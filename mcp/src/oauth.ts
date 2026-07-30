/**
 * OAuth 2.0 for the MCP server, delegated to an external authorization server.
 *
 * MCP clients (Claude, Cursor, ChatGPT connectors) add a remote server by reading
 * its Protected Resource Metadata (RFC 9728), discovering the authorization
 * server named there, and running an OAuth flow against it. Without that
 * document there is no way to install this server in any of them, which is the
 * actual reason this file exists. The score on an agent-readiness scanner is a
 * side effect.
 *
 * We are the RESOURCE server only. We do not issue tokens, hold passwords, or
 * run an authorization endpoint: AuthKit does, and we verify what it signed.
 * That is the right split for a team this size, because the failure modes of a
 * hand-rolled authorization server (key rotation, PKCE downgrade, alg confusion,
 * refresh replay) are exactly the ones that do not announce themselves.
 *
 * Credential-gated like every other integration here: with OAUTH_ISSUER unset
 * the whole module reports disabled and nothing changes. Verification is purely
 * ADDITIVE to the existing HMAC session tokens, which keep working untouched.
 *
 * Specs: RFC 9728 (protected resource metadata), RFC 8414 (AS metadata),
 * RFC 7517 (JWK), RFC 7519 (JWT).
 */
import { createPublicKey, verify as cryptoVerify, timingSafeEqual } from 'node:crypto'

/** The AuthKit (or any RFC 8414) issuer. Unset means OAuth is simply off. */
const ISSUER = process.env.OAUTH_ISSUER?.replace(/\/$/, '') ?? ''

/** The canonical identifier of the thing being protected, per RFC 9728. */
const RESOURCE = process.env.OAUTH_RESOURCE ?? 'https://a-identity.xyz/mcp'

export const oauthEnabled = (): boolean => ISSUER.length > 0
export const oauthIssuer = (): string => ISSUER

/**
 * The document an MCP client fetches first. It says what this resource is called
 * and which authorization server can mint tokens for it; the client takes it from
 * there and never needs a credential from us.
 */
export function protectedResourceMetadata(): Record<string, unknown> {
  return {
    resource: RESOURCE,
    authorization_servers: ISSUER ? [ISSUER] : [],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://a-identity.xyz/auth.md',
    resource_name: 'A-Identity MCP server',
    // Said plainly so a client is not surprised: signing in identifies the human
    // who owns an agent. It does not raise that agent's spending limits, which
    // live on-chain and are not a function of who is holding the token.
    resource_policy_uri: 'https://a-identity.xyz/auth.md',
    // How an agent obtains a credential in the first place, per the auth.md
    // registration protocol. Three routes because agents arrive in three
    // situations, and the honest answer differs: a human is present, no human is
    // present, or value is about to move.
    agent_auth: {
      skill: 'https://a-identity.xyz/auth.md',
      register_uri: 'https://a-identity.xyz/signup',
      revocation_uri: 'https://a-identity.xyz/app',
      identity_types_supported: ['identity_assertion'],
      identity_assertion: {
        assertion_types_supported: ['verified_email'],
        credential_types_supported: ['oauth_access_token', 'agent_key'],
        claim_uri: 'https://a-identity.xyz/signup',
      },
      registration_methods: [
        {
          method: 'oauth',
          description:
            'Authorization code with PKCE against the authorization server named above, then a bearer token. Dynamic client registration is supported by the issuer. Grants ownership of the agents registered to the verified email.',
          authorization_server: ISSUER,
          requires_human: true,
        },
        {
          method: 'payment',
          description:
            'For autonomous agents with no human present. Paid endpoints authenticate the payment rather than the caller: an unpaid request returns HTTP 402 with a machine-readable challenge and is served on a paid retry.',
          challenge_endpoint: 'https://a-identity.xyz/api/x402/nano/data',
          requires_human: false,
        },
        {
          method: 'owner_provisioned_key',
          description:
            'Required only for operations that move value. A human registers the agent and sets its limits; the key is issued at the end of that flow. No endpoint mints one on an agent own request, because it authorizes spending from a human wallet.',
          register_uri: 'https://a-identity.xyz/signup',
          requires_human: true,
        },
      ],
      notes:
        'No credential widens a spending limit. Caps, the approval line and the payee allowlist are enforced by an on-chain vault that cannot see how the caller authenticated.',
    },
  }
}

/** The header to send with a 401 so a client can find the metadata above. */
export function wwwAuthenticate(): string {
  const base = `Bearer realm="a-identity"`
  if (!ISSUER) return base
  return `${base}, resource_metadata="${RESOURCE.replace(/\/mcp$/, '')}/.well-known/oauth-protected-resource"`
}

// ── JWKS ────────────────────────────────────────────────────────────────────

type Jwk = { kid?: string; kty?: string; alg?: string; use?: string; n?: string; e?: string }
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null
/** Keys rotate, but not often. An hour bounds staleness without hammering the AS. */
const JWKS_TTL_MS = 60 * 60 * 1000

async function getJwks(force = false): Promise<Jwk[]> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  if (fresh && !force) return jwksCache!.keys

  // Read the jwks_uri from the AS metadata rather than assuming a path: RFC 8414
  // exists precisely so this is not guesswork, and AuthKit is free to move it.
  const metaRes = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!metaRes.ok) throw new Error(`AS metadata returned HTTP ${metaRes.status}`)
  const meta = (await metaRes.json()) as { jwks_uri?: string; issuer?: string }
  if (meta.issuer && meta.issuer.replace(/\/$/, '') !== ISSUER) {
    // A metadata document whose issuer disagrees with where we fetched it from is
    // the classic mix-up attack; refuse rather than trust it.
    throw new Error(`AS metadata issuer ${meta.issuer} does not match configured ${ISSUER}`)
  }
  if (!meta.jwks_uri) throw new Error('AS metadata has no jwks_uri')

  const jwksRes = await fetch(meta.jwks_uri, { signal: AbortSignal.timeout(10_000) })
  if (!jwksRes.ok) throw new Error(`JWKS returned HTTP ${jwksRes.status}`)
  const jwks = (await jwksRes.json()) as { keys?: Jwk[] }
  const keys = jwks.keys ?? []
  jwksCache = { keys, fetchedAt: Date.now() }
  return keys
}

// ── JWT ─────────────────────────────────────────────────────────────────────

const b64urlToBuf = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const b64urlToJson = (s: string): Record<string, unknown> => JSON.parse(b64urlToBuf(s).toString('utf8'))

export type OAuthClaims = {
  /** The stable subject from the authorization server. */
  sub: string
  /** The verified email, when the token carries one. */
  email?: string
  expiresAt: number
}

/**
 * Verify an access token issued by the configured authorization server.
 *
 * Returns null for anything that does not verify, rather than throwing, because
 * every caller's correct response to a bad token is identical and a thrown error
 * here would be one `catch` away from being treated as success.
 *
 * The `alg` is pinned to RS256 from the header. Accepting whatever the token
 * asks for is how `alg: none` and HMAC-with-the-public-key forgeries get in.
 */
export async function verifyAccessToken(token: string): Promise<OAuthClaims | null> {
  if (!oauthEnabled() || !token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const header = b64urlToJson(parts[0]) as { alg?: string; kid?: string; typ?: string }
    if (header.alg !== 'RS256') return null

    let keys = await getJwks()
    let jwk = keys.find((k) => k.kid === header.kid && (k.kty ?? 'RSA') === 'RSA')
    if (!jwk) {
      // Unknown kid usually means the AS rotated since we cached. Refetch once.
      keys = await getJwks(true)
      jwk = keys.find((k) => k.kid === header.kid && (k.kty ?? 'RSA') === 'RSA')
    }
    if (!jwk?.n || !jwk.e) return null

    const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8')
    const signature = b64urlToBuf(parts[2])
    if (!cryptoVerify('RSA-SHA256', signed, key, signature)) return null

    const claims = b64urlToJson(parts[1]) as {
      iss?: string
      sub?: string
      email?: string
      exp?: number
      nbf?: number
      aud?: string | string[]
    }

    if (!claims.sub) return null
    if ((claims.iss ?? '').replace(/\/$/, '') !== ISSUER) return null

    const now = Math.floor(Date.now() / 1000)
    // A little skew, because clocks drift and a token rejected one second early
    // looks to a user exactly like a broken login.
    const SKEW = 60
    if (typeof claims.exp !== 'number' || claims.exp + SKEW < now) return null
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW > now) return null

    // Audience is only checked when the deployment pins one. RFC 8707 resource
    // indicators are not universally emitted yet, and rejecting every token for a
    // claim the AS may not set would break the flow for no security gain.
    const wantAud = process.env.OAUTH_AUDIENCE
    if (wantAud) {
      const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : []
      if (!auds.some((a) => constantTimeEquals(a, wantAud))) return null
    }

    return { sub: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined, expiresAt: claims.exp }
  } catch {
    return null
  }
}

/** Compare without leaking length or position through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

/** Reset the cached JWKS. Tests only. */
export function __resetJwksCache(): void {
  jwksCache = null
}

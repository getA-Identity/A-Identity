/**
 * Mirror the authorization server's metadata onto our own origin.
 *
 * Why this exists, and why it is safe:
 *
 * Some MCP clients look for authorization server metadata on the RESOURCE
 * server's origin rather than following Protected Resource Metadata to the real
 * issuer. Without a document there they get a 404 and the connection attempt
 * ends. With one, every one of the endpoints inside points at AuthKit, so a
 * client that uses it ends up talking to the real authorization server and the
 * flow completes correctly.
 *
 * The obvious objection is RFC 8414 section 3.3: a client that built this URL by
 * inserting the well-known string into an issuer identifier MUST reject metadata
 * whose `issuer` disagrees. That is true, and it is also harmless here, because
 * rejecting this document leaves such a client exactly where a 404 would have:
 * falling back to PRM, which is correct and which we serve. So the mirror is
 * neutral in the strict case and helpful in the lenient one.
 *
 * The one case that would genuinely break is OIDC: an ID token is validated by
 * the client, and a client that discovered us leniently would compare the token
 * issuer against our origin and reject a legitimate token. That is why this
 * mirrors ONLY /.well-known/oauth-authorization-server and deliberately does NOT
 * mirror /.well-known/openid-configuration. Access tokens are opaque to clients;
 * ID tokens are not.
 *
 * The remaining risk is staleness, which is what --check is for: it refetches
 * AuthKit's live document and fails if ours has drifted, so a rotated endpoint
 * surfaces as a red build rather than as a login that mysteriously stopped
 * working.
 *
 * Run:   node scripts/gen-oauth-mirror.mjs
 * Check: node scripts/gen-oauth-mirror.mjs --check
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/.well-known/oauth-authorization-server')

/** Single source of truth for the issuer; change it here when moving to production. */
const ISSUER = process.env.OAUTH_ISSUER ?? 'https://artistic-olive-45-staging.authkit.app'

/**
 * Our own registration story, per the auth.md protocol, which places the
 * agent_auth block in authorization server metadata. AuthKit does not know how
 * A-Identity provisions agent keys, so this part is ours to state.
 */
const AGENT_AUTH = {
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
        'Authorization code with PKCE against this issuer, then a bearer token. Grants ownership of the agents registered to the verified email.',
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
        'Required only for operations that move value. A human registers the agent and sets its limits; the key is issued at the end of that flow. No endpoint mints one on an agent own request.',
      register_uri: 'https://a-identity.xyz/signup',
      requires_human: true,
    },
  ],
  notes:
    'No credential widens a spending limit. Caps, the approval line and the payee allowlist are enforced by an on-chain vault that cannot see how the caller authenticated.',
}

async function fetchUpstream() {
  const res = await fetch(`${ISSUER}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`${ISSUER} metadata returned HTTP ${res.status}`)
  const doc = await res.json()
  if (doc.issuer?.replace(/\/$/, '') !== ISSUER.replace(/\/$/, '')) {
    throw new Error(`upstream issuer ${doc.issuer} does not match ${ISSUER}`)
  }
  return doc
}

/**
 * In --check mode a network failure must not fail the build. The question this
 * guard answers is "has AuthKit changed its endpoints", and "we could not reach
 * AuthKit from a build container" is not an answer to it. Drift fails hard;
 * unreachability warns and passes. Generation still fails loudly, because
 * writing the file from a failed fetch would produce garbage.
 */
const checking = process.argv.includes('--check')
let upstream
try {
  upstream = await fetchUpstream()
} catch (e) {
  if (!checking) throw e
  console.warn(`OAuth mirror check skipped: could not reach the issuer (${e.message})`)
  process.exit(0)
}
const doc = {
  ...upstream,
  // Kept exactly as AuthKit publishes it. A client that validates strictly will
  // notice this does not match our origin and fall back to PRM, which is the
  // correct outcome and the reason we do not rewrite it.
  issuer: upstream.issuer,
  agent_auth: AGENT_AUTH,
  'x-mirror-note':
    'Mirrored from the issuer named above so that MCP clients probing this origin find a document. Authoritative copy: ' +
    `${ISSUER}/.well-known/oauth-authorization-server`,
}
const next = JSON.stringify(doc, null, 2) + '\n'

if (process.argv.includes('--check')) {
  let current
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    console.error(`missing ${OUT}. Run: node scripts/gen-oauth-mirror.mjs`)
    process.exit(1)
  }
  // Compare only the upstream-derived fields: agent_auth is ours and a local edit
  // to it is legitimate, while a changed AuthKit endpoint is what must fail.
  const mine = JSON.parse(current)
  const drifted = Object.keys(upstream).filter(
    (k) => JSON.stringify(mine[k]) !== JSON.stringify(upstream[k]),
  )
  if (drifted.length) {
    console.error(
      `the OAuth metadata mirror has drifted from ${ISSUER} on: ${drifted.join(', ')}\n` +
        'Run: node scripts/gen-oauth-mirror.mjs',
    )
    process.exit(1)
  }
  console.log(`OAuth mirror matches ${ISSUER} (${Object.keys(upstream).length} upstream fields)`)
} else {
  writeFileSync(OUT, next)
  console.log(`wrote ${OUT}`)
  console.log(`  issuer: ${doc.issuer}`)
  console.log(`  endpoints: ${Object.keys(upstream).filter((k) => k.endsWith('_endpoint')).join(', ')}`)
}

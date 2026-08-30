/**
 * Web Bot Auth: sign the requests our own agents send.
 *
 * A-Identity is not only a service agents call, it is an agent that calls other
 * services: it reads chains, fetches counterparty manifests, and pays for x402
 * resources. From the receiving end those requests are indistinguishable from
 * anyone else claiming to be us, and the usual answer, a User-Agent string, is
 * a claim rather than evidence. This signs them with an Ed25519 key whose public
 * half is published at /.well-known/http-message-signatures-directory, so a site
 * we call can verify the request came from whoever controls a-identity.xyz.
 *
 * Publishing the directory without ever signing anything would be decoration.
 * That is not a hypothetical: this module shipped its directory and its signer with
 * NO call site at all, so for a while the claim in this very comment was false. The
 * signer is now wired into the outbound leg it was written for, the counterparty
 * manifest fetch in commerce.ts, and bot-auth.test.ts fails if that call site
 * disappears again.
 *
 * Credential-gated like everything else here: with BOT_SIGNING_KEY unset,
 * `signedFetch` is an ordinary fetch. The private key never appears in the repo.
 *
 * Draft: https://datatracker.ietf.org/wg/webbotauth/about/
 * Built on RFC 9421 (HTTP Message Signatures).
 */
import { createPrivateKey, sign as cryptoSign, randomBytes } from 'node:crypto'

/** The public half of this pair is served from the well-known directory. */
export const BOT_KEY_ID = 'APKAPhL6wDOPdis4Rj1fZlx5TG9QdMPwfN_kkauG_HM'

/** Who to look up the key from, per the Web Bot Auth draft. */
export const SIGNATURE_AGENT = 'https://a-identity.xyz'

const PRIVATE_PEM = process.env.BOT_SIGNING_KEY ?? ''

export const botAuthEnabled = (): boolean => PRIVATE_PEM.length > 0

/**
 * Build the RFC 9421 signature base: the exact bytes that get signed.
 *
 * Order matters and is not cosmetic. The base lists each covered component on
 * its own line in the same order as the `@signature-params` line at the end, and
 * a verifier reconstructs it from the headers alone. Any disagreement about
 * order produces a valid-looking signature over different bytes, which fails
 * verification in a way that is tedious to debug, so this builds both from one
 * list rather than from two places that must agree.
 */
export function signatureBase(input: {
  method: string
  url: string
  created: number
  expires: number
  nonce: string
  keyid: string
  tag?: string
}): { base: string; params: string } {
  const u = new URL(input.url)
  const covered = ['"@method"', '"@authority"', '"@path"']
  const params =
    `(${covered.join(' ')});created=${input.created};expires=${input.expires};` +
    `keyid="${input.keyid}";alg="ed25519";nonce="${input.nonce}"` +
    (input.tag ? `;tag="${input.tag}"` : '')

  const lines = [
    `"@method": ${input.method.toUpperCase()}`,
    `"@authority": ${u.host}`,
    `"@path": ${u.pathname}`,
    `"@signature-params": ${params}`,
  ]
  return { base: lines.join('\n'), params }
}

export type SignedHeaders = {
  'signature-agent': string
  'signature-input': string
  signature: string
}

/**
 * Sign one request. Returns null when no key is configured, so callers can spread
 * the result and get an unsigned request rather than having to branch.
 *
 * The signature is scoped in time and to a nonce: a captured one cannot be
 * replayed against a different path or after it expires. Default lifetime is
 * short for the same reason.
 */
export function signRequest(
  method: string,
  url: string,
  opts: { lifetimeSeconds?: number; now?: number } = {},
): SignedHeaders | null {
  if (!botAuthEnabled()) return null

  const created = Math.floor((opts.now ?? Date.now()) / 1000)
  const expires = created + (opts.lifetimeSeconds ?? 60)
  const nonce = randomBytes(16).toString('base64url')

  const { base, params } = signatureBase({
    method,
    url,
    created,
    expires,
    nonce,
    keyid: BOT_KEY_ID,
    tag: 'web-bot-auth',
  })

  const key = createPrivateKey(PRIVATE_PEM)
  // Ed25519 signs the message directly; passing a digest algorithm is an error.
  const sig = cryptoSign(null, Buffer.from(base, 'utf8'), key)

  return {
    'signature-agent': `"${SIGNATURE_AGENT}"`,
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${sig.toString('base64')}:`,
  }
}

/**
 * `fetch`, with our identity attached when we have a key.
 *
 * Use this for every outbound request made on the platform's own behalf. It is
 * deliberately a drop-in: an unconfigured deployment behaves exactly like plain
 * fetch, so nothing depends on the key existing.
 *
 * The signature is `typeof fetch` rather than `(url: string, ...)` on purpose. A signer
 * that cannot be passed where a `fetch` is expected is a signer nobody wires in, which is
 * how the published directory ended up with no caller in the first place. The signature
 * base needs a string URL, so the three shapes `fetch` accepts are narrowed to one here
 * rather than at every call site.
 */
export async function signedFetch(input: URL | RequestInfo, init: RequestInit = {}): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  // A Request carries its own method; an explicit init.method still wins, as it does in fetch.
  const method = (init.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
  const signed = signRequest(method, url)
  if (!signed) return fetch(input, init)
  return fetch(input, { ...init, headers: { ...(init.headers as Record<string, string>), ...signed } })
}

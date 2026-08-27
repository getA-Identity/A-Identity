/**
 * Session auth for the write side of the platform.
 *
 * This is a SESSION layer, not identity verification (that's KYA). Login issues an
 * HMAC-signed token carrying the caller's subject (email or wallet address) AND the
 * method used to establish it. Ownership of an agent is bound to a VERIFIED identity:
 *  - 'wallet' - proven by a Sign-In-with-Ethereum signature
 *  - 'email'  - proven by clicking a one-time magic link (Resend)
 *  - 'guest'  - an unverified, browse-only session (plain /api/auth/login)
 * Mutating endpoints require a verified caller; guest sessions are read-only. This is
 * what stops someone from minting a token for an arbitrary email and acting as its
 * owner. The signing secret comes from AUTH_SECRET; set a strong one in production.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const DEV_SECRET = 'a-identity-dev-secret-change-me'

/** True when we look like a real deploy (Render / explicit prod / a Postgres DB). */
function isProdLike(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.NODE_ENV === 'production' || env.RENDER || env.RENDER_EXTERNAL_URL || env.DATABASE_URL)
}

/**
 * Resolve the token-signing secret ONCE, safely:
 *  - AUTH_SECRET set        -> use it (the correct path; stable across restarts).
 *  - unset, prod-like host  -> generate a strong RANDOM per-process secret and warn
 *    loudly. This closes the forgeable-default-secret hole WITHOUT taking the deploy
 *    down; the only cost is that existing sessions don't survive a restart.
 *  - unset, local dev       -> the fixed dev secret, for convenience.
 * Shared by the session-token layer (this file) and the magic-link layer (magic.ts).
 */
function resolveSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTH_SECRET && env.AUTH_SECRET.length >= 16) return env.AUTH_SECRET
  if (isProdLike(env)) {
    console.error(
      '[auth] WARNING: AUTH_SECRET is unset (or too short) on a production-like host. ' +
        'Using a random per-process secret so tokens cannot be forged - but sessions will ' +
        'NOT survive a restart. Set a strong AUTH_SECRET (>=16 chars) in the host env.',
    )
    return randomBytes(32).toString('hex')
  }
  return DEV_SECRET
}

/** The resolved signing secret. Import this instead of reading AUTH_SECRET directly. */
export const AUTH_SECRET = resolveSecret()

const SECRET = AUTH_SECRET

/** How a session's identity was established. Only 'wallet' / 'email' are verified. */
export type AuthMethod = 'guest' | 'email' | 'wallet'

/** The authenticated caller: who they are + how they proved it. */
export type Caller = { subject: string; method: AuthMethod }

function sign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('base64url')
}

/** Session lifetime. A bearer token is the write-side credential, so it must not be valid
 *  forever if it leaks - it carries an `exp` and expires. Override with AUTH_TOKEN_TTL_MS. */
const TOKEN_TTL_MS = Math.max(60_000, Number(process.env.AUTH_TOKEN_TTL_MS ?? 7 * 24 * 60 * 60 * 1000))

/** Issue an opaque session token for a subject established via `method`. */
export function issueToken(subject: string, method: AuthMethod): string {
  const now = Date.now()
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, method, iat: now, exp: now + TOKEN_TTL_MS }),
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

/** Verify a token and return the caller, or null if invalid/tampered. */
export function verifyToken(token: string | undefined | null): Caller | null {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = sign(payload)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      sub?: string
      email?: string // legacy tokens carried { email } with no method
      method?: AuthMethod
      exp?: number
    }
    const subject = obj.sub ?? obj.email
    if (!subject) return null
    // Enforce expiry when present (all tokens issued now carry one). A tampered exp can't
    // help an attacker: the HMAC over the payload was already verified above.
    if (typeof obj.exp === 'number' && Date.now() > obj.exp) return null
    // Legacy tokens (no method) fail closed -> treated as unverified guests.
    const method: AuthMethod = obj.method === 'wallet' || obj.method === 'email' ? obj.method : 'guest'
    return { subject, method }
  } catch {
    return null
  }
}

/** True only for identities proven by a wallet signature or a magic-link click. */
export function isVerified(caller: Caller | null): boolean {
  return caller?.method === 'wallet' || caller?.method === 'email'
}

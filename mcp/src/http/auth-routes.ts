/**
 * Auth route group (split from http.ts): guest login, SIWE nonce + verify, magic-link
 * request + verify, whoami, logout. Handlers return true when the request was
 * handled; order within this file mirrors the original http.ts order.
 */
import { randomBytes } from 'node:crypto'
import { issueToken, isVerified } from '../auth.js'
import { magicEnabled, sendMagicLink, verifyMagicToken } from '../magic.js'
import { normalizeWalletAddress, shortAddress, signInMessage, verifyWalletProof, walletEcosystemOf, type WalletEcosystem } from '../wallet-proof.js'
import { clearSessionCookie, readBody, sendJson, sessionCookie, type RouteCtx } from './shared.js'

/**
 * Short-lived sign-in nonces, keyed by the NONCE itself, with the canonical wallet address
 * (EVM lowercased, Stellar and Algorand as given) and the purpose stored beside it.
 * In-memory + a 10-minute TTL: a nonce expires if unused and stale entries can't pile up.
 * Correct for our single backend instance; a scaled deploy would move these (and the KYA
 * challenges in platform.ts, and the x402 nonces) to shared storage.
 *
 * Keyed by the nonce rather than by the address, and that is a fix. The address is public,
 * so a store keyed by it let anyone ask for a nonce for somebody else's wallet and overwrite
 * the one that person was in the middle of signing: their signature was then refused as
 * stale, every time, for as long as the stranger kept asking. A nonce is 128 random bits
 * that only its requester ever sees, so nobody can reach an entry they were not handed.
 *
 * The same nonce store serves two purposes, told apart by `purpose`: a fresh sign-in, and
 * linking a second wallet to an account that is already signed in. The message a wallet
 * signs says which, so a signature minted for one cannot be replayed as the other.
 */
const NONCE_TTL_MS = 10 * 60 * 1000
/**
 * A ceiling on pending nonces, so a flood of requests cannot grow this map without bound.
 * Expired entries are swept first; only a store still full after that drops its oldest
 * entry, which takes far more traffic than the per-IP auth budget allows from one address.
 */
const MAX_PENDING_NONCES = 10_000
const nonces = new Map<string, { address: string; exp: number; purpose: 'sign in' | 'link' }>()

/** The nonce a sign-in message carries, read from the last line signInMessage writes. */
function nonceIn(message: string): string | undefined {
  return /\nNonce: ([0-9a-f]{32})$/.exec(message)?.[1]
}

/** Mint a nonce and the message to sign for an address, on whatever ecosystem it belongs to. */
export function issueNonce(address: string, purpose: 'sign in' | 'link' = 'sign in'): { ecosystem: WalletEcosystem; address: string; message: string } | null {
  const ecosystem = walletEcosystemOf(address)
  if (!ecosystem) return null
  const addr = normalizeWalletAddress(address, ecosystem)
  const now = Date.now()
  if (nonces.size >= MAX_PENDING_NONCES) {
    for (const [k, v] of nonces) if (v.exp <= now) nonces.delete(k)
  }
  if (nonces.size >= MAX_PENDING_NONCES) {
    const oldest = nonces.keys().next().value
    if (oldest !== undefined) nonces.delete(oldest)
  }
  const nonce = randomBytes(16).toString('hex')
  nonces.set(nonce, { address: addr, exp: now + NONCE_TTL_MS, purpose })
  return { ecosystem, address: addr, message: signInMessage(addr, nonce, purpose) }
}

/**
 * Consume a nonce and verify the signature. Returns the canonical address and ecosystem
 * on success, or the reason for refusal. The nonce must have been issued for this address
 * and this purpose. It is deleted on success and on a stale read, never on a bad signature,
 * so a mistyped wallet prompt can be retried until the nonce expires.
 */
export async function consumeWalletProof(
  body: { address?: string; message?: string; signature?: string },
  purpose: 'sign in' | 'link' = 'sign in',
): Promise<{ ok: true; ecosystem: WalletEcosystem; address: string } | { ok: false; status: number; error: string }> {
  if (!body?.address || !body?.message || !body?.signature) return { ok: false, status: 400, error: 'address, message, signature required' }
  const ecosystem = walletEcosystemOf(body.address)
  if (!ecosystem) return { ok: false, status: 400, error: 'address is not an EVM, Stellar or Algorand address' }
  const addr = normalizeWalletAddress(body.address, ecosystem)
  const nonce = nonceIn(body.message)
  const entry = nonce ? nonces.get(nonce) : undefined
  const now = Date.now()
  if (nonce && entry && entry.exp <= now) nonces.delete(nonce)
  const live = Boolean(nonce && entry && entry.exp > now && entry.address === addr && entry.purpose === purpose)
  if (!live || body.message !== signInMessage(addr, nonce as string, purpose)) return { ok: false, status: 401, error: 'stale or missing nonce; request a new one' }
  const ok = await verifyWalletProof({ ecosystem, address: addr, message: body.message, signature: String(body.signature) })
  if (!ok) return { ok: false, status: 401, error: 'signature does not match address' }
  nonces.delete(nonce as string)
  return { ok: true, ecosystem, address: addr }
}

export async function handleAuthRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, caller } = ctx

  // ── auth: login (public) ──────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = (await readBody(req).catch(() => null)) as { email?: string; name?: string } | null
    if (!body?.email) { sendJson(res, 400, { error: 'email required' }); return true }
    const email = String(body.email).trim().toLowerCase()
    // Unverified, browse-only session: the email is NOT proven. This token is a
    // 'guest' - it cannot own agents or mutate. To act, sign in with a wallet or a
    // magic link (both verified). This is what closes the email-impersonation hole.
    const token = issueToken(email, 'guest')
    res.setHeader('Set-Cookie', sessionCookie(token))
    sendJson(res, 200, {
      token,
      user: { email, name: body.name?.trim() || email.split('@')[0] },
    })
    return true
  }

  // ── auth: wallet nonce (public) - start a wallet sign-in on any ecosystem ───────
  // The address decides the ecosystem: 0x... is EVM (Sign-In with Ethereum, unchanged),
  // G... is a Stellar account, a 58-character base32 string is Algorand. The caller may
  // also say `purpose: 'link'` to mint a linking nonce for a second wallet.
  if (req.method === 'POST' && url.pathname === '/api/auth/nonce') {
    const body = (await readBody(req).catch(() => null)) as { address?: string; purpose?: string } | null
    if (!body?.address || typeof body.address !== 'string') { sendJson(res, 400, { error: 'valid address required' }); return true }
    const purpose = body.purpose === 'link' ? 'link' : 'sign in'
    const minted = issueNonce(body.address, purpose)
    if (!minted) { sendJson(res, 400, { error: 'valid address required: an EVM (0x...), Stellar (G...) or Algorand address' }); return true }
    sendJson(res, 200, { message: minted.message, address: minted.address, ecosystem: minted.ecosystem, purpose })
    return true
  }

  // ── auth: wallet verify (public) - finish the sign-in, issue a session token ────
  if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
    const body = (await readBody(req).catch(() => null)) as { address?: string; message?: string; signature?: string } | null
    const r = await consumeWalletProof(body ?? {}, 'sign in')
    if (!r.ok) { sendJson(res, r.status, { error: r.error }); return true }
    // Wallet ownership proven by signature -> a verified session, whatever the chain.
    const token = issueToken(r.address, 'wallet')
    res.setHeader('Set-Cookie', sessionCookie(token))
    sendJson(res, 200, {
      token,
      user: { email: r.address, name: shortAddress(r.address) },
      ecosystem: r.ecosystem,
    })
    return true
  }

  // ── auth: passwordless email magic-link (public; credential-gated behind Resend) ──
  if (req.method === 'POST' && url.pathname === '/api/auth/magic/request') {
    const body = (await readBody(req).catch(() => null)) as { email?: string } | null
    const email = body?.email?.trim().toLowerCase()
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      sendJson(res, 400, { error: 'A valid email is required' }); return true
    }
    const err = await sendMagicLink(email)
    if (err) { sendJson(res, magicEnabled() ? 502 : 501, { sent: false, error: err }); return true }
    sendJson(res, 200, { sent: true })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/magic/verify') {
    const body = (await readBody(req).catch(() => null)) as { token?: string } | null
    const email = verifyMagicToken(body?.token)
    if (!email) { sendJson(res, 401, { error: 'This sign-in link is invalid or expired.' }); return true }
    // Email ownership proven by the one-time link -> a verified session.
    const token = issueToken(email, 'email')
    res.setHeader('Set-Cookie', sessionCookie(token))
    sendJson(res, 200, { token, user: { email, name: email.split('@')[0] } })
    return true
  }

  // ── auth: who am I (restores a session from the HttpOnly cookie on reload) ─────
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    // "Who am I" is answered, not refused. Being signed out is a normal answer to
    // this question, and a 401 makes Chrome log a console error on every page load
    // for every anonymous visitor, which is both noise and a Lighthouse failure.
    // The 401 is kept only for genuinely malformed credentials.
    if (!caller) { sendJson(res, 200, { authenticated: false }); return true }
    const name = caller.method === 'wallet' ? shortAddress(caller.subject) : caller.subject.split('@')[0]
    sendJson(res, 200, {
      user: { email: caller.subject, name },
      method: caller.method,
      verified: isVerified(caller),
      // Which ecosystem a wallet session lives on, from the address shape; null for email.
      ecosystem: caller.method === 'wallet' ? walletEcosystemOf(caller.subject) : null,
    })
    return true
  }
  // ── auth: logout (clears the session cookie) ──────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    res.setHeader('Set-Cookie', clearSessionCookie())
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}

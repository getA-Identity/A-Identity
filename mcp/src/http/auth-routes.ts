/**
 * Auth route group (split from http.ts): guest login, SIWE nonce + verify, magic-link
 * request + verify, whoami, logout. Handlers return true when the request was
 * handled; order within this file mirrors the original http.ts order.
 */
import { randomBytes } from 'node:crypto'
import { issueToken, isVerified } from '../auth.js'
import { magicEnabled, sendMagicLink, verifyMagicToken } from '../magic.js'
import { clearSessionCookie, readBody, sendJson, sessionCookie, type RouteCtx } from './shared.js'

/**
 * Short-lived Sign-In-with-Ethereum nonces, keyed by lowercase wallet address.
 * In-memory + a 10-minute TTL: a nonce expires if unused and stale entries can't pile
 * up. Correct for our single backend instance; a scaled deploy would move these (and
 * the KYA challenges in platform.ts, and the x402 nonces) to shared storage.
 */
const NONCE_TTL_MS = 10 * 60 * 1000
const nonces = new Map<string, { nonce: string; exp: number }>()

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

  // ── auth: wallet nonce (public) - start Sign-In with Ethereum ─────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/nonce') {
    const body = (await readBody(req).catch(() => null)) as { address?: string } | null
    if (!body?.address || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      sendJson(res, 400, { error: 'valid address required' }); return true
    }
    const addr = body.address.toLowerCase()
    const nonce = randomBytes(16).toString('hex')
    nonces.set(addr, { nonce, exp: Date.now() + NONCE_TTL_MS })
    const message = `A-Identity: sign in with your wallet.\n\nAddress: ${addr}\nNonce: ${nonce}`
    sendJson(res, 200, { message })
    return true
  }

  // ── auth: wallet verify (public) - finish SIWE, issue a session token ─────────
  if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
    const body = (await readBody(req).catch(() => null)) as
      | { address?: string; message?: string; signature?: string }
      | null
    if (!body?.address || !body?.message || !body?.signature) {
      sendJson(res, 400, { error: 'address, message, signature required' }); return true
    }
    const addr = body.address.toLowerCase()
    const entry = nonces.get(addr)
    if (entry && entry.exp <= Date.now()) nonces.delete(addr)
    const nonce = entry && entry.exp > Date.now() ? entry.nonce : undefined
    if (!nonce || !body.message.includes(nonce)) {
      sendJson(res, 401, { error: 'stale or missing nonce; request a new one' }); return true
    }
    try {
      const { verifyMessage } = await import('viem')
      const ok = await verifyMessage({
        address: addr as `0x${string}`,
        message: body.message,
        signature: body.signature as `0x${string}`,
      })
      if (!ok) { sendJson(res, 401, { error: 'signature does not match address' }); return true }
    } catch {
      sendJson(res, 401, { error: 'signature verification failed' }); return true
    }
    nonces.delete(addr)
    // Wallet ownership proven by signature -> a verified session.
    const token = issueToken(addr, 'wallet')
    res.setHeader('Set-Cookie', sessionCookie(token))
    sendJson(res, 200, {
      token,
      user: { email: addr, name: `${addr.slice(0, 6)}...${addr.slice(-4)}` },
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
    const name =
      caller.method === 'wallet'
        ? `${caller.subject.slice(0, 6)}...${caller.subject.slice(-4)}`
        : caller.subject.split('@')[0]
    sendJson(res, 200, { user: { email: caller.subject, name }, method: caller.method, verified: isVerified(caller) })
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

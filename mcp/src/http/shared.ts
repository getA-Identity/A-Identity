/**
 * Shared helpers + request context for the HTTP route modules (split from http.ts).
 * Side-effect-free helpers: session cookies, body reading, validators, JSON replies,
 * ownership guards, and the RouteCtx type the route-group handlers receive.
 */
import type http from 'node:http'
import type { Caller } from '../auth.js'
import { agentAccess, listPlatformAgents } from '../platform.js'

/** Per-request context the http.ts dispatcher hands to each route-group handler. */
export type RouteCtx = { req: http.IncomingMessage; res: http.ServerResponse; url: URL; caller: Caller | null; callerId: string | undefined }

// ── HttpOnly session cookie (closes the JS-readable-token exposure) ────────────────
// The session token also rides in an HttpOnly cookie, so the SPA never has to keep it in
// localStorage. In prod the app is same-origin (Vercel proxy → Render), so the cookie is
// first-party; SameSite=Lax + Secure. Requests may still present a Bearer token (the
// in-memory fallback), so both paths are accepted.
export const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL
export const SESSION_COOKIE = 'aid_session'
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60 // seconds

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}${IS_PROD ? '; Secure' : ''}`
}
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${IS_PROD ? '; Secure' : ''}`
}

/** Hard cap on a request body. Every endpoint here takes a small JSON object; a bigger
 *  body is abuse (memory spike + it would balloon the single persisted state blob). */
export const MAX_BODY_BYTES = 256 * 1024

export function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c) => {
      size += (c as Buffer).length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c as Buffer)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve(undefined)
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

// ── small input validators (finite, bounded — no NaN/Infinity/negative slips through) ──
/** A finite, non-negative number no larger than `max` (USD amounts on a testnet demo). */
export function validAmount(v: unknown, max = 1_000_000): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
}
/** Clamp a client-supplied USD amount into [0, max]; non-numbers → `fallback`. */
export function clampUsd(v: unknown, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : fallback
}
/** The on-chain demo endpoints spend the shared server signer. Cap client-chosen amounts
 *  so an internet caller can't force a large deposit/transfer from the house key. Returns
 *  `undefined` for a missing/invalid value so the runner falls back to its own small default. */
export const MAX_DEMO_USD = 5
export function cappedDemoUsd(v: unknown, max = MAX_DEMO_USD): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : undefined
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Map a platform error message to an HTTP status. */
export function errStatus(msg: string): number {
  return msg.startsWith('Forbidden') ? 403 : msg.startsWith('Unknown') ? 404 : 400
}

/**
 * Send an x402 challenge, in BOTH transports.
 *
 * The body is where our own buyers read it and where a v1 client looks. The
 * `PAYMENT-REQUIRED` header is where the x402 v2 spec puts it, and a stock client is not
 * lenient about that: @x402/core's `getPaymentRequiredResponse` reads the header, and
 * falls back to the body ONLY when `x402Version === 1`. Anything else throws
 * "Invalid payment required response" before the buyer ever sees the price.
 *
 * Our EIP-3009 and Stellar rails served `x402Version: 2` in the body with no header, which
 * is v1 transport under a v2 number, so no off-the-shelf v2 buyer of any origin could pay
 * them. It went unnoticed because our own buyer scripts parse the body directly: we tested
 * the rails with the one client that did not need the header. The nano rail and the ASP
 * both got this right, so the pattern already existed in the repo and was simply not
 * carried across.
 *
 * Sending both costs one header and keeps every existing caller working.
 */
export function sendChallenge(res: http.ServerResponse, status: number, body: unknown): void {
  if (status === 402) {
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'))
  }
  sendJson(res, status, body)
}

/** Guard an agent-scoped private read (policy / vault / treasury / Circle wallet / payment
 *  history): only the owner may read it. Returns true (and sends the response) when access
 *  is denied, so a handler can `if (denyRead(...)) return`. Public reads (identity resolve,
 *  reputation, marketplace) never call this. */
export function denyRead(res: http.ServerResponse, agentId: string, caller?: string): boolean {
  const access = agentAccess(agentId, caller)
  if (access === 'ok') return false
  sendJson(res, access === 'unknown' ? 404 : 403, {
    error: access === 'unknown' ? 'Unknown agent' : 'Forbidden: not the agent owner',
  })
  return true
}

/** The real agents this platform knows, in a public discovery shape. Shared by the
 *  REST /api/agents endpoint and the MCP `list_agents` tool. No mocks. */
export function publicAgents() {
  return listPlatformAgents().map((a) => ({
    agentId: a.onchainAgentId ? `eip155:${a.chainId}:8004/${a.onchainAgentId}` : a.id,
    name: a.name,
    chain: a.chain,
    kya: a.kya,
    onchain: a.onchain,
    walletAddress: a.walletAddress,
    onchainExplorer: a.onchainExplorer,
  }))
}

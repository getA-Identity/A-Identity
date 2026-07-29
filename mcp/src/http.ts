#!/usr/bin/env node
/**
 * A-Identity MCP server - HTTP entry (Streamable HTTP + REST companion).
 *
 *   POST /mcp           to MCP Streamable HTTP (JSON-RPC 2.0, enableJsonResponse)
 *   GET  /health        to liveness probe
 *   GET  /api/agent     to REST: resolve agent (?q=<query>[&chain=<chain>])
 *   GET  /api/reputation to  REST: get reputation (?id=<agentId>)
 *   GET  /api/chains    to REST: list chains and agent counts
 *   GET  /api/agents    to REST: list agents (?chain=<chain>)
 */
import http from 'node:http'
import { URL } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer } from './server.js'
import { CHAIN_CONFIG } from './data.js'
import { renderBadgeSvg } from './policy/index.js'
import { createIdentityProvider } from './erc8004.js'
import { getArcStatus } from './arc.js'
import { getCircleStatus } from './circle.js'
import { readArcContracts, registerAgentOnchain, createJobOnchain, runEscrowJobDemo, readMemosOnchain, rejectJobOnchain, claimJobRefundOnchain, readJobOnchain, payUsdcBatchOnchain } from './arc-contracts.js'
import {
  agentPolicy,
  getAgentActionPolicy,
  updateAgentActionPolicy,
  checkAgentAction,
  platformTraction,
  guardrailSelfCheck,
  listAgentAudits,
  recordAuditOutcome,
  registerAgentFromManifest,
  agentRegistration,
  setBadgeVisibility,
  agentBadge,
  agentReputation,
  anchorAgentOnchain,
  approveInstruction,
  assignWallet,
  createAgent,
  createInstruction,
  initState,
  recordWallet,
  executeInstruction,
  followAgent,
  getWalletBalance,
  listInstructions,
  listInstructionsForOwner,
  agentAccess,
  listPlatformAgents,
  marketplace,
  updateAgentPermissions,
  provisionAgentVault,
  getAgentVault,
  grantAgentSessionKey,
  provisionCircleWallet,
  getAgentCircleWallet,
  startKyaChallenge,
  verifyKya,
  revokeAgentKya,
  getAgentKya,
  getAgentTreasury,
  startAgentAutoYield,
  stopAgentAutoYield,
  hireAgent,
  deliverTask,
  releaseTask,
  disputeTask,
  getTask,
  listTasksForClient,
  listTasksForAgent,
  marketplaceCatalog,
  agentManifest,
  registerExternalAgent,
  postOpenTask,
  bidOnTask,
  acceptBid,
  listOpenTasks,
  type InstructionType,
} from './platform.js'
import { issueToken, verifyToken, isVerified } from './auth.js'
import { magicEnabled, sendMagicLink, verifyMagicToken } from './magic.js'
import {
  x402PayTo, paymentRequirements, verifyPayment, premiumResource,
  issueX402Nonce, x402NonceValid, consumeX402Nonce, verifyPayerBinding,
} from './x402.js'
import { nanoPaymentRequirements, settleNano, nanoResource, runNanopayDemo } from './nanopay.js'
import { runGatewayDemo, gatewayBalance } from './gateway.js'
import { runCctpDemo } from './cctp.js'
import { runAgentRun } from './autopilot.js'
import { runTrustOracleDogfood } from './trust-oracle.js'
import { runSessionKeyDemo } from './aa-wallet.js'
import { randomBytes } from 'node:crypto'

// Render/most hosts inject PORT; fall back to our own var, then the local default.
const PORT = Number(process.env.PORT ?? process.env.A_IDENTITY_HTTP_PORT ?? 3399)

// CORS: an explicit allowlist (comma-separated origins in ALLOWED_ORIGINS) locks the
// API to known frontends in production; unset → '*' for local Vite dev. Prod uses a
// same-origin Vercel proxy, so setting ALLOWED_ORIGINS to the site's origin(s) means
// only the real app can call the API cross-origin.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim().toLowerCase())
  .filter(Boolean)

/** Resolve the Access-Control-Allow-Origin value for a request's Origin header. Echoes the
 *  caller's origin so credentialed (cookie) requests are allowed. With no allowlist (dev) it
 *  echoes whatever origin called — safe because the session cookie is SameSite=Lax, so it is
 *  never sent on a cross-site fetch from another origin. */
function resolveCorsOrigin(origin: string | undefined): string {
  if (ALLOWED_ORIGINS.length === 0) return origin ?? '*'
  if (origin && ALLOWED_ORIGINS.includes(origin.toLowerCase())) return origin
  return ALLOWED_ORIGINS[0] // a safe default so preflights still get a concrete allowed origin
}

// ── HttpOnly session cookie (closes the JS-readable-token exposure) ────────────────
// The session token also rides in an HttpOnly cookie, so the SPA never has to keep it in
// localStorage. In prod the app is same-origin (Vercel proxy → Render), so the cookie is
// first-party; SameSite=Lax + Secure. Requests may still present a Bearer token (the
// in-memory fallback), so both paths are accepted.
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER || !!process.env.RENDER_EXTERNAL_URL
const SESSION_COOKIE = 'aid_session'
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 // seconds

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}${IS_PROD ? '; Secure' : ''}`
}
function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${IS_PROD ? '; Secure' : ''}`
}

/**
 * Short-lived Sign-In-with-Ethereum nonces, keyed by lowercase wallet address.
 * In-memory + a 10-minute TTL: a nonce expires if unused and stale entries can't pile
 * up. Correct for our single backend instance; a scaled deploy would move these (and
 * the KYA challenges in platform.ts, and the x402 nonces) to shared storage.
 */
const NONCE_TTL_MS = 10 * 60 * 1000
const nonces = new Map<string, { nonce: string; exp: number }>()

// ── basic per-IP rate limiting (in-memory, per-process) ──────────────────────────
// Fixed-window counters for sensitive/expensive endpoints, so a single client can't
// spam auth challenges, magic-link emails, or the on-chain demo runs. Process-local by
// design (same as the nonce / KYA / x402 stores); a horizontally-scaled deploy would move
// this (and those) to a shared store.
const rlBuckets = new Map<string, { count: number; resetAt: number }>()

function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const b = rlBuckets.get(key)
  if (!b || b.resetAt <= now) {
    rlBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  b.count += 1
  return b.count > max
}

// Prune expired buckets occasionally so the map can't grow unbounded. unref() so this
// timer never keeps the process alive on its own.
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of rlBuckets) if (v.resetAt <= now) rlBuckets.delete(k)
}, 5 * 60 * 1000).unref()

/** Per-path rate budget, or null when the path isn't limited. */
function rateBudget(method: string, pathname: string): { bucket: string; max: number; windowMs: number } | null {
  if (method !== 'POST') return null
  // Auth challenges + guest login: cheap to abuse, keep them tight.
  if (pathname === '/api/auth/nonce' || pathname === '/api/auth/verify' || pathname === '/api/auth/login')
    return { bucket: 'auth', max: 20, windowMs: 60_000 }
  // Passwordless email: sends a real email, so limit hardest.
  if (pathname === '/api/auth/magic/request') return { bucket: 'magic', max: 5, windowMs: 60_000 }
  // Expensive on-chain demo runs (each spends gas / moves real testnet value).
  if (pathname === '/api/arc/agent-run' || (pathname.startsWith('/api/arc/') && pathname.endsWith('-demo')))
    return { bucket: 'demo', max: 8, windowMs: 60_000 }
  // Marketplace release/dispute run a real ERC-8183 escrow lifecycle from the shared signer.
  if (pathname === '/api/marketplace/release' || pathname === '/api/marketplace/dispute')
    return { bucket: 'demo', max: 8, windowMs: 60_000 }
  // MCP can also drive a release (release_escrow tool) which spends the shared signer, so cap
  // the whole /mcp endpoint. A backstop against escrow-release spam via MCP (a per-tool limit is
  // the finer follow-up); normal MCP usage stays well under it.
  if (pathname === '/mcp') return { bucket: 'mcp', max: 40, windowMs: 60_000 }
  return null
}

// Number of trusted reverse proxies in front of us (Render/Vercel terminate as 1 hop).
// The real client IP is the XFF entry `TRUSTED_PROXY_COUNT` from the END — NOT the first
// entry, which is fully attacker-controlled (a spoofed X-Forwarded-For would otherwise give
// each request a fresh rate-limit bucket and defeat the limiter entirely).
const TRUSTED_PROXY_COUNT = Math.max(1, Number(process.env.TRUSTED_PROXY_COUNT ?? 1))

function clientIpOf(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean)
    // Take the hop just before our trusted proxy layer; clamp if fewer entries than expected.
    const idx = Math.max(0, parts.length - TRUSTED_PROXY_COUNT)
    if (parts[idx]) return parts[idx]
  }
  return req.socket.remoteAddress || 'unknown'
}

/** Hard cap on a request body. Every endpoint here takes a small JSON object; a bigger
 *  body is abuse (memory spike + it would balloon the single persisted state blob). */
const MAX_BODY_BYTES = 256 * 1024

function readBody(req: http.IncomingMessage): Promise<unknown> {
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
function validAmount(v: unknown, max = 1_000_000): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
}
/** Clamp a client-supplied USD amount into [0, max]; non-numbers → `fallback`. */
function clampUsd(v: unknown, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : fallback
}
/** The on-chain demo endpoints spend the shared server signer. Cap client-chosen amounts
 *  so an internet caller can't force a large deposit/transfer from the house key. Returns
 *  `undefined` for a missing/invalid value so the runner falls back to its own small default. */
const MAX_DEMO_USD = 5
function cappedDemoUsd(v: unknown, max = MAX_DEMO_USD): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : undefined
}

/** Parse a caller-supplied ERC-8183 jobId (string or number) into a non-negative bigint,
 *  or null if it isn't a valid non-negative integer. Bounds the value so a malformed id
 *  can't reach the chain layer. */
function jobIdFromInput(v: unknown): bigint | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? BigInt(v) : null
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim())
  return null
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Map a platform error message to an HTTP status. */
function errStatus(msg: string): number {
  return msg.startsWith('Forbidden') ? 403 : msg.startsWith('Unknown') ? 404 : 400
}

/** Guard an agent-scoped private read (policy / vault / treasury / Circle wallet / payment
 *  history): only the owner may read it. Returns true (and sends the response) when access
 *  is denied, so a handler can `if (denyRead(...)) return`. Public reads (identity resolve,
 *  reputation, marketplace) never call this. */
function denyRead(res: http.ServerResponse, agentId: string, caller?: string): boolean {
  const access = agentAccess(agentId, caller)
  if (access === 'ok') return false
  sendJson(res, access === 'unknown' ? 404 : 403, {
    error: access === 'unknown' ? 'Unknown agent' : 'Forbidden: not the agent owner',
  })
  return true
}

/** The real agents this platform knows, in a public discovery shape. Shared by the
 *  REST /api/agents endpoint and the MCP `list_agents` tool. No mocks. */
function publicAgents() {
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

const server = http.createServer(async (req, res) => {
  // CORS: '*' for local dev, or the request's origin when it's on the ALLOWED_ORIGINS
  // allowlist (production lockdown). Vary: Origin keeps caches per-origin correct.
  const reqOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const corsOrigin = resolveCorsOrigin(reqOrigin)
  res.setHeader('Access-Control-Allow-Origin', corsOrigin)
  res.setHeader('Vary', 'Origin')
  // Allow the browser to send/receive the HttpOnly session cookie. Credentials can't be
  // combined with '*', so only enable them when echoing a concrete origin.
  if (corsOrigin !== '*') res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  // Includes the x402 payment headers (X-Payment*, PAYMENT-SIGNATURE); without them a
  // cross-origin caller's redemption preflight is blocked and shows as "Failed to fetch".
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Payment, X-Payment-Nonce, X-Payment-Payer, X-Payment-Sig, PAYMENT-SIGNATURE, mcp-session-id, mcp-protocol-version',
  )

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }

  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)

  // Rate-limit sensitive/expensive endpoints per client IP before doing any work.
  const budget = rateBudget(req.method ?? 'GET', url.pathname)
  if (budget && rateLimited(`${clientIpOf(req)}:${budget.bucket}`, budget.max, budget.windowMs)) {
    res.setHeader('Retry-After', String(Math.ceil(budget.windowMs / 1000)))
    sendJson(res, 429, { error: 'Too many requests. Slow down and try again in a minute.' })
    return
  }

  // Session identity from the HttpOnly cookie, or a Bearer token (the in-memory fallback).
  const authHeader = req.headers.authorization
  const bearer = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  const cookieToken = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null
  const caller = verifyToken(bearer ?? cookieToken)
  // The subject string used for ownership checks (email or wallet address).
  const callerId = caller?.subject

  // ── auth: login (public) ──────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = (await readBody(req).catch(() => null)) as { email?: string; name?: string } | null
    if (!body?.email) { sendJson(res, 400, { error: 'email required' }); return }
    const email = String(body.email).trim().toLowerCase()
    // Unverified, browse-only session: the email is NOT proven. This token is a
    // 'guest' — it cannot own agents or mutate. To act, sign in with a wallet or a
    // magic link (both verified). This is what closes the email-impersonation hole.
    const token = issueToken(email, 'guest')
    res.setHeader('Set-Cookie', sessionCookie(token))
    sendJson(res, 200, {
      token,
      user: { email, name: body.name?.trim() || email.split('@')[0] },
    })
    return
  }

  // ── auth: wallet nonce (public) — start Sign-In with Ethereum ─────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/nonce') {
    const body = (await readBody(req).catch(() => null)) as { address?: string } | null
    if (!body?.address || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      sendJson(res, 400, { error: 'valid address required' }); return
    }
    const addr = body.address.toLowerCase()
    const nonce = randomBytes(16).toString('hex')
    nonces.set(addr, { nonce, exp: Date.now() + NONCE_TTL_MS })
    const message = `A-Identity: sign in with your wallet.\n\nAddress: ${addr}\nNonce: ${nonce}`
    sendJson(res, 200, { message })
    return
  }

  // ── auth: wallet verify (public) — finish SIWE, issue a session token ─────────
  if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
    const body = (await readBody(req).catch(() => null)) as
      | { address?: string; message?: string; signature?: string }
      | null
    if (!body?.address || !body?.message || !body?.signature) {
      sendJson(res, 400, { error: 'address, message, signature required' }); return
    }
    const addr = body.address.toLowerCase()
    const entry = nonces.get(addr)
    if (entry && entry.exp <= Date.now()) nonces.delete(addr)
    const nonce = entry && entry.exp > Date.now() ? entry.nonce : undefined
    if (!nonce || !body.message.includes(nonce)) {
      sendJson(res, 401, { error: 'stale or missing nonce; request a new one' }); return
    }
    try {
      const { verifyMessage } = await import('viem')
      const ok = await verifyMessage({
        address: addr as `0x${string}`,
        message: body.message,
        signature: body.signature as `0x${string}`,
      })
      if (!ok) { sendJson(res, 401, { error: 'signature does not match address' }); return }
    } catch {
      sendJson(res, 401, { error: 'signature verification failed' }); return
    }
    nonces.delete(addr)
    // Wallet ownership proven by signature → a verified session.
    const token = issueToken(addr, 'wallet')
    res.setHeader('Set-Cookie', sessionCookie(token))
    sendJson(res, 200, {
      token,
      user: { email: addr, name: `${addr.slice(0, 6)}...${addr.slice(-4)}` },
    })
    return
  }

  // ── auth: passwordless email magic-link (public; credential-gated behind Resend) ──
  if (req.method === 'POST' && url.pathname === '/api/auth/magic/request') {
    const body = (await readBody(req).catch(() => null)) as { email?: string } | null
    const email = body?.email?.trim().toLowerCase()
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      sendJson(res, 400, { error: 'A valid email is required' }); return
    }
    const err = await sendMagicLink(email)
    if (err) { sendJson(res, magicEnabled() ? 502 : 501, { sent: false, error: err }); return }
    sendJson(res, 200, { sent: true })
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/magic/verify') {
    const body = (await readBody(req).catch(() => null)) as { token?: string } | null
    const email = verifyMagicToken(body?.token)
    if (!email) { sendJson(res, 401, { error: 'This sign-in link is invalid or expired.' }); return }
    // Email ownership proven by the one-time link → a verified session.
    const token = issueToken(email, 'email')
    res.setHeader('Set-Cookie', sessionCookie(token))
    sendJson(res, 200, { token, user: { email, name: email.split('@')[0] } })
    return
  }

  // ── auth: who am I (restores a session from the HttpOnly cookie on reload) ─────
  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    if (!caller) { sendJson(res, 401, { error: 'not signed in' }); return }
    const name =
      caller.method === 'wallet'
        ? `${caller.subject.slice(0, 6)}...${caller.subject.slice(-4)}`
        : caller.subject.split('@')[0]
    sendJson(res, 200, { user: { email: caller.subject, name }, method: caller.method, verified: isVerified(caller) })
    return
  }
  // ── auth: logout (clears the session cookie) ──────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    res.setHeader('Set-Cookie', clearSessionCookie())
    sendJson(res, 200, { ok: true })
    return
  }

  // Guard: every other mutating /api endpoint requires a VERIFIED session. No token
  // → 401. A guest (unverified email) token → 403: guests are browse-only, so a
  // token minted for an arbitrary email can never act as an agent's owner.
  const isMutation =
    req.method === 'POST' && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/')
  if (isMutation && !caller) {
    sendJson(res, 401, { error: 'Authentication required. Sign in with a wallet or an email link.' })
    return
  }
  if (isMutation && !isVerified(caller)) {
    sendJson(res, 403, {
      error:
        'Verified sign-in required. Guest sessions are read-only — sign in with your wallet or an emailed magic link to act.',
    })
    return
  }

  // ── /health ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      server: 'a-identity-mcp',
      version: '0.2.0',
      transport: 'streamable-http',
      chains: CHAIN_CONFIG.map((c) => ({ id: c.id, status: c.status })),
    })
    return
  }

  // ── REST /api/agent — LIVE on-chain ERC-8004 resolve (Arc), no mocks ──────────
  if (req.method === 'GET' && url.pathname === '/api/agent') {
    const q = url.searchParams.get('q') ?? ''
    if (!q) { sendJson(res, 400, { error: 'Missing ?q= parameter' }); return }
    const provider = createIdentityProvider()
    const agent = await provider.resolve(q)
    if (!agent) { sendJson(res, 404, { found: false, query: q, reason: 'No matching ERC-8004 registration on-chain' }); return }
    sendJson(res, 200, { found: true, source: provider.kind, agent })
    return
  }

  // ── REST /api/reputation — real, from platform settlements + on-chain identity ──
  if (req.method === 'GET' && url.pathname === '/api/reputation') {
    const id = url.searchParams.get('id') ?? ''
    if (!id) { sendJson(res, 400, { error: 'Missing ?id= parameter' }); return }
    let rep = agentReputation(id)
    // Accept an on-chain id too (e.g. "eip155:5042002:8004/849980" or a bare token id):
    // map it to the platform agent anchored at that ERC-8004 token, then score it for real.
    if ('error' in rep) {
      const tokenId = id.match(/(\d+)\s*$/)?.[1]
      const anchored = tokenId ? listPlatformAgents().find((a) => a.onchainAgentId === tokenId) : undefined
      if (anchored) rep = agentReputation(anchored.id)
    }
    if ('error' in rep) { sendJson(res, 404, { found: false, agentId: id, reason: 'Unknown agent or no activity yet' }); return }
    sendJson(res, 200, { found: true, reputation: rep })
    return
  }

  // ── REST /api/chains ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/chains') {
    sendJson(res, 200, { chains: CHAIN_CONFIG })
    return
  }

  // ── REST /api/arc (live Circle Arc testnet status) ────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/arc') {
    const status = await getArcStatus()
    sendJson(res, status.online ? 200 : 503, status)
    return
  }

  // ── REST /api/circle (Circle developer platform link state) ──────────────────
  if (req.method === 'GET' && url.pathname === '/api/circle') {
    sendJson(res, 200, await getCircleStatus())
    return
  }

  // ── x402: pay-per-request paid resource (real on-chain USDC settlement) ───────
  if (req.method === 'GET' && url.pathname === '/api/x402/data') {
    const payTo = await x402PayTo()
    if (!payTo) { sendJson(res, 501, { error: 'x402 not configured (no payTo / signer key)' }); return }
    const proof = req.headers['x-payment']
    if (typeof proof !== 'string' || !proof) {
      // No payment yet -> 402 with machine-readable requirements + a fresh single-use
      // nonce. The client echoes this nonce in X-Payment-Nonce when it redeems.
      sendJson(res, 402, paymentRequirements(payTo, issueX402Nonce()))
      return
    }
    // Redeem: the payment must answer THIS challenge — a live nonce we issued, bound to
    // this resource. Without it, an unrelated USDC transfer can't blind-unlock the data.
    const nonce = typeof req.headers['x-payment-nonce'] === 'string' ? req.headers['x-payment-nonce'] : undefined
    if (!x402NonceValid(nonce)) {
      sendJson(res, 402, { ...paymentRequirements(payTo, issueX402Nonce()), verifyError: 'missing or stale payment nonce; re-quote to get a fresh one' })
      return
    }
    // Bind the redemption to the actual PAYER. The client proves control of the paying
    // wallet by signing the (nonce, payer) challenge; we then require the on-chain payment
    // to originate from that same wallet. This is what stops a front-runner who scraped the
    // tx hash off the public chain (or any unrelated transfer to payTo) from redeeming a
    // payment they did not make.
    const payer = typeof req.headers['x-payment-payer'] === 'string' ? req.headers['x-payment-payer'] : undefined
    const paySig = typeof req.headers['x-payment-sig'] === 'string' ? req.headers['x-payment-sig'] : undefined
    if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer) || !paySig) {
      // Keep the same nonce live so the client can sign and retry without re-quoting.
      sendJson(res, 402, { ...paymentRequirements(payTo, nonce), verifyError: 'payer proof required: sign the x402 authorization with the paying wallet (X-Payment-Payer + X-Payment-Sig)' })
      return
    }
    if (!(await verifyPayerBinding(nonce!, payer, paySig))) {
      sendJson(res, 402, { ...paymentRequirements(payTo, nonce), verifyError: 'payer signature does not match the paying wallet' })
      return
    }
    const verified = await verifyPayment(proof, payTo, payer)
    if (!verified.ok) {
      // Keep the same nonce live (echo it back) so the client can retry while the
      // payment is still confirming; only a real failure/expiry forces a re-quote.
      sendJson(res, 402, { ...paymentRequirements(payTo, nonce), verifyError: verified.reason })
      return
    }
    consumeX402Nonce(nonce!) // one challenge unlocks the resource exactly once
    sendJson(res, 200, await premiumResource(proof))
    return
  }

  // ── x402 Nanopayments seller: gasless, Gateway-batched USDC (x402 v2) ─────────
  // Second x402 rail. No PAYMENT-SIGNATURE → 402 v2 with the GatewayWalletBatched
  // requirements; with one → settle through Circle Gateway and serve immediately.
  if (req.method === 'GET' && url.pathname === '/api/x402/nano/data') {
    const requirements = await nanoPaymentRequirements()
    if (!requirements) { sendJson(res, 501, { error: 'nanopayments not configured (no payTo / Gateway rail)' }); return }
    const proof = req.headers['payment-signature']
    if (typeof proof !== 'string' || !proof) {
      res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(requirements)).toString('base64'))
      sendJson(res, 402, requirements)
      return
    }
    const settled = await settleNano(proof)
    if (!settled.ok) { sendJson(res, 402, { ...requirements, settleError: settled.reason }); return }
    res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify(settled.settle)).toString('base64'))
    sendJson(res, 200, nanoResource(settled.settle))
    return
  }

  // ── REST /api/arc/contracts (LIVE reads of real ERC-8004 + ERC-8183) ─────────
  if (req.method === 'GET' && url.pathname === '/api/arc/contracts') {
    const data = await readArcContracts()
    sendJson(res, data.reachable ? 200 : 503, data)
    return
  }

  // ── REST /api/arc/memos: the on-chain "why" audit trail (Arc Memo precompile) ──
  // Public read of the Memo event log, filtered by the indexed memoId and/or sender,
  // block-bounded (DoS guard: maxBlocks is clamped in the adapter). Proves that an
  // agent settlement's reason is provably on-chain and indexable, not a server log.
  if (req.method === 'GET' && url.pathname === '/api/arc/memos') {
    const memoId = url.searchParams.get('memoId') ?? undefined
    const sender = url.searchParams.get('sender') ?? undefined
    if (memoId && !/^0x[0-9a-fA-F]{64}$/.test(memoId)) { sendJson(res, 400, { error: 'memoId must be a 32-byte 0x hash' }); return }
    if (sender && !/^0x[0-9a-fA-F]{40}$/.test(sender)) { sendJson(res, 400, { error: 'sender must be a 0x address' }); return }
    const maxParam = Number(url.searchParams.get('maxBlocks'))
    const maxBlocks = Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined
    try {
      const data = await readMemosOnchain({ memoId, sender, maxBlocks })
      sendJson(res, 200, data)
    } catch (err) {
      sendJson(res, 502, { supported: true, memos: [], error: err instanceof Error ? err.message : String(err) })
    }
    return
  }

  // ── Real on-chain agent registration (ERC-8004). Env-gated; prepared w/o key ──
  if (req.method === 'POST' && url.pathname === '/api/arc/register-onchain') {
    const body = (await readBody(req).catch(() => null)) as { metadataUri?: string } | null
    const uri = body?.metadataUri ?? 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei'
    sendJson(res, 200, await registerAgentOnchain(uri))
    return
  }

  // ── Real ERC-8183 job (escrow). Env-gated; prepared w/o key ──────────────────
  if (req.method === 'POST' && url.pathname === '/api/arc/create-job') {
    const body = (await readBody(req).catch(() => null)) as
      | { provider?: string; evaluator?: string; description?: string }
      | null
    if (!body?.provider || !body?.evaluator) { sendJson(res, 400, { error: 'provider and evaluator required' }); return }
    sendJson(res, 200, await createJobOnchain({
      provider: body.provider,
      evaluator: body.evaluator,
      description: body.description ?? 'A-Identity agentic-commerce job',
    }))
    return
  }

  // ── One-click ERC-8183 lifecycle demo: complete (release) OR refund (dispute) ──
  if (req.method === 'POST' && url.pathname === '/api/arc/job-demo') {
    const body = (await readBody(req).catch(() => null)) as { budgetUsd?: number; description?: string; outcome?: string } | null
    const outcome = body?.outcome === 'refund' ? 'refund' : 'complete'
    sendJson(res, 200, await runEscrowJobDemo({ budgetUsd: body?.budgetUsd, description: body?.description, outcome }))
    return
  }

  // ── Dispute a job: the evaluator rejects the deliverable → client refunded on-chain ─
  if (req.method === 'POST' && url.pathname === '/api/arc/job/dispute') {
    const body = (await readBody(req).catch(() => null)) as { jobId?: string | number; reason?: string } | null
    const jobId = jobIdFromInput(body?.jobId)
    if (jobId === null) { sendJson(res, 400, { error: 'jobId (non-negative integer) required' }); return }
    sendJson(res, 200, await rejectJobOnchain(jobId, typeof body?.reason === 'string' ? body.reason.slice(0, 200) : 'disputed'))
    return
  }

  // ── Reclaim escrow for the client after a job's deadline (expiry refund) ──────
  if (req.method === 'POST' && url.pathname === '/api/arc/job/claim-refund') {
    const body = (await readBody(req).catch(() => null)) as { jobId?: string | number } | null
    const jobId = jobIdFromInput(body?.jobId)
    if (jobId === null) { sendJson(res, 400, { error: 'jobId (non-negative integer) required' }); return }
    sendJson(res, 200, await claimJobRefundOnchain(jobId))
    return
  }

  // ── Live on-chain job state (status, parties, budget) — public read ──────────
  if (req.method === 'GET' && url.pathname === '/api/arc/job') {
    const jobId = jobIdFromInput(url.searchParams.get('jobId'))
    if (jobId === null) { sendJson(res, 400, { error: 'jobId (non-negative integer) required' }); return }
    sendJson(res, 200, await readJobOnchain(jobId))
    return
  }

  // ── Circle Gateway: live unified USDC balance (public read) ───────────────────
  if (req.method === 'GET' && url.pathname === '/api/arc/gateway-balance') {
    const address = url.searchParams.get('address') ?? ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { sendJson(res, 400, { error: 'valid ?address= required' }); return }
    sendJson(res, 200, await gatewayBalance(address))
    return
  }

  // ── Circle Gateway: one-click deposit + gasless cross-chain transfer (Arc→Base) ──
  if (req.method === 'POST' && url.pathname === '/api/arc/gateway-demo') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await runGatewayDemo({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return
  }

  // ── Circle Nanopayments: one-click gasless, Gateway-batched USDC nanopayment ──
  if (req.method === 'POST' && url.pathname === '/api/arc/nanopay-demo') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await runNanopayDemo({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return
  }

  // ── Circle CCTP: one-click native USDC bridge (burn-and-mint) Arc → Base Sepolia ──
  if (req.method === 'POST' && url.pathname === '/api/arc/cctp-demo') {
    const body = (await readBody(req).catch(() => null)) as { amountUsd?: number } | null
    sendJson(res, 200, await runCctpDemo({ amountUsd: cappedDemoUsd(body?.amountUsd) }))
    return
  }

  // ── Autonomous agent run: the agent pays a service on its own until it hits the
  //    human-set budget, then stops itself; a protocol fee is routed to the treasury.
  if (req.method === 'POST' && url.pathname === '/api/arc/agent-run') {
    const body = (await readBody(req).catch(() => null)) as { maxCalls?: number; amountUsd?: number; budgetUsd?: number } | null
    // Cap the client-chosen amounts: this run deposits/spends the shared server signer.
    sendJson(res, 200, await runAgentRun({
      maxCalls: body?.maxCalls,
      amountUsd: cappedDemoUsd(body?.amountUsd, 0.05),
      budgetUsd: cappedDemoUsd(body?.budgetUsd, MAX_DEMO_USD),
    }))
    return
  }

  // ── Batched settlement (bonus E): settle N USDC transfers ATOMICALLY in one Arc tx via
  //    Multicall3From (EOA preserved). Demonstrates Arc-native batching / high-frequency
  //    agent payments. Env-gated; prepared without a key; demo amounts/count are capped.
  if (req.method === 'POST' && url.pathname === '/api/arc/batch-demo') {
    const body = (await readBody(req).catch(() => null)) as { count?: number; amountUsd?: number } | null
    const count = Number.isFinite(body?.count) ? Math.min(Math.max(Math.floor(body!.count!), 1), 5) : 3
    const amountUsd = cappedDemoUsd(body?.amountUsd, 0.05) ?? 0.01
    // Distinct demo payees, so the batch shows "one Arc tx, many recipients".
    const demoPayees = [
      '0x000000000000000000000000000000000000dEaD',
      '0x000000000000000000000000000000000000bEEF',
      '0x0000000000000000000000000000000000000A11',
      '0x0000000000000000000000000000000000000B22',
      '0x0000000000000000000000000000000000000C33',
    ]
    const payments = Array.from({ length: count }, (_, i) => ({ to: demoPayees[i % demoPayees.length], amountUsd }))
    sendJson(res, 200, await payUsdcBatchOnchain(payments))
    return
  }

  // ── ERC-4337 session-key smart account (idea C2): deploy a Kernel SCA, grant a session
  //    key scoped to cap/allowlist/expiry, and settle a REAL UserOp within bounds while an
  //    out-of-bounds payment is rejected on-chain by the policy validator. Credential-gated
  //    on PIMLICO_API_KEY (prepared without it).
  if (req.method === 'POST' && url.pathname === '/api/arc/session-key-demo') {
    const body = (await readBody(req).catch(() => null)) as { capUsd?: number; expirySeconds?: number; sponsorGas?: boolean } | null
    const expirySeconds = typeof body?.expirySeconds === 'number' && Number.isFinite(body.expirySeconds)
      ? Math.min(Math.max(body.expirySeconds, 60), 86400) : undefined
    sendJson(res, 200, await runSessionKeyDemo({ capUsd: cappedDemoUsd(body?.capUsd, 1), expirySeconds, sponsorGas: body?.sponsorGas === true }))
    return
  }

  // ── Trust Oracle dogfood: a buyer agent pays risk_check over x402 (Arc nanopayment)
  //    then acts on the ALLOW/WARN/DENY verdict. The consumer side of the same Trust
  //    Oracle we list on Circle's Agent Marketplace. Env-gated; prepared without a key.
  if (req.method === 'POST' && url.pathname === '/api/arc/trust-oracle-demo') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; txContext?: { amountUsd?: number; kind?: string } } | null
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required (platform id, ERC-8004 token id, or 0x owner address)' }); return }
    if (agentId.length > 128) { sendJson(res, 400, { error: 'agentId too long (max 128 chars)' }); return }
    const txContext = body?.txContext && typeof body.txContext === 'object'
      ? { amountUsd: cappedDemoUsd(body.txContext.amountUsd), kind: typeof body.txContext.kind === 'string' ? body.txContext.kind.slice(0, 40) : undefined }
      : null
    sendJson(res, 200, await runTrustOracleDogfood({ agentId, txContext }))
    return
  }

  // ── REST /api/agents — real agents this platform knows (no mocks) ─────────────
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    const agents = publicAgents()
    sendJson(res, 200, { total: agents.length, source: 'platform', agents })
    return
  }

  // ── Platform: wallets ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/wallets') {
    const body = (await readBody(req).catch(() => null)) as { address?: string } | null
    // No-custody by construction: the client generates the keypair in the browser and only
    // ever sends the public address. The server never generates or returns a private key
    // (the old server-side fallback returned a raw key over HTTP — removed).
    if (!body?.address || !/^0x[0-9a-fA-F]{40}$/.test(body.address)) {
      sendJson(res, 400, { error: 'a client-generated wallet address (0x…) is required; the server never creates or holds private keys' })
      return
    }
    sendJson(res, 201, recordWallet(body.address))
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/wallets/assign') {
    const body = (await readBody(req).catch(() => null)) as { address?: string; agentId?: string } | null
    if (!body?.address || !body?.agentId) { sendJson(res, 400, { error: 'address and agentId required' }); return }
    const w = assignWallet(body.address, body.agentId, callerId)
    if ('error' in w) { sendJson(res, errStatus(w.error), w); return }
    sendJson(res, 200, w)
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/wallet-balance') {
    const address = url.searchParams.get('address') ?? ''
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { sendJson(res, 400, { error: 'valid ?address= required' }); return }
    sendJson(res, 200, await getWalletBalance(address))
    return
  }

  // ── Platform: agents ──────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/agents') {
    const body = (await readBody(req).catch(() => null)) as {
      name?: string; description?: string; category?: string
      capabilities?: string[]; permissions?: Record<string, unknown>; walletAddress?: string
    } | null
    if (!body?.name) { sendJson(res, 400, { error: 'name required' }); return }
    const agent = createAgent({
      name: body.name,
      description: body.description ?? '',
      category: body.category ?? 'Other',
      capabilities: Array.isArray(body.capabilities) ? body.capabilities : [],
      permissions: (body.permissions ?? {}) as never,
      walletAddress: body.walletAddress,
      owner: callerId,
    })
    sendJson(res, 201, { agent })
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/platform-agents') {
    // Scoped to the caller: the app lists/manages only the agents you own. No session,
    // or a guest with none, gets an empty list (public discovery is /api/marketplace).
    const owned = callerId ? listPlatformAgents().filter((a) => a.owner === callerId) : []
    sendJson(res, 200, { agents: owned })
    return
  }
  // Anchor an existing platform agent on-chain (real ERC-8004 register, env-gated)
  if (req.method === 'POST' && url.pathname === '/api/agents/anchor') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r = await anchorAgentOnchain(body.agentId, callerId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Provision an on-chain policy vault for an agent (deploy + optional funding, env-gated)
  if (req.method === 'POST' && url.pathname === '/api/agents/vault') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; fundUsd?: number; ownerAddress?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    // fundUsd is deposited from the shared server signer — cap it like the other demo spends.
    const r = await provisionAgentVault(body.agentId, { fundUsd: cappedDemoUsd(body.fundUsd), caller: callerId, ownerAddress: body.ownerAddress })
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Grant / extend / revoke the agent's on-chain SESSION KEY (a time-bounded spend
  // authority on the vault). Owner-only; env-gated. Body: { agentId, durationHours | revoke }.
  if (req.method === 'POST' && url.pathname === '/api/agents/session-key') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; durationHours?: number; expiryUnix?: number; revoke?: boolean } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    // Bound the duration so a caller can't set a nonsensical far-future expiry (max ~30 days).
    const durationHours = typeof body.durationHours === 'number' && Number.isFinite(body.durationHours)
      ? Math.min(Math.max(body.durationHours, 0), 24 * 30)
      : undefined
    const r = await grantAgentSessionKey(body.agentId, { durationHours, expiryUnix: body.expiryUnix, revoke: body.revoke === true }, callerId)
    if (r.reason && !r.granted && !r.ownerGated && (r.reason.startsWith('Forbidden') || r.reason.startsWith('Unknown'))) {
      sendJson(res, errStatus(r.reason), r); return
    }
    sendJson(res, 200, r)
    return
  }
  // Read an agent's live on-chain vault policy + balance
  if (req.method === 'GET' && url.pathname === '/api/agents/vault') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    if (denyRead(res, agentId, callerId)) return
    const r = await getAgentVault(agentId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Provision a Circle Agent Wallet for an agent (hosted policy layer, credential-gated)
  if (req.method === 'POST' && url.pathname === '/api/agents/circle-wallet') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; fund?: boolean } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r = await provisionCircleWallet(body.agentId, { fund: body.fund, caller: callerId })
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Read an agent's live Circle Agent Wallet state + balances
  if (req.method === 'GET' && url.pathname === '/api/agents/circle-wallet') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    if (denyRead(res, agentId, callerId)) return
    const r = await getAgentCircleWallet(agentId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // ── Treasury: idle-balance auto-yield into USYC (Circle's yield-bearing token) ──
  // Live multi-asset balances + deployable idle + projected USYC earnings (read-only)
  if (req.method === 'GET' && url.pathname === '/api/agents/treasury') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    if (denyRead(res, agentId, callerId)) return
    const capParam = url.searchParams.get('cap')
    const cap = capParam !== null && Number.isFinite(Number(capParam)) ? Number(capParam) : undefined
    const r = await getAgentTreasury(agentId, cap)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Owner authorizes (or turns off) auto-yield at a working-capital cap
  if (req.method === 'POST' && url.pathname === '/api/agents/treasury') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; capUsd?: number; enabled?: boolean } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r =
      body.enabled === false
        ? stopAgentAutoYield(body.agentId, callerId)
        : await startAgentAutoYield(body.agentId, typeof body.capUsd === 'number' ? body.capUsd : 25, callerId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // ── KYA (Know Your Agent): prove the agent controls its wallet ─────────────────
  // Start a challenge for the agent to sign (owner-only)
  if (req.method === 'POST' && url.pathname === '/api/agents/kya/challenge') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r = startKyaChallenge(body.agentId, callerId)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Finish KYA: verify the wallet signature, mark verified, attest on-chain (best-effort)
  if (req.method === 'POST' && url.pathname === '/api/agents/kya/verify') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; message?: string; signature?: string } | null
    if (!body?.agentId || !body?.message || !body?.signature) {
      sendJson(res, 400, { error: 'agentId, message, signature required' }); return
    }
    const r = await verifyKya(body.agentId, body.message, body.signature, callerId)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Revoke KYA: flag the agent as an incident (owner-only). risk_check then DENYs it; the
  // agent is no longer hireable. Best-effort negative on-chain attestation (tag "revoked").
  if (req.method === 'POST' && url.pathname === '/api/agents/kya/revoke') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; reason?: string } | null
    if (!body?.agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r = await revokeAgentKya(body.agentId, body.reason ?? '', callerId)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Read an agent's KYA status + live on-chain validation
  if (req.method === 'GET' && url.pathname === '/api/agents/kya') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r = await getAgentKya(agentId)
    if ('error' in r && typeof r.error === 'string') { sendJson(res, errStatus(r.error), r); return }
    sendJson(res, 200, r)
    return
  }
  // Reputation for one agent, computed from real activity
  if (req.method === 'GET' && url.pathname === '/api/agents/reputation') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r = agentReputation(agentId)
    sendJson(res, 'error' in r ? 404 : 200, r)
    return
  }
  // Live policy for one agent (limits + today's spend + reset time)
  if (req.method === 'GET' && url.pathname === '/api/agents/policy') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    if (denyRead(res, agentId, callerId)) return
    const p = agentPolicy(agentId)
    sendJson(res, 'error' in p ? 404 : 200, p)
    return
  }
  // ── Policy Engine v2: the action policy (trade surface today) ────────────────
  // Distinct from /api/agents/policy above, which is the USDC payment policy. Free to
  // read and write: these are the owner's own rules. Owner-gated both ways, since a
  // policy exposes the owner's limits.
  if (req.method === 'GET' && url.pathname === '/api/agents/action-policy') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    if (denyRead(res, agentId, callerId)) return
    const p = getAgentActionPolicy(agentId, callerId)
    sendJson(res, 'error' in p ? errStatus(p.error) : 200, p)
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/agents/action-policy') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; policy?: unknown } | null
    if (!body?.agentId || body.policy === undefined) {
      sendJson(res, 400, { error: 'agentId and policy required' }); return
    }
    const p = updateAgentActionPolicy(body.agentId, body.policy, callerId)
    sendJson(res, 'error' in p ? errStatus(p.error) : 200, p)
    return
  }

  // ── traction + engine self-check (Phase 5.4 and 5.5) ─────────────────────────
  // Public and unauthenticated on purpose: both are aggregate or stateless, so there is
  // nothing here that identifies an agent, an owner, a holding or an individual amount.
  if (req.method === 'GET' && url.pathname === '/api/traction') {
    sendJson(res, 200, platformTraction())
    return
  }
  // "Is the guardrail enforcing right now?" answered by running canonical vectors through
  // the pure engine. Creates nothing and records nothing, so this monitor cannot inflate
  // the traction numbers above.
  if (req.method === 'GET' && url.pathname === '/api/guardrail-status') {
    const status = guardrailSelfCheck()
    sendJson(res, status.enforcing ? 200 : 503, status)
    return
  }

  // ── register_agent + guardrail badge (Phase 1.5) ─────────────────────────────
  // A manifest-shaped registration over the SAME createAgent path the UI uses. Free.
  if (req.method === 'POST' && url.pathname === '/api/agents/register') {
    const body = (await readBody(req).catch(() => null)) as { manifest?: Record<string, unknown> } | null
    const manifest = (body?.manifest ?? body) as Record<string, unknown> | null
    if (!manifest?.name) { sendJson(res, 400, { error: 'manifest.name required' }); return }
    // `ci: true` marks a canary: recorded in full, excluded from traction headlines.
    const r = registerAgentFromManifest(manifest as never, callerId)
    sendJson(res, 'error' in r ? errStatus(r.error) : 201, r)
    return
  }
  // The owner's own registration + badge view.
  if (req.method === 'GET' && url.pathname === '/api/agents/register') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    if (denyRead(res, agentId, callerId)) return
    const r = agentRegistration(agentId, callerId)
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return
  }
  // Publish or unpublish the badge. Off by default: a badge is the owner's own claim.
  if (req.method === 'POST' && url.pathname === '/api/agents/badge-visibility') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; public?: boolean } | null
    if (!body?.agentId || typeof body.public !== 'boolean') {
      sendJson(res, 400, { error: 'agentId and public (boolean) required' }); return
    }
    const r = setBadgeVisibility(body.agentId, body.public, callerId)
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return
  }
  // The public badge. Served only for agents whose owner opted in. Content-negotiated:
  // an SVG for embedding, JSON otherwise. Coarse by design, and it carries no number.
  if (req.method === 'GET' && url.pathname === '/api/agents/badge') {
    const agentId = url.searchParams.get('agentId') ?? ''
    const surface = url.searchParams.get('surface') ?? 'trade'
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const r = agentBadge(agentId, surface)
    if ('error' in r) { sendJson(res, errStatus(r.error), r); return }
    const wantsSvg = (req.headers.accept ?? '').includes('image/svg') || url.searchParams.get('format') === 'svg'
    if (wantsSvg) {
      const svg = renderBadgeSvg(r.badge)
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        // Short cache: a badge must not keep showing "enforced" long after the state moved.
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(svg)
      return
    }
    sendJson(res, 200, { agentId, agentName: r.agentName, ...r.badge })
    return
  }

  // Check an intended action against the policy. Returns a verdict and the audit id; it
  // never executes anything, so the caller stays the one that acts.
  if (req.method === 'POST' && url.pathname === '/api/agents/action-check') {
    const body = (await readBody(req).catch(() => null)) as
      | { agentId?: string; surface?: string; intent?: unknown; snapshot?: unknown }
      | null
    if (!body?.agentId || !body?.surface || !body?.intent) {
      sendJson(res, 400, { error: 'agentId, surface and intent required' }); return
    }
    const r = checkAgentAction(
      body.agentId,
      { surface: body.surface, intent: body.intent as never, snapshot: body.snapshot as never },
      callerId,
    )
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return
  }
  // The decision trail for one agent (owner-gated, newest first, optional ?since=).
  if (req.method === 'GET' && url.pathname === '/api/agents/audit-log') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    if (denyRead(res, agentId, callerId)) return
    const limitRaw = url.searchParams.get('limit')
    const r = listAgentAudits(
      agentId,
      {
        since: url.searchParams.get('since') ?? undefined,
        limit: limitRaw ? Number(limitRaw) : undefined,
      },
      callerId,
    )
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return
  }
  // Record what happened after a verdict (a WARN a human confirmed, or an abandon).
  if (req.method === 'POST' && url.pathname === '/api/agents/audit-log/outcome') {
    const body = (await readBody(req).catch(() => null)) as
      | { agentId?: string; auditId?: string; outcome?: string; evidenceRef?: string }
      | null
    const allowed = ['executed', 'blocked', 'awaiting_human', 'abandoned']
    if (!body?.agentId || !body?.auditId || !body?.outcome) {
      sendJson(res, 400, { error: 'agentId, auditId and outcome required' }); return
    }
    if (!allowed.includes(body.outcome)) {
      sendJson(res, 400, { error: `outcome must be one of: ${allowed.join(', ')}` }); return
    }
    const r = recordAuditOutcome(body.agentId, body.auditId, body.outcome as never, callerId, body.evidenceRef)
    sendJson(res, 'error' in r ? errStatus(r.error) : 200, r)
    return
  }

  // Update an agent's permissions (the real policy the engine enforces)
  if (req.method === 'POST' && url.pathname === '/api/agents/permissions') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; permissions?: Record<string, unknown> } | null
    if (!body?.agentId || !body?.permissions) { sendJson(res, 400, { error: 'agentId and permissions required' }); return }
    const a = await updateAgentPermissions(body.agentId, body.permissions as never, callerId)
    sendJson(res, 'error' in a ? errStatus(a.error) : 200, { agent: a })
    return
  }

  // ── Platform: instructions (pay / purchase / rental / batch) ─────────────────
  if (req.method === 'POST' && url.pathname === '/api/instructions') {
    const body = (await readBody(req).catch(() => null)) as {
      agentId?: string; type?: InstructionType; amountUsd?: number
      count?: number; payee?: string; memo?: string
    } | null
    if (!body?.agentId || !body?.type || !body?.payee) {
      sendJson(res, 400, { error: 'agentId, type, amountUsd, payee required' }); return
    }
    if (!validAmount(body.amountUsd)) {
      // Reject negative/NaN/Infinity here: a negative amount would otherwise subtract from
      // the agent's daily spend, letting an owner rewind their own safety cap.
      sendJson(res, 400, { error: 'amountUsd must be a finite number between 0 and 1000000' }); return
    }
    if (body.count !== undefined && !(Number.isFinite(body.count) && body.count! >= 1 && body.count! <= 1000)) {
      sendJson(res, 400, { error: 'count must be an integer between 1 and 1000' }); return
    }
    const ix = createInstruction({ ...body, caller: callerId } as never)
    sendJson(res, 'error' in ix ? errStatus(ix.error) : 201, ix)
    return
  }
  if (req.method === 'GET' && url.pathname === '/api/instructions') {
    // Owner-scoped: a specific agentId is gated to its owner; without one, return only
    // the caller's own agents' payment history (never everyone's).
    const agentId = url.searchParams.get('agentId') ?? undefined
    if (agentId) {
      if (denyRead(res, agentId, callerId)) return
      sendJson(res, 200, { instructions: listInstructions(agentId) })
    } else {
      sendJson(res, 200, { instructions: listInstructionsForOwner(callerId) })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/instructions/approve') {
    const body = (await readBody(req).catch(() => null)) as { id?: string } | null
    if (!body?.id) { sendJson(res, 400, { error: 'id required' }); return }
    const ix = approveInstruction(body.id, callerId)
    sendJson(res, 'error' in ix ? errStatus(ix.error) : 200, ix)
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/instructions/execute') {
    const body = (await readBody(req).catch(() => null)) as { id?: string } | null
    if (!body?.id) { sendJson(res, 400, { error: 'id required' }); return }
    const ix = await executeInstruction(body.id, callerId)
    sendJson(res, 'error' in ix ? errStatus(ix.error) : 200, ix)
    return
  }

  // ── Platform: marketplace (Agent House) ──────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/marketplace') {
    const includeAll = url.searchParams.get('all') === '1'
    // ?category=trading|spend lists only agents who published a badge AND have been checked
    // on that surface (Phase 5.2).
    sendJson(
      res,
      200,
      marketplace(url.searchParams.get('viewer') ?? undefined, includeAll, url.searchParams.get('category') ?? undefined),
    )
    return
  }
  if (req.method === 'POST' && url.pathname === '/api/follow') {
    const body = (await readBody(req).catch(() => null)) as { agentId?: string; follower?: string } | null
    if (!body?.agentId || !body?.follower) { sendJson(res, 400, { error: 'agentId and follower required' }); return }
    const r = followAgent(body.agentId, body.follower)
    sendJson(res, 'error' in r ? 404 : 200, r)
    return
  }

  // ── Marketplace tasks: hire a verified worker; escrow settles on release ─────
  // Public service catalog (the card grid): verified agents' services + ratings.
  if (req.method === 'GET' && url.pathname === '/api/marketplace/catalog') {
    sendJson(res, 200, marketplaceCatalog())
    return
  }
  // Hire a verified agent for a service → creates a task (escrow committed). Verified-only.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/hire') {
    const body = (await readBody(req).catch(() => null)) as
      | { agentId?: string; service?: string; priceUsd?: number; description?: string; deadlineHours?: number }
      | null
    if (!body?.agentId || !body?.service) { sendJson(res, 400, { error: 'agentId and service required' }); return }
    if (!validAmount(body.priceUsd, 1000)) { sendJson(res, 400, { error: 'priceUsd must be a finite number between 0 and 1000' }); return }
    const t = await hireAgent({
      agentId: body.agentId, service: body.service, priceUsd: body.priceUsd,
      description: body.description, deadlineHours: body.deadlineHours, client: callerId,
    })
    sendJson(res, 'error' in t ? errStatus(t.error) : 201, t)
    return
  }
  // The hired worker delivers a result. funded → delivered.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/deliver') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; deliverable?: string } | null
    if (!body?.taskId) { sendJson(res, 400, { error: 'taskId required' }); return }
    const t = deliverTask(body.taskId, typeof body.deliverable === 'string' ? body.deliverable : '', callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return
  }
  // The client releases the escrow (real ERC-8183 settlement) + optional review.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/release') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; rating?: number; review?: string } | null
    if (!body?.taskId) { sendJson(res, 400, { error: 'taskId required' }); return }
    const t = await releaseTask(body.taskId, { rating: body.rating, review: body.review }, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return
  }
  // The client disputes → real ERC-8183 refund to the client.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/dispute') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; reason?: string } | null
    if (!body?.taskId) { sendJson(res, 400, { error: 'taskId required' }); return }
    const t = await disputeTask(body.taskId, typeof body.reason === 'string' ? body.reason : 'disputed', callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return
  }
  // One task (party-scoped: the client or the hired agent's owner).
  if (req.method === 'GET' && url.pathname === '/api/marketplace/task') {
    const taskId = url.searchParams.get('taskId') ?? ''
    if (!taskId) { sendJson(res, 400, { error: 'taskId required' }); return }
    const t = getTask(taskId, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return
  }
  // Open tasks (post → bid → accept). Public list of open tasks awaiting bids.
  if (req.method === 'GET' && url.pathname === '/api/marketplace/open-tasks') {
    sendJson(res, 200, listOpenTasks())
    return
  }
  // A client posts an open task (no worker chosen yet). Verified-only.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/post-task') {
    const body = (await readBody(req).catch(() => null)) as { service?: string; budgetUsd?: number; description?: string; deadlineHours?: number } | null
    if (!body?.service) { sendJson(res, 400, { error: 'service required' }); return }
    if (!validAmount(body.budgetUsd, 1000)) { sendJson(res, 400, { error: 'budgetUsd must be a finite number between 0 and 1000' }); return }
    const t = postOpenTask({ service: body.service, budgetUsd: body.budgetUsd, description: body.description, deadlineHours: body.deadlineHours, client: callerId })
    sendJson(res, 'error' in t ? errStatus(t.error) : 201, t)
    return
  }
  // A verified agent bids on an open task (bidder = the agent owner).
  if (req.method === 'POST' && url.pathname === '/api/marketplace/bid') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; agentId?: string; priceUsd?: number } | null
    if (!body?.taskId || !body?.agentId) { sendJson(res, 400, { error: 'taskId and agentId required' }); return }
    if (!validAmount(body.priceUsd, 1000)) { sendJson(res, 400, { error: 'priceUsd must be a finite number between 0 and 1000' }); return }
    const t = bidOnTask(body.taskId, { agentId: body.agentId, priceUsd: body.priceUsd }, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return
  }
  // The client accepts a bid → task assigned + escrow committed.
  if (req.method === 'POST' && url.pathname === '/api/marketplace/accept-bid') {
    const body = (await readBody(req).catch(() => null)) as { taskId?: string; agentId?: string } | null
    if (!body?.taskId || !body?.agentId) { sendJson(res, 400, { error: 'taskId and agentId required' }); return }
    const t = await acceptBid(body.taskId, body.agentId, callerId)
    sendJson(res, 'error' in t ? errStatus(t.error) : 200, t)
    return
  }
  // Tasks: an owned agent's jobs (?agentId=, owner-only) or the caller's own hires.
  if (req.method === 'GET' && url.pathname === '/api/marketplace/tasks') {
    const agentId = url.searchParams.get('agentId') ?? undefined
    if (agentId) {
      const r = listTasksForAgent(agentId, callerId)
      if ('error' in r) { sendJson(res, errStatus(r.error), r); return }
      sendJson(res, 200, { tasks: r })
    } else {
      sendJson(res, 200, { tasks: listTasksForClient(callerId) })
    }
    return
  }

  // ── Open ecosystem: per-agent manifest (AMP Discover) + external self-register ──
  // Public manifest an external project / SDK reads to find + hire an agent.
  if (req.method === 'GET' && url.pathname === '/api/v1/agents/manifest') {
    const agentId = url.searchParams.get('agentId') ?? ''
    if (!agentId) { sendJson(res, 400, { error: 'agentId required' }); return }
    const m = agentManifest(agentId)
    sendJson(res, 'error' in m ? errStatus(m.error) : 200, m)
    return
  }
  // An external framework's agent self-registers (verified session; owner = caller). Returns
  // the created agent, its manifest, and a KYA challenge to prove wallet control next.
  if (req.method === 'POST' && url.pathname === '/api/v1/agents/register') {
    const body = (await readBody(req).catch(() => null)) as {
      name?: string; description?: string; category?: string
      capabilities?: string[]; services?: { name: string; priceUsd: number; unit: string }[]
      walletAddress?: string; endpoint?: string
    } | null
    if (!body?.name) { sendJson(res, 400, { error: 'name required' }); return }
    if (body.walletAddress && !/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress)) {
      sendJson(res, 400, { error: 'walletAddress must be a 0x address' }); return
    }
    const r = await registerExternalAgent({
      name: body.name, description: body.description, category: body.category,
      capabilities: body.capabilities, services: body.services,
      walletAddress: body.walletAddress, endpoint: body.endpoint, owner: callerId,
    })
    sendJson(res, 'error' in r ? errStatus(r.error) : 201, r)
    return
  }

  // ── POST /mcp (MCP Streamable HTTP) ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/mcp') {
    try {
      const body = await readBody(req)
      // Bake the request's VERIFIED caller into the marketplace hooks. A guest / no token →
      // mcpCaller is undefined, so the ownership gate in platform.ts rejects the mutating tools
      // (hire/deliver/release) with a Forbidden error — MCP never bypasses the verified-session gate.
      const mcpCaller = isVerified(caller) ? callerId : undefined
      const mcp = buildServer({
        listAgents: publicAgents,
        getReputation: (id) => agentReputation(id),
        marketplace: {
          catalog: () => marketplaceCatalog(),
          manifest: (agentId) => agentManifest(agentId),
          hire: (input) => hireAgent({ ...input, client: mcpCaller }),
          deliver: (taskId, deliverable) => deliverTask(taskId, deliverable, mcpCaller),
          checkTask: (taskId) => getTask(taskId, mcpCaller),
          release: (taskId, opts) => releaseTask(taskId, opts, mcpCaller),
        },
        // Same per-request caller, same ownership gate in platform.ts. Without a verified
        // session mcpCaller is undefined and every one of these returns Forbidden.
        policy: {
          getPolicy: (agentId) => getAgentActionPolicy(agentId, mcpCaller),
          setPolicy: (agentId, policy) => updateAgentActionPolicy(agentId, policy, mcpCaller),
          check: (agentId, input) => checkAgentAction(agentId, input as never, mcpCaller),
          auditLog: (agentId, opts) => listAgentAudits(agentId, opts, mcpCaller),
          recordOutcome: (agentId, auditId, outcome, evidenceRef) =>
            recordAuditOutcome(agentId, auditId, outcome as never, mcpCaller, evidenceRef),
          register: (manifest) => registerAgentFromManifest(manifest as never, mcpCaller),
        },
      })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      res.on('close', () => { transport.close(); void mcp.close() })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      console.error('[a-identity-mcp] request error:', err)
      if (!res.headersSent) {
        sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
      }
    }
    return
  }

  sendJson(res, 404, { error: 'not found' })
})

// Load persisted state (Postgres or JSON) before we start serving.
await initState()

server.listen(PORT, () => {
  console.error(`[a-identity-mcp] HTTP on http://localhost:${PORT}`)
  console.error(`  POST /mcp               MCP JSON-RPC (tools/call, etc.)`)
  console.error(`  GET  /health            liveness probe`)
  console.error(`  GET  /api/agent?q=...   resolve agent by id/address/domain`)
  console.error(`  GET  /api/reputation?id=... reputation score`)
  console.error(`  GET  /api/chains        supported chains`)
  console.error(`  GET  /api/arc           live Circle Arc testnet status`)
  console.error(`  GET  /api/circle        Circle platform link (wallets, gateway, USDC)`)
  console.error(`  GET  /api/agents        list agents (?chain=base|arbitrum|ethereum)`)
  console.error(`  GET  /api/agents/action-policy   owner-gated action policy (free)`)
  console.error(`  POST /api/agents/action-policy   update the action policy (free, versioned)`)
  console.error(`  POST /api/agents/action-check    policy verdict for an intended action`)
  console.error(`  GET  /api/agents/audit-log       decision trail (?since= &limit=)`)
  console.error(`  POST /api/agents/audit-log/outcome  record what happened after a verdict`)
  console.error(`  POST /api/agents/register         register an agent from a manifest (free)`)
  console.error(`  GET  /api/agents/badge           public guardrail badge (SVG or JSON, opt-in)`)
  console.error(`  GET  /api/traction               aggregate guardrail traction (public)`)
  console.error(`  GET  /api/guardrail-status       live engine self-check (503 if not enforcing)`)
})

// Keep-alive: free-tier hosts (e.g. Render) idle-sleep after ~15 min without inbound
// traffic. When RENDER_EXTERNAL_URL is present, ping our own public /health every 10
// minutes so the service stays awake. No-op locally and in CI (the var is unset there).
const keepAliveUrl = process.env.RENDER_EXTERNAL_URL
if (keepAliveUrl) {
  setInterval(() => {
    fetch(`${keepAliveUrl}/health`).catch(() => {})
  }, 10 * 60 * 1000)
  console.error(`[a-identity-mcp] keep-alive self-ping every 10m -> ${keepAliveUrl}/health`)
}

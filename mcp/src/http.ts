#!/usr/bin/env node
/**
 * A-Identity MCP server - HTTP entry (Streamable HTTP + REST companion).
 *
 * Routes are split into ./http/ modules (auth, public, arc, agent, guardrail,
 * instruction, marketplace); each handler returns true when it handled the request.
 * This file keeps CORS, rate limiting, sessions, the /mcp transport, and startup.
 */
import http from 'node:http'
import { URL } from 'node:url'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildServer } from './server.js'
import {
  agentManifest,
  agentReputation,
  checkAgentAction,
  deliverTask,
  getAgentActionPolicy,
  getTask,
  hireAgent,
  initState,
  listAgentAudits,
  marketplaceCatalog,
  recordAuditOutcome,
  registerAgentFromManifest,
  releaseTask,
  updateAgentActionPolicy,
} from './platform.js'
import { verifyToken, isVerified } from './auth.js'
import { oauthEnabled, verifyAccessToken } from './oauth.js'
import { SESSION_COOKIE, parseCookies, publicAgents, readBody, sendJson, type RouteCtx } from './http/shared.js'
import { handleAuthRoutes } from './http/auth-routes.js'
import { handlePublicRoutes } from './http/public-routes.js'
import { handleCeloRoutes } from './http/celo-routes.js'
import { handleX402ThreeKRoutes } from './http/x402-3009-routes.js'
import { handleArcRoutes } from './http/arc-routes.js'
import { handleAgentRoutes } from './http/agent-routes.js'
import { handleGuardrailRoutes } from './http/guardrail-routes.js'
import { handleInstructionRoutes } from './http/instruction-routes.js'
import { handleMarketplaceRoutes } from './http/marketplace-routes.js'

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
  // Celo x402 tool calls each cost the server two facilitator round-trips (verify+settle).
  if (pathname.startsWith('/api/celo/tools/')) return { bucket: 'celo', max: 30, windowMs: 60_000 }
  // On the self-facilitated rail WE broadcast, so each settle spends real gas from our
  // own wallet. That makes these the most abusable POSTs on the server: limit settle
  // hardest, tools next, and leave verify generous because it is read-only.
  if (pathname === '/api/facilitator/settle') return { bucket: 'settle', max: 6, windowMs: 60_000 }
  if (pathname === '/api/facilitator/verify') return { bucket: 'verify', max: 60, windowMs: 60_000 }
  if (pathname.startsWith('/api/x402/tools/')) return { bucket: 'x402tools', max: 20, windowMs: 60_000 }
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
  let caller = verifyToken(bearer ?? cookieToken)

  // An OAuth access token is the second thing a Bearer header can be, and it is how
  // MCP clients (Claude, Cursor, ChatGPT connectors) sign in to a remote server.
  // Tried only AFTER our own HMAC token fails, so this is purely additive: existing
  // sessions take the same path they always did, and with OAUTH_ISSUER unset the
  // call below returns null immediately. The authorization server verified the
  // email, so the caller counts as 'email'-verified, the same standing a magic-link
  // login produces. It grants ownership of that email's agents and nothing more:
  // spending limits live on-chain and are not a function of how you signed in.
  if (!caller && bearer && oauthEnabled()) {
    const claims = await verifyAccessToken(bearer)
    if (claims?.email) caller = { subject: claims.email.trim().toLowerCase(), method: 'email' }
  }

  // The subject string used for ownership checks (email or wallet address).
  const callerId = caller?.subject

  const ctx: RouteCtx = { req, res, url, caller, callerId }

  if (await handleAuthRoutes(ctx)) return

  // Guard: every other mutating /api endpoint requires a VERIFIED session. No token
  // → 401. A guest (unverified email) token → 403: guests are browse-only, so a
  // token minted for an arbitrary email can never act as an agent's owner.
  // /api/celo/tools/* is exempt because it is PAYMENT-gated, not session-gated: the
  // caller is an anonymous buyer agent whose authorization is the settled USDC payment
  // (402 → pay → facilitator verify+settle). The rail is fail-closed (501) when
  // unconfigured and serves read-only trust tools, so the exemption never frees a write.
  // /api/x402/tools/* and /api/facilitator/* are exempt for the same reason: the caller's
  // authorization is a signed payment, not a session. Both are fail-closed (501) when the
  // rail is unconfigured, and /api/facilitator/settle is additionally payTo-allowlisted
  // because we pay the gas there.
  const isMutation =
    req.method === 'POST' && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/') &&
    !url.pathname.startsWith('/api/celo/tools/') &&
    !url.pathname.startsWith('/api/x402/tools/') && !url.pathname.startsWith('/api/facilitator/')
  if (isMutation && !caller) {
    sendJson(res, 401, { error: 'Authentication required. Sign in with a wallet or an email link.' })
    return
  }
  if (isMutation && !isVerified(caller)) {
    sendJson(res, 403, {
      error:
        'Verified sign-in required. Guest sessions are read-only. Sign in with your wallet or an emailed magic link to act.',
    })
    return
  }

  if (await handlePublicRoutes(ctx)) return
  if (await handleCeloRoutes(ctx)) return
  if (await handleX402ThreeKRoutes(ctx)) return
  if (await handleArcRoutes(ctx)) return
  if (await handleAgentRoutes(ctx)) return
  if (await handleGuardrailRoutes(ctx)) return
  if (await handleInstructionRoutes(ctx)) return
  if (await handleMarketplaceRoutes(ctx)) return

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
  console.error(`  GET  /api/agents        list agents`)
  console.error(`  GET  /api/agents/action-policy   owner-gated action policy (free)`)
  console.error(`  POST /api/agents/action-policy   update the action policy (free, versioned)`)
  console.error(`  POST /api/agents/action-check    policy verdict for an intended action`)
  console.error(`  POST /api/agents/spend-preflight dry-run a USDC spend against the live policy (nothing created)`)
  console.error(`  GET  /api/agents/audit-log       decision trail (?since= &limit=)`)
  console.error(`  POST /api/agents/audit-log/outcome  record what happened after a verdict`)
  console.error(`  POST /api/agents/logo            set/replace/remove the profile image (owner-only)`)
  console.error(`  POST /api/agents/register         register an agent from a manifest (free)`)
  console.error(`  POST /api/agents/register-url     register from a hosted manifest URL (free)`)
  console.error(`  GET  /api/agents/badge           public guardrail badge (SVG or JSON, opt-in)`)
  console.error(`  GET  /api/traction               aggregate guardrail traction (public)`)
  console.error(`  GET  /api/stats                  platform-wide aggregates (public)`)
  console.error(`  GET  /api/guardrail-status       live engine self-check (503 if not enforcing)`)
  console.error(`  GET  /api/facilitator/supported  x402 discovery: what this facilitator settles`)
  console.error(`  POST /api/facilitator/verify     check a signed EIP-3009 payment (open, read-only)`)
  console.error(`  POST /api/facilitator/settle     broadcast it and pay the gas (allowlisted payTo)`)
  console.error(`  GET  /api/facilitator/proof      settlements, with the proven signing domain`)
  console.error(`  GET  /api/x402/tools/:name       price + calling contract; POST to pay and call`)
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

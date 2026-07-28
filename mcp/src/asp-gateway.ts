/**
 * A-Identity - Agent Trust Oracle: the OKX.AI ASP (A2MCP) gateway.
 *
 * A thin public HTTPS service that sells four pay-per-call tools, each a wrapper over
 * A-Identity's existing live engine (see ./asp/tools.ts). OKX x402 charges per call on
 * X Layer when credentials are set (./asp/payment.ts); otherwise it serves free so the
 * service is always deployable and testable.
 *
 * Run: `npm run build && npm run start:asp` (PORT / ASP_PORT selects the port).
 *
 *   GET  /health           free - liveness + service card (discovery)
 *   POST /tools/trust_preview       free  - coarse band + flags (rate-limited on-ramp)
 *   POST /tools/verify_agent        $0.001 - ERC-8004 identity + KYA
 *   POST /tools/reputation_score    $0.002 - 0-1000 on-chain reputation
 *   POST /tools/risk_check          $0.005 - ALLOW/WARN/DENY pre-tx risk
 *   POST /tools/counterparty_check  $0.008 - deal-specific two-agent verdict
 *   POST /tools/agent_passport      $0.01  - full agent passport
 */
import express, { type Request, type Response } from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { initState } from './platform.js'
import { verifyAgent, reputationScore, riskCheck, agentPassport, counterpartyCheck, trustPreview, guardrailCheck, type TxContext } from './asp/tools.js'
import { applyOkxX402, type PaymentStatus } from './asp/payment.js'
import { PROOF, METHODOLOGY } from './asp/proof.js'
import { renderProofHtml } from './asp/proof-html.js'
import { getLiveStats } from './asp/stats.js'

const SERVICE = 'A-Identity - Agent Trust Oracle'
const PORT = Number(process.env.ASP_PORT ?? process.env.PORT ?? 4000)

/** The Circle Agent Marketplace service manifest - the descriptor an agent (or the
 *  `circle services inspect` CLI) reads to discover this service. Loaded once from the
 *  committed JSON (single source of truth; ../marketplace/ ships with the mcp/ deploy).
 *  A missing file degrades to a minimal card so discovery never 500s. */
function loadManifest(): Record<string, unknown> {
  try {
    const here = dirname(fileURLToPath(import.meta.url)) // mcp/dist
    return JSON.parse(readFileSync(join(here, '..', 'marketplace', 'circle-agent-marketplace.json'), 'utf8'))
  } catch {
    return { name: SERVICE, type: 'x402', url: 'https://a-identity-asp.onrender.com' }
  }
}
const MANIFEST = loadManifest()

/** Merge JSON body + query string so every tool accepts POST (body) AND GET (query). */
function params(req: Request): Record<string, unknown> {
  return { ...(req.query as Record<string, unknown>), ...(req.body as Record<string, unknown> | undefined) }
}

/** Pull a required string `agentId` (with common aliases), or explain what's missing. */
function requireAgentId(req: Request): { agentId: string } | { error: string } {
  const p = params(req)
  const id = p.agentId ?? p.agent_id ?? p.agent ?? p.id ?? p.address ?? p.wallet
  if (typeof id !== 'string' || id.trim() === '') {
    return { error: 'Provide a non-empty string "agentId" (ERC-8004 token id like "#849980", CAIP id, or 0x owner address) in the JSON body or as a query param.' }
  }
  // Bound the length so a giant numeric agentId can't force an O(n^2) BigInt parse (DoS).
  if (id.length > 128) return { error: 'agentId too long (max 128 characters).' }
  return { agentId: id.trim() }
}

/** Pull the two agent ids a counterparty_check needs (`from` = payer, `to` = counterparty). */
function requireFromTo(req: Request): { from: string; to: string } | { error: string } {
  const p = params(req)
  const from = p.from ?? p.payer
  const to = p.to ?? p.counterparty ?? p.agentId
  for (const [k, v] of [['from', from], ['to', to]] as const) {
    if (typeof v !== 'string' || v.trim() === '') return { error: `Provide a non-empty string "${k}" (the ${k === 'from' ? 'paying' : 'counterparty'} agent id) in the JSON body or as a query param.` }
    if (v.length > 128) return { error: `"${k}" too long (max 128 characters).` }
  }
  return { from: (from as string).trim(), to: (to as string).trim() }
}

/** Read an optional TxContext from the JSON body (object) or flat query params. */
function txContextFrom(req: Request): TxContext | null {
  const body = req.body as { txContext?: TxContext; tx_context?: TxContext } | undefined
  const ctx = body?.txContext ?? body?.tx_context
  if (ctx && typeof ctx === 'object') return ctx
  const q = req.query as Record<string, string | undefined>
  const amount = q.amountUsd ?? q.amount_usd ?? q.amount
  const payee = q.payee
  if (amount === undefined && payee === undefined) return null
  const amountUsd = amount !== undefined ? Number(amount) : undefined
  return {
    ...(amountUsd !== undefined && Number.isFinite(amountUsd) ? { amountUsd } : {}),
    ...(payee ? { payee } : {}),
  }
}

/**
 * Free-tier rate limit for trust_preview: per-IP fixed window, in-memory (single-instance,
 * same accepted tradeoff as the rest of this backend - see SECURITY.md). Paid tools are
 * never rate-limited this way; x402 pricing is their throttle.
 */
const PREVIEW_WINDOW_MS = 60 * 60 * 1000
const PREVIEW_LIMIT = 20 // calls per IP per window
const previewHits = new Map<string, { count: number; resetAt: number }>()
function previewGate(ip: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const now = Date.now()
  // Lazy sweep so the map can't grow unboundedly across many IPs.
  if (previewHits.size > 10_000) {
    for (const [k, v] of previewHits) if (v.resetAt <= now) previewHits.delete(k)
  }
  const hit = previewHits.get(ip)
  if (!hit || hit.resetAt <= now) {
    previewHits.set(ip, { count: 1, resetAt: now + PREVIEW_WINDOW_MS })
    return { allowed: true }
  }
  if (hit.count >= PREVIEW_LIMIT) return { allowed: false, retryAfterSeconds: Math.ceil((hit.resetAt - now) / 1000) }
  hit.count++
  return { allowed: true }
}

/** Run a tool handler, translating errors into a clean 400/500 JSON envelope. */
function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const out = await fn(req)
      if (out && typeof out === 'object' && typeof (out as { error?: unknown }).error === 'string') {
        res.status(400).json(out)
        return
      }
      res.json(out)
    } catch (e) {
      // Log the detail server-side; never reflect raw internals (RPC/URLs/addresses) to callers.
      console.error('[asp] tool error:', e)
      res.status(500).json({ error: 'Internal error' })
    }
  }
}

function serviceCard(payment: PaymentStatus) {
  return {
    service: SERVICE,
    positioning: 'The identity & reputation oracle for the agent economy.',
    type: 'A2MCP',
    payment: { mode: payment.mode, network: payment.network, payTo: payment.payTo },
    tools: [
      { name: 'trust_preview', method: 'POST /tools/trust_preview', price: 'free', desc: `Free tier: coarse trust band + flags for one agent (rate-limited ${PREVIEW_LIMIT}/hour per IP).` },
      { name: 'verify_agent', method: 'POST /tools/verify_agent', price: payment.prices['POST /tools/verify_agent'], desc: 'Verify an AI agent identity (ERC-8004 / KYA status).' },
      { name: 'reputation_score', method: 'POST /tools/reputation_score', price: payment.prices['POST /tools/reputation_score'], desc: 'On-chain 0-1000 reputation score for an agent.' },
      { name: 'risk_check', method: 'POST /tools/risk_check', price: payment.prices['POST /tools/risk_check'], desc: 'Pre-transaction counterparty risk: ALLOW / WARN / DENY.' },
      { name: 'agent_passport', method: 'POST /tools/agent_passport', price: payment.prices['POST /tools/agent_passport'], desc: 'Full agent passport (identity + reputation + KYA + risk).' },
      { name: 'counterparty_check', method: 'POST /tools/counterparty_check', price: payment.prices['POST /tools/counterparty_check'], desc: 'Deal-specific verdict between two agents (risk + same-operator self-deal check).' },
    ],
    docs: 'https://a-identity.xyz',
    proof: '/proof',
    methodology: '/methodology',
  }
}

async function main() {
  await initState()

  const app = express()
  // Behind Render's (and Cloudflare's) proxy, TLS terminates upstream, so Express's
  // `req.protocol` defaults to 'http'. The OKX x402 middleware builds the 402 challenge's
  // `resource.url` as `${req.protocol}://${req.headers.host}${req.originalUrl}`, and OKX
  // requires a public HTTPS resource - an `http://` URL can fail the ASP review / a strict
  // buyer client. Trusting the proxy makes `req.protocol` read `X-Forwarded-Proto` ('https'),
  // so the advertised resource URL is correctly `https://`.
  app.set('trust proxy', true)
  app.use(express.json({ limit: '16kb' }))

  // CORS: agent-to-agent callers are servers, but browser-based agent clients (and the
  // OKX web surfaces) preflight; expose the x402 headers so a web client can read the
  // challenge and attach payment proofs.
  app.use((req: Request, res: Response, next: () => void) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-PAYMENT, X-Payment-Nonce, X-Payment-Payer, X-Payment-Sig, PAYMENT-SIGNATURE, Authorization')
    res.set('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE')
    if (req.method === 'OPTIONS') { res.status(204).end(); return }
    next()
  })

  // Free discovery endpoints - never charged (payment middleware only guards POST /tools/*).
  const health = (payment: PaymentStatus) => (_req: Request, res: Response) =>
    res.json({ ok: true, ...serviceCard(payment), paymentReason: payment.reason })

  // Register the OKX x402 middleware (paid mode iff creds present) BEFORE the tool routes.
  const payment = await applyOkxX402(app)

  app.get('/health', health(payment))
  app.get('/', health(payment))

  // Free, public, verifiable proof for the hackathon submission (real on-chain
  // settlements, the ASP identity, the deterministic scoring methodology).
  // Content-negotiated: a browser (a judge clicking the link) gets a styled HTML page;
  // an agent/API caller gets JSON. /proof.json always returns JSON.
  app.get('/proof', (req: Request, res: Response) => {
    if (req.accepts(['json', 'html']) === 'html') res.type('html').send(renderProofHtml())
    else res.json(PROOF)
  })
  app.get('/proof.json', (_req: Request, res: Response) => res.json(PROOF))
  app.get('/methodology', (_req: Request, res: Response) => res.json(METHODOLOGY))
  // Circle Agent Marketplace discovery: the inspectable service manifest. Free, public -
  // this is what `circle services inspect "<url>"` (and agents.circle.com) read to list us.
  app.get('/.well-known/agent.json', (_req: Request, res: Response) => res.json(MANIFEST))
  app.get('/manifest', (_req: Request, res: Response) => res.json(MANIFEST))
  // Live on-chain stats (payTo's current USD₮0), so the /proof page reads "live".
  app.get('/stats', async (_req: Request, res: Response) => res.json(await getLiveStats()))

  // Every tool answers BOTH GET (query params) and POST (JSON body): the OKX buyer CLI
  // probes with GET by default, so a POST-only route would return 404 on the probe
  // ("endpoint_unreachable") and lose the sale before the 402 is ever seen.

  // The FREE tier (never behind x402 - its route is deliberately absent from PRICES).
  app.all('/tools/trust_preview', (req: Request, res: Response) => {
    if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'Use GET or POST.' }); return }
    const gate = previewGate(req.ip ?? 'unknown')
    if (!gate.allowed) {
      res.status(429).set('Retry-After', String(gate.retryAfterSeconds)).json({
        error: `Free-tier limit reached (${PREVIEW_LIMIT}/hour per IP). Retry in ${gate.retryAfterSeconds}s, or use the paid tools (no free-tier limit).`,
      })
      return
    }
    void handle(async (r) => {
      const v = requireAgentId(r); if ('error' in v) return v
      return trustPreview(v.agentId)
    })(req, res)
  })

  // The paid tools.
  app.all('/tools/verify_agent', handle(async (req) => {
    const v = requireAgentId(req); if ('error' in v) return v
    return verifyAgent(v.agentId)
  }))
  app.all('/tools/reputation_score', handle(async (req) => {
    const v = requireAgentId(req); if ('error' in v) return v
    return reputationScore(v.agentId)
  }))
  app.all('/tools/risk_check', handle(async (req) => {
    const v = requireAgentId(req); if ('error' in v) return v
    return riskCheck(v.agentId, txContextFrom(req))
  }))
  app.all('/tools/agent_passport', handle(async (req) => {
    const v = requireAgentId(req); if ('error' in v) return v
    return agentPassport(v.agentId)
  }))
  app.all('/tools/counterparty_check', handle(async (req) => {
    const v = requireFromTo(req); if ('error' in v) return v
    return counterpartyCheck(v.from, v.to, txContextFrom(req))
  }))
  // Policy discipline about a THIRD party. The engine's own pre_action_check stays free
  // and owner-gated on the main backend: payment cannot prove ownership, so it must never
  // be the gate for owner-scoped data. See docs/compliance-robinhood.md section 2.
  app.all('/tools/guardrail_check', handle(async (req) => {
    const v = requireAgentId(req); if ('error' in v) return v
    return guardrailCheck(v.agentId)
  }))

  app.listen(PORT, () => {
    console.log(`[asp-gateway] ${SERVICE} listening on :${PORT}`)
    console.log(`[asp-gateway] payment: ${payment.mode} (${payment.reason})`)
  })

  // Keep-warm: free-tier hosts (Render) idle-sleep after ~15 min without inbound
  // traffic, which shows up as a cold-start/502 to a reviewer. When RENDER_EXTERNAL_URL
  // is present, self-ping our own public /health every 10 min (an inbound request that
  // resets the idle timer). Belt-and-suspenders with an external uptime pinger. No-op
  // locally / in CI (the var is unset there).
  const keepAliveUrl = process.env.RENDER_EXTERNAL_URL
  if (keepAliveUrl) {
    setInterval(() => {
      fetch(`${keepAliveUrl}/health`).catch(() => {})
    }, 10 * 60 * 1000)
    console.log(`[asp-gateway] keep-warm self-ping every 10m -> ${keepAliveUrl}/health`)
  }
}

main().catch((e) => {
  console.error('[asp-gateway] fatal:', e)
  process.exit(1)
})

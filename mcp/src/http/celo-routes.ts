/**
 * Celo route group: the facilitator-settled x402 rail + its public proof surface.
 * Same convention as every group here: handleCeloRoutes(ctx) returns true when the
 * request was handled. Thin adapters only - the decisions (fail-closed gate, challenge,
 * verify/settle/serve, proof aggregation) live in ../celo-x402.ts where they are
 * unit-tested without a network.
 *
 * The tool endpoints are PAYMENT-gated, not session-gated: the buyer is an anonymous
 * agent whose authorization is the settled USDC payment itself (402 -> pay -> verify ->
 * settle). http.ts exempts POST /api/celo/tools/* from the verified-session mutation
 * gate for exactly that reason; the rail is fail-closed (501) when unconfigured, so the
 * exemption can never free-serve anything.
 */
import {
  CELO_TOOLS,
  CELO_TOOL_CARDS,
  celoChallenge,
  celoPaywallGate,
  celoProof,
  celoServeTool,
  celoStatusReport,
  celoX402Status,
  type CeloToolName,
} from '../celo-x402.js'
import type { TxContext } from '../asp/tools.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

export async function handleCeloRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/celo/')) return false

  // ── GET /api/celo/status - rail config + registry facts + resolver readiness ──
  if (req.method === 'GET' && url.pathname === '/api/celo/status') {
    sendJson(res, 200, celoStatusReport())
    return true
  }

  // ── GET /api/celo/proof - the durable settlement log, honest zeros included ──
  if (req.method === 'GET' && url.pathname === '/api/celo/proof') {
    sendJson(res, 200, await celoProof())
    return true
  }

  // ── GET+POST /api/celo/tools/:name - the four paid trust tools ──
  const toolMatch = url.pathname.match(/^\/api\/celo\/tools\/([a-z_]+)$/)
  if (toolMatch && (req.method === 'GET' || req.method === 'POST')) {
    const status = celoX402Status()
    const gate = celoPaywallGate(status)
    // FAIL-CLOSED: unconfigured -> 501 for BOTH methods. Never a free serve.
    if (!gate.ok) { sendJson(res, gate.httpStatus, gate.body); return true }

    const name = toolMatch[1]
    if (!(CELO_TOOLS as readonly string[]).includes(name)) {
      sendJson(res, 404, { error: `unknown tool '${name}'`, tools: CELO_TOOLS })
      return true
    }
    const tool = name as CeloToolName

    // A probing GET sees the full contract: the 402 challenge + the tool card.
    if (req.method === 'GET') {
      sendJson(res, 402, celoChallenge(tool, status))
      return true
    }

    // POST: input first (a paid call with unusable input must fail BEFORE money moves).
    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return true
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const agentId = typeof b.agentId === 'string' && b.agentId.trim() ? b.agentId.trim() : null
    if (!agentId) {
      sendJson(res, 400, { error: 'agentId required', tool: { name: tool, ...CELO_TOOL_CARDS[tool] } })
      return true
    }
    const txContext =
      tool === 'risk_check' && typeof b.txContext === 'object' && b.txContext !== null
        ? (b.txContext as TxContext)
        : null

    // Unpaid POST -> the same 402 challenge the GET serves.
    const paymentHeader = req.headers['x-payment']
    if (typeof paymentHeader !== 'string' || !paymentHeader) {
      sendJson(res, 402, celoChallenge(tool, status))
      return true
    }

    const out = await celoServeTool(tool, { agentId, txContext }, paymentHeader, status)
    sendJson(res, out.httpStatus, out.body)
    return true
  }

  return false
}

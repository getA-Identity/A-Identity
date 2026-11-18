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
 *
 * The tool endpoints speak x402 v2 over HTTP: the 402 carries the PaymentRequired object in
 * the PAYMENT-REQUIRED header and the body, the payment arrives in PAYMENT-SIGNATURE (or in
 * X-PAYMENT, the v1 name), and a settled answer carries PAYMENT-RESPONSE. They are also the one
 * place whose CORS is open to any origin, without credentials (applyCeloToolCors).
 */
import type http from 'node:http'
import {
  CELO_TOOLS,
  CELO_TOOL_CARDS,
  celoChallengeResponse,
  celoPauseResponse,
  celoPaymentHeader,
  celoPaywallGate,
  celoProof,
  celoServeTool,
  celoStatusReport,
  celoX402Status,
  type CeloServeDeps,
  type CeloToolName,
} from '../celo-x402.js'
import type { TxContext } from '../asp/tools.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'
import { requestOrigin } from './x402-gateway-routes.js'

/** The paid tool paths: the same match the route below answers. */
export const CELO_TOOL_PATH = /^\/api\/celo\/tools\/([a-z_]+)$/

/**
 * The CORS a Celo paid tool route answers with. Any origin may call it, because the buyer is any
 * agent or page and its credential is the signed payment in a request header, never a cookie or a
 * session: so no credentials. The request headers a paid call carries are allowed, and the v2
 * challenge and receipt headers are exposed, since a browser hides response headers from
 * cross-origin script unless they are listed. This rail sends no other payment header.
 *
 * Allowed, besides Content-Type and the payment under either name: Access-Control-Expose-Headers
 * as a REQUEST header. The reference browser clients set it on their paid retry (@x402/fetch, read
 * at 2.18.0 and 2.29.0, and @x402/axios send "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE" in it; the v1
 * x402-fetch sends "X-PAYMENT-RESPONSE"). It is not CORS-safelisted, so a browser names it in the
 * preflight, and a preflight that does not allow it stops the paid POST before it is sent. The
 * response headers those clients read are PAYMENT-REQUIRED and PAYMENT-RESPONSE, both exposed, and
 * X-PAYMENT-RESPONSE only when PAYMENT-RESPONSE is missing; this rail never sends that one.
 */
export const CELO_TOOL_CORS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers',
  'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
}

/**
 * Open the CORS of the Celo paid tool routes, and of their OPTIONS preflight, over the allowlist
 * http.ts sets on every route; every other path keeps that allowlist untouched. `path` is the
 * request target without its query. Returns whether it applied.
 */
export function applyCeloToolCors(path: string, res: Pick<http.ServerResponse, 'setHeader' | 'removeHeader'>): boolean {
  if (!CELO_TOOL_PATH.test(path)) return false
  for (const [name, value] of Object.entries(CELO_TOOL_CORS)) res.setHeader(name, value)
  // '*' and credentials cannot go together, and nothing on these routes reads a cookie.
  res.removeHeader('Access-Control-Allow-Credentials')
  return true
}

/** The seams a test uses. Production passes nothing: process.env and the live facilitator. */
export type CeloRouteDeps = { env?: NodeJS.ProcessEnv; serve?: CeloServeDeps }

const NOTHING_CHARGED = 'the request was refused before the payment was verified or settled, so nothing was charged'

function send(res: http.ServerResponse, out: { httpStatus: number; body: unknown; headers?: Record<string, string> }): void {
  for (const [name, value] of Object.entries(out.headers ?? {})) res.setHeader(name, value)
  sendJson(res, out.httpStatus, out.body)
}

export async function handleCeloRoutes(ctx: RouteCtx, deps: CeloRouteDeps = {}): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/celo/')) return false
  const env = deps.env ?? process.env

  // ── GET /api/celo/status - rail config + registry facts + resolver readiness ──
  if (req.method === 'GET' && url.pathname === '/api/celo/status') {
    sendJson(res, 200, celoStatusReport(env))
    return true
  }

  // ── GET /api/celo/proof - the durable settlement log, honest zeros included ──
  if (req.method === 'GET' && url.pathname === '/api/celo/proof') {
    sendJson(res, 200, await celoProof(env))
    return true
  }

  // ── GET+POST /api/celo/tools/:name - the four paid trust tools ──
  const toolMatch = url.pathname.match(CELO_TOOL_PATH)
  if (toolMatch && (req.method === 'GET' || req.method === 'POST')) {
    const status = celoX402Status(env)
    const gate = celoPaywallGate(status)
    // FAIL-CLOSED: unconfigured -> 501 for BOTH methods. Never a free serve.
    if (!gate.ok) { sendJson(res, gate.httpStatus, gate.body); return true }

    const name = toolMatch[1]
    if (!(CELO_TOOLS as readonly string[]).includes(name)) {
      sendJson(res, 404, { error: `unknown tool '${name}'`, tools: CELO_TOOLS })
      return true
    }
    const tool = name as CeloToolName

    // While the rail is paused (the facilitator refused to settle for us, an empty
    // settlement balance), neither the challenge nor the paid call is served: a buyer
    // would otherwise sign for nothing. The body says why and until when.
    const paused = celoPauseResponse()
    if (paused) {
      sendJson(res, paused.httpStatus, paused.body)
      return true
    }

    // The absolute resource URL names the host this request reached (Vercel forwards the site's).
    const origin = requestOrigin(ctx)
    const payment = celoPaymentHeader(req.headers)

    // No payment means the 402, on either method and whatever the body: a client, a probe or a
    // badge that sends nothing (or no agentId) learns the price before anything else. A GET only
    // quotes, so a payment sent on one is refused unused and the 402 says how to send it.
    if (!payment || req.method === 'GET') {
      send(res, celoChallengeResponse(tool, status, {
        origin,
        ...(payment ? { refusal: 'a GET only quotes the price: send this payment with a POST whose JSON body names agentId. It was not verified or settled, so nothing was charged.' } : {}),
      }))
      return true
    }

    // POST with a payment: the input is checked before anything is verified or settled, so a
    // request that cannot be answered is never charged.
    let body: unknown
    try {
      body = await readBody(req)
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body', charged: false, note: NOTHING_CHARGED })
      return true
    }
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    const agentId = typeof b.agentId === 'string' && b.agentId.trim() ? b.agentId.trim() : null
    if (!agentId) {
      sendJson(res, 400, { error: 'agentId required', charged: false, note: NOTHING_CHARGED, tool: { name: tool, ...CELO_TOOL_CARDS[tool] } })
      return true
    }
    const txContext =
      tool === 'risk_check' && typeof b.txContext === 'object' && b.txContext !== null
        ? (b.txContext as TxContext)
        : null

    send(res, await celoServeTool(tool, { agentId, txContext }, payment, status, { env, ...deps.serve, origin }))
    return true
  }

  return false
}

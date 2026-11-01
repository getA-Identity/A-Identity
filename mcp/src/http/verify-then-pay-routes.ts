/**
 * verify-then-pay on Arc Mainnet: buy a risk_check through Circle Gateway, then get back the
 * exact vault call, the owner hand-off, or nothing to sign. Three routes, all under the
 * Gateway rail's prefix:
 *
 *   POST /api/x402/gateway/verify-then-pay            the flow: 400 bad input, 422 refused
 *                                                     before any charge (503 when the chain
 *                                                     did not answer), 402 the Arc Mainnet
 *                                                     offer, 200 the paid result
 *   GET  /api/x402/gateway/flows/:flowId              the public record of one flow
 *   POST /api/x402/gateway/flows/:flowId/receipt      {txHash}: the server reads the receipt
 *                                                     from every RPC and records only what it
 *                                                     proves
 *
 * Thin adapters only: every decision lives in ../verify-then-pay/, unit-tested without a
 * network. None of these routes signs or broadcasts anything. They sit outside the session
 * gate on the terms http.ts states: the paid route's credential is the signed Gateway
 * authorization, the record is public by design, and the receipt route writes nothing but
 * what the chain proves.
 */
import { railPaymentHeader } from '../x402-gateway/index.js'
import { readVtpFlow, recordVtpReceipt, runVerifyThenPay, type VtpInput } from '../verify-then-pay/index.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'
import { requestOrigin } from './x402-gateway-routes.js'

/** The three entry points, injectable so the adapter is tested apart from what it adapts. */
export type VtpRouteDeps = {
  run?: typeof runVerifyThenPay
  read?: typeof readVtpFlow
  receipt?: typeof recordVtpReceipt
}

async function jsonBody(ctx: RouteCtx): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; reason: string }> {
  try {
    const body = await readBody(ctx.req)
    if (body === undefined) return { ok: true, body: {} }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'the body must be a JSON object' }
    return { ok: true, body: body as Record<string, unknown> }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export function createVerifyThenPayRoutes(deps: VtpRouteDeps = {}): (ctx: RouteCtx) => Promise<boolean> {
  const run = deps.run ?? runVerifyThenPay
  const readFlow = deps.read ?? readVtpFlow
  const postReceipt = deps.receipt ?? recordVtpReceipt

  return async (ctx) => {
    const { req, res, url } = ctx
    if (!url.pathname.startsWith('/api/x402/gateway/')) return false
    const origin = requestOrigin(ctx)

    // ── POST /api/x402/gateway/verify-then-pay ──
    if (req.method === 'POST' && url.pathname === '/api/x402/gateway/verify-then-pay') {
      const body = await jsonBody(ctx)
      if (!body.ok) {
        sendJson(res, 400, { error: 'the body must be JSON', reason: body.reason })
        return true
      }
      const out = await run(body.body as VtpInput, railPaymentHeader(req.headers), { origin })
      for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v)
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, out.httpStatus, out.body)
      return true
    }
    if (url.pathname === '/api/x402/gateway/verify-then-pay') {
      sendJson(res, 405, { error: 'use POST with {vault, payee, amount}; the first call answers 402 with the Arc Mainnet offer, or 422 if the vault would refuse' })
      return true
    }

    // ── POST /api/x402/gateway/flows/:flowId/receipt ──
    const receiptPath = url.pathname.match(/^\/api\/x402\/gateway\/flows\/([^/]+)\/receipt$/)
    if (receiptPath) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'use POST with {txHash}' })
        return true
      }
      const body = await jsonBody(ctx)
      if (!body.ok) {
        sendJson(res, 400, { error: 'the body must be JSON', reason: body.reason })
        return true
      }
      const out = await postReceipt(receiptPath[1], body.body.txHash, { origin })
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, out.httpStatus, out.body)
      return true
    }

    // ── GET /api/x402/gateway/flows/:flowId ──
    const flowPath = url.pathname.match(/^\/api\/x402\/gateway\/flows\/([^/]+)$/)
    if (flowPath) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'use GET' })
        return true
      }
      const out = await readFlow(flowPath[1], { origin })
      // A pending flow moves when its receipt is read, so nothing here may be served stale.
      res.setHeader('Cache-Control', 'no-store')
      sendJson(res, out.httpStatus, out.body)
      return true
    }

    return false
  }
}

export const handleVerifyThenPayRoutes = createVerifyThenPayRoutes()

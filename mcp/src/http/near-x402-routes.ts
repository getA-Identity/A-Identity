/**
 * GET /api/near/x402/check?account=<id>[&vault=<id>]: the verdict GET /api/near/check gives for
 * free, sold over x402 `exact` on near:testnet (../near-x402/).
 *
 * A thin adapter: every decision (rail on or off, ready or not, the 402, verify, relay, the
 * receipt proof, replay) lives in near-x402/rail.ts. Without a payment header the answer is the
 * 402, with the challenge in the PAYMENT-REQUIRED header and the body; with one, a 200 carries the
 * verdict and the settlement in PAYMENT-RESPONSE. With the relayer unset it is 503 "rail off" and
 * no challenge at all.
 *
 * A GET, so the session gate in http.ts (POST only) never stands in front of it: the credential
 * is the signed payment. It is charged to the same per-IP NEAR bucket as GET /api/near/check
 * (rate-budget.ts), since a paid call runs the same collection. Never cached by a proxy: each
 * answer is about one payment.
 */
import type http from 'node:http'
import { NEAR_X402_PATH, nearX402Check, nearX402PaymentHeader, type NearX402Deps } from '../near-x402/rail.js'
import { sendChallenge, sendJson, type RouteCtx } from './shared.js'

export { NEAR_X402_PATH }

const USAGE = `use GET ${NEAR_X402_PATH}?account=<near:testnet:<account> or a name ending in .testnet>[&vault=<vault account>], with an x402 v2 payment in PAYMENT-SIGNATURE (without one the answer is the 402 that says what to sign)`

/** Report whether the response reached the socket: true once flushed, false when the socket closed first. */
function watchDelivery(res: http.ServerResponse, onDelivery: (delivered: boolean) => void): void {
  if (res.destroyed) {
    onDelivery(false)
    return
  }
  res.once('close', () => onDelivery(Boolean(res.writableFinished)))
}

export async function handleNearX402Routes(ctx: RouteCtx, deps: NearX402Deps = {}): Promise<boolean> {
  const { req, res, url } = ctx
  if (req.method === 'GET' && url.pathname === '/api/near/x402/check') {
    const out = await nearX402Check(
      {
        account: url.searchParams.get('account') ?? '',
        vault: url.searchParams.get('vault'),
        paymentHeader: nearX402PaymentHeader(req.headers),
      },
      deps,
    )
    res.setHeader('Cache-Control', 'no-store')
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v)
    if (out.onDelivery) watchDelivery(res, out.onDelivery)
    if (out.challenge) sendChallenge(res, out.httpStatus, out.body)
    else sendJson(res, out.httpStatus, out.body)
    return true
  }
  if (url.pathname === NEAR_X402_PATH) {
    res.setHeader('Allow', 'GET')
    sendJson(res, 405, { error: USAGE })
    return true
  }
  return false
}

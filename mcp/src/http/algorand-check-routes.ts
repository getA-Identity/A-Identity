/**
 * GET /api/algorand/check?q=<address or link>: the free "Before you pay" answer the /check page
 * shows. The same engine is sold per call to agents as pay_check on the Algorand x402 rail,
 * which adds the per-payer breakdown; this route returns the verdict, reasons and facts only.
 *
 * Free and public, so it is bounded twice: per client IP in rate-budget.ts, and by a short
 * per-query cache here, because a shared link opened by many people is the same question.
 */
import { runPayCheck, type PayCheckResult } from '../algorand-check/check.js'
import { DEFAULT_FACILITATOR } from '../x402-algorand/rail.js'
import { sendJson, type RouteCtx } from './shared.js'

const TTL_MS = 60_000
const MAX_ENTRIES = 500
const answers = new Map<string, { at: number; result: PayCheckResult }>()

export async function handleAlgorandCheckRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  if (url.pathname !== '/api/algorand/check') return false
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'use GET /api/algorand/check?q=<Algorand address or x402 seller link>' })
    return true
  }
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q || q.length > 300) {
    sendJson(res, 400, { error: 'Paste an Algorand address or a service link.' })
    return true
  }

  const key = q.toUpperCase()
  const hit = answers.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader('Cache-Control', 'public, max-age=60')
    sendJson(res, 200, hit.result)
    return true
  }

  const out = await runPayCheck(q, { facilitator: process.env.X402_ALGORAND_FACILITATOR ?? DEFAULT_FACILITATOR })
  if ('error' in out) {
    sendJson(res, out.httpStatus, { error: out.error })
    return true
  }
  if (answers.size >= MAX_ENTRIES) answers.delete(answers.keys().next().value as string)
  answers.set(key, { at: Date.now(), result: out })
  res.setHeader('Cache-Control', 'public, max-age=60')
  sendJson(res, 200, out)
  return true
}

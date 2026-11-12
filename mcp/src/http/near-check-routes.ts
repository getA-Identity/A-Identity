/**
 * GET /api/near/check?account=<id>[&vault=<id>]: A-Identity's verdict on a NEAR testnet account,
 * free, from the same engine the NEAR SDK CLI runs (../near-check/check.ts).
 *
 * `account` is near:testnet:<account> or a bare name ending in .testnet, the one routing rule
 * the trust tools use too. `vault` is optional: the agent's spend vault, whose counters for this
 * payee (paid_count, refusal_count, guard_refusal_count) and owner allowlist the verdict then
 * reads. The answer is the CLI's --json shape plus the registry and vault as read, the exact
 * command that recomputes it, and its labels: testnet, read live, nothing settled.
 *
 * Free and public, so it is bounded twice, like the other free checks: per client IP in
 * rate-budget.ts (the near-check bucket, which the Gateway's free trust_preview on a NEAR
 * target draws on too), and by nearCheck's own 60 s answer per account and vault, which a
 * shared link opened by many people reuses. CORS is the server's, as for every
 * route. A refusal is 400 with the reason; a chain that did not answer is 503 with Retry-After,
 * and never a guessed verdict.
 */
import { nearCheck, NEAR_CHECK_TTL_MS, type NearCheckDeps } from '../near-check/check.js'
import { sendJson, type RouteCtx } from './shared.js'

export const NEAR_CHECK_PATH = '/api/near/check'

const USAGE = `use GET ${NEAR_CHECK_PATH}?account=<near:testnet:<account> or a name ending in .testnet>[&vault=<vault account>]`

export async function handleNearCheckRoutes(ctx: RouteCtx, deps: NearCheckDeps = {}): Promise<boolean> {
  const { req, res, url } = ctx
  if (req.method === 'GET' && url.pathname === '/api/near/check') {
    const out = await nearCheck(url.searchParams.get('account') ?? '', { vault: url.searchParams.get('vault') }, deps)
    if ('error' in out) {
      if (out.httpStatus === 503) res.setHeader('Retry-After', '30')
      sendJson(res, out.httpStatus, { error: out.error, code: out.code })
      return true
    }
    res.setHeader('Cache-Control', `public, max-age=${Math.round(NEAR_CHECK_TTL_MS / 1000)}`)
    sendJson(res, 200, out)
    return true
  }
  if (url.pathname === NEAR_CHECK_PATH) {
    res.setHeader('Allow', 'GET')
    sendJson(res, 405, { error: USAGE })
    return true
  }
  return false
}

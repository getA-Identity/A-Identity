/**
 * GET /api/robinhood/check?q=... and GET /api/arbitrum/check?q=...: the free "Before you pay"
 * answer for the two Arbitrum chains we settle on. Paste a token address, a wallet, an agent id
 * or an x402 link; the answer says whether the dollar is the real one, whether the signing
 * domain is proven, and whether the payee is a registered agent (see evm-pay-check/check.ts).
 *
 * The slug is the one /proof/:rail already uses, so /check/robinhood and /proof/robinhood name
 * the same chain. Free and public, so it is bounded twice like the Algorand check: per client IP
 * in rate-budget.ts, and by a short per-query cache here.
 */
import { getChainById } from '../chains/registry.js'
import { addressUrl } from '../chains/explorer.js'
import { runEvmPayCheck, settlementTokenOf, REASON_CODES, type EvmPayCheckResult } from '../evm-pay-check/check.js'
import { sendJson, type RouteCtx } from './shared.js'

export const PAY_CHECK_SLUGS: Record<string, string> = { robinhood: 'rhchain', arbitrum: 'arbitrum' }

const TTL_MS = 60_000
const MAX_ENTRIES = 500
const answers = new Map<string, { at: number; result: EvmPayCheckResult }>()

export async function handleEvmPayCheckRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  const m = url.pathname.match(/^\/api\/([a-z]+)\/check(\/codes)?$/)
  if (!m || !PAY_CHECK_SLUGS[m[1]]) return false
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: `use GET /api/${m[1]}/check?q=<token, wallet, agent id or x402 link>` })
    return true
  }
  if (m[2]) {
    // The machine codes, so an agent can branch on them without scraping prose, and the token
    // the check calls real, so the page never has to carry its own copy of that address.
    const chain = getChainById(PAY_CHECK_SLUGS[m[1]])
    const token = chain ? settlementTokenOf(chain) : null
    res.setHeader('Cache-Control', 'public, max-age=3600')
    sendJson(res, 200, {
      chain: chain ? { id: chain.id, name: chain.name, caip2: chain.caip2 } : null,
      settlementToken: chain && token ? { symbol: token.symbol, address: token.address, explorerUrl: addressUrl(chain, token.address) } : null,
      codes: REASON_CODES,
    })
    return true
  }
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q || q.length > 500) {
    sendJson(res, 400, { error: 'Paste a token or wallet address, an agent id, or an x402 link.' })
    return true
  }
  const chainId = PAY_CHECK_SLUGS[m[1]]
  const key = `${chainId}|${/^0x[0-9a-fA-F]{40}$/.test(q) ? q.toLowerCase() : q}`
  const hit = answers.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) {
    res.setHeader('Cache-Control', 'public, max-age=60')
    sendJson(res, 200, hit.result)
    return true
  }
  const out = await runEvmPayCheck(q, chainId)
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

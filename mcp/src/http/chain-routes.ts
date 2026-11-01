/**
 * Public proof surface: the provenance ledger for a rail, plus a live re-read.
 *
 * A rail slug rather than a registry slug, because the URL is judge-facing copy and
 * `rhchain-testnet` is an internal id. One rail can span several networks so mainnet and
 * testnet evidence sit side by side instead of being halved across two pages.
 */
import { railProofReport, proofRailIndex } from '../chains/proof.js'
import { liveSettlementsByNetworkDeps, settlementsByNetwork, type SettlementsByNetwork } from '../settlement-networks.js'
import { sendJson, type RouteCtx } from './shared.js'

export type ChainRouteDeps = {
  /** The settlement split by network. Injected only so a test can drive the route without
   *  reading a log; http.ts passes nothing and gets the live one. */
  splitByNetwork?: () => Promise<SettlementsByNetwork>
}

export async function handleChainRoutes(ctx: RouteCtx, deps: ChainRouteDeps = {}): Promise<boolean> {
  const { req, res, url } = ctx
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/proof')) return false

  if (url.pathname === '/api/proof/rails') {
    // The rail index is still the local ledger. settlementsByNetwork is additive: the Gateway
    // and facilitator logs split by network, counted on every read like /api/arc/season, so
    // no cache may hold it. A split that fails is left out rather than allowed to cost the
    // page its rail cards, and a page that finds no split shows nothing in its place.
    res.setHeader('Cache-Control', 'no-store')
    const splitByNetwork = deps.splitByNetwork ?? (() => settlementsByNetwork(liveSettlementsByNetworkDeps()))
    // Through a resolved promise, so a throw before the first await is caught here too.
    const split = await Promise.resolve().then(splitByNetwork).catch((e: unknown) => {
      console.error('[proof] settlement split by network failed:', e instanceof Error ? e.message : e)
      return undefined
    })
    sendJson(res, 200, { rails: proofRailIndex(), ...(split ? { settlementsByNetwork: split } : {}) })
    return true
  }

  const match = url.pathname.match(/^\/api\/proof\/([a-z0-9-]+)$/)
  if (!match) return false
  const report = await railProofReport(match[1])
  if (!report) {
    sendJson(res, 404, { error: `no published proof for '${match[1]}'`, rails: proofRailIndex() })
    return true
  }
  sendJson(res, 200, report)
  return true
}

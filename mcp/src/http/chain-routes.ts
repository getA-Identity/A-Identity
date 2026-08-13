/**
 * Public proof surface: the provenance ledger for a rail, plus a live re-read.
 *
 * A rail slug rather than a registry slug, because the URL is judge-facing copy and
 * `rhchain-testnet` is an internal id. One rail can span several networks so mainnet and
 * testnet evidence sit side by side instead of being halved across two pages.
 */
import { railProofReport, proofRailIndex } from '../chains/proof.js'
import { sendJson, type RouteCtx } from './shared.js'

export async function handleChainRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  if (req.method !== 'GET' || !url.pathname.startsWith('/api/proof')) return false

  if (url.pathname === '/api/proof/rails') {
    sendJson(res, 200, { rails: proofRailIndex() })
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

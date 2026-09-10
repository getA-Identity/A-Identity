/**
 * Circle CCTP V2 between Stellar and EVM, driven directly (see ../cctp-stellar.ts).
 *
 * GET  /api/cctp/stellar/status   which chains can take part, their Circle-verified
 *                                 contracts, and whether a bridging signer is present
 * POST /api/cctp/stellar/bridge   prepared-or-executed transfer; behind the verified
 *                                 session gate because it can move money, capped, and
 *                                 mainnet-refused unless the environment opts in
 */
import { bridgeCctp, cctpStellarStatus, type BridgeInput } from '../cctp-stellar.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

export async function handleCctpRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url } = ctx
  if (!url.pathname.startsWith('/api/cctp/stellar/')) return false

  if (req.method === 'GET' && url.pathname === '/api/cctp/stellar/status') {
    sendJson(res, 200, cctpStellarStatus())
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/cctp/stellar/bridge') {
    const body = (await readBody(req).catch(() => null)) as Partial<BridgeInput> | null
    if (!body?.from || !body?.to || typeof body.amountUsd !== 'number') {
      sendJson(res, 400, { error: 'from, to (registry chain ids or CAIP-2) and amountUsd are required; execute: true to broadcast, recipient optional' })
      return true
    }
    const r = await bridgeCctp({
      from: String(body.from),
      to: String(body.to),
      amountUsd: body.amountUsd,
      recipient: typeof body.recipient === 'string' ? body.recipient : undefined,
      finality: body.finality === 1000 ? 1000 : 2000,
      execute: body.execute === true,
      resumeBurnTx: typeof body.resumeBurnTx === 'string' ? body.resumeBurnTx : undefined,
    })
    if ('error' in r) { sendJson(res, 400, r); return true }
    sendJson(res, 200, r)
    return true
  }
  return false
}

/**
 * Circle CCTP V2 between Stellar and EVM, driven directly (see ../cctp-stellar.ts).
 *
 * GET  /api/cctp/stellar/status   which chains can take part, their Circle-verified
 *                                 contracts, and whether a bridging signer is present
 * POST /api/cctp/stellar/bridge   prepared-or-executed transfer. Any verified session gets
 *                                 every step prepared, which broadcasts nothing. EXECUTING
 *                                 is limited to the operators named in CCTP_BRIDGE_OPERATORS,
 *                                 signs only with the dedicated bridging keys, is rate
 *                                 limited and capped, and is mainnet-refused unless the
 *                                 environment opts in
 */
import { bridgeCctp, bridgeExecuteGate, cctpStellarStatus, type BridgeInput } from '../cctp-stellar.js'
import { readBody, sendJson, type RouteCtx } from './shared.js'

export async function handleCctpRoutes(ctx: RouteCtx): Promise<boolean> {
  const { req, res, url, callerId } = ctx
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
    const execute = body.execute === true
    // Before anything is fetched or built. A verified session used to be this route's only
    // gate, and wallet sign-in is open to anyone, so an executed bridge was open to anyone:
    // it burned USDC from a key this server holds, to a recipient the caller chose.
    if (execute) {
      const gate = bridgeExecuteGate(callerId)
      if (!gate.ok) {
        sendJson(res, 403, { error: `Forbidden: ${gate.reason}` })
        return true
      }
    }
    const r = await bridgeCctp({
      from: String(body.from),
      to: String(body.to),
      amountUsd: body.amountUsd,
      recipient: typeof body.recipient === 'string' ? body.recipient : undefined,
      finality: body.finality === 1000 ? 1000 : 2000,
      execute,
      resumeBurnTx: typeof body.resumeBurnTx === 'string' ? body.resumeBurnTx : undefined,
    })
    if ('error' in r) { sendJson(res, 400, r); return true }
    sendJson(res, 200, r)
    return true
  }
  return false
}

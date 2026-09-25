/**
 * Paid checks settled on a set of networks, summed across the x402 rails that report a
 * per-network breakdown: our own EIP-3009 facilitator (GET /api/facilitator/proof) and
 * Circle Gateway nanopayments (GET /api/x402/gateway/proof).
 *
 * Each rail's byNetwork is keyed by CAIP-2 id, so the sum only ever adds figures about the
 * same chains; a rail-wide total (or a rail's default asset symbol) never leaks in. /arc and
 * /proof/arc both read their headline from here, so the two pages cannot disagree about the
 * same payments.
 */

export type ByNetwork = Record<string, { count: number; usd: number; assetSymbol?: string }>

export type PaidChecks = {
  count: number
  usd: number
  /** The asset each counted network settled in, deduplicated. Empty when nothing settled. */
  assetSymbols: string[]
}

/**
 * Null when no source could be read or none publishes a per-network breakdown, so a caller
 * shows a dash rather than a zero it does not know to be true.
 */
export function sumPaidChecks(
  sources: readonly ({ byNetwork?: ByNetwork } | null | undefined)[],
  networks: ReadonlySet<string>,
): PaidChecks | null {
  const readable = sources.filter((s): s is { byNetwork: ByNetwork } => Boolean(s?.byNetwork))
  if (readable.length === 0) return null
  let count = 0
  let usd = 0
  const symbols = new Set<string>()
  for (const s of readable) {
    for (const [caip, v] of Object.entries(s.byNetwork)) {
      if (!networks.has(caip)) continue
      count += v.count
      usd += v.usd
      if (v.assetSymbol && v.count > 0) symbols.add(v.assetSymbol)
    }
  }
  return { count, usd: Number(usd.toFixed(6)), assetSymbols: [...symbols] }
}

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

export type ByNetwork = Record<string, { count: number; usd: number; assetSymbol?: string; internal?: number; internalUsd?: number }>

/** How many of the settled payments came from our own wallets. Null when a log read does not publish it, a backend from before it. */
export type PaidChecksSplit = { internal: number; external: number; internalUsd: number; externalUsd: number }

export type PaidChecks = {
  count: number
  usd: number
  /** The asset each counted network settled in, deduplicated. Empty when nothing settled. */
  assetSymbols: string[]
  split: PaidChecksSplit | null
}

/** A split by count alone: a rail with its own log says how many settlements came from outside our wallets, and no dollars. */
export type CountSplit = { internal: number; external: number; internalUsd: null; externalUsd: null }

/**
 * The split for a rail with its own log (Stellar, Algorand, Celo), which publishes how many settlements it counted and how
 * many of those came from outside our own wallets. Ours are the rest. Null when the log does not say how many were external,
 * or says what no count can be (a negative, a fraction, or more external than settled), so the headline shows nothing
 * rather than a guess. /proof/:rail reads its own-rail headline from here.
 */
export function ownRailSplit(total: number, external: number | null | undefined): CountSplit | null {
  if (typeof external !== 'number' || !Number.isInteger(external) || !Number.isInteger(total) || external < 0 || external > total) return null
  return { internal: total - external, external, internalUsd: null, externalUsd: null }
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
  let internal = 0
  let internalUsd = 0
  // A network whose log says nothing about who paid leaves the split unknown, rather than reading as all external.
  let splitKnown = true
  const symbols = new Set<string>()
  for (const s of readable) {
    for (const [caip, v] of Object.entries(s.byNetwork)) {
      if (!networks.has(caip)) continue
      count += v.count
      usd += v.usd
      if (v.assetSymbol && v.count > 0) symbols.add(v.assetSymbol)
      if (typeof v.internal === 'number' && typeof v.internalUsd === 'number') {
        internal += v.internal
        internalUsd += v.internalUsd
      } else if (v.count > 0) {
        splitKnown = false
      }
    }
  }
  const round = (n: number) => Number(n.toFixed(6))
  return {
    count,
    usd: round(usd),
    assetSymbols: [...symbols],
    split: splitKnown ? { internal, external: count - internal, internalUsd: round(internalUsd), externalUsd: round(usd - internalUsd) } : null,
  }
}

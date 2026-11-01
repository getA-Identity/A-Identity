/**
 * The Circle Gateway and EIP-3009 facilitator logs, split by network: our own payments
 * apart from everyone else's, per rail, per chain.
 *
 * The general proof page printed each log's own count and its payer split, and that was all
 * a reader could quote. The Deliverable 2 evidence doc wrote "9 internal / 7 external
 * payments across supported networks" and then had to hedge that the network of each
 * external payment required separate verification, although every row in both logs names
 * the network it settled on. This module says it: for each network, named from the chain
 * registry, how many settled payments each rail took from our own wallets and how many from
 * wallets we do not control, with the USD of each.
 *
 * The rules are the season report's (arc-season.ts), applied to every network instead of
 * Arc Mainnet alone, and settlement-networks.test.ts feeds the same rows to both documents
 * to keep them that way:
 *   - A row counts when it settled: a Gateway row credited or completed, a facilitator row
 *     settled. Failed, unconfirmed, reverted and ambiguous rows do not count.
 *   - A payer is internal when it is on either rail's published list of our own buyer
 *     wallets, compared case-insensitively. Every other payer is external.
 *   - Each rail is counted on its own and never added to the other, the rule the page
 *     prints above its tiles: one figure across two logs describes neither of them.
 *
 * A network the registry does not know keeps a row of its own under its CAIP-2 id, with no
 * registry id, after every network the registry does know. Dropping it, or folding it into
 * another row, would make the split disagree with the log it was read from.
 *
 * Pure: the loaders, the internal-payer lists and the clock are injected, and the live ones
 * are the season report's own (liveArcSeasonDeps), so the two documents cannot read
 * different logs or different lists.
 */
import { liveArcSeasonDeps, type ArcSeasonDeps } from './arc-season.js'
import { CHAINS, getChain } from './chains/index.js'
import {
  GATEWAY_SETTLEMENTS_CAP,
  X402_SETTLEMENTS_CAP,
  type GatewaySettlementRecord,
  type X402SettlementRecord,
} from './storage.js'

export type SettlementRail = 'gateway' | 'facilitator'

export type SettlementSide = { count: number; usd: number }

export type SettlementRailSplit = { internal: SettlementSide; external: SettlementSide }

export type SettlementNetwork = {
  /** Registry id, or null for a network the registry does not know. */
  chain: string | null
  /** Registry display name; the CAIP-2 id itself for a network the registry does not know. */
  name: string
  /** As the log recorded it. Empty only for a row that recorded no network at all. */
  caip2: string
  /** From the registry; null for a network it does not know. */
  testnet: boolean | null
  byRail: Record<SettlementRail, SettlementRailSplit>
}

export type SettlementLogState = {
  label: string
  /** The log itself on this backend, for a reader who wants every row behind a count. */
  path: string
  /** What a row had to be to count. */
  counts: string
  /** False when the log did not answer. It then contributes nothing, and says so here
   *  rather than reading as zero payments. */
  readable: boolean
  /** Rows read, every outcome included. */
  rows: number
  /** Why an unreadable log is so, in our own words: the deadline it missed, or
   *  SETTLEMENT_LOG_UNREADABLE. Never a storage error verbatim. */
  reason?: string
}

export type SettlementsByNetwork = {
  asOf: string
  basis: string
  logs: Record<SettlementRail, SettlementLogState>
  /** Every network with at least one counted row on either rail: Arc Mainnet first, then
   *  the other mainnets and then the testnets in registry order, then any network the
   *  registry does not know. */
  networks: SettlementNetwork[]
  /** Each rail across every network, so the split reconciles with that rail's own log. */
  totals: Record<SettlementRail, SettlementRailSplit>
}

export type SettlementsByNetworkDeps = Pick<ArcSeasonDeps, 'gatewayRows' | 'facilitatorRows' | 'internalPayers'> & {
  now?: () => number
  /** How long a log may take to answer before it is reported unreadable. */
  deadlineMs?: number
}

/** The season report's loaders and lists, and nothing else. */
export function liveSettlementsByNetworkDeps(env: NodeJS.ProcessEnv = process.env): SettlementsByNetworkDeps {
  const { gatewayRows, facilitatorRows, internalPayers } = liveArcSeasonDeps(env)
  return { gatewayRows, facilitatorRows, internalPayers }
}

/**
 * Bounded, because the rail index this split rides on used to be purely local and painted
 * at once. A database that stops answering must cost the page its split, not its rail cards.
 */
export const SETTLEMENT_LOG_DEADLINE_MS = 5_000

/** Arc Mainnet leads: both rails settle there, and it is the network the season is judged on. */
const LEADING_CHAIN = 'arc-mainnet'

const GATEWAY_SETTLED = new Set<GatewaySettlementRecord['outcome']>(['credited', 'completed'])

const LOGS: Record<SettlementRail, Pick<SettlementLogState, 'label' | 'path' | 'counts'>> = {
  gateway: { label: 'Circle Gateway', path: '/api/x402/gateway/proof', counts: 'rows credited or completed' },
  facilitator: { label: 'EIP-3009 facilitator', path: '/api/facilitator/proof', counts: 'rows settled' },
}

const BASIS =
  "A row counts when it settled: a Circle Gateway row credited or completed, or an EIP-3009 facilitator row settled; failed, unconfirmed, reverted and ambiguous rows do not. A payer is internal when its address is on either rail's published list of our own buyer wallets (the hardcoded KNOWN_INTERNAL_PAYERS plus X402_GATEWAY_INTERNAL_PAYERS and X402_3009_INTERNAL_PAYERS), compared case-insensitively, the rule /api/arc/season counts by; every other payer is external. " +
  `Each network is named from the chain registry, and each rail is counted on its own, never added to the other. Counts cover the rows each log retains, the latest ${GATEWAY_SETTLEMENTS_CAP} on the Gateway log and the latest ${X402_SETTLEMENTS_CAP} on the facilitator log, not an all-time history.`

const usd6 = (n: number) => Number(n.toFixed(6))

type Counted = { rail: SettlementRail; caip2: string; payer: string; usd: number }

/** One settled row, read defensively: a malformed row must not break the split. */
function counted(rail: SettlementRail, r: GatewaySettlementRecord | X402SettlementRecord): Counted {
  return {
    rail,
    caip2: typeof r.network === 'string' ? r.network : '',
    payer: typeof r.payer === 'string' ? r.payer.toLowerCase() : '',
    usd: Number.isFinite(r.amountUsd) ? r.amountUsd : 0,
  }
}

/** Published when a read fails for any reason but the deadline. The cause itself is not
 *  published: a storage error can name a database host or a file path, and the storage layer
 *  already logs it on the server. */
export const SETTLEMENT_LOG_UNREADABLE = 'the log could not be read; the cause is logged on the server rather than published'

async function readLog<T>(
  load: () => Promise<T[]>,
  deadlineMs: number,
): Promise<{ rows: T[]; readable: boolean; reason?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Error(`the log did not answer within ${deadlineMs} ms`)
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late), deadlineMs)
  })
  try {
    const rows = await Promise.race([load(), deadline])
    return { rows, readable: true }
  } catch (e) {
    return { rows: [], readable: false, reason: e === late ? late.message : SETTLEMENT_LOG_UNREADABLE }
  } finally {
    clearTimeout(timer)
  }
}

const emptySplit = (): SettlementRailSplit => ({ internal: { count: 0, usd: 0 }, external: { count: 0, usd: 0 } })

const roundSplit = (s: SettlementRailSplit): SettlementRailSplit => ({
  internal: { count: s.internal.count, usd: usd6(s.internal.usd) },
  external: { count: s.external.count, usd: usd6(s.external.usd) },
})

/** Sort key: Arc Mainnet, then mainnets, then testnets, each in registry order, then the
 *  networks the registry does not know, then rows that recorded no network at all. */
function rank(n: SettlementNetwork): [number, number] {
  if (n.chain === LEADING_CHAIN) return [0, 0]
  const i = CHAINS.findIndex((c) => c.id === n.chain)
  if (i === -1) return [n.caip2 ? 3 : 4, 0]
  return [n.testnet ? 2 : 1, i]
}

export async function settlementsByNetwork(deps: SettlementsByNetworkDeps): Promise<SettlementsByNetwork> {
  const now = deps.now ?? Date.now
  const deadlineMs = deps.deadlineMs ?? SETTLEMENT_LOG_DEADLINE_MS
  const [gateway, facilitator] = await Promise.all([
    readLog(deps.gatewayRows, deadlineMs),
    readLog(deps.facilitatorRows, deadlineMs),
  ])

  const rows: Counted[] = [
    ...gateway.rows.filter((r) => GATEWAY_SETTLED.has(r.outcome)).map((r) => counted('gateway', r)),
    ...facilitator.rows.filter((r) => r.outcome === 'settled').map((r) => counted('facilitator', r)),
  ]
  const mine = new Set([...deps.internalPayers.gateway, ...deps.internalPayers.facilitator].map((a) => a.toLowerCase()))

  // Summed in log order and rounded once at the end, as the season report sums, so the two
  // documents print the same USD for the same rows to the last digit.
  const byNetwork = new Map<string, Record<SettlementRail, SettlementRailSplit>>()
  const totals: Record<SettlementRail, SettlementRailSplit> = { gateway: emptySplit(), facilitator: emptySplit() }
  for (const row of rows) {
    const side = mine.has(row.payer) ? 'internal' : 'external'
    const network = byNetwork.get(row.caip2) ?? { gateway: emptySplit(), facilitator: emptySplit() }
    byNetwork.set(row.caip2, network)
    for (const split of [network[row.rail], totals[row.rail]]) {
      split[side].count += 1
      split[side].usd += row.usd
    }
  }

  const networks: SettlementNetwork[] = [...byNetwork].map(([caip2, split]) => {
    const chain = caip2 ? getChain(caip2) : undefined
    return {
      chain: chain?.id ?? null,
      name: chain?.name ?? (caip2 || 'Network not recorded'),
      caip2,
      testnet: chain?.testnet ?? null,
      byRail: { gateway: roundSplit(split.gateway), facilitator: roundSplit(split.facilitator) },
    }
  })
  networks.sort((a, b) => {
    const [ra, rb] = [rank(a), rank(b)]
    return ra[0] - rb[0] || ra[1] - rb[1] || a.caip2.localeCompare(b.caip2)
  })

  const state = (rail: SettlementRail, read: { rows: unknown[]; readable: boolean; reason?: string }): SettlementLogState => ({
    ...LOGS[rail],
    readable: read.readable,
    rows: read.rows.length,
    ...(read.reason ? { reason: read.reason } : {}),
  })

  return {
    asOf: new Date(now()).toISOString(),
    basis: BASIS,
    logs: { gateway: state('gateway', gateway), facilitator: state('facilitator', facilitator) },
    networks,
    totals: { gateway: roundSplit(totals.gateway), facilitator: roundSplit(totals.facilitator) },
  }
}

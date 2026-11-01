/**
 * The settlement split by network that GET /api/proof/rails carries, read for /proof.
 *
 * The backend builds it in mcp/src/settlement-networks.ts: the Circle Gateway and EIP-3009
 * facilitator logs, per network, with payments from our own wallets apart from everyone
 * else's. The field is additive and new, and the site and the backend deploy from the same
 * push but not at the same speed, so for a while this page can be talking to a backend that
 * sends no settlementsByNetwork at all. readNetworkSplit answers null for that, and for
 * anything else it cannot read as a split, and the page then shows nothing in its place
 * rather than a table of guesses. Inside a split it did read, a number the backend omits is
 * null, never zero.
 *
 * No imports on purpose: mcp/src/settlement-networks.test.ts loads this file as it ships,
 * through Node's type stripping, and reads the backend's own output with it, so the shape
 * the backend sends and the shape this page reads cannot drift apart unnoticed.
 */

export type SplitRail = 'gateway' | 'facilitator'

/** Column order on the page. */
export const SPLIT_RAILS: readonly SplitRail[] = ['gateway', 'facilitator']

/** Arc Mainnet's registry id. Its row leads the table whatever order a backend sends. */
export const SPLIT_LEADING_CHAIN = 'arc-mainnet'

export type SplitSide = { count: number | null; usd: number | null }

export type SplitCell = { internal: SplitSide; external: SplitSide }

export type SplitLog = {
  label: string
  /** The log's own path on the backend, when the split names it. */
  path: string | null
  /** False when the backend says the log did not answer: its cells are not zeros. */
  readable: boolean
}

export type SplitRow = {
  /** Registry id, or null for a network the registry does not know. */
  chain: string | null
  name: string
  caip2: string
  testnet: boolean | null
  /** Null when the backend sent nothing readable for that rail on this network. */
  byRail: Record<SplitRail, SplitCell | null>
}

export type NetworkSplit = {
  asOf: string | null
  basis: string | null
  logs: Record<SplitRail, SplitLog>
  rows: SplitRow[]
  totals: Record<SplitRail, SplitCell | null>
}

const FALLBACK_LABEL: Record<SplitRail, string> = {
  gateway: 'Circle Gateway',
  facilitator: 'EIP-3009 facilitator',
}

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function readSide(v: unknown): SplitSide {
  const o = obj(v)
  return { count: num(o?.count), usd: num(o?.usd) }
}

function readCell(v: unknown): SplitCell | null {
  const o = obj(v)
  return o ? { internal: readSide(o.internal), external: readSide(o.external) } : null
}

function readByRail(v: unknown): Record<SplitRail, SplitCell | null> {
  const o = obj(v)
  return { gateway: readCell(o?.gateway), facilitator: readCell(o?.facilitator) }
}

function readLogState(rail: SplitRail, v: unknown): SplitLog {
  const o = obj(v)
  return {
    label: str(o?.label) || FALLBACK_LABEL[rail],
    path: str(o?.path),
    readable: o?.readable !== false,
  }
}

function readRow(v: unknown): SplitRow | null {
  const o = obj(v)
  const caip2 = str(o?.caip2)
  if (!o || caip2 === null) return null
  return {
    chain: str(o.chain),
    name: str(o.name) || caip2 || 'Network not recorded',
    caip2,
    testnet: typeof o.testnet === 'boolean' ? o.testnet : null,
    byRail: readByRail(o.byRail),
  }
}

const everyLogRead = (s: NetworkSplit) => SPLIT_RAILS.every((rail) => s.logs[rail].readable)

/**
 * What the page keeps after a refresh, by the rule its tiles follow: a refresh that fails
 * keeps the last good read, and only a log never read says so. A refresh that brings no
 * split, or one where a log did not answer although the last split had every log, keeps the
 * last split, whose own asOf then says how old it is. With no last split there is nothing to
 * keep, so a backend that never sent one still shows nothing.
 */
export function keepLastGoodSplit(prev: NetworkSplit | null, next: NetworkSplit | null): NetworkSplit | null {
  if (!next) return prev
  if (prev && everyLogRead(prev) && !everyLogRead(next)) return prev
  return next
}

/** The split, or null when the document carries none this page can read. Never throws. */
export function readNetworkSplit(raw: unknown): NetworkSplit | null {
  const o = obj(raw)
  if (!o || !Array.isArray(o.networks)) return null
  const logs = obj(o.logs)
  const rows = o.networks.flatMap((n) => {
    const row = readRow(n)
    return row ? [row] : []
  })
  return {
    asOf: str(o.asOf),
    basis: str(o.basis),
    logs: { gateway: readLogState('gateway', logs?.gateway), facilitator: readLogState('facilitator', logs?.facilitator) },
    rows: [...rows.filter((r) => r.chain === SPLIT_LEADING_CHAIN), ...rows.filter((r) => r.chain !== SPLIT_LEADING_CHAIN)],
    totals: readByRail(o.totals),
  }
}

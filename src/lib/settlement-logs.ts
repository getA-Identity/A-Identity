/**
 * The one spec of the published settlement logs, shared by /stats and /proof.
 *
 * Both pages used to carry their own list of which logs exist and how each is read, and
 * they drifted: /stats summed two logs into its headline while /proof read six, and Arc
 * Mainnet, selling since 2026-09-16 on two rails, appeared on one page and not the other.
 * This module is the single list. A page that wants a settlement number imports it from
 * here, so adding a rail is one edit and the two pages cannot disagree about what exists.
 *
 * Pure and typed, no React: the normalizers turn each log's own shape into one `LogRead`,
 * the fetch helper reads every log with independent failure, and `chainRows` folds the
 * per-network rows of every log into one row per chain using the generated registry for
 * names and status. Nothing in here invents a number: a field a log omits is null, never
 * zero, and a log that fails to answer is an error value, never a missing entry.
 */
import { CHAINS, type Chain, type ChainId } from './chains'
import { ASP_BASE, MCP_BASE } from './mcpBase'

/**
 * What a counted row had to pass, by kind. This is the honest difference between the
 * logs, and it is printed per log and per chain rather than flattened into "settled".
 */
export type EvidenceKind =
  | 'chain-receipt'
  | 'facilitator-credit'
  | 'own-event-read'
  | 'facilitator-word'
  | 'fixed-ledger'

export const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
  'chain-receipt': 'Chain receipt',
  'facilitator-credit': 'Facilitator credit, read back',
  'own-event-read': 'Our own event read',
  'facilitator-word': "Facilitator's word",
  'fixed-ledger': 'Fixed ledger',
}

/** One sentence per kind, for a tooltip or a legend. */
export const EVIDENCE_SENTENCE: Record<EvidenceKind, string> = {
  'chain-receipt': 'We broadcast the transfer ourselves and counted it from the receipt carrying the matching Transfer log.',
  'facilitator-credit': "The facilitator settled it; we counted it only after reading the credit back from the facilitator's own API.",
  'own-event-read': 'Whoever broadcast it, we counted it only after reading the transfer event back from the chain ourselves.',
  'facilitator-word': 'Counted when the facilitator answered settled; we do not read it back from the chain.',
  'fixed-ledger': 'A fixed list of transactions published by the seller, each with its own hash; not a running counter.',
}

export type LogKey = 'facilitator' | 'gateway' | 'stellar' | 'algorand' | 'celo' | 'xlayer'

export type LogSpec = {
  key: LogKey
  label: string
  /** Where a page fetches it. For a backend log this is MCP_BASE plus `path`. */
  fetchUrl: string
  /** The backend path, for a page that reads through apiFetch's cold-start retry. The
   *  ASP has no such path: it is a different origin with open CORS, fetched plainly. */
  path?: string
  /** Where a reader opens it raw, on the origin the numbers really come from. */
  href: string
  /** What a row had to pass to be counted, in this log's own terms. One sentence. */
  basis: string
  evidence: EvidenceKind
  /** For a log that names no CAIP-2 network of its own. */
  network?: string
  /** For a log that labels no payer: what the record says about who paid, if anything. */
  payers?: string
  /** The log's own page, when it is not the raw log: the link on its tile. A chain card
   *  links to the chain's /proof page first and falls back to this (PROOF_PAGE_BY_CHAIN). */
  pageHref?: string
}

export type NetworkRow = {
  caip2: string
  count: number
  /** USD moved on this network, when the log says. */
  usd: number | null
  assetSymbol: string | null
}

export type ToolRow = { tool: string; count: number; usd: number | null }

/** One settlement log as both pages show it: its own count, never added to another's. */
export type LogRead = {
  count: number
  /** USD across the log, when the log publishes it. */
  usd: number | null
  /** Payments from wallets we own, or null when the log does not tell them apart. */
  internal: number | null
  /** Payments from wallets that are not ours, or null when the log does not tell. */
  external: number | null
  /** Per-network rows, synthesized from the log's one network when it publishes no breakdown. */
  byNetwork: NetworkRow[]
  /** CAIP-2 ids with at least one settled payment in this log. */
  networks: string[]
  byTool: ToolRow[]
  /** The row cap, when the log says it is full and the count is a window, not a history. */
  cappedAt: number | null
  /** When the retained window starts, if the log says. */
  since: string | null
  /** Facts the pages may quote beside the numbers, each null when the log omits it. */
  details: {
    /** The log's own network string, verbatim. */
    network: string | null
    /** The one buyer wallet behind every row, when the log names it. */
    payer: string | null
    /** Who publishes the log, when it is not this backend. */
    publisher: string | null
    publisherAgentId: string | null
    /** The default network's settlement asset, when named. */
    assetSymbol: string | null
    reverted: number | null
    ambiguous: number | null
    unconfirmed: number | null
  }
}

/**
 * The union of fields a settlement log may publish. Every log names its own total in its
 * own way; the rest is optional because each rail grew its own shape, and a field a log
 * omits is shown as unknown rather than as zero.
 */
export type RawLog = {
  totalSettlements?: number
  totalUsd?: number
  /** The Gateway log's count: rows Circle has credited to us. */
  credited?: number
  internalSettlements?: number
  externalSettlements?: number
  network?: string
  assetSymbol?: string | null
  byNetwork?: Record<string, { count?: number; usd?: number; assetSymbol?: string }>
  byTool?: Record<string, { count?: number; usd?: number } | number>
  reverted?: number
  ambiguous?: number
  unconfirmed?: number
  /** The ASP's shape, which nests its X Layer ledger. */
  asp?: { name?: string; agentId?: string; network?: string }
  realOnchainRevenue?: {
    network?: string
    payer?: string
    totalSettlements?: number
    totalUsd?: number
    byTool?: Record<string, number>
  }
  /** A log that keeps only its latest rows says so here once it is full. */
  window?: { keepsLatest?: number; rows?: number; capped?: boolean; since?: string | null }
}

const ASP_PROOF_JSON = 'https://a-identity-asp.onrender.com/proof.json'
const ASP_PROOF_PAGE = 'https://a-identity-asp.onrender.com/proof'

const backend = (path: string) => `${MCP_BASE}${path}`
const published = (path: string) => `https://a-identity.xyz${path}`

/**
 * Every settlement log we publish, in the order both pages list them.
 *
 * Each keeps its own tile and its own count. The only figures that span them are the
 * ones that say so in their label: /stats sums them into "settlements across every
 * published log" once every log has answered, and /proof counts the networks they cover.
 */
export const SETTLEMENT_LOGS: readonly LogSpec[] = [
  {
    key: 'facilitator',
    label: 'Our EIP-3009 facilitator',
    path: '/api/facilitator/proof',
    fetchUrl: backend('/api/facilitator/proof'),
    href: published('/api/facilitator/proof'),
    basis: 'Counted on a receipt carrying a matching Transfer log.',
    evidence: 'chain-receipt',
  },
  {
    key: 'gateway',
    label: 'Circle Gateway nanopayments',
    path: '/api/x402/gateway/proof',
    fetchUrl: backend('/api/x402/gateway/proof'),
    href: published('/api/x402/gateway/proof'),
    basis: "Counted once Circle's transfers API returns the payment's own authorization.",
    evidence: 'facilitator-credit',
  },
  {
    key: 'stellar',
    label: 'Stellar x402',
    path: '/api/x402/stellar/proof',
    fetchUrl: backend('/api/x402/stellar/proof'),
    href: published('/api/x402/stellar/proof'),
    basis: 'Counted on our own read of the SEP-41 transfer event.',
    evidence: 'own-event-read',
  },
  {
    key: 'algorand',
    label: 'Algorand x402',
    path: '/api/x402/algorand/proof',
    fetchUrl: backend('/api/x402/algorand/proof'),
    href: published('/api/x402/algorand/proof'),
    basis: 'Counted on our own indexer read of the ASA transfer.',
    evidence: 'own-event-read',
  },
  {
    key: 'celo',
    label: 'Celo x402',
    path: '/api/celo/proof',
    fetchUrl: backend('/api/celo/proof'),
    href: published('/api/celo/proof'),
    basis: 'Counted when the facilitator Celo operates answers settled; we do not read it back.',
    evidence: 'facilitator-word',
    pageHref: '/celo-proof',
  },
  {
    key: 'xlayer',
    label: 'X Layer, the Trust Oracle ASP',
    fetchUrl: `${ASP_BASE}/proof.json`,
    href: ASP_PROOF_JSON,
    basis: 'A fixed ledger: each row a transfer with its own transaction hash.',
    evidence: 'fixed-ledger',
    network: CHAINS.find((c) => c.id === 'xlayer')?.caip2,
    payers: 'All from our own buyer wallet, in the demo and seeding runs.',
    pageHref: ASP_PROOF_PAGE,
  },
]

export const LOG_BY_KEY = Object.fromEntries(SETTLEMENT_LOGS.map((s) => [s.key, s])) as Record<LogKey, LogSpec>

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A CAIP-2 id, or the one hidden inside a human string like "X Layer mainnet (eip155:196)". */
function caipOf(s: string | undefined): string | null {
  if (!s) return null
  if (/^[a-z0-9-]+:[A-Za-z0-9._-]+$/.test(s)) return s
  const m = s.match(/\(([a-z0-9-]+:[A-Za-z0-9._-]+)\)/)
  return m ? m[1] : null
}

/** Per-tool rows, normalized across shapes: most logs send objects, the ASP sends counts. */
export function toolRows(byTool: RawLog['byTool'] | undefined): ToolRow[] {
  if (!byTool) return []
  return Object.entries(byTool).map(([tool, v]) => ({
    tool,
    count: typeof v === 'number' ? v : (num(v?.count) ?? 0),
    usd: typeof v === 'number' ? null : num(v?.usd),
  }))
}

/** Turn one log's raw document into the shape both pages render. Never throws on a thin document. */
export function readLog(raw: RawLog, spec: LogSpec): LogRead {
  const nested = raw.realOnchainRevenue
  const byNetworkEntries = Object.entries(raw.byNetwork ?? {})
  const fromNetworks = byNetworkEntries.reduce((n, [, v]) => n + (num(v?.count) ?? 0), 0)
  const count = num(raw.totalSettlements) ?? num(raw.credited) ?? num(nested?.totalSettlements) ?? fromNetworks
  const usd = num(raw.totalUsd) ?? num(nested?.totalUsd)
  const named = spec.network ?? caipOf(raw.network) ?? caipOf(nested?.network)

  let byNetwork: NetworkRow[] = byNetworkEntries.map(([caip2, v]) => ({
    caip2,
    count: num(v?.count) ?? 0,
    usd: num(v?.usd),
    assetSymbol: typeof v?.assetSymbol === 'string' ? v.assetSymbol : null,
  }))
  if (byNetwork.length === 0 && named && count > 0) {
    // A log that publishes no breakdown settles on exactly one network, so its total is
    // that network's row; the asset is only asserted when the log names it.
    byNetwork = [{ caip2: named, count, usd, assetSymbol: typeof raw.assetSymbol === 'string' ? raw.assetSymbol : null }]
  }
  const networks = byNetwork.filter((n) => n.count > 0).map((n) => n.caip2)

  const internal = num(raw.internalSettlements)
  const external = num(raw.externalSettlements) ?? (internal == null ? null : Math.max(0, count - internal))
  const cappedAt = raw.window?.capped && num(raw.window.keepsLatest) ? (raw.window.keepsLatest as number) : null

  return {
    count,
    usd,
    internal,
    external,
    byNetwork,
    networks,
    byTool: toolRows(raw.byTool ?? nested?.byTool),
    cappedAt,
    since: cappedAt && typeof raw.window?.since === 'string' ? raw.window.since : null,
    details: {
      network: raw.network ?? nested?.network ?? raw.asp?.network ?? null,
      payer: nested?.payer ?? null,
      publisher: raw.asp?.name ?? null,
      publisherAgentId: raw.asp?.agentId ?? null,
      assetSymbol: typeof raw.assetSymbol === 'string' ? raw.assetSymbol : null,
      reverted: num(raw.reverted),
      ambiguous: num(raw.ambiguous),
      unconfirmed: num(raw.unconfirmed),
    },
  }
}

/** A log either answered, with its read, or did not, with the reason. Never both, never neither. */
export type LogResult =
  | { spec: LogSpec; status: 'ok'; read: LogRead; readAt: number }
  | { spec: LogSpec; status: 'failed'; error: string; readAt: number }

export type LogFetchOptions = {
  /** Reads a backend path with cold-start retry (apiFetch). Falls back to plain fetch. */
  backend?: (path: string) => Promise<Response>
  /** Plain fetch for the logs on another origin. Defaults to the global one. */
  fetcher?: (url: string) => Promise<Response>
}

/** Read one log. Resolves to a result in every case; it never rejects. */
export async function fetchSettlementLog(spec: LogSpec, opts: LogFetchOptions = {}): Promise<LogResult> {
  const fetcher = opts.fetcher ?? ((url: string) => fetch(url))
  try {
    const res = spec.path && opts.backend ? await opts.backend(spec.path) : await fetcher(spec.fetchUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as RawLog
    return { spec, status: 'ok', read: readLog(raw, spec), readAt: Date.now() }
  } catch (e) {
    return { spec, status: 'failed', error: e instanceof Error ? e.message : String(e), readAt: Date.now() }
  }
}

/**
 * Read every log with independent failure. `onEach` fires as each log lands so a page can
 * fill its tiles one by one; the returned array is in SETTLEMENT_LOGS order once all are in.
 */
export function fetchSettlementLogs(
  opts: LogFetchOptions & { onEach?: (result: LogResult) => void } = {},
  specs: readonly LogSpec[] = SETTLEMENT_LOGS,
): Promise<LogResult[]> {
  return Promise.all(
    specs.map((spec) =>
      fetchSettlementLog(spec, opts).then((result) => {
        opts.onEach?.(result)
        return result
      }),
    ),
  )
}

/** Results keyed by log, the shape a page keeps in state. */
export type LogResults = Partial<Record<LogKey, LogResult>>

export const okReads = (results: LogResults): LogRead[] =>
  SETTLEMENT_LOGS.map((s) => results[s.key]).flatMap((r) => (r && r.status === 'ok' ? [r.read] : []))

/**
 * The cross-log figures /stats leads with, each defined only when it can be honest.
 *
 * `total` exists only once EVERY log has answered: a total that silently drops a rail
 * because its fetch was slow is a lie with a plausible shape. `usd` is the strict figure
 * and likewise needs every log to publish a USD figure, so one log that publishes none
 * keeps it null for good; `usdKnown` is the sum over the logs that do publish one, and
 * `usdUnknownLogs` names the logs it leaves out, so a page can print the known sum with
 * its gap stated instead of a skeleton that never resolves. The payer split sums only the
 * logs that label payers, and `unlabeled` is what the other logs hold: counted as unknown,
 * never as external.
 */
export function crossLogTotals(results: LogResults): {
  answered: number
  failed: LogSpec[]
  pending: LogSpec[]
  total: number | null
  usd: number | null
  /** USD summed over the answered logs that publish a figure; 0 until one does. */
  usdKnown: number
  /** The answered logs that publish no USD figure, so are missing from `usdKnown`. */
  usdUnknownLogs: LogSpec[]
  internal: number
  external: number
  unlabeled: number
  unlabeledLogs: LogSpec[]
  cappedLogs: LogSpec[]
} {
  const failed: LogSpec[] = []
  const pending: LogSpec[] = []
  const unlabeledLogs: LogSpec[] = []
  const usdUnknownLogs: LogSpec[] = []
  const cappedLogs: LogSpec[] = []
  let total = 0
  let usd: number | null = 0
  let usdKnown = 0
  let internal = 0
  let external = 0
  let unlabeled = 0
  let answered = 0
  for (const spec of SETTLEMENT_LOGS) {
    const r = results[spec.key]
    if (!r) {
      pending.push(spec)
      continue
    }
    if (r.status === 'failed') {
      failed.push(spec)
      continue
    }
    answered += 1
    total += r.read.count
    usd = usd == null || r.read.usd == null ? null : usd + r.read.usd
    if (r.read.usd == null) usdUnknownLogs.push(spec)
    else usdKnown += r.read.usd
    if (r.read.internal == null) {
      unlabeled += r.read.count
      unlabeledLogs.push(spec)
    } else {
      internal += r.read.internal
      external += r.read.external ?? Math.max(0, r.read.count - r.read.internal)
    }
    if (r.read.cappedAt) cappedLogs.push(spec)
  }
  const complete = failed.length === 0 && pending.length === 0
  return {
    answered,
    failed,
    pending,
    total: complete ? total : null,
    usd: complete ? usd : null,
    usdKnown,
    usdUnknownLogs,
    internal,
    external,
    unlabeled,
    unlabeledLogs,
    cappedLogs,
  }
}

/** One log's contribution to one chain. */
export type ChainSource = {
  key: LogKey
  label: string
  evidence: EvidenceKind
  count: number
  usd: number | null
  assetSymbol: string | null
  /** Whether the log's payer split applies to this chain alone or to the whole log. A log
   *  that settles on several networks publishes one split for all of them; when that
   *  rail-wide split is all-internal or all-external, every chain's rows follow and the
   *  split is `inferred`. Otherwise it stays `log`, and this chain's share is unknown. */
  splitScope: 'chain' | 'inferred' | 'log' | 'none'
  internal: number | null
  external: number | null
  /** The whole log, for the "n of its m rows are on this chain" qualifier. */
  logCount: number
  /** Per-tool rows, only when they describe this chain alone. */
  tools: ToolRow[]
  cappedAt: number | null
  since: string | null
  href: string
  pageHref: string | null
  payers: string | null
  payer: string | null
}

export type ChainRow = {
  caip2: string
  /** The registry entry, or null for a network the registry does not know. */
  chain: Chain | null
  name: string
  status: Chain['status'] | null
  testnet: boolean
  count: number
  /** Summed only when every contributing log publishes a USD figure. */
  usd: number | null
  assets: string[]
  sources: ChainSource[]
  /** Payments we know came from our own wallets, summed over sources whose split is per chain. */
  internal: number | null
  external: number | null
}

/** Where each chain's human-readable proof lives, by proof rail slug. Keyed by chain id,
 *  mirroring PROOF_RAILS in mcp/src/chains/provenance.ts. A chain card links here first,
 *  so every registry chain links the same way; a chain with no entry links to the page of
 *  the log that counted it, or to the raw log when it has none. */
export const PROOF_PAGE_BY_CHAIN: Partial<Record<ChainId, string>> = {
  'arc-mainnet': '/proof/arc',
  arc: '/proof/arc',
  stellar: '/proof/stellar',
  'stellar-testnet': '/proof/stellar',
  algorand: '/proof/algorand',
  'algorand-testnet': '/proof/algorand',
  base: '/proof/base',
  rhchain: '/proof/robinhood',
  'rhchain-testnet': '/proof/robinhood',
  arbitrum: '/proof/arbitrum',
  celo: '/proof/celo',
  'celo-sepolia': '/proof/celo',
}

/**
 * Fold every answered log into one row per chain, in registry order, for the rail cards.
 *
 * A chain appears when any log counts a settlement on it, so a new network shows up the
 * day it settles and nothing is listed by hand. Arc Mainnet is the case that made this
 * necessary: it is one row in the facilitator log's byNetwork and the whole of the Gateway
 * log, and a reader deserves them on one card.
 */
export function chainRows(results: LogResults): ChainRow[] {
  const rows = new Map<string, ChainRow>()
  for (const spec of SETTLEMENT_LOGS) {
    const r = results[spec.key]
    if (!r || r.status !== 'ok') continue
    const single = r.read.networks.length === 1
    const logInternal = r.read.internal
    const logExternal = r.read.external ?? (logInternal == null ? null : Math.max(0, r.read.count - logInternal))
    for (const n of r.read.byNetwork) {
      if (n.count <= 0) continue
      // Per-chain payer split, in the strongest scope the log supports.
      let splitScope: ChainSource['splitScope'] = 'none'
      let internal: number | null = null
      let external: number | null = null
      if (logInternal != null && logExternal != null) {
        if (single) {
          splitScope = 'chain'
          internal = logInternal
          external = logExternal
        } else if (logExternal === 0) {
          splitScope = 'inferred'
          internal = n.count
          external = 0
        } else if (logInternal === 0) {
          splitScope = 'inferred'
          internal = 0
          external = n.count
        } else {
          splitScope = 'log'
        }
      }
      const chain = CHAINS.find((c) => c.caip2 === n.caip2) ?? null
      const row: ChainRow = rows.get(n.caip2) ?? {
        caip2: n.caip2,
        chain,
        name: chain?.name ?? n.caip2,
        status: chain?.status ?? null,
        testnet: chain?.testnet ?? false,
        count: 0,
        usd: 0,
        assets: [],
        sources: [],
        internal: 0,
        external: 0,
      }
      row.count += n.count
      row.usd = row.usd == null || n.usd == null ? null : Number((row.usd + n.usd).toFixed(6))
      if (n.assetSymbol && !row.assets.includes(n.assetSymbol)) row.assets.push(n.assetSymbol)
      if ((splitScope === 'chain' || splitScope === 'inferred') && row.internal != null && row.external != null) {
        row.internal += internal ?? 0
        row.external += external ?? 0
      } else {
        row.internal = null
        row.external = null
      }
      row.sources.push({
        key: spec.key,
        label: spec.label,
        evidence: spec.evidence,
        count: n.count,
        usd: n.usd,
        assetSymbol: n.assetSymbol,
        splitScope,
        internal: splitScope === 'log' ? logInternal : internal,
        external: splitScope === 'log' ? logExternal : external,
        logCount: r.read.count,
        tools: single ? r.read.byTool : [],
        cappedAt: r.read.cappedAt,
        since: r.read.since,
        href: spec.href,
        // The chain's own /proof page wins; a log's page (the ASP's, or /celo-proof) is its
        // tile's link and only the fallback here, so Celo's card links like every other chain's.
        pageHref: (chain ? PROOF_PAGE_BY_CHAIN[chain.id] : undefined) ?? spec.pageHref ?? null,
        payers: spec.payers ?? null,
        payer: r.read.details.payer,
      })
      rows.set(n.caip2, row)
    }
  }
  const order = (row: ChainRow) => {
    const i = CHAINS.findIndex((c) => c.caip2 === row.caip2)
    return i === -1 ? CHAINS.length : i
  }
  return [...rows.values()].sort((a, b) => order(a) - order(b))
}

/** The registry name for a CAIP-2 id, or the id itself for a network the registry does not know. */
export const chainName = (caip2: string) => CHAINS.find((c) => c.caip2 === caip2)?.name ?? caip2

const fmt = (n: number) => n.toLocaleString('en-US')

/** Who paid, as far as this log says. One sentence, printed identically on both pages. */
export function payersSentence(spec: LogSpec, result: LogResult | undefined): string | null {
  if (!result || result.status !== 'ok') return null
  const log = result.read
  if (log.internal === null) return spec.payers ?? 'This log does not label which payers are our own.'
  if (log.count === 0) return 'Nothing settled yet.'
  if (log.internal === log.count) return 'All from our own wallets, labeled internal.'
  return `${fmt(log.internal)} from our own wallets, ${fmt(log.count - log.internal)} from others.`
}

/** Where it settled and how far back the log reaches. One sentence, identical on both pages. */
export function coverageSentence(result: LogResult | undefined): string | null {
  if (!result || result.status !== 'ok') return null
  const log = result.read
  const where = log.networks.map(chainName).join(', ') || 'no network yet'
  const window = log.cappedAt
    ? `, in the log's latest ${fmt(log.cappedAt)} rows${log.since ? ` since ${log.since.slice(0, 10)}` : ''}`
    : ''
  return `Settled on ${where}${window}.`
}

// ── the Arc Acceleration Season document ──────────────────────────────────────────

export const SEASON_PATH = '/api/arc/season'
export const SEASON_URL = published(SEASON_PATH)

/** The few season facts the two pages quote beside Arc Mainnet's count. Nothing is hardcoded:
 *  the backend counts these from the same two logs on every request. */
export type SeasonSummary = {
  asOf: string | null
  network: string | null
  programName: string | null
  internalChecks: number | null
  externalChecks: number | null
  externalWallets: number | null
  evidenceHref: string
}

export type RawSeason = {
  asOf?: string
  network?: string
  program?: { name?: string }
  usage?: {
    internal?: { checks?: number; wallets?: string[] }
    external?: { checks?: number; wallets?: string[] }
  }
  milestone1?: { evidence?: string }
}

export function readSeason(raw: RawSeason): SeasonSummary {
  return {
    asOf: typeof raw.asOf === 'string' ? raw.asOf : null,
    network: typeof raw.network === 'string' ? raw.network : null,
    programName: typeof raw.program?.name === 'string' ? raw.program.name : null,
    internalChecks: num(raw.usage?.internal?.checks),
    externalChecks: num(raw.usage?.external?.checks),
    externalWallets: Array.isArray(raw.usage?.external?.wallets) ? raw.usage.external.wallets.length : null,
    evidenceHref: '/proof/arc',
  }
}

/** Read the season document. Resolves to null when the backend lacks it or does not answer. */
export async function fetchSeason(backend: (path: string) => Promise<Response>): Promise<SeasonSummary | null> {
  try {
    const res = await backend(SEASON_PATH)
    if (!res.ok) return null
    return readSeason((await res.json()) as RawSeason)
  } catch {
    return null
  }
}

/**
 * Arc Acceleration Season: progress against the success metrics, read from the logs.
 *
 * Circle judges Deliverable 2 (due 2026-10-30) on progress against each success metric
 * with current numbers, links to on-chain evidence and usage so far, with external
 * activity counted separately from our own. This module is that report, and it is
 * computed rather than written: every count comes from the two settlement logs and the
 * verify-then-pay flow log on every request, and the four lists a human has to curate
 * (owner-held vaults, inspectable refusals, partner wallets, verify-then-pay flows recorded
 * anywhere else) are exported here as data, and fill only when the evidence exists.
 *
 * What counts, stated once:
 *   - A check is a settled row on Arc Mainnet. On the Gateway log that is an outcome of
 *     'credited' or 'completed' (Circle holds the money, or the batch has landed); on the
 *     facilitator log it is 'settled' (a receipt with a matching Transfer log). The
 *     facilitator rows are reported under usage, labeled as such.
 *   - Milestone 1 counts verify-then-pay flows, not checks: one of our own Gateway checks
 *     that a vault payment or an inspectable refusal followed, linked by the nonce the
 *     check's settlement row is keyed by. A check with nothing linked is a paid check and
 *     not a flow. An external check is never counted in Milestone 1: it belongs to
 *     Milestone 2, so no check counts in both. The flows come from the vtp_flows log the
 *     verify-then-pay route writes (verify-then-pay/season.ts maps its rows), merged with
 *     the curated list, one flow per check nonce and per payment transaction. A row that cannot
 *     be mapped is skipped and named in logs.flows, and never hides the others. The Gateway log keeps its newest 2000 rows
 *     and vtp_flows keeps every flow, so a recorded flow whose check is older than the oldest
 *     row of a full Gateway log links by the settlement its own row recorded (the same
 *     read-back from Gateway's transfers API, written by the same server), and the report
 *     says how many did. A Gateway log that cannot be read links nothing and says so.
 *   - A payer is internal when it is on either rail's published list of our own buyer
 *     wallets, compared case-insensitively. Everything else is external.
 *   - A vault counts only when its owner key is one we never held, so the launch-day
 *     vault, owned by our operating wallet, does not. A refusal counts only when a
 *     reviewer can inspect it: a reverted vault transaction with a hash, or a DENY that
 *     stopped a payment before signing, with its audit entry. The launch-day refusal was
 *     a simulation with no hash, so it does not.
 *
 * Pure: the loaders, the internal payer lists, the curated lists and the clock are
 * injected, so the aggregation is unit-tested with rows and the route adds the real
 * loaders and nothing else.
 */
import { getChainById, type ChainDescriptor } from './chains/index.js'
import { addressUrl, txUrl } from './chains/explorer.js'
import { PROVENANCE } from './chains/provenance.js'
import {
  GATEWAY_SETTLEMENTS_CAP,
  loadGatewaySettlementsResult,
  loadCountableVtpFlows,
  loadX402SettlementsResult,
  type GatewaySettlementRecord,
  type VtpFlowRecord,
  type X402SettlementRecord,
} from './storage.js'
import { internalPayers as gatewayInternalPayers, railStatus as gatewayRailStatus } from './x402-gateway/rail.js'
import { internalPayers as facilitatorInternalPayers, railStatus as facilitatorRailStatus } from './x402-3009/rail.js'
import { toSeasonFlow } from './verify-then-pay/season.js'

export const ARC_SEASON_CHAIN = 'arc-mainnet'

export const ARC_SEASON_PROGRAM = {
  name: 'Arc Acceleration Season',
  deliverable2Due: '2026-10-30',
  milestone1Due: '2026-11-05',
  milestone2Due: '2026-11-06',
} as const

/** The Deliverable 1 commitments as Circle revised them on 2026-10-19. */
export const ARC_SEASON_TARGETS = {
  ownerHeldVaults: 5,
  gatewayChecks: 100,
  inspectableRefusals: 2,
  externalTeamsLive: 2,
  externalChecks: 30,
  teamsActiveOnSeveralDays: 1,
  publicReferences: 1,
  /** After the program: active external wallets inside a 28-day window. */
  activeExternalWallets: 5,
  activeWindowDays: 28,
} as const

export const ARC_SEASON_EVIDENCE_URL = 'https://a-identity.xyz/proof/arc'

// ── the curated lists ─────────────────────────────────────────────────────────────

export type ArcPartner = {
  /** The wallet the team pays from, any case; matched case-insensitively. */
  wallet: string
  team: string
  /** True once the team has agreed to be named in public as an integration. */
  publicReference: boolean
}

/**
 * External teams, attributed by wallet. A team is added here only AFTER its wallet has
 * paid a check on Arc Mainnet, with the settlement row it first appeared in named in the
 * commit; an entry written before that would make externalTeamsLive count a promise. Empty
 * on 2026-10-19: no external wallet has paid yet.
 */
export const ARC_PARTNERS: ArcPartner[] = []

/**
 * Whose wallet an owner-held vault's owner key is. 'team': a person on the A-Identity team, in
 * their own wallet. 'external': anyone else. Our server holds neither, which is what the metric
 * counts; a reviewer still needs to see which of the two each vault is. The chain cannot tell them
 * apart, so whoever admits the vault says which, with --owner-kind.
 */
export type ArcOwnerKind = 'team' | 'external'

export type ArcOwnerHeldVault = {
  /** The AgentSpendPolicy contract. */
  address: string
  /** The owner key. It is the user's; we never held it, which is the whole metric. */
  owner: string
  ownerKind: ArcOwnerKind
  deployTx: string
  /** UTC day of the deployment. */
  deployedAt: string
  note: string
}

/**
 * Owner-held AgentSpendPolicy vaults on Arc Mainnet, deployed from the browser with a
 * key A-Identity never holds. Filled from the browser vault deployer at /app/vault/arc as
 * each deployment lands; mcp/scripts/arc-owner-vault-check.mjs admits a vault and prints its
 * entry, and a vault is listed only with its deploy hash. Empty until the first one lands.
 */
export const ARC_OWNER_HELD_VAULTS: ArcOwnerHeldVault[] = []

export type ArcRefusalKind = 'vault-policy-on-chain' | 'deny-before-signing'

export type ArcRefusal = {
  kind: ArcRefusalKind
  /** The reverted vault transaction. Required for a vault-policy refusal; absent for a
   *  DENY that stopped the payment before anything was signed, because there is none. */
  txHash?: string
  /** Where the refusal can be inspected when it has no transaction: the audit entry. */
  evidenceUrl?: string
  /** UTC timestamp of the refusal. */
  at: string
  note: string
  /** Why the payment that was refused was to a wallet of ours, when it was. */
  payeeInternal?: string
}

/**
 * Refusals anyone can inspect. One of each kind is the Milestone 1 commitment: a
 * vault-policy refusal that reverted on chain (so it has a hash), and a DENY verdict
 * that stopped a payment before signing (so it has an audit entry and no hash). The
 * launch-day refusal was a simulation and is not here, see the note in the report. The
 * first on-chain refusal was mined on 2026-11-01 by mcp/scripts/arc-vault-refusal.mjs.
 */
export const ARC_REFUSALS: ArcRefusal[] = [
  {
    kind: 'vault-policy-on-chain',
    txHash: '0x134de0b2e18b516d2fb3eda456201d741a089d79dcdc827d77b83e60afd6cb72',
    at: '2026-11-01T12:54:40Z',
    note: 'A 0.5 USDC pay() on the launch-day vault, above its 0.25 USDC autoApproveMax, sent by its operator key (ours) to its owner (our operating wallet) with an explicit gas limit so that it would be mined. It reverted with AboveAutoApprove in block 28990543 (31079 gas, 0.00065 USDC); nothing moved.',
  },
]

export type ArcFlowOutcome = 'paid' | 'refused'

export type ArcVerifyThenPayFlow = {
  /** The Gateway check that opened the flow, by the EIP-3009 nonce its settlement row is
   *  keyed by (authNonce). It counts only when that row is one of our own settled Gateway
   *  checks on Arc Mainnet, so a nonce that names no such row counts nothing. */
  checkNonce: string
  /** The address that was checked and then paid or refused. The check's agentId and the
   *  vault payee are this one address, so a reviewer can match the verdict to the Paid
   *  event; a Gateway row does not record what was checked. */
  payee: string
  outcome: ArcFlowOutcome
  /** The vault's Paid transaction for a payment, or the reverted pay() for an on-chain
   *  refusal. Required for a payment. */
  txHash?: string
  /** Where a DENY that stopped the payment before signing can be inspected: its public
   *  audit entry or flow record. Only for a refusal with no transaction. */
  evidenceUrl?: string
  /** The wallet that paid for the check, when the flow names it. EIP-3009 nonces are unique
   *  per payer, not globally, so a flow that names its payer links only to that payer's
   *  check. */
  payer?: string
  /** The check's settlement as the flow's own record holds it (recorded flows only). Read
   *  only when the check's row can have aged out of the retained Gateway log: the log is full
   *  and the check is older than its oldest row. */
  check?: { network: string; payer: string; outcome: string; ts: string }
  /** The vault's two keys as the flow's own record holds them (recorded flows only). A flow
   *  whose payee is one of them is labeled in the report: it is a real settled check, and it is
   *  not a payment to anyone else. */
  vaultKeys?: { owner: string; operator: string }
  /** UTC timestamp of the outcome. */
  at: string
  note: string
}

/**
 * Verify-then-pay flows on Arc Mainnet recorded anywhere other than the vtp_flows log: a
 * Gateway check followed by the vault payment or the refusal it led to. The route
 * POST /api/x402/gateway/verify-then-pay records its own flows and the report reads them
 * through ArcSeasonDeps.flowRows; an entry here is for a flow that ran some other way. A
 * flow is added only after its outcome was read back from the chain (the Paid or reverted
 * receipt, paying the payee that was checked) or published (the DENY's public record), with
 * the check's settlement nonce. Empty on 2026-11-01: no settled check is linked to a vault
 * payment or a refusal yet. The two launch-day vault payments went to our own operating
 * wallet and are not linked to any check.
 */
export const ARC_VERIFY_THEN_PAY_FLOWS: ArcVerifyThenPayFlow[] = []

// ── the report ────────────────────────────────────────────────────────────────────

export type ArcSeasonRailTotals = { checks: number; usd: number }

export type ArcSeasonWallet = {
  wallet: string
  /** The partner team, when the wallet is attributed to one. */
  team?: string
  checks: number
  usd: number
  firstTs: string
  lastTs: string
  /** Distinct UTC days with at least one settled check, ascending. */
  activeDays: string[]
}

export type ArcSeasonUsageSide = {
  checks: number
  usd: number
  /** Distinct payer wallets, lowercased, ascending. */
  wallets: string[]
  /** Distinct UTC days with at least one settled check, ascending. */
  activeDays: string[]
  byRail: { gateway: ArcSeasonRailTotals; facilitator: ArcSeasonRailTotals }
}

/** A flow row the report could not map. flowId is null when the row does not carry one. */
export type ArcSeasonSkippedRow = { flowId: string | null; reason: string }
export type ArcSeasonLogRead = { readable: boolean; rows: number; reason?: string; skipped?: ArcSeasonSkippedRow[] }

export type ArcSeasonVaultItem = ArcOwnerHeldVault & { explorerUrl: string; deployExplorerUrl: string }
export type ArcSeasonRefusalItem = ArcRefusal & { explorerUrl: string | null }
export type ArcSeasonFlowItem = ArcVerifyThenPayFlow & { explorerUrl: string | null }
export type ArcSeasonTeam = ArcSeasonWallet & { team: string; publicReference: boolean }

export type ArcSeasonReport = {
  asOf: string
  chain: string
  /** CAIP-2 id of Arc Mainnet, from the registry. */
  network: string
  program: typeof ARC_SEASON_PROGRAM
  /** Whether each log could be read. A log that could not be read contributes nothing,
   *  and says so here rather than reading as zero demand. `flows` is the verify-then-pay
   *  flow log, present whenever a loader for it is wired (the live route always wires one). */
  logs: { gateway: ArcSeasonLogRead; facilitator: ArcSeasonLogRead; flows?: ArcSeasonLogRead }
  usage: {
    basis: string
    internal: ArcSeasonUsageSide
    external: ArcSeasonUsageSide & { byWallet: ArcSeasonWallet[] }
  }
  milestone1: {
    title: string
    due: string
    vaults: { count: number; target: number; items: ArcSeasonVaultItem[]; note: string }
    checks: {
      /** Verify-then-pay flows: our own Gateway checks with a vault payment or a refusal linked. */
      count: number
      target: number
      /** Our own Gateway checks settled on Arc Mainnet, linked or not. */
      internal: number
      /** External Gateway checks. Counted under Milestone 2, never in count. */
      external: number
      linked: Record<ArcFlowOutcome, number>
      /** Our own Gateway checks in the retained log with nothing linked: paid checks, not flows. */
      unlinked: number
      /** Of count, flows linked by the settlement their own flow record holds, because their
       *  check's Gateway row aged out of the retained log. */
      agedOut: number
      /** Of count, flows whose payee is one of our own wallets or the vault's own key. Each is
       *  labeled on its item. Planned probes count as flows, and are not third-party payments. */
      internalPayee: number
      /** How many different payees the refused flows name, next to linked.refused. */
      refusedPayees: number
      items: ArcSeasonFlowItem[]
      rail: string
      note: string
    }
    refusals: {
      count: number
      target: number
      items: ArcSeasonRefusalItem[]
      byKind: Record<ArcRefusalKind, number>
      note: string
    }
    evidence: string
  }
  milestone2: {
    title: string
    due: string
    externalTeamsLive: { count: number; target: number; teams: ArcSeasonTeam[]; note: string }
    externalChecks: { count: number; target: number; note: string }
    teamActiveOnSeveralDays: { count: number; target: number; teams: string[]; note: string }
    publicReference: { count: number; target: number; names: string[]; note: string }
    /** External wallets that paid but are attributed to no team. Reported, never folded. */
    unattributed: { wallets: number; checks: number; note: string }
  }
  afterProgram: {
    activeExternalWallets: { count: number; target: number; windowDays: number; since: string; wallets: string[] }
    note: string
  }
  note: string
}

export type ArcSeasonDeps = {
  /** May throw: an unreadable Gateway log is reported as unreadable, not as empty. */
  gatewayRows: () => Promise<GatewaySettlementRecord[]>
  /** How many rows the Gateway log keeps. Default GATEWAY_SETTLEMENTS_CAP. */
  gatewayCap?: number
  /** May throw: an unreadable facilitator log is reported as unreadable, not as empty. */
  facilitatorRows: () => Promise<X402SettlementRecord[]>
  /** Our own buyer wallets, as each rail publishes them. Any case. */
  internalPayers: { gateway: string[]; facilitator: string[] }
  /** The wallets our rails are paid to. A payment to one is a payment to ourselves. */
  ourPayTo?: string[]
  now?: () => number
  partners?: ArcPartner[]
  vaults?: ArcOwnerHeldVault[]
  refusals?: ArcRefusal[]
  /** The curated flows. Default ARC_VERIFY_THEN_PAY_FLOWS. */
  flows?: ArcVerifyThenPayFlow[]
  /** Flows the server recorded after its own read-back (vtp_flows), mapped by toSeasonFlow.
   *  May throw: an unreadable flow log is reported in logs.flows as unreadable, never as no
   *  flows. A single row it cannot map goes to onSkip and on into logs.flows. Merged with
   *  `flows`, one flow per check nonce, the curated entry first. */
  flowRows?: (onSkip?: (row: ArcSeasonSkippedRow) => void) => Promise<ArcVerifyThenPayFlow[]>
}

// The live loaders, each through the read that tells "no rows yet" from "could not read the
// log", so an unreadable log throws and is reported as unreadable rather than counted as zero.
// Declared once at module level, so every document that takes the season report's loaders
// (settlement-networks.ts does) holds these very functions, and a test can say so.
async function liveGatewayRows(): Promise<GatewaySettlementRecord[]> {
  const read = await loadGatewaySettlementsResult()
  if (!read.ok) throw new Error(read.reason)
  return read.rows
}

async function liveFacilitatorRows(): Promise<X402SettlementRecord[]> {
  const read = await loadX402SettlementsResult()
  if (!read.ok) throw new Error(read.reason)
  return read.rows
}

async function liveFlowRows(onSkip?: (row: ArcSeasonSkippedRow) => void): Promise<ArcVerifyThenPayFlow[]> {
  const read = await loadCountableVtpFlows()
  if (!read.ok) throw new Error(read.reason)
  return seasonFlowsFromRows(read.rows, onSkip)
}

/** Flow rows as season flows, one row at a time: a row that cannot be mapped is passed to onSkip,
 *  and the rest still count. */
export function seasonFlowsFromRows(rows: VtpFlowRecord[], onSkip?: (row: ArcSeasonSkippedRow) => void): ArcVerifyThenPayFlow[] {
  return rows.flatMap((row) => {
    try {
      return toSeasonFlow(row)
    } catch (e) {
      const flowId = (row as { flowId?: unknown } | null)?.flowId
      onSkip?.({ flowId: typeof flowId === 'string' ? flowId : null, reason: e instanceof Error ? e.message : String(e) })
      return []
    }
  })
}

/** The real loaders and the rails' own internal-payer lists. The route adds nothing else. */
export function liveArcSeasonDeps(env: NodeJS.ProcessEnv = process.env): ArcSeasonDeps {
  return {
    gatewayRows: liveGatewayRows,
    facilitatorRows: liveFacilitatorRows,
    flowRows: liveFlowRows,
    internalPayers: { gateway: gatewayInternalPayers(env), facilitator: facilitatorInternalPayers(env) },
    ourPayTo: [gatewayRailStatus(env, arcMainnet().caip2).payTo, facilitatorRailStatus(env, arcMainnet().caip2).payTo].filter((a): a is string => Boolean(a)),
  }
}

/** Curated flows first, then recorded ones, one per check nonce whatever its case. */
export function mergeFlows(curated: ArcVerifyThenPayFlow[], recorded: ArcVerifyThenPayFlow[]): ArcVerifyThenPayFlow[] {
  const seen = new Set<string>()
  const out: ArcVerifyThenPayFlow[] = []
  for (const f of [...curated, ...recorded]) {
    const key = f.checkNonce.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f)
  }
  return out
}

const GATEWAY_SETTLED = new Set<GatewaySettlementRecord['outcome']>(['credited', 'completed'])

type Check = { rail: 'gateway' | 'facilitator'; payer: string; usd: number; ts: string; nonce: string }

const usd6 = (n: number) => Number(n.toFixed(6))

const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** What a reviewer opens to inspect a flow's outcome, or null when the flow names nothing
 *  and so cannot count: a payment needs its Paid transaction, a refusal its reverted
 *  transaction or a public audit entry. */
function flowEvidence(f: ArcVerifyThenPayFlow): string | null {
  if (f.txHash && TX_HASH.test(f.txHash)) return f.txHash
  if (f.outcome === 'refused' && f.evidenceUrl?.startsWith('https://')) return f.evidenceUrl
  return null
}

/** The UTC day of an ISO timestamp, or null when the timestamp does not parse. */
function utcDay(ts: string): string | null {
  const t = Date.parse(ts)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null
}

const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort()

function arcMainnet(): ChainDescriptor {
  const chain = getChainById(ARC_SEASON_CHAIN)
  if (!chain) throw new Error(`the registry no longer has ${ARC_SEASON_CHAIN}; the season report reads its network from there`)
  return chain
}

function side(checks: Check[]): ArcSeasonUsageSide {
  const rail = (name: Check['rail']): ArcSeasonRailTotals => {
    const own = checks.filter((c) => c.rail === name)
    return { checks: own.length, usd: usd6(own.reduce((s, c) => s + c.usd, 0)) }
  }
  return {
    checks: checks.length,
    usd: usd6(checks.reduce((s, c) => s + c.usd, 0)),
    wallets: sortedUnique(checks.map((c) => c.payer)),
    activeDays: sortedUnique(checks.map((c) => utcDay(c.ts)).filter((d): d is string => d !== null)),
    byRail: { gateway: rail('gateway'), facilitator: rail('facilitator') },
  }
}

function byWallet(checks: Check[], teamOf: Map<string, string>): ArcSeasonWallet[] {
  const groups = new Map<string, Check[]>()
  for (const c of checks) {
    const g = groups.get(c.payer) ?? []
    g.push(c)
    groups.set(c.payer, g)
  }
  const rows: ArcSeasonWallet[] = []
  for (const [wallet, own] of groups) {
    // Ordered in time, not as strings: a timestamp with a zone offset sorts wrongly as text.
    const times = own
      .map((c) => c.ts)
      .filter((t) => Number.isFinite(Date.parse(t)))
      .sort((x, y) => Date.parse(x) - Date.parse(y))
    const team = teamOf.get(wallet)
    rows.push({
      wallet,
      ...(team ? { team } : {}),
      checks: own.length,
      usd: usd6(own.reduce((s, c) => s + c.usd, 0)),
      firstTs: times[0] ?? own[0].ts,
      lastTs: times[times.length - 1] ?? own[own.length - 1].ts,
      activeDays: sortedUnique(own.map((c) => utcDay(c.ts)).filter((d): d is string => d !== null)),
    })
  }
  // Most checks first; ties by who paid first, so the order is stable between reads.
  return rows.sort((a, b) => b.checks - a.checks || a.firstTs.localeCompare(b.firstTs) || a.wallet.localeCompare(b.wallet))
}

/** The launch-day vault, named from the provenance ledger so its address is not restated. */
function launchDayVault(): string | null {
  const arc = PROVENANCE.find((p) => p.chain === ARC_SEASON_CHAIN)
  const vault = arc?.contracts.find((c) => c.name.startsWith('AgentSpendPolicy'))
  return vault?.address ?? null
}

async function readLog<T>(load: () => Promise<T[]>): Promise<{ rows: T[]; read: ArcSeasonLogRead }> {
  try {
    const rows = await load()
    return { rows, read: { readable: true, rows: rows.length } }
  } catch (e) {
    return { rows: [], read: { readable: false, rows: 0, reason: e instanceof Error ? e.message : String(e) } }
  }
}

/** A season can hold dozens of recorded DENYs. The report lists a few here and counts them all. */
const REFUSAL_ITEMS_SHOWN = 5

export async function arcSeasonReport(deps: ArcSeasonDeps): Promise<ArcSeasonReport> {
  const chain = arcMainnet()
  const now = deps.now ?? Date.now
  const partners = deps.partners ?? ARC_PARTNERS
  const vaults = deps.vaults ?? ARC_OWNER_HELD_VAULTS
  const refusals = deps.refusals ?? ARC_REFUSALS

  const gateway = await readLog(deps.gatewayRows)
  const facilitator = await readLog(deps.facilitatorRows)
  const skippedRows: ArcSeasonSkippedRow[] = []
  const loadFlowRows = deps.flowRows
  const recordedFlows = loadFlowRows ? await readLog(() => loadFlowRows((row) => skippedRows.push(row))) : null
  const flows = mergeFlows(deps.flows ?? ARC_VERIFY_THEN_PAY_FLOWS, recordedFlows?.rows ?? [])

  const checks: Check[] = [
    ...gateway.rows
      .filter((r) => GATEWAY_SETTLED.has(r.outcome) && r.network === chain.caip2)
      .map((r): Check => ({ rail: 'gateway', payer: r.payer.toLowerCase(), usd: r.amountUsd, ts: r.ts, nonce: r.authNonce })),
    ...facilitator.rows
      .filter((r) => r.outcome === 'settled' && r.network === chain.caip2)
      .map((r): Check => ({ rail: 'facilitator', payer: r.payer.toLowerCase(), usd: r.amountUsd, ts: r.ts, nonce: r.authNonce })),
  ]
  const mine = new Set([...deps.internalPayers.gateway, ...deps.internalPayers.facilitator].map((a) => a.toLowerCase()))
  const internalChecks = checks.filter((c) => mine.has(c.payer))
  const externalChecks = checks.filter((c) => !mine.has(c.payer))

  const teamOf = new Map(partners.map((p) => [p.wallet.toLowerCase(), p.team]))
  const external = byWallet(externalChecks, teamOf)
  const walletStats = new Map(external.map((w) => [w.wallet, w]))

  // Partners, each with what its wallet actually paid. A team can pay from more than one
  // wallet, so team-level metrics count distinct team names.
  const teams: ArcSeasonTeam[] = partners.flatMap((p) => {
    const stats = walletStats.get(p.wallet.toLowerCase())
    return stats ? [{ ...stats, team: p.team, publicReference: p.publicReference }] : []
  })
  const liveTeams = sortedUnique(teams.map((t) => t.team))
  const severalDays = sortedUnique(teams.filter((t) => t.activeDays.length >= 2).map((t) => t.team))
  const publicNames = sortedUnique(teams.filter((t) => t.publicReference).map((t) => t.team))
  const unattributed = external.filter((w) => !w.team)

  const gatewayChecks = checks.filter((c) => c.rail === 'gateway')
  const ownGateway = gatewayChecks.filter((c) => mine.has(c.payer))
  const gatewayInternal = ownGateway.length
  const gatewayExternal = gatewayChecks.length - gatewayInternal

  // A flow counts once per check and once per payment transaction, only on one of our own
  // settled Gateway checks, only when it names the payee and its outcome did not come before
  // the check, and only with something a reviewer can open. A flow that names its payer links only to that payer's
  // check, because a nonce is unique per payer and not across payers. An external check is
  // left to Milestone 2.
  const ownByNonce = new Map(ownGateway.map((c) => [c.nonce.toLowerCase(), c]))
  // The Gateway log keeps its newest rows only. A check older than the oldest row of a full
  // log lost its row to that trim, so a recorded flow for it links by the settlement its own
  // record holds. Anything newer has its row in the log, or never had one, and links by the
  // log alone; an unreadable log links nothing either way.
  const cap = deps.gatewayCap ?? GATEWAY_SETTLEMENTS_CAP
  const retainedTimes = gateway.rows.map((r) => Date.parse(r.ts)).filter((t) => Number.isFinite(t))
  const retainedFrom = gateway.read.readable && gateway.rows.length >= cap && retainedTimes.length ? Math.min(...retainedTimes) : null
  const agedOutCheck = (f: ArcVerifyThenPayFlow): Check | null => {
    const e = f.check
    if (!e || retainedFrom === null) return null
    if (e.network !== chain.caip2 || !GATEWAY_SETTLED.has(e.outcome as GatewaySettlementRecord['outcome']) || !mine.has(e.payer.toLowerCase())) return null
    const t = Date.parse(e.ts)
    if (!Number.isFinite(t) || t >= retainedFrom) return null
    return { rail: 'gateway', payer: e.payer.toLowerCase(), usd: 0, ts: e.ts, nonce: f.checkNonce.toLowerCase() }
  }
  const linkedFlows = new Map<string, ArcVerifyThenPayFlow>()
  const linkedTxs = new Set<string>()
  let agedOut = 0
  for (const f of flows) {
    const nonce = f.checkNonce.toLowerCase()
    const inLog = ownByNonce.get(nonce)
    const check = inLog ?? agedOutCheck(f)
    if (!check || linkedFlows.has(nonce) || !ADDRESS.test(f.payee) || flowEvidence(f) === null) continue
    if (f.payer !== undefined && f.payer.toLowerCase() !== check.payer) continue
    const tx = f.txHash?.toLowerCase()
    if (tx && linkedTxs.has(tx)) continue
    const outcomeAt = Date.parse(f.at)
    const checkedAt = Date.parse(check.ts)
    if (Number.isFinite(outcomeAt) && Number.isFinite(checkedAt) && outcomeAt >= checkedAt) {
      linkedFlows.set(nonce, f)
      if (tx) linkedTxs.add(tx)
      if (!inLog) agedOut += 1
    }
  }
  const linked: Record<ArcFlowOutcome, number> = { paid: 0, refused: 0 }
  for (const f of linkedFlows.values()) linked[f.outcome] += 1
  const linkedInLog = linkedFlows.size - agedOut

  const windowMs = ARC_SEASON_TARGETS.activeWindowDays * 24 * 60 * 60 * 1000
  const since = new Date(now() - windowMs).toISOString()
  const activeWallets = sortedUnique(
    externalChecks.filter((c) => Number.isFinite(Date.parse(c.ts)) && Date.parse(c.ts) >= Date.parse(since)).map((c) => c.payer),
  )

  // A payee that is ours, or the vault's own key: the flow is real and counts, and a reviewer
  // should not have to work out from addresses that nobody else was going to be paid.
  const ourAddresses = new Set([...mine, ...(deps.ourPayTo ?? []).map((a) => a.toLowerCase())])
  const payeeInternal = (f: ArcVerifyThenPayFlow): string | null => {
    const payee = f.payee.toLowerCase()
    if (payee === f.vaultKeys?.owner.toLowerCase()) return "the payee is this vault's owner"
    if (payee === f.vaultKeys?.operator.toLowerCase()) return "the payee is this vault's operator"
    return ourAddresses.has(payee) ? 'the payee is one of our own wallets' : null
  }
  const linkedList = [...linkedFlows.values()]
  const internalPayeeFlows = linkedList.filter((f) => payeeInternal(f) !== null).length
  const refusedPayees = new Set(linkedList.filter((f) => f.outcome === 'refused').map((f) => f.payee.toLowerCase())).size

  // A recorded DENY is an inspectable refusal: it has a public record, and it is what the metric
  // asks for. Filling this by hand-committed entry left it unmet while the flows sat in checks.
  const curatedEvidence = new Set(refusals.map((r) => r.evidenceUrl).filter(Boolean))
  const recordedDenials: ArcRefusal[] = linkedList.flatMap((f) => {
    if (f.outcome !== 'refused' || f.txHash || !f.evidenceUrl || curatedEvidence.has(f.evidenceUrl)) return []
    const why = payeeInternal(f)
    return [{ kind: 'deny-before-signing' as const, evidenceUrl: f.evidenceUrl, at: f.at, note: f.note, ...(why ? { payeeInternal: why } : {}) }]
  })
  const allRefusals = [...refusals, ...recordedDenials]
  const byKind: Record<ArcRefusalKind, number> = { 'vault-policy-on-chain': 0, 'deny-before-signing': 0 }
  for (const r of allRefusals) byKind[r.kind] += 1
  const launchVault = launchDayVault()

  return {
    asOf: new Date(now()).toISOString(),
    chain: ARC_SEASON_CHAIN,
    network: chain.caip2,
    program: ARC_SEASON_PROGRAM,
    logs: { gateway: gateway.read, facilitator: facilitator.read, ...(recordedFlows ? { flows: { ...recordedFlows.read, ...(skippedRows.length ? { skipped: skippedRows } : {}) } } : {}) },
    usage: {
      basis:
        'A payer is internal when its address is on either rail\'s published list of our own buyer wallets (the hardcoded KNOWN_INTERNAL_PAYERS plus X402_GATEWAY_INTERNAL_PAYERS and X402_3009_INTERNAL_PAYERS), compared case-insensitively; every other payer is external, and a check is a Circle Gateway row credited or completed, or a facilitator row settled, on Arc Mainnet.',
      internal: side(internalChecks),
      external: { ...side(externalChecks), byWallet: external },
    },
    milestone1: {
      title: 'Owner-held spend vaults and verify-then-pay on Arc Mainnet',
      due: ARC_SEASON_PROGRAM.milestone1Due,
      vaults: {
        count: vaults.length,
        target: ARC_SEASON_TARGETS.ownerHeldVaults,
        items: vaults.map((v) => ({ ...v, explorerUrl: addressUrl(chain, v.address), deployExplorerUrl: txUrl(chain, v.deployTx) })),
        note:
          vaults.length === 0
            ? `No owner-held vault yet. The launch-day vault${launchVault ? ` ${launchVault}` : ''} was deployed from our server key with our operating wallet as its owner, so it is not owner-held and is not counted. This count fills from vaults deployed in the browser at /app/vault/arc whose owner key A-Identity never holds, each listed with its deploy hash.`
            : `${vaults.length} of ${ARC_SEASON_TARGETS.ownerHeldVaults} vaults deployed from the browser with an owner key A-Identity never held. The launch-day vault${launchVault ? ` ${launchVault}` : ''} is owned by our operating wallet and is not among them.`,
      },
      checks: {
        count: linkedFlows.size,
        target: ARC_SEASON_TARGETS.gatewayChecks,
        internal: gatewayInternal,
        external: gatewayExternal,
        linked,
        unlinked: gatewayInternal - linkedInLog,
        agedOut,
        internalPayee: internalPayeeFlows,
        refusedPayees,
        items: linkedList.map((f) => {
          const why = payeeInternal(f)
          return {
            ...f,
            explorerUrl: f.txHash && TX_HASH.test(f.txHash) ? txUrl(chain, f.txHash) : null,
            ...(why ? { payeeInternal: why } : {}),
          }
        }),
        rail: 'circle-gateway',
        note:
          (!gateway.read.readable
            ? `The Circle Gateway settlement log could not be read on this request (${gateway.read.reason ?? 'no reason given'}), so no check, and no flow linked to one, is counted until it answers. `
            : '') +
          (recordedFlows && !recordedFlows.read.readable
            ? `The verify-then-pay flow log could not be read on this request (${recordedFlows.read.reason ?? 'no reason given'}), so any flow it holds is missing from this count until it answers. `
            : '') +
          (skippedRows.length ? `${skippedRows.length} verify-then-pay flow row(s) could not be read and are not counted; logs.flows names them. ` : '') +
          (linkedFlows.size === 0
            ? `No verify-then-pay flow yet. A check counts here only when it opened one: a Circle Gateway check on Arc Mainnet paid from our own wallets and followed by a vault payment or an inspectable refusal, linked by the nonce its settlement row is keyed by. ${gatewayInternal} internal Gateway check(s) have settled and none is linked to a vault payment or a refusal yet, so none counts. The ${gatewayExternal} external Gateway check(s) count under Milestone 2, not here, so no check counts twice. EIP-3009 facilitator settlements are reported under usage.`
            : `${linkedFlows.size} of ${ARC_SEASON_TARGETS.gatewayChecks} verify-then-pay flows on Arc Mainnet: a Circle Gateway check paid from our own wallets and followed by ${linked.paid} vault payment(s) and ${linked.refused} refusal(s), each linked by the check's settlement nonce. ${gatewayInternal - linkedInLog} internal check(s) have nothing linked and are not counted. The ${gatewayExternal} external Gateway check(s) count under Milestone 2, not here, so no check counts twice.` +
              (agedOut > 0
                ? ` ${agedOut} of the flows link by the settlement their own flow record holds: the Gateway log keeps its newest ${cap} rows, and their check is older than the oldest row it still has.`
                : '') +
              (internalPayeeFlows > 0
                ? ` ${internalPayeeFlows} of the flows name a payee that is our own wallet or the vault's own key: planned probes, labeled payeeInternal on each item, not payments to anyone else. The refused flows name ${refusedPayees} distinct payee(s).`
                : '')),
      },
      refusals: {
        count: allRefusals.length,
        target: ARC_SEASON_TARGETS.inspectableRefusals,
        // The curated entries and the first few recorded ones: every recorded one is on checks.items.
        items: [...refusals, ...recordedDenials.slice(0, REFUSAL_ITEMS_SHOWN)].map((r) => ({ ...r, explorerUrl: r.txHash ? txUrl(chain, r.txHash) : null })),
        byKind,
        note:
          allRefusals.length === 0
            ? 'No inspectable refusal yet. The launch-day refusal (a 0.50 USDC payment above autoApproveMax) was a simulation that returned the contract\'s typed AboveAutoApprove error and broadcast nothing, so it has no hash and is not counted. A refusal counts once it is a reverted vault transaction with a hash, or a DENY verdict that stopped a payment before signing with an audit entry anyone can open.'
            : `${allRefusals.length} of ${ARC_SEASON_TARGETS.inspectableRefusals}: ${byKind['vault-policy-on-chain']} vault-policy refusal(s) on chain and ${byKind['deny-before-signing']} DENY result(s) stopped before signing, read from the public flow records. The launch-day simulated refusal is not among them.` +
              (recordedDenials.length > REFUSAL_ITEMS_SHOWN ? ` ${recordedDenials.length - REFUSAL_ITEMS_SHOWN} more DENY record(s) are on checks.items.` : ''),
      },
      evidence: ARC_SEASON_EVIDENCE_URL,
    },
    milestone2: {
      title: 'First external agents verifying and paying on Arc Mainnet',
      due: ARC_SEASON_PROGRAM.milestone2Due,
      externalTeamsLive: {
        count: liveTeams.length,
        target: ARC_SEASON_TARGETS.externalTeamsLive,
        teams,
        note:
          liveTeams.length === 0
            ? 'No external team live yet. A team is listed only after its wallet has paid a check on Arc Mainnet; the wallet is then attributed here by name.'
            : `${liveTeams.length} of ${ARC_SEASON_TARGETS.externalTeamsLive} external teams have paid at least one check on Arc Mainnet from a wallet attributed to them.`,
      },
      externalChecks: {
        count: externalChecks.length,
        target: ARC_SEASON_TARGETS.externalChecks,
        note:
          externalChecks.length === 0
            ? 'No paid check from a wallet outside our own yet. Every check settled so far came from our own buyer wallets, labeled internal above.'
            : `${externalChecks.length} of ${ARC_SEASON_TARGETS.externalChecks} paid checks from wallets A-Identity does not control, on either rail.`,
      },
      teamActiveOnSeveralDays: {
        count: severalDays.length,
        target: ARC_SEASON_TARGETS.teamsActiveOnSeveralDays,
        teams: severalDays,
        note:
          severalDays.length === 0
            ? 'No external team has paid on two or more distinct UTC days yet.'
            : `${severalDays.length} external team(s) paid on two or more distinct UTC days.`,
      },
      publicReference: {
        count: publicNames.length,
        target: ARC_SEASON_TARGETS.publicReferences,
        names: publicNames,
        note:
          publicNames.length === 0
            ? 'No external integration can be named in public yet. A team is counted here only when it has paid and has agreed to be referenced.'
            : `${publicNames.length} external integration(s) that paid and agreed to be referenced in public.`,
      },
      unattributed: {
        wallets: unattributed.length,
        checks: unattributed.reduce((s, w) => s + w.checks, 0),
        note:
          unattributed.length === 0
            ? 'Every external wallet that paid is attributed to a team, or none has paid.'
            : `${unattributed.length} external wallet(s) paid ${unattributed.reduce((s, w) => s + w.checks, 0)} check(s) without being attributed to a team. They count as external checks and as nothing else.`,
      },
    },
    afterProgram: {
      activeExternalWallets: {
        count: activeWallets.length,
        target: ARC_SEASON_TARGETS.activeExternalWallets,
        windowDays: ARC_SEASON_TARGETS.activeWindowDays,
        since,
        wallets: activeWallets,
      },
      note: `After the program the reference is ${ARC_SEASON_TARGETS.activeExternalWallets} external wallets with a settled check inside the last ${ARC_SEASON_TARGETS.activeWindowDays} days, measured on a rolling window from the time of each read.`,
    },
    note: 'Targets are the Deliverable 1 commitments as revised by Circle on 2026-10-19; counts are read from the settlement logs on every request, and the curated lists (vaults, refusals, partners) fill only when the evidence exists.',
  }
}

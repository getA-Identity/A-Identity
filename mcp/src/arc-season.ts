/**
 * Arc Acceleration Season: progress against the success metrics, read from the logs.
 *
 * Circle judges Deliverable 2 (due 2026-10-30) on progress against each success metric
 * with current numbers, links to on-chain evidence and usage so far, with external
 * activity counted separately from our own. This module is that report, and it is
 * computed rather than written: every count comes from the two settlement logs on every
 * request, and the three lists a human has to curate (owner-held vaults, inspectable
 * refusals, partner wallets) are exported here as data, empty until the evidence exists.
 *
 * What counts, stated once:
 *   - A check is a settled row on Arc Mainnet. On the Gateway log that is an outcome of
 *     'credited' or 'completed' (Circle holds the money, or the batch has landed); on the
 *     facilitator log it is 'settled' (a receipt with a matching Transfer log). Milestone 1
 *     names Circle Gateway nanopayments, so its check count is the Gateway count alone;
 *     the facilitator rows are reported under usage, labeled as such.
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
  loadGatewaySettlements,
  loadX402SettlementsResult,
  type GatewaySettlementRecord,
  type X402SettlementRecord,
} from './storage.js'
import { internalPayers as gatewayInternalPayers } from './x402-gateway/rail.js'
import { internalPayers as facilitatorInternalPayers } from './x402-3009/rail.js'

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

export type ArcOwnerHeldVault = {
  /** The AgentSpendPolicy contract. */
  address: string
  /** The owner key. It is the user's; we never held it, which is the whole metric. */
  owner: string
  deployTx: string
  /** UTC day of the deployment. */
  deployedAt: string
  note: string
}

/**
 * Owner-held AgentSpendPolicy vaults on Arc Mainnet, deployed from the browser with a
 * key A-Identity never holds. Filled by the browser vault deployer (planned at
 * /app/vault/arc) as each deployment lands; a vault is listed only with its deploy hash.
 * Empty on 2026-10-19.
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
}

/**
 * Refusals anyone can inspect. One of each kind is the Milestone 1 commitment: a
 * vault-policy refusal that reverted on chain (so it has a hash), and a DENY verdict
 * that stopped a payment before signing (so it has an audit entry and no hash). Empty on
 * 2026-10-19: the launch-day refusal was a simulation, see the note in the report.
 */
export const ARC_REFUSALS: ArcRefusal[] = []

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

export type ArcSeasonLogRead = { readable: boolean; rows: number; reason?: string }

export type ArcSeasonVaultItem = ArcOwnerHeldVault & { explorerUrl: string; deployExplorerUrl: string }
export type ArcSeasonRefusalItem = ArcRefusal & { explorerUrl: string | null }
export type ArcSeasonTeam = ArcSeasonWallet & { team: string; publicReference: boolean }

export type ArcSeasonReport = {
  asOf: string
  chain: string
  /** CAIP-2 id of Arc Mainnet, from the registry. */
  network: string
  program: typeof ARC_SEASON_PROGRAM
  /** Whether each log could be read. A log that could not be read contributes nothing,
   *  and says so here rather than reading as zero demand. */
  logs: { gateway: ArcSeasonLogRead; facilitator: ArcSeasonLogRead }
  usage: {
    basis: string
    internal: ArcSeasonUsageSide
    external: ArcSeasonUsageSide & { byWallet: ArcSeasonWallet[] }
  }
  milestone1: {
    title: string
    due: string
    vaults: { count: number; target: number; items: ArcSeasonVaultItem[]; note: string }
    checks: { count: number; target: number; internal: number; external: number; rail: string; note: string }
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
  gatewayRows: () => Promise<GatewaySettlementRecord[]>
  /** May throw: an unreadable facilitator log is reported as unreadable, not as empty. */
  facilitatorRows: () => Promise<X402SettlementRecord[]>
  /** Our own buyer wallets, as each rail publishes them. Any case. */
  internalPayers: { gateway: string[]; facilitator: string[] }
  now?: () => number
  partners?: ArcPartner[]
  vaults?: ArcOwnerHeldVault[]
  refusals?: ArcRefusal[]
}

/** The real loaders and the rails' own internal-payer lists. The route adds nothing else. */
export function liveArcSeasonDeps(env: NodeJS.ProcessEnv = process.env): ArcSeasonDeps {
  return {
    gatewayRows: loadGatewaySettlements,
    facilitatorRows: async () => {
      const read = await loadX402SettlementsResult()
      if (!read.ok) throw new Error(read.reason)
      return read.rows
    },
    internalPayers: { gateway: gatewayInternalPayers(env), facilitator: facilitatorInternalPayers(env) },
  }
}

const GATEWAY_SETTLED = new Set<GatewaySettlementRecord['outcome']>(['credited', 'completed'])

type Check = { rail: 'gateway' | 'facilitator'; payer: string; usd: number; ts: string }

const usd6 = (n: number) => Number(n.toFixed(6))

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

export async function arcSeasonReport(deps: ArcSeasonDeps): Promise<ArcSeasonReport> {
  const chain = arcMainnet()
  const now = deps.now ?? Date.now
  const partners = deps.partners ?? ARC_PARTNERS
  const vaults = deps.vaults ?? ARC_OWNER_HELD_VAULTS
  const refusals = deps.refusals ?? ARC_REFUSALS

  const gateway = await readLog(deps.gatewayRows)
  const facilitator = await readLog(deps.facilitatorRows)

  const checks: Check[] = [
    ...gateway.rows
      .filter((r) => GATEWAY_SETTLED.has(r.outcome) && r.network === chain.caip2)
      .map((r): Check => ({ rail: 'gateway', payer: r.payer.toLowerCase(), usd: r.amountUsd, ts: r.ts })),
    ...facilitator.rows
      .filter((r) => r.outcome === 'settled' && r.network === chain.caip2)
      .map((r): Check => ({ rail: 'facilitator', payer: r.payer.toLowerCase(), usd: r.amountUsd, ts: r.ts })),
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
  const gatewayInternal = gatewayChecks.filter((c) => mine.has(c.payer)).length

  const windowMs = ARC_SEASON_TARGETS.activeWindowDays * 24 * 60 * 60 * 1000
  const since = new Date(now() - windowMs).toISOString()
  const activeWallets = sortedUnique(
    externalChecks.filter((c) => Number.isFinite(Date.parse(c.ts)) && Date.parse(c.ts) >= Date.parse(since)).map((c) => c.payer),
  )

  const byKind: Record<ArcRefusalKind, number> = { 'vault-policy-on-chain': 0, 'deny-before-signing': 0 }
  for (const r of refusals) byKind[r.kind] += 1
  const launchVault = launchDayVault()

  return {
    asOf: new Date(now()).toISOString(),
    chain: ARC_SEASON_CHAIN,
    network: chain.caip2,
    program: ARC_SEASON_PROGRAM,
    logs: { gateway: gateway.read, facilitator: facilitator.read },
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
            ? `No owner-held vault yet. The launch-day vault${launchVault ? ` ${launchVault}` : ''} was deployed from our server key with our operating wallet as its owner, so it is not owner-held and is not counted. This count fills from vaults deployed in the browser (planned at /app/vault/arc) whose owner key A-Identity never holds, each listed with its deploy hash.`
            : `${vaults.length} of ${ARC_SEASON_TARGETS.ownerHeldVaults} vaults deployed from the browser with an owner key A-Identity never held. The launch-day vault${launchVault ? ` ${launchVault}` : ''} is owned by our operating wallet and is not among them.`,
      },
      checks: {
        count: gatewayChecks.length,
        target: ARC_SEASON_TARGETS.gatewayChecks,
        internal: gatewayInternal,
        external: gatewayChecks.length - gatewayInternal,
        rail: 'circle-gateway',
        note: `${gatewayChecks.length} of ${ARC_SEASON_TARGETS.gatewayChecks} verify-then-pay checks settled through Circle Gateway nanopayments on Arc Mainnet, ${gatewayInternal} from our own wallets and ${gatewayChecks.length - gatewayInternal} external. Each is a trust tool call paid before it was served. EIP-3009 facilitator settlements are reported under usage and not counted here, because the metric names Gateway.`,
      },
      refusals: {
        count: refusals.length,
        target: ARC_SEASON_TARGETS.inspectableRefusals,
        items: refusals.map((r) => ({ ...r, explorerUrl: r.txHash ? txUrl(chain, r.txHash) : null })),
        byKind,
        note:
          refusals.length === 0
            ? 'No inspectable refusal yet. The launch-day refusal (a 0.50 USDC payment above autoApproveMax) was a simulation that returned the contract\'s typed AboveAutoApprove error and broadcast nothing, so it has no hash and is not counted. A refusal counts once it is a reverted vault transaction with a hash, or a DENY verdict that stopped a payment before signing with an audit entry anyone can open.'
            : `${refusals.length} of ${ARC_SEASON_TARGETS.inspectableRefusals}: ${byKind['vault-policy-on-chain']} vault-policy refusal(s) on chain and ${byKind['deny-before-signing']} DENY result(s) stopped before signing. The launch-day simulated refusal is not among them.`,
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
    note: 'Targets are the Deliverable 1 commitments as revised by Circle on 2026-10-19; counts are read from the settlement logs on every request, and the curated lists (vaults, refusals, partners) are empty until the evidence exists.',
  }
}

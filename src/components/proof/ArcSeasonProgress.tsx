/**
 * The Arc Acceleration Season block on /proof/arc.
 *
 * Circle judges Deliverable 2 on progress against each success metric with current
 * numbers, links to on-chain evidence and usage so far, with external activity counted
 * apart from our own. Everything here arrives from GET /api/arc/season, which the backend
 * counts from the two settlement logs on every request (mcp/src/arc-season.ts). Nothing is
 * copied into the frontend, so there is no second number to go stale.
 *
 * The cost of that is stated rather than hidden: the prerendered snapshot cannot reach the
 * backend, so the snapshot and a cold backend both say that the numbers load live and where
 * from, instead of an invented row or a claim about the backend that is not true when it is read.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { short } from '../../lib/format'
import { Skeleton } from '../ui/skeleton'

// incomplete: a log this number reads could not be read, so the count is a lower limit.
// mayIncludeTeamKeys: the flow log could not be read, so the agent key of a vault labeled team, or of the launch-day vault, could be in it: an upper limit.
type Metric = { count: number; target: number; note?: string; incomplete?: boolean; mayIncludeTeamKeys?: boolean }
type RailTotals = { checks: number; usd: number }
type UsageSide = {
  checks: number
  usd: number
  wallets: string[]
  activeDays: string[]
  byRail: { gateway: RailTotals; facilitator: RailTotals }
}
type WalletRow = {
  wallet: string
  team?: string
  // Whether anyone has said whose it is, and which other paying wallets are tied to it. A backend from before these sends neither.
  identity?: 'team' | 'not-team' | 'not-identified'
  linkedWith?: string[]
  checks: number
  usd: number
  firstTs: string
  lastTs: string
  activeDays: string[]
}
type VaultItem = {
  address: string
  owner: string
  // A backend from before the label sends no such field, and the line then names no kind.
  ownerKind?: 'team' | 'external' | 'unstated'
  deployTx: string
  deployedAt: string
  note: string
  explorerUrl: string
  deployExplorerUrl: string
  // What the owner's wallet signed. A backend from before these sends none of the three.
  freezeTxs?: ActionTx[]
  withdrawTxs?: ActionTx[]
  actionsRead?: { state: 'complete' | 'reading' | 'unreadable'; scannedToBlock: string | null; reason?: string }
}
type ActionTx = { txHash: string; block: string; explorerUrl: string }
type LinkEvidence = { txHash?: string; url?: string; what: string; explorerUrl: string | null }
/** Who stands behind the vault count. A backend from before it sends none, and the line does not appear. */
type VaultOwners = {
  distinct: number
  // null when a list or log behind it could not be read: then it is no ceiling.
  parties: number | null
  summary: string
  linked: { owners: string[]; vaults: string[]; tracedOn: string; confidence: string; note: string; evidence: LinkEvidence[] }[]
  alsoPaid: { vaults: string[]; wallets: string[]; checks: number; note: string }[]
}
/** Who stands behind the external checks. A backend from before it sends none, and the line does not appear. */
type Payers = {
  wallets: number
  parties: number | null
  summary: string
  linked: { wallets: string[]; checks: number; team?: string; tracedOn: string; confidence: string; note: string; evidence: LinkEvidence[] }[]
}
type LinkGroup = { wallets: string[]; tracedOn: string; confidence: string; note: string; evidence: LinkEvidence[] }
type OurSideLink = { kind: 'ours' | 'disclosed' | 'none-found'; note: string; evidence: LinkEvidence[] }
/** The hand trace behind the links. A backend from before it sends none, and the section does not appear. */
type LinkedWallets = { tracedOn: string; reads: string; groups: LinkGroup[]; ourSide: OurSideLink[]; limits: string[] }
type RefusalItem = {
  kind: string
  txHash?: string
  evidenceUrl?: string
  at: string
  note: string
  explorerUrl: string | null
  /** Why the payee is one of our own wallets, when it is. */
  payeeInternal?: string
}
type FlowItem = {
  checkNonce: string
  payee: string
  outcome: 'paid' | 'refused'
  txHash?: string
  evidenceUrl?: string
  at: string
  explorerUrl: string | null
  payeeInternal?: string
  /** On an external flow: the payee is tied to the wallet that paid for the check. */
  payeeTiedToPayer?: boolean
  // A backend from before these sends none of them, and the row then shows what it has.
  recordUrl?: string
  vaultKind?: 'launch-day' | 'owner-held' | 'other' | 'not-recorded'
  checkSettlement?: { outcome: string; readFrom: 'gateway-log' | 'flow-record'; batchTx?: string; batchExplorerUrl?: string }
}
type LogRead = { readable: boolean; rows: number; reason?: string; skipped?: { flowId: string | null; reason: string }[] }
type WeekRow = {
  weekStart: string
  weekEnd: string
  inProgress: boolean
  checks: number
  activeWallets: string[]
  activeDays: string[]
  returningWallets: string[]
}

type SeasonReport = {
  asOf: string
  network: string
  program: { name: string; deliverable2Due: string; milestone1Due: string; milestone2Due: string }
  // flows is the verify-then-pay flow log; a backend from before it sends no such field.
  logs: { gateway: LogRead; facilitator: LogRead; flows?: LogRead }
  // A backend from before the trace sends no such field.
  linkedWallets?: LinkedWallets
  usage: { basis: string; internal: UsageSide; external: UsageSide & { byWallet: WalletRow[]; mayIncludeTeamKeys?: boolean } }
  milestone1: {
    title: string
    due: string
    vaults: Metric & { items: VaultItem[]; ownerActions?: { freezes: number; withdrawals: number; vaultsNotFullyRead: number }; owners?: VaultOwners }
    // linked and unlinked arrive with the flow count; a backend from before it sends neither,
    // and its count is every Gateway check, so the row is labeled by which one answered.
    // unlinked is null when a log it needs could not be read, because then nobody can say.
    checks: Metric & { internal: number; external: number; linked?: { paid: number; refused: number }; unlinked?: number | null; internalPayee?: number; refusedPayees?: number; items?: FlowItem[] }
    // byKind arrives with the count by kind. From a backend before it, count is the list's length.
    refusals: Metric & { items: RefusalItem[]; byKind?: Record<string, number> }
    evidence: string
  }
  milestone2: {
    title: string
    due: string
    externalTeamsLive: Metric
    externalChecks: Metric & { payers?: Payers }
    teamActiveOnSeveralDays: Metric
    publicReference: Metric
    unattributed: { wallets: number; checks: number; note: string }
    // A backend from before it sends no such field, and the card lists none.
    externalFlows?: { count: number; items: FlowItem[]; note: string }
  }
  afterProgram: {
    activeExternalWallets: Metric & { windowDays: number; parties?: number | null; linkedSummary?: string }
    // A backend from before it sends no such field, and the table does not appear.
    weekly?: { incomplete?: boolean; weeks: WeekRow[]; repeatWallets: string[]; repeatTeams: string[]; note: string }
    note: string
  }
  note: string
}

type LoadState = 'loading' | 'unreachable' | 'missing' | 'ready'

const SEASON_PATH = '/api/arc/season'
const SEASON_URL = `https://a-identity.xyz${SEASON_PATH}`
const REFRESH_MS = 60_000

const usd = (n: number) => `$${n}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What a count reads as when a log behind it could not be read: never a plain number it cannot stand behind. */
const countLabel = (m: Metric) => {
  if (m.incomplete && m.mayIncludeTeamKeys) return `about ${m.count}`
  if (m.incomplete) return m.count === 0 ? 'not readable' : `at least ${m.count}`
  return m.mayIncludeTeamKeys ? `at most ${m.count}` : String(m.count)
}

/** One metric: label, count over target, a thin bar, then the sentence a reader needs first (lead), then the reason while the count is 0 or cannot be trusted (with keepNote, always). */
function MetricRow({ label, metric, lead, detail, keepNote }: { label: string; metric: Metric; lead?: string; detail?: string; keepNote?: boolean }) {
  const pct = metric.target > 0 ? Math.min(100, Math.round((metric.count / metric.target) * 100)) : 0
  const met = metric.count >= metric.target && !metric.mayIncludeTeamKeys
  return (
    <div className="border-b border-border/60 py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-x-4">
        <span className="text-xs text-foreground/75">{label}</span>
        <span className={`shrink-0 font-mono text-xs tabular-nums ${met ? 'text-ok' : 'text-foreground/85'}`}>
          {countLabel(metric)} / {metric.target}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={metric.target}
        aria-valuenow={Math.min(metric.count, metric.target)}
      >
        <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      {lead && <p className="mt-1.5 text-[11px] font-semibold leading-relaxed text-foreground/80">{lead}</p>}
      {detail && <p className="mt-1.5 font-mono text-[11px] text-foreground/50">{detail}</p>}
      {(metric.count === 0 || metric.incomplete || keepNote) && metric.note && (
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/50">{metric.note}</p>
      )}
    </div>
  )
}

function MilestoneCard({ id, title, due, children }: { id: number; title: string; due: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-background p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">
          <span className="font-mono text-foreground/50">M{id}</span> {title}
        </h3>
        <span className="font-mono text-[11px] text-foreground/50">target {due}</span>
      </div>
      <div className="mt-2">{children}</div>
    </div>
  )
}

/** The sum over the vaults, beside the count. A backend from before it sends none, and the row then adds nothing. While a vault is still being read it is a lower limit, and says so. */
function ownerActionsLine(a?: { freezes: number; withdrawals: number; vaultsNotFullyRead?: number }): string | undefined {
  return a ? `${plural(a.freezes, 'freeze', 'freezes')} and ${plural(a.withdrawals, 'withdrawal', 'withdrawals')} signed by an owner wallet${a.vaultsNotFullyRead ? ' so far' : ''}` : undefined
}

/** One kind of owner action on one vault: its hashes, or that none was found, said only when the whole chain was read. */
function OwnerActionLine({ label, none, txs, complete }: { label: string; none: string; txs: ActionTx[]; complete: boolean }) {
  if (txs.length === 0) return complete ? <div>{none}</div> : null
  return (
    <div>
      {label}:{' '}
      {txs.map((t, i) => (
        <span key={t.txHash}>
          {i > 0 && ', '}
          <OutLink href={t.explorerUrl}>{short(t.txHash)}</OutLink>
        </span>
      ))}
    </div>
  )
}

/** What this vault's owner did, in plain words, and how much of the chain that rests on. */
function VaultOwnerActions({ vault }: { vault: VaultItem }) {
  const read = vault.actionsRead
  if (!read) return null
  const complete = read.state === 'complete'
  return (
    <div className="mt-0.5 pl-3 text-foreground/60">
      <OwnerActionLine label="Frozen by the owner's wallet" none="Not frozen by the owner's wallet yet." txs={vault.freezeTxs ?? []} complete={complete} />
      <OwnerActionLine label="USDC taken out by the owner's wallet" none="No USDC taken out by the owner's wallet yet." txs={vault.withdrawTxs ?? []} complete={complete} />
      {read.state === 'reading' && <div>Still reading this vault's history from the chain{read.scannedToBlock ? ` (up to block ${read.scannedToBlock} so far)` : ''}, so there may be more.</div>}
      {read.state === 'unreadable' && <div>Could not read all of this vault's history just now, so there may be more: {read.reason ?? 'no reason given'}.</div>}
    </div>
  )
}

/** A link's note and how strong it is, in the open, and the transactions behind it one click down, each one a reader can open. */
function LinkLine({ tracedOn, confidence, note, evidence }: { tracedOn: string; confidence: string; note: string; evidence: LinkEvidence[] }) {
  return (
    <div className="mt-0.5 pl-3 text-foreground/55">
      <p>
        {note} {confidence} Traced by hand on {tracedOn}, not read live.
      </p>
      <details className="mt-0.5">
        <summary className="cursor-pointer font-semibold text-foreground/65">
          {evidence.length === 1 ? 'The transaction behind this link' : `The ${evidence.length} transactions behind this link`}
        </summary>
        <ul className="mt-1 flex flex-col gap-0.5">
          {evidence.map((e, i) => (
            <li key={e.txHash ?? e.url ?? i}>
              {e.what} {e.explorerUrl ? <OutLink href={e.explorerUrl}>{e.txHash ? short(e.txHash) : 'open'}</OutLink> : null}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** Which owner wallets the chain links, each link with what it rests on. The count of vaults and wallets is the row's own lead, above its note. */
function VaultOwnersLine({ owners }: { owners: VaultOwners }) {
  if (owners.linked.length === 0 && owners.alsoPaid.length === 0) return null
  return (
    <div className="mb-1 mt-1 text-[11px] leading-relaxed text-foreground/65">
      {owners.linked.map((l) => (
        <LinkLine key={l.owners.join(',')} tracedOn={l.tracedOn} confidence={l.confidence} note={l.note} evidence={l.evidence} />
      ))}
      {owners.alsoPaid.map((p) => (
        <p key={p.wallets.join(',')} className="mt-1 pl-3 text-foreground/55">
          {p.note}
        </p>
      ))}
    </div>
  )
}

/** Which paying wallets are linked, so no one wallet reads as one person. The count of wallets and parties is the row's own lead, above its note. */
function PayersLine({ payers }: { payers: Payers }) {
  if (payers.linked.length === 0) return null
  return (
    <div className="mb-1 mt-1 text-[11px] leading-relaxed text-foreground/65">
      {payers.linked.map((l) => (
        <div key={l.wallets.join(',')} className="mt-1">
          <p className="pl-3 font-mono text-foreground/70">
            {l.wallets.map((w) => short(w)).join(' and ')}
            {l.team && <span className="font-sans font-semibold text-foreground/80"> {l.team}</span>}
            <span className="font-sans">, {plural(l.checks, 'check', 'checks')}</span>
          </p>
          <LinkLine tracedOn={l.tracedOn} confidence={l.confidence} note={l.note} evidence={l.evidence} />
        </div>
      ))}
    </div>
  )
}

const OUR_SIDE_LABEL: Record<OurSideLink['kind'], string> = {
  ours: 'Ours, labeled',
  disclosed: 'Disclosed',
  'none-found': 'Looked for and not found',
}

/** What the hand trace found between what is counted and our own side, and everything else it tied together. */
function LinkedWalletsSection({ data }: { data: LinkedWallets }) {
  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-foreground">Linked wallets, and links to our side</h3>
      <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-foreground/55">{data.reads}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {data.ourSide.map((item) => (
          <li key={item.note} className="text-[11px] leading-relaxed text-foreground/70">
            <span className="font-semibold text-foreground/85">{OUR_SIDE_LABEL[item.kind]}:</span> {item.note}{' '}
            {item.evidence.map((e, i) => (
              <span key={e.txHash ?? e.url ?? i}>
                {i > 0 && '; '}
                {e.what} {e.explorerUrl ? <OutLink href={e.explorerUrl}>{e.txHash ? short(e.txHash) : 'open'}</OutLink> : null}
              </span>
            ))}
          </li>
        ))}
      </ul>
      <ul className="mt-3 flex list-disc flex-col gap-1 pl-4">
        {data.limits.map((l) => (
          <li key={l} className="text-[11px] leading-relaxed text-foreground/55">
            {l}
          </li>
        ))}
      </ul>
      {data.groups.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] font-semibold text-foreground/70">
            Every group of wallets the trace tied together, outside the named teams' own wallets ({data.groups.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-3">
            {data.groups.map((g) => (
              <li key={g.wallets.join(',')} className="text-[11px] leading-relaxed text-foreground/65">
                <div className="font-mono text-foreground/70">{g.wallets.map((w) => short(w)).join(', ')}</div>
                <LinkLine tracedOn={g.tracedOn} confidence={g.confidence} note={g.note} evidence={g.evidence} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function OutLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-mono text-[11px] text-accent hover:underline"
    >
      <span className="break-all">{children}</span>
      <ArrowUpRight size={11} className="shrink-0" />
    </a>
  )
}

const FLOW_VAULT_LABEL: Record<NonNullable<FlowItem['vaultKind']>, string> = {
  'launch-day': 'launch-day vault (ours)',
  'owner-held': 'owner-held vault',
  other: 'another vault',
  'not-recorded': 'no vault on record',
}

/** One flow, traceable both ways: the record of the check and verdict, the check's batch, the payment. */
function FlowLine({ f }: { f: FlowItem }) {
  const record = f.recordUrl ?? f.evidenceUrl
  const check = f.checkSettlement
  return (
    <li className="text-[11px] text-foreground/65">
      <span className="font-mono text-foreground/50">{f.at.slice(0, 16).replace('T', ' ')} UTC</span>{' '}
      <span className={`font-semibold ${f.outcome === 'paid' ? 'text-ok' : 'text-foreground/80'}`}>{f.outcome}</span> payee {short(f.payee)}
      {f.payeeInternal ? (
        <span className="font-semibold text-foreground/80"> ({f.payeeInternal})</span>
      ) : (
        f.payeeTiedToPayer && <span className="font-semibold text-foreground/80"> (the payee is tied to the wallet that paid for the check)</span>
      )}
      {f.vaultKind && <span>, {FLOW_VAULT_LABEL[f.vaultKind]}</span>}{' '}
      {record && <OutLink href={record}>flow record</OutLink>}{' '}
      {check?.batchExplorerUrl ? (
        <OutLink href={check.batchExplorerUrl}>Gateway batch</OutLink>
      ) : (
        check && <span className="text-foreground/50">check {check.outcome}{check.outcome === 'credited' ? ', no batch hash read yet' : ''}</span>
      )}{' '}
      {f.explorerUrl && <OutLink href={f.explorerUrl}>transaction</OutLink>}
    </li>
  )
}

/** Every flow the count stands on, closed by default: a reviewer can open any one of the hundred. */
function FlowList({ items, title = 'Every flow, newest first' }: { items: FlowItem[]; title?: string }) {
  const newestFirst = [...items].sort((a, b) => b.at.localeCompare(a.at))
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-[11px] font-semibold text-foreground/70">{title} ({items.length})</summary>
      <ul className="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto pr-1">
        {newestFirst.map((f) => (
          <FlowLine key={f.checkNonce} f={f} />
        ))}
      </ul>
    </details>
  )
}

/** External use per UTC week: small, and it says which wallets came back. */
function WeeklyTable({ weeks }: { weeks: WeekRow[] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-[11px] text-foreground/70">
        <caption className="sr-only">External use per UTC week</caption>
        <thead>
          <tr className="border-b border-border text-foreground/45">
            <th scope="col" className="py-1.5 pr-3 font-medium">Week (UTC)</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">External checks</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Active wallets</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Active days</th>
            <th scope="col" className="py-1.5 font-medium">Came back from an earlier week</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {weeks.map((w) => (
            <tr key={w.weekStart} className="border-b border-border/60 last:border-0">
              <td className="py-1.5 pr-3">
                {w.weekStart} to {w.weekEnd}
                {w.inProgress && <span className="font-sans text-foreground/50"> (so far)</span>}
              </td>
              <td className="py-1.5 pr-3">{w.checks}</td>
              <td className="py-1.5 pr-3">{w.activeWallets.length}</td>
              <td className="py-1.5 pr-3">{w.activeDays.length}</td>
              <td className="py-1.5">{w.returningWallets.length > 0 ? w.returningWallets.map((a) => short(a)).join(', ') : 'none'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function UsageCell({ title, caption, side, parties }: { title: string; caption: string; side: UsageSide; parties?: number | null }) {
  const rows: [string, string][] = [
    ['Checks', `${side.checks} (Gateway ${side.byRail.gateway.checks}, facilitator ${side.byRail.facilitator.checks})`],
    ['USD', usd(side.usd)],
    ['Wallets', typeof parties === 'number' && parties < side.wallets.length ? `${side.wallets.length}, at most ${parties} parties` : String(side.wallets.length)],
    ['Active days', String(side.activeDays.length)],
  ]
  return (
    <div className="bg-background p-4">
      <div className="text-xs font-semibold text-foreground/85">{title}</div>
      <div className="mt-0.5 text-[11px] text-foreground/50">{caption}</div>
      <div className="mt-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-x-3 border-b border-border/60 py-1.5 last:border-0">
            <span className="text-[11px] uppercase tracking-wide text-foreground/45">{k}</span>
            <span className="text-right font-mono text-xs tabular-nums text-foreground/80">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** A timestamp to the minute, so two dates a few hours apart read as what they are. */
const utcMinute = (ts: string) => {
  const t = Date.parse(ts)
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : ts
}

/** The flow row's small print, leaving out whatever a log that could not be read would make false. */
function flowDetail(c: SeasonReport['milestone1']['checks']): string | undefined {
  if (c.incomplete && c.count === 0) return undefined
  const linked = c.linked as { paid: number; refused: number }
  const payees = c.internalPayee
    ? ` (${c.internalPayee} pay or name a payee that is ours: our own wallet, our own agent or the vault's own key; refused flows name ${plural(c.refusedPayees ?? 0, 'distinct payee', 'distinct payees')})`
    : ''
  const rest = c.incomplete ? '' : `; ${c.unlinked ?? 0} internal checks with nothing linked; ${c.external} external checks count under M2`
  return `${linked.paid} paid, ${linked.refused} refused${payees}${rest}`
}

function WalletLine({ w }: { w: WalletRow }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border/60 py-2 last:border-0">
      <span className="font-mono text-xs text-foreground/80" title={w.wallet}>
        {short(w.wallet)}
        {w.team && <span className="ml-2 font-sans font-semibold text-foreground/70"> {w.team}</span>}
        {w.identity === 'not-team' && <span className="ml-2 font-sans text-foreground/55"> not a team wallet, on the founder's word of 2026-11-06</span>}
        {w.identity === 'not-identified' && <span className="ml-2 font-sans text-foreground/55"> not identified</span>}
        {w.linkedWith && w.linkedWith.length > 0 && (
          <span className="ml-2 font-sans text-foreground/55"> linked with {w.linkedWith.map((a) => short(a)).join(', ')}</span>
        )}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-foreground/55">
        {plural(w.checks, 'check', 'checks')}, {usd(w.usd)}, {plural(w.activeDays.length, 'day', 'days')}
        {w.activeDays.length > 1 && `: ${utcMinute(w.firstTs)} to ${utcMinute(w.lastTs)} UTC`}
      </span>
    </li>
  )
}

export default function ArcSeasonProgress() {
  const [report, setReport] = useState<SeasonReport | null>(null)
  const [state, setState] = useState<LoadState>('loading')

  const load = useCallback(() => {
    apiFetch(SEASON_PATH)
      .then(async (res) => {
        if (res.status === 404 || res.status === 501) {
          setState('missing')
          return
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setReport((await res.json()) as SeasonReport)
        setState('ready')
      })
      .catch(() => {
        // A failed refresh keeps the last good report on screen; only a first read fails.
        setState((s) => (s === 'ready' ? s : 'unreachable'))
      })
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => window.clearInterval(id)
  }, [load])

  const m1 = report?.milestone1
  const m2 = report?.milestone2
  const external = report?.usage.external
  const after = report?.afterProgram.activeExternalWallets
  const weekly = report?.afterProgram.weekly
  const skippedFlows = report?.logs.flows?.skipped ?? []
  const settlementsUnreadable = report ? !report.logs.gateway.readable || !report.logs.facilitator.readable : false
  const settlementLogsDown = report ? (['gateway', 'facilitator'] as const).filter((l) => !report.logs[l].readable) : []
  // The flow log is not a settlement log: what it holds is flows, and its being down can make the external numbers too high.
  const flowLogDown = Boolean(report?.logs.flows && !report.logs.flows.readable)

  return (
    <section className="rounded-3xl border border-border bg-card p-6 sm:p-8" aria-labelledby="arc-season">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="arc-season" className="text-lg font-bold tracking-tight text-foreground">
            Arc Acceleration Season
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-foreground/60">
            Progress against the success metrics Circle set on 2026-10-19, read from the settlement logs on every load.
          </p>
        </div>
        <a
          href={SEASON_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 font-mono text-[11px] text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
        >
          GET /api/arc/season <ArrowUpRight size={12} className="shrink-0" />
        </a>
      </div>

      {!report && state === 'loading' && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-2xl border border-border bg-background p-5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-4 h-3 w-full" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-3 h-3 w-5/6" />
            </div>
          ))}
        </div>
      )}

      {!report && state !== 'loading' && (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-background px-5 py-4">
          <p className="text-sm leading-relaxed text-foreground/60">
            {state === 'missing'
              ? 'The backend answered without this endpoint, so it is running an older build. Nothing is shown rather than a copy that could be stale.'
              : 'The numbers in this section load live from GET /api/arc/season, and they have not loaded yet. Nothing here is cached in the page, so until they load this section stays empty rather than showing old numbers.'}
          </p>
          {state === 'unreachable' && (
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
            >
              <RefreshCw size={13} /> Retry now
            </button>
          )}
        </div>
      )}

      {report && m1 && m2 && external && after && (
        <>
          <p className="mt-4 text-xs leading-relaxed text-foreground/50">
            As of {report.asOf}. Deliverable 2 was due {report.program.deliverable2Due}. {report.note}
          </p>

          {settlementLogsDown.length > 0 && (
            <p className="mt-3 rounded-xl bg-warn/10 px-4 py-2.5 text-xs leading-relaxed text-warn">
              The {settlementLogsDown.join(' and ')} log could not be read on this request, so what it holds is missing from every
              number below until it answers.
            </p>
          )}

          {flowLogDown && (
            <p className="mt-3 rounded-xl bg-warn/10 px-4 py-2.5 text-xs leading-relaxed text-warn">
              The verify-then-pay flow log could not be read on this request, so the flows it holds are missing from the flow and
              refusal counts below until it answers.
              {external.mayIncludeTeamKeys && ' The agent key of a vault labeled team, or of the launch-day vault, is known from that log, so it could be counted as external, and the external numbers below could be too high.'}
            </p>
          )}

          {skippedFlows.length > 0 && (
            <p className="mt-3 rounded-xl bg-warn/10 px-4 py-2.5 text-xs leading-relaxed text-warn">
              {`${plural(skippedFlows.length, 'flow record', 'flow records')} could not be read and ${skippedFlows.length === 1 ? 'is' : 'are'} not counted below: `}
              {skippedFlows.map((row) => (row.flowId ? short(row.flowId) : 'a row with no id')).join(', ')}.
            </p>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <MilestoneCard id={1} title={m1.title} due={m1.due}>
              {/* The note names the launch-day vault and why it is not counted, which stays true at any count. */}
              {/* The lead says it first: how many vaults, how many owner wallets and how many of them are linked, without hiding the count. */}
              <MetricRow label="Owner-held vaults deployed by the owner's own wallet" metric={m1.vaults} keepNote lead={m1.vaults.items.length > 0 ? m1.vaults.owners?.summary : undefined} detail={ownerActionsLine(m1.vaults.ownerActions)} />
              {m1.vaults.owners && m1.vaults.items.length > 0 && <VaultOwnersLine owners={m1.vaults.owners} />}
              {m1.checks.linked ? (
                // The note says these are our own runs and through which vault, which stays true at any count.
                <MetricRow label="Verify-then-pay flows through Circle Gateway" metric={m1.checks} keepNote detail={flowDetail(m1.checks)} />
              ) : (
                <MetricRow
                  label="Verify-then-pay checks through Circle Gateway"
                  metric={m1.checks}
                  detail={`${m1.checks.internal} internal, ${m1.checks.external} external`}
                />
              )}
              <MetricRow
                label="Refusals anyone can inspect, one of each kind"
                metric={m1.refusals}
                keepNote
                detail={m1.refusals.byKind && !m1.refusals.incomplete ? `${m1.refusals.byKind['vault-policy-on-chain'] ?? 0} reverted on chain, ${m1.refusals.byKind['deny-before-signing'] ?? 0} DENY stopped before signing` : undefined}
              />
              {m1.vaults.items.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {m1.vaults.items.map((v) => (
                    <li key={v.address} className="text-[11px] text-foreground/65">
                      <OutLink href={v.explorerUrl}>{short(v.address)}</OutLink> owner {short(v.owner)}
                      {(v.ownerKind === 'team' || v.ownerKind === 'external') && <span className="font-semibold text-foreground/80"> ({v.ownerKind})</span>}
                      {v.ownerKind === 'unstated' && <span className="font-semibold text-foreground/80"> (owner not identified)</span>}, deployed{' '}
                      <OutLink href={v.deployExplorerUrl}>{v.deployedAt}</OutLink>
                      {v.note && <div className="mt-0.5 pl-3 text-foreground/50">{v.note}</div>}
                      <VaultOwnerActions vault={v} />
                    </li>
                  ))}
                </ul>
              )}
              {m1.refusals.items.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {/* One of each kind reads as the commitment; the rest are in the flow list below. */}
                  {m1.refusals.items.filter((r, i, all) => all.findIndex((x) => x.kind === r.kind) === i).map((r) => (
                    <li key={`${r.kind}-${r.at}-${r.evidenceUrl ?? r.txHash ?? ''}`} className="text-[11px] text-foreground/65">
                      <span className="font-mono text-foreground/50">{r.kind}</span> {r.note}{' '}
                      {r.payeeInternal && <span className="font-semibold text-foreground/80">Our own probe: {r.payeeInternal}. </span>}
                      {r.explorerUrl ? (
                        <OutLink href={r.explorerUrl}>{short(r.txHash ?? '')}</OutLink>
                      ) : r.evidenceUrl ? (
                        <OutLink href={r.evidenceUrl}>flow record</OutLink>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {m1.checks.items && m1.checks.items.length > 0 && <FlowList items={m1.checks.items} />}
            </MilestoneCard>

            <MilestoneCard id={2} title={m2.title} due={m2.due}>
              {/* Every note stays: each says what its row means, which reads stronger than it is without it. */}
              <MetricRow label="External teams live on Arc Mainnet" metric={m2.externalTeamsLive} keepNote />
              {/* The note says who stands behind the checks and when a paying wallet also owns a vault, so it stays past 0. */}
              <MetricRow label="Paid checks from wallets we do not control" metric={m2.externalChecks} keepNote lead={m2.externalChecks.count > 0 ? m2.externalChecks.payers?.summary : undefined} />
              {m2.externalChecks.payers && m2.externalChecks.count > 0 && <PayersLine payers={m2.externalChecks.payers} />}
              {/* The note states the dates, because two UTC dates can be hours apart. */}
              <MetricRow label="External team active on several days" metric={m2.teamActiveOnSeveralDays} keepNote />
              {/* The note says what the reference is, because a count with nothing to open reads stronger than it is. */}
              <MetricRow label="External integration referenced in public" metric={m2.publicReference} keepNote />
              {m2.externalFlows && (
                <div className="mt-3">
                  <p className="text-[11px] leading-relaxed text-foreground/50">{m2.externalFlows.note}</p>
                  {m2.externalFlows.items.length > 0 && <FlowList items={m2.externalFlows.items} title="External flows, newest first" />}
                </div>
              )}
            </MilestoneCard>
          </div>

          <h3 className="mt-8 text-sm font-semibold text-foreground">Internal vs external</h3>
          <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-foreground/55">{report.usage.basis}</p>
          <div className="mt-3 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
            <UsageCell title="Internal" caption="Our own buyer wallets, labeled, never hidden." side={report.usage.internal} />
            <UsageCell
              title="External"
              caption={external.mayIncludeTeamKeys ? 'Wallets A-Identity does not control, and possibly the agent key of a vault labeled team, or of the launch-day vault, until the flow log answers.' : 'Wallets A-Identity does not control.'}
              side={external}
              parties={m2.externalChecks.incomplete ? undefined : m2.externalChecks.payers?.parties}
            />
          </div>

          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wide text-foreground/45">External wallets</div>
            {external.byWallet.length === 0 ? (
              <p className="mt-1.5 text-xs leading-relaxed text-foreground/55">
                {settlementsUnreadable
                  ? 'None found in the logs that could be read on this request, which says nothing about the one that could not.'
                  : 'No external payment yet: every check settled on Arc Mainnet so far came from our own wallets.'}
              </p>
            ) : (
              <ul className="mt-1.5">
                {external.byWallet.map((w) => (
                  <WalletLine key={w.wallet} w={w} />
                ))}
              </ul>
            )}
            {m2.unattributed.wallets > 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-foreground/50">{m2.unattributed.note}</p>
            )}
          </div>

          {report.linkedWallets && <LinkedWalletsSection data={report.linkedWallets} />}

          <p className="mt-4 text-xs leading-relaxed text-foreground/55">
            After the program: {countLabel(after)} / {after.target} external wallets active in the last {after.windowDays} days.
          </p>
          <p className="mt-1 max-w-[80ch] text-[11px] leading-relaxed text-foreground/50">{report.afterProgram.note}</p>
          {weekly && (
            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-wide text-foreground/45">Weekly usage</div>
              <p className="mt-1 max-w-[80ch] text-[11px] leading-relaxed text-foreground/50">{weekly.note}</p>
              {weekly.weeks.length > 0 && <WeeklyTable weeks={weekly.weeks} />}
            </div>
          )}
        </>
      )}
    </section>
  )
}

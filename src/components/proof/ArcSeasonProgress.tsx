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
 * backend, so the snapshot and a cold backend both show the waiting state below instead of
 * an invented row.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowUpRight, RefreshCw } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { short } from '../../lib/format'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { Skeleton } from '../ui/skeleton'

type Metric = { count: number; target: number; note?: string }
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
  checks: number
  usd: number
  firstTs: string
  lastTs: string
  activeDays: string[]
}
type VaultItem = {
  address: string
  owner: string
  deployTx: string
  deployedAt: string
  note: string
  explorerUrl: string
  deployExplorerUrl: string
}
type RefusalItem = {
  kind: string
  txHash?: string
  evidenceUrl?: string
  at: string
  note: string
  explorerUrl: string | null
}
type LogRead = { readable: boolean; rows: number; reason?: string }

type SeasonReport = {
  asOf: string
  network: string
  program: { name: string; deliverable2Due: string; milestone1Due: string; milestone2Due: string }
  // flows is the verify-then-pay flow log; a backend from before it sends no such field.
  logs: { gateway: LogRead; facilitator: LogRead; flows?: LogRead }
  usage: { basis: string; internal: UsageSide; external: UsageSide & { byWallet: WalletRow[] } }
  milestone1: {
    title: string
    due: string
    vaults: Metric & { items: VaultItem[] }
    // linked and unlinked arrive with the flow count; a backend from before it sends neither,
    // and its count is every Gateway check, so the row is labeled by which one answered.
    checks: Metric & { internal: number; external: number; linked?: { paid: number; refused: number }; unlinked?: number }
    refusals: Metric & { items: RefusalItem[] }
    evidence: string
  }
  milestone2: {
    title: string
    due: string
    externalTeamsLive: Metric
    externalChecks: Metric
    teamActiveOnSeveralDays: Metric
    publicReference: Metric
    unattributed: { wallets: number; checks: number; note: string }
  }
  afterProgram: { activeExternalWallets: Metric & { windowDays: number }; note: string }
  note: string
}

type LoadState = 'loading' | 'unreachable' | 'missing' | 'ready'

const SEASON_PATH = '/api/arc/season'
const SEASON_URL = `https://a-identity.xyz${SEASON_PATH}`
const REFRESH_MS = 60_000

const usd = (n: number) => `$${n}`
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** One metric: label, count over target, a thin bar, and the reason while the count is 0. */
function MetricRow({ label, metric, detail }: { label: string; metric: Metric; detail?: string }) {
  const pct = metric.target > 0 ? Math.min(100, Math.round((metric.count / metric.target) * 100)) : 0
  const met = metric.count >= metric.target
  return (
    <div className="border-b border-border/60 py-3 last:border-0">
      <div className="flex items-baseline justify-between gap-x-4">
        <span className="text-xs text-foreground/75">{label}</span>
        <span className={`shrink-0 font-mono text-xs tabular-nums ${met ? 'text-ok' : 'text-foreground/85'}`}>
          {metric.count} / {metric.target}
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
      {detail && <p className="mt-1.5 font-mono text-[11px] text-foreground/50">{detail}</p>}
      {metric.count === 0 && metric.note && (
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
        <span className="font-mono text-[11px] text-foreground/50">due {due}</span>
      </div>
      <div className="mt-2">{children}</div>
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

function UsageCell({ title, caption, side }: { title: string; caption: string; side: UsageSide }) {
  const rows: [string, string][] = [
    ['Checks', `${side.checks} (Gateway ${side.byRail.gateway.checks}, facilitator ${side.byRail.facilitator.checks})`],
    ['USD', usd(side.usd)],
    ['Wallets', String(side.wallets.length)],
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

function WalletLine({ w }: { w: WalletRow }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-border/60 py-2 last:border-0">
      <span className="font-mono text-xs text-foreground/80" title={w.wallet}>
        {short(w.wallet)}
        {w.team && <span className="ml-2 font-sans font-semibold text-foreground/70">{w.team}</span>}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-foreground/55">
        {plural(w.checks, 'check', 'checks')}, {usd(w.usd)}, {plural(w.activeDays.length, 'day', 'days')}
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
  const unreadable = report
    ? [
        ...(['gateway', 'facilitator'] as const).filter((l) => !report.logs[l].readable),
        ...(report.logs.flows && !report.logs.flows.readable ? ['verify-then-pay flow'] : []),
      ]
    : []

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
              : `${BACKEND_UNREACHABLE} Nothing here is cached in the page, so until it answers this section stays empty rather than showing old numbers.`}
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
            As of {report.asOf}. Deliverable 2 is due {report.program.deliverable2Due}. {report.note}
          </p>

          {unreadable.length > 0 && (
            <p className="mt-3 rounded-xl bg-warn/10 px-4 py-2.5 text-xs leading-relaxed text-warn">
              The {unreadable.join(' and ')} log could not be read on this request, so what it holds is missing from every
              number below until it answers.
            </p>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <MilestoneCard id={1} title={m1.title} due={m1.due}>
              <MetricRow label="Owner-held vaults deployed from the browser" metric={m1.vaults} />
              {m1.checks.linked ? (
                <MetricRow
                  label="Verify-then-pay flows through Circle Gateway"
                  metric={m1.checks}
                  detail={`${m1.checks.linked.paid} paid, ${m1.checks.linked.refused} refused; ${m1.checks.unlinked ?? 0} internal checks with nothing linked; ${m1.checks.external} external checks count under M2`}
                />
              ) : (
                <MetricRow
                  label="Verify-then-pay checks through Circle Gateway"
                  metric={m1.checks}
                  detail={`${m1.checks.internal} internal, ${m1.checks.external} external`}
                />
              )}
              <MetricRow label="Refusals anyone can inspect" metric={m1.refusals} />
              {m1.vaults.items.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {m1.vaults.items.map((v) => (
                    <li key={v.address} className="text-[11px] text-foreground/65">
                      <OutLink href={v.explorerUrl}>{short(v.address)}</OutLink> owner {short(v.owner)}, deployed{' '}
                      <OutLink href={v.deployExplorerUrl}>{v.deployedAt}</OutLink>
                    </li>
                  ))}
                </ul>
              )}
              {m1.refusals.items.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {m1.refusals.items.map((r) => (
                    <li key={`${r.kind}-${r.at}`} className="text-[11px] text-foreground/65">
                      <span className="font-mono text-foreground/50">{r.kind}</span> {r.note}{' '}
                      {r.explorerUrl ? (
                        <OutLink href={r.explorerUrl}>{short(r.txHash ?? '')}</OutLink>
                      ) : r.evidenceUrl ? (
                        <OutLink href={r.evidenceUrl}>audit entry</OutLink>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </MilestoneCard>

            <MilestoneCard id={2} title={m2.title} due={m2.due}>
              <MetricRow label="External teams live on Arc Mainnet" metric={m2.externalTeamsLive} />
              <MetricRow label="Paid checks from wallets we do not control" metric={m2.externalChecks} />
              <MetricRow label="External team active on several days" metric={m2.teamActiveOnSeveralDays} />
              <MetricRow label="External integration referenced in public" metric={m2.publicReference} />
            </MilestoneCard>
          </div>

          <h3 className="mt-8 text-sm font-semibold text-foreground">Internal vs external</h3>
          <p className="mt-1 max-w-[80ch] text-xs leading-relaxed text-foreground/55">{report.usage.basis}</p>
          <div className="mt-3 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-2">
            <UsageCell title="Internal" caption="Our own buyer wallets, labeled, never hidden." side={report.usage.internal} />
            <UsageCell title="External" caption="Wallets A-Identity does not control." side={external} />
          </div>

          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-wide text-foreground/45">External wallets</div>
            {external.byWallet.length === 0 ? (
              <p className="mt-1.5 text-xs leading-relaxed text-foreground/55">
                No external payment yet: every check settled on Arc Mainnet so far came from our own wallets.
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

          <p className="mt-4 text-xs leading-relaxed text-foreground/55">
            After the program: {after.count} / {after.target} external wallets active in the last {after.windowDays} days.
          </p>
        </>
      )}
    </section>
  )
}

import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { Skeleton } from '../ui/skeleton'

/**
 * What this agent has actually been doing with money, over the last week.
 *
 * The console sells the idea of bounded autonomy and then never shows the operator the
 * one thing that proves it is working: the shape of the spending. Four counters and a
 * seven-day bar answer "is it behaving" faster than reading the queue row by row.
 *
 * Everything here is computed from instructions the console has already fetched. No new
 * request, no estimate, no projection. A day with no payments is a real zero and is drawn
 * as an empty column rather than skipped, because the gaps are part of the shape.
 */
export type Ix = { status: string; amountUsd: number; count: number; createdAt: string }

const DAY = 86_400_000

export default function SpendSummary({ instructions, loading }: { instructions: Ix[] | null; loading?: boolean }) {
  if (loading || !instructions) {
    return (
      <div className="rounded-xl border border-border bg-card p-6">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="mt-4 h-20 w-full" />
        <Skeleton className="mt-4 h-3 w-40" />
      </div>
    )
  }

  // Only money that actually moved counts as spend. Pending and rejected are intent, not
  // outcome, and folding them in would overstate what the agent has done.
  const settledStatuses = new Set(['executed_onchain', 'executed_simulated'])
  const now = Date.now()
  const startOfToday = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()

  const days = Array.from({ length: 7 }, (_, i) => {
    const from = startOfToday - (6 - i) * DAY
    const to = from + DAY
    const total = instructions
      .filter((ix) => settledStatuses.has(ix.status))
      .filter((ix) => {
        const t = new Date(ix.createdAt).getTime()
        return t >= from && t < to
      })
      .reduce((s, ix) => s + ix.amountUsd * ix.count, 0)
    return { from, total, label: new Date(from).toLocaleDateString(undefined, { weekday: 'narrow' }) }
  })

  const peak = Math.max(...days.map((d) => d.total))
  const weekTotal = days.reduce((s, d) => s + d.total, 0)
  const counts = {
    settled: instructions.filter((ix) => ix.status === 'executed_onchain').length,
    pending: instructions.filter((ix) => ix.status === 'pending_approval').length,
    rejected: instructions.filter((ix) => ix.status === 'rejected').length,
  }

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground/50">Last 7 days</h3>
        <Link to="/app/settlements" className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent hover:underline">
          All payments <ArrowUpRight size={12} />
        </Link>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums tracking-tight text-foreground">
          {weekTotal.toFixed(weekTotal > 0 && weekTotal < 1 ? 4 : 2)}
        </span>
        <span className="text-xs font-semibold text-foreground/45">USDC settled</span>
      </div>

      {/* Seven real days. An empty column is a day with no settlement, not missing data. */}
      <div className="mt-4 flex h-20 items-end gap-1.5" role="img" aria-label={`Settled per day over the last seven days, ${weekTotal.toFixed(2)} USDC in total`}>
        {days.map((d) => (
          <div key={d.from} className="flex flex-1 flex-col items-center gap-1.5">
            <div className="flex h-16 w-full items-end">
              <div
                className={`w-full rounded-sm transition-all ${d.total > 0 ? 'bg-accent' : 'bg-foreground/[0.07]'}`}
                style={{ height: d.total > 0 && peak > 0 ? `${Math.max(8, (d.total / peak) * 100)}%` : '3px' }}
                title={`${new Date(d.from).toLocaleDateString()} · ${d.total.toFixed(2)} USDC`}
              />
            </div>
            <span className="text-[10px] text-foreground/35">{d.label}</span>
          </div>
        ))}
      </div>

      <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3">
        {[
          { k: 'Settled', v: counts.settled, tone: 'text-emerald-600 dark:text-emerald-400' },
          { k: 'Waiting', v: counts.pending, tone: counts.pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/45' },
          { k: 'Refused', v: counts.rejected, tone: counts.rejected > 0 ? 'text-foreground/70' : 'text-foreground/45' },
        ].map(({ k, v, tone }) => (
          <div key={k}>
            <dt className="text-[10px] font-medium uppercase tracking-wide text-foreground/40">{k}</dt>
            <dd className={`text-lg font-bold tabular-nums ${tone}`}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

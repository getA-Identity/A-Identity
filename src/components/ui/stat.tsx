import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * A labelled number in a small card.
 *
 * `Stat` in WalletPanels and `MetricTile` further down the same file were byte-identical, and
 * `BalanceTile` was the same thing with a shadow and a badge slot. One component with an
 * optional badge covers all three, and the markup is unchanged from what they rendered.
 *
 * Numbers are `tabular-nums` throughout so a value that ticks does not shift the layout under
 * it, which matters here because most of these are live balances.
 */
export function Stat({
  label,
  value,
  badge,
  raised,
  className = '',
}: {
  label: ReactNode
  value: ReactNode
  /** Sits beside the label, e.g. the "Yielding" tag on a treasury balance. */
  badge?: ReactNode
  /** The slightly lifted treatment the balance tiles use. */
  raised?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-foreground/[0.06] bg-card px-4 py-3',
        raised && 'shadow-[0_1px_2px_rgba(16,24,40,0.04)]',
        className,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('text-[11px] font-medium text-foreground/45', badge && 'text-xs font-semibold text-foreground/55')}>
          {label}
        </span>
        {badge}
      </div>
      <div
        className={cn(
          'mt-0.5 font-semibold tracking-tight text-foreground tabular-nums',
          badge ? 'mt-1 text-lg' : 'text-base',
        )}
      >
        {value}
      </div>
    </div>
  )
}

/** The green "Yielding" tag the treasury balances carry. Kept here so it travels with Stat. */
export function StatBadge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-emerald-100 dark:bg-emerald-500/15 px-1.5 py-[1px] text-[9px] font-semibold text-emerald-700 dark:text-emerald-300">
      {children}
    </span>
  )
}

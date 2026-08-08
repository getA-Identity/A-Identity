import { Skeleton } from '../../ui/skeleton'

/**
 * One component of the reputation score, as a card: the figure in its own
 * colour, the share of its maximum as a bar, and a small owl keeping watch.
 * The owl varies per component so the three cards read as three characters,
 * not three copies.
 */
export default function ReputationCard({
  label,
  value,
  max,
  color,
  loading,
  owl,
}: {
  label: string
  value: number
  max: number
  color: string
  loading: boolean
  /** Path under /mascots, e.g. "/mascots/owl-card.png". */
  owl?: string
}) {
  const pct = Math.round((value / max) * 100)
  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5">
      {owl && (
        <img
          src={owl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="absolute -right-1 top-2 h-12 w-12 object-contain opacity-90"
        />
      )}
      <div className="text-sm font-semibold text-foreground/70">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-14" />
      ) : (
        <div className="mt-2 flex items-baseline gap-1.5">
          <span className="text-2xl font-bold tabular-nums tracking-tight" style={{ color }}>
            {value}
          </span>
          <span className="text-xs font-medium text-foreground/50">of {max}</span>
        </div>
      )}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-foreground/8">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${loading ? 0 : Math.min(100, pct)}%`, background: color }}
        />
      </div>
    </div>
  )
}

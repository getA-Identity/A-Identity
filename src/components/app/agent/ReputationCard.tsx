import { Skeleton } from '../../ui/skeleton'

export default function ReputationCard({
  label,
  value,
  max,
  color,
  loading,
}: {
  label: string
  value: number
  max: number
  color: string
  loading: boolean
}) {
  const pct = Math.round((value / max) * 100)
  return (
    <div className="rounded-2xl border border-foreground/10 bg-card p-5">
      <div className="text-xs font-semibold text-foreground/50">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-10" />
      ) : (
        <div className="mt-2 text-2xl font-bold tracking-tight" style={{ color }}>
          {value}
        </div>
      )}
      <div className="text-xs text-foreground/35">of {max}</div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-foreground/8">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  )
}

import { RotateCcw } from 'lucide-react'
import {
  ROADMAP_STATUSES,
  ROADMAP_TRACKS,
  type RoadmapStatus,
  type RoadmapTrackId,
} from '../../lib/roadmap'
import { cn } from '../../lib/utils'
import { STATUS_UI, TRACK_ICON } from './roadmap-ui'

export type StatusFilter = RoadmapStatus | 'all'
export type TrackFilter = RoadmapTrackId | 'all'

/**
 * Two rows of toggle buttons, status and track, and nothing in the URL. Each button is a
 * real button with `aria-pressed`, so the keyboard and a screen reader get the state for
 * free; the active one is drawn solid, the rest as outlined pills. The counts beside each
 * label are totals over the whole roadmap, not over the other filter, so a reader can see
 * what a filter would show before pressing it.
 */
export function RoadmapFilters({
  status,
  track,
  onStatus,
  onTrack,
  statusCounts,
  trackCounts,
  total,
  visible,
}: {
  status: StatusFilter
  track: TrackFilter
  onStatus: (s: StatusFilter) => void
  onTrack: (t: TrackFilter) => void
  statusCounts: Record<RoadmapStatus, number>
  trackCounts: Record<RoadmapTrackId, number>
  total: number
  /** How many items the current pair of filters leaves on the page. */
  visible: number
}) {
  const filtered = status !== 'all' || track !== 'all'
  return (
    <div className="space-y-4">
      <FilterRow label="Status">
        <FilterButton active={status === 'all'} onClick={() => onStatus('all')} count={total}>
          All
        </FilterButton>
        {ROADMAP_STATUSES.map((s) => {
          const { Icon } = STATUS_UI[s.id]
          return (
            <FilterButton
              key={s.id}
              active={status === s.id}
              onClick={() => onStatus(s.id)}
              count={statusCounts[s.id]}
              icon={<Icon size={13} strokeWidth={2.3} aria-hidden="true" />}
            >
              {s.label}
            </FilterButton>
          )
        })}
      </FilterRow>
      <FilterRow label="Track">
        <FilterButton active={track === 'all'} onClick={() => onTrack('all')} count={total}>
          All
        </FilterButton>
        {ROADMAP_TRACKS.map((t) => {
          const Icon = TRACK_ICON[t.id]
          return (
            <FilterButton
              key={t.id}
              active={track === t.id}
              onClick={() => onTrack(t.id)}
              count={trackCounts[t.id]}
              icon={<Icon size={13} strokeWidth={2.2} aria-hidden="true" />}
            >
              {t.label}
            </FilterButton>
          )
        })}
      </FilterRow>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
        <span aria-live="polite">
          Showing {visible} of {total}
        </span>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              onStatus('all')
              onTrack('all')
            }}
            className="inline-flex items-center gap-1 text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCcw size={11} aria-hidden="true" />
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={`Filter by ${label.toLowerCase()}`} className="flex flex-wrap items-center gap-2">
      <span className="mr-1 w-full font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/45 sm:w-14">
        {label}
      </span>
      {children}
    </div>
  )
}

function FilterButton({
  active,
  onClick,
  count,
  icon,
  children,
}: {
  active: boolean
  onClick: () => void
  count: number
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-semibold leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-card text-foreground/75 hover:border-foreground/30 hover:text-foreground',
      )}
    >
      {icon}
      {children}
      <span className={cn('font-mono text-[10.5px]', active ? 'text-background/70' : 'text-foreground/45')}>
        {count}
      </span>
    </button>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Star, Trophy } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import AgentAvatar from '../AgentAvatar'

/**
 * Featured agents carousel: the top of the SAME composite leaderboard the
 * Leaderboard tab renders, framed as a storefront strip. Every card is a real
 * leaderboard row; there are no campaign or paid-placement slots, so an empty
 * leaderboard renders nothing at all rather than filler.
 *
 * Motion contract: JS decides WHEN (the 5s auto-advance timer, pause flags),
 * CSS/scroll decide WHAT. Auto-advance stops entirely under
 * prefers-reduced-motion, and manual arrow jumps degrade to instant scrolls.
 */

/** One row of GET /api/marketplace/leaderboard. */
export type FeaturedAgent = {
  id: string
  name: string
  logoUrl?: string
  category: string
  kya: string
  onchainAgentId?: string
  reputation: { score: number }
  feedback: { avg: number | null; count: number }
  followers: number
  tasksDone: number
  rankScore: number
  rank: number
}

/** Five stars filled proportionally to the platform's 0-10 rating average. */
export function Stars({ avg, count, className = '' }: { avg: number | null; count: number; className?: string }) {
  const frac = avg == null ? 0 : Math.max(0, Math.min(1, avg / 10))
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`}
      role="img"
      aria-label={
        avg == null ? 'No ratings yet' : `Rated ${avg.toFixed(1)} out of 10 from ${count} rating${count === 1 ? '' : 's'}`
      }
    >
      <span className="relative inline-flex shrink-0" aria-hidden="true">
        <span className="flex gap-0.5 text-foreground/20">
          {Array.from({ length: 5 }).map((_, i) => (
            <Star key={i} size={12} fill="currentColor" strokeWidth={0} />
          ))}
        </span>
        <span className="absolute inset-y-0 left-0 overflow-hidden text-warn" style={{ width: `${frac * 100}%` }}>
          <span className="flex w-max gap-0.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Star key={i} size={12} fill="currentColor" strokeWidth={0} />
            ))}
          </span>
        </span>
      </span>
      {avg == null ? (
        <span className="text-[11px] font-medium text-foreground/40">No ratings yet</span>
      ) : (
        <span className="text-xs font-semibold tabular-nums text-foreground/70">
          {avg.toFixed(1)}/10 <span className="font-medium text-foreground/45">({count})</span>
        </span>
      )}
    </span>
  )
}

/** Rank chip: the podium (top 3) carries the accent, everyone below is a plain number. */
export function RankBadge({ rank }: { rank: number }) {
  if (rank === 1)
    return (
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
        1
      </span>
    )
  if (rank <= 3)
    return (
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-accent/35 bg-accent/10 text-xs font-bold text-accent">
        {rank}
      </span>
    )
  return (
    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-xs font-semibold tabular-nums text-foreground/45">
      {rank}
    </span>
  )
}

const MAX_CARDS = 8
const AUTO_ADVANCE_MS = 5000

const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function FeaturedCarousel({
  rows,
  title,
  subnote,
  moreTo,
  compact = false,
  className = '',
}: {
  /** Leaderboard rows to render. Omit to let the strip fetch the leaderboard itself
   *  (the Dashboard use); when the fetch fails or comes back empty, the whole strip
   *  stays hidden instead of showing placeholders. */
  rows?: FeaturedAgent[]
  title: string
  /** Honest framing line next to the heading (e.g. what ranking this is). */
  subnote?: string
  /** Optional "see everything" link target (the Dashboard strip points into the marketplace). */
  moreTo?: string
  compact?: boolean
  className?: string
}) {
  const [fetched, setFetched] = useState<FeaturedAgent[] | null>(null)
  useEffect(() => {
    if (rows) return
    let active = true
    ;(async () => {
      try {
        const res = await apiFetch('/api/marketplace/leaderboard')
        if (!res.ok) return
        const data = (await res.json()) as { agents?: FeaturedAgent[] }
        if (active && Array.isArray(data.agents)) setFetched(data.agents)
      } catch {
        // This strip is a bonus surface: with no leaderboard to show it simply
        // does not render, and the owning page's own error states do the talking.
      }
    })()
    return () => {
      active = false
    }
  }, [rows])

  const list = (rows ?? fetched ?? []).slice(0, MAX_CARDS)

  const trackRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [edges, setEdges] = useState({ atStart: true, atEnd: true })

  const readEdges = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    setEdges({
      atStart: el.scrollLeft <= 4,
      atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
    })
  }, [])

  // The arrows start from real overflow state (a strip of two cards on a wide
  // screen has nothing to scroll), and track it on resize.
  useEffect(() => {
    readEdges()
    const el = trackRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(readEdges)
    ro.observe(el)
    return () => ro.disconnect()
  }, [readEdges, list.length])

  /** One card-width step. `wrap` (auto-advance only) loops back to the start at the end. */
  const advance = useCallback((dir: 1 | -1, wrap = false) => {
    const el = trackRef.current
    if (!el) return
    const kids = el.children
    // Real step = distance between the first two cards (card width + gap).
    const step =
      kids.length > 1
        ? (kids[1] as HTMLElement).offsetLeft - (kids[0] as HTMLElement).offsetLeft
        : el.clientWidth
    const behavior: ScrollBehavior = prefersReduced() ? 'auto' : 'smooth'
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8
    if (dir === 1 && atEnd && wrap) el.scrollTo({ left: 0, behavior })
    else el.scrollBy({ left: dir * step, behavior })
  }, [])

  // Auto-advance: a plain timer that the pause flag and reduced-motion kill.
  useEffect(() => {
    if (paused || list.length < 2 || prefersReduced()) return
    const t = window.setInterval(() => advance(1, true), AUTO_ADVANCE_MS)
    return () => window.clearInterval(t)
  }, [paused, list.length, advance])

  if (list.length === 0) return null

  const scrollable = !(edges.atStart && edges.atEnd)

  return (
    <section
      aria-label={title}
      className={className}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-sm font-bold tracking-tight">
          <Trophy size={15} className="text-accent" /> {title}
        </h4>
        <div className="flex items-center gap-2">
          {subnote && <span className="text-[11px] font-medium text-foreground/45">{subnote}</span>}
          {moreTo && (
            <Link to={moreTo} className="text-xs font-semibold text-accent hover:underline">
              Open marketplace
            </Link>
          )}
        </div>
      </div>

      <div className="relative mt-3">
        <div
          ref={trackRef}
          onScroll={readEdges}
          className="cn-mk2-track flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1"
        >
          {list.map((r) => (
            <div
              key={r.id}
              className={`flex shrink-0 snap-start flex-col rounded-2xl border border-border bg-card transition-colors duration-[120ms] hover:border-accent/40 ${
                compact ? 'w-[200px] p-3.5' : 'w-[240px] p-4'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <AgentAvatar
                  seed={r.onchainAgentId || r.id}
                  category={r.category}
                  size={compact ? 36 : 44}
                  verdict={r.kya === 'verified' ? 'allow' : 'warn'}
                  src={r.logoUrl}
                />
                <RankBadge rank={r.rank} />
              </div>
              <Link
                to={`/app/marketplace/${r.id}`}
                className="mt-2.5 block truncate text-sm font-bold text-foreground hover:text-accent"
              >
                {r.name}
              </Link>
              <span className="block truncate text-[11px] text-foreground/50">{r.category}</span>
              <Stars avg={r.feedback.avg} count={r.feedback.count} className="mt-1.5" />
              {!compact && (
                <span className="mt-1 text-[11px] font-medium tabular-nums text-foreground/45">
                  {r.tasksDone} paid job{r.tasksDone === 1 ? '' : 's'} done · rep {r.reputation.score}
                </span>
              )}
              <Link
                to={`/app/marketplace/${r.id}`}
                className={`inline-flex items-center justify-center rounded-full bg-accent text-xs font-bold text-white transition-transform hover:scale-[1.02] ${
                  compact ? 'mt-2.5 px-3 py-1.5' : 'mt-3 px-3.5 py-2'
                }`}
              >
                Hire now
              </Link>
            </div>
          ))}
        </div>

        {/* Inline overlay arrows (no portals): disabled flat at the edges. */}
        {scrollable && (
          <>
            <button
              type="button"
              onClick={() => advance(-1)}
              disabled={edges.atStart}
              aria-label="Scroll featured agents left"
              className="absolute left-0 top-1/2 z-10 grid h-8 w-8 -translate-x-1/3 -translate-y-1/2 place-items-center rounded-full border border-border bg-card text-foreground/70 shadow-sm transition-opacity duration-[120ms] hover:text-accent disabled:pointer-events-none disabled:opacity-0"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => advance(1)}
              disabled={edges.atEnd}
              aria-label="Scroll featured agents right"
              className="absolute right-0 top-1/2 z-10 grid h-8 w-8 -translate-y-1/2 translate-x-1/3 place-items-center rounded-full border border-border bg-card text-foreground/70 shadow-sm transition-opacity duration-[120ms] hover:text-accent disabled:pointer-events-none disabled:opacity-0"
            >
              <ChevronRight size={16} />
            </button>
          </>
        )}
      </div>
    </section>
  )
}

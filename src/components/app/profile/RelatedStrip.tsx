/**
 * "Explore more" strip at the foot of the agent profile: related agents from
 * the same fetched marketplace list, same category first, then nearest
 * composite score (the ranking itself stays computed in AgentProfile).
 * Extracted from AgentProfile.tsx together with its whole motion cluster
 * (stripRef, stripPaused, spinStrip, the ~5s auto-advance interval). Must
 * preserve: auto-advance pauses on hover/focus, never starts under
 * prefers-reduced-motion or with fewer than 2 agents, wraps at both ends, and
 * renders nothing at all when there are no related agents.
 */
import { useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Star } from 'lucide-react'
import AgentAvatar from '../../AgentAvatar'
import { AgentBanner } from '../marketplace/AgentCardChrome'
import { cardTint, CIRCLE_MARK } from '../marketplace/types'
import type { MarketAgent } from './types'

type Props = {
  related: MarketAgent[]
}

export default function RelatedStrip({ related }: Props) {
  // Explore-more auto-advance: ~5s per step, paused while hovered or focused,
  // and never started at all under prefers-reduced-motion.
  const stripRef = useRef<HTMLDivElement | null>(null)
  const stripPaused = useRef(false)
  const spinStrip = useCallback((dir: 1 | -1) => {
    const el = stripRef.current
    if (!el) return
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    const card = el.firstElementChild as HTMLElement | null
    const step = card ? card.offsetWidth + 12 : 236
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8
    const atStart = el.scrollLeft <= 8
    if (dir === 1 && atEnd) el.scrollTo({ left: 0, behavior })
    else if (dir === -1 && atStart) el.scrollTo({ left: el.scrollWidth, behavior })
    else el.scrollBy({ left: dir * step, behavior })
  }, [])
  useEffect(() => {
    if (related.length < 2) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const iv = setInterval(() => {
      if (!stripPaused.current) spinStrip(1)
    }, 5000)
    return () => clearInterval(iv)
  }, [related.length, spinStrip])

  if (related.length === 0) return null
  return (
    <section
      className="mt-8"
      aria-label="Explore more agents"
      onPointerEnter={() => {
        stripPaused.current = true
      }}
      onPointerLeave={() => {
        stripPaused.current = false
      }}
      onFocusCapture={() => {
        stripPaused.current = true
      }}
      onBlurCapture={() => {
        stripPaused.current = false
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-foreground/80">Explore more agents</h3>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => spinStrip(-1)}
            aria-label="Previous agents"
            className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-foreground/60 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() => spinStrip(1)}
            aria-label="Next agents"
            className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card text-foreground/60 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div ref={stripRef} className="cn-pf2-strip mt-3 flex gap-3 overflow-x-auto pb-1">
        {related.map((r) => (
          <Link
            key={r.id}
            to={`/app/marketplace/${r.id}`}
            className="w-56 shrink-0 overflow-hidden rounded-2xl border border-border bg-card transition-colors duration-[120ms] hover:border-accent/40"
          >
            {/* Same banner-and-mark language as the marketplace cards, at strip scale. */}
            <AgentBanner tint={cardTint(r)} className="h-11" />
            <div className="px-4 pb-4">
              <div className="-mt-5 w-fit rounded-full ring-4 ring-card">
                <AgentAvatar
                  seed={r.onchainAgentId || r.id}
                  category={r.category}
                  size={40}
                  verdict={r.kya === 'verified' ? 'allow' : 'warn'}
                  src={r.logoUrl}
                  className={CIRCLE_MARK}
                />
              </div>
              <div className="mt-2 min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{r.name}</div>
                <div className="truncate text-[11px] text-foreground/55">{r.category}</div>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1 font-semibold text-foreground/75">
                <Star size={11} className="text-warn" fill="currentColor" />
                {r.feedback?.avg != null ? (
                  <>
                    {r.feedback.avg.toFixed(1)}
                    <span className="font-medium text-foreground/45">({r.feedback.count})</span>
                  </>
                ) : (
                  <span className="font-medium text-foreground/45">No ratings</span>
                )}
              </span>
              <span className="tabular-nums font-medium text-foreground/55">{r.soldCount ?? 0} sold</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { ASP_BASE } from '../../lib/mcpBase'

/**
 * Every settlement we have ever taken, as clickable rows.
 *
 * The category has no customer quotes to show, so the strongest available proof is the
 * chain itself: this reads the live /proof.json from the ASP and renders each settlement
 * as a link into OKLink. A visitor does not have to believe the number above it, because
 * any single row can be opened and checked in one click.
 *
 * Nothing here is generated: the rows are the real USD₮0 transfers on X Layer mainnet that
 * paid for tool calls. If the feed cannot be reached, the panel says so and keeps the link
 * to the full proof page rather than inventing rows.
 *
 * WHY IT MOVES, AND WHAT THE MOVEMENT IS NOT ALLOWED TO CLAIM.
 *
 * The panel is called a ticker and for a long time it was a static list. It moves now, but
 * only in the one way that cannot lie: it scrolls its own box down through settlements
 * that were all fetched in a single read and were already on-chain before the page opened.
 * A row is never inserted, never animated in from the top, and the order never changes, so
 * there is no frame in which the panel implies that money arrived while you watched. The
 * copy says exactly that, in the header, for as long as the drift is running.
 *
 * The reader takes it over permanently on any wheel, drag, key or focus, because a person
 * reading row forty must not be carried to row forty-one; hovering only pauses it. Reduced
 * motion never starts it, and neither does an off-screen panel.
 */

// Fetched through ASP_BASE (same-origin /asp proxy in prod, so ad blockers that list
// *.onrender.com cannot fake an outage); the human-facing proof page stays on the ASP's
// real origin because it is the ASP's own document, not ours.
const PROOF_PAGE = 'https://a-identity-asp.onrender.com/proof'

type Settlement = { round: number; tool: string; amountUsd: number; txHash: string; txUrl: string }
type Feed = { settlements: Settlement[]; total: number; totalUsd: number; payToUrl?: string }

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`

/** Pixels a second the ledger drifts by. A row is 46px, so about two and a half seconds. */
const DRIFT_PX_PER_MS = 0.019
/** A beat at the top and at the bottom, so the newest row is readable on both passes. */
const DRIFT_HOLD_MS = 1100

export default function SettlementTicker() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [failed, setFailed] = useState(false)
  const still = useReducedMotion() ?? false
  const listRef = useRef<HTMLDivElement>(null)
  /** False once the reader has steered. There is no path back: it was their choice. */
  const [drifting, setDrifting] = useState(true)
  const hovered = useRef(false)

  useEffect(() => {
    let alive = true
    // Deferred to idle. This section is far below the fold and the fetch goes to
    // a backend that may be cold, so on a phone it was competing for bandwidth
    // with the fonts and the entry chunk while the hero was still painting. The
    // ledger is proof, not the first thing anyone reads.
    const idle =
      window.requestIdleCallback?.(() => alive && load(), { timeout: 3000 }) ??
      window.setTimeout(() => alive && load(), 1200)

    function load() {
    fetch(`${ASP_BASE}/proof.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { realOnchainRevenue?: Record<string, unknown> }) => {
        const rev = d.realOnchainRevenue
        const list = Array.isArray(rev?.settlements) ? (rev.settlements as Settlement[]) : []
        if (!alive || list.length === 0) {
          if (alive) setFailed(true)
          return
        }
        setFeed({
          // Newest first: the seeding rounds ran in order, so the tail is the latest.
          settlements: [...list].reverse(),
          total: Number(rev?.totalSettlements ?? list.length),
          totalUsd: Number(rev?.totalUsd ?? 0),
          payToUrl: typeof rev?.payToUrl === 'string' ? rev.payToUrl : undefined,
        })
      })
      .catch(() => alive && setFailed(true))
    }

    return () => {
      alive = false
      if (typeof idle === 'number') window.clearTimeout(idle)
      else window.cancelIdleCallback?.(idle)
    }
  }, [])

  /* The drift. It walks the box's own scrollTop, which is the honest way to move a ledger:
     the scrollbar shows a reader travelling through a fixed list rather than a list being
     fed from somewhere. When it reaches the last settlement it waits, returns to the
     newest and waits again. */
  useEffect(() => {
    if (still || !drifting || !feed) return
    const el = listRef.current
    if (!el) return

    let onScreen = false
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([e]) => (onScreen = e.isIntersecting), { threshold: 0.3 })
    io?.observe(el)

    let raf = 0
    let last = 0
    let hold = DRIFT_HOLD_MS
    /* The position is kept here as a float and only then written out. `scrollTop` snaps
       what it is given to a whole device pixel, so a frame's worth of drift (0.3px at
       60fps) written straight to the element rounds to zero, is read back as zero, and the
       panel never moves at all. Accumulating first is what makes a slow drift possible. */
    let pos = el.scrollTop
    const step = (t: number) => {
      raf = requestAnimationFrame(step)
      const dt = last ? Math.min(t - last, 100) : 0
      last = t
      if (!onScreen || hovered.current || document.hidden) return
      if (hold > 0) {
        hold -= dt
        return
      }
      const max = el.scrollHeight - el.clientHeight
      if (max <= 0) return
      // Something other than us moved the box (a focus ring being revealed, say). Follow
      // it rather than yanking the reader back to where we thought we were.
      if (Math.abs(el.scrollTop - pos) > 2) pos = el.scrollTop
      if (pos >= max - 0.5) {
        pos = 0
        el.scrollTop = 0
        hold = DRIFT_HOLD_MS
        return
      }
      pos = Math.min(max, pos + dt * DRIFT_PX_PER_MS)
      el.scrollTop = pos
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      io?.disconnect()
    }
  }, [still, drifting, feed])

  const takeOver = () => setDrifting(false)

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-32px_rgba(16,24,40,0.35)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
            </span>
            Every settlement, on-chain
          </p>
          {/* The one sentence that keeps the movement honest, shown exactly while there IS
              movement. The list is a complete record read once; scrolling it is not a feed
              arriving, and a reader should not have to work that out from the timing. */}
          {feed && drifting && !still && (
            <p className="mt-0.5 pl-4 text-[11px] leading-tight text-foreground/60">
              The complete record, newest first. It scrolls; nothing arrives while you watch.
            </p>
          )}
        </div>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/60">
          USD₮0 · X Layer mainnet
        </p>
      </div>

      <div className="hidden grid-cols-[minmax(0,1fr)_88px_minmax(0,1.1fr)_18px] gap-x-4 border-b border-border/60 px-5 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-foreground/60 sm:grid">
        <span>Tool paid for</span>
        <span className="justify-self-end">Amount</span>
        <span className="justify-self-end">Transaction</span>
        <span />
      </div>

      {/* Fixed height with its own scroll: a hundred and twenty rows must never grow the page. */}
      <div
        ref={listRef}
        /* Hover pauses. A wheel, a drag, a key or focus arriving on a row is the reader
           steering, and the drift does not come back after that. Focus matters most: a
           keyboard user tabbing down the rows makes the browser scroll this box itself,
           and two things scrolling one box is a fight the reader always loses. */
        onMouseEnter={() => (hovered.current = true)}
        onMouseLeave={() => (hovered.current = false)}
        onWheel={takeOver}
        onPointerDown={takeOver}
        onTouchStart={takeOver}
        onKeyDown={takeOver}
        onFocusCapture={takeOver}
        className="h-[264px] divide-y divide-border/60 overflow-y-auto overscroll-y-contain"
      >
        {feed?.settlements.map((s, i) => (
          <motion.a
            key={s.txHash + i}
            href={s.txUrl}
            target="_blank"
            rel="noopener noreferrer"
            initial={i < 8 ? { opacity: 0, y: -8 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: Math.min(i, 8) * 0.04, ease: [0.16, 1, 0.3, 1] }}
            className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-3 transition-colors hover:bg-accent/[0.05] sm:grid-cols-[minmax(0,1fr)_88px_minmax(0,1.1fr)_18px]"
          >
            <span className="truncate font-mono text-[13px] font-semibold text-foreground">
              {s.tool}
            </span>
            <span className="justify-self-end font-mono text-[13px] font-semibold text-emerald-600 dark:text-emerald-400">
              ${s.amountUsd.toFixed(3)}
            </span>
            <span className="col-span-2 truncate font-mono text-[11px] text-foreground/60 sm:col-span-1 sm:justify-self-end">
              {short(s.txHash)}
            </span>
            <ArrowUpRight
              size={13}
              className="hidden text-foreground/60 transition-colors group-hover:text-accent sm:block"
            />
          </motion.a>
        ))}

        {!feed && !failed && (
          <div className="flex h-full items-center justify-center font-mono text-xs text-foreground/60">
            reading the chain…
          </div>
        )}

        {failed && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm text-foreground/70">
              The live feed did not answer just now. The record is still on-chain.
            </p>
            <a
              href={PROOF_PAGE}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
            >
              Open the proof page <ArrowUpRight size={14} />
            </a>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-foreground/60">
        <span>
          {feed ? (
            <>
              <span className="font-mono font-semibold text-foreground">{feed.total}</span>{' '}
              settlements, <span className="font-mono">${feed.totalUsd.toFixed(3)}</span> taken in
              total. Every row opens on OKLink.
            </>
          ) : (
            'Every row opens the transaction on OKLink.'
          )}
        </span>
        <a
          href={feed?.payToUrl ?? PROOF_PAGE}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-accent hover:underline"
        >
          The receiving wallet
        </a>
      </div>
    </div>
  )
}

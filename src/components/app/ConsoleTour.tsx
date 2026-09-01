import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, X } from 'lucide-react'

/**
 * First-run guided tour.
 *
 * A spotlight travels between real elements (marked with `data-tour` attributes)
 * while a small card explains what each one is for, with Back / Next / Skip.
 * Steps whose target is not on screen (mobile rail, a checklist that is already
 * done) are skipped, so the tour never points at nothing.
 *
 * The overlay swallows page interaction while open. Positioning runs on ONE
 * requestAnimationFrame loop: scroll, resize, and DOM listeners only mark the
 * loop dirty; a single callback measures the target once per frame and writes
 * transform and size straight to the spotlight and card elements, with no React
 * state on the hot path. The loop parks once the rect has held still for a few
 * frames and wakes again on the next event. Step-to-step travel gets a 300ms
 * glide (.cn-tour-glide); while the page scrolls the frame is written directly
 * every frame so it stays glued to its target instead of trailing a tween.
 */
export type TourStep = {
  /** Matches an element carrying data-tour="<target>". */
  target: string
  title: string
  body: string
}

type Rect = { top: number; left: number; width: number; height: number }

const PAD = 8
const CARD_W = 330
/** Frames the target rect must hold still before the loop parks. */
const STABLE_FRAMES = 3
/** Step-to-step glide length; mirrors .cn-tour-glide in console.css. */
const GLIDE_MS = 300

/**
 * Card placement. A tall target (the full-height rail) gets the card BESIDE it,
 * vertically centred; anything else gets below-when-there-is-room, above
 * otherwise. Everything clamps to the viewport so the card can never leave it.
 * The card keeps top/left positioning (not transform) because cn-pop-in
 * animates transform and would override an inline one while playing.
 */
function cardPosition(rect: Rect, vw: number, vh: number) {
  const tall = rect.height > vh * 0.6
  let top: number
  let left: number
  if (tall) {
    left = rect.left + rect.width + 12 + CARD_W < vw ? rect.left + rect.width + 12 : Math.max(12, rect.left - CARD_W - 12)
    top = Math.min(Math.max(12, rect.top + rect.height / 2 - 130), vh - 280)
  } else {
    const below = rect.top + rect.height + 220 < vh
    top = below ? rect.top + rect.height + 12 : Math.max(12, rect.top - 232)
    left = Math.max(12, Math.min(rect.left, vw - CARD_W - 12))
  }
  return { top, left }
}

export default function ConsoleTour({
  open,
  onClose,
  steps: allSteps,
  storageKey,
}: {
  open: boolean
  onClose: () => void
  /** This page's stops, in order; invisible targets are skipped at runtime. */
  steps: TourStep[]
  /** localStorage key marking this page's tour as seen. */
  storageKey: string
}) {
  const [idx, setIdx] = useState(0)
  const spotRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  /** True once the spotlight has been placed at least once this open; the
      first placement never glides, every later step change does. */
  const shownRef = useRef(false)

  // Only steps whose target is actually rendered and visible.
  const steps = useMemo(() => {
    if (!open) return allSteps
    return allSteps.filter((s) => {
      const el = document.querySelector(`[data-tour="${s.target}"]`)
      if (!el) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
  }, [open, allSteps])

  const step = steps[idx]

  // Reset to the first step each time the tour opens.
  useEffect(() => {
    if (open) {
      setIdx(0)
      shownRef.current = false
    }
  }, [open])

  // Bring the target on screen, then track it with the frame loop until its
  // rect stops changing; scroll, resize, and DOM swaps re-arm the loop.
  useEffect(() => {
    if (!open || !step) return
    const spot = spotRef.current
    const card = cardRef.current
    if (!spot || !card) return
    const selector = `[data-tour="${step.target}"]`
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // The glide is for step-to-step travel only: never on the first placement
    // of a fresh open, never under reduced motion. It ends on the first scroll
    // event (direct tracking takes over) or when its duration runs out.
    let glideTimer: number | undefined
    const endGlide = () => {
      spot.classList.remove('cn-tour-glide')
      if (glideTimer !== undefined) {
        window.clearTimeout(glideTimer)
        glideTimer = undefined
      }
    }
    if (!reduced && shownRef.current) {
      spot.classList.add('cn-tour-glide')
      glideTimer = window.setTimeout(endGlide, GLIDE_MS)
    }

    let raf: number | undefined
    let lastRect: Rect | null = null
    let stable = 0
    let revealed = false

    const frame = () => {
      raf = undefined
      const el = document.querySelector(selector)
      const b = el?.getBoundingClientRect()
      if (!b || b.width <= 0 || b.height <= 0) {
        // Target left the page (a tab or route swap): fade the frame out
        // rather than leaving it parked over nothing, and keep seeking every
        // frame so it comes back the moment the target does.
        if (revealed) {
          revealed = false
          spot.style.opacity = '0'
          card.style.visibility = 'hidden'
        }
        lastRect = null
        stable = 0
        raf = requestAnimationFrame(frame)
        return
      }
      const r: Rect = {
        top: b.top - PAD,
        left: b.left - PAD,
        width: b.width + PAD * 2,
        height: b.height + PAD * 2,
      }
      const moved =
        !lastRect ||
        r.top !== lastRect.top ||
        r.left !== lastRect.left ||
        r.width !== lastRect.width ||
        r.height !== lastRect.height
      if (moved) {
        // Transform moves the spotlight without forcing layout of the page;
        // width/height are written directly and never transition outside the
        // glide. The card is placed in the same pass so it cannot lag.
        spot.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`
        spot.style.width = `${r.width}px`
        spot.style.height = `${r.height}px`
        const pos = cardPosition(r, window.innerWidth, window.innerHeight)
        card.style.top = `${pos.top}px`
        card.style.left = `${pos.left}px`
        lastRect = r
        stable = 0
      } else {
        stable += 1
      }
      if (!revealed) {
        revealed = true
        shownRef.current = true
        spot.style.visibility = 'visible'
        spot.style.opacity = '1'
        card.style.visibility = 'visible'
      }
      // Keep measuring until the rect holds still for a few frames (a smooth
      // scrollIntoView is still in flight until then), then park. The
      // listeners below stay armed and wake the loop again.
      if (stable < STABLE_FRAMES) raf = requestAnimationFrame(frame)
    }

    // Handlers only mark the loop dirty and make sure one frame is queued; all
    // reading and writing happens inside the single rAF callback above.
    const wake = () => {
      stable = 0
      if (raf === undefined) raf = requestAnimationFrame(frame)
    }
    const onScroll = () => {
      endGlide()
      wake()
    }

    document.querySelector(selector)?.scrollIntoView({
      block: 'center',
      behavior: reduced ? 'auto' : 'smooth',
    })
    frame()
    window.addEventListener('resize', wake)
    document.addEventListener('scroll', onScroll, { capture: true, passive: true })
    // Route and tab swaps do not necessarily scroll; watching the DOM catches
    // the target vanishing (or returning) while the loop is parked.
    const mo = new MutationObserver(wake)
    mo.observe(document.body, { childList: true, subtree: true })

    return () => {
      if (raf !== undefined) cancelAnimationFrame(raf)
      endGlide()
      mo.disconnect()
      window.removeEventListener('resize', wake)
      document.removeEventListener('scroll', onScroll, { capture: true })
    }
  }, [open, step])

  const finish = useCallback(() => {
    try {
      localStorage.setItem(storageKey, 'done')
    } catch {
      /* private mode */
    }
    onClose()
  }, [onClose, storageKey])

  // Seen is seen. Unmounting while open means the reader navigated away mid-tour; that
  // is a decision, not an accident, and re-opening on the next visit turned this into a
  // recurring blocker rather than a one-time introduction.
  const seenRef = useRef(storageKey)
  seenRef.current = storageKey
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => () => {
    if (!openRef.current) return
    try {
      localStorage.setItem(seenRef.current, 'done')
    } catch {
      /* private mode */
    }
  }, [])

  // Keyboard: arrows advance, Escape leaves.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, steps.length - 1))
      if (e.key === 'ArrowLeft') setIdx((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, steps.length, finish])

  if (!open || !step) return null

  const last = idx === steps.length - 1

  return (
    <div
      className="fixed inset-0 z-[80]"
      role="dialog"
      aria-modal="true"
      aria-label="Console tour"
      onPointerDown={(e) => {
        // Anywhere outside the explainer card leaves the tour. This used to swallow the
        // click on purpose, which meant that while the tour was open NOTHING on the page
        // could be pressed: someone trying to hire an agent pressed a button, the click
        // went nowhere, and the only visible movement was the spotlight jumping to the
        // next element. Leaving on an outside press is the ordinary behaviour of every
        // other overlay, and it costs the tour nothing: the reader has already decided.
        if (cardRef.current?.contains(e.target as Node)) return
        finish()
      }}
    >
      {/* Spotlight: the page dims everywhere except the target; the 9999px
          shadow IS the dim. Position and size are written by the frame loop
          (transform plus width/height), so no React render happens on scroll.
          Hidden until the first measurement places it. */}
      <div
        ref={spotRef}
        className="cn-tour-spot absolute left-0 top-0 rounded-xl border-2 border-accent"
        style={{ visibility: 'hidden', boxShadow: '0 0 0 9999px rgba(8, 12, 20, 0.55)' }}
      />

      {/* Explainer card: remounts per step so cn-pop-in replays; the frame
          loop writes its top/left in the same pass as the spotlight. */}
      <div
        key={idx}
        ref={cardRef}
        className="cn-pop-in absolute rounded-2xl border border-border bg-card p-5 shadow-xl"
        style={{ visibility: 'hidden', width: CARD_W }}
      >
        <button
          type="button"
          onClick={finish}
          aria-label="Skip the tour"
          className="absolute right-3 top-3 rounded-lg p-1 text-foreground/40 transition-colors duration-[120ms] hover:bg-foreground/[0.06] hover:text-foreground/70"
        >
          <X size={15} />
        </button>

        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-accent">
          {idx + 1} / {steps.length}
        </div>
        <h3 className="mt-1.5 pr-6 text-sm font-bold text-foreground">{step.title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-foreground/60">{step.body}</p>

        <div className="mt-4 flex items-center justify-between">
          {/* Step dots: where you are in the walk. */}
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {steps.map((s, i) => (
              <span
                key={s.target}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === idx ? 'w-4 bg-accent' : 'w-1.5 bg-foreground/15'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {idx > 0 && (
              <button
                type="button"
                onClick={() => setIdx((i) => i - 1)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground/60 transition-colors duration-[120ms] hover:bg-foreground/[0.04]"
              >
                <ArrowLeft size={12} /> Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (last ? finish() : setIdx((i) => i + 1))}
              className="inline-flex items-center gap-1 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-colors duration-[120ms] hover:bg-accent-deep"
            >
              {last ? 'Done' : 'Next'} {!last && <ArrowRight size={12} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

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
 * The overlay swallows page interaction while open; the spotlight element moves
 * with a transition, so advancing a step glides instead of teleporting.
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
  const [rect, setRect] = useState<Rect | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

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

  const measure = useCallback(() => {
    if (!step) return
    const el = document.querySelector(`[data-tour="${step.target}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 })
  }, [step])

  // Bring the target on screen, then track it through resizes and scrolls.
  useEffect(() => {
    if (!open || !step) return
    const el = document.querySelector(`[data-tour="${step.target}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const settle = setTimeout(measure, 320)
    measure()
    window.addEventListener('resize', measure)
    document.addEventListener('scroll', measure, { capture: true, passive: true })
    return () => {
      clearTimeout(settle)
      window.removeEventListener('resize', measure)
      document.removeEventListener('scroll', measure, { capture: true })
    }
  }, [open, step, measure])

  // Reset to the first step each time the tour opens.
  useEffect(() => {
    if (open) setIdx(0)
  }, [open])

  const finish = useCallback(() => {
    try {
      localStorage.setItem(storageKey, 'done')
    } catch {
      /* private mode */
    }
    onClose()
  }, [onClose, storageKey])

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

  if (!open || !step || !rect) return null

  const last = idx === steps.length - 1

  // Card placement. A tall target (the full-height rail) gets the card BESIDE it,
  // vertically centred; anything else gets below-when-there-is-room, above
  // otherwise. Everything clamps to the viewport so the card can never leave it.
  const vw = window.innerWidth
  const vh = window.innerHeight
  const tall = rect.height > vh * 0.6
  let cardTop: number
  let cardLeft: number
  if (tall) {
    cardLeft = rect.left + rect.width + 12 + CARD_W < vw ? rect.left + rect.width + 12 : Math.max(12, rect.left - CARD_W - 12)
    cardTop = Math.min(Math.max(12, rect.top + rect.height / 2 - 130), vh - 280)
  } else {
    const below = rect.top + rect.height + 220 < vh
    cardTop = below ? rect.top + rect.height + 12 : Math.max(12, rect.top - 232)
    cardLeft = Math.max(12, Math.min(rect.left, vw - CARD_W - 12))
  }

  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label="Console tour">
      {/* Spotlight: the page dims everywhere except the target, and the window
          glides between steps. Clicking the dim area is swallowed on purpose. */}
      <div
        className="absolute rounded-xl border-2 border-accent transition-all duration-300 [transition-timing-function:cubic-bezier(0.22,0.61,0.36,1)]"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          boxShadow: '0 0 0 9999px rgba(8, 12, 20, 0.55)',
        }}
      />

      <div
        key={idx}
        ref={cardRef}
        className="cn-pop-in absolute rounded-2xl border border-border bg-card p-5 shadow-xl"
        style={{ top: cardTop, left: cardLeft, width: CARD_W }}
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

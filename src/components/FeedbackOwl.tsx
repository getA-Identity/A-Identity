import { useEffect, useRef } from 'react'
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, type Variants } from 'framer-motion'
import OwlMark, { type OwlVerdict } from './OwlMark'
import { cn } from '../lib/utils'

/**
 * The owl on /feedback: the flat OwlMark, brought to life around the form.
 *
 * It floats, blinks, leans toward the pointer and tilts its head while someone types. Its
 * eyes report the send the same way they report a verdict everywhere else: accent while
 * nothing has happened, green once the email went out, amber when the server could not send
 * and the mailto takes over, red on an error worth retrying. Green only ever follows a
 * delivered send, because the page only reaches `sent` on `delivered: true`.
 *
 * Decorative: the form says everything this shows in words, so the whole stage is hidden
 * from assistive tech. Reduced motion gets a still owl, decided here rather than left to
 * MotionConfig, because an infinite keyframe loop collapsed to zero duration is still a loop.
 * The markup is the same either way; only the animation is skipped.
 */

export type OwlMood = 'idle' | 'typing' | 'sending' | 'sent' | 'fallback' | 'error'

const VERDICT: Record<OwlMood, OwlVerdict> = {
  idle: 'neutral',
  typing: 'neutral',
  sending: 'neutral',
  sent: 'allow',
  fallback: 'warn',
  error: 'deny',
}

const LINE: Record<OwlMood, string> = {
  idle: 'Tell me anything.',
  typing: 'I am listening.',
  sending: 'Flying it over...',
  sent: 'Delivered. Thank you!',
  fallback: 'Email works too.',
  error: 'Hmm. Try once more?',
}

/**
 * What each mood adds on top of the float. The float runs on its own wrapper, so a mood
 * change never restarts it, and every keyframe list here starts and ends at rest.
 */
const MOOD: Variants = {
  idle: { y: 0, x: 0, rotate: 0, rotateZ: 0, transition: { rotate: { duration: 0.4 } } },
  typing: { y: 0, x: 0, rotate: 7, rotateZ: 0, transition: { rotate: { type: 'spring', stiffness: 200, damping: 14 } } },
  // The wiggle runs on rotateZ, which composes with rotate, so the tilt eases back instead of snapping.
  sending: { y: 0, x: 0, rotate: 0, rotateZ: [0, -4, 4, 0], transition: { rotate: { duration: 0.3 }, rotateZ: { duration: 0.6, repeat: Infinity, ease: 'easeInOut' } } },
  sent: { y: [0, -26, 0, -12, 0], x: 0, rotate: 0, rotateZ: 0, transition: { y: { duration: 1, ease: 'easeOut' } } },
  fallback: { y: 0, x: 0, rotate: -8, rotateZ: 0, transition: { rotate: { type: 'spring', stiffness: 160, damping: 12 } } },
  error: { y: 0, x: [0, -7, 7, -5, 5, 0], rotate: 0, rotateZ: 0, transition: { x: { duration: 0.5 } } },
}

const FLOAT = { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } as const

/** The facial disc's ink, the fixed brand colour OwlMark draws it in; a lid that matches it reads as a closed eye. */
const LID = '#192837'
/** The eye centres and the ring's outer radius on OwlMark's 64-unit grid. */
const EYES = [24.2, 39.8]
const EYE_Y = 23.4
const LID_R = 8.6

export default function FeedbackOwl({
  mood,
  className = '',
  stageClassName = 'h-44 w-44 sm:h-52 sm:w-52 lg:h-60 lg:w-60',
}: {
  mood: OwlMood
  className?: string
  /** The owl's box. Sized in classes rather than a prop so a phone gets a smaller owl above the form. */
  stageClassName?: string
}) {
  const still = useReducedMotion() ?? false
  const hostRef = useRef<HTMLDivElement>(null)
  const lean = useMotionValue(0)
  const leanSpring = useSpring(lean, { stiffness: 120, damping: 14 })

  // A few degrees toward the pointer, wherever it is on the page. Never wired for reduced
  // motion, and harmless on touch, where there is no hover to follow.
  useEffect(() => {
    if (still) return
    const onMove = (e: PointerEvent) => {
      const host = hostRef.current
      if (!host) return
      const r = host.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      lean.set(Math.max(-8, Math.min(8, dx / 60)))
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => window.removeEventListener('pointermove', onMove)
  }, [still, lean])

  return (
    <div aria-hidden="true" className={cn('flex select-none flex-col items-center', className)}>
      <div className="flex h-12 items-end">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={mood}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="relative rounded-2xl border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground shadow-sm"
          >
            {LINE[mood]}
            <span className="absolute -bottom-[7px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border-b border-r border-border bg-card" />
          </motion.div>
        </AnimatePresence>
      </div>

      <div ref={hostRef} className={cn('relative mt-4', stageClassName)}>
        <div className="absolute -inset-[12%] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--color-accent)_22%,transparent),transparent)]" />
        <motion.div className="relative h-full w-full" style={{ rotate: still ? 0 : leanSpring, transformOrigin: '50% 90%' }}>
          <motion.div className="relative h-full w-full" animate={still ? undefined : { y: [0, -8, 0] }} transition={FLOAT}>
            <motion.div className="relative h-full w-full" variants={MOOD} animate={still ? undefined : mood}>
              <OwlMark verdict={VERDICT[mood]} size={240} className="block h-full w-full drop-shadow-xl" />
              <svg viewBox="0 0 64 64" className="absolute inset-0 h-full w-full" focusable="false">
                {EYES.map((cx) => (
                  // framer-motion places an SVG element's transform origin on its own box, so
                  // originY 0 is the top of the lid: it closes downward over the eye.
                  <motion.ellipse
                    key={cx}
                    cx={cx}
                    cy={EYE_Y}
                    rx={LID_R}
                    ry={LID_R}
                    fill={LID}
                    style={{ originY: 0 }}
                    initial={{ scaleY: 0 }}
                    animate={still ? undefined : { scaleY: [0, 0, 1, 0, 0] }}
                    transition={{ duration: 4.2, times: [0, 0.9, 0.93, 0.96, 1], repeat: Infinity, ease: 'easeInOut' }}
                  />
                ))}
              </svg>
            </motion.div>
          </motion.div>
        </motion.div>
        <motion.div
          className="absolute -bottom-1 left-1/4 h-3 w-1/2 rounded-[50%] bg-foreground/40 blur-[3px]"
          initial={{ scaleX: 1, opacity: 0.3 }}
          animate={still ? undefined : { scaleX: [1, 0.84, 1], opacity: [0.3, 0.18, 0.3] }}
          transition={FLOAT}
        />
      </div>
    </div>
  )
}

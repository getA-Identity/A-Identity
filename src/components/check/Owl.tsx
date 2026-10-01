import { AnimatePresence, motion } from 'framer-motion'
import { EASE } from './format'
import { cn } from '../../lib/utils'

/**
 * The owl that reacts to a check's verdict. Shared by /check and the per-chain pay checks, so
 * every "Before you pay" page answers with the same face.
 */
export type Mood = 'idle' | 'thinking' | 'happy' | 'cautious' | 'alarmed' | 'curious' | 'error'

/**
 * Existing renders only, no new art. The verdict owls are the soft owl with allow, warn and
 * deny eyes (the same three the deck uses for ALLOW / WARN / DENY); thinking and curious are
 * the plain soft owl with motion or a head tilt; a failed request gets the officer, which is
 * the brand's owl for "something went wrong".
 */
const OWLS: Record<Mood, { src: string; ring: string; tilt: number }> = {
  idle: { src: '/mascots/owl-soft.png', ring: 'bg-accent/10', tilt: 0 },
  thinking: { src: '/mascots/owl-soft.png', ring: 'bg-accent/15', tilt: 0 },
  happy: { src: '/mascots/owl-soft-allow.png', ring: 'bg-ok/15', tilt: 0 },
  cautious: { src: '/mascots/owl-soft-warn.png', ring: 'bg-warn/15', tilt: 0 },
  alarmed: { src: '/mascots/owl-soft-deny.png', ring: 'bg-danger/15', tilt: 0 },
  curious: { src: '/mascots/owl-soft.png', ring: 'bg-foreground/[0.06]', tilt: -9 },
  error: { src: '/mascots/owl-officer.png', ring: 'bg-foreground/[0.06]', tilt: 0 },
}

export default function Owl({ mood }: { mood: Mood }) {
  const o = OWLS[mood]
  const thinking = mood === 'thinking'
  return (
    <div className="relative mx-auto h-28 w-28 sm:h-32 sm:w-32">
      <div className={cn('absolute inset-[4%] rounded-full transition-colors duration-500', o.ring)} />
      <AnimatePresence mode="wait" initial={false}>
        {/* Keyed by picture, not by mood: idle to thinking to curious is the same owl
            moving, and only a verdict swaps the render. */}
        <motion.img
          key={o.src}
          src={o.src}
          alt=""
          aria-hidden="true"
          width={128}
          height={128}
          decoding="async"
          draggable={false}
          className="relative h-full w-full select-none object-contain"
          initial={{ opacity: 0, scale: 0.88 }}
          animate={
            thinking
              ? { opacity: 1, scale: 1, y: [0, -5, 0], rotate: [-4, 4, -4] }
              : { opacity: 1, scale: 1, y: 0, rotate: o.tilt }
          }
          exit={{ opacity: 0, scale: 0.9 }}
          transition={
            thinking
              ? {
                  y: { duration: 1.1, repeat: Infinity, ease: 'easeInOut' },
                  rotate: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
                  default: { duration: 0.3, ease: EASE },
                }
              : { duration: 0.4, ease: EASE }
          }
        />
      </AnimatePresence>
    </div>
  )
}

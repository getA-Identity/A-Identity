import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { cn } from '../../lib/utils'
import { SectionBackdrop } from './section-backdrop'

/**
 * Vertical rhythm, in one place.
 *
 * Every landing section had been choosing its own padding and its own max-width, which is
 * why the page read as a list rather than as a document: sections that are equally spaced
 * and equally wide are sections with no relationship to each other. Space is the cheapest
 * hierarchy there is, and it only works if something owns it.
 *
 * `size` is the whole point. A section that carries the page gets `lg` and the room to
 * breathe; a section that supports one gets `default`. Two values, deliberately, because a
 * scale with five steps is a scale nobody uses consistently.
 */
const PAD = {
  default: 'py-14 sm:py-20',
  lg: 'py-20 sm:py-28',
  /** For a section that sits directly under another with no surface change. */
  tight: 'py-10 sm:py-14',
} as const

const WIDTH = {
  default: 'max-w-[1100px]',
  /** Long-form reading measure. */
  prose: 'max-w-[820px]',
  wide: 'max-w-[1280px]',
} as const

export const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/** Staggered version, for a heading block whose parts should arrive in order. */
export const revealAt = (i: number) => ({
  ...reveal,
  transition: { ...reveal.transition, delay: i * 0.08 },
})

export function SectionShell({
  children,
  id,
  size = 'default',
  width = 'default',
  surface = 'background',
  backdrop,
  backdropPosition,
  className = '',
  innerClassName = '',
}: {
  children: ReactNode
  id?: string
  size?: keyof typeof PAD
  width?: keyof typeof WIDTH
  /** `card` lifts a section off the page, which is how a run of sections gets punctuated. */
  surface?: 'background' | 'card'
  /** File stem of the soft brand still to sit behind this section. */
  backdrop?: string
  backdropPosition?: 'right' | 'left' | 'center'
  className?: string
  innerClassName?: string
}) {
  return (
    <section
      id={id}
      className={cn(
        'relative w-full overflow-hidden px-5 text-foreground sm:px-8',
        surface === 'card' ? 'bg-card' : 'bg-background',
        PAD[size],
        className,
      )}
    >
      {backdrop && <SectionBackdrop name={backdrop} position={backdropPosition} />}
      <div className={cn('relative mx-auto', WIDTH[width], innerClassName)}>{children}</div>
    </section>
  )
}

/**
 * Eyebrow, heading and lede as one block, so the spacing between them is the same
 * everywhere and each part arrives a beat after the one above it.
 */
export function SectionIntro({
  eyebrow,
  heading,
  lede,
  align = 'left',
  className = '',
}: {
  eyebrow?: ReactNode
  heading: ReactNode
  lede?: ReactNode
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <div className={cn(align === 'center' && 'flex flex-col items-center text-center', className)}>
      {eyebrow && <motion.div {...revealAt(0)}>{eyebrow}</motion.div>}
      <motion.div {...revealAt(eyebrow ? 1 : 0)} className={eyebrow ? 'mt-4' : ''}>
        {heading}
      </motion.div>
      {lede && (
        <motion.div {...revealAt(eyebrow ? 2 : 1)} className="mt-5">
          {lede}
        </motion.div>
      )}
    </div>
  )
}

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { DisplayHeading } from '../ui/display'
import { reveal } from '../ui/section'
import { cn } from '../../lib/utils'

/**
 * One section of the roadmap: an indexed kicker, the heading, an optional lede, then the
 * timeline or the grid it carries. The same shape as the manifesto's sections, so the two
 * reference pages read as one family; `aside` is the one addition, a slot beside the kicker
 * for the section's count.
 */
export function RoadmapSection({
  id,
  index,
  label,
  heading,
  lede,
  aside,
  children,
  className = '',
}: {
  id: string
  /** Two digits, the editorial index shared with the manifesto and the architecture page. */
  index: string
  label: string
  heading: ReactNode
  lede?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      className={cn('mx-auto w-full max-w-[1040px] border-t border-border px-5 py-14 sm:px-8 sm:py-20', className)}
    >
      <motion.div {...reveal}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
            <span className="text-accent">{index}</span>
            <span className="h-px w-4 bg-foreground/20" />
            {label}
          </span>
          {aside}
        </div>
        <div className="max-w-[760px]">
          <DisplayHeading size="section" className="mt-4">
            {heading}
          </DisplayHeading>
          {lede && <p className="mt-5 text-base leading-relaxed text-foreground/65 sm:text-lg">{lede}</p>}
        </div>
      </motion.div>
      {children}
    </section>
  )
}

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { DisplayHeading } from '../ui/display'
import { reveal } from '../ui/section'
import { cn } from '../../lib/utils'

/**
 * One section of the manifesto: an indexed kicker, the heading, an optional lede, then
 * whatever the section carries.
 *
 * Two measures, on purpose. Prose reads at 760px, which is where a line stays short
 * enough to finish; the diagram and the tables get 1040px because they are scanned, not
 * read. The header block is capped at the prose measure even inside a wide section, so a
 * lede never runs the full width of a table.
 */
export function ManifestoSection({
  id,
  index,
  label,
  heading,
  lede,
  width = 'wide',
  children,
  className = '',
}: {
  id: string
  /** Two digits, the editorial index shared with the architecture page. */
  index: string
  label: string
  heading: ReactNode
  lede?: ReactNode
  width?: 'wide' | 'prose'
  children: ReactNode
  className?: string
}) {
  return (
    <section
      id={id}
      className={cn(
        'mx-auto w-full border-t border-border px-5 py-14 sm:px-8 sm:py-20',
        width === 'wide' ? 'max-w-[1040px]' : 'max-w-[760px]',
        className,
      )}
    >
      <motion.div {...reveal} className="max-w-[760px]">
        <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/45">
          <span className="text-accent">{index}</span>
          <span className="h-px w-4 bg-foreground/20" />
          {label}
        </span>
        <DisplayHeading size="section" className="mt-4">
          {heading}
        </DisplayHeading>
        {lede && <p className="mt-5 text-base leading-relaxed text-foreground/65 sm:text-lg">{lede}</p>}
      </motion.div>
      {children}
    </section>
  )
}

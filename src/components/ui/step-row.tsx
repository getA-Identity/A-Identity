import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { revealAt } from './section'
import { cn } from '../../lib/utils'

/**
 * The numbered-steps row.
 *
 * The number is set in mono and left large and quiet rather than dropped into a filled
 * circle. A circled numeral is a badge and reads as decoration; a bare `01` in the margin
 * reads as an index, which is what it is. It also stops the row competing with the section
 * heading above it, which the badge version always does.
 *
 * Three steps across on desktop, stacked below. Not a card grid: no borders, no fills, just
 * a hairline above each step. Whatever this describes is a sequence, and boxes make a
 * sequence look like a menu.
 */
export function Steps({
  children,
  columns = 3,
  className = '',
}: {
  children: ReactNode
  columns?: 2 | 3 | 4
  className?: string
}) {
  return (
    <div
      className={cn(
        'grid gap-x-10 gap-y-10',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-2 lg:grid-cols-3',
        columns === 4 && 'sm:grid-cols-2 lg:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function StepRow({
  index,
  title,
  children,
  icon,
  action,
}: {
  /** One-based. Rendered zero-padded, so a run reads 01 02 03 rather than 1 2 3. */
  index: number
  title: ReactNode
  children?: ReactNode
  /** Sits beside the title. Keep it to one glyph. */
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <motion.div {...revealAt(index - 1)} className="border-t border-border pt-6">
      <span className="block font-mono text-sm font-semibold tabular-nums text-foreground/30">
        {String(index).padStart(2, '0')}
      </span>
      <h3 className="mt-4 flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
        {title}
        {icon && <span className="text-foreground/35">{icon}</span>}
      </h3>
      {children && (
        <p className="mt-3 max-w-[42ch] text-[15px] leading-relaxed text-foreground/55">
          {children}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </motion.div>
  )
}

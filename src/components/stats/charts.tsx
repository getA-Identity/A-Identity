import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { cn } from '../../lib/utils'
import { int } from './format'

/**
 * The two chart forms /stats needs, and deliberately no more.
 *
 * Both are picked by the job the data does rather than by what looks impressive. Ranking a
 * handful of named things by magnitude is a horizontal bar list, not a donut: the labels
 * here are long ("reputation_score", "Trading / Finance"), the values are close, and a
 * reader comparing two arcs of a pie is doing work a bar makes free. Splitting one whole
 * into a few ordered states is a single stacked bar with a legend.
 *
 * Colour carries as little as possible. A bar list is one hue for every row, because the
 * bar length already encodes the magnitude and tinting it darker-where-bigger would spend
 * the only free channel restating what the reader can already see. Identity comes from the
 * label beside each bar, never from colour alone, so the charts survive being read in
 * greyscale or by someone with any form of colour blindness.
 */

export type BarRow = {
  key: string
  label: ReactNode
  value: number
  /** What prints at the end of the row, e.g. "303 calls, $0.303". Falls back to the count. */
  valueLabel?: ReactNode
  /** Plain-text hover description, since the marks are divs rather than SVG. */
  title?: string
}

/**
 * A sorted horizontal bar list.
 *
 * Values sit outside the bar end, never inside it: an inline label on a short bar either
 * gets clipped or has to be dropped, and a value that disappears when a number gets small
 * is the wrong kind of chart. Bars are thin, share one hue, and grow from a common left
 * baseline, so row length is the only thing doing the comparing.
 */
export function BarList({
  rows,
  emptyNote,
  className = '',
}: {
  rows: BarRow[]
  /** Shown instead of the bars when there is genuinely nothing to plot. */
  emptyNote?: ReactNode
  className?: string
}) {
  const reduced = useReducedMotion() ?? false
  const sorted = [...rows].sort((a, b) => b.value - a.value)
  const max = sorted.reduce((m, r) => Math.max(m, r.value), 0)

  if (sorted.length === 0 || max === 0) {
    return (
      <p className={cn('rounded-xl border border-border bg-background p-4 text-xs leading-relaxed text-foreground/50', className)}>
        {emptyNote ?? 'Nothing to plot yet. The first record draws the first bar.'}
      </p>
    )
  }

  return (
    <ul className={cn('flex flex-col gap-3.5', className)}>
      {sorted.map((r, i) => (
        <li key={r.key} className="group min-w-0" title={r.title}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-xs text-foreground/70">{r.label}</span>
            <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground/55">
              {r.valueLabel ?? int(r.value)}
            </span>
          </div>
          <div className="mt-1.5 h-2.5 w-full rounded-[3px] bg-foreground/[0.05]">
            <motion.div
              /* Square at the baseline, rounded at the data end: the right edge is where
                 the value is, and rounding both ends would make a short bar read as a pill
                 floating free of the axis. */
              className="h-full rounded-r-[3px] bg-accent/70 transition-colors group-hover:bg-accent"
              initial={reduced ? false : { width: 0 }}
              whileInView={{ width: `${(r.value / max) * 100}%` }}
              viewport={{ once: true, margin: '-60px' }}
              animate={reduced ? { width: `${(r.value / max) * 100}%` } : undefined}
              transition={{ duration: 0.85, ease: EASE_OUT_EXPO, delay: reduced ? 0 : i * 0.06 }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}

export type Segment = {
  key: string
  label: ReactNode
  value: number
  /** Tailwind background class for the fill. Ordered states get an ordered ramp. */
  fill: string
}

/**
 * One whole, split into a few ordered states, as a single stacked bar plus a legend.
 *
 * The segments are separated by a 2px gap in the page surface rather than by a stroke:
 * a border around a mark adds ink that is not data, and neighbouring steps of one ramp
 * read as distinct because of the gap. The legend is always drawn, so the split is
 * readable without matching colours by eye, and a state at zero still gets a legend row
 * saying zero instead of quietly vanishing.
 */
export function SegmentBar({
  segments,
  className = '',
}: {
  segments: Segment[]
  className?: string
}) {
  const reduced = useReducedMotion() ?? false
  const total = segments.reduce((s, x) => s + x.value, 0)
  const drawn = segments.filter((s) => s.value > 0)

  return (
    <div className={cn('min-w-0', className)}>
      <div className="h-3 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
        <motion.div
          className="flex h-full w-full gap-[2px]"
          initial={reduced ? false : { width: '0%' }}
          whileInView={{ width: '100%' }}
          viewport={{ once: true, margin: '-60px' }}
          animate={reduced ? { width: '100%' } : undefined}
          transition={{ duration: 0.9, ease: EASE_OUT_EXPO }}
        >
          {drawn.map((s) => (
            <span
              key={s.key}
              className={cn('h-full first:rounded-l-full last:rounded-r-full', s.fill)}
              style={{ flexGrow: s.value, flexBasis: 0 }}
              title={total > 0 ? `${s.value} of ${total}` : undefined}
            />
          ))}
        </motion.div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5 text-xs">
            <span className={cn('h-2 w-2 shrink-0 rounded-full', s.value > 0 ? s.fill : 'bg-foreground/15')} />
            <span className="text-foreground/55">{s.label}</span>
            <span className={cn('font-semibold tabular-nums', s.value > 0 ? 'text-foreground/75' : 'text-foreground/35')}>
              {int(s.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

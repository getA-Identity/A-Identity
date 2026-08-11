import type { ComponentType, ReactNode } from 'react'
import { useEffect, useRef } from 'react'
import { animate, motion, useInView, useReducedMotion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { cn } from '../../lib/utils'
import { revealAt } from '../ui/section'
import { int } from './format'

/**
 * The /stats visual kit: counters, tiles, meters and the little source labels that keep
 * every figure attached to the endpoint it was read from.
 *
 * Two rules shaped all of it.
 *
 * First, honesty is a layout problem before it is a copy problem. A number with no
 * provenance beside it is a claim; a number with `live GET /api/stats` under it is a
 * receipt. So `SourceTag` is not decoration, it is the reason these tiles are allowed to
 * be large. The same goes for zero: `MetricTile` has an explicit `zeroNote` slot, because
 * a zero that explains itself is a stronger signal than a zero that is quietly padded or
 * hidden, and this product argues exactly that.
 *
 * Second, motion has to survive being turned off. Every animation here is gated on
 * `useReducedMotion`, and the reduced path is not a shorter animation, it is the final
 * state painted immediately. Nothing on this page depends on movement to be readable.
 */

/** Icons arrive as components; typed structurally so this file needs no lucide types. */
export type IconType = ComponentType<{ size?: number | string; className?: string; strokeWidth?: number }>

/** The loading placeholder a value shows before real data exists. Never a fake number. */
export function ValueSkeleton({ className = '' }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-block h-[1em] w-16 animate-pulse rounded bg-foreground/10 align-middle motion-reduce:animate-none',
        className,
      )}
    />
  )
}

/**
 * A number that counts itself up the first time it scrolls into view, then eases to each
 * new value the 60s poll brings in.
 *
 * The text is written imperatively rather than through state so a running count never
 * re-renders the tree around it sixty times a second. Off-screen tiles paint their final
 * value straight away: the count-up is a thing you see arrive, and nothing is gained by
 * animating a number nobody is looking at.
 */
export function CountUp({
  value,
  format,
  className = '',
}: {
  /** null while the fetch is still out; the caller shows a skeleton instead. */
  value: number | null
  format: (n: number) => string
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-60px' })
  const reduced = useReducedMotion() ?? false
  /** The last value actually painted, so a refresh eases from it instead of from zero. */
  const painted = useRef<number | null>(null)
  /**
   * The formatter lives in a ref rather than in the dependency list. Callers pass inline
   * arrows (`(n) => usdFixed(n, 3)`), which are a new identity every render, and this page
   * re-renders each time one of its four independent fetches lands. Depending on `format`
   * would therefore restart every count-up three or four times during the first second.
   */
  const fmt = useRef(format)
  fmt.current = format

  useEffect(() => {
    const el = ref.current
    if (!el || value == null) return

    if (reduced || !inView) {
      el.textContent = fmt.current(value)
      painted.current = value
      return
    }

    const from = painted.current ?? 0
    if (from === value) {
      el.textContent = fmt.current(value)
      return
    }
    const controls = animate(from, value, {
      // First arrival gets the full run; a poll nudging a live counter gets a short one.
      duration: painted.current == null ? 1.1 : 0.45,
      ease: EASE_OUT_EXPO,
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = fmt.current(v)
      },
      onComplete: () => {
        painted.current = value
      },
    })
    return () => controls.stop()
  }, [value, inView, reduced])

  return <span ref={ref} className={className} />
}

/**
 * The one number the page leads with. Exactly one per view, by design: a page with four
 * hero figures has no hero figure.
 */
export function HeroFigure({
  value,
  format,
  label,
  sub,
}: {
  value: number | null
  format: (n: number) => string
  label: ReactNode
  sub?: ReactNode
}) {
  return (
    <div>
      <div className="text-[clamp(3.2rem,11vw,5.5rem)] font-semibold leading-[0.95] tracking-[-0.04em] text-foreground tabular-nums">
        {value == null ? <ValueSkeleton className="w-40" /> : <CountUp value={value} format={format} />}
      </div>
      <div className="mt-3 text-base font-medium text-foreground/70">{label}</div>
      {sub && <div className="mt-1.5 max-w-[46ch] text-sm leading-relaxed text-foreground/50">{sub}</div>}
    </div>
  )
}

/**
 * The provenance chip. Every figure on this page carries one, because "live" is a claim
 * and the endpoint that backs it is the evidence.
 */
export function SourceTag({
  label,
  href,
  className = '',
}: {
  /** The read itself, e.g. "GET /api/stats". */
  label: string
  href?: string
  className?: string
}) {
  const body = (
    <>
      <span className="relative flex h-1.5 w-1.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok/50 motion-reduce:animate-none" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ok" />
      </span>
      <span className="shrink-0 font-semibold uppercase tracking-[0.14em]">live</span>
      <span className="truncate font-mono normal-case tracking-normal text-foreground/45">{label}</span>
      {href && <ArrowUpRight size={11} className="shrink-0 text-foreground/30 transition-colors group-hover/src:text-accent" />}
    </>
  )
  const cls = cn(
    'group/src inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[10px] text-foreground/55',
    href && 'transition-colors hover:border-accent/40 hover:text-foreground/75',
    className,
  )
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  )
}

/** Tone is meaning, never brand: accent is neutral-informational, ok/warn/danger are the
 *  verdict colours the console already uses, and muted is what a zero wears. */
const TONE_CHIP = {
  accent: 'bg-accent/10 text-accent',
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
  muted: 'bg-foreground/[0.06] text-foreground/45',
} as const

export type Tone = keyof typeof TONE_CHIP

/**
 * An icon-led stat tile.
 *
 * `zeroNote` is the interesting prop. Several counters on this page are genuinely zero,
 * and the tile's job in that case is not to look broken or to look full, it is to say why
 * the zero is there. A tile that has explained its own zero is doing more work than a tile
 * showing a number nobody can reproduce.
 */
export function MetricTile({
  icon: Icon,
  label,
  value,
  format,
  note,
  zeroNote,
  tone = 'accent',
  className = '',
}: {
  icon: IconType
  label: ReactNode
  value: number | null
  format: (n: number) => string
  /** The line under the number: what it counts. */
  note?: ReactNode
  /** Replaces `note` when the value is exactly zero. */
  zeroNote?: ReactNode
  tone?: Tone
  className?: string
}) {
  const isZero = value === 0
  const caption = isZero && zeroNote ? zeroNote : note
  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ type: 'spring', stiffness: 400, damping: 28 }}
      className={cn(
        'flex min-w-0 flex-col rounded-2xl border border-border bg-card p-4 transition-colors hover:border-accent/30 sm:p-5',
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', TONE_CHIP[isZero ? 'muted' : tone])}>
          <Icon size={15} strokeWidth={2} />
        </span>
        <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/45">
          {label}
        </span>
      </div>
      <div
        className={cn(
          'mt-3 text-[clamp(1.35rem,4.4vw,2.1rem)] font-semibold leading-none tracking-[-0.03em] tabular-nums',
          isZero ? 'text-foreground/35' : 'text-foreground',
        )}
      >
        {value == null ? <ValueSkeleton className="w-20" /> : <CountUp value={value} format={format} />}
      </div>
      {caption && (
        <p className={cn('mt-2 text-xs leading-relaxed', isZero && zeroNote ? 'text-foreground/45' : 'text-foreground/50')}>
          {caption}
        </p>
      )}
    </motion.div>
  )
}

/**
 * A ratio against a limit, drawn as a meter rather than as a two-slice pie.
 *
 * The track is a lighter step of the fill's own hue so the state reads across the whole
 * bar, and the fill grows from zero the first time the meter is seen. At zero the meter
 * stays an empty track and the number beside it says so.
 */
export function Meter({
  label,
  value,
  max,
  tone = 'accent',
  suffix,
  delay = 0,
}: {
  label: ReactNode
  value: number | null
  max: number | null
  tone?: Tone
  /** Trails the "n of m" readout, e.g. "verified". */
  suffix?: ReactNode
  delay?: number
}) {
  const reduced = useReducedMotion() ?? false
  const known = value != null && max != null && max > 0
  const pct = known ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  const fill = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', muted: 'bg-foreground/30' }[tone]
  const track = { accent: 'bg-accent/12', ok: 'bg-ok/12', warn: 'bg-warn/12', danger: 'bg-danger/12', muted: 'bg-foreground/[0.08]' }[tone]

  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-xs font-medium text-foreground/60">{label}</span>
        <span className="shrink-0 text-xs tabular-nums text-foreground/45">
          {value == null || max == null ? (
            <ValueSkeleton className="w-12" />
          ) : (
            <>
              <span className={cn('font-semibold', value === 0 ? 'text-foreground/40' : 'text-foreground/75')}>
                {int(value)}
              </span>
              <span> of {int(max)}</span>
              {suffix ? <span> {suffix}</span> : null}
            </>
          )}
        </span>
      </div>
      <div className={cn('mt-2 h-2 w-full overflow-hidden rounded-full', track)}>
        <motion.div
          className={cn('h-full rounded-full', fill)}
          initial={reduced ? false : { width: 0 }}
          whileInView={{ width: `${pct}%` }}
          viewport={{ once: true, margin: '-60px' }}
          animate={reduced ? { width: `${pct}%` } : undefined}
          transition={{ duration: 0.9, ease: EASE_OUT_EXPO, delay: reduced ? 0 : delay }}
        />
      </div>
    </div>
  )
}

/**
 * A group of tiles under one heading, with the endpoint they all came from pinned to the
 * header. One panel, one source: a panel that mixes reads without saying which is which is
 * how a page starts lying by accident.
 */
export function StatPanel({
  icon: Icon,
  title,
  caption,
  source,
  art,
  index = 0,
  surface = 'card',
  className = '',
  children,
}: {
  icon: IconType
  title: ReactNode
  caption?: ReactNode
  source?: ReactNode
  /** Brand still for the panel corner. Decoration over copy that already says it, so it
   *  is dropped entirely on small screens rather than shrunk. */
  art?: ReactNode
  /** Feeds the stagger so panels arrive in reading order. */
  index?: number
  /** `background` for a panel sitting on a card-surface section, so it still reads as raised. */
  surface?: 'card' | 'background'
  className?: string
  children: ReactNode
}) {
  return (
    <motion.section
      {...revealAt(index % 2)}
      className={cn(
        'flex flex-col rounded-3xl border border-border p-5 sm:p-8',
        surface === 'card' ? 'bg-card' : 'bg-background',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <Icon size={17} strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold tracking-tight text-foreground">{title}</h2>
            {caption && <p className="mt-1 max-w-[62ch] text-sm leading-relaxed text-foreground/55">{caption}</p>}
          </div>
        </div>
        <div className="flex max-w-full flex-col items-end gap-2">
          {art && <div className="hidden sm:block">{art}</div>}
          {source}
        </div>
      </div>
      <div className="mt-6 flex-1">{children}</div>
    </motion.section>
  )
}

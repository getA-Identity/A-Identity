import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * A slice of the product, shown as itself.
 *
 * The strongest thing a landing page can put next to a claim is the interface that makes it
 * true, and the reason to build that as a component rather than as a screenshot is that a
 * screenshot goes stale the day after it is taken, cannot be themed, and is a blurry image
 * on a retina display. This renders in the same tokens as the real console, so it is right
 * in both themes and at every width by construction.
 *
 * It is deliberately not interactive. A control that looks live and does nothing is worse
 * than a still, so everything here is `aria-hidden` and nothing takes focus.
 */
export function ProductMock({
  title,
  meta,
  children,
  className = '',
}: {
  title: ReactNode
  /** The quiet line under the title, e.g. a masked card number or a balance. */
  meta?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'w-full select-none rounded-3xl border border-border bg-card p-5 shadow-[0_24px_60px_-24px_rgba(16,24,40,0.28)] sm:p-6',
        className,
      )}
    >
      <div className="px-1">
        <p className="text-base font-semibold tracking-tight text-foreground">{title}</p>
        {meta && <p className="mt-1 font-mono text-xs text-foreground/40">{meta}</p>}
      </div>
      <div className="mt-4 flex flex-col gap-2.5">{children}</div>
    </div>
  )
}

/** A labelled row inside the mock. `value` is right-aligned, the way the console renders it. */
export function MockRow({
  label,
  sub,
  value,
  leading,
  tone,
}: {
  label: ReactNode
  sub?: ReactNode
  value?: ReactNode
  /** An icon or avatar at the start of the row. */
  leading?: ReactNode
  tone?: 'default' | 'accent'
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl border px-4 py-3.5',
        tone === 'accent'
          ? 'border-accent/25 bg-accent/[0.06]'
          : 'border-border bg-background/50',
      )}
    >
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{label}</span>
        {sub && <span className="mt-0.5 block truncate text-xs text-foreground/45">{sub}</span>}
      </span>
      {value && <span className="shrink-0">{value}</span>}
    </div>
  )
}

/** The pill a value sits in, so numbers in a mock line up the way they do in the console. */
export function MockValue({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-xl bg-foreground/[0.06] px-3 py-1.5 font-mono text-sm font-semibold tabular-nums text-foreground">
      {children}
    </span>
  )
}

/** A switch, drawn rather than rendered: it never toggles and never takes focus. */
export function MockToggle({ on = false }: { on?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors',
        on ? 'bg-accent' : 'bg-foreground/15',
      )}
    >
      <span
        className={cn(
          'h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
          on && 'translate-x-5',
        )}
      />
    </span>
  )
}

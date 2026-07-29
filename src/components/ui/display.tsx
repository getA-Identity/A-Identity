import type { ElementType, ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * The heading scale.
 *
 * What made the landing read as amateur was not the typeface, it was that every section
 * heading was roughly the same size. Nothing announced itself as more important than
 * anything else, so the page had no hierarchy and the eye had nowhere to land. Three steps
 * with real distance between them fixes that, and it costs no brand change: this uses the
 * same `--font-heading` the site already ships.
 *
 * The sizes are fluid rather than breakpoint-stepped, so a heading is proportionate at every
 * width instead of snapping between two wrong sizes. Tracking tightens as size grows, which
 * is what large type needs and small type does not.
 */
const SIZES = {
  /** Once per page. The hero, or the one thing a page is about. */
  display: 'text-[clamp(2.6rem,6.4vw,4.6rem)] leading-[0.98] tracking-[-0.035em]',
  /** Opens a section. */
  section: 'text-[clamp(2rem,4.2vw,3.1rem)] leading-[1.04] tracking-[-0.03em]',
  /** Inside a section, above a group. */
  sub: 'text-[clamp(1.3rem,2.4vw,1.75rem)] leading-[1.15] tracking-[-0.02em]',
} as const

export function DisplayHeading({
  children,
  size = 'section',
  as,
  className = '',
  id,
}: {
  children: ReactNode
  size?: keyof typeof SIZES
  /** Defaults to h1 for display and h2 otherwise. Set it when the outline needs something else. */
  as?: ElementType
  className?: string
  id?: string
}) {
  const Tag = (as ?? (size === 'display' ? 'h1' : size === 'section' ? 'h2' : 'h3')) as ElementType
  return (
    <Tag
      id={id}
      className={cn('font-bold text-foreground', SIZES[size], className)}
      style={{ fontFamily: 'var(--font-heading)', textWrap: 'balance' }}
    >
      {children}
    </Tag>
  )
}

/**
 * The small tracked label above a heading. Carries the section's category, never a sentence:
 * if it needs a verb it belongs in the heading.
 */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'text-xs font-semibold uppercase tracking-[0.18em] text-foreground/40',
        className,
      )}
    >
      {children}
    </p>
  )
}

/**
 * The paragraph under a heading. Capped at a readable measure rather than the container
 * width, because a lede that runs the full 1100px is a lede nobody finishes.
 */
export function Lede({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        'max-w-[54ch] text-lg leading-relaxed text-foreground/55 sm:text-xl',
        className,
      )}
    >
      {children}
    </p>
  )
}

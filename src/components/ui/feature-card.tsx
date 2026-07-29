import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { revealAt } from './section'
import { cn } from '../../lib/utils'

/**
 * A large card that leads with its claim and shows the thing underneath.
 *
 * The proportions are the argument. Copy sits in the top third at a short measure, and the
 * bottom two thirds belong to whatever proves it, running to the card's edges rather than
 * sitting inside another inset. Art that is politely padded away from the border always
 * looks like an illustration dropped into a slot; art that is bled looks like the card is
 * made of it.
 *
 * `tone` only shifts the surface, never the text colour. The palette stays where it is.
 */
const TONE = {
  default: 'border-border bg-card',
  /** A faint accent wash, for the card that carries the section. */
  accent: 'border-accent/20 bg-gradient-to-b from-accent/[0.07] to-card',
  /** Inverted, for a card that should stop the scroll. */
  contrast: 'border-transparent bg-foreground text-background',
} as const

export function FeatureCards({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-5 md:grid-cols-2', className)}>{children}</div>
}

export function FeatureCard({
  title,
  children,
  art,
  tone = 'default',
  index = 0,
  align = 'center',
  className = '',
}: {
  title: ReactNode
  children?: ReactNode
  /** Fills the lower portion, bled to the card edges. */
  art?: ReactNode
  tone?: keyof typeof TONE
  /** Position in its row, used only to stagger the reveal. */
  index?: number
  align?: 'left' | 'center'
  className?: string
}) {
  const inverted = tone === 'contrast'
  return (
    <motion.article
      {...revealAt(index)}
      className={cn(
        'flex flex-col overflow-hidden rounded-3xl border',
        TONE[tone],
        className,
      )}
    >
      <div className={cn('px-8 pt-10 sm:px-10 sm:pt-12', align === 'center' && 'text-center')}>
        <h3
          className={cn(
            'text-[clamp(1.5rem,2.6vw,2rem)] font-bold leading-[1.1] tracking-[-0.025em]',
            inverted ? 'text-background' : 'text-foreground',
          )}
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          {title}
        </h3>
        {children && (
          <p
            className={cn(
              'mt-4 text-[15px] leading-relaxed sm:text-base',
              align === 'center' ? 'mx-auto max-w-[46ch]' : 'max-w-[46ch]',
              inverted ? 'text-background/70' : 'text-foreground/55',
            )}
          >
            {children}
          </p>
        )}
      </div>

      {art && <div className="relative mt-10 flex-1 overflow-hidden">{art}</div>}
      {!art && <div className="pb-10 sm:pb-12" />}
    </motion.article>
  )
}

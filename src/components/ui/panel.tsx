import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

/**
 * The console's card surface, which fourteen panels had each been spelling out by hand.
 *
 * The class strings here are copied from what those panels already rendered, not redesigned,
 * so adopting this changes nothing on screen. `border-foreground/10` rather than
 * `border-border` for the same reason: the two resolve slightly differently in dark mode and
 * the panels were using the former.
 *
 * Tones exist because a few panels deliberately signal what they are. Autopilot is accent
 * because it is the thing that spends without asking; x402 is brand purple because it is the
 * protocol surface. Everything else is `default` and should stay that way, since a card that
 * shouts about itself stops meaning anything once every card does it.
 */
const panelVariants = cva('rounded-2xl', {
  variants: {
    tone: {
      default: 'border border-foreground/10 bg-card',
      accent: 'border-2 border-accent/30 bg-accent/[0.03]',
      brand: 'border border-[#7342E2]/20 bg-[#7342E2]/[0.04]',
      circle: 'border border-[#2775CA]/25 bg-[#2775CA]/[0.05]',
      warn: 'border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10',
      success: 'border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/50 dark:bg-emerald-500/10',
    },
    padding: {
      default: 'p-6',
      sm: 'p-5',
      none: '',
    },
  },
  defaultVariants: { tone: 'default', padding: 'default' },
})

export interface PanelProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof panelVariants> {}

export const Panel = React.forwardRef<HTMLDivElement, PanelProps>(
  ({ className, tone, padding, ...props }, ref) => (
    <div ref={ref} className={cn(panelVariants({ tone, padding, className }))} {...props} />
  ),
)
Panel.displayName = 'Panel'

/**
 * A panel's opening line. `action` is the slot every panel was filling with a right-aligned
 * button or status pill.
 */
export function PanelHeader({
  title,
  description,
  action,
  className = '',
}: {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h3 className="text-sm font-bold tracking-tight text-foreground">{title}</h3>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-foreground/50">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export { panelVariants }

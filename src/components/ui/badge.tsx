import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * The badge language shared by the console and the explorer.
 *
 * Two rules shaped it.
 *
 * First, tone is meaning, never decoration. Every variant paints from the semantic
 * tokens (ok / warn / danger / usdc / accent) rather than from a raw palette class, so a
 * badge means the same thing on every screen and survives the theme flip. The old
 * variants were emerald / amber / red literals with a `dark:` override bolted on, which
 * is how a "success" pill on one screen ends up a different green from the "settled"
 * pill on the next.
 *
 * Second, a badge is a pill with a ring, not a floating block of tinted text. The ring is
 * what separates a soft 10% tint from the card behind it; without it the pale states
 * (neutral, success on a white card) read as a smudge rather than as a token.
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold leading-none ring-1 ring-inset [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-accent/10 text-accent ring-accent/20',
        neutral: 'bg-foreground/[0.06] text-foreground/70 ring-foreground/10',
        outline: 'bg-transparent text-foreground/70 ring-foreground/20',
        success: 'bg-ok/10 text-ok ring-ok/25',
        warning: 'bg-warn/12 text-warn ring-warn/30',
        info: 'bg-usdc/10 text-usdc ring-usdc/25',
        danger: 'bg-danger/10 text-danger ring-danger/30',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export type Verdict = 'ALLOW' | 'WARN' | 'DENY'

/**
 * The three verdicts, drawn so colour is never the only thing carrying the answer.
 *
 * A verdict is a decision about money, so it has to survive being read by someone who
 * cannot separate the green from the red, and by someone reading a greyscale print of a
 * screenshot. Three channels carry it, and any one of them is enough on its own:
 *
 *   1. The WORD. Always rendered, never abbreviated to an icon, never truncated.
 *   2. The GLYPH. Three different shields: a tick, an exclamation, a cross. Different
 *      silhouettes, not the same shape in three hues.
 *   3. The WEIGHT. The ring steps up with severity (30 / 45 / 60), so in greyscale the
 *      three read as increasingly outlined.
 *
 * The hue is the fourth channel and the only one that is optional.
 */
const VERDICT_STYLE: Record<Verdict, { Icon: typeof ShieldCheck; cls: string }> = {
  ALLOW: { Icon: ShieldCheck, cls: 'bg-ok/10 text-ok ring-ok/30' },
  WARN: { Icon: ShieldAlert, cls: 'bg-warn/12 text-warn ring-warn/45' },
  DENY: { Icon: ShieldX, cls: 'bg-danger/12 text-danger ring-danger/60' },
}

const VERDICT_SIZE = {
  sm: { box: 'gap-1.5 px-2.5 py-1 text-[11px]', icon: 12 },
  md: { box: 'gap-2 px-3.5 py-1.5 text-[13px]', icon: 15 },
} as const

/**
 * The verdict pill. `sm` is the table cell, `md` is the one a payer acts on.
 *
 * The aria-label spells the decision out rather than leaving a screen reader to announce
 * a bare uppercase word next to an unlabelled icon.
 */
export function VerdictBadge({
  verdict,
  size = 'sm',
  className = '',
}: {
  verdict: Verdict
  size?: keyof typeof VERDICT_SIZE
  className?: string
}) {
  const { Icon, cls } = VERDICT_STYLE[verdict]
  const s = VERDICT_SIZE[size]
  return (
    <span
      aria-label={`Verdict: ${verdict}`}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full font-bold uppercase leading-none tracking-[0.08em] ring-1 ring-inset',
        cls,
        s.box,
        className,
      )}
    >
      <Icon size={s.icon} strokeWidth={2.4} aria-hidden="true" />
      {verdict}
    </span>
  )
}

export { Badge, badgeVariants }

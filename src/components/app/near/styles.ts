/**
 * Class strings the NEAR console's components share. Kept out of the component files so each
 * of those exports components only (the react-refresh rule), and so a tone means the same tint
 * on every card. Text never takes a tone color here; see ui.tsx for why.
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted'

/** The tinted frame for a tone, for a callout or a headline card. */
export const TONE_FRAME: Record<Tone, string> = {
  ok: 'border-ok/35 bg-ok/[0.06]',
  warn: 'border-warn/40 bg-warn/[0.08]',
  danger: 'border-danger/35 bg-danger/[0.07]',
  accent: 'border-accent/30 bg-accent/[0.05]',
  muted: 'border-border bg-foreground/[0.03]',
}

/** An icon in a tone. Icons are graphics, held to 3:1, which every tone clears on the card. */
export const TONE_ICON: Record<Tone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  accent: 'text-accent',
  muted: 'text-foreground/70',
}

export const BUTTON_QUIET =
  'inline-flex items-center justify-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-xs font-semibold text-foreground hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

export const INPUT =
  'mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none placeholder:text-foreground/65 focus:border-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'

/**
 * Small pieces the NEAR vault console repeats, in the console's own look (the Arc and Stellar
 * vault pages: rounded cards on bg-card, small uppercase labels, mono for ids).
 *
 * One rule shaped them: text stays in the foreground color, and tone travels in the tint, the
 * ring and the icon. The verdict colors (ok, warn, danger) are tuned for fills and icons; as
 * 11px text on a white card the light theme's green and amber fall under 4.5:1, so they never
 * carry words here. Muted text is never fainter than foreground/70, which clears 4.5:1 on the
 * card and the page ground in both themes.
 */
import { Fragment, useState, type ReactNode } from 'react'
import { Check, Copy, ExternalLink as ExternalIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { Tone } from './styles'

const PILL: Record<Tone, string> = {
  ok: 'bg-ok/10 ring-ok/40',
  warn: 'bg-warn/15 ring-warn/50',
  danger: 'bg-danger/10 ring-danger/50',
  accent: 'bg-accent/10 ring-accent/35',
  muted: 'bg-foreground/[0.05] ring-foreground/15',
}

const DOT: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  accent: 'bg-accent',
  muted: 'bg-foreground/45',
}

/** A status token: words in the foreground color, tone in the tint, the ring and the dot. */
export function Pill({ tone, children, className, icon }: { tone: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold leading-5 text-foreground ring-1 ring-inset', PILL[tone], className)}>
      {icon ?? <span className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} aria-hidden="true" />}
      {children}
    </span>
  )
}

export function Card({
  title,
  icon,
  aside,
  children,
  className,
  label,
}: {
  title: ReactNode
  icon?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  /** The section's accessible name, when the title is not plain text. */
  label?: string
}) {
  return (
    <section aria-label={label ?? (typeof title === 'string' ? title : undefined)} className={cn('min-w-0 rounded-2xl border border-border bg-card p-4 sm:p-5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          {icon && (
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-foreground/[0.05] text-foreground/80" aria-hidden="true">
              {icon}
            </span>
          )}
          {title}
        </h3>
        {aside}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('text-[11px] font-semibold uppercase tracking-wide text-foreground/70', className)}>{children}</span>
}

/** One labelled value in a definition list. */
export function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt>
        <Label>{label}</Label>
      </dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  )
}

/**
 * An account id or hash that wraps rather than pushing the page sideways on a phone: it may break
 * after each dot first (vault.aid-demo-owner. | testnet), and anywhere only when a part is longer
 * than the line, as a 64-character implicit account or a token id is.
 */
export function IdText({ id }: { id: string }) {
  const parts = id.split('.')
  return (
    <span>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              .<wbr />
            </>
          )}
        </Fragment>
      ))}
    </span>
  )
}

/** Monospace for ids and hashes; a plain string child gets IdText's line breaks. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('font-mono text-xs text-foreground [overflow-wrap:anywhere]', className)}>
      {typeof children === 'string' ? <IdText id={children} /> : children}
    </span>
  )
}

/** An external link that clears contrast in both themes: foreground text, accent underline. */
export function ExtLink({ href, children, className }: { href: string | null; children: ReactNode; className?: string }) {
  if (!href) return <>{children}</>
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'inline-flex items-center gap-1 font-semibold text-foreground underline decoration-accent/60 decoration-2 underline-offset-2 hover:decoration-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
      <ExternalIcon size={11} aria-hidden="true" />
    </a>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => undefined,
        )
      }
      aria-label={copied ? 'Copied' : `${label}: ${text}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-foreground/80 transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check size={11} className="text-ok" aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      {copied ? 'Copied' : label}
    </button>
  )
}

/** A bar for spent against a cap. `max` 0 means no cap, and the bar says so instead of filling. */
export function Meter({ value, max, label }: { value: bigint; max: bigint; label: string }) {
  if (max === 0n) return <div className="mt-2 h-1.5 rounded-full bg-foreground/[0.08]" aria-hidden="true" />
  const pct = Number((value * 10_000n) / max) / 100
  const shown = Math.min(100, Math.max(pct > 0 ? 2 : 0, pct))
  const tone = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warn' : 'bg-ok'
  return (
    <div
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(pct))}
    >
      <div className={cn('h-full rounded-full transition-[width] duration-500', tone)} style={{ width: `${shown}%` }} />
    </div>
  )
}

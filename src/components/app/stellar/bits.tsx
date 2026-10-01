/**
 * Small pieces the Stellar vault panel repeats: a copy button, a toned chip, a labelled
 * value, and a titled group of values. Kept together because none of them earns a file.
 */
import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '../../../lib/utils'

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => undefined,
    )
  }
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : `${label}: ${text}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold text-foreground/65 transition-colors hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {copied ? <Check size={11} className="text-ok" /> : <Copy size={11} />}
      {copied ? 'Copied' : label}
    </button>
  )
}

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted'

const TONE: Record<Tone, string> = {
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
  accent: 'bg-accent/10 text-accent',
  muted: 'bg-foreground/[0.06] text-foreground/65',
}

export function Chip({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold', TONE[tone], className)}>
      {children}
    </span>
  )
}

/** One labelled value. `wide` lets a long value (an address) take the full row. */
export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-foreground">{children}</dd>
    </div>
  )
}

/** A titled block of values, with the read stamp that covers all of them. */
export function Group({ title, stamp, children }: { title: string; stamp?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-4 sm:p-5" aria-label={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {stamp}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** A monospace address that wraps instead of pushing the page sideways on a phone. */
export function Mono({ children }: { children: ReactNode }) {
  return <span className="break-all font-mono text-xs text-foreground/85">{children}</span>
}

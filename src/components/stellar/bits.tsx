import { useState } from 'react'
import { ArrowUpRight, Check, Copy } from 'lucide-react'
import { addressUrl, type PasskeyNetwork } from '../../lib/stellar/passkey'

/**
 * The small pieces every card on /stellar shares: a status chip, a transaction link, a full
 * hash that copies, and an address that links to the right explorer for the network in view.
 * Semantic tokens only, so both themes read them.
 */

export type Tone = 'ok' | 'warn' | 'danger' | 'muted' | 'accent'

export function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'bg-ok/10 text-ok'
      : tone === 'warn'
        ? 'bg-warn/10 text-warn'
        : tone === 'danger'
          ? 'bg-danger/10 text-danger'
          : tone === 'accent'
            ? 'bg-accent/10 text-accent'
            : 'bg-foreground/[0.06] text-foreground/60'
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] ${cls}`}>
      {children}
    </span>
  )
}

export function TxLink({ hash, url, label = 'transaction' }: { hash: string; url: string; label?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1 font-mono text-xs text-accent underline-offset-2 hover:underline"
    >
      <span className="truncate">
        {label} {hash.slice(0, 10)}
      </span>
      <ArrowUpRight size={12} className="shrink-0" />
    </a>
  )
}

/** A whole hash, wrapped rather than truncated, with a copy button and its explorer link. */
export function FullHash({ hash, url, label = 'Transaction' }: { hash: string; url: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard refused; the hash is selectable text right beside the button */
    }
  }
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-foreground/45">{label}</div>
      <div className="mt-0.5 flex items-start gap-2">
        <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground/80">{hash}</code>
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-semibold text-foreground/70 hover:border-accent/50"
          aria-label={`Copy ${label.toLowerCase()} hash`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <a href={url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-accent underline-offset-2 hover:underline">
        Open on stellar.expert <ArrowUpRight size={12} />
      </a>
    </div>
  )
}

/** One address, readable on a phone: never wider than its card, always linked. */
export function AddressLink({ net, value, label, note }: { net: PasskeyNetwork; value: string; label: string; note?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-foreground/45">
        {label}
        {note ? <span className="ml-2 normal-case tracking-normal">{note}</span> : null}
      </div>
      <a
        href={addressUrl(net, value)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-0.5 block break-all font-mono text-xs text-accent underline-offset-2 hover:underline"
      >
        {value}
      </a>
    </div>
  )
}

export const BTN =
  'inline-flex items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100'
export const BTN_QUIET =
  'inline-flex items-center justify-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-xs font-semibold text-foreground/75 transition-colors hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-50'
export const INPUT =
  'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-accent'
export const LABEL = 'text-[11px] font-semibold uppercase tracking-wide text-foreground/45'

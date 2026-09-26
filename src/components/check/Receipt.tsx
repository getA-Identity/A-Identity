import type { ReactNode } from 'react'
import { ArrowUpRight, Loader2 } from 'lucide-react'
import { accountUrl, txUrl } from '../../lib/algorand/x402pay'
import type { Stop } from '../../lib/algorand/purchase'
import { short } from '../../lib/format'
import { cn } from '../../lib/utils'
import { sentence } from './format'

export function TxLink({ tx, children }: { tx: string; children?: ReactNode }) {
  return (
    <a
      href={txUrl(tx)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 break-all font-mono font-semibold text-accent hover:underline"
    >
      {children ?? short(tx, 6)}
      <ArrowUpRight size={13} className="shrink-0" />
    </a>
  )
}

export function AccountLink({ address }: { address: string }) {
  return (
    <a
      href={accountUrl(address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className="font-mono text-foreground underline decoration-foreground/25 underline-offset-2 hover:text-accent hover:decoration-accent/50"
    >
      {address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address}
    </a>
  )
}

/**
 * One line per ending, each saying what happened to the money. Only true sentences.
 * `noun` is what was being bought: "report" for the detailed report, "answer" for the rest.
 */
export function StopText({ stop, noun = 'report' }: { stop: Stop; noun?: 'report' | 'answer' }) {
  switch (stop.kind) {
    case 'cancelled':
      return <>Payment cancelled. Nothing was charged.</>
    case 'refusal':
      return <>{sentence(stop.text)} Nothing was charged.</>
    case 'wallet':
      return (
        <>
          {stop.wallet}: {sentence(stop.text)} Nothing was charged.
        </>
      )
    case 'before':
      return <>Something went wrong before paying. Nothing was charged.</>
    case 'refused':
      return <>The payment was refused: {stop.reason}. Nothing was charged.</>
    case 'unavailable':
      return <>The {noun} could not be made right now. Nothing was charged.</>
    case 'pending':
      return (
        <>
          Your payment was sent but is not confirmed yet. Check it here: <TxLink tx={stop.tx} />. Do not pay again.
        </>
      )
    case 'unknown':
      return (
        <>
          We could not confirm what happened. Check your wallet before trying again. Your payment, if it went through:{' '}
          <TxLink tx={stop.tx} />
        </>
      )
    case 'paid_unreadable':
      return (
        <>
          Your payment went through, but the {noun} could not be shown. Receipt: <TxLink tx={stop.tx} />
        </>
      )
  }
}

/** Where a payment is, once a wallet is known: checking its USDC, waiting for the signature, confirming. */
export function PayProgress({
  step,
  price,
  onCancel,
  className,
}: {
  step: { s: 'checking' | 'signing' | 'confirming'; from: string; wallet: string }
  price: string
  onCancel: () => void
  className?: string
}) {
  return (
    <div className={cn('rounded-2xl border border-border bg-background/60 px-4 py-3', className)} role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
        <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
        {step.s === 'checking' ? 'Checking the USDC in your wallet...' : step.s === 'signing' ? `Approve the ${price} payment in your wallet` : 'Confirming on Algorand...'}
      </p>
      <p className="mt-1 text-xs text-foreground/55">
        Paying from <span className="font-mono">{short(step.from, 4)}</span> in {step.wallet}.
        {step.s === 'confirming' && ' This can take up to a minute. Keep this page open.'}
      </p>
      {step.s === 'signing' && (
        <button type="button" onClick={onCancel} className="mt-2 text-xs font-semibold text-foreground/70 underline underline-offset-2 hover:text-foreground">
          Cancel
        </button>
      )}
    </div>
  )
}

/** The box a stop is shown in: amber when money may be out, quiet otherwise. */
export function StopBox({ stop, noun, className, children }: { stop: Stop; noun?: 'report' | 'answer'; className?: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        // A refusal reason can carry a 58-character address; it wraps instead of widening the page.
        'break-words rounded-2xl border px-4 py-3 text-sm leading-relaxed [overflow-wrap:anywhere]',
        stop.kind === 'pending' || stop.kind === 'unknown' ? 'border-warn/35 bg-warn/[0.08] text-foreground' : 'border-border bg-background/60 text-foreground/80',
        className,
      )}
    >
      <StopText stop={stop} noun={noun} />
      {children}
    </div>
  )
}

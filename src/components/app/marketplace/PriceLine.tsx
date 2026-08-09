/**
 * Price lead for marketplace cards and rows: the real starting price when the
 * agent lists services, the honest "Quote per task" fallback when not.
 * Extracted verbatim from Marketplace.tsx; pure props component, must keep
 * the exact span markup.
 */
import { cheapestService, fmtUsd, type MarketAgent } from './types'

/** Price lead: real starting price when the agent lists services, honest fallback when not. */
export function PriceLine({ a, className = '' }: { a: MarketAgent; className?: string }) {
  const c = cheapestService(a)
  if (!c)
    return <span className={`text-sm font-semibold text-foreground/55 ${className}`}>Quote per task</span>
  return (
    <span className={`text-sm font-bold tabular-nums text-foreground ${className}`}>
      from ${fmtUsd(c.priceUsd)}
      {c.unit && <span className="font-medium text-foreground/50"> per {c.unit}</span>}
    </span>
  )
}

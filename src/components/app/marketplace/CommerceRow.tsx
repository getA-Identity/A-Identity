/**
 * Social proof row for marketplace cards and rows: stars, positive share,
 * completed sales. Extracted verbatim from Marketplace.tsx; pure props
 * component, must keep the exact div markup and only ever state claims the
 * backend holds.
 */
import { Stars } from './FeaturedCarousel'
import type { MarketAgent } from './types'

/** Social proof row: stars, positive share, completed sales. Only claims we hold. */
export function CommerceRow({ a, className = '' }: { a: MarketAgent; className?: string }) {
  const pct = a.feedbackBreakdown?.positivePct ?? null
  const sold = a.soldCount ?? 0
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      <Stars avg={a.feedback?.avg ?? null} count={a.feedback?.count ?? 0} />
      {pct != null && <span className="text-[11px] font-semibold text-ok">{pct}% positive</span>}
      {sold > 0 && (
        <span className="text-[11px] font-medium tabular-nums text-foreground/55">
          {sold} sold
        </span>
      )}
    </div>
  )
}

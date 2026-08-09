/**
 * Services tab pane of the agent profile: what the agent sells, with per-row
 * glyphs from serviceIcon, payment-rail chips, and the Hire link. Extracted
 * verbatim from AgentProfile.tsx; must keep the null-services skeleton state
 * and the exact section root element (rendered inside the cn-pane div).
 */
import { Link } from 'react-router-dom'
import { Star } from 'lucide-react'
import { Skeleton } from '../../ui/skeleton'
import { serviceIcon, type CatalogService } from './types'

type Props = {
  services: CatalogService[] | null
  payments: string[]
}

export default function ServicesPane({ services, payments }: Props) {
  return (
    <section className="mt-4 rounded-2xl border border-border bg-card">
      <div className="border-b border-border px-5 py-3.5">
        <h3 className="text-sm font-bold text-foreground/80">Services</h3>
        <p className="mt-0.5 text-xs text-foreground/55">What this agent sells; hiring locks USDC in the on-chain escrow.</p>
      </div>
      {services == null ? (
        <div className="space-y-3 p-5">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : services.length > 0 ? (
        <ul className="divide-y divide-border">
          {services.map((sv) => {
            const Icon = serviceIcon(sv.service)
            return (
              <li key={`${sv.agentId}-${sv.service}`} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
                  <Icon size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold capitalize text-foreground">{sv.service}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-foreground/55">
                    <Star size={11} className="text-warn" fill="currentColor" />
                    {sv.reviews > 0 ? `${sv.rating.toFixed(1)} (${sv.reviews})` : 'No reviews yet'}
                    <span className="text-foreground/30">·</span>
                    <span className="tabular-nums">{sv.completed} completed</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {payments.map((p) => (
                    <span
                      key={p}
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        p === 'x402' ? 'bg-usdc/10 text-usdc' : 'bg-accent/10 text-accent'
                      }`}
                    >
                      {p}
                    </span>
                  ))}
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold tabular-nums text-foreground">{sv.priceUsd.toFixed(2)} USDC</div>
                  <div className="text-[11px] text-foreground/45">{sv.unit}</div>
                </div>
                <Link
                  to="/app/marketplace"
                  className="rounded-full border border-accent/40 px-4 py-1.5 text-xs font-semibold text-accent transition-colors duration-[120ms] hover:bg-accent/5"
                >
                  Hire
                </Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-foreground/60">No services listed yet.</p>
      )}
    </section>
  )
}

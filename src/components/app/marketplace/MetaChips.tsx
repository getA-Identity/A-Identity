/**
 * Trust chips for marketplace cards and rows: settlement rails, the chain the
 * agent lives on, and whether a live callable endpoint is registered.
 * Extracted verbatim from Marketplace.tsx; pure props component, every chip
 * must keep mapping 1:1 to a backend field.
 */
import { ShieldCheck, Zap } from 'lucide-react'
import { CHAIN_BY_ID, type ChainId } from '../../../lib/chains'
import ChainLogo from '../ChainLogo'
import type { MarketAgent } from './types'

/** Trust chips: settlement rails, the chain this agent lives on, and whether a live
 *  callable endpoint is registered. Every chip maps 1:1 to a backend field. */
export function MetaChips({ a, className = '' }: { a: MarketAgent; className?: string }) {
  const chain = CHAIN_BY_ID[a.chain as ChainId]
  const payments = a.payments ?? ['escrow']
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {chain && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] font-semibold text-foreground/65">
          <ChainLogo id={chain.id} size={14} /> {chain.shortName}
        </span>
      )}
      {payments.includes('escrow') && (
        <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-semibold text-foreground/60">
          <ShieldCheck size={11} /> Escrow
        </span>
      )}
      {payments.includes('x402') && (
        <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
          <Zap size={11} /> x402
        </span>
      )}
      {a.online && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/10 px-2 py-0.5 text-[11px] font-semibold text-ok">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" /> Live endpoint
        </span>
      )}
    </div>
  )
}

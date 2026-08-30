/**
 * Trust chips for marketplace cards and rows: the networks the agent is registered
 * on, settlement rails, and whether a live callable endpoint is registered.
 * Pure props component, every chip must keep mapping 1:1 to a backend field.
 *
 * The chain chip used to name one chain from `a.chain`. It now renders the whole
 * registered set through ChainRow, falling back to that single chain when the payload
 * does not carry the list, so it can only ever say less than the truth, never more.
 */
import { ShieldCheck, Zap } from 'lucide-react'
import { ChainRow } from './AgentCardChrome'
import type { MarketAgent } from './types'

/** Trust chips: the chains this agent lives on, its settlement rails, and whether a live
 *  callable endpoint is registered. Every chip maps 1:1 to a backend field. */
export function MetaChips({ a, className = '' }: { a: MarketAgent; className?: string }) {
  const payments = a.payments ?? ['escrow']
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <ChainRow chains={a.chains ?? [a.chain]} />
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

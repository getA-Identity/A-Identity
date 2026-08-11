/**
 * Shared storefront chrome for the marketplace and the agent profile: the tinted
 * banner an agent's mark straddles, the tier badge slot, the payable-wallet line,
 * and the capability tag row.
 *
 * The layout language is the one every agent storefront converged on (agent.ai,
 * kore.ai): a colored banner, a circular mark overlapping its lower edge, a badge
 * in the corner, stars with a review count, an author line, one primary button.
 * What goes IN those slots is our own backend state and nothing else, which is
 * why the tier badge below renders for nobody today.
 *
 * Pure props components. Every one of them is safe on both the light card surface
 * and the profile hero's fixed dark ground (pass tone="inverse" for the latter).
 */
import type { ReactNode } from 'react'
import { Sparkles, Wallet } from 'lucide-react'
import { CHAIN_BY_ID, type ChainId } from '../../../lib/chains'
import { short } from '../../../lib/format'
import ChainLogo from '../ChainLogo'
import { bannerStyle } from './types'

/** The colored strip at the top of a card. Children are positioned over it. */
export function AgentBanner({
  tint,
  className = '',
  children,
}: {
  tint: number
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`relative ${className}`} style={bannerStyle(tint)}>
      {children}
    </div>
  )
}

/**
 * The tier badge in the card's top-right corner (agent.ai's Pro / Premium mark).
 *
 * We do not sell tiers. There is no tier, plan, or subscription field on an agent
 * anywhere in the backend, so this renders NOTHING for every agent we serve: a Pro
 * badge nobody paid for is a claim we cannot back, and the corner carries the real
 * KYA state instead. The component is wired and waiting on the field. The day the
 * marketplace payload starts serving `tier`, drop the `?? null` in MarketAgent and
 * this lights up on its own with no other change.
 */
export function TierBadge({ tier }: { tier?: string | null }) {
  const label = tier === 'pro' ? 'Pro' : tier === 'premium' ? 'Premium' : null
  if (!label) return null
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-card/90 px-2 py-1 text-[11px] font-bold text-accent shadow-sm backdrop-blur-sm">
      <Sparkles size={11} /> {label}
    </span>
  )
}

/**
 * The author line under an agent's rating: who you actually pay.
 *
 * agent.ai names the human who built the agent. Our marketplace payload carries no
 * owner (the feed deliberately never serves one), so the honest equivalent is the
 * declared payable wallet on its chain, and "no wallet" is said plainly rather than
 * dressed up as an author.
 */
export function OwnerLine({
  walletAddress,
  chainId,
  tone = 'surface',
  className = '',
}: {
  walletAddress: string | null
  chainId?: string
  tone?: 'surface' | 'inverse'
  className?: string
}) {
  const chain = chainId && chainId in CHAIN_BY_ID ? CHAIN_BY_ID[chainId as ChainId] : undefined
  const muted = tone === 'inverse' ? 'text-white/45' : 'text-foreground/40'
  const ink = tone === 'inverse' ? 'text-white/70' : 'text-foreground/55'
  if (!walletAddress)
    return (
      <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${muted} ${className}`}>
        <Wallet size={12} /> No wallet declared
      </span>
    )
  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium ${ink} ${className}`}
      title={`Payable wallet${chain ? ` on ${chain.name}` : ''}: ${walletAddress}`}
    >
      {chain ? <ChainLogo id={chain.id} size={15} /> : <Wallet size={12} />}
      <span className="truncate font-mono">{short(walletAddress)}</span>
    </span>
  )
}

/** The agent's declared capabilities, as agent.ai's Agent Tags row. */
export function TagRow({
  tags,
  max = 3,
  tone = 'surface',
  className = '',
}: {
  tags: string[]
  /** Pass Infinity on a page that has room for the full list. */
  max?: number
  tone?: 'surface' | 'inverse'
  className?: string
}) {
  if (tags.length === 0) return null
  const head = tags.slice(0, max)
  const rest = tags.length - head.length
  const pill =
    tone === 'inverse' ? 'bg-white/15 text-white/85' : 'bg-foreground/5 text-foreground/60'
  const more = tone === 'inverse' ? 'text-white/55' : 'text-foreground/40'
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {head.map((t) => (
        <span key={t} className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${pill}`}>
          {t}
        </span>
      ))}
      {rest > 0 && <span className={`text-[11px] font-medium ${more}`}>+{rest} more</span>}
    </div>
  )
}


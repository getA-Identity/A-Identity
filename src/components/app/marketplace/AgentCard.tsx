/**
 * One agent, as a storefront product card.
 *
 * Reads top to bottom the way the agent marketplaces do: a tinted banner with the
 * trust badge in its corner, the agent's mark straddling the banner's lower edge,
 * name and one-line pitch, its tags, the rating with its review count, the price,
 * the author line, and exactly one primary button. Everything on it is real
 * backend state; nothing here invents a number, a tier, or a claim.
 */
import { Link } from 'react-router-dom'
import { ArrowUpRight, BadgeCheck, Clock, Heart, Sparkles } from 'lucide-react'
import AgentAvatar from '../../AgentAvatar'
import { AgentBanner, OwnerLine, TagRow, TierBadge } from './AgentCardChrome'
import { CommerceRow } from './CommerceRow'
import { MetaChips } from './MetaChips'
import { PriceLine } from './PriceLine'
import { CIRCLE_MARK, cardTint, type MarketAgent } from './types'

export default function AgentCard({
  a,
  matchReasons,
  onToggleFollow,
}: {
  a: MarketAgent
  /** Why the semantic search matched this agent, when that mode is on. */
  matchReasons?: string[]
  onToggleFollow?: (id: string) => void
}) {
  const to = `/app/marketplace/${a.id}`
  return (
    <div className="cn-glow-wrap h-full">
      <article className="cn-glow-card flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card">
        {/* Banner: the owner's card style when set, else the agent's own mark tint. */}
        <AgentBanner tint={cardTint(a)} className="h-20">
          <div className="absolute right-3 top-3 flex items-center gap-1.5">
            {/* Wired and unrendered: we sell no tiers, see TierBadge. The corner
                carries the KYA state instead, which is a signal we can prove. */}
            <TierBadge tier={a.tier} />
            {a.kya === 'verified' ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-card/90 px-2 py-1 text-[11px] font-bold text-ok shadow-sm backdrop-blur-sm">
                <BadgeCheck size={11} /> KYA
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-md bg-card/90 px-2 py-1 text-[11px] font-bold text-warn shadow-sm backdrop-blur-sm">
                <Clock size={11} /> Pending
              </span>
            )}
          </div>
        </AgentBanner>

        <div className="flex flex-1 flex-col px-5 pb-5">
          {/* The mark straddles the banner edge, half over and half under. */}
          <Link to={to} aria-label={`${a.name} profile`} className="-mt-7 w-fit rounded-full ring-4 ring-card transition-transform duration-[120ms] hover:scale-[1.04]">
            <AgentAvatar
              seed={a.onchainAgentId || a.id}
              category={a.category}
              size={56}
              verdict={a.kya === 'verified' ? 'allow' : 'warn'}
              src={a.logoUrl}
              className={CIRCLE_MARK}
            />
          </Link>

          <Link to={to} className="mt-3 block truncate text-[15px] font-bold text-foreground hover:text-accent">
            {a.name}
          </Link>
          <div className="mt-0.5 truncate text-xs text-foreground/50">{a.category}</div>

          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-foreground/60">
            {a.description || 'No description yet.'}
          </p>

          {matchReasons && matchReasons.length > 0 && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-accent">
              <Sparkles size={11} /> {matchReasons.join(' · ')}
            </p>
          )}

          <TagRow tags={a.capabilities} className="mt-2.5" />

          {/* flex-1 lands here so cards in a row line their footers up whatever
              the description and tag rows cost. */}
          <div className="flex-1" />

          <CommerceRow a={a} className="mt-3" />
          <MetaChips a={a} className="mt-2" />

          <div className="mt-3 flex items-end justify-between gap-2 border-t border-border pt-3">
            <div className="min-w-0">
              <PriceLine a={a} />
              <div className="mt-0.5 text-[11px] font-medium tabular-nums text-foreground/45">
                Rep {a.reputation ? a.reputation.score : '-'} / 1000
              </div>
            </div>
            <OwnerLine walletAddress={a.walletAddress} chainId={a.chain} className="max-w-[45%]" />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Link
              to={to}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-colors duration-[120ms] hover:bg-accent-deep"
            >
              View profile <ArrowUpRight size={14} />
            </Link>
            {onToggleFollow && (
              <button
                type="button"
                onClick={() => onToggleFollow(a.id)}
                aria-pressed={a.followedByViewer}
                aria-label={`${a.followedByViewer ? 'Unfollow' : 'Follow'} ${a.name}`}
                title={`${a.followers} follower${a.followers === 1 ? '' : 's'}`}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-bold tabular-nums transition-colors duration-[120ms] ${
                  a.followedByViewer
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border text-foreground/60 hover:bg-foreground/[0.04]'
                }`}
              >
                <Heart size={13} fill={a.followedByViewer ? 'currentColor' : 'none'} />
                {a.followers}
              </button>
            )}
          </div>
        </div>
      </article>
    </div>
  )
}

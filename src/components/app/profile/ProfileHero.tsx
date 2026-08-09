/**
 * The agent profile certificate hero, extracted verbatim from AgentProfile.tsx.
 * The certificate's dark glass ground (tinted by the owner's card style when
 * set), the agent's own mark as the seal, its registry facts typed on, and a
 * slow sheen. Must render exactly one root element: the same .cn-pf2-hero div
 * with data-tint on that same element. All state stays lifted in AgentProfile;
 * the "how we calculate" popover is absolute inside calcRef and deliberately
 * not portaled.
 */
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { BadgeCheck, Check, Copy, ExternalLink, Heart, Info, ShieldQuestion, Star } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import AgentAvatar from '../../AgentAvatar'
import ChainLogo from '../ChainLogo'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip'
import type { MarketAgent } from './types'

type Props = {
  agent: MarketAgent
  heroTint: string | undefined
  revealed: string[]
  done: boolean
  activeLine: number
  copiedId: boolean
  copyId: () => void
  rep: MarketAgent['reputation']
  fbAvg: number | null
  fbCount: number
  calcOpen: boolean
  setCalcOpen: Dispatch<SetStateAction<boolean>>
  calcRef: RefObject<HTMLDivElement | null>
  breakdown: MarketAgent['feedbackBreakdown']
  soldCount: number
  chainInfo: Chain | undefined
  copiedWallet: boolean
  copyWallet: () => void
  toggleFollow: () => void
}

export default function ProfileHero({
  agent,
  heroTint,
  revealed,
  done,
  activeLine,
  copiedId,
  copyId,
  rep,
  fbAvg,
  fbCount,
  calcOpen,
  setCalcOpen,
  calcRef,
  breakdown,
  soldCount,
  chainInfo,
  copiedWallet,
  copyWallet,
  toggleFollow,
}: Props) {
  return (
    <div
      className="cn-pf2-hero relative mt-6 rounded-3xl border border-white/10 p-6 text-white shadow-xl sm:p-7"
      data-tint={heroTint}
    >
      <div className="cn-cert-sheen" aria-hidden="true" />
      <div
        className="pointer-events-none absolute inset-0 rounded-3xl opacity-[0.07]"
        style={{
          backgroundImage: 'radial-gradient(circle, white 1px, transparent 1.5px)',
          backgroundSize: '7px 7px',
        }}
        aria-hidden="true"
      />

      <div className="relative flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-white/55">
          A-Identity · Agent Profile
        </div>
        {agent.kya === 'verified' ? (
          <span className="cn-pf2-chip-ok inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold">
            <BadgeCheck size={12} /> KYA Verified
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-white/70">
            <ShieldQuestion size={12} /> KYA Pending
          </span>
        )}
      </div>

      <div className="relative mt-5 flex flex-col gap-5 sm:flex-row sm:items-start">
        <div className="shrink-0 self-start rounded-2xl bg-white/10 p-1.5">
          <AgentAvatar
            seed={agent.onchainAgentId || agent.id}
            category={agent.category}
            size={72}
            verdict={agent.kya === 'verified' ? 'allow' : 'warn'}
            src={agent.logoUrl}
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-2xl font-bold tracking-tight">
            {revealed[0]}
            {activeLine === 0 && <span className="cn-caret" aria-hidden="true" />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="break-all font-mono text-xs text-white/60">
              {revealed[1]}
              {activeLine === 1 && <span className="cn-caret" aria-hidden="true" />}
            </span>
            <button
              type="button"
              onClick={copyId}
              aria-label="Copy agent id"
              className={`shrink-0 rounded-md p-1 text-white/55 transition-opacity duration-300 hover:bg-white/10 hover:text-white/90 ${done ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
            >
              {copiedId ? <Check size={12} className="cn-pf2-ok-ink" /> : <Copy size={12} />}
            </button>
          </div>
          {agent.description && (
            <p className="mt-2.5 line-clamp-2 max-w-2xl text-sm leading-relaxed text-white/75">{agent.description}</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/85">
              {agent.category}
            </span>
            <span className="text-[11px] font-medium text-white/50">
              Registered{' '}
              {new Date(agent.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
            </span>
          </div>
        </div>

        {/* Reputation block, with the inline "how we calculate" popover
            (absolute inside this container; deliberately not portaled). */}
        <div ref={calcRef} className="relative shrink-0 sm:text-right">
          <div className="flex items-center gap-1.5 sm:justify-end">
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Reputation</span>
            <button
              type="button"
              onClick={() => setCalcOpen((v) => !v)}
              aria-expanded={calcOpen}
              aria-haspopup="dialog"
              aria-label="How we calculate these numbers"
              className="rounded-full p-0.5 text-white/50 transition-colors duration-[120ms] hover:bg-white/10 hover:text-white/90"
            >
              <Info size={13} />
            </button>
          </div>
          <div className="mt-0.5 text-4xl font-bold leading-none tabular-nums">{rep ? rep.score : '-'}</div>
          <div className="mt-0.5 text-xs text-white/50">/ 1000</div>
          {fbAvg != null ? (
            <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/85">
              <Star size={11} className="text-warn" fill="currentColor" /> {fbAvg.toFixed(1)}/10 · {fbCount}
            </div>
          ) : (
            <div className="mt-2 text-[11px] font-medium text-white/45">No ratings yet</div>
          )}

          {calcOpen && (
            <div
              role="dialog"
              aria-label="How we calculate these numbers"
              className="cn-pop-in absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-border bg-card p-4 text-left shadow-xl sm:w-80"
            >
              <div className="text-xs font-bold text-foreground">How we calculate</div>
              <p className="mt-1.5 text-xs leading-relaxed text-foreground/70">
                Marketplace rank uses one composite number:
              </p>
              <pre className="mt-1.5 overflow-x-auto rounded-lg bg-foreground/[0.04] px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/80">
                {'rankScore = reputation\n  + avg rating x 20\n  + ratings x 10\n  + followers x 5\n  + tasks done x 15'}
              </pre>
              <p className="mt-2.5 text-xs leading-relaxed text-foreground/70">
                Reputation (0-1000) comes from real signals:
              </p>
              <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[11px] leading-relaxed text-foreground/65">
                <li>Settlement: up to 600 from on-chain USDC settlements, including a +60 verified-identity credit.</li>
                <li>Validation: up to 240 from the clean (settled vs rejected) ratio.</li>
                <li>Tenure: up to 160, about 1 point per 2 days since registration.</li>
                <li>Behavior: -150 to +40 from real job outcomes and client ratings.</li>
              </ul>
              <p className="mt-2 text-[11px] leading-relaxed text-foreground/50">
                User ratings are whole 1-10 scores, one per rater; rating again replaces the old one.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Stats strip: feedback breakdown, sales, the network row, follow. */}
      <div
        className={`relative mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4 transition-opacity duration-500 ${done ? 'opacity-100' : 'opacity-40'}`}
      >
        <div className="flex flex-wrap items-center gap-2">
          {breakdown && (
            <>
              <span className="cn-pf2-chip-ok rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums">
                {breakdown.positive} positive
              </span>
              <span className="cn-pf2-chip-warn rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums">
                {breakdown.neutral} neutral
              </span>
              <span className="cn-pf2-chip-danger rounded-full px-2.5 py-1 text-[11px] font-bold tabular-nums">
                {breakdown.negative} negative
              </span>
            </>
          )}
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold tabular-nums text-white/85">
            {soldCount} sold
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {chainInfo && (
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Network: ${chainInfo.name}`}
                    className="inline-flex items-center gap-2 rounded-full bg-white/10 py-1 pl-1.5 pr-3 text-[11px] font-bold text-white/85 transition-colors duration-[120ms] hover:bg-white/20"
                  >
                    <ChainLogo id={chainInfo.id} size={18} className="border-white/20" />
                    {chainInfo.shortName}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" align="end" className="w-64 p-3">
                  <div className="flex items-center gap-2">
                    <ChainLogo id={chainInfo.id} size={20} />
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-foreground">{chainInfo.name}</div>
                      <div className="font-mono text-[10px] text-foreground/50">{chainInfo.caip2}</div>
                    </div>
                  </div>
                  <div className="mt-2.5 border-t border-border pt-2.5">
                    {agent.walletAddress ? (
                      <>
                        <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-foreground/50">
                          Wallet
                        </div>
                        <div className="mt-1 flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">
                            {agent.walletAddress}
                          </span>
                          <button
                            type="button"
                            onClick={copyWallet}
                            aria-label="Copy wallet address"
                            className="shrink-0 rounded-md p-1 text-foreground/55 transition-colors duration-[120ms] hover:bg-foreground/[0.06] hover:text-foreground"
                          >
                            {copiedWallet ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
                          </button>
                        </div>
                        {chainInfo.explorer && (
                          <a
                            href={`${chainInfo.explorer}/address/${agent.walletAddress}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline"
                          >
                            View on explorer <ExternalLink size={10} />
                          </a>
                        )}
                      </>
                    ) : (
                      <p className="text-[11px] leading-relaxed text-foreground/60">
                        No wallet declared yet; this agent cannot receive payments.
                      </p>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          <button
            type="button"
            onClick={toggleFollow}
            aria-pressed={agent.followedByViewer}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition-colors duration-[120ms] ${
              agent.followedByViewer ? 'cn-pf2-btn-on' : 'border border-white/30 text-white hover:bg-white/10'
            }`}
          >
            <Heart size={12} fill={agent.followedByViewer ? 'currentColor' : 'none'} />
            {agent.followedByViewer ? 'Following' : 'Follow'} ({agent.followers})
          </button>
        </div>
      </div>
    </div>
  )
}

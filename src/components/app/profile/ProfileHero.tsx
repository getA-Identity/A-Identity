/**
 * The agent profile hero: the certificate's dark glass ground (tinted by the
 * owner's card style when set), the agent's own mark as the seal, its registry
 * facts typed on, and a slow sheen.
 *
 * Laid out the way a storefront lays out a product page: a big name, the
 * one-line value prop under it, one row of the numbers a buyer scans (rating,
 * jobs done, followers, reputation, registered), and a single primary CTA in a
 * card on the right. Every cell of that row is a real backend field; the CTA
 * says plainly when the agent lists nothing to sell instead of offering a button
 * that cannot do anything.
 *
 * Must render exactly one root element: the same .cn-pf2-hero div with data-tint
 * on that same element. All state stays lifted in AgentProfile; the "how we
 * calculate" popover is absolute inside calcRef and deliberately not portaled.
 */
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import { Check, Copy, ExternalLink, Heart, Info, Star } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import { kyaPresentation, type KyaTone } from '../../../lib/kya'
import AgentAvatar from '../../AgentAvatar'
import ChainLogo from '../ChainLogo'
import { TagRow } from '../marketplace/AgentCardChrome'
import { cheapestService, CIRCLE_MARK, fmtUsd } from '../marketplace/types'
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
  /** Sends the reader to the Services pane, which is where hiring actually starts. */
  onHire: () => void
}

/** One cell of the metric row. */
function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">{label}</div>
      <div className="mt-1 flex items-center gap-1.5 text-sm font-bold leading-none text-white">{children}</div>
    </div>
  )
}

const Divider = () => <span className="hidden h-8 w-px shrink-0 bg-white/15 sm:block" aria-hidden="true" />

/**
 * The KYA chip's paint on this hero. The ground here is theme-FIXED dark, so the raw
 * ok/danger tokens (which are dark in the light theme) would sink into it; the
 * .cn-pf2-chip-* rules mix the same semantic tokens toward white. The label, glyph and
 * tone themselves come from lib/kya, so this table only answers "which paint".
 */
const KYA_CHIP: Record<KyaTone, string> = {
  ok: 'cn-pf2-chip-ok',
  neutral: 'bg-white/10 text-white/70',
  danger: 'cn-pf2-chip-danger',
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
  onHire,
}: Props) {
  const price = cheapestService(agent)
  const serviceCount = agent.services?.length ?? 0
  const kya = kyaPresentation(agent.kya)
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
        {/* Three states, three chips. A revoked attestation is an incident, so it must
            never borrow the neutral, hopeful wording that "pending" gets. */}
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold ${KYA_CHIP[kya.tone]}`}
          title={kya.detail}
        >
          <kya.Icon size={12} /> {kya.label}
        </span>
      </div>

      {/* Identity and numbers on the left, the one call to action on the right. */}
      <div className="relative mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="min-w-0">
          <div className="flex items-start gap-4">
            <div className="shrink-0 rounded-full ring-4 ring-white/15">
              <AgentAvatar
                seed={agent.onchainAgentId || agent.id}
                category={agent.category}
                size={72}
                verdict={kya.verdict}
                src={agent.logoUrl}
                className={CIRCLE_MARK}
              />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                {revealed[0]}
                {activeLine === 0 && <span className="cn-caret" aria-hidden="true" />}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
              <span className="mt-2 inline-block rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/85">
                {agent.category}
              </span>
            </div>
          </div>

          {/* The one-line value prop. */}
          <p className="mt-4 line-clamp-2 max-w-2xl text-[15px] leading-relaxed text-white/75">
            {agent.description || 'No description yet.'}
          </p>

          <TagRow tags={agent.capabilities} max={6} tone="inverse" className="mt-3" />

          {/* Metric row: the numbers a buyer scans, every one of them a real field. */}
          <div
            className={`mt-5 flex flex-wrap items-center gap-x-5 gap-y-4 border-t border-white/10 pt-4 transition-opacity duration-500 ${done ? 'opacity-100' : 'opacity-40'}`}
          >
            <Metric label="Rating">
              {fbAvg != null ? (
                <>
                  <Star size={13} className="text-warn" fill="currentColor" />
                  <span className="tabular-nums">
                    {fbAvg.toFixed(1)}/10 <span className="font-medium text-white/55">({fbCount})</span>
                  </span>
                </>
              ) : (
                <span className="font-medium text-white/50">No ratings yet</span>
              )}
            </Metric>
            <Divider />
            <Metric label="Jobs done">
              <span className="tabular-nums">{soldCount}</span>
            </Metric>
            <Divider />
            <Metric label="Followers">
              <span className="tabular-nums">{agent.followers}</span>
            </Metric>
            <Divider />
            {/* Reputation keeps the inline "how we calculate" popover; calcRef must
                stay the element that wraps both the trigger and the panel. */}
            <div ref={calcRef} className="relative min-w-0">
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">Reputation</span>
                <button
                  type="button"
                  onClick={() => setCalcOpen((v) => !v)}
                  aria-expanded={calcOpen}
                  aria-haspopup="dialog"
                  aria-label="How we calculate these numbers"
                  className="rounded-full p-0.5 text-white/50 transition-colors duration-[120ms] hover:bg-white/10 hover:text-white/90"
                >
                  <Info size={12} />
                </button>
              </div>
              <div className="mt-1 text-sm font-bold leading-none tabular-nums text-white">
                {rep ? rep.score : '-'} <span className="font-medium text-white/55">/ 1000</span>
              </div>

              {calcOpen && (
                <div
                  role="dialog"
                  aria-label="How we calculate these numbers"
                  className="cn-pop-in absolute left-0 top-full z-30 mt-2 w-72 rounded-xl border border-border bg-card p-4 text-left shadow-xl sm:w-80"
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
            <Divider />
            <Metric label="Registered">
              <span className="font-semibold">
                {new Date(agent.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
              </span>
            </Metric>
          </div>

          {/* Rating split and the network row. */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
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
                  <TooltipContent side="top" align="start" className="w-64 p-3">
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
          </div>
        </div>

        {/* The one call to action. It only offers a hire when there is something
            listed to hire, and says why when there is not. */}
        <aside className="self-start rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm">
          {price ? (
            <>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/45">Starting at</div>
              <div className="mt-1 text-2xl font-bold leading-none tabular-nums text-white">
                ${fmtUsd(price.priceUsd)}
                {price.unit && <span className="ml-1 text-xs font-semibold text-white/55">per {price.unit}</span>}
              </div>
            </>
          ) : (
            <div className="text-sm font-bold text-white/85">Quote per task</div>
          )}

          {serviceCount > 0 ? (
            <>
              <button
                type="button"
                onClick={onHire}
                className="cn-pf2-btn-on mt-3.5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-bold transition-transform duration-[120ms] hover:scale-[1.02]"
              >
                Hire this agent
              </button>
              <p className="mt-2 text-[11px] leading-relaxed text-white/55">
                {serviceCount} service{serviceCount === 1 ? '' : 's'} listed. Your USDC locks in an on-chain escrow and
                releases to the agent on delivery.
              </p>
            </>
          ) : (
            <p className="mt-3.5 rounded-xl bg-white/10 px-3 py-2.5 text-[11px] leading-relaxed text-white/65">
              No services listed yet, so this agent cannot be hired. Its owner has to list one first.
            </p>
          )}

          <button
            type="button"
            onClick={toggleFollow}
            aria-pressed={agent.followedByViewer}
            className={`mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold transition-colors duration-[120ms] ${
              agent.followedByViewer ? 'bg-white/25 text-white' : 'border border-white/30 text-white hover:bg-white/10'
            }`}
          >
            <Heart size={12} fill={agent.followedByViewer ? 'currentColor' : 'none'} />
            {agent.followedByViewer ? 'Following' : 'Follow'} ({agent.followers})
          </button>
        </aside>
      </div>
    </div>
  )
}

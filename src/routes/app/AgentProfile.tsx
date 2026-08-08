import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  Clock,
  ExternalLink,
  Gauge,
  Heart,
  Info,
  Loader2,
  MessageSquare,
  ShieldQuestion,
  Star,
  Wrench,
} from 'lucide-react'
import { authHeaders, useAuth } from '../../store/auth'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { humanizeActivity, short } from '../../lib/format'
import AgentAvatar from '../../components/AgentAvatar'
import AppPage from '../../components/app/AppPage'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { useTabCarousel } from '../../hooks/useTabCarousel'

type MarketAgent = {
  id: string
  name: string
  logoUrl?: string
  description: string
  category: string
  capabilities: string[]
  kya: string
  onchain: string
  onchainTx?: string
  onchainExplorer?: string
  onchainAgentId?: string
  reputation?: { score: number; breakdown: { settlement: number; validation: number; tenure: number } }
  feedback?: { avg: number | null; count: number }
  walletAddress: string | null
  followers: number
  followedByViewer: boolean
  activity: { at: string; text: string }[]
  createdAt: string
}

type CatalogService = {
  agentId: string
  agentName: string
  service: string
  priceUsd: number
  unit: string
  rating: number
  reviews: number
  completed: number
}

type FeedbackEntry = { id: string; rater: string; score: number; comment: string; at: string }
type FeedbackData = { avg: number | null; count: number; entries: FeedbackEntry[] }

const PROFILE_TABS = ['overview', 'services', 'statistics', 'quality', 'feedback'] as const
type ProfileTab = (typeof PROFILE_TABS)[number]

const TAB_META: { id: ProfileTab; label: string; icon: typeof Info }[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'services', label: 'Services', icon: Wrench },
  { id: 'statistics', label: 'Statistics', icon: BarChart3 },
  { id: 'quality', label: 'Quality', icon: Gauge },
  { id: 'feedback', label: 'Feedback', icon: MessageSquare },
]

/**
 * Reveal a set of labelled lines one after another, character by character,
 * like a certificate being typed onto the card. Reduced motion (or a finished
 * run) renders everything instantly.
 */
function useTypewriter(lines: string[], speedMs = 22) {
  const [progress, setProgress] = useState(0) // total characters revealed
  const total = lines.reduce((s, l) => s + l.length, 0)

  useEffect(() => {
    setProgress(0)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setProgress(total)
      return
    }
    const iv = setInterval(() => {
      setProgress((p) => {
        if (p >= total) {
          clearInterval(iv)
          return p
        }
        return p + 1
      })
    }, speedMs)
    return () => clearInterval(iv)
  }, [lines.join('\n'), total, speedMs]) // eslint-disable-line react-hooks/exhaustive-deps

  let remaining = progress
  const revealed = lines.map((l) => {
    const take = Math.max(0, Math.min(l.length, remaining))
    remaining -= take
    return l.slice(0, take)
  })
  const activeLine = revealed.findIndex((r, i) => r.length < lines[i].length)
  return { revealed, done: progress >= total, activeLine }
}

export default function AgentProfile() {
  const { agentId } = useParams<{ agentId: string }>()
  const user = useAuth((s) => s.user)
  const verified = useAuth((s) => s.verified)
  const viewer = user?.email || user?.name || 'guest'

  const [agent, setAgent] = useState<MarketAgent | null>(null)
  const [services, setServices] = useState<CatalogService[] | null>(null)
  const [feedback, setFeedback] = useState<FeedbackData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [tab, setTab] = useState<ProfileTab>('overview')
  const { shown: shownTab, className: paneClass } = useTabCarousel(tab, PROFILE_TABS)

  // Rating form (verified users only; guests see why they can't).
  const [myScore, setMyScore] = useState<number | null>(null)
  const [myComment, setMyComment] = useState('')
  const [rating, setRating] = useState(false)
  const [rateNote, setRateNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`/api/marketplace?viewer=${encodeURIComponent(viewer)}&all=1`)
        const data = (await res.json()) as { agents: MarketAgent[] }
        if (cancelled) return
        setAgent(data.agents.find((a) => a.id === agentId) ?? null)
        setError(null)
      } catch {
        if (!cancelled) setError(BACKEND_UNREACHABLE)
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    // Services and feedback load alongside; each fails soft on its own.
    apiFetch('/api/marketplace/catalog')
      .then((r) => readJson<{ services?: CatalogService[] }>(r))
      .then((d) => {
        if (!cancelled) setServices((d.services ?? []).filter((sv) => sv.agentId === agentId))
      })
      .catch(() => {
        if (!cancelled) setServices([])
      })
    apiFetch(`/api/marketplace/feedback?agentId=${encodeURIComponent(agentId ?? '')}`)
      .then((r) => readJson<FeedbackData>(r))
      .then((d) => {
        if (!cancelled && typeof d.count === 'number') setFeedback(d)
      })
      .catch(() => {
        /* feedback stays null; the tab says it could not load */
      })
    return () => {
      cancelled = true
    }
  }, [agentId, viewer])

  const toggleFollow = async () => {
    if (!agent) return
    setAgent({
      ...agent,
      followedByViewer: !agent.followedByViewer,
      followers: agent.followers + (agent.followedByViewer ? -1 : 1),
    })
    try {
      await apiFetch('/api/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: agent.id, follower: viewer }),
      })
    } catch {
      /* optimistic flip stays; a reload reconciles */
    }
  }

  const submitRating = async () => {
    if (!agent || myScore == null) return
    setRating(true)
    setRateNote(null)
    try {
      const res = await apiFetch('/api/marketplace/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: agent.id, score: myScore, comment: myComment.trim() || undefined }),
      })
      const data = await readJson<{ error?: string; summary?: { avg: number | null; count: number } }>(res)
      if (!res.ok) {
        setRateNote(explainError(res.status, data.error))
        return
      }
      setRateNote('Thanks! Your rating replaces any previous one from this account.')
      setMyComment('')
      // Re-read the list so the new entry (and average) is the server's truth.
      const fb = await apiFetch(`/api/marketplace/feedback?agentId=${encodeURIComponent(agent.id)}`).then((r) =>
        readJson<FeedbackData>(r),
      )
      if (typeof fb.count === 'number') setFeedback(fb)
    } catch {
      setRateNote('Could not send the rating. The backend may be waking up; try again.')
    } finally {
      setRating(false)
    }
  }

  // The certificate's typed lines: real registry facts only.
  const certLines = useMemo(() => {
    if (!agent) return []
    return [
      agent.name,
      agent.onchainAgentId ? `ERC-8004 #${agent.onchainAgentId}` : agent.id,
      agent.category,
      `Registered ${new Date(agent.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })} · Circle Arc`,
    ]
  }, [agent])
  const { revealed, done, activeLine } = useTypewriter(certLines)

  const rep = agent?.reputation
  const fbAvg = feedback?.avg ?? agent?.feedback?.avg ?? null
  const fbCount = feedback?.count ?? agent?.feedback?.count ?? 0

  // Quality signals: every flag derives from a real field, nothing is invented.
  const quality = agent
    ? [
        { ok: agent.kya === 'verified', label: 'KYA verified', detail: 'Wallet control proven by signature.', miss: 'KYA pending: the agent has not proven wallet control yet.' },
        { ok: agent.onchain === 'registered', label: 'Anchored on-chain', detail: 'ERC-8004 identity broadcast on Arc.', miss: 'On-chain anchor still queued.' },
        { ok: Boolean(agent.walletAddress), label: 'Wallet declared', detail: 'Payable address on Arc.', miss: 'No wallet: the agent cannot receive payments.' },
        { ok: (services?.length ?? 0) > 0, label: 'Services listed', detail: 'Hireable through the escrow marketplace.', miss: 'No services listed yet.' },
        { ok: fbCount > 0, label: 'Has user feedback', detail: `${fbCount} rating${fbCount === 1 ? '' : 's'} recorded.`, miss: 'No user feedback yet.' },
        { ok: (rep?.score ?? 0) >= 100, label: 'Reputation 100+', detail: 'Past the first milestone.', miss: 'Below the first reputation milestone.' },
      ]
    : []
  const qualityMet = quality.filter((q) => q.ok).length

  return (
    <AppPage
      title="Agent profile"
      description="The public record of one agent: its certificate, its services, its numbers, and what people say about it."
      actions={
        <Link
          to="/app/marketplace"
          className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-2 text-xs font-semibold text-foreground/70 transition-colors duration-[120ms] hover:bg-foreground/[0.04]"
        >
          <ArrowLeft size={13} /> Marketplace
        </Link>
      }
    >
      {error && (
        <div className="mt-5 rounded-2xl border border-warn/25 bg-warn/10 p-4 text-sm text-foreground/70">{error}</div>
      )}

      {!loaded && (
        <div className="mt-5 space-y-4">
          <Skeleton className="h-64 w-full rounded-3xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      )}

      {loaded && !error && !agent && (
        <div className="mt-5 rounded-2xl border border-dashed border-foreground/15 bg-card p-10 text-center text-sm text-foreground/60">
          This agent does not exist (or is not listed). Back to the
          <Link to="/app/marketplace" className="ml-1 font-semibold text-accent hover:underline">
            marketplace
          </Link>
          .
        </div>
      )}

      {agent && (
        <>
          {/* The certificate. A dark glass card in the brand's ink, the agent's own
              mark as the seal, its registry facts typed on, and a slow sheen. */}
          <div
            className="cn-cert relative mt-6 overflow-hidden rounded-3xl border border-white/10 p-7 text-white shadow-xl"
            style={{
              background: 'linear-gradient(140deg, #131c26 0%, #192837 45%, var(--accent-deep) 130%)',
            }}
          >
            <div className="cn-cert-sheen" aria-hidden="true" />
            <div
              className="pointer-events-none absolute inset-0 opacity-[0.07]"
              style={{
                backgroundImage: 'radial-gradient(circle, white 1px, transparent 1.5px)',
                backgroundSize: '7px 7px',
              }}
              aria-hidden="true"
            />

            <div className="relative flex items-start justify-between gap-4">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-white/55">
                A-Identity · Agent Certificate
              </div>
              {agent.kya === 'verified' ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/20 px-3 py-1 text-[11px] font-bold text-[#8ef0c0]">
                  <BadgeCheck size={12} /> KYA Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-white/70">
                  <ShieldQuestion size={12} /> KYA Pending
                </span>
              )}
            </div>

            <div className="relative mt-6 flex items-start gap-5">
              <div className="shrink-0 rounded-2xl bg-white/10 p-1.5">
                <AgentAvatar
                  seed={agent.onchainAgentId || agent.id}
                  category={agent.category}
                  size={64}
                  verdict={agent.kya === 'verified' ? 'allow' : 'warn'}
                  src={agent.logoUrl}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-2xl font-bold tracking-tight">
                  {revealed[0]}
                  {activeLine === 0 && <span className="cn-caret" aria-hidden="true" />}
                </div>
                <div className="mt-1 font-mono text-sm text-white/60">
                  {revealed[1]}
                  {activeLine === 1 && <span className="cn-caret" aria-hidden="true" />}
                </div>
                <div className="mt-3 text-sm font-semibold text-white/80">
                  {revealed[2]}
                  {activeLine === 2 && <span className="cn-caret" aria-hidden="true" />}
                </div>
                <div className="mt-0.5 text-xs text-white/55">
                  {revealed[3]}
                  {activeLine === 3 && <span className="cn-caret" aria-hidden="true" />}
                </div>
              </div>
              <div className={`shrink-0 text-right transition-opacity duration-500 ${done ? 'opacity-100' : 'opacity-0'}`}>
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/50">Reputation</div>
                <div className="mt-0.5 text-4xl font-bold leading-none tabular-nums">{rep ? rep.score : '-'}</div>
                <div className="mt-0.5 text-xs text-white/50">/ 1000</div>
                {fbAvg != null && (
                  <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-bold text-white/85">
                    <Star size={11} className="text-warn" fill="currentColor" /> {fbAvg.toFixed(1)}/10 · {fbCount}
                  </div>
                )}
              </div>
            </div>

            <div
              className={`relative mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4 transition-opacity duration-500 ${done ? 'opacity-100' : 'opacity-40'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {agent.onchain === 'registered' ? (
                  agent.onchainExplorer ? (
                    <a
                      href={agent.onchainExplorer}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-white/85 hover:bg-white/20"
                    >
                      On-chain #{agent.onchainAgentId ?? ''} <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-white/85">
                      On-chain #{agent.onchainAgentId ?? ''}
                    </span>
                  )
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold text-white/70">
                    <Clock size={11} /> on-chain queued
                  </span>
                )}
                {agent.walletAddress && (
                  <a
                    href={`https://testnet.arcscan.app/address/${agent.walletAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] font-semibold text-white/75 hover:bg-white/20"
                  >
                    {short(agent.walletAddress)} <ExternalLink size={10} />
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={toggleFollow}
                aria-pressed={agent.followedByViewer}
                className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-bold transition-colors duration-[120ms] ${
                  agent.followedByViewer ? 'bg-white text-[#192837]' : 'border border-white/30 text-white hover:bg-white/10'
                }`}
              >
                <Heart size={12} fill={agent.followedByViewer ? 'currentColor' : 'none'} />
                {agent.followedByViewer ? 'Following' : 'Follow'} ({agent.followers})
              </button>
            </div>
          </div>

          {/* Tab strip, same language as the rest of the console. */}
          <div className="mt-5 flex flex-wrap gap-1.5 border-b border-border pb-3" role="tablist" aria-label="Agent profile sections">
            {TAB_META.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                onClick={() => setTab(id)}
                aria-selected={tab === id}
                className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors duration-[120ms] ${
                  tab === id ? 'border-foreground/60 text-foreground' : 'border-transparent text-foreground/55 hover:text-foreground/85'
                }`}
              >
                <Icon size={13} className={tab === id ? 'text-accent' : ''} />
                {label}
                {id === 'feedback' && fbCount > 0 && <span className="tabular-nums normal-case tracking-normal">({fbCount})</span>}
              </button>
            ))}
          </div>

          <div className="cn-tab-clip">
          <div className={paneClass}>
          {shownTab === 'overview' && (
            <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
              <div className="flex flex-col gap-4 lg:col-span-2">
                <section className="rounded-2xl border border-border bg-card p-5">
                  <h3 className="text-sm font-bold text-foreground/80">About</h3>
                  <p className="mt-2 text-sm leading-relaxed text-foreground/70">
                    {agent.description || 'No description yet.'}
                  </p>
                  {agent.capabilities.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {agent.capabilities.map((c) => (
                        <span key={c} className="rounded-full bg-foreground/5 px-2.5 py-1 text-[11px] font-medium text-foreground/65">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-border bg-card p-5">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-foreground/80">
                    <Activity size={14} className="text-accent" /> Recent Activity
                  </h3>
                  {agent.activity.length > 0 ? (
                    <ul className="mt-3 flex flex-col gap-2.5">
                      {[...agent.activity].reverse().slice(0, 5).map((ev, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-foreground/70">
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                          <span className="min-w-0 break-words">
                            {humanizeActivity(ev.text)}
                            <span className="ml-1.5 text-xs font-medium text-accent/80">
                              {new Date(ev.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-foreground/60">No recorded activity yet.</p>
                  )}
                </section>
              </div>

              {/* Basic Information: the registry facts, label/value, links out. */}
              <section className="rounded-2xl border border-border bg-card p-5">
                <h3 className="text-sm font-bold text-foreground/80">Basic Information</h3>
                <dl className="mt-3 flex flex-col divide-y divide-border text-sm">
                  {(
                    [
                      ['Agent ID', agent.id, null],
                      ['ERC-8004', agent.onchainAgentId ? `#${agent.onchainAgentId}` : 'queued', agent.onchainExplorer ?? null],
                      ['Chain', 'Circle Arc (testnet)', null],
                      ['Category', agent.category, null],
                      ['Wallet', agent.walletAddress ? short(agent.walletAddress) : 'none', agent.walletAddress ? `https://testnet.arcscan.app/address/${agent.walletAddress}` : null],
                      ['Registered', new Date(agent.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), null],
                      ['Registration tx', agent.onchainTx ? short(agent.onchainTx) : 'pending', agent.onchainExplorer ?? null],
                    ] as const
                  ).map(([label, value, href]) => (
                    <div key={label} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <dt className="shrink-0 text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">{label}</dt>
                      {href ? (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate font-mono text-xs font-semibold text-accent hover:underline">
                          <span className="truncate">{value}</span> <ExternalLink size={10} className="shrink-0" />
                        </a>
                      ) : (
                        <dd className="min-w-0 truncate text-right font-mono text-xs font-semibold text-foreground/80">{value}</dd>
                      )}
                    </div>
                  ))}
                </dl>
              </section>
            </div>
          )}

          {shownTab === 'services' && (
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
                  {services.map((sv) => (
                    <li key={`${sv.agentId}-${sv.service}`} className="flex flex-wrap items-center gap-4 px-5 py-3.5">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold capitalize text-foreground">{sv.service}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-foreground/55">
                          <Star size={11} className="text-warn" fill="currentColor" />
                          {sv.reviews > 0 ? `${sv.rating.toFixed(1)} (${sv.reviews})` : 'No reviews yet'}
                          <span className="text-foreground/30">·</span>
                          <span className="tabular-nums">{sv.completed} done</span>
                        </div>
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
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-foreground/60">No services listed yet.</p>
              )}
            </section>
          )}

          {shownTab === 'statistics' && (
            <section className="mt-4 rounded-2xl border border-border bg-card p-5">
              <h3 className="text-sm font-bold text-foreground/80">Statistics</h3>
              {rep ? (
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  {(
                    [
                      ['Settlement', rep.breakdown.settlement, 600, 'var(--accent)'],
                      ['Validation', rep.breakdown.validation, 240, 'var(--usdc)'],
                      ['Tenure', rep.breakdown.tenure, 160, 'var(--ok)'],
                    ] as const
                  ).map(([label, v, max, color]) => (
                    <div key={label}>
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs font-semibold text-foreground/65">{label}</span>
                        <span className="text-sm font-bold tabular-nums" style={{ color }}>
                          {v}
                          <span className="ml-0.5 text-[10px] font-medium text-foreground/40">/ {max}</span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                        <div
                          className="h-full rounded-full transition-all duration-700"
                          style={{ width: `${Math.min(100, (v / max) * 100)}%`, background: color }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-foreground/60">No reputation recorded yet.</p>
              )}
              <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 sm:grid-cols-4">
                {(
                  [
                    ['Reputation', rep ? `${rep.score} / 1000` : '-'],
                    ['User rating', fbAvg != null ? `${fbAvg.toFixed(1)} / 10` : 'none yet'],
                    ['Followers', String(agent.followers)],
                    ['Recorded events', String(agent.activity.length)],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-[11px] font-bold text-foreground/50">{k}</dt>
                    <dd className="mt-0.5 text-lg font-bold tabular-nums text-foreground">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {shownTab === 'quality' && (
            <section className="mt-4 rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-foreground/80">Quality Signals</h3>
                <Badge variant={qualityMet >= 5 ? 'success' : qualityMet >= 3 ? 'default' : 'warning'}>
                  {qualityMet} / {quality.length} signals met
                </Badge>
              </div>
              <p className="mt-1 text-xs text-foreground/55">
                Every signal derives from the live record; nothing here is scored by opinion.
              </p>
              <ul className="mt-4 flex flex-col gap-1.5">
                {quality.map((q) => (
                  <li
                    key={q.label}
                    className={`flex items-start gap-3 rounded-xl px-3.5 py-2.5 ${q.ok ? 'bg-ok/[0.06]' : 'bg-warn/[0.08]'}`}
                  >
                    <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-white ${q.ok ? 'bg-ok' : 'bg-warn'}`}>
                      {q.ok ? <BadgeCheck size={12} /> : <Clock size={12} />}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">{q.label}</div>
                      <div className="text-xs text-foreground/60">{q.ok ? q.detail : q.miss}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {shownTab === 'feedback' && (
            <div className="mt-4 flex flex-col gap-4">
              {/* Rate 1-10. One rating per account; rating again replaces it. */}
              <section className="rounded-2xl border border-border bg-card p-5">
                <h3 className="text-sm font-bold text-foreground/80">Rate this agent</h3>
                {verified ? (
                  <>
                    <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Score from 1 to 10">
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                        <button
                          key={n}
                          type="button"
                          role="radio"
                          aria-checked={myScore === n}
                          onClick={() => setMyScore(n)}
                          className={`h-9 w-9 rounded-lg text-sm font-bold tabular-nums transition-colors duration-[120ms] ${
                            myScore != null && n <= myScore
                              ? 'bg-accent text-white'
                              : 'border border-border text-foreground/55 hover:border-accent/40 hover:text-accent'
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                    <textarea
                      value={myComment}
                      onChange={(e) => setMyComment(e.target.value)}
                      rows={2}
                      placeholder="Optional: what was it like to work with this agent?"
                      className="mt-3 w-full resize-none rounded-xl border border-border bg-background/40 px-3 py-2 text-sm outline-none transition-colors duration-[120ms] focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={submitRating}
                      disabled={rating || myScore == null}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors duration-[120ms] hover:bg-accent-deep disabled:opacity-50"
                    >
                      {rating && <Loader2 size={14} className="animate-spin" />}
                      Submit rating
                    </button>
                  </>
                ) : (
                  <p className="mt-2 text-sm text-foreground/65">
                    Sign in with your wallet or an email link to rate. Guest sessions are read-only.
                  </p>
                )}
                {rateNote && <p className="mt-2 text-xs font-medium text-foreground/65">{rateNote}</p>}
              </section>

              <section className="rounded-2xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
                  <h3 className="text-sm font-bold text-foreground/80">User Feedback</h3>
                  {fbAvg != null && (
                    <span className="inline-flex items-center gap-1 text-sm font-bold tabular-nums text-foreground">
                      <Star size={13} className="text-warn" fill="currentColor" /> {fbAvg.toFixed(1)}/10
                      <span className="text-xs font-medium text-foreground/50">({fbCount})</span>
                    </span>
                  )}
                </div>
                {feedback == null ? (
                  <p className="px-5 py-8 text-center text-sm text-foreground/60">Could not load feedback right now.</p>
                ) : feedback.entries.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {feedback.entries.map((f) => (
                      <li key={f.id} className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-bold text-accent">
                            {f.score}/10
                          </span>
                          <span className="text-xs font-semibold text-foreground/70">{f.rater.split('@')[0]}</span>
                          <span className="text-[11px] font-medium text-accent/80">
                            {new Date(f.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </span>
                        </div>
                        {f.comment && <p className="mt-1.5 text-sm leading-relaxed text-foreground/70">{f.comment}</p>}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-8 text-center text-sm text-foreground/60">
                    No feedback yet. Be the first to rate this agent.
                  </p>
                )}
              </section>
            </div>
          )}
          </div>
          </div>
        </>
      )}
    </AppPage>
  )
}

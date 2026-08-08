import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock,
  Copy,
  ExternalLink,
  FileJson,
  Gauge,
  Headset,
  Heart,
  Info,
  Languages,
  Loader2,
  MessageSquare,
  Palette,
  PenLine,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Star,
  Terminal,
  TrendingUp,
  Wrench,
} from 'lucide-react'
import { authHeaders, useAuth } from '../../store/auth'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { humanizeActivity, short } from '../../lib/format'
import { CHAIN_BY_ID, type ChainId } from '../../lib/chains'
import AgentAvatar from '../../components/AgentAvatar'
import AppPage from '../../components/app/AppPage'
import ChainLogo from '../../components/app/ChainLogo'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip'
import { useTabCarousel } from '../../hooks/useTabCarousel'
import CopyBlock from '../../components/app/CopyBlock'

type MarketAgent = {
  id: string
  name: string
  logoUrl?: string
  description: string
  category: string
  capabilities: string[]
  chain?: string
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
  /** The public ERC-8004 registration document, as stored at register time. */
  registration?: Record<string, unknown>
  /** What this agent sells, trimmed to card fields. */
  services?: { name: string; priceUsd: number; unit: string }[]
  /** Cheapest listed service; null when the agent sells nothing. */
  priceFromUsd?: number | null
  /** Real completed sales: tasks whose escrow actually released. */
  soldCount?: number
  feedbackBreakdown?: { positive: number; neutral: number; negative: number }
  positivePct?: number | null
  /** A live callable endpoint is registered, nothing more. */
  online?: boolean
  /** 'escrow' always; 'x402' only with a callable endpoint. */
  payments?: string[]
  /** Owner-picked card style preset (1..6 onto --cat-1..6), or null. */
  cardStyle?: number | null
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

const PROFILE_TABS = ['overview', 'services', 'statistics', 'quality', 'feedback', 'metadata'] as const
type ProfileTab = (typeof PROFILE_TABS)[number]

const TAB_META: { id: ProfileTab; label: string; icon: typeof Info }[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'services', label: 'Services', icon: Wrench },
  { id: 'statistics', label: 'Statistics', icon: BarChart3 },
  { id: 'quality', label: 'Quality', icon: Gauge },
  { id: 'feedback', label: 'Rating & Feedback', icon: MessageSquare },
  { id: 'metadata', label: 'Metadata', icon: FileJson },
]

/** Keyword-to-glyph map for service rows, same idiom as AgentAvatar's category map. */
const SERVICE_ICONS: { match: RegExp; icon: typeof Wrench }[] = [
  { match: /translat|language|locali/i, icon: Languages },
  { match: /trad|invest|defi|financ|portfolio|swap/i, icon: TrendingUp },
  { match: /research|analy|data|scan|monitor|search/i, icon: Search },
  { match: /writ|content|blog|copy|summar|report|doc/i, icon: PenLine },
  { match: /code|dev|review|debug|engineer|deploy|test/i, icon: Terminal },
  { match: /audit|secur|risk|compliance|kyc|verif/i, icon: ShieldCheck },
  { match: /support|help|assist|customer|chat/i, icon: Headset },
  { match: /design|image|art|logo|video|brand/i, icon: Palette },
  { match: /pay|invoice|billing|settle|escrow/i, icon: CircleDollarSign },
]

function serviceIcon(name: string) {
  return SERVICE_ICONS.find((s) => s.match.test(name))?.icon ?? Wrench
}

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
  const [allAgents, setAllAgents] = useState<MarketAgent[]>([])
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

  // Hero micro-interactions: id copy, wallet copy (inside the chain tooltip),
  // and the inline "how we calculate" popover.
  const [copiedId, setCopiedId] = useState(false)
  const [copiedWallet, setCopiedWallet] = useState(false)
  const [calcOpen, setCalcOpen] = useState(false)
  const calcRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await apiFetch(`/api/marketplace?viewer=${encodeURIComponent(viewer)}&all=1`)
        const data = (await res.json()) as { agents: MarketAgent[] }
        if (cancelled) return
        setAllAgents(data.agents)
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

  // The calculation popover dismisses on outside click and Escape, like any menu.
  useEffect(() => {
    if (!calcOpen) return
    const onDown = (e: PointerEvent) => {
      if (calcRef.current && e.target instanceof Node && !calcRef.current.contains(e.target)) setCalcOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCalcOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [calcOpen])

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

  // The typed lines: the agent's name, then its full id (platform + ERC-8004).
  const idLine = agent ? (agent.onchainAgentId ? `${agent.id} · ERC-8004 #${agent.onchainAgentId}` : agent.id) : ''
  const certLines = useMemo(() => (agent ? [agent.name, idLine] : []), [agent, idLine])
  const { revealed, done, activeLine } = useTypewriter(certLines)

  const copyId = () => {
    navigator.clipboard?.writeText(idLine)
    setCopiedId(true)
    setTimeout(() => setCopiedId(false), 1500)
  }
  const copyWallet = () => {
    if (!agent?.walletAddress) return
    navigator.clipboard?.writeText(agent.walletAddress)
    setCopiedWallet(true)
    setTimeout(() => setCopiedWallet(false), 1500)
  }

  const rep = agent?.reputation
  const fbAvg = feedback?.avg ?? agent?.feedback?.avg ?? null
  const fbCount = feedback?.count ?? agent?.feedback?.count ?? 0
  const breakdown = agent?.feedbackBreakdown
  const soldCount = agent?.soldCount ?? 0
  const chainInfo = agent?.chain && agent.chain in CHAIN_BY_ID ? CHAIN_BY_ID[agent.chain as ChainId] : undefined
  const heroTint =
    agent?.cardStyle != null && agent.cardStyle >= 1 && agent.cardStyle <= 6 ? String(Math.round(agent.cardStyle)) : undefined
  const payments = agent?.payments ?? ['escrow']

  // "Explore more": related agents from the already-fetched marketplace list.
  // Same category first, then nearest composite rank score; never the agent itself.
  const related = useMemo(() => {
    if (!agent) return []
    const scoreOf = (a: MarketAgent) =>
      (a.reputation?.score ?? 0) +
      (a.feedback?.avg ?? 0) * 20 +
      (a.feedback?.count ?? 0) * 10 +
      a.followers * 5 +
      (a.soldCount ?? 0) * 15
    const mine = scoreOf(agent)
    return allAgents
      .filter((a) => a.id !== agent.id && a.kya === 'verified')
      .map((a) => ({ a, diff: Math.abs(scoreOf(a) - mine), sameCat: a.category === agent.category }))
      .sort((x, y) => (x.sameCat === y.sameCat ? x.diff - y.diff : x.sameCat ? -1 : 1))
      .slice(0, 8)
      .map((r) => r.a)
  }, [allAgents, agent])

  // Explore-more auto-advance: ~5s per step, paused while hovered or focused,
  // and never started at all under prefers-reduced-motion.
  const stripRef = useRef<HTMLDivElement | null>(null)
  const stripPaused = useRef(false)
  const spinStrip = useCallback((dir: 1 | -1) => {
    const el = stripRef.current
    if (!el) return
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    const card = el.firstElementChild as HTMLElement | null
    const step = card ? card.offsetWidth + 12 : 236
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 8
    const atStart = el.scrollLeft <= 8
    if (dir === 1 && atEnd) el.scrollTo({ left: 0, behavior })
    else if (dir === -1 && atStart) el.scrollTo({ left: el.scrollWidth, behavior })
    else el.scrollBy({ left: dir * step, behavior })
  }, [])
  useEffect(() => {
    if (related.length < 2) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const iv = setInterval(() => {
      if (!stripPaused.current) spinStrip(1)
    }, 5000)
    return () => clearInterval(iv)
  }, [related.length, spinStrip])

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
          {/* The profile hero. The certificate's dark glass ground (tinted by the
              owner's card style when set), the agent's own mark as the seal, its
              registry facts typed on, and a slow sheen. */}
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
                      ['Chain', chainInfo ? chainInfo.name : 'Circle Arc (testnet)', null],
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
          {shownTab === 'metadata' && (
            <div className="mt-4 flex flex-col gap-4">
              {/* The agent's own registration document, verbatim. */}
              <CopyBlock
                title="Registration document"
                subtitle="The off-chain metadata stored when this agent registered (ERC-8004 registration shape)."
                text={JSON.stringify(
                  agent.registration ?? {
                    name: agent.name,
                    description: agent.description,
                    category: agent.category,
                    capabilities: agent.capabilities,
                    chain: 'eip155:5042002',
                    registeredAt: agent.createdAt.slice(0, 10),
                  },
                  null,
                  2,
                )}
              />

              {/* Connect the machine way: MCP + REST, copy-paste ready. */}
              <CopyBlock
                title="MCP server"
                subtitle="Add the A-Identity MCP server to any client (Claude Code shown); every console capability is a tool."
                text={'claude mcp add a-identity --transport http https://a-identity.xyz/mcp'}
              />
              <CopyBlock
                title="Self-register over REST"
                subtitle="Agents register themselves with one manifest-shaped POST (verified session cookie or bearer required)."
                text={`curl -X POST https://a-identity.xyz/api/agents/register \\
  -H 'Content-Type: application/json' \\
  -d '{"manifest":{"name":"My Agent","description":"What it does (20+ chars)","category":"${agent.category}","capabilities":["translation"]}}'`}
              />
              <CopyBlock
                title="Quick register from a metadata URL"
                subtitle="Already host an agent manifest? Point the registrar at it and skip the wizard."
                text={`curl -X POST https://a-identity.xyz/api/agents/register-url \\
  -H 'Content-Type: application/json' \\
  -d '{"url":"https://your-agent.example.com/.well-known/agent-manifest.json"}'`}
              />

              {/* What registering actually takes, split by where it happens. */}
              <section className="rounded-2xl border border-border bg-card p-5">
                <h3 className="text-sm font-bold text-foreground/80">What registration needs</h3>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">Off-chain</div>
                    <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm text-foreground/70">
                      <li>name, description (20+ chars), category</li>
                      <li>capabilities (become hireable services)</li>
                      <li>optional: square logo (resized to 96px, stored as a data URL)</li>
                      <li>optional: wallet address + reachable endpoint</li>
                    </ul>
                  </div>
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-foreground/50">On-chain (Circle Arc testnet)</div>
                    <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm text-foreground/70">
                      <li>
                        ERC-8004 IdentityRegistry{' '}
                        <a
                          href="https://testnet.arcscan.app/address/0x8004A818BFB912233c491871b3d84c89A494BD9e"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-accent hover:underline"
                        >
                          0x8004A8...BD9e
                        </a>{' '}
                        on eip155:5042002
                      </li>
                      <li>anchor: one register tx (the console's "Anchor on Arc")</li>
                      <li>KYA: prove wallet control with one signature</li>
                      <li>gas is USDC on Arc; testnet funds from faucet.circle.com</li>
                    </ul>
                  </div>
                </div>
              </section>
            </div>
          )}
          </div>
          </div>

          {/* Explore more: related agents from the same fetched list, same
              category first, then nearest composite score. Auto-advances every
              ~5s, pauses on hover/focus, and stays still under reduced motion. */}
          {related.length > 0 && (
            <section
              className="mt-8"
              aria-label="Explore more agents"
              onPointerEnter={() => {
                stripPaused.current = true
              }}
              onPointerLeave={() => {
                stripPaused.current = false
              }}
              onFocusCapture={() => {
                stripPaused.current = true
              }}
              onBlurCapture={() => {
                stripPaused.current = false
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold text-foreground/80">Explore more agents</h3>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => spinStrip(-1)}
                    aria-label="Previous agents"
                    className="grid h-8 w-8 place-items-center rounded-full border border-border text-foreground/60 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => spinStrip(1)}
                    aria-label="Next agents"
                    className="grid h-8 w-8 place-items-center rounded-full border border-border text-foreground/60 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              </div>
              <div ref={stripRef} className="cn-pf2-strip mt-3 flex gap-3 overflow-x-auto pb-1">
                {related.map((r) => (
                  <Link
                    key={r.id}
                    to={`/app/marketplace/${r.id}`}
                    className="w-56 shrink-0 rounded-2xl border border-border bg-card p-4 transition-colors duration-[120ms] hover:border-accent/40"
                  >
                    <div className="flex items-center gap-3">
                      <AgentAvatar
                        seed={r.onchainAgentId || r.id}
                        category={r.category}
                        size={40}
                        verdict={r.kya === 'verified' ? 'allow' : 'warn'}
                        src={r.logoUrl}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-foreground">{r.name}</div>
                        <div className="truncate text-[11px] text-foreground/55">{r.category}</div>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-1 font-semibold text-foreground/75">
                        <Star size={11} className="text-warn" fill="currentColor" />
                        {r.feedback?.avg != null ? (
                          <>
                            {r.feedback.avg.toFixed(1)}
                            <span className="font-medium text-foreground/45">({r.feedback.count})</span>
                          </>
                        ) : (
                          <span className="font-medium text-foreground/45">No ratings</span>
                        )}
                      </span>
                      <span className="tabular-nums font-medium text-foreground/55">{r.soldCount ?? 0} sold</span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </AppPage>
  )
}

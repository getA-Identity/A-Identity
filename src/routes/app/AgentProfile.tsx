import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { authHeaders, useAuth } from '../../store/auth'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { CHAIN_BY_ID, type ChainId } from '../../lib/chains'
import AppPage from '../../components/app/AppPage'
import { Skeleton } from '../../components/ui/skeleton'
import { useTabCarousel } from '../../hooks/useTabCarousel'
import { useTypewriter } from '../../hooks/useTypewriter'
import ProfileHero from '../../components/app/profile/ProfileHero'
import OverviewPane from '../../components/app/profile/OverviewPane'
import ServicesPane from '../../components/app/profile/ServicesPane'
import StatisticsPane from '../../components/app/profile/StatisticsPane'
import QualityPane from '../../components/app/profile/QualityPane'
import FeedbackPane from '../../components/app/profile/FeedbackPane'
import MetadataPane from '../../components/app/profile/MetadataPane'
import RelatedStrip from '../../components/app/profile/RelatedStrip'
import {
  PROFILE_TABS,
  TAB_META,
  type CatalogService,
  type FeedbackData,
  type MarketAgent,
  type ProfileTab,
} from '../../components/app/profile/types'

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
      ambient
      title="Agent profile"
      description="The public record of one agent: its certificate, its services, its numbers, and what people say about it."
      actions={
        <Link
          to="/app/marketplace"
          className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-xs font-semibold text-foreground/70 transition-colors duration-[120ms] hover:bg-foreground/[0.04]"
        >
          <ArrowLeft size={13} /> Marketplace
        </Link>
      }
    >
      {error && (
        <div className="mt-6 rounded-2xl border border-warn/25 bg-warn/10 p-4 text-sm text-foreground/70">{error}</div>
      )}

      {!loaded && (
        <div className="mt-6 space-y-4">
          <Skeleton className="h-64 w-full rounded-3xl" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      )}

      {loaded && !error && !agent && (
        <div className="mt-6 rounded-2xl border border-dashed border-foreground/15 bg-card p-10 text-center text-sm text-foreground/60">
          This agent does not exist (or is not listed). Back to the
          <Link to="/app/marketplace" className="ml-1 font-semibold text-accent hover:underline">
            marketplace
          </Link>
          .
        </div>
      )}

      {agent && (
        <>
          <ProfileHero
            agent={agent}
            heroTint={heroTint}
            revealed={revealed}
            done={done}
            activeLine={activeLine}
            copiedId={copiedId}
            copyId={copyId}
            rep={rep}
            fbAvg={fbAvg}
            fbCount={fbCount}
            calcOpen={calcOpen}
            setCalcOpen={setCalcOpen}
            calcRef={calcRef}
            breakdown={breakdown}
            soldCount={soldCount}
            chainInfo={chainInfo}
            copiedWallet={copiedWallet}
            copyWallet={copyWallet}
            toggleFollow={toggleFollow}
          />

          {/* Tab strip, same language as the rest of the console. */}
          <div className="mt-6 flex flex-wrap gap-1.5 border-b border-border pb-3" role="tablist" aria-label="Agent profile sections">
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
          {shownTab === 'overview' && <OverviewPane agent={agent} chainInfo={chainInfo} />}

          {shownTab === 'services' && <ServicesPane services={services} payments={payments} />}

          {shownTab === 'statistics' && <StatisticsPane rep={rep} fbAvg={fbAvg} agent={agent} />}

          {shownTab === 'quality' && <QualityPane quality={quality} qualityMet={qualityMet} />}

          {shownTab === 'feedback' && (
            <FeedbackPane
              verified={verified}
              myScore={myScore}
              myComment={myComment}
              rating={rating}
              rateNote={rateNote}
              setMyScore={setMyScore}
              setMyComment={setMyComment}
              submitRating={submitRating}
              feedback={feedback}
              fbAvg={fbAvg}
              fbCount={fbCount}
            />
          )}
          {shownTab === 'metadata' && <MetadataPane agent={agent} />}
          </div>
          </div>

          {/* Explore more: related agents from the same fetched list, same
              category first, then nearest composite score (ranked above). */}
          <RelatedStrip related={related} />
        </>
      )}
    </AppPage>
  )
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowUpRight,
  BadgeCheck,
  Bookmark,
  Clock,
  Heart,
  LayoutGrid,
  List,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Trophy,
  X,
  Zap,
} from 'lucide-react'
import { authHeaders, useAuth } from '../../store/auth'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { humanizeActivity } from '../../lib/format'
import { CHAIN_BY_ID, type ChainId } from '../../lib/chains'
import AgentAvatar from '../../components/AgentAvatar'
import BrandArt from '../../components/app/BrandArt'
import ChainLogo from '../../components/app/ChainLogo'
import FeaturedCarousel, { RankBadge, Stars, type FeaturedAgent } from '../../components/app/FeaturedCarousel'
import WorkerCatalog from '../../components/app/WorkerCatalog'
import AppPage from '../../components/app/AppPage'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'

type Service = { name: string; priceUsd: number; unit: string }

type MarketAgent = {
  id: string
  name: string
  logoUrl?: string
  description: string
  category: string
  capabilities: string[]
  chain: string
  kya: string
  onchain: string
  onchainTx?: string
  onchainExplorer?: string
  onchainAgentId?: string
  reputation?: { score: number; breakdown: { settlement: number; validation: number; tenure: number } }
  walletAddress: string | null
  followers: number
  followedByViewer: boolean
  activity: { at: string; text: string }[]
  createdAt: string
  // Commerce fields (all real backend state; optional so an older payload degrades
  // to the plain card instead of crashing the roster).
  services?: Service[]
  priceFromUsd?: number | null
  soldCount?: number
  feedback?: { avg: number | null; count: number }
  feedbackBreakdown?: { positive: number; neutral: number; negative: number; positivePct: number | null }
  online?: boolean
  payments?: string[]
  cardStyle?: number | null
}

// One row of GET /api/marketplace/leaderboard: the server's composite ranking over
// the same KYA-verified showcase the Agent House feed serves.
type LeaderboardRow = FeaturedAgent

type SortKey = 'default' | 'reputation' | 'followers' | 'newest' | 'rating' | 'price' | 'selling'
const SORT_KEYS: SortKey[] = ['default', 'reputation', 'followers', 'newest', 'rating', 'price', 'selling']
const SORT_LABELS: Record<SortKey, string> = {
  default: 'Default',
  reputation: 'Top reputation',
  followers: 'Most followed',
  newest: 'Newest',
  rating: 'Highest rating',
  price: 'Lowest price',
  selling: 'Best selling',
}

type PayFilter = 'all' | 'escrow' | 'x402'

/** A saved toolbar preset. Older entries (query/sort/showAll/view only) are
 *  revived with defaults for the newer filter fields, so nothing saved before
 *  this redesign is lost or crashes the parse. */
type SavedSearch = {
  name: string
  query: string
  sort: SortKey
  showAll: boolean
  view: 'list' | 'grid'
  cats: string[]
  online: boolean
  pay: PayFilter
  chain: string
}

function reviveSavedSearches(raw: string | null): SavedSearch[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
      .filter((x) => typeof x.name === 'string')
      .map((x) => ({
        name: x.name as string,
        query: typeof x.query === 'string' ? x.query : '',
        sort: SORT_KEYS.includes(x.sort as SortKey) ? (x.sort as SortKey) : 'default',
        showAll: Boolean(x.showAll),
        view: x.view === 'grid' ? 'grid' : 'list',
        cats: Array.isArray(x.cats) ? (x.cats as unknown[]).filter((c): c is string => typeof c === 'string') : [],
        online: Boolean(x.online),
        pay: x.pay === 'escrow' || x.pay === 'x402' ? x.pay : 'all',
        chain: typeof x.chain === 'string' ? x.chain : 'all',
      }))
  } catch {
    return []
  }
}

const fmtUsd = (n: number) => (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2))

/** The cheapest listed service, for the "from $X per unit" line. Falls back to the
 *  server's priceFromUsd (without a unit) if the services array is ever absent. */
function cheapestService(a: MarketAgent): { priceUsd: number; unit: string } | null {
  if (a.services && a.services.length > 0) {
    const s = a.services.reduce((min, sv) => (sv.priceUsd < min.priceUsd ? sv : min))
    return { priceUsd: s.priceUsd, unit: s.unit.replace(/^per\s+/i, '').trim() }
  }
  if (typeof a.priceFromUsd === 'number') return { priceUsd: a.priceFromUsd, unit: '' }
  return null
}

/** Price lead: real starting price when the agent lists services, honest fallback when not. */
function PriceLine({ a, className = '' }: { a: MarketAgent; className?: string }) {
  const c = cheapestService(a)
  if (!c)
    return <span className={`text-sm font-semibold text-foreground/55 ${className}`}>Quote per task</span>
  return (
    <span className={`text-sm font-bold tabular-nums text-foreground ${className}`}>
      from ${fmtUsd(c.priceUsd)}
      {c.unit && <span className="font-medium text-foreground/50"> per {c.unit}</span>}
    </span>
  )
}

/** Social proof row: stars, positive share, completed sales. Only claims we hold. */
function CommerceRow({ a, className = '' }: { a: MarketAgent; className?: string }) {
  const pct = a.feedbackBreakdown?.positivePct ?? null
  const sold = a.soldCount ?? 0
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${className}`}>
      <Stars avg={a.feedback?.avg ?? null} count={a.feedback?.count ?? 0} />
      {pct != null && <span className="text-[11px] font-semibold text-ok">{pct}% positive</span>}
      {sold > 0 && (
        <span className="text-[11px] font-medium tabular-nums text-foreground/55">
          {sold} sold
        </span>
      )}
    </div>
  )
}

/** Trust chips: settlement rails, the chain this agent lives on, and whether a live
 *  callable endpoint is registered. Every chip maps 1:1 to a backend field. */
function MetaChips({ a, className = '' }: { a: MarketAgent; className?: string }) {
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

export default function Marketplace() {
  const user = useAuth((s) => s.user)
  // Follow/follower identity = the signed-in caller (their wallet address or email),
  // so follows are per-user, not shared across everyone. Falls back to 'guest' only
  // for a tokenless browse session (whose follow writes the server rejects anyway).
  const viewer = user?.email || user?.name || 'guest'

  const [agents, setAgents] = useState<MarketAgent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openActivity, setOpenActivity] = useState<string | null>(null)
  const [anchoringId, setAnchoringId] = useState<string | null>(null)
  const [anchorNote, setAnchorNote] = useState<Record<string, string>>({})
  // Default view is the KYA-verified showcase; the toggle reveals pending agents too.
  const [showAll, setShowAll] = useState(false)
  const [counts, setCounts] = useState({ total: 0, totalAll: 0 })
  // The pivot hero is the trusted-worker catalog; Agent House and the Leaderboard
  // are the second and third tabs.
  const [tab, setTab] = useState<'hire' | 'house' | 'leaderboard'>('hire')

  // Leaderboard: ONE server-computed composite ranking, fetched lazily the first time
  // a surface that shows it opens (the Leaderboard tab, or the featured carousel on the
  // Agent House pane). The weekly wording on the carousel frames this same data.
  const [lbRows, setLbRows] = useState<LeaderboardRow[]>([])
  const [lbComputedAt, setLbComputedAt] = useState<string | null>(null)
  const [lbLoading, setLbLoading] = useState(false)
  const [lbError, setLbError] = useState<string | null>(null)
  const [lbLoadedOnce, setLbLoadedOnce] = useState(false)

  const loadLeaderboard = useCallback(async () => {
    setLbLoading(true)
    try {
      const res = await apiFetch('/api/marketplace/leaderboard')
      const data = await readJson<{ agents?: LeaderboardRow[]; computedAt?: string; error?: string }>(res)
      if (!res.ok) {
        setLbError(explainError(res.status, data.error))
        return
      }
      setLbRows(data.agents ?? [])
      setLbComputedAt(data.computedAt ?? null)
      setLbError(null)
    } catch {
      setLbError(BACKEND_UNREACHABLE)
    } finally {
      setLbLoading(false)
    }
  }, [])

  // Same deferred pattern as the Agent House roster below: nobody pays for a
  // leaderboard request while they are still on the hire tab.
  useEffect(() => {
    if (lbLoadedOnce || (tab !== 'leaderboard' && tab !== 'house')) return
    setLbLoadedOnce(true)
    loadLeaderboard()
  }, [tab, lbLoadedOnce, loadLeaderboard])

  // The proportional rank-score bars scale against the leader.
  const lbMax = lbRows.reduce((m, r) => Math.max(m, r.rankScore), 0)

  // House toolbar: search, sort, structural filters, view mode, and saved searches
  // (all client-side, over the real roster; the view mode and presets persist per browser).
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>('default')
  const [cats, setCats] = useState<string[]>([])
  const [onlineOnly, setOnlineOnly] = useState(false)
  const [pay, setPay] = useState<PayFilter>('all')
  const [chainF, setChainF] = useState<string>('all')
  const [view, setView] = useState<'list' | 'grid'>(() => {
    try {
      return localStorage.getItem('aid-mkt-view') === 'grid' ? 'grid' : 'list'
    } catch {
      return 'list'
    }
  })
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>(() => {
    try {
      return reviveSavedSearches(localStorage.getItem('aid-mkt-saved'))
    } catch {
      return []
    }
  })
  const setViewPersist = (v: 'list' | 'grid') => {
    setView(v)
    try {
      localStorage.setItem('aid-mkt-view', v)
    } catch {
      /* private mode */
    }
  }
  const saveCurrentSearch = () => {
    const parts = [query.trim() || 'all agents', SORT_LABELS[sort]]
    if (cats.length > 0) parts.push(cats.join('+'))
    if (onlineOnly) parts.push('online')
    if (pay !== 'all') parts.push(pay)
    if (chainF !== 'all') parts.push(CHAIN_BY_ID[chainF as ChainId]?.shortName ?? chainF)
    if (showAll) parts.push('incl. pending')
    const name = parts.join(' · ')
    const entry: SavedSearch = { name, query: query.trim(), sort, showAll, view, cats, online: onlineOnly, pay, chain: chainF }
    const next = [...savedSearches.filter((x) => x.name !== name), entry]
    setSavedSearches(next)
    try {
      localStorage.setItem('aid-mkt-saved', JSON.stringify(next))
    } catch {
      /* private mode */
    }
  }
  const applySaved = (sv: SavedSearch) => {
    setQuery(sv.query)
    setSort(sv.sort)
    setShowAll(sv.showAll)
    setViewPersist(sv.view)
    setCats(sv.cats)
    setOnlineOnly(sv.online)
    setPay(sv.pay)
    setChainF(sv.chain)
  }
  const removeSaved = (name: string) => {
    const next = savedSearches.filter((x) => x.name !== name)
    setSavedSearches(next)
    try {
      localStorage.setItem('aid-mkt-saved', JSON.stringify(next))
    } catch {
      /* private mode */
    }
  }

  // Filter options are computed from the loaded roster, never a hardcoded list:
  // a category or chain appears here only when at least one real agent carries it.
  const catOptions = useMemo(() => {
    const m = new Map<string, number>()
    for (const a of agents) {
      const c = a.category || 'Uncategorized'
      m.set(c, (m.get(c) ?? 0) + 1)
    }
    return [...m.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
  }, [agents])
  const chainOptions = useMemo(() => [...new Set(agents.map((a) => a.chain))], [agents])
  const anyX402 = useMemo(() => agents.some((a) => (a.payments ?? []).includes('x402')), [agents])

  const toggleCat = (c: string) =>
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  const structuralActive = cats.length > 0 || onlineOnly || pay !== 'all' || chainF !== 'all'
  const clearFilters = () => {
    setCats([])
    setOnlineOnly(false)
    setPay('all')
    setChainF('all')
  }

  // Semantic mode: a metered natural-language search on the backend (5 free per
  // day, then a hard 402). Results carry match reasons; the roster rows reorder
  // to the server's ranking and show why each one matched.
  const [semantic, setSemantic] = useState(false)
  const [semBusy, setSemBusy] = useState(false)
  const [semRemaining, setSemRemaining] = useState<number | null>(null)
  const [semNote, setSemNote] = useState<string | null>(null)
  const [semMatches, setSemMatches] = useState<Record<string, { score: number; reasons: string[] }> | null>(null)
  const [semOrder, setSemOrder] = useState<string[] | null>(null)

  const runSemantic = async () => {
    const q = query.trim()
    if (!q || semBusy) return
    setSemBusy(true)
    setSemNote(null)
    try {
      const res = await apiFetch(
        `/api/marketplace/semantic-search?q=${encodeURIComponent(q)}&viewer=${encodeURIComponent(viewer)}`,
      )
      const data = await readJson<{
        agents?: { id: string; matchScore: number; matchReasons: string[] }[]
        remaining?: number
        resetsAt?: string
        error?: string
        premium?: { note?: string; priceUsd?: number }
      }>(res)
      if (res.status === 402) {
        setSemNote(
          `${data.error ?? 'Free semantic searches used up.'} Resets ${data.resetsAt ? new Date(data.resetsAt).toLocaleString() : 'at UTC midnight'}. ${data.premium?.note ?? ''}`,
        )
        setSemRemaining(0)
        return
      }
      if (!res.ok) {
        setSemNote(explainError(res.status, data.error))
        return
      }
      const rows = data.agents ?? []
      setSemOrder(rows.map((r) => r.id))
      setSemMatches(Object.fromEntries(rows.map((r) => [r.id, { score: r.matchScore, reasons: r.matchReasons }])))
      setSemRemaining(typeof data.remaining === 'number' ? data.remaining : null)
      if (rows.length === 0) setSemNote('No agents matched that description.')
    } catch {
      setSemNote(BACKEND_UNREACHABLE)
    } finally {
      setSemBusy(false)
    }
  }
  const clearSemantic = () => {
    setSemOrder(null)
    setSemMatches(null)
    setSemNote(null)
  }

  const shown = agents
    // Structural filters ALWAYS apply, semantic mode included: asking for "online
    // x402 sellers" and then describing a job should intersect the two, not race them.
    .filter((a) => {
      if (cats.length > 0 && !cats.includes(a.category || 'Uncategorized')) return false
      if (onlineOnly && !a.online) return false
      if (pay !== 'all' && !(a.payments ?? ['escrow']).includes(pay)) return false
      if (chainF !== 'all' && a.chain !== chainF) return false
      return true
    })
    .filter((a) => {
      const q = query.trim().toLowerCase()
      if (!q) return true
      // With a semantic result in hand, membership belongs to the server's
      // ranking (applied below); the literal substring test would empty the
      // list, since nobody's name contains the whole question.
      if (semantic && semOrder) return true
      return (
        a.name.toLowerCase().includes(q) ||
        a.category.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q) ||
        a.capabilities.some((c) => c.toLowerCase().includes(q))
      )
    })
    .sort((a, b) => {
      // 'default' keeps the server's marketRank order (the sort is stable).
      if (sort === 'default') return 0
      if (sort === 'reputation') return (b.reputation?.score ?? -1) - (a.reputation?.score ?? -1)
      if (sort === 'followers') return b.followers - a.followers
      if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt)
      // Ratings on the 1-10 scale: unrated (null) sinks below every rated agent.
      if (sort === 'rating') return (b.feedback?.avg ?? -1) - (a.feedback?.avg ?? -1)
      // Cheapest first; agents with no listed price (quote per task) go last.
      if (sort === 'price') return (a.priceFromUsd ?? Infinity) - (b.priceFromUsd ?? Infinity)
      return (b.soldCount ?? 0) - (a.soldCount ?? 0) // 'selling'
    })
    // In semantic mode the server's ranking wins: reorder to it and drop non-matches.
    .filter((a) => !(semantic && semOrder) || semOrder.includes(a.id))
    .sort((a, b) => {
      if (!(semantic && semOrder)) return 0
      return semOrder.indexOf(a.id) - semOrder.indexOf(b.id)
    })

  const load = useCallback(async () => {
    try {
      const url = `/api/marketplace?viewer=${encodeURIComponent(viewer)}${showAll ? '&all=1' : ''}`
      const res = await apiFetch(url)
      const data = (await res.json()) as { agents: MarketAgent[]; total?: number; totalAll?: number }
      setAgents(data.agents)
      setCounts({ total: data.total ?? data.agents.length, totalAll: data.totalAll ?? data.agents.length })
      setError(null)
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setLoading(false)
    }
  }, [viewer, showAll])

  // The Agent House roster loads when its tab is first opened (or a filter changes),
  // not on mount: someone hiring a worker should not pay for a request they never see.
  const [houseLoadedOnce, setHouseLoadedOnce] = useState(false)
  useEffect(() => {
    if (tab !== 'house' && houseLoadedOnce) return
    if (tab === 'house') setHouseLoadedOnce(true)
    if (tab === 'house' || houseLoadedOnce) load()
  }, [load, tab, houseLoadedOnce])

  const toggleFollow = async (agentId: string) => {
    // Optimistic flip, then reconcile with the server.
    setAgents((prev) =>
      prev.map((a) =>
        a.id === agentId
          ? {
              ...a,
              followedByViewer: !a.followedByViewer,
              followers: a.followers + (a.followedByViewer ? -1 : 1),
            }
          : a,
      ),
    )
    try {
      await apiFetch('/api/follow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, follower: viewer }),
      })
    } catch {
      load()
    }
  }

  // Deliberate, human-triggered on-chain anchor for a queued agent: broadcasts a
  // real ERC-8004 registration on Arc and flips the card to "registered" with a tx link.
  const anchorAgent = async (agentId: string) => {
    setAnchoringId(agentId)
    setAnchorNote((n) => ({ ...n, [agentId]: '' }))
    try {
      const res = await apiFetch('/api/agents/anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId }),
        timeoutMs: 90_000, // an on-chain ERC-8004 register can take a while to confirm
        onWaking: () => setAnchorNote((n) => ({ ...n, [agentId]: 'Waking up the backend (free tier)…' })),
      })
      const data = await readJson<{
        agent?: { onchain?: string; onchainTx?: string; onchainExplorer?: string; onchainAgentId?: string }
        result?: { executed?: boolean; reason?: string }
        error?: string
      }>(res)
      if (res.ok && data.result?.executed && data.agent) {
        setAgents((prev) => prev.map((a) => (a.id === agentId ? { ...a, ...data.agent } : a)))
        setAnchorNote((n) => ({ ...n, [agentId]: '' }))
      } else if (!res.ok) {
        // 403 = you don't own this agent; 401 = guest; 5xx = backend waking. Say which.
        setAnchorNote((n) => ({ ...n, [agentId]: explainError(res.status, data.error) }))
      } else {
        setAnchorNote((n) => ({
          ...n,
          [agentId]: data.result?.reason ?? data.error ?? 'Could not broadcast. The server needs a funded ARC_SIGNER_KEY.',
        }))
      }
    } catch {
      setAnchorNote((n) => ({ ...n, [agentId]: 'Anchoring timed out. The backend may be waking up, try again in a moment.' }))
    } finally {
      setAnchoringId(null)
    }
  }

  return (
    <AppPage
      ambient
      title="Marketplace"
      description="Hire a verified agent to do a job, or browse the agents already working on Arc."
    >
      {/* Segmented control with a sliding thumb: the console's one overshoot curve. */}
      <div data-tour="views" className="relative inline-grid max-w-full grid-cols-3 rounded-full border border-border bg-card p-1 text-sm font-semibold" role="tablist" aria-label="Marketplace views">
        <span
          aria-hidden="true"
          className={`cn-seg-thumb absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/3)] rounded-full bg-accent ${
            tab === 'leaderboard' ? 'translate-x-[200%]' : tab === 'house' ? 'translate-x-full' : 'translate-x-0'
          }`}
        />
        {(['hire', 'house', 'leaderboard'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`relative z-10 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs transition-colors duration-[240ms] sm:px-4 sm:text-sm ${
              tab === t ? 'text-white' : 'text-foreground/60 hover:text-foreground'
            }`}
          >
            {t === 'hire' ? 'Hire a worker' : t === 'house' ? 'Agent House' : 'Leaderboard'}
          </button>
        ))}
      </div>

      {tab === 'hire' && (
        <div className="mt-6" data-tour="catalog">
          <WorkerCatalog />
        </div>
      )}

      {/* Leaderboard pane: the server's composite ranking, rendered as an
          e-commerce style rank table. Rendered fresh on each visit so the row
          stagger replays like the other tab panes. */}
      {tab === 'leaderboard' && (
        <div className="mt-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold tracking-tight">Leaderboard</h3>
              <p className="mt-1 max-w-xl text-sm text-foreground/55">
                Every KYA-verified agent, ranked by one composite score. Delivered paid work and
                verified ratings move it far more than followers, so finishing jobs beats popularity.
              </p>
            </div>
            {lbComputedAt && !lbError && (
              <span className="text-xs font-medium text-foreground/45">
                Computed {new Date(lbComputedAt).toLocaleString()}
              </span>
            )}
          </div>

          {lbError && (
            <div className="mt-6 rounded-2xl border border-warn/25 bg-warn/10 p-5 text-sm text-foreground/70">
              {lbError}
              <button
                type="button"
                onClick={() => {
                  setLbError(null)
                  loadLeaderboard()
                }}
                className="ml-3 font-semibold text-accent hover:underline"
              >
                Retry
              </button>
            </div>
          )}

          {lbLoading && !lbError && (
            <div className="mt-4 flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 rounded-2xl border border-border bg-card px-5 py-4">
                  <Skeleton className="h-7 w-7 rounded-full" />
                  <Skeleton className="h-9 w-9 rounded-xl" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>
          )}

          {!lbLoading && !lbError && lbRows.length === 0 && (
            <div className="mt-6 rounded-3xl border border-dashed border-foreground/15 bg-card p-12 text-center">
              <Trophy size={28} className="mx-auto text-foreground/25" />
              <h3 className="mt-4 text-lg font-bold text-foreground">No ranked agents yet.</h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-foreground/55">
                Only KYA-verified showcase agents can place. Register an agent and pass
                verification to claim the first spot.
              </p>
              <Link
                to="/app/agent-id"
                className="mt-5 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
              >
                <Plus size={15} /> Register an agent
              </Link>
            </div>
          )}

          {!lbLoading && !lbError && lbRows.length > 0 && (
            <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-card">
              <div className="min-w-[860px]">
                <div className="grid grid-cols-[3.5rem_minmax(230px,1.8fr)_minmax(180px,1.1fr)_6.5rem_6rem_6rem_minmax(150px,1fr)] items-center gap-3 border-b border-border px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                  <span>Rank</span>
                  <span>Agent</span>
                  <span>Rating</span>
                  <span className="text-right">Reputation</span>
                  <span className="text-right">Tasks done</span>
                  <span className="text-right">Followers</span>
                  <span className="text-right">Rank score</span>
                </div>
                <div className="cn-lb-rows">
                  {lbRows.map((r) => (
                    <div
                      key={r.id}
                      className="grid grid-cols-[3.5rem_minmax(230px,1.8fr)_minmax(180px,1.1fr)_6.5rem_6rem_6rem_minmax(150px,1fr)] items-center gap-3 border-b border-border px-5 py-3.5 transition-colors duration-[120ms] last:border-b-0 hover:bg-foreground/[0.03]"
                    >
                      <RankBadge rank={r.rank} />
                      <Link to={`/app/marketplace/${r.id}`} className="flex min-w-0 items-center gap-3 hover:opacity-90">
                        <AgentAvatar
                          seed={r.onchainAgentId || r.id}
                          category={r.category}
                          size={36}
                          verdict={r.kya === 'verified' ? 'allow' : 'warn'}
                          src={r.logoUrl}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-bold text-foreground hover:text-accent">{r.name}</span>
                          <span className="block truncate text-[11px] text-foreground/50">{r.category}</span>
                        </span>
                      </Link>
                      <Stars avg={r.feedback.avg} count={r.feedback.count} />
                      <span className="text-right text-sm font-semibold tabular-nums text-foreground">{r.reputation.score}</span>
                      <span className="text-right text-sm tabular-nums text-foreground/70">{r.tasksDone}</span>
                      <span className="text-right text-sm tabular-nums text-foreground/70">{r.followers}</span>
                      <span className="block">
                        <span className="block text-right text-sm font-bold tabular-nums text-foreground">{r.rankScore}</span>
                        <span className="ml-auto mt-1 block h-1 w-full max-w-[140px] overflow-hidden rounded-full bg-foreground/10">
                          <span
                            className="cn-lb-bar block h-full rounded-full bg-accent"
                            style={{ width: `${lbMax > 0 ? (r.rankScore / lbMax) * 100 : 0}%` }}
                          />
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              {lbRows.length < 10 && (
                <p className="border-t border-border px-5 py-3 text-[11px] font-medium text-foreground/45">
                  Only KYA-verified showcase agents can place, so a short list means a strict gate, not missing data.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div className={tab === 'house' ? 'mt-6' : 'hidden'}>
      {/* Featured carousel: the top of the SAME composite ranking the Leaderboard tab
          shows, framed for the storefront. Only real leaderboard rows render; there is
          no separate paid placement. The strip never touches the strict default filter
          of the roster below it. */}
      {lbRows.length > 0 && (
        <FeaturedCarousel
          rows={lbRows}
          title="Featured this week"
          subnote="Top of the same composite ranking as the Leaderboard tab"
          className="mb-6"
        />
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold tracking-tight">Agent House</h3>
          <p className="mt-1 max-w-xl text-sm text-foreground/55">
            The showcase for verified agents on Arc. Follow the ones you rely on and watch
            what they do. Each agent shows its real KYA status: green once it has proven control of its wallet.
          </p>
        </div>
        <Link
          to="/app/agent-id"
          className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
        >
          <Plus size={15} /> Register an agent
        </Link>
      </div>

      {/* Toolbar: search, sort, KYA filter, saved presets, and the view switch, plus
          the structural filter row (categories, endpoint, payment rail, chain).
          Everything operates client-side on the real roster. */}
      {!loading && !error && agents.length > 0 && (
        <div className="mt-4 space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground/40" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  if (semOrder) clearSemantic()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && semantic) runSemantic()
                }}
                placeholder={semantic ? 'Describe what kind of agent you need...' : 'Search name, category, capability...'}
                aria-label="Search agents"
                className={`w-full rounded-xl border bg-card py-2.5 pl-9 pr-20 text-sm outline-none transition-colors duration-[120ms] ${
                  semantic ? 'border-accent/50 focus:border-accent' : 'border-border focus:border-accent'
                }`}
              />
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                {semantic && (
                  <button
                    type="button"
                    onClick={runSemantic}
                    disabled={semBusy || !query.trim()}
                    className="rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-bold text-white disabled:opacity-40"
                  >
                    {semBusy ? '...' : 'Ask'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setSemantic((v) => !v)
                    clearSemantic()
                  }}
                  aria-pressed={semantic}
                  title={semantic ? 'Back to standard search' : 'Switch to semantic search (5 free per day)'}
                  className={`rounded-lg p-1.5 transition-colors duration-[120ms] ${
                    semantic ? 'bg-accent/15 text-accent' : 'text-foreground/40 hover:bg-foreground/[0.05] hover:text-accent'
                  }`}
                >
                  <Sparkles size={15} />
                </button>
              </div>
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort agents"
              className="rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-semibold text-foreground/75 outline-none"
            >
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SORT_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              aria-pressed={showAll}
              className={`rounded-xl border px-3 py-2.5 text-xs font-semibold transition-colors duration-[120ms] ${
                showAll ? 'border-warn/40 bg-warn/10 text-foreground/80' : 'border-border bg-card text-foreground/65 hover:bg-foreground/[0.04]'
              }`}
            >
              {showAll ? 'Incl. pending' : 'Verified only'}
            </button>
            <button
              type="button"
              onClick={saveCurrentSearch}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2.5 text-xs font-semibold text-foreground/65 transition-colors duration-[120ms] hover:bg-foreground/[0.04]"
            >
              <Bookmark size={13} /> Save
            </button>
            {/* View switch: two ways to read the same roster. */}
            <div className="ml-auto inline-flex overflow-hidden rounded-xl border border-border" role="tablist" aria-label="Roster view">
              {(
                [
                  ['list', List, 'List view'],
                  ['grid', LayoutGrid, 'Grid view'],
                ] as const
              ).map(([v, Icon, label]) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  aria-label={label}
                  onClick={() => setViewPersist(v)}
                  className={`p-2.5 transition-colors duration-[120ms] ${
                    view === v ? 'bg-accent text-white' : 'bg-card text-foreground/55 hover:text-foreground'
                  }`}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </div>

          {/* Structural filters, computed from the loaded roster. These compose with the
              verified-only toggle above AND with semantic mode: a semantic result is
              still intersected with whatever is toggled here. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {catOptions.map(([c, n]) => (
              <button
                key={c}
                type="button"
                onClick={() => toggleCat(c)}
                aria-pressed={cats.includes(c)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors duration-[120ms] ${
                  cats.includes(c)
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border bg-card text-foreground/60 hover:bg-foreground/[0.04]'
                }`}
              >
                {c} <span className="tabular-nums opacity-70">({n})</span>
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-foreground/65 transition-colors duration-[120ms] hover:bg-foreground/[0.04]">
              <input
                type="checkbox"
                checked={onlineOnly}
                onChange={(e) => setOnlineOnly(e.target.checked)}
                className="h-3 w-3"
                style={{ accentColor: 'var(--color-accent)' }}
              />
              Online only
            </label>
            {anyX402 && (
              <select
                value={pay}
                onChange={(e) => setPay(e.target.value as PayFilter)}
                aria-label="Filter by payment rail"
                className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-foreground/65 outline-none"
              >
                <option value="all">Any payment</option>
                <option value="escrow">Escrow</option>
                <option value="x402">x402</option>
              </select>
            )}
            {chainOptions.length > 0 && (
              <select
                value={chainF}
                onChange={(e) => setChainF(e.target.value)}
                aria-label="Filter by chain"
                className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold text-foreground/65 outline-none"
              >
                <option value="all">All chains</option>
                {chainOptions.map((c) => (
                  <option key={c} value={c}>
                    {CHAIN_BY_ID[c as ChainId]?.shortName ?? c}
                  </option>
                ))}
              </select>
            )}
            {structuralActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-foreground/50 transition-colors duration-[120ms] hover:text-danger"
              >
                <X size={11} /> Clear filters
              </button>
            )}
          </div>

          {savedSearches.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-semibold text-foreground/50">Saved:</span>
              {savedSearches.map((sv) => (
                <span key={sv.name} className="inline-flex items-center overflow-hidden rounded-full border border-border bg-card text-[11px] font-semibold">
                  <button
                    type="button"
                    onClick={() => applySaved(sv)}
                    className="px-2.5 py-1 text-foreground/70 transition-colors duration-[120ms] hover:bg-accent/10 hover:text-accent"
                  >
                    {sv.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeSaved(sv.name)}
                    aria-label={`Delete saved search ${sv.name}`}
                    className="px-1.5 py-1 text-foreground/35 hover:bg-danger/10 hover:text-danger"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground/55">
            <span>
              {shown.length} of {showAll ? counts.totalAll : counts.total} agents
              {!showAll && counts.totalAll > counts.total && ` · ${counts.totalAll - counts.total} pending hidden`}
            </span>
            {semantic && semRemaining != null && (
              <Badge variant={semRemaining > 0 ? 'default' : 'warning'}>
                <Sparkles size={11} /> {semRemaining} free semantic search{semRemaining === 1 ? '' : 'es'} left today
              </Badge>
            )}
          </div>
          {semNote && (
            <div className="rounded-xl border border-warn/25 bg-warn/10 px-3.5 py-2.5 text-xs font-medium text-foreground/75">
              {semNote}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-5 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {loading && !error && (
        <div className="mt-4 grid items-start gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col rounded-2xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-11 w-11 rounded-xl" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                </div>
                <Skeleton className="h-7 w-24 rounded-full" />
              </div>
              <div className="mt-3 space-y-2">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-4/5" />
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Skeleton className="h-6 w-24 rounded-full" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty state: the lean-startup honest zero */}
      {!loading && !error && agents.length === 0 && (
        <div className="mt-6 rounded-3xl border border-dashed border-foreground/15 bg-card p-12 text-center">
          {/* Stalls with coins on the counters and nobody trading: the same sentence as
              the copy below, drawn instead of typed. */}
          <BrandArt src="/art/art-market.webp" className="mx-auto h-44 w-56 sm:h-52 sm:w-72" />
          <h3 className="mt-4 text-lg font-bold text-foreground">The house is open, the floor is empty.</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-foreground/55">
            Be the first: register an agent, pass KYA, and it appears here with its own
            follower count and activity feed.
          </p>
          <Link
            to="/app/agent-id"
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
          >
            <Plus size={15} /> Register the first agent
          </Link>
        </div>
      )}

      {/* Filters that matched nobody: a real zero over a loaded roster, with the way out. */}
      {!loading && !error && agents.length > 0 && shown.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed border-foreground/15 bg-card p-10 text-center">
          <p className="text-sm font-semibold text-foreground/70">No agents match these filters.</p>
          <button
            type="button"
            onClick={() => {
              clearFilters()
              setQuery('')
              clearSemantic()
            }}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/65 transition-colors duration-[120ms] hover:bg-foreground/[0.04]"
          >
            <X size={12} /> Clear filters and search
          </button>
        </div>
      )}

      {/* Agent listing. One card or row per agent, product-card grade: identity,
          rating and social proof, price, and the trust chips (chain, rails, live
          endpoint), all from real backend state. */}
      {view === 'grid' ? (
        /* Grid: product cards, two up. The full record lives one click in. */
        <div className="mt-4 grid items-start gap-4 sm:grid-cols-2">
          {shown.map((a) => (
            <div key={a.id} className="cn-glow-wrap">
              <div className="cn-glow-card flex flex-col overflow-hidden rounded-2xl border border-border bg-card">
                {/* Owner-picked card style: a quiet tint strip from the six category tokens. */}
                {typeof a.cardStyle === 'number' && a.cardStyle >= 1 && a.cardStyle <= 6 && (
                  <span
                    className="block h-1 w-full"
                    style={{ background: `var(--cat-${a.cardStyle})` }}
                    aria-hidden="true"
                  />
                )}
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <Link to={`/app/marketplace/${a.id}`} className="flex min-w-0 items-center gap-3 hover:opacity-90">
                      <AgentAvatar
                        seed={a.onchainAgentId || a.id}
                        category={a.category}
                        size={44}
                        verdict={a.kya === 'verified' ? 'allow' : 'warn'}
                        src={a.logoUrl}
                      />
                      <div className="min-w-0">
                        <div className="truncate font-bold text-foreground">{a.name}</div>
                        <div className="truncate text-xs text-foreground/50">{a.category}</div>
                      </div>
                    </Link>
                    {a.kya === 'verified' ? (
                      <Badge variant="success">
                        <BadgeCheck size={11} /> KYA
                      </Badge>
                    ) : (
                      <Badge variant="warning">
                        <Clock size={11} /> pending
                      </Badge>
                    )}
                  </div>
                  <p className="mt-3 line-clamp-2 flex-1 text-sm leading-relaxed text-foreground/60">
                    {a.description || 'No description yet.'}
                  </p>
                  <CommerceRow a={a} className="mt-3" />
                  <MetaChips a={a} className="mt-2.5" />
                  <div className="mt-3 flex items-end justify-between gap-2 border-t border-border pt-3">
                    <div className="min-w-0">
                      <PriceLine a={a} />
                      <div className="mt-0.5 text-[11px] font-medium tabular-nums text-foreground/45">
                        Rep {a.reputation ? a.reputation.score : '-'} / 1000
                      </div>
                    </div>
                    <Link
                      to={`/app/marketplace/${a.id}`}
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-accent hover:underline"
                    >
                      View profile <ArrowUpRight size={12} />
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
      <div className="mt-4 flex flex-col gap-3">
        {shown.map((a) => (
          <div
            key={a.id}
            className="cn-glow-wrap"
          >
          <div className="cn-glow-card rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-start gap-4">
              <Link to={`/app/marketplace/${a.id}`} className="shrink-0 hover:opacity-90">
                <AgentAvatar
                  seed={a.onchainAgentId || a.id}
                  category={a.category}
                  size={56}
                  verdict={a.kya === 'verified' ? 'allow' : 'warn'}
                  src={a.logoUrl}
                />
              </Link>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/app/marketplace/${a.id}`} className="truncate text-base font-bold text-foreground hover:text-accent">
                    {a.name}
                  </Link>
                  {a.kya === 'verified' ? (
                    <Badge variant="success">
                      <BadgeCheck size={11} /> KYA verified
                    </Badge>
                  ) : (
                    <Badge variant="warning">KYA pending</Badge>
                  )}
                  {a.onchain === 'registered' ? (
                    a.onchainExplorer ? (
                      <a href={a.onchainExplorer} target="_blank" rel="noopener noreferrer" className="hover:underline">
                        <Badge variant="info">On-chain #{a.onchainAgentId ?? ''}</Badge>
                      </a>
                    ) : (
                      <Badge variant="info">On-chain #{a.onchainAgentId ?? ''}</Badge>
                    )
                  ) : (
                    <Badge variant="warning">
                      <Clock size={11} /> queued
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-foreground/45">{a.category}</div>
                <p className="mt-2 line-clamp-2 max-w-2xl text-sm leading-relaxed text-foreground/60">
                  {a.description || 'No description yet.'}
                </p>
                {semantic && semMatches?.[a.id] && (
                  <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-accent">
                    <Sparkles size={11} />
                    {semMatches[a.id].reasons.join(' · ') || 'semantic match'}
                  </p>
                )}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <CommerceRow a={a} />
                  <PriceLine a={a} />
                </div>
                <MetaChips a={a} className="mt-2" />
                {a.capabilities.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {a.capabilities.map((c) => (
                      <span key={c} className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-medium text-foreground/60">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* The numbers column: reputation first, then the social action. */}
              <div className="flex shrink-0 flex-col items-end gap-2.5">
                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/40">Reputation</div>
                  <div className="mt-0.5 text-2xl font-bold leading-none tabular-nums text-foreground">
                    {a.reputation ? a.reputation.score : '-'}
                    <span className="ml-1 text-xs font-semibold text-foreground/35">/ 1000</span>
                  </div>
                  {a.reputation && (
                    <div className="ml-auto mt-1.5 h-1 w-24 overflow-hidden rounded-full bg-foreground/10">
                      <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(a.reputation.score / 1000) * 100}%` }} />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => toggleFollow(a.id)}
                  aria-pressed={a.followedByViewer}
                  aria-label={`${a.followedByViewer ? 'Unfollow' : 'Follow'} ${a.name}`}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold transition-colors duration-[120ms] ${
                    a.followedByViewer
                      ? 'bg-accent text-white hover:bg-accent-deep'
                      : 'border border-foreground/15 text-foreground/70 hover:bg-foreground/5'
                  }`}
                >
                  <Heart size={12} fill={a.followedByViewer ? 'currentColor' : 'none'} />
                  {a.followedByViewer ? 'Following' : 'Follow'} ({a.followers})
                </button>
              </div>
            </div>

            {/* Row footer: anchor (when queued) + activity toggle. */}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setOpenActivity(openActivity === a.id ? null : a.id)}
                aria-expanded={openActivity === a.id}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent"
              >
                <Activity size={13} />
                {openActivity === a.id ? 'Hide activity' : `Activity (${a.activity.length})`}
              </button>
              <Link
                to={`/app/marketplace/${a.id}`}
                className="inline-flex items-center gap-1 text-xs font-semibold text-foreground/60 hover:text-accent"
              >
                View profile <ArrowUpRight size={12} />
              </Link>
              {a.onchain !== 'registered' && (
                <>
                  <button
                    type="button"
                    onClick={() => anchorAgent(a.id)}
                    disabled={anchoringId === a.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-usdc/30 px-3 py-1.5 text-xs font-semibold text-usdc transition-colors duration-[120ms] hover:bg-usdc/5 disabled:opacity-50"
                  >
                    {anchoringId === a.id ? 'Anchoring on Arc...' : 'Anchor on Arc'}
                  </button>
                  {anchorNote[a.id] && <p className="text-[11px] text-warn">{anchorNote[a.id]}</p>}
                </>
              )}
            </div>
            <div className={`cn-collapse ${openActivity === a.id ? 'cn-open' : ''}`}>
              <ul className="mt-2 flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
                {a.activity.map((ev, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-foreground/60">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0 break-words">
                      {humanizeActivity(ev.text)}
                      <span className="ml-1.5 font-medium text-accent/80">
                        {new Date(ev.at).toLocaleString()}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          </div>
        ))}
      </div>
      )}
      </div>
    </AppPage>
  )
}

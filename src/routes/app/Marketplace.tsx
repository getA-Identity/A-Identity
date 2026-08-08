import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  BadgeCheck,
  Clock,
  Heart,
  Plus,
} from 'lucide-react'
import { authHeaders, useAuth } from '../../store/auth'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { humanizeActivity } from '../../lib/format'
import AgentAvatar from '../../components/AgentAvatar'
import BrandArt from '../../components/app/BrandArt'
import WorkerCatalog from '../../components/app/WorkerCatalog'
import AppPage from '../../components/app/AppPage'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'

type MarketAgent = {
  id: string
  name: string
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
  // The pivot hero is the trusted-worker catalog; Agent House is the second tab.
  const [tab, setTab] = useState<'hire' | 'house'>('hire')

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
      title="Marketplace"
      description="Hire a verified agent to do a job, or browse the agents already working on Arc."
    >
      {/* Segmented control with a sliding thumb: the console's one overshoot curve. */}
      <div className="relative inline-grid grid-cols-2 rounded-full border border-border bg-card p-1 text-sm font-semibold" role="tablist" aria-label="Marketplace views">
        <span
          aria-hidden="true"
          className={`cn-seg-thumb absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-full bg-accent ${
            tab === 'house' ? 'translate-x-full' : 'translate-x-0'
          }`}
        />
        {(['hire', 'house'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`relative z-10 rounded-full px-4 py-1.5 transition-colors duration-[240ms] ${
              tab === t ? 'text-white' : 'text-foreground/60 hover:text-foreground'
            }`}
          >
            {t === 'hire' ? 'Hire a worker' : 'Agent House'}
          </button>
        ))}
      </div>

      {tab === 'hire' && (
        <div className="mt-6">
          <WorkerCatalog />
        </div>
      )}

      <div className={tab === 'house' ? 'mt-6' : 'hidden'}>
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

      {/* KYA showcase vs full roster. Default shows only verified agents (matching the
          "every agent here passed KYA" promise); the toggle reveals pending ones too. */}
      {!loading && !error && (counts.totalAll > counts.total || showAll) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-foreground/15 px-3 py-1.5 font-semibold text-foreground/70 transition-colors hover:bg-foreground/5"
          >
            {showAll ? 'Show verified only' : 'Show all (including pending)'}
          </button>
          <span className="text-foreground/45">
            {showAll
              ? `Showing all ${counts.totalAll} agents`
              : `${counts.total} KYA-verified shown, ${counts.totalAll - counts.total} pending hidden`}
          </span>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-5 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {loading && !error && (
        <div className="mt-6 grid items-start gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex flex-col rounded-2xl border border-border bg-card p-6">
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

      {/* Agent listing. One row per agent, marketplace-style: identity on the left,
          what it does in the middle, its numbers on the right. A row expands its
          activity in place via an animated grid track, so the list never snaps. */}
      <div className="mt-6 flex flex-col gap-3">
        {agents.map((a) => (
          <div
            key={a.id}
            className="cn-glow-wrap"
          >
          <div className="cn-glow-card rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-start gap-4">
              <AgentAvatar
                seed={a.onchainAgentId || a.id}
                category={a.category}
                size={56}
                verdict={a.kya === 'verified' ? 'allow' : 'warn'}
              />

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-base font-bold text-foreground">{a.name}</span>
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
                <div className="mt-0.5 text-xs text-foreground/45">{a.category} · Arc testnet</div>
                <p className="mt-2 line-clamp-2 max-w-2xl text-sm leading-relaxed text-foreground/60">
                  {a.description || 'No description yet.'}
                </p>
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
                      <span className="ml-1.5 text-foreground/35">
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
      </div>
    </AppPage>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  Activity,
  ArrowLeft,
  BadgeCheck,
  Clock,
  ExternalLink,
  Heart,
  ShieldQuestion,
} from 'lucide-react'
import { authHeaders, useAuth } from '../../store/auth'
import { apiFetch } from '../../lib/api'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { humanizeActivity, short } from '../../lib/format'
import AgentAvatar from '../../components/AgentAvatar'
import AppPage from '../../components/app/AppPage'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'

type MarketAgent = {
  id: string
  name: string
  description: string
  category: string
  capabilities: string[]
  kya: string
  onchain: string
  onchainExplorer?: string
  onchainAgentId?: string
  reputation?: { score: number; breakdown: { settlement: number; validation: number; tenure: number } }
  walletAddress: string | null
  followers: number
  followedByViewer: boolean
  activity: { at: string; text: string }[]
  createdAt: string
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

  // Slice each line by how much of the budget has reached it.
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
  const viewer = user?.email || user?.name || 'guest'

  const [agent, setAgent] = useState<MarketAgent | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  return (
    <AppPage
      width="form"
      title="Agent profile"
      description="The public record of one agent: its certificate, its numbers, and everything it has done."
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
              avatar as the seal, its registry facts typed on, and a slow sheen. */}
          <div
            className="cn-cert relative mt-6 overflow-hidden rounded-3xl border border-white/10 p-7 text-white shadow-xl"
            style={{
              background:
                'linear-gradient(140deg, #131c26 0%, #192837 45%, var(--accent-deep) 130%)',
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
                />
              </div>
              <div className="min-w-0 flex-1">
                {/* Typed lines: name, id, category, registration. */}
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
              </div>
            </div>

            <div className={`relative mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4 transition-opacity duration-500 ${done ? 'opacity-100' : 'opacity-40'}`}>
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

          {/* About */}
          <section className="mt-4 rounded-2xl border border-border bg-card p-5">
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

          {/* Metrics: the same three components the score is made of. */}
          <section className="mt-4 rounded-2xl border border-border bg-card p-5">
            <h3 className="text-sm font-bold text-foreground/80">Metrics</h3>
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
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
              <Badge variant="neutral">{agent.followers} follower{agent.followers === 1 ? '' : 's'}</Badge>
              <Badge variant="neutral">{agent.activity.length} recorded event{agent.activity.length === 1 ? '' : 's'}</Badge>
              <Badge variant="info">Circle Arc</Badge>
            </div>
          </section>

          {/* Full activity trail */}
          <section className="mt-4 rounded-2xl border border-border bg-card p-5">
            <h3 className="flex items-center gap-2 text-sm font-bold text-foreground/80">
              <Activity size={14} className="text-accent" /> Activity
            </h3>
            {agent.activity.length > 0 ? (
              <ul className="mt-3 flex max-h-80 flex-col gap-2.5 overflow-y-auto pr-1">
                {[...agent.activity].reverse().map((ev, i) => (
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
        </>
      )}
    </AppPage>
  )
}

import { useCallback, useEffect, useState } from 'react'
import {
  BadgeCheck,
  CheckCircle2,
  Circle,
  ShieldQuestion,
  Star,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useAuth } from '../../store/auth'
import { useAgentReputation, useMcpHealth, useResolveAgent } from '../../hooks/useMcp'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { fetchPlatformAgents, subscribePlatformAgents } from '../../lib/platformAgents'
import { apiFetch } from '../../lib/api'
import { useSelectedAgent } from '../../store/agent'
import AgentAvatar from '../../components/AgentAvatar'
import AgentSelect from '../../components/app/AgentSelect'
import AppPage from '../../components/app/AppPage'
import BrandArt from '../../components/app/BrandArt'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'
import ReputationCard from '../../components/app/agent/ReputationCard'
import RegisterForm from '../../components/app/agent/RegisterForm'

type Stage = 'register' | 'verify' | 'live'

const STAGES: { key: Stage; label: string; desc: string }[] = [
  { key: 'register', label: 'Register', desc: 'Create your on-chain agent identity via ERC-8004.' },
  { key: 'verify', label: 'KYA Verify', desc: 'Pass Know Your Agent checks. No personal data exposed.' },
  { key: 'live', label: 'Go Live', desc: 'Agent is verified and ready to pay and receive.' },
]


/** A REAL agent registered on Arc (ERC-8004 token #849980), shown as an example only
 *  when the signed-in account has no agent of its own yet. Resolved live on-chain. */
const DEMO_AGENT_ID = 'eip155:5042002:8004/849980'

/** The subset of a real platform agent the identity card renders. */
type RealAgent = {
  id: string
  name: string
  category: string
  kya: 'unverified' | 'verified'
  onchain: 'queued' | 'registered'
  onchainAgentId?: string
  walletAddress: string | null
  createdAt: string
}

export default function AgentId() {
  const user = useAuth((s) => s.user)
  const [showReg, setShowReg] = useState(false)

  const mcpOnline = useMcpHealth() === 'online'

  // The user's first real agent (from the platform), when available. Drives the
  // identity card below; falls back to the live example agent (#849980) only when there are none.
  const [agents, setAgents] = useState<RealAgent[]>([])
  const selectedId = useSelectedAgent((s) => s.agentId)
  const setSelectedId = useSelectedAgent((s) => s.setAgentId)
  const syncRoster = useSelectedAgent((s) => s.syncRoster)
  const [realAgent, setRealAgent] = useState<RealAgent | null>(null)
  const [realChecked, setRealChecked] = useState(false)
  const [realRep, setRealRep] = useState<{
    score: number
    breakdown: { settlement: number; validation: number; tenure: number }
  } | null>(null)

  // Load the account's agents; default the selection to the primary agent. `select`
  // optionally forces the selection to a specific id (used right after a create so the
  // brand-new agent shows immediately, even though it doesn't yet outrank older ones).
  const loadAgents = useCallback(async (opts: { force?: boolean; select?: string } = {}) => {
    try {
      const list = await fetchPlatformAgents<RealAgent>({ force: opts.force })
      setAgents(list.agents)
      if (opts.select && list.agents.some((a) => a.id === opts.select)) {
        setSelectedId(opts.select)
      } else {
        syncRoster(list.agents.map((a) => a.id), pickPrimaryAgent(list.agents)?.id)
      }
    } catch {
      /* keep the fallbacks */
    } finally {
      setRealChecked(true)
    }
  }, [setSelectedId, syncRoster])

  useEffect(() => {
    loadAgents()
    // When an agent is created/anchored (here or elsewhere), re-fetch so the roster and
    // the identity card reflect it without a manual page switch.
    return subscribePlatformAgents(() => loadAgents({ force: true }))
  }, [loadAgents])

  // Show whichever agent is selected and recompute its reputation live from the backend,
  // so you can run any existing agent through reputation, not just the newest one.
  useEffect(() => {
    let cancelled = false
    const a = agents.find((x) => x.id === selectedId) ?? null
    setRealAgent(a)
    setRealRep(null)
    if (!a) return
    ;(async () => {
      try {
        const rep = await apiFetch(`/api/agents/reputation?agentId=${a.id}`).then((r) => r.json())
        if (!cancelled && rep && !('error' in rep)) setRealRep({ score: rep.score, breakdown: rep.breakdown })
      } catch {
        /* leave reputation null */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, agents])

  // Only resolve the live example agent (#849980, a real ERC-8004 token read on-chain) as a
  // fallback, and only once we've confirmed the account has no real agent. Avoids two throwaway
  // requests on every mount when a real agent already exists.
  const useExampleFallback = realChecked && !realAgent
  const { agent: liveAgent, source, loading: agentLoading } = useResolveAgent(DEMO_AGENT_ID, useExampleFallback)
  const { reputation: liveRep, loading: repLoading } = useAgentReputation(DEMO_AGENT_ID, useExampleFallback)

  // Real reputation when available; no fabricated fallback (show '-' if we have none).
  const score = realRep?.score ?? liveRep?.score ?? null
  const breakdown = realRep?.breakdown ?? liveRep?.breakdown ?? { settlement: 0, validation: 0, tenure: 0 }

  // Identity-card fields: prefer the real agent, else the live example resolve / placeholders.
  const agentName = realAgent?.name ?? `${liveAgent?.domain?.split('.')[0] ?? user?.name ?? 'My Agent'} Agent`
  const agentIdLabel = realAgent?.onchainAgentId
    ? `ERC-8004 #${realAgent.onchainAgentId}`
    : realAgent?.id ?? liveAgent?.agentId ?? '-'
  const category = realAgent?.category ?? 'Trading / Finance'
  const kyaVerified = realAgent ? realAgent.kya === 'verified' : false
  const registeredLabel = realAgent?.createdAt
    ? new Date(realAgent.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : liveAgent?.registeredAt ?? '-'
  const networkLabel = 'Arc testnet'
  // Honest progress: only a REAL agent advances the stepper. The illustrative sample
  // (shown when the account has no agent yet) sits at stage 0: the user hasn't
  // registered anything, so nothing is "done".
  const stageIndex = !realAgent
    ? 0
    : realAgent.onchain === 'registered' && realAgent.kya === 'verified'
      ? 2
      : realAgent.kya === 'verified' || realAgent.onchain === 'registered'
        ? 1
        : 0
  // The card is the user's own agent when we found one; otherwise it renders a REAL
  // example agent (resolved live from Arc's ERC-8004 registry) so the layout isn't empty.
  const isSample = realChecked && !realAgent

  return (
    <AppPage
      width="form"
      title="Agent ID"
      description="Your agent's on-chain passport. ERC-8004 gives every agent a verifiable identity, so others can trust it before transacting."
      actions={
        /* Data-source badge: quiet, semantic, one word. */
        <Badge variant={!mcpOnline ? 'neutral' : realAgent ? 'success' : 'warning'} className="mt-1.5">
          {mcpOnline ? <Wifi size={11} /> : <WifiOff size={11} />}
          {!mcpOnline ? 'Offline' : realAgent ? 'Live' : 'Sample'}
        </Badge>
      }
    >
      <AgentSelect agents={agents} />

      {/* Sample notice: no real agent yet → the card below is illustrative, not yours. */}
      {isSample && (
        <>
          {/* A ceramic passport booklet with an unstamped seal: exactly an account with
              no passport issued yet. */}
          <BrandArt src="/art/art-passport.webp" className="mx-auto mt-6 h-40 w-52 sm:h-48 sm:w-64" />
          <div className="mt-2 flex items-start gap-3 rounded-2xl border border-warn/25 bg-warn/10 p-4 text-sm text-foreground/75">
            <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-warn" />
            <p>
              <span className="font-semibold">This is a real example agent</span> (ERC-8004 #849980 on
              Arc), resolved live on-chain. You haven't created an agent yet. Register one below to get
              your own on-chain passport.
            </p>
          </div>
        </>
      )}

      {/* Identity card. A quiet bordered surface with one accent edge: the passport
          reads as a document now, not a poster. The category avatar identifies the
          agent; the reputation figure holds the right edge; the registry facts run
          along the bottom as a label/value strip. */}
      <div className="relative mt-6 overflow-hidden rounded-2xl border border-border bg-card">
        <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-accent via-accent/40 to-transparent" aria-hidden="true" />
        <div className="p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex min-w-0 items-start gap-4">
              <AgentAvatar
                seed={realAgent?.onchainAgentId || realAgent?.id || 'sample'}
                category={category}
                size={52}
                verdict={kyaVerified ? 'allow' : 'warn'}
              />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-bold tracking-tight text-foreground">{agentName}</h3>
                  <Badge variant={kyaVerified ? 'success' : 'warning'}>
                    {kyaVerified ? <BadgeCheck size={12} /> : <ShieldQuestion size={12} />}
                    {kyaVerified ? 'KYA Verified' : 'KYA Pending'}
                  </Badge>
                </div>
                {realChecked ? (
                  <div className="mt-1 break-all font-mono text-xs text-foreground/45">{agentIdLabel}</div>
                ) : (
                  <Skeleton className="mt-1.5 h-3.5 w-40" />
                )}
                <div className="mt-2 text-sm text-foreground/60">{category}</div>
              </div>
            </div>

            <div className="shrink-0 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                Reputation
              </div>
              {repLoading || !realChecked ? (
                <Skeleton className="ml-auto mt-1.5 h-9 w-20" />
              ) : (
                <div className="mt-0.5 text-3xl font-bold leading-none tabular-nums text-foreground">
                  {score ?? '-'}
                  <span className="ml-1 text-sm font-semibold text-foreground/35">/ 1000</span>
                </div>
              )}
              {score != null && (
                <div className="ml-auto mt-2 h-1 w-28 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-500"
                    style={{ width: `${Math.max(0, Math.min(100, score / 10))}%` }}
                  />
                </div>
              )}
            </div>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-4 sm:grid-cols-4">
            {(
              [
                ['Registered', realChecked ? registeredLabel : null],
                ['Network', networkLabel],
                ['Standard', 'ERC-8004'],
                ['Issuer', 'A-Identity'],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/40">{label}</dt>
                {value == null ? (
                  <Skeleton className="mt-1 h-4 w-20" />
                ) : (
                  <dd className="mt-0.5 text-sm font-semibold text-foreground">{value}</dd>
                )}
              </div>
            ))}
          </dl>
        </div>
      </div>

      {/* Stage progress */}
      <div className="mt-6 rounded-2xl border border-border bg-card p-6">
        <h3 className="mb-4 font-semibold">Registration progress</h3>
        <div className="flex items-start">
          {STAGES.map(({ key, label, desc }, i) => {
            const done = i < stageIndex
            const active = i === stageIndex
            return (
              <div key={key} className="flex flex-1 flex-col items-center">
                <div className="flex w-full items-center">
                  {i > 0 && (
                    <div className={`h-0.5 flex-1 ${done || active ? 'bg-accent' : 'bg-foreground/15'}`} />
                  )}
                  <div
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 ${
                      done
                        ? 'border-accent bg-accent text-white'
                        : active
                          ? 'border-accent bg-card text-accent'
                          : 'border-foreground/15 bg-card text-foreground/25'
                    }`}
                  >
                    {done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
                  </div>
                  {i < STAGES.length - 1 && (
                    <div className={`h-0.5 flex-1 ${done ? 'bg-accent' : 'bg-foreground/15'}`} />
                  )}
                </div>
                <div className="mt-2 text-center">
                  <div className={`text-xs font-semibold ${done || active ? 'text-accent' : 'text-foreground/35'}`}>
                    {label}
                  </div>
                  <div className="mt-0.5 hidden text-[11px] text-foreground/45 sm:block">{desc}</div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Reputation breakdown */}
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <ReputationCard
          label="Settlement score"
          value={breakdown.settlement}
          max={600}
          color="var(--accent)"
          loading={repLoading}
        />
        <ReputationCard
          label="Validation score"
          value={breakdown.validation}
          max={240}
          color="var(--usdc)"
          loading={repLoading}
        />
        <ReputationCard
          label="Tenure score"
          value={breakdown.tenure}
          max={160}
          color="var(--ok)"
          loading={repLoading}
        />
      </div>

      {/* Source detail */}
      {(agentLoading || !mcpOnline) ? null : (
        <p className="mt-2 text-xs text-foreground/40">
          {mcpOnline
            ? `Identity resolved live on-chain (source: ${source ?? 'rpc'}). Reputation: settlement + validation + tenure, max 1000.`
            : 'Start the MCP server to read live on-chain data.'}
        </p>
      )}

      {/* Human-on-the-loop */}
      <div className="mt-5 flex items-start gap-3 rounded-2xl border border-accent/20 bg-accent/[0.05] p-5">
        <ShieldQuestion size={20} className="mt-0.5 shrink-0 text-accent" />
        <div>
          <p className="text-sm font-semibold text-foreground">Human approval required for deployment</p>
          <p className="mt-1 text-sm text-foreground/65">
            Registering an ERC-8004 identity on-chain (Arc) requires your explicit approval. This
            card reads live from Arc's ERC-8004 registry. No mock data.
          </p>
        </div>
      </div>

      {/* Register new agent */}
      <div className="mt-4 rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Register a new agent</h3>
          <button
            type="button"
            onClick={() => setShowReg((v) => !v)}
            className="rounded-full border border-accent/30 px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/5"
          >
            {showReg ? 'Cancel' : 'New agent'}
          </button>
        </div>
        {showReg && (
          <RegisterForm
            onClose={() => setShowReg(false)}
            onCreated={(id) => loadAgents({ force: true, select: id })}
          />
        )}
      </div>

      {/* Reputation milestones */}
      <div className="mt-4 rounded-2xl border border-border bg-card p-6">
        <h3 className="mb-4 font-semibold">Reputation milestones</h3>
        <ul className="flex flex-col gap-3">
          {(() => {
            // `done` reflects the agent's REAL reputation score, not a hardcoded flag:
            // a milestone is achieved only once score >= its threshold (-/unknown → not done).
            const has = score != null
            const s = score ?? 0
            const base = [
              { threshold: 100, label: 'First verified agent' },
              { threshold: 300, label: 'Trusted agent (auto-approve eligible)' },
              { threshold: 500, label: 'Established agent (raised daily cap)' },
              { threshold: 900, label: 'Elite agent (full autonomy tier)' },
            ].map((m) => ({ ...m, done: has && s >= m.threshold, current: false }))
            const rows = has
              ? [...base, { threshold: s, label: 'You are here', done: true, current: true }]
              : base
            return rows.sort((a, b) => a.threshold - b.threshold)
          })().map(({ threshold, label, done, current }) => (
            <li
              key={label}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 ${
                current ? 'border border-accent/25 bg-accent/[0.05]' : 'bg-background/40'
              }`}
            >
              <div
                className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
                  done ? 'bg-accent text-white' : 'bg-foreground/10 text-foreground/40'
                }`}
              >
                {done ? <CheckCircle2 size={14} /> : <Star size={14} />}
              </div>
              <div className="flex-1">
                <span className="text-sm font-medium text-foreground">{label}</span>
              </div>
              <span className="text-xs font-semibold text-foreground/40">{threshold} pts</span>
            </li>
          ))}
        </ul>
      </div>
    </AppPage>
  )
}

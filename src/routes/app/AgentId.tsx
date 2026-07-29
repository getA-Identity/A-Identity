import { useCallback, useEffect, useState } from 'react'
import {
  BadgeCheck,
  CheckCircle2,
  Circle,
  Fingerprint,
  ShieldQuestion,
  Star,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useAuth, authHeaders } from '../../store/auth'
import { useAgentReputation, useMcpHealth, useResolveAgent } from '../../hooks/useMcp'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { fetchPlatformAgents, invalidatePlatformAgents, subscribePlatformAgents } from '../../lib/platformAgents'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { Skeleton } from '../../components/ui/skeleton'
import { OwlMascot } from '../../components/OwlMascot'

type Stage = 'register' | 'verify' | 'live'

const STAGES: { key: Stage; label: string; desc: string }[] = [
  { key: 'register', label: 'Register', desc: 'Create your on-chain agent identity via ERC-8004.' },
  { key: 'verify', label: 'KYA Verify', desc: 'Pass Know Your Agent checks. No personal data exposed.' },
  { key: 'live', label: 'Go Live', desc: 'Agent is verified and ready to pay and receive.' },
]

const CATEGORIES = [
  'Trading / Finance',
  'Research / Data',
  'Content / Writing',
  'DevOps / Code',
  'Customer Support',
  'Other',
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
  const [selectedId, setSelectedId] = useState('')
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
        const first = pickPrimaryAgent(list.agents)
        if (first) setSelectedId((cur) => cur || first.id)
      }
    } catch {
      /* keep the fallbacks */
    } finally {
      setRealChecked(true)
    }
  }, [])

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
    <div className="mx-auto max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Agent ID</h2>
          <p className="mt-1 text-sm text-foreground/55">
            Your agent's on-chain passport. ERC-8004 gives every agent a verifiable identity, so
            others can trust it before transacting.
          </p>
        </div>
        {/* MCP source badge */}
        <div
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-semibold ${
            !mcpOnline
              ? 'bg-foreground/8 text-foreground/40'
              : realAgent
                ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300'
          }`}
        >
          {mcpOnline ? <Wifi size={12} /> : <WifiOff size={12} />}
          {!mcpOnline ? 'Offline' : realAgent ? 'Live' : 'Sample'}
        </div>
      </div>

      {agents.length > 1 && (
        <div className="mt-5">
          <label className="text-xs font-semibold text-foreground/50">Agent</label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="mt-1 w-full rounded-xl border border-foreground/10 bg-card px-3 py-2.5 text-sm outline-none focus:border-accent"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Sample notice: no real agent yet → the card below is illustrative, not yours. */}
      {isSample && (
        <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/70 dark:bg-amber-500/10 p-4 text-sm text-amber-900">
          <ShieldQuestion size={18} className="mt-0.5 shrink-0" />
          <p>
            <span className="font-semibold">This is a real example agent</span> (ERC-8004 #849980 on
            Arc), resolved live on-chain. You haven't created an agent yet. Register one below to get
            your own on-chain passport.
          </p>
        </div>
      )}

      {/* Identity card */}
      <div
        className="relative mt-6 overflow-hidden rounded-2xl p-6 text-white"
        style={{ background: 'linear-gradient(135deg, #7342E2 0%, #4F2FA8 100%)' }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-10"
          style={{
            backgroundImage:
              'radial-gradient(circle at 80% 20%, white 0%, transparent 50%), radial-gradient(circle at 20% 80%, white 0%, transparent 50%)',
          }}
        />
        <div className="relative flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <Fingerprint size={18} className="opacity-75" />
              <span className="text-sm font-semibold opacity-75">A-Identity</span>
            </div>
            <div className="text-xl font-bold tracking-tight">
              {agentName}
            </div>
            {realChecked ? (
              <div className="mt-1 break-all font-mono text-sm opacity-60">
                {agentIdLabel}
              </div>
            ) : (
              <Skeleton className="mt-1 h-4 w-40" />
            )}
            <div className="mt-3 text-xs opacity-60">Category</div>
            <div className="text-sm font-semibold">{category}</div>
          </div>
          <div className="text-right">
            <div className="text-xs opacity-60">ERC-8004</div>
            <div className="mt-1 flex items-center justify-end gap-1.5">
              {repLoading || !realChecked ? (
                <Skeleton className="h-10 w-20" />
              ) : (
                <div className="text-3xl font-bold leading-none">{score ?? '-'}</div>
              )}
            </div>
            <div className="mt-0.5 text-xs opacity-60">Reputation</div>
            <div className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-semibold">
              {kyaVerified ? <BadgeCheck size={13} /> : <ShieldQuestion size={13} />}
              {kyaVerified ? 'KYA Verified' : 'KYA Pending'}
            </div>
          </div>
        </div>
        <div className="relative mt-5 flex items-center justify-between">
          <div>
            <div className="text-xs opacity-60">Registered</div>
            {realChecked ? (
              <div className="text-sm font-semibold">
                {registeredLabel}
              </div>
            ) : (
              <Skeleton className="h-4 w-24" />
            )}
          </div>
          <div>
            <div className="text-xs opacity-60">Network</div>
            <div className="text-sm font-semibold">{networkLabel}</div>
          </div>
          <div>
            <div className="text-xs opacity-60">Standard</div>
            <div className="text-sm font-semibold">ERC-8004</div>
          </div>
        </div>
      </div>

      {/* Stage progress */}
      <div className="mt-6 rounded-2xl border border-foreground/10 bg-card p-6">
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
          color="#7342E2"
          loading={repLoading}
        />
        <ReputationCard
          label="Validation score"
          value={breakdown.validation}
          max={240}
          color="#2775CA"
          loading={repLoading}
        />
        <ReputationCard
          label="Tenure score"
          value={breakdown.tenure}
          max={160}
          color="#1AAB7A"
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
      <div className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
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
      <div className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
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
    </div>
  )
}

function ReputationCard({
  label,
  value,
  max,
  color,
  loading,
}: {
  label: string
  value: number
  max: number
  color: string
  loading: boolean
}) {
  const pct = Math.round((value / max) * 100)
  return (
    <div className="rounded-2xl border border-foreground/10 bg-card p-5">
      <div className="text-xs font-semibold text-foreground/50">{label}</div>
      {loading ? (
        <Skeleton className="mt-2 h-6 w-10" />
      ) : (
        <div className="mt-2 text-2xl font-bold tracking-tight" style={{ color }}>
          {value}
        </div>
      )}
      <div className="text-xs text-foreground/35">of {max}</div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-foreground/8">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  )
}

const CAPABILITIES = ['Payments', 'Purchases', 'Rentals', 'Batch actions'] as const

/**
 * Full onboarding: identity details, capabilities, KYA permissions, a real Arc
 * testnet wallet (key shown once, never stored), then registration. The on-chain
 * anchor is queued for human approval; everything else happens for real against
 * the local platform backend.
 */
function RegisterForm({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [category, setCategory] = useState(CATEGORIES[0])
  const [caps, setCaps] = useState<string[]>(['Payments'])
  const [dailyCap, setDailyCap] = useState('50')
  const [autoApprove, setAutoApprove] = useState('1')
  const [a2a, setA2a] = useState(true)
  const [a2h, setA2h] = useState(false)

  const [wallet, setWallet] = useState<{ address: string; privateKey: string } | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [copiedKey, setCopiedKey] = useState(false)
  const [keySaved, setKeySaved] = useState(false)
  const [copiedAddr, setCopiedAddr] = useState(false)
  const [fundBusy, setFundBusy] = useState(false)
  const [fundBal, setFundBal] = useState<number | null>(null)
  const [walletBusy, setWalletBusy] = useState(false)
  const [submitBusy, setSubmitBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [anchorBusy, setAnchorBusy] = useState(false)
  const [anchored, setAnchored] = useState<{ onchainTx?: string; onchainExplorer?: string; onchainAgentId?: string } | null>(null)
  const [anchorNote, setAnchorNote] = useState<string | null>(null)
  const [kyaBusy, setKyaBusy] = useState(false)
  const [kya, setKya] = useState<{ verified: boolean; onchainTx?: string; onchainExplorer?: string } | null>(null)
  const [kyaNote, setKyaNote] = useState<string | null>(null)

  const input =
    'w-full rounded-xl border border-foreground/10 bg-background/40 px-3 py-2.5 text-sm outline-none transition-colors focus:border-accent'
  const label = 'text-xs font-semibold text-foreground/50'

  const toggleCap = (c: string) =>
    setCaps((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

  const createWallet = async () => {
    setWalletBusy(true)
    setError(null)
    try {
      // Generate the keypair IN THE BROWSER. The private key never touches the server.
      const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts')
      const privateKey = generatePrivateKey()
      const address = privateKeyToAccount(privateKey).address
      // Register only the public address with the backend.
      const res = await apiFetch('/api/wallets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ address }),
        onWaking: () => setError('Waking up the backend (free tier)…'),
      })
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        setError(explainError(res.status, j.error))
        return
      }
      setError(null)
      setWallet({ address, privateKey })
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setWalletBusy(false)
    }
  }

  const copyAddress = async () => {
    if (!wallet) return
    try {
      await navigator.clipboard.writeText(wallet.address)
      setCopiedAddr(true)
      setTimeout(() => setCopiedAddr(false), 1500)
    } catch { /* clipboard blocked; the address is visible to copy by hand */ }
  }

  // "I funded it": poll the live on-chain balance so the demo never waits on a manual
  // page refresh after using the Circle faucet.
  const checkFunded = async () => {
    if (!wallet) return
    setFundBusy(true)
    try {
      const r = await apiFetch(`/api/wallet-balance?address=${wallet.address}`)
      const d = await readJson<{ balance?: string | null }>(r)
      setFundBal(d.balance != null ? Number(d.balance) : 0)
    } catch {
      setFundBal(null)
    } finally {
      setFundBusy(false)
    }
  }

  const submit = async () => {
    if (!name.trim()) { setError('Give the agent a name.'); return }
    if (desc.trim().length < 20) { setError('Describe what this agent does (at least 20 characters), so it can appear in the Agent House showcase.'); return }
    if (wallet && !keySaved) { setError('Confirm you saved the private key before continuing.'); return }
    setSubmitBusy(true)
    setError(null)
    try {
      const res = await apiFetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          name: name.trim(),
          description: desc.trim(),
          category,
          capabilities: caps,
          permissions: {
            dailyCapUsd: Number(dailyCap) || 50,
            autoApproveUnderUsd: Number(autoApprove) || 1,
            agentToAgent: a2a,
            agentToHuman: a2h,
          },
          walletAddress: wallet?.address,
        }),
        onWaking: () => setError('Waking up the backend (free tier)…'),
      })
      const data = await readJson<{ agent?: { id: string }; error?: string }>(res)
      if (res.ok && data.agent) {
        setError(null)
        invalidatePlatformAgents() // a new agent joined the list; refresh every screen that lists agents
        onCreated?.(data.agent.id) // select it on the parent so it shows immediately
        setDone(data.agent.id)
      } else {
        setError(explainError(res.status, data.error))
      }
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setSubmitBusy(false)
    }
  }

  // Deliberate, human-triggered on-chain anchor: broadcasts a real ERC-8004
  // registration on Arc and shows the tx. Env-gated behind ARC_SIGNER_KEY server-side.
  const anchorOnchain = async () => {
    if (!done) return
    setAnchorBusy(true)
    setAnchorNote(null)
    try {
      const res = await apiFetch('/api/agents/anchor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: done }),
        timeoutMs: 90_000, // an on-chain ERC-8004 register can take a while to confirm
        onWaking: () => setAnchorNote('Waking up the backend (free tier)…'),
      })
      const data = await readJson<{
        agent?: { onchainTx?: string; onchainExplorer?: string; onchainAgentId?: string }
        result?: { executed?: boolean; reason?: string }
        error?: string
      }>(res)
      if (res.ok && data.result?.executed && data.agent) {
        invalidatePlatformAgents() // on-chain status changed, refresh every screen that lists agents
        setAnchorNote(null)
        setAnchored(data.agent)
      } else if (!res.ok) {
        setAnchorNote(explainError(res.status, data.error))
      } else {
        setAnchorNote(data.result?.reason ?? data.error ?? 'Could not broadcast. The server needs a funded ARC_SIGNER_KEY.')
      }
    } catch {
      setAnchorNote('Anchoring timed out. It runs on-chain and can be slow — give it a moment and try again.')
    } finally {
      setAnchorBusy(false)
    }
  }

  // Real KYA: prove the agent controls its wallet by signing a challenge with the
  // key generated in the browser. On success the backend also attests the result on
  // the ERC-8004 ValidationRegistry (if the agent is anchored + a signer key is set).
  const proveKya = async () => {
    if (!done || !wallet) return
    setKyaBusy(true)
    setKyaNote(null)
    try {
      const chRes = await apiFetch('/api/agents/kya/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: done }),
        onWaking: () => setKyaNote('Waking up the backend (free tier)…'),
      })
      const ch = await readJson<{ message?: string; error?: string }>(chRes)
      if (!chRes.ok || !ch.message) { setKyaNote(explainError(chRes.status, ch.error) ?? 'Could not start the KYA challenge.'); return }
      const { privateKeyToAccount } = await import('viem/accounts')
      const signature = await privateKeyToAccount(wallet.privateKey as `0x${string}`).signMessage({ message: ch.message })
      const vRes = await apiFetch('/api/agents/kya/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: done, message: ch.message, signature }),
        timeoutMs: 90_000, // verify also attests on the ERC-8004 ValidationRegistry (on-chain)
      })
      const v = await readJson<{ kya?: string; onchain?: { txHash?: string; explorerUrl?: string }; error?: string }>(vRes)
      if (vRes.ok && v.kya === 'verified') {
        setKyaNote(null)
        invalidatePlatformAgents() // KYA flipped to verified; refresh the roster/showcase
        setKya({ verified: true, onchainTx: v.onchain?.txHash, onchainExplorer: v.onchain?.explorerUrl })
      } else {
        setKyaNote(explainError(vRes.status, v.error) ?? 'KYA verification failed.')
      }
    } catch {
      setKyaNote('KYA timed out. The backend may be waking up — try again in a moment.')
    } finally {
      setKyaBusy(false)
    }
  }

  if (done) {
    return (
      <div className="relative mt-5 overflow-hidden rounded-2xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/50 p-6">
        {/* The owl marks the good outcome. Decorative, so it stays out of the a11y tree and
            never overlaps the text: it sits in the card's empty top-right corner. */}
        <OwlMascot
          variant="geometric"
          width={148}
          className="pointer-events-none absolute -right-3 -top-3 hidden w-[148px] select-none opacity-90 sm:block"
        />
        <div className="flex items-center gap-2 font-bold text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 size={18} /> {name} is registered.
        </div>
        <ul className="mt-3 flex flex-col gap-1.5 text-sm text-foreground/70">
          <li>Permissions set (daily cap, auto-approve).</li>
          {kya?.verified ? (
            <li>KYA verified: wallet control proven.</li>
          ) : (
            <li>KYA pending: prove the agent controls its wallet below.</li>
          )}
          {wallet && <li>Wallet {wallet.address.slice(0, 10)}... is assigned to it.</li>}
          {!anchored && <li>On-chain anchor is queued. Anchor it on Arc to mint a real ERC-8004 identity.</li>}
        </ul>

        {/* On-chain anchor: real ERC-8004 registration on Arc, human-triggered */}
        {anchored ? (
          <div className="mt-4 rounded-xl border border-[#2775CA]/25 bg-[#2775CA]/[0.05] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#2775CA]">
              <BadgeCheck size={16} /> Anchored on Arc: ERC-8004 id #{anchored.onchainAgentId ?? '?'}
            </div>
            {anchored.onchainExplorer && (
              <a
                href={anchored.onchainExplorer}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block break-all text-xs font-semibold text-[#2775CA] hover:underline"
              >
                View transaction on arcscan
              </a>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <button
              type="button"
              onClick={anchorOnchain}
              disabled={anchorBusy}
              className="rounded-full border border-[#2775CA]/30 px-4 py-2 text-sm font-semibold text-[#2775CA] transition-colors hover:bg-[#2775CA]/5 disabled:opacity-50"
            >
              {anchorBusy ? 'Anchoring on Arc...' : 'Anchor on Arc (register on-chain)'}
            </button>
            {anchorNote && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{anchorNote}</p>}
          </div>
        )}

        {/* KYA: prove the agent controls its wallet (real signature, not a stamp) */}
        {wallet && (
          <div className="mt-4">
            {kya?.verified ? (
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                  <BadgeCheck size={16} /> KYA verified: wallet control proven
                </div>
                {kya.onchainExplorer ? (
                  <a
                    href={kya.onchainExplorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 inline-block break-all text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
                  >
                    Attested on-chain: ERC-8004 ValidationRegistry (view tx)
                  </a>
                ) : (
                  <p className="mt-1 text-xs text-foreground/45">Anchor on Arc to also record this on the ERC-8004 ValidationRegistry.</p>
                )}
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={proveKya}
                  disabled={kyaBusy}
                  className="rounded-full border border-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                >
                  {kyaBusy ? 'Proving wallet control...' : 'Prove wallet control (KYA)'}
                </button>
                <p className="mt-2 text-xs text-foreground/45">
                  Signs a challenge with your agent's wallet key (in your browser)
                  {anchored ? ' and records it on the ERC-8004 ValidationRegistry.' : '. Anchor first for an on-chain attestation.'}
                </p>
                {kyaNote && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{kyaNote}</p>}
              </>
            )}
          </div>
        )}

        <div className="mt-4 flex gap-3">
          <Button asChild size="sm" className="text-sm">
            <a href="/app/marketplace">See it in Agent House</a>
          </Button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-foreground/15 px-4 py-2 text-sm font-semibold text-foreground/70"
          >
            Close
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-5 flex flex-col gap-5">
      {/* 1. Identity */}
      <div>
        <div className={label}>1. Identity</div>
        <div className="mt-2 flex flex-col gap-3">
          <input className={input} placeholder="Agent name (e.g. My Trading Agent)" value={name} onChange={(e) => setName(e.target.value)} required />
          <div>
            <input className={input} placeholder="What does this agent do? (shown in Agent House)" value={desc} onChange={(e) => setDesc(e.target.value)} required minLength={20} />
            <p className="mt-1 text-[11px] text-foreground/45">
              At least 20 characters. Verified agents with a description appear in the Agent House showcase.
            </p>
          </div>
          <select className={input} value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* 2. Capabilities */}
      <div>
        <div className={label}>2. What it is allowed to do</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {CAPABILITIES.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => toggleCap(c)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                caps.includes(c)
                  ? 'bg-accent text-white'
                  : 'border border-foreground/15 text-foreground/60 hover:bg-foreground/5'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* 3. KYA permissions */}
      <div>
        <div className={label}>3. Permissions (set at KYA, like card limits)</div>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-[11px] text-foreground/45">Daily cap (USD)</div>
            <input className={input} type="number" min="0" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
          </div>
          <div>
            <div className="mb-1 text-[11px] text-foreground/45">Auto-approve under (USD)</div>
            <input className={input} type="number" min="0" step="0.1" value={autoApprove} onChange={(e) => setAutoApprove(e.target.value)} />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm text-foreground/70">
            <input type="checkbox" checked={a2a} onChange={(e) => setA2a(e.target.checked)} className="accent-[#7342E2]" />
            Agent-to-agent payments
          </label>
          <label className="flex items-center gap-2 text-sm text-foreground/70">
            <input type="checkbox" checked={a2h} onChange={(e) => setA2h(e.target.checked)} className="accent-[#7342E2]" />
            Agent-to-human payments
          </label>
        </div>
      </div>

      {/* 4. Wallet */}
      <div>
        <div className={label}>4. Arc testnet wallet</div>
        {!wallet ? (
          <button
            type="button"
            onClick={createWallet}
            disabled={walletBusy}
            className="mt-2 rounded-full border border-[#2775CA]/30 px-4 py-2.5 text-sm font-semibold text-[#2775CA] transition-colors hover:bg-[#2775CA]/5 disabled:opacity-50"
          >
            {walletBusy ? 'Creating...' : 'Create wallet (generated in your browser)'}
          </button>
        ) : (
          <div className="mt-2 rounded-xl border border-[#2775CA]/25 bg-[#2775CA]/[0.04] p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-bold text-foreground/50">Address</div>
              <button type="button" onClick={copyAddress} className="text-[11px] font-semibold text-[#2775CA] hover:underline">
                {copiedAddr ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="break-all font-mono text-xs text-foreground">{wallet.address}</div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="text-[11px] font-bold text-red-600">
                Private key (generated in your browser, the server never sees it)
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowKey((s) => !s)}
                  className="text-[11px] font-semibold text-[#2775CA] hover:underline"
                >
                  {showKey ? 'Hide' : 'Reveal'}
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(wallet.privateKey)
                      setCopiedKey(true)
                      setTimeout(() => setCopiedKey(false), 1500)
                    } catch {
                      setShowKey(true) // clipboard blocked, reveal so it can be copied by hand
                    }
                  }}
                  className="text-[11px] font-semibold text-[#2775CA] hover:underline"
                >
                  {copiedKey ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div className="break-all font-mono text-xs text-foreground/70">
              {showKey ? wallet.privateKey : '•'.repeat(48)}
            </div>
            <p className="mt-1 text-[11px] text-foreground/45">
              Save it now. It is shown once and never stored. Reveal only somewhere no one can see your screen.
            </p>
            <label className="mt-2 flex items-start gap-2 text-[11px] font-medium text-foreground/70">
              <input
                type="checkbox"
                checked={keySaved}
                onChange={(e) => setKeySaved(e.target.checked)}
                className="mt-0.5 accent-[#7342E2]"
              />
              I saved this private key somewhere safe. A-Identity never stores it and cannot recover it.
            </label>
            <a
              href="https://faucet.circle.com"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-xs font-semibold text-[#2775CA] hover:underline"
            >
              Fund it with testnet USDC at faucet.circle.com
            </a>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={checkFunded}
                disabled={fundBusy}
                className="rounded-full border border-[#2775CA]/30 px-3 py-1.5 text-[11px] font-semibold text-[#2775CA] transition-colors hover:bg-[#2775CA]/5 disabled:opacity-50"
              >
                {fundBusy ? 'Checking...' : 'I funded it, check balance'}
              </button>
              {fundBal != null && (
                <span className={`text-[11px] font-semibold ${fundBal > 0 ? 'text-emerald-600' : 'text-foreground/50'}`}>
                  {fundBal > 0 ? `Funded: ${fundBal.toFixed(4)} USDC` : 'Still 0 USDC, give the faucet a moment and check again'}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Button
        type="button"
        size="lg"
        onClick={submit}
        disabled={submitBusy || (!!wallet && !keySaved)}
      >
        {submitBusy ? 'Registering...' : 'Pass KYA and register on Arc testnet'}
      </Button>
      <p className="text-xs text-foreground/45">
        Registration writes to the A-Identity registry now; the on-chain anchor is queued and
        broadcast only after a human approves it.
      </p>
    </div>
  )
}

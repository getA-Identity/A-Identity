import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, CreditCard, ExternalLink, Fingerprint, SlidersHorizontal } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { CHAINS } from '../../lib/chains'

import { apiFetch } from '../../lib/api'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { fetchPlatformAgents, subscribePlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { humanizeActivity, ago } from '../../lib/format'
import { useSelectedAgent } from '../../store/agent'
import AppPage from '../../components/app/AppPage'
import AgentStatusBar, { type AgentState } from '../../components/app/AgentStatusBar'
import ChainLogo from '../../components/app/ChainLogo'
import SetupChecklist, { type Step } from '../../components/app/SetupChecklist'
import Freshness from '../../components/app/Freshness'
import SpendSummary, { type Ix } from '../../components/app/SpendSummary'
import { Badge } from '../../components/ui/badge'
import { Skeleton } from '../../components/ui/skeleton'

const gradeOf = (s: number) =>
  s >= 800 ? 'Excellent' : s >= 650 ? 'Strong' : s >= 500 ? 'Good' : s >= 350 ? 'Fair' : s >= 200 ? 'Weak' : 'High risk'

type Perms = { dailyCapUsd: number; autoApproveUnderUsd: number; frozen: boolean }
/** GET /api/agents/policy: the same permissions plus today's usage against the cap. */
type Policy = { permissions: Perms; spentTodayUsd: number; remainingTodayUsd: number }
type Agent = {
  id: string
  name: string
  walletAddress: string | null
  kya: 'unverified' | 'verified' | 'revoked'
  onchain: 'queued' | 'registered'
  permissions: Perms
  activity: { at: string; text: string }[]
}

export default function Dashboard() {
  const user = useAuth((s) => s.user)

  const [agents, setAgents] = useState<Agent[]>([])
  const [rep, setRep] = useState<number | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [settlements, setSettlements] = useState<number | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [txTotal, setTxTotal] = useState<number | null>(null)
  const [instructions, setInstructions] = useState<Ix[] | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [agentTotal, setAgentTotal] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Wall-clock ms of the last successful read, so every figure can say how old it is. */
  const [readAt, setReadAt] = useState<number | null>(null)

  const agentId = useSelectedAgent((s) => s.agentId)
  const syncRoster = useSelectedAgent((s) => s.syncRoster)

  const loadRoster = useCallback(async () => {
    try {
      const list = await fetchPlatformAgents<Agent>()
      const roster = Array.isArray(list.agents) ? list.agents : []
      setAgents(roster)
      setAgentTotal(roster.length)
      syncRoster(roster.map((a) => a.id), pickPrimaryAgent(roster)?.id)
      setError(null)
    } catch {
      // Say the backend is unreachable instead of falling through to "no agent yet":
      // an offline console claiming the account is empty is the one wrong answer here.
      setError(BACKEND_UNREACHABLE)
    } finally {
      setLoaded(true)
    }
  }, [syncRoster])

  useEffect(() => {
    loadRoster()
    // Re-read when an agent is created or anchored elsewhere in the console, so the
    // overview is not the one screen still showing yesterday's roster.
    return subscribePlatformAgents(loadRoster)
  }, [loadRoster])

  // Follow the console-wide selection, falling back to the most demo-worthy agent.
  const agent = agents.find((a) => a.id === agentId) ?? pickPrimaryAgent(agents) ?? null

  useEffect(() => {
    if (!agent) return
    let active = true
    setRep(null)
    setBalance(null)
    setSettlements(null)
    setPending(null)
    setTxTotal(null)
    setInstructions(null)
    setPolicy(null)
    setReadAt(null)
    ;(async () => {
      const [repRes, ixRes, polRes] = await Promise.all([
        apiFetch(`/api/agents/reputation?agentId=${agent.id}`).then((r) => r.json()).catch(() => null),
        apiFetch(`/api/instructions?agentId=${agent.id}`).then((r) => r.json()).catch(() => null),
        // Today's spend against the cap. The agent object carries the cap but not the
        // usage, and a cap without usage is half a sentence.
        apiFetch(`/api/agents/policy?agentId=${agent.id}`).then((r) => r.json()).catch(() => null),
      ])
      if (!active) return
      if (repRes && !('error' in repRes) && typeof repRes.score === 'number') setRep(repRes.score)
      if (Array.isArray(ixRes?.instructions)) {
        const ix = ixRes.instructions as Ix[]
        setInstructions(ix)
        setSettlements(ix.filter((i) => i.status === 'executed_onchain').length)
        setPending(ix.filter((i) => i.status === 'pending_approval').length)
        setTxTotal(ix.length)
      }
      if (polRes && typeof polRes.spentTodayUsd === 'number') setPolicy(polRes as Policy)
      if (agent.walletAddress) {
        const bal = await apiFetch(`/api/wallet-balance?address=${agent.walletAddress}`)
          .then((r) => r.json())
          .catch(() => null)
        if (active && bal?.balance != null) setBalance(Number(bal.balance))
      }
      if (active) setReadAt(Date.now())
    })()
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, agent?.walletAddress])

  const dash = '·'
  const p = agent?.permissions
  const statusItems = [
    {
      label: 'Agent ID',
      detail: !agent
        ? 'No agent yet'
        : agent.onchain === 'registered'
          ? `ERC-8004 anchored · KYA ${agent.kya}`
          : `Registration queued · KYA ${agent.kya}`,
      ok: agent?.onchain === 'registered' && agent?.kya === 'verified',
      to: '/app/agent-id',
      icon: Fingerprint,
    },
    {
      label: 'Wallet',
      detail: !agent?.walletAddress
        ? 'No wallet yet'
        : balance != null
          ? `${balance.toFixed(4)} USDC on Arc`
          : 'Balance loading',
      ok: (balance ?? 0) > 0,
      to: '/app/wallet',
      icon: CreditCard,
    },
    {
      label: 'Permissions',
      detail: !p ? 'Not set' : p.frozen ? 'Frozen, all activity paused' : `Daily cap $${p.dailyCapUsd}`,
      ok: Boolean(p) && !p!.frozen,
      to: '/app/permissions',
      icon: SlidersHorizontal,
    },
  ]

  const activity = agent?.activity ? [...agent.activity].slice(-6).reverse() : []
  const lastActedAt = agent?.activity?.length ? agent.activity[agent.activity.length - 1].at : null

  // What the agent is doing right now, derived only from state we hold. Order matters:
  // a frozen agent is frozen even if something is queued, and an agent that cannot pay
  // yet is in setup no matter how clean its queue looks.
  const setupDone = Boolean(agent?.walletAddress) && (balance ?? 0) > 0 && Boolean(p)
  const agentState: AgentState = !setupDone
    ? 'setup'
    : p?.frozen
      ? 'frozen'
      : (pending ?? 0) > 0
        ? 'waiting'
        : 'ready'

  // Only clauses we can prove. A figure we have not read is omitted rather than shown as
  // zero: "0 settled" and "we do not know yet" are different claims.
  const clauses: string[] = []
  if ((pending ?? 0) > 0) clauses.push(`${pending} payment${pending === 1 ? '' : 's'} waiting for your approval`)
  if ((settlements ?? 0) > 0) clauses.push(`${settlements} settled on-chain`)
  if (policy) clauses.push(`$${policy.spentTodayUsd.toFixed(2)} of your $${policy.permissions.dailyCapUsd} daily cap used today`)
  if (agentState === 'ready' && clauses.length === 0) clauses.push('Nothing waiting. The agent can pay within your limits.')
  if (agentState === 'frozen') clauses.unshift('Every payment is paused until you unfreeze it.')

  const statusAction =
    agentState === 'waiting'
      ? { label: 'Review', to: '/app/settlements' }
      : agentState === 'frozen'
        ? { label: 'Unfreeze', to: '/app/permissions' }
        : undefined

  // The onboarding path, with real completion state. Stays until every step is done,
  // because the stall is usually between "registered" and "paid", not at zero.
  const steps: Step[] = [
    {
      label: 'Claim an Agent ID',
      detail: 'An ERC-8004 passport on Arc, so others can verify your agent.',
      done: Boolean(agent),
      to: '/app/agent-id',
    },
    {
      label: 'Give it a wallet',
      detail: 'The account your agent pays from.',
      done: Boolean(agent?.walletAddress),
      to: '/app/agent-id',
      blockedBy: agent ? undefined : 'after step 1',
    },
    {
      label: 'Fund it with testnet USDC',
      detail: 'Free from faucet.circle.com. Nothing can settle from an empty wallet.',
      done: (balance ?? 0) > 0,
      to: '/app/wallet',
      blockedBy: agent?.walletAddress ? undefined : 'after step 2',
    },
    {
      label: 'Set your limits',
      detail: 'A daily cap and the line below which the agent may act alone.',
      done: Boolean(p),
      to: '/app/permissions',
      blockedBy: agent ? undefined : 'after step 1',
    },
    {
      label: 'Make the first payment',
      detail: 'Watch the policy engine decide, then settle it on Arc.',
      done: (txTotal ?? 0) > 0,
      to: '/app/settlements',
      blockedBy: (balance ?? 0) > 0 ? undefined : 'after step 3',
    },
  ]
  // Hide the checklist only once it is genuinely finished, and never flash it while the
  // first read is still in flight.
  const setupSettled = loaded && !error && (!agent || readAt != null)
  const showChecklist = setupSettled && steps.some((s) => !s.done)

  return (
      <AppPage
        ambient
        title={`Welcome back, ${user?.name ?? 'there'}.`}
        description="Your agent console. Everything your agent needs to act, with you in the tower."
      >
      {error && (
        <div className="mt-6 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-4 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {/* What the agent is doing right now, before any number. */}
      {!error && (agent || !loaded) && (
        <div className="mt-6">
          <AgentStatusBar
            state={agentState}
            agentName={agent?.name ?? ''}
            clauses={clauses}
            lastActedAt={lastActedAt}
            readAt={readAt}
            action={statusAction}
            loading={!loaded || (Boolean(agent) && readAt == null)}
          />
        </div>
      )}

      {showChecklist && (
        <div className="mt-4">
          <SetupChecklist steps={steps} />
        </div>
      )}

      {/* Stat strip: hairline-divided tiles, tabular figures, credit-score spectrum on
          reputation. Hover is a solid tonal shift only: dimming neighbours here made
          the numbers unreadable over the ambient field. */}
      <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
        <StatTile to="/app/agent-id" label="Reputation" value={rep != null ? String(rep) : dash} sub={rep != null ? `${gradeOf(rep)} · / 1000` : 'from real activity'} loading={rep == null && !loaded} readAt={rep != null ? readAt : null}>
          {rep != null ? (
            <div className="mt-2 mb-0.5 h-1.5 w-full rounded-full" style={{ background: 'linear-gradient(90deg,var(--danger),var(--warn) 45%,var(--ok))' }}>
              <div className="relative h-full">
                <span className="absolute -top-0.5 h-2.5 w-[3px] -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--color-card)]" style={{ left: `${Math.max(0, Math.min(100, rep / 10))}%` }} />
              </div>
            </div>
          ) : !loaded ? (
            <Skeleton className="mt-2 mb-0.5 h-1.5 w-full" />
          ) : null}
        </StatTile>
        <StatTile to="/app/wallet" label="Wallet balance" value={balance != null ? balance.toFixed(2) : dash} sub="USDC on Arc" loading={balance == null && !loaded} readAt={balance != null ? readAt : null} />
        <StatTile to="/app/settlements" label="Settlements" value={settlements != null ? String(settlements) : dash} sub="settled on-chain" loading={settlements == null && !loaded} readAt={settlements != null ? readAt : null} />
        <StatTile
          to="/app/permissions"
          label="Daily cap"
          value={p ? `$${p.dailyCapUsd}` : dash}
          sub={policy ? `$${policy.remainingTodayUsd.toFixed(2)} left today` : p ? `auto-approve $${p.autoApproveUnderUsd}` : 'set your limits'}
          loading={!p && !loaded}
          readAt={policy ? readAt : null}
        >
          {/* How much of today's cap is gone, so the cap is a state and not a setting. */}
          {policy && policy.permissions.dailyCapUsd > 0 && (
            <div className="mt-2 mb-0.5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (policy.spentTodayUsd / policy.permissions.dailyCapUsd) * 100)}%`,
                  background: policy.spentTodayUsd >= policy.permissions.dailyCapUsd ? 'var(--danger)' : 'var(--color-accent)',
                }}
              />
            </div>
          )}
        </StatTile>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Agent status + network */}
        <div className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
          {/* While the checklist is up it already says all of this, in order and with the
              steps that unblock each other. Two copies of the same three facts on one
              screen is worse than one, so these rows stand down until setup is finished. */}
          {!showChecklist && (
            <>
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-foreground/50">Agent status</h3>
          <ul className="flex flex-col gap-2">
            {statusItems.map(({ label, detail, ok, to, icon: Icon }) => (
              <li key={label} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-4 py-3 transition-colors hover:bg-background">
                <div className="flex items-center gap-3">
                  <div className="grid h-8 w-8 place-items-center rounded-lg bg-foreground/[0.05] text-foreground/60"><Icon size={15} /></div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">{label}</div>
                    <div className="text-xs text-foreground/50">{detail}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold" style={{ color: ok ? 'var(--ok)' : 'var(--warn)', background: ok ? 'var(--ok)14' : 'var(--warn)14' }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: ok ? 'var(--ok)' : 'var(--warn)' }} />
                    {ok ? 'Ready' : 'Pending'}
                  </span>
                  <Link to={to} className="text-foreground/40 hover:text-accent"><ArrowUpRight size={15} /></Link>
                </div>
              </li>
            ))}
          </ul>
            </>
          )}

          <h3 className={`mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/50 ${showChecklist ? '' : 'mt-6'}`}>Network</h3>
          {/* One row per network: the official mark on a token disc, the name, and a
              quiet status. The live rail leads with its real agent count; planned
              rails stay visibly planned instead of wearing nine loud colours. */}
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-background/40">
            {CHAINS.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-[120ms] hover:bg-foreground/[0.02]">
                <ChainLogo id={c.id} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{c.shortName}</span>
                    {c.status === 'live' ? (
                      <Badge variant="success" className="px-2 py-0.5 text-[10px]">live</Badge>
                    ) : (
                      <Badge variant="neutral" className="px-2 py-0.5 text-[10px]">{c.status}</Badge>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-foreground/40">
                    {c.id === 'arc' ? (
                      agentTotal != null ? (
                        `${agentTotal} live agent${agentTotal === 1 ? '' : 's'}`
                      ) : !loaded ? (
                        <Skeleton className="h-3 w-20" />
                      ) : (
                        '·'
                      )
                    ) : (
                      'no live agents yet'
                    )}
                  </div>
                </div>
                {c.explorer && (
                  <a
                    href={c.explorer}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${c.shortName} explorer`}
                    className="shrink-0 rounded-lg p-1.5 text-foreground/35 transition-colors duration-[120ms] hover:bg-foreground/[0.05] hover:text-accent"
                  >
                    <ExternalLink size={13} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-4">
        {/* What the money actually did this week, before the individual events. */}
        {agent && <SpendSummary instructions={instructions} loading={readAt == null} />}

        {/* Activity feed */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-foreground/50">Recent activity</h3>
          {activity.length > 0 ? (
            <ul className="flex flex-col gap-4">
              {activity.map((a, i) => (
                <li key={i} className="flex gap-3 text-sm">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 break-words text-foreground/70">
                    {humanizeActivity(a.text)}
                    <span className="mt-0.5 block text-[11px] text-foreground/35">{ago(a.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : !loaded ? (
            <ul className="flex flex-col gap-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <li key={i} className="flex gap-3">
                  <Skeleton className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-full" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-foreground/45">No activity yet. Register an agent and make a payment.</p>
          )}
          <Link to="/app/settlements" className="mt-5 inline-flex items-center gap-1 text-sm font-semibold text-accent hover:underline">
            View all <ArrowUpRight size={14} />
          </Link>
        </div>
        </div>
      </div>
      </AppPage>
  )
}

function StatTile({ to, label, value, sub, loading, readAt, children }: { to: string; label: string; value: string; sub: string; loading?: boolean; readAt?: number | null; children?: ReactNode }) {
  // Hover stays a SOLID surface (mixed from the card colour): a translucent hover
  // colour replaced the card background and let the dot field bleed through the
  // figures, which made the tile unreadable mid-hover.
  return (
    <Link
      to={to}
      className="group flex flex-col bg-card p-5 transition-colors duration-[120ms] hover:bg-[color-mix(in_srgb,var(--card)_94%,var(--foreground))]"
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">{label}</div>
      {loading ? (
        <Skeleton className="mt-1.5 h-8 w-16" />
      ) : (
        <div className="mt-1.5 text-3xl font-bold tabular-nums tracking-tight text-foreground">{value}</div>
      )}
      {children}
      {loading ? (
        <Skeleton className="mt-1 h-3 w-24" />
      ) : (
        <div className="mt-1 text-[11px] text-foreground/40">{sub}</div>
      )}
      {/* When the figure was read. Only rendered for figures we actually hold. */}
      <Freshness at={readAt ?? null} className="mt-0.5 text-[10px] text-foreground/30" />
    </Link>
  )
}

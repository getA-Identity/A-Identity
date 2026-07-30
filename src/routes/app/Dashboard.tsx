import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, CreditCard, ExternalLink, Fingerprint, SlidersHorizontal } from 'lucide-react'
import { useAuth } from '../../store/auth'
import { useMcpHealth } from '../../hooks/useMcp'
import { CHAINS } from '../../lib/chains'

import { apiFetch } from '../../lib/api'
import { fetchPlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { Skeleton } from '../../components/ui/skeleton'

/** Shorten any full 40-hex address inside activity text so it never overflows the card. */
const humanizeActivity = (text: string) =>
  text.replace(/0x[0-9a-fA-F]{40}/g, (a) => `${a.slice(0, 6)}...${a.slice(-4)}`)

const gradeOf = (s: number) =>
  s >= 800 ? 'Excellent' : s >= 650 ? 'Strong' : s >= 500 ? 'Good' : s >= 350 ? 'Fair' : s >= 200 ? 'Weak' : 'High risk'

type Perms = { dailyCapUsd: number; autoApproveUnderUsd: number; frozen: boolean }
type Agent = {
  id: string
  name: string
  walletAddress: string | null
  kya: 'unverified' | 'verified' | 'revoked'
  onchain: 'queued' | 'registered'
  permissions: Perms
  activity: { at: string; text: string }[]
}

/** Compact "5h ago" style relative time. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function Dashboard() {
  const user = useAuth((s) => s.user)
  const mcp = useMcpHealth() // 'checking' | 'waking' | 'online' | 'offline'

  const mcpColor = mcp === 'online' ? '#059669' : mcp === 'offline' ? '#dc2626' : '#d97706'
  const mcpLabel =
    mcp === 'online' ? 'MCP live' : mcp === 'waking' ? 'Backend waking up' : mcp === 'checking' ? 'Connecting' : 'MCP offline'

  const [agent, setAgent] = useState<Agent | null>(null)
  const [rep, setRep] = useState<number | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [settlements, setSettlements] = useState<number | null>(null)
  const [agentTotal, setAgentTotal] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await fetchPlatformAgents<Agent>()
        if (cancelled) return
        setAgentTotal(Array.isArray(list.agents) ? list.agents.length : 0)
        const first: Agent | undefined = pickPrimaryAgent(list.agents)
        if (!first) return
        setAgent(first)
        const [repRes, ixRes] = await Promise.all([
          apiFetch(`/api/agents/reputation?agentId=${first.id}`).then((r) => r.json()).catch(() => null),
          apiFetch(`/api/instructions?agentId=${first.id}`).then((r) => r.json()).catch(() => null),
        ])
        if (cancelled) return
        if (repRes && !('error' in repRes) && typeof repRes.score === 'number') setRep(repRes.score)
        if (Array.isArray(ixRes?.instructions))
          setSettlements(ixRes.instructions.filter((i: { status: string }) => i.status === 'executed_onchain').length)
        if (first.walletAddress) {
          const bal = await apiFetch(`/api/wallet-balance?address=${first.walletAddress}`)
            .then((r) => r.json())
            .catch(() => null)
          if (!cancelled && bal?.balance != null) setBalance(Number(bal.balance))
        }
      } catch {
        /* backend unreachable, leave everything empty (no fake numbers) */
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: 'easeOut' }} className="mx-auto max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Welcome back, {user?.name ?? 'there'}.</h2>
          <p className="mt-1 text-sm text-foreground/55">Your agent console. Everything your agent needs to act, with you in the tower.</p>
        </div>
        <div className="mt-1 inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground/70">
          <span className={`h-1.5 w-1.5 rounded-full ${mcp === 'waking' || mcp === 'checking' ? 'animate-pulse' : ''}`} style={{ background: mcpColor }} />
          {mcpLabel}
        </div>
      </div>

      {loaded && !agent && (
        <div className="mt-6 rounded-xl border border-dashed border-border bg-card p-6 text-sm text-foreground/60">
          No agent registered yet.{' '}
          <Link to="/app/agent-id" className="font-semibold text-accent hover:underline">Claim an Agent ID</Link>{' '}
          to give it a wallet, limits, and an on-chain passport.
        </div>
      )}

      {/* Stat strip: hairline-divided tiles, mono figures, credit-score spectrum on reputation */}
      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
        <StatTile to="/app/agent-id" label="Reputation" value={rep != null ? String(rep) : dash} sub={rep != null ? `${gradeOf(rep)} · / 1000` : 'from real activity'} loading={rep == null && !loaded}>
          {rep != null ? (
            <div className="mt-2 mb-0.5 h-1.5 w-full rounded-full" style={{ background: 'linear-gradient(90deg,#dc2626,#d97706 45%,#059669)' }}>
              <div className="relative h-full">
                <span className="absolute -top-0.5 h-2.5 w-[3px] -translate-x-1/2 rounded-full bg-foreground shadow-[0_0_0_2px_var(--color-card)]" style={{ left: `${Math.max(0, Math.min(100, rep / 10))}%` }} />
              </div>
            </div>
          ) : !loaded ? (
            <Skeleton className="mt-2 mb-0.5 h-1.5 w-full" />
          ) : null}
        </StatTile>
        <StatTile to="/app/wallet" label="Wallet balance" value={balance != null ? balance.toFixed(2) : dash} sub="USDC on Arc · live" loading={balance == null && !loaded} />
        <StatTile to="/app/settlements" label="Settlements" value={settlements != null ? String(settlements) : dash} sub="settled on-chain" loading={settlements == null && !loaded} />
        <StatTile to="/app/permissions" label="Daily cap" value={p ? `$${p.dailyCapUsd}` : dash} sub={p ? `auto-approve $${p.autoApproveUnderUsd}` : 'set your limits'} loading={!p && !loaded} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Agent status + network */}
        <div className="rounded-xl border border-border bg-card p-6 lg:col-span-2">
          <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-foreground/50">Agent status</h3>
          <ul className="flex flex-col gap-2">
            {statusItems.map(({ label, detail, ok, to, icon: Icon }) => (
              <li key={label} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/40 px-4 py-3 transition-colors hover:bg-background">
                <div className="flex items-center gap-3">
                  <div className="grid h-8 w-8 place-items-center rounded-lg bg-foreground/[0.05] text-foreground/60"><Icon size={15} /></div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">{label}</div>
                    <div className="font-mono text-xs text-foreground/50">{detail}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold" style={{ color: ok ? '#059669' : '#d97706', background: ok ? '#05966914' : '#d9770614' }}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: ok ? '#059669' : '#d97706' }} />
                    {ok ? 'Ready' : 'Pending'}
                  </span>
                  <Link to={to} className="text-foreground/40 hover:text-accent"><ArrowUpRight size={15} /></Link>
                </div>
              </li>
            ))}
          </ul>

          <h3 className="mb-3 mt-6 text-xs font-semibold uppercase tracking-wide text-foreground/50">Network</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            {CHAINS.map((c) => (
              <div key={c.id} className="rounded-lg border border-border bg-background/40 p-3">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                  <span className="text-xs font-semibold text-foreground">{c.shortName}</span>
                  <span className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: c.color + '18', color: c.color }}>{c.status}</span>
                </div>
                <div className="mt-2 font-mono text-[11px] leading-relaxed text-foreground/45">
                  {c.id === 'arc'
                    ? agentTotal != null
                      ? `${agentTotal} live agent${agentTotal === 1 ? '' : 's'}`
                      : !loaded
                        ? <Skeleton className="h-3 w-20" />
                        : '·'
                    : 'no live agents yet'}
                </div>
                {c.explorer && (
                  <a href={c.explorer} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-0.5 text-[11px] font-semibold text-accent hover:underline">
                    Explorer <ExternalLink size={10} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>

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
                    <span className="mt-0.5 block font-mono text-xs text-foreground/40">{ago(a.at)}</span>
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
    </motion.div>
  )
}

function StatTile({ to, label, value, sub, loading, children }: { to: string; label: string; value: string; sub: string; loading?: boolean; children?: ReactNode }) {
  return (
    <Link to={to} className="group flex flex-col bg-card p-5 transition-colors hover:bg-foreground/[0.02]">
      <div className="text-[11px] font-medium uppercase tracking-wide text-foreground/45">{label}</div>
      {loading ? (
        <Skeleton className="mt-1.5 h-8 w-16" />
      ) : (
        <div className="mt-1.5 font-mono text-3xl font-bold tabular-nums tracking-tight text-foreground">{value}</div>
      )}
      {children}
      {loading ? (
        <Skeleton className="mt-1 h-3 w-24" />
      ) : (
        <div className="mt-1 text-[11px] text-foreground/40">{sub}</div>
      )}
    </Link>
  )
}

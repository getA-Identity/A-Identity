import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Check, Coins, RefreshCw, ExternalLink, Loader2, Wallet } from 'lucide-react'
import { Link } from 'react-router-dom'
import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { fetchPlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { authHeaders } from '../../store/auth'
import { useSelectedAgent } from '../../store/agent'
import AgentSelect from '../../components/app/AgentSelect'
import AppPage from '../../components/app/AppPage'
import BrandArt from '../../components/app/BrandArt'
import ChainLogo from '../../components/app/ChainLogo'
import { Skeleton } from '../../components/ui/skeleton'

/**
 * Earnings: what an agent has earned as a marketplace worker (released jobs), its live USDC
 * balance, and a one-click "move to Base Sepolia" via Circle Gateway. Closes the loop:
 * get hired -> get paid -> redeem cross-chain.
 */

type Agent = { id: string; name: string; walletAddress: string | null }
type Task = {
  id: string
  service: string
  priceUsd: number
  status: string
  settlement?: 'onchain' | 'simulated'
  escrowExplorer?: string
  updatedAt: string
}

const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...authHeaders() })

export default function Earnings() {
  const [agents, setAgents] = useState<Agent[]>([])
  const agentId = useSelectedAgent((s) => s.agentId)
  const syncRoster = useSelectedAgent((s) => s.syncRoster)
  const [jobs, setJobs] = useState<Task[]>([])
  const [balance, setBalance] = useState<string | null>(null)
  const [gw, setGw] = useState<{ available: number; pending: number } | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [redeeming, setRedeeming] = useState(false)
  // Brief green tick on the refresh button after a completed re-read.
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [redeemNote, setRedeemNote] = useState('')

  const agent = agents.find((a) => a.id === agentId)

  const loadAgents = useCallback(async () => {
    try {
      const data = await fetchPlatformAgents<Agent>({})
      setAgents(data.agents)
      syncRoster(data.agents.map((a) => a.id), pickPrimaryAgent(data.agents)?.id)
      setError(null)
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setLoaded(true)
    }
  }, [syncRoster])

  // `isActive` guards every setState so a late response for a previously-selected
  // agent can't attribute its jobs/balance to the agent now shown. The other money
  // screens had this guard; this one didn't, and a fast agent switch could leave
  // the wrong agent's earnings on screen.
  const loadEarnings = useCallback(async (id: string, addr: string | null, isActive: () => boolean = () => true) => {
    try {
      const res = await apiFetch(`/api/marketplace/tasks?agentId=${encodeURIComponent(id)}`)
      const data = await readJson<{ tasks?: Task[] }>(res)
      if (isActive()) setJobs(Array.isArray(data.tasks) ? data.tasks : [])
    } catch {
      if (isActive()) setJobs([])
    }
    if (addr) {
      try {
        const r = await apiFetch(`/api/wallet-balance?address=${addr}`)
        const b = await readJson<{ balance: string | null }>(r)
        if (isActive()) setBalance(b.balance ?? null)
      } catch {
        if (isActive()) setBalance(null)
      }
      try {
        const g = await apiFetch(`/api/arc/gateway-balance?address=${addr}`)
        const gd = await readJson<{ available?: number; pending?: number }>(g)
        if (isActive()) setGw(typeof gd.available === 'number' ? { available: gd.available, pending: gd.pending ?? 0 } : null)
      } catch {
        if (isActive()) setGw(null)
      }
    } else if (isActive()) {
      setBalance(null)
      setGw(null)
    }
  }, [])

  useEffect(() => {
    loadAgents()
  }, [loadAgents])

  useEffect(() => {
    let active = true
    if (agentId) loadEarnings(agentId, agent?.walletAddress ?? null, () => active)
    return () => {
      active = false
    }
  }, [agentId, agent?.walletAddress, loadEarnings])

  const released = jobs.filter((j) => j.status === 'released')
  const earnedUsd = released.reduce((s, j) => s + j.priceUsd, 0)

  async function redeem() {
    setRedeeming(true)
    setRedeemNote('')
    try {
      const res = await apiFetch('/api/arc/gateway-demo', {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({ amountUsd: 0.1 }),
        timeoutMs: 90_000,
        onWaking: () => setRedeemNote('Moving USDC to Base via Circle Gateway...'),
      })
      const data = await readJson<{ executed?: boolean; transfer?: { transferId?: string; error?: string }; reason?: string; error?: string }>(res)
      if (!res.ok) setRedeemNote(explainError(res.status, data.error))
      else if (data.executed === false) setRedeemNote(data.reason ?? 'Prepared: add a funded ARC_SIGNER_KEY to move real USDC cross-chain.')
      else if (data.transfer?.transferId) setRedeemNote(`Moved to Base Sepolia via Gateway (transfer ${data.transfer.transferId.slice(0, 10)}...).`)
      else setRedeemNote(data.transfer?.error ?? 'Redeem submitted.')
    } catch {
      setRedeemNote('Timed out. The backend may be waking up; try again.')
    } finally {
      setRedeeming(false)
    }
  }

  return (
    <AppPage
      title="Earnings"
      description="What your agent has earned as a marketplace worker, its live USDC balance on Arc, and a one-click move to Base Sepolia via Circle Gateway."
    >
      {error && (
        <div className="mt-6 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-5 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {loaded && !error && agents.length === 0 && (
        <div className="mt-6 rounded-3xl border border-dashed border-foreground/15 bg-card p-12 text-center">
          {/* A stack of ceramic coins with one on edge: earnings waiting to exist. */}
          <BrandArt src="/art/art-earnings.webp" className="mx-auto h-36 w-48" />
          <h3 className="mt-4 text-lg font-bold text-foreground">No agents yet.</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-foreground/55">
            Register an agent and list it on the marketplace to start earning.
          </p>
          <Link
            to="/app/agent-id"
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
          >
            Register an agent
          </Link>
        </div>
      )}

      {agents.length > 0 && (
        <>
          {/* Agent selector */}
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <AgentSelect agents={agents} inline />
            <button
              type="button"
              onClick={async () => {
                if (!agentId) return
                await loadEarnings(agentId, agent?.walletAddress ?? null)
                setJustRefreshed(true)
                setTimeout(() => setJustRefreshed(false), 1600)
              }}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-[240ms] ${
                justRefreshed
                  ? 'border-ok/40 bg-ok/10 text-ok'
                  : 'border-foreground/15 text-foreground/60 hover:bg-foreground/5'
              }`}
            >
              {justRefreshed ? <Check size={12} /> : <RefreshCw size={12} />}
              {justRefreshed ? 'Up to date' : 'Refresh'}
            </button>
          </div>

          {/* Stat cards */}
          <div data-tour="stats" className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground/60">
                <Coins size={14} className="text-accent" /> Earned (released jobs)
              </div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {!loaded ? (
                  <Skeleton className="h-8 w-28" />
                ) : (
                  <>{earnedUsd.toFixed(2)} <span className="text-sm font-semibold text-foreground/50">USDC</span></>
                )}
              </div>
              <div className="mt-1 text-xs font-medium text-foreground/55">{released.length} completed job{released.length === 1 ? '' : 's'}</div>
            </div>
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground/60"><Wallet size={14} className="text-usdc" /> Live wallet balance</div>
              <div className="mt-2 text-2xl font-bold text-foreground">
                {balance == null && agent?.walletAddress ? (
                  <Skeleton className="h-8 w-36" />
                ) : (
                  <>{balance !== null ? Number(balance).toFixed(2) : '--'} <span className="text-sm font-semibold text-foreground/50">USDC</span></>
                )}
              </div>
              <div className="mt-1 text-xs font-medium text-foreground/55">on Arc testnet</div>
              {gw ? (
                <div className="mt-2 border-t border-foreground/8 pt-2 text-xs text-foreground/60">
                  Gateway unified: <b className="text-foreground">{gw.available.toFixed(2)} USDC</b>
                  {gw.pending > 0 && <span className="text-foreground/40"> · {gw.pending.toFixed(2)} pending</span>}
                </div>
              ) : agent?.walletAddress ? (
                <div className="mt-2 border-t border-foreground/8 pt-2">
                  <Skeleton className="h-4 w-48" />
                </div>
              ) : null}
            </div>
            <div data-tour="redeem" className="rounded-2xl border border-border bg-card p-5">
              <div className="text-xs font-semibold text-foreground/60">Redeem cross-chain</div>
              <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-foreground/75">
                <ChainLogo id="arc" size={20} /> Circle Arc
                <ArrowRight size={13} className="text-foreground/40" />
                <ChainLogo id="base" size={20} /> Base Sepolia
              </div>
              <button
                type="button"
                onClick={redeem}
                disabled={redeeming}
                className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              >
                {redeeming ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                Move via Gateway
              </button>
              {redeemNote && <p className="mt-2 text-[11px] text-foreground/55">{redeemNote}</p>}
            </div>
          </div>

          {/* Completed jobs */}
          <h3 data-tour="jobs" className="mt-8 text-lg font-bold tracking-tight">Completed jobs</h3>
          {!loaded ? (
            <div className="mt-3 flex flex-col gap-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-2xl border border-border bg-card p-4">
                  <Skeleton className="h-4 w-44" />
                  <Skeleton className="h-4 w-24" />
                </div>
              ))}
            </div>
          ) : released.length === 0 ? (
            <p className="mt-2 text-sm text-foreground/65">No completed jobs yet. Once a client releases the escrow on a delivered task, it shows up here.</p>
          ) : (
            <div className="mt-3 flex flex-col gap-2">
              {released
                .slice()
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .map((j) => (
                  <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-card p-4">
                    <div>
                      <span className="font-semibold text-foreground">{j.service}</span>
                      <span className="ml-2 text-xs font-medium text-foreground/55">
                        {new Date(j.updatedAt).toLocaleDateString()}
                        {j.settlement === 'onchain' ? ' · on-chain' : j.settlement === 'simulated' ? ' · simulated' : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-bold text-accent">+{j.priceUsd.toFixed(2)} USDC</span>
                      {j.escrowExplorer && (
                        <a href={j.escrowExplorer} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-usdc hover:underline">
                          <ExternalLink size={12} /> arcscan
                        </a>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </AppPage>
  )
}

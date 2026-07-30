import { useCallback, useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Copy,
  ExternalLink,
  RefreshCw,
  ShieldQuestion,
  Wallet as WalletIcon,
} from 'lucide-react'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson } from '../../lib/api'
import { fetchPlatformAgents, subscribePlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { CircleWalletPanel, TreasuryPanel } from '../../components/app/WalletPanels'
import { Skeleton } from '../../components/ui/skeleton'
const FAUCET = 'https://faucet.circle.com'

type Agent = { id: string; name: string; walletAddress: string | null }
type Balance = { address: string; balance: string | null; symbol: string; source: string }
type AssetBalances = { usdcUsd: number; eurcUsd: number; usycUsd: number; idleUsd: number; totalUsd: number }
type Instruction = {
  id: string
  amountUsd: number
  count: number
  payee: string
  status: string
  policyNote: string
  txHash?: string
  explorerUrl?: string
  createdAt: string
}

const short = (a: string) => (a && a.length > 16 ? `${a.slice(0, 10)}...${a.slice(-6)}` : a)

export default function Wallet() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
  const [balance, setBalance] = useState<Balance | null>(null)
  const [assets, setAssets] = useState<AssetBalances | null>(null)
  const [txs, setTxs] = useState<Instruction[]>([])
  const [txsLoaded, setTxsLoaded] = useState(false)
  const [loadingBal, setLoadingBal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [copied, setCopied] = useState(false)

  const loadAgents = useCallback(async (force = false) => {
    try {
      const data = await fetchPlatformAgents<Agent>({ force })
      setAgents(data.agents)
      if (data.agents.length) setAgentId((cur) => cur || pickPrimaryAgent(data.agents)?.id || data.agents[0].id)
      setError(null)
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    loadAgents()
    // Refresh the roster when an agent is created/anchored elsewhere in the app.
    return subscribePlatformAgents(() => loadAgents(true))
  }, [loadAgents])

  const agent = agents.find((a) => a.id === agentId)

  // `isActive` guards every setState so a late response for a previously-selected agent
  // can't clobber the state of the one now shown (a fast agent switch would otherwise
  // attribute the wrong balance/txs to the wrong agent).
  const refresh = useCallback(async (a: Agent | undefined, isActive: () => boolean = () => true) => {
    if (!a) return
    // Real recent payments for this agent.
    apiFetch(`/api/instructions?agentId=${a.id}`)
      .then((r) => r.json())
      .then((d: { instructions: Instruction[] }) => { if (isActive()) setTxs([...d.instructions].reverse().slice(0, 8)) })
      .catch(() => { if (isActive()) setTxs([]) })
      .finally(() => { if (isActive()) setTxsLoaded(true) })
    // Live multi-asset balances (USDC / EURC / USYC) read from Arc, via the treasury
    // read (which returns all three), so the wallet shows every token it holds, not
    // only the native USDC gas balance. Best-effort: the hero USDC below is separate.
    apiFetch(`/api/agents/treasury?agentId=${a.id}`)
      .then((r) => readJson<{ balances?: AssetBalances; error?: string }>(r))
      .then((d) => { if (isActive()) setAssets(d.balances ?? null) })
      .catch(() => { if (isActive()) setAssets(null) })
    // Live on-chain USDC balance, if the agent has a wallet.
    if (a.walletAddress) {
      if (isActive()) setLoadingBal(true)
      try {
        const r = await apiFetch(`/api/wallet-balance?address=${a.walletAddress}`)
        const b = await readJson<Balance>(r)
        if (isActive()) setBalance(b)
      } catch {
        if (isActive()) setBalance(null)
      } finally {
        if (isActive()) setLoadingBal(false)
      }
    } else if (isActive()) {
      setBalance(null)
    }
  }, [])

  useEffect(() => {
    let active = true
    if (agent) refresh(agent, () => active)
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, agent?.walletAddress])

  const copy = () => {
    if (!agent?.walletAddress) return
    navigator.clipboard?.writeText(agent.walletAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const bal = balance?.balance != null ? Number(balance.balance) : null

  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="text-2xl font-bold tracking-tight">Wallet</h2>
      <p className="mt-1 text-sm text-foreground/55">
        Your agent's Arc wallet. Balance is read live from the Arc testnet; payments settle in
        real USDC. You set the limits in Permissions.
      </p>

      {error && (
        <div className="mt-5 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-4 text-sm text-foreground/70">{error}</div>
      )}

      {loaded && agents.length === 0 && !error && (
        <div className="mt-5 rounded-2xl border border-dashed border-foreground/15 bg-card p-8 text-center text-sm text-foreground/55">
          No agents yet. Register one in Agent ID to get a wallet.
        </div>
      )}

      {agent && (
        <>
          {agents.length > 1 && (
            <div className="mt-5">
              <label className="text-xs font-semibold text-foreground/50">Agent</label>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
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

          {/* Live balance hero */}
          <div
            className="relative mt-5 overflow-hidden rounded-2xl p-6 text-white"
            style={{ background: 'linear-gradient(135deg, #2775CA 0%, #1A4F8C 100%)' }}
          >
            <div
              className="pointer-events-none absolute inset-0 opacity-10"
              style={{ backgroundImage: 'radial-gradient(circle at 80% 20%, white 0%, transparent 50%)' }}
            />
            <div className="relative">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold opacity-75">
                  <WalletIcon size={16} />
                  Live balance on Arc testnet
                </div>
                <button
                  type="button"
                  onClick={() => refresh(agent)}
                  className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-semibold backdrop-blur-sm transition-colors hover:bg-white/25"
                >
                  <RefreshCw size={11} className={loadingBal ? 'animate-spin' : ''} /> Refresh
                </button>
              </div>

              {agent.walletAddress ? (
                <>
                  <div className="mt-2 text-4xl font-bold tracking-tight">
                    {loadingBal || bal == null ? (
                      <Skeleton className="h-9 w-40" />
                    ) : (
                      <>
                        {bal.toFixed(4)}{' '}
                        <span className="text-lg font-semibold opacity-70">USDC</span>
                      </>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="font-mono text-xs opacity-70">{short(agent.walletAddress)}</span>
                    <button type="button" onClick={copy} className="opacity-70 hover:opacity-100" title="Copy address" aria-label="Copy wallet address">
                      <Copy size={12} />
                    </button>
                    {copied && <span className="text-[10px] opacity-70">copied</span>}
                    <a
                      href={`https://testnet.arcscan.app/address/${agent.walletAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-[11px] font-semibold opacity-80 hover:opacity-100"
                    >
                      explorer <ExternalLink size={10} />
                    </a>
                  </div>
                  {bal === 0 && (
                    <a
                      href={FAUCET}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 inline-block rounded-full bg-white/20 px-3 py-1.5 text-xs font-semibold backdrop-blur-sm transition-colors hover:bg-white/30"
                    >
                      Fund it with testnet USDC at faucet.circle.com
                    </a>
                  )}
                </>
              ) : (
                <div className="mt-3 text-sm opacity-85">
                  This agent has no wallet yet.
                  <a href="/app/agent-id" className="ml-1 underline">
                    Create one in Agent ID
                  </a>
                  .
                </div>
              )}
            </div>
          </div>

          {/* Token balances: every asset the wallet holds on Arc, not just native USDC.
              (Useful when the faucet funds EURC, or idle USDC is parked in USYC.) */}
          {agent.walletAddress && assets && (
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold text-foreground/50">Token balances on Arc</div>
              <div className="grid grid-cols-3 gap-2.5">
                {([
                  { t: 'USDC', v: assets.usdcUsd },
                  { t: 'EURC', v: assets.eurcUsd },
                  { t: 'USYC', v: assets.usycUsd },
                ] as const).map(({ t, v }) => (
                  <div key={t} className="rounded-2xl border border-foreground/[0.06] bg-card px-4 py-3">
                    <div className="text-xs font-semibold text-foreground/55">{t}</div>
                    <div className="mt-1 text-lg font-semibold tracking-tight text-foreground tabular-nums">
                      ${v.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[11px] text-foreground/40">
                Read live from Arc. USYC is yield-bearing, manage it in Treasury below.
              </p>
            </div>
          )}

          {/* Token balances still loading from Arc: mirror the real 3-tile layout. */}
          {agent.walletAddress && !assets && (
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold text-foreground/50">Token balances on Arc</div>
              <div className="grid grid-cols-3 gap-2.5">
                {(['USDC', 'EURC', 'USYC'] as const).map((t) => (
                  <div key={t} className="rounded-2xl border border-foreground/[0.06] bg-card px-4 py-3">
                    <div className="text-xs font-semibold text-foreground/55">{t}</div>
                    <Skeleton className="mt-1 h-6 w-16" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Human-on-the-loop */}
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-accent/20 bg-accent/[0.05] p-4">
            <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-accent" />
            <p className="text-sm text-foreground/70">
              Payments run through the policy engine first. Above your limits, they pause for
              approval; nothing moves real USDC without it.
            </p>
          </div>

          {/* Recent payments (real instructions) */}
          <h3 className="mt-8 font-semibold">Recent payments</h3>
          {!txsLoaded && txs.length === 0 ? (
            <ul className="mt-3 flex flex-col gap-2.5">
              {Array.from({ length: 3 }).map((_, i) => (
                <li key={i} className="flex items-center gap-4 rounded-2xl border border-foreground/10 bg-card p-4">
                  <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
          <ul className="mt-3 flex flex-col gap-2.5">
            {txs.map((tx) => {
              const total = tx.amountUsd * tx.count
              const settled = tx.status === 'executed_onchain'
              return (
                <li key={tx.id} className="flex items-center gap-4 rounded-2xl border border-foreground/10 bg-card p-4">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#7342E2] text-white">
                    <ArrowUpRight size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs font-semibold text-foreground">{short(tx.payee)}</div>
                    <div className="truncate text-xs text-foreground/45">{tx.policyNote}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-foreground">
                      -{total < 0.01 ? total.toFixed(4) : total.toFixed(2)}{' '}
                      <span className="text-xs font-semibold text-[#2775CA]">USDC</span>
                    </div>
                    {settled && tx.explorerUrl ? (
                      <a
                        href={tx.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-600 hover:underline"
                      >
                        settled <ExternalLink size={9} />
                      </a>
                    ) : (
                      <span className="text-[11px] font-semibold text-foreground/40">{tx.status.replace(/_/g, ' ')}</span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          )}
          {txsLoaded && txs.length === 0 && (
            <div className="mt-3 rounded-2xl border border-dashed border-foreground/15 bg-white/50 p-8 text-center text-sm text-foreground/50">
              No payments yet. Make one in Settlements.
            </div>
          )}

          {/* Circle Agent Wallet: hosted wallet-layer screening */}
          <CircleWalletPanel agentId={agentId} />

          {/* Treasury: idle-balance auto-yield into USYC */}
          <TreasuryPanel agentId={agentId} />
        </>
      )}
    </div>
  )
}

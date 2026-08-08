import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowUpRight,
  Check,
  Coins,
  Copy,
  Droplets,
  ExternalLink,
  Globe,
  Hash,
  Layers,
  RefreshCw,
  ShieldQuestion,
} from 'lucide-react'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson } from '../../lib/api'
import { fetchPlatformAgents, subscribePlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { short } from '../../lib/format'
import { CircleWalletPanel, TreasuryPanel } from '../../components/app/WalletPanels'
import AgentSelect from '../../components/app/AgentSelect'
import AppPage from '../../components/app/AppPage'
import BrandArt from '../../components/app/BrandArt'
import ChainLogo from '../../components/app/ChainLogo'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip'
import { useSelectedAgent } from '../../store/agent'
import { Skeleton } from '../../components/ui/skeleton'
const FAUCET = 'https://faucet.circle.com'

type Agent = { id: string; name: string; walletAddress: string | null }
type Balance = { address: string; balance: string | null; symbol: string; source: string }
type AssetBalances = { usdcUsd: number; eurcUsd: number; usycUsd: number; idleUsd: number; totalUsd: number }
type Gateway = { available: number; pending: number }
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

/**
 * Where the money is read from. 'all' is the chain-abstracted view: the Arc
 * wallet plus the Circle Gateway unified balance (which itself spans chains).
 * Every figure is a real read; a scope with nothing readable says so.
 */
type Scope = 'all' | 'arc' | 'gateway'

const TOKEN_ICON: Record<string, string> = {
  USDC: '/tokens/usdc.svg',
  EURC: '/tokens/eurc.svg',
}

function TokenIcon({ symbol, size = 18 }: { symbol: string; size?: number }) {
  const src = TOKEN_ICON[symbol]
  if (src) {
    return <img src={src} alt="" aria-hidden="true" style={{ width: size, height: size }} className="shrink-0 rounded-full" />
  }
  // USYC has no public mark in the set: a minimal yield badge in the same shape.
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      className="grid shrink-0 place-items-center rounded-full bg-ok font-bold text-white"
    >
      Y
    </span>
  )
}

export default function Wallet() {
  const [agents, setAgents] = useState<Agent[]>([])
  const agentId = useSelectedAgent((s) => s.agentId)
  const syncRoster = useSelectedAgent((s) => s.syncRoster)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [assets, setAssets] = useState<AssetBalances | null>(null)
  const [gw, setGw] = useState<Gateway | null>(null)
  const [txs, setTxs] = useState<Instruction[]>([])
  const [txsLoaded, setTxsLoaded] = useState(false)
  const [loadingBal, setLoadingBal] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [scope, setScope] = useState<Scope>('all')

  const loadAgents = useCallback(async (force = false) => {
    try {
      const data = await fetchPlatformAgents<Agent>({ force })
      setAgents(data.agents)
      syncRoster(data.agents.map((a) => a.id), pickPrimaryAgent(data.agents)?.id)
      setError(null)
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setLoaded(true)
    }
  }, [syncRoster])

  useEffect(() => {
    loadAgents()
    // Refresh the roster when an agent is created/anchored elsewhere in the app.
    return subscribePlatformAgents(() => loadAgents(true))
  }, [loadAgents])

  const agent = agents.find((a) => a.id === agentId)

  // `isActive` guards every setState so a late response for a previously-selected agent
  // can't clobber the state of the one now shown.
  const refresh = useCallback(async (a: Agent | undefined, isActive: () => boolean = () => true) => {
    if (!a) return
    // Real recent payments for this agent.
    apiFetch(`/api/instructions?agentId=${a.id}`)
      .then((r) => r.json())
      .then((d: { instructions: Instruction[] }) => { if (isActive()) setTxs([...d.instructions].reverse().slice(0, 8)) })
      .catch(() => { if (isActive()) setTxs([]) })
      .finally(() => { if (isActive()) setTxsLoaded(true) })
    // Live multi-asset balances (USDC / EURC / USYC) read from Arc via the treasury read.
    apiFetch(`/api/agents/treasury?agentId=${a.id}`)
      .then((r) => readJson<{ balances?: AssetBalances; error?: string }>(r))
      .then((d) => { if (isActive()) setAssets(d.balances ?? null) })
      .catch(() => { if (isActive()) setAssets(null) })
    if (a.walletAddress) {
      // Circle Gateway unified balance: the chain-abstracted USDC this wallet can
      // mint on any supported chain. Read live; absent when Gateway has nothing.
      apiFetch(`/api/arc/gateway-balance?address=${a.walletAddress}`)
        .then((r) => readJson<{ available?: number; pending?: number }>(r))
        .then((d) => {
          if (isActive()) setGw(typeof d.available === 'number' ? { available: d.available, pending: d.pending ?? 0 } : null)
        })
        .catch(() => { if (isActive()) setGw(null) })
      // Live on-chain USDC balance on Arc.
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
      setGw(null)
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

  // The three real figures behind the scope chips. 'all' only sums what was
  // actually read; while Arc is still loading it stays a skeleton, never a guess.
  const gwAvailable = gw?.available ?? 0
  const scopeValue: number | null =
    scope === 'arc' ? bal : scope === 'gateway' ? (gw ? gwAvailable : null) : bal == null ? null : bal + gwAvailable

  const SCOPES: { id: Scope; label: string; icon: React.ReactNode; sub: string }[] = [
    { id: 'all', label: 'All chains', icon: <Layers size={13} />, sub: 'Arc + Gateway unified' },
    { id: 'arc', label: 'Circle Arc', icon: <ChainLogo id="arc" size={16} />, sub: 'on-chain balance' },
    { id: 'gateway', label: 'Gateway', icon: <Globe size={13} />, sub: 'chain-abstracted USDC' },
  ]
  const activeScope = SCOPES.find((s) => s.id === scope)!

  return (
    <AppPage
      title="Wallet"
      description="Your agent's Arc wallet. Balance is read live from the Arc testnet; payments settle in real USDC. You set the limits in Permissions."
    >
      {error && (
        <div className="mt-5 rounded-2xl border border-warn/25 bg-warn/10 p-4 text-sm text-foreground/70">{error}</div>
      )}

      {loaded && agents.length === 0 && !error && (
        <div className="mt-5 rounded-2xl border border-dashed border-foreground/15 bg-card p-8 text-center text-sm text-foreground/55">
          No agents yet. Register one in Agent ID to get a wallet.
        </div>
      )}

      {agent && (
        <>
          <AgentSelect agents={agents} inline className="mt-0" />

          <div className="mt-5 grid items-start gap-4 lg:grid-cols-3">
            {/* Left: the money itself. */}
            <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
              {/* Live balance hero: one figure, scoped by chain. */}
              <div
                data-tour="balance"
                className="relative overflow-hidden rounded-2xl p-6 text-white"
                style={{ background: 'linear-gradient(135deg, var(--usdc) 0%, var(--usdc-deep) 100%)' }}
              >
                <div
                  className="pointer-events-none absolute inset-0 opacity-10"
                  style={{ backgroundImage: 'radial-gradient(circle at 80% 20%, white 0%, transparent 50%)' }}
                />
                {/* The vault sits low in the corner as texture, never under the controls. */}
                {agent.walletAddress && (
                  <BrandArt
                    src="/art/art-vault.webp"
                    variant="band"
                    className="pointer-events-none absolute -bottom-10 -right-8 hidden h-40 w-40 opacity-20 lg:block"
                  />
                )}
                <div className="relative">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      {activeScope.icon}
                      Live balance · {activeScope.label}
                      <span className="hidden text-xs font-medium text-white/60 sm:inline">{activeScope.sub}</span>
                    </div>
                    {agent.walletAddress && (
                      <button
                        type="button"
                        onClick={() => refresh(agent)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-semibold backdrop-blur-sm transition-colors duration-[120ms] hover:bg-white/20"
                      >
                        <RefreshCw size={12} className={loadingBal ? 'animate-spin' : ''} /> Refresh
                      </button>
                    )}
                  </div>

                  {agent.walletAddress ? (
                    <>
                      <div className="mt-3 flex items-center gap-3">
                        <TokenIcon symbol="USDC" size={34} />
                        {loadingBal || scopeValue == null ? (
                          <Skeleton className="h-10 w-40" />
                        ) : (
                          <div className="text-4xl font-bold tracking-tight">
                            {scopeValue.toFixed(2)} <span className="text-lg font-semibold text-white/70">USDC</span>
                          </div>
                        )}
                      </div>

                      {/* Chain abstraction: the same wallet, three real reads. */}
                      <div className="mt-4 flex flex-wrap gap-1.5" role="tablist" aria-label="Balance scope">
                        {SCOPES.map((s) => (
                          <button
                            key={s.id}
                            type="button"
                            role="tab"
                            aria-selected={scope === s.id}
                            onClick={() => setScope(s.id)}
                            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors duration-[120ms] ${
                              scope === s.id
                                ? 'bg-white text-[var(--usdc-deep)]'
                                : 'border border-white/25 bg-white/5 text-white/85 hover:bg-white/15'
                            }`}
                          >
                            {s.icon}
                            {s.label}
                          </button>
                        ))}
                      </div>

                      {/* Every stablecoin the wallet holds, right where the balance is. */}
                      {assets && (
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          {(
                            [
                              ['USDC', assets.usdcUsd],
                              ['EURC', assets.eurcUsd],
                              ['USYC', assets.usycUsd],
                            ] as const
                          ).map(([sym, v]) => (
                            <span
                              key={sym}
                              className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-white/90"
                            >
                              <TokenIcon symbol={sym} size={15} />
                              {sym} ${v.toFixed(2)}
                            </span>
                          ))}
                          {gw && gw.pending > 0 && (
                            <span className="text-xs font-medium text-white/60">+{gw.pending.toFixed(2)} pending in Gateway</span>
                          )}
                        </div>
                      )}

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
                    <div className="mt-3 text-sm text-white/90">
                      This agent has no wallet yet.
                      <Link to="/app/agent-id" className="ml-1 font-semibold underline underline-offset-2">
                        Create one in Agent ID
                      </Link>
                      .
                    </div>
                  )}
                </div>
              </div>

              {/* Recent payments (real instructions) */}
              <section data-tour="payments" className="rounded-2xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-foreground">Recent Payments</h3>
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" aria-label="How payments are protected" className="text-foreground/40 hover:text-foreground/70">
                            <ShieldQuestion size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          Payments run through the policy engine first. Above your limits, they pause for
                          approval; nothing moves real USDC without it.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <Link to="/app/settlements" className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
                    Settlements <ArrowUpRight size={12} />
                  </Link>
                </div>
                {!txsLoaded && txs.length === 0 ? (
                  <ul className="divide-y divide-border">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <li key={i} className="flex items-center gap-4 px-5 py-3.5">
                        <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Skeleton className="h-3 w-32" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                        <Skeleton className="h-4 w-20" />
                      </li>
                    ))}
                  </ul>
                ) : txs.length > 0 ? (
                  <ul className="divide-y divide-border">
                    {txs.map((tx) => {
                      const total = tx.amountUsd * tx.count
                      const settled = tx.status === 'executed_onchain'
                      return (
                        <li key={tx.id} className="flex items-center gap-4 px-5 py-3.5">
                          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                            <ArrowUpRight size={15} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-xs font-semibold text-foreground">{short(tx.payee)}</div>
                            <div className="truncate text-xs text-foreground/50">{tx.policyNote}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-bold tabular-nums text-foreground">
                              -{total < 0.01 ? total.toFixed(4) : total.toFixed(2)}{' '}
                              <span className="text-xs font-semibold text-usdc">USDC</span>
                            </div>
                            {settled && tx.explorerUrl ? (
                              <a
                                href={tx.explorerUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-ok hover:underline"
                              >
                                settled <ExternalLink size={9} />
                              </a>
                            ) : (
                              <span className="text-[11px] font-medium text-foreground/50">{tx.status.replace(/_/g, ' ')}</span>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <div className="px-5 py-10 text-center text-sm text-foreground/60">
                    No payments yet. Make one in Settlements.
                  </div>
                )}
              </section>
            </div>

            {/* Right rail: what the money is made of, and the utilities. */}
            <div className="flex min-w-0 flex-col gap-4">
              {/* Token balances */}
              <section data-tour="tokens" className="rounded-2xl border border-border bg-card p-5">
                <h3 className="flex items-center gap-2 text-sm font-bold text-foreground/80">
                  <Coins size={15} className="text-accent" /> Token Balances
                </h3>
                <dl className="mt-3 flex flex-col divide-y divide-border">
                  {(['USDC', 'EURC', 'USYC'] as const).map((t) => {
                    const v = assets ? { USDC: assets.usdcUsd, EURC: assets.eurcUsd, USYC: assets.usycUsd }[t] : null
                    return (
                      <div key={t} className="flex items-center justify-between py-2.5 first:pt-0 last:pb-0">
                        <dt className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
                          <TokenIcon symbol={t} size={18} /> {t}
                        </dt>
                        {agent.walletAddress && v == null ? (
                          <Skeleton className="h-5 w-16" />
                        ) : (
                          <dd className="text-sm font-bold tabular-nums text-foreground">${(v ?? 0).toFixed(2)}</dd>
                        )}
                      </div>
                    )
                  })}
                </dl>
                <p className="mt-3 text-xs leading-relaxed text-foreground/60">
                  Read live from Arc. USYC is yield-bearing, manage it in Treasury below.
                </p>
              </section>

              {/* Address utilities */}
              {agent.walletAddress && (
                <section data-tour="address" className="rounded-2xl border border-border bg-card p-5">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-foreground/80">
                    <Hash size={15} className="text-accent" /> Address
                  </h3>
                  <div className="mt-2.5 font-mono text-xs text-foreground/70">{short(agent.walletAddress)}</div>
                  <div className="mt-3 flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={copy}
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground/70 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
                    >
                      {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
                      {copied ? 'Copied' : 'Copy address'}
                    </button>
                    <a
                      href={`https://testnet.arcscan.app/address/${agent.walletAddress}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground/70 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
                    >
                      <ExternalLink size={13} /> View on arcscan
                    </a>
                    <a
                      href={FAUCET}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground/70 transition-colors duration-[120ms] hover:bg-foreground/[0.04] hover:text-foreground"
                    >
                      <Droplets size={13} /> Fund with testnet USDC
                    </a>
                  </div>
                </section>
              )}
            </div>
          </div>

          {/* Wallet-layer panels, paired. */}
          <div data-tour="panels" className="mt-4 grid items-start gap-4 xl:grid-cols-2">
            {/* Circle Agent Wallet: hosted wallet-layer screening */}
            <CircleWalletPanel agentId={agentId} />

            {/* Treasury: idle-balance auto-yield into USYC */}
            <TreasuryPanel agentId={agentId} />
          </div>
        </>
      )}
    </AppPage>
  )
}

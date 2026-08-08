import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, TrendingUp, Wallet, Info } from 'lucide-react'
import { authHeaders } from '../../store/auth'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { Skeleton } from '../ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { Stat, StatBadge } from '../ui/stat'

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-4)}` : a)

// Re-exported so the panels that already imported Stat from here keep working.
export { Stat }

type CircleWalletState = {
  circleWalletId: string | null
  circleWalletAddress?: string | null
  configured?: boolean
  walletAddress?: string | null
  blockchain?: string | null
  state?: string | null
  balances?: { amount: string; symbol?: string; tokenAddress?: string }[]
  explorer?: string | null
  reason?: string
  error?: string
}

/**
 * Provision a Circle Agent Wallet for the agent: the hosted wallet layer enforcement
 * layer that complements the on-chain vault. The agent's USDC lives in a Circle-managed
 * wallet on Arc whose hosted policy engine SCREENS every transfer (sanctions, address
 * allow/block, freeze). Precise by design: Circle screens at the wallet layer; the spend
 * cap stays on our server + the on-chain vault. Credential-gated behind Circle keys.
 */
export function CircleWalletPanel({ agentId }: { agentId: string }) {
  // Full explanation folds away; the panel leads with one sentence.
  const [cwHow, setCwHow] = useState(false)
  const [wallet, setWallet] = useState<CircleWalletState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/agents/circle-wallet?agentId=${agentId}`)
      setWallet(await readJson<CircleWalletState>(res))
      setErr(null)
    } catch {
      setErr('Could not load Circle wallet status.')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    if (agentId) load()
  }, [agentId, load])

  const provision = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await apiFetch('/api/agents/circle-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, fund: true }),
        timeoutMs: 90_000, // Circle provisions + funds the wallet on-chain; can be slow
        onWaking: () => setErr('Waking up the backend (free tier)…'),
      })
      const j = await readJson<{ error?: string }>(res)
      if (!res.ok) {
        setErr(explainError(res.status, j.error))
        return
      }
      if (j.error) setErr(j.error)
      else setErr(null)
      await load()
    } catch {
      setErr('Provisioning timed out. It runs on Circle + on-chain and can be slow, give it a moment and try again.')
    } finally {
      setBusy(false)
    }
  }

  const has = !!wallet?.circleWalletId
  const addr = wallet?.circleWalletAddress ?? wallet?.walletAddress ?? null
  const usdc = wallet?.balances?.find((b) => (b.symbol ?? '').toUpperCase().includes('USDC'))

  return (
    <section className="overflow-hidden rounded-2xl border border-usdc/25 bg-gradient-to-b from-usdc/[0.06] to-card p-6 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-7">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-usdc text-white">
          <Wallet size={16} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-foreground">Circle Agent Wallet</h3>
            {has && (
              <span className="rounded-full bg-usdc/10 px-2 py-0.5 text-[10px] font-semibold text-usdc">
                Live on Arc
              </span>
            )}
          </div>
          <p className="text-xs font-medium text-foreground/60">A Circle-managed wallet, screened at the wallet layer</p>
        </div>
      </div>
      <div className="mb-4 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground/65">
        <span>Circle screens every transfer (sanctions, allow/block, freeze) and settles real USDC.</span>
        <button
          type="button"
          onClick={() => setCwHow((v) => !v)}
          aria-expanded={cwHow}
          className="font-semibold text-usdc hover:underline"
        >
          {cwHow ? 'Hide details' : 'How it works'}
        </button>
      </div>
      <div className={`cn-collapse ${cwHow ? 'cn-open' : ''}`}>
        <p className="pb-4 text-xs leading-relaxed text-foreground/65">
          Give the agent a <b>Circle-managed wallet</b> on Arc. Circle's hosted policy engine screens
          every transfer at the <b>wallet layer</b> (sanctions, address allow and block, and freeze) and
          settles real USDC. It complements the onchain vault: the server sets the spend cap, Circle
          screens at the wallet layer, and the vault enforces it trustlessly onchain.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-foreground/[0.06] bg-card px-4 py-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-1.5 h-4 w-20" />
              </div>
            ))}
          </div>
        </div>
      ) : has ? (
        <div className="space-y-3">
          {addr && (
            <a
              href={wallet?.explorer ?? `https://testnet.arcscan.app/address/${addr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-usdc hover:underline"
            >
              {short(addr)} <ExternalLink size={11} />
            </a>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Wallet State" value={wallet?.state ?? (wallet?.configured === false ? 'Keys off' : 'Not set')} />
            <Stat label="USDC Balance" value={usdc ? `$${Number(usdc.amount).toFixed(2)}` : 'Not set'} />
            <Stat label="Network" value={wallet?.blockchain ?? 'ARC-TESTNET'} />
          </div>
          {wallet?.configured === false && wallet?.reason && (
            <p className="text-[11px] text-foreground/45">
              Wallet stored; live balance needs Circle keys on the backend. {wallet.reason}
            </p>
          )}
          <p className="text-[11px] text-foreground/45">
            Address payments now settle through Circle, screened by its hosted policy at the wallet layer.
          </p>
        </div>
      ) : (
        <button
          type="button"
          onClick={provision}
          disabled={busy}
          className="rounded-full bg-usdc px-4 py-2 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
        >
          {busy ? 'Provisioning on Circle...' : 'Provision Circle Agent Wallet'}
        </button>
      )}
      {err && <div className="mt-3 text-xs text-red-600">{err}</div>}
    </section>
  )
}

type TreasuryState = {
  address?: string
  balances?: { usdcUsd: number; eurcUsd: number; usycUsd: number; idleUsd: number; totalUsd: number }
  capUsd?: number
  deployableUsd?: number
  projection?: { apyPct: number; weeklyUsd: number; monthlyUsd: number; yearlyUsd: number }
  usyc?: { token: string; teller: string; explorer: string; apyEstimatePct: number }
  note?: string
  autoYieldEnabled?: boolean
  authorizedAt?: string
  error?: string
}

const CAP_PRESETS = [0, 5, 25, 100]



/**
 * Treasury: put the agent's idle stablecoin to work in USYC, Circle's yield-bearing token.
 * Idle USDC/EURC above a working-capital cap earns yield and redeems back to USDC on demand.
 * The owner reviews projected earnings and authorizes; balances and the review are live, the
 * on-chain USDC to USYC mint goes live once the wallet is USYC-allowlisted (enterprise-gated).
 */
export function TreasuryPanel({ agentId }: { agentId: string }) {
  const [t, setT] = useState<TreasuryState | null>(null)
  const [cap, setCap] = useState('25')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // The full explanation, the three steps and the read-from address all fold away
  // behind How it works: a first visit reads one subtitle and the controls.
  const [how, setHow] = useState(false)

  const load = useCallback(
    async (capUsd?: string, opts?: { syncCap?: boolean; quiet?: boolean }) => {
      if (!opts?.quiet) setLoading(true)
      try {
        const q = capUsd !== undefined && capUsd !== '' ? `&cap=${Number(capUsd)}` : ''
        const res = await apiFetch(`/api/agents/treasury?agentId=${agentId}${q}`)
        const j = await readJson<TreasuryState>(res)
        setT(j)
        // Only sync the input to the saved cap on the first load; never overwrite what
        // the owner is actively typing.
        if (opts?.syncCap && typeof j.capUsd === 'number') setCap(String(j.capUsd))
        setErr(j.error ?? null)
      } catch {
        setErr('Could not load treasury status. The backend may be waking up, try again in a moment.')
      } finally {
        if (!opts?.quiet) setLoading(false)
      }
    },
    [agentId],
  )

  // Initial load: fetch balances and sync the cap to the saved config.
  useEffect(() => {
    if (agentId) load(undefined, { syncCap: true })
  }, [agentId, load])

  // Live preview: a moment after the cap stops changing (chip click or typing), recalculate
  // quietly. The projection is server math, so the fetch is debounced; `previewing` drives a
  // small "updating" hint on the hero number instead of a separate Preview button.
  useEffect(() => {
    if (!agentId) return
    const timer = setTimeout(async () => {
      setPreviewing(true)
      await load(cap, { quiet: true })
      setPreviewing(false)
    }, 400)
    return () => clearTimeout(timer)
  }, [cap, agentId, load])

  const act = async (enable: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      const res = await apiFetch('/api/agents/treasury', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(enable ? { agentId, capUsd: Number(cap) || 0 } : { agentId, enabled: false }),
        onWaking: () => setErr('Waking up the backend (free tier)…'),
      })
      const j = await readJson<{ error?: string }>(res)
      if (!res.ok) {
        setErr(explainError(res.status, j.error))
        return
      }
      if (j.error) {
        setErr(j.error)
      } else {
        setErr(null)
        setSavedTick(true)
        setTimeout(() => setSavedTick(false), 1600)
      }
      await load(cap)
    } catch {
      setErr('Action failed. The backend may be waking up, give it a few seconds and try again.')
    } finally {
      setBusy(false)
    }
  }

  // Presets go through the same debounced live preview as typing, one fetch per change.
  const setCapPreset = (v: number) => setCap(String(v))

  const b = t?.balances
  const proj = t?.projection
  const on = !!t?.autoYieldEnabled
  const deployable = t?.deployableUsd ?? 0
  const apy = t?.usyc?.apyEstimatePct ?? proj?.apyPct ?? 4.2
  const money = (n?: number) => `$${(n ?? 0).toFixed(2)}`

  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-200/70 dark:border-emerald-500/25 bg-gradient-to-b from-emerald-50/50 dark:from-emerald-500/[0.06] to-card p-6 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-7">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-600 text-white">
            <TrendingUp size={16} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-foreground">Treasury</h3>
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label="About USYC treasury" className="text-foreground/40 hover:text-foreground/70">
                      <Info size={13} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    USYC is an enterprise-gated Circle product. Balances, the cap and the earnings
                    review are live now; the on-chain USDC to USYC mint activates once this wallet is
                    USYC-allowlisted (Circle Support, about 24 to 48 hours). APY is an estimate and
                    floats with short Treasury rates.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              {!loading && t && !t.error && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    on
                      ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                      : 'border border-border bg-card text-foreground/45'
                  }`}
                >
                  {on ? 'Auto Yield On' : 'Auto Yield Off'}
                </span>
              )}
            </div>
            <p className="text-xs font-medium text-foreground/60">Idle balance earns yield in USYC</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setHow((v) => !v)}
          aria-expanded={how}
          className="shrink-0 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
        >
          {how ? 'Hide details' : 'How it works'}
        </button>
      </div>

      <div className={`cn-collapse ${how ? 'cn-open' : ''}`}>
        <div className="pt-3">
          <p className="text-xs leading-relaxed text-foreground/55">
            Anything above your working capital cap earns yield in <b>USYC</b>, Circle's tokenized money
            market fund on Arc, and redeems back to USDC when the agent needs to spend. Nothing moves
            without your approval.
          </p>
          <ol className="mt-2 grid gap-2 rounded-2xl border border-emerald-200/60 dark:border-emerald-500/25 bg-card/60 p-3 text-[11px] leading-relaxed text-foreground/60 sm:grid-cols-3">
            <li><span className="font-semibold text-foreground/75">1. Set a cap.</span> Idle balance below it stays liquid for spending.</li>
            <li><span className="font-semibold text-foreground/75">2. Review.</span> The surplus and its projected yield update live.</li>
            <li><span className="font-semibold text-foreground/75">3. Authorize.</span> You approve; the surplus earmarks into USYC.</li>
          </ol>
          {t?.address && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px] text-foreground/45">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
              Reading balances from <span className="font-mono" title={t.address}>{short(t.address)}</span>
            </p>
          )}
        </div>
      </div>

      {loading ? (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-24 rounded-full" />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-14 rounded-full" />
            ))}
          </div>
          <div className="rounded-2xl border border-foreground/[0.06] bg-card px-5 py-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-2 h-7 w-24" />
          </div>
        </div>
      ) : t?.error ? (
        <div className="mt-5 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-foreground/70">
          <div className="font-semibold text-amber-800 dark:text-amber-300">Nothing to show yet</div>
          <p className="mt-1">{t.error}</p>
          <p className="mt-1 text-foreground/50">
            This agent needs a funded Arc wallet before there's idle balance to put to work. Create a wallet in
            Agent ID, fund it at faucet.circle.com, then come back here.
          </p>
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {/* Balances: one compact chip row instead of three tiles. */}
          <div className="flex flex-wrap items-center gap-2">
            {[
              { label: 'USDC', value: b?.usdcUsd, yielding: false },
              { label: 'EURC', value: b?.eurcUsd, yielding: false },
              { label: 'USYC', value: b?.usycUsd, yielding: true },
            ].map((c) => (
              <span
                key={c.label}
                className="inline-flex items-center gap-1.5 rounded-full border border-foreground/[0.07] bg-card px-2.5 py-1 text-[11px] font-medium text-foreground/55 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
              >
                {c.label}
                <span className="font-semibold text-foreground tabular-nums">{money(c.value)}</span>
                {c.yielding && <StatBadge>Yielding</StatBadge>}
              </span>
            ))}
          </div>

          {/* Cap picker: presets + custom input; the projection previews live, no button. */}
          <div>
            <div className="mb-2 text-[11px] font-medium text-foreground/45">
              Working capital cap <span className="text-foreground/35">· stays liquid</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {CAP_PRESETS.map((v) => {
                const active = Number(cap) === v
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setCapPreset(v)}
                    aria-pressed={active}
                    className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                      active ? 'bg-foreground text-background' : 'border border-border bg-card text-foreground/60 hover:border-foreground/25'
                    }`}
                  >
                    ${v}
                  </button>
                )
              })}
              <div className="inline-flex items-center rounded-full border border-border bg-card pl-3">
                <span className="text-[11px] text-foreground/40">$</span>
                <input
                  type="number"
                  min="0"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  aria-label="Custom working capital cap in dollars"
                  className="w-16 bg-transparent px-1.5 py-1.5 text-xs font-semibold text-foreground outline-none"
                />
              </div>
            </div>
          </div>

          {/* One hero: the deployable amount plus the APY estimate. */}
          <div className="overflow-hidden rounded-2xl border border-emerald-300/60 bg-gradient-to-r from-emerald-400/[0.16] via-emerald-300/[0.08] to-transparent px-5 py-4">
            <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
              <div>
                <div className="text-[11px] font-medium text-foreground/50" aria-live="polite">
                  Ready to earn in USYC{previewing ? ' · updating…' : ''}
                </div>
                <div className="mt-0.5 text-[26px] font-bold leading-none tracking-tight text-emerald-700 dark:text-emerald-300 tabular-nums">
                  {money(deployable)}
                </div>
              </div>
              <span className="rounded-full bg-emerald-100 dark:bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                About {apy}% APY est.
              </span>
            </div>
          </div>

          {/* Everything secondary in one compact line. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-foreground/50 tabular-nums">
            <span>Idle now {money(b?.idleUsd)}</span>
            <span aria-hidden="true">·</span>
            <span>Est. {money(proj?.monthlyUsd)}/mo</span>
            <span aria-hidden="true">·</span>
            <span>{money(proj?.weeklyUsd)}/wk</span>
            <span aria-hidden="true">·</span>
            <span>{money(proj?.yearlyUsd)}/yr</span>
          </p>

          {deployable <= 0 && (
            <p className="text-[11px] text-foreground/45">
              Idle balance is under the ${Number(cap) || 0} cap. Lower it to earn.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {on ? (
              <>
                <button
                  type="button"
                  onClick={() => act(true)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  {busy ? 'Updating…' : savedTick ? <><Check size={15} /> Saved</> : 'Update Cap'}
                </button>
                <button
                  type="button"
                  onClick={() => act(false)}
                  disabled={busy}
                  className="rounded-full px-4 py-2.5 text-sm font-semibold text-foreground/55 transition hover:text-red-600 disabled:opacity-50"
                >
                  Turn Off
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => act(true)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? 'Authorizing…' : savedTick ? <><Check size={15} /> Authorized</> : 'Authorize Auto Yield'}
              </button>
            )}
          </div>

          {/* One small meta line: authorization state plus the contract link. */}
          {(on || t?.usyc?.explorer) && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-foreground/45">
              {on && (
                <span className="font-medium text-emerald-700 dark:text-emerald-300">
                  Authorized{typeof t?.capUsd === 'number' ? ` · cap $${t.capUsd}` : ''}
                </span>
              )}
              {on && t?.usyc?.explorer && <span aria-hidden="true">·</span>}
              {t?.usyc?.explorer && (
                <a
                  href={t.usyc.explorer}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
                >
                  USYC Contract <ExternalLink size={11} />
                </a>
              )}
            </p>
          )}
        </div>
      )}
      {/* Mutation errors only; the load-side reason already renders in the card body. */}
      {err && err !== t?.error && <div className="mt-3 text-xs text-red-600">{err}</div>}
    </section>
  )
}

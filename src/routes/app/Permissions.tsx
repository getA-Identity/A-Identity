import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  CreditCard,
  Loader2,
  Save,
  Shield,
  Snowflake,
} from 'lucide-react'
import { authHeaders } from '../../store/auth'
import TradingPermissions from '../../components/app/permissions/TradingPermissions'
import AuditTrail from '../../components/app/permissions/AuditTrail'
import SpendPermissions from '../../components/app/permissions/SpendPermissions'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { fetchPlatformAgents } from '../../lib/platformAgents'
import { pickPrimaryAgent } from '../../lib/pickAgent'
import { short } from '../../lib/format'
import { useSelectedAgent } from '../../store/agent'
import { useTabCarousel } from '../../hooks/useTabCarousel'
import AgentSelect from '../../components/app/AgentSelect'
import AppPage from '../../components/app/AppPage'
import { Skeleton } from '../../components/ui/skeleton'
import { NumberField } from '../../components/ui/number-field'
import PayeeAdder from '../../components/app/permissions/PayeeAdder'
import { Row } from '../../components/app/permissions/ToggleRow'
import PolicyTester from '../../components/app/permissions/PolicyTester'
import VaultPanel from '../../components/app/permissions/VaultPanel'
import VenuePanel from '../../components/app/permissions/VenuePanel'
import CirclePolicyPanel from '../../components/app/permissions/CirclePolicyPanel'

/**
 * One action surface as the backend registry describes it.
 *
 * The tab row used to be a literal list, which meant a `planned` surface was simply
 * invisible: `bet` shipped as a reviewed schema and nobody using the console could tell it
 * existed, let alone that it is deliberately not live. A surface the product has decided
 * NOT to run is information, and hiding it reads as a gap rather than as a decision.
 */
type Surface = { id: string; name: string; status: 'live' | 'planned'; note: string }

/** Payments is not a policy-engine surface: it is the Arc USDC payment policy, governed by
 *  `permissions` and enforced by the on-chain vault. It stays a literal because deriving it
 *  from /api/surfaces would claim it is something it is not. */
const PAYMENTS_TAB = {
  id: 'payments',
  label: 'Payments',
  status: 'live' as const,
  note: 'The USDC payment policy on Arc. Enforced by this server and by the on-chain vault.',
}
const AUDIT_TAB = {
  id: 'audit',
  label: 'Audit',
  status: 'live' as const,
  note: 'Every decision, why it went that way, and what happened next.',
}

type Permissions = {
  dailyCapUsd: number
  autoApproveUnderUsd: number
  payeeAllowlist: string[]
  agentToAgent: boolean
  agentToHuman: boolean
  frozen: boolean
}

type Policy = {
  agentId: string
  name: string
  permissions: Permissions
  spentTodayUsd: number
  remainingTodayUsd: number
  resetsAt: string
}

type Agent = { id: string; name: string }

/** Result of pushing the saved limits onto the agent's on-chain policy vault. */
type VaultSyncNote = {
  synced: boolean
  ownerGated?: boolean
  reason?: string
  note?: string
  txs?: { setPolicy?: string; setFrozen?: string }
}

const ARCSCAN_TX = 'https://testnet.arcscan.app/tx/'

export default function Permissions() {
  const [tab, setTab] = useState('payments')
  const [surfaces, setSurfaces] = useState<Surface[] | null>(null)
  const [surfacesFailed, setSurfacesFailed] = useState(false)

  // The tab row, derived. A planned surface renders disabled and carries its own reason,
  // so "not live" is a visible decision rather than an absence.
  const tabs = useMemo(
    () => [
      PAYMENTS_TAB,
      ...(surfaces ?? []).map((s) => ({ id: s.id, label: s.name, status: s.status, note: s.note })),
      AUDIT_TAB,
    ],
    [surfaces],
  )
  const tabOrder = useMemo(() => tabs.map((t) => t.id), [tabs])
  const { shown: shownTab, className: paneClass } = useTabCarousel(tab, tabOrder)
  const [agents, setAgents] = useState<Agent[]>([])
  const agentId = useSelectedAgent((s) => s.agentId)
  const syncRoster = useSelectedAgent((s) => s.syncRoster)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [draft, setDraft] = useState<Permissions | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [vaultSync, setVaultSync] = useState<VaultSyncNote | null>(null)

  // Live "resets in" countdown, ticking each minute.
  const [now, setNow] = useState(() => new Date().getTime())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date().getTime()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Static registry data, so it is fetched once and never refetched per agent.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const res = await apiFetch('/api/surfaces')
        const j = (await res.json()) as { surfaces?: Surface[] }
        if (active) setSurfaces(j.surfaces ?? [])
      } catch {
        // Fail visibly rather than falling back to a hardcoded list: a stale literal is
        // exactly the drift this replaced.
        if (active) { setSurfaces([]); setSurfacesFailed(true) }
      }
    })()
    return () => { active = false }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const data = await fetchPlatformAgents<Agent>()
        setAgents(data.agents)
        syncRoster(data.agents.map((a) => a.id), pickPrimaryAgent(data.agents)?.id)
        if (!data.agents.length) setLoading(false)
      } catch {
        setError(BACKEND_UNREACHABLE)
        setLoading(false)
      }
    })()
  }, [syncRoster])

  // `isActive` guards setState so a late policy response for a previously-selected agent
  // can't overwrite the caps/limits now shown for a different one.
  const loadPolicy = useCallback(async (id: string, isActive: () => boolean = () => true) => {
    try {
      const res = await apiFetch(`/api/agents/policy?agentId=${id}`)
      const p = (await res.json()) as Policy
      if (isActive()) {
        setPolicy(p)
        setDraft(p.permissions)
        setError(null)
      }
    } catch {
      if (isActive()) setError('Could not load the policy.')
    } finally {
      if (isActive()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    if (agentId) loadPolicy(agentId, () => active)
    return () => { active = false }
  }, [agentId, loadPolicy])

  const save = async () => {
    if (!draft || !agentId) return
    setSaving(true)
    setSaved(false)
    setVaultSync(null)
    try {
      const res = await apiFetch('/api/agents/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, permissions: draft }),
        onWaking: () => setError('Waking up the backend (free tier)...'),
      })
      // Fail loudly instead of showing a false "saved": a guest (401) or a caller who
      // does not own this agent (403) is rejected by the backend, and the limits revert
      // on reload, which reads as "I set it but nothing changed".
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        setError(explainError(res.status, j.error))
        return
      }
      setError(null)
      // When the agent has an on-chain vault, the backend reports whether it pushed
      // the new limits on-chain (or that the owner must sign the change).
      const j = (await res.json().catch(() => null)) as { agent?: { vaultSync?: VaultSyncNote } } | null
      if (j?.agent?.vaultSync) setVaultSync(j.agent.vaultSync)
      await loadPolicy(agentId)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {
      setError('Save failed. The backend may be waking up; try again in a moment.')
    } finally {
      setSaving(false)
    }
  }

  const set = <K extends keyof Permissions>(key: K, value: Permissions[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d))

  const untilReset = (iso: string) => {
    const ms = new Date(iso).getTime() - now
    if (ms <= 0) return 'now'
    const h = Math.floor(ms / 3_600_000)
    const m = Math.floor((ms % 3_600_000) / 60_000)
    return `${h}h ${m}m`
  }

  return (
    <AppPage
      ambient
      width="form"
      title="Permissions"
      description="You are in control. Set what your agent can do, who it can pay, and how much it can spend per day. The policy engine enforces every rule here for real."
    >
      {error && (
        <div className="mt-6 rounded-2xl border border-warn/25 bg-warn/10 p-4 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {loading && !error && (
        <div className="mt-4 space-y-4">
          {/* Daily-spend card */}
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-28" />
            </div>
            <div className="mt-3 flex items-end justify-between">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
            <Skeleton className="mt-3 h-2 w-full rounded-full" />
          </div>
          {/* Spending limits (form rows) */}
          <div className="rounded-2xl border border-border bg-card p-6">
            <Skeleton className="mb-4 h-4 w-32" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-10 w-full rounded-xl" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-10 w-full rounded-xl" />
              </div>
            </div>
          </div>
          {/* Access controls (toggle rows) */}
          <div className="rounded-2xl border border-border bg-card p-6">
            <Skeleton className="mb-4 h-4 w-32" />
            <div className="space-y-4">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <div className="min-w-0 space-y-2">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                  <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && !error && agents.length === 0 && (
        <div className="mt-6 rounded-2xl border border-dashed border-foreground/15 bg-card p-8 text-center text-sm text-foreground/55">
          No agents yet. Register one in Agent ID, then set its permissions here.
        </div>
      )}

      {policy && draft && (
        <>
          {/* Agent selector */}
          <AgentSelect agents={agents} className="mt-6" />

          {/* Surface tabs, derived from the backend surface registry. Payments is the USDC
              policy on Arc and stays a literal; the rest are the policy-engine surfaces.
              They are separate on purpose: the two govern different surfaces, and merging
              them would put payee allowlists next to tickers. */}
          <div data-tour="tabs" className="mt-6 flex flex-wrap gap-1.5 border-b border-border pb-3" role="tablist" aria-label="Permission surfaces">
            {tabs.map((t) => {
              const planned = t.status !== 'live'
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  disabled={planned}
                  title={planned ? `Not live. ${t.note}` : t.note}
                  onClick={() => { if (!planned) setTab(t.id) }}
                  aria-selected={tab === t.id}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors duration-[120ms] ${
                    planned
                      ? 'cursor-not-allowed border-transparent text-foreground/30'
                      : tab === t.id
                        ? 'border-foreground/60 text-foreground'
                        : 'border-transparent text-foreground/50 hover:text-foreground/80'
                  }`}
                >
                  {t.label}
                  {planned && (
                    <span className="rounded-sm bg-warn/15 px-1 py-px text-[9px] tracking-normal text-warn">planned</span>
                  )}
                </button>
              )
            })}
          </div>
          {/* A planned surface says why, in the open. It is a schema that shipped and a
              decision not to run it, and both halves are worth reading. */}
          {tabs.filter((t) => t.status !== 'live').map((t) => (
            <p key={t.id} className="mt-2 text-[11px] text-foreground/45">
              <span className="font-semibold text-foreground/60">{t.label}</span> is planned, not live: {t.note}
            </p>
          ))}
          {surfacesFailed && (
            <p className="mt-2 text-[11px] text-warn">
              Could not read the action surfaces, so only the payment policy and the audit trail are shown here.
            </p>
          )}

          <div className="cn-tab-clip">
          <div className={paneClass}>
          {shownTab === 'payments' && (
          <>
          {/* Daily limit status */}
          <div data-tour="today" className="mt-4 rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CreditCard size={16} className="text-usdc" />
                Today's spending
              </div>
              <div className="text-xs text-foreground/45">
                Resets at 00:00 UTC (in {untilReset(policy.resetsAt)})
              </div>
            </div>
            <div className="mt-3 flex items-end justify-between">
              <div className="text-2xl font-bold tracking-tight text-foreground">
                ${policy.spentTodayUsd.toFixed(2)}
                <span className="text-sm font-semibold text-foreground/40"> / ${policy.permissions.dailyCapUsd}</span>
              </div>
              <div className="text-xs font-semibold text-ok">
                ${policy.remainingTodayUsd.toFixed(2)} left today
              </div>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-foreground/8">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (policy.spentTodayUsd / Math.max(1, policy.permissions.dailyCapUsd)) * 100)}%`,
                  background: policy.spentTodayUsd >= policy.permissions.dailyCapUsd ? 'var(--danger)' : 'var(--usdc)',
                }}
              />
            </div>
          </div>

          {/* Spending limits (editable) */}
          <section data-tour="limits" className="mt-4 rounded-2xl border border-border bg-card p-6">
            <h3 className="mb-4 font-semibold text-foreground">Spending limits</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="daily-cap" className="text-xs font-semibold text-foreground/50">Daily cap (USD)</label>
                <NumberField
                  id="daily-cap"
                  value={draft.dailyCapUsd}
                  onChange={(n) => set('dailyCapUsd', n)}
                  className="mt-1"
                />
                <p className="mt-1 text-[11px] text-foreground/45">Total the agent may commit per day. Resets 00:00 UTC.</p>
              </div>
              <div>
                <label htmlFor="auto-approve" className="text-xs font-semibold text-foreground/50">Auto-approve under (USD)</label>
                <NumberField
                  id="auto-approve"
                  value={draft.autoApproveUnderUsd}
                  onChange={(n) => set('autoApproveUnderUsd', n)}
                  className="mt-1"
                />
                <p className="mt-1 text-[11px] text-foreground/45">Payments below this settle without asking you.</p>
              </div>
            </div>
          </section>

          {/* Access controls (toggles) */}
          <section data-tour="access" className="mt-4 rounded-2xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-ok text-white">
                <Shield size={15} />
              </div>
              <h3 className="font-semibold text-foreground">Access controls</h3>
            </div>
            <ul className="divide-y divide-foreground/8">
              <Row
                label="Agent-to-agent payments"
                desc="Let the agent pay other verified agents autonomously, within the limits above."
                on={draft.agentToAgent}
                onChange={() => set('agentToAgent', !draft.agentToAgent)}
              />
              <Row
                label="Agent-to-human payments"
                desc="Allow the agent to pay human wallet addresses."
                on={draft.agentToHuman}
                onChange={() => set('agentToHuman', !draft.agentToHuman)}
              />
            </ul>

            <div className="mt-5 border-t border-foreground/8 pt-5">
              <div className="text-sm font-semibold text-foreground">Payee allowlist</div>
              <p className="mt-1 text-xs text-foreground/50">
                When set, the agent can only pay these payees. Leave it empty to let it pay anyone within the limits above.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {draft.payeeAllowlist.length === 0 ? (
                  <span className="text-xs text-foreground/40">No allowlist. The agent may pay any payee within its limits.</span>
                ) : (
                  draft.payeeAllowlist.map((p) => (
                    <span
                      key={p}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground/70"
                    >
                      {p.length > 14 ? short(p) : p}
                      <button
                        type="button"
                        onClick={() => set('payeeAllowlist', draft.payeeAllowlist.filter((x) => x !== p))}
                        className="grid h-4 w-4 place-items-center rounded-full text-sm leading-none text-foreground/40 hover:bg-danger/10 hover:text-danger"
                        aria-label={`Remove ${p}`}
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
              <PayeeAdder
                onAdd={(v) => {
                  if (v && !draft.payeeAllowlist.includes(v)) set('payeeAllowlist', [...draft.payeeAllowlist, v])
                }}
              />
            </div>
          </section>

          {/* Safety */}
          <section data-tour="safety" className="mt-4 rounded-2xl border border-border bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-danger text-white">
                <Snowflake size={15} />
              </div>
              <h3 className="font-semibold text-foreground">Safety</h3>
            </div>
            <ul className="divide-y divide-foreground/8">
              <Row
                label="Freeze all activity"
                desc="Emergency off switch. Every payment pauses for your approval until you unfreeze."
                on={draft.frozen}
                danger
                onChange={() => set('frozen', !draft.frozen)}
              />
            </ul>
          </section>

          {/* Save. A confirmed save blooms once (accent glow, see console.css): the
              moment the rules changed deserves a beat more than a label swap. */}
          <div data-tour="save" className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className={`inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform duration-[120ms] hover:bg-accent-deep disabled:opacity-50 ${saved ? 'cn-bloom' : ''}`}
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : saved ? <Check size={16} /> : <Save size={16} />}
              {saving ? 'Saving...' : saved ? 'Saved' : 'Save permissions'}
            </button>
            <span className="text-xs text-foreground/45">Applies to every new action immediately.</span>
          </div>

          {/* On-chain vault sync outcome (only when the agent has a deployed vault) */}
          {vaultSync && (
            <div
              className={`mt-3 rounded-xl border px-4 py-3 text-xs ${
                vaultSync.synced
                  ? 'border-accent/25 bg-accent/[0.05] text-foreground/70'
                  : 'border-warn/40 bg-warn/10 text-warn'
              }`}
            >
              {vaultSync.synced ? (
                <span>
                  {vaultSync.note ?? 'New limits pushed to the on-chain policy vault.'}
                  {vaultSync.txs?.setPolicy && (
                    <>
                      {' '}
                      <a
                        href={`${ARCSCAN_TX}${vaultSync.txs.setPolicy}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-semibold text-accent hover:underline"
                      >
                        View setPolicy tx
                      </a>
                    </>
                  )}
                </span>
              ) : (
                <span>{vaultSync.reason ?? 'Could not sync the on-chain vault.'}</span>
              )}
            </div>
          )}

          {/* Onchain policy vault: deploy this policy as a smart contract on Arc */}
          <VaultPanel agentId={agentId} />
          <CirclePolicyPanel agentId={agentId} />

          {/* Try a payment (live policy tester) */}
          <PolicyTester agentId={agentId} onSpent={() => loadPolicy(agentId)} />
          </>
          )}

          {/* Keyed off the registry's surface ids, so a rename in the registry shows up
              here as a missing pane rather than as a pane wired to a stale string. */}
          {shownTab === 'trade' && <TradingPermissions agentId={agentId} />}
          {shownTab === 'spend' && <SpendPermissions agentId={agentId} />}
          {shownTab === 'audit' && (
            <>
              <AuditTrail agentId={agentId} />
              <VenuePanel />
            </>
          )}
          </div>
          </div>
        </>
      )}

      {/* The account block that used to sit here said the same three things as the
          sidebar's account card, one scroll below a policy screen it had nothing to do
          with. Who you are is not a permission, so it lives in the rail now. */}
    </AppPage>
  )
}

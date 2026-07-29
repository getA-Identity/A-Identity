import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Check,
  CreditCard,
  ExternalLink,
  Link2,
  LogOut,
  PlayCircle,
  Save,
  Shield,
  Snowflake,
} from 'lucide-react'
import { useAuth, authHeaders } from '../../store/auth'
import { Stat } from '../../components/app/WalletPanels'
import TradingPermissions from '../../components/app/TradingPermissions'
import AuditTrail from '../../components/app/AuditTrail'
import SpendPermissions from '../../components/app/SpendPermissions'

import { BACKEND_UNREACHABLE } from '../../lib/mcpBase'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { fetchPlatformAgents } from '../../lib/platformAgents'
import { Skeleton } from '../../components/ui/skeleton'
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}...${a.slice(-4)}` : a)

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
  const user = useAuth((s) => s.user)
  const logout = useAuth((s) => s.logout)
  const navigate = useNavigate()

  const [tab, setTab] = useState<'payments' | 'trading' | 'spend' | 'audit'>('payments')
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentId, setAgentId] = useState('')
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

  useEffect(() => {
    ;(async () => {
      try {
        const data = await fetchPlatformAgents<Agent>()
        setAgents(data.agents)
        if (data.agents.length) setAgentId((cur) => cur || data.agents[0].id)
        else setLoading(false)
      } catch {
        setError(BACKEND_UNREACHABLE)
        setLoading(false)
      }
    })()
  }, [])

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
    <div className="mx-auto max-w-2xl">
      <h2 className="text-2xl font-bold tracking-tight">Permissions</h2>
      <p className="mt-1 text-sm text-foreground/55">
        You are in control. Set what your agent can do, who it can pay, and how much it
        can spend per day. The policy engine enforces every rule here for real.
      </p>

      {error && (
        <div className="mt-5 rounded-2xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-4 text-sm text-foreground/70">
          {error}
        </div>
      )}

      {loading && !error && (
        <div className="mt-5 space-y-4">
          {/* Daily-spend card */}
          <div className="rounded-2xl border border-foreground/10 bg-card p-5">
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
          <div className="rounded-2xl border border-foreground/10 bg-card p-6">
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
          <div className="rounded-2xl border border-foreground/10 bg-card p-6">
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
        <div className="mt-5 rounded-2xl border border-dashed border-foreground/15 bg-card p-8 text-center text-sm text-foreground/55">
          No agents yet. Register one in Agent ID, then set its permissions here.
        </div>
      )}

      {policy && draft && (
        <>
          {/* Agent selector */}
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

          {/* Surface tabs. Payments is the USDC policy on Arc; Trading is the brokerage
              action policy. They are separate on purpose: the two govern different
              surfaces, and merging them would put payee allowlists next to tickers. */}
          <div className="mt-5 flex flex-wrap gap-1 rounded-xl border border-foreground/10 bg-card p-1">
            {([
              ['payments', 'Payments'],
              ['trading', 'Trading'],
              ['spend', 'Spend'],
              ['audit', 'Audit'],
            ] as const).map(([id, labelText]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition-colors ${
                  tab === id ? 'bg-accent text-white' : 'text-foreground/55 hover:text-foreground'
                }`}
                aria-current={tab === id}
              >
                {labelText}
              </button>
            ))}
          </div>

          {tab === 'payments' && (
          <>
          {/* Daily limit status */}
          <div className="mt-5 rounded-2xl border border-foreground/10 bg-card p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CreditCard size={16} className="text-[#2775CA]" />
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
              <div className="text-xs font-semibold text-emerald-600">
                ${policy.remainingTodayUsd.toFixed(2)} left today
              </div>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-foreground/8">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, (policy.spentTodayUsd / Math.max(1, policy.permissions.dailyCapUsd)) * 100)}%`,
                  background: policy.spentTodayUsd >= policy.permissions.dailyCapUsd ? '#EF4444' : '#2775CA',
                }}
              />
            </div>
          </div>

          {/* Spending limits (editable) */}
          <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
            <h3 className="mb-4 font-semibold text-foreground">Spending limits</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="text-xs font-semibold text-foreground/50">Daily cap (USD)</label>
                <input
                  type="number"
                  min="0"
                  value={draft.dailyCapUsd}
                  onChange={(e) => set('dailyCapUsd', Number(e.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-foreground/10 bg-background/40 px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
                <p className="mt-1 text-[11px] text-foreground/45">Total the agent may commit per day. Resets 00:00 UTC.</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-foreground/50">Auto-approve under (USD)</label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={draft.autoApproveUnderUsd}
                  onChange={(e) => set('autoApproveUnderUsd', Number(e.target.value) || 0)}
                  className="mt-1 w-full rounded-xl border border-foreground/10 bg-background/40 px-3 py-2.5 text-sm outline-none focus:border-accent"
                />
                <p className="mt-1 text-[11px] text-foreground/45">Payments below this settle without asking you.</p>
              </div>
            </div>
          </section>

          {/* Access controls (toggles) */}
          <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-[#1AAB7A] text-white">
                <Shield size={15} />
              </div>
              <h3 className="font-semibold text-foreground">Access controls</h3>
            </div>
            <ul className="divide-y divide-ink/8">
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
                      className="inline-flex items-center gap-1.5 rounded-full border border-foreground/10 bg-background/70 px-2.5 py-1 font-mono text-[11px] text-foreground/70"
                    >
                      {p.length > 14 ? short(p) : p}
                      <button
                        type="button"
                        onClick={() => set('payeeAllowlist', draft.payeeAllowlist.filter((x) => x !== p))}
                        className="grid h-4 w-4 place-items-center rounded-full text-sm leading-none text-foreground/40 hover:bg-red-50 hover:text-red-500"
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
          <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
            <div className="mb-4 flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-red-500 text-white">
                <Snowflake size={15} />
              </div>
              <h3 className="font-semibold text-foreground">Safety</h3>
            </div>
            <ul className="divide-y divide-ink/8">
              <Row
                label="Freeze all activity"
                desc="Emergency off switch. Every payment pauses for your approval until you unfreeze."
                on={draft.frozen}
                danger
                onChange={() => set('frozen', !draft.frozen)}
              />
            </ul>
          </section>

          {/* Save */}
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
            >
              {saved ? <Check size={16} /> : <Save size={16} />}
              {saving ? 'Saving...' : saved ? 'Saved' : 'Save permissions'}
            </button>
            <span className="text-xs text-foreground/45">Applies to every new action immediately.</span>
          </div>

          {/* On-chain vault sync outcome (only when the agent has a deployed vault) */}
          {vaultSync && (
            <div
              className={`mt-3 rounded-xl border px-4 py-3 text-xs ${
                vaultSync.synced
                  ? 'border-[#7342E2]/25 bg-[#7342E2]/[0.05] text-foreground/70'
                  : 'border-amber-400/40 bg-amber-50 text-amber-800 dark:text-amber-300'
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
                        className="font-semibold text-[#7342E2] hover:underline"
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

          {/* Try a payment (live policy tester) */}
          <PolicyTester agentId={agentId} onSpent={() => loadPolicy(agentId)} />
          </>
          )}

          {tab === 'trading' && <TradingPermissions agentId={agentId} />}
          {tab === 'audit' && <AuditTrail agentId={agentId} />}

          {tab === 'spend' && <SpendPermissions agentId={agentId} />}
        </>
      )}

      {/* Profile */}
      <section className="mt-6 rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-4 font-semibold">Profile</h3>
        <div className="flex items-center gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-accent text-lg font-bold text-white">
            {user?.name?.[0]?.toUpperCase() ?? 'U'}
          </div>
          <div className="min-w-0">
            <div className="truncate font-semibold">{user?.name}</div>
            <div className="truncate text-sm text-foreground/55">{user?.email}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            logout()
            navigate('/')
          }}
          className="mt-4 inline-flex items-center gap-2 rounded-full border border-foreground/15 bg-card px-5 py-3 text-sm font-semibold text-foreground/80 transition-colors hover:bg-foreground/5"
        >
          <LogOut size={16} />
          Log out
        </button>
      </section>
    </div>
  )
}

function PayeeAdder({ onAdd }: { onAdd: (v: string) => void }) {
  const [v, setV] = useState('')
  const add = () => {
    const t = v.trim()
    if (t) {
      onAdd(t)
      setV('')
    }
  }
  return (
    <div className="mt-3 flex items-center gap-2">
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        placeholder="Add a 0x address or agent://<id>"
        className="min-w-0 flex-1 rounded-xl border border-foreground/10 bg-background/40 px-3 py-2 font-mono text-xs outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={add}
        className="shrink-0 rounded-full border border-foreground/15 px-4 py-2 text-xs font-semibold text-foreground/70 transition hover:border-accent"
      >
        Add
      </button>
    </div>
  )
}

function Row({
  label,
  desc,
  on,
  danger,
  onChange,
}: {
  label: string
  desc: string
  on: boolean
  danger?: boolean
  onChange: () => void
}) {
  return (
    <li className="flex items-center justify-between gap-4 py-4">
      <div className="min-w-0">
        <div className={`text-sm font-medium ${danger ? 'text-red-600' : 'text-foreground'}`}>{label}</div>
        <div className="mt-0.5 text-xs text-foreground/50">{desc}</div>
      </div>
      <Toggle on={on} danger={danger} onChange={onChange} />
    </li>
  )
}

function Toggle({ on, danger, onChange }: { on: boolean; danger?: boolean; onChange: () => void }) {
  const activeColor = danger ? 'bg-red-500' : 'bg-accent'
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onChange}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${on ? activeColor : 'bg-foreground/20'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-card shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  )
}

/** Fire a real instruction through the policy engine and show the verdict. */
function PolicyTester({ agentId, onSpent }: { agentId: string; onSpent: () => void }) {
  const [amount, setAmount] = useState('10')
  const [payee, setPayee] = useState('agent://provider')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ status: string; policyNote: string } | null>(null)

  const run = async () => {
    setBusy(true)
    try {
      const res = await apiFetch('/api/instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, type: 'payment', amountUsd: Math.max(0, Number(amount) || 0), payee, memo: 'policy test' }),
        onWaking: () => setResult({ status: 'error', policyNote: 'Waking up the backend (free tier)...' }),
      })
      const ix = await readJson<{ status?: string; policyNote?: string; error?: string }>(res)
      if (!res.ok) {
        setResult({ status: 'error', policyNote: explainError(res.status, ix.error) })
        return
      }
      setResult({ status: ix.status ?? 'error', policyNote: ix.policyNote ?? ix.error ?? '' })
      onSpent()
    } catch {
      setResult({ status: 'error', policyNote: 'Backend not reachable. It may be waking up, try again.' })
    } finally {
      setBusy(false)
    }
  }

  const approved = result?.status === 'auto_approved'
  const pending = result?.status === 'pending_approval'

  return (
    <section className="mt-4 rounded-2xl border border-accent/20 bg-accent/[0.04] p-6">
      <div className="mb-1 flex items-center gap-2">
        <PlayCircle size={16} className="text-accent" />
        <h3 className="font-semibold text-foreground">Try a payment</h3>
      </div>
      <p className="mb-4 text-xs text-foreground/55">
        Send a test payment through the real policy engine. Watch it auto-approve under your
        rules, or pause for approval once it would break the daily cap.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-[11px] font-semibold text-foreground/50">Amount (USD)</label>
          <input
            type="number"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="mt-1 w-28 rounded-xl border border-foreground/10 bg-card px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex-1">
          <label className="text-[11px] font-semibold text-foreground/50">Payee</label>
          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            className="mt-1 w-full rounded-xl border border-foreground/10 bg-card px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
        >
          {busy ? 'Testing...' : 'Test'}
        </button>
      </div>

      {result && (
        <div
          className={`mt-4 rounded-xl border p-3 text-sm ${
            approved
              ? 'border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10 text-emerald-800'
              : pending
                ? 'border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 text-amber-800 dark:text-amber-300'
                : 'border-red-200 dark:border-red-500/25 bg-red-50/60 dark:bg-red-500/10 text-red-700 dark:text-red-300'
          }`}
        >
          <div className="flex items-center gap-1.5 font-bold">
            {approved ? <Check size={14} /> : <AlertTriangle size={14} />}
            {approved ? 'Auto-approved' : pending ? 'Paused for human approval' : 'Error'}
          </div>
          <p className="mt-0.5">{result.policyNote}</p>
        </div>
      )}
    </section>
  )
}

type VaultState = {
  vaultAddress: string | null
  dailyCapUsd?: number
  autoApproveUsd?: number
  frozen?: boolean
  spentTodayUsd?: number
  balanceUsd?: number
  sessionKeyExpiry?: number
  sessionKeyExpired?: boolean
  explorer?: string
  error?: string
}

/** Human-readable "expires in ~Xh Ym" for a UNIX-seconds expiry. */
function untilLabel(expiryUnix?: number): string {
  if (!expiryUnix) return ''
  const secs = expiryUnix - Math.floor(Date.now() / 1000)
  if (secs <= 0) return 'expired'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `~${h}h ${m}m left` : `~${m}m left`
}

/**
 * Deploy the agent's policy as a real smart contract on Arc. Once live, address
 * payments settle THROUGH the vault. A payment over the cap or auto-approve line
 * reverts onchain, not just on our server. Programmable money enforcing itself.
 */
function VaultPanel({ agentId }: { agentId: string }) {
  const [vault, setVault] = useState<VaultState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fund, setFund] = useState('2')
  const [sessionHours, setSessionHours] = useState('1')
  const [busyKey, setBusyKey] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/agents/vault?agentId=${agentId}`)
      setVault((await res.json()) as VaultState)
      setErr(null)
    } catch {
      setErr('Could not load vault status.')
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
      const res = await apiFetch('/api/agents/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, fundUsd: Math.max(0, Number(fund) || 0) }),
        timeoutMs: 90_000, // deploying a contract + funding it on-chain takes a while
        onWaking: () => setErr('Waking up the backend (free tier)...'),
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
      setErr('Deploying the vault timed out. It runs on-chain and can be slow, give it a moment and try again.')
    } finally {
      setBusy(false)
    }
  }

  const setSessionKey = async (opts: { durationHours?: number; revoke?: boolean }) => {
    setBusyKey(true)
    setErr(null)
    try {
      const res = await apiFetch('/api/agents/session-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, ...opts }),
        timeoutMs: 60_000,
      })
      const j = await readJson<{ error?: string; ownerGated?: boolean; reason?: string }>(res)
      if (!res.ok) { setErr(explainError(res.status, j.error)); return }
      if (j.ownerGated) setErr(j.reason ?? 'The vault owner must sign this from their own wallet.')
      await load()
    } catch {
      setErr('Could not update the session key (the backend may be waking up, try again).')
    } finally {
      setBusyKey(false)
    }
  }

  const has = !!vault?.vaultAddress
  const keyActive = has && (vault?.sessionKeyExpiry ?? 0) > 0 && !vault?.sessionKeyExpired

  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-[#7342E2]/25 bg-gradient-to-b from-[#7342E2]/[0.06] to-card p-6 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-7">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#7342E2] text-white">
          <Link2 size={16} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-foreground">Onchain Policy Vault</h3>
            {has && (
              <span className="rounded-full bg-[#7342E2]/10 px-2 py-0.5 text-[10px] font-semibold text-[#7342E2]">
                Live on Arc
              </span>
            )}
          </div>
          <p className="text-[11px] text-foreground/50">Your policy, enforced by a smart contract</p>
        </div>
      </div>
      <p className="mt-3 mb-4 text-xs text-foreground/55">
        Deploy this policy as a smart contract on Arc. Once live, the agent's payments to an Arc
        address settle <b>through the vault</b>. Anything over the cap or auto-approve line
        reverts onchain, not just on our server. Programmable money enforcing itself.
      </p>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-2xl border border-foreground/[0.06] bg-card px-4 py-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-1.5 h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
      ) : has ? (
        <div className="space-y-3">
          <a
            href={vault!.explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-[#7342E2] hover:underline"
          >
            {short(vault!.vaultAddress!)} <ExternalLink size={11} />
          </a>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Daily Cap" value={`$${vault!.dailyCapUsd}`} />
            <Stat label="Auto Approve" value={`$${vault!.autoApproveUsd}`} />
            <Stat label="Spent Today" value={`$${vault!.spentTodayUsd?.toFixed(2) ?? '0.00'}`} />
            <Stat label="Vault Balance" value={`$${vault!.balanceUsd?.toFixed(2) ?? '0.00'}`} />
          </div>
          {vault!.frozen && (
            <div className="text-xs font-semibold text-red-600">Frozen onchain. The agent cannot spend.</div>
          )}
          <p className="text-[11px] text-foreground/45">
            The contract enforces the same limits set above. Address payments now settle through it.
          </p>

          {/* Session key: a time-bounded spend authority the human grants the agent. */}
          <div className="mt-2 rounded-xl border border-foreground/10 bg-background/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-foreground/70">Session key (bounded authority)</div>
              {keyActive ? (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  active · {untilLabel(vault!.sessionKeyExpiry)}
                </span>
              ) : vault!.sessionKeyExpired ? (
                <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:text-red-300">expired</span>
              ) : (
                <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-bold text-foreground/50">no time limit</span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-foreground/45">
              Grant the agent a spend authority scoped to the cap/allowlist above and a <b>time limit</b>.
              When it expires, the agent's on-chain payments revert until you extend or re-grant it.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div>
                <label className="text-[10px] font-semibold text-foreground/50">Valid for (hours)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={sessionHours}
                  onChange={(e) => setSessionHours(e.target.value)}
                  className="mt-1 w-24 rounded-lg border border-foreground/10 bg-card px-3 py-1.5 text-sm outline-none focus:border-[#7342E2]"
                />
              </div>
              <button
                type="button"
                onClick={() => setSessionKey({ durationHours: Math.max(0, Number(sessionHours) || 0) })}
                disabled={busyKey}
                className="rounded-full bg-[#7342E2] px-3 py-1.5 text-xs font-semibold text-white hover:scale-[1.02] disabled:opacity-50"
              >
                {busyKey ? 'Signing...' : keyActive ? 'Extend / re-grant' : 'Grant session key'}
              </button>
              {keyActive && (
                <button
                  type="button"
                  onClick={() => setSessionKey({ revoke: true })}
                  disabled={busyKey}
                  className="rounded-full border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:hover:bg-red-500/10"
                >
                  Revoke now
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[11px] font-semibold text-foreground/50">Fund with (USDC)</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={fund}
              onChange={(e) => setFund(e.target.value)}
              className="mt-1 w-28 rounded-xl border border-foreground/10 bg-card px-3 py-2 text-sm outline-none focus:border-[#7342E2]"
            />
          </div>
          <button
            type="button"
            onClick={provision}
            disabled={busy}
            className="rounded-full bg-[#7342E2] px-4 py-2 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {busy ? 'Deploying on Arc...' : 'Provision on-chain vault'}
          </button>
        </div>
      )}
      {err && <div className="mt-3 text-xs text-red-600">{err}</div>}
    </section>
  )
}


/**
 * Trading Permissions (Phase 3.1): the editor for the action policy the guardrail engine
 * enforces before an agent touches a brokerage account.
 *
 * Distinct from the Payments tab, which edits the USDC payment policy on Arc. The two
 * govern different surfaces, so merging them would put payee allowlists next to ticker
 * allowlists.
 *
 * Two things are deliberately NOT editable here, and the UI says why rather than hiding
 * them: margin is off by construction, and a DENY cannot be overridden. Offering either as
 * a switch would misrepresent what the backend actually does.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Clock, Save, ShieldCheck, TrendingUp } from 'lucide-react'
import { authHeaders } from '../../store/auth'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { Skeleton } from '../ui/skeleton'
import { NumberField } from '../ui/number-field'

type TradePolicy = {
  allowSymbols: string[]
  denySymbols: string[]
  allowOptions: boolean
  allowMargin: false
  tradingHoursUtc: { start: string; end: string } | null
  maxConcentrationPct: number
}

export type ActionPolicy = {
  policyId: string
  version: number
  updatedAt: string
  frozen: boolean
  perActionCapUsd: number
  dailyCapUsd: number
  humanApprovalAboveUsd: number
  trade: TradePolicy
}

const input =
  'mt-1 w-full rounded-xl border border-foreground/10 bg-background/40 px-3 py-2.5 text-sm outline-none focus:border-accent'
const label = 'text-xs font-semibold text-foreground/50'
const hint = 'mt-1 text-[11px] text-foreground/45'

/** Comma-separated text to a clean ticker list, and back. Kept lossless while typing. */
const listToText = (l: string[]) => l.join(', ')
const textToList = (t: string) =>
  t
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)

export default function TradingPermissions({ agentId }: { agentId: string }) {
  const [policy, setPolicy] = useState<ActionPolicy | null>(null)
  const [draft, setDraft] = useState<ActionPolicy | null>(null)
  const [configured, setConfigured] = useState(false)
  const [allowText, setAllowText] = useState('')
  const [denyText, setDenyText] = useState('')
  const [hoursOn, setHoursOn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (id: string, isActive: () => boolean = () => true) => {
    try {
      const res = await apiFetch(`/api/agents/action-policy?agentId=${encodeURIComponent(id)}`)
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        if (isActive()) setError(explainError(res.status, j.error))
        return
      }
      const j = (await res.json()) as { policy: ActionPolicy; configured: boolean }
      if (!isActive()) return
      setPolicy(j.policy)
      setDraft(j.policy)
      setConfigured(j.configured)
      setAllowText(listToText(j.policy.trade.allowSymbols))
      setDenyText(listToText(j.policy.trade.denySymbols))
      setHoursOn(Boolean(j.policy.trade.tradingHoursUtc))
      setError(null)
    } catch {
      if (isActive()) setError('Could not load the trading policy.')
    } finally {
      if (isActive()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    if (agentId) void load(agentId, () => active)
    return () => {
      active = false
    }
  }, [agentId, load])

  const set = <K extends keyof ActionPolicy>(k: K, v: ActionPolicy[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d))
  const setTrade = <K extends keyof TradePolicy>(k: K, v: TradePolicy[K]) =>
    setDraft((d) => (d ? { ...d, trade: { ...d.trade, [k]: v } } : d))

  const save = async () => {
    if (!draft || !agentId) return
    setSaving(true)
    setSaved(false)
    try {
      // Send only what the user can set. `allowMargin` is deliberately absent: the backend
      // forces it off anyway, and posting it would imply it is ours to change.
      const body = {
        agentId,
        policy: {
          perActionCapUsd: draft.perActionCapUsd,
          dailyCapUsd: draft.dailyCapUsd,
          humanApprovalAboveUsd: draft.humanApprovalAboveUsd,
          frozen: draft.frozen,
          trade: {
            allowSymbols: textToList(allowText),
            denySymbols: textToList(denyText),
            allowOptions: draft.trade.allowOptions,
            maxConcentrationPct: draft.trade.maxConcentrationPct,
            tradingHoursUtc: hoursOn ? (draft.trade.tradingHoursUtc ?? { start: '13:30', end: '20:00' }) : null,
          },
        },
      }
      const res = await apiFetch('/api/agents/action-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
        onWaking: () => setError('Waking up the backend (free tier)...'),
      })
      // Fail loudly rather than showing a false "saved": a guest (401) or a caller who does
      // not own this agent (403) is rejected, and the limits would silently revert.
      if (!res.ok) {
        const j = await readJson<{ error?: string }>(res)
        setError(explainError(res.status, j.error))
        return
      }
      setError(null)
      await load(agentId)
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {
      setError('Save failed. The backend may be waking up; try again in a moment.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="mt-4 space-y-4">
        {[0, 1, 2].map((i) => (
          <section key={i} className="rounded-2xl border border-foreground/10 bg-card p-6">
            <Skeleton className="mb-4 h-4 w-40" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          </section>
        ))}
      </div>
    )
  }

  if (!draft) {
    return (
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <p className="text-sm text-foreground/60">{error ?? 'No trading policy available for this agent.'}</p>
      </section>
    )
  }

  return (
    <div className="mt-4">
      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-foreground/70">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
          <span>{error}</span>
        </div>
      )}

      {/* Honest state: defaults are shown until the owner actually saves something. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-foreground/[0.06] px-2 py-1 font-semibold text-foreground/70">
          <TrendingUp size={12} /> v{policy?.version ?? 1}
        </span>
        {configured ? (
          <span className="text-foreground/50">
            Saved policy. Every check runs against this version, and the audit trail records which one decided.
          </span>
        ) : (
          <span className="text-foreground/50">
            Showing safe defaults. Nothing is saved yet, so these are our starting values, not your choices.
          </span>
        )}
      </div>

      {/* Caps */}
      <section className="rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-4 font-semibold text-foreground">Limits</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="per-action-cap" className={label}>Per-action cap (USD)</label>
            <NumberField
              id="per-action-cap"
              value={draft.perActionCapUsd}
              onChange={(n) => set('perActionCapUsd', n)}
              className="mt-1"
            />
            <p className={hint}>The most a single action may be worth.</p>
          </div>
          <div>
            <label htmlFor="trading-daily-cap" className={label}>Daily cap (USD)</label>
            <NumberField
              id="trading-daily-cap"
              value={draft.dailyCapUsd}
              onChange={(n) => set('dailyCapUsd', n)}
              className="mt-1"
            />
            <p className={hint}>
              Total across the day. This is what stops many small actions adding up past the per-action cap.
            </p>
          </div>
          <div>
            <label htmlFor="human-approval-above" className={label}>Human approval above (USD)</label>
            <NumberField
              id="human-approval-above"
              value={draft.humanApprovalAboveUsd}
              onChange={(n) => set('humanApprovalAboveUsd', n)}
              className="mt-1"
            />
            <p className={hint}>At or above this, the action waits for you instead of being refused.</p>
          </div>
        </div>
      </section>

      {/* Symbols */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-4 font-semibold text-foreground">Symbols</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label}>Allow list</label>
            <input
              type="text"
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              placeholder="AAPL, MSFT"
              className={input}
            />
            <p className={hint}>Leave empty for no restriction. Non-empty means ONLY these.</p>
          </div>
          <div>
            <label className={label}>Deny list</label>
            <input
              type="text"
              value={denyText}
              onChange={(e) => setDenyText(e.target.value)}
              placeholder="GME"
              className={input}
            />
            <p className={hint}>Always wins over the allow list.</p>
          </div>
        </div>
      </section>

      {/* Risk */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-4 font-semibold text-foreground">Risk</h3>

        <div className="flex items-center justify-between border-b border-foreground/[0.07] py-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Options</div>
            <div className="text-[11px] text-foreground/45">
              Off by default. Options carry leverage, so this is opt-in.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setTrade('allowOptions', !draft.trade.allowOptions)}
            className={`h-6 w-11 shrink-0 rounded-full transition-colors ${draft.trade.allowOptions ? 'bg-accent' : 'bg-foreground/15'}`}
            aria-pressed={draft.trade.allowOptions}
            aria-label="Allow options"
          >
            <span
              className={`block h-5 w-5 rounded-full bg-white transition-transform ${draft.trade.allowOptions ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
            />
          </button>
        </div>

        {/* Not a switch, and the copy says why. Presenting margin as toggleable would
            misrepresent the engine: it is the literal false in the type. */}
        <div className="flex items-center justify-between border-b border-foreground/[0.07] py-3">
          <div>
            <div className="text-sm font-semibold text-foreground">Margin</div>
            <div className="text-[11px] text-foreground/45">
              Off by construction, not by preference. Margin can lose more than the account holds, so it is not
              offered as a setting.
            </div>
          </div>
          <span className="shrink-0 rounded-md bg-foreground/[0.06] px-2 py-1 text-[11px] font-semibold text-foreground/60">
            Always off
          </span>
        </div>

        <div className="py-3">
          <label htmlFor="max-concentration" className={label}>Max concentration in one symbol (%)</label>
          <NumberField
            id="max-concentration"
            max={100}
            value={draft.trade.maxConcentrationPct}
            onChange={(n) => setTrade('maxConcentrationPct', n)}
            className="mt-1 sm:max-w-[220px]"
          />
          <p className={hint}>
            Checked on the position AFTER a buy. 100 means no limit. Sells are never blocked by this, since they
            reduce concentration.
          </p>
        </div>
      </section>

      {/* Hours */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <div className="mb-4 flex items-center gap-2">
          <Clock size={16} className="text-foreground/40" />
          <h3 className="font-semibold text-foreground">Trading window (UTC)</h3>
        </div>
        <div className="flex items-center justify-between border-b border-foreground/[0.07] pb-3">
          <div className="text-[11px] text-foreground/45">
            Off means no clock restriction. A window that crosses midnight is supported.
          </div>
          <button
            type="button"
            onClick={() => {
              const next = !hoursOn
              setHoursOn(next)
              if (next && !draft.trade.tradingHoursUtc) setTrade('tradingHoursUtc', { start: '13:30', end: '20:00' })
            }}
            className={`h-6 w-11 shrink-0 rounded-full transition-colors ${hoursOn ? 'bg-accent' : 'bg-foreground/15'}`}
            aria-pressed={hoursOn}
            aria-label="Restrict trading hours"
          >
            <span
              className={`block h-5 w-5 rounded-full bg-white transition-transform ${hoursOn ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
            />
          </button>
        </div>
        {hoursOn && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label}>Start (HH:MM)</label>
              <input
                type="time"
                value={draft.trade.tradingHoursUtc?.start ?? '13:30'}
                onChange={(e) =>
                  setTrade('tradingHoursUtc', {
                    start: e.target.value,
                    end: draft.trade.tradingHoursUtc?.end ?? '20:00',
                  })
                }
                className={input}
              />
            </div>
            <div>
              <label className={label}>End (HH:MM)</label>
              <input
                type="time"
                value={draft.trade.tradingHoursUtc?.end ?? '20:00'}
                onChange={(e) =>
                  setTrade('tradingHoursUtc', {
                    start: draft.trade.tradingHoursUtc?.start ?? '13:30',
                    end: e.target.value,
                  })
                }
                className={input}
              />
            </div>
          </div>
        )}
      </section>

      {/* Freeze */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">Freeze all agent actions</div>
            <div className="text-[11px] text-foreground/45">
              Emergency stop. Every action is refused while this is on, whatever the other limits say.
            </div>
          </div>
          <button
            type="button"
            onClick={() => set('frozen', !draft.frozen)}
            className={`h-6 w-11 shrink-0 rounded-full transition-colors ${draft.frozen ? 'bg-red-500' : 'bg-foreground/15'}`}
            aria-pressed={draft.frozen}
            aria-label="Freeze agent"
          >
            <span
              className={`block h-5 w-5 rounded-full bg-white transition-transform ${draft.frozen ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
            />
          </button>
        </div>
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
        >
          {saved ? <Check size={16} /> : <Save size={16} />}
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save trading limits'}
        </button>
        <span className="text-xs text-foreground/45">Applies to the next action immediately, and bumps the policy version.</span>
      </div>

      <p className="mt-4 flex items-start gap-2 text-[11px] text-foreground/40">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        <span>
          These limits are enforced before an action reaches a venue. A denial means it breaks a limit you set, never
          that it is a bad investment. Not investment advice.
        </span>
      </p>
    </div>
  )
}

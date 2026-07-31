/**
 * Spend Permissions (Phase 4): the card-surface policy editor.
 *
 * It deliberately does NOT restate the controls the venue already gives you. Robinhood's
 * agent card carries its own single spending limit, a monthly cap and an all-or-nothing
 * approval toggle, so a second copy of those would be a worse version of a control that
 * already exists. What this adds is WHERE and on WHAT the money may go, and a refusal that
 * arrives with a reason and a record.
 *
 * Shares the same policy document as the Trading tab, so a saved change here bumps the same
 * version and the caps at the top apply to both surfaces.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, CreditCard, Plus, Save, ShieldCheck, X } from 'lucide-react'
import { authHeaders } from '../../store/auth'
import { apiFetch, readJson, explainError } from '../../lib/api'
import { Skeleton } from '../ui/skeleton'
import { NumberField } from '../ui/number-field'

type SpendPolicy = {
  merchantAllow: string[]
  merchantDeny: string[]
  categoryLimits: Record<string, number>
  cardCaps: Record<string, number>
  categoryDeny: string[]
}

type ActionPolicy = {
  policyId: string
  version: number
  perActionCapUsd: number
  dailyCapUsd: number
  humanApprovalAboveUsd: number
  spend?: SpendPolicy
}

const HIGH_RISK = ['cash_advance', 'quasi_cash', 'gambling'] as const
const HIGH_RISK_COPY: Record<string, string> = {
  cash_advance: 'Cash advances and ATM withdrawals',
  quasi_cash: 'Quasi-cash, which covers crypto purchases',
  gambling: 'Betting and casino gaming',
}

const input =
  'mt-1 w-full rounded-xl border border-foreground/10 bg-background/40 px-3 py-2.5 text-sm outline-none focus:border-accent'
const label = 'text-xs font-semibold text-foreground/50'
const hint = 'mt-1 text-[11px] text-foreground/45'

const listToText = (l: string[]) => l.join(', ')
const textToList = (t: string) =>
  t
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** A small editor for a {key: usd} map, used for both category limits and card ceilings. */
function UsdMapEditor({
  rows,
  onChange,
  keyPlaceholder,
  keyLabel,
}: {
  rows: [string, number][]
  onChange: (rows: [string, number][]) => void
  keyPlaceholder: string
  keyLabel: string
}) {
  return (
    <div className="space-y-2">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="text"
            value={k}
            placeholder={keyPlaceholder}
            onChange={(e) => {
              const next = [...rows]
              next[i] = [e.target.value, v]
              onChange(next)
            }}
            className={`${input} mt-0 flex-1`}
            aria-label={keyLabel}
          />
          <NumberField
            value={v}
            onChange={(n) => {
              const next = [...rows]
              next[i] = [k, n]
              onChange(next)
            }}
            className="w-28"
            label="Daily ceiling in USD"
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-foreground/40 hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Remove"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, ['', 0]])}
        className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 px-3 py-1.5 text-xs font-semibold text-foreground/60 hover:text-foreground"
      >
        <Plus size={12} /> Add
      </button>
    </div>
  )
}

export default function SpendPermissions({ agentId }: { agentId: string }) {
  const [policy, setPolicy] = useState<ActionPolicy | null>(null)
  const [allowText, setAllowText] = useState('')
  const [denyText, setDenyText] = useState('')
  const [categoryDeny, setCategoryDeny] = useState<string[]>([])
  const [catRows, setCatRows] = useState<[string, number][]>([])
  const [cardRows, setCardRows] = useState<[string, number][]>([])
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
      const j = (await res.json()) as { policy: ActionPolicy }
      if (!isActive()) return
      const sp = j.policy.spend
      setPolicy(j.policy)
      setAllowText(listToText(sp?.merchantAllow ?? []))
      setDenyText(listToText(sp?.merchantDeny ?? []))
      setCategoryDeny(sp?.categoryDeny ?? [])
      setCatRows(Object.entries(sp?.categoryLimits ?? {}))
      setCardRows(Object.entries(sp?.cardCaps ?? {}))
      setError(null)
    } catch {
      if (isActive()) setError('Could not load the spend policy.')
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

  const toMap = (rows: [string, number][]) =>
    Object.fromEntries(rows.filter(([k]) => k.trim()).map(([k, v]) => [k.trim().toLowerCase(), v]))

  const save = async () => {
    if (!agentId) return
    setSaving(true)
    setSaved(false)
    try {
      const res = await apiFetch('/api/agents/action-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          agentId,
          policy: {
            spend: {
              merchantAllow: textToList(allowText),
              merchantDeny: textToList(denyText),
              categoryDeny,
              categoryLimits: toMap(catRows),
              cardCaps: toMap(cardRows),
            },
          },
        }),
        onWaking: () => setError('Waking up the backend (free tier)...'),
      })
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
            <Skeleton className="h-11 w-full" />
          </section>
        ))}
      </div>
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

      {/* What we add versus what the card already does. Saying this plainly is the honest
          alternative to shipping a second copy of the venue's own limit. */}
      <section className="rounded-2xl border border-foreground/10 bg-card p-6">
        <div className="mb-2 flex items-center gap-2">
          <CreditCard size={16} className="text-foreground/40" />
          <h3 className="font-semibold text-foreground">Card spending</h3>
          <span className="rounded-md bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-semibold text-foreground/60">
            v{policy?.version ?? 1}
          </span>
        </div>
        <p className="text-xs text-foreground/55">
          Your card issuer already has one spending limit, a monthly cap and an approve-everything toggle. We do not
          duplicate those. This decides <strong>where</strong> and <strong>on what</strong> the money may go, and gives
          you a refusal that comes with a reason and a record.
        </p>
        <p className={hint}>
          The caps and the approval line on the Trading tab are shared: they apply to card purchases too, since they sit
          on the same policy.
        </p>
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-3 text-[11px] text-foreground/60">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-500" />
          <span>
            Worth knowing on this surface: a card agent is given the virtual card details, and a purchase happens at the
            merchant, not through an API we sit in front of. These limits are load-bearing when your agent asks us
            first, and they cannot physically stop one that already holds the card. Keep your issuer&apos;s
            approve-each-purchase setting on alongside this, not instead of it.
          </span>
        </p>
      </section>

      {/* Merchants */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-4 font-semibold text-foreground">Merchants</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={label}>Allow list</label>
            <input
              type="text"
              value={allowText}
              onChange={(e) => setAllowText(e.target.value)}
              placeholder="whole foods, uber"
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
              placeholder="casino, steam"
              className={input}
            />
            <p className={hint}>Always wins over the allow list.</p>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-foreground/45">
          Matched as a case-insensitive substring, because card networks report messy names. &quot;amzn&quot; catches
          &quot;AMZN Mktp US*2H4B1&quot;, which an exact match would miss.
        </p>
      </section>

      {/* High-risk categories */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-1 font-semibold text-foreground">Never on an agent card</h3>
        <p className="mb-4 text-[11px] text-foreground/45">
          On by default. These turn a spending mistake into one you cannot claw back, so they start refused. Turning one
          off is your call, and it should be a deliberate one.
        </p>
        {HIGH_RISK.map((c) => {
          const on = categoryDeny.includes(c)
          return (
            <div key={c} className="flex items-center justify-between border-b border-foreground/[0.07] py-3 last:border-0">
              <div className="text-sm text-foreground">{HIGH_RISK_COPY[c]}</div>
              <button
                type="button"
                onClick={() => setCategoryDeny(on ? categoryDeny.filter((x) => x !== c) : [...categoryDeny, c])}
                className={`h-6 w-11 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-foreground/15'}`}
                aria-pressed={on}
                aria-label={`Refuse ${c}`}
              >
                <span
                  className={`block h-5 w-5 rounded-full bg-white transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-0.5'}`}
                />
              </button>
            </div>
          )
        })}
      </section>

      {/* Category ceilings */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-1 font-semibold text-foreground">Daily ceiling per category</h3>
        <p className="mb-4 text-[11px] text-foreground/45">
          Categories come from the card network&apos;s merchant code when one reaches us. Robinhood&apos;s card surface
          does not document sending it, so in practice the category usually comes from the label your caller supplies.
          Anything without one lands in <span className="font-mono">uncategorized</span>, which you can put a ceiling on
          like any other, so the unknown case is limitable rather than exempt.
        </p>
        <UsdMapEditor
          rows={catRows}
          onChange={setCatRows}
          keyPlaceholder="groceries"
          keyLabel="Category"
        />
      </section>

      {/* Card ceilings */}
      <section className="mt-4 rounded-2xl border border-foreground/10 bg-card p-6">
        <h3 className="mb-1 font-semibold text-foreground">Daily ceiling per card</h3>
        <p className="mb-4 text-[11px] text-foreground/45">
          Agents get their own virtual card, so this is the ceiling that matches how the cards are actually handed out.
          A card with no entry here has no per-card ceiling of ours.
        </p>
        <UsdMapEditor rows={cardRows} onChange={setCardRows} keyPlaceholder="card_agent_1" keyLabel="Card id" />
      </section>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
        >
          {saved ? <Check size={16} /> : <Save size={16} />}
          {saving ? 'Saving...' : saved ? 'Saved' : 'Save spend limits'}
        </button>
        <span className="text-xs text-foreground/45">Applies to the next purchase immediately.</span>
      </div>

      <p className="mt-4 flex items-start gap-2 text-[11px] text-foreground/40">
        <ShieldCheck size={13} className="mt-0.5 shrink-0" />
        <span>
          A-Identity does not make purchases and never holds your card details. It answers whether an intended purchase
          breaks a limit you set. Not investment advice.
        </span>
      </p>
    </div>
  )
}

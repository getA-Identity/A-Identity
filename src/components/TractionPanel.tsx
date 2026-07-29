/**
 * The public traction panel (Phase 5.5).
 *
 * Everything shown here is measured, aggregate and free of anything that identifies an agent,
 * an owner, a holding or an individual amount. That is what makes it publishable.
 *
 * The headline is `protectedNotionalUsd`: USD of intended action the policy actually refused.
 * It is deliberately labeled as protected value and NOT as revenue, because conflating the
 * two would be the easiest and most dishonest number to inflate in this whole product.
 *
 * Renders nothing at all when there is no activity yet, rather than a row of zeroes dressed
 * up as a dashboard.
 */
import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldAlert } from 'lucide-react'
import { apiFetch } from '../lib/api'

type Traction = {
  activeAgents: number
  registeredAgents: number
  checks: number
  allow: number
  warn: number
  deny: number
  overrideAttempts: number
  protectedNotionalUsd: number
  bySurface: Record<string, number>
  ci: { agents: number; checks: number }
  disclosure: string[]
}

type Status = { enforcing: boolean; vectors: { pass: boolean }[] }

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0)

export default function TractionPanel() {
  const [t, setT] = useState<Traction | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const [tr, st] = await Promise.all([apiFetch('/api/traction'), apiFetch('/api/guardrail-status')])
        if (!active) return
        if (tr.ok) setT((await tr.json()) as Traction)
        // The status endpoint answers 503 when the engine is NOT enforcing, and that body is
        // the interesting one, so it is read either way.
        setStatus((await st.json()) as Status)
      } catch {
        // A public panel that cannot load is simply not shown. No error banner on a
        // marketing surface for something nobody asked for.
      }
    })()
    return () => {
      active = false
    }
  }, [])

  if (!t || t.checks === 0) return null

  const surfaces = Object.entries(t.bySurface).filter(([, n]) => n > 0)

  return (
    <div className="mt-12">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-foreground/70">Guardrails at work</h2>
        <span className="font-mono text-[11px] text-foreground/40">measured, not projected</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="grid gap-px bg-border sm:grid-cols-4">
          {[
            ['Value stopped', usd(t.protectedNotionalUsd), 'action the policy refused'],
            ['Decisions', t.checks.toLocaleString('en-US'), `${t.activeAgents} active agent${t.activeAgents === 1 ? '' : 's'}`],
            ['Needed a human', `${pct(t.warn, t.checks)}%`, `${t.warn.toLocaleString('en-US')} paused for approval`],
            ['Stopped', `${pct(t.deny, t.checks)}%`, `${t.deny.toLocaleString('en-US')} refused`],
          ].map(([k, v, sub]) => (
            <div key={k} className="bg-card p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">{k}</div>
              <div className="mt-1 font-mono text-xl tabular-nums text-foreground">{v}</div>
              <div className="mt-0.5 text-[11px] text-foreground/40">{sub}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-[11px] text-foreground/45">
          {status && (
            <span className="inline-flex items-center gap-1.5 font-semibold">
              {status.enforcing ? (
                <>
                  <ShieldCheck size={13} className="text-emerald-600" />
                  <span className="text-emerald-600">enforcing now</span>
                </>
              ) : (
                <>
                  <ShieldAlert size={13} className="text-red-500" />
                  <span className="text-red-500">not enforcing</span>
                </>
              )}
              <span className="font-normal text-foreground/35">
                ({status.vectors.filter((v) => v.pass).length}/{status.vectors.length} live checks)
              </span>
            </span>
          )}
          {surfaces.length > 0 && (
            <span>
              by surface:{' '}
              {surfaces.map(([s, n], i) => (
                <span key={s}>
                  {i > 0 && ', '}
                  <span className="font-mono">{s}</span> {n.toLocaleString('en-US')}
                </span>
              ))}
            </span>
          )}
          {t.overrideAttempts > 0 && (
            <span className="text-amber-600">
              {t.overrideAttempts} refused attempt{t.overrideAttempts === 1 ? '' : 's'} to overwrite a refusal
            </span>
          )}
        </div>

        <div className="border-t border-border px-4 py-3 text-[11px] leading-relaxed text-foreground/35">
          Value stopped is USD of intended action the policy refused. It is protected value, not revenue. Aggregate
          only: nothing here identifies an agent, an owner, a holding or an individual amount.
          {t.ci.checks > 0 && ` Monitoring activity (${t.ci.checks} canary checks) is excluded from every number above.`}
        </div>
      </div>
    </div>
  )
}

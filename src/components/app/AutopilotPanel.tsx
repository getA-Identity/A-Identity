import { useEffect, useState } from 'react'
import { Bot, CheckCircle2, Loader2, Hand, Coins } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { Button } from '../ui/button'
import { authHeaders } from '../../store/auth'
import { Panel } from '../ui/panel'

type Payment = { n: number; amountUsd: number; cumulativeUsd: number; ok: boolean; transaction?: string; reason?: string }
type Result =
  | { executed: false; reason: string }
  | {
      executed: true
      service: string
      treasury: string
      feeBps: number
      budgetUsd: number
      amountUsd: number
      payments: Payment[]
      settledCount: number
      volumeUsd: number
      stoppedReason: 'budget-reached' | 'max-calls' | 'settlement-error'
      pausedForHuman: boolean
      protocolFee: { accruedUsd: number; settled: boolean; transaction?: string; note?: string }
    }

/**
 * Autonomous agent run. A human sets a budget once; the agent then pays a service on
 * its OWN, a burst of real gasless nanopayments (pay-per-inference / streaming),
 * and stops itself when the next payment would breach the budget (bounded authority,
 * live). Each settlement accrues a protocol fee routed to the treasury. Hits
 * POST /api/arc/agent-run.
 *
 * The payments settle server-side in one batch; we then reveal them one-by-one on
 * screen so the run reads as a live sequence of real transactions, played back in
 * order, ending on the self-stop moment. Respects prefers-reduced-motion.
 */
export default function AutopilotPanel() {
  const [budget, setBudget] = useState('0.02')
  const [amount, setAmount] = useState('0.005')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(0)

  // Reveal the (real, already-settled) payments one at a time so the run is filmable
  // as a live sequence. The self-stop banner + fee unlock only after the last payment.
  useEffect(() => {
    if (!result || result.executed !== true) {
      setRevealed(0)
      return
    }
    const n = result.payments.length
    const reduce =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduce || n === 0) {
      setRevealed(n)
      return
    }
    let i = 0
    setRevealed(0)
    const id = window.setInterval(() => {
      i += 1
      setRevealed(i)
      if (i >= n) window.clearInterval(id)
    }, 800)
    return () => window.clearInterval(id)
  }, [result])

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/agent-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ amountUsd: Number(amount) || 0.005, budgetUsd: Number(budget) || 0.02, maxCalls: 6 }),
        timeoutMs: 180_000, // a burst of gasless nanopayments
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to run the agent (guests are read-only).')
        return
      }
      setResult((await res.json()) as Result)
    } catch {
      setError('Could not run the agent (the backend may be waking up, try again).')
    } finally {
      setBusy(false)
    }
  }

  const short = (a?: string) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-')

  const executed = result?.executed === true ? result : null
  const revealing = executed ? revealed < executed.payments.length : false
  const allRevealed = executed ? revealed >= executed.payments.length : false
  // Cumulative spend through the payments revealed so far, and its share of the budget,
  // so the bar fills live as each payment appears and pins near the line at the stop.
  const revealedPayments = executed ? executed.payments.slice(0, revealed) : []
  const spent = revealedPayments.length ? revealedPayments[revealedPayments.length - 1].cumulativeUsd : 0
  const budgetPct = executed && executed.budgetUsd > 0 ? Math.min(100, (spent / executed.budgetUsd) * 100) : 0

  return (
<Panel tone="accent" className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
          <Bot size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Autonomous agent run</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            Set a budget once, then the agent runs <b>on its own</b>: a burst of real gasless
            nanopayments to a service (pay-per-inference), stopping <b>itself</b> the moment the
            next payment would breach your budget. A protocol fee is routed to the treasury on each run.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Budget (agent stops itself here)" value={budget} onChange={setBudget} step="0.005" />
        <Field label="Per call" value={amount} onChange={setAmount} step="0.001" />
        <Button type="button" size="sm" className="text-sm" onClick={run} disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Bot size={15} />}
          {busy ? 'Agent running' : 'Run the agent'}
        </Button>
      </div>

      {busy && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent/[0.04] p-3 text-sm text-foreground/60">
          <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
          <span>The agent is paying autonomously on Arc. Real gasless nanopayments settle in a batch.</span>
        </div>
      )}

      {error && <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-3 text-sm text-foreground/70">{error}</div>}

      {result && result.executed === false && (
        <div className="mt-4 rounded-xl border border-foreground/10 bg-background/40 p-3 text-sm text-foreground/70">
          Prepared (no signer configured on the server): {result.reason}
        </div>
      )}

      {executed && (
        <div className="mt-4 space-y-2 text-sm">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground/45">
            {revealing ? (
              <>
                <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
                <span>Agent paying {short(executed.service)} autonomously ({revealed}/{executed.payments.length})</span>
              </>
            ) : (
              <span>
                Agent paid {short(executed.service)} autonomously · {executed.settledCount} payments · volume{' '}
                {executed.volumeUsd} USDC
              </span>
            )}
          </div>

          {/* Live budget bar: fills as payments reveal, turns amber at the self-stop line. */}
          <div>
            <div className="flex items-center justify-between text-[11px] text-foreground/50">
              <span>Budget ${executed.budgetUsd.toFixed(3)}</span>
              <span>spent ${spent.toFixed(3)}</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-foreground/8">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  allRevealed && executed.pausedForHuman ? 'bg-amber-500' : 'bg-accent'
                }`}
                style={{ width: `${budgetPct}%` }}
              />
            </div>
          </div>

          {executed.payments.slice(0, revealed).map((p) => (
            <div
              key={p.n}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                p.ok ? 'border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-red-200 dark:border-red-500/25 bg-red-50/60 dark:bg-red-500/10'
              } motion-safe:animate-[fadeIn_0.35s_ease-out]`}
            >
              {p.ok ? (
                <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
              ) : (
                <span className="shrink-0 text-red-500">✕</span>
              )}
              <span className="text-foreground/75">
                Payment #{p.n}: ${p.amountUsd.toFixed(3)}
              </span>
              <span className="text-xs text-foreground/45">cumulative ${p.cumulativeUsd.toFixed(3)}</span>
              {p.transaction && <span className="ml-auto font-mono text-[10px] text-foreground/40">batch {p.transaction.slice(0, 8)}...</span>}
              {p.reason && <span className="ml-auto text-[11px] text-red-600">{p.reason}</span>}
            </div>
          ))}

          {revealing && (
            <div className="flex items-center gap-2 rounded-lg border border-dashed border-foreground/15 px-3 py-2 text-foreground/40">
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-accent" />
              <span className="text-xs">agent deciding whether the next payment fits the budget</span>
            </div>
          )}

          {allRevealed && executed.pausedForHuman && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10 px-3 py-2 text-amber-800 dark:text-amber-300 motion-safe:animate-[fadeIn_0.4s_ease-out]">
              <Hand size={14} className="shrink-0" />
              <span>
                <b>Bounded authority:</b> the agent hit your ${executed.budgetUsd} budget and stopped itself.
                Further spend now needs a human.
              </span>
            </div>
          )}

          {allRevealed && (
            <div className="flex items-center gap-2 rounded-lg border border-[#2775CA]/25 bg-[#2775CA]/[0.05] px-3 py-2 text-foreground/75 motion-safe:animate-[fadeIn_0.4s_ease-out]">
              <Coins size={14} className="shrink-0 text-[#2775CA]" />
              <span>
                Protocol fee <b>{executed.protocolFee.accruedUsd} USDC</b> ({executed.feeBps} bps) →{' '}
                {short(executed.treasury)}
                {executed.protocolFee.settled
                  ? ', settled'
                  : executed.protocolFee.note
                    ? `, ${executed.protocolFee.note}`
                    : ''}
              </span>
              {executed.protocolFee.settled && executed.protocolFee.transaction && (
                <span className="ml-auto font-mono text-[10px] text-foreground/40">batch {executed.protocolFee.transaction.slice(0, 8)}...</span>
              )}
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

function Field({ label, value, onChange, step }: { label: string; value: string; onChange: (v: string) => void; step: string }) {
  return (
    <div>
      <label className="text-xs font-semibold text-foreground/50">{label}</label>
      <div className="mt-1 flex items-center gap-1 rounded-xl border border-foreground/10 bg-card px-3 py-2">
        <span className="text-sm text-foreground/50">$</span>
        <input
          type="number"
          min="0"
          step={step}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 bg-transparent text-sm outline-none"
        />
        <span className="text-xs font-semibold text-accent">USDC</span>
      </div>
    </div>
  )
}

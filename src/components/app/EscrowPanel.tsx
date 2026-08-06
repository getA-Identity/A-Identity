import { useState } from 'react'
import { Boxes, CheckCircle2, ExternalLink, Loader2, ArrowRight, RotateCcw } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { authHeaders } from '../../store/auth'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Panel } from '../ui/panel'

type Outcome = 'complete' | 'refund'
type Step = { step: string; txHash: string; explorerUrl: string }
type Result =
  | { executed: false; reason: string; lifecycle: string[]; outcome: Outcome }
  | {
      executed: true
      jobId: string
      budgetUsd: number
      outcome: Outcome
      steps: Step[]
      status: string
      refundedUsd?: number
      failedAt?: string
      reason?: string
    }

const LIFECYCLE: Record<Outcome, string[]> = {
  complete: ['createJob', 'setBudget', 'approve(USDC)', 'fund', 'submit', 'complete'],
  refund: ['createJob', 'setBudget', 'approve(USDC)', 'fund', 'submit', 'reject'],
}

/**
 * One-click ERC-8183 escrow demo: an agent hires an agent, USDC is escrowed on Arc.
 * The happy path releases it to the provider on delivery (complete); the dispute path
 * rejects the deliverable and refunds the client in the same tx (refund), buyer
 * protection for trust-minimized agent commerce. Both are real on-chain lifecycles.
 */
export default function EscrowPanel() {
  const [budget, setBudget] = useState('0.02')
  const [busy, setBusy] = useState<Outcome | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (outcome: Outcome) => {
    setBusy(outcome)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/job-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ budgetUsd: Number(budget) || 0.02, outcome }),
        timeoutMs: 150_000, // 6 real on-chain txs back-to-back
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to run a real escrow job (guests are read-only).')
        return
      }
      setResult((await res.json()) as Result)
    } catch {
      setError('Could not run the escrow job (the backend may be waking up, try again).')
    } finally {
      setBusy(null)
    }
  }

  const outcome: Outcome = result?.outcome ?? 'complete'
  const refunded = result?.executed && result.outcome === 'refund'
  const okOutcome =
    result?.executed && !result.failedAt && (refunded ? result.status === 'Rejected' : result.status === 'Completed')

  return (
<Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <Boxes size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Agent-to-agent escrow (ERC-8183)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            One click runs the full on-chain job: an agent hires an agent, USDC is held in escrow on
            Arc. <span className="font-medium text-foreground/70">Released to the provider on delivery</span>, or,
            if the deliverable is disputed, <span className="font-medium text-foreground/70">refunded to the client</span> in
            the same tx (buyer protection). Both are real lifecycles.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-foreground/50">Budget</label>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-background/40 px-3 py-2">
          <span className="text-sm text-foreground/50">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-20 bg-transparent text-sm outline-none"
          />
          <span className="text-xs font-semibold text-usdc">USDC</span>
        </div>
        <Button type="button" variant="inverse" size="sm" className="text-sm" onClick={() => run('complete')} disabled={!!busy}>
          {busy === 'complete' ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
          {busy === 'complete' ? 'Running lifecycle' : 'Run escrow job'}
        </Button>
        <Button type="button" variant="outline" size="sm" className="text-sm" onClick={() => run('refund')} disabled={!!busy}>
          {busy === 'refund' ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
          {busy === 'refund' ? 'Running dispute' : 'Dispute & refund'}
        </Button>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-sm text-foreground/70 dark:border-amber-500/25 dark:bg-amber-500/10">{error}</div>
      )}

      {result && result.executed === false && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3 text-sm text-foreground/70">
          Prepared (no signer configured on the server): {result.reason}
        </div>
      )}

      {result && result.executed && (
        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-foreground/60">
              Job <span className="font-mono font-semibold text-foreground">#{result.jobId}</span> · ${result.budgetUsd} USDC
            </span>
            <Badge variant={okOutcome ? 'success' : 'warning'}>
              {okOutcome && <CheckCircle2 size={12} />}
              {result.status}
            </Badge>
            {refunded && okOutcome && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-bold text-emerald-700 dark:text-emerald-300">
                <RotateCcw size={11} /> Refunded ${result.refundedUsd ?? result.budgetUsd} to client
              </span>
            )}
          </div>

          <ol className="mt-3 flex flex-col gap-1.5">
            {LIFECYCLE[outcome].map((name) => {
              const s = result.steps.find((x) => x.step === name)
              const failedHere = result.failedAt === name
              const isDispute = name === 'reject'
              return (
                <li
                  key={name}
                  className="flex items-center gap-3 rounded-lg border border-foreground/8 bg-background/40 px-3 py-2 text-sm"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      s ? (isDispute ? 'bg-amber-500' : 'bg-emerald-500') : failedHere ? 'bg-red-500' : 'bg-foreground/20'
                    }`}
                  />
                  <span className="font-mono text-xs text-foreground/70">{name}</span>
                  <span className="ml-auto">
                    {s ? (
                      <a
                        href={s.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-accent hover:underline"
                      >
                        tx <ExternalLink size={9} />
                      </a>
                    ) : failedHere ? (
                      <span className="text-[11px] font-semibold text-red-500">reverted</span>
                    ) : (
                      <span className="text-[11px] text-foreground/30">-</span>
                    )}
                  </span>
                </li>
              )
            })}
          </ol>
          {result.failedAt && (
            <p className="mt-2 text-xs text-red-600">Reverted at {result.failedAt}: {result.reason}</p>
          )}
        </div>
      )}
    </Panel>
  )
}

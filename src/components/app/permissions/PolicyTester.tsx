import { useState } from 'react'
import { AlertTriangle, Check, PlayCircle } from 'lucide-react'
import { apiFetch, readJson, explainError } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'

/** Fire a real instruction through the policy engine and show the verdict. */
export default function PolicyTester({ agentId, onSpent }: { agentId: string; onSpent: () => void }) {
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
            className="mt-1 w-28 rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <div className="flex-1">
          <label className="text-[11px] font-semibold text-foreground/50">Payee</label>
          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent"
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
              ? 'border-ok/25 bg-ok/10 text-ok'
              : pending
                ? 'border-warn/25 bg-warn/10 text-warn'
                : 'border-danger/25 bg-danger/10 text-danger'
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

import { useState } from 'react'
import { Layers, CheckCircle2, ExternalLink, Loader2, ArrowRight } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { authHeaders } from '../../store/auth'
import { Button } from '../ui/button'
import { Panel } from '../ui/panel'

type Result =
  | { executed: false; reason: string; reverted?: boolean }
  | { executed: true; txHash: string; explorerUrl: string; count: number; totalUsd: number }

/**
 * Batched settlement via Arc's Multicall3From: settle many USDC transfers atomically in one
 * Arc tx, the EOA preserved as msg.sender for each (one Transfer per payment). Demonstrates
 * Arc-native batching for high-frequency agent payments. Hits POST /api/arc/batch-demo.
 */
export default function BatchPanel() {
  const [count, setCount] = useState('3')
  const [amount, setAmount] = useState('0.01')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/batch-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ count: Number(count) || 3, amountUsd: Number(amount) || 0.01 }),
        timeoutMs: 120_000,
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to run a real batch (guests are read-only).')
        return
      }
      setResult((await res.json()) as Result)
    } catch {
      setError('Could not run the batch (the backend may be waking up, try again).')
    } finally {
      setBusy(false)
    }
  }

  return (
<Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#2775CA]/10 text-[#2775CA]">
          <Layers size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Batched settlement (Multicall3From)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            Settle many USDC payments <b>atomically in one Arc transaction</b> via the Multicall3From
            precompile. Each transfer keeps your wallet as the sender (one on-chain <code className="rounded bg-foreground/5 px-1">Transfer</code> per
            payment), so an agent can pay a whole burst in a single tx, all-or-nothing.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground/50">
          Payments
          <input type="number" min="1" max="5" step="1" value={count} onChange={(e) => setCount(e.target.value)} className="w-20 rounded-xl border border-foreground/10 bg-background/40 px-3 py-2 text-sm outline-none" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground/50">
          Each
          <div className="flex items-center gap-1 rounded-xl border border-foreground/10 bg-background/40 px-3 py-2">
            <span className="text-sm text-foreground/50">$</span>
            <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-16 bg-transparent text-sm outline-none" />
            <span className="text-xs font-semibold text-[#2775CA]">USDC</span>
          </div>
        </label>
        <Button type="button" size="sm" className="text-sm" onClick={run} disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
          {busy ? 'Batching on Arc…' : 'Settle batch in one tx'}
        </Button>
      </div>

      {error && <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-3 text-sm text-foreground/70">{error}</div>}

      {result && result.executed === false && (
        <div className="mt-4 rounded-xl border border-foreground/10 bg-background/40 p-3 text-sm text-foreground/70">
          {result.reverted ? `Batch reverted on-chain: ${result.reason}` : `Prepared (no signer configured on the server): ${result.reason}`}
        </div>
      )}

      {result && result.executed && (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10 px-3 py-2 text-sm">
          <CheckCircle2 size={14} className="shrink-0 text-emerald-600" />
          <span className="text-foreground/75">
            <b>{result.count}</b> USDC payments (${result.totalUsd}) settled <b>atomically in one Arc tx</b>, wallet preserved as sender
          </span>
          <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline">
            View on arcscan <ExternalLink size={11} />
          </a>
        </div>
      )}
    </Panel>
  )
}

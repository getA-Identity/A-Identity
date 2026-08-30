import { useState } from 'react'
import { ArrowLeftRight, CheckCircle2, ExternalLink, Loader2, Flame } from 'lucide-react'
import { apiFetch } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'
import { Panel } from '../../ui/panel'

type Step = { name: string; state: string; txHash?: string; explorerUrl?: string }
type Result =
  | { executed: false; reason: string; route: string }
  | { executed: true; amountUsd: number; route: string; state: string; steps: Step[]; reason?: string }

/**
 * Circle CCTP: native USDC cross-chain via burn-and-mint (Bridge Kit / CCTPv2). One
 * click burns USDC on Arc and mints it natively on Base Sepolia, never wrapped. This
 * is the canonical bridge, distinct from Gateway's unified-balance Forwarding Service.
 * Hits POST /api/arc/cctp-demo.
 */
export default function CctpPanel() {
  const [amount, setAmount] = useState('1')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/cctp-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ amountUsd: Number(amount) || 1 }),
        timeoutMs: 180_000,
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to bridge real USDC (guests are read-only).')
        return
      }
      setResult((await res.json()) as Result)
    } catch {
      setError('Could not run the CCTP bridge (attestation can take a bit, try again).')
    } finally {
      setBusy(false)
    }
  }

  const minted = result?.executed && result.steps.some((s) => s.name.toLowerCase().includes('mint') && s.state === 'success')

  return (
<Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-usdc/10 text-usdc">
          <ArrowLeftRight size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Native USDC bridge (Circle CCTP)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            The canonical cross-chain rail: USDC is <b>burned on Arc and minted natively on Base Sepolia</b>,
            never wrapped. Distinct from Gateway's unified-balance forwarding; this is CCTPv2 burn-and-mint.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-foreground/50">Amount</label>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-background/40 px-3 py-2">
          <span className="text-sm text-foreground/50">$</span>
          <input
            type="number"
            min="1"
            step="0.5"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-20 bg-transparent text-sm outline-none"
          />
          <span className="text-xs font-semibold text-usdc">USDC</span>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full bg-usdc px-4 py-2 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
        >
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Flame size={15} />}
          {busy ? 'Burning & minting' : 'Bridge USDC (CCTP)'}
        </button>
        <span className="text-[11px] text-foreground/40">min 1 USDC (CCTPv2 fee)</span>
      </div>

      {error && <div className="mt-4 rounded-xl border border-warn/35 bg-warn/[0.08] p-3 text-sm text-foreground/70">{error}</div>}

      {result && result.executed === false && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3 text-sm text-foreground/70">
          Prepared (no signer configured on the server): {result.reason}
        </div>
      )}

      {result && result.executed && (
        <div className="mt-4 space-y-2 text-sm">
          <div className="text-xs font-semibold text-foreground/45">
            {result.route} · {result.amountUsd} USDC · <span className="text-foreground/60">{result.state}</span>
          </div>
          {result.steps.length === 0 && (
            <div className="rounded-lg border border-foreground/8 bg-background/40 px-3 py-2 text-foreground/60">
              Bridge submitted, awaiting step confirmations.
            </div>
          )}
          {result.steps.map((s, i) => (
            <div
              key={`${s.name}-${i}`}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                s.state === 'success' ? 'border-ok/30 bg-ok/[0.08]' : 'border-foreground/8 bg-background/40'
              }`}
            >
              {s.state === 'success' ? (
                <CheckCircle2 size={13} className="shrink-0 text-ok" />
              ) : (
                <Loader2 size={13} className="shrink-0 animate-spin text-foreground/40" />
              )}
              <span className="capitalize text-foreground/75">{s.name}</span>
              <span className="text-xs text-foreground/45">{s.state}</span>
              {s.explorerUrl && (
                <a
                  href={s.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-accent hover:underline"
                >
                  explorer <ExternalLink size={9} />
                </a>
              )}
            </div>
          ))}
          {minted && (
            <div className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok/[0.08] px-3 py-2 text-ok">
              <Flame size={14} /> <span>Minted natively on Base Sepolia, burn-and-mint complete.</span>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

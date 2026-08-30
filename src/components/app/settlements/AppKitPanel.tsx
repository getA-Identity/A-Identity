import { useEffect, useState } from 'react'
import { ArrowRightLeft, CheckCircle2, ExternalLink, Loader2, Repeat } from 'lucide-react'
import { apiFetch } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'
import { Panel } from '../../ui/panel'

type Capability = { name: string; supported: boolean; note?: string }
type Caps = {
  chain: string
  chainId: number
  capabilities: Capability[]
  tokens: { usdc?: string | null; eurc?: string | null }
  swapTestnetsSupported: string[]
  explorerUrl?: string
}
type SwapResult = {
  executed: boolean
  route: string
  amountUsd: number
  tokenIn: string
  tokenOut: string
  txHash?: string
  explorerUrl?: string
  state?: string
  reason?: string
}

/**
 * Circle App Kit on Arc: Send, Bridge, Swap and Unified Balance in one SDK, with the
 * swap actually run here.
 *
 * The reason this panel exists rather than a paragraph: App Kit supports swap on exactly
 * one testnet, and it is Arc. The capability strip below is read from the SDK's own chain
 * table at request time (GET /api/arc/appkit), so the claim is computed, not typed by us.
 * The button then swaps real USDC for EURC on Arc through the same kit.
 */
export default function AppKitPanel() {
  const [caps, setCaps] = useState<Caps | null>(null)
  const [amount, setAmount] = useState('1')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SwapResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    apiFetch('/api/arc/appkit')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && d && setCaps(d as Caps))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/appkit-swap-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ amountUsd: Number(amount) || 1 }),
        timeoutMs: 180_000,
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to run a real swap (guests are read-only).')
        return
      }
      setResult((await res.json()) as SwapResult)
    } catch {
      setError('Could not run the App Kit swap. The route can be busy; try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const onlyArc = caps?.swapTestnetsSupported.length === 1 && caps.swapTestnetsSupported[0] === 'Arc_Testnet'

  return (
    <Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-usdc/10 text-usdc">
          <ArrowRightLeft size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Send, Bridge, Swap (Circle App Kit)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            One SDK for the money movements an agent needs. The strip below is read from App Kit's own
            chain table when this loads, so it says what the SDK says.
            {onlyArc && (
              <>
                {' '}
                <b>Arc Testnet is the only testnet App Kit can swap on</b>, which is why the swap
                below exists here and nowhere else.
              </>
            )}
          </p>
        </div>
      </div>

      {/* Capability strip, live from the SDK. */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {(caps?.capabilities ?? []).map((c) => (
          <div
            key={c.name}
            className="rounded-xl border border-border bg-background/40 px-3 py-2.5"
            title={c.note}
          >
            <div className="flex items-center gap-1.5">
              {c.supported ? (
                <CheckCircle2 size={13} className="shrink-0 text-ok" />
              ) : (
                <span className="h-2 w-2 shrink-0 rounded-full bg-foreground/20" />
              )}
              <span className="text-sm font-semibold text-foreground">{c.name}</span>
            </div>
            {c.note && <p className="mt-1 text-[11px] leading-relaxed text-foreground/45">{c.note}</p>}
          </div>
        ))}
        {!caps && (
          <div className="col-span-full rounded-xl border border-border bg-background/40 px-3 py-2.5 text-sm text-foreground/45">
            Reading App Kit's supported chains…
          </div>
        )}
      </div>

      {caps?.tokens?.eurc && (
        <p className="mt-3 font-mono text-[11px] text-foreground/40">
          USDC {caps.tokens.usdc?.slice(0, 10)}… · EURC {caps.tokens.eurc.slice(0, 10)}… · chain{' '}
          {caps.chainId}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-foreground/50">Amount</label>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-background/40 px-3 py-2">
          <span className="text-sm text-foreground/50">$</span>
          <input
            type="number"
            min="0.01"
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
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Repeat size={15} />}
          {busy ? 'Swapping' : 'Swap USDC -> EURC on Arc'}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-xl border border-warn/35 bg-warn/[0.08] p-3 text-sm text-foreground/80">
          {error}
        </div>
      )}

      {result && !result.executed && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3 text-sm text-foreground/70">
          Prepared: {result.reason}
        </div>
      )}

      {result?.executed && (
        <div className="mt-4 rounded-xl border border-ok/30 bg-ok/[0.08] p-3 text-sm">
          <div className="flex items-center gap-2 text-foreground/75">
            <CheckCircle2 size={14} className="shrink-0 text-ok" />
            {result.route} · {result.amountUsd} {result.tokenIn} · {result.state}
          </div>
          {result.explorerUrl && (
            <a
              href={result.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-accent hover:underline"
            >
              {result.txHash?.slice(0, 14)}… <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}
    </Panel>
  )
}

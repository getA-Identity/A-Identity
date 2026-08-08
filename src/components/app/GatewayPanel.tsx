import { useState } from 'react'
import { Globe, ExternalLink, Loader2, ArrowRight, Zap } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { Button } from '../ui/button'
import { authHeaders } from '../../store/auth'
import { DataRow } from '../ui/data-row'
import BrandArt from './BrandArt'
import { Panel } from '../ui/panel'

type Result =
  | { executed: false; reason: string; gatewayWallet: string }
  | {
      executed: true
      recipient: string
      amountUsd: number
      unifiedBalanceUsd: number
      deposit: { amountUsd: number; depositTx?: string; explorerUrl?: string } | null
      transfer: { transferId?: string; maxFeeUsd?: number; forwardingFee?: string; destination?: string; error?: string }
      baseMint: { minted: boolean; beforeUsd: number | null; afterUsd: number | null; explorerUrl: string } | null
    }

/**
 * Circle Gateway: a chain-abstracted USDC balance. One click deposits (if needed) and
 * moves USDC from Arc to Base Sepolia via the Forwarding Service, minted on Base in
 * <500 ms, gaslessly (no wallet or gas needed there). Hits POST /api/arc/gateway-demo.
 */
export default function GatewayPanel() {
  const [amount, setAmount] = useState('0.1')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/gateway-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ amountUsd: Number(amount) || 0.1 }),
        timeoutMs: 120_000,
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to move real USDC (guests are read-only).')
        return
      }
      setResult((await res.json()) as Result)
    } catch {
      setError('Could not run the Gateway transfer (the backend may be waking up, try again).')
    } finally {
      setBusy(false)
    }
  }

  const minted = result?.executed && result.baseMint?.minted

  return (
<Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-ok/10 text-ok">
          <Globe size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Chain-abstracted USDC (Circle Gateway)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            Your agent's USDC isn't stuck on one chain. One click moves it from Arc to Base Sepolia
            via Circle Gateway, minted on Base in under 500 ms, <b>gaslessly</b> (no wallet or gas there).
          </p>
        </div>
        {/* Spheres joined by violet orbits: one balance, many chains. */}
        <BrandArt src="/art/art-orbits.webp" className="hidden h-20 w-24 shrink-0 sm:block" />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-foreground/50">Amount</label>
        <div className="flex items-center gap-1 rounded-xl border border-border bg-background/40 px-3 py-2">
          <span className="text-sm text-foreground/50">$</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-20 bg-transparent text-sm outline-none"
          />
          <span className="text-xs font-semibold text-usdc">USDC</span>
        </div>
        <Button type="button" variant="inverse" size="sm" className="text-sm" onClick={run} disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
          {busy ? 'Moving Arc to Base' : 'Send USDC to Base (gasless)'}
        </Button>
      </div>

      {error && <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-3 text-sm text-foreground/70">{error}</div>}

      {result && result.executed === false && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3 text-sm text-foreground/70">
          Prepared (no signer configured on the server): {result.reason}
        </div>
      )}

      {result && result.executed && (
        <div className="mt-4 space-y-2 text-sm">
          <DataRow label="Unified balance (Arc)" value={`${result.unifiedBalanceUsd.toFixed(4)} USDC`} />
          {result.deposit && (
            <DataRow
              label={`Deposited ${result.deposit.amountUsd} USDC to Gateway`}
              link={result.deposit.explorerUrl}
              linkText="tx"
            />
          )}
          {result.transfer.error ? (
            <div className="rounded-lg border border-red-200 dark:border-red-500/25 bg-red-50/60 dark:bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
              Transfer failed: {result.transfer.error}
            </div>
          ) : (
            <DataRow
              label={`Forwarded ${result.amountUsd} USDC → ${result.transfer.destination}`}
              value={result.transfer.forwardingFee ? `fee ~$${result.transfer.forwardingFee}` : undefined}
              badge={<span className="font-mono text-[10px] text-foreground/40">{result.transfer.transferId?.slice(0, 8)}...</span>}
            />
          )}
          {result.baseMint && (
            <div
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                minted ? 'border-emerald-200 dark:border-emerald-500/25 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10'
              }`}
            >
              {minted ? <Zap size={14} className="text-emerald-600" /> : <Loader2 size={14} className="animate-spin text-amber-600" />}
              <span className="text-foreground/75">
                {minted ? (
                  <>
                    Minted on Base Sepolia: balance {result.baseMint.beforeUsd} → <b>{result.baseMint.afterUsd}</b> USDC,
                    gasless
                  </>
                ) : (
                  'Transfer submitted, minting on Base'
                )}
              </span>
              <a
                href={result.baseMint.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-0.5 text-[11px] font-semibold text-accent hover:underline"
              >
                Basescan <ExternalLink size={9} />
              </a>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}


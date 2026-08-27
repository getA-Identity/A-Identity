import { useState } from 'react'
import { ShieldCheck, ShieldAlert, ShieldX, Loader2, Coins } from 'lucide-react'
import { apiFetch } from '../../../lib/api'
import { Button } from '../../ui/button'
import { authHeaders } from '../../../store/auth'
import { Panel } from '../../ui/panel'

type Decision = 'ALLOW' | 'WARN' | 'DENY'
type Result =
  | { executed: false; reason: string; tool: string; priceUsd: number }
  | {
      executed: true
      priceUsd: number
      buyer: string
      payTo: string
      payment: { rail: string; network: string; amountUsd: number; transaction?: string; explorerUrl?: string }
      riskCheck: { agentId: string; decision: Decision; risk: string; reasons: string[]; checkedAt: string }
    }

const short = (a?: string) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-')

const VERDICT: Record<Decision, { icon: typeof ShieldCheck; cls: string; chip: string }> = {
  ALLOW: { icon: ShieldCheck, cls: 'text-emerald-600 dark:text-emerald-400', chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' },
  WARN: { icon: ShieldAlert, cls: 'text-amber-600 dark:text-amber-400', chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-300' },
  DENY: { icon: ShieldX, cls: 'text-red-600 dark:text-red-400', chip: 'bg-red-500/10 text-red-700 dark:text-red-300' },
}

/**
 * Trust Oracle dogfood: one of our own agents BUYS a risk_check over x402 (a gasless Arc
 * nanopayment via Circle Gateway) before it transacts, and acts on the ALLOW/WARN/DENY
 * verdict. The consumer side of the same Trust Oracle we list on Circle's Agent
 * Marketplace. Hits POST /api/arc/trust-oracle-demo.
 */
export default function TrustOraclePanel() {
  const [agentId, setAgentId] = useState('#849980')
  const [amount, setAmount] = useState('25')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/trust-oracle-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId: agentId.trim(), txContext: { amountUsd: Number(amount) || undefined, kind: 'payment' } }),
        timeoutMs: 120_000,
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to run a real x402 purchase (guests are read-only).')
        return
      }
      if (res.status === 400) {
        setError('Enter a counterparty agent id (platform id, ERC-8004 token id like #849980, or a 0x address).')
        return
      }
      setResult((await res.json()) as Result)
    } catch {
      setError('Could not run the risk check (the backend may be waking up, try again).')
    } finally {
      setBusy(false)
    }
  }

  const v = result?.executed ? VERDICT[result.riskCheck.decision] : null
  const VIcon = v?.icon ?? ShieldCheck

  return (
<Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-usdc/10 text-usdc">
          <ShieldCheck size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Trust Oracle · an agent pays an agent (x402)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            Before it pays a counterparty, a buyer agent <b>buys a risk check</b> from our Trust Oracle over
            x402 (a gasless Arc nanopayment via Circle Gateway) and acts on the <b>ALLOW / WARN / DENY</b> verdict.
            The same service we list on <b>Circle's Agent Marketplace</b>, dogfooded on-chain.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground/50">
          Counterparty agent
          <input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="#849980 or 0x…"
            className="w-44 rounded-xl border border-border bg-background/40 px-3 py-2 font-mono text-sm outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground/50">
          About to pay
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background/40 px-3 py-2">
            <span className="text-sm text-foreground/50">$</span>
            <input type="number" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-20 bg-transparent text-sm outline-none" />
            <span className="text-xs font-semibold text-usdc">USDC</span>
          </div>
        </label>
        <Button type="button" size="sm" className="text-sm" onClick={run} disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Coins size={15} />}
          {busy ? 'Paying & checking' : 'Buy a risk check ($0.005)'}
        </Button>
      </div>

      {error && <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/10 p-3 text-sm text-foreground/70">{error}</div>}

      {result && result.executed === false && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3 text-sm text-foreground/70">
          Prepared (no signer configured on the server): {result.reason}
        </div>
      )}

      {result && result.executed && v && (
        <div className="mt-4 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-foreground/8 bg-background/40 px-3 py-2">
            <Coins size={13} className="shrink-0 text-usdc" />
            <span className="text-foreground/75">
              Paid <b>${result.payment.amountUsd}</b> over x402 (gasless nanopayment) to {short(result.payTo)}
            </span>
            <span className="ml-auto rounded bg-usdc/10 px-1.5 py-0.5 text-[10px] font-semibold text-usdc">Arc · Gateway-batched</span>
          </div>

          <div className={`flex items-start gap-2 rounded-lg border border-foreground/8 bg-background/40 px-3 py-3`}>
            <VIcon size={18} className={`mt-0.5 shrink-0 ${v.cls}`} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${v.chip}`}>{result.riskCheck.decision}</span>
                <span className="text-xs text-foreground/50">
                  counterparty <span className="font-mono text-foreground/70">{result.riskCheck.agentId}</span> · risk {result.riskCheck.risk}
                </span>
              </div>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-foreground/60">
                {result.riskCheck.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-[11px] text-foreground/40">
            The agent paid for the check and can now act on the verdict, {result.riskCheck.decision === 'DENY' ? 'it will not pay this counterparty.' : result.riskCheck.decision === 'WARN' ? 'proceed with caution.' : 'safe to proceed.'}
          </p>
        </div>
      )}
    </Panel>
  )
}

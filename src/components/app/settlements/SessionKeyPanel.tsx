import { useState } from 'react'
import { KeyRound, CheckCircle2, XCircle, ExternalLink, Loader2, Cpu } from 'lucide-react'
import { apiFetch } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'
import { Button } from '../../ui/button'
import { Panel } from '../../ui/panel'

type Attempt = { label: string; to: string; amountUsd: number; settled: boolean; txHash?: string; explorerUrl?: string; rejectedReason?: string }
type Result =
  | { executed: false; reason: string }
  | {
      executed: true
      sca: string
      sessionKey: string
      scopedTo: { capUsd: number; allowlist: string; expiresAt: number }
      funded: { amountUsd: number; txHash?: string } | null
      attempts: Attempt[]
    }

const short = (a?: string) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '-')

/**
 * ERC-4337 session-key smart account (the hero). One click deploys a Kernel smart account,
 * grants a session key scoped to a spend cap + payee allowlist + expiry, and settles a REAL
 * UserOperation within bounds while an out-of-bounds payment is rejected on-chain by the
 * policy validator, bounded authority on the standard AA primitive. POST /api/arc/session-key-demo.
 */
export default function SessionKeyPanel() {
  const [cap, setCap] = useState('0.05')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const res = await apiFetch('/api/arc/session-key-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ capUsd: Number(cap) || 0.05 }),
        timeoutMs: 150_000, // deploy SCA + fund + 2 UserOps through a bundler
      })
      if (res.status === 401 || res.status === 403) {
        setError('Sign in with a wallet or email link to run a real UserOp (guests are read-only).')
        return
      }
      setResult((await res.json()) as Result)
    } catch {
      setError('Could not run the session-key demo (the backend may be waking up, try again).')
    } finally {
      setBusy(false)
    }
  }

  return (
<Panel className="mt-8">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
          <KeyRound size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-foreground">Session-key smart account (ERC-4337)</h3>
          <p className="mt-0.5 text-sm text-foreground/55">
            The owner deploys a <b>Kernel smart account</b> and grants the agent a <b>session key</b> scoped
            to a spend cap, a payee allowlist, and an <b>expiry</b>. The agent then pays entirely on its own
            with a real <b>UserOperation</b>; anything outside the bounds is rejected <b>on-chain</b> by the
            policy validator, bounded authority on the standard AA primitive (via Pimlico on Arc).
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-foreground/50">
          Session cap
          <div className="flex items-center gap-1 rounded-xl border border-border bg-background/40 px-3 py-2">
            <span className="text-sm text-foreground/50">$</span>
            <input type="number" min="0" step="0.01" value={cap} onChange={(e) => setCap(e.target.value)} className="w-20 bg-transparent text-sm outline-none" />
            <span className="text-xs font-semibold text-accent">USDC</span>
          </div>
        </label>
        <Button type="button" size="sm" className="text-sm" onClick={run} disabled={busy}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Cpu size={15} />}
          {busy ? 'Deploying & signing UserOps…' : 'Grant a session key & run'}
        </Button>
      </div>

      {error && <div className="mt-4 rounded-xl border border-warn/35 bg-warn/[0.08] p-3 text-sm text-foreground/70">{error}</div>}

      {result && result.executed === false && (
        <div className="mt-4 rounded-xl border border-border bg-background/40 p-3 text-sm text-foreground/70">
          Prepared (no bundler key configured on the server): {result.reason}
        </div>
      )}

      {result && result.executed && (
        <div className="mt-4 space-y-2 text-sm">
          <div className="rounded-lg border border-foreground/8 bg-background/40 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-foreground/60">Smart account <span className="font-mono text-foreground/80">{short(result.sca)}</span></span>
              <span className="text-foreground/40">·</span>
              <span className="text-foreground/60">session key <span className="font-mono text-foreground/80">{short(result.sessionKey)}</span></span>
            </div>
            <div className="mt-0.5 text-[11px] text-foreground/45">
              scoped to <b>cap ${result.scopedTo.capUsd}</b> · <b>1 allowlisted payee</b> · expires {new Date(result.scopedTo.expiresAt * 1000).toLocaleTimeString()}
            </div>
          </div>

          {result.attempts.map((a, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
                a.settled
                  ? 'border-ok/30 bg-ok/[0.08]'
                  : 'border-foreground/8 bg-background/40'
              }`}
            >
              {a.settled ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" /> : <XCircle size={14} className="mt-0.5 shrink-0 text-foreground/40" />}
              <div className="min-w-0">
                <div className="text-foreground/75">{a.label}</div>
                <div className="text-[11px] text-foreground/50">
                  {a.settled ? (
                    <>Settled via a real UserOp{' '}
                      {a.explorerUrl && (
                        <a href={a.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-accent hover:underline">
                          tx <ExternalLink size={9} />
                        </a>
                      )}
                    </>
                  ) : (
                    <>Rejected on-chain, {a.rejectedReason ?? 'outside the session-key policy'}</>
                  )}
                </div>
              </div>
            </div>
          ))}
          <p className="text-[11px] text-foreground/40">
            The session key acted on its own within bounds and was stopped outside them, enforced by the
            account's policy validator, not a server.
          </p>
        </div>
      )}
    </Panel>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Link2 } from 'lucide-react'
import { apiFetch, readJson, explainError } from '../../../lib/api'
import { authHeaders } from '../../../store/auth'
import { shortAddress as short } from '../../../lib/utils'
import { Skeleton } from '../../ui/skeleton'
import { Stat } from '../../ui/stat'

type VaultState = {
  vaultAddress: string | null
  dailyCapUsd?: number
  autoApproveUsd?: number
  frozen?: boolean
  spentTodayUsd?: number
  balanceUsd?: number
  sessionKeyExpiry?: number
  sessionKeyExpired?: boolean
  explorer?: string
  error?: string
}

/** Human-readable "expires in ~Xh Ym" for a UNIX-seconds expiry. */
function untilLabel(expiryUnix?: number): string {
  if (!expiryUnix) return ''
  const secs = expiryUnix - Math.floor(Date.now() / 1000)
  if (secs <= 0) return 'expired'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `~${h}h ${m}m left` : `~${m}m left`
}

/**
 * Deploy the agent's policy as a real smart contract on Arc. Once live, address
 * payments settle THROUGH the vault. A payment over the cap or auto-approve line
 * reverts onchain, not just on our server. Programmable money enforcing itself.
 */
export default function VaultPanel({ agentId }: { agentId: string }) {
  const [vault, setVault] = useState<VaultState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [fund, setFund] = useState('2')
  const [sessionHours, setSessionHours] = useState('1')
  const [busyKey, setBusyKey] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch(`/api/agents/vault?agentId=${agentId}`)
      setVault((await res.json()) as VaultState)
      setErr(null)
    } catch {
      setErr('Could not load vault status.')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    if (agentId) load()
  }, [agentId, load])

  const provision = async () => {
    setBusy(true)
    setErr(null)
    try {
      const res = await apiFetch('/api/agents/vault', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, fundUsd: Math.max(0, Number(fund) || 0) }),
        timeoutMs: 90_000, // deploying a contract + funding it on-chain takes a while
        onWaking: () => setErr('Waking up the backend (free tier)...'),
      })
      const j = await readJson<{ error?: string }>(res)
      if (!res.ok) {
        setErr(explainError(res.status, j.error))
        return
      }
      if (j.error) setErr(j.error)
      else setErr(null)
      await load()
    } catch {
      setErr('Deploying the vault timed out. It runs on-chain and can be slow, give it a moment and try again.')
    } finally {
      setBusy(false)
    }
  }

  const setSessionKey = async (opts: { durationHours?: number; revoke?: boolean }) => {
    setBusyKey(true)
    setErr(null)
    try {
      const res = await apiFetch('/api/agents/session-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ agentId, ...opts }),
        timeoutMs: 60_000,
      })
      const j = await readJson<{ error?: string; ownerGated?: boolean; reason?: string }>(res)
      if (!res.ok) { setErr(explainError(res.status, j.error)); return }
      if (j.ownerGated) setErr(j.reason ?? 'The vault owner must sign this from their own wallet.')
      await load()
    } catch {
      setErr('Could not update the session key (the backend may be waking up, try again).')
    } finally {
      setBusyKey(false)
    }
  }

  const has = !!vault?.vaultAddress
  const keyActive = has && (vault?.sessionKeyExpiry ?? 0) > 0 && !vault?.sessionKeyExpired

  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-accent/25 bg-gradient-to-b from-accent/[0.06] to-card p-6 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-7">
      <div className="flex items-center gap-3">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-accent text-white">
          <Link2 size={16} />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-foreground">Onchain Policy Vault</h3>
            {has && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent">
                Live on Arc
              </span>
            )}
          </div>
          <p className="text-[11px] text-foreground/50">Your policy, enforced by a smart contract</p>
        </div>
      </div>
      <p className="mt-3 mb-4 text-xs text-foreground/55">
        Deploy this policy as a smart contract on Arc. Once live, the agent's payments to an Arc
        address settle <b>through the vault</b>. Anything over the cap or auto-approve line
        reverts onchain, not just on our server. Programmable money enforcing itself.
      </p>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-2xl border border-foreground/[0.06] bg-card px-4 py-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="mt-1.5 h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
      ) : has ? (
        <div className="space-y-3">
          <a
            href={vault!.explorer}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-mono text-xs font-semibold text-accent hover:underline"
          >
            {short(vault!.vaultAddress!)} <ExternalLink size={11} />
          </a>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Daily Cap" value={`$${vault!.dailyCapUsd}`} />
            <Stat label="Auto Approve" value={`$${vault!.autoApproveUsd}`} />
            <Stat label="Spent Today" value={`$${vault!.spentTodayUsd?.toFixed(2) ?? '0.00'}`} />
            <Stat label="Vault Balance" value={`$${vault!.balanceUsd?.toFixed(2) ?? '0.00'}`} />
          </div>
          {vault!.frozen && (
            <div className="text-xs font-semibold text-red-600">Frozen onchain. The agent cannot spend.</div>
          )}
          <p className="text-[11px] text-foreground/45">
            The contract enforces the same limits set above. Address payments now settle through it.
          </p>

          {/* Session key: a time-bounded spend authority the human grants the agent. */}
          <div className="mt-2 rounded-xl border border-border bg-background/40 p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-foreground/70">Session key (bounded authority)</div>
              {keyActive ? (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300">
                  active · {untilLabel(vault!.sessionKeyExpiry)}
                </span>
              ) : vault!.sessionKeyExpired ? (
                <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:text-red-300">expired</span>
              ) : (
                <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-bold text-foreground/50">no time limit</span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-foreground/45">
              Grant the agent a spend authority scoped to the cap/allowlist above and a <b>time limit</b>.
              When it expires, the agent's on-chain payments revert until you extend or re-grant it.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div>
                <label className="text-[10px] font-semibold text-foreground/50">Valid for (hours)</label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={sessionHours}
                  onChange={(e) => setSessionHours(e.target.value)}
                  className="mt-1 w-24 rounded-lg border border-border bg-card px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
              </div>
              <button
                type="button"
                onClick={() => setSessionKey({ durationHours: Math.max(0, Number(sessionHours) || 0) })}
                disabled={busyKey}
                className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:scale-[1.02] disabled:opacity-50"
              >
                {busyKey ? 'Signing...' : keyActive ? 'Extend / re-grant' : 'Grant session key'}
              </button>
              {keyActive && (
                <button
                  type="button"
                  onClick={() => setSessionKey({ revoke: true })}
                  disabled={busyKey}
                  className="rounded-full border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:hover:bg-red-500/10"
                >
                  Revoke now
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-[11px] font-semibold text-foreground/50">Fund with (USDC)</label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={fund}
              onChange={(e) => setFund(e.target.value)}
              className="mt-1 w-28 rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          <button
            type="button"
            onClick={provision}
            disabled={busy}
            className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50"
          >
            {busy ? 'Deploying on Arc...' : 'Provision on-chain vault'}
          </button>
        </div>
      )}
      {err && <div className="mt-3 text-xs text-red-600">{err}</div>}
    </section>
  )
}

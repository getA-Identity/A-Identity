/**
 * The owner's controls on a Stellar (Soroban) policy vault.
 *
 * These exist only where the vault's owner is a WALLET rather than the server: the backend
 * prepares each call, this screen hands the envelope to the owner's wallet, and the backend
 * broadcasts what comes back. The server never holds the key, which is why freeze, withdraw
 * and the session-key deadline are buttons here instead of a server-side switch.
 *
 * Nothing is reported as done without a transaction hash. A submit that has not made a
 * ledger yet says exactly that.
 */
import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  ownerAction,
  walletErrorMessage,
  STEP_LABEL,
  type OwnerActionResult,
  type OwnerActionStep,
  type StellarVaultAction,
  type StellarVaultArgs,
} from '../../../lib/stellar/vault'

/** Human-readable "~Xh Ym left" for a UNIX-seconds expiry. */
function untilLabel(expiryUnix?: number): string {
  if (!expiryUnix) return ''
  const secs = expiryUnix - Math.floor(Date.now() / 1000)
  if (secs <= 0) return 'expired'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `~${h}h ${m}m left` : `~${m}m left`
}

const BTN = 'rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-transform hover:scale-[1.02] disabled:opacity-50'
const BTN_DANGER =
  'rounded-full border border-danger/40 px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50'
const INPUT = 'mt-1 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground outline-none focus:border-accent'
const LABEL = 'text-[10px] font-semibold text-foreground/50'

export default function StellarVaultPanel({
  network,
  contract,
  owner,
  frozen,
  sessionKeyExpiry,
  sessionKeyExpired,
  onDone,
}: {
  /** CAIP-2, e.g. 'stellar:testnet'. */
  network: string
  contract: string
  owner: string
  frozen: boolean
  sessionKeyExpiry?: number
  sessionKeyExpired?: boolean
  onDone: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState<OwnerActionStep | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<(OwnerActionResult & { what: string }) | null>(null)
  const [amount, setAmount] = useState('1')
  const [to, setTo] = useState('')
  const [hours, setHours] = useState('1')

  const keyActive = (sessionKeyExpiry ?? 0) > 0 && !sessionKeyExpired

  const run = async (key: string, what: string, action: StellarVaultAction, args: StellarVaultArgs) => {
    setBusy(key)
    setErr(null)
    setDone(null)
    try {
      const r = await ownerAction({ network, contract, source: owner, action, args, onStep: setStep })
      setDone({ ...r, what })
      await onDone()
    } catch (e) {
      setErr(walletErrorMessage(e) || 'That did not go through.')
    } finally {
      setBusy(null)
      setStep(null)
    }
  }

  const withdraw = () => {
    const amountUsd = Number(amount)
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      setErr('Enter how much USDC to withdraw.')
      return
    }
    if (!/^G[A-Z2-7]{55}$/.test(to.trim())) {
      setErr('That is not a Stellar account address. It starts with G and is 56 characters long.')
      return
    }
    void run('withdraw', 'Withdrawal', 'withdraw', { to: to.trim(), amountUsd })
  }

  const grantKey = (revoke: boolean) => {
    const now = Math.floor(Date.now() / 1000)
    if (revoke) {
      void run('key', 'Session key revoked', 'set_session_key_expiry', { expiryUnix: now })
      return
    }
    const h = Number(hours)
    if (!Number.isFinite(h) || h <= 0) {
      setErr('Enter how many hours the session key should last.')
      return
    }
    void run('key', 'Session key', 'set_session_key_expiry', { expiryUnix: now + Math.floor(h * 3600) })
  }

  const label = (key: string, idle: string) => (busy === key ? `${step ? STEP_LABEL[step] : 'Working'}...` : idle)

  return (
    <div className="mt-2 space-y-3">
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="text-xs font-semibold text-foreground/70">Owner controls</div>
        <p className="mt-1 text-[11px] text-foreground/45">
          You sign with your wallet; the server never holds your key. It prepares each call and
          broadcasts what your wallet signs.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void run('freeze', frozen ? 'Unfreeze' : 'Freeze', 'set_frozen', { frozen: !frozen })} disabled={busy !== null} className={frozen ? BTN : BTN_DANGER}>
            {label('freeze', frozen ? 'Unfreeze the vault' : 'Freeze the vault')}
          </button>
          <span className="text-[11px] text-foreground/45">
            {frozen ? 'Frozen on-chain: every payment reverts until you unfreeze it.' : 'Freezing stops every payment on-chain, not just on our server.'}
          </span>
        </div>
      </div>

      {/* Withdraw: the owner takes USDC back out of the vault. */}
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="text-xs font-semibold text-foreground/70">Withdraw USDC</div>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label className={LABEL} htmlFor="stellar-vault-amount">Amount (USDC)</label>
            <input
              id="stellar-vault-amount"
              type="number"
              min="0"
              step="0.5"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={`${INPUT} w-24`}
            />
          </div>
          <div className="min-w-[14rem] flex-1">
            <label className={LABEL} htmlFor="stellar-vault-to">To (G... account)</label>
            <input
              id="stellar-vault-to"
              type="text"
              spellCheck={false}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="GA..."
              className={`${INPUT} w-full font-mono text-xs`}
            />
          </div>
          <button type="button" onClick={withdraw} disabled={busy !== null} className={BTN}>
            {label('withdraw', 'Withdraw')}
          </button>
        </div>
      </div>

      {/* Session key: a deadline on the operator's authority to spend. */}
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-foreground/70">Session key (bounded authority)</div>
          {keyActive ? (
            <span className="rounded-full bg-ok/10 px-2 py-0.5 text-[10px] font-bold text-ok">
              active, {untilLabel(sessionKeyExpiry)}
            </span>
          ) : sessionKeyExpired ? (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger">expired</span>
          ) : (
            <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-bold text-foreground/50">no time limit</span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-foreground/45">
          Give the agent's spend authority a deadline. When it passes, the vault reverts the agent's
          payments until you extend it.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label className={LABEL} htmlFor="stellar-vault-hours">Valid for (hours)</label>
            <input
              id="stellar-vault-hours"
              type="number"
              min="0"
              step="1"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className={`${INPUT} w-24`}
            />
          </div>
          <button type="button" onClick={() => grantKey(false)} disabled={busy !== null} className={BTN}>
            {label('key', keyActive ? 'Extend / re-grant' : 'Grant session key')}
          </button>
          {keyActive && (
            <button type="button" onClick={() => grantKey(true)} disabled={busy !== null} className={BTN_DANGER}>
              Revoke now
            </button>
          )}
        </div>
      </div>

      {done && (
        <div className="text-xs text-foreground/65">
          {done.outcome === 'settled' ? `${done.what} settled.` : `${done.what}: ${done.reason ?? 'submitted.'}`}{' '}
          {done.explorerUrl && (
            <a
              href={done.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-accent hover:underline"
            >
              View the transaction <ExternalLink size={11} />
            </a>
          )}
        </div>
      )}
      {err && <div className="text-xs text-danger">{err}</div>}
    </div>
  )
}

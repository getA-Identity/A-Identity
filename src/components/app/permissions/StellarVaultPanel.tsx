/**
 * The owner's controls on a Stellar (Soroban) policy vault, inside an agent's Limits screen.
 *
 * These exist only where the vault's owner is a WALLET rather than the server: the backend
 * prepares each call, this screen hands the envelope to the owner's wallet, and the backend
 * broadcasts what comes back. The server never holds the key, which is why freeze, withdraw
 * and the session-key deadline are buttons here instead of a server-side switch.
 *
 * The pieces are the same ones the full vault page uses (/app/vault/stellar): one-click
 * freeze, a two-step withdrawal with a review screen, and one notice that names every way
 * an action can stop. The receipt is held HERE, and this component is no longer unmounted
 * by the parent's refetch, so the hash of a settled or pending transaction stays on screen
 * while the vault's new state loads.
 *
 * Nothing is reported as done without a transaction hash. A submit that has not made a
 * ledger yet says exactly that, and keeps checking.
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink } from 'lucide-react'
import { ownerAction, STEP_LABEL } from '../../../lib/stellar/vault'
import { readVault, type VaultRead } from '../../../lib/stellar/vault-read'
import FailureNotice from '../stellar/FailureNotice'
import FreezeButton from '../stellar/FreezeButton'
import TxReceipt, { type Receipt } from '../stellar/TxReceipt'
import WithdrawFlow from '../stellar/WithdrawFlow'
import { receiptOf, useOwnerRun } from '../stellar/useOwnerRun'

/** Human-readable "~Xh Ym left" for a UNIX-seconds expiry. */
function untilLabel(expiryUnix?: number): string {
  if (!expiryUnix) return ''
  const secs = expiryUnix - Math.floor(Date.now() / 1000)
  if (secs <= 0) return 'expired'
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h > 0 ? `~${h}h ${m}m left` : `~${m}m left`
}

const BTN = 'rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
const BTN_DANGER =
  'rounded-full border border-danger/40 px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
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
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [hours, setHours] = useState('1')
  const keyRun = useOwnerRun()
  // The exact balance and the token's decimals, for the withdrawal form's Max and its
  // amount check. Read live; when the read fails the form says where to withdraw instead.
  const [live, setLive] = useState<VaultRead | null>(null)
  const [liveFailed, setLiveFailed] = useState(false)

  const readLive = useCallback(async () => {
    const r = await readVault(network, contract)
    if (r.ok) {
      setLive(r.data)
      setLiveFailed(false)
    } else {
      setLive(null)
      setLiveFailed(true)
    }
  }, [network, contract])

  useEffect(() => {
    void readLive()
  }, [readLive])

  const keyActive = (sessionKeyExpiry ?? 0) > 0 && !sessionKeyExpired

  const onReceipt = useCallback(
    (r: Receipt) => {
      setReceipt(r)
      if (r.outcome === 'settled') {
        void onDone()
        void readLive()
      }
    },
    [onDone, readLive],
  )

  const grantKey = (revoke: boolean) => {
    const now = Math.floor(Date.now() / 1000)
    let expiryUnix = now
    if (!revoke) {
      const h = Number(hours)
      if (!Number.isFinite(h) || h <= 0) {
        keyRun.setFailure({ code: 'bad_request', message: 'Enter how many hours the session key should last.' })
        return
      }
      expiryUnix = now + Math.floor(h * 3600)
    }
    const what = revoke ? 'Session key revoked' : 'Session key'
    void keyRun.run('key', async (onStep) => {
      const r = await ownerAction({ network, contract, source: owner, action: 'set_session_key_expiry', args: { expiryUnix }, onStep })
      onReceipt(receiptOf(what, network, r))
      return r
    })
  }

  const keyLabel = (idle: string) => (keyRun.busy ? `${keyRun.step ? STEP_LABEL[keyRun.step] : 'Working'}...` : idle)
  const fullPanel = `/app/vault/stellar?network=${encodeURIComponent(network)}&contract=${encodeURIComponent(contract)}`
  // While a submitted transaction has not landed, nothing new is offered for signing, so a
  // pending freeze or withdrawal is never signed twice by a second press.
  const held = receipt?.outcome === 'pending'

  return (
    <div className="mt-2 space-y-3">
      {receipt && <TxReceipt receipt={receipt} onUpdate={setReceipt} onSettled={() => void onDone()} />}
      {held && (
        <p className="text-[11px] text-warn">
          A transaction is still pending. The controls come back once it lands or fails, so nothing is signed twice.
        </p>
      )}

      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-semibold text-foreground/70">Owner controls</div>
          <Link to={fullPanel} className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent hover:underline">
            Open the live vault panel <ExternalLink size={11} />
          </Link>
        </div>
        <p className="mt-1 text-[11px] text-foreground/45">
          You sign with your wallet; the server never holds your key. It prepares each call and broadcasts what your wallet signs.
        </p>
        <div className="mt-2">
          <FreezeButton network={network} contract={contract} owner={owner} frozen={frozen} onReceipt={onReceipt} held={held} />
        </div>
      </div>

      {/* Withdraw: the owner takes USDC back out of the vault, after a review screen. */}
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="text-xs font-semibold text-foreground/70">Withdraw {live?.tokenSymbol || 'USDC'}</div>
        <div className="mt-2">
          {live ? (
            <WithdrawFlow
              network={network}
              contract={contract}
              owner={owner}
              balance={live.balance}
              decimals={live.decimals}
              tokenSymbol={live.tokenSymbol}
              onReceipt={onReceipt}
              held={held}
            />
          ) : liveFailed ? (
            <p className="text-[11px] text-foreground/60">
              The live balance could not be read just now, so the withdrawal form is not shown with a guessed one.{' '}
              <button type="button" onClick={() => void readLive()} className="font-semibold text-accent underline underline-offset-2">
                Read again
              </button>{' '}
              or use the{' '}
              <Link to={fullPanel} className="font-semibold text-accent underline underline-offset-2">
                live vault panel
              </Link>
              .
            </p>
          ) : (
            <p className="text-[11px] text-foreground/60">Reading the live balance...</p>
          )}
        </div>
      </div>

      {/* Session key: a deadline on the operator's authority to spend. */}
      <div className="rounded-xl border border-border bg-background/40 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs font-semibold text-foreground/70">Session key (bounded authority)</div>
          {keyActive ? (
            <span className="rounded-full bg-ok/10 px-2 py-0.5 text-[10px] font-bold text-ok">active, {untilLabel(sessionKeyExpiry)}</span>
          ) : sessionKeyExpired ? (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-bold text-danger">expired</span>
          ) : (
            <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] font-bold text-foreground/50">no time limit</span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-foreground/45">
          Give the agent's spend authority a deadline. When it passes, the vault reverts the agent's payments until you extend it.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label className={LABEL} htmlFor="stellar-vault-hours">
              Valid for (hours)
            </label>
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
          <button type="button" onClick={() => grantKey(false)} disabled={keyRun.busy !== null || held} className={BTN}>
            {keyLabel(keyActive ? 'Extend / re-grant' : 'Grant session key')}
          </button>
          {keyActive && (
            <button type="button" onClick={() => grantKey(true)} disabled={keyRun.busy !== null || held} className={BTN_DANGER}>
              Revoke now
            </button>
          )}
        </div>
        {keyRun.failure && (
          <div className="mt-2">
            <FailureNotice failure={keyRun.failure} owner={owner} network={network} />
          </div>
        )}
      </div>
    </div>
  )
}

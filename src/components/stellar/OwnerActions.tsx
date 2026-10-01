import { useCallback, useEffect, useState } from 'react'
import { Loader2, Lock, LockOpen, RefreshCw } from 'lucide-react'
import {
  PASSKEY_STEP_LABEL,
  ownerSetFrozen,
  ownerWithdraw,
  passkeyErrorMessage,
  type ChainWrite,
  type PasskeyNetwork,
  type PasskeyStep,
} from '../../lib/stellar/passkey'
import { readPasskeyVault, type VaultRead } from '../../lib/stellar/passkey-api'
import { AddressLink, BTN, BTN_QUIET, Chip, INPUT, LABEL } from './bits'
import { fromRaw, money } from './format'
import TxResult from './TxResult'

/**
 * The owner's own levers on the vault (D3.5), each signed by the passkey through the smart
 * account and relayed: freeze or unfreeze, and withdraw, which is two steps on purpose
 * because it is the one action that moves money out. After each, the whole hash, who paid
 * the fee and what was signed. The vault's state above the buttons is read live and re-read
 * after every write, so the page never reports a freeze it has not seen.
 */
export default function OwnerActions({
  net,
  vault,
  smartAccount,
  onSettled,
}: {
  net: PasskeyNetwork
  vault: string
  smartAccount: string
  onSettled: (r: { label: string; write: Extract<ChainWrite, { outcome: 'settled' }> }) => void
}) {
  const [state, setState] = useState<VaultRead | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState<'freeze' | 'withdraw' | null>(null)
  const [step, setStep] = useState<PasskeyStep | null>(null)
  const [last, setLast] = useState<{ what: string; write: ChainWrite } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [amount, setAmount] = useState('')
  const [to, setTo] = useState(smartAccount)
  const [review, setReview] = useState<{ to: string; amountUsd: number } | null>(null)

  const refresh = useCallback(async () => {
    setReading(true)
    setState(await readPasskeyVault(net, vault))
    setReading(false)
  }, [net, vault])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = async (kind: 'freeze' | 'withdraw', what: string, fn: () => Promise<ChainWrite>) => {
    setBusy(kind)
    setError(null)
    try {
      const w = await fn()
      setLast({ what, write: w })
      if (w.outcome === 'settled') onSettled({ label: what, write: w })
      await refresh()
    } catch (e) {
      setError(passkeyErrorMessage(e))
    } finally {
      setBusy(null)
      setStep(null)
    }
  }

  const balance = state ? fromRaw(state.balanceRaw, state.decimals) : null
  const frozen = state?.frozen ?? null

  const startReview = () => {
    setError(null)
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) return setError('Enter an amount above zero.')
    if (balance !== null && n > balance) return setError(`The vault holds ${money(balance)}; withdraw at most that.`)
    if (!/^[GC][A-Z2-7]{55}$/.test(to.trim())) return setError('The destination is not a Stellar address (G... or C..., 56 characters).')
    setReview({ to: to.trim(), amountUsd: n })
  }

  const label = (kind: 'freeze' | 'withdraw', idle: string) => (busy === kind ? `${step ? PASSKEY_STEP_LABEL[step] : 'Working'}...` : idle)

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/60">
        {state ? (
          <>
            <Chip tone={state.frozen ? 'danger' : 'ok'}>{state.frozen ? 'frozen' : 'not frozen'}</Chip>
            <Chip tone="muted">balance {balance !== null ? money(balance) : '?'} USDC</Chip>
            <span>read live {new Date(state.checkedAt).toLocaleTimeString()}</span>
          </>
        ) : (
          <span>{reading ? 'Reading the vault...' : 'The vault could not be read right now.'}</span>
        )}
        <button type="button" onClick={() => void refresh()} disabled={reading} className="inline-flex items-center gap-1 text-accent disabled:opacity-50" aria-label="Read the vault again">
          <RefreshCw size={12} className={reading ? 'animate-spin' : ''} /> re-read
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy !== null || frozen === null}
          onClick={() => act('freeze', frozen ? 'Unfreeze' : 'Freeze', () => ownerSetFrozen(net, vault, !frozen, setStep))}
          className={BTN_QUIET}
        >
          {busy === 'freeze' ? <Loader2 size={13} className="animate-spin" /> : frozen ? <LockOpen size={13} /> : <Lock size={13} />}
          {label('freeze', frozen ? 'Unfreeze with your passkey' : 'Freeze with your passkey')}
        </button>
        <span className="text-xs text-foreground/50">While frozen, every pay() is refused with Frozen (#1). Withdraw still works: it is yours.</span>
      </div>

      <div className="grid gap-3 rounded-xl border border-border bg-background/40 p-4">
        <div className="text-sm font-semibold text-foreground">Withdraw</div>
        {!review ? (
          <>
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <div>
                <label className={LABEL} htmlFor="stellar-withdraw-amount">
                  Amount (USDC)
                </label>
                <input
                  id="stellar-withdraw-amount"
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={balance !== null ? String(balance) : '0'}
                  className={INPUT}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="stellar-withdraw-to">
                  To
                </label>
                <input
                  id="stellar-withdraw-to"
                  type="text"
                  spellCheck={false}
                  autoComplete="off"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className={`${INPUT} font-mono text-xs`}
                />
                {to.trim() === smartAccount && <p className="mt-1 text-[11px] text-foreground/50">Your own smart account, which this passkey also controls.</p>}
              </div>
            </div>
            <div>
              <button type="button" onClick={startReview} disabled={busy !== null} className={BTN_QUIET}>
                Review the withdrawal
              </button>
            </div>
          </>
        ) : (
          <div className="grid gap-3">
            <p className="text-[13px] leading-relaxed text-foreground/70">
              Your passkey will sign <span className="font-mono">withdraw</span> on the vault, through your smart account: {money(review.amountUsd)} USDC
              leaves the vault for the address below. This is the owner's path, outside the agent's policy, and it cannot be undone.
            </p>
            <AddressLink net={net} value={review.to} label="Destination" />
            <AddressLink net={net} value={vault} label="From vault" />
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() =>
                  act('withdraw', `Withdraw ${money(review.amountUsd)}`, async () => {
                    const w = await ownerWithdraw(net, vault, review.to, review.amountUsd, setStep)
                    if (w.outcome === 'settled') {
                      setReview(null)
                      setAmount('')
                    }
                    return w
                  })
                }
                className={BTN}
              >
                {busy === 'withdraw' && <Loader2 size={15} className="animate-spin" />}
                {label('withdraw', 'Sign the withdrawal with your passkey')}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => setReview(null)} className={BTN_QUIET}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>

      {last && <TxResult net={net} write={last.write} what={last.what} />}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  )
}

/**
 * Fund a vault: one USDC transfer, in the token's 6-decimal units, from the connected account.
 *
 * Never native value: the vault has no receive function, and its balance() counts the ERC-20.
 * On Arc USDC is also the gas token, so the transfer is refused unless the account keeps enough
 * behind for this fee and two later owner actions (a freeze, a withdrawal). Two steps, like a
 * withdrawal: the form prepares and simulates, and only the review's Confirm opens the wallet.
 */
import { useState, type FormEvent } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import { track } from '../../../lib/analytics'
import type { TxRecord } from '../../../lib/arc/pending'
import { networkWord, type VaultSnapshot } from '../../../lib/arc/vault-read'
import { aboveSoftWarn, parseUnitsExact } from '../../../lib/arc/vault-rules'
import { STEP_LABEL, prepareFund, preparedStale, sendPrepared, type PreparedTx } from '../../../lib/arc/vault-write'
import type { Eip1193 } from '../../../lib/wallets'
import { Button } from '../../ui/button'
import FailureNotice from './FailureNotice'
import PreparedView from './PreparedView'
import { recordOf, useArcTx } from './useArcTx'

export default function FundForm({
  chain,
  vault,
  provider,
  account,
  onSubmitted,
  held,
  initial = '',
  confirmLabel = 'Confirm in wallet',
  stillCurrent,
}: {
  chain: Chain
  vault: VaultSnapshot
  provider: Eip1193
  account: string
  onSubmitted: (r: TxRecord) => void
  held: boolean
  initial?: string
  confirmLabel?: string
  /** Asked before preparing and again before the wallet. False stops it; the caller says why. */
  stillCurrent?: () => boolean
}) {
  const [amount, setAmount] = useState(initial)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedTx | null>(null)
  const { busy, step, failure, setFailure, run } = useArcTx()
  const id = `fund-${vault.address.slice(2, 10)}`
  const label = busy ? `${step ? STEP_LABEL[step] : 'Working'}...` : null

  const units = (): bigint | null => {
    const raw = parseUnitsExact(amount, vault.decimals)
    if (raw === null || raw <= 0n) {
      setInvalid(`Enter an amount above 0, with at most ${vault.decimals} decimal places.`)
      return null
    }
    setInvalid(null)
    return raw
  }

  const review = (e: FormEvent) => {
    e.preventDefault()
    setFailure(null)
    if (stillCurrent && !stillCurrent()) return
    const raw = units()
    if (raw === null) return
    void run('prepare', async (onStep) => {
      onStep('simulating')
      const p = await prepareFund(chain, vault, account, raw)
      setPrepared(p)
      return p
    })
  }

  const confirm = () => {
    if (!prepared) return
    if (stillCurrent && !stillCurrent()) {
      setPrepared(null)
      return
    }
    void run('confirm', async (onStep) => {
      let p = prepared
      if (preparedStale(p)) {
        const raw = units()
        if (raw === null) return null
        onStep('simulating')
        p = await prepareFund(chain, vault, account, raw)
      }
      const hash = await sendPrepared(provider, p, onStep)
      const first = p.expect[0]
      const value = first && first.kind === 'transfer' ? first.value : undefined
      onSubmitted({ ...recordOf(p, hash, vault.address), ...(value !== undefined ? { amount: value } : {}) })
      track('arc_vault_owner_action', { network: networkWord(chain), action: 'fund', outcome: 'submitted' })
      setPrepared(null)
      return hash
    })
  }

  const raw = parseUnitsExact(amount, vault.decimals)
  return (
    <div className="space-y-3">
      {prepared ? (
        <>
          <PreparedView p={prepared} decimals={vault.decimals} />
          {raw !== null && aboveSoftWarn(raw, vault.decimals) && (
            <p className="text-xs font-semibold text-warn">
              This is more than 10 USDC into a contract with internal reviews and no outside audit. The limits cap what the agent can spend per
              day, not what the vault holds.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={confirm} disabled={busy !== null || held}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {label ?? confirmLabel}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPrepared(null)
                setFailure(null)
              }}
              disabled={busy !== null}
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back
            </Button>
          </div>
        </>
      ) : (
        <form onSubmit={review} className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={id} className="text-[11px] font-semibold text-foreground/65">
              Amount (USDC)
            </label>
            <input
              id={id}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="mt-1 w-40 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy !== null || held}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {label ?? 'Review'}
          </Button>
        </form>
      )}
      {invalid && (
        <p role="alert" className="text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
      {failure && <FailureNotice failure={failure} />}
    </div>
  )
}

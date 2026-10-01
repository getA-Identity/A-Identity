/**
 * Withdraw, in two steps: a form, then a review screen, then the wallet.
 *
 * Step one only PREPARES: the backend builds the exact withdraw call and simulates it, which
 * is also where a destination with no USDC trustline is caught, before anything is signed.
 * Step two restates what will happen (amount, token, destination, the network fee the
 * owner's account will pay, and whether a state restore rides along) and only its Confirm
 * opens the wallet. Money leaving a vault gets a second look; a freeze does not.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import {
  prepareOwnerAction,
  preparedExpired,
  signAndSubmit,
  STEP_LABEL,
  type PreparedOwnerAction,
} from '../../../lib/stellar/vault'
import { ACCOUNT_ID, CONTRACT_ID, networkWord, parseAmount, type Amount } from '../../../lib/stellar/vault-read'
import FailureNotice from './FailureNotice'
import type { Receipt } from './TxReceipt'
import { receiptOf, useOwnerRun } from './useOwnerRun'
import { Mono } from './bits'

const INPUT =
  'mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring'

export default function WithdrawFlow({
  network,
  contract,
  owner,
  balance,
  decimals,
  tokenSymbol,
  onReceipt,
  signIn,
}: {
  network: string
  contract: string
  owner: string
  /** The live balance, for Max and for refusing an amount the vault does not hold. */
  balance: Amount | null
  decimals: number
  tokenSymbol: string
  onReceipt: (r: Receipt) => void
  signIn?: ReactNode
}) {
  const [amount, setAmount] = useState('')
  const [to, setTo] = useState(owner)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedOwnerAction | null>(null)
  const { busy, step, failure, setFailure, run } = useOwnerRun()
  const sym = tokenSymbol || 'USDC'
  const amountId = `withdraw-amount-${contract.slice(0, 8)}`
  const toId = `withdraw-to-${contract.slice(0, 8)}`

  const input = (amt: string, dest: string) => ({
    network,
    contract,
    source: owner,
    action: 'withdraw' as const,
    args: { to: dest, amountUsd: Number(amt) },
  })

  const review = (e: FormEvent) => {
    e.preventDefault()
    setFailure(null)
    const raw = parseAmount(amount, decimals)
    if (raw === null || raw <= 0n) {
      setInvalid(`Enter an amount above 0, with at most ${decimals} decimal places.`)
      return
    }
    if (balance) {
      try {
        if (raw > BigInt(balance.raw)) {
          setInvalid(`The vault holds ${balance.display} ${sym}. Enter that much or less (Max fills it in).`)
          return
        }
      } catch {
        /* an unparseable balance leaves the check to the contract */
      }
    }
    const dest = to.trim()
    if (!ACCOUNT_ID.test(dest) && !CONTRACT_ID.test(dest)) {
      setInvalid('The destination must be a Stellar account (G..., 56 characters) or a contract (C...).')
      return
    }
    setInvalid(null)
    void run('prepare', async (onStep) => {
      const p = await prepareOwnerAction({ ...input(amount.trim(), dest), onStep })
      setPrepared(p)
      return p
    })
  }

  const confirm = () => {
    if (!prepared) return
    void run('confirm', async (onStep) => {
      // A review screen can sit open past the envelope's time bound. Prepare it again
      // rather than hand the wallet something the network will refuse as too late.
      const ready = preparedExpired(prepared) ? await prepareOwnerAction({ ...prepared.input, onStep }) : prepared
      const r = await signAndSubmit(ready, onStep)
      onReceipt(receiptOf(`Withdrawal of ${amount.trim()} ${sym}`, network, r))
      setPrepared(null)
      setAmount('')
      return r
    })
  }

  const working = busy !== null
  const stepLabel = step ? `${STEP_LABEL[step]}...` : 'Working...'

  if (prepared) {
    const dest = String(prepared.input.args?.to ?? '')
    return (
      <div className="space-y-3">
        <div className="rounded-xl border border-border bg-background/60 p-4">
          <h4 className="text-sm font-semibold text-foreground">Review the withdrawal</h4>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Amount</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                {amount.trim()} {sym}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">Network fee (paid by your account)</dt>
              <dd className="mt-0.5 text-foreground">{prepared.feeXlm ? `${prepared.feeXlm} XLM` : 'Shown in your wallet prompt'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">To</dt>
              <dd className="mt-0.5">
                <Mono>{dest}</Mono>
                {dest === owner && <span className="ml-2 text-xs text-foreground/60">(your owner account)</span>}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/50">From vault, on Stellar {networkWord(network)}</dt>
              <dd className="mt-0.5">
                <Mono>{contract}</Mono>
              </dd>
            </div>
          </dl>
          {prepared.restoreNeeded && (
            <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
              A restore is included: part of this vault's state was archived, so this transaction also restores it. That is why the fee
              is higher than usual. Nothing the vault holds was lost.
            </p>
          )}
          {prepared.summary && <p className="mt-3 text-xs text-foreground/60">Prepared call: {prepared.summary}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={confirm}
              disabled={working}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {working && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {working ? stepLabel : 'Confirm in wallet'}
            </button>
            <button
              type="button"
              onClick={() => {
                setPrepared(null)
                setFailure(null)
              }}
              disabled={working}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-semibold text-foreground/80 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <ArrowLeft size={14} aria-hidden="true" /> Back
            </button>
          </div>
        </div>
        {failure && <FailureNotice failure={failure} owner={owner} network={network} signIn={signIn} />}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <form onSubmit={review} className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor={amountId} className="text-[11px] font-semibold text-foreground/65">
            Amount ({sym})
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id={amountId}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className={INPUT}
            />
            <button
              type="button"
              onClick={() => balance && setAmount(balance.display)}
              disabled={!balance}
              className="mt-1 shrink-0 rounded-lg border border-border px-2 py-2 text-xs font-semibold text-foreground/75 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Max
            </button>
          </div>
        </div>
        <div className="min-w-0">
          <label htmlFor={toId} className="text-[11px] font-semibold text-foreground/65">
            Destination (defaults to your owner account)
          </label>
          <input
            id={toId}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`${INPUT} font-mono text-xs`}
          />
        </div>
        <button
          type="submit"
          disabled={working}
          className="inline-flex items-center justify-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {working && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {working ? stepLabel : 'Review'}
        </button>
      </form>
      <p className="text-[11px] text-foreground/55">
        Review prepares the exact call and checks that the destination can hold {sym}. Nothing is signed until you confirm on the next
        screen.
      </p>
      {invalid && (
        <p role="alert" className="text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
      {failure && <FailureNotice failure={failure} owner={owner} network={network} signIn={signIn} />}
    </div>
  )
}

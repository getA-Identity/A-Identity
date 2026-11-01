/**
 * The owner's controls on an Arc vault whose owner is the account connected here.
 *
 * The page mounts this only after a live read has established all of: the connected account IS
 * owner(), the wallet reports the vault's chain, the vault's code is the build this page deploys
 * and its token is the registry's USDC, and no transaction for the vault is still pending. Arc
 * Mainnet controls exist on purpose (that is where an owner-held vault lives) and are labelled
 * as real money.
 *
 * Every control simulates its call as the owner first, so a refusal shows here before the wallet
 * opens, then hands the wallet one transaction with explicit gas and fees. A-Identity signs none
 * of it. A freeze is one click: the wallet's own prompt is the confirmation, and a freeze is what
 * an owner reaches for when something is going wrong. Money leaving the vault gets a review step.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Loader2, Snowflake, Sun } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import { track } from '../../../lib/analytics'
import type { TxRecord } from '../../../lib/arc/pending'
import { networkName, networkWord, type VaultSnapshot } from '../../../lib/arc/vault-read'
import {
  DEFAULT_SESSION_SECONDS,
  SESSION_CHOICES,
  aboveSoftWarn,
  capsRefusal,
  capsWarning,
  formatUnitsExact,
  operatorRefusal,
  parseUnitsExact,
  withdrawRefusal,
} from '../../../lib/arc/vault-rules'
import { STEP_LABEL, prepareOwnerCall, preparedStale, sendPrepared, type OwnerCall, type PreparedTx } from '../../../lib/arc/vault-write'
import type { Eip1193 } from '../../../lib/wallets'
import { Button } from '../../ui/button'
import FailureNotice from './FailureNotice'
import PreparedView from './PreparedView'
import { recordOf, useArcTx } from './useArcTx'

const INPUT =
  'mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring'

type Shared = {
  chain: Chain
  vault: VaultSnapshot
  provider: Eip1193
  onSubmitted: (r: TxRecord) => void
  /** A transaction for this vault is still pending: nothing new is prepared or signed. */
  held: boolean
}

/** Simulate, then send, then hand the hash up. One shape for every one-click owner action. */
function useOwnerAction({ chain, vault, provider, onSubmitted }: Shared) {
  const tx = useArcTx()
  const act = (key: string, call: OwnerCall) =>
    tx.run(key, async (onStep) => {
      onStep('simulating')
      const p = await prepareOwnerCall(chain, vault, call)
      const hash = await sendPrepared(provider, p, onStep)
      onSubmitted(recordOf(p, hash, vault.address))
      track('arc_vault_owner_action', { network: networkWord(chain), action: p.action, outcome: 'submitted' })
      return hash
    })
  return { ...tx, act }
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-xl border border-border bg-background/60 p-4">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      <div className="mt-2">{children}</div>
    </section>
  )
}

const working = (busy: string | null, step: keyof typeof STEP_LABEL | null, idle: string) => (busy ? `${step ? STEP_LABEL[step] : 'Working'}...` : idle)

export default function OwnerControls(props: Shared) {
  const { chain, held } = props
  return (
    <div className="space-y-4">
      {!chain.testnet && (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
          {networkName(chain)}: these controls move real USDC and pay real network fees, signed by your own wallet. The contract has had
          internal reviews only, no external audit.
        </p>
      )}
      {held && (
        <p className="rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-foreground/85">
          A transaction for this vault is still pending. The controls come back once it lands, so nothing is signed twice.
        </p>
      )}
      <FreezeControl {...props} />
      <SessionKeyControl {...props} />
      <WithdrawControl {...props} />
      <PolicyControl {...props} />
      <OperatorControl {...props} />
    </div>
  )
}

function FreezeControl(props: Shared) {
  const { vault, held } = props
  const { busy, step, failure, act } = useOwnerAction(props)
  const next = !vault.frozen
  return (
    <Card title="Freeze">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void act('freeze', { fn: 'setFrozen', frozen: next })} disabled={busy !== null || held}>
          {busy ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : next ? (
            <Snowflake size={14} className="text-danger" aria-hidden="true" />
          ) : (
            <Sun size={14} className="text-ok" aria-hidden="true" />
          )}
          {working(busy, step, next ? 'Freeze the vault' : 'Unfreeze the vault')}
        </Button>
        <span className="text-xs text-foreground/65">
          {vault.frozen
            ? 'Frozen on-chain: every agent payment reverts. Unfreezing lets the policy decide again.'
            : 'Freezing stops every agent payment on-chain at once. Your wallet prompt is the confirmation.'}
        </span>
      </div>
      {failure && (
        <div className="mt-3">
          <FailureNotice failure={failure} />
        </div>
      )}
    </Card>
  )
}

function SessionKeyControl(props: Shared) {
  const { vault, held } = props
  const [seconds, setSeconds] = useState(DEFAULT_SESSION_SECONDS)
  const { busy, step, failure, act } = useOwnerAction(props)
  const id = `session-${vault.address.slice(2, 10)}`
  return (
    <Card title="Session key">
      {vault.sessionKeyExpiry === 0n && (
        <p className="mb-2 rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-xs font-semibold text-foreground">
          This vault's operator key has no time bound. Set an expiry now.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor={id} className="text-[11px] font-semibold text-foreground/65">
            Valid for, from the chain's current time
          </label>
          <select id={id} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} className={INPUT}>
            {SESSION_CHOICES.map((c) => (
              <option key={c.seconds} value={c.seconds}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <Button size="sm" onClick={() => void act('extend', { fn: 'extend', seconds })} disabled={busy !== null || held}>
          {busy === 'extend' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {busy === 'extend' ? working(busy, step, '') : vault.sessionKeyExpiry === 0n ? 'Set the expiry' : 'Extend or shorten'}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="border-danger/40 text-danger hover:bg-danger/10"
          onClick={() => void act('revoke', { fn: 'revoke' })}
          disabled={busy !== null || held || vault.expired}
        >
          {busy === 'revoke' && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {busy === 'revoke' ? working(busy, step, '') : 'Revoke now'}
        </Button>
      </div>
      <p className="mt-2 text-[11px] text-foreground/60">
        The expiry is the latest block's time plus the lifetime chosen, never this browser's clock. Revoking writes 1, a second already past on
        every chain; this page never writes 0, which would mean no time bound at all.
      </p>
      {failure && (
        <div className="mt-3">
          <FailureNotice failure={failure} />
        </div>
      )}
    </Card>
  )
}

function PolicyControl(props: Shared) {
  const { vault, held } = props
  const [cap, setCap] = useState(formatUnitsExact(vault.dailyCap, vault.decimals))
  const [ceiling, setCeiling] = useState(formatUnitsExact(vault.autoApproveMax, vault.decimals))
  const [allowlist, setAllowlist] = useState(vault.allowlistEnabled)
  const [invalid, setInvalid] = useState<string | null>(null)
  const { busy, step, failure, act } = useOwnerAction(props)
  const id = vault.address.slice(2, 10)
  const c = parseUnitsExact(cap, vault.decimals)
  const a = parseUnitsExact(ceiling, vault.decimals)
  const warn = c !== null && a !== null && c > 0n && a > 0n ? capsWarning(c, a) : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const bad = capsRefusal(c, a, vault.decimals)
    if (bad || c === null || a === null) {
      setInvalid(bad ?? 'Enter both limits.')
      return
    }
    setInvalid(null)
    void act('policy', { fn: 'setPolicy', dailyCap: c, autoApproveMax: a, allowlistEnabled: allowlist })
  }

  return (
    <details className="rounded-xl border border-border bg-background/60 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Change the policy (daily cap, per-payment ceiling, allowlist)
      </summary>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
        <div>
          <label htmlFor={`cap-${id}`} className="text-[11px] font-semibold text-foreground/65">
            Daily cap (USDC, above 0)
          </label>
          <input id={`cap-${id}`} inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} className={INPUT} />
        </div>
        <div>
          <label htmlFor={`ceiling-${id}`} className="text-[11px] font-semibold text-foreground/65">
            Largest auto-approved payment (USDC, above 0)
          </label>
          <input id={`ceiling-${id}`} inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} className={INPUT} />
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={allowlist} onChange={(e) => setAllowlist(e.target.checked)} className="h-4 w-4 accent-accent" />
          Enforce the allowlist
        </label>
        {allowlist && !vault.allowlistEnabled && (
          <p className="text-xs text-foreground/75 sm:col-span-3">
            With the allowlist on, the agent can pay only payees the owner has added with setAllowed. This page does not add payees, so
            turning it on here blocks every agent payment until payees are added.
          </p>
        )}
        {warn && <p className="text-xs text-foreground/75 sm:col-span-3">{warn}</p>}
        <div className="sm:col-span-3">
          <Button type="submit" size="sm" disabled={busy !== null || held}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {working(busy, step, 'Set the policy')}
          </Button>
          <span className="ml-2 text-xs text-foreground/60">0 is refused: in this contract 0 means no limit.</span>
        </div>
      </form>
      {invalid && (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
      {failure && (
        <div className="mt-3">
          <FailureNotice failure={failure} />
        </div>
      )}
    </details>
  )
}

function OperatorControl(props: Shared) {
  const { vault, held } = props
  const [operator, setOperator] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)
  const { busy, step, failure, act } = useOwnerAction(props)
  const id = `operator-${vault.address.slice(2, 10)}`

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const bad = operatorRefusal(operator, { owner: vault.owner, usdc: vault.usdc, vault: vault.address })
    if (bad) {
      setInvalid(bad)
      return
    }
    setInvalid(null)
    void act('operator', { fn: 'setOperator', operator: operator.trim() })
  }

  return (
    <details className="rounded-xl border border-border bg-background/60 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Replace the operator (the agent's key)
      </summary>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <label htmlFor={id} className="text-[11px] font-semibold text-foreground/65">
            New operator address (a key the agent holds, never the owner)
          </label>
          <input
            id={id}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            placeholder="0x..."
            className={`${INPUT} font-mono text-xs`}
          />
        </div>
        <Button type="submit" size="sm" disabled={busy !== null || held}>
          {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {working(busy, step, 'Replace the operator')}
        </Button>
      </form>
      <p className="mt-2 text-[11px] text-foreground/60">
        The current operator key stops working the moment this lands. The session key expiry stays as it is.
      </p>
      {invalid && (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
      {failure && (
        <div className="mt-3">
          <FailureNotice failure={failure} />
        </div>
      )}
    </details>
  )
}

/** Withdraw in two steps: a form that prepares and simulates, then a review whose Confirm opens the wallet. */
function WithdrawControl(props: Shared) {
  const { chain, vault, provider, onSubmitted, held } = props
  const [amount, setAmount] = useState('')
  const [to, setTo] = useState<string>(vault.owner)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<PreparedTx | null>(null)
  const { busy, step, failure, setFailure, run } = useArcTx()
  const id = vault.address.slice(2, 10)
  const max = formatUnitsExact(vault.balance, vault.decimals)

  const call = (): OwnerCall | null => {
    const raw = parseUnitsExact(amount, vault.decimals)
    const bad = withdrawRefusal({ to, amount: raw, balance: vault.balance, vault: vault.address, usdc: vault.usdc, decimals: vault.decimals })
    if (bad || raw === null) {
      setInvalid(bad ?? 'Enter an amount.')
      return null
    }
    setInvalid(null)
    return { fn: 'withdraw', to: to.trim(), amount: raw }
  }

  const review = (e: FormEvent) => {
    e.preventDefault()
    setFailure(null)
    const c = call()
    if (!c) return
    void run('prepare', async (onStep) => {
      onStep('simulating')
      const p = await prepareOwnerCall(chain, vault, c)
      setPrepared(p)
      return p
    })
  }

  const confirm = () => {
    if (!prepared) return
    void run('confirm', async (onStep) => {
      let p = prepared
      if (preparedStale(p)) {
        const c = call()
        if (!c) return null
        onStep('simulating')
        p = await prepareOwnerCall(chain, vault, c)
      }
      const hash = await sendPrepared(provider, p, onStep)
      onSubmitted(recordOf(p, hash, vault.address))
      track('arc_vault_owner_action', { network: networkWord(chain), action: 'withdraw', outcome: 'submitted' })
      setPrepared(null)
      setAmount('')
      return hash
    })
  }

  const raw = parseUnitsExact(amount, vault.decimals)
  return (
    <Card title="Withdraw USDC">
      {prepared ? (
        <div className="space-y-3">
          <PreparedView p={prepared} decimals={vault.decimals} />
          {raw !== null && aboveSoftWarn(raw, vault.decimals) && (
            <p className="text-xs font-semibold text-warn">This is more than 10 USDC. Check the destination address character by character.</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={confirm} disabled={busy !== null || held}>
              {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
              {working(busy, step, 'Confirm in wallet')}
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
        </div>
      ) : (
        <form onSubmit={review} className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
          <div>
            <label htmlFor={`withdraw-amount-${id}`} className="text-[11px] font-semibold text-foreground/65">
              Amount (USDC)
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id={`withdraw-amount-${id}`}
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className={INPUT}
              />
              <button
                type="button"
                onClick={() => setAmount(max)}
                className="mt-1 shrink-0 rounded-lg border border-border px-2 py-2 text-xs font-semibold text-foreground/75 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Max
              </button>
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor={`withdraw-to-${id}`} className="text-[11px] font-semibold text-foreground/65">
              Destination (defaults to your owner account)
            </label>
            <input
              id={`withdraw-to-${id}`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={`${INPUT} font-mono text-xs`}
            />
          </div>
          <Button type="submit" size="sm" disabled={busy !== null || held}>
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {working(busy, step, 'Review')}
          </Button>
        </form>
      )}
      {!prepared && (
        <p className="mt-2 text-[11px] text-foreground/55">
          Review simulates the exact withdraw call as the owner. Nothing is signed until you confirm on the next screen.
        </p>
      )}
      {invalid && (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
      {failure && (
        <div className="mt-3">
          <FailureNotice failure={failure} />
        </div>
      )}
    </Card>
  )
}

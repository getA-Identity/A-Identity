/**
 * The owner's controls on a testnet vault whose owner is the wallet connected here.
 *
 * The page mounts this only after it has established, from a live read, that the connected
 * account IS the owner, that the wallet reports the vault's network, and that the vault is
 * on testnet. It is never mounted for a pubnet vault, so no pubnet control exists to be
 * enabled by mistake.
 *
 * Each action is prepared by the backend, signed by the wallet as a whole transaction whose
 * source is the owner account (so the owner pays the fee and no separate auth entry exists),
 * and submitted by the backend. The backend can build and broadcast; it cannot sign.
 */
import { useState, type FormEvent, type ReactNode } from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { ownerAction, STEP_LABEL } from '../../../lib/stellar/vault'
import { parseAmount, type VaultRead } from '../../../lib/stellar/vault-read'
import type { WalletSigner } from '../../../lib/wallet/types'
import FailureNotice from './FailureNotice'
import FreezeButton from './FreezeButton'
import type { Receipt } from './TxReceipt'
import WithdrawFlow from './WithdrawFlow'
import { Mono } from './bits'
import { useOwnerSession } from './useOwnerSession'
import { receiptOf, useOwnerRun } from './useOwnerRun'

export default function OwnerControls({
  vault,
  signer,
  onReceipt,
}: {
  vault: VaultRead
  signer: WalletSigner
  onReceipt: (r: Receipt) => void
}) {
  const session = useOwnerSession(signer.address, signer)

  const signInButton = (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void session.signIn()}
        disabled={session.signingIn}
        className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {session.signingIn ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <LogIn size={12} aria-hidden="true" />}
        {session.signingIn ? 'Waiting for your wallet...' : 'Sign in with this wallet'}
      </button>
      {session.error && <span className="text-xs font-semibold text-danger">{session.error}</span>}
    </span>
  )

  if (session.cover === 'checking')
    return <p className="text-sm text-foreground/65">Checking whether your session can prepare calls for this account...</p>

  if (session.cover !== 'covered')
    return (
      <div className="space-y-2">
        <FailureNotice
          failure={{ code: 'no_session', message: '' }}
          owner={vault.owner}
          network={vault.network}
          signIn={signInButton}
        />
        {session.cover === 'other-account' && (
          <p className="text-xs text-foreground/65">
            You are signed in as {session.sessionAddress ? <Mono>{session.sessionAddress}</Mono> : 'another account'}, which is not this
            wallet and does not have it linked. Signing in with this wallet replaces that session. To keep it instead, link this wallet
            from your Profile page.
          </p>
        )}
      </div>
    )

  return (
    <div className="space-y-4">
      <section aria-label="Freeze" className="rounded-xl border border-border bg-background/60 p-4">
        <h4 className="text-sm font-semibold text-foreground">Freeze</h4>
        <div className="mt-2">
          <FreezeButton
            network={vault.network}
            contract={vault.contract}
            owner={vault.owner}
            frozen={vault.frozen}
            onReceipt={onReceipt}
            signIn={signInButton}
          />
        </div>
      </section>

      <section aria-label="Withdraw" className="rounded-xl border border-border bg-background/60 p-4">
        <h4 className="text-sm font-semibold text-foreground">Withdraw {vault.tokenSymbol || 'USDC'} to an account</h4>
        <div className="mt-2">
          <WithdrawFlow
            network={vault.network}
            contract={vault.contract}
            owner={vault.owner}
            balance={vault.balance}
            decimals={vault.decimals}
            tokenSymbol={vault.tokenSymbol}
            onReceipt={onReceipt}
            signIn={signInButton}
          />
        </div>
      </section>

      <PolicyForm vault={vault} onReceipt={onReceipt} signIn={signInButton} />
    </div>
  )
}

/**
 * The policy itself, as a secondary form: daily cap, the single-payment ceiling, and
 * whether the allowlist is enforced. All three are sent together because set_policy takes
 * all three; the form starts from the live values so an untouched field stays as it is.
 */
function PolicyForm({ vault, onReceipt, signIn }: { vault: VaultRead; onReceipt: (r: Receipt) => void; signIn: ReactNode }) {
  const [cap, setCap] = useState(vault.dailyCap.display)
  const [ceiling, setCeiling] = useState(vault.autoApproveMax.display)
  const [allowlist, setAllowlist] = useState(vault.allowlistEnabled)
  const [invalid, setInvalid] = useState<string | null>(null)
  const { busy, step, failure, run } = useOwnerRun()
  const sym = vault.tokenSymbol || 'USDC'
  const id = vault.contract.slice(0, 8)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const c = parseAmount(cap, vault.decimals)
    const a = parseAmount(ceiling, vault.decimals)
    if (c === null || a === null) {
      setInvalid(`Enter amounts from 0 upward, with at most ${vault.decimals} decimal places. 0 means no limit.`)
      return
    }
    setInvalid(null)
    void run('policy', async (onStep) => {
      const r = await ownerAction({
        network: vault.network,
        contract: vault.contract,
        source: vault.owner,
        action: 'set_policy',
        args: { dailyCapUsd: Number(cap.trim()), autoApproveUsd: Number(ceiling.trim()), allowlistEnabled: allowlist },
        onStep,
      })
      onReceipt(receiptOf('Policy change', vault.network, r))
      return r
    })
  }

  return (
    <details className="rounded-xl border border-border bg-background/60 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Change the policy (daily cap, per-payment ceiling, allowlist)
      </summary>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3 sm:items-end">
        <div>
          <label htmlFor={`cap-${id}`} className="text-[11px] font-semibold text-foreground/65">
            Daily cap ({sym}, 0 = none)
          </label>
          <input
            id={`cap-${id}`}
            inputMode="decimal"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div>
          <label htmlFor={`ceiling-${id}`} className="text-[11px] font-semibold text-foreground/65">
            Largest auto-approved payment ({sym}, 0 = none)
          </label>
          <input
            id={`ceiling-${id}`}
            inputMode="decimal"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={allowlist} onChange={(e) => setAllowlist(e.target.checked)} className="h-4 w-4 accent-accent" />
          Enforce the allowlist
        </label>
        <div className="sm:col-span-3">
          <button
            type="submit"
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
            {busy ? `${step ? STEP_LABEL[step] : 'Working'}...` : 'Set the policy'}
          </button>
          <span className="ml-2 text-xs text-foreground/60">Your wallet prompt shows the call and the fee before anything is signed.</span>
        </div>
      </form>
      {invalid && (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger">
          {invalid}
        </p>
      )}
      {failure && (
        <div className="mt-3">
          <FailureNotice failure={failure} owner={vault.owner} network={vault.network} signIn={signIn} />
        </div>
      )}
    </details>
  )
}

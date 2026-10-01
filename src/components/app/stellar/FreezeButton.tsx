/**
 * Freeze or unfreeze, in one click.
 *
 * There is no "are you sure" dialog on purpose: the wallet's own prompt, which shows the
 * call and the fee, IS the confirmation, and a freeze is the control an owner reaches for
 * when something is going wrong, so it should not take two screens. Freeze and Unfreeze
 * are the same button at the same weight; neither is tucked away as the lesser option.
 */
import { Loader2, Snowflake, Sun } from 'lucide-react'
import { ownerAction, STEP_LABEL } from '../../../lib/stellar/vault'
import FailureNotice from './FailureNotice'
import type { Receipt } from './TxReceipt'
import { receiptOf, useOwnerRun } from './useOwnerRun'
import type { ReactNode } from 'react'

export default function FreezeButton({
  network,
  contract,
  owner,
  frozen,
  onReceipt,
  signIn,
}: {
  network: string
  contract: string
  owner: string
  frozen: boolean
  onReceipt: (r: Receipt) => void
  signIn?: ReactNode
}) {
  const { busy, step, failure, run } = useOwnerRun()
  const next = !frozen
  const what = next ? 'Freeze' : 'Unfreeze'

  const go = () =>
    void run('freeze', async (onStep) => {
      const r = await ownerAction({ network, contract, source: owner, action: 'set_frozen', args: { frozen: next }, onStep })
      onReceipt(receiptOf(what, network, r))
      return r
    })

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={go}
          disabled={busy !== null}
          className="inline-flex min-w-[9rem] items-center justify-center gap-2 rounded-full border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : next ? (
            <Snowflake size={14} className="text-danger" aria-hidden="true" />
          ) : (
            <Sun size={14} className="text-ok" aria-hidden="true" />
          )}
          {busy ? `${step ? STEP_LABEL[step] : 'Working'}...` : next ? 'Freeze the vault' : 'Unfreeze the vault'}
        </button>
        <span className="text-xs text-foreground/65">
          {frozen
            ? 'Frozen on-chain: every agent payment reverts. Unfreezing lets the policy decide again.'
            : 'Freezing stops every agent payment on-chain, not just on our server. Your wallet prompt is the confirmation.'}
        </span>
      </div>
      {failure && <FailureNotice failure={failure} owner={owner} network={network} signIn={signIn} />}
    </div>
  )
}

/**
 * The line that comes before any control: is the connected account this vault's owner?
 *
 * Read off the vault's live owner() in the same snapshot as everything else, never off our own
 * records, and compared case-insensitively. For our own launch-day vault the line also says
 * whose key the owner is, because "not you" alone would leave the reader guessing.
 */
import { CheckCircle2, ShieldAlert } from 'lucide-react'
import type { VaultSnapshot } from '../../../lib/arc/vault-read'
import { sameAddress } from '../../../lib/arc/vault-rules'
import { Mono } from '../stellar/bits'

export default function OwnerMatch({ vault, account, ownerIsOurKey }: { vault: VaultSnapshot; account: string | null; ownerIsOurKey: boolean }) {
  if (!account)
    return (
      <p className="text-sm text-foreground/70">
        {ownerIsOurKey
          ? 'The owner this contract names is one of our own keys, so no visitor can act on this vault here. Reading it needs no wallet.'
          : 'Connect an EVM wallet above to see whether you own this vault. Reading it needs no wallet.'}
      </p>
    )

  if (sameAddress(account, vault.owner))
    return (
      <div className="flex items-start gap-2 text-sm text-foreground">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
        <p>
          Connected account <Mono>{account}</Mono> IS the owner of this vault.
        </p>
      </div>
    )

  return (
    <div className="flex items-start gap-2 text-sm text-foreground">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
      <p>
        Connected account <Mono>{account}</Mono> is NOT the owner (owner is <Mono>{vault.owner}</Mono>
        {ownerIsOurKey ? ', one of our own keys' : ''}). Owner controls are hidden.
        {ownerIsOurKey ? '' : ' To act on this vault, pick the owner account in your wallet.'}
      </p>
    </div>
  )
}

/**
 * The line that comes before any control: is the connected account this vault's owner?
 *
 * Read off the vault's live owner() in the same read as everything else, never off our
 * own records. When the owner is a passkey smart account (C...), no browser wallet can sign
 * for it, so the line says where its controls live instead of offering any here.
 */
import { Link } from 'react-router-dom'
import { CheckCircle2, ShieldAlert } from 'lucide-react'
import type { VaultRead } from '../../../lib/stellar/vault-read'
import { Mono } from './bits'

export default function OwnerMatch({ vault, address }: { vault: VaultRead; address: string | null }) {
  // A passkey-owned vault is answered the same way with or without a wallet: no browser
  // wallet can be its owner, so asking the reader to connect one would send them nowhere.
  if (!address && vault.ownerKind === 'smart-account')
    return (
      <div className="flex items-start gap-2 text-sm text-foreground">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
        <p>
          The owner is a passkey smart account, <Mono>{vault.owner}</Mono>, whose calls are signed by a device passkey rather than a
          wallet. Its controls live on{' '}
          <Link to="/stellar" className="font-semibold text-accent underline underline-offset-2">
            the Stellar passkey page
          </Link>
          . No controls are offered here.
        </p>
      </div>
    )

  if (!address)
    return (
      <p className="text-sm text-foreground/70">
        Connect a Stellar wallet above to see whether you own this vault. Reading it needs no wallet.
      </p>
    )

  if (vault.ownerKind === 'smart-account')
    return (
      <div className="flex items-start gap-2 text-sm text-foreground">
        <ShieldAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
        <p>
          Connected account <Mono>{address}</Mono> is NOT the owner. The owner is a passkey smart account,{' '}
          <Mono>{vault.owner}</Mono>, whose calls are signed by a device passkey rather than a wallet. Its controls live on{' '}
          <Link to="/stellar" className="font-semibold text-accent underline underline-offset-2">
            the Stellar passkey page
          </Link>
          . No controls are offered here.
        </p>
      </div>
    )

  if (address === vault.owner)
    return (
      <div className="flex items-start gap-2 text-sm text-foreground">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
        <p>
          Connected account <Mono>{address}</Mono> IS the owner of this vault.
        </p>
      </div>
    )

  return (
    <div className="flex items-start gap-2 text-sm text-foreground">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
      <p>
        Connected account <Mono>{address}</Mono> is NOT the owner (owner is <Mono>{vault.owner}</Mono>). Owner controls are hidden. To
        act on this vault, pick the owner account inside your wallet and connect again.
      </p>
    </div>
  )
}

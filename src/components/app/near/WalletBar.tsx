/**
 * The NEAR wallet strip: connect through NEAR Connect, which account, and whether it is this
 * vault's owner. Optional by design: with no wallet the strip says so plainly and every read on
 * the page still works.
 */
import { Loader2, LogOut, Wallet } from 'lucide-react'
import { Button } from '../../ui/button'
import { CopyButton, Pill } from './ui'
import type { NearWalletState } from './useNearWallet'

export default function WalletBar({ wallet, ownerId }: { wallet: NearWalletState; ownerId: string | null }) {
  const { status, accountId, walletName, walletIcon, error } = wallet
  const busy = status === 'connecting' || status === 'restoring'
  const isOwner = Boolean(accountId && ownerId && accountId === ownerId)
  return (
    <section aria-label="Your NEAR wallet" className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3 sm:items-center">
          <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl bg-foreground/[0.05]">
            {walletIcon ? <img src={walletIcon} alt="" className="h-6 w-6 object-contain" /> : <Wallet size={17} className="text-foreground/80" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {accountId ? `${walletName ?? 'NEAR wallet'} connected` : status === 'restoring' ? 'Restoring your NEAR wallet...' : 'Your NEAR wallet'}
            </div>
            {accountId ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-foreground/80">
                <span className="break-all font-mono text-foreground">{accountId}</span>
                <CopyButton text={accountId} label="Copy" />
                {ownerId && (isOwner ? <Pill tone="ok">This vault's owner</Pill> : <Pill tone="muted">Not this vault's owner</Pill>)}
              </div>
            ) : (
              <p className="mt-0.5 max-w-xl text-xs text-foreground/75">
                Optional. Reading the vault needs no wallet. Its owner connects to freeze it, approve held payments or change its limits. Testnet
                wallets: Meteor, Intear, Nightly, Ledger and NEAR CLI (MyNearWallet and HOT do not support testnet).
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {accountId ? (
            <Button size="sm" variant="outline" onClick={() => void wallet.disconnect()} title="This page stops using the wallet. The wallet itself keeps its account.">
              <LogOut size={13} aria-hidden="true" />
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={() => void wallet.connect()} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Wallet size={13} aria-hidden="true" />}
              {status === 'connecting' ? 'Waiting for the wallet...' : 'Connect NEAR wallet'}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-danger/35 bg-danger/[0.07] px-3 py-2 text-xs text-foreground">
          <span className="font-semibold">The wallet did not connect: </span>
          {error}
        </p>
      )}
    </section>
  )
}

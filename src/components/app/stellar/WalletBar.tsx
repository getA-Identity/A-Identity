/**
 * The Stellar wallet strip at the top of the vault page: connect, which account, which
 * network the WALLET reports, disconnect.
 *
 * The network shown is what the wallet says, read and never set. A wallet that cannot say
 * is labelled so, because owner signing is blocked for it further down. With no Stellar
 * wallet installed the strip says so and links to Freighter; the read panel below works
 * the same either way.
 */
import { useState } from 'react'
import { Loader2, RefreshCw, Wallet } from 'lucide-react'
import { stellarNetworkLabel } from '../../../lib/stellar/kit'
import { FREIGHTER_URL, shortId } from '../../../lib/stellar/vault-read'
import { Chip, CopyButton } from './bits'
import type { StellarWalletState } from './useStellarWallet'

export default function WalletBar({ wallet }: { wallet: StellarWalletState }) {
  const [picking, setPicking] = useState(false)
  const { detect, wallets, signer, network, busy, error } = wallet
  const freighter = wallets.find((w) => /freighter/i.test(w.id) || /freighter/i.test(w.name))
  const installed = wallets.filter((w) => w.isAvailable)

  return (
    <section aria-label="Stellar wallet" className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <Wallet size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {signer ? `${signer.walletName || 'Stellar wallet'} connected` : 'Stellar wallet'}
            </div>
            {signer ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-foreground/70">
                <span className="font-mono" title={signer.address}>
                  {shortId(signer.address)}
                </span>
                <CopyButton text={signer.address} label="Copy address" />
                {network === null ? (
                  <Chip tone="muted">Reading network...</Chip>
                ) : !network.reported ? (
                  <Chip tone="warn">Network not reported by this wallet</Chip>
                ) : network.network ? (
                  <Chip tone={network.network === 'stellar:testnet' ? 'accent' : 'warn'}>
                    Wallet reports {stellarNetworkLabel(network.network)}
                  </Chip>
                ) : (
                  <Chip tone="warn">Wallet is on a network that is neither testnet nor pubnet</Chip>
                )}
                <button
                  type="button"
                  onClick={() => void wallet.recheckNetwork()}
                  aria-label="Read the wallet's network again"
                  title="Read the wallet's network again"
                  className="rounded-md p-1 text-foreground/55 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RefreshCw size={12} />
                </button>
              </div>
            ) : (
              <div className="mt-0.5 text-xs text-foreground/65">
                {detect === 'checking'
                  ? 'Looking for Stellar wallets in this browser...'
                  : detect === 'none'
                    ? 'No Stellar wallet is installed. Reading vaults works without one.'
                    : detect === 'failed'
                      ? 'Could not load the wallet list. Reading vaults works without it.'
                      : wallet.rememberedAddress
                        ? `${wallet.rememberedName ?? 'A wallet'} (${shortId(wallet.rememberedAddress)}) was connected earlier. Connect again to sign in this tab.`
                        : 'Optional. Connect to see whether you own a vault and to act on a testnet vault you own.'}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {signer ? (
            <button
              type="button"
              onClick={() => void wallet.disconnect()}
              disabled={busy}
              className="rounded-full border border-border px-3.5 py-1.5 text-xs font-semibold text-foreground/75 hover:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : detect === 'none' || detect === 'failed' ? (
            <a
              href={freighter?.url || FREIGHTER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Install Freighter
            </a>
          ) : (
            <button
              type="button"
              onClick={() => setPicking((v) => !v)}
              disabled={busy || detect === 'checking'}
              aria-expanded={picking}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              {busy ? 'Waiting for the wallet...' : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>

      {/* The module picker: installed wallets only, the kit's own names and icons. */}
      {picking && !signer && installed.length > 0 && (
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2" aria-label="Installed Stellar wallets">
          {installed.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPicking(false)
                  void wallet.connect(w.id)
                }}
                className="flex w-full items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {w.icon ? <img src={w.icon} alt="" className="h-5 w-5 rounded object-contain" /> : <Wallet size={16} aria-hidden="true" />}
                {w.name}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mt-3 text-xs font-semibold text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

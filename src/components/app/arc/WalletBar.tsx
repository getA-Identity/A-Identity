/**
 * The EVM wallet strip at the top of the Arc vault page: connect, which account, which chain
 * the WALLET reports, a button to switch it to the vault's chain, and how much USDC the account
 * holds for gas there (read from the chain, not from the wallet).
 *
 * Optional by design. With no wallet the strip says so plainly and every read below still
 * works: a vault's state is public, and checking it needs no wallet and no account.
 */
import { useEffect, useState } from 'react'
import { Loader2, QrCode, RefreshCw, Wallet } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import { networkName, readNativeBalance, shortAddress } from '../../../lib/arc/vault-read'
import { formatUnitsExact } from '../../../lib/arc/vault-rules'
import { Button } from '../../ui/button'
import { Chip, CopyButton } from '../stellar/bits'
import type { ArcWalletState } from './useArcWallet'

export default function WalletBar({ wallet, target }: { wallet: ArcWalletState; target: Chain }) {
  const [picking, setPicking] = useState(false)
  const [gas, setGas] = useState<{ key: string; wei: bigint | null } | null>(null)
  const { options, looked, account, chainId, busy, error } = wallet
  const onTarget = chainId === target.chainId
  const gasKey = account ? `${target.id}:${account}` : ''

  // The account's USDC on the target chain, read from the registry RPCs. On Arc the gas
  // token IS USDC, so this is also what every fee below is paid from.
  useEffect(() => {
    if (!account) return
    let alive = true
    const key = `${target.id}:${account}`
    void readNativeBalance(target, account).then((wei) => {
      if (alive) setGas({ key, wei })
    })
    return () => {
      alive = false
    }
  }, [account, target])

  const shownGas = gas && gas.key === gasKey ? gas.wei : undefined
  const noWallet = looked && options.length === 0 && !wallet.walletConnect

  return (
    <section aria-label="Your wallet" className="rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
            <Wallet size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {account ? `${wallet.wallet?.name ?? 'Your wallet'} connected` : 'Your wallet'}
            </div>
            {account ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-foreground/70">
                <span className="font-mono" title={account}>
                  {shortAddress(account)}
                </span>
                <CopyButton text={account} label="Copy address" />
                {chainId === null ? (
                  <Chip tone="muted">Chain not reported</Chip>
                ) : onTarget ? (
                  <Chip tone={target.testnet ? 'accent' : 'ok'}>Wallet reports {networkName(target)}</Chip>
                ) : (
                  <Chip tone="warn">Wallet is on chain {chainId}, not {networkName(target)}</Chip>
                )}
                <button
                  type="button"
                  onClick={() => void wallet.refresh()}
                  aria-label="Read the wallet's account and chain again"
                  title="Read the wallet's account and chain again"
                  className="rounded-md p-1 text-foreground/55 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RefreshCw size={12} aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="mt-0.5 text-xs text-foreground/65">
                {!looked
                  ? 'Looking for wallets in this browser...'
                  : noWallet
                    ? 'No wallet found in this browser. You can read any vault without one. To deploy or run a vault you need a wallet such as Rabby or MetaMask: install one, then reload this page.'
                    : 'Optional. Connect to deploy a vault you own, or to run one you already own. Reading needs no wallet.'}
              </div>
            )}
            {account && (
              <div className="mt-1 text-[11px] text-foreground/60">
                Your USDC on {networkName(target)}:{' '}
                {shownGas === undefined ? (
                  'reading...'
                ) : shownGas === null ? (
                  'could not be read'
                ) : (
                  <span className="font-semibold tabular-nums text-foreground/80">
                    {formatUnitsExact(shownGas, target.nativeCurrency.decimals)} USDC
                  </span>
                )}
                <span className="text-foreground/50"> (on Arc, this same balance pays every network fee)</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {account && chainId !== null && !onTarget && (
            <Button size="sm" onClick={() => void wallet.switchTo(target)} disabled={busy}>
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
              Switch to {networkName(target)}
            </Button>
          )}
          {account ? (
            <Button size="sm" variant="outline" onClick={wallet.disconnect} disabled={busy}>
              Forget this wallet
            </Button>
          ) : (
            !noWallet && (
              <Button size="sm" onClick={() => setPicking((v) => !v)} disabled={busy || !looked} aria-expanded={picking}>
                {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
                {busy ? 'Waiting for the wallet...' : 'Connect wallet'}
              </Button>
            )
          )}
        </div>
      </div>

      {picking && !account && (
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2" aria-label="Wallets you can connect">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPicking(false)
                  void wallet.connect(o, target)
                }}
                className="flex w-full items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {o.icon ? <img src={o.icon} alt="" className="h-5 w-5 rounded object-contain" /> : <Wallet size={16} aria-hidden="true" />}
                {o.name}
              </button>
            </li>
          ))}
          {wallet.walletConnect && (
            <li>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setPicking(false)
                  void wallet.connect('walletconnect', target)
                }}
                className="flex w-full items-center gap-2.5 rounded-xl border border-border px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <QrCode size={16} aria-hidden="true" />
                Phone wallet (WalletConnect)
              </button>
            </li>
          )}
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

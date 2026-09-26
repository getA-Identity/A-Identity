import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, Lock, QrCode, Wallet, X } from 'lucide-react'
import { Button } from '../ui/button'
import { ALGORAND_WALLETS, algorandWalletError, connectAlgorand, reconnectAlgorand, type AlgorandWalletId } from '../../lib/algorand/wallet'
import type { PayWallet } from '../../lib/algorand/purchase'
import { fetchUsdcHolding, formatUsdc, holdingUsdc } from '../../lib/algorand/x402pay'
import type { WalletSigner } from '../../lib/wallet/types'
import { shortAddress } from './format'
import { CheckWalletContext, useCheckWallet, type Balance, type CheckWallet } from './walletContext'

/**
 * The Algorand wallet the /check page pays from. Connected once, from the wallet bar or from
 * the first Pay; remembered for this tab (which wallet, never an address) and picked up again
 * silently on load where the wallet can do that without a prompt (Pera and Defly keep a
 * session; Lute has none to resume, so it asks again). Nothing is ever picked for the
 * visitor: the list is one flat list, and a wallet's own error message is shown as it is.
 */

const LAST_WALLET = 'a-identity:check-wallet'

type ListState = { mode: 'connect' } | { mode: 'pay'; price: string }
type Answer = PayWallet | 'cancelled' | null

function lastWallet(): AlgorandWalletId | null {
  try {
    const v = window.sessionStorage.getItem(LAST_WALLET)
    return ALGORAND_WALLETS.some((w) => w.id === v) ? (v as AlgorandWalletId) : null
  } catch {
    return null
  }
}

function rememberWallet(id: AlgorandWalletId | null): void {
  try {
    if (id) window.sessionStorage.setItem(LAST_WALLET, id)
    else window.sessionStorage.removeItem(LAST_WALLET)
  } catch {
    /* storage can be off; the wallet still works for this page view */
  }
}

export function CheckWalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<PayWallet | null>(null)
  const signer = useRef<WalletSigner | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [balance, setBalance] = useState<Balance | null>(null)
  const [tick, setTick] = useState(0)
  const [list, setList] = useState<ListState | null>(null)
  const [busy, setBusy] = useState<AlgorandWalletId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [holds, setHolds] = useState(0)
  /** The payment waiting on the list, if it was opened for one. */
  const pending = useRef<((a: Answer) => void) | null>(null)
  /** Which connect attempt is current: a wallet that answers after a cancel or a close is ignored. */
  const seq = useRef(0)

  const answer = useCallback((a: Answer) => {
    const resolve = pending.current
    pending.current = null
    resolve?.(a)
  }, [])

  // A wallet used earlier in this tab, picked up without a prompt, or not at all.
  useEffect(() => {
    const id = lastWallet()
    if (!id || ALGORAND_WALLETS.find((w) => w.id === id)?.kind !== 'mobile') return
    let alive = true
    setRestoring(true)
    void reconnectAlgorand(id).then((s) => {
      if (!alive) return
      setRestoring(false)
      // A wallet connected by hand while this was running wins.
      if (!s || signer.current) return
      signer.current = s
      setWallet({ id, name: s.walletName, address: s.address })
    })
    return () => {
      alive = false
    }
  }, [])

  // Nobody is left waiting on a list that is gone.
  useEffect(() => () => answer(null), [answer])

  const address = wallet?.address ?? null
  useEffect(() => {
    if (!address) {
      setBalance(null)
      return
    }
    let alive = true
    // A refresh keeps the number it had until the new one is in.
    setBalance((b) => (b && b.address === address && b.s === 'ok' ? b : { s: 'loading', address }))
    fetchUsdcHolding(address).then(
      (holding) => alive && setBalance({ s: 'ok', address, holding }),
      () => alive && setBalance({ s: 'error', address }),
    )
    return () => {
      alive = false
    }
  }, [address, tick])

  const pick = async (id: AlgorandWalletId) => {
    if (busy) return
    const name = ALGORAND_WALLETS.find((w) => w.id === id)?.name ?? 'Your wallet'
    const mine = ++seq.current
    setBusy(id)
    setError(null)
    try {
      const s = await connectAlgorand(id)
      if (mine !== seq.current) return
      signer.current = s
      const w: PayWallet = { id, name, address: s.address }
      setWallet(w)
      rememberWallet(id)
      setBusy(null)
      setList(null)
      answer(w)
    } catch (e) {
      if (mine !== seq.current) return
      const we = algorandWalletError(e)
      setBusy(null)
      if (we.cancelled) {
        setList(null)
        answer('cancelled')
      } else setError(we.message || `${name} could not connect.`)
    }
  }

  /** Stop waiting for the wallet; the list stays open for another choice. */
  const stopWaiting = () => {
    seq.current += 1
    setBusy(null)
  }

  const close = useCallback(() => {
    seq.current += 1
    setBusy(null)
    setError(null)
    setList(null)
    answer(null)
  }, [answer])

  const openConnect = useCallback(() => {
    setError(null)
    setList({ mode: 'connect' })
  }, [])

  const askWallet = useCallback(
    (price: string) =>
      new Promise<Answer>((resolve) => {
        answer(null)
        pending.current = resolve
        seq.current += 1
        setBusy(null)
        setError(null)
        setList({ mode: 'pay', price })
      }),
    [answer],
  )

  const disconnect = useCallback(() => {
    const s = signer.current
    signer.current = null
    setWallet(null)
    rememberWallet(null)
    void s?.disconnect?.().catch(() => undefined)
  }, [])

  const refreshBalance = useCallback(() => setTick((t) => t + 1), [])

  const holdPayment = useCallback(() => {
    let held = true
    setHolds((h) => h + 1)
    return () => {
      if (!held) return
      held = false
      setHolds((h) => h - 1)
    }
  }, [])

  const value = useMemo<CheckWallet>(
    () => ({ wallet, restoring, balance, openConnect, askWallet, disconnect, refreshBalance, paying: holds > 0, holdPayment }),
    [wallet, restoring, balance, openConnect, askWallet, disconnect, refreshBalance, holds, holdPayment],
  )

  return (
    <CheckWalletContext.Provider value={value}>
      {children}
      {list && <WalletList list={list} busy={busy} error={error} onPick={(id) => void pick(id)} onStopWaiting={stopWaiting} onClose={close} />}
    </CheckWalletContext.Provider>
  )
}

/** One flat list of the three Algorand wallets. Nothing is picked for the visitor. */
function WalletList({
  list,
  busy,
  error,
  onPick,
  onStopWaiting,
  onClose,
}: {
  list: ListState
  busy: AlgorandWalletId | null
  error: string | null
  onPick: (id: AlgorandWalletId) => void
  onStopWaiting: () => void
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const busyName = ALGORAND_WALLETS.find((w) => w.id === busy)?.name
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/45 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="algorand-wallet-title"
        className="w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h3 id="algorand-wallet-title" className="text-lg font-bold tracking-tight text-foreground">
              {list.mode === 'pay' ? 'Pay with' : 'Connect a wallet'}
            </h3>
            <p className="mt-0.5 text-sm text-foreground/55">Pick the Algorand wallet that holds your USDC.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-border text-foreground/50 transition-colors hover:text-foreground"
          >
            <X size={15} />
          </button>
        </div>
        <div className="flex flex-col gap-1 p-3">
          {error && (
            <p role="alert" className="mb-1 rounded-xl border border-danger/25 bg-danger/10 px-3 py-2 text-xs font-semibold text-danger">
              {error}
            </p>
          )}
          {ALGORAND_WALLETS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => onPick(w.id)}
              disabled={busy !== null}
              className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-background/60">
                {busy === w.id ? (
                  <Loader2 size={18} className="animate-spin text-accent" />
                ) : w.kind === 'mobile' ? (
                  <QrCode size={18} className="text-foreground/55" />
                ) : (
                  <Wallet size={18} className="text-foreground/55" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-foreground">{w.name}</span>
                <span className="block text-[11px] text-foreground/50">{w.kind === 'mobile' ? 'Phone app, scan a code' : 'Browser extension'}</span>
              </span>
            </button>
          ))}
          {busy && (
            <div className="mt-1 flex items-center justify-between gap-3 rounded-2xl border border-border bg-background/60 px-3.5 py-2.5 text-xs text-foreground/60">
              <span>Waiting for {busyName ?? 'your wallet'}. If it opened a prompt, finish it there.</span>
              <button type="button" onClick={onStopWaiting} className="shrink-0 font-semibold text-foreground/70 underline underline-offset-2 hover:text-foreground">
                Cancel
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3 text-[11px] text-foreground/50">
          <Lock size={12} className="shrink-0" />
          {list.mode === 'pay'
            ? `You approve one ${list.price} USDC payment in your wallet. Network fees are covered.`
            : 'Connecting shares your address only. You approve every payment in your wallet.'}
        </div>
      </div>
    </div>
  )
}

function balanceText(b: Balance | null, address: string): string | null {
  if (!b || b.address !== address || b.s === 'loading') return null
  if (b.s === 'error') return 'Balance unavailable'
  return b.holding.optedIn ? `${formatUsdc(holdingUsdc(b.holding))} USDC` : 'No USDC'
}

/** The wallet bar at the top of /check: connect, or the connected address, its USDC, and Disconnect. */
export function WalletBar() {
  const { wallet, restoring, balance, openConnect, disconnect, paying } = useCheckWallet()
  if (!wallet) {
    return (
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={openConnect} disabled={restoring}>
          {restoring ? <Loader2 size={14} className="animate-spin" /> : <Wallet size={14} />}
          Connect wallet
        </Button>
      </div>
    )
  }
  const usdc = balanceText(balance, wallet.address)
  return (
    <div className="flex justify-end">
      <div
        role="group"
        aria-label="Your Algorand wallet"
        className="flex max-w-full items-center gap-2 rounded-full border border-border bg-card py-1 pl-3 pr-1 text-xs"
      >
        <Wallet size={14} className="shrink-0 text-accent" aria-hidden="true" />
        <span className="hidden text-foreground/55 sm:inline">{wallet.name}</span>
        <span className="font-mono font-semibold text-foreground" title={wallet.address}>
          {shortAddress(wallet.address)}
        </span>
        <span className="h-3.5 w-px shrink-0 bg-border" aria-hidden="true" />
        {usdc ? (
          <span className="whitespace-nowrap tabular-nums text-foreground/75">{usdc}</span>
        ) : (
          <span className="h-3 w-14 animate-pulse rounded bg-foreground/[0.08]" aria-label="Reading your USDC balance" />
        )}
        <button
          type="button"
          onClick={disconnect}
          disabled={paying}
          className="rounded-full px-2.5 py-1.5 font-semibold text-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
        >
          Disconnect
        </button>
      </div>
    </div>
  )
}

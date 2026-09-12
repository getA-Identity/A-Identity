import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, QrCode, Wallet, X } from 'lucide-react'
import type { Chain } from '../../../lib/chains'
import {
  connectWalletConnect,
  currentEvmWallet,
  ensureEvmChain,
  getInjectedWallets,
  refreshInjectedWallets,
  rememberEvmWallet,
  setConnectedProvider,
  walletConnectEnabled,
  walletErrorText,
  type Eip1193,
  type EvmWallet,
  type WalletOption,
} from '../../../lib/wallets'

/**
 * Paying from an EVM wallet, in one call.
 *
 *   const payer = useEvmPayer()
 *   const { provider, from } = await payer.prepare(CHAIN_BY_ID.arc)
 *   ...render {payer.picker} somewhere in the component
 *
 * `prepare` settles which wallet pays (the one already chosen, the only one installed, or a
 * pick from a short list), connects it, and puts it on the chain, adding the chain first
 * when the wallet has never seen it. What the sign-in wallet is does not matter: someone
 * signed in with Freighter still pays an Arc call from the EVM wallet they pick here.
 */

export type PayStep = 'idle' | 'choosing' | 'connecting' | 'switching' | 'ready'

export function useEvmPayer() {
  const [wallet, setWallet] = useState<EvmWallet | null>(() => currentEvmWallet())
  const [step, setStep] = useState<PayStep>('idle')
  const [pickerOpen, setPickerOpen] = useState(false)
  const pending = useRef<{ resolve: (w: EvmWallet) => void; reject: (e: Error) => void } | null>(null)

  const choose = useCallback(
    () =>
      new Promise<EvmWallet>((resolve, reject) => {
        pending.current = { resolve, reject }
        setPickerOpen(true)
      }),
    [],
  )

  const onPicked = useCallback((w: EvmWallet) => {
    setWallet(w)
    setPickerOpen(false)
    pending.current?.resolve(w)
    pending.current = null
  }, [])

  const onClose = useCallback(() => {
    setPickerOpen(false)
    pending.current?.reject(new Error('No wallet chosen.'))
    pending.current = null
  }, [])

  const prepare = useCallback(
    async (chain: Chain): Promise<{ provider: Eip1193; from: string; wallet: EvmWallet }> => {
      try {
        let w = wallet ?? currentEvmWallet()
        if (!w) {
          setStep('choosing')
          w = await choose()
        }
        setStep('connecting')
        let accounts: string[]
        try {
          accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[]
        } catch (e) {
          throw new Error(walletErrorText(e, `connect ${w.name}`))
        }
        const from = accounts?.[0]
        if (!from) throw new Error(`${w.name} returned no account. Unlock it, then try again.`)
        setStep('switching')
        await ensureEvmChain(w.provider, chain)
        setStep('ready')
        setWallet(w)
        return { provider: w.provider, from, wallet: w }
      } catch (e) {
        setStep('idle')
        throw e
      }
    },
    [wallet, choose],
  )

  /** Pick a different wallet for the next payment. */
  const change = useCallback(() => {
    setConnectedProvider(null)
    void choose().catch(() => undefined)
  }, [choose])

  const picker = <PayWalletPicker open={pickerOpen} onPicked={onPicked} onClose={onClose} />

  return { wallet, step, prepare, change, picker }
}

/** The button text for a payment's wallet step. */
export function payStepLabel(step: PayStep, chainName: string, walletName?: string): string {
  if (step === 'choosing') return 'Pick a wallet...'
  if (step === 'connecting') return `Connecting ${walletName ?? 'your wallet'}...`
  if (step === 'switching') return `Switching to ${chainName}...`
  return 'Preparing...'
}

/** One flat list of the EVM wallets in this browser, plus WalletConnect when configured. */
function PayWalletPicker({ open, onPicked, onClose }: { open: boolean; onPicked: (w: EvmWallet) => void; onClose: () => void }) {
  const [wallets, setWallets] = useState<WalletOption[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(null)
    refreshInjectedWallets()
    setWallets(getInjectedWallets())
    // Extensions announce a beat late; read again before calling anything "not installed".
    const t = setTimeout(() => setWallets(getInjectedWallets()), 200)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(t)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null

  const pickInjected = (w: WalletOption) => {
    if (!w.provider) {
      setError(`${w.name} exposed no provider. Unlock it, then try again.`)
      return
    }
    onPicked(rememberEvmWallet({ ...w, provider: w.provider }))
  }

  const pickWalletConnect = async () => {
    setBusy('walletconnect')
    setError(null)
    try {
      const provider = await connectWalletConnect()
      setConnectedProvider(provider, { name: 'WalletConnect' })
      onPicked({ provider, name: 'WalletConnect' })
    } catch (e) {
      setError(walletErrorText(e, 'connect a phone wallet'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/45 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-wallet-title"
        className="w-full max-w-sm overflow-hidden rounded-3xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            <h3 id="pay-wallet-title" className="text-lg font-bold tracking-tight text-foreground">
              Pay with
            </h3>
            <p className="mt-0.5 text-sm text-foreground/55">Pick the EVM wallet to pay from.</p>
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
          {wallets.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => pickInjected(w)}
              disabled={busy !== null}
              className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-background/60">
                {w.icon ? <img src={w.icon} alt="" className="h-6 w-6 object-contain" /> : <Wallet size={18} className="text-foreground/55" />}
              </span>
              <span className="text-sm font-semibold text-foreground">{w.name}</span>
            </button>
          ))}
          {walletConnectEnabled() && (
            <button
              type="button"
              onClick={() => void pickWalletConnect()}
              disabled={busy !== null}
              className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-background/60">
                {busy === 'walletconnect' ? <Loader2 size={18} className="animate-spin text-accent" /> : <QrCode size={18} className="text-foreground/55" />}
              </span>
              <span className="text-sm font-semibold text-foreground">Phone wallet (WalletConnect)</span>
            </button>
          )}
          {wallets.length === 0 && !walletConnectEnabled() && (
            <p className="px-3 py-3 text-sm text-foreground/60">No EVM wallet in this browser. Install Rabby or MetaMask, then reload.</p>
          )}
        </div>
      </div>
    </div>
  )
}

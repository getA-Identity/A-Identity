import { useEffect, useState } from 'react'
import { QrCode, Wallet, X } from 'lucide-react'
import { useAuth } from '../../store/auth'
import {
  connectWalletConnect,
  getInjectedWallets,
  refreshInjectedWallets,
  walletConnectEnabled,
  type WalletOption,
} from '../../lib/wallets'

/**
 * Wallet picker. Lists every installed wallet via EIP-6963 (so several extensions
 * no longer fight over window.ethereum) plus WalletConnect for mobile wallets.
 */
export default function WalletModal({
  open,
  onClose,
  onConnected,
}: {
  open: boolean
  onClose: () => void
  onConnected: () => void
}) {
  const loginWallet = useAuth((s) => s.loginWallet)
  const [wallets, setWallets] = useState<WalletOption[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    refreshInjectedWallets()
    setWallets(getInjectedWallets())
    // Some wallets announce a beat late, re-read shortly after opening.
    const t = setTimeout(() => setWallets(getInjectedWallets()), 150)
    return () => clearTimeout(t)
  }, [open])

  if (!open) return null

  const connectInjected = async (w: WalletOption) => {
    if (!w.provider) return
    setBusy(w.id)
    setError(null)
    try {
      await loginWallet(w.provider)
      onConnected()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.')
    } finally {
      setBusy(null)
    }
  }

  const connectWc = async () => {
    setBusy('wc')
    setError(null)
    try {
      const provider = await connectWalletConnect()
      await loginWallet(provider)
      onConnected()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'WalletConnect failed.')
    } finally {
      setBusy(null)
    }
  }

  const wcOn = walletConnectEnabled()
  const nothing = wallets.length === 0 && !wcOn

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-3xl bg-card p-6 shadow-[0_24px_64px_rgba(25,40,55,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold tracking-tight text-foreground">Connect a wallet</h3>
          <button type="button" onClick={onClose} className="text-foreground/40 transition-colors hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        {nothing ? (
          <p className="text-sm text-foreground/60">
            No wallet detected. Install{' '}
            <a
              className="font-semibold text-accent hover:underline"
              href="https://metamask.io/download"
              target="_blank"
              rel="noreferrer"
            >
              MetaMask
            </a>
            , or close this and continue as guest.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => connectInjected(w)}
                disabled={!!busy}
                className="flex items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 text-left transition-colors hover:border-accent disabled:opacity-50"
              >
                {w.icon ? (
                  <img src={w.icon} alt="" className="h-7 w-7 rounded-lg" />
                ) : (
                  <Wallet size={22} className="text-foreground/50" />
                )}
                <span className="flex-1 text-sm font-semibold text-foreground">{w.name}</span>
                {busy === w.id && <span className="text-xs text-foreground/45">Connecting</span>}
              </button>
            ))}
            {wcOn && (
              <button
                type="button"
                onClick={connectWc}
                disabled={!!busy}
                className="flex items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 text-left transition-colors hover:border-accent disabled:opacity-50"
              >
                <QrCode size={22} className="text-[#3b99fc]" />
                <span className="flex-1 text-sm font-semibold text-foreground">
                  WalletConnect <span className="text-foreground/40">(mobile)</span>
                </span>
                {busy === 'wc' && <span className="text-xs text-foreground/45">Opening</span>}
              </button>
            )}
          </div>
        )}

        {error && <p className="mt-3 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  )
}

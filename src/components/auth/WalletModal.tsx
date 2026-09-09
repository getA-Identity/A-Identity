import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ChevronDown, QrCode, Wallet, X } from 'lucide-react'
import { useAuth } from '../../store/auth'
import {
  connectWalletConnect,
  evmSigner,
  getInjectedWallets,
  refreshInjectedWallets,
  setConnectedProvider,
  walletConnectEnabled,
  type WalletOption,
} from '../../lib/wallets'
import { connectStellar, listStellarWallets, type StellarWalletInfo } from '../../lib/stellar/kit'
import { ALGORAND_WALLETS, connectAlgorand, type AlgorandWalletId } from '../../lib/algorand/wallet'
import type { Ecosystem, WalletSigner } from '../../lib/wallet/types'

/**
 * The wallet picker: one flat list, whatever chain family a wallet belongs to.
 *
 * Wallets that are actually here come first (installed browser wallets, on any family),
 * then the phone options (WalletConnect, Pera, Defly), and everything the kit knows but
 * is not installed sits behind "More wallets". A small tag says which family a wallet is;
 * nothing else about chains is asked of the person, because the wallet already knows.
 * The same picker signs in and, in `link` mode, attaches one more wallet to an account.
 */
export default function WalletModal({
  open,
  onClose,
  onConnected,
  mode = 'signin',
}: {
  open: boolean
  onClose: () => void
  onConnected: (result?: { note?: string }) => void
  mode?: 'signin' | 'link'
}) {
  const loginWithSigner = useAuth((s) => s.loginWithSigner)
  const linkWallet = useAuth((s) => s.linkWallet)
  const [evmWallets, setEvmWallets] = useState<WalletOption[]>([])
  const [stellarWallets, setStellarWallets] = useState<StellarWalletInfo[]>([])
  const [stellarReady, setStellarReady] = useState(false)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setMore(false)
    refreshInjectedWallets()
    setEvmWallets(getInjectedWallets())
    // Extensions announce themselves a beat late (EIP-6963 wallets and Freighter alike),
    // so both lists are read again after a moment before anything is called "not installed".
    const t1 = setTimeout(() => setEvmWallets(getInjectedWallets()), 150)
    let alive = true
    setStellarReady(false)
    const readStellar = () =>
      listStellarWallets()
        .then((list) => {
          if (!alive) return
          setStellarWallets(list)
          setStellarReady(true)
        })
        .catch(() => alive && setStellarReady(true))
    void readStellar()
    const t2 = setTimeout(() => void readStellar(), 1200)
    return () => {
      alive = false
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  type Row = { id: string; name: string; family: Ecosystem; icon?: string; hint?: string; installed: boolean; connect: () => Promise<WalletSigner> }

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const w of evmWallets) {
      out.push({
        id: `evm:${w.id}`, name: w.name, family: 'evm', icon: w.icon, installed: true,
        connect: async () => {
          if (!w.provider) throw new Error('This wallet exposed no provider.')
          setConnectedProvider(w.provider)
          return evmSigner(w.provider, { id: w.id, name: w.name, icon: w.icon })
        },
      })
    }
    for (const w of stellarWallets) {
      out.push({
        id: `stellar:${w.id}`, name: w.name, family: 'stellar', icon: w.icon, installed: w.isAvailable,
        // Availability is re-checked by the wallet module itself on connect, so a wallet
        // that announced late still works from "More wallets".
        connect: () => connectStellar(w.id),
      })
    }
    if (walletConnectEnabled()) {
      out.push({
        id: 'evm:walletconnect', name: 'WalletConnect', family: 'evm', hint: 'phone', installed: true,
        connect: async () => {
          const provider = await connectWalletConnect()
          setConnectedProvider(provider)
          return evmSigner(provider, { id: 'walletconnect', name: 'WalletConnect' })
        },
      })
    }
    for (const w of ALGORAND_WALLETS) {
      out.push({
        id: `algorand:${w.id}`, name: w.name, family: 'algorand', hint: w.kind === 'mobile' ? 'phone' : 'extension', installed: w.kind === 'mobile',
        connect: () => connectAlgorand(w.id as AlgorandWalletId),
      })
    }
    return out
  }, [evmWallets, stellarWallets])

  if (!open) return null

  const primary = rows.filter((r) => r.installed)
  const rest = rows.filter((r) => !r.installed)

  const finish = async (row: Row) => {
    setBusy(row.id)
    setError(null)
    try {
      const signer = await row.connect()
      if (mode === 'link') {
        const r = await linkWallet(signer)
        onConnected({ note: r.note })
      } else {
        await loginWithSigner(signer)
        onConnected()
      }
    } catch (e) {
      setError(errorText(e, row.name))
    } finally {
      setBusy(null)
    }
  }

  const Row = ({ r }: { r: Row }) => (
    <button
      type="button"
      onClick={() => finish(r)}
      disabled={!!busy}
      className="flex items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 text-left transition-colors hover:border-accent disabled:opacity-50"
    >
      {r.icon ? (
        <img src={r.icon} alt="" className="h-7 w-7 rounded-lg" />
      ) : r.hint === 'phone' ? (
        <QrCode size={22} className="text-foreground/50" />
      ) : (
        <Wallet size={22} className="text-foreground/50" />
      )}
      <span className="flex-1 text-sm font-semibold text-foreground">
        {r.name}
        {r.hint && <span className="ml-1.5 text-xs font-medium text-foreground/40">{r.hint}</span>}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground/40">{FAMILY[r.family]}</span>
      {busy === r.id && <span className="text-xs text-foreground/45">...</span>}
    </button>
  )

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
        className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-3xl bg-card p-6 shadow-[0_24px_64px_rgba(25,40,55,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <div className="flex items-center justify-between">
            <button type="button" onClick={onClose} aria-label="Back" title="Back (Esc)" className="-ml-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold text-foreground/55 transition-colors hover:text-foreground">
              <ArrowLeft size={14} />
              Back
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="text-foreground/40 transition-colors hover:text-foreground">
              <X size={18} />
            </button>
          </div>
          <h3 id="wallet-modal-title" className="mt-2 text-lg font-bold tracking-tight text-foreground">
            {mode === 'link' ? 'Link a wallet' : 'Connect a wallet'}
          </h3>
          <p className="mt-1 text-xs text-foreground/55">You sign one message. Nothing is sent.</p>
        </div>

        <div className="flex flex-col gap-2">
          {primary.length === 0 && stellarReady && (
            <p className="px-1 text-sm text-foreground/60">
              No wallet detected in this browser. Install one (MetaMask, Freighter, Lute) or use a phone wallet below.
            </p>
          )}
          {!stellarReady && primary.length === 0 && <p className="px-1 text-sm text-foreground/45">Looking for wallets...</p>}
          {primary.map((r) => (
            <Row key={r.id} r={r} />
          ))}
          {rest.length > 0 && (
            <button
              type="button"
              onClick={() => setMore((m) => !m)}
              className="mt-1 inline-flex items-center gap-1 self-start px-1 text-xs font-semibold text-foreground/50 transition-colors hover:text-foreground"
            >
              <ChevronDown size={14} className={more ? 'rotate-180 transition-transform' : 'transition-transform'} />
              {more ? 'Fewer wallets' : `More wallets (${rest.length})`}
            </button>
          )}
          {more && rest.map((r) => <Row key={r.id} r={r} />)}
        </div>

        {error && <p className="mt-3 text-xs font-semibold text-danger">{error}</p>}
      </div>
    </div>
  )
}

const FAMILY: Record<Ecosystem, string> = { evm: 'EVM', stellar: 'Stellar', algorand: 'Algorand' }

/**
 * One sentence from whatever a wallet threw. Wallet kits reject with plain objects
 * ({ code, message }), not Error instances, and a picker that only reads Error.message
 * answers every one of them with "Connection failed", which is what this replaces.
 */
function errorText(e: unknown, wallet: string): string {
  const msg =
    e instanceof Error ? e.message
    : typeof e === 'string' ? e
    : e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string' ? (e as { message: string }).message
    : ''
  if (/not connected|not installed|not available|not found/i.test(msg)) return `${wallet} was not found in this browser. Install it, unlock it, then try again.`
  if (/declin|reject|denied|cancel|closed/i.test(msg)) return `You declined in ${wallet}.`
  return msg || `${wallet}: connection failed.`
}

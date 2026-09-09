import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Loader2, Lock, QrCode, Wallet, X } from 'lucide-react'
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
import { CHAINS } from '../../lib/chains'
import { networkMarks, type Ecosystem, type WalletSigner } from '../../lib/wallet/types'
import { EASE_OUT_EXPO } from '../../lib/brand'
import ChainLogo from '../app/ChainLogo'

/**
 * The wallet picker: one list, every chain family.
 *
 * Each row is a wallet; on its right sit the marks of the networks that wallet reaches,
 * which is the only chain information a person needs and the only one shown. Wallets
 * found in this browser come first, phone wallets next, and everything the kit knows but
 * is not installed waits behind "More wallets". The same picker signs in and, in `link`
 * mode, attaches one more wallet to an account that is already signed in.
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
  /** Which attempt is current. A wallet that answers after the person cancelled, or after
   *  the timeout, is answering an attempt nobody is waiting for any more. */
  const attempt = useRef(0)

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

  const rows = useMemo<PickerRow[]>(() => {
    const out: PickerRow[] = []
    for (const w of evmWallets) {
      out.push({
        id: `evm:${w.id}`, name: w.name, family: 'evm', icon: w.icon, status: 'detected',
        connect: async () => {
          if (!w.provider) throw new Error('This wallet exposed no provider.')
          setConnectedProvider(w.provider)
          return evmSigner(w.provider, { id: w.id, name: w.name, icon: w.icon })
        },
      })
    }
    for (const w of stellarWallets) {
      out.push({
        id: `stellar:${w.id}`, name: w.name, family: 'stellar', icon: w.icon, status: w.isAvailable ? 'detected' : 'missing',
        // The wallet module re-checks availability on connect, so a late announcer works.
        connect: () => connectStellar(w.id),
      })
    }
    if (walletConnectEnabled()) {
      out.push({
        id: 'evm:walletconnect', name: 'WalletConnect', family: 'evm', status: 'phone',
        connect: async () => {
          const provider = await connectWalletConnect()
          setConnectedProvider(provider)
          return evmSigner(provider, { id: 'walletconnect', name: 'WalletConnect' })
        },
      })
    }
    for (const w of ALGORAND_WALLETS) {
      out.push({
        id: `algorand:${w.id}`, name: w.name, family: 'algorand', status: w.kind === 'mobile' ? 'phone' : 'missing',
        connect: () => connectAlgorand(w.id as AlgorandWalletId),
      })
    }
    return out
  }, [evmWallets, stellarWallets])

  const primary = rows.filter((r) => r.status !== 'missing')
  const rest = rows.filter((r) => r.status === 'missing')

  const cancel = () => {
    attempt.current += 1
    setBusy(null)
    setError(null)
  }

  const finish = async (row: PickerRow) => {
    const mine = ++attempt.current
    setBusy(row.id)
    setError(null)
    try {
      // A multi-chain extension (Trust Wallet, for one) can show its own "switch to your
      // Ethereum wallet" prompt and then never settle the request if that prompt is closed.
      // Nothing here can finish that prompt, so the wait is bounded and the person gets a
      // sentence and a way out instead of a spinner.
      const signer = await withDeadline(row.connect(), CONNECT_MS, `${row.name} did not answer. Open the extension, finish any prompt there (some wallets first ask you to switch to their Ethereum account), then try again.`)
      if (mine !== attempt.current) return
      if (mode === 'link') {
        const r = await withDeadline(linkWallet(signer), SIGN_MS, `${row.name} did not return a signature. Open the extension, approve or dismiss the request there, then try again.`)
        if (mine !== attempt.current) return
        onConnected({ note: r.note })
      } else {
        await withDeadline(loginWithSigner(signer), SIGN_MS, `${row.name} did not return a signature. Open the extension, approve or dismiss the request there, then try again.`)
        if (mine !== attempt.current) return
        onConnected()
      }
    } catch (e) {
      if (mine !== attempt.current) return
      setError(errorText(e, row.name))
    } finally {
      if (mine === attempt.current) setBusy(null)
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-foreground/45 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-modal-title"
            className="relative max-h-[88vh] w-full max-w-md overflow-hidden rounded-[28px] border border-border bg-card shadow-[0_32px_80px_rgba(25,40,55,0.22)]"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.32, ease: EASE_OUT_EXPO }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* A thin brand rule along the top: the one decorative element. */}
            <div className="h-1 w-full bg-gradient-to-r from-accent via-accent/60 to-transparent" aria-hidden="true" />

            <div className="flex items-start justify-between gap-4 px-6 pt-5">
              <div>
                <h3 id="wallet-modal-title" className="text-xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
                  {mode === 'link' ? 'Link a wallet' : 'Connect a wallet'}
                </h3>
                <p className="mt-1 text-sm text-foreground/55">
                  {mode === 'link' ? 'Prove one more wallet is yours.' : 'Pick the wallet you already use.'}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close (Esc)"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-border text-foreground/50 transition-colors hover:border-accent/40 hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            <div className="max-h-[calc(88vh-140px)] overflow-y-auto px-4 pb-4 pt-4">
              <div className="flex flex-col gap-1.5">
                {primary.length === 0 && (
                  <p className="px-2 py-3 text-sm text-foreground/55">
                    {stellarReady
                      ? 'No wallet found in this browser. Install MetaMask, Freighter or Lute, or use a phone wallet.'
                      : 'Looking for wallets...'}
                  </p>
                )}
                {primary.map((r, i) => (
                  <WalletRow key={r.id} row={r} index={i} busy={busy} onPick={finish} />
                ))}

                {rest.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setMore((m) => !m)}
                    className="mt-1 flex items-center justify-between rounded-2xl px-3 py-2.5 text-xs font-semibold text-foreground/50 transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                  >
                    <span>{more ? 'Fewer wallets' : `More wallets (${rest.length})`}</span>
                    <ChevronDown size={15} className={`transition-transform ${more ? 'rotate-180' : ''}`} />
                  </button>
                )}
                {more && rest.map((r, i) => <WalletRow key={r.id} row={r} index={i} busy={busy} onPick={finish} />)}
              </div>

              {busy && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-border bg-background/60 px-3.5 py-2.5 text-xs text-foreground/60">
                  <span>Waiting for your wallet. If it opened a prompt, finish it there.</span>
                  <button type="button" onClick={cancel} className="shrink-0 font-semibold text-foreground/70 underline underline-offset-2 hover:text-foreground">
                    Cancel
                  </button>
                </div>
              )}
              {error && (
                <p role="alert" className="mt-3 rounded-2xl border border-danger/25 bg-danger/10 px-3.5 py-2.5 text-xs font-semibold text-danger">
                  {error}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-border px-6 py-3 text-[11px] text-foreground/45">
              <Lock size={12} className="shrink-0" />
              One signature to prove the wallet is yours. No transaction, no fee, no key leaves your wallet.
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** How long a wallet gets to answer a connect request, and a signature request. */
const CONNECT_MS = 60_000
const SIGN_MS = 120_000

/** Race a wallet call against a deadline, so a prompt nobody can see cannot hang the picker. */
function withDeadline<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

type PickerRow = {
  id: string
  name: string
  family: Ecosystem
  icon?: string
  /** detected: installed here. phone: a mobile app over QR. missing: known, not installed. */
  status: 'detected' | 'phone' | 'missing'
  connect: () => Promise<WalletSigner>
}

function WalletRow({ row, index, busy, onPick }: { row: PickerRow; index: number; busy: string | null; onPick: (r: PickerRow) => void }) {
  const networks = networkMarks(row.family, CHAINS)
  const shown = networks.slice(0, 4)
  const extra = networks.length - shown.length
  const isBusy = busy === row.id
  return (
    <motion.button
      type="button"
      onClick={() => onPick(row)}
      disabled={!!busy}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index, 8) * 0.03, ease: EASE_OUT_EXPO }}
      className="group flex w-full items-center gap-3.5 rounded-2xl border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-foreground/[0.035] disabled:opacity-50"
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-background/60">
        {row.icon ? (
          <img src={row.icon} alt="" className="h-7 w-7 rounded-lg object-contain" />
        ) : row.status === 'phone' ? (
          <QrCode size={20} className="text-foreground/55" />
        ) : (
          <Wallet size={20} className="text-foreground/55" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{row.name}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-foreground/45">
          {row.status === 'detected' && <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />}
          {row.status === 'detected' ? 'Detected in this browser' : row.status === 'phone' ? 'Phone app, scan a code' : 'Not installed'}
        </span>
      </span>
      <span className="flex shrink-0 items-center" aria-label={`Works on ${networks.map((c) => c.shortName).join(', ')}`} title={networks.map((c) => c.shortName).join(', ')}>
        {isBusy ? (
          <Loader2 size={18} className="animate-spin text-accent" />
        ) : (
          <>
            {shown.map((c, i) => (
              <ChainLogo key={c.id} id={c.id} size={22} className={i > 0 ? '-ml-2 ring-2 ring-card' : 'ring-2 ring-card'} />
            ))}
            {extra > 0 && (
              <span className="-ml-2 grid h-[22px] w-[22px] place-items-center rounded-full border border-border bg-background text-[9px] font-bold text-foreground/60 ring-2 ring-card">
                +{extra}
              </span>
            )}
          </>
        )}
      </span>
    </motion.button>
  )
}

/**
 * One sentence from whatever a wallet threw. Wallet kits reject with plain objects
 * ({ code, message }), not Error instances, so the message is read from either.
 */
function errorText(e: unknown, wallet: string): string {
  const msg =
    e instanceof Error ? e.message
    : typeof e === 'string' ? e
    : e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string' ? (e as { message: string }).message
    : ''
  if (/not connected|not installed|not available|not found/i.test(msg)) return `${wallet} was not found in this browser. Install it, unlock it, then try again.`
  if (/declin|reject|denied|cancel|closed/i.test(msg)) return `You declined in ${wallet}.`
  if (/switch|network|chain/i.test(msg) && !/signature/i.test(msg)) return `${wallet} asked to switch its active account or network. Do that inside the extension, then try again.`
  return msg || `${wallet}: connection failed.`
}

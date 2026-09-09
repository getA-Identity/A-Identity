import { useEffect, useState } from 'react'
import { ArrowLeft, QrCode, Wallet, X } from 'lucide-react'
import { useAuth } from '../../store/auth'
import {
  connectWalletConnect,
  evmSigner,
  EVM_WALLET_CHAINS,
  getInjectedWallets,
  refreshInjectedWallets,
  setConnectedProvider,
  walletConnectEnabled,
  type WalletOption,
} from '../../lib/wallets'
import { connectStellar, listStellarWallets, type StellarWalletInfo } from '../../lib/stellar/kit'
import { ALGORAND_WALLETS, connectAlgorand, type AlgorandWalletId } from '../../lib/algorand/wallet'
import { CHAINS } from '../../lib/chains'
import { chainsFor, ECOSYSTEM_LABEL, type Ecosystem, type WalletSigner } from '../../lib/wallet/types'

/**
 * The wallet picker, for every chain family the registry knows.
 *
 * Three groups, each listing the wallets that exist for it: EVM (every installed wallet
 * via EIP-6963, plus WalletConnect for phones), Stellar (Freighter, xBull, Albedo, Lobstr,
 * Hana and the other kit modules; installed ones first), and Algorand (Pera, Defly, Lute).
 * The same picker signs people in and, in `link` mode, attaches one more wallet to an
 * account that is already signed in. The Stellar and Algorand connectors load only when
 * this dialog opens, so the public pages carry none of their code.
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
  /** `signin` starts a session with the wallet; `link` proves one more wallet for the current account. */
  mode?: 'signin' | 'link'
}) {
  const loginWithSigner = useAuth((s) => s.loginWithSigner)
  const linkWallet = useAuth((s) => s.linkWallet)
  const [evmWallets, setEvmWallets] = useState<WalletOption[]>([])
  const [stellarWallets, setStellarWallets] = useState<StellarWalletInfo[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    refreshInjectedWallets()
    setEvmWallets(getInjectedWallets())
    // Some wallets announce a beat late, re-read shortly after opening.
    const t = setTimeout(() => setEvmWallets(getInjectedWallets()), 150)
    let alive = true
    setStellarWallets(null)
    listStellarWallets()
      .then((list) => alive && setStellarWallets(list))
      .catch(() => alive && setStellarWallets([]))
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [open])

  // Escape closes the picker. This is one step deep, so backing out of it lands on
  // the card that opened it, which is exactly what the Back control does.
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

  if (!open) return null

  const finish = async (id: string, connect: () => Promise<WalletSigner>) => {
    setBusy(id)
    setError(null)
    try {
      const signer = await connect()
      if (mode === 'link') {
        const r = await linkWallet(signer)
        onConnected({ note: r.note })
      } else {
        await loginWithSigner(signer)
        onConnected()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed.')
    } finally {
      setBusy(null)
    }
  }

  const connectInjected = (w: WalletOption) =>
    finish(w.id, async () => {
      if (!w.provider) throw new Error('This wallet exposed no provider.')
      setConnectedProvider(w.provider)
      return evmSigner(w.provider, { id: w.id, name: w.name, icon: w.icon })
    })

  const connectWc = () =>
    finish('wc', async () => {
      const provider = await connectWalletConnect()
      setConnectedProvider(provider)
      return evmSigner(provider, { id: 'walletconnect', name: 'WalletConnect' })
    })

  const wcOn = walletConnectEnabled()
  const chips = (eco: Ecosystem) => chainsFor(eco, CHAINS).map((c) => c.shortName)
  const rowClass =
    'flex items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 text-left transition-colors hover:border-accent disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-foreground/40 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-modal-title"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-3xl bg-card p-6 shadow-[0_24px_64px_rgba(25,40,55,0.18)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back"
              title="Back (Esc)"
              className="-ml-1.5 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-semibold text-foreground/55 transition-colors hover:text-foreground"
            >
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
          <p className="mt-1 text-xs text-foreground/55">
            {mode === 'link'
              ? 'Prove you control one more wallet and it is listed on your account. Nothing moves; you sign one message.'
              : 'Any chain family the product settles on. You sign one message; no transaction is sent.'}
          </p>
        </div>

        <div className="flex flex-col gap-5">
          <Group label={ECOSYSTEM_LABEL.evm} chips={chips('evm')}>
            {evmWallets.length === 0 && !wcOn ? (
              <Empty>
                No EVM wallet detected. Install{' '}
                <a className="font-semibold text-accent hover:underline" href="https://metamask.io/download" target="_blank" rel="noreferrer">
                  MetaMask
                </a>{' '}
                or another browser wallet.
              </Empty>
            ) : (
              <>
                {evmWallets.map((w) => (
                  <button key={w.id} type="button" onClick={() => connectInjected(w)} disabled={!!busy} className={rowClass}>
                    {w.icon ? <img src={w.icon} alt="" className="h-7 w-7 rounded-lg" /> : <Wallet size={22} className="text-foreground/50" />}
                    <span className="flex-1 text-sm font-semibold text-foreground">{w.name}</span>
                    {busy === w.id && <Busy />}
                  </button>
                ))}
                {wcOn && (
                  <button type="button" onClick={connectWc} disabled={!!busy} className={rowClass}>
                    <QrCode size={22} className="text-[#3b99fc]" />
                    <span className="flex-1 text-sm font-semibold text-foreground">
                      WalletConnect <span className="text-foreground/40">(mobile)</span>
                    </span>
                    {busy === 'wc' && <Busy />}
                  </button>
                )}
              </>
            )}
          </Group>

          <Group label={ECOSYSTEM_LABEL.stellar} chips={chips('stellar')}>
            {stellarWallets === null ? (
              <Empty>Loading Stellar wallets...</Empty>
            ) : stellarWallets.length === 0 ? (
              <Empty>Stellar wallets could not be loaded in this browser.</Empty>
            ) : (
              stellarWallets.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => finish(`stellar:${w.id}`, () => connectStellar(w.id))}
                  disabled={!!busy}
                  className={rowClass}
                >
                  {w.icon ? <img src={w.icon} alt="" className="h-7 w-7 rounded-lg" /> : <Wallet size={22} className="text-foreground/50" />}
                  <span className="flex-1 text-sm font-semibold text-foreground">
                    {w.name}
                    {!w.isAvailable && <span className="ml-2 text-xs font-medium text-foreground/40">not installed</span>}
                  </span>
                  {busy === `stellar:${w.id}` && <Busy />}
                </button>
              ))
            )}
          </Group>

          <Group label={ECOSYSTEM_LABEL.algorand} chips={chips('algorand')}>
            {ALGORAND_WALLETS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => finish(`algorand:${w.id}`, () => connectAlgorand(w.id as AlgorandWalletId))}
                disabled={!!busy}
                className={rowClass}
              >
                {w.kind === 'mobile' ? <QrCode size={22} className="text-foreground/50" /> : <Wallet size={22} className="text-foreground/50" />}
                <span className="flex-1 text-sm font-semibold text-foreground">
                  {w.name} <span className="text-foreground/40">({w.kind === 'mobile' ? 'app or QR' : 'extension'})</span>
                </span>
                {busy === `algorand:${w.id}` && <Busy />}
              </button>
            ))}
            <p className="px-1 text-[11px] leading-relaxed text-foreground/45">
              Algorand wallets prove control by signing a zero-value payment to yourself. It is never sent.
            </p>
          </Group>
        </div>

        {error && <p className="mt-3 text-xs font-semibold text-danger">{error}</p>}
        {!EVM_WALLET_CHAINS.length && null}
      </div>
    </div>
  )
}

function Group({ label, chips, children }: { label: string; chips: string[]; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/45">{label}</h4>
        <span className="truncate text-[11px] text-foreground/40">{chips.join(' / ')}</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-sm text-foreground/60">{children}</p>
}

function Busy() {
  return <span className="text-xs text-foreground/45">Connecting</span>
}

import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, ExternalLink, Link2, Loader2, Lock, Unlink, Wallet } from 'lucide-react'
import ChainLogo from '../ChainLogo'
import { ensureEvmChain, EVM_WALLET_CHAINS, getConnectedProvider, walletErrorText } from '../../../lib/wallets'
import WalletModal from '../../auth/WalletModal'
import { apiFetch, readJson } from '../../../lib/api'
import { BACKEND_UNREACHABLE } from '../../../lib/mcpBase'
import { CHAIN_BY_ID, CHAINS, type Chain } from '../../../lib/chains'
import { chainsFor, ECOSYSTEM_LABEL, shortAddress, type Ecosystem } from '../../../lib/wallet/types'
import { authHeaders, type LinkedWalletRow } from '../../../store/auth'
import { useWallets } from '../../../store/wallets'

/**
 * The wallets that belong to this account, across chain families.
 *
 * Two kinds, kept apart on purpose: the wallet the session IS (when you signed in with
 * one), and wallets you LINKED afterwards by signing a nonce with each. Both are proofs
 * of control; neither is custody. The console never holds a key, so this list is what
 * the account can be reached at, not what it can spend.
 */
const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...authHeaders() })

type Listing = { session: { ecosystem: Ecosystem; address: string } | null; wallets: LinkedWalletRow[] }

/** Where a person can look an address up, per chain family. */
function explorerFor(ecosystem: Ecosystem, address: string): string | null {
  if (ecosystem === 'stellar') {
    const base = CHAIN_BY_ID.stellar.explorer
    return base ? `${base.replace(/\/$/, '')}/account/${address}` : null
  }
  if (ecosystem === 'algorand') {
    const base = CHAIN_BY_ID.algorand.explorer
    return base ? `${base.replace(/\/$/, '')}/account/${address}` : null
  }
  const base = (CHAINS.find((c) => c.id === 'base') ?? CHAINS.find((c) => c.evmCompatible && c.status === 'live'))?.explorer
  return base ? `${base.replace(/\/$/, '')}/address/${address}` : null
}

export default function LinkedWallets({ isGuest }: { isGuest: boolean }) {
  const connected = useWallets((s) => s.connected)
  const [listing, setListing] = useState<Listing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  /** The network the connected EVM wallet is on right now, read from the wallet itself. */
  const [evmChainId, setEvmChainId] = useState<number | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  const evmConnected = connected.evm?.address ?? null
  useEffect(() => {
    const eth = getConnectedProvider()
    if (!evmConnected || !eth) {
      setEvmChainId(null)
      return
    }
    let alive = true
    const read = () =>
      eth.request({ method: 'eth_chainId' })
        .then((hex) => alive && setEvmChainId(typeof hex === 'string' ? parseInt(hex, 16) : null))
        .catch(() => alive && setEvmChainId(null))
    void read()
    // Wallets announce network changes; keep the chip honest when the person switches inside the extension.
    const on = (eth as { on?: (ev: string, cb: (v: unknown) => void) => void }).on
    const off = (eth as { removeListener?: (ev: string, cb: (v: unknown) => void) => void }).removeListener
    const handler = () => void read()
    on?.('chainChanged', handler)
    return () => {
      alive = false
      off?.('chainChanged', handler)
    }
  }, [evmConnected])

  const switchTo = async (chain: Chain) => {
    const eth = getConnectedProvider()
    if (!eth) {
      setError('Connect the wallet in this tab first (Link a wallet), then switch its network from here.')
      return
    }
    setSwitching(chain.id)
    setError(null)
    setNote(null)
    try {
      await ensureEvmChain(eth, chain)
      setEvmChainId(chain.chainId)
      setNote(`Wallet switched to ${chain.name}.`)
    } catch (e) {
      setError(walletErrorText(e, `switch to ${chain.name}`))
    } finally {
      setSwitching(null)
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/user/wallets', { headers: authHeaders() })
      const data = await readJson<Listing & { error?: string }>(res)
      if (!res.ok) {
        setError(data.error ?? 'Could not load your wallets.')
        return
      }
      setListing({ session: data.session ?? null, wallets: data.wallets ?? [] })
      setError(null)
    } catch {
      setError(BACKEND_UNREACHABLE)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const unlink = async (address: string) => {
    setBusy(address)
    setError(null)
    setNote(null)
    try {
      const res = await apiFetch('/api/user/wallets/unlink', { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ address }) })
      const data = await readJson<{ wallets?: LinkedWalletRow[]; removed?: boolean; error?: string }>(res)
      if (!res.ok) {
        setError(data.error ?? 'Could not unlink the wallet.')
        return
      }
      setListing((l) => (l ? { ...l, wallets: data.wallets ?? [] } : l))
      setNote(data.removed ? `${shortAddress(address)} unlinked.` : 'That wallet was not linked.')
    } catch {
      setError(BACKEND_UNREACHABLE)
    } finally {
      setBusy(null)
    }
  }

  const rows: { ecosystem: Ecosystem; address: string; label: string; linkedAt?: string; session: boolean }[] = []
  if (listing?.session) rows.push({ ...listing.session, label: 'Signed in with this wallet', session: true })
  for (const w of listing?.wallets ?? []) rows.push({ ecosystem: w.ecosystem, address: w.address, label: w.wallet ?? 'Linked by signature', linkedAt: w.linkedAt, session: false })

  return (
    <div className="mt-4 rounded-2xl border border-border bg-card p-5">
      <WalletModal
        open={pickerOpen}
        mode="link"
        onClose={() => setPickerOpen(false)}
        onConnected={(r) => {
          setPickerOpen(false)
          setNote(r?.note ?? 'Wallet linked.')
          void load()
        }}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-foreground/80">Wallets</h3>
          <p className="mt-0.5 text-xs text-foreground/55">
            Every wallet this account has proven control of, on any chain family the product settles on: EVM, Stellar and Algorand.
            Linking signs one message; nothing is sent and no key ever leaves your wallet.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={isGuest || busy !== null}
          className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Link2 size={13} /> Link a wallet
        </button>
      </div>

      {isGuest && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-warn/25 bg-warn/10 p-3 text-xs font-medium text-foreground/80">
          <Lock size={13} className="shrink-0 text-warn" />
          A guest session cannot link wallets.
          <Link to="/login" className="font-semibold underline underline-offset-2 hover:text-foreground">
            Sign in with a wallet or an email link
          </Link>
        </div>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {listing === null && !error && <p className="text-xs text-foreground/45">Loading...</p>}
        {listing !== null && rows.length === 0 && (
          <p className="text-xs text-foreground/45">No wallet on this account yet. Link one to be reachable on its chains.</p>
        )}
        {rows.map((r) => {
          const chains = chainsFor(r.ecosystem, CHAINS)
          const live = connected[r.ecosystem]?.address === r.address
          const explorer = explorerFor(r.ecosystem, r.address)
          return (
            <div key={`${r.ecosystem}:${r.address}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background/40 px-3.5 py-3">
              <Wallet size={18} className="shrink-0 text-foreground/50" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-foreground">{shortAddress(r.address)}</span>
                  <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground/60">
                    {ECOSYSTEM_LABEL[r.ecosystem]}
                  </span>
                  {live && <span className="text-[10px] font-semibold uppercase tracking-wider text-ok">connected now</span>}
                </div>
                <div className="mt-0.5 truncate text-xs text-foreground/50">
                  {r.label}
                  {chains.length > 0 && ` on ${chains.map((c) => c.shortName).join(', ')}`}
                </div>
              </div>
              {explorer && (
                <a href={explorer} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-foreground/55 hover:text-foreground">
                  Explorer <ExternalLink size={12} />
                </a>
              )}
              {r.ecosystem === 'evm' && live && (
                <div className="flex w-full flex-wrap items-center gap-1.5 pl-[30px] pt-1">
                  <span className="mr-1 text-[11px] text-foreground/45">
                    {evmChainId != null
                      ? `On ${EVM_WALLET_CHAINS.find((c) => c.chainId === evmChainId)?.shortName ?? `chain ${evmChainId}`}. Switch:`
                      : 'Switch network:'}
                  </span>
                  {EVM_WALLET_CHAINS.filter((c) => !c.testnet || c.id === 'arc').map((c) => {
                    const active = c.chainId === evmChainId
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => switchTo(c)}
                        disabled={switching !== null || active}
                        title={active ? `${c.name} (current)` : `Switch the wallet to ${c.name}`}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors disabled:cursor-default ${
                          active ? 'border-accent/50 bg-accent/10 text-foreground' : 'border-border text-foreground/60 hover:border-accent/40 hover:text-foreground'
                        }`}
                      >
                        {switching === c.id ? <Loader2 size={11} className="animate-spin" /> : <ChainLogo id={c.id} size={14} />}
                        {c.shortName}
                      </button>
                    )
                  })}
                </div>
              )}
              {!r.session && (
                <button
                  type="button"
                  onClick={() => unlink(r.address)}
                  disabled={isGuest || busy !== null}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-foreground/45 transition-colors hover:text-danger disabled:opacity-50"
                >
                  {busy === r.address ? <Loader2 size={12} className="animate-spin" /> : <Unlink size={12} />}
                  Unlink
                </button>
              )}
            </div>
          )
        })}
      </div>

      {error && <p className="mt-2 text-xs font-semibold text-danger">{error}</p>}
      {!error && note && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-ok">
          <CheckCircle2 size={13} /> {note}
        </p>
      )}
    </div>
  )
}

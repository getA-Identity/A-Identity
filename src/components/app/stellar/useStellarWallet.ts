/**
 * The Stellar wallet as the vault page sees it: which wallets are installed, which one is
 * connected in this tab, and which network that wallet says it is on.
 *
 * The network is READ from the wallet, on connect, when the tab regains focus, and on
 * demand, and never set by us. A wallet that will not say which network it is on is
 * recorded as such (`reported: false`), so the page can block owner signing with a
 * specific sentence instead of assuming testnet.
 *
 * Everything here goes through src/lib/stellar/kit.ts, which loads Stellar Wallets Kit
 * with a dynamic import on first use: the kit never lands in the landing bundle.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  connectStellar,
  detectStellarWallets,
  disconnectStellar,
  readWalletNetwork,
  type StellarWalletInfo,
  type WalletNetworkReading,
} from '../../../lib/stellar/kit'
import { walletErrorMessage } from '../../../lib/stellar/vault'
import type { WalletSigner } from '../../../lib/wallet/types'
import { getSigner, useWallets } from '../../../store/wallets'

export type WalletDetect = 'checking' | 'installed' | 'none' | 'failed'

export type StellarWalletState = {
  detect: WalletDetect
  wallets: StellarWalletInfo[]
  /** The live signer in this tab, or null. */
  signer: WalletSigner | null
  /** A wallet remembered from an earlier visit with no live signer behind it. */
  rememberedAddress: string | null
  rememberedName: string | null
  network: WalletNetworkReading | null
  busy: boolean
  error: string | null
  connect: (walletId: string) => Promise<void>
  disconnect: () => Promise<void>
  recheckNetwork: () => Promise<void>
}

export function useStellarWallet(): StellarWalletState {
  const [detect, setDetect] = useState<WalletDetect>('checking')
  const [wallets, setWallets] = useState<StellarWalletInfo[]>([])
  const [signer, setSigner] = useState<WalletSigner | null>(() => getSigner('stellar'))
  const [network, setNetwork] = useState<WalletNetworkReading | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remembered = useWallets((s) => s.connected.stellar ?? null)

  // Extensions announce themselves a beat after load, so "none installed" is only said
  // after a second look.
  useEffect(() => {
    let alive = true
    const look = async (final: boolean) => {
      const r = await detectStellarWallets()
      if (!alive) return
      setWallets(r.wallets)
      if (r.installed) setDetect('installed')
      else if (final) setDetect(r.failed ? 'failed' : 'none')
    }
    void look(false)
    const t = setTimeout(() => void look(true), 1200)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [])

  const recheckNetwork = useCallback(async () => {
    if (!getSigner('stellar')) {
      setNetwork(null)
      return
    }
    setNetwork(await readWalletNetwork())
  }, [])

  // Read the network whenever a signer appears, and again whenever the tab regains focus:
  // switching networks happens inside the extension, outside this page.
  useEffect(() => {
    if (!signer) return
    void recheckNetwork()
    const onFocus = () => void recheckNetwork()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [signer, recheckNetwork])

  const connect = useCallback(async (walletId: string) => {
    setBusy(true)
    setError(null)
    try {
      const s = await connectStellar(walletId)
      useWallets.getState().remember(s)
      setSigner(s)
    } catch (e) {
      setError(walletErrorMessage(e) || 'The wallet did not connect.')
    } finally {
      setBusy(false)
    }
  }, [])

  const disconnect = useCallback(async () => {
    setBusy(true)
    try {
      await useWallets.getState().forget('stellar')
      await disconnectStellar()
    } finally {
      setSigner(null)
      setNetwork(null)
      setError(null)
      setBusy(false)
    }
  }, [])

  return {
    detect,
    wallets,
    signer,
    rememberedAddress: !signer && remembered ? remembered.address : null,
    rememberedName: !signer && remembered ? remembered.walletName : null,
    network,
    busy,
    error,
    connect,
    disconnect,
    recheckNetwork,
  }
}

/**
 * The EVM wallet as the Arc vault page sees it: which wallets this browser has, which one is
 * chosen, which account it has connected here, and which chain it says it is on.
 *
 * Read, never assumed: the account comes from eth_accounts (silently, on load, for a wallet
 * chosen before) or eth_requestAccounts (when the person presses Connect), and the chain from
 * eth_chainId, read again on connect, when the tab regains focus, and on the provider's own
 * accountsChanged and chainChanged events when it emits them. Nothing here signs anything; the
 * page asks the wallet to switch chains only when the person presses Switch or a write is
 * about to be sent.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAddress, isAddress, type Address } from 'viem'
import type { Chain } from '../../../lib/chains'
import {
  connectWalletConnect,
  currentEvmWallet,
  ensureEvmChain,
  forgetEvmWallet,
  getInjectedWallets,
  refreshInjectedWallets,
  rememberEvmWallet,
  setConnectedProvider,
  walletConnectEnabled,
  walletErrorText,
  type EvmWallet,
  type WalletOption,
} from '../../../lib/wallets'

export type ArcWalletState = {
  /** Injected wallets that announced themselves (EIP-6963), plus the legacy one if none did. */
  options: WalletOption[]
  /** False until the second look, so "no wallet" is never said before extensions announce. */
  looked: boolean
  walletConnect: boolean
  wallet: EvmWallet | null
  account: Address | null
  /** The chain id the wallet reports, or null when it has not said. */
  chainId: number | null
  busy: boolean
  error: string | null
  connect: (option: WalletOption | 'walletconnect', target: Chain) => Promise<void>
  disconnect: () => void
  refresh: () => Promise<void>
  switchTo: (chain: Chain) => Promise<void>
}

function parseChainId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = v.startsWith('0x') ? parseInt(v, 16) : Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function firstAccount(v: unknown): Address | null {
  const a = Array.isArray(v) ? v[0] : null
  return typeof a === 'string' && isAddress(a, { strict: false }) ? getAddress(a) : null
}

export function useArcWallet(): ArcWalletState {
  const [options, setOptions] = useState<WalletOption[]>([])
  const [looked, setLooked] = useState(false)
  const [wallet, setWallet] = useState<EvmWallet | null>(null)
  const [account, setAccount] = useState<Address | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = useRef<EvmWallet | null>(null)
  current.current = wallet

  // Extensions announce a beat after load, so the list is read twice before "none" is said.
  useEffect(() => {
    refreshInjectedWallets()
    setOptions(getInjectedWallets())
    const t = setTimeout(() => {
      setOptions(getInjectedWallets())
      setLooked(true)
    }, 600)
    return () => clearTimeout(t)
  }, [])

  const read = useCallback(async (w: EvmWallet | null) => {
    if (!w) {
      setAccount(null)
      setChainId(null)
      return
    }
    try {
      setAccount(firstAccount(await w.provider.request({ method: 'eth_accounts' })))
    } catch {
      setAccount(null)
    }
    try {
      setChainId(parseChainId(await w.provider.request({ method: 'eth_chainId' })))
    } catch {
      setChainId(null)
    }
  }, [])

  // A wallet chosen on an earlier visit (or the only one installed) is read silently: no
  // prompt opens until the person presses Connect.
  useEffect(() => {
    const w = currentEvmWallet()
    if (!w) return
    setWallet(w)
    void read(w)
  }, [read])

  // The provider's own events, when it emits them, and focus for the ones that do not.
  useEffect(() => {
    if (!wallet) return
    const p = wallet.provider
    const onAccounts = (...args: unknown[]) => setAccount(firstAccount(args[0]))
    const onChain = (...args: unknown[]) => setChainId(parseChainId(args[0]))
    p.on?.('accountsChanged', onAccounts)
    p.on?.('chainChanged', onChain)
    const onFocus = () => void read(current.current)
    window.addEventListener('focus', onFocus)
    return () => {
      p.removeListener?.('accountsChanged', onAccounts)
      p.removeListener?.('chainChanged', onChain)
      window.removeEventListener('focus', onFocus)
    }
  }, [wallet, read])

  const connect = useCallback(
    async (option: WalletOption | 'walletconnect', target: Chain) => {
      setBusy(true)
      setError(null)
      try {
        let w: EvmWallet
        if (option === 'walletconnect') {
          const provider = await connectWalletConnect(target)
          setConnectedProvider(provider, { name: 'WalletConnect' })
          w = { provider, name: 'WalletConnect' }
        } else {
          if (!option.provider) throw new Error(`${option.name} exposed no provider. Unlock it, then try again.`)
          w = rememberEvmWallet({ ...option, provider: option.provider })
        }
        const accounts = await w.provider.request({ method: 'eth_requestAccounts' })
        const a = firstAccount(accounts)
        if (!a) throw new Error(`${w.name} returned no account. Unlock it, then try again.`)
        setWallet(w)
        setAccount(a)
        setChainId(parseChainId(await w.provider.request({ method: 'eth_chainId' })))
      } catch (e) {
        setError(walletErrorText(e, 'connect your wallet'))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const disconnect = useCallback(() => {
    forgetEvmWallet()
    setWallet(null)
    setAccount(null)
    setChainId(null)
    setError(null)
  }, [])

  const refresh = useCallback(async () => {
    refreshInjectedWallets()
    setOptions(getInjectedWallets())
    await read(current.current)
  }, [read])

  const switchTo = useCallback(
    async (chain: Chain) => {
      const w = current.current
      if (!w) return
      setBusy(true)
      setError(null)
      try {
        await ensureEvmChain(w.provider, chain)
      } catch (e) {
        setError(e instanceof Error ? e.message : `Your wallet did not switch to ${chain.name}.`)
      } finally {
        setBusy(false)
        await read(w)
      }
    },
    [read],
  )

  return {
    options,
    looked,
    walletConnect: walletConnectEnabled(),
    wallet,
    account,
    chainId,
    busy,
    error,
    connect,
    disconnect,
    refresh,
    switchTo,
  }
}

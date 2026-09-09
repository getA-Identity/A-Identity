/**
 * Wallet discovery + connection.
 *
 * - EIP-6963: the modern multi-wallet standard. Every installed wallet announces
 *   itself (name + icon + provider), so we can show a proper picker instead of
 *   fighting over the single `window.ethereum` (which is what caused the
 *   "Cannot redefine property: ethereum" errors with several extensions).
 * - WalletConnect: a QR/deep-link path for mobile wallets. Credential-gated behind
 *   VITE_WALLETCONNECT_PROJECT_ID (a free id from cloud.reown.com); hidden when unset.
 *
 * All connectors return a plain EIP-1193 provider, so the SIWE flow in the auth
 * store treats them uniformly.
 */

import { CHAINS, CHAIN_BY_ID, type Chain } from './chains'

export type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>
  isMetaMask?: boolean
}

export type WalletOption = {
  id: string
  name: string
  icon?: string
  kind: 'injected' | 'walletconnect'
  /** Present for injected wallets; WalletConnect creates its provider on demand. */
  provider?: Eip1193
}

// ── EIP-6963 injected-wallet discovery ───────────────────────────────────────────

type Eip6963Detail = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193 }
const announced = new Map<string, Eip6963Detail>()

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e: Event) => {
    const detail = (e as CustomEvent<Eip6963Detail>).detail
    if (detail?.info?.uuid) announced.set(detail.info.uuid, detail)
  })
  // Ask any installed wallets to (re-)announce themselves.
  window.dispatchEvent(new Event('eip6963:requestProvider'))
}

/** Re-request announcements (call right before showing the picker for freshness). */
export function refreshInjectedWallets(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('eip6963:requestProvider'))
}

/** All discovered injected wallets; falls back to legacy `window.ethereum` if none announced. */
export function getInjectedWallets(): WalletOption[] {
  const list: WalletOption[] = [...announced.values()].map((d) => ({
    id: d.info.uuid,
    name: d.info.name,
    icon: d.info.icon,
    kind: 'injected',
    provider: d.provider,
  }))
  if (list.length === 0) {
    const legacy = (window as unknown as { ethereum?: Eip1193 }).ethereum
    if (legacy) {
      list.push({
        id: 'legacy-injected',
        name: legacy.isMetaMask ? 'MetaMask' : 'Browser wallet',
        kind: 'injected',
        provider: legacy,
      })
    }
  }
  return list
}

/**
 * The best available injected EIP-1193 provider: EIP-6963 discovery first, legacy
 * `window.ethereum` as a fallback. Use this instead of reaching into `window.ethereum`
 * directly, so every surface (login, x402 payment, and more) selects wallets the same way.
 */
export function getActiveInjectedProvider(): Eip1193 | null {
  refreshInjectedWallets()
  return getInjectedWallets()[0]?.provider ?? null
}

/**
 * The provider the user actually signed in with. Reused for later actions (an x402
 * payment, for example) so we pay from the SAME wallet the user chose, instead of
 * whichever extension grabbed window.ethereum first when several are installed.
 */
let connectedProvider: Eip1193 | null = null
export function setConnectedProvider(p: Eip1193 | null): void {
  connectedProvider = p
}
export function getConnectedProvider(): Eip1193 | null {
  return connectedProvider
}

// ── Any EVM chain in the registry ─────────────────────────────────────────────────

/** Every EVM chain a wallet can be pointed at: live and beta entries with a numeric id. */
export const EVM_WALLET_CHAINS: readonly Chain[] = CHAINS.filter(
  (c) => c.evmCompatible && c.chainId != null && (c.status === 'live' || c.status === 'beta'),
)

/** The hex chain id wallets speak, from the registry's decimal one. */
export const evmChainHex = (chain: Chain): string => '0x' + (chain.chainId as number).toString(16)

/**
 * Make sure the wallet is on `chain` before anything is signed against it. Otherwise a
 * transfer meant for Arc would be broadcast to the Arc USDC address on whatever chain is
 * active, which on Ethereum mainnet is a real, confusing and possibly fund-losing
 * transaction. Switches, and adds the chain from the registry's own facts when the wallet
 * has never seen it. This used to exist for Arc alone; every registry chain now gets it.
 */
export async function ensureEvmChain(eth: Eip1193, chain: Chain): Promise<void> {
  if (chain.chainId == null || !chain.evmCompatible) throw new Error(`${chain.name} is not an EVM chain; a browser wallet cannot switch to it.`)
  const hex = evmChainHex(chain)
  const current = (await eth.request({ method: 'eth_chainId' })) as string
  if (typeof current === 'string' && current.toLowerCase() === hex) return
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (err) {
    const code = (err as { code?: number })?.code
    const msg = err instanceof Error ? err.message : String(err)
    // 4902: the wallet does not know this chain yet. Some wallets report it in text only.
    if (code === 4902 || /unrecognized chain|not been added|4902/i.test(msg)) {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrl ? [chain.rpcUrl] : [],
          blockExplorerUrls: chain.explorer ? [chain.explorer] : [],
        }],
      })
      return
    }
    throw new Error(`Switch your wallet to ${chain.name} to continue.`)
  }
}

/** Build an EVM signer from a provider the person already chose: connect, then personal_sign. */
export async function evmSigner(provider: Eip1193, wallet?: { id: string; name: string; icon?: string }) {
  let address: string | undefined
  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
    address = accounts?.[0]
  } catch (e) {
    throw new Error(walletErrorText(e, 'connect to your wallet'))
  }
  if (!address) throw new Error('No account selected in your wallet.')
  const addr = address.toLowerCase()
  let network: string | null = null
  try {
    const hex = (await provider.request({ method: 'eth_chainId' })) as string
    const id = typeof hex === 'string' ? parseInt(hex, 16) : NaN
    network = Number.isFinite(id) ? `eip155:${id}` : null
  } catch {
    network = null
  }
  return {
    ecosystem: 'evm' as const,
    address: addr,
    walletId: wallet?.id ?? 'injected',
    walletName: wallet?.name ?? (provider.isMetaMask ? 'MetaMask' : 'Browser wallet'),
    icon: wallet?.icon,
    network,
    signMessage: async (message: string) => {
      try {
        return (await provider.request({ method: 'personal_sign', params: [message, addr] })) as string
      } catch (e) {
        throw new Error(walletErrorText(e, 'sign the message'))
      }
    },
  }
}

/** Turn a wallet's rejection into one sentence a person can act on. */
export function walletErrorText(e: unknown, action: string): string {
  const code = (e as { code?: number })?.code
  const msg = e instanceof Error ? e.message : String(e)
  if (code === 4001 || /rejected|denied|cancel/i.test(msg)) return `You declined to ${action}.`
  if (/pending|already processing/i.test(msg)) return 'Your wallet has a request open. Finish it there, then try again.'
  return msg || `Could not ${action}.`
}

// ── WalletConnect (mobile wallets via QR) ─────────────────────────────────────────

export const WC_PROJECT_ID = (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) ?? ''
export const walletConnectEnabled = (): boolean => WC_PROJECT_ID.length > 0

// From the generated registry mirror, not typed here: a third hand-copied Arc
// config is exactly the drift the chains generator exists to prevent. Non-null by
// construction for Arc (an EVM chain with a public RPC).
const ARC_CHAIN_ID = CHAIN_BY_ID.arc.chainId as number
const ARC_RPC = CHAIN_BY_ID.arc.rpcUrl as string

/** Open the WalletConnect QR modal and return the connected EIP-1193 provider. */
export async function connectWalletConnect(): Promise<Eip1193> {
  if (!WC_PROJECT_ID) throw new Error('WalletConnect is not configured.')
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider')
  // Arc stays the required chain (the console's home); every other live EVM chain in the
  // registry is offered as optional, with its RPC from the same source, so a mobile wallet
  // can sign on Base, Celo or Arbitrum without a second connection.
  const optional = EVM_WALLET_CHAINS.map((c) => c.chainId as number).filter((id) => id !== ARC_CHAIN_ID)
  const rpcMap: Record<number, string> = { [ARC_CHAIN_ID]: ARC_RPC }
  for (const c of EVM_WALLET_CHAINS) if (c.rpcUrl && c.chainId != null) rpcMap[c.chainId] = c.rpcUrl
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [ARC_CHAIN_ID],
    optionalChains: [ARC_CHAIN_ID, ...optional],
    rpcMap,
    showQrModal: true,
    metadata: {
      name: 'A-Identity',
      description: 'Passport and spend guardrails for AI agents, on every chain the registry knows',
      // The canonical domain, not the Vercel alias: every other self-reference in the
      // repo uses a-identity.xyz, and wallet UIs show this URL to the person signing.
      url: 'https://a-identity.xyz',
      icons: ['https://a-identity.xyz/favicon.png'],
    },
  })
  await provider.connect()
  return provider as unknown as Eip1193
}

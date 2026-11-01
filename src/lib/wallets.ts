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
import type { Eip1193 } from './evm-chain'

// The chain switch and the rejection test live in evm-chain.ts, which has no runtime imports so
// the Arc vault's send path can be tested under Node; every caller still imports them from here.
export { ensureEvmChain, evmChainHex, isWalletRejection, type Eip1193 } from './evm-chain'

export type WalletOption = {
  id: string
  name: string
  icon?: string
  kind: 'injected' | 'walletconnect'
  /** Present for injected wallets; WalletConnect creates its provider on demand. */
  provider?: Eip1193
  /** EIP-6963 reverse-DNS id (io.rabby, io.metamask). Stable across reloads, unlike the uuid. */
  rdns?: string
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
    rdns: d.info.rdns,
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
let connectedMeta: { name: string; icon?: string } | null = null
export function setConnectedProvider(p: Eip1193 | null, meta?: { name: string; icon?: string }): void {
  connectedProvider = p
  connectedMeta = p ? (meta ?? connectedMeta) : null
}
export function getConnectedProvider(): Eip1193 | null {
  return connectedProvider
}

// ── The EVM wallet a payment comes from ───────────────────────────────────────────

/** A chosen EVM wallet: who it is, and the provider to talk to. */
export type EvmWallet = { provider: Eip1193; name: string; icon?: string }

/** Which EVM wallet the person chose last, by its stable EIP-6963 rdns. Not a key, not a session. */
const EVM_CHOICE_KEY = 'aid-evm-wallet'

/** Make `w` the wallet payments come from, in this tab and after a reload. */
export function rememberEvmWallet(w: WalletOption & { provider: Eip1193 }): EvmWallet {
  setConnectedProvider(w.provider, { name: w.name, icon: w.icon })
  try {
    localStorage.setItem(EVM_CHOICE_KEY, w.rdns ?? w.name)
  } catch {
    /* storage blocked: the choice still holds for this tab */
  }
  return { provider: w.provider, name: w.name, icon: w.icon }
}

/**
 * The EVM wallet to pay from without asking, or null when the person has to pick.
 *
 * In order: the wallet already chosen in this tab; the one chosen last time, if it is still
 * installed; the only EVM wallet in the browser, when there is exactly one. Several wallets
 * and no remembered choice means asking, never guessing: grabbing whichever extension
 * announced first is how a Stellar sign-in ended up with a Rabby prompt nobody asked for.
 */
export function currentEvmWallet(): EvmWallet | null {
  if (connectedProvider) return { provider: connectedProvider, name: connectedMeta?.name ?? 'Your wallet', icon: connectedMeta?.icon }
  if (typeof window === 'undefined') return null
  refreshInjectedWallets()
  const list = getInjectedWallets().filter((w): w is WalletOption & { provider: Eip1193 } => Boolean(w.provider))
  let key: string | null = null
  try {
    key = localStorage.getItem(EVM_CHOICE_KEY)
  } catch {
    key = null
  }
  const remembered = key ? list.find((w) => (w.rdns ?? w.name) === key) : undefined
  const pick = remembered ?? (list.length === 1 ? list[0] : undefined)
  return pick ? rememberEvmWallet(pick) : null
}

/** Forget the chosen EVM wallet, so the next payment asks again. */
export function forgetEvmWallet(): void {
  setConnectedProvider(null)
  try {
    localStorage.removeItem(EVM_CHOICE_KEY)
  } catch {
    /* nothing stored */
  }
}

// ── Any EVM chain in the registry ─────────────────────────────────────────────────

/** Every EVM chain a wallet can be pointed at: live and beta entries with a numeric id. */
export const EVM_WALLET_CHAINS: readonly Chain[] = CHAINS.filter(
  (c) => c.evmCompatible && c.chainId != null && (c.status === 'live' || c.status === 'beta'),
)

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

/**
 * Open the WalletConnect QR modal and return the connected EIP-1193 provider.
 *
 * `required` is the chain the session must include. It defaults to Arc testnet, the console's
 * home; a page that signs on another chain (the Arc Mainnet vault page) passes that chain, so a
 * phone wallet that does not carry the testnet can still connect for it.
 */
export async function connectWalletConnect(required?: Chain): Promise<Eip1193> {
  if (!WC_PROJECT_ID) throw new Error('WalletConnect is not configured.')
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider')
  const requiredId = required?.evmCompatible && required.chainId != null ? required.chainId : ARC_CHAIN_ID
  // The required chain first; every other live EVM chain in the registry is offered as
  // optional, with its RPC from the same source, so a mobile wallet can sign on Base, Celo or
  // Arbitrum without a second connection.
  const optional = EVM_WALLET_CHAINS.map((c) => c.chainId as number).filter((id) => id !== requiredId)
  const rpcMap: Record<number, string> = { [ARC_CHAIN_ID]: ARC_RPC }
  for (const c of EVM_WALLET_CHAINS) if (c.rpcUrl && c.chainId != null) rpcMap[c.chainId] = c.rpcUrl
  if (required?.rpcUrl && required.chainId != null) rpcMap[required.chainId] = required.rpcUrl
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [requiredId],
    optionalChains: [requiredId, ...optional],
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

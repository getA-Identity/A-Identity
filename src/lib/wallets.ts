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

import { CHAIN_BY_ID } from './chains'

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
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [ARC_CHAIN_ID],
    optionalChains: [ARC_CHAIN_ID],
    rpcMap: { [ARC_CHAIN_ID]: ARC_RPC },
    showQrModal: true,
    metadata: {
      name: 'A-Identity',
      description: 'Passport + wallet for AI agents on Arc',
      // The canonical domain, not the Vercel alias: every other self-reference in the
      // repo uses a-identity.xyz, and wallet UIs show this URL to the person signing.
      url: 'https://a-identity.xyz',
      icons: ['https://a-identity.xyz/favicon.svg'],
    },
  })
  await provider.connect()
  return provider as unknown as Eip1193
}

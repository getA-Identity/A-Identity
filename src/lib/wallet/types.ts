/**
 * One wallet, whatever chain family it lives on.
 *
 * The console used to know one kind of wallet: an EIP-1193 provider. The product settles
 * on Stellar and Algorand as well, and a person whose money sits in Freighter or Pera
 * could not even sign in. Every connector now produces the same small object: who it is,
 * where it lives, and a way to sign a message the backend can verify on that ecosystem.
 */
import type { Chain } from '../chains'

export type Ecosystem = 'evm' | 'stellar' | 'algorand'

export type WalletSigner = {
  ecosystem: Ecosystem
  /** Canonical address: EVM lowercased, Stellar and Algorand as the wallet gave it. */
  address: string
  /** Stable connector id (an EIP-6963 rdns, a Stellar kit module id, pera / defly / lute). */
  walletId: string
  walletName: string
  icon?: string
  /** The network the wallet reported, when it can say (a CAIP-2 id or a passphrase). */
  network?: string | null
  /**
   * Sign the exact message the backend minted. Returns whatever the ecosystem's proof is:
   * a hex signature (EVM), a base64 or hex ed25519 signature (Stellar, SEP-43), or a base64
   * signed zero-value self-payment carrying the message in its note (Algorand).
   */
  signMessage: (message: string) => Promise<string>
  /** Forget the connection on the connector's side, when it has one. */
  disconnect?: () => Promise<void>
}

/** A wallet as the console remembers it between screens: no signer, only facts. */
export type ConnectedWallet = {
  ecosystem: Ecosystem
  address: string
  walletId: string
  walletName: string
  icon?: string
  network?: string | null
  connectedAt: string
}

export const ECOSYSTEM_LABEL: Record<Ecosystem, string> = {
  evm: 'Ethereum and EVM chains',
  stellar: 'Stellar',
  algorand: 'Algorand',
}

/** The registry chains a wallet of this family can be used on, live and beta only. */
export function chainsFor(ecosystem: Ecosystem, chains: readonly Chain[]): Chain[] {
  return chains.filter((c) => c.ecosystem === ecosystem && (c.status === 'live' || c.status === 'beta'))
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

/** Which ecosystem an address belongs to, from its shape; null when it is none. */
export function ecosystemOfAddress(address: string): Ecosystem | null {
  const a = address.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return 'evm'
  if (/^G[A-Z2-7]{55}$/.test(a)) return 'stellar'
  if (/^[A-Z2-7]{58}$/.test(a)) return 'algorand'
  return null
}

/**
 * The networks a wallet family reaches, one mark per network: mainnets first, and a
 * testnet dropped when its mainnet sibling carries the same mark. Used wherever a row
 * shows chain logos instead of naming chains.
 */
export function networkMarks(ecosystem: Ecosystem, chains: readonly Chain[]): Chain[] {
  const sorted = chainsFor(ecosystem, chains).sort((a, b) => Number(a.testnet) - Number(b.testnet))
  const seen = new Set<string>()
  return sorted.filter((c) => {
    const key = c.id.replace(/-(testnet|sepolia)$/, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

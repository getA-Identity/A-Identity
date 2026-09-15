/**
 * Stellar wallets, through Stellar Wallets Kit (SEP-43): Freighter, xBull, Albedo, Lobstr,
 * Hana, Hot Wallet and the rest of the kit's default modules.
 *
 * Loaded lazily: nothing on the landing pages imports this, so the public bundle and the
 * prerender snapshot are unaffected. The kit is a static singleton; this module is the only
 * place that talks to it, so the version pin and the module list live in one file.
 *
 * The wallet's network is READ, never set: if Freighter is on testnet while a screen
 * targets pubnet, that screen refuses with a specific message instead of signing anyway.
 */
import type { WalletSigner } from '../wallet/types'

/** Pinned: @creit.tech/stellar-wallets-kit 2.6.0 (package.json). Recorded here so the
 *  release notes can quote it without opening the lockfile. */
export const STELLAR_WALLETS_KIT_VERSION = '2.6.0'

export const STELLAR_PUBNET_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
export const STELLAR_TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'

export type StellarWalletInfo = { id: string; name: string; icon: string; url: string; isAvailable: boolean; type: string }

/** The slice of the kit this module uses, typed here so the kit's own types stay internal. */
type KitLike = {
  init(params: unknown): void
  setWallet(id: string): void
  getAddress(): Promise<{ address: string }>
  /** Asks the SELECTED module for its address (Freighter: requestAccess then getAddress) and
   *  stores it in the kit. getAddress() only reads that memory and throws "No wallet has
   *  been connected" when it is empty, which is the whole difference. */
  fetchAddress(): Promise<{ address: string }>
  signMessage(message: string, opts?: { address?: string; networkPassphrase?: string }): Promise<{ signedMessage: string; signerAddress?: string }>
  signTransaction(xdr: string, opts?: { address?: string; networkPassphrase?: string }): Promise<{ signedTxXdr: string; signerAddress?: string }>
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>
  disconnect(): Promise<void>
  refreshSupportedWallets(): Promise<StellarWalletInfo[]>
}

let kitPromise: Promise<KitLike> | null = null

async function kit(): Promise<KitLike> {
  if (!kitPromise) {
    kitPromise = (async () => {
      const [{ StellarWalletsKit }, { defaultModules }] = await Promise.all([
        import('@creit.tech/stellar-wallets-kit/sdk'),
        import('@creit.tech/stellar-wallets-kit/modules/utils'),
      ])
      const k = StellarWalletsKit as unknown as KitLike
      k.init({ modules: defaultModules(), network: STELLAR_PUBNET_PASSPHRASE })
      return k
    })().catch((e) => {
      kitPromise = null
      throw e
    })
  }
  return kitPromise
}

/** Every wallet the kit knows, installed ones first. */
export async function listStellarWallets(): Promise<StellarWalletInfo[]> {
  const k = await kit()
  const list = await k.refreshSupportedWallets()
  return [...list].sort((a, b) => Number(b.isAvailable) - Number(a.isAvailable))
}

/** Human-readable network label for a passphrase the wallet reported. */
export function stellarNetworkOf(passphrase: string | null | undefined): 'stellar:pubnet' | 'stellar:testnet' | null {
  if (passphrase === STELLAR_PUBNET_PASSPHRASE) return 'stellar:pubnet'
  if (passphrase === STELLAR_TESTNET_PASSPHRASE) return 'stellar:testnet'
  return null
}

/** The passphrase a CAIP-2 Stellar network signs under; null for anything else. */
export function stellarPassphraseFor(caip2: string | null | undefined): string | null {
  if (caip2 === 'stellar:pubnet') return STELLAR_PUBNET_PASSPHRASE
  if (caip2 === 'stellar:testnet') return STELLAR_TESTNET_PASSPHRASE
  return null
}

/** "pubnet" / "testnet" for a CAIP-2 id, for a sentence a person reads. */
export function stellarNetworkLabel(caip2: string | null | undefined): string {
  if (caip2 === 'stellar:pubnet') return 'pubnet'
  if (caip2 === 'stellar:testnet') return 'testnet'
  return caip2 ?? 'an unknown network'
}

/**
 * The network the connected wallet is on RIGHT NOW. Read from the wallet, never set by
 * us: a wallet on the wrong network is told to switch, not switched.
 */
export async function readStellarNetwork(): Promise<'stellar:pubnet' | 'stellar:testnet' | null> {
  try {
    const k = await kit()
    return stellarNetworkOf((await k.getNetwork()).networkPassphrase)
  } catch {
    return null
  }
}

/**
 * The refusal sentence when a wallet is pointed at another network than the one a screen
 * targets, or null when signing may go ahead (including when the wallet will not say).
 */
export function stellarNetworkMismatch(
  walletName: string,
  walletNetwork: string | null | undefined,
  targetNetwork: string,
): string | null {
  if (!walletNetwork || walletNetwork === targetNetwork) return null
  return `${walletName} is on ${stellarNetworkLabel(walletNetwork)}; this vault is on ${stellarNetworkLabel(targetNetwork)}. Switch the network inside the wallet, then try again.`
}

/**
 * Sign a prepared envelope with the wallet that is selected in the kit. The signed XDR
 * goes back to the backend, which broadcasts it; nothing here holds a key.
 */
export async function signStellarTransaction(
  xdr: string,
  opts: { networkPassphrase: string; address: string },
): Promise<string> {
  const k = await kit()
  const { signedTxXdr, signerAddress } = await k.signTransaction(xdr, {
    address: opts.address,
    networkPassphrase: opts.networkPassphrase,
  })
  if (signerAddress && signerAddress !== opts.address)
    throw new Error('The wallet signed with a different account than the one connected.')
  if (!signedTxXdr) throw new Error('The wallet returned no signed transaction.')
  return signedTxXdr
}

/**
 * Connect one wallet module and return a signer. The address is whatever the wallet
 * reports; SEP-43 signMessage signs the raw message bytes and the backend accepts the
 * signature in base64 (Freighter) or hex (the SEP text), so nothing is re-encoded here.
 */
export async function connectStellar(walletId: string): Promise<WalletSigner> {
  const k = await kit()
  const wallets = await k.refreshSupportedWallets()
  const info = wallets.find((w) => w.id === walletId)
  if (!info) throw new Error('Unknown Stellar wallet.')
  if (!info.isAvailable) throw new Error(`${info.name} is not installed. Get it at ${info.url}`)
  k.setWallet(walletId)
  const { address } = await k.fetchAddress()
  if (!/^G[A-Z2-7]{55}$/.test(address)) throw new Error('The wallet did not return a Stellar account address.')
  let passphrase: string | null = null
  try {
    passphrase = (await k.getNetwork()).networkPassphrase
  } catch {
    passphrase = null
  }
  return {
    ecosystem: 'stellar',
    address,
    walletId,
    walletName: info.name,
    icon: info.icon,
    network: stellarNetworkOf(passphrase),
    signMessage: async (message: string) => {
      const { signedMessage, signerAddress } = await k.signMessage(message, { address, networkPassphrase: passphrase ?? undefined })
      if (signerAddress && signerAddress !== address) throw new Error('The wallet signed with a different account than the one connected.')
      if (!signedMessage) throw new Error('The wallet returned no signature.')
      return signedMessage
    },
    signTransaction: (xdr: string, opts: { networkPassphrase: string }) =>
      signStellarTransaction(xdr, { networkPassphrase: opts.networkPassphrase, address }),
    disconnect: () => k.disconnect().catch(() => undefined),
  }
}

/**
 * NEAR wallets through NEAR Connect (@hot-labs/near-connect 0.12.0), which docs.near.org
 * recommends over the archived NEAR Wallet Selector.
 *
 * Loaded only when a person reaches for a wallet: the module is imported on the first Connect,
 * or on page load only when NEAR Connect's own marker says this browser chose a wallet here
 * before. A visitor who only reads a vault never downloads it.
 *
 * Pinned for the demo: network 'testnet' (NEAR Connect defaults to mainnet), the registry's RPC
 * hosts for the wallets to use, and a fixed wallet list (wallet-manifest.ts) instead of the
 * manifest NEAR Connect would fetch from GitHub. A-Identity holds no key: every transaction is
 * the prepared one from calls.ts, signed in the person's own wallet.
 */
import type { NearConnector, NearWalletBase } from '@hot-labs/near-connect'
import type { PreparedTx } from './calls.ts'
import { NEAR_NETWORK, NEAR_RPC_URLS } from './chain.ts'
import { TESTNET_WALLETS } from './wallet-manifest.ts'

export type { NearWalletBase }

/** The key NEAR Connect keeps its chosen wallet under in localStorage. */
const SESSION_MARKER = 'selected-wallet'

let pending: Promise<NearConnector> | null = null

type ConnectorOptions = NonNullable<ConstructorParameters<typeof NearConnector>[0]>

/** The one NEAR Connect instance for this page, created on first use. */
export function nearConnector(): Promise<NearConnector> {
  pending ??= import('@hot-labs/near-connect')
    .then((mod) => {
      // A CommonJS package: depending on the bundler's interop the class is a named export or
      // sits on the default export.
      const Ctor = mod.NearConnector ?? (mod as unknown as { default?: { NearConnector?: typeof NearConnector } }).default?.NearConnector
      if (typeof Ctor !== 'function') throw new Error('NEAR Connect did not load in this browser.')
      return new Ctor({
        network: NEAR_NETWORK,
        providers: { testnet: [...NEAR_RPC_URLS] },
        manifest: TESTNET_WALLETS as unknown as ConnectorOptions['manifest'],
        features: { signAndSendTransaction: true },
        autoConnect: false,
        footerBranding: null,
      })
    })
    .catch((e: unknown) => {
      pending = null
      throw e
    })
  return pending
}

/** True when this browser chose a NEAR wallet on this site before, so a session may be restored. */
export function hadNearSession(): boolean {
  try {
    return Boolean(window.localStorage.getItem(SESSION_MARKER))
  } catch {
    return false
  }
}

/** Hand a prepared transaction to the wallet, signed by `signerId`. Resolves with what the wallet answers. */
export function signAndSend(wallet: NearWalletBase, signerId: string, tx: PreparedTx): Promise<unknown> {
  return wallet.signAndSendTransaction({ network: NEAR_NETWORK, signerId, receiverId: tx.receiverId, actions: tx.actions })
}

/** The transaction hash in a wallet's answer, wherever that wallet put it; null when it gave none. */
export function hashOfWalletAnswer(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const a = answer as { transaction?: { hash?: unknown }; transaction_outcome?: { id?: unknown } }
  if (typeof a.transaction?.hash === 'string') return a.transaction.hash
  if (typeof a.transaction_outcome?.id === 'string') return a.transaction_outcome.id
  return null
}

/** A wallet's error in words, with the "you closed it" cases recognized as a cancel rather than a failure. */
export function walletErrorText(e: unknown): { cancelled: boolean; text: string } {
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : 'The wallet returned an error.'
  const cancelled = /reject|cancel|closed|denied|dismiss/i.test(text)
  return { cancelled, text }
}

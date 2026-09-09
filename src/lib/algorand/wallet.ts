/**
 * Algorand wallets: Pera and Defly over WalletConnect (QR or the mobile app), Lute as a
 * browser extension. Loaded lazily, like the Stellar kit.
 *
 * Algorand has no message-signing primitive every wallet ships, so proving control of an
 * address is done the way every Algorand wallet can: the wallet signs a zero-value payment
 * from the address to itself whose note is the message. It is never broadcast; the backend
 * verifies the signature over the transaction bytes and refuses anything that could move
 * value (see mcp/src/wallet-proof.ts). Building that transaction needs the network's
 * current parameters, which come from the registry's algod endpoint.
 */
import { CHAIN_BY_ID } from '../chains'
import type { WalletSigner } from '../wallet/types'

export type AlgorandWalletId = 'pera' | 'defly' | 'lute'

export const ALGORAND_WALLETS: { id: AlgorandWalletId; name: string; kind: 'mobile' | 'extension'; url: string }[] = [
  { id: 'pera', name: 'Pera Wallet', kind: 'mobile', url: 'https://perawallet.app' },
  { id: 'defly', name: 'Defly', kind: 'mobile', url: 'https://defly.app' },
  { id: 'lute', name: 'Lute', kind: 'extension', url: 'https://lute.app' },
]

/** Mainnet, from the registry mirror: the same node the backend reads. */
const ALGOD_URL = CHAIN_BY_ID.algorand.rpcUrl as string
const MAINNET_GENESIS_ID = 'mainnet-v1.0'
const PERA_MAINNET_CHAIN_ID = 416001

const isAlgoAddress = (s: string) => /^[A-Z2-7]{58}$/.test(s)

type Connector =
  | { kind: 'pera' | 'defly'; connect(): Promise<string[]>; reconnectSession(): Promise<string[]>; disconnect(): Promise<void>; signTransaction(groups: { txn: unknown }[][]): Promise<Uint8Array[]> }
  | { kind: 'lute'; connect(genesisId: string): Promise<string[]>; signTxns(txns: { txn: string }[]): Promise<(Uint8Array | null)[]> }

const connectors = new Map<AlgorandWalletId, Promise<Connector>>()

function connector(id: AlgorandWalletId): Promise<Connector> {
  let p = connectors.get(id)
  if (!p) {
    p = (async (): Promise<Connector> => {
      if (id === 'pera') {
        const { PeraWalletConnect } = await import('@perawallet/connect')
        const c = new PeraWalletConnect({ chainId: PERA_MAINNET_CHAIN_ID, shouldShowSignTxnToast: false })
        return { kind: 'pera', connect: () => c.connect(), reconnectSession: () => c.reconnectSession(), disconnect: () => c.disconnect(), signTransaction: (g) => c.signTransaction(g as never) }
      }
      if (id === 'defly') {
        const { DeflyWalletConnect } = await import('@blockshake/defly-connect')
        const c = new DeflyWalletConnect({ chainId: PERA_MAINNET_CHAIN_ID, shouldShowSignTxnToast: false })
        return { kind: 'defly', connect: () => c.connect(), reconnectSession: () => c.reconnectSession(), disconnect: () => c.disconnect(), signTransaction: (g) => c.signTransaction(g as never) }
      }
      const { default: LuteConnect } = await import('lute-connect')
      const c = new LuteConnect('A-Identity')
      return { kind: 'lute', connect: (genesisId) => c.connect(genesisId), signTxns: (txns) => c.signTxns(txns) }
    })().catch((e) => {
      connectors.delete(id)
      throw e
    })
    connectors.set(id, p)
  }
  return p
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

/** The proof transaction: zero ALGO from the address to itself, the message in the note. */
async function buildProofTxn(address: string, message: string) {
  const algosdk = await import('algosdk')
  const client = new algosdk.Algodv2('', ALGOD_URL, '')
  const suggestedParams = await client.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    note: new TextEncoder().encode(message),
    suggestedParams,
  })
  return { algosdk, txn }
}

async function signerFor(id: AlgorandWalletId, c: Connector, address: string, name: string): Promise<WalletSigner> {
  return {
    ecosystem: 'algorand',
    address,
    walletId: id,
    walletName: name,
    network: CHAIN_BY_ID.algorand.caip2,
    signMessage: async (message: string) => {
      const { algosdk, txn } = await buildProofTxn(address, message)
      let blob: Uint8Array | null
      if (c.kind === 'lute') {
        const [signed] = await c.signTxns([{ txn: toBase64(algosdk.encodeUnsignedTransaction(txn)) }])
        blob = signed
      } else {
        const [signed] = await c.signTransaction([[{ txn }]])
        blob = signed ?? null
      }
      if (!blob) throw new Error('The wallet did not sign the proof transaction.')
      return toBase64(blob)
    },
    disconnect: async () => {
      if (c.kind !== 'lute') await c.disconnect().catch(() => undefined)
    },
  }
}

/** Open the wallet's connect flow and return a signer for the first account it offers. */
export async function connectAlgorand(id: AlgorandWalletId): Promise<WalletSigner> {
  const meta = ALGORAND_WALLETS.find((w) => w.id === id)
  if (!meta) throw new Error('Unknown Algorand wallet.')
  const c = await connector(id)
  let accounts: string[]
  try {
    accounts = c.kind === 'lute' ? await c.connect(MAINNET_GENESIS_ID) : await c.connect()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/CONNECT_MODAL_CLOSED|closed|cancel/i.test(msg)) throw new Error('Connection cancelled in the wallet.')
    throw new Error(msg || `Could not connect ${meta.name}.`)
  }
  const address = accounts?.[0]
  if (!address || !isAlgoAddress(address)) throw new Error('No Algorand account was selected.')
  return signerFor(id, c, address, meta.name)
}

/** Silently pick up an existing Pera or Defly session on page load; null when there is none. */
export async function reconnectAlgorand(id: AlgorandWalletId): Promise<WalletSigner | null> {
  const meta = ALGORAND_WALLETS.find((w) => w.id === id)
  if (!meta || meta.kind !== 'mobile') return null
  try {
    const c = await connector(id)
    if (c.kind === 'lute') return null
    const accounts = await c.reconnectSession()
    const address = accounts?.[0]
    if (!address || !isAlgoAddress(address)) return null
    return signerFor(id, c, address, meta.name)
  } catch {
    return null
  }
}

/**
 * Wallet ownership proofs for sign-in and wallet linking, across every ecosystem the chain
 * registry knows: EVM, Stellar and Algorand.
 *
 * Sign-In with Ethereum was the only door, so a person whose money lives in Freighter or
 * Pera could look at the product and never sign in, on chains where the product settles
 * real payments. Each ecosystem proves control of an address the way its wallets can:
 *
 *  - EVM: personal_sign over the message, recovered with viem (unchanged from SIWE).
 *  - Stellar: SEP-43 signMessage. Freighter signs per SEP-53 (SHA-256 of a fixed prefix
 *    plus the message); other wallets sign the raw bytes. Both are accepted, and the
 *    signature may arrive base64 or hex; the bytes are what is verified.
 *  - Algorand: no wallet-wide message-signing standard is deployed everywhere, so the
 *    proof is a signed, never-broadcast, zero-amount payment from the address to itself
 *    whose note carries the message. The signature is over the transaction bytes, by the
 *    address's own ed25519 key. It is refused if it could ever move value: any amount,
 *    any other receiver, a rekey, a close-to, a lease or a signer other than the sender.
 *
 * Pure functions plus one async verifier; no network. The nonce lifecycle stays in the
 * route, the way it always has.
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { isAccountId } from './chains/stellar/strkey.js'
import { isAlgorandAddress } from './chains/algorand/ids.js'

export type WalletEcosystem = 'evm' | 'stellar' | 'algorand'

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Which ecosystem an address belongs to, from its shape alone; null when it is none. */
export function walletEcosystemOf(address: string): WalletEcosystem | null {
  const a = address.trim()
  if (EVM_ADDRESS_RE.test(a)) return 'evm'
  if (isAccountId(a)) return 'stellar'
  if (isAlgorandAddress(a)) return 'algorand'
  return null
}

/**
 * The canonical form of an address as a session subject. EVM addresses are lowercased
 * (checksum case is presentation, not identity); Stellar and Algorand addresses are
 * case-sensitive base32 and are kept exactly as given.
 */
export function normalizeWalletAddress(address: string, ecosystem: WalletEcosystem): string {
  const a = address.trim()
  return ecosystem === 'evm' ? a.toLowerCase() : a
}

/** The text a wallet signs. Same shape on every ecosystem, so a person sees one sentence. */
export function signInMessage(address: string, nonce: string, purpose: 'sign in' | 'link' = 'sign in'): string {
  const line = purpose === 'link' ? 'link this wallet to your account' : 'sign in with your wallet'
  return `A-Identity: ${line}.\n\nAddress: ${address}\nNonce: ${nonce}`
}

/** A short display form of any address: first six, last four. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-4)}` : address
}

export type WalletProof = {
  ecosystem: WalletEcosystem
  address: string
  message: string
  /** EVM: 0x hex signature. Stellar: base64 or hex ed25519 signature. Algorand: base64 signed transaction. */
  signature: string
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** SEP-53: the fixed prefix a Stellar wallet prepends before hashing and signing a message. */
export const SEP53_PREFIX = 'Stellar Signed Message:\n'

/** Verify a raw 64-byte ed25519 signature over `data` with a raw 32-byte public key. */
export function ed25519Verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: 'der', type: 'spki' })
    return cryptoVerify(null, Buffer.from(data), key, Buffer.from(signature))
  } catch {
    return false
  }
}

/** Decode a signature that may arrive as base64 or hex; null when neither yields 64 bytes. */
export function decodeSignature64(s: string): Uint8Array | null {
  const t = s.trim().replace(/^0x/, '')
  if (/^[0-9a-fA-F]{128}$/.test(t)) return Uint8Array.from(Buffer.from(t, 'hex'))
  try {
    const b = Buffer.from(s.trim(), 'base64')
    if (b.length === 64) return Uint8Array.from(b)
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Verify a wallet proof. Never throws: a malformed proof is simply not a proof. The
 * message is checked byte for byte; the caller is responsible for having minted it.
 */
export async function verifyWalletProof(p: WalletProof): Promise<boolean> {
  try {
    if (p.ecosystem === 'evm') {
      if (!EVM_ADDRESS_RE.test(p.address)) return false
      const { verifyMessage } = await import('viem')
      return await verifyMessage({ address: p.address as `0x${string}`, message: p.message, signature: p.signature as `0x${string}` })
    }
    if (p.ecosystem === 'stellar') {
      if (!isAccountId(p.address)) return false
      const sig = decodeSignature64(p.signature)
      if (!sig) return false
      const { StrKey } = await import('@stellar/stellar-sdk')
      const pub = Uint8Array.from(StrKey.decodeEd25519PublicKey(p.address))
      const msg = Buffer.from(p.message, 'utf8')
      // Three encodings are in the wild and all three are accepted, most standard first.
      // SEP-53 (what Freighter signs): SHA-256 of "Stellar Signed Message:\n" + message.
      // Then the bare SEP-43 reading, the raw message bytes; then SHA-256 of the raw bytes.
      // Each is a signature by the same key over a deterministic function of the same
      // message, so accepting all three loosens nothing about WHO signed.
      const { createHash } = await import('node:crypto')
      const sep53 = createHash('sha256').update(Buffer.concat([Buffer.from(SEP53_PREFIX, 'utf8'), msg])).digest()
      if (ed25519Verify(pub, sep53, sig)) return true
      if (ed25519Verify(pub, msg, sig)) return true
      return ed25519Verify(pub, createHash('sha256').update(msg).digest(), sig)
    }
    if (p.ecosystem === 'algorand') {
      if (!isAlgorandAddress(p.address)) return false
      return await verifyAlgorandProof(p.address, p.message, p.signature)
    }
    return false
  } catch {
    return false
  }
}

/**
 * The Algorand proof: a signed zero-value self-payment carrying the message in its note.
 * Every field that could give the transaction an effect is checked, and the signature is
 * verified over the exact bytes the wallet signed. Nothing here is ever broadcast.
 */
async function verifyAlgorandProof(address: string, message: string, signedTxnBase64: string): Promise<boolean> {
  const algosdk = await import('algosdk')
  const blob = Buffer.from(signedTxnBase64.trim(), 'base64')
  if (blob.length === 0 || blob.length > 4096) return false
  const stxn = algosdk.decodeSignedTransaction(Uint8Array.from(blob))
  const txn = stxn.txn
  if (!stxn.sig || stxn.sgnr || stxn.msig || stxn.lsig) return false
  if (txn.type !== algosdk.TransactionType.pay || !txn.payment) return false
  const sender = txn.sender.toString()
  const receiver = txn.payment.receiver.toString()
  if (sender !== address || receiver !== address) return false
  if (txn.payment.amount !== 0n) return false
  if (txn.payment.closeRemainderTo) return false
  if (txn.rekeyTo) return false
  if (txn.lease && txn.lease.some((b) => b !== 0)) return false
  const note = txn.note ? Buffer.from(txn.note).toString('utf8') : ''
  if (note !== message) return false
  const pub = algosdk.decodeAddress(address).publicKey
  return ed25519Verify(pub, txn.bytesToSign(), Uint8Array.from(stxn.sig))
}

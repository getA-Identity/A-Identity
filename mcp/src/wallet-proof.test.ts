/**
 * Wallet proofs across the three ecosystems, offline: real keys, real signatures, and
 * every refusal a proof can earn. Nothing here touches a network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import algosdk from 'algosdk'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import {
  walletEcosystemOf, normalizeWalletAddress, signInMessage, shortAddress, decodeSignature64, ed25519Verify, verifyWalletProof,
} from './wallet-proof.js'

const EVM = '0x6A5F1b8e56A19D456b799C2fA00E513244F58Ce6'
const STELLAR = 'GBMF7MDHLF6E5GWNCUJZKDBID5LCU5U5K7J26MRUJCM2FK7J7VZXTZZ3'
const ALGO = algosdk.generateAccount()

test('walletEcosystemOf: an address is recognised by its shape, or refused', () => {
  assert.equal(walletEcosystemOf(EVM), 'evm')
  assert.equal(walletEcosystemOf(STELLAR), 'stellar')
  assert.equal(walletEcosystemOf(ALGO.addr.toString()), 'algorand')
  assert.equal(walletEcosystemOf('#6271'), null)
  assert.equal(walletEcosystemOf('SBMF7MDHLF6E5GWNCUJZKDBID5LCU5U5K7J26MRUJCM2FK7J7VZXTZZ3'), null) // a Stellar secret is not an address
  assert.equal(walletEcosystemOf(''), null)
})

test('normalizeWalletAddress: EVM lowercases, base32 ecosystems keep their case', () => {
  assert.equal(normalizeWalletAddress(EVM, 'evm'), EVM.toLowerCase())
  assert.equal(normalizeWalletAddress(STELLAR, 'stellar'), STELLAR)
  assert.equal(normalizeWalletAddress(` ${ALGO.addr.toString()} `, 'algorand'), ALGO.addr.toString())
})

test('signInMessage: one sentence, address and nonce in the body, link purpose says link', () => {
  const m = signInMessage(STELLAR, 'abc123')
  assert.match(m, /^A-Identity: sign in with your wallet\./)
  assert.ok(m.includes(`Address: ${STELLAR}`) && m.includes('Nonce: abc123'))
  assert.match(signInMessage(STELLAR, 'n', 'link'), /link this wallet to your account/)
  assert.equal(shortAddress(STELLAR), 'GBMF7M...TZZ3')
})

test('decodeSignature64: base64 and hex both decode to 64 bytes; anything else is null', () => {
  const raw = Buffer.alloc(64, 7)
  assert.deepEqual(decodeSignature64(raw.toString('base64')), Uint8Array.from(raw))
  assert.deepEqual(decodeSignature64(raw.toString('hex')), Uint8Array.from(raw))
  assert.deepEqual(decodeSignature64('0x' + raw.toString('hex')), Uint8Array.from(raw))
  assert.equal(decodeSignature64('not a signature'), null)
  assert.equal(decodeSignature64(Buffer.alloc(32).toString('base64')), null)
})

test('stellar: a SEP-43 signature over the raw message verifies, in base64 and in hex', async () => {
  const kp = Keypair.random()
  const message = signInMessage(kp.publicKey(), 'nonce-1')
  const sig = kp.sign(Buffer.from(message, 'utf8'))
  assert.equal(await verifyWalletProof({ ecosystem: 'stellar', address: kp.publicKey(), message, signature: sig.toString('base64') }), true)
  assert.equal(await verifyWalletProof({ ecosystem: 'stellar', address: kp.publicKey(), message, signature: sig.toString('hex') }), true)
})

test('stellar: the wrong key, a changed message or garbage is refused', async () => {
  const kp = Keypair.random()
  const other = Keypair.random()
  const message = signInMessage(kp.publicKey(), 'nonce-2')
  const sig = kp.sign(Buffer.from(message, 'utf8')).toString('base64')
  assert.equal(await verifyWalletProof({ ecosystem: 'stellar', address: other.publicKey(), message, signature: sig }), false)
  assert.equal(await verifyWalletProof({ ecosystem: 'stellar', address: kp.publicKey(), message: message + ' ', signature: sig }), false)
  assert.equal(await verifyWalletProof({ ecosystem: 'stellar', address: kp.publicKey(), message, signature: 'zzz' }), false)
  assert.equal(await verifyWalletProof({ ecosystem: 'stellar', address: 'GNOTANADDRESS', message, signature: sig }), false)
})

test('ed25519Verify: refuses wrong-length keys and signatures without throwing', () => {
  assert.equal(ed25519Verify(new Uint8Array(31), new Uint8Array(1), new Uint8Array(64)), false)
  assert.equal(ed25519Verify(new Uint8Array(32), new Uint8Array(1), new Uint8Array(63)), false)
})

const PARAMS: algosdk.SuggestedParams = {
  fee: 1000, minFee: 1000, flatFee: true, firstValid: 1, lastValid: 1000,
  genesisID: 'mainnet-v1.0', genesisHash: Uint8Array.from(Buffer.alloc(32, 1)),
}
function selfPayment(account: algosdk.Account, message: string, over: Partial<{ amount: number; receiver: string; rekeyTo: string; note: string }> = {}) {
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr,
    receiver: over.receiver ?? account.addr.toString(),
    amount: over.amount ?? 0,
    note: new TextEncoder().encode(over.note ?? message),
    rekeyTo: over.rekeyTo,
    suggestedParams: PARAMS,
  })
  return Buffer.from(txn.signTxn(account.sk)).toString('base64')
}

test('algorand: a signed zero-value self-payment whose note is the message verifies', async () => {
  const message = signInMessage(ALGO.addr.toString(), 'nonce-3')
  assert.equal(await verifyWalletProof({ ecosystem: 'algorand', address: ALGO.addr.toString(), message, signature: selfPayment(ALGO, message) }), true)
})

test('algorand: anything that could move value or change control is refused', async () => {
  const message = signInMessage(ALGO.addr.toString(), 'nonce-4')
  const other = algosdk.generateAccount()
  const addr = ALGO.addr.toString()
  assert.equal(await verifyWalletProof({ ecosystem: 'algorand', address: addr, message, signature: selfPayment(ALGO, message, { amount: 1 }) }), false, 'amount')
  assert.equal(await verifyWalletProof({ ecosystem: 'algorand', address: addr, message, signature: selfPayment(ALGO, message, { receiver: other.addr.toString() }) }), false, 'receiver')
  assert.equal(await verifyWalletProof({ ecosystem: 'algorand', address: addr, message, signature: selfPayment(ALGO, message, { rekeyTo: other.addr.toString() }) }), false, 'rekey')
  assert.equal(await verifyWalletProof({ ecosystem: 'algorand', address: addr, message, signature: selfPayment(ALGO, message, { note: 'something else' }) }), false, 'note')
  assert.equal(await verifyWalletProof({ ecosystem: 'algorand', address: other.addr.toString(), message, signature: selfPayment(ALGO, message) }), false, 'other address')
  assert.equal(await verifyWalletProof({ ecosystem: 'algorand', address: addr, message, signature: 'not-msgpack' }), false, 'garbage')
})

test('evm: a personal_sign signature verifies against its address and no other', async () => {
  const account = privateKeyToAccount(generatePrivateKey())
  const message = signInMessage(account.address.toLowerCase(), 'nonce-5')
  const signature = await account.signMessage({ message })
  assert.equal(await verifyWalletProof({ ecosystem: 'evm', address: account.address, message, signature }), true)
  assert.equal(await verifyWalletProof({ ecosystem: 'evm', address: EVM, message, signature }), false)
  assert.equal(await verifyWalletProof({ ecosystem: 'evm', address: account.address, message: message + '!', signature }), false)
})

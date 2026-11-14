import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'
import { KeyPair } from '@near-js/crypto'
import { KeyPairSigner } from '@near-js/signers'
import { actionCreators, buildDelegateAction, createTransaction, decodeSignedTransaction, encodeSignedDelegate, encodeTransaction } from '@near-js/transactions'
import { baseDecode, baseEncode } from '@near-js/utils'
import { createHash } from 'node:crypto'
import { getChainById } from '../chains/registry.js'
import { encodeRelayTransaction, nearVerifyReads, relayerFromEnv, relaySignedDelegate, signRelayTransaction, __resetRelayForTests } from './relay.js'
import { fakeNear } from './fake-near.js'

/**
 * The relayer: the outer transaction it builds is byte for byte what @near-js builds, its hash is
 * known before the send, it sends to one host, it retries a refused nonce once, and its key stays
 * out of every string it can produce.
 */
const NEAR = getChainById('near-testnet')!
const USDC = NEAR.documentedTokens!.find((t) => t.symbol === 'USDC')!.address
const PRIMARY = new URL(NEAR.rpcUrls[0]).host
const RELAYER = 'x402-relayer.a-identity.testnet'
const PAYER = 'aid-demo-agent.testnet'
const PAY_TO = 'a-identity.testnet'

async function signedDelegate(buyer: KeyPair, o: { nonce: bigint; maxBlockHeight: bigint }) {
  const da = buildDelegateAction({
    actions: [actionCreators.functionCall('ft_transfer', { receiver_id: PAY_TO, amount: '10000' }, 30_000_000_000_000n, 1n)],
    maxBlockHeight: o.maxBlockHeight,
    nonce: o.nonce,
    publicKey: buyer.getPublicKey(),
    receiverId: USDC,
    senderId: PAYER,
  })
  const [, sd] = await new KeyPairSigner(buyer).signDelegateAction(da)
  return { sd, bytes: encodeSignedDelegate(sd) }
}

test('the outer transaction is the one @near-js builds, its hash is known before it is sent, and its signature is the relayer\'s', async () => {
  const buyer = KeyPair.fromRandom('ed25519')
  const relayer = KeyPair.fromRandom('ed25519')
  const { sd, bytes } = await signedDelegate(buyer, { nonce: 7n, maxBlockHeight: 277_430_100n })
  const blockHash = baseEncode(createHash('sha256').update('a block').digest())
  const reference = createTransaction(RELAYER, relayer.getPublicKey(), PAYER, 260_461_863_000_007n, [actionCreators.signedDelegate(sd)], baseDecode(blockHash))
  const mine = encodeRelayTransaction({ signerId: RELAYER, publicKey: relayer.getPublicKey().toString(), nonce: 260_461_863_000_007n, receiverId: PAYER, blockHash, signedDelegate: bytes })
  assert.deepEqual(Buffer.from(mine), Buffer.from(encodeTransaction(reference)))
  const [refHash, refSigned] = await new KeyPairSigner(relayer).signTransaction(reference)
  const out = signRelayTransaction({ sign: (h) => relayer.sign(h).signature }, mine)
  assert.equal(out.txHash, baseEncode(refHash))
  assert.deepEqual(Buffer.from(out.signed), Buffer.from(refSigned.encode()))
  // The buyer's delegate is relayed as the bytes it signed, not a re-encoding of them.
  const decoded = decodeSignedTransaction(out.signed)
  assert.ok((decoded.transaction.actions[0] as { signedDelegate?: unknown }).signedDelegate)
  assert.ok(Buffer.from(out.signed).includes(Buffer.from(bytes)))
  assert.throws(() => encodeRelayTransaction({ signerId: RELAYER, publicKey: relayer.getPublicKey().toString(), nonce: 1n, receiverId: PAYER, blockHash: 'abc', signedDelegate: bytes }), /32 bytes/)
})

test('the relayer comes from the env only, a missing or unusable one turns the rail off, and no reason or dump carries the key', () => {
  const pair = KeyPair.fromRandom('ed25519')
  const secret = pair.toString()
  const body = secret.slice('ed25519:'.length)
  const none = relayerFromEnv({})
  assert.equal(none.ok, false)
  if (!none.ok) assert.match(none.reason, /NEAR_X402_RELAYER_ACCOUNT and NEAR_X402_RELAYER_KEY are not set/)
  const noKey = relayerFromEnv({ NEAR_X402_RELAYER_ACCOUNT: RELAYER })
  if (!noKey.ok) assert.match(noKey.reason, /^NEAR_X402_RELAYER_KEY is not set/)
  else assert.fail('a relayer without a key')
  // A mainnet name, and keys that are not keys: refused, and the value is never repeated, not even
  // the one character a parser would quote back.
  for (const [env, why] of [
    [{ NEAR_X402_RELAYER_ACCOUNT: 'relayer.near', NEAR_X402_RELAYER_KEY: secret }, /testnet only/],
    [{ NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: `${body}` }, /is set but is not an ed25519 NEAR secret key/],
    [{ NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: `ed25519:${body.slice(0, 20)}!` }, /is set but is not/],
    [{ NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: `ed25519:${body.slice(0, 30)}` }, /is set but is not/],
    [{ NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: `secp256k1:${body}` }, /is set but is not/],
  ] as const) {
    const r = relayerFromEnv(env)
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.match(r.reason, why)
      assert.ok(!r.reason.includes(body.slice(0, 12)), 'a reason quotes the key')
    }
  }
  // An implicit account is a testnet account too.
  assert.equal(relayerFromEnv({ NEAR_X402_RELAYER_ACCOUNT: 'ab'.repeat(32), NEAR_X402_RELAYER_KEY: secret }).ok, true)
  const r = relayerFromEnv({ NEAR_X402_RELAYER_ACCOUNT: ` ${RELAYER} `, NEAR_X402_RELAYER_KEY: ` ${secret} ` })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.relayer.accountId, RELAYER)
  assert.equal(r.relayer.publicKey, pair.getPublicKey().toString())
  for (const shown of [JSON.stringify(r), JSON.stringify(r.relayer), inspect(r, { depth: 9, showHidden: true }), String(r.relayer.sign)]) {
    assert.ok(!shown.includes(body), 'the relayer object shows its key')
  }
})

test('relay: the hash reaches beforeSend before the send, one host takes the send, and the node\'s FINAL answer comes back', async () => {
  __resetRelayForTests()
  const buyer = KeyPair.fromRandom('ed25519')
  const relayer = KeyPair.fromRandom('ed25519')
  const chain = fakeNear({
    token: USDC,
    accounts: {
      [RELAYER]: { keys: { [relayer.getPublicKey().toString()]: { nonce: 40n, permission: 'FullAccess' } } },
      [PAYER]: { keys: { [buyer.getPublicKey().toString()]: { nonce: 5n, permission: 'FullAccess' } } },
    },
    balances: { [PAYER]: 50_000n },
    registered: [PAY_TO],
  })
  const { bytes } = await signedDelegate(buyer, { nonce: 6n, maxBlockHeight: BigInt(chain.height + 100) })
  const r = relayerFromEnv({ NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: relayer.toString() })
  assert.ok(r.ok)
  if (!r.ok) return
  const seen: string[] = []
  const out = await relaySignedDelegate(
    { chain: NEAR, relayer: r.relayer, payer: PAYER, signedDelegate: bytes, beforeSend: (h) => void seen.push(`${h} sends=${chain.sends.length}`) },
    { fetchImpl: chain.fetch, env: {} },
  )
  assert.equal(out.kind, 'final')
  assert.equal(chain.sends.length, 1)
  assert.deepEqual(seen, [`${chain.sends[0].hash} sends=0`], 'the hash was known, and recorded, before anything was sent')
  assert.equal(out.txHash, chain.sends[0].hash)
  assert.equal(chain.sends[0].nonce, 41n)
  assert.equal(chain.sends[0].relayerSignatureValid, true)
  assert.ok(chain.calls.filter((c) => c.method === 'send_tx').every((c) => c.host === PRIMARY))
  assert.equal(chain.balances.get(PAY_TO), 10_000n)
})

test('relay: a refused nonce signs once more with the nonce the node named; a beforeSend that fails sends nothing', async () => {
  __resetRelayForTests()
  const buyer = KeyPair.fromRandom('ed25519')
  const relayer = KeyPair.fromRandom('ed25519')
  const accounts = {
    [RELAYER]: { keys: { [relayer.getPublicKey().toString()]: { nonce: 40n, permission: 'FullAccess' as const } } },
    [PAYER]: { keys: { [buyer.getPublicKey().toString()]: { nonce: 5n, permission: 'FullAccess' as const } } },
  }
  const chain = fakeNear({ token: USDC, accounts, balances: { [PAYER]: 50_000n }, registered: [PAY_TO], refuseNonce: 1 })
  const { bytes } = await signedDelegate(buyer, { nonce: 6n, maxBlockHeight: BigInt(chain.height + 100) })
  const r = relayerFromEnv({ NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: relayer.toString() })
  if (!r.ok) return assert.fail(r.reason)
  const hashes: string[] = []
  const out = await relaySignedDelegate({ chain: NEAR, relayer: r.relayer, payer: PAYER, signedDelegate: bytes, beforeSend: (h) => void hashes.push(h) }, { fetchImpl: chain.fetch, env: {} })
  assert.equal(out.kind, 'final')
  assert.deepEqual(chain.sends.map((s) => s.outcome), ['refused', 'final'])
  assert.equal(hashes.length, 2)
  assert.notEqual(hashes[0], hashes[1], 'the second try is a new transaction')
  assert.equal(out.txHash, hashes[1])

  const quiet = fakeNear({ token: USDC, accounts, balances: { [PAYER]: 50_000n }, registered: [PAY_TO] })
  await assert.rejects(
    relaySignedDelegate({ chain: NEAR, relayer: r.relayer, payer: PAYER, signedDelegate: bytes, beforeSend: () => { throw new Error('the record could not be written') } }, { fetchImpl: quiet.fetch, env: {} }),
    /the record could not be written/,
  )
  assert.equal(quiet.sends.length, 0)
  assert.equal(quiet.calls.filter((c) => c.method === 'send_tx').length, 0)
})

test('relay: a send that times out is looked up by its hash and never sent again, or to another host', async () => {
  __resetRelayForTests()
  const buyer = KeyPair.fromRandom('ed25519')
  const relayer = KeyPair.fromRandom('ed25519')
  const accounts = {
    [RELAYER]: { keys: { [relayer.getPublicKey().toString()]: { nonce: 40n, permission: 'FullAccess' as const } } },
    [PAYER]: { keys: { [buyer.getPublicKey().toString()]: { nonce: 5n, permission: 'FullAccess' as const } } },
  }
  const r = relayerFromEnv({ NEAR_X402_RELAYER_ACCOUNT: RELAYER, NEAR_X402_RELAYER_KEY: relayer.toString() })
  if (!r.ok) return assert.fail(r.reason)
  const landed = fakeNear({ token: USDC, accounts: structuredClone(accounts), balances: { [PAYER]: 50_000n }, registered: [PAY_TO], send: 'timeout_landed' })
  const one = await signedDelegate(buyer, { nonce: 6n, maxBlockHeight: BigInt(landed.height + 100) })
  const a = await relaySignedDelegate({ chain: NEAR, relayer: r.relayer, payer: PAYER, signedDelegate: one.bytes, beforeSend: () => {} }, { fetchImpl: landed.fetch, env: {}, sleep: async () => {}, pollMs: 0 })
  assert.equal(a.kind, 'final', 'found by its hash')
  assert.equal(landed.calls.filter((c) => c.method === 'send_tx').length, 1)

  __resetRelayForTests()
  const lost = fakeNear({ token: USDC, accounts: structuredClone(accounts), balances: { [PAYER]: 50_000n }, registered: [PAY_TO], send: 'timeout_lost' })
  let t = 0
  const b = await relaySignedDelegate(
    { chain: NEAR, relayer: r.relayer, payer: PAYER, signedDelegate: one.bytes, beforeSend: () => {} },
    { fetchImpl: lost.fetch, env: {}, sleep: async () => {}, pollMs: 0, lookupMs: 3, now: () => t++ },
  )
  assert.equal(b.kind, 'unknown')
  assert.equal(b.txHash, lost.sends[0].hash)
  const sendsTo = lost.calls.filter((c) => c.method === 'send_tx').map((c) => c.host)
  assert.deepEqual(sendsTo, [PRIMARY], 'one send, to one host')
  assert.ok(lost.calls.some((c) => c.method === 'tx' && c.params.tx_hash === b.txHash && c.params.sender_account_id === RELAYER))
})

test('the reads @x402/near verifies with answer for near:testnet only, at final, and fail closed', async () => {
  const chain = fakeNear({ token: USDC, accounts: { [PAYER]: { keys: { 'ed25519:2CHL4RuYp4a84rh2bVZo6iVZci99SUkQzCpbG3HgVryf': { nonce: 9n, permission: 'FunctionCall' } } } }, balances: { [PAYER]: 5n }, registered: [PAY_TO] })
  const reads = nearVerifyReads(NEAR, RELAYER, { fetchImpl: chain.fetch, env: {} })
  assert.deepEqual(reads.getRelayerIds(), [RELAYER])
  await assert.rejects(reads.getCurrentBlockHeight('near:mainnet'), /near:testnet only/)
  assert.equal(await reads.getCurrentBlockHeight('near:testnet'), BigInt(chain.height))
  assert.deepEqual(await reads.viewAccessKey({ network: 'near:testnet', accountId: PAYER, publicKey: 'ed25519:2CHL4RuYp4a84rh2bVZo6iVZci99SUkQzCpbG3HgVryf' }), { nonce: 9n, permissionKind: 'FunctionCall' })
  assert.equal(await reads.viewAccessKey({ network: 'near:testnet', accountId: PAYER, publicKey: 'ed25519:HTmjPWtrAKpYPmwkkABEiSWRHbqKVsfVFrjp5aKnwD7d' }), null)
  assert.equal(await reads.viewAccount({ network: 'near:testnet', accountId: 'nobody-here-zz.testnet' }), null)
  assert.equal(await reads.ftBalanceOf({ network: 'near:testnet', token: USDC, accountId: PAYER }), 5n)
  assert.deepEqual(await reads.storageBalanceOf({ network: 'near:testnet', token: USDC, accountId: PAY_TO }), { supported: true, registered: true })
  assert.deepEqual(await reads.storageBalanceOf({ network: 'near:testnet', token: USDC, accountId: 'unregistered.testnet' }), { supported: true, registered: false })
  await assert.rejects(reads.submitSignedDelegateAction({ network: 'near:testnet', relayerId: RELAYER, signedDelegateAction: '' }), /not used/)
  assert.equal(chain.calls.filter((c) => c.method === 'send_tx').length, 0)
})

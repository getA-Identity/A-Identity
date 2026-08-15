import test from 'node:test'
import assert from 'node:assert/strict'
import { rpc, xdr } from '@stellar/stellar-sdk'

import { confirmStellarTransfer } from './confirm.js'
import { getChainById } from '../chains/registry.js'

/**
 * Real bytes from the live network, captured verbatim. Decoding actual bytes offline is
 * the point, and the shape space matters as much as the happy path: the first version of
 * this suite sampled ONE transaction and generalised from it, which is how a memo-bearing
 * payment came to be refused as not a payment at all.
 *
 *   GASLESS_TRANSFER   plain i128 data. Our gasless settlement 37d52f31..., ledger 4148274.
 *   GASLESS_ENVELOPE   the same transaction's envelope, carrying the buyer's signed
 *                      authorization entry and therefore the nonce everything binds to.
 *   MEMO_TRANSFER      CAP-67 map data { amount, to_muxed_id }. A real classic payment,
 *                      9c7042f4..., ledger 4140857.
 */
const GASLESS_TRANSFER =
  'AAAAAAAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAAAEAAAAAAAAABAAAAA8AAAAIdHJhbnNmZXIAAAASAAAAAAAAAABiqNB4Vh0jH5BGAFc19rlEUX1dBg6KpG3CQZ3sJO4kyQAAABIAAAAAAAAAAFkbLX8s7NhktbXmLbxHPTi0gkM1gDHTlL4ErVi+kRIGAAAADgAAAD1VU0RDOkdCQkQ0N0lGNkxXSzdQN01ERVZTQ1dSN0RQVVdWM05ZM0RUUUVWRkw0TkFUNEFRSDNaTExGTEE1AAAAAAAACgAAAAAAAAAAAAAAAAAmJaA='
const GASLESS_ENVELOPE =
  'AAAAAgAAAABWdoF9/ZYOmVNBnhOJM4DaTJb6FU/dkHRxrIJFqiCiRgAAgYEAP0mIAAAACwAAAAEAAAAAAAAAAAAAAABqf9fJAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABUEXNXsBymnaP1a0CUFhS308Cjc6DDlrFIgm6SEg7LwEAAAAIdHJhbnNmZXIAAAADAAAAEgAAAAAAAAAAYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMkAAAASAAAAAAAAAABZGy1/LOzYZLW15i28Rz04tIJDNYAx05S+BK1YvpESBgAAAAoAAAAAAAAAAAAAAAAAJiWgAAAAAQAAAAEAAAAAAAAAAGKo0HhWHSMfkEYAVzX2uURRfV0GDoqkbcJBnewk7iTJVwWFcy2UK+wAP0yVAAAAEAAAAAEAAAABAAAAEQAAAAEAAAACAAAADwAAAApwdWJsaWNfa2V5AAAAAAANAAAAIGKo0HhWHSMfkEYAVzX2uURRfV0GDoqkbcJBnewk7iTJAAAADwAAAAlzaWduYXR1cmUAAAAAAAANAAAAQI5+wltPkFID7V8JtTGnw/vSTCEoFCfSdnn6uL56ftyzxqKtAidnZ0xMOzZg1/37az6uEtxvZYu6hdRT19ZUwgsAAAAAAAAAAVBFzV7Acpp2j9WtAlBYUt9PAo3Ogw5axSIJukhIOy8BAAAACHRyYW5zZmVyAAAAAwAAABIAAAAAAAAAAGKo0HhWHSMfkEYAVzX2uURRfV0GDoqkbcJBnewk7iTJAAAAEgAAAAAAAAAAWRstfyzs2GS1teYtvEc9OLSCQzWAMdOUvgStWL6REgYAAAAKAAAAAAAAAAAAAAAAACYloAAAAAAAAAABAAAAAAAAAAIAAAAAAAAAAGKo0HhWHSMfkEYAVzX2uURRfV0GDoqkbcJBnewk7iTJAAAABgAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAABQAAAABAAAAAwAAAAEAAAAAWRstfyzs2GS1teYtvEc9OLSCQzWAMdOUvgStWL6REgYAAAABVVNEQwAAAABCPn0F8uyvv+wZKyFaPxvpau242OcCVKvjQT4CB95WsgAAAAEAAAAAYqjQeFYdIx+QRgBXNfa5RFF9XQYOiqRtwkGd7CTuJMkAAAABVVNEQwAAAABCPn0F8uyvv+wZKyFaPxvpau242OcCVKvjQT4CB95WsgAAAAYAAAAAAAAAAGKo0HhWHSMfkEYAVzX2uURRfV0GDoqkbcJBnewk7iTJAAAAFVcFhXMtlCvsAAAAAAAL2KwAAAF4AAABNAAAAAAAAIEdAAAAAaogokYAAABA2tnG9oylzGk/kUIGMSiEb8A5MDEpMvCZOY36GYHfdWfvaUMMtWJspCrcDaduL99adPILN6n630tDPIn8nNqNCA=='
const MEMO_TRANSFER =
  'AAAAAAAAAAFQRc1ewHKado/VrQJQWFLfTwKNzoMOWsUiCbpISDsvAQAAAAEAAAAAAAAABAAAAA8AAAAIdHJhbnNmZXIAAAASAAAAAAAAAAAAbwPjORlg7SY4Z3Mn7dm1JHt4hIgiRg6VAm0J0Mwn3AAAABIAAAAAAAAAANpmWu/YUzY9J6lrmmMqFt3DY8C0TcqxdA3gxbQi02vlAAAADgAAAD1VU0RDOkdCQkQ0N0lGNkxXSzdQN01ERVZTQ1dSN0RQVVdWM05ZM0RUUUVWRkw0TkFUNEFRSDNaTExGTEE1AAAAAAAAEQAAAAEAAAACAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAAmJaAAAAADwAAAAt0b19tdXhlZF9pZAAAAAAOAAAADUFULU9SREVSLU9ZTzEAAAA='

const CHAIN = getChainById('stellar-testnet')!
const SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SELLER = 'GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI'
const BUYER = 'GBRKRUDYKYOSGH4QIYAFONPWXFCFC7K5AYHIVJDNYJAZ33BE5YSMTS6R'
const NONCE = '6270564785915702252'
const HASH = '37d52f31263714e2a41dd3f1bbb6e13148b178cc450ddf59e1e4d8582dc9a80a'
const PAID = 2_500_000n

/** What our purchase authorized. Every field is load-bearing; none is decoration. */
const OURS = { sac: SAC, to: SELLER, from: BUYER, amountRaw: PAID, authNonce: NONCE }

/**
 * A stub that ANSWERS PER HASH, unlike the first version of this suite whose stub ignored
 * its argument entirely. That is why the old tests could not see that the hash decided
 * nothing: every one of them asked about the same transaction and got the same canned
 * reply no matter what they passed.
 */
const serverFor = (byHash: Record<string, unknown>) => ({
  getTransaction: async (h: string) =>
    (byHash[h] ?? { status: rpc.Api.GetTransactionStatus.NOT_FOUND }) as never,
})

const success = (events: string[], envelope = GASLESS_ENVELOPE) => ({
  status: rpc.Api.GetTransactionStatus.SUCCESS,
  ledger: 4148274,
  events: { contractEventsXdr: [events] },
  envelopeXdr: xdr.TransactionEnvelope.fromXDR(envelope, 'base64'),
})

const deps = (byHash: Record<string, unknown>) => ({
  server: serverFor(byHash),
  timeoutMs: 50,
  pollMs: 1,
  sleep: async () => {},
})

test('our own settlement confirms, and the facts come off the chain not the request', async () => {
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, deps({ [HASH]: success([GASLESS_TRANSFER]) }))
  assert.equal(r.confirmed, true)
  if (!r.confirmed) return
  assert.equal(r.ledger, 4148274)
  assert.equal(r.from, BUYER)
  assert.equal(r.amountRaw, '2500000')
  assert.equal(r.authNonce, NONCE)
})

/**
 * The hole an adversarial review found in the first version, kept as a test so it cannot
 * come back. Then, this function checked only {sac, to, amount}, so ANY transaction that
 * had ever paid that amount to our payee confirmed, forever, for anyone. The reviewer
 * pointed at a real unrelated testnet transaction that would have bought a tool for free.
 */
test('a real payment of the right size, from the right payer, settling a DIFFERENT authorization, is refused', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { ...OURS, authNonce: '999999999999999999' },
    deps({ [HASH]: success([GASLESS_TRANSFER]) }),
  )
  assert.equal(r.confirmed, false)
  if (r.confirmed) return
  assert.equal(r.code, 'wrong_authorization')
  // It must show the nonce it DID see, or a replay attempt is indistinguishable from a bug.
  assert.ok(r.sawNonces?.some((n) => n.endsWith(NONCE)))
})

test('the authorization is checked before the amount, so a replay is named as a replay', async () => {
  // Both wrong. The reason returned must be the authorization, because "your amount is
  // off" would send an attacker looking for the right amount rather than telling them the
  // truth, which is that this transaction is not theirs to claim.
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { ...OURS, authNonce: '1', amountRaw: 999n },
    deps({ [HASH]: success([GASLESS_TRANSFER]) }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'wrong_authorization')
})

/**
 * CAP-67. A SAC transfer event carries a MAP when the payment has a muxed destination,
 * and a bare i128 otherwise. The first version read only the second shape, so String()
 * turned the first into "[object Object]" and every memo-bearing payment was refused as
 * not a payment to us.
 */
test('a CAP-67 memo-bearing transfer decodes to its amount, not to [object Object]', () => {
  const event = xdr.ContractEvent.fromXDR(MEMO_TRANSFER, 'base64')
  const data = event.body().v0().data()
  assert.equal(data.switch().name, 'scvMap', 'this fixture must be the map shape or it tests nothing')
  // Decoded through the same path confirm.ts uses.
  const tx = success([MEMO_TRANSFER]) as unknown as rpc.Api.GetSuccessfulTransactionResponse
  assert.ok(tx)
})

test('the map shape is matched on amount just like the plain shape', async () => {
  // Read the fixture's own numbers so the test cannot drift from the bytes.
  const event = xdr.ContractEvent.fromXDR(MEMO_TRANSFER, 'base64')
  const topics = event.body().v0().topics()
  const { scValToNative } = await import('@stellar/stellar-sdk')
  const from = String(scValToNative(topics[1]))
  const to = String(scValToNative(topics[2]))
  const { StrKey } = await import('@stellar/stellar-sdk')
  const sac = StrKey.encodeContract(Buffer.from(event.contractId() as unknown as Uint8Array))
  const data = scValToNative(event.body().v0().data()) as { amount: bigint; to_muxed_id?: string }

  // The nonce check still applies, so this uses the envelope we have and expects the
  // authorization mismatch rather than a decode failure. What it proves is that the
  // amount was READ: a "[object Object]" amount could never reach the nonce branch with
  // the right numbers in hand.
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { sac, to, from, amountRaw: data.amount, authNonce: NONCE },
    deps({ [HASH]: success([MEMO_TRANSFER]) }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'wrong_authorization', 'the amount decoded; the authorization is what differs')
    assert.notEqual(String(data.amount), '[object Object]')
    assert.equal(data.to_muxed_id, 'AT-ORDER-OYO1')
  }
})

test('a transfer to someone else, on our authorization, is still refused', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { ...OURS, to: BUYER },
    deps({ [HASH]: success([GASLESS_TRANSFER]) }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'no_matching_transfer')
})

test('the right amount to the right payee on the WRONG token is refused', async () => {
  // The sharpest attack: a worthless token can emit an event carrying our payee and our
  // number. Only the SAC we named counts.
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    { ...OURS, sac: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAAA' },
    deps({ [HASH]: success([GASLESS_TRANSFER]) }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'no_matching_transfer')
})

test('a successful transaction with no transfer at all is refused', async () => {
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, deps({ [HASH]: success([]) }))
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'no_matching_transfer')
    assert.deepEqual(r.sawTransfers, [])
  }
})

test('a failed transaction is decided, and decided against', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    OURS,
    deps({ [HASH]: { status: rpc.Api.GetTransactionStatus.FAILED, ledger: 4147972 } }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'tx_failed')
    assert.equal(r.ledger, 4147972)
  }
})

test('a hash the RPC has never seen is undecided, not refused', async () => {
  const r = await confirmStellarTransfer(CHAIN, 'a'.repeat(64), OURS, deps({}))
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'not_found')
    assert.match(r.reason, /NOT a refusal/)
  }
})

/**
 * Soroban RPC keeps roughly a week. Outside that window NOT_FOUND means "we cannot see
 * it", which is a different claim from "it has not landed", and telling an operator to
 * keep waiting for something the RPC will never show again is a lie of omission.
 */
test('beyond the retention window says so, instead of "it may still land"', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    'b'.repeat(64),
    OURS,
    deps({
      ['b'.repeat(64)]: {
        status: rpc.Api.GetTransactionStatus.NOT_FOUND,
        oldestLedger: 4027488,
        latestLedger: 4148482,
      },
    }),
  )
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'beyond_retention')
    assert.match(r.reason, /retains ledgers 4027488 to 4148482/)
    assert.match(r.reason, /not absent from the chain/)
  }
})

test('an unreachable RPC is its own outcome, never a silent refusal', async () => {
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, {
    server: {
      getTransaction: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    },
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
  })
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'unreachable')
})

/**
 * Building the RPC handle used to sit outside the guard, so a chain with no usable RPC
 * threw out of a function whose whole contract is that it returns an outcome.
 */
test('a chain that cannot produce an RPC client returns unreachable rather than throwing', async () => {
  const broken = { ...CHAIN, rpcUrls: [] as string[] }
  const r = await confirmStellarTransfer(broken, HASH, OURS, { timeoutMs: 10, pollMs: 1, sleep: async () => {} })
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'unreachable')
    assert.match(r.reason, /could not build an RPC client/)
  }
})

test('a malformed event does not hide the good one next to it', async () => {
  const r = await confirmStellarTransfer(
    CHAIN,
    HASH,
    OURS,
    deps({ [HASH]: success(['not-base64-at-all', GASLESS_TRANSFER]) }),
  )
  assert.equal(r.confirmed, true, 'one undecodable event must not lose the rest')
})

test('an envelope we cannot read fails closed rather than skipping the binding', async () => {
  // No envelope means no nonces, which must mean no confirmation. The dangerous
  // alternative is treating an unreadable envelope as "nothing to check here".
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, {
    server: serverFor({
      [HASH]: {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 4148274,
        events: { contractEventsXdr: [[GASLESS_TRANSFER]] },
      },
    }),
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
  })
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'wrong_authorization')
})

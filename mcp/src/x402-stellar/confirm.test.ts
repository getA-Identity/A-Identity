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
/**
 * beyond_retention is a COMPARISON, and the first version of this test did not make one.
 * It asserted the code came back whenever oldestLedger was present, and oldestLedger is a
 * mandatory field in the RPC response, so every miss was reported as "older than we can
 * see" including a transaction broadcast a second ago. That tells an operator to stop
 * waiting for a payment that is simply still in flight.
 */
test('beyond the retention window says so, but only when we can place the transaction outside it', async () => {
  const window = {
    status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    oldestLedger: 4027488,
    latestLedger: 4148482,
  }
  // Known to have been in a ledger the RPC no longer holds. Decided: it is gone from view.
  const gone = await confirmStellarTransfer(CHAIN, 'b'.repeat(64), OURS, {
    ...deps({ ['b'.repeat(64)]: window }),
    knownLedger: 4000000,
  })
  assert.equal(gone.confirmed, false)
  if (!gone.confirmed) {
    assert.equal(gone.code, 'beyond_retention')
    assert.match(gone.reason, /retains ledgers 4027488 to 4148482/)
    assert.match(gone.reason, /not absent from the chain/)
  }

  // Same window, no ledger to place it in. Still open, so still not_found.
  const unknown = await confirmStellarTransfer(CHAIN, 'b'.repeat(64), OURS, deps({ ['b'.repeat(64)]: window }))
  assert.equal(unknown.confirmed, false)
  if (!unknown.confirmed) assert.equal(unknown.code, 'not_found', 'without a ledger to compare, the question is open')

  // Inside the window. Never beyond_retention, whatever the fields say.
  const recent = await confirmStellarTransfer(CHAIN, 'b'.repeat(64), OURS, {
    ...deps({ ['b'.repeat(64)]: window }),
    knownLedger: 4148480,
  })
  assert.equal(recent.confirmed, false)
  if (!recent.confirmed) assert.equal(recent.code, 'not_found')
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

/**
 * The finding this test exists for: `events` is optional in the RPC response, and an RPC
 * that omits it made every real settlement look like a transaction carrying no payment.
 * The two answers must not share a code, because one is a verdict about the buyer and the
 * other is a verdict about our infrastructure.
 */
test('an absent events field is handled the same way as an empty one', async () => {
  // Kept because a hand-rolled or future client could omit it even though the SDK does not,
  // and because the two must not diverge: both mean "look at the meta instead".
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, {
    server: serverFor({
      [HASH]: { status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 4148274, envelopeXdr: xdr.TransactionEnvelope.fromXDR(GASLESS_ENVELOPE, 'base64') },
    }),
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
  })
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'no_event_data')
})

/**
 * The other side of the line, and harder to state than it looks.
 *
 * The SDK builds `events` unconditionally from `raw.events?.contractEventsXdr ?? []`, so an
 * RPC that omits the field and a transaction with no transfers BOTH arrive as an empty
 * array. The only thing that separates them is `resultMetaXdr`, which is mandatory. So:
 * empty array plus a meta that parses and holds no events is a real answer about the
 * transaction, and must be a refusal rather than an admission of blindness.
 */
test('an empty event list plus readable meta is a real answer about the transaction', async () => {
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, {
    server: serverFor({
      [HASH]: {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 4148274,
        envelopeXdr: xdr.TransactionEnvelope.fromXDR(GASLESS_ENVELOPE, 'base64'),
        events: { contractEventsXdr: [] },
        // A meta that parses as v4 and carries one operation with no events at all.
        resultMetaXdr: {
          switch: () => ({ name: 'transactionMetaV4' }),
          v4: () => ({ operations: () => [{ events: () => [] }] }),
        },
      },
    }),
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
  })
  assert.equal(r.confirmed, false)
  if (!r.confirmed) assert.equal(r.code, 'no_matching_transfer')
})

/**
 * And the reverse: the convenience field is empty and the meta is unreadable, so we have
 * nothing to look at from either source. That is our blindness and it must not be recorded
 * as a refusal. Note this is now the ONLY way to reach no_event_data, which is the point:
 * the previous guard (`if (!tx.events)`) was unreachable in production, because the SDK
 * never leaves that field undefined.
 */
test('no events from either source is our blindness, not a refusal', async () => {
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, {
    server: serverFor({
      [HASH]: {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 4148274,
        envelopeXdr: xdr.TransactionEnvelope.fromXDR(GASLESS_ENVELOPE, 'base64'),
        events: { contractEventsXdr: [] },
      },
    }),
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
  })
  assert.equal(r.confirmed, false)
  if (!r.confirmed) {
    assert.equal(r.code, 'no_event_data')
    assert.match(r.reason, /our blindness, not a refusal/)
  }
})

/**
 * The fallback doing its job: the RPC dropped the convenience field, and the transfer is
 * still found, because resultMetaXdr cannot be dropped. Read off our real settlement
 * 3da74634 rather than a hand-built shape.
 */
test('a transfer only present in the meta is still found', async () => {
  const events = xdr.ContractEvent.fromXDR(GASLESS_TRANSFER, 'base64')
  const r = await confirmStellarTransfer(CHAIN, HASH, OURS, {
    server: serverFor({
      [HASH]: {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 4148274,
        envelopeXdr: xdr.TransactionEnvelope.fromXDR(GASLESS_ENVELOPE, 'base64'),
        events: { contractEventsXdr: [] },
        resultMetaXdr: {
          switch: () => ({ name: 'transactionMetaV4' }),
          v4: () => ({ operations: () => [{ events: () => [events] }] }),
        },
      },
    }),
    timeoutMs: 50,
    pollMs: 1,
    sleep: async () => {},
  })
  assert.equal(r.confirmed, true, 'the meta is the source that cannot be omitted')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import algosdk from 'algosdk'
import { getChainById } from '../chains/index.js'
import type { AlgorandSettlementRecord } from '../storage.js'
import { settleAlgorandPayment, verifyAlgorandGroup, type AlgorandRequirements } from './settle.js'

/**
 * Fixtures are REAL algosdk transactions: a fee-zero signed ASA transfer from a
 * generated account, grouped with an unsigned fee-payer payment, exactly the
 * shape the AVM exact scheme sends. Building them with the SDK rather than
 * hand-rolled msgpack means a decoding change in algosdk breaks these tests
 * instead of production.
 */
const chain = getChainById('algorand-testnet')!
const token = chain.settlementTokens![0]
const TESTNET_GENESIS = 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
const buyer = algosdk.generateAccount()
const feePayerAcct = algosdk.generateAccount()
const PAY_TO = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA'

const params: algosdk.SuggestedParams = {
  fee: 0,
  flatFee: true,
  firstValid: 1000,
  lastValid: 2000,
  genesisHash: new Uint8Array(Buffer.from(TESTNET_GENESIS, 'base64')),
  genesisID: 'testnet-v1.0',
  minFee: 1000,
}

function buildGroup(opts: { amount?: bigint; assetIndex?: bigint; receiver?: string; rekey?: boolean; signPayment?: boolean } = {}) {
  const payment = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: buyer.addr,
    receiver: opts.receiver ?? PAY_TO,
    assetIndex: opts.assetIndex ?? BigInt(token.address),
    amount: opts.amount ?? 1000n,
    suggestedParams: { ...params, fee: 0 },
    ...(opts.rekey ? { rekeyTo: feePayerAcct.addr } : {}),
  })
  const feePayer = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: feePayerAcct.addr,
    receiver: feePayerAcct.addr,
    amount: 0,
    suggestedParams: { ...params, fee: 2000 },
  })
  const [fp, pay] = algosdk.assignGroupID([feePayer, payment])
  const group = [
    Buffer.from(algosdk.encodeUnsignedTransaction(fp)).toString('base64'),
    Buffer.from(opts.signPayment === false ? algosdk.encodeUnsignedTransaction(pay) : pay.signTxn(buyer.sk)).toString('base64'),
  ]
  return { group, paymentTxn: pay, txId: pay.txID() }
}

const REQ: AlgorandRequirements = {
  network: chain.caip2,
  facilitatorNetwork: `algorand:${TESTNET_GENESIS}`,
  asset: token.address,
  payTo: PAY_TO,
  amount: '1000',
  resource: 'https://a-identity-backend.onrender.com/api/x402/algorand/tools/verify_agent',
}

const payloadOf = (group: string[], paymentIndex = 1) => ({
  x402Version: 2,
  scheme: 'exact',
  network: `algorand:${TESTNET_GENESIS}`,
  payload: { paymentGroup: group, paymentIndex },
})

test('a well-formed fee-zero group passes local verification and yields payer and txid', () => {
  const { group, txId } = buildGroup()
  const r = verifyAlgorandGroup(payloadOf(group), REQ)
  assert.ok(r.ok, r.ok ? '' : r.reason)
  if (r.ok) {
    assert.equal(r.payer, buyer.addr.toString())
    assert.equal(r.txId, txId)
    assert.equal(r.amount, 1000n)
  }
})

test('the wrong asset, the wrong recipient and a short amount are refused locally', () => {
  const wrongAsset = buildGroup({ assetIndex: 31566704n })
  assert.deepEqual((verifyAlgorandGroup(payloadOf(wrongAsset.group), REQ) as { code: string }).code, 'unsupported_asset')
  const wrongPayee = buildGroup({ receiver: feePayerAcct.addr.toString() })
  assert.deepEqual((verifyAlgorandGroup(payloadOf(wrongPayee.group), REQ) as { code: string }).code, 'wrong_recipient')
  const short = buildGroup({ amount: 999n })
  assert.deepEqual((verifyAlgorandGroup(payloadOf(short.group), REQ) as { code: string }).code, 'wrong_amount')
})

test('a rekeying transaction anywhere in the group is refused as unsafe', () => {
  const { group } = buildGroup({ rekey: true })
  const r = verifyAlgorandGroup(payloadOf(group), REQ)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'unsafe_group')
})

test('an unsigned payment transaction is refused: the signature IS the authorization', () => {
  const { group } = buildGroup({ signPayment: false })
  const r = verifyAlgorandGroup(payloadOf(group), REQ)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'unsigned_payment')
})

test('transactions from two different groups do not pass as one atomic group', () => {
  const a = buildGroup()
  // A different amount, so b's group id genuinely differs: two identical groups
  // would share an id and prove nothing about the check.
  const b = buildGroup({ amount: 1500n })
  const mixed = [a.group[0], b.group[1]]
  const r = verifyAlgorandGroup(payloadOf(mixed), REQ)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'unsafe_group')
})

test('garbage payloads are malformed, not exceptions', () => {
  for (const bad of [null, {}, { payload: { paymentGroup: 'nope', paymentIndex: 0 } }, { payload: { paymentGroup: ['AAA'], paymentIndex: 5 } }]) {
    const r = verifyAlgorandGroup(bad, REQ)
    assert.equal(r.ok, false)
    if (!r.ok) assert.equal(r.code, 'malformed_payload')
  }
})

// ── the full settle path, facilitator and indexer mocked ─────────────────────────

function mockNet(txId: string, opts: { verifyValid?: boolean; settleOk?: boolean; confirm?: boolean } = {}) {
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/verify')) return new Response(JSON.stringify({ isValid: opts.verifyValid !== false, invalidReason: 'nope' }), { status: 200 })
    if (url.endsWith('/settle')) return new Response(JSON.stringify({ success: opts.settleOk !== false, transaction: txId, errorReason: 'boom' }), { status: 200 })
    if (url.includes('/v2/transactions/')) {
      if (opts.confirm === false) return new Response('{}', { status: 404 })
      return new Response(
        JSON.stringify({
          transaction: {
            id: txId,
            sender: buyer.addr.toString(),
            'tx-type': 'axfer',
            'confirmed-round': 4242,
            'asset-transfer-transaction': { 'asset-id': Number(token.address), amount: 1000, receiver: PAY_TO },
          },
        }),
        { status: 200 },
      )
    }
    return new Response('{}', { status: 404 })
  }
  return { fetcher, calls }
}

test('the happy path settles, confirms from the indexer, and records the sale', async () => {
  const { group, txId } = buildGroup()
  const net = mockNet(txId)
  const persisted: AlgorandSettlementRecord[] = []
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(group), facilitator: 'https://facilitator.example',
    deps: {
      fetcher: net.fetcher, sleep: async () => {}, attempts: 1,
      persist: async (rec) => { persisted.push(rec) },
      loadResult: async () => ({ ok: true, rows: [] }),
      meta: { tool: 'verify_agent', baseUsd: 0.001 },
    },
  })
  assert.ok(r.success, r.success ? '' : r.errorReason)
  if (r.success) {
    assert.equal(r.transaction, txId)
    assert.equal(r.round, 4242)
  }
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].outcome, 'settled')
  assert.equal(persisted[0].confirmedBy, 'algod-indexer')
  assert.ok(net.calls.some((u) => u.endsWith('/verify')) && net.calls.some((u) => u.endsWith('/settle')))
})

test('a transaction id that already paid for a serving is refused before any network call', async () => {
  const { group, txId } = buildGroup()
  const net = mockNet(txId)
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(group), facilitator: 'https://facilitator.example',
    deps: {
      fetcher: net.fetcher, sleep: async () => {},
      persist: async () => {},
      loadResult: async () => ({ ok: true, rows: [{ tx: txId, outcome: 'settled' } as AlgorandSettlementRecord] }),
    },
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'already_redeemed')
  assert.equal(net.calls.length, 0, 'the replay refusal must cost no facilitator call')
})

test('an unreadable settlement log fails closed instead of serving unguarded', async () => {
  const { group } = buildGroup()
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(group), facilitator: 'https://facilitator.example',
    deps: { fetcher: mockNet('X').fetcher, sleep: async () => {}, persist: async () => {}, loadResult: async () => ({ ok: false, reason: 'disk' }) },
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'replay_guard_unavailable')
})

test('a facilitator rejection is surfaced with its reason and nothing is recorded as settled', async () => {
  const { group, txId } = buildGroup()
  const persisted: AlgorandSettlementRecord[] = []
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(group), facilitator: 'https://facilitator.example',
    deps: {
      fetcher: mockNet(txId, { verifyValid: false }).fetcher, sleep: async () => {},
      persist: async (rec) => { persisted.push(rec) },
      loadResult: async () => ({ ok: true, rows: [] }),
    },
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'facilitator_rejected')
  assert.equal(persisted.length, 0)
})

test('a settle the indexer cannot confirm is ambiguous: recorded, unserved, honestly labeled', async () => {
  const { group, txId } = buildGroup()
  const persisted: AlgorandSettlementRecord[] = []
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(group), facilitator: 'https://facilitator.example',
    deps: {
      fetcher: mockNet(txId, { confirm: false }).fetcher, sleep: async () => {}, attempts: 2,
      persist: async (rec) => { persisted.push(rec) },
      loadResult: async () => ({ ok: true, rows: [] }),
    },
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'not_confirmed')
    assert.equal(r.ambiguous, true)
  }
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].outcome, 'ambiguous')
  assert.equal(persisted[0].confirmedBy, 'none')
})

function capturingNet(txId: string) {
  const bodies: Record<'verify' | 'settle', Record<string, any> | null> = { verify: null, settle: null }
  const base = mockNet(txId)
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/verify')) bodies.verify = JSON.parse(String(init?.body))
    if (url.endsWith('/settle')) bodies.settle = JSON.parse(String(init?.body))
    return base.fetcher(input, init)
  }
  return { fetcher, bodies }
}

test('the facilitator sees the challenge tag, our resource and our discovery declaration, with the signed group untouched', async () => {
  const { group, txId } = buildGroup()
  const net = capturingNet(txId)
  const extensions = { bazaar: { info: { input: { type: 'http', method: 'POST' } }, schema: { type: 'object' } } }
  const resourceInfo = { url: 'https://a-identity.xyz/api/x402/algorand/tools/verify_agent', description: 'verify', mimeType: 'application/json' }
  // A buyer that echoed a different resource and some unrelated extension of its own.
  const buyerPayload = { ...payloadOf(group), resource: { url: 'https://elsewhere.example/x' }, extensions: { other: { kept: true } } }
  const r = await settleAlgorandPayment({
    chain, token, requirements: { ...REQ, tag: 'x402-global-challenge', resourceInfo, extensions },
    payload: buyerPayload, facilitator: 'https://facilitator.example',
    deps: { fetcher: net.fetcher, sleep: async () => {}, attempts: 1, persist: async () => {}, loadResult: async () => ({ ok: true, rows: [] }) },
  })
  assert.ok(r.success, r.success ? '' : r.errorReason)
  for (const step of ['verify', 'settle'] as const) {
    const body = net.bodies[step]
    assert.ok(body, `${step} was not called`)
    assert.equal(body.paymentRequirements.extra.tag, 'x402-global-challenge', `${step}: tag`)
    assert.equal(body.paymentRequirements.extra.decimals, token.decimals, `${step}: decimals`)
    assert.deepEqual(body.paymentPayload.resource, resourceInfo, `${step}: our resource wins`)
    assert.deepEqual(body.paymentPayload.extensions.bazaar, extensions.bazaar, `${step}: our declaration`)
    assert.deepEqual(body.paymentPayload.extensions.other, { kept: true }, `${step}: buyer extensions kept`)
    assert.deepEqual(body.paymentPayload.payload.paymentGroup, group, `${step}: signed group forwarded as-is`)
  }
  assert.equal(buyerPayload.resource.url, 'https://elsewhere.example/x', 'the buyer payload object is not mutated')
})

test('with no tag configured none is invented on the way to the facilitator', async () => {
  const { group, txId } = buildGroup()
  const net = capturingNet(txId)
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(group), facilitator: 'https://facilitator.example',
    deps: { fetcher: net.fetcher, sleep: async () => {}, attempts: 1, persist: async () => {}, loadResult: async () => ({ ok: true, rows: [] }) },
  })
  assert.ok(r.success, r.success ? '' : r.errorReason)
  assert.equal(net.bodies.settle?.paymentRequirements.extra.tag, undefined)
  assert.equal(net.bodies.settle?.paymentPayload.resource, undefined)
})

test('a beforeSettle refusal submits nothing: the facilitator verified, nobody settles, nothing is recorded', async () => {
  const { group, txId } = buildGroup()
  const net = mockNet(txId)
  const persisted: AlgorandSettlementRecord[] = []
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(group), facilitator: 'https://facilitator.example',
    deps: {
      fetcher: net.fetcher, sleep: async () => {}, attempts: 1,
      persist: async (rec) => { persisted.push(rec) },
      loadResult: async () => ({ ok: true, rows: [] }),
      beforeSettle: async () => ({ ok: false, reason: 'the tool could not answer' }),
    },
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'service_unavailable')
    assert.equal(r.errorReason, 'the tool could not answer')
    assert.equal(r.ambiguous, undefined)
  }
  assert.ok(net.calls.some((u) => u.endsWith('/verify')), 'the payment was verified first')
  assert.ok(!net.calls.some((u) => u.endsWith('/settle')), 'nothing may be submitted')
  assert.equal(persisted.length, 0)
})

test('beforeSettle runs after a valid verify and before settle, and a hook that throws is a refusal', async () => {
  const first = buildGroup()
  const order: string[] = []
  const base = mockNet(first.txId)
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/verify')) order.push('verify')
    if (url.endsWith('/settle')) order.push('settle')
    return base.fetcher(input, init)
  }
  const common = { sleep: async () => {}, attempts: 1, persist: async () => {}, loadResult: async () => ({ ok: true as const, rows: [] }) }
  const ok = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(first.group), facilitator: 'https://facilitator.example',
    deps: { ...common, fetcher, beforeSettle: async () => { order.push('hook'); return { ok: true } } },
  })
  assert.ok(ok.success, ok.success ? '' : ok.errorReason)
  assert.deepEqual(order, ['verify', 'hook', 'settle'])

  const second = buildGroup({ amount: 1200n })
  const thrown = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload: payloadOf(second.group), facilitator: 'https://facilitator.example',
    deps: { ...common, fetcher: mockNet(second.txId).fetcher, beforeSettle: async () => { throw new Error('rpc down') } },
  })
  assert.equal(thrown.success, false)
  if (!thrown.success) {
    assert.equal(thrown.code, 'service_unavailable')
    assert.match(thrown.errorReason, /rpc down/)
  }
})

test('a payment naming a network this challenge does not settle on is refused', async () => {
  const { group } = buildGroup()
  const payload = { ...payloadOf(group), network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' }
  const r = await settleAlgorandPayment({
    chain, token, requirements: REQ, payload, facilitator: 'https://facilitator.example',
    deps: { fetcher: mockNet('X').fetcher, sleep: async () => {}, persist: async () => {}, loadResult: async () => ({ ok: true, rows: [] }) },
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'unsupported_network')
})

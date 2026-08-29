import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getChainById } from '../chains/index.js'
import { confirmAlgorandTransfer, indexerBase, type TransferExpectation } from './confirm.js'

const chain = getChainById('algorand-testnet')!
const PAY_TO = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA'
const PAYER = '2UEQTE5QDNXPI7M3TU44G6SYKLFWLPQO7EBZM7K7MHMQQMFI4QJPLHQFHM'
const TX = 'UTXPSO7OSSQN6NFFI6QESOSMUGRMUMO7HVBMRTBTL6RLPFMUFWVQ'

const EXPECT: TransferExpectation = { txId: TX, asset: '10458941', payTo: PAY_TO, minAmount: 1000n, payer: PAYER }

const goodTxn = {
  transaction: {
    id: TX,
    sender: PAYER,
    'tx-type': 'axfer',
    'confirmed-round': 123456,
    'asset-transfer-transaction': { 'asset-id': 10458941, amount: 1000, receiver: PAY_TO },
  },
}

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const noSleep = async () => {}

test('the indexer base derives from the registry algod host, -api. becoming -idx.', () => {
  const base = indexerBase(chain, {})
  assert.ok(base.includes('-idx.'), base)
  assert.ok(!base.includes('-api.'), base)
})

test('ALGORAND_TESTNET_INDEXER_URL overrides the derivation', () => {
  assert.equal(indexerBase(chain, { ALGORAND_TESTNET_INDEXER_URL: 'https://example.test/idx/' }), 'https://example.test/idx')
})

test('a confirmed matching transfer is accepted with its round', async () => {
  const r = await confirmAlgorandTransfer(chain, EXPECT, { fetcher: async () => jsonRes(goodTxn), sleep: noSleep, attempts: 1 })
  assert.deepEqual(r, { ok: true, txId: TX, round: 123456 })
})

test('a 404 retries and then reports not-indexed rather than inventing success', async () => {
  let calls = 0
  const r = await confirmAlgorandTransfer(chain, EXPECT, {
    fetcher: async () => { calls++; return jsonRes({}, 404) },
    sleep: noSleep,
    attempts: 3,
  })
  assert.equal(calls, 3)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /not in the indexer/)
})

test('the wrong asset is a hard refusal, not a retry', async () => {
  let calls = 0
  const wrong = structuredClone(goodTxn)
  wrong.transaction['asset-transfer-transaction']['asset-id'] = 31566704
  const r = await confirmAlgorandTransfer(chain, EXPECT, {
    fetcher: async () => { calls++; return jsonRes(wrong) },
    sleep: noSleep,
    attempts: 5,
  })
  assert.equal(calls, 1, 'a mismatch must not be polled into agreement')
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /ASA 31566704/)
})

test('the wrong recipient, a short amount and the wrong sender are each refused', async () => {
  for (const mutate of [
    (t: typeof goodTxn) => { t.transaction['asset-transfer-transaction'].receiver = PAYER },
    (t: typeof goodTxn) => { t.transaction['asset-transfer-transaction'].amount = 999 },
    (t: typeof goodTxn) => { t.transaction.sender = PAY_TO },
  ]) {
    const body = structuredClone(goodTxn)
    mutate(body)
    const r = await confirmAlgorandTransfer(chain, EXPECT, { fetcher: async () => jsonRes(body), sleep: noSleep, attempts: 1 })
    assert.equal(r.ok, false)
  }
})

test('a transaction without a confirmed round keeps polling instead of counting', async () => {
  const pending = structuredClone(goodTxn)
  delete (pending.transaction as Record<string, unknown>)['confirmed-round']
  const r = await confirmAlgorandTransfer(chain, EXPECT, { fetcher: async () => jsonRes(pending), sleep: noSleep, attempts: 2 })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /without a confirmed round/)
})

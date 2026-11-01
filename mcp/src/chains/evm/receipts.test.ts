import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockFromEveryRpc, receiptFromEveryRpc, transactionFromEveryRpc, rpcSourceLabel, type RpcCall } from './receipts.js'
import { resolveRpcUrls } from './client.js'
import { getChainById } from '../registry.js'

/**
 * Receipts read from every host, one at a time, fed by fake transports.
 *
 * The reason this exists is a host that answers null for a receipt it should have: viem's
 * fallback transport takes that null as the answer and never asks the next host. So the
 * cases below are all about who gets asked, in which order, and what "nobody had it" is
 * allowed to mean.
 */
const arc = getChainById('arc-mainnet')!
const HASH = '0x' + 'c1'.repeat(32)
const OTHER = '0x' + 'c2'.repeat(32)
const [A, B, C, D] = ['https://a.rpc.test', 'https://b.rpc.test', 'https://c.rpc.test', 'https://d.rpc.test']

function rawReceipt(hash = HASH, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transactionHash: hash,
    blockHash: '0x' + 'bb'.repeat(32),
    blockNumber: '0x15a8e21',
    from: '0x8c8d9cd12d8896a40cf2115ee731258bb4983349',
    to: '0xe07819e6d28a5dfd5a9f4cd94dc6dc9aeeda4146',
    status: '0x1',
    gasUsed: '0x160e5',
    cumulativeGasUsed: '0x160e5',
    effectiveGasPrice: '0x4ae0f4c00',
    logs: [],
    logsBloom: '0x' + '00'.repeat(256),
    transactionIndex: '0x0',
    type: '0x2',
    contractAddress: null,
    ...over,
  }
}

function rawTx(hash = HASH): Record<string, unknown> {
  return {
    hash,
    blockHash: '0x' + 'bb'.repeat(32),
    blockNumber: '0x15a8e21',
    from: '0x8c8d9cd12d8896a40cf2115ee731258bb4983349',
    to: '0xe07819e6d28a5dfd5a9f4cd94dc6dc9aeeda4146',
    input: '0xc4076876' + '00'.repeat(64),
    gas: '0x1c9c3',
    maxFeePerGas: '0x59dbbf000',
    maxPriorityFeePerGas: '0x3b9aca00',
    nonce: '0x7',
    value: '0x0',
    type: '0x2',
    chainId: '0x' + (arc.evmChainId as number).toString(16),
    transactionIndex: '0x0',
    v: '0x0',
    r: '0x' + '11'.repeat(32),
    s: '0x' + '22'.repeat(32),
  }
}

type Answer = unknown | Error | (() => Promise<unknown>)

/** A fake caller: each url answers from its script, round by round (the last entry repeats). */
function fake(script: Record<string, Answer[]>): { call: RpcCall; asked: string[]; methods: string[]; params: unknown[][]; deadlines: number[] } {
  const asked: string[] = []
  const methods: string[] = []
  const params: unknown[][] = []
  const deadlines: number[] = []
  const seen = new Map<string, number>()
  const call: RpcCall = async (url, method, p, timeoutMs) => {
    asked.push(url)
    methods.push(method)
    params.push([...p])
    deadlines.push(timeoutMs)
    const n = seen.get(url) ?? 0
    seen.set(url, n + 1)
    const answers = script[url] ?? [null]
    const a = answers[Math.min(n, answers.length - 1)]
    if (a instanceof Error) throw a
    if (typeof a === 'function') return (a as () => Promise<unknown>)()
    return a
  }
  return { call, asked, methods, params, deadlines }
}

test('a host that answers null does not end the read: the next host that has the receipt wins', async () => {
  const f = fake({ [A]: [null], [B]: [rawReceipt()], [C]: [rawReceipt()] })
  const r = await receiptFromEveryRpc(arc, HASH, { urls: [A, B, C], call: f.call })
  assert.equal(r.status, 'found')
  if (r.status !== 'found') return
  assert.equal(r.url, B)
  assert.equal(r.rounds, 1)
  assert.equal(r.value.status, 'success')
  assert.equal(r.value.blockNumber, 0x15a8e21n)
  assert.deepEqual(r.answers.map((a) => a.answer), ['null', 'found'])
  // First non-null wins: the host after it is never asked.
  assert.deepEqual(f.asked, [A, B])
  assert.deepEqual([...new Set(f.methods)], ['eth_getTransactionReceipt'])
})

test('every registry host is asked in order, and the env override takes the primary slot without being published', async () => {
  const override = 'https://user:secret@private.node.test/key/abc'
  const env = { [arc.rpcEnvVar as string]: override } as NodeJS.ProcessEnv
  const f = fake({})
  const r = await receiptFromEveryRpc(arc, HASH, { env, call: f.call })
  assert.equal(r.status, 'not_found')
  assert.deepEqual(f.asked, resolveRpcUrls(arc, env))
  assert.equal(f.asked[0], override)
  assert.equal(f.asked.length, arc.rpcUrls.length)
  // The override may carry credentials, so a record names it and never prints it.
  assert.equal(rpcSourceLabel(arc, override), `${arc.rpcEnvVar} override`)
  assert.equal(rpcSourceLabel(arc, arc.rpcUrls[2]), new URL(arc.rpcUrls[2]).host)
})

test('not found anywhere and unreachable are told apart, and one answering host is enough for not found', async () => {
  const allNull = await receiptFromEveryRpc(arc, HASH, { urls: [A, B], call: fake({ [A]: [null], [B]: [null] }).call })
  assert.equal(allNull.status, 'not_found')

  const down = new Error('fetch failed')
  const allDown = await receiptFromEveryRpc(arc, HASH, { urls: [A, B], call: fake({ [A]: [down], [B]: [down] }).call })
  assert.equal(allDown.status, 'unreachable')
  assert.deepEqual(allDown.answers.map((a) => [a.answer, a.error]), [['error', 'fetch failed'], ['error', 'fetch failed']])

  const mixed = await receiptFromEveryRpc(arc, HASH, { urls: [A, B], call: fake({ [A]: [down], [B]: [null] }).call })
  assert.equal(mixed.status, 'not_found')

  const none = await receiptFromEveryRpc(arc, HASH, { urls: [], call: fake({}).call })
  assert.equal(none.status, 'unreachable')
})

test('rounds repeat inside the budget and stop as soon as a host has the receipt', async () => {
  let clock = 0
  const sleeps: number[] = []
  const f = fake({ [A]: [null, null, null, rawReceipt()], [B]: [null, null, rawReceipt()] })
  const r = await receiptFromEveryRpc(arc, HASH, {
    urls: [A, B],
    call: f.call,
    timeoutMs: 10_000,
    pollMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
  })
  assert.equal(r.status, 'found')
  if (r.status !== 'found') return
  assert.equal(r.rounds, 3)
  assert.equal(r.url, B)
  assert.deepEqual(sleeps, [1000, 1000])
  assert.deepEqual(f.asked, [A, B, A, B, A, B])

  // With the budget spent and nobody holding it, the read ends rather than polling forever.
  clock = 0
  const g = fake({ [A]: [null], [B]: [null] })
  const gone = await receiptFromEveryRpc(arc, HASH, {
    urls: [A, B],
    call: g.call,
    timeoutMs: 2500,
    pollMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  })
  assert.equal(gone.status, 'not_found')
  assert.equal(gone.rounds, 3)

  // The default budget is one round.
  const once = fake({ [A]: [null], [B]: [null] })
  const single = await receiptFromEveryRpc(arc, HASH, { urls: [A, B], call: once.call, sleep: async () => assert.fail('no second round') })
  assert.equal(single.rounds, 1)
})

test('a stalled host costs its own deadline, and the next host is still asked', async () => {
  const f = fake({ [A]: [() => new Promise(() => {})], [B]: [rawReceipt()] })
  const r = await receiptFromEveryRpc(arc, HASH, { urls: [A, B], call: f.call, perCallTimeoutMs: 20 })
  assert.equal(r.status, 'found')
  assert.deepEqual(r.answers[0], { url: A, answer: 'error', error: 'no answer within 20 ms' })
})

test('an answer about another transaction, or a malformed one, is a failing host and not proof', async () => {
  const f = fake({
    [A]: [rawReceipt(OTHER)],
    [B]: [{ transactionHash: HASH }],
    [C]: ['0xdeadbeef'],
    [D]: [rawReceipt(HASH, { status: '0x0' })],
  })
  const r = await receiptFromEveryRpc(arc, HASH, { urls: [A, B, C, D], call: f.call })
  assert.equal(r.status, 'found')
  if (r.status !== 'found') return
  assert.equal(r.url, D)
  assert.equal(r.value.status, 'reverted')
  assert.deepEqual(r.answers.map((a) => a.answer), ['error', 'error', 'error', 'found'])
  assert.match(r.answers[0].error ?? '', /another transaction/)
  assert.match(r.answers[1].error ?? '', /no status/)
})

test('the transaction read-back asks every host too, as it had to for an old Arc Mainnet vault payment', async () => {
  // Shaped on 2026-11-01: for 0xc1f3eb7f only dRPC, the third host, returned the transaction.
  const urls = arc.rpcUrls
  const f = fake({ [urls[0]]: [null], [urls[1]]: [null], [urls[2]]: [rawTx()], [urls[3]]: [null] })
  const r = await transactionFromEveryRpc(arc, HASH, { urls, call: f.call })
  assert.equal(r.status, 'found')
  if (r.status !== 'found') return
  assert.equal(r.url, urls[2])
  assert.equal(r.value.from, '0x8c8d9cd12d8896a40cf2115ee731258bb4983349')
  assert.equal(r.value.input.slice(0, 10), '0xc4076876')
  assert.equal(r.value.maxFeePerGas, 0x59dbbf000n)
  assert.deepEqual([...new Set(f.methods)], ['eth_getTransactionByHash'])
  assert.deepEqual(f.asked, urls.slice(0, 3))
})

test('something that is not a transaction hash is refused before any host is asked', async () => {
  const f = fake({})
  await assert.rejects(() => receiptFromEveryRpc(arc, '0x1234', { urls: [A], call: f.call }), TypeError)
  await assert.rejects(() => transactionFromEveryRpc(arc, 'not-a-hash', { urls: [A], call: f.call }), TypeError)
  await assert.rejects(() => blockFromEveryRpc(arc, { number: -1n }, { urls: [A], call: f.call }), TypeError)
  await assert.rejects(() => blockFromEveryRpc(arc, { number: 1n, hash: '0x12' }, { urls: [A], call: f.call }), TypeError)
  assert.deepEqual(f.asked, [])
})

const BLOCK_HASH = '0x' + 'bb'.repeat(32)

function rawBlock(number: bigint, hash = BLOCK_HASH, timestamp = 1_793_542_458n): Record<string, unknown> {
  return {
    number: '0x' + number.toString(16),
    hash,
    parentHash: '0x' + 'aa'.repeat(32),
    timestamp: '0x' + timestamp.toString(16),
    gasLimit: '0x1c9c380',
    gasUsed: '0x0',
    baseFeePerGas: '0x4a817c800',
    miner: '0x' + '00'.repeat(20),
    transactions: [],
    uncles: [],
    logsBloom: '0x' + '00'.repeat(256),
  }
}

test("a block is read from every host too, and only an answer carrying the receipt's block hash counts", async () => {
  // A lagging host answers null for a height it has not reached; a host on another fork holds
  // another block at that height. Neither is the block the receipt was mined in.
  const n = 0x15a8e21n
  const f = fake({ [A]: [null], [B]: [rawBlock(n, '0x' + 'cc'.repeat(32))], [C]: [rawBlock(n)], [D]: [rawBlock(n)] })
  const r = await blockFromEveryRpc(arc, { number: n, hash: BLOCK_HASH.toUpperCase().replace('0X', '0x') }, { urls: [A, B, C, D], call: f.call })
  assert.equal(r.status, 'found')
  if (r.status !== 'found') return
  assert.equal(r.url, C)
  assert.deepEqual(r.value, { number: n, hash: BLOCK_HASH, timestamp: 1_793_542_458n })
  assert.deepEqual(r.answers.map((a) => a.answer), ['null', 'error', 'found'])
  assert.match(r.answers[1].error ?? '', /another block at this height/)
  assert.deepEqual([...new Set(f.methods)], ['eth_getBlockByNumber'])
  assert.deepEqual(f.params[0], ['0x15a8e21', false], 'by height, header only')

  // An answer for another height is a failing host as well.
  const g = fake({ [A]: [rawBlock(n + 1n)], [B]: [rawBlock(n)] })
  const other = await blockFromEveryRpc(arc, { number: n }, { urls: [A, B], call: g.call })
  assert.equal(other.status === 'found' && other.url, B)
})

test('a hard deadline ends the read inside a round: no host is asked after it, and each call is cut to what is left', async () => {
  // The round budget alone would let this round run on; the hard deadline does not.
  let clock = 0
  const f = fake({
    [A]: [
      async () => {
        clock += 50
        return null
      },
    ],
    [B]: [rawReceipt()],
  })
  const r = await receiptFromEveryRpc(arc, HASH, { urls: [A, B], call: f.call, timeoutMs: 10_000, hardTimeoutMs: 40, perCallTimeoutMs: 5000, now: () => clock, sleep: async () => assert.fail('no second round') })
  assert.equal(r.status, 'not_found')
  assert.equal(r.rounds, 1)
  assert.deepEqual(f.asked, [A], 'B was never asked')
  assert.deepEqual(f.deadlines, [40], "A's call was given what was left of the deadline, not its own 5000 ms")
  assert.deepEqual(r.answers[1], { url: B, answer: 'error', error: 'not asked: the read ran out of time' })

  // A call in flight is cut off at the deadline rather than at its own, longer one.
  clock = 0
  const stalled = fake({
    [A]: [
      () => {
        clock += 30
        return new Promise(() => {})
      },
    ],
    [B]: [rawReceipt()],
  })
  const t0 = Date.now()
  const cut = await receiptFromEveryRpc(arc, HASH, { urls: [A, B], call: stalled.call, hardTimeoutMs: 25, perCallTimeoutMs: 5000, now: () => clock })
  assert.ok(Date.now() - t0 < 2000, 'cut off near 25 ms, not at 5000')
  assert.equal(cut.status, 'unreachable')
  assert.deepEqual(cut.answers.map((a) => a.error), ['no answer within 25 ms', 'not asked: the read ran out of time'])

  // No time at all asks nobody.
  const none = fake({ [A]: [rawReceipt()] })
  const zero = await receiptFromEveryRpc(arc, HASH, { urls: [A], call: none.call, hardTimeoutMs: 0 })
  assert.equal(zero.status, 'unreachable')
  assert.deepEqual(none.asked, [])
})

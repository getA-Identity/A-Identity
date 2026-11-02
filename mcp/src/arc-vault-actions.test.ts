import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeAbiParameters, keccak256, toHex } from 'viem'
import { FROZEN_SET_TOPIC, WITHDRAWN_TOPIC, actionOfLog, createOwnerActionReader, type ActionVault } from './arc-vault-actions.js'
import type { RpcHost } from './arc-owner-vault-live.js'

/**
 * Owner actions read from a chain of plain answers. A hash published here is evidence for a
 * milestone, so these hold what must not slip: only the owner's own wallet is published, an
 * unfreeze is not a freeze, no query is wider than the hosts allow, a window nobody answered is
 * never skipped, and whatever could not be read says so.
 */
const VAULT = '0x' + 'a1'.repeat(20)
const OWNER = '0x' + 'b2'.repeat(20)
const STRANGER = '0x' + 'c3'.repeat(20)
const OTHER = '0x' + 'd4'.repeat(20)
const vault: ActionVault = { address: VAULT, owner: OWNER, deployTx: '0x' + 'de'.repeat(32), deployBlock: '1000' }
const hash = (n: number) => keccak256(toHex(n))

const frozen = (on: boolean) => encodeAbiParameters([{ type: 'bool' }], [on])
const amount = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n])
type FakeLog = { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string }
const freezeLog = (block: number, txHash: string, on = true, address = VAULT): FakeLog => ({ address, topics: [FROZEN_SET_TOPIC], data: frozen(on), transactionHash: txHash, blockNumber: toHex(block) })
const withdrawLog = (block: number, txHash: string, n = 5n): FakeLog => ({ address: VAULT, topics: [WITHDRAWN_TOPIC, '0x' + '00'.repeat(32)], data: amount(n), transactionHash: txHash, blockNumber: toHex(block) })

type LogFilter = { address: string; fromBlock: string; toBlock: string; topics: string[][] }

function chain(opts: { head?: number; logs?: FakeLog[]; senders?: Record<string, string | null>; failLogs?: (from: bigint) => boolean; label?: string; onLogs?: (f: LogFilter) => void } = {}): RpcHost {
  return {
    label: opts.label ?? 'host',
    request: async (method, params) => {
      if (method === 'eth_blockNumber') return toHex(opts.head ?? 30_000)
      if (method === 'eth_getLogs') {
        const f = params[0] as LogFilter
        opts.onLogs?.(f)
        if (opts.failLogs?.(BigInt(f.fromBlock))) throw new Error('rate limit exceeded')
        return (opts.logs ?? []).filter((l) => BigInt(l.blockNumber) >= BigInt(f.fromBlock) && BigInt(l.blockNumber) <= BigInt(f.toBlock))
      }
      if (method === 'eth_getTransactionByHash') {
        const from = opts.senders?.[params[0] as string]
        return from ? { hash: params[0], from, to: VAULT, nonce: '0x1', input: '0x', blockHash: null } : null
      }
      if (method === 'eth_getTransactionReceipt') return { transactionHash: params[0], blockNumber: toHex(1000), blockHash: '0x1', contractAddress: VAULT }
      throw new Error(`unexpected ${method}`)
    },
  }
}

const reader = (hosts: RpcHost[], over: Partial<Parameters<typeof createOwnerActionReader>[0]> = {}) => createOwnerActionReader({ hosts, waitMs: 5_000, lagBlocks: 0n, ...over })

test('a freeze and a withdrawal from the owner are published; the same from anyone else is not', async () => {
  const [mine, mineOut, theirs, theirsOut] = [hash(1), hash(2), hash(3), hash(4)]
  const r = reader([
    chain({
      logs: [freezeLog(1500, mine), withdrawLog(1600, mineOut), freezeLog(1700, theirs), withdrawLog(1800, theirsOut)],
      senders: { [mine]: OWNER.toUpperCase().replace('0X', '0x'), [mineOut]: OWNER, [theirs]: STRANGER, [theirsOut]: STRANGER },
    }),
  ])
  const a = (await r.read([vault])).get(VAULT)
  assert.ok(a)
  assert.deepEqual(a.freezeTxs, [{ txHash: mine, block: '1500' }])
  assert.deepEqual(a.withdrawTxs, [{ txHash: mineOut, block: '1600' }])
  assert.equal(a.read.state, 'complete')
  assert.equal(a.read.scannedToBlock, '30000')
})

test('an unfreeze is not a freeze, a zero withdrawal is not a withdrawal, and a removed or foreign log is nothing', () => {
  assert.equal(actionOfLog(freezeLog(1, hash(1), true), VAULT), 'freeze')
  assert.equal(actionOfLog(freezeLog(1, hash(1), false), VAULT), null)
  assert.equal(actionOfLog(withdrawLog(1, hash(1), 1n), VAULT), 'withdraw')
  assert.equal(actionOfLog(withdrawLog(1, hash(1), 0n), VAULT), null)
  assert.equal(actionOfLog({ ...freezeLog(1, hash(1)), removed: true }, VAULT), null)
  assert.equal(actionOfLog(freezeLog(1, hash(1), true, OTHER), VAULT), null)
  assert.equal(actionOfLog({ ...freezeLog(1, hash(1)), topics: ['0x' + '00'.repeat(32)] }, VAULT), null)
  assert.equal(actionOfLog({ ...freezeLog(1, hash(1)), data: '0x' }, VAULT), null)
})

test('no query is wider than 10,000 blocks, each names the vault and the two events, and no block is skipped', async () => {
  const seen: LogFilter[] = []
  const r = reader([chain({ head: 25_500, onLogs: (f) => seen.push(f) })])
  await r.read([vault])
  assert.equal(seen.length, 3)
  let expected = 1000n
  for (const f of seen) {
    assert.equal(f.address, VAULT)
    assert.deepEqual(f.topics, [[FROZEN_SET_TOPIC, WITHDRAWN_TOPIC]])
    assert.equal(BigInt(f.fromBlock), expected)
    assert.ok(BigInt(f.toBlock) - BigInt(f.fromBlock) + 1n <= 10_000n)
    expected = BigInt(f.toBlock) + 1n
  }
  assert.equal(expected, 25_501n)
})

test('a failed window stops the scan there, is said plainly, keeps what was verified, and resumes without a gap', async () => {
  const mine = hash(1)
  const later = hash(2)
  let failing = true
  const seen: bigint[] = []
  const t = { now: 0 }
  const r = reader(
    [
      chain({
        logs: [freezeLog(1500, mine), withdrawLog(15_000, later)],
        senders: { [mine]: OWNER, [later]: OWNER },
        failLogs: (from) => failing && from >= 11_000n,
        onLogs: (f) => seen.push(BigInt(f.fromBlock)),
      }),
    ],
    { now: () => t.now },
  )
  const first = (await r.read([vault])).get(VAULT)
  assert.ok(first)
  assert.equal(first.read.state, 'unreadable')
  assert.match(first.read.reason ?? '', /no host answered for the blocks from 11000/)
  assert.match(first.read.reason ?? '', /rate limit/)
  assert.equal(first.read.scannedToBlock, '10999')
  assert.deepEqual(first.freezeTxs.map((x) => x.txHash), [mine])
  assert.deepEqual(first.withdrawTxs, [])

  failing = false
  t.now = 60_000
  seen.length = 0
  const second = (await r.read([vault])).get(VAULT)
  assert.ok(second)
  assert.equal(second.read.state, 'complete')
  assert.equal(seen[0], 11_000n)
  assert.deepEqual(second.withdrawTxs.map((x) => x.txHash), [later])
})

test('a sender no host can read is not published, is named as unread, and is asked again', async () => {
  const mine = hash(1)
  const senders: Record<string, string | null> = { [mine]: null }
  const t = { now: 0 }
  const r = reader([chain({ logs: [freezeLog(1500, mine)], senders })], { now: () => t.now })
  const first = (await r.read([vault])).get(VAULT)
  assert.ok(first)
  assert.deepEqual(first.freezeTxs, [])
  assert.equal(first.read.state, 'unreadable')
  assert.match(first.read.reason ?? '', /sender of 1 transaction/)

  senders[mine] = OWNER
  t.now = 60_000
  const second = (await r.read([vault])).get(VAULT)
  assert.ok(second)
  assert.deepEqual(second.freezeTxs.map((x) => x.txHash), [mine])
  assert.equal(second.read.state, 'complete')
})

test('hosts that disagree about a sender publish nothing, even when one says it was the owner', async () => {
  const mine = hash(1)
  const logs = [freezeLog(1500, mine)]
  const r = reader([chain({ logs, senders: { [mine]: OWNER } }), chain({ logs, senders: { [mine]: STRANGER }, label: 'other' })])
  const a = (await r.read([vault])).get(VAULT)
  assert.ok(a)
  assert.deepEqual(a.freezeTxs, [])
  assert.equal(a.read.state, 'unreadable')
})

test('a host that refuses hands over to the next, which stays first', async () => {
  const mine = hash(1)
  const counts = { a: 0, b: 0 }
  const a = chain({ label: 'a', failLogs: () => true, onLogs: () => void counts.a++, senders: { [mine]: OWNER } })
  const b = chain({ label: 'b', logs: [freezeLog(1500, mine)], onLogs: () => void counts.b++, senders: { [mine]: OWNER } })
  const r = reader([a, b])
  const got = (await r.read([vault])).get(VAULT)
  assert.ok(got)
  assert.equal(got.read.state, 'complete')
  assert.equal(got.freezeTxs.length, 1)
  assert.equal(counts.a, 1)
  assert.equal(counts.b, 3)
})

test('no host at all: every vault says so, and nothing is published', async () => {
  const dead: RpcHost = {
    label: 'dead',
    request: async () => {
      throw new Error('connect ECONNREFUSED')
    },
  }
  const a = (await reader([dead]).read([vault])).get(VAULT)
  assert.ok(a)
  assert.equal(a.read.state, 'unreadable')
  assert.match(a.read.reason ?? '', /ECONNREFUSED/)
  assert.deepEqual([a.freezeTxs, a.withdrawTxs], [[], []])
})

test('a request does not wait for a long scan: it says it is still reading, and the scan goes on', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const mine = hash(1)
  const inner = chain({ logs: [freezeLog(1500, mine)], senders: { [mine]: OWNER } })
  const slow: RpcHost = {
    label: 'slow',
    request: async (method, params) => {
      if (method === 'eth_getLogs') await gate
      return inner.request(method, params)
    },
  }
  const r = reader([slow], { waitMs: 5 })
  const first = (await r.read([vault])).get(VAULT)
  assert.ok(first)
  assert.equal(first.read.state, 'reading')
  assert.deepEqual(first.freezeTxs, [])
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = (await r.read([vault])).get(VAULT)
  assert.ok(second)
  assert.equal(second.read.state, 'complete')
  assert.equal(second.freezeTxs.length, 1)
})

test('within the TTL a request costs no chain read, also after a failure; a new vault is read at once; no vault costs nothing', async () => {
  let reads = 0
  const counting = (fail: boolean): RpcHost => ({
    label: 'c',
    request: async (method) => {
      reads += 1
      if (fail) throw new Error('down')
      if (method === 'eth_blockNumber') return toHex(1500)
      if (method === 'eth_getLogs') return []
      return null
    },
  })
  const t = { now: 1000 }
  const failing = reader([counting(true)], { now: () => t.now })
  await failing.read([vault])
  const afterFailure = reads
  await failing.read([vault])
  assert.equal(reads, afterFailure)

  reads = 0
  const r = reader([counting(false)], { now: () => t.now })
  await r.read([])
  assert.equal(reads, 0)
  await r.read([vault])
  const once = reads
  assert.ok(once > 0)
  await r.read([vault])
  assert.equal(reads, once)
  await r.read([vault, { ...vault, address: OTHER }])
  assert.ok(reads > once)
  const twice = reads
  t.now += 60_000
  await r.read([vault])
  assert.ok(reads > twice)
})

test('a vault with no known deploy block takes it from its receipt, and a missing receipt is said plainly', async () => {
  const seen: bigint[] = []
  const r = reader([chain({ head: 1200, onLogs: (f) => seen.push(BigInt(f.fromBlock)) })])
  const a = (await r.read([{ ...vault, deployBlock: undefined }])).get(VAULT)
  assert.ok(a)
  assert.equal(a.read.state, 'complete')
  assert.equal(seen[0], 1000n)

  const noReceipt: RpcHost = {
    label: 'n',
    request: async (method) => (method === 'eth_blockNumber' ? toHex(1200) : null),
  }
  const b = (await reader([noReceipt]).read([{ ...vault, deployBlock: undefined }])).get(VAULT)
  assert.ok(b)
  assert.equal(b.read.state, 'unreadable')
  assert.match(b.read.reason ?? '', /deploy receipt/)
})

test('it stops short of the head by the lag, so a host a little behind cannot answer empty for blocks it has not seen', async () => {
  const seen: bigint[] = []
  const r = createOwnerActionReader({ hosts: [chain({ head: 1500, onLogs: (f) => seen.push(BigInt(f.toBlock)) })], waitMs: 5_000 })
  const a = (await r.read([vault])).get(VAULT)
  assert.ok(a)
  assert.equal(seen[0], 1480n)
  assert.equal(a.read.scannedToBlock, '1480')
})

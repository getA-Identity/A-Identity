import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem'
import { answeredFlow, recordVtpReceipt } from './receipt.js'
import { storageVtpStore, type VtpStore } from './context.js'
import { gasCostUsdc, ownerPayCalldata, payCalldata } from './prepare.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { getChainById, txUrl, type RpcCall } from '../chains/index.js'
import { persistVtpFlow, type VtpFlowRecord, type VtpStoreIo } from '../storage.js'

/**
 * The only door to executed: a receipt the server reads itself, from every RPC, that proves
 * the payment the flow prepared. These run the real flow store against a temporary file, so
 * the compare-and-set and the one-transaction-one-flow rule are the ones production uses.
 *
 * The receipts are shaped on a real one: the launch-day vault's operator payment on Arc
 * Mainnet (0xc1f3eb7f), which carries the vault's Paid event, USDC's Transfer in 6 decimals,
 * and a second Transfer of the same payment in 18 decimals from Arc's native-balance system
 * address. Only USDC's own may count.
 *
 * Block numbers: the preflight read block 90, the verdict came back in block 100, and the
 * payment lands in block 101 unless a case says otherwise.
 */
const arc = getChainById('arc-mainnet')!
const URLS = arc.rpcUrls
const USDC = (arc.contracts.usdc as string).toLowerCase()
const NATIVE_SYSTEM = '0xfffffffffffffffffffffffffffffffffffffffe'
const VAULT = '0x' + 'a1'.repeat(20)
const OWNER = '0x' + 'b2'.repeat(20)
const OPERATOR = '0x' + 'c3'.repeat(20)
const PAYEE = '0x' + 'd4'.repeat(20)
const FLOW = '0x' + 'ab'.repeat(32)
const HASH = '0x' + 'c1'.repeat(32)
const AMOUNT = 250_000n
const NOW = Date.parse('2026-11-01T10:05:00Z')
const BLOCK_HASH = '0x' + 'bb'.repeat(32)
/** The payment block's own timestamp: two seconds before the server reads the receipt. */
const MINED = BigInt(Math.floor(NOW / 1000) - 2)

const TRANSFER_EVENT = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const

function flow(over: Partial<VtpFlowRecord> = {}): VtpFlowRecord {
  return {
    v: 1,
    flowId: FLOW,
    network: arc.caip2,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    vault: VAULT,
    owner: OWNER,
    operator: OPERATOR,
    payee: PAYEE,
    payeeAgentId: null,
    asset: USDC,
    amount: AMOUNT.toString(),
    amountUsd: 0.25,
    check: { authNonce: FLOW, transferId: 'tr-1', gatewayOutcome: 'credited', payer: OPERATOR, value: '5000', tool: 'risk_check', checkedAt: '2026-11-01T10:00:00.000Z', checkedAtBlock: '90', verdictBlock: '100' },
    verdict: { decision: 'ALLOW', effective: 'ALLOW', risk: 'low', reasons: ['strong'], reputationScore: 720, agentId: PAYEE, checkedAt: '2026-11-01T10:00:00.000Z' },
    payOnWarn: false,
    prepared: { from: OPERATOR, to: VAULT, data: payCalldata(PAYEE, AMOUNT), function: 'pay(address,uint256)', args: [PAYEE, AMOUNT.toString()] },
    outcome: 'pending',
    detail: 'agent_will_pay',
    ...over,
  }
}

const hex = (n: bigint | number) => `0x${n.toString(16)}`

function rawLog(address: string, topics: readonly unknown[], data: Hex, i: number) {
  return { address, topics, data, blockNumber: hex(101), blockHash: BLOCK_HASH, transactionHash: HASH, transactionIndex: '0x0', logIndex: hex(i), removed: false }
}

function paidLog(o: { address?: string; to?: string; amount?: bigint; byOwner?: boolean } = {}, i = 2) {
  const topics = encodeEventTopics({ abi: AgentSpendPolicyAbi, eventName: 'Paid', args: { to: (o.to ?? PAYEE) as Hex, dayIndex: 20_758n } })
  return rawLog(o.address ?? VAULT, topics, encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [o.amount ?? AMOUNT, o.byOwner ?? false]), i)
}

function transferLog(o: { address?: string; from?: string; to?: string; value?: bigint } = {}, i = 1) {
  const topics = encodeEventTopics({ abi: TRANSFER_EVENT, eventName: 'Transfer', args: { from: (o.from ?? VAULT) as Hex, to: (o.to ?? PAYEE) as Hex } })
  return rawLog(o.address ?? USDC, topics, encodeAbiParameters([{ type: 'uint256' }], [o.value ?? AMOUNT]), i)
}

/** Arc's native-balance Transfer of the same payment, 18 decimals, from the system address. */
const nativeLog = (i = 0) => transferLog({ address: NATIVE_SYSTEM, value: AMOUNT * 10n ** 12n }, i)

function rawReceipt(o: { status?: '0x1' | '0x0'; block?: number; logs?: unknown[]; from?: string; hash?: string } = {}) {
  return {
    transactionHash: o.hash ?? HASH,
    blockHash: BLOCK_HASH,
    blockNumber: hex(o.block ?? 101),
    from: o.from ?? OPERATOR,
    to: VAULT,
    status: o.status ?? '0x1',
    gasUsed: hex(90_341),
    cumulativeGasUsed: hex(90_341),
    effectiveGasPrice: hex(20_100_000_000n),
    logs: o.logs ?? [nativeLog(0), transferLog(), paidLog()],
    logsBloom: '0x' + '00'.repeat(256),
    transactionIndex: '0x0',
    type: '0x2',
    contractAddress: null,
  }
}

function rawTx(o: { from?: string; to?: string; input?: string; hash?: string } = {}) {
  return {
    hash: o.hash ?? HASH,
    blockHash: '0x' + 'bb'.repeat(32),
    blockNumber: hex(101),
    from: o.from ?? OPERATOR,
    to: o.to ?? VAULT,
    input: o.input ?? payCalldata(PAYEE, AMOUNT),
    gas: hex(139_644),
    maxFeePerGas: hex(41_002_000_000n),
    maxPriorityFeePerGas: hex(1_000_000_000n),
    nonce: '0x7',
    value: '0x0',
    type: '0x2',
    chainId: hex(arc.evmChainId as number),
    transactionIndex: '0x0',
    v: '0x0',
    r: '0x' + '11'.repeat(32),
    s: '0x' + '22'.repeat(32),
  }
}

function rawBlock(number: bigint, hash = BLOCK_HASH, timestamp = MINED) {
  return { number: hex(number), hash, parentHash: '0x' + 'aa'.repeat(32), timestamp: hex(timestamp), gasLimit: hex(30_000_000), gasUsed: '0x0', baseFeePerGas: hex(20_000_000_000n), miner: '0x' + '00'.repeat(20), transactions: [], uncles: [], logsBloom: '0x' + '00'.repeat(256) }
}

/** Per method, per host: what each RPC answers. Missing means null. An Error is thrown.
 *  Blocks: every host has the one asked for, with the receipt's block hash, unless told otherwise. */
type Hosts = Partial<Record<string, unknown>>
function rpc(receipts: Hosts, txs: Hosts = {}, blocks?: Hosts): { call: RpcCall; asked: string[] } {
  const asked: string[] = []
  const call: RpcCall = async (url, method, params) => {
    asked.push(`${method}@${url}`)
    const a =
      method === 'eth_getBlockByNumber'
        ? blocks
          ? (blocks[url] ?? null)
          : rawBlock(BigInt(params[0] as string))
        : ((method === 'eth_getTransactionReceipt' ? receipts : txs)[url] ?? null)
    if (a instanceof Error) throw a
    return a
  }
  return { call, asked }
}

async function storeWith(rows: VtpFlowRecord[]): Promise<{ store: VtpStore; io: VtpStoreIo }> {
  const io: VtpStoreIo = { file: join(mkdtempSync(join(tmpdir(), 'vtp-receipt-')), 'vtp-flows.json'), getPool: async () => null }
  for (const r of rows) assert.deepEqual(await persistVtpFlow(r, io), { ok: true, inserted: true })
  return { store: storageVtpStore(io), io }
}

const deps = (store: VtpStore, call: RpcCall) => ({ store, now: () => NOW, receipts: { urls: URLS, call, timeoutMs: 0 } })

test('a receipt the first hosts lack is read from the next, and the vault Paid plus the USDC Transfer mark the flow executed', async () => {
  const { store } = await storeWith([flow()])
  // Circle's primary and Blockdaemon answer null; dRPC has it.
  const r = rpc({ [URLS[2]]: rawReceipt() })
  const out = await recordVtpReceipt(FLOW, HASH.toUpperCase().replace('0X', '0x'), deps(store, r.call))
  assert.equal(out.httpStatus, 200, JSON.stringify(out.body))
  assert.equal(out.body.verified, true)
  assert.deepEqual([out.body.outcome, out.body.detail], ['executed', 'agent_paid'])
  const p = out.body.payment!
  assert.equal(p.txHash, HASH)
  assert.equal(p.status, 'success')
  assert.equal(p.byOwner, false)
  assert.equal(p.blockNumber, '101')
  assert.equal(p.from, OPERATOR)
  assert.equal(p.costUsdc, gasCostUsdc(arc, 90_341n * 20_100_000_000n))
  assert.equal(p.readBackFrom, new URL(URLS[2]).host)
  assert.equal(p.readBackAt, new Date(NOW).toISOString())
  // The chain's time for the payment, from its own block, apart from when it was read.
  assert.equal(p.minedAt, new Date(Number(MINED) * 1000).toISOString())
  assert.equal(p.explorerUrl, txUrl(arc, HASH))
  assert.deepEqual(r.asked, [...URLS.slice(0, 3).map((u) => `eth_getTransactionReceipt@${u}`), `eth_getBlockByNumber@${URLS[0]}`])

  const row = (await store.load(FLOW)) as { ok: true; row: VtpFlowRecord }
  assert.deepEqual([row.row.outcome, row.row.detail, row.row.payment?.txHash], ['executed', 'agent_paid', HASH])

  // The same hash again is what was recorded, without asking the chain twice.
  const again = rpc({})
  const repeat = await recordVtpReceipt(FLOW, HASH, deps(store, again.call))
  assert.equal(repeat.httpStatus, 200)
  assert.deepEqual(repeat.body.payment, p)
  assert.deepEqual(again.asked, [])
})

test('a receipt that does not prove this payment leaves the row exactly as it was', async () => {
  const other = '0x' + '99'.repeat(20)
  const cases: [string, ReturnType<typeof rawReceipt>, string][] = [
    ['Paid to another payee', rawReceipt({ logs: [transferLog(), paidLog({ to: other })] }), 'NO_MATCHING_PAID'],
    ['Paid for another amount', rawReceipt({ logs: [transferLog(), paidLog({ amount: AMOUNT - 1n })] }), 'NO_MATCHING_PAID'],
    ['a Paid event from another contract', rawReceipt({ logs: [transferLog(), paidLog({ address: other })] }), 'NO_MATCHING_PAID'],
    ['no Paid event at all', rawReceipt({ logs: [transferLog()] }), 'NO_MATCHING_PAID'],
    ["only the native-balance Transfer, not USDC's", rawReceipt({ logs: [nativeLog(0), paidLog()] }), 'NO_MATCHING_TRANSFER'],
    ['a USDC Transfer from another address', rawReceipt({ logs: [transferLog({ from: other }), paidLog()] }), 'NO_MATCHING_TRANSFER'],
    ['a USDC Transfer for another amount', rawReceipt({ logs: [transferLog({ value: AMOUNT + 1n }), paidLog()] }), 'NO_MATCHING_TRANSFER'],
    ['a transfer of another token that looks like USDC', rawReceipt({ logs: [transferLog({ address: other }), paidLog()] }), 'NO_MATCHING_TRANSFER'],
    ['a payment in the block the verdict came back in', rawReceipt({ block: 100 }), 'TX_BEFORE_CHECK'],
    ['a payment mined while the check was still running', rawReceipt({ block: 95 }), 'TX_BEFORE_CHECK'],
    ['a payment from before the check', rawReceipt({ block: 42 }), 'TX_BEFORE_CHECK'],
  ]
  for (const [what, receipt, code] of cases) {
    const seed = flow()
    const { store } = await storeWith([seed])
    const out = await recordVtpReceipt(FLOW, HASH, deps(store, rpc({ [URLS[0]]: receipt }).call))
    assert.equal(out.httpStatus, 422, what)
    assert.equal(out.body.code, code, what)
    assert.equal(out.body.verified, false, what)
    const row = (await store.load(FLOW)) as { ok: true; row: VtpFlowRecord }
    assert.deepEqual(row.row, seed, `${what}: the row moved`)
  }
})

test('a payment mined between the preflight and the verdict is not the result of the check; the first block after the verdict is', async () => {
  // The preflight read block 90 and the verdict came back in block 100. A pay() sent while
  // the check was running lands after 90, and that is exactly what must not count.
  for (const block of [91, 99, 100]) {
    const seed = flow()
    const { store } = await storeWith([seed])
    const out = await recordVtpReceipt(FLOW, HASH, deps(store, rpc({ [URLS[0]]: rawReceipt({ block }) }).call))
    assert.deepEqual([out.httpStatus, out.body.code], [422, 'TX_BEFORE_CHECK'], `block ${block}`)
    assert.match(out.body.reason ?? '', /not after block 100, the latest block when the check's verdict came back/)
    assert.deepEqual(((await store.load(FLOW)) as { ok: true; row: VtpFlowRecord }).row, seed)
  }
  const { store } = await storeWith([flow()])
  const first = await recordVtpReceipt(FLOW, HASH, deps(store, rpc({ [URLS[0]]: rawReceipt({ block: 101 }) }).call))
  assert.deepEqual([first.httpStatus, first.body.outcome], [200, 'executed'])

  // A row that never got a verdict block takes no receipt at all.
  const unpinned = await storeWith([flow({ check: { ...flow().check, verdictBlock: null } })])
  const none = await recordVtpReceipt(FLOW, HASH, deps(unpinned.store, rpc({ [URLS[0]]: rawReceipt({ block: 5000 }) }).call))
  assert.deepEqual([none.httpStatus, none.body.code], [422, 'VERDICT_BLOCK_UNKNOWN'])
})

test("a payment whose block no host returns with the receipt's block hash is a retry, and the row stays as it was", async () => {
  const seed = flow()
  const lagging = await storeWith([seed])
  const a = await recordVtpReceipt(FLOW, HASH, deps(lagging.store, rpc({ [URLS[0]]: rawReceipt() }, {}, {}).call))
  assert.deepEqual([a.httpStatus, a.body.code, a.body.retry], [503, 'BLOCK_UNREADABLE', true])

  // Every host holding another block at that height is no answer either.
  const forked = await storeWith([seed])
  const other = Object.fromEntries(URLS.map((u) => [u, rawBlock(101n, '0x' + 'cc'.repeat(32))]))
  const b = await recordVtpReceipt(FLOW, HASH, deps(forked.store, rpc({ [URLS[0]]: rawReceipt() }, {}, other).call))
  assert.deepEqual([b.httpStatus, b.body.code], [503, 'BLOCK_UNREADABLE'])

  // A timestamp that is no time at all is no answer, and never a crash.
  const garbled = await storeWith([seed])
  const far = Object.fromEntries(URLS.map((u) => [u, rawBlock(101n, BLOCK_HASH, 2n ** 60n)]))
  const c = await recordVtpReceipt(FLOW, HASH, deps(garbled.store, rpc({ [URLS[0]]: rawReceipt() }, {}, far).call))
  assert.deepEqual([c.httpStatus, c.body.code], [503, 'BLOCK_UNREADABLE'])

  for (const s of [lagging, forked, garbled]) assert.deepEqual(((await s.store.load(FLOW)) as { ok: true; row: VtpFlowRecord }).row, seed)
})

test('a reverted receipt of the prepared call is recorded as reverted on chain, from the one host that returns the transaction', async () => {
  const { store } = await storeWith([flow()])
  const reverted = rawReceipt({ status: '0x0', logs: [] })
  const r = rpc({ [URLS[0]]: reverted }, { [URLS[2]]: rawTx() })
  const out = await recordVtpReceipt(FLOW, HASH, deps(store, r.call))
  assert.equal(out.httpStatus, 200, JSON.stringify(out.body))
  assert.deepEqual([out.body.verified, out.body.outcome, out.body.detail], [true, 'blocked', 'reverted_onchain'])
  assert.deepEqual([out.body.payment?.status, out.body.payment?.byOwner], ['reverted', false])

  // Not the call this flow prepared, or not from its key: nothing is recorded.
  for (const [what, tx] of [
    ['another amount', rawTx({ input: payCalldata(PAYEE, 1n) })],
    ['another sender', rawTx({ from: OWNER })],
    ['another target', rawTx({ to: '0x' + '99'.repeat(20) })],
  ] as const) {
    const s = await storeWith([flow()])
    const o = await recordVtpReceipt(FLOW, HASH, deps(s.store, rpc({ [URLS[0]]: reverted }, { [URLS[1]]: tx }).call))
    assert.equal(o.httpStatus, 422, what)
    assert.equal(o.body.code, 'NOT_THIS_FLOWS_CALL', what)
  }
  // A reverted receipt with no host returning the transaction proves nothing yet.
  const s = await storeWith([flow()])
  const o = await recordVtpReceipt(FLOW, HASH, deps(s.store, rpc({ [URLS[0]]: reverted }).call))
  assert.equal(o.httpStatus, 503)
  assert.equal(o.body.code, 'TX_UNREADABLE')
})

test('byOwner gives owner_paid, and a WARN hand-off is closed only by the owner', async () => {
  const pending = await storeWith([flow()])
  const byOwner = await recordVtpReceipt(FLOW, HASH, deps(pending.store, rpc({ [URLS[0]]: rawReceipt({ from: OWNER, logs: [transferLog(), paidLog({ byOwner: true })] }) }).call))
  assert.deepEqual([byOwner.httpStatus, byOwner.body.outcome, byOwner.body.detail, byOwner.body.payment?.byOwner], [200, 'executed', 'owner_paid', true])

  const warn = () => flow({ outcome: 'awaiting_human', detail: 'warn_handoff', prepared: { from: OWNER, to: VAULT, data: ownerPayCalldata(PAYEE, AMOUNT), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } })
  const agent = await storeWith([warn()])
  const refused = await recordVtpReceipt(FLOW, HASH, deps(agent.store, rpc({ [URLS[0]]: rawReceipt() }).call))
  assert.equal(refused.httpStatus, 422)
  assert.equal(refused.body.code, 'AGENT_PAID_ON_HANDOFF')
  assert.equal(((await agent.store.load(FLOW)) as { ok: true; row: VtpFlowRecord }).row.outcome, 'awaiting_human')

  const owner = await storeWith([warn()])
  const settled = await recordVtpReceipt(FLOW, HASH, deps(owner.store, rpc({ [URLS[0]]: rawReceipt({ from: OWNER, logs: [transferLog(), paidLog({ byOwner: true })] }) }).call))
  assert.deepEqual([settled.httpStatus, settled.body.outcome, settled.body.detail], [200, 'executed', 'owner_paid'])
  // And on a hand-off, a reverted ownerPay from the owner is the hand-off's own refusal.
  const ownerRevert = await storeWith([warn()])
  const rev = await recordVtpReceipt(
    FLOW,
    HASH,
    deps(ownerRevert.store, rpc({ [URLS[0]]: rawReceipt({ status: '0x0', logs: [] }) }, { [URLS[0]]: rawTx({ from: OWNER, input: ownerPayCalldata(PAYEE, AMOUNT) }) }).call),
  )
  assert.deepEqual([rev.body.outcome, rev.body.detail, rev.body.payment?.byOwner], ['blocked', 'reverted_onchain', true])
})

test('one transaction proves one flow, and a flow that ended takes no receipt', async () => {
  const OTHER_FLOW = '0x' + 'cd'.repeat(32)
  const done = flow({
    flowId: OTHER_FLOW,
    check: { ...flow().check, authNonce: OTHER_FLOW },
    outcome: 'executed',
    detail: 'agent_paid',
    payment: { txHash: HASH, blockNumber: '101', minedAt: 'x', status: 'success', byOwner: false, from: OPERATOR, to: VAULT, gasUsed: '1', effectiveGasPrice: '1', costUsdc: '0.000001', readBackAt: 'x', readBackFrom: 'x', explorerUrl: 'x' },
  })
  const { store } = await storeWith([done, flow()])
  const r = rpc({ [URLS[0]]: rawReceipt() })
  const out = await recordVtpReceipt(FLOW, HASH, deps(store, r.call))
  assert.equal(out.httpStatus, 409)
  assert.equal(out.body.code, 'TX_LINKED_ELSEWHERE')
  assert.deepEqual(r.asked, [], 'refused before any RPC was asked')

  const denied = await storeWith([flow({ outcome: 'blocked', detail: 'deny', prepared: null })])
  const late = await recordVtpReceipt(FLOW, HASH, deps(denied.store, rpc({ [URLS[0]]: rawReceipt() }).call))
  assert.equal(late.httpStatus, 409)
  assert.equal(late.body.code, 'FLOW_ENDED')
})

test('nothing found yet and no host answering are both retries, and neither changes the row', async () => {
  const seed = flow()
  const nowhere = await storeWith([seed])
  const a = await recordVtpReceipt(FLOW, HASH, deps(nowhere.store, rpc({}).call))
  assert.deepEqual([a.httpStatus, a.body.code, a.body.retry], [202, 'TX_NOT_FOUND', true])
  assert.match(a.body.next, /20 gwei/)

  const pending = await storeWith([seed])
  const b = await recordVtpReceipt(FLOW, HASH, deps(pending.store, rpc({}, { [URLS[3]]: rawTx() }).call))
  assert.deepEqual([b.httpStatus, b.body.code], [202, 'RECEIPT_PENDING'])

  const down = new Error('fetch failed')
  const dark = await storeWith([seed])
  const c = await recordVtpReceipt(FLOW, HASH, deps(dark.store, rpc(Object.fromEntries(URLS.map((u) => [u, down]))).call))
  assert.deepEqual([c.httpStatus, c.body.code, c.body.retry], [503, 'RPC_UNREACHABLE', true])

  for (const s of [nowhere, pending, dark]) {
    assert.deepEqual(((await s.store.load(FLOW)) as { ok: true; row: VtpFlowRecord }).row, seed)
  }
})

test('a malformed flow id or hash is a 400 and an unknown flow a 404, before any RPC is asked', async () => {
  const { store } = await storeWith([flow()])
  const r = rpc({ [URLS[0]]: rawReceipt() })
  assert.equal((await recordVtpReceipt('0x1234', HASH, deps(store, r.call))).httpStatus, 400)
  assert.equal((await recordVtpReceipt(FLOW, 'not-a-hash', deps(store, r.call))).httpStatus, 400)
  assert.equal((await recordVtpReceipt(FLOW, undefined, deps(store, r.call))).httpStatus, 400)
  const unknown = await recordVtpReceipt('0x' + 'ee'.repeat(32), HASH, deps(store, r.call))
  assert.equal(unknown.httpStatus, 404)
  assert.deepEqual(r.asked, [])
})

// ── which flow a payment answers ──────────────────────────────────────────────────

const HASH_B = '0x' + 'c2'.repeat(32)
const FLOW_B = '0x' + 'cd'.repeat(32)

/** Flow B: the same vault, payee and amount as flow A, checked later (verdict in block 200). */
function flowB(over: Partial<VtpFlowRecord> = {}): VtpFlowRecord {
  return flow({ flowId: FLOW_B, createdAt: '2026-11-01T10:10:00.000Z', updatedAt: '2026-11-01T10:10:00.000Z', check: { ...flow().check, authNonce: FLOW_B, checkedAtBlock: '190', verdictBlock: '200' }, ...over })
}

/** A chain that answers by transaction hash, and has every block asked for. */
function chainOf(receipts: Record<string, unknown>, txs: Record<string, unknown> = {}): RpcCall {
  return async (_url, method, params) => {
    const key = String(params[0]).toLowerCase()
    if (method === 'eth_getTransactionReceipt') return receipts[key] ?? null
    if (method === 'eth_getTransactionByHash') return txs[key] ?? null
    if (method === 'eth_getBlockByNumber') return rawBlock(BigInt(params[0] as string))
    return null
  }
}

const rowOf = async (store: VtpStore, id: string) => ((await store.load(id)) as { ok: true; row: VtpFlowRecord }).row

test("flow B's payment posted to flow A changes nothing: a payment answers the latest open check before it, and each flow still gets its own", async () => {
  // A's verdict came back in block 100 and A paid in block 150; B's verdict came back in block
  // 200 and B paid in block 205. Both flow ids are public, and the route takes no session.
  const a = flow()
  const b = flowB()
  const { store } = await storeWith([a, b])
  const call = chainOf({ [HASH]: rawReceipt({ block: 150 }), [HASH_B]: rawReceipt({ hash: HASH_B, block: 205 }) })

  const stolen = await recordVtpReceipt(FLOW, HASH_B, deps(store, call))
  assert.deepEqual([stolen.httpStatus, stolen.body.code, stolen.body.answersFlow, stolen.body.verified], [409, 'TX_ANSWERS_LATER_CHECK', FLOW_B, false])
  assert.match(stolen.body.reason ?? '', /block 200, after this flow's \(block 100\) and before the payment \(block 205\)/)
  assert.ok(stolen.body.next.includes(`/api/x402/gateway/flows/${FLOW_B}/receipt`))
  assert.deepEqual([await rowOf(store, FLOW), await rowOf(store, FLOW_B)], [a, b], 'neither row moved')

  // A's payment came before B's check, so it can never be B's.
  const early = await recordVtpReceipt(FLOW_B, HASH, deps(store, call))
  assert.deepEqual([early.httpStatus, early.body.code], [422, 'TX_BEFORE_CHECK'])

  // Each payment closes its own flow, in either order.
  const own = await recordVtpReceipt(FLOW, HASH, deps(store, call))
  assert.deepEqual([own.httpStatus, own.body.outcome, own.body.payment?.txHash], [200, 'executed', HASH])
  const bOwn = await recordVtpReceipt(FLOW_B, HASH_B, deps(store, call))
  assert.deepEqual([bOwn.httpStatus, bOwn.body.outcome, bOwn.body.payment?.txHash], [200, 'executed', HASH_B])

  // The same in the other order: B first, then A, and A's payment still finds A.
  const again = await storeWith([flow(), flowB()])
  assert.equal((await recordVtpReceipt(FLOW_B, HASH_B, deps(again.store, call))).httpStatus, 200)
  assert.equal((await recordVtpReceipt(FLOW, HASH, deps(again.store, call))).httpStatus, 200)
})

test('a revert answers the latest open check too, and an owner payment can answer a later hand-off where an operator payment cannot', async () => {
  // A reverted pay() from the operator, mined after both verdicts, is B's refusal, not A's.
  const reverts = await storeWith([flow(), flowB()])
  const revert = chainOf({ [HASH_B]: rawReceipt({ hash: HASH_B, block: 205, status: '0x0', logs: [] }) }, { [HASH_B]: rawTx({ hash: HASH_B }) })
  const toA = await recordVtpReceipt(FLOW, HASH_B, deps(reverts.store, revert))
  assert.deepEqual([toA.httpStatus, toA.body.code, toA.body.answersFlow], [409, 'TX_ANSWERS_LATER_CHECK', FLOW_B])
  const toB = await recordVtpReceipt(FLOW_B, HASH_B, deps(reverts.store, revert))
  assert.deepEqual([toB.httpStatus, toB.body.outcome, toB.body.detail], [200, 'blocked', 'reverted_onchain'])

  // B waits for its owner. An operator payment cannot close a hand-off, so it is A's.
  const handoff = () => flowB({ outcome: 'awaiting_human', detail: 'warn_handoff', prepared: { from: OWNER, to: VAULT, data: ownerPayCalldata(PAYEE, AMOUNT), function: 'ownerPay(address,uint256)', args: [PAYEE, AMOUNT.toString()] } })
  const operator = await storeWith([flow(), handoff()])
  const byOperator = chainOf({ [HASH_B]: rawReceipt({ hash: HASH_B, block: 205 }) })
  assert.deepEqual((await recordVtpReceipt(FLOW, HASH_B, deps(operator.store, byOperator))).body.outcome, 'executed')

  // The owner's payment can close either, and B's check is the later one.
  const owner = await storeWith([flow(), handoff()])
  const byOwner = chainOf({ [HASH_B]: rawReceipt({ hash: HASH_B, block: 205, from: OWNER, logs: [transferLog(), paidLog({ byOwner: true })] }) })
  const ownerToA = await recordVtpReceipt(FLOW, HASH_B, deps(owner.store, byOwner))
  assert.deepEqual([ownerToA.httpStatus, ownerToA.body.answersFlow], [409, FLOW_B])
  assert.deepEqual((await recordVtpReceipt(FLOW_B, HASH_B, deps(owner.store, byOwner))).body.detail, 'owner_paid')
})

test('a tie on the verdict block goes to the later check, whoever asks first, and another amount never competes', async () => {
  const tied = flowB({ check: { ...flowB().check, checkedAtBlock: '90', verdictBlock: '100' } })
  const { store } = await storeWith([flow(), tied])
  const call = chainOf({ [HASH]: rawReceipt({ block: 101 }) })
  const first = await recordVtpReceipt(FLOW, HASH, deps(store, call))
  assert.deepEqual([first.httpStatus, first.body.answersFlow], [409, FLOW_B])
  assert.equal((await recordVtpReceipt(FLOW_B, HASH, deps(store, call))).httpStatus, 200)

  // One base unit apart is another flow entirely: B's later check does not take A's payment.
  const apart = await storeWith([flow(), flowB({ amount: (AMOUNT + 1n).toString() })])
  const paid = await recordVtpReceipt(FLOW, HASH, deps(apart.store, chainOf({ [HASH]: rawReceipt({ block: 205 }) })))
  assert.deepEqual([paid.httpStatus, paid.body.outcome], [200, 'executed'])

  // The rule itself, pure: nothing that could take the payment, no answer.
  assert.equal(answeredFlow([flowB()], 150n, { byOwner: false, from: null }), null)
  assert.equal(answeredFlow([flow(), flowB()], 205n, { byOwner: false, from: null })?.flowId, FLOW_B)
  assert.equal(answeredFlow([flow(), flowB({ outcome: 'executed', detail: 'agent_paid' })], 205n, { byOwner: false, from: null })?.flowId, FLOW)
  assert.equal(answeredFlow([flow(), flowB()], 205n, { byOwner: false, from: OWNER }), null, 'a revert from a key neither flow prepared for answers nothing')
})

test('the flow log not answering while the payment is matched is a retry, and nothing changes', async () => {
  const seed = flow()
  const { store } = await storeWith([seed])
  const dark: VtpStore = { ...store, openFlows: async () => ({ ok: false, reason: 'postgres unreachable' }) }
  const out = await recordVtpReceipt(FLOW, HASH, deps(dark, rpc({ [URLS[0]]: rawReceipt() }).call))
  assert.deepEqual([out.httpStatus, out.body.code, out.body.retry], [503, 'FLOW_STORE_UNREADABLE', true])
  assert.deepEqual(await rowOf(store, FLOW), seed)
})

test('one receipt post ends inside its hard deadline however many hosts stall, whichever read they stall in', async () => {
  const stall: RpcCall = () => new Promise(() => {})
  const dark = await storeWith([flow()])
  const t0 = Date.now()
  const out = await recordVtpReceipt(FLOW, HASH, { store: dark.store, now: () => NOW, receipts: { urls: URLS, call: stall }, receiptTotalMs: 60 })
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms against a 60 ms deadline`)
  assert.deepEqual([out.httpStatus, out.body.code, out.body.retry], [503, 'RPC_UNREACHABLE', true])

  // The receipt answers at once and every block read stalls: what is left of the deadline is
  // all the block read gets, and the post still ends with a retry, not a hang.
  const quick: RpcCall = async (_url, method) => (method === 'eth_getTransactionReceipt' ? rawReceipt() : new Promise(() => {}))
  const late = await storeWith([flow()])
  const t1 = Date.now()
  const out2 = await recordVtpReceipt(FLOW, HASH, { store: late.store, now: () => NOW, receipts: { urls: URLS, call: quick }, receiptTotalMs: 80 })
  assert.ok(Date.now() - t1 < 2000, `took ${Date.now() - t1} ms against an 80 ms deadline`)
  assert.deepEqual([out2.httpStatus, out2.body.code], [503, 'BLOCK_UNREADABLE'])
  assert.equal((await rowOf(late.store, FLOW)).outcome, 'pending')
})

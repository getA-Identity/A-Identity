import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findVtpFlowByTx, loadOpenVtpFlows, loadVtpFlow, loadVtpFlowsResult, persistVtpFlow, updateVtpFlow, type VtpFlowRecord, type VtpStoreIo } from '../storage.js'
import { fakeVtpPool } from './fake-pg.js'

/**
 * The vtp_flows log, against its two backends: the file fallback for real, and Postgres
 * through fake-pg.ts, which applies each statement's WHERE, the primary key and the unique
 * payment index the way the database does. No real Postgres runs here, so what these prove is
 * what storage.ts does with the statements' answers, on those semantics.
 *
 * Three properties, because each one is what the season report and the receipt route lean
 * on: an unreadable log never reads as an empty one; a flow is written once and never
 * overwritten; and a flow moves on only from pending or awaiting_human, with one payment
 * transaction linked to one flow at most.
 */
const FLOW = '0x' + 'ab'.repeat(32)
const TX = '0x' + 'c1'.repeat(32)

function flow(over: Partial<VtpFlowRecord> = {}): VtpFlowRecord {
  return {
    v: 1,
    flowId: FLOW,
    network: 'eip155:test',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    vault: '0x' + 'a1'.repeat(20),
    owner: '0x' + 'b2'.repeat(20),
    operator: '0x' + 'c3'.repeat(20),
    payee: '0x' + 'd4'.repeat(20),
    payeeAgentId: null,
    asset: '0x' + 'e5'.repeat(20),
    amount: '250000',
    amountUsd: 0.25,
    check: { authNonce: FLOW, transferId: null, gatewayOutcome: 'credited', payer: '0x' + 'c3'.repeat(20), value: '5000', tool: 'risk_check', checkedAt: '2026-11-01T10:00:00.000Z', checkedAtBlock: '90', verdictBlock: '100' },
    verdict: null,
    payOnWarn: false,
    prepared: null,
    outcome: 'pending',
    detail: 'agent_will_pay',
    ...over,
  }
}

const payment = (txHash = TX): NonNullable<VtpFlowRecord['payment']> => ({
  txHash,
  blockNumber: '101',
  minedAt: '2026-11-01T10:04:58.000Z',
  status: 'success',
  byOwner: false,
  from: '0x' + 'c3'.repeat(20),
  to: '0x' + 'a1'.repeat(20),
  gasUsed: '90341',
  effectiveGasPrice: '20100000000',
  costUsdc: '0.001816',
  readBackAt: '2026-11-01T10:05:00.000Z',
  readBackFrom: 'rpc.example',
  explorerUrl: 'https://explorer.example/tx/' + txHash,
})

function fileIo(): VtpStoreIo {
  return { file: join(mkdtempSync(join(tmpdir(), 'vtp-store-')), 'vtp-flows.json'), getPool: async () => null }
}

test('the flow log tells no flows apart from a log it cannot read', async () => {
  const io = fileIo()
  assert.deepEqual(await loadVtpFlowsResult(io), { ok: true, rows: [] }, 'no file yet is a first run, not a failure')

  writeFileSync(io.file!, '{ not json')
  const corrupt = await loadVtpFlowsResult(io)
  assert.equal(corrupt.ok, false)
  writeFileSync(io.file!, JSON.stringify({ rows: [] }))
  const wrongShape = await loadVtpFlowsResult(io)
  assert.equal(wrongShape.ok, false)
  // The single-row read and the transaction lookup fail the same way rather than reading as "none".
  assert.equal((await loadVtpFlow(FLOW, io)).ok, false)
  assert.equal((await findVtpFlowByTx(TX, io)).ok, false)

  const down: VtpStoreIo = {
    getPool: async () => ({
      query: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    }),
  }
  assert.deepEqual(await loadVtpFlowsResult(down), { ok: false, reason: 'connect ECONNREFUSED' })
  assert.deepEqual(await loadVtpFlow(FLOW, down), { ok: false, reason: 'connect ECONNREFUSED' })
  assert.deepEqual(await persistVtpFlow(flow(), down), { ok: false, reason: 'connect ECONNREFUSED' })
})

test('Postgres gets the vtp_flows table once, the unique payment index, and an insert that never overwrites', async () => {
  const pool = fakeVtpPool()
  const io: VtpStoreIo = { getPool: async () => pool }
  const first = flow({ flowId: FLOW.toUpperCase().replace('0X', '0x') })
  assert.deepEqual(await persistVtpFlow(first, io), { ok: true, inserted: true })
  assert.deepEqual(await persistVtpFlow(flow({ outcome: 'executed', detail: 'agent_paid' }), io), { ok: true, inserted: false })

  const ddl = pool.sql.filter((q) => q.text.startsWith('CREATE')).map((q) => q.text)
  assert.deepEqual(ddl, [
    'CREATE TABLE IF NOT EXISTS vtp_flows (flow_id text PRIMARY KEY, data jsonb NOT NULL)',
    "CREATE UNIQUE INDEX IF NOT EXISTS vtp_flows_payment_tx ON vtp_flows ((data->'payment'->>'txHash'))",
  ], 'the schema is created once per pool')
  assert.equal(pool.sql.find((q) => q.text.startsWith('INSERT'))?.params[0], FLOW, 'keyed by the nonce, lowercase')
  const held = await loadVtpFlow(FLOW, io)
  assert.equal(held.ok && held.row?.outcome, 'pending', 'the second insert changed nothing')
})

test('Postgres compare-and-set: an UPDATE that matches moves the row, one that matches nothing changes nothing', async () => {
  const pool = fakeVtpPool()
  const io: VtpStoreIo = { getPool: async () => pool }
  await persistVtpFlow(flow({ outcome: 'opening', detail: 'opening', verdict: null }), io)

  // The row is opening, so a patch that may only move a pending row is a 0-row UPDATE, and the
  // store answers with the row as it stands rather than a write that did not happen.
  const noMatch = await updateVtpFlow(FLOW, { outcome: 'executed', detail: 'agent_paid' }, ['pending', 'awaiting_human'], io)
  assert.deepEqual(noMatch.ok && !noMatch.updated && noMatch.row?.outcome, 'opening')

  // From opening it moves, and a patch can carry the whole record the verdict decided.
  const closed = await updateVtpFlow(FLOW, flow({ outcome: 'pending', detail: 'agent_will_pay', updatedAt: '2026-11-01T10:00:05.000Z' }), ['opening'], io)
  assert.equal(closed.ok && closed.updated, true)
  if (closed.ok && closed.updated) assert.deepEqual([closed.row.outcome, closed.row.detail, closed.row.updatedAt], ['pending', 'agent_will_pay', '2026-11-01T10:00:05.000Z'])

  // A second close from opening finds nothing to move: a reservation closes once.
  const twice = await updateVtpFlow(FLOW, { outcome: 'blocked', detail: 'deny' }, ['opening'], io)
  assert.deepEqual(twice.ok && !twice.updated && twice.row?.outcome, 'pending')

  // And the payment lands from an open outcome, merged into the row, hash lowercase.
  const paid = await updateVtpFlow(FLOW, { outcome: 'executed', detail: 'agent_paid', payment: payment(TX.toUpperCase().replace('0X', '0x')) }, ['pending', 'awaiting_human'], io)
  assert.equal(paid.ok && paid.updated, true)
  if (paid.ok && paid.updated) assert.deepEqual([paid.row.outcome, paid.row.payment?.txHash, paid.row.vault], ['executed', TX, flow().vault])

  // An ended flow stays ended, and a row that is not there answers null.
  const ended = await updateVtpFlow(FLOW, { outcome: 'blocked', detail: 'reverted_onchain' }, ['pending', 'awaiting_human'], io)
  assert.deepEqual(ended.ok && !ended.updated && ended.row?.outcome, 'executed')
  assert.deepEqual(await updateVtpFlow('0x' + 'ee'.repeat(32), { outcome: 'executed' }, ['pending'], io), { ok: true, updated: false, row: null })
})

test('Postgres: the unique index refuses a transaction already linked to another flow, and neither row moves', async () => {
  const pool = fakeVtpPool()
  const io: VtpStoreIo = { getPool: async () => pool }
  const OTHER = '0x' + 'cd'.repeat(32)
  await persistVtpFlow(flow(), io)
  await persistVtpFlow(flow({ flowId: OTHER, outcome: 'awaiting_human', detail: 'warn_handoff' }), io)
  const won = await updateVtpFlow(FLOW, { outcome: 'executed', detail: 'agent_paid', payment: payment() }, ['pending'], io)
  assert.equal(won.ok && won.updated, true)
  const stolen = await updateVtpFlow(OTHER, { outcome: 'executed', detail: 'owner_paid', payment: payment(TX.toUpperCase().replace('0X', '0x')) }, ['awaiting_human'], io)
  assert.deepEqual(stolen, { ok: false, reason: 'that transaction is already linked to another flow', conflict: 'tx_linked' })
  const other = await loadVtpFlow(OTHER, io)
  assert.deepEqual(other.ok && [other.row?.outcome, other.row?.payment], ['awaiting_human', undefined])
  assert.deepEqual(await findVtpFlowByTx(TX, io), { ok: true, flowId: FLOW })
  // Rows without a payment have a NULL key, and NULLs never collide.
  const THIRD = '0x' + 'ef'.repeat(32)
  await persistVtpFlow(flow({ flowId: THIRD }), io)
  const moved = await updateVtpFlow(THIRD, { outcome: 'blocked', detail: 'deny' }, ['pending'], io)
  assert.equal(moved.ok && moved.updated, true)
})

test('Postgres: any other failure of an UPDATE is reported as a failure, not as a linked transaction', async () => {
  const pool = fakeVtpPool()
  let down = false
  const io: VtpStoreIo = {
    getPool: async () => ({
      query: async (text: string, params?: unknown[]) => {
        if (down && text.startsWith('UPDATE')) throw new Error('connection reset')
        return pool.query(text, params)
      },
    }),
  }
  await persistVtpFlow(flow(), io)
  down = true
  assert.deepEqual(await updateVtpFlow(FLOW, { outcome: 'executed' }, ['pending'], io), { ok: false, reason: 'connection reset' })
})

test('a flow is written once and never overwritten', async () => {
  const io = fileIo()
  const first = flow()
  assert.deepEqual(await persistVtpFlow(first, io), { ok: true, inserted: true })
  assert.deepEqual(await persistVtpFlow(flow({ outcome: 'executed', detail: 'agent_paid' }), io), { ok: true, inserted: false })
  const read = await loadVtpFlow(FLOW.toUpperCase().replace('0X', '0x'), io)
  assert.deepEqual(read, { ok: true, row: first })
  assert.deepEqual(await loadVtpFlowsResult(io), { ok: true, rows: [first] })
})

test('only a pending or awaiting_human flow moves, and one payment transaction links one flow', async () => {
  const io = fileIo()
  const OTHER = '0x' + 'cd'.repeat(32)
  await persistVtpFlow(flow(), io)
  await persistVtpFlow(flow({ flowId: OTHER, outcome: 'awaiting_human', detail: 'warn_handoff' }), io)

  const moved = await updateVtpFlow(FLOW, { outcome: 'executed', detail: 'agent_paid', payment: payment(), updatedAt: '2026-11-01T10:05:00.000Z' }, ['pending', 'awaiting_human'], io)
  assert.equal(moved.ok && moved.updated, true)
  if (moved.ok && moved.updated) assert.deepEqual([moved.row.outcome, moved.row.payment?.txHash], ['executed', TX])

  // Ended flows stay ended.
  const again = await updateVtpFlow(FLOW, { outcome: 'blocked', detail: 'reverted_onchain' }, ['pending', 'awaiting_human'], io)
  assert.deepEqual(again.ok && !again.updated && again.row?.outcome, 'executed')

  // The same transaction cannot prove a second flow.
  const stolen = await updateVtpFlow(OTHER, { outcome: 'executed', detail: 'owner_paid', payment: payment() }, ['pending', 'awaiting_human'], io)
  assert.deepEqual(stolen, { ok: false, reason: 'that transaction is already linked to another flow', conflict: 'tx_linked' })
  assert.deepEqual(await findVtpFlowByTx(TX.toUpperCase().replace('0X', '0x'), io), { ok: true, flowId: FLOW })
  assert.deepEqual(await findVtpFlowByTx('0x' + '77'.repeat(32), io), { ok: true, flowId: null })

  const missing = await updateVtpFlow('0x' + 'ee'.repeat(32), { outcome: 'executed' }, ['pending'], io)
  assert.deepEqual(missing, { ok: true, updated: false, row: null })
  const other = await loadVtpFlow(OTHER, io)
  assert.equal(other.ok && other.row?.outcome, 'awaiting_human')
})

test('the open flows on one vault, payee and amount are found, and nothing else; an unreadable log is an error', async () => {
  const io = fileIo()
  const VAULT = '0x' + 'a1'.repeat(20)
  const PAYEE = '0x' + 'd4'.repeat(20)
  const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')
  for (const r of [
    flow({ flowId: id(1) }),
    flow({ flowId: id(2), outcome: 'awaiting_human', detail: 'warn_handoff' }),
    flow({ flowId: id(3), outcome: 'executed', detail: 'agent_paid', payment: payment() }),
    flow({ flowId: id(4), outcome: 'blocked', detail: 'deny' }),
    flow({ flowId: id(5), amount: '250001' }),
    flow({ flowId: id(6), payee: '0x' + 'd5'.repeat(20) }),
    flow({ flowId: id(7), vault: '0x' + 'a2'.repeat(20) }),
  ]) {
    await persistVtpFlow(r, io)
  }
  const got = await loadOpenVtpFlows({ vault: '0x' + 'A1'.repeat(20), payee: PAYEE, amount: '250000' }, io)
  assert.deepEqual(got.ok && got.rows.map((r) => r.flowId), [id(1), id(2)])

  // Postgres filters in the database, on the open outcomes only: a reservation is not open.
  const pool = fakeVtpPool()
  const pg: VtpStoreIo = { getPool: async () => pool }
  await persistVtpFlow(flow({ flowId: id(8), outcome: 'opening', detail: 'opening' }), pg)
  await persistVtpFlow(flow({ flowId: id(9) }), pg)
  await persistVtpFlow(flow({ flowId: id(10), outcome: 'failed', detail: 'reverted_not_policy' }), pg)
  const open = await loadOpenVtpFlows({ vault: VAULT, payee: PAYEE, amount: '250000' }, pg)
  assert.deepEqual(open.ok && open.rows.map((r) => r.flowId), [id(9)])
  const q = pool.sql.find((x) => x.text.startsWith('SELECT'))!
  assert.deepEqual(q.params, [VAULT, PAYEE, '250000', ['pending', 'awaiting_human']])

  writeFileSync(io.file!, '{ not json')
  assert.equal((await loadOpenVtpFlows({ vault: VAULT, payee: PAYEE, amount: '250000' }, io)).ok, false)
})

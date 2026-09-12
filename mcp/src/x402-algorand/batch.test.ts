import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAgentIds, runBatchAudit, BATCH_MAX_AGENTS, type BatchCheck } from './batch.js'

const verdict = (decision: string, score = 500) => ({
  decision,
  risk: decision === 'ALLOW' ? 'low' : decision === 'WARN' ? 'medium' : 'high',
  reasons: decision === 'ALLOW' ? [] : [`${decision.toLowerCase()} reason`],
  signals: { reputationScore: score, onchainVerified: decision !== 'DENY', kyaVerified: decision === 'ALLOW', revoked: false },
})

test('agent ids are trimmed, de-duplicated in order, and accepted as a comma-separated string', () => {
  assert.deepEqual(normalizeAgentIds([' #1 ', '#2', '#1', '', '#3']), { ok: true, ids: ['#1', '#2', '#3'] })
  assert.deepEqual(normalizeAgentIds('#1, #2,,#2'), { ok: true, ids: ['#1', '#2'] })
})

test('a list that decides the price is refused whole when any part of it is wrong', () => {
  assert.equal(normalizeAgentIds(undefined).ok, false)
  assert.equal(normalizeAgentIds([]).ok, false)
  assert.equal(normalizeAgentIds(['#1', 7]).ok, false)
  assert.equal(normalizeAgentIds(['x'.repeat(201)]).ok, false)
  const tooMany = Array.from({ length: BATCH_MAX_AGENTS + 1 }, (_, i) => `#${i}`)
  const r = normalizeAgentIds(tooMany)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /at most 50/)
})

test('an audit returns every verdict in input order with a decision summary', async () => {
  const decisions: Record<string, string> = { a: 'ALLOW', b: 'DENY', c: 'WARN', d: 'ALLOW' }
  const check: BatchCheck = async (id) => verdict(decisions[id], id === 'b' ? 0 : 600)
  const r = await runBatchAudit(['a', 'b', 'c', 'd'], { amountUsd: 25 } as never, { check, concurrency: 3 })
  assert.ok(r.ok)
  if (r.ok) {
    assert.deepEqual(r.result.results.map((e) => e.agentId), ['a', 'b', 'c', 'd'])
    assert.deepEqual(r.result.summary, { ALLOW: 2, WARN: 1, DENY: 1 })
    assert.equal(r.result.count, 4)
    assert.equal(r.result.results[1].reputationScore, 0)
    assert.equal(r.result.results[1].onchainVerified, false)
  }
})

test('the worker pool never runs more checks at once than its concurrency', async () => {
  let inFlight = 0
  let peak = 0
  const check: BatchCheck = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight -= 1
    return verdict('ALLOW')
  }
  const ids = Array.from({ length: 12 }, (_, i) => `#${i}`)
  const r = await runBatchAudit(ids, null, { check, concurrency: 3 })
  assert.ok(r.ok)
  assert.ok(peak <= 3, `peak concurrency was ${peak}`)
})

test('an audit that misses its deadline or loses a check is incomplete, never trimmed', async () => {
  const slow: BatchCheck = async () => {
    await new Promise((r) => setTimeout(r, 60))
    return verdict('ALLOW')
  }
  const late = await runBatchAudit(['a', 'b', 'c', 'd'], null, { check: slow, concurrency: 2, deadlineMs: 20 })
  assert.equal(late.ok, false)
  if (!late.ok) assert.match(late.reason, /did not finish inside 20 ms/)

  const flaky: BatchCheck = async (id) => {
    if (id === 'b') throw new Error('rpc down')
    return verdict('ALLOW')
  }
  const broken = await runBatchAudit(['a', 'b', 'c'], null, { check: flaky, concurrency: 1 })
  assert.equal(broken.ok, false)
  if (!broken.ok) assert.match(broken.reason, /the check for b failed: rpc down/)
})

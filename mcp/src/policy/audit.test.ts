import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_AUDITS_PER_AGENT,
  buildAuditEntry,
  capAudits,
  filterAudits,
  hashSnapshot,
  initialOutcome,
  summarizeAudits,
  type AuditEntry,
} from './audit.js'
import { evaluateAction } from './engine.js'
import { defaultActionPolicy } from './policy.js'
import type { AccountSnapshot, NormalizedIntent } from './types.js'

const NOW = '2026-07-29T12:00:00Z'
const POLICY = defaultActionPolicy('pol_audit', NOW)

const snap = (over: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  todayNotionalUsd: 0,
  positions: [{ symbol: 'AAPL', shares: 3, valueUsd: 500 }],
  portfolioValueUsd: 10_000,
  buyingPowerUsd: 5_000,
  cashAvailableUsd: 5_000,
  marginUsedUsd: 0,
  accountType: 'cash',
  ...over,
})

const intent = (over: Partial<NormalizedIntent> = {}): NormalizedIntent => ({
  kind: 'order',
  side: 'buy',
  symbol: 'AAPL',
  assetClass: 'equity',
  notionalUsd: 50,
  ...over,
})

function entryFor(i: NormalizedIntent, s?: AccountSnapshot, id = 'aud_1'): AuditEntry {
  const decision = evaluateAction({ surface: 'trade', policy: POLICY, intent: i, snapshot: s, now: new Date(NOW) })
  return buildAuditEntry({ id, ts: NOW, agentId: 'agent_1', intent: i, snapshot: s, decision })
}

// ── the snapshot is hashed, never stored ─────────────────────────────────────────

test('an entry carries a snapshot hash and no snapshot', () => {
  const e = entryFor(intent(), snap())
  assert.match(e.snapshotHash as string, /^sha256:[0-9a-f]{64}$/)
  const serialized = JSON.stringify(e)
  // The numbers that would constitute a financial dossier must not appear anywhere.
  assert.equal(serialized.includes('buyingPower'), false)
  assert.equal(serialized.includes('5000'), false)
  assert.equal(serialized.includes('positions'), false)
})

test('the hash is stable across key order and position order', () => {
  const a = hashSnapshot(snap({ positions: [{ symbol: 'AAPL', valueUsd: 1 }, { symbol: 'MSFT', valueUsd: 2 }] }))
  const b = hashSnapshot(snap({ positions: [{ symbol: 'MSFT', valueUsd: 2 }, { symbol: 'AAPL', valueUsd: 1 }] }))
  assert.equal(a, b, 'an equivalent portfolio in a different order must hash the same')
})

test('the hash changes when the state a verdict depended on changes', () => {
  assert.notEqual(hashSnapshot(snap()), hashSnapshot(snap({ cashAvailableUsd: 4_999 })))
  assert.notEqual(hashSnapshot(snap()), hashSnapshot(snap({ todayNotionalUsd: 1 })))
})

test('no snapshot hashes to null rather than to a hash of nothing', () => {
  assert.equal(hashSnapshot(undefined), null)
  assert.equal(entryFor(intent(), undefined).snapshotHash, null)
})

// ── what an entry records ────────────────────────────────────────────────────────

test('an ALLOW is recorded with no reasons and an executed outcome', () => {
  const e = entryFor(intent(), snap())
  assert.equal(e.verdict, 'ALLOW')
  assert.deepEqual(e.reasons, [])
  assert.equal(e.outcome, 'executed')
  assert.equal(e.policyId, 'pol_audit')
  assert.equal(e.policyVersion, 1)
  assert.equal(e.unverifiable, false)
})

test('a DENY records every reason and code and is blocked', () => {
  const e = entryFor(intent({ notionalUsd: 5_000 }), snap())
  assert.equal(e.verdict, 'DENY')
  assert.equal(e.outcome, 'blocked')
  assert.ok(e.codes.includes('PER_ACTION_CAP'))
  assert.equal(e.reasons.length, e.codes.length)
})

test('a WARN waits on a human', () => {
  const e = entryFor(intent({ kind: 'transfer', notionalUsd: 1 }), snap())
  assert.equal(e.verdict, 'WARN')
  assert.equal(e.outcome, 'awaiting_human')
})

test('outcome follows from the verdict', () => {
  assert.equal(initialOutcome('ALLOW'), 'executed')
  assert.equal(initialOutcome('WARN'), 'awaiting_human')
  assert.equal(initialOutcome('DENY'), 'blocked')
})

test('an unverifiable decision is flagged in the trail', () => {
  const s = snap()
  delete s.cashAvailableUsd
  const e = entryFor(intent(), s)
  assert.equal(e.unverifiable, true)
})

// ── bounded storage: a caller cannot grow an entry ───────────────────────────────

test('recorded strings are truncated and normalized', () => {
  const e = entryFor(intent({ symbol: 'x'.repeat(50), label: 'y'.repeat(500) }), snap())
  assert.equal(e.intent.symbol?.length, 12)
  assert.equal(e.intent.symbol, 'X'.repeat(12), 'symbols are upper-cased')
  assert.equal(e.intent.label?.length, 120)
})

test('a settings key is normalized to lowercase', () => {
  const e = entryFor({ kind: 'settings', notionalUsd: 0, settingKey: 'STOCK_LENDING', settingValue: true }, snap())
  assert.equal(e.intent.settingKey, 'stock_lending')
})

test('absent intent fields are omitted rather than stored as undefined', () => {
  const e = entryFor({ kind: 'document', notionalUsd: 0 }, snap())
  assert.equal('symbol' in e.intent, false)
  assert.equal('side' in e.intent, false)
})

test('the per-agent trail is capped, keeping the most recent', () => {
  const many: AuditEntry[] = Array.from({ length: MAX_AUDITS_PER_AGENT + 50 }, (_, i) => ({
    ...entryFor(intent(), snap(), `aud_${i}`),
  }))
  const capped = capAudits(many)
  assert.equal(capped.length, MAX_AUDITS_PER_AGENT)
  assert.equal(capped[capped.length - 1].id, `aud_${MAX_AUDITS_PER_AGENT + 49}`)
  assert.equal(capped[0].id, 'aud_50')
})

// ── querying ────────────────────────────────────────────────────────────────────

const trail = (): AuditEntry[] =>
  ['2026-07-01T00:00:00Z', '2026-07-15T00:00:00Z', '2026-07-29T00:00:00Z'].map((ts, i) => ({
    ...entryFor(intent(), snap(), `aud_${i}`),
    ts,
  }))

test('results come back newest first', () => {
  const { audits } = filterAudits(trail())
  assert.deepEqual(audits.map((a) => a.id), ['aud_2', 'aud_1', 'aud_0'])
})

test('since filters to entries at or after the instant', () => {
  const { audits, sinceApplied } = filterAudits(trail(), { since: '2026-07-15T00:00:00Z' })
  assert.equal(sinceApplied, true)
  assert.deepEqual(audits.map((a) => a.id), ['aud_2', 'aud_1'], 'inclusive of the boundary')
})

test('an unparseable since is ignored, not treated as "no activity"', () => {
  // Silently returning nothing would read as a clean history, which is the dangerous
  // failure mode for an audit view.
  const { audits, sinceApplied } = filterAudits(trail(), { since: 'last tuesday' })
  assert.equal(sinceApplied, false)
  assert.equal(audits.length, 3)
})

test('limit is bounded, and a nonsense limit falls back to the default', () => {
  assert.equal(filterAudits(trail(), { limit: 1 }).audits.length, 1)
  assert.equal(filterAudits(trail(), { limit: 1e9 }).audits.length, 3, 'clamped to 500, so all 3 come back')
  // 0, negative and NaN all mean "the caller did not really ask", so they must not
  // silently return almost nothing and make a busy history look empty.
  for (const bad of [0, -5, NaN, undefined]) {
    assert.equal(filterAudits(trail(), { limit: bad as number }).audits.length, 3, String(bad))
  }
})

test('filtering never mutates the stored array', () => {
  const t = trail()
  const before = t.map((e) => e.id)
  filterAudits(t)
  assert.deepEqual(t.map((e) => e.id), before)
})

// ── the summary is the honest traction metric ────────────────────────────────────

test('the summary counts verdicts and the USD the policy actually refused', () => {
  const entries = [
    entryFor(intent({ notionalUsd: 50 }), snap(), 'a'), // ALLOW
    entryFor(intent({ notionalUsd: 5_000 }), snap(), 'b'), // DENY, over cap
    entryFor(intent({ notionalUsd: 900 }), snap(), 'c'), // DENY, over cap
    entryFor(intent({ kind: 'transfer', notionalUsd: 10 }), snap(), 'd'), // WARN
  ]
  const s = summarizeAudits(entries)
  assert.equal(s.total, 4)
  assert.equal(s.allow, 1)
  assert.equal(s.warn, 1)
  assert.equal(s.deny, 2)
  assert.equal(s.blockedNotionalUsd, 5_900, 'blocked notional is the sum of DENYed action value')
})

test('an empty trail summarizes to zeroes, not to nothing', () => {
  assert.deepEqual(summarizeAudits([]), {
    total: 0,
    allow: 0,
    warn: 0,
    deny: 0,
    unverifiable: 0,
    blockedNotionalUsd: 0,
  })
})

// ── the spend counters a spend verdict is computed against ───────────────────────

test('the hash changes when the category counter a spend verdict depended on changes', () => {
  // `categoryOverLimit` decides on this number. If it did not reach the hash, a snapshot
  // claiming nothing was spent today and one claiming a fortune was would be
  // indistinguishable after the fact, which is exactly what the hash exists to prevent.
  const a = hashSnapshot(snap({ categorySpentTodayUsd: { dining: 0 } }))
  const b = hashSnapshot(snap({ categorySpentTodayUsd: { dining: 999_999 } }))
  assert.notEqual(a, b)
})

test('the hash changes when the per-card counter a spend verdict depended on changes', () => {
  const a = hashSnapshot(snap({ cardSpentTodayUsd: { card_1: 0 } }))
  const b = hashSnapshot(snap({ cardSpentTodayUsd: { card_1: 999_999 } }))
  assert.notEqual(a, b)
})

test('the spend counters hash the same whatever order their keys were inserted in', () => {
  const a = hashSnapshot(
    snap({ categorySpentTodayUsd: { dining: 10, travel: 20 }, cardSpentTodayUsd: { card_1: 5, card_2: 7 } }),
  )
  const b = hashSnapshot(
    snap({ categorySpentTodayUsd: { travel: 20, dining: 10 }, cardSpentTodayUsd: { card_2: 7, card_1: 5 } }),
  )
  assert.equal(a, b, 'the same counters in a different insertion order are the same state')
})

test('an absent counter does not hash like an empty one', () => {
  // Absent is what makes `categoryOverLimit` and `cardOverCap` fail closed, so it is a
  // different state from "supplied, and nothing spent yet" and must hash differently.
  assert.notEqual(hashSnapshot(snap()), hashSnapshot(snap({ categorySpentTodayUsd: {} })))
  assert.notEqual(hashSnapshot(snap()), hashSnapshot(snap({ cardSpentTodayUsd: {} })))
})

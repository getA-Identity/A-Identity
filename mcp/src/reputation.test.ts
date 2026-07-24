import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeAgentReputation } from './reputation.js'

// Tests the SAME function production uses (platform.ts repOf delegates to it).
const asOf = new Date('2026-07-10T00:00:00Z')

test('same input + asOf is deterministic', () => {
  const s = { settledCount: 20, rejected: 5, onchainRegistered: true, createdAt: '2026-01-01' }
  assert.deepEqual(computeAgentReputation(s, asOf), computeAgentReputation(s, asOf))
})

test('score is bounded 0..1000', () => {
  const r = computeAgentReputation(
    { settledCount: 100000, rejected: 0, onchainRegistered: true, createdAt: '2020-01-01' },
    asOf,
  )
  assert.ok(r.score >= 0 && r.score <= 1000, `score out of range: ${r.score}`)
})

test('more settled actions => higher settlement score', () => {
  const low = computeAgentReputation({ settledCount: 2, rejected: 0, onchainRegistered: false, createdAt: '2026-07-01' }, asOf)
  const high = computeAgentReputation({ settledCount: 40, rejected: 0, onchainRegistered: false, createdAt: '2026-07-01' }, asOf)
  assert.ok(high.breakdown.settlement > low.breakdown.settlement)
})

test('a verified on-chain identity adds a settlement credit', () => {
  const off = computeAgentReputation({ settledCount: 1, rejected: 0, onchainRegistered: false, createdAt: '2026-07-01' }, asOf)
  const on = computeAgentReputation({ settledCount: 1, rejected: 0, onchainRegistered: true, createdAt: '2026-07-01' }, asOf)
  assert.ok(on.breakdown.settlement > off.breakdown.settlement)
})

test('rejections lower the validation score', () => {
  const clean = computeAgentReputation({ settledCount: 10, rejected: 0, onchainRegistered: false, createdAt: '2026-07-01' }, asOf)
  const rejected = computeAgentReputation({ settledCount: 10, rejected: 10, onchainRegistered: false, createdAt: '2026-07-01' }, asOf)
  assert.ok(rejected.breakdown.validation < clean.breakdown.validation)
})

test('a brand-new agent with no activity and no on-chain id scores 0', () => {
  const r = computeAgentReputation({ settledCount: 0, rejected: 0, onchainRegistered: false, createdAt: '2026-07-10' }, asOf)
  assert.equal(r.score, 0)
})

test('settledUsd is carried through, settledOnchain mirrors the count', () => {
  const r = computeAgentReputation({ settledCount: 3, rejected: 0, onchainRegistered: true, createdAt: '2026-07-01', settledUsd: 12.5 }, asOf)
  assert.equal(r.settledOnchain, 3)
  assert.equal(r.settledUsd, 12.5)
})

test('an unparseable createdAt yields tenure 0 and a finite score (no NaN bypass)', () => {
  // A NaN score would slip past every downstream `score < threshold` risk comparison.
  const r = computeAgentReputation({ settledCount: 0, rejected: 0, onchainRegistered: true, createdAt: 'soon' }, asOf)
  assert.ok(Number.isFinite(r.score), `score must be finite, got ${r.score}`)
  assert.equal(r.breakdown.tenure, 0)
})

test('a future createdAt never produces negative tenure', () => {
  const r = computeAgentReputation({ settledCount: 1, rejected: 0, onchainRegistered: false, createdAt: '2999-01-01' }, asOf)
  assert.equal(r.breakdown.tenure, 0)
})

// ── behavioral band (B1): real marketplace job outcomes sharpen the score ──────────

test('an agent with no job history is scored exactly as before (behavior 0, backward compatible)', () => {
  const withoutFields = computeAgentReputation({ settledCount: 8, rejected: 2, onchainRegistered: true, createdAt: '2026-05-01' }, asOf)
  const withZeroHistory = computeAgentReputation({ settledCount: 8, rejected: 2, onchainRegistered: true, createdAt: '2026-05-01', completedTasks: 0, disputedTasks: 0, ratedCount: 0 }, asOf)
  assert.equal(withoutFields.breakdown.behavior, 0)
  assert.equal(withoutFields.score, withZeroHistory.score)
})

test('a high dispute rate lowers the score via a negative behavior band', () => {
  const clean = computeAgentReputation({ settledCount: 10, rejected: 0, onchainRegistered: true, createdAt: '2026-01-01', completedTasks: 5, disputedTasks: 0 }, asOf)
  const disputed = computeAgentReputation({ settledCount: 10, rejected: 0, onchainRegistered: true, createdAt: '2026-01-01', completedTasks: 1, disputedTasks: 4 }, asOf)
  assert.equal(clean.breakdown.behavior, 0)
  assert.ok(disputed.breakdown.behavior < 0, `expected a penalty, got ${disputed.breakdown.behavior}`)
  assert.ok(disputed.score < clean.score, `${disputed.score} !< ${clean.score}`)
})

test('strong client ratings (>=2 reviews) add a small behavior bonus', () => {
  const base = computeAgentReputation({ settledCount: 2, rejected: 0, onchainRegistered: false, createdAt: '2026-07-01', completedTasks: 3, disputedTasks: 0 }, asOf)
  const rated = computeAgentReputation({ settledCount: 2, rejected: 0, onchainRegistered: false, createdAt: '2026-07-01', completedTasks: 3, disputedTasks: 0, avgRating: 5, ratedCount: 4 }, asOf)
  assert.ok(rated.breakdown.behavior > base.breakdown.behavior)
  assert.ok(rated.score > base.score)
})

test('a single review does not move the behavior band (needs >=2)', () => {
  const one = computeAgentReputation({ settledCount: 5, rejected: 0, onchainRegistered: true, createdAt: '2026-06-01', completedTasks: 1, disputedTasks: 0, avgRating: 5, ratedCount: 1 }, asOf)
  assert.equal(one.breakdown.behavior, 0)
})

test('the behavior adjustment is bounded at the floor (-150) even at 100% disputes + 1-star', () => {
  const r = computeAgentReputation({ settledCount: 3, rejected: 0, onchainRegistered: true, createdAt: '2026-06-01', completedTasks: 0, disputedTasks: 50, avgRating: 1, ratedCount: 10 }, asOf)
  assert.ok(r.breakdown.behavior >= -150, `behavior ${r.breakdown.behavior} below floor`)
  assert.ok(r.score >= 0 && r.score <= 1000)
})

test('breakdown exposes a finite numeric behavior band', () => {
  const r = computeAgentReputation({ settledCount: 4, rejected: 0, onchainRegistered: true, createdAt: '2026-06-01', completedTasks: 2, disputedTasks: 2 }, asOf)
  assert.equal(typeof r.breakdown.behavior, 'number')
  assert.ok(Number.isFinite(r.breakdown.behavior))
})

// ── recency decay (B3): recent settlements outweigh ancient ones ───────────────────

test('no timestamps => every settlement weighs 1 (backward compatible)', () => {
  const plain = computeAgentReputation({ settledCount: 10, rejected: 0, onchainRegistered: false, createdAt: '2026-01-01' }, asOf)
  assert.equal(plain.settledEffective, 10)
})

test('fresh settlements weigh ~1 each', () => {
  const fresh = computeAgentReputation(
    { settledCount: 4, rejected: 0, onchainRegistered: false, createdAt: '2026-01-01', settledAt: ['2026-07-09', '2026-07-09', '2026-07-08', '2026-07-08'] },
    asOf,
  )
  assert.ok(fresh.settledEffective > 3.9 && fresh.settledEffective <= 4, `got ${fresh.settledEffective}`)
})

test('a 90-day-old settlement weighs ~0.5 (the half-life)', () => {
  const r = computeAgentReputation(
    { settledCount: 1, rejected: 0, onchainRegistered: false, createdAt: '2025-01-01', settledAt: ['2026-04-11'] }, // 90 days before asOf
    asOf,
  )
  assert.ok(Math.abs(r.settledEffective - 0.5) < 0.01, `got ${r.settledEffective}`)
})

test('recent history outscores identical-but-ancient history', () => {
  const recent = computeAgentReputation(
    { settledCount: 8, rejected: 0, onchainRegistered: false, createdAt: '2024-01-01', settledAt: Array(8).fill('2026-07-05') },
    asOf,
  )
  const ancient = computeAgentReputation(
    { settledCount: 8, rejected: 0, onchainRegistered: false, createdAt: '2024-01-01', settledAt: Array(8).fill('2024-07-05') },
    asOf,
  )
  assert.ok(recent.breakdown.settlement > ancient.breakdown.settlement, `${recent.breakdown.settlement} !> ${ancient.breakdown.settlement}`)
})

test('decay never touches the validation share (a rejection does not age away)', () => {
  const aged = computeAgentReputation(
    { settledCount: 5, rejected: 5, onchainRegistered: false, createdAt: '2024-01-01', settledAt: Array(5).fill('2024-07-05') },
    asOf,
  )
  const fresh = computeAgentReputation({ settledCount: 5, rejected: 5, onchainRegistered: false, createdAt: '2024-01-01' }, asOf)
  assert.equal(aged.breakdown.validation, fresh.breakdown.validation)
})

test('an unparseable settlement timestamp weighs 1 (neutral, never NaN)', () => {
  const r = computeAgentReputation(
    { settledCount: 2, rejected: 0, onchainRegistered: false, createdAt: '2026-01-01', settledAt: ['garbage', '2026-07-09'] },
    asOf,
  )
  assert.ok(Number.isFinite(r.settledEffective) && r.settledEffective > 1.9, `got ${r.settledEffective}`)
  assert.ok(Number.isFinite(r.score))
})

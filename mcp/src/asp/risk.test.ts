/**
 * Unit tests for the ASP risk engine (assessRisk) - pure, offline, deterministic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessRisk, classifySybil, type RiskSignals, type SybilSignals } from './risk.js'

const strong: RiskSignals = { onchainVerified: true, kyaVerified: true, reputationScore: 720, tenureDays: 90 }

test('ALLOW: verified identity + KYA + strong reputation', () => {
  const r = assessRisk(strong)
  assert.equal(r.decision, 'ALLOW')
  assert.equal(r.risk, 'low')
  assert.ok(r.reasons.length >= 1)
})

test('DENY: no on-chain identity', () => {
  const r = assessRisk({ ...strong, onchainVerified: false })
  assert.equal(r.decision, 'DENY')
  assert.equal(r.risk, 'high')
  assert.ok(r.reasons.some((x) => /on-chain identity/i.test(x)))
})

test('DENY: reputation below the safe floor', () => {
  const r = assessRisk({ ...strong, reputationScore: 150 })
  assert.equal(r.decision, 'DENY')
  assert.ok(r.reasons.some((x) => /below the safe threshold/i.test(x)))
})

test('DENY: high-value tx to a low-reputation agent', () => {
  const r = assessRisk({ ...strong, reputationScore: 300 }, { amountUsd: 500 })
  assert.equal(r.decision, 'DENY')
  assert.ok(r.reasons.some((x) => /High-value transaction/i.test(x)))
})

test('WARN: KYA not attested (identity still verified)', () => {
  const r = assessRisk({ ...strong, kyaVerified: false })
  assert.equal(r.decision, 'WARN')
  assert.equal(r.risk, 'medium')
  assert.ok(r.reasons.some((x) => /KYA/i.test(x)))
})

test('WARN: moderate reputation', () => {
  const r = assessRisk({ ...strong, reputationScore: 350 })
  assert.equal(r.decision, 'WARN')
  assert.ok(r.reasons.some((x) => /Moderate reputation/i.test(x)))
})

test('WARN: new agent (short tenure)', () => {
  const r = assessRisk({ ...strong, tenureDays: 2 })
  assert.equal(r.decision, 'WARN')
  assert.ok(r.reasons.some((x) => /New agent/i.test(x)))
})

test('WARN: large transaction amount even for a strong agent', () => {
  const r = assessRisk(strong, { amountUsd: 5000 })
  assert.equal(r.decision, 'WARN')
  assert.ok(r.reasons.some((x) => /Large transaction/i.test(x)))
})

test('txContext is echoed back in signals', () => {
  const ctx = { amountUsd: 42, payee: '0xabc' }
  const r = assessRisk(strong, ctx)
  assert.deepEqual(r.signals.txContext, ctx)
})

test('DENY reasons include triggered WARN reasons too', () => {
  const r = assessRisk({ onchainVerified: false, kyaVerified: false, reputationScore: 100, tenureDays: 1 })
  assert.equal(r.decision, 'DENY')
  // both deny (no identity, low rep) and warn (kya, new agent) reasons collected
  assert.ok(r.reasons.length >= 3)
})

test('DENY: a revoked KYA forces a deny even for an otherwise-strong agent (A2)', () => {
  const r = assessRisk({ ...strong, revoked: true })
  assert.equal(r.decision, 'DENY')
  assert.equal(r.risk, 'high')
  assert.ok(r.reasons.some((x) => /REVOKED/i.test(x)), 'the revoked reason must be present')
})

test('a revoked agent is not also flagged as merely "KYA not attested"', () => {
  const r = assessRisk({ onchainVerified: true, kyaVerified: false, reputationScore: 720, tenureDays: 90, revoked: true })
  assert.equal(r.decision, 'DENY')
  assert.ok(r.reasons.some((x) => /REVOKED/i.test(x)))
  assert.ok(!r.reasons.some((x) => /not attested/i.test(x)), 'revoked should suppress the redundant not-attested warn')
})

// ── Sybil / wash-reputation detection (A4) ────────────────────────────────────────

const cleanSybil: SybilSignals = { siblingCount: 0, jobs: 0, uniqueClients: 0, selfDealt: 0, selfDealRate: 0, diversity: 1 }

test('classifySybil: reputation mostly self-dealt is HIGH', () => {
  assert.equal(classifySybil({ ...cleanSybil, jobs: 5, uniqueClients: 1, selfDealt: 4, selfDealRate: 0.8, diversity: 0.2 }), 'high')
})
test('classifySybil: partial self-dealing is MEDIUM', () => {
  assert.equal(classifySybil({ ...cleanSybil, jobs: 5, uniqueClients: 3, selfDealt: 2, selfDealRate: 0.4, diversity: 0.6 }), 'medium')
})
test('classifySybil: a large cluster with low diversity is MEDIUM', () => {
  assert.equal(classifySybil({ ...cleanSybil, siblingCount: 5, jobs: 4, uniqueClients: 1, selfDealt: 0, selfDealRate: 0, diversity: 0.25 }), 'medium')
})
test('classifySybil: a bit of self-dealing or a cluster is LOW', () => {
  assert.equal(classifySybil({ ...cleanSybil, jobs: 10, uniqueClients: 8, selfDealt: 1, selfDealRate: 0.1, diversity: 0.8 }), 'low')
  assert.equal(classifySybil({ ...cleanSybil, siblingCount: 4 }), 'low')
})
test('classifySybil: independent clients => none', () => {
  assert.equal(classifySybil({ ...cleanSybil, jobs: 8, uniqueClients: 7, selfDealt: 0, selfDealRate: 0, diversity: 0.875 }), 'none')
})
test('DENY: high Sybil risk forces a deny even for a strong agent (A4)', () => {
  const r = assessRisk({ ...strong, sybil: 'high' })
  assert.equal(r.decision, 'DENY')
  assert.ok(r.reasons.some((x) => /Sybil|wash-traded/i.test(x)))
})
test('WARN: medium Sybil risk warns', () => {
  const r = assessRisk({ ...strong, sybil: 'medium' })
  assert.equal(r.decision, 'WARN')
  assert.ok(r.reasons.some((x) => /Sybil/i.test(x)))
})

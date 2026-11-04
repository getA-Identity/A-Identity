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

test('DENY: no on-chain identity, when the caller does not say whether it holds a record', () => {
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

// ── the line, decided 2026-11-04: DENY needs evidence against a payee we hold a record of ──

const unknown: RiskSignals = { onchainVerified: false, kyaVerified: false, reputationScore: 0, tenureDays: 0, onPlatform: false }

test('a payee with no identity and no platform record is WARN, and the reasons say what we do not know', () => {
  const r = assessRisk(unknown)
  assert.equal(r.decision, 'WARN')
  assert.equal(r.risk, 'medium')
  assert.match(r.reasons[0], /No on-chain identity/)
  assert.match(r.reasons[0], /we do not know who it is/)
  assert.match(r.reasons[0], /does not mean it is bad/)
  for (const reason of r.reasons) {
    assert.doesNotMatch(reason, /Identity resolved/, 'no identity was found, so none resolved')
    assert.doesNotMatch(reason, /New agent/, 'with no record a tenure of 0 means unknown, not new')
  }
  assert.ok(r.reasons.some((x) => /KYA/.test(x)))
})

test('a payee with an identity and no platform record is WARN, at the score it can actually reach', () => {
  const r = assessRisk({ ...unknown, onchainVerified: true, reputationScore: 60 })
  assert.equal(r.decision, 'WARN')
  assert.match(r.reasons[0], /An on-chain identity was found/)
  assert.match(r.reasons[0], /does not mean it is bad/)
  assert.ok(r.reasons.some((x) => /score of 60 only reflects/.test(x)))
})

test('a high-value or large payment to a payee with no record stays WARN, with the amount named', () => {
  const high = assessRisk({ ...unknown, onchainVerified: true, reputationScore: 60 }, { amountUsd: 500 })
  assert.equal(high.decision, 'WARN')
  assert.ok(high.reasons.some((x) => /\$500/.test(x)))
  assert.ok(!high.reasons.some((x) => /low-reputation agent/.test(x)))
  const large = assessRisk(unknown, { amountUsd: 5000 })
  assert.equal(large.decision, 'WARN')
  assert.ok(large.reasons.some((x) => /Large transaction amount \(\$5000\)/.test(x)))
  // At exactly 100 USD it is not high-value, the same line the platform rule uses.
  assert.ok(!assessRisk(unknown, { amountUsd: 100 }).reasons.some((x) => /High-value/.test(x)))
})

test('a payee with no record is never ALLOW, whatever else it shows', () => {
  const r = assessRisk({ ...strong, onPlatform: false })
  assert.equal(r.decision, 'WARN')
  assert.equal(assessRisk({ ...strong, onchainVerified: false, onPlatform: false }).decision, 'WARN')
})

test('evidence against a payee is DENY with or without a platform record', () => {
  assert.equal(assessRisk({ ...unknown, revoked: true }).decision, 'DENY')
  assert.equal(assessRisk({ ...unknown, sybil: 'high' }).decision, 'DENY')
})

test('an agent on our platform keeps the DENY lines: under 200, and over 100 USD under 400', () => {
  const platform: RiskSignals = { ...strong, onPlatform: true }
  const low = assessRisk({ ...platform, reputationScore: 199 })
  assert.equal(low.decision, 'DENY')
  assert.ok(low.reasons.some((x) => /below the safe threshold/.test(x)))
  assert.equal(assessRisk({ ...platform, reputationScore: 200 }).decision, 'WARN')
  const high = assessRisk({ ...platform, reputationScore: 399 }, { amountUsd: 100.01 })
  assert.equal(high.decision, 'DENY')
  assert.ok(high.reasons.some((x) => /High-value transaction/.test(x)))
  assert.equal(assessRisk({ ...platform, reputationScore: 399 }, { amountUsd: 100 }).decision, 'WARN')
  assert.equal(assessRisk({ ...platform, reputationScore: 400 }, { amountUsd: 100.01 }).decision, 'WARN')
  assert.equal(assessRisk(platform).decision, 'ALLOW')
})

test('an agent on our platform with no identity is WARN, not ALLOW and not DENY, and no identity is claimed', () => {
  const r = assessRisk({ ...strong, onchainVerified: false, onPlatform: true })
  assert.equal(r.decision, 'WARN')
  assert.match(r.reasons[0], /does not mean it is bad/)
  const noKya = assessRisk({ ...strong, onchainVerified: false, kyaVerified: false, reputationScore: 300, onPlatform: true })
  assert.equal(noKya.decision, 'WARN')
  assert.ok(!noKya.reasons.some((x) => /Identity resolved/.test(x)))
})

test('with the input absent nothing loosens: every strict DENY stays, and no identity claims none resolved', () => {
  const absent = assessRisk({ onchainVerified: false, kyaVerified: false, reputationScore: 60, tenureDays: 0 }, { amountUsd: 500 })
  assert.equal(absent.decision, 'DENY')
  assert.ok(absent.reasons.some((x) => /No verifiable on-chain identity/.test(x)))
  assert.ok(absent.reasons.some((x) => /below the safe threshold/.test(x)))
  assert.ok(absent.reasons.some((x) => /High-value transaction/.test(x)))
  assert.ok(!absent.reasons.some((x) => /Identity resolved/.test(x)))
  assert.deepEqual(assessRisk({ ...strong, onPlatform: undefined }).decision, 'ALLOW')
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

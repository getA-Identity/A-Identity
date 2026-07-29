import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateTraction, emptyMeter, meterDecision, meterOverrideAttempt, type AgentMeter } from './meter.js'
import type { Decision, Surface, Verdict } from './types.js'

// Metering and traction (Phase 5.3 and 5.5). The tests that matter most here are the honesty
// ones: a metric that can be inflated by our own monitoring, or that shrinks as usage grows,
// is worse than no metric.

const AT = '2026-07-29T12:00:00Z'
const LATER = '2026-07-30T12:00:00Z'

const decision = (verdict: Verdict, surface: Surface = 'trade', unverifiable = false): Decision => ({
  verdict,
  reasons: [],
  codes: [],
  surface,
  kind: 'order',
  policyId: 'p',
  policyVersion: 1,
  unverifiable,
})

const fold = (
  steps: { verdict: Verdict; notionalUsd: number; surface?: Surface; unverifiable?: boolean }[],
): AgentMeter => {
  let m: AgentMeter | undefined
  for (const s of steps) {
    m = meterDecision(m, {
      decision: decision(s.verdict, s.surface ?? 'trade', s.unverifiable ?? false),
      notionalUsd: s.notionalUsd,
      at: AT,
    })
  }
  return m as AgentMeter
}

// ── counting ──────────────────────────────────────────────────────────────────────

test('a meter counts verdicts and keeps allowed and blocked value apart', () => {
  const m = fold([
    { verdict: 'ALLOW', notionalUsd: 50 },
    { verdict: 'ALLOW', notionalUsd: 25 },
    { verdict: 'DENY', notionalUsd: 900 },
    { verdict: 'WARN', notionalUsd: 200 },
  ])
  assert.equal(m.checks, 4)
  assert.equal(m.allow, 2)
  assert.equal(m.deny, 1)
  assert.equal(m.warn, 1)
  assert.equal(m.blockedNotionalUsd, 900)
  assert.equal(m.allowedNotionalUsd, 75)
})

test('a WARN counts as neither allowed nor blocked value', () => {
  // It is undecided until a human acts, so putting it in either bucket would be a claim we
  // cannot support.
  const m = fold([{ verdict: 'WARN', notionalUsd: 500 }])
  assert.equal(m.allowedNotionalUsd, 0)
  assert.equal(m.blockedNotionalUsd, 0)
})

test('surfaces are counted separately', () => {
  const m = fold([
    { verdict: 'ALLOW', notionalUsd: 10, surface: 'trade' },
    { verdict: 'DENY', notionalUsd: 20, surface: 'spend' },
    { verdict: 'ALLOW', notionalUsd: 30, surface: 'spend' },
  ])
  assert.deepEqual(m.bySurface, { trade: 1, spend: 2 })
})

test('unverifiable decisions are tracked', () => {
  const m = fold([{ verdict: 'DENY', notionalUsd: 10, unverifiable: true }])
  assert.equal(m.unverifiable, 1)
})

test('a nonsense amount contributes nothing rather than NaN', () => {
  for (const bad of [NaN, Infinity, -5]) {
    const m = meterDecision(undefined, { decision: decision('DENY'), notionalUsd: bad, at: AT })
    assert.equal(m.blockedNotionalUsd, 0, String(bad))
    assert.equal(m.checks, 1)
  }
})

test('metering never mutates the meter it was handed', () => {
  const first = fold([{ verdict: 'ALLOW', notionalUsd: 10 }])
  const snapshot = JSON.stringify(first)
  meterDecision(first, { decision: decision('DENY'), notionalUsd: 99, at: LATER })
  assert.equal(JSON.stringify(first), snapshot)
})

test('an override attempt is counted without counting as a decision', () => {
  const m = meterOverrideAttempt(fold([{ verdict: 'DENY', notionalUsd: 10 }]), LATER)
  assert.equal(m.overrideAttempts, 1)
  assert.equal(m.checks, 1, 'a refused override is not a new decision')
  assert.equal(m.lastAt, LATER)
})

test('timestamps bracket the activity', () => {
  const m = meterDecision(fold([{ verdict: 'ALLOW', notionalUsd: 1 }]), {
    decision: decision('ALLOW'),
    notionalUsd: 1,
    at: LATER,
  })
  assert.equal(m.firstAt, AT)
  assert.equal(m.lastAt, LATER)
})

// ── the aggregate, and the honesty rules it has to hold ───────────────────────────

const row = (m: AgentMeter, ci = false) => ({ meter: m, ci })

test('traction sums real agents', () => {
  const t = aggregateTraction(
    [
      row(fold([{ verdict: 'DENY', notionalUsd: 500 }, { verdict: 'ALLOW', notionalUsd: 40 }])),
      row(fold([{ verdict: 'DENY', notionalUsd: 250 }])),
    ],
    2,
    0,
  )
  assert.equal(t.checks, 3)
  assert.equal(t.deny, 2)
  assert.equal(t.protectedNotionalUsd, 750)
  assert.equal(t.activeAgents, 2)
})

test('CI activity is excluded from every headline and reported on its own', () => {
  // The load-bearing rule. A scheduled canary exists to prove the engine still enforces;
  // letting its synthetic checks count as usage would turn our own monitoring into fake
  // traction, which is exactly what the honesty gate forbids.
  const real = row(fold([{ verdict: 'DENY', notionalUsd: 100 }]))
  const canary = row(fold([{ verdict: 'DENY', notionalUsd: 1_000_000 }]), true)
  const t = aggregateTraction([real, canary], 1, 1)
  assert.equal(t.checks, 1, 'CI checks are not counted as usage')
  assert.equal(t.protectedNotionalUsd, 100, 'CI value never reaches the grant metric')
  assert.equal(t.activeAgents, 1)
  assert.equal(t.ci.checks, 1)
  assert.equal(t.ci.agents, 1)
})

test('a registered agent nobody ever checked is not active', () => {
  const t = aggregateTraction([row(emptyMeter(AT))], 5, 0)
  assert.equal(t.registeredAgents, 5)
  assert.equal(t.activeAgents, 0, 'registration is not traction')
  assert.equal(t.checks, 0)
})

test('an empty platform aggregates to zeroes, not to nothing', () => {
  const t = aggregateTraction([], 0, 0)
  assert.equal(t.checks, 0)
  assert.equal(t.protectedNotionalUsd, 0)
  assert.equal(t.firstAt, null)
  assert.ok(t.disclosure.length >= 4)
})

test('surface breakdown is summed across agents', () => {
  const t = aggregateTraction(
    [
      row(fold([{ verdict: 'ALLOW', notionalUsd: 1, surface: 'trade' }])),
      row(fold([{ verdict: 'ALLOW', notionalUsd: 1, surface: 'spend' }, { verdict: 'DENY', notionalUsd: 1, surface: 'spend' }])),
    ],
    2,
    0,
  )
  assert.deepEqual(t.bySurface, { trade: 1, spend: 2 })
})

test('the disclosure states what the protected number is and is not', () => {
  const t = aggregateTraction([row(fold([{ verdict: 'DENY', notionalUsd: 10 }]))], 1, 0)
  const text = t.disclosure.join(' ')
  assert.ok(text.includes('measured, not a projection'))
  assert.ok(text.includes('not revenue'), 'protected notional must never read as income')
  assert.ok(text.includes('Aggregate only'))
  assert.ok(text.includes('excluded'), 'the CI exclusion has to be stated, not just implemented')
})

test('money amounts are rounded to cents rather than carrying float noise', () => {
  const t = aggregateTraction(
    [row(fold([{ verdict: 'DENY', notionalUsd: 0.1 }, { verdict: 'DENY', notionalUsd: 0.2 }]))],
    1,
    0,
  )
  assert.equal(t.protectedNotionalUsd, 0.3)
})

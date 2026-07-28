import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardrailProfile, notRegisteredProfile, unobservableProfile } from './compliance.js'
import { buildAuditEntry } from './audit.js'
import { evaluateAction } from './engine.js'
import { defaultActionPolicy } from './policy.js'
import type { AccountSnapshot, AuditEntry, NormalizedIntent } from './index.js'

const NOW = new Date('2026-07-29T12:00:00Z')
const POLICY = defaultActionPolicy('pol_c', NOW.toISOString())

const snap = (over: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  todayNotionalUsd: 0,
  positions: [{ symbol: 'NVDA', shares: 40, valueUsd: 8_400 }],
  portfolioValueUsd: 12_000,
  buyingPowerUsd: 9_000,
  cashAvailableUsd: 9_000,
  marginUsedUsd: 0,
  accountType: 'cash',
  ...over,
})

function entry(intent: NormalizedIntent, i = 0, over: Partial<AuditEntry> = {}): AuditEntry {
  const decision = evaluateAction({ surface: 'trade', policy: POLICY, intent, snapshot: snap(), now: NOW })
  return {
    ...buildAuditEntry({
      id: `aud_${i}`,
      ts: '2026-07-28T10:00:00Z',
      agentId: 'agent_1',
      intent,
      snapshot: snap(),
      decision,
    }),
    ...over,
  }
}

const allow = (i = 0) => entry({ kind: 'order', side: 'buy', symbol: 'NVDA', notionalUsd: 40 }, i)
const deny = (i = 0, over: Partial<AuditEntry> = {}) =>
  entry({ kind: 'order', side: 'buy', symbol: 'NVDA', notionalUsd: 9_000 }, i, over)
const warn = (i = 0, over: Partial<AuditEntry> = {}) => entry({ kind: 'transfer', notionalUsd: 5 }, i, over)

const profile = (entries: AuditEntry[], configured = true, version = 2) =>
  guardrailProfile({ entries, policyConfigured: configured, policyVersion: version, now: NOW })

// ── the no-leak guarantee: this is the whole reason the tool is sellable ───────────

test('the profile discloses no caps, symbols, amounts, holdings or hashes', () => {
  const p = profile([allow(0), deny(1), warn(2)])
  const json = JSON.stringify(p)
  // Values from the policy, the intents and the snapshot that must never cross over.
  for (const secret of ['NVDA', '9000', '9,000', '8400', '12000', 'sha256', 'perActionCap', 'dailyCap', 'allowSymbols', 'positions', 'buyingPower']) {
    assert.equal(json.includes(secret), false, `profile leaked ${secret}`)
  }
})

test('the profile exposes no exact counts, only bands', () => {
  // 3 ALLOWs and 1 DENY must not be recoverable from the output.
  const p = profile([allow(0), allow(1), allow(2), deny(3)])
  const json = JSON.stringify(p)
  for (const n of ['"3"', '"4"', ':3', ':4']) {
    assert.equal(json.includes(n), false, `profile leaked a count (${n})`)
  }
  assert.equal(typeof p.decisionsObserved, 'string')
  assert.equal(typeof p.blockRate, 'string')
})

test('only day precision is published for the last decision', () => {
  const p = profile([allow(0)])
  assert.equal(p.lastDecisionDate, '2026-07-28')
  assert.equal(JSON.stringify(p).includes('10:00'), false, 'exact activity timing must not leak')
})

// ── enforcement is policy PLUS observed decisions ────────────────────────────────

test('a configured policy with no decisions is not enforcement', () => {
  const p = profile([], true)
  assert.equal(p.policyEnforced, false)
  assert.ok(p.disclosure.some((d) => d.includes('absence of history')))
})

test('an unconfigured policy is never reported as enforced', () => {
  assert.equal(profile([allow(0)], false).policyEnforced, false)
})

test('a configured policy with recorded decisions is enforcement', () => {
  assert.equal(profile([allow(0)], true).policyEnforced, true)
})

// ── bands ────────────────────────────────────────────────────────────────────────

test('decision volume bands step at 10 and 100', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => allow(i))
  assert.equal(profile([]).decisionsObserved, 'none')
  assert.equal(profile(many(9)).decisionsObserved, 'few')
  assert.equal(profile(many(10)).decisionsObserved, 'some')
  assert.equal(profile(many(100)).decisionsObserved, 'many')
})

test('a clean record bands as none, not low', () => {
  const p = profile([allow(0), allow(1)])
  assert.equal(p.blockRate, 'none')
  assert.equal(p.overrideAttempts, 'none')
  assert.equal(p.unverifiableRate, 'none')
})

test('block rate bands by share of decisions', () => {
  const mix = (denies: number, allows: number) => [
    ...Array.from({ length: denies }, (_, i) => deny(i)),
    ...Array.from({ length: allows }, (_, i) => allow(100 + i)),
  ]
  assert.equal(profile(mix(1, 99)).blockRate, 'low')
  assert.equal(profile(mix(2, 8)).blockRate, 'medium')
  assert.equal(profile(mix(5, 5)).blockRate, 'high')
})

test('override attempts band by count, and are called out in the disclosure', () => {
  assert.equal(profile([deny(0)]).overrideAttempts, 'none')
  assert.equal(profile([deny(0, { overrideAttempts: 2 })]).overrideAttempts, 'low')
  assert.equal(profile([deny(0, { overrideAttempts: 5 })]).overrideAttempts, 'medium')
  const p = profile([deny(0, { overrideAttempts: 12 })])
  assert.equal(p.overrideAttempts, 'high')
  assert.ok(p.disclosure.some((d) => d.includes('blocked action as executed')))
})

test('dangling approvals measure WARNs nobody closed, against WARNs only', () => {
  // 2 WARNs, 1 still awaiting: the denominator is the WARN count, not all decisions,
  // or a busy ALLOW history would dilute an unclosed human loop into invisibility.
  const p = profile([
    warn(0, { outcome: 'awaiting_human' }),
    warn(1, { outcome: 'executed' }),
    allow(2),
    allow(3),
  ])
  assert.equal(p.danglingApprovals, 'high')
})

test('unverifiable decisions are surfaced', () => {
  const noCash = snap()
  delete noCash.cashAvailableUsd
  const intent: NormalizedIntent = { kind: 'order', side: 'buy', symbol: 'NVDA', notionalUsd: 40 }
  const decision = evaluateAction({ surface: 'trade', policy: POLICY, intent, snapshot: noCash, now: NOW })
  const e = buildAuditEntry({ id: 'aud_u', ts: '2026-07-28T10:00:00Z', agentId: 'a', intent, snapshot: noCash, decision })
  assert.equal(e.unverifiable, true)
  assert.equal(profile([e]).unverifiableRate, 'high')
})

// ── honest caveats ───────────────────────────────────────────────────────────────

test('the disclosure warns that a high block rate is not itself negative', () => {
  const p = profile([deny(0), deny(1)])
  assert.equal(p.blockRate, 'high')
  assert.ok(
    p.disclosure.some((d) => d.includes('NOT by itself a negative signal')),
    'a buyer must not read a tight policy as a bad agent',
  )
})

test('the disclosure always states that fields are bands', () => {
  assert.ok(profile([allow(0)]).disclosure.some((d) => d.includes('band, not a value')))
})

// ── unobservable is not innocence ────────────────────────────────────────────────

test('an unreadable store reports unavailable, never a clean profile', () => {
  const p = unobservableProfile()
  assert.equal(p.observability, 'unavailable')
  assert.equal(p.policyEnforced, false)
  assert.equal(p.policyStability, 'unknown')
  assert.equal(p.lastDecisionDate, null)
  assert.ok(
    p.disclosure[0].includes('NOT evidence'),
    'the output must say plainly that absence of data is not absence of guardrails',
  )
})

test('an unregistered agent is a different answer from an unreadable store', () => {
  // Collapsing these would be dishonest in both directions: one is a finding (the agent
  // does not use our guardrails), the other is the absence of any finding.
  const nr = notRegisteredProfile()
  const un = unobservableProfile()
  assert.equal(nr.observability, 'not_registered')
  assert.equal(un.observability, 'unavailable')
  assert.notEqual(nr.disclosure[0], un.disclosure[0])
  assert.ok(nr.disclosure[0].includes('not registered'))
  assert.ok(
    nr.disclosure[0].includes('may still be bounded by guardrails we cannot see'),
    'not being our customer is not the same as being unbounded',
  )
  // Neither may look like a pass.
  for (const p of [nr, un]) {
    assert.equal(p.policyEnforced, false)
    assert.equal(p.decisionsObserved, 'none')
  }
})

test('an observed profile is distinguishable from an unobservable one', () => {
  assert.equal(profile([allow(0)]).observability, 'observed')
})

// ── policy stability ─────────────────────────────────────────────────────────────

test('a policy edited many times right before its actions is flagged', () => {
  const recent = { ...allow(0), ts: '2026-07-29T11:00:00Z' } // one hour before now
  assert.equal(profile([recent], true, 9).policyStability, 'recently_changed')
})

test('a settled policy reads as stable', () => {
  assert.equal(profile([allow(0)], true, 2).policyStability, 'stable')
})

test('an unconfigured policy has unknown stability, not stable', () => {
  assert.equal(profile([allow(0)], false).policyStability, 'unknown')
})

// ── determinism ──────────────────────────────────────────────────────────────────

test('the same inputs always produce the same profile', () => {
  const entries = [allow(0), deny(1), warn(2)]
  assert.deepEqual(profile(entries), profile(entries))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateAction } from './engine.js'
import { getSurface, SURFACES } from './registry.js'
import { defaultActionPolicy } from './policy.js'
import { BET_RULES_SKETCH, PRE_BET_CHECK_SCHEMA } from './bet-schema.js'
import type { AccountSnapshot, ActionKind, NormalizedIntent } from './types.js'

/**
 * Phase 7 is schema only, so these tests are not about what the bet surface does. They are
 * about proving it does NOTHING, and that it cannot quietly start doing something later
 * without a test going red. A planned surface is only honest if the plan is enforced.
 */

const src = (f: string) => readFileSync(new URL(`../../src/policy/${f}`, import.meta.url), 'utf8')

// ── the surface cannot authorize anything ─────────────────────────────────────────────

test('no policy, however permissive, lets the bet surface produce an ALLOW', () => {
  const base = defaultActionPolicy('p', '2026-07-29T12:00:00Z')
  const wideOpen = {
    ...base,
    frozen: false,
    perActionCapUsd: 1e9,
    dailyCapUsd: 1e9,
    humanApprovalAboveUsd: 1e9,
    trade: { ...base.trade, allowOptions: true, maxConcentrationPct: 100, tradingHoursUtc: null },
  }
  const snapshot: AccountSnapshot = {
    todayNotionalUsd: 0,
    positions: [],
    portfolioValueUsd: 1e7,
    cashAvailableUsd: 1e7,
    buyingPowerUsd: 1e7,
    marginUsedUsd: 0,
    accountType: 'cash',
  }

  // Every kind, including the one the registry lists for bet, and a zero-dollar action which
  // is the case most likely to slip through an amount-based rule.
  const kinds: ActionKind[] = ['order', 'purchase', 'cancel', 'recurring', 'settings', 'transfer', 'document']
  for (const kind of kinds) {
    for (const notionalUsd of [0, 1, 5000]) {
      const intent: NormalizedIntent = { kind, notionalUsd, symbol: 'BTC', side: 'buy' }
      const d = evaluateAction({ surface: 'bet', policy: wideOpen, intent, snapshot })
      assert.equal(d.verdict, 'DENY', `${kind} @ ${notionalUsd} produced ${d.verdict}`)
      assert.ok(d.codes.includes('SURFACE_NOT_LIVE'), `${kind} denied for the wrong reason: ${d.codes}`)
    }
  }
})

test('the refusal comes from status, before any rule can run', () => {
  // If the refusal were merely the last rule to fire, a reordering would break it silently.
  // The bet surface must carry exactly one code: the status gate and nothing else.
  const policy = defaultActionPolicy('p', '2026-07-29T12:00:00Z')
  const d = evaluateAction({
    surface: 'bet',
    policy,
    // A frozen policy AND an over-cap amount would each independently deny on a live
    // surface. Neither reason appears, which proves nothing downstream was consulted.
    intent: { kind: 'order', notionalUsd: 1e9 },
    snapshot: { todayNotionalUsd: 0, positions: [] },
  })
  assert.deepEqual(d.codes, ['SURFACE_NOT_LIVE'])
  assert.equal(d.surface, 'bet')
  assert.equal(d.unverifiable, false, 'a planned surface is not an unverifiable one')
})

test('bet stays planned, and is the only planned surface', () => {
  assert.equal(getSurface('bet')?.status, 'planned')
  const planned = SURFACES.filter((s) => s.status !== 'live').map((s) => s.id)
  assert.deepEqual(planned, ['bet'])
})

// ── the schema is inert ──────────────────────────────────────────────────────────────

test('the schema module exports data and not one function', async () => {
  // The moment this file exports a function, it has stopped being a schema.
  const mod: Record<string, unknown> = await import('./bet-schema.js')
  for (const [name, value] of Object.entries(mod)) {
    assert.notEqual(typeof value, 'function', `bet-schema exports a callable: ${name}`)
  }
  assert.ok(Object.isFrozen(PRE_BET_CHECK_SCHEMA))
  assert.ok(Object.isFrozen(BET_RULES_SKETCH))
  BET_RULES_SKETCH.forEach((r) => assert.ok(Object.isFrozen(r), `${r.code} is not frozen`))
})

test('the engine imports nothing from the bet schema and carries no bet rule', () => {
  const engine = src('engine.ts')
  assert.equal(engine.includes('bet-schema'), false, 'the engine reached for the planned schema')
  // Every sketched rule is genuinely unimplemented: its code appears nowhere in the engine.
  for (const r of BET_RULES_SKETCH) {
    assert.equal(engine.includes(r.code), false, `${r.code} looks implemented, so the sketch is stale`)
  }
})

test('no live tool or route named pre_bet_check exists', () => {
  // A schema that is reachable is not a schema, it is a feature.
  for (const f of [
    '../server.ts',
    '../http.ts',
    '../http/shared.ts',
    '../http/auth-routes.ts',
    '../http/public-routes.ts',
    '../http/celo-routes.ts',
    '../http/arc-routes.ts',
    '../http/agent-routes.ts',
    '../http/guardrail-routes.ts',
    '../http/instruction-routes.ts',
    '../http/marketplace-routes.ts',
  ]) {
    const text = readFileSync(new URL(f, new URL('../../src/policy/', import.meta.url)), 'utf8')
    assert.equal(text.includes('pre_bet_check'), false, `${f} registers pre_bet_check`)
    assert.equal(text.includes('bet-schema'), false, `${f} imports the planned schema`)
  }
})

test('the sketch has unique codes and only non-ALLOW verdicts', () => {
  const codes = BET_RULES_SKETCH.map((r) => r.code)
  assert.equal(new Set(codes).size, codes.length, 'duplicate rule code in the sketch')
  for (const r of BET_RULES_SKETCH) {
    assert.ok(['DENY', 'WARN'].includes(r.verdict), `${r.code} sketches a ${r.verdict}`)
    assert.ok(r.needs.length > 0, `${r.code} does not say what it is waiting on`)
  }
  // The two ceilings that make a bet different from a trade must both be present, or the
  // schema has forgotten why it exists.
  assert.ok(codes.includes('BET_OPEN_STAKE_CAP'), 'no cumulative open-stake ceiling')
  assert.ok(codes.includes('BET_NEEDS_HUMAN'), 'no human-approval default')
})

// ── the schema matches the type it documents ─────────────────────────────────────────

test('the declared field lists match the BetIntent type', () => {
  // Drift guard in the same spirit as frontend-sync: the tool schema and the type are two
  // statements of one shape, so they are asserted equal rather than kept in step by hand.
  const text = src('bet-schema.ts')
  const block = text.slice(text.indexOf('export type BetIntent = {'))
  const body = block.slice(0, block.indexOf('\n}'))
  const declared = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1])
  const listed = [...PRE_BET_CHECK_SCHEMA.required, ...PRE_BET_CHECK_SCHEMA.optional]
  assert.deepEqual(new Set(declared), new Set(listed), `type has [${declared}], schema lists [${listed}]`)

  // Required means non-optional in the type, too.
  for (const field of PRE_BET_CHECK_SCHEMA.required) {
    assert.ok(new RegExp(`^\\s{2}${field}:`, 'm').test(body), `${field} is required but optional in the type`)
  }
  for (const field of PRE_BET_CHECK_SCHEMA.optional) {
    assert.ok(new RegExp(`^\\s{2}${field}\\?:`, 'm').test(body), `${field} is optional but required in the type`)
  }
})

test('stake is the risk field, and payout is never treated as one', () => {
  // The single most tempting mistake here: capping on maxPayoutUsd. Upside is not risk, and
  // a cap on it would refuse the safest bets hardest.
  assert.ok(PRE_BET_CHECK_SCHEMA.required.includes('stakeUsd'))
  assert.equal(PRE_BET_CHECK_SCHEMA.required.includes('maxPayoutUsd'), false)
  const rules = BET_RULES_SKETCH.map((r) => `${r.code} ${r.rule}`).join('\n')
  assert.equal(/maxPayoutUsd|payout exceeds/.test(rules), false, 'a sketched rule caps payout rather than stake')
  assert.ok(rules.includes('stakeCapUsd'))
})

test('the schema declares itself planned, so a reader cannot mistake it for shipped', () => {
  assert.equal(PRE_BET_CHECK_SCHEMA.status, 'planned')
  assert.equal(PRE_BET_CHECK_SCHEMA.surface, 'bet')
  assert.ok(PRE_BET_CHECK_SCHEMA.description.includes('SURFACE_NOT_LIVE'))
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CALLERS, getCaller, publicCallers } from './registry.js'
import { resolveCallerInput } from './normalize.js'
import { buildAuditEntry, guardrailProfile, evaluateAction, defaultActionPolicy } from '../policy/index.js'
import type { AuditEntry } from '../policy/index.js'

/**
 * The caller seam, and the two boundaries that keep it a seam instead of a pile of special
 * cases: venue names live only here, and nothing that decides anything may import this.
 */

const CRYPTO = 'robinhood-crypto-api'

const order = {
  symbol: 'BTC-USD',
  side: 'buy',
  type: 'limit',
  limit_order_config: { quote_amount: '25.00', time_in_force: 'gtc' },
}
const account = {
  buying_power: '1200.00',
  total_value_usd: '9800.00',
  today_notional_usd: '0',
  holdings: [{ symbol: 'BTC-USD', quantity: '0.01', value_usd: '620.00' }],
}

// ── the two accepted shapes ────────────────────────────────────────────────────────

test('a pre-normalized intent still resolves, and records itself as direct', () => {
  const r = resolveCallerInput({
    surface: 'trade',
    intent: { kind: 'order', notionalUsd: 20, symbol: 'AAPL' },
    snapshot: { todayNotionalUsd: 0, positions: [] },
  })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.intent.notionalUsd, 20)
  assert.deepEqual(r.provenance, {
    callerId: null,
    venue: null,
    // The weakest honest value: a wrapper we never heard of may exist, and we do not get
    // to claim credit for one we cannot name.
    enforcement: 'none',
    intentSource: 'direct',
    snapshotSource: 'direct',
  })
})

test('a direct intent with no snapshot records snapshotSource absent, not direct', () => {
  const r = resolveCallerInput({ surface: 'trade', intent: { kind: 'order', notionalUsd: 5 } })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.provenance.snapshotSource, 'absent')
  assert.equal(r.snapshot, undefined)
})

test('a MALFORMED direct intent passes through, so the engine can record the refusal', () => {
  // This is the property the product sells. If this module validated the intent, the
  // caller would get a protocol error and NO audit row would exist, which is exactly the
  // outcome a misbehaving agent would prefer.
  const r = resolveCallerInput({ surface: 'trade', intent: { kind: 'not-a-kind', notionalUsd: 'twenty' } })
  assert.equal(r.ok, true)
  if (!r.ok) return
  const decision = evaluateAction({
    surface: 'trade',
    policy: defaultActionPolicy('pol_t', '2026-08-13T00:00:00Z'),
    intent: r.intent,
    snapshot: { todayNotionalUsd: 0, positions: [] },
    now: new Date('2026-08-13T15:00:00Z'),
  })
  assert.equal(decision.verdict, 'DENY')
  assert.ok(decision.reasons.length > 0, 'a refusal must arrive with a reason')
})

test('a registered caller translates its own payload and names the venue', () => {
  const r = resolveCallerInput({ surface: 'trade', callerId: CRYPTO, action: order, account })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.intent.notionalUsd, 25)
  assert.equal(r.intent.symbol, 'BTC')
  assert.equal(r.snapshot?.portfolioValueUsd, 9800)
  assert.equal(r.provenance.callerId, CRYPTO)
  assert.equal(r.provenance.venue, getCaller(CRYPTO)?.venue)
  assert.equal(r.provenance.intentSource, 'caller-adapter')
  assert.equal(r.provenance.snapshotSource, 'caller-adapter')
})

test('a caller with no account payload still resolves, and the engine fails closed on it', () => {
  const r = resolveCallerInput({ surface: 'trade', callerId: CRYPTO, action: order })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.snapshot, undefined)
  assert.equal(r.provenance.snapshotSource, 'absent')
  const decision = evaluateAction({
    surface: 'trade',
    policy: defaultActionPolicy('pol_t', '2026-08-13T00:00:00Z'),
    intent: r.intent,
    now: new Date('2026-08-13T15:00:00Z'),
  })
  assert.equal(decision.verdict, 'DENY')
  assert.equal(decision.unverifiable, true)
})

// ── typed failures ─────────────────────────────────────────────────────────────────

test('every failure mode returns a typed code, never a thrown error', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ surface: 'trade' }, 'input_required'],
    [{ surface: 'trade', intent: { kind: 'order' }, callerId: CRYPTO, action: order }, 'ambiguous_input'],
    [{ surface: 'trade', callerId: 'nope', action: order }, 'unknown_caller'],
    [{ surface: 'trade', callerId: 'robinhood-mcp-official', action: order }, 'caller_not_normalizable'],
    [{ surface: 'spend', callerId: CRYPTO, action: order }, 'surface_mismatch'],
    [{ surface: 'trade', callerId: CRYPTO }, 'action_required'],
    [{ surface: 'trade', callerId: CRYPTO, action: { symbol: 'BTC-USD' } }, 'action_not_normalizable'],
    [{ surface: 'trade', callerId: CRYPTO, action: order, account: 'nonsense' }, 'account_not_normalizable'],
  ]
  for (const [input, code] of cases) {
    const r = resolveCallerInput(input as Parameters<typeof resolveCallerInput>[0])
    assert.equal(r.ok, false, `${code}: expected a refusal`)
    if (r.ok) continue
    assert.equal(r.code, code)
    assert.ok(r.reason.length > 10, `${code} must say why, not just that`)
  }
})

test('an unvaluable order is refused rather than estimated', () => {
  // A quantity with no price and no mark. This is precisely where an estimate would be
  // most tempting and least defensible.
  const r = resolveCallerInput({
    surface: 'trade',
    callerId: CRYPTO,
    action: { symbol: 'BTC-USD', side: 'buy', type: 'market', market_order_config: { asset_quantity: '0.5' } },
  })
  assert.equal(r.ok, false)
  if (r.ok) return
  assert.equal(r.code, 'action_not_normalizable')
})

// ── the audit row ──────────────────────────────────────────────────────────────────

const decisionFor = (intent: { kind: 'order'; notionalUsd: number }) =>
  evaluateAction({
    surface: 'trade',
    policy: defaultActionPolicy('pol_t', '2026-08-13T00:00:00Z'),
    intent,
    snapshot: { todayNotionalUsd: 0, positions: [], portfolioValueUsd: 1000, cashAvailableUsd: 1000, marginUsedUsd: 0 },
    now: new Date('2026-08-13T15:00:00Z'),
  })

test('an audit entry carries provenance when it is supplied, and NO key when it is not', () => {
  const intent = { kind: 'order' as const, notionalUsd: 10 }
  const decision = decisionFor(intent)
  const withCaller = buildAuditEntry({
    id: 'aud_1', ts: '2026-08-13T15:00:00Z', agentId: 'a', intent, decision,
    caller: { callerId: CRYPTO, venue: 'Robinhood Crypto', enforcement: 'wrapper', intentSource: 'caller-adapter', snapshotSource: 'absent' },
  })
  assert.equal(withCaller.caller?.callerId, CRYPTO)
  assert.equal(withCaller.caller?.enforcement, 'wrapper')

  const without = buildAuditEntry({ id: 'aud_2', ts: '2026-08-13T15:00:00Z', agentId: 'a', intent, decision })
  // Not `caller: undefined`. A row that predates the seam must read as "not recorded", and
  // backfilling 'direct' onto it would invent a provenance nobody observed.
  assert.equal('caller' in without, false)
})

test('the guardrail profile never leaks a caller id or a venue', () => {
  // The profile is the THIRD-PARTY product: bands only, nothing that identifies the owner's
  // position or strategy. A venue name is exactly that class of fact, so it must not reach
  // the band output even though it is now stored on every row.
  const intent = { kind: 'order' as const, notionalUsd: 10 }
  const decision = decisionFor(intent)
  const entries: AuditEntry[] = [1, 2, 3].map((i) =>
    buildAuditEntry({
      id: `aud_${i}`, ts: '2026-08-13T15:00:00Z', agentId: 'a', intent, decision,
      caller: { callerId: CRYPTO, venue: 'Robinhood Crypto', enforcement: 'process', intentSource: 'caller-adapter', snapshotSource: 'absent' },
    }),
  )
  const profile = guardrailProfile({ entries, policyConfigured: true, policyVersion: 2, now: new Date('2026-08-13T16:00:00Z') })
  const serialized = JSON.stringify(profile)
  for (const secret of [CRYPTO, 'Robinhood', 'robinhood', 'process', 'caller']) {
    assert.equal(
      serialized.toLowerCase().includes(secret.toLowerCase()),
      false,
      `guardrailProfile leaked "${secret}": the band product must not disclose who the counterparty trades with`,
    )
  }
})

// ── the registry ───────────────────────────────────────────────────────────────────

test('the public caller view drops the adapter and keeps the honest fields', () => {
  const view = publicCallers()
  assert.equal(view.length, CALLERS.length)
  for (const c of view) {
    assert.equal('adapter' in c, false, 'a function cannot be serialized to a public GET')
    assert.ok(['process', 'wrapper', 'none'].includes(c.enforcement))
    assert.ok(['live', 'beta', 'planned'].includes(c.status))
    assert.ok(c.note.length > 20, `${c.id} must say what it cannot do, not only what it can`)
  }
  assert.equal(view.find((c) => c.id === CRYPTO)?.normalizes, true)
  assert.equal(view.find((c) => c.id === 'robinhood-mcp-official')?.normalizes, false)
})

test('no caller claims a status stronger than its evidence', () => {
  for (const c of CALLERS) {
    // `live` would mean a call of ours reached the venue. None has, and a status field that
    // drifts optimistic is the thing every honest-status rule in this repo exists to stop.
    assert.notEqual(c.status, 'live', `${c.id} claims live; no caller has been exercised against a real account`)
    if (c.status !== 'planned') {
      assert.ok(c.adapter, `${c.id} is past 'planned' but carries no adapter`)
    }
  }
})

// ── the boundary ───────────────────────────────────────────────────────────────────

/** Compiled to dist/callers/, so mcp/src is two levels up. */
const SRC = fileURLToPath(new URL('../../src/', import.meta.url))

test('nothing under policy/ imports the caller seam', () => {
  // The mirror of policy/engine.test.ts, which fails if a venue name appears in policy/
  // code. Together they are the whole rule: translation lives here, decisions live there,
  // and neither direction of the dependency is allowed to close.
  const dir = SRC + 'policy/'
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
  assert.ok(files.length >= 4, 'expected the policy module sources to be readable')
  for (const f of files) {
    const text = readFileSync(dir + f, 'utf8')
    assert.equal(
      /from\s+'\.\.\/callers\//.test(text),
      false,
      `policy/${f} imports ../callers/: the decision core may never learn that venues exist`,
    )
  }
})

test('every venue string the decision path can see lives under callers/', () => {
  // The provenance work put a venue on every new audit row, which is exactly the moment a
  // venue string could drift inward. policy/engine.test.ts already forbids one in policy/
  // code; this asserts the same for the module that now WRITES the venue, so the guarantee
  // survives a refactor that moves code between the two.
  const guardrail = readFileSync(SRC + 'platform/guardrail.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
  assert.equal(
    /robinhood/i.test(guardrail),
    false,
    'platform/guardrail.ts names a venue in code: the decision path records provenance it is handed, it never authors one',
  )
  // And the strings really are here, so the rule above is a constraint rather than a
  // coincidence of nobody having written them yet.
  assert.ok(CALLERS.some((c) => /robinhood/i.test(c.venue)), 'the registry is the place venue names live')
})

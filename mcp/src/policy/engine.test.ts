import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { evaluateAction } from './engine.js'
import {
  applyPolicyPatch,
  defaultActionPolicy,
  resolveActionPolicy,
  sanitizeActionPolicy,
  sanitizeTradePolicy,
} from './policy.js'
import { SURFACES, getSurface, liveSurfaces } from './registry.js'
import type { AccountSnapshot, ActionPolicy, NormalizedIntent } from './types.js'

// Deterministic vectors only. No mock account data enters the product: these fixtures
// exist solely to pin the pure decision function, and at runtime the snapshot always
// comes from a real caller (see ./README.md, "Red lines").

const AT = new Date('2026-07-29T15:00:00Z') // inside a 13:30-20:00 UTC window

function policy(over: Partial<ActionPolicy> = {}): ActionPolicy {
  const base = defaultActionPolicy('pol_test', '2026-07-29T00:00:00Z')
  return { ...base, ...over, trade: { ...base.trade, ...(over.trade ?? {}) } }
}

function snap(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    todayNotionalUsd: 0,
    positions: [],
    portfolioValueUsd: 10_000,
    buyingPowerUsd: 5_000,
    cashAvailableUsd: 5_000,
    marginUsedUsd: 0,
    accountType: 'cash',
    ...over,
  }
}

const buy = (over: Partial<NormalizedIntent> = {}): NormalizedIntent => ({
  kind: 'order',
  side: 'buy',
  symbol: 'AAPL',
  assetClass: 'equity',
  notionalUsd: 50,
  ...over,
})

const decide = (i: { policy?: ActionPolicy; intent?: NormalizedIntent; snapshot?: AccountSnapshot | undefined; surface?: string } = {}) =>
  evaluateAction({
    surface: i.surface ?? 'trade',
    policy: i.policy ?? policy(),
    intent: i.intent ?? buy(),
    snapshot: 'snapshot' in i ? i.snapshot : snap(),
    now: AT,
  })

// ── the happy path ───────────────────────────────────────────────────────────────

test('an in-policy buy is ALLOWed with no reasons', () => {
  const d = decide()
  assert.equal(d.verdict, 'ALLOW')
  assert.deepEqual(d.reasons, [])
  assert.deepEqual(d.codes, [])
  assert.equal(d.unverifiable, false)
  assert.equal(d.policyId, 'pol_test')
  assert.equal(d.policyVersion, 1)
})

test('the same inputs always produce the same decision', () => {
  assert.deepEqual(decide(), decide())
})

// ── caps ─────────────────────────────────────────────────────────────────────────

test('over the per-action cap is DENYed', () => {
  const d = decide({ intent: buy({ notionalUsd: 250 }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('PER_ACTION_CAP'))
})

test('structuring is caught by the daily cap, not the per-action cap', () => {
  // Each slice is under the $100 per-action cap, but today is already at $480 of $500.
  const d = decide({ intent: buy({ notionalUsd: 50 }), snapshot: snap({ todayNotionalUsd: 480 }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('DAILY_CAP'))
  assert.ok(!d.codes.includes('PER_ACTION_CAP'))
})

test('at the human-approval line the action WARNs rather than being refused', () => {
  const d = decide({ policy: policy({ perActionCapUsd: 1000, dailyCapUsd: 1000 }), intent: buy({ notionalUsd: 100 }) })
  assert.equal(d.verdict, 'WARN')
  assert.deepEqual(d.codes, ['HUMAN_APPROVAL'])
})

test('frozen stops everything', () => {
  const d = decide({ policy: policy({ frozen: true }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('FROZEN'))
})

// ── symbols and options ──────────────────────────────────────────────────────────

test('a denied symbol is refused, case-insensitively', () => {
  const d = decide({ policy: policy({ trade: { ...policy().trade, denySymbols: ['aapl'] } }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('SYMBOL_DENIED'))
})

test('an empty allow list means no allow-list restriction', () => {
  assert.equal(decide().verdict, 'ALLOW')
})

test('a non-empty allow list refuses everything outside it', () => {
  const p = policy({ trade: { ...policy().trade, allowSymbols: ['MSFT'] } })
  assert.ok(decide({ policy: p }).codes.includes('SYMBOL_NOT_ALLOWED'))
  assert.equal(decide({ policy: p, intent: buy({ symbol: 'MSFT' }) }).verdict, 'ALLOW')
})

test('a ticker allow list does not block actions that have no security', () => {
  // Setting "only trade AAPL" must not also block transfers, settings changes and document
  // pulls. It used to DENY all three with "this action carries no symbol", which replaced a
  // transfer's human-approval WARN with a confusing refusal.
  const p = policy({ trade: { ...policy().trade, allowSymbols: ['AAPL'] } })
  const transfer = decide({ policy: p, intent: { kind: 'transfer', notionalUsd: 20 } })
  assert.equal(transfer.verdict, 'WARN', 'a transfer must still reach the human')
  assert.ok(transfer.codes.includes('TRANSFER'))
  assert.equal(transfer.codes.includes('SYMBOL_UNKNOWN'), false)

  for (const intent of [
    { kind: 'settings', notionalUsd: 0, settingKey: 'pdt', settingValue: true },
    { kind: 'document', notionalUsd: 0 },
  ] as const) {
    const d = decide({ policy: p, intent })
    assert.equal(d.codes.includes('SYMBOL_UNKNOWN'), false, intent.kind)
  }
})

test('a ticker deny list does not block a non-security action either', () => {
  const p = policy({ trade: { ...policy().trade, denySymbols: ['GME'] } })
  const d = decide({ policy: p, intent: { kind: 'transfer', notionalUsd: 5 } })
  assert.equal(d.codes.includes('SYMBOL_DENIED'), false)
})

test('a symbol-bearing action with no symbol still fails closed under an allow list', () => {
  // For an order the missing ticker IS the thing the rule needed, so DENY is correct.
  const p = policy({ trade: { ...policy().trade, allowSymbols: ['AAPL'] } })
  for (const kind of ['order', 'cancel', 'recurring'] as const) {
    const d = decide({ policy: p, intent: { kind, side: 'buy', notionalUsd: 10 } })
    assert.ok(d.codes.includes('SYMBOL_UNKNOWN'), kind)
    assert.equal(d.verdict, 'DENY', kind)
  }
})

test('an allow list of only junk restricts everything, it does not switch off', () => {
  // "I set an allow list" must never silently become "there is no allow list". The
  // sanitizer strips junk before storage, but the engine must not depend on that having run.
  const p = policy({ trade: { ...policy().trade, allowSymbols: ['   ', ''] } })
  const d = decide({ policy: p })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('SYMBOL_NOT_ALLOWED'))
})

test('the deny list wins over the allow list', () => {
  const p = policy({ trade: { ...policy().trade, allowSymbols: ['AAPL'], denySymbols: ['AAPL'] } })
  assert.ok(decide({ policy: p }).codes.includes('SYMBOL_DENIED'))
})

test('options are off by default and on only when enabled', () => {
  const opt = buy({ assetClass: 'option' })
  assert.ok(decide({ intent: opt }).codes.includes('OPTIONS_BLOCKED'))
  const p = policy({ trade: { ...policy().trade, allowOptions: true } })
  assert.equal(decide({ policy: p, intent: opt }).verdict, 'ALLOW')
})

// ── margin: the rule that must not be satisfied by buying power alone ─────────────

test('a buy beyond settled cash is DENYed as margin, even when inside buying power', () => {
  // Buying power says $5,000 but only $10 is settled cash: on a margin account the
  // difference is borrowed, which the no-margin policy forbids.
  const d = decide({ intent: buy({ notionalUsd: 90 }), snapshot: snap({ cashAvailableUsd: 10, buyingPowerUsd: 5_000 }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('MARGIN_REQUIRED'))
})

test('unknown settled cash fails closed instead of trusting buying power', () => {
  const s = snap()
  delete s.cashAvailableUsd
  const d = decide({ snapshot: s })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('MARGIN_UNVERIFIABLE'))
  assert.equal(d.unverifiable, true)
})

test('margin already drawn blocks further buys', () => {
  const d = decide({ snapshot: snap({ marginUsedUsd: 1 }) })
  assert.ok(d.codes.includes('MARGIN_IN_USE'))
})

test('a sell is not subject to the margin rule', () => {
  const s = snap()
  delete s.cashAvailableUsd
  const d = decide({ intent: buy({ side: 'sell' }), snapshot: s })
  assert.equal(d.verdict, 'ALLOW')
})

// ── missing snapshot fails closed ────────────────────────────────────────────────

test('no snapshot at all is DENYed, not waved through', () => {
  const d = decide({ snapshot: undefined })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('DAILY_CAP_UNVERIFIABLE'))
  assert.equal(d.unverifiable, true)
})

// ── clock window ─────────────────────────────────────────────────────────────────

test('inside the trading window is fine, outside is DENYed', () => {
  const p = policy({ trade: { ...policy().trade, tradingHoursUtc: { start: '13:30', end: '20:00' } } })
  assert.equal(evaluateAction({ surface: 'trade', policy: p, intent: buy(), snapshot: snap(), now: AT }).verdict, 'ALLOW')
  const late = new Date('2026-07-29T21:00:00Z')
  const d = evaluateAction({ surface: 'trade', policy: p, intent: buy(), snapshot: snap(), now: late })
  assert.ok(d.codes.includes('OUTSIDE_HOURS'))
})

test('a window that wraps past midnight is handled', () => {
  const p = policy({ trade: { ...policy().trade, tradingHoursUtc: { start: '22:00', end: '02:00' } } })
  const inside = new Date('2026-07-29T23:30:00Z')
  const outside = new Date('2026-07-29T12:00:00Z')
  assert.equal(evaluateAction({ surface: 'trade', policy: p, intent: buy(), snapshot: snap(), now: inside }).verdict, 'ALLOW')
  assert.ok(evaluateAction({ surface: 'trade', policy: p, intent: buy(), snapshot: snap(), now: outside }).codes.includes('OUTSIDE_HOURS'))
})

// ── concentration ────────────────────────────────────────────────────────────────

test('a buy that pushes one symbol past the concentration limit is DENYed', () => {
  const p = policy({ trade: { ...policy().trade, maxConcentrationPct: 20 } })
  const s = snap({ positions: [{ symbol: 'AAPL', valueUsd: 2_000 }], portfolioValueUsd: 10_000 })
  const d = decide({ policy: p, intent: buy({ notionalUsd: 100 }), snapshot: s })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('CONCENTRATION'))
})

test('a sell is never blocked by concentration, since it reduces it', () => {
  const p = policy({ trade: { ...policy().trade, maxConcentrationPct: 1 } })
  const s = snap({ positions: [{ symbol: 'AAPL', valueUsd: 9_000 }], portfolioValueUsd: 10_000 })
  assert.equal(decide({ policy: p, intent: buy({ side: 'sell' }), snapshot: s }).verdict, 'ALLOW')
})

test('unknown portfolio value fails closed when a concentration limit is set', () => {
  const p = policy({ trade: { ...policy().trade, maxConcentrationPct: 20 } })
  const s = snap()
  delete s.portfolioValueUsd
  assert.ok(decide({ policy: p, snapshot: s }).codes.includes('CONCENTRATION_UNVERIFIABLE'))
})

// ── the non-order paths a cap-only policy would miss ──────────────────────────────

test('a recurring order warns that one approval authorizes many executions', () => {
  const d = decide({ intent: { kind: 'recurring', notionalUsd: 25, symbol: 'AAPL', side: 'buy', cadence: 'weekly' } })
  assert.equal(d.verdict, 'WARN')
  assert.ok(d.codes.includes('STANDING_AUTHORITY'))
})

test('a recurring order still has to clear the caps', () => {
  const d = decide({ intent: { kind: 'recurring', notionalUsd: 5_000, symbol: 'AAPL', side: 'buy' } })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('PER_ACTION_CAP'))
})

test('enabling margin or lending through settings is refused outright', () => {
  for (const key of ['margin', 'stock_lending']) {
    const d = decide({ intent: { kind: 'settings', notionalUsd: 0, settingKey: key, settingValue: true } })
    assert.equal(d.verdict, 'DENY', key)
    assert.ok(d.codes.includes('SETTING_FORBIDDEN'), key)
  }
})

test('another risk-raising setting warns', () => {
  const d = decide({ intent: { kind: 'settings', notionalUsd: 0, settingKey: 'pdt', settingValue: true } })
  assert.equal(d.verdict, 'WARN')
  assert.ok(d.codes.includes('SETTING_RISK'))
})

test('a transfer always needs a human, even for a small amount', () => {
  const d = decide({ intent: { kind: 'transfer', notionalUsd: 1 } })
  assert.equal(d.verdict, 'WARN')
  assert.ok(d.codes.includes('TRANSFER'))
})

test('a document pull is treated as data egress', () => {
  const d = decide({ intent: { kind: 'document', notionalUsd: 0, label: '1099' } })
  assert.equal(d.verdict, 'WARN')
  assert.ok(d.codes.includes('DOCUMENT_EGRESS'))
})

test('cancelling a protective leg warns', () => {
  const d = decide({ intent: { kind: 'cancel', notionalUsd: 0, symbol: 'AAPL', protective: true } })
  assert.equal(d.verdict, 'WARN')
  assert.ok(d.codes.includes('PROTECTIVE_CANCEL'))
})

// ── every violation is reported at once ──────────────────────────────────────────

test('all findings come back together, not one refusal at a time', () => {
  const p = policy({ trade: { ...policy().trade, denySymbols: ['AAPL'], allowOptions: false } })
  const d = decide({ policy: p, intent: buy({ notionalUsd: 250, assetClass: 'option' }) })
  assert.equal(d.verdict, 'DENY')
  for (const code of ['PER_ACTION_CAP', 'HUMAN_APPROVAL', 'SYMBOL_DENIED', 'OPTIONS_BLOCKED']) {
    assert.ok(d.codes.includes(code), `missing ${code}`)
  }
  assert.equal(d.reasons.length, d.codes.length)
})

test('DENY beats WARN', () => {
  const d = decide({ intent: buy({ notionalUsd: 250 }) }) // over cap AND over the approval line
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('HUMAN_APPROVAL'))
})

// ── malformed input and surface gating ───────────────────────────────────────────

test('a malformed amount is refused, not guessed at', () => {
  for (const bad of [NaN, Infinity, -1]) {
    const d = decide({ intent: buy({ notionalUsd: bad }) })
    assert.equal(d.verdict, 'DENY', String(bad))
    assert.ok(d.codes.includes('INTENT_MALFORMED'), String(bad))
  }
})

test('an unknown surface is refused', () => {
  assert.ok(decide({ surface: 'casino' }).codes.includes('UNKNOWN_SURFACE'))
})

test('a planned surface can never authorize an action', () => {
  // `bet` is the only planned surface now that spend is live. Phase 7 is schema only by
  // design, so this must keep holding for it.
  const d = decide({ surface: 'bet' })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('SURFACE_NOT_LIVE'))
})

test('a transfer cannot be smuggled through the bet surface', () => {
  // Gated by status first; the kind allowlist is the second gate once bet goes live.
  assert.equal(getSurface('bet')?.kinds.includes('transfer'), false)
})

test('trade and spend are live, bet is not', () => {
  assert.deepEqual(liveSurfaces().map((s) => s.id), ['trade', 'spend'])
  assert.equal(SURFACES.length, 3)
  assert.equal(getSurface('bet')?.status, 'planned')
})

// ── the sanitizer (Phase 1.1 clamps) ─────────────────────────────────────────────

test('caps are clamped into range, and junk is dropped', () => {
  const clean = sanitizeActionPolicy({
    perActionCapUsd: 1e308,
    dailyCapUsd: -5,
    humanApprovalAboveUsd: NaN,
    frozen: 'yes',
  })
  assert.equal(clean.perActionCapUsd, 1_000_000)
  assert.equal(clean.dailyCapUsd, 0)
  assert.equal(clean.humanApprovalAboveUsd, undefined)
  assert.equal(clean.frozen, true)
})

test('margin can never be enabled through a patch', () => {
  const patched = applyPolicyPatch(policy(), { trade: { allowMargin: true, allowOptions: true } }, '2026-07-30T00:00:00Z')
  assert.equal(patched.trade.allowMargin, false)
  assert.equal(patched.trade.allowOptions, true)
  assert.equal(patched.version, 2)
})

test('symbol lists are normalized and bounded; junk and over-long symbols are dropped', () => {
  // An over-long symbol is DROPPED, never truncated: truncating would silently change
  // which security the user allowed, which is worse than ignoring the entry.
  const clean = sanitizeTradePolicy({ allowSymbols: [' aapl ', 'MSFT', 42, '', 'X'.repeat(50)] })
  assert.deepEqual(clean.allowSymbols, ['AAPL', 'MSFT'])
})

test('a symbol list is capped in length so a patch cannot blow up the policy', () => {
  const many = Array.from({ length: 500 }, (_, i) => `S${i}`)
  assert.equal(sanitizeTradePolicy({ allowSymbols: many }).allowSymbols?.length, 100)
})

test('a half-specified trading window is dropped, not half-applied', () => {
  assert.equal(sanitizeTradePolicy({ tradingHoursUtc: { start: '13:30' } }).tradingHoursUtc, undefined)
  assert.equal(sanitizeTradePolicy({ tradingHoursUtc: { start: '99:99', end: '20:00' } }).tradingHoursUtc, undefined)
  assert.deepEqual(sanitizeTradePolicy({ tradingHoursUtc: { start: '13:30', end: '20:00' } }).tradingHoursUtc, {
    start: '13:30',
    end: '20:00',
  })
  assert.equal(sanitizeTradePolicy({ tradingHoursUtc: null }).tradingHoursUtc, null)
})

test('concentration percent is clamped to 0-100', () => {
  assert.equal(sanitizeTradePolicy({ maxConcentrationPct: 5000 }).maxConcentrationPct, 100)
  assert.equal(sanitizeTradePolicy({ maxConcentrationPct: -1 }).maxConcentrationPct, 0)
})

// ── the store resolver (Phase 1.3): whatever is in storage must come back safe ─────

const NOW = '2026-07-29T12:00:00Z'

test('an unconfigured agent resolves to the safe defaults, flagged unconfigured', () => {
  for (const stored of [undefined, null, 'nonsense', 42]) {
    const r = resolveActionPolicy(stored, 'pol_new', NOW)
    assert.equal(r.configured, false, String(stored))
    assert.equal(r.policy.policyId, 'pol_new')
    assert.equal(r.policy.version, 1)
    assert.equal(r.policy.trade.allowOptions, false)
    assert.equal(r.policy.trade.allowMargin, false)
  }
})

test('an unconfigured policy still DENYs an out-of-policy action', () => {
  // The point of defaulting rather than erroring: a client can render the starting point,
  // but the engine is never handed a permissive policy.
  const { policy: p } = resolveActionPolicy(undefined, 'pol_new', NOW)
  const d = evaluateAction({ surface: 'trade', policy: p, intent: buy({ notionalUsd: 5_000 }), snapshot: snap(), now: AT })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('PER_ACTION_CAP'))
})

test('a stored policy missing the trade block comes back with safe defaults, not undefined', () => {
  const r = resolveActionPolicy({ policyId: 'pol_old', version: 3, updatedAt: NOW, dailyCapUsd: 250 }, 'pol_fb', NOW)
  assert.equal(r.configured, true)
  assert.equal(r.policy.policyId, 'pol_old')
  assert.equal(r.policy.version, 3)
  assert.equal(r.policy.dailyCapUsd, 250)
  assert.equal(r.policy.trade.allowMargin, false)
  assert.deepEqual(r.policy.trade.allowSymbols, [])
  assert.equal(r.policy.trade.maxConcentrationPct, 100)
})

test('a stored policy with margin flipped on in the database is neutralized on read', () => {
  // Persisted state is JSON that a previous build or a hand edit could have written.
  const r = resolveActionPolicy(
    { policyId: 'pol_x', version: 2, updatedAt: NOW, trade: { allowMargin: true, allowOptions: true } },
    'pol_fb',
    NOW,
  )
  assert.equal(r.policy.trade.allowMargin, false)
  assert.equal(r.policy.trade.allowOptions, true)
})

test('a stored policy with junk caps is clamped, not trusted', () => {
  const r = resolveActionPolicy({ policyId: 'p', version: 1, updatedAt: NOW, perActionCapUsd: 1e309, dailyCapUsd: -3 }, 'pol_fb', NOW)
  assert.equal(r.policy.perActionCapUsd, 100) // 1e309 is Infinity, so the field is dropped and the default stands
  assert.equal(r.policy.dailyCapUsd, 0)
})

test('a bogus stored version cannot go backwards or fractional', () => {
  for (const [stored, expected] of [[0, 1], [-5, 1], [2.7, 2], ['x', 1]] as const) {
    const r = resolveActionPolicy({ policyId: 'p', version: stored, updatedAt: NOW }, 'pol_fb', NOW)
    assert.equal(r.policy.version, expected, String(stored))
  }
})

test('resolve then patch bumps the version by exactly one', () => {
  const { policy: first } = resolveActionPolicy(undefined, 'pol_1', NOW)
  const second = applyPolicyPatch(first, { dailyCapUsd: 300 }, '2026-07-30T00:00:00Z')
  const third = applyPolicyPatch(second, { dailyCapUsd: 400 }, '2026-07-31T00:00:00Z')
  assert.deepEqual([first.version, second.version, third.version], [1, 2, 3])
  assert.equal(third.policyId, 'pol_1', 'the policy id is stable across edits')
  assert.equal(third.updatedAt, '2026-07-31T00:00:00Z')
})

test('a round trip through storage is stable', () => {
  const { policy: p } = resolveActionPolicy(undefined, 'pol_rt', NOW)
  const edited = applyPolicyPatch(p, { trade: { allowSymbols: ['aapl'], allowOptions: true }, dailyCapUsd: 300 }, NOW)
  // JSON is exactly what Postgres and the file store hold.
  const reread = resolveActionPolicy(JSON.parse(JSON.stringify(edited)), 'pol_other', NOW)
  assert.deepEqual(reread.policy, edited)
  assert.equal(reread.configured, true)
})

// ── the caller-agnostic invariant, enforced rather than documented ────────────────

test('no file in the policy module is caller-specific', () => {
  // ./README.md ("The rule that keeps this module a core") decided the engine carries zero dependency on
  // any particular brokerage, official or unofficial. That is the whole reason we can
  // proceed while the public skill release is on hold, so it is checked, not trusted.
  // Compiled to dist/policy/, so the sources are two levels up.
  const srcDir = fileURLToPath(new URL('../../src/policy/', import.meta.url))
  // Production sources only. Test files legitimately name callers (this one holds the
  // very pattern being searched for), and the invariant is about what ships.
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  assert.ok(files.length >= 4, 'expected the policy module sources to be readable')

  for (const f of files) {
    const text = readFileSync(srcDir + f, 'utf8')
    const imports = text.match(/^\s*import[\s\S]*?from\s+'[^']+'/gm) ?? []
    for (const line of imports) {
      const from = /from\s+'([^']+)'/.exec(line)?.[1] ?? ''
      assert.ok(
        from.startsWith('./') || from.startsWith('node:'),
        `${f} imports "${from}": the policy module may only import itself and node builtins`,
      )
    }
    // Prose may name a caller (the docs do), but code must not branch on one. Check the
    // non-comment body only, so the explanatory comments above stay allowed.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    assert.equal(/robinhood/i.test(code), false, `${f} mentions a specific caller in code`)
  }
})

test('the default policy is safe before the user configures anything', () => {
  const p = defaultActionPolicy('pol_x', '2026-07-29T00:00:00Z')
  assert.equal(p.trade.allowOptions, false)
  assert.equal(p.trade.allowMargin, false)
  assert.equal(p.humanApprovalAboveUsd, 100)
  assert.ok(p.perActionCapUsd <= 100)
  assert.equal(p.frozen, false)
})

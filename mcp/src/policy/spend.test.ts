import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAction } from './engine.js'
import { DEFAULT_SPEND_POLICY, defaultActionPolicy, sanitizeSpendPolicy, applyPolicyPatch } from './policy.js'
import { HIGH_RISK_CATEGORIES, KNOWN_MCC_COUNT, isKnownMcc, resolveCategory } from './mcc.js'
import { getSurface } from './registry.js'
import type { AccountSnapshot, ActionPolicy, NormalizedIntent } from './types.js'

// The card surface (Phase 4). Deterministic vectors only: no card, no network, no invented
// transactions. The point of these is that the surface adds what the VENUE does not already
// give you, so most of them are about merchants, categories and per-card ceilings rather
// than about a single spending limit.

const AT = new Date('2026-07-29T15:00:00Z')

function policy(over: Partial<ActionPolicy> = {}): ActionPolicy {
  const base = defaultActionPolicy('pol_spend', '2026-07-29T00:00:00Z')
  return {
    ...base,
    ...over,
    spend: { ...(base.spend ?? DEFAULT_SPEND_POLICY), ...(over.spend ?? {}) },
  }
}

function snap(over: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    todayNotionalUsd: 0,
    positions: [],
    cardSpentTodayUsd: { card_agent_1: 0 },
    categorySpentTodayUsd: { groceries: 0, restaurants: 0, uncategorized: 0 },
    ...over,
  }
}

const buy = (over: Partial<NormalizedIntent> = {}): NormalizedIntent => ({
  kind: 'purchase',
  notionalUsd: 40,
  merchant: 'Whole Foods Market',
  mcc: '5411',
  cardId: 'card_agent_1',
  ...over,
})

const decide = (i: { policy?: ActionPolicy; intent?: NormalizedIntent; snapshot?: AccountSnapshot } = {}) =>
  evaluateAction({
    surface: 'spend',
    policy: i.policy ?? policy(),
    intent: i.intent ?? buy(),
    snapshot: 'snapshot' in i ? i.snapshot : snap(),
    now: AT,
  })

// ── the surface is live and accepts the right kinds ───────────────────────────────

test('the spend surface is live and takes card kinds, not trading kinds', () => {
  const s = getSurface('spend')
  assert.equal(s?.status, 'live')
  assert.deepEqual(s?.kinds, ['purchase', 'recurring', 'transfer'])
  // An equity order must not be smuggled through the card surface.
  const d = decide({ intent: { kind: 'order', notionalUsd: 10, symbol: 'AAPL' } })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('KIND_NOT_ON_SURFACE'))
})

test('an in-policy purchase is ALLOWed', () => {
  const d = decide()
  assert.equal(d.verdict, 'ALLOW')
  assert.deepEqual(d.reasons, [])
})

// ── the shared caps still apply ───────────────────────────────────────────────────

test('the per-action and daily caps apply to a card purchase too', () => {
  assert.ok(decide({ intent: buy({ notionalUsd: 500 }) }).codes.includes('PER_ACTION_CAP'))
  const d = decide({ intent: buy({ notionalUsd: 90 }), snapshot: snap({ todayNotionalUsd: 480 }) })
  assert.ok(d.codes.includes('DAILY_CAP'))
})

test('the approval line makes a purchase wait for a human rather than refusing it', () => {
  const p = policy({ perActionCapUsd: 1000, dailyCapUsd: 2000, humanApprovalAboveUsd: 100 })
  const d = decide({ policy: p, intent: buy({ notionalUsd: 250 }) })
  assert.equal(d.verdict, 'WARN')
  assert.deepEqual(d.codes, ['HUMAN_APPROVAL'])
})

// ── merchants: substring matching, because venue names are messy ───────────────────

test('a denied merchant is refused, and matching is a case-insensitive substring', () => {
  // Venues report "AMZN Mktp US*2H4B1", never a clean "Amazon", so exact matching would
  // silently fail to match the thing the user typed.
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, merchantDeny: ['amzn'] } })
  const d = decide({ policy: p, intent: buy({ merchant: 'AMZN Mktp US*2H4B1', mcc: '5999' }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('MERCHANT_DENIED'))
})

test('an empty merchant allow list means no restriction', () => {
  assert.equal(decide().verdict, 'ALLOW')
})

test('a non-empty merchant allow list refuses everything outside it', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, merchantAllow: ['whole foods', 'uber'] } })
  assert.equal(decide({ policy: p }).verdict, 'ALLOW')
  const d = decide({ policy: p, intent: buy({ merchant: 'Steam Games', mcc: '5734' }) })
  assert.ok(d.codes.includes('MERCHANT_NOT_ALLOWED'))
})

test('the merchant deny list wins over the allow list', () => {
  const p = policy({
    spend: { ...DEFAULT_SPEND_POLICY, merchantAllow: ['whole foods'], merchantDeny: ['whole foods'] },
  })
  assert.ok(decide({ policy: p }).codes.includes('MERCHANT_DENIED'))
})

test('under an allow list, a purchase naming no merchant fails closed', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, merchantAllow: ['whole foods'] } })
  const d = decide({ policy: p, intent: buy({ merchant: undefined }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('MERCHANT_UNKNOWN'))
})

test('a blank or whitespace allow-list entry does not match everything', () => {
  // A stray empty string in the list must not turn the allow list into a pass-all.
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, merchantAllow: ['   '] } })
  const d = decide({ policy: p, intent: buy({ merchant: 'Anything At All' }) })
  assert.ok(d.codes.includes('MERCHANT_NOT_ALLOWED'))
})

// ── the default deny set ──────────────────────────────────────────────────────────

test('cash advance, quasi-cash and gambling are refused out of the box', () => {
  // These are denied by DEFAULT, without the user configuring anything: on a card an agent
  // drives, they turn a spending mistake into one that cannot be clawed back.
  for (const [mcc, what] of [
    ['6011', 'ATM cash'],
    ['6010', 'manual cash'],
    ['6051', 'quasi-cash / crypto'],
    ['7995', 'gambling'],
  ] as const) {
    const d = decide({ intent: buy({ mcc, merchant: 'Somewhere', notionalUsd: 20 }) })
    assert.equal(d.verdict, 'DENY', what)
    assert.ok(d.codes.includes('CATEGORY_DENIED'), what)
  }
})

test('the default deny set is exactly the three high-risk categories', () => {
  assert.deepEqual(DEFAULT_SPEND_POLICY.categoryDeny, [...HIGH_RISK_CATEGORIES])
  assert.deepEqual([...HIGH_RISK_CATEGORIES], ['cash_advance', 'quasi_cash', 'gambling'])
})

test('emptying the deny list is possible, and is the users own decision', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, categoryDeny: [] } })
  const d = decide({ policy: p, intent: buy({ mcc: '7995', merchant: 'Casino' }) })
  assert.equal(d.verdict, 'ALLOW')
})

// ── category limits ───────────────────────────────────────────────────────────────

test('a category limit counts todays spend in that category', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, categoryLimits: { groceries: 50 } } })
  assert.equal(decide({ policy: p, intent: buy({ notionalUsd: 40 }) }).verdict, 'ALLOW')
  const d = decide({
    policy: p,
    intent: buy({ notionalUsd: 40 }),
    snapshot: snap({ categorySpentTodayUsd: { groceries: 30 } }),
  })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('CATEGORY_LIMIT'))
})

test('an unknown category spend still counts against an uncategorized limit', () => {
  // The unknown case must be limitable, not exempt.
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, categoryLimits: { uncategorized: 10 } } })
  const d = decide({ policy: p, intent: buy({ mcc: '9999', merchant: 'Mystery', notionalUsd: 40 }) })
  assert.ok(d.codes.includes('CATEGORY_LIMIT'))
})

test('a category limit with unknown spend-so-far fails closed', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, categoryLimits: { groceries: 50 } } })
  const d = decide({ policy: p, snapshot: snap({ categorySpentTodayUsd: {} }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('CATEGORY_UNVERIFIABLE'))
  assert.equal(d.unverifiable, true)
})

test('a reason says plainly when the category came from the caller, not from a known MCC', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, categoryLimits: { pet_supplies: 10 } } })
  const d = decide({
    policy: p,
    intent: buy({ mcc: undefined, label: 'Pet Supplies', notionalUsd: 40 }),
    snapshot: snap({ categorySpentTodayUsd: { pet_supplies: 0 } }),
  })
  assert.ok(d.codes.includes('CATEGORY_LIMIT'))
  assert.ok(d.reasons.some((r) => r.includes('not from a recognized MCC')))
})

// ── per-card ceilings ─────────────────────────────────────────────────────────────

test('a per-card ceiling counts todays spend on that card', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, cardCaps: { card_agent_1: 60 } } })
  assert.equal(decide({ policy: p }).verdict, 'ALLOW')
  const d = decide({ policy: p, snapshot: snap({ cardSpentTodayUsd: { card_agent_1: 50 } }) })
  assert.equal(d.verdict, 'DENY')
  assert.ok(d.codes.includes('CARD_CAP'))
})

test('a ceiling on one card does not restrict another', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, cardCaps: { card_other: 1 } } })
  assert.equal(decide({ policy: p }).verdict, 'ALLOW')
})

test('a per-card ceiling with unknown spend-so-far fails closed', () => {
  const p = policy({ spend: { ...DEFAULT_SPEND_POLICY, cardCaps: { card_agent_1: 60 } } })
  const d = decide({ policy: p, snapshot: snap({ cardSpentTodayUsd: {} }) })
  assert.ok(d.codes.includes('CARD_CAP_UNVERIFIABLE'))
  assert.equal(d.unverifiable, true)
})

// ── non-purchase kinds on the card surface ────────────────────────────────────────

test('a subscription warns that one approval authorizes every future charge', () => {
  const d = decide({
    intent: { kind: 'recurring', notionalUsd: 12, merchant: 'Netflix', mcc: '5968', cardId: 'card_agent_1', cadence: 'monthly' },
  })
  assert.equal(d.verdict, 'WARN')
  assert.ok(d.codes.includes('STANDING_AUTHORITY'))
})

test('money moved off the card always needs a human', () => {
  const d = decide({ intent: { kind: 'transfer', notionalUsd: 1, cardId: 'card_agent_1' } })
  assert.equal(d.verdict, 'WARN')
  assert.ok(d.codes.includes('TRANSFER'))
})

test('a frozen policy stops card spending too', () => {
  assert.ok(decide({ policy: policy({ frozen: true }) }).codes.includes('FROZEN'))
})

// ── every violation at once ───────────────────────────────────────────────────────

test('all findings come back together', () => {
  const p = policy({
    spend: { ...DEFAULT_SPEND_POLICY, merchantDeny: ['casino'], categoryLimits: { gambling: 5 } },
  })
  const d = decide({
    policy: p,
    intent: buy({ merchant: 'Casino Royale', mcc: '7995', notionalUsd: 400 }),
    snapshot: snap({ categorySpentTodayUsd: { gambling: 0 } }),
  })
  assert.equal(d.verdict, 'DENY')
  for (const code of ['PER_ACTION_CAP', 'MERCHANT_DENIED', 'CATEGORY_DENIED', 'CATEGORY_LIMIT']) {
    assert.ok(d.codes.includes(code), `missing ${code}`)
  }
})

// ── the receipt ───────────────────────────────────────────────────────────────────

test('a card purchase is recorded with the merchant, the code and the card', async () => {
  // The audit entry is the receipt. Without these three the row would say "a purchase for
  // $40" and nothing about where the money went, which is most of the point.
  const { buildAuditEntry } = await import('./audit.js')
  const intent = buy({ notionalUsd: 40 })
  const decision = evaluateAction({ surface: 'spend', policy: policy(), intent, snapshot: snap(), now: AT })
  const e = buildAuditEntry({ id: 'aud_1', ts: AT.toISOString(), agentId: 'a', intent, snapshot: snap(), decision })
  assert.equal(e.intent.merchant, 'Whole Foods Market')
  assert.equal(e.intent.mcc, '5411')
  assert.equal(e.intent.cardId, 'card_agent_1')
  assert.equal(e.intent.kind, 'purchase')
})

test('recorded merchant and card strings are bounded', async () => {
  const { buildAuditEntry } = await import('./audit.js')
  const intent = buy({ merchant: 'm'.repeat(300), cardId: 'c'.repeat(300), mcc: '9'.repeat(50) })
  const decision = evaluateAction({ surface: 'spend', policy: policy(), intent, snapshot: snap(), now: AT })
  const e = buildAuditEntry({ id: 'aud_2', ts: AT.toISOString(), agentId: 'a', intent, snapshot: snap(), decision })
  assert.equal(e.intent.merchant?.length, 60)
  assert.equal(e.intent.cardId?.length, 60)
  assert.equal(e.intent.mcc?.length, 8)
})

// ── the MCC map is small on purpose ───────────────────────────────────────────────

test('the MCC map covers only codes we are confident about', () => {
  // A confidently wrong category would apply the wrong limit to a real purchase, so this
  // map is deliberately tiny and the test pins that intent.
  assert.ok(KNOWN_MCC_COUNT < 30, `MCC map grew to ${KNOWN_MCC_COUNT}; each addition needs to be verifiable`)
  assert.equal(resolveCategory('5411'), 'groceries')
  assert.equal(resolveCategory('7995'), 'gambling')
  assert.equal(isKnownMcc('5411'), true)
  assert.equal(isKnownMcc('9999'), false)
})

test('an unrecognized MCC falls back to the caller label, then to uncategorized', () => {
  assert.equal(resolveCategory('9999', 'Pet Supplies'), 'pet_supplies')
  assert.equal(resolveCategory(undefined, undefined), 'uncategorized')
  assert.equal(resolveCategory('', ''), 'uncategorized')
})

test('a known MCC wins over a caller-supplied label', () => {
  // The MCC comes from the card network; the label comes from whoever typed it.
  assert.equal(resolveCategory('7995', 'Groceries'), 'gambling')
})

// ── the sanitizer ─────────────────────────────────────────────────────────────────

test('spend patches are clamped and normalized', () => {
  const clean = sanitizeSpendPolicy({
    merchantAllow: ['  Whole Foods  ', 42, '', 'x'.repeat(200)],
    categoryDeny: ['Cash Advance', 'GAMBLING'],
    categoryLimits: { Groceries: 1e308, restaurants: -5, '': 10 },
    cardCaps: { card_1: 250.5, card_2: 'nope' },
  })
  assert.deepEqual(clean.merchantAllow, ['Whole Foods'], 'trimmed, junk and over-long dropped')
  assert.deepEqual(clean.categoryDeny, ['cash_advance', 'gambling'], 'normalized to policy keys')
  assert.deepEqual(clean.categoryLimits, { groceries: 1_000_000, restaurants: 0 }, 'clamped, blank key dropped')
  assert.deepEqual(clean.cardCaps, { card_1: 250.5 })
})

test('a stored policy missing the spend block comes back with safe defaults', () => {
  const patched = applyPolicyPatch(
    { ...defaultActionPolicy('p', '2026-07-29T00:00:00Z'), spend: undefined },
    { spend: { merchantDeny: ['casino'] } },
    '2026-07-30T00:00:00Z',
  )
  assert.deepEqual(patched.spend?.categoryDeny, [...HIGH_RISK_CATEGORIES], 'the default deny set survives')
  assert.deepEqual(patched.spend?.merchantDeny, ['casino'])
})

test('an unconfigured policy already refuses a high-risk card purchase', () => {
  // The whole point of a safe default: protection before anyone opens the settings screen.
  const d = decide({ intent: buy({ mcc: '6011', merchant: 'ATM', notionalUsd: 20 }) })
  assert.equal(d.verdict, 'DENY')
})

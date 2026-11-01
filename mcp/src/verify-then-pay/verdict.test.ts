import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateVerdict, readSettlement, type ExpectedCheck } from './verdict.js'
import { getChainById } from '../chains/index.js'

/**
 * The paid answer, checked before anything is prepared from it.
 *
 * The scorer behind risk_check is frozen (the OKX.AI listings are registered against it), and
 * it has two holes this layer closes: a NaN reputation comes out ALLOW, and the payee in
 * txContext is echoed and never compared. Every case here is an answer the scorer could give
 * that must not lead to a payment.
 */
const arc = getChainById('arc-mainnet')!
const base = getChainById('base')!
const PAYEE = '0x' + 'd4'.repeat(20)
const PAYER = '0x' + 'c3'.repeat(20)
const NONCE = '0x' + 'ab'.repeat(32)

const expected: ExpectedCheck = { network: arc.caip2, authNonce: NONCE, payer: PAYER, payee: PAYEE, amountUsd: 0.25 }

function body(over: { signals?: Record<string, unknown>; settlement?: Record<string, unknown>; [k: string]: unknown } = {}): Record<string, unknown> {
  const { signals, settlement, ...rest } = over
  return {
    tool: 'risk_check',
    agentId: PAYEE,
    decision: 'ALLOW',
    risk: 'low',
    reasons: ['Verified on-chain identity, attested KYA, and strong reputation'],
    signals: {
      onchainVerified: true,
      kyaVerified: true,
      reputationScore: 720,
      tenureDays: 40,
      revoked: false,
      sybil: 'none',
      txContext: { amountUsd: 0.25, payee: PAYEE },
      ...signals,
    },
    checkedAt: '2026-11-01T10:00:00.000Z',
    settlement: {
      ts: '2026-11-01T10:00:00.000Z',
      outcome: 'credited',
      tool: 'risk_check',
      resource: '/api/x402/gateway/tools/risk_check',
      network: arc.caip2,
      value: '5000',
      payer: PAYER.toUpperCase().replace('0X', '0x'),
      authNonce: NONCE.toUpperCase().replace('0X', '0x'),
      transferId: 'tr-1',
      ...settlement,
    },
    ...rest,
  }
}

test('a clean ALLOW that echoes this check is usable and decides ALLOW, whatever the case of the echo', () => {
  const v = evaluateVerdict(body(), expected)
  assert.equal(v.usable, true)
  if (!v.usable) return
  assert.equal(v.decision, 'ALLOW')
  assert.equal(v.effective, 'ALLOW')
  assert.equal(v.reputationScore, 720)
  assert.deepEqual(v.settlement, {
    network: arc.caip2,
    authNonce: NONCE,
    payer: PAYER,
    outcome: 'credited',
    transferId: 'tr-1',
    value: '5000',
    ts: '2026-11-01T10:00:00.000Z',
    resource: '/api/x402/gateway/tools/risk_check',
  })
})

test('a reputation that is NaN, null, missing, a string or out of range is blocked, as assessRisk would have let it ALLOW', () => {
  for (const rep of [Number.NaN, null, undefined, 'NaN', '720', Number.POSITIVE_INFINITY, -1, 1001]) {
    const signals: Record<string, unknown> = { reputationScore: rep }
    const v = evaluateVerdict(body({ signals }), expected)
    assert.equal(v.usable, false, `reputation ${String(rep)} must not be usable`)
    if (v.usable) continue
    assert.equal(v.code, 'REPUTATION_NOT_FINITE')
    assert.equal(v.effective, 'DENY')
    assert.equal(v.decision, 'ALLOW', 'the decision the scorer gave is kept for the record')
    assert.equal(v.reputationScore, null)
  }
  // The same goes for tenure, which the NEW_AGENT rule compares the same way.
  const t = evaluateVerdict(body({ signals: { tenureDays: Number.NaN } }), expected)
  assert.equal(t.usable ? null : t.code, 'TENURE_NOT_FINITE')
})

test('a missing or unknown decision, or a verdict without signals or reasons, decides nothing and is blocked', () => {
  for (const decision of [undefined, null, 'allow', 'MAYBE', 1]) {
    const v = evaluateVerdict(body({ decision }), expected)
    assert.equal(v.usable ? null : v.code, 'DECISION_UNKNOWN', `decision ${String(decision)}`)
  }
  const noSignals = evaluateVerdict({ ...body(), signals: null }, expected)
  assert.equal(noSignals.usable ? null : noSignals.code, 'SIGNALS_MISSING')
  const noReasons = evaluateVerdict(body({ reasons: [] }), expected)
  assert.equal(noReasons.usable ? null : noReasons.code, 'SIGNALS_MISSING')
})

test('the settlement must echo this check: network, nonce, payer, a credited outcome and the tool', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['another network', { network: base.caip2 }],
    ['another nonce', { authNonce: '0x' + 'cd'.repeat(32) }],
    ['another payer', { payer: '0x' + 'ee'.repeat(20) }],
    ['unconfirmed', { outcome: 'unconfirmed' }],
    ['failed', { outcome: 'failed' }],
    ['another tool', { tool: 'verify_agent' }],
  ]
  for (const [what, settlement] of cases) {
    const v = evaluateVerdict(body({ settlement }), expected)
    assert.equal(v.usable ? null : v.code, 'SETTLEMENT_MISMATCH', what)
    assert.equal(v.effective, 'DENY')
  }
  assert.deepEqual(readSettlement({ tool: 'risk_check' }, expected), { ok: false, reason: 'the answer carries no settlement record' })
  const wrongTool = evaluateVerdict(body({ tool: 'agent_passport' }), expected)
  assert.equal(wrongTool.usable ? null : wrongTool.code, 'TOOL_MISMATCH')
})

test('the verdict must be about the payee that will be paid, for the amount that will be paid', () => {
  const other = '0x' + '99'.repeat(20)
  const cases: [string, Record<string, unknown>][] = [
    ['agentId is another agent', { agentId: other }],
    ['agentId is a CAIP id rather than the payee', { agentId: `${arc.caip2}:8004/7` }],
    ['txContext names another payee', { signals: { txContext: { amountUsd: 0.25, payee: other } } }],
    ['txContext carries a string amount, which switches the amount rules off', { signals: { txContext: { amountUsd: '0.25', payee: PAYEE } } }],
    ['txContext carries another amount', { signals: { txContext: { amountUsd: 0.2, payee: PAYEE } } }],
    ['txContext is missing', { signals: { txContext: null } }],
  ]
  for (const [what, over] of cases) {
    const v = evaluateVerdict(body(over), expected)
    assert.equal(v.usable ? null : v.code, 'CONTEXT_MISMATCH', what)
  }
})

test('an ALLOW that contradicts the signals it was computed from is a scorer fault and is blocked', () => {
  const cases: Record<string, unknown>[] = [
    { onchainVerified: false },
    { kyaVerified: false },
    { revoked: true },
    { sybil: 'medium' },
    { sybil: 'high' },
    { reputationScore: 499 },
    { tenureDays: 6 },
  ]
  for (const signals of cases) {
    const v = evaluateVerdict(body({ signals }), expected)
    assert.equal(v.usable ? null : v.code, 'SIGNALS_INCONSISTENT', JSON.stringify(signals))
  }
  // The same signals under WARN or DENY are what those verdicts are for.
  const warn = evaluateVerdict(body({ decision: 'WARN', risk: 'medium', signals: { kyaVerified: false, reputationScore: 300 } }), expected)
  assert.equal(warn.usable, true)
  assert.equal(warn.effective, 'WARN')
  const deny = evaluateVerdict(body({ decision: 'DENY', risk: 'high', reasons: ['Reputation 60 is below the safe threshold (200)'], signals: { kyaVerified: false, reputationScore: 60, tenureDays: 0 } }), expected)
  assert.equal(deny.usable, true)
  assert.equal(deny.effective, 'DENY')
  assert.deepEqual(deny.reasons, ['Reputation 60 is below the safe threshold (200)'])
})

test('a WARN carrying signals that force DENY is a scorer fault and is blocked, naming each one', () => {
  const warn = (signals: Record<string, unknown>, e: ExpectedCheck = expected) => {
    const ctx = { amountUsd: e.amountUsd, payee: PAYEE }
    return evaluateVerdict(body({ decision: 'WARN', risk: 'medium', reasons: ['Moderate reputation'], signals: { kyaVerified: false, reputationScore: 320, tenureDays: 0, txContext: ctx, ...signals } }), e)
  }
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ revoked: true }, /revoked/],
    [{ sybil: 'high' }, /sybil high/],
    [{ onchainVerified: false }, /no on-chain identity/],
    [{ onchainVerified: undefined }, /no on-chain identity/],
    [{ onchainVerified: 'true' }, /no on-chain identity/],
    [{ reputationScore: 199 }, /reputation 199 under 200/],
  ]
  for (const [signals, named] of cases) {
    const v = warn(signals)
    assert.equal(v.usable ? null : v.code, 'SIGNALS_INCONSISTENT', JSON.stringify(signals))
    assert.equal(v.effective, 'DENY')
    assert.equal(v.decision, 'WARN', 'the decision the scorer gave is kept for the record')
    assert.match(v.usable ? '' : v.reason, named)
  }

  // Over 100 USD the bar is 400, and exactly at either line the scorer does not deny.
  const big: ExpectedCheck = { ...expected, amountUsd: 100.01 }
  const denied = warn({ reputationScore: 399 }, big)
  assert.equal(denied.usable ? null : denied.code, 'SIGNALS_INCONSISTENT')
  assert.match(denied.usable ? '' : denied.reason, /100\.01 USD with reputation 399 under 400/)
  assert.equal(warn({ reputationScore: 400 }, big).usable, true)
  assert.equal(warn({ reputationScore: 399 }, { ...expected, amountUsd: 100 }).usable, true)
  assert.equal(warn({ reputationScore: 200 }).usable, true)
  // A medium Sybil flag is what a WARN is for.
  assert.equal(warn({ sybil: 'medium' }).usable, true)
})

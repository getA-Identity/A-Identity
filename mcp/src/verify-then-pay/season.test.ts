import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toSeasonFlow } from './season.js'
import { getChainById } from '../chains/index.js'
import type { VtpFlowRecord } from '../storage.js'

/**
 * Which recorded flows the Arc Acceleration Season report may count. A row counts only with
 * something a reviewer can open: a payment or a revert by its hash, or a DENY by its public
 * flow record on https://a-identity.xyz. Everything still open, or never decided, counts
 * nothing, however many of them there are.
 */
const arc = getChainById('arc-mainnet')!
const FLOW = '0x' + 'ab'.repeat(32)
const TX = '0x' + 'c1'.repeat(32)
const PAYER = '0x' + 'c3'.repeat(20)
const PAYEE = '0x' + 'd4'.repeat(20)

function row(over: Partial<VtpFlowRecord> = {}): VtpFlowRecord {
  return {
    v: 1,
    flowId: FLOW,
    network: arc.caip2,
    createdAt: '2026-11-01T10:00:01.000Z',
    updatedAt: '2026-11-01T10:00:01.000Z',
    vault: '0x' + 'a1'.repeat(20),
    owner: '0x' + 'b2'.repeat(20),
    operator: PAYER,
    payee: PAYEE,
    payeeAgentId: null,
    asset: (arc.contracts.usdc as string).toLowerCase(),
    amount: '10000',
    amountUsd: 0.01,
    check: { authNonce: FLOW, transferId: 'tr-1', gatewayOutcome: 'credited', payer: PAYER, value: '5000', tool: 'risk_check', checkedAt: '2026-11-01T10:00:00.000Z', checkedAtBlock: '90', verdictBlock: '100' },
    verdict: { decision: 'ALLOW', effective: 'ALLOW', risk: 'low', reasons: ['strong'], reputationScore: 720, agentId: PAYEE, checkedAt: '2026-11-01T10:00:00.000Z' },
    payOnWarn: false,
    prepared: null,
    outcome: 'pending',
    detail: 'agent_will_pay',
    ...over,
  }
}

const payment = (status: 'success' | 'reverted', byOwner = false): NonNullable<VtpFlowRecord['payment']> => ({
  txHash: TX,
  blockNumber: '101',
  minedAt: '2026-11-01T10:00:09.000Z',
  status,
  byOwner,
  from: PAYER,
  to: '0x' + 'a1'.repeat(20),
  gasUsed: '90341',
  effectiveGasPrice: '20100000000',
  costUsdc: '0.001816',
  readBackAt: '2026-11-01T10:05:00.000Z',
  readBackFrom: 'rpc.example',
  explorerUrl: 'x',
})

test('an executed flow is a payment, named by its hash, timed by the block it was mined in, and tied to its payer', () => {
  const [f, ...rest] = toSeasonFlow(row({ outcome: 'executed', detail: 'agent_paid', payment: payment('success') }))
  assert.equal(rest.length, 0)
  // The block's time, not the read-back's: a read-back is always after the check, so timing a
  // flow by it would make the report's "after the check" rule true of every payment.
  assert.deepEqual(
    { checkNonce: f.checkNonce, payer: f.payer, payee: f.payee, outcome: f.outcome, txHash: f.txHash, evidenceUrl: f.evidenceUrl, at: f.at },
    { checkNonce: FLOW, payer: PAYER, payee: PAYEE, outcome: 'paid', txHash: TX, evidenceUrl: undefined, at: '2026-11-01T10:00:09.000Z' },
  )
  assert.notEqual(f.at, payment('success').readBackAt)
  // The check's settlement as the row recorded it, for when its Gateway row has aged out.
  assert.deepEqual(f.check, { network: arc.caip2, payer: PAYER, outcome: 'credited', ts: '2026-11-01T10:00:00.000Z' })
  assert.match(f.note, /0\.01 USDC/)
  assert.match(f.note, /in block 101/)
})

test('a vault policy revert and a DENY are refusals: one by its hash, the other by its public flow record', () => {
  const [rev] = toSeasonFlow(row({ outcome: 'blocked', detail: 'reverted_onchain', payment: { ...payment('reverted'), revertReason: 'AboveAutoApprove' } }))
  assert.deepEqual([rev.outcome, rev.txHash, rev.evidenceUrl, rev.at], ['refused', TX, undefined, '2026-11-01T10:00:09.000Z'])
  assert.match(rev.note, /AboveAutoApprove/)
  const [deny] = toSeasonFlow(row({ outcome: 'blocked', detail: 'deny', verdict: { ...row().verdict!, decision: 'DENY', effective: 'DENY' } }))
  assert.deepEqual([deny.outcome, deny.txHash], ['refused', undefined])
  assert.equal(deny.evidenceUrl, `https://a-identity.xyz/api/x402/gateway/flows/${FLOW}`)
  assert.equal(deny.at, '2026-11-01T10:00:01.000Z')
})

test('a flow still open, or one whose verdict was never usable, counts nothing', () => {
  for (const over of [
    { outcome: 'opening', detail: 'opening', verdict: null },
    { outcome: 'abandoned', detail: 'rail_failed', verdict: null },
    { outcome: 'blocked', detail: 'warn_no_human_gate' },
    { outcome: 'pending', detail: 'agent_will_pay' },
    { outcome: 'awaiting_human', detail: 'warn_handoff' },
    { outcome: 'blocked', detail: 'verdict_unusable' },
    { outcome: 'blocked', detail: 'verdict_unavailable', verdict: null },
    { outcome: 'abandoned', detail: 'expired' },
    // An executed row without a successful receipt is not a payment.
    { outcome: 'executed', detail: 'agent_paid' },
    { outcome: 'executed', detail: 'agent_paid', payment: payment('reverted') },
    // A revert that was not the vault's policy is neither a payment nor a refusal.
    { outcome: 'failed', detail: 'reverted_not_policy', payment: { ...payment('reverted'), revertReason: 'out of gas: the transaction used all of its 100000 gas' } },
    { outcome: 'failed', detail: 'reverted_not_policy', payment: { ...payment('reverted'), revertReason: 'NotOperator' } },
    // And a refusal has to name the typed error that made it one.
    { outcome: 'blocked', detail: 'reverted_onchain', payment: payment('reverted') },
    { outcome: 'blocked', detail: 'reverted_onchain', payment: { ...payment('reverted'), revertReason: 'TransferFailed' } },
  ] as Partial<VtpFlowRecord>[]) {
    assert.deepEqual(toSeasonFlow(row(over)), [], JSON.stringify(over))
  }
})

test('a row that is not a flow record throws here, so the report can skip that row alone', () => {
  assert.throws(() => toSeasonFlow(row({ amount: 'not a number', outcome: 'executed', detail: 'agent_paid', payment: payment('success') })))
  assert.throws(() => toSeasonFlow(row({ check: undefined as never })), /no flowId, payee or check payer/)
  assert.throws(() => toSeasonFlow(row({ flowId: 7 as never })), /no flowId, payee or check payer/)
})

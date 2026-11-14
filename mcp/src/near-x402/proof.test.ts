import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getChainById } from '../chains/registry.js'
import { proveNearPayment, type NearPaymentExpectation } from './proof.js'
import type { NearTxResult } from './relay.js'

/**
 * proveNearPayment against one FINAL outcome in the shape testnet gives for a relayed x402
 * payment (the reference settlement Ax8kFqgPZZgsvamjwdMeE7RmmBTDhLNVgeB5fFt9E3x1, read from
 * archival RPC on 2026-11-12 UTC: a Delegate receipt run by the payer, the token's ft_transfer receipt
 * with its nep141 event, two refunds to the relayer), with our accounts in it. Every way of not
 * being the payment must fail, each with its own reason.
 */
const USDC = getChainById('near-testnet')!.documentedTokens!.find((t) => t.symbol === 'USDC')!.address
const TX = '9xGcQhbnVWV2mmY7vPDqYt2r5i2hkJ2D7qn7dD3bS1eA'
const RELAYER = 'x402-relayer.a-identity.testnet'
const PAYER = 'aid-demo-agent.testnet'
const PAY_TO = 'a-identity.testnet'
const KEY = 'ed25519:2CHL4RuYp4a84rh2bVZo6iVZci99SUkQzCpbG3HgVryf'
const NONCE = 277284573000002n

const want: NearPaymentExpectation = { txHash: TX, relayer: RELAYER, payer: PAYER, asset: USDC, payTo: PAY_TO, amount: '10000', delegate: { publicKey: KEY, nonce: NONCE } }

const event = (data: unknown[], extra: Record<string, unknown> = {}) => `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data, ...extra })}`
const args = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64')

function outcome(): any {
  return {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: {
      hash: TX,
      signer_id: RELAYER,
      receiver_id: PAYER,
      public_key: 'ed25519:6njRwRtwBdZtsqLaLuB7Uuxt5yT62s6pXT8aMjFSRs8X',
      nonce: 277421000000001,
      actions: [
        {
          Delegate: {
            delegate_action: {
              sender_id: PAYER,
              receiver_id: USDC,
              actions: [{ FunctionCall: { method_name: 'ft_transfer', args: args({ receiver_id: PAY_TO, amount: '10000' }), gas: 30000000000000, deposit: '1' } }],
              nonce: Number(NONCE),
              max_block_height: 277430117,
              public_key: KEY,
            },
            signature: 'ed25519-signature-not-quoted-here',
          },
        },
      ],
    },
    transaction_outcome: { id: TX, block_hash: 'B1', outcome: { executor_id: RELAYER, status: { SuccessReceiptId: 'R1' }, logs: [] } },
    receipts_outcome: [
      { id: 'R1', block_hash: 'B2', outcome: { executor_id: PAYER, status: { SuccessValue: '' }, logs: [] } },
      { id: 'R2', block_hash: 'B3', outcome: { executor_id: USDC, status: { SuccessValue: '' }, logs: [event([{ old_owner_id: PAYER, new_owner_id: PAY_TO, amount: '10000' }])] } },
      { id: 'R3', block_hash: 'B4', outcome: { executor_id: RELAYER, status: { SuccessValue: '' }, logs: [] } },
    ],
  }
}

const delegateOf = (o: any) => o.transaction.actions[0].Delegate.delegate_action
const fcOf = (o: any) => delegateOf(o).actions[0].FunctionCall

test('a relayed ft_transfer of exactly the price, executed by the token and logged by it, is proven', () => {
  const p = proveNearPayment(outcome() as NearTxResult, want)
  assert.equal(p.ok, true, p.ok ? '' : p.reason)
  if (!p.ok) return
  assert.equal(p.txHash, TX)
  assert.equal(p.receiptId, 'R2')
  assert.equal(p.receiptBlockHash, 'B3')
  assert.deepEqual(p.event, { old_owner_id: PAYER, new_owner_id: PAY_TO, amount: '10000' })
  assert.match(p.eventLog, /^EVENT_JSON:\{"standard":"nep141"/)
})

test('every way of not being this payment fails, with its own reason', () => {
  const cases: [string, (o: any) => void, RegExp][] = [
    ['not final', (o) => (o.final_execution_status = 'EXECUTED_OPTIMISTIC'), /^not_final/],
    ['another transaction', (o) => (o.transaction.hash = 'Other'), /^tx_hash_mismatch/],
    ['another relayer', (o) => (o.transaction.signer_id = 'x402-relayer.mike.testnet'), /^tx_shape_mismatch/],
    ['another receiver', (o) => (o.transaction.receiver_id = 'someone.testnet'), /^tx_shape_mismatch/],
    ['two actions', (o) => o.transaction.actions.push(o.transaction.actions[0]), /^delegate_mismatch: the transaction carries 2 actions/],
    ['not a Delegate', (o) => (o.transaction.actions = [{ FunctionCall: fcOf(o) }]), /^delegate_mismatch: the transaction's action is not a Delegate/],
    ['a delegate from someone else', (o) => (delegateOf(o).sender_id = 'other.testnet'), /^delegate_mismatch: the delegate is from other\.testnet/],
    ['a delegate on another token', (o) => (delegateOf(o).receiver_id = 'usdc.testnet'), /^delegate_mismatch: the delegate calls usdc\.testnet/],
    ['another key', (o) => (delegateOf(o).public_key = 'ed25519:HTmjPWtrAKpYPmwkkABEiSWRHbqKVsfVFrjp5aKnwD7d'), /different key/],
    ['another nonce', (o) => (delegateOf(o).nonce = Number(NONCE) + 1), /different nonce/],
    ['two delegated actions', (o) => delegateOf(o).actions.push(delegateOf(o).actions[0]), /holds 2 actions/],
    ['ft_transfer_call', (o) => (fcOf(o).method_name = 'ft_transfer_call'), /calls ft_transfer_call, not ft_transfer/],
    ['no yoctoNEAR', (o) => (fcOf(o).deposit = '0'), /attaches 0 yoctoNEAR/],
    ['another payee in the args', (o) => (fcOf(o).args = args({ receiver_id: 'thief.testnet', amount: '10000' })), /pays thief\.testnet/],
    ['another amount in the args', (o) => (fcOf(o).args = args({ receiver_id: PAY_TO, amount: '9999' })), /moves 9999, not exactly 10000/],
    ['the transaction failed', (o) => (o.status = { Failure: { ActionError: {} } }), /^tx_failure/],
    ['a receipt failed', (o) => (o.receipts_outcome[0].outcome.status = { Failure: { ActionError: { kind: 'DelegateActionInvalidNonce' } } }), /^receipt_failure/],
    // nearcore keeps a failed call's logs: the event line is there, and it proves nothing.
    ['the token receipt failed with its event logged', (o) => (o.receipts_outcome[1].outcome.status = { Failure: { ActionError: {} } }), /^receipt_failure/],
    ['the event logged by another contract', (o) => {
      o.receipts_outcome[1].outcome.logs = []
      o.receipts_outcome.push({ id: 'R9', outcome: { executor_id: 'mimic.testnet', status: { SuccessValue: '' }, logs: [event([{ old_owner_id: PAYER, new_owner_id: PAY_TO, amount: '10000' }])] } })
    }, /^no_matching_ft_transfer/],
    ['an event one unit short', (o) => (o.receipts_outcome[1].outcome.logs = [event([{ old_owner_id: PAYER, new_owner_id: PAY_TO, amount: '9999' }])]), /^no_matching_ft_transfer/],
    ['an event to someone else', (o) => (o.receipts_outcome[1].outcome.logs = [event([{ old_owner_id: PAYER, new_owner_id: 'thief.testnet', amount: '10000' }])]), /^no_matching_ft_transfer/],
    ['an event of another standard version', (o) => (o.receipts_outcome[1].outcome.logs = [event([{ old_owner_id: PAYER, new_owner_id: PAY_TO, amount: '10000' }], { version: '2.0.0' })]), /^no_matching_ft_transfer/],
    ['no event at all', (o) => (o.receipts_outcome[1].outcome.logs = []), /^no_matching_ft_transfer/],
    ['two matching transfers', (o) => (o.receipts_outcome[1].outcome.logs = [event([{ old_owner_id: PAYER, new_owner_id: PAY_TO, amount: '10000' }, { old_owner_id: PAYER, new_owner_id: PAY_TO, amount: '10000' }])]), /^ambiguous_transfer/],
  ]
  for (const [name, mutate, reason] of cases) {
    const o = outcome()
    mutate(o)
    const p = proveNearPayment(o as NearTxResult, want)
    assert.equal(p.ok, false, `${name} was proven as a payment`)
    if (!p.ok) assert.match(p.reason, reason, name)
  }
  // And an expectation that is not an integer is refused before anything is read.
  const bad = proveNearPayment(outcome() as NearTxResult, { ...want, amount: '0.01' })
  assert.equal(bad.ok, false)
})

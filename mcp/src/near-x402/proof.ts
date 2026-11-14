/**
 * Did the money move? Decided from a FINAL NEAR transaction outcome, and from nothing else.
 *
 * A relayed x402 payment on NEAR is one outer transaction (our relayer signs it, the payer
 * receives it, its only action is the payer's Delegate) that spawns the payer's ft_transfer on
 * the token. Inclusion, a FINAL status or a SuccessValue on the outer transaction proves none of
 * it: the Delegate can fail (an expired window, a used nonce), and the ft_transfer can fail
 * inside it (no balance, no storage). So a payment is proven here only when ALL of this holds:
 *
 *   1. the outcome is FINAL (every receipt, refunds included, has executed);
 *   2. it is the transaction we signed: its hash, our relayer as signer, the payer as receiver;
 *   3. its one action is the payer's Delegate, and the delegate holds exactly one FunctionCall:
 *      ft_transfer on the asset, 1 yoctoNEAR attached, to payTo for exactly the amount, signed
 *      with the key and nonce of the delegate that was verified;
 *   4. nothing failed, neither the transaction nor any receipt;
 *   5. a receipt EXECUTED BY THE TOKEN ended in SuccessValue and logged a NEP-297 event, standard
 *      nep141 version 1.0.0, event ft_transfer, with exactly one item from the payer to payTo
 *      for exactly the amount.
 *
 * Point 5 names its executor and its status on purpose. Any contract can log a line that reads
 * like a nep141 event, and nearcore keeps a call's logs even when the call fails, so an event is
 * evidence only from the token's own receipt, and only when that same receipt succeeded.
 *
 * Pure: no I/O, so every way of not being a payment is a test without a network.
 */
import type { NearTxResult } from './relay.js'

export type NearPaymentExpectation = {
  txHash: string
  relayer: string
  payer: string
  asset: string
  payTo: string
  /** Atomic units, a decimal string. */
  amount: string
  /** The delegate that was verified, so the proof is about THIS payment and no other. */
  delegate: { publicKey: string; nonce: bigint }
}

export type NearTransferEvent = { old_owner_id: string; new_owner_id: string; amount: string; memo?: string }

export type NearPaymentProof =
  | {
      ok: true
      txHash: string
      /** The token contract's ft_transfer receipt. */
      receiptId: string
      receiptBlockHash: string | null
      event: NearTransferEvent
      /** The log line, verbatim, for anyone re-reading the transaction. */
      eventLog: string
    }
  | { ok: false; reason: string }

const EVENT_PREFIX = 'EVENT_JSON:'

const isObj = (x: unknown): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && !Array.isArray(x)
const failed = (status: unknown) => isObj(status) && 'Failure' in status
const digits = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s)

function decodeArgs(args: unknown): Record<string, unknown> | null {
  if (typeof args !== 'string') return null
  try {
    const v = JSON.parse(Buffer.from(args, 'base64').toString('utf8')) as unknown
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** Check point 3: the single action is the expected Delegate. Null when it is, else why not. */
function delegateMismatch(actions: unknown, e: NearPaymentExpectation): string | null {
  if (!Array.isArray(actions) || actions.length !== 1) return `the transaction carries ${Array.isArray(actions) ? actions.length : 'no'} actions, not one Delegate`
  const d = isObj(actions[0]) ? actions[0].Delegate : undefined
  if (!isObj(d) || !isObj(d.delegate_action)) return 'the transaction\'s action is not a Delegate'
  const da = d.delegate_action
  if (da.sender_id !== e.payer) return `the delegate is from ${String(da.sender_id)}, not ${e.payer}`
  if (da.receiver_id !== e.asset) return `the delegate calls ${String(da.receiver_id)}, not the asset ${e.asset}`
  if (da.public_key !== e.delegate.publicKey) return 'the delegate was signed with a different key than the one verified'
  if (!digits(String(da.nonce ?? '')) || BigInt(String(da.nonce)) !== e.delegate.nonce) return 'the delegate carries a different nonce than the one verified'
  const inner = da.actions
  if (!Array.isArray(inner) || inner.length !== 1) return `the delegate holds ${Array.isArray(inner) ? inner.length : 'no'} actions, not one ft_transfer`
  const fc = isObj(inner[0]) ? inner[0].FunctionCall : undefined
  if (!isObj(fc)) return 'the delegated action is not a FunctionCall'
  if (fc.method_name !== 'ft_transfer') return `the delegate calls ${String(fc.method_name)}, not ft_transfer`
  if (String(fc.deposit) !== '1') return `the ft_transfer attaches ${String(fc.deposit)} yoctoNEAR, not 1`
  const args = decodeArgs(fc.args)
  if (!args) return 'the ft_transfer arguments are not JSON'
  if (args.receiver_id !== e.payTo) return `the ft_transfer pays ${String(args.receiver_id)}, not ${e.payTo}`
  if (!digits(args.amount) || BigInt(args.amount) !== BigInt(e.amount)) return `the ft_transfer moves ${String(args.amount)}, not exactly ${e.amount}`
  return null
}

export function proveNearPayment(r: NearTxResult, e: NearPaymentExpectation): NearPaymentProof {
  if (!digits(e.amount)) return { ok: false, reason: 'bad_amount: the expected amount is not an integer' }
  if (r?.final_execution_status !== 'FINAL') return { ok: false, reason: `not_final: the outcome is ${r?.final_execution_status ?? 'missing'}, and only FINAL has run every receipt` }
  const tx = r.transaction ?? {}
  if (tx.hash !== e.txHash || (r.transaction_outcome?.id !== undefined && r.transaction_outcome.id !== e.txHash)) {
    return { ok: false, reason: `tx_hash_mismatch: the outcome is for ${String(tx.hash)}, not ${e.txHash}` }
  }
  if (tx.signer_id !== e.relayer || tx.receiver_id !== e.payer) {
    return { ok: false, reason: `tx_shape_mismatch: signed by ${String(tx.signer_id)} for ${String(tx.receiver_id)}, expected ${e.relayer} for ${e.payer}` }
  }
  const shape = delegateMismatch(tx.actions, e)
  if (shape) return { ok: false, reason: `delegate_mismatch: ${shape}` }
  if (failed(r.status)) return { ok: false, reason: `tx_failure: ${JSON.stringify((r.status as Record<string, unknown>).Failure).slice(0, 300)}` }
  const outcomes = r.receipts_outcome ?? []
  const bad = outcomes.find((o) => failed(o.outcome?.status))
  if (bad) return { ok: false, reason: `receipt_failure: ${String(bad.outcome?.executor_id)} failed: ${JSON.stringify((bad.outcome?.status as Record<string, unknown>).Failure).slice(0, 300)}` }

  const want = BigInt(e.amount)
  let found: { receiptId: string; receiptBlockHash: string | null; event: NearTransferEvent; eventLog: string } | null = null
  let count = 0
  for (const o of outcomes) {
    const out = o.outcome
    // The token's own receipt, and only one that succeeded: see the header.
    if (out?.executor_id !== e.asset || !isObj(out.status) || !('SuccessValue' in out.status)) continue
    for (const log of out.logs ?? []) {
      if (typeof log !== 'string' || !log.startsWith(EVENT_PREFIX)) continue
      let ev: unknown
      try {
        ev = JSON.parse(log.slice(EVENT_PREFIX.length))
      } catch {
        continue
      }
      if (!isObj(ev) || ev.standard !== 'nep141' || ev.version !== '1.0.0' || ev.event !== 'ft_transfer' || !Array.isArray(ev.data)) continue
      for (const item of ev.data) {
        if (!isObj(item) || item.old_owner_id !== e.payer || item.new_owner_id !== e.payTo || !digits(item.amount) || BigInt(item.amount) !== want) continue
        count += 1
        found ??= {
          receiptId: String(o.id ?? ''),
          receiptBlockHash: typeof o.block_hash === 'string' ? o.block_hash : null,
          event: { old_owner_id: item.old_owner_id, new_owner_id: item.new_owner_id, amount: item.amount, ...(typeof item.memo === 'string' ? { memo: item.memo } : {}) },
          eventLog: log,
        }
      }
    }
  }
  if (!found) return { ok: false, reason: `no_matching_ft_transfer: no successful receipt of ${e.asset} logged a nep141 ft_transfer of exactly ${e.amount} from ${e.payer} to ${e.payTo}` }
  // One delegated ft_transfer moves the money once. Two matching items would be a token doing
  // something this proof does not understand, and that is not counted as a payment.
  if (count !== 1) return { ok: false, reason: `ambiguous_transfer: ${count} matching ft_transfer items, expected exactly one` }
  return { ok: true, txHash: e.txHash, ...found }
}

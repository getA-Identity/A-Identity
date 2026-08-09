/**
 * Pure encode/decode helpers for Arc transaction memos. No chain I/O — every function
 * here is deterministic and unit-testable, so the "why" payload attached to an on-chain
 * settlement has one canonical, tested shape. The adapter (adapter.ts) does the actual
 * `Memo.memo(...)` broadcast; this module only shapes the bytes.
 *
 * See ../../../ARC docs: /arc/concepts/transaction-memos.
 */
import { keccak256, stringToHex, hexToString } from 'viem'

type Hex = `0x${string}`

/** The structured reason attached to every memo-wrapped settlement. Deliberately
 *  small — it lands in an on-chain event log — but complete enough to reconstruct
 *  WHY an agent paid: which agent, which instruction, for what, under which decision. */
export type MemoInput = {
  agentId: string
  instructionId: string
  /** What was paid for — the payee ref or instruction type. */
  service: string
  /** The policy decision that authorized it, e.g. 'auto_approved' | 'approved'. */
  policyDecision: string
}

/** Deterministic, indexable memo id for an instruction settlement. Because it is a
 *  keccak of the instruction ref, anyone can recompute it and query the `Memo` event
 *  by `memoId` without knowing the tx hash. */
export function memoIdFor(instructionId: string): Hex {
  return keccak256(stringToHex(`a-identity:ix:${instructionId}`))
}

/**
 * The canonical structured "why" payload, as compact JSON. Keys are single-letter
 * because it lands in an on-chain event log.
 *
 * Shared on purpose: the Memo path writes this on-chain, and the settlement paths that
 * CANNOT emit a Memo (the AgentSpendPolicy vault contract, the Circle Agent Wallet,
 * batched Multicall3From) record the very same payload app-layer. One function, so the
 * on-chain and the app-layer audit trails can never drift into different shapes.
 */
export function memoReasonJson(input: MemoInput): string {
  return JSON.stringify({
    a: input.agentId,
    i: input.instructionId,
    s: input.service,
    d: input.policyDecision,
  })
}

/** Encode a MemoInput into the on-chain `{ memoId, memoData }` pair plus the human
 *  reason string. Keys are single-letter to keep the log payload compact. */
export function encodeMemo(input: MemoInput): { memoId: Hex; memoBytes: Hex; reason: string } {
  const reason = memoReasonJson(input)
  return { memoId: memoIdFor(input.instructionId), memoBytes: stringToHex(reason), reason }
}

/** Decode on-chain memo bytes back to the reason string (best-effort; returns the raw
 *  hex if it is not valid UTF-8, so a malformed/foreign memo never throws). */
export function decodeMemo(memoHex: string): string {
  try {
    return hexToString(memoHex as Hex)
  } catch {
    return memoHex
  }
}

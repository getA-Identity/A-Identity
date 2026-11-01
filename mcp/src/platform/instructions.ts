/**
 * Spend instructions: the pre-flight policy ladder, create/approve/reject, and the
 * layered settlement paths (on-chain vault, Circle Agent Wallet, direct with memo).
 * Layering: L2 domain module; imports ./core.js and flat ../ modules only.
 */
import {
  state, save, saveDurably, id, ownsAgent, dailySpent, addSpend, reverseSpend, nextUtcMidnight, pushActivity, short, cap, todayUTC,
  type Permissions, type Instruction, type InstructionType, type PlatformAgent,
} from './core.js'
import { policyPay, policyOwnerPay, payUsdcWithMemoOnchain, payUsdcBatchOnchain, memoReasonJson, readPolicyVault } from '../arc-contracts.js'
import type { MemoInput } from '../arc-contracts.js'
import { randomUUID } from 'node:crypto'
import { circlePay, circleTransferStatus, type CirclePayPending } from '../circle-agent.js'
import { vaultChainFor, vaultReceiptStatus, isEvmVault, payFromVault, readVaultPolicy } from './vault-adapter.js'
import { isAccountId, type BroadcastHooks, type Unconfirmed } from '../chains/index.js'

// ── instructions ──────────────────────────────────────────────────────────────

/** AgentSpendPolicy error names that are authoritative policy rejections (vs an
 *  infra error, which we fall back on rather than treat as a "no").
 *
 *  Both dialects, because there are two implementations of this contract and they do not
 *  spell their errors the same way. The Solidity original says `IsFrozen`; the Soroban port
 *  says `Frozen` and adds five refusals with no Solidity analogue. Listing only the
 *  Solidity names meant a genuine Soroban policy refusal was not recognised as one, and the
 *  settlement fell through to a path with no vault enforcement at all: a "no" from the
 *  chain read as an infrastructure hiccup. Names, not codes, because the adapters surface
 *  the name. */
const VAULT_POLICY_ERRORS = new Set([
  // Solidity (mcp/contracts/AgentSpendPolicy.sol)
  'IsFrozen', 'ZeroAddress', 'TransferFailed',
  // Shared by both implementations
  'SessionKeyExpired', 'PayeeNotAllowed', 'AboveAutoApprove', 'DailyCapExceeded',
  // Soroban (soroban/contracts/agent-spend-policy/src/error.rs)
  'Frozen', 'InvalidAmount', 'InvalidPayee', 'MathOverflow', 'InsufficientBalance', 'OwnerIsOperator',
])

// ── D1 spend pre-flight + D3 velocity circuit-breaker (pure decision core) ─────
//
// "If my agent tried this spend right now, what would happen and why?" answered by the
// SAME function the real path runs. createInstruction calls evaluateSpendPreflight for
// its decision, so the dry-run and reality cannot drift: whatever the preview says is,
// by construction, what POST /api/instructions would do one second later.
//
// Everything here is pure: state in, verdict out, nothing written. The stateful wrapper
// (spendPreflight below) gathers the live inputs and is read-only by contract.

/** Which rule fired. Stable and machine-readable; ladder order, first is decisive. */
export type SpendPreflightCode =
  | 'velocity_exceeded'
  | 'frozen'
  | 'payee_type_blocked'
  | 'payee_not_allowed'
  | 'daily_cap_exceeded'
  | 'above_auto_approve'
  | 'invalid_amount'

/** The on-chain AgentSpendPolicy custom error the decisive rule maps to, when the rule
 *  also exists on the vault. Server-only rules (velocity, payee type) map to null. */
export type SpendPreflightVaultError =
  | 'IsFrozen'
  | 'PayeeNotAllowed'
  | 'DailyCapExceeded'
  | 'AboveAutoApprove'

export type SpendPreflight = {
  /** ALLOW = would auto-approve; WARN = would pause for a human; DENY = would be refused. */
  verdict: 'ALLOW' | 'WARN' | 'DENY'
  /** The exact status POST /api/instructions would record, or null when the request would
   *  be refused at validation and no instruction would be created at all. */
  wouldBeStatus: 'auto_approved' | 'pending_approval' | 'rejected' | null
  /** Every rule that would trigger, in ladder order. The FIRST entry is decisive (it is
   *  what sets wouldBeStatus and policyNote); the rest are also-true findings so a caller
   *  can plan past the first blocker. Empty on ALLOW. */
  codes: SpendPreflightCode[]
  /** The exact policyNote the created instruction would carry. */
  policyNote: string
  /** What the on-chain vault would revert with for the decisive rule, or null. */
  vaultError: SpendPreflightVaultError | null
  totalUsd: number
  count: number
  frozen: boolean
  payeeAllowlisted: boolean
  payeeTypeAllowed: boolean
  /** True when a human would have to act before this spend executes (WARN or DENY). */
  needsHumanApproval: boolean
  headroom: {
    dailyCapUsd: number
    spentTodayUsd: number
    remainingTodayUsd: number
    autoApproveUnderUsd: number
  }
  /** Present when the D3 velocity breaker is configured on this agent; null otherwise. */
  velocity: {
    maxActions: number
    windowMinutes: number
    recentActions: number
    /** How many more actions fit in the current window before the breaker trips. */
    remainingActions: number
  } | null
}

/** Instruction statuses the velocity window counts: money that moved or was cleared to
 *  move. Pending and rejected rows are deliberately excluded, so a denied burst does not
 *  extend its own lockout and a queue of unapproved requests cannot trip the breaker. */
export const VELOCITY_COUNTED_STATUSES: ReadonlySet<Instruction['status']> = new Set<Instruction['status']>([
  'auto_approved', 'approved', 'executed_simulated', 'executed_onchain',
])

/**
 * D3: how many actions this agent settled or had approved inside the rolling window.
 * Batch instructions count as their full `count` (a batch of 500 IS 500 payments; a
 * velocity guard a single batch could step around would not guard anything). Pure over
 * the given list; exported for unit tests.
 */
export function countRecentActions(
  instructions: readonly Instruction[],
  agentId: string,
  windowMinutes: number,
  now: number | Date = Date.now(),
): number {
  const nowMs = typeof now === 'number' ? now : now.getTime()
  const cutoff = nowMs - windowMinutes * 60_000
  let actions = 0
  for (const ix of instructions) {
    if (ix.agentId !== agentId) continue
    if (!VELOCITY_COUNTED_STATUSES.has(ix.status)) continue
    const at = Date.parse(ix.createdAt)
    if (!Number.isFinite(at) || at <= cutoff) continue
    actions += ix.count
  }
  return actions
}

/**
 * The spend-policy ladder as one pure function: permissions + live numbers in, verdict
 * out. This is the decision core for BOTH the real path (createInstruction) and the D1
 * dry-run endpoint, in the order a bank would run the checks:
 *
 *   velocity (DENY) -> frozen -> payee type -> allowlist -> daily cap -> auto-approve line
 *
 * The velocity breaker is the only hard DENY: everything else pauses for a human, but a
 * burst past the configured rate is the compromised-agent signature, and queueing a flood
 * for a human would invite approval fatigue instead of stopping it.
 */
export function evaluateSpendPreflight(input: {
  permissions: Permissions
  spentTodayUsd: number
  /** Actions already inside the velocity window (see countRecentActions). Ignored when
   *  the agent has no velocity policy. */
  recentActions?: number
  amountUsd: number
  count?: number
  payee: string
}): SpendPreflight {
  const p = input.permissions
  // Identical normalization to the real path, so the preview prices the same action.
  const count = Math.min(1000, Math.max(1, Math.floor(input.count ?? 1)))
  const total = input.amountUsd * count
  const spentToday = input.spentTodayUsd
  const headroom = {
    dailyCapUsd: p.dailyCapUsd,
    spentTodayUsd: spentToday,
    remainingTodayUsd: Math.max(0, p.dailyCapUsd - spentToday),
    autoApproveUnderUsd: p.autoApproveUnderUsd,
  }
  const vel = p.velocity ?? null
  const recent = Math.max(0, input.recentActions ?? 0)
  const velocity = vel
    ? {
        maxActions: vel.maxActions,
        windowMinutes: vel.windowMinutes,
        recentActions: recent,
        remainingActions: Math.max(0, vel.maxActions - recent),
      }
    : null

  const payeeAllowed = p.payeeAllowlist.length === 0 || p.payeeAllowlist.includes(input.payee)
  const isHumanPayee = /^0x[0-9a-fA-F]{40}$/.test(input.payee)
  const payeeTypeAllowed = isHumanPayee ? p.agentToHuman !== false : p.agentToAgent !== false

  const base = {
    totalUsd: total,
    count,
    frozen: p.frozen,
    payeeAllowlisted: payeeAllowed,
    payeeTypeAllowed,
    headroom,
    velocity,
  }

  // A non-finite or negative amount never reaches the ladder: the real path refuses to
  // create anything at all, so the preview says exactly that (wouldBeStatus null).
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) {
    return {
      ...base,
      verdict: 'DENY',
      wouldBeStatus: null,
      codes: ['invalid_amount'],
      policyNote: 'amountUsd must be a non-negative number',
      vaultError: null,
      needsHumanApproval: true,
    }
  }

  // Collect EVERY rule that would trigger, in ladder order. The first is decisive.
  const codes: SpendPreflightCode[] = []
  if (vel && recent + count > vel.maxActions) codes.push('velocity_exceeded')
  if (p.frozen) codes.push('frozen')
  if (!payeeTypeAllowed) codes.push('payee_type_blocked')
  if (!payeeAllowed) codes.push('payee_not_allowed')
  if (spentToday + total > p.dailyCapUsd) codes.push('daily_cap_exceeded')
  // Negated <= so a NaN total (garbage count) lands here, same as the real ladder's else.
  if (!(total <= p.autoApproveUnderUsd)) codes.push('above_auto_approve')

  if (codes.length === 0) {
    return {
      ...base,
      verdict: 'ALLOW',
      wouldBeStatus: 'auto_approved',
      codes,
      policyNote: `Under the $${p.autoApproveUnderUsd} auto-approve line.`,
      vaultError: null,
      needsHumanApproval: false,
    }
  }

  const decisive = codes[0]!
  if (decisive === 'velocity_exceeded' && vel) {
    return {
      ...base,
      verdict: 'DENY',
      wouldBeStatus: 'rejected',
      codes,
      policyNote:
        `Velocity limit hit: ${recent} action(s) already in the last ${vel.windowMinutes} min ` +
        `and this would make ${recent + count} of ${vel.maxActions} allowed (velocity_exceeded). ` +
        'Denied; wait for the window to clear or raise the velocity policy.',
      vaultError: null,
      needsHumanApproval: true,
    }
  }

  const note =
    decisive === 'frozen'
      ? 'Agent is frozen; all activity is paused. A human must unfreeze or approve.'
      : decisive === 'payee_type_blocked'
        ? isHumanPayee
          ? 'Agent-to-human payments are turned off for this agent; a human must approve.'
          : 'Agent-to-agent payments are turned off for this agent; a human must approve.'
        : decisive === 'payee_not_allowed'
          ? 'Payee not on the allowlist; a human must approve.'
          : decisive === 'daily_cap_exceeded'
            ? `Would exceed today's cap ($${spentToday.toFixed(2)} spent + $${total.toFixed(2)} > $${p.dailyCapUsd}); a human must approve.`
            : `Above the auto-approve line ($${p.autoApproveUnderUsd}); waiting for a human.`
  const vaultError: SpendPreflightVaultError | null =
    decisive === 'frozen'
      ? 'IsFrozen'
      : decisive === 'payee_not_allowed'
        ? 'PayeeNotAllowed'
        : decisive === 'daily_cap_exceeded'
          ? 'DailyCapExceeded'
          : decisive === 'above_auto_approve'
            ? 'AboveAutoApprove'
            : null
  return {
    ...base,
    verdict: 'WARN',
    wouldBeStatus: 'pending_approval',
    codes,
    policyNote: note,
    vaultError,
    needsHumanApproval: true,
  }
}

/**
 * D1: the stateful, read-only dry-run. Owner-gated like every other agent-scoped read.
 * Gathers the LIVE inputs (today's spend, the velocity window count) and hands them to
 * the pure evaluator. Mutates nothing by contract: no instruction, no audit row, no
 * meter tick, no daily-spend commit, no activity entry, no save. A preview that changed
 * state would not be a preview.
 */
export function spendPreflight(
  agentId: string,
  input: { amountUsd: number; count?: number; payee: string },
  caller?: string,
):
  | ({ agentId: string; preview: true; checkedAt: string; resetsAt: string; note: string } & SpendPreflight)
  | { error: string } {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  if (typeof input.payee !== 'string' || input.payee.length === 0) return { error: 'payee required' }
  const p = agent.permissions
  const result = evaluateSpendPreflight({
    permissions: p,
    spentTodayUsd: dailySpent(agent),
    recentActions: p.velocity
      ? countRecentActions(state.instructions, agent.id, p.velocity.windowMinutes, Date.now())
      : 0,
    amountUsd: input.amountUsd,
    count: input.count,
    payee: input.payee,
  })
  return {
    agentId: agent.id,
    preview: true,
    checkedAt: new Date().toISOString(),
    resetsAt: nextUtcMidnight(),
    note: 'Dry-run only: nothing was created and no state changed. POST /api/instructions to submit for real.',
    ...result,
  }
}

export function createInstruction(input: {
  agentId: string
  type: InstructionType
  amountUsd: number
  count?: number
  payee: string
  memo?: string
  caller?: string
}): Instruction | { error: string } {
  const agent = state.agents.find((a) => a.id === input.agentId)
  if (!agent) return { error: 'Unknown agent' }
  if (!ownsAgent(agent, input.caller)) return { error: 'Forbidden: not the agent owner' }
  // Defense in depth (the HTTP layer validates too): a non-finite/negative amount must never
  // reach the daily-cap math, where a negative would subtract from today's spend.
  if (!Number.isFinite(input.amountUsd) || input.amountUsd < 0) return { error: 'amountUsd must be a non-negative number' }

  const p = agent.permissions

  // Policy checks, in the order a bank would run them: the ladder lives in the pure
  // evaluateSpendPreflight, shared with the D1 dry-run endpoint so the preview and the
  // real path can never disagree.
  const check = evaluateSpendPreflight({
    permissions: p,
    spentTodayUsd: dailySpent(agent),
    recentActions: p.velocity
      ? countRecentActions(state.instructions, agent.id, p.velocity.windowMinutes, Date.now())
      : 0,
    amountUsd: input.amountUsd,
    count: input.count,
    payee: input.payee,
  })
  // The amount guard above already refused the only wouldBeStatus-null case; this is the
  // belt to that suspender, kept as an error rather than a throw.
  if (check.wouldBeStatus === null) return { error: check.policyNote }

  const count = check.count
  const total = check.totalUsd
  const status: Instruction['status'] = check.wouldBeStatus
  const policyNote = check.policyNote

  // Auto-approved payments commit against today's cap immediately. A velocity DENY
  // commits nothing: rejected rows never count against the cap or the window.
  if (status === 'auto_approved') addSpend(agent, total)

  const instruction: Instruction = {
    id: id('ix'),
    agentId: agent.id,
    type: input.type,
    amountUsd: input.amountUsd,
    count,
    payee: input.payee,
    memo: input.memo ?? '',
    status,
    policyNote,
    // The D3 breaker is the only rule that hard-denies at creation; carry its typed
    // reason so clients and the audit trail can match on a code, not on prose.
    ...(status === 'rejected' && check.codes[0] === 'velocity_exceeded'
      ? { denyCode: 'velocity_exceeded' as const }
      : {}),
    createdAt: new Date().toISOString(),
  }

  state.instructions.push(instruction)
  pushActivity(
    agent,
    `${cap(input.type)} instruction for $${total.toFixed(2)} (${count}x): ${status.replace('_', ' ')}`,
  )
  save(state)
  return instruction
}

/**
 * Hand an instruction back to the human after a settlement that moved nothing.
 *
 * The four callers all reach the same state from different rails: the vault refused it,
 * Circle's hosted policy refused it, the batch reverted, the single transfer reverted.
 * In every one of them the instruction had ALREADY committed against the daily cap, when
 * it was auto-approved or approved, and none of them gave that back.
 *
 * Two things were wrong with that. The cap is meant to bound authorized spending, and a
 * payment that reverted spent nothing, so the day's budget was being eaten by transactions
 * that never moved money. And `approveInstruction` calls addSpend unconditionally, so
 * re-approving the returned instruction counted the same payment a second time.
 *
 * Reversing here also makes rejectInstruction's premise true again: a `pending_approval`
 * instruction holds no claim on the cap, which is exactly why that path can refuse without
 * unwinding anything.
 */
function returnToHuman(ix: Instruction, agent: PlatformAgent | undefined, amount: number, note: string, enforcedBy: Instruction['enforcedBy']) {
  if (agent) reverseSpend(agent, amount)
  delete ix.capHeldOn
  ix.status = 'pending_approval'
  ix.enforcedBy = enforcedBy
  ix.policyNote = note
}

/** Whether a settlement call came back broadcast with no receipt on any RPC. */
function isUnconfirmed(res: unknown): res is Unconfirmed {
  return (res as { unconfirmed?: unknown } | null | undefined)?.unconfirmed === true
}

/**
 * A settlement was broadcast and no RPC has its receipt, so it may have landed. It stops here:
 * every rail below would be a second payment. The hash stays on the instruction, and both an
 * approval and a rejection read it before they do anything.
 *
 * The cap claim stays too, unlike every other return to a human. A payment that may have landed
 * must count, or the agent could spend its whole cap again while this one lands: with no vault
 * nothing else bounds that. The claim is released only when a receipt shows a revert, and an
 * approval does not add it a second time (see capHeldOn).
 */
function holdUnconfirmed(ix: Instruction, agent: PlatformAgent | undefined, res: Unconfirmed, enforcedBy: Instruction['enforcedBy']) {
  holdSettlement(
    ix,
    `Settlement was broadcast (tx ${res.txHash}) but no RPC has its receipt yet, so it may have landed. Nothing else was sent and it stays counted against today's cap. ` +
      'Approving this again reads that transaction first and sends no second payment while it is unconfirmed.',
    enforcedBy,
  )
  ix.unconfirmedTx = res.txHash
  ix.unconfirmedAt ??= new Date().toISOString()
  ix.explorerUrl = res.explorerUrl
  if (agent) pushActivity(agent, `Settlement unconfirmed: tx ${short(res.txHash)} has no receipt yet; returned to a human`)
  save(state)
  return ix
}

/** The same hold for a transfer Circle may still complete. */
function holdCircle(ix: Instruction, agent: PlatformAgent | undefined, res: CirclePayPending) {
  holdSettlement(
    ix,
    `Circle may still complete this transfer (${res.reason}). Nothing else was sent and it stays counted against today's cap. ` +
      'Approving this again reads Circle first and sends no second payment while it is open.',
    'circle-agent-stack',
  )
  if (res.transactionId) ix.unconfirmedCircleTx = res.transactionId
  ix.unconfirmedAt ??= new Date().toISOString()
  if (agent) pushActivity(agent, 'Circle transfer not finished; returned to a human')
  save(state)
  return ix
}

function holdSettlement(ix: Instruction, note: string, enforcedBy: Instruction['enforcedBy']) {
  ix.status = 'pending_approval'
  ix.enforcedBy = enforcedBy
  ix.policyNote = note
  ix.capHeldOn ??= todayUTC()
}

/** Whether something sent for this instruction has no known outcome. */
function hasOpenSettlement(ix: Instruction): boolean {
  return Boolean(ix.unconfirmedTx || ix.unconfirmedCircleTx || ix.circleIdempotencyKey)
}

/** What is known about this instruction's open settlement, from whichever rail holds it. */
async function readOpenSettlement(ix: Instruction, agent: PlatformAgent | undefined): Promise<
  | { status: 'success'; txHash: string; explorerUrl: string }
  | { status: 'reverted' | 'denied' | 'unknown'; reason: string }
> {
  if (ix.unconfirmedTx) {
    const seen = await settlement.receiptStatus(ix.unconfirmedTx, agent, { nonce: ix.unconfirmedNonce, from: ix.unconfirmedFrom })
    if (seen.status === 'unknown') return seen
    if (seen.status === 'reverted') return { status: 'reverted', reason: `tx ${seen.txHash} reverted on-chain` }
    // Its nonce is used and no RPC has it: it moved nothing and never will, the same as a revert.
    if (seen.status === 'dropped') return { status: 'reverted', reason: seen.reason }
    return { status: 'success', txHash: seen.txHash, explorerUrl: seen.explorerUrl }
  }
  if (ix.unconfirmedCircleTx) return settlement.circleStatus(ix.unconfirmedCircleTx)
  return { status: 'unknown', reason: 'the request to Circle was not answered, so there is no transfer to read yet' }
}

function clearUnconfirmedTx(ix: Instruction) {
  delete ix.unconfirmedTx
  delete ix.unconfirmedFrom
  delete ix.unconfirmedNonce
  delete ix.unconfirmedAt
}

function closeOpenSettlement(ix: Instruction) {
  clearUnconfirmedTx(ix)
  delete ix.unconfirmedCircleTx
  delete ix.circleIdempotencyKey
}

/**
 * Close a held settlement that moved nothing, leaving a claim for returnToHuman to give back: the
 * hold kept one on the day it went out, and if the day has turned, today has not counted it.
 */
function closeHeld(ix: Instruction, agent: PlatformAgent | undefined, total: number) {
  const heldOn = ix.capHeldOn
  closeOpenSettlement(ix)
  delete ix.capHeldOn
  delete ix.explorerUrl
  if (heldOn && heldOn !== todayUTC() && agent) addSpend(agent, total)
}

/**
 * A held settlement turned out to have moved nothing. The human who clicked Approve consented to
 * a read, not to a fresh payment around whatever refused this one, so nothing is sent in that
 * click: it goes back to a human with the reason named and the cap given back, and the next
 * approval is an informed one.
 */
function returnHeldNotSent(ix: Instruction, agent: PlatformAgent | undefined, total: number, reason: string, enforcedBy: Instruction['enforcedBy']) {
  closeHeld(ix, agent, total)
  const fmt = total < 0.01 ? total.toFixed(4) : total.toFixed(2)
  returnToHuman(ix, agent, total, `The held settlement did not go through (${reason}). Nothing settled and nothing was sent by this approval. Approve again to pay it afresh, knowing that.`, enforcedBy)
  if (agent) pushActivity(agent, `Held settlement of ${fmt} USDC to ${short(ix.payee)} did not go through: ${reason}`)
  save(state)
  return ix
}

/** Record a settlement that turned out to have landed while it was held. Counted once: by the
 *  claim the hold kept, or by the approval that preceded it. */
function recordLanded(ix: Instruction, agent: PlatformAgent | undefined, seen: { txHash: string; explorerUrl: string }, policyDecision: string, total: number) {
  closeOpenSettlement(ix)
  delete ix.capHeldOn
  const fmt = total < 0.01 ? total.toFixed(4) : total.toFixed(2)
  ix.status = 'executed_onchain'
  ix.txHash = seen.txHash
  ix.explorerUrl = seen.explorerUrl
  stampAppLayerAudit(ix, policyDecision)
  ix.policyNote = `Settled ${fmt} USDC: tx ${short(seen.txHash)} landed after the wait for its receipt ended, and no second payment was sent. Reason recorded in the app-layer audit record.`
  if (agent) pushActivity(agent, `Settlement confirmed late: ${fmt} USDC to ${short(ix.payee)} (tx ${short(seen.txHash)})`)
  save(state)
}

/** Give back the claim a hold kept, on the day it was counted. */
function releaseHeldCap(ix: Instruction, agent: PlatformAgent | undefined, amount: number) {
  if (agent && ix.capHeldOn === todayUTC()) reverseSpend(agent, amount)
  delete ix.capHeldOn
}

/** How long a transaction nobody has a receipt for blocks a rejection. */
export const UNCONFIRMED_REJECT_AFTER_MS = 24 * 3_600_000

/**
 * Reject a pending instruction.
 *
 * This is the cancel half of "edit a payment before approving it". Editing does not mutate
 * the original: the console rejects it and creates a replacement, so no record is ever
 * rewritten after the fact and the audit trail keeps both the thing that was proposed and
 * the thing that was actually authorised.
 *
 * Only `pending_approval` can be rejected, which is also why nothing has to be unwound
 * here: a `pending_approval` instruction holds no claim on the daily cap. That was written
 * as "has never committed against the daily cap", which was not the same sentence and was
 * not true: an instruction that was approved, settled and REVERTED comes back here through
 * returnToHuman, having committed once. It holds no claim because returnToHuman gives the
 * cap back on the way, not because it never took any.
 *
 * The exception is a held settlement, which may have moved money. Rejecting one used to record
 * a payment that landed as rejected, forever, and the console's edit flow then paid again. So
 * the transaction is read first. Landed: it is recorded as settled, and the answer is an error,
 * because the caller was about to treat this as cancelled. Reverted: the claim goes back and the
 * rejection stands. Unknown: refused until a day has passed, after which a human may give up on
 * it, with the hash kept on the record and the cap claim left where it is.
 *
 * Auto-approved and approved instructions do hold a claim, so they are deliberately not
 * rejectable through this path.
 */
export async function rejectInstruction(ixId: string, caller?: string, reason?: string): Promise<Instruction | { error: string }> {
  const ix = state.instructions.find((i) => i.id === ixId)
  if (!ix) return { error: 'Unknown instruction' }
  const ag = state.agents.find((a) => a.id === ix.agentId)
  if (ag && !ownsAgent(ag, caller)) return { error: 'Forbidden: not the agent owner' }
  if (ix.status !== 'pending_approval') return { error: `Cannot reject from status ${ix.status}` }
  if (hasOpenSettlement(ix)) {
    if (executingIx.has(ixId)) return { error: 'This instruction is already being executed' }
    // Held across the read, so an approve-and-execute cannot start on it meanwhile.
    executingIx.add(ixId)
    try {
      const total = ix.amountUsd * ix.count
      const seen = await readOpenSettlement(ix, ag)
      if (ix.status !== 'pending_approval') return { error: `Cannot reject from status ${ix.status}` }
      if (seen.status === 'success') {
        recordLanded(ix, ag, seen, 'landed_while_held', total)
        return { error: `Cannot reject: this payment already landed (tx ${seen.txHash}) and is now recorded as settled. Check it before you send it again.` }
      }
      if (seen.status === 'unknown') {
        const since = Date.parse(ix.unconfirmedAt ?? ix.createdAt)
        if (Date.now() - since < UNCONFIRMED_REJECT_AFTER_MS) {
          return {
            error: `Cannot reject yet: a settlement for this instruction ${ix.unconfirmedTx ? `(tx ${ix.unconfirmedTx}) ` : ''}has no known outcome, so it may have moved money (${seen.reason}). Approving reads it again and sends nothing while it is open.`,
          }
        }
        const given = ix.unconfirmedTx ?? ix.unconfirmedCircleTx
        if (given) ix.abandonedTx = given
        closeOpenSettlement(ix)
        delete ix.capHeldOn
        ix.status = 'rejected'
        ix.policyNote = `Rejected by a human with its settlement unresolved a day after it went out${given ? ` (${given})` : ''}. It may still have moved money; if it did, this record is wrong and it stays counted against the day it went out.`
        if (ag) pushActivity(ag, `Instruction ${ix.id} rejected with its settlement unresolved`)
        save(state)
        return ix
      }
      closeOpenSettlement(ix)
      releaseHeldCap(ix, ag, total)
    } finally {
      executingIx.delete(ixId)
    }
  }
  ix.status = 'rejected'
  ix.policyNote = reason?.trim() ? reason.trim().slice(0, 200) : 'Rejected by a human.'
  if (ag) pushActivity(ag, `Instruction ${ix.id} rejected by a human`)
  save(state)
  return ix
}

export function approveInstruction(ixId: string, caller?: string): Instruction | { error: string } {
  const ix = state.instructions.find((i) => i.id === ixId)
  if (!ix) return { error: 'Unknown instruction' }
  const ag = state.agents.find((a) => a.id === ix.agentId)
  if (ag && !ownsAgent(ag, caller)) return { error: 'Forbidden: not the agent owner' }
  if (ix.status !== 'pending_approval') return { error: `Cannot approve from status ${ix.status}` }
  ix.status = 'approved'
  ix.policyNote = 'Approved by a human.'
  const agent = state.agents.find((a) => a.id === ix.agentId)
  if (agent) {
    // A held settlement never gave its claim back, so this approval does not add it again.
    if (!ix.capHeldOn) addSpend(agent, ix.amountUsd * ix.count)
    pushActivity(agent, `Instruction ${ix.id} approved by a human`)
  }
  save(state)
  return ix
}

const EVM_PAYEE_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * True only when this agent actually settles through a Soroban vault.
 *
 * The vault ADDRESS is part of the test, not just the chain field, and the two must agree
 * everywhere or they disagree somewhere. An agent naming a Stellar chain with no vault
 * deployed would otherwise have its payee resolved as a G... account and then settle on the
 * Arc rails, which is precisely the cross-chain mix-up the rest of this file exists to
 * prevent. One predicate, asked by both the payee resolver and the settlement guard.
 */
function hasStellarVault(agent?: PlatformAgent): boolean {
  if (!agent?.vaultAddress) return false
  return vaultChainFor(agent)?.ecosystem === 'stellar'
}

/**
 * Resolve an instruction payee to a real address to settle to, or null.
 *  - a 0x… address -> itself, on an EVM vault
 *  - a G… account -> itself, on a Stellar vault
 *  - `agent://<idOrName>` (or a bare agent id/name) -> THAT agent's wallet address,
 *    so agent-to-agent payments settle on-chain instead of falling back to simulated.
 *
 * The address shape is decided by the PAYING vault's ecosystem, not by what the string
 * happens to look like. A Soroban vault cannot pay a 0x address and an Arc vault cannot pay
 * a G... account, so accepting either everywhere would resolve a payee the settlement path
 * then has to reject one layer deeper, wearing the wrong chain's error message. An agent://
 * payee is held to the same rule: the target's wallet has to be on the paying vault's
 * ecosystem or it is not a payee, which is the honest answer rather than a cross-chain
 * payment this product does not make.
 *
 * An agent with no vault, and every agent whose vault predates the chain field, resolves
 * exactly as before: `vaultChainFor` answers Arc for those rows.
 */
function resolvePayeeAddress(payee: string, agent?: PlatformAgent): string | null {
  const stellar = hasStellarVault(agent)
  const accepts = (v: string | undefined | null): string | null => {
    const s = (v ?? '').trim()
    if (!s) return null
    return stellar ? (isAccountId(s) ? s : null) : EVM_PAYEE_RE.test(s) ? s : null
  }
  const direct = accepts(payee)
  if (direct) return direct
  const key = payee.replace(/^agent:\/\//i, '').trim()
  if (!key) return null
  const target = state.agents.find((a) => a.id === key || a.name.toLowerCase() === key.toLowerCase())
  return accepts(target?.walletAddress)
}

// ── the audit trail on the paths that cannot emit an on-chain Memo ────────────
//
// Only the direct-EOA settlement path can route a transfer through Arc's Memo precompile,
// because only there is our signer `msg.sender`. The vault settles through the
// AgentSpendPolicy CONTRACT, Circle broadcasts from its own hosted wallet, and a batch is
// one Multicall3From contract call: on all three, an on-chain memo is impossible. Losing
// the "why" on exactly the paths a serious operator uses would be the wrong trade, so the
// same payload is recorded app-layer and labeled as app-layer.

/**
 * The app-layer equivalent of an on-chain Memo. Same structured payload the Memo path
 * commits on-chain, produced by the same encoder, so the two trails cannot drift.
 *
 * It never pretends to be a memo: the result lands on `offchainAuditId` /
 * `offchainAuditReason` (never `memoId` / `memoReason`), and the id is a readable app ref
 * rather than a bytes32, so nobody can mistake it for something to look up on arcscan.
 * Pure; exported for unit tests.
 */
export function appLayerAudit(input: MemoInput): { offchainAuditId: string; offchainAuditReason: string } {
  return {
    offchainAuditId: `a-identity:audit:ix:${input.instructionId}`,
    offchainAuditReason: memoReasonJson(input),
  }
}

/** Stamp the app-layer audit record onto a settled instruction. `policyDecision` is the
 *  status that AUTHORIZED the spend, captured before the flip to executed_*, matching what
 *  the Memo path commits on-chain. */
function stampAppLayerAudit(ix: Instruction, policyDecision: string): void {
  const record = appLayerAudit({
    agentId: ix.agentId,
    instructionId: ix.id,
    service: ix.type,
    policyDecision,
  })
  ix.offchainAuditId = record.offchainAuditId
  ix.offchainAuditReason = record.offchainAuditReason
}

/**
 * The payments a `batch` instruction really represents: `count` separate transfers of
 * `amountUsd` to the payee, NOT one transfer of the total. Returns null when the
 * instruction is not an executable batch (single action, non-positive amount, or another
 * type), in which case settlement keeps the single Memo-wrapped transfer it always used.
 * Pure; exported for unit tests.
 */
export function batchPaymentPlan(ix: Instruction, to: string): { to: string; amountUsd: number }[] | null {
  if (ix.type !== 'batch') return null
  if (!Number.isFinite(ix.count) || ix.count < 2) return null
  if (!Number.isFinite(ix.amountUsd) || ix.amountUsd <= 0) return null
  return Array.from({ length: Math.floor(ix.count) }, () => ({ to, amountUsd: ix.amountUsd }))
}

// ── session keys: the half that is safe, and the half this project refuses to build ──
//
// The ask was "route session-key settlements through executeInstruction with
// enforcedBy: 'session-key', backed by a persisted smart contract account per agent".
// One half of that is honest and is implemented below. The other half is not, and the
// reason is the rule at the top of this project, not a shortage of time.
//
// WHAT IS IMPLEMENTED. The AgentSpendPolicy vault already carries a session key. The human
// owner grants the agent's operator a UNIX expiry (`setSessionKeyExpiry`); `pay` reverts
// `SessionKeyExpired` past it, and `ownerPay` is deliberately exempt from that gate. So an
// AGENT-initiated vault settlement that lands while the vault carries a live expiry was
// authorised by a time-bounded session key, and saying so costs no new key: the operator
// is the same env-gated signer this path already uses. The claim is grounded on a read of
// the vault, never inferred from configuration, and it is never made about `ownerPay`.
//
// WHAT IS NOT IMPLEMENTED, AND WHY. The ERC-4337 flavour in `aa-wallet.ts` mints a fresh
// session-key private key per run and throws it away; it is never persisted anywhere. For
// this server to settle an instruction by SIGNING a UserOperation with such a key, the key
// would have to survive the request: in the database, in an env var, or in process memory
// across calls. That is autonomous key custody, which this project does not do, so it is
// not done here. The same rule blocks the "persisted smart contract account per agent": a
// Kernel account is only per-agent if its owner is the agent owner's own wallet, and then
// the session-key grant and the UserOperation are theirs to sign, not ours. The honest
// shape of that feature is client-side signing, and it does not live in this function.
//
// The vault IS the per-agent, persisted, on-chain bounded-authority account we actually
// have: `agent.vaultAddress` with `agent.vaultOperator` as its session key, both public,
// both already stored, neither of them a secret at rest.

/** What a vault read says about the session-key time bound. `live` is the ONLY thing that
 *  licenses an `enforcedBy: 'session-key'` claim on a settlement. */
export type SessionKeyBound =
  | { live: true; expiry: number }
  | { live: false; why: 'unsupported-chain' | 'no-read' | 'no-bound' | 'expired'; expiry?: number }

/**
 * Reduce a vault read to the one bit settlement labeling needs. Pure, so the boundaries are
 * tested rather than argued about.
 *
 * The contract's rule is that `pay` reverts when `sessionKeyExpiry != 0 && block.timestamp >
 * sessionKeyExpiry`. Two consequences are load-bearing and neither is obvious: 0 means NO
 * time bound at all (an operator whose authority never lapses, which is the opposite of a
 * session key, so it must not be labeled as one), and the expiry second itself is still
 * inside the window. A missing, malformed or unreadable value is `no-read` and never a
 * bound: a label is not upgraded on a guess.
 */
export function sessionKeyBound(
  view: { sessionKeyExpiry?: unknown; sessionKeyExpired?: unknown } | null | undefined,
  atUnix: number = Math.floor(Date.now() / 1000),
): SessionKeyBound {
  if (!view) return { live: false, why: 'no-read' }
  const expiry = view.sessionKeyExpiry
  if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry < 0) return { live: false, why: 'no-read' }
  if (expiry === 0) return { live: false, why: 'no-bound', expiry: 0 }
  // The adapter also computes `sessionKeyExpired` against its own clock. If either clock
  // says the window has closed, it has closed: the two never get to disagree in our favour.
  if (view.sessionKeyExpired === true || atUnix > expiry) return { live: false, why: 'expired', expiry }
  return { live: true, expiry }
}

/**
 * The chain calls executeInstruction makes, behind one indirection. Production always runs
 * REAL_SETTLEMENT; the seam exists so a unit test can exercise the executed / reverted
 * branches, which otherwise only run with a funded signer and a live RPC.
 */
type SettlementBackend = {
  policyPay: typeof policyPay
  policyOwnerPay: typeof policyOwnerPay
  /** One look at a transaction sent earlier and not yet confirmed. Reads only. */
  /** Routed by the agent: a settlement on a Soroban vault is read from Soroban. */
  receiptStatus: (hash: string, agent?: PlatformAgent, held?: { nonce?: number; from?: string }) => ReturnType<typeof vaultReceiptStatus>
  circleStatus: typeof circleTransferStatus
  /**
   * The vault payment for every vault the two calls above cannot reach.
   *
   * Added rather than substituted. `policyPay` and `policyOwnerPay` are the Arc adapter
   * bound to the Arc descriptor, which was right for exactly as long as a vault could only
   * be on Arc; they stay, byte for byte, for the vaults that are. A Soroban vault's C...
   * contract id went into them anyway and failed with a message about an address, so it
   * now takes this routed call instead. The RESULT shape is the same on both, which is why
   * every branch below reads exactly as it did.
   */
  payFromVault: typeof payFromVault
  circlePay: typeof circlePay
  payUsdcWithMemo: typeof payUsdcWithMemoOnchain
  payUsdcBatch: typeof payUsdcBatchOnchain
  readVault: typeof readPolicyVault
  /** The chain-routed vault read, used for the session-key label off EVM. */
  readVaultPolicy: typeof readVaultPolicy
}

const REAL_SETTLEMENT: SettlementBackend = {
  policyPay,
  policyOwnerPay,
  receiptStatus: (hash, agent, held) => vaultReceiptStatus(agent, hash, held),
  circleStatus: circleTransferStatus,
  payFromVault,
  circlePay,
  payUsdcWithMemo: payUsdcWithMemoOnchain,
  payUsdcBatch: payUsdcBatchOnchain,
  readVault: readPolicyVault,
  readVaultPolicy,
}

let settlement: SettlementBackend = REAL_SETTLEMENT

/**
 * The session-key bound on THIS agent's vault, or a labeled reason there is none to claim.
 *
 * Never throws and never blocks a settlement. An RPC that will not answer means the
 * settlement is labeled `onchain-vault`, which is what it was labeled before this existed:
 * an infrastructure hiccup must not invent a session key, and it must not lose a payment
 * either. Only called once a settlement actually has a receipt, so the round trip is spent
 * on money that moved rather than on every attempt.
 *
 * Two gates, both with reasons rather than convenience behind them:
 *
 *  - EVM and Stellar, not Algorand. Both AgentSpendPolicy implementations carry the same
 *    `SessionKeyExpired` refusal and both now surface the expiry through the vault view, so
 *    the label is available on either. The Algorand port does not exist, so a vault named
 *    on that chain is `unsupported-chain` rather than an unread bound. The REFUSAL side was
 *    never chain-gated: a `SessionKeyExpired` revert is recognised whatever the chain.
 *  - The chain's signer key must be configured. Without it the vault payment returns
 *    prepared and this path never settles for real, so there is nothing to ground a label on.
 *
 * And a deadline, because of WHERE this sits. By the time it runs the payment has already
 * moved on-chain, but the instruction has not yet been flipped to executed_onchain and the
 * TOCTOU guard still holds its id, so a read that hangs would strand a settled payment as
 * unrecorded and un-retryable. A label is worth a few seconds and not one second more.
 */
const SESSION_KEY_READ_MS = 4_000

async function readSessionKeyBound(agent: PlatformAgent, vault: string): Promise<SessionKeyBound> {
  const chain = vaultChainFor(agent)
  if (!chain || (chain.ecosystem !== 'evm' && chain.ecosystem !== 'stellar')) {
    return { live: false, why: 'unsupported-chain' }
  }
  if (!chain.signerEnvVar || !process.env[chain.signerEnvVar]) return { live: false, why: 'no-read' }
  // The deadline timer is deliberately NOT unref'd, and it was, which is a real bug rather
  // than a style point. An unref'd timer does not keep the event loop alive, so on a
  // process with nothing else pending (CI, no database pool, no open sockets) Node exits
  // the moment the vault read is the only thing outstanding: the race never settles, the
  // deadline never fires, and the caller is abandoned with a pending promise. Locally the
  // same code passed because a Postgres pool happened to hold the loop open. The guardrail
  // canary caught it: five session-key tests "cancelled by parent" on every hourly run
  // from 2026-08-30. A deadline that cannot fire is not a deadline. The timer is cleared as
  // soon as the read answers, so it never holds the process open longer than the read.
  let deadline: ReturnType<typeof setTimeout> | undefined
  const giveUp = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), SESSION_KEY_READ_MS)
  })
  try {
    // Same question, asked of whichever adapter owns this vault. The EVM read keeps its
    // own entry point because that is the one every existing test injects.
    const read =
      chain.ecosystem === 'evm' ? settlement.readVault(vault) : settlement.readVaultPolicy(agent, vault)
    return sessionKeyBound(await Promise.race([read, giveUp]))
  } catch {
    return { live: false, why: 'no-read' }
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}

/** TEST-ONLY: substitute settlement calls with fakes; returns the restore function.
 *  Production code never calls this. */
export function __setSettlementForTests(over: Partial<SettlementBackend>): () => void {
  const previous = settlement
  settlement = { ...settlement, ...over }
  return () => {
    settlement = previous
  }
}

/**
 * Execute an approved or auto-approved instruction. When the agent has an
 * on-chain policy vault, address payments settle THROUGH it - the vault enforces
 * the daily cap / auto-approve ceiling / freeze on Arc, so a disallowed payment
 * reverts on-chain (the source of truth). The server engine stays the pre-check;
 * if the vault path hits an infra error (not a policy revert) we fall back to
 * direct settlement so a chain hiccup never blocks the flow. A `batch` settles on
 * the direct path as `count` transfers in one atomic Multicall3From tx. Without a
 * signer key, execution is SIMULATED and labeled as such; the trail stays honest.
 *
 * A settlement broadcast with no receipt on any RPC is none of those. It may have landed, so
 * it never falls through to another rail: it goes back to a human with the hash (see
 * holdUnconfirmed), and the next execute reads that hash before anything else is sent. A vault
 * payment that was mined and reverted does not fall through either: the chain refused it. Nor
 * does a held settlement that turns out to have gone nowhere: the approval that read it was given
 * for a read, so that click sends nothing and the next one is an informed override.
 *
 * When the vault also carries a live SESSION KEY (a time bound the human owner granted
 * the agent's operator), an agent-initiated settlement is labeled `session-key` rather
 * than the broader `onchain-vault`, and a `SessionKeyExpired` revert is recorded as the
 * session key refusing rather than as a generic vault rejection. Both are read from the
 * chain; see the session-key block above for what this deliberately does NOT do.
 */
/** Instruction ids currently mid-execution, so a concurrent double-execute of the same
 *  instruction can't both settle (see the TOCTOU guard below). Process-local by design:
 *  it only serializes overlapping requests within this single server process. */
const executingIx = new Set<string>()

export async function executeInstruction(ixId: string, caller?: string): Promise<Instruction | { error: string }> {
  const ix = state.instructions.find((i) => i.id === ixId)
  if (!ix) return { error: 'Unknown instruction' }
  if (ix.status !== 'approved' && ix.status !== 'auto_approved')
    return { error: `Cannot execute from status ${ix.status}` }
  const agent = state.agents.find((a) => a.id === ix.agentId)
  if (agent && !ownsAgent(agent, caller)) return { error: 'Forbidden: not the agent owner' }
  // TOCTOU guard: the status flip to executed_* happens only AFTER the awaited on-chain
  // settle, so two overlapping executes of the same id could both pay. Claim the id
  // synchronously (check-and-add is atomic in single-threaded JS) and hold it across the
  // awaits; the finally at the end releases it.
  if (executingIx.has(ixId)) return { error: 'This instruction is already being executed' }
  executingIx.add(ixId)
  try {
  const total = ix.amountUsd * ix.count
  const fmt = (n: number) => (n < 0.01 ? n.toFixed(4) : n.toFixed(2))
  // Where this actually settles on-chain: a 0x… payee, or an agent:// payee
  // resolved to that agent's wallet. null -> nothing to send to -> simulated.
  const settleTo = resolvePayeeAddress(ix.payee, agent)
  // Asked once, from the same predicate the payee resolver used. A Stellar vault must never
  // fall through to the Arc rails below: those settle 0x payees from an EVM signer, and a
  // G... payee reaching them is not a fallback, it is a different chain.
  const vaultIsStellar = hasStellarVault(agent)
  // The decision that AUTHORIZED this settlement: 'auto_approved' (within policy) or
  // 'approved' (a human said yes). Captured before the status flips to executed_*, so
  // every audit payload records why the money was allowed to move, on-chain memo or not.
  const policyDecision: string = ix.status

  // An earlier settlement of this instruction has no known outcome. Read it first: if it landed
  // this instruction is settled, and if nobody can say yet, nothing more is sent. A Circle create
  // that was never answered has nothing to read yet: its key goes back to Circle below, and that
  // answers with the transfer if there is one, so no other rail runs ahead of it.
  const resumeCircle = Boolean(ix.circleIdempotencyKey && !ix.unconfirmedCircleTx && settleTo && agent?.circleWalletId)
  if (hasOpenSettlement(ix) && !resumeCircle) {
    const seen = await readOpenSettlement(ix, agent)
    if (seen.status === 'unknown') {
      const open = ix.unconfirmedTx ? `Settlement tx ${ix.unconfirmedTx} still has no receipt on any RPC` : 'The Circle transfer has still not finished'
      holdSettlement(
        ix,
        `${open} (${seen.reason}), so it may yet land. No second payment was sent and it stays counted against today's cap. Approve this again to read it again. A rejection reads it too, and waits until it is resolved.`,
        ix.enforcedBy,
      )
      save(state)
      return ix
    }
    if (seen.status === 'success') {
      recordLanded(ix, agent, seen, policyDecision, total)
      return ix
    }
    if (seen.status === 'denied') {
      closeHeld(ix, agent, total)
      returnToHuman(ix, agent, total, `Circle's hosted policy rejected this (${seen.reason}); a human must intervene.`, 'circle-agent-stack')
      if (agent) pushActivity(agent, `Circle Agent Wallet rejected ${fmt(total)} USDC to ${short(ix.payee)}: ${seen.reason}`)
      save(state)
      return ix
    }
    return returnHeldNotSent(ix, agent, total, seen.reason, ix.enforcedBy)
  }

  // Noted before the transaction is sent, and written to storage before the send: a restart inside
  // the wait for its receipt cannot lose it, because the next execute finds this hash and reads it
  // before sending anything. If that write fails nothing is sent, and `unsaved` says why, so the
  // rails below do not try to pay around it.
  let unsaved: string | undefined
  const hooks: BroadcastHooks = {
    onBroadcast: async (hash, signed) => {
      ix.unconfirmedTx = hash
      if (signed?.from) ix.unconfirmedFrom = signed.from
      if (signed?.nonce !== undefined) ix.unconfirmedNonce = signed.nonce
      ix.unconfirmedAt = new Date().toISOString()
      const saved = await saveDurably(state)
      if (!saved.ok) {
        clearUnconfirmedTx(ix)
        unsaved = saved.reason
        throw new Error(saved.reason)
      }
    },
  }
  /** Back to a human when the hold could not be saved. Nothing was sent, so the cap goes back too. */
  const refuseUnsaved = (why: string) => {
    returnToHuman(ix, agent, total, `The server could not save this settlement's hold (${why}), so nothing was sent. Approve it again when storage is back.`, ix.enforcedBy)
    if (agent) pushActivity(agent, `Settlement of ${fmt(total)} USDC not sent: its hold could not be saved`)
    save(state)
    return ix
  }
  /** An attempt answered with a known outcome leaves nothing open. */
  const settledAttempt = (res: unknown) => {
    if (!isUnconfirmed(res)) clearUnconfirmedTx(ix)
  }

  // On-chain policy vault: the chain enforces the policy. Agent-initiated
  // (auto-approved) payments go through pay(); human-approved ones through
  // ownerPay() (override). A policy revert is an authoritative rejection; an
  // infra error falls through to direct settlement below.
  // A human override uses the owner-only ownerPay(), which the SERVER can only sign
  // when the vault owner is the server signer (== operator). When owner is the human's
  // own wallet (the intended separation), the server can't sign as owner, so a human
  // override can't settle through the vault here - it falls through to direct settlement
  // below (an owner-signed ownerPay would come from the human's wallet client-side).
  const serverCanOwnerPay =
    !agent?.vaultOwner || !agent?.vaultOperator || agent.vaultOwner.toLowerCase() === agent.vaultOperator.toLowerCase()
  // What the vault said when it neither settled nor was a decided refusal, for the Stellar note.
  let vaultAnswer: string | undefined
  if (settleTo && agent?.vaultAddress && !resumeCircle && !(ix.status === 'approved' && !serverCanOwnerPay)) {
    const humanApproved = ix.status === 'approved'
    // Arc keeps the two calls it always made; anything else is routed by the vault's chain.
    const res = isEvmVault(agent)
      ? humanApproved
        ? await settlement.policyOwnerPay(agent.vaultAddress, settleTo, total, undefined, hooks)
        : await settlement.policyPay(agent.vaultAddress, settleTo, total, undefined, hooks)
      : await settlement.payFromVault(agent, agent.vaultAddress, settleTo, total, humanApproved, hooks)
    settledAttempt(res)
    if (unsaved) return refuseUnsaved(unsaved)
    if (res.executed) {
      // Which authority let this through. Asked ONLY now, with a receipt in hand, and only
      // on the agent path: `ownerPay` is owner-only and the contract exempts it from the
      // session-key gate on purpose, so a human override is never labeled session-key no
      // matter what expiry the vault happens to carry.
      const bound = humanApproved ? null : await readSessionKeyBound(agent, agent.vaultAddress)
      const live = bound?.live === true ? bound : null
      ix.status = 'executed_onchain'
      ix.txHash = res.txHash
      ix.explorerUrl = res.explorerUrl
      // `session-key` is the narrower, truer claim when the vault proved a live time bound;
      // `onchain-vault` otherwise, including every case where we could not read one. It is
      // never widened on an assumption.
      ix.enforcedBy = live ? 'session-key' : 'onchain-vault'
      // The vault is a contract, so no on-chain Memo is possible here: keep the same
      // structured "why", app-layer and labeled as such.
      stampAppLayerAudit(ix, policyDecision)
      ix.policyNote = live
        ? `Settled ${fmt(total)} USDC through the on-chain policy vault under a live session key (agent, within policy). ` +
          `The vault carried a session-key expiry of ${new Date(live.expiry * 1000).toISOString()} when this settled, and pay() reverts SessionKeyExpired past it. ` +
          'Reason recorded in the app-layer audit record; the vault contract cannot emit an on-chain Memo.'
        : `Settled ${fmt(total)} USDC through the on-chain policy vault (${humanApproved ? 'human override' : 'agent, within policy'}). Reason recorded in the app-layer audit record; the vault contract cannot emit an on-chain Memo.`
      pushActivity(
        agent,
        `On-chain vault settled ${fmt(total)} USDC to ${short(settleTo)} (tx ${short(res.txHash)})` +
          (live ? ' under a live session key' : ''),
      )
      save(state)
      return ix
    }
    // Broadcast, and no RPC has the receipt: the payment may have landed, so neither Circle
    // nor direct settlement below may send it again.
    if (isUnconfirmed(res)) return holdUnconfirmed(ix, agent, res, 'onchain-vault')
    // Mined and reverted: the chain refused it, whatever the reason was (a freeze or a filled cap
    // after a lagging host's simulate passed). The receipt does not carry a typed name, and
    // sending the same payment from a rail with no vault would step around that refusal.
    if (res.reverted && res.minedTx) {
      returnToHuman(ix, agent, total, `The on-chain policy vault payment reverted (tx ${res.minedTx}); nothing settled and nothing fell through to another rail. A human must intervene.`, 'onchain-vault')
      pushActivity(agent, `On-chain vault payment reverted: ${fmt(total)} USDC to ${short(settleTo)} (tx ${short(res.minedTx)})`)
      save(state)
      return ix
    }
    if (res.reverted && VAULT_POLICY_ERRORS.has(res.reason)) {
      // A SessionKeyExpired revert is the session-key gate itself saying no: the agent's
      // authority lapsed, which is a different fact from the cap or the allowlist refusing
      // and needs a different human action. Recorded from the revert alone, so it does not
      // depend on the read above having worked.
      const bySessionKey = res.reason === 'SessionKeyExpired'
      returnToHuman(
        ix,
        agent,
        total,
        bySessionKey
          ? 'The agent session key has expired on-chain (SessionKeyExpired); nothing settled. A human must extend or revoke the session key, or approve this payment as an owner override.'
          : `On-chain policy vault rejected this (${res.reason}); a human must intervene.`,
        bySessionKey ? 'session-key' : 'onchain-vault',
      )
      pushActivity(agent, `On-chain vault rejected ${fmt(total)} USDC to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    vaultAnswer = res.reason
    // Nothing was broadcast (no key / a simulate that failed on infra) - fall through to direct settlement.
  }

  /**
   * A Stellar vault's payment stops here, whatever happened above.
   *
   * Three ways to arrive: the vault branch was skipped because a human override needs an
   * owner signature we do not hold, nothing was sent (no signer, or a prepared call), or the
   * refusal was not one of the typed policy errors. A payment that was sent and is pending
   * never gets here: it is held above with its hash. Every one of them used to continue into the Circle and direct
   * rails below, which settle on Arc from an EVM signer. Reaching those with a G... payee
   * cannot succeed, and the shape of the bug that would produce is the worst kind: a
   * payment recorded as settled on a chain it never touched.
   *
   * So it goes back to the human with the reason, and the day's budget goes back with it.
   */
  if (vaultIsStellar && settleTo && agent?.vaultAddress) {
    const why =
      ix.status === 'approved'
        ? 'A human override on this vault is owner_pay, which only the owner wallet can sign; this server holds the operator key. ' +
          'Sign it with POST /api/stellar/vault/prepare and POST /api/stellar/vault/submit.'
        : `The Soroban vault did not settle it${vaultAnswer ? ` (${vaultAnswer})` : ''}.`
    returnToHuman(
      ix,
      agent,
      total,
      `${why} Nothing is recorded as settled and nothing fell through to another chain: this agent's vault is on ` +
        `${vaultChainFor(agent)?.name ?? 'Stellar'} and its payee is a Stellar account, which the Arc rails cannot pay.`,
      'onchain-vault',
    )
    pushActivity(agent, `Stellar vault could not settle ${fmt(total)} USDC to ${short(settleTo)}; returned to a human`)
    save(state)
    return ix
  }

  // Circle Agent Wallet: the agent's USDC lives in a Circle-managed wallet whose
  // hosted policy engine screens every transfer at the wallet layer (sanctions /
  // allow-block / freeze). A screening DENY is an authoritative rejection (like a
  // vault revert). No creds or a transfer that ended FAILED falls through to direct settlement,
  // and a transfer Circle may still complete holds here, because falling through would pay twice.
  // Vault-first by design: an agent with a vault settles there; this runs when the
  // agent has a Circle wallet (and, as a resilience bonus, if the vault infra-failed).
  if (settleTo && agent?.circleWalletId) {
    // Written before the call, so a restart with this request open sends the same key again. A
    // key that is already here went out with no known answer, so this is a resend, and only a
    // terminal answer about the transfer itself may end it.
    const resumed = Boolean(ix.circleIdempotencyKey)
    ix.circleIdempotencyKey ??= randomUUID()
    const saved = await saveDurably(state)
    if (!saved.ok && !resumed) {
      delete ix.circleIdempotencyKey
      return refuseUnsaved(saved.reason)
    }
    const res = await settlement.circlePay(agent.circleWalletId, settleTo, total, undefined, { idempotencyKey: ix.circleIdempotencyKey, resumed })
    if ('pending' in res) return holdCircle(ix, agent, res)
    closeOpenSettlement(ix)
    // A transfer that was held and has now ended without moving anything is the same case as a
    // held settlement that reverted: the human consented to a read, so nothing is sent here.
    if (resumed && !res.executed && !res.rejected) return returnHeldNotSent(ix, agent, total, res.reason, 'circle-agent-stack')
    if (res.executed) {
      ix.status = 'executed_onchain'
      ix.txHash = res.txHash
      ix.explorerUrl = res.explorerUrl
      ix.enforcedBy = 'circle-agent-stack'
      // Circle broadcasts from its own hosted wallet, so we cannot wrap the transfer in a
      // Memo: same structured "why", recorded app-layer.
      stampAppLayerAudit(ix, policyDecision)
      ix.policyNote = `Settled ${fmt(total)} USDC through the Circle Agent Wallet (hosted policy screened + approved). Reason recorded in the app-layer audit record; Circle broadcasts from its own wallet, so there is no on-chain Memo.`
      pushActivity(agent, `Circle Agent Wallet settled ${fmt(total)} USDC to ${short(settleTo)} (tx ${short(res.txHash)})`)
      save(state)
      return ix
    }
    if (res.rejected) {
      returnToHuman(ix, agent, total, `Circle's hosted policy rejected this (${res.reason}); a human must intervene.`, 'circle-agent-stack')
      pushActivity(agent, `Circle Agent Wallet rejected ${fmt(total)} USDC to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    // Not a policy rejection, and nothing moved (no creds, a refused create, FAILED or
    // CANCELLED) - fall through to direct settlement.
  }

  // Direct settlement when we have a resolved Arc address and a signer is configured.
  // The server signer is an EOA, so this path (unlike the vault, a smart contract) can
  // route the transfer through Arc's `Memo` precompile - attaching an on-chain,
  // indexable audit trail of WHY the agent paid. On a chain without a Memo precompile,
  // payUsdcWithMemoOnchain degrades cleanly to a bare transfer.
  if (settleTo) {
    // A `batch` instruction is `count` payments, not one payment of the total. Settle it
    // as `count` real USDC transfers in ONE atomic Arc tx (Multicall3From, allowFailure
    // false), so the chain shows what actually happened and either all of them land or
    // none do. The policy ladder already ran at creation and counted the batch as its full
    // `count`; this only changes HOW an already-authorized batch settles.
    const plan = batchPaymentPlan(ix, settleTo)
    if (plan) {
      // Credential-gated and hardened inside the adapter, but a transport blowing up must
      // not take the whole execute with it: an unavailable adapter degrades to the single
      // Memo-wrapped transfer below, exactly as before this path existed.
      let batch: Awaited<ReturnType<typeof payUsdcBatchOnchain>> | null = null
      try {
        batch = await settlement.payUsdcBatch(plan, undefined, hooks)
      } catch {
        batch = null
      }
      if (unsaved) return refuseUnsaved(unsaved)
      // A throw after the hash was noted is a batch that may have gone out, not an unavailable
      // adapter, so it must not degrade to the single transfer below.
      if (batch === null && ix.unconfirmedTx) {
        return holdUnconfirmed(ix, agent, { executed: false, reverted: false, unconfirmed: true, txHash: ix.unconfirmedTx, explorerUrl: ix.explorerUrl ?? '', reason: 'the batch call failed after it was signed' }, 'server')
      }
      if (batch) settledAttempt(batch)
      if (batch?.executed) {
        ix.status = 'executed_onchain'
        ix.txHash = batch.txHash
        ix.explorerUrl = batch.explorerUrl
        ix.enforcedBy = 'server'
        // Multicall3From is a contract call, so its subcalls cannot go through the Memo
        // precompile: same structured "why", recorded app-layer.
        stampAppLayerAudit(ix, policyDecision)
        // Report what the receipt covered, not what we planned to send.
        ix.policyNote =
          `Settled ${batch.count} USDC payments of ${fmt(ix.amountUsd)} (${fmt(batch.totalUsd)} total) atomically in one Arc tx. ` +
          'Reason recorded in the app-layer audit record; a batched contract call cannot emit an on-chain Memo.'
        if (agent) {
          pushActivity(
            agent,
            `Batch settled ${batch.count} USDC payments (${fmt(batch.totalUsd)} total) to ${short(settleTo)} in one Arc tx (tx ${short(batch.txHash)})`,
          )
        }
        save(state)
        return ix
      }
      if (isUnconfirmed(batch)) return holdUnconfirmed(ix, agent, batch, 'server')
      if (batch && 'reverted' in batch && batch.reverted) {
        // Broadcast but reverted. The batch is all-or-nothing, so nothing moved, and a
        // reverted broadcast is never reported as executed: back to the human, and NOT
        // retried as a single transfer (that would be a different settlement).
        returnToHuman(ix, agent, total, `Batch settlement reverted on-chain (${batch.reason}); nothing settled, a human must intervene.`, 'server')
        if (agent) pushActivity(agent, `Batch settlement reverted on Arc to ${short(settleTo)}: ${batch.reason}`)
        save(state)
        return ix
      }
      // Prepared (no signer) or the adapter was unavailable: nothing was broadcast, so
      // fall through to the single-transfer path and its labeled simulation.
    }

    const res = await settlement.payUsdcWithMemo(settleTo, total, {
      agentId: ix.agentId,
      instructionId: ix.id,
      service: ix.type,
      policyDecision,
    }, undefined, hooks)
    settledAttempt(res)
    if (unsaved) return refuseUnsaved(unsaved)
    if (res.executed) {
      ix.status = 'executed_onchain'
      ix.txHash = res.txHash
      ix.explorerUrl = res.explorerUrl
      ix.enforcedBy = 'server'
      ix.memoId = res.memoId
      ix.memoReason = res.memo
      ix.policyNote = res.memoId
        ? `Settled ${fmt(total)} USDC on Arc with an on-chain Memo audit trail (why: ${ix.type}, ${short(res.memoId)}).`
        : `Settled ${fmt(total)} USDC on Arc.`
      if (agent) pushActivity(agent, `Settled ${total.toFixed(4)} USDC on Arc to ${short(settleTo)} (tx ${short(res.txHash)})${res.memoId ? ` · memo ${short(res.memoId)}` : ''}`)
      save(state)
      return ix
    }
    // Broadcast with no receipt is not "no signer" below, which is what it would read as.
    if (isUnconfirmed(res)) return holdUnconfirmed(ix, agent, res, 'server')
    // The settlement was BROADCAST but reverted on-chain (e.g. insufficient balance) - never
    // mark it executed. Kick it back to the human, exactly like an on-chain policy rejection.
    if ('reverted' in res && res.reverted) {
      returnToHuman(ix, agent, total, `On-chain settlement reverted (${res.reason}); a human must intervene.`, 'server')
      if (agent) pushActivity(agent, `Settlement reverted on Arc to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    ix.policyNote = 'No signer configured; settlement simulated.'
  }

  ix.status = 'executed_simulated'
  if (!settleTo) ix.policyNote = 'Executed as a testnet simulation (payee has no Arc address to settle to).'
  if (agent) pushActivity(agent, `Executed (simulated) ${ix.type} of $${total.toFixed(2)}`)
  save(state)
  return ix
  } finally {
    executingIx.delete(ixId)
  }
}

export function listInstructions(agentId?: string): Instruction[] {
  return agentId ? state.instructions.filter((i) => i.agentId === agentId) : state.instructions
}

/** Instructions across every agent the caller owns (for the unscoped list read). */
export function listInstructionsForOwner(caller?: string): Instruction[] {
  if (!caller) return []
  const mine = new Set(state.agents.filter((a) => a.owner === caller).map((a) => a.id))
  return state.instructions.filter((i) => mine.has(i.agentId))
}

/** Read-access decision for an agent-scoped GET: only the owner may read its private
 *  config (policy, vault, treasury, Circle wallet, payment history). Public reads
 *  (identity resolve, reputation, marketplace) do NOT go through this. */
export function agentAccess(agentId: string, caller?: string): 'ok' | 'unknown' | 'forbidden' {
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return 'unknown'
  return ownsAgent(agent, caller) ? 'ok' : 'forbidden'
}

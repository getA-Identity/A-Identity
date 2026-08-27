/**
 * Spend instructions: the pre-flight policy ladder, create/approve/reject, and the
 * layered settlement paths (on-chain vault, Circle Agent Wallet, direct with memo).
 * Layering: L2 domain module; imports ./core.js and flat ../ modules only.
 */
import {
  state, save, id, ownsAgent, dailySpent, addSpend, nextUtcMidnight, pushActivity, short, cap,
  type Permissions, type Instruction, type InstructionType,
} from './core.js'
import { policyPay, policyOwnerPay, payUsdcWithMemoOnchain, payUsdcBatchOnchain, memoReasonJson } from '../arc-contracts.js'
import type { MemoInput } from '../arc-contracts.js'
import { circlePay } from '../circle-agent.js'

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
 * Reject a pending instruction.
 *
 * This is the cancel half of "edit a payment before approving it". Editing does not mutate
 * the original: the console rejects it and creates a replacement, so no record is ever
 * rewritten after the fact and the audit trail keeps both the thing that was proposed and
 * the thing that was actually authorised.
 *
 * Only `pending_approval` can be rejected, which is also why nothing has to be unwound
 * here: a pending instruction has never committed against the daily cap. Auto-approved and
 * approved instructions have, so they are deliberately not rejectable through this path.
 */
export function rejectInstruction(ixId: string, caller?: string, reason?: string): Instruction | { error: string } {
  const ix = state.instructions.find((i) => i.id === ixId)
  if (!ix) return { error: 'Unknown instruction' }
  const ag = state.agents.find((a) => a.id === ix.agentId)
  if (ag && !ownsAgent(ag, caller)) return { error: 'Forbidden: not the agent owner' }
  if (ix.status !== 'pending_approval') return { error: `Cannot reject from status ${ix.status}` }
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
    addSpend(agent, ix.amountUsd * ix.count)
    pushActivity(agent, `Instruction ${ix.id} approved by a human`)
  }
  save(state)
  return ix
}

/**
 * Resolve an instruction payee to a real Arc address to settle to, or null.
 *  - a 0x… address -> itself
 *  - `agent://<idOrName>` (or a bare agent id/name) -> THAT agent's wallet address,
 *    so agent-to-agent payments settle on-chain instead of falling back to simulated.
 */
function resolvePayeeAddress(payee: string): string | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(payee)) return payee
  const key = payee.replace(/^agent:\/\//i, '').trim()
  if (!key) return null
  const target = state.agents.find((a) => a.id === key || a.name.toLowerCase() === key.toLowerCase())
  return target?.walletAddress && /^0x[0-9a-fA-F]{40}$/.test(target.walletAddress) ? target.walletAddress : null
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

/**
 * The chain calls executeInstruction makes, behind one indirection. Production always runs
 * REAL_SETTLEMENT; the seam exists so a unit test can exercise the executed / reverted
 * branches, which otherwise only run with a funded signer and a live RPC.
 */
type SettlementBackend = {
  policyPay: typeof policyPay
  policyOwnerPay: typeof policyOwnerPay
  circlePay: typeof circlePay
  payUsdcWithMemo: typeof payUsdcWithMemoOnchain
  payUsdcBatch: typeof payUsdcBatchOnchain
}

const REAL_SETTLEMENT: SettlementBackend = {
  policyPay,
  policyOwnerPay,
  circlePay,
  payUsdcWithMemo: payUsdcWithMemoOnchain,
  payUsdcBatch: payUsdcBatchOnchain,
}

let settlement: SettlementBackend = REAL_SETTLEMENT

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
  const settleTo = resolvePayeeAddress(ix.payee)
  // The decision that AUTHORIZED this settlement: 'auto_approved' (within policy) or
  // 'approved' (a human said yes). Captured before the status flips to executed_*, so
  // every audit payload records why the money was allowed to move, on-chain memo or not.
  const policyDecision: string = ix.status

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
  if (settleTo && agent?.vaultAddress && !(ix.status === 'approved' && !serverCanOwnerPay)) {
    const humanApproved = ix.status === 'approved'
    const res = humanApproved
      ? await settlement.policyOwnerPay(agent.vaultAddress, settleTo, total)
      : await settlement.policyPay(agent.vaultAddress, settleTo, total)
    if (res.executed) {
      ix.status = 'executed_onchain'
      ix.txHash = res.txHash
      ix.explorerUrl = res.explorerUrl
      ix.enforcedBy = 'onchain-vault'
      // The vault is a contract, so no on-chain Memo is possible here: keep the same
      // structured "why", app-layer and labeled as such.
      stampAppLayerAudit(ix, policyDecision)
      ix.policyNote = `Settled ${fmt(total)} USDC through the on-chain policy vault (${humanApproved ? 'human override' : 'agent, within policy'}). Reason recorded in the app-layer audit record; the vault contract cannot emit an on-chain Memo.`
      pushActivity(agent, `On-chain vault settled ${fmt(total)} USDC to ${short(settleTo)} (tx ${short(res.txHash)})`)
      save(state)
      return ix
    }
    if (res.reverted && VAULT_POLICY_ERRORS.has(res.reason)) {
      ix.status = 'pending_approval'
      ix.enforcedBy = 'onchain-vault'
      ix.policyNote = `On-chain policy vault rejected this (${res.reason}); a human must intervene.`
      pushActivity(agent, `On-chain vault rejected ${fmt(total)} USDC to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    // Not a policy revert (no key / infra error) - fall through to direct settlement.
  }

  // Circle Agent Wallet: the agent's USDC lives in a Circle-managed wallet whose
  // hosted policy engine screens every transfer at the wallet layer (sanctions /
  // allow-block / freeze). A screening DENY is an authoritative rejection (like a
  // vault revert); no creds / infra / timeout falls through to direct settlement.
  // Vault-first by design: an agent with a vault settles there; this runs when the
  // agent has a Circle wallet (and, as a resilience bonus, if the vault infra-failed).
  if (settleTo && agent?.circleWalletId) {
    const res = await settlement.circlePay(agent.circleWalletId, settleTo, total)
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
      ix.status = 'pending_approval'
      ix.enforcedBy = 'circle-agent-stack'
      ix.policyNote = `Circle's hosted policy rejected this (${res.reason}); a human must intervene.`
      pushActivity(agent, `Circle Agent Wallet rejected ${fmt(total)} USDC to ${short(settleTo)}: ${res.reason}`)
      save(state)
      return ix
    }
    // Not a policy rejection (no creds / infra) - fall through to direct settlement.
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
        batch = await settlement.payUsdcBatch(plan)
      } catch {
        batch = null
      }
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
      if (batch && 'reverted' in batch && batch.reverted) {
        // Broadcast but reverted. The batch is all-or-nothing, so nothing moved, and a
        // reverted broadcast is never reported as executed: back to the human, and NOT
        // retried as a single transfer (that would be a different settlement).
        ix.status = 'pending_approval'
        ix.enforcedBy = 'server'
        ix.policyNote = `Batch settlement reverted on-chain (${batch.reason}); nothing settled, a human must intervene.`
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
    })
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
    // The settlement was BROADCAST but reverted on-chain (e.g. insufficient balance) - never
    // mark it executed. Kick it back to the human, exactly like an on-chain policy rejection.
    if ('reverted' in res && res.reverted) {
      ix.status = 'pending_approval'
      ix.enforcedBy = 'server'
      ix.policyNote = `On-chain settlement reverted (${res.reason}); a human must intervene.`
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

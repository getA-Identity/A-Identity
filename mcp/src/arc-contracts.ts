/**
 * Arc on-chain binding — now a THIN layer over the generic multichain engine.
 *
 * Arc is just "the first descriptor the adapter serves": the real logic (identity
 * register, ERC-8183 escrow, USDC settlement, the AgentSpendPolicy vault, ERC-8004
 * KYA attestation) lives in `chains/evm/adapter.ts` and is driven by the Arc descriptor
 * in `chains/registry.ts`. This file keeps the exact same public API every other module
 * imports, so nothing downstream changed; adding another EVM chain is now a registry
 * entry, not a copy of this file. See ../../MULTICHAIN-STRATEGY.md.
 *
 * Reads run live with no key. Writes stay env-gated behind ARC_SIGNER_KEY and
 * human-on-the-loop: nothing broadcasts unless a key is present and the caller
 * explicitly asks to execute. Gas is paid in USDC (~0.006 USDC per tx).
 */
import { ARC_CHAIN, createEvmAdapter, resolveRpcUrls } from './chains/index.js'
import { readValidationOn } from './validation-registry.js'
import type { MemoInput } from './chains/evm/memo.js'

export type { MemoInput } from './chains/evm/memo.js'
/** The canonical structured "why" payload for a settlement. Re-exported here so the
 *  platform layer can record it app-layer on the paths that cannot emit an on-chain
 *  Memo (the vault contract, Circle, batched Multicall3From) without reaching past the
 *  flat module boundary, and without restating the shape. */
export { memoReasonJson } from './chains/evm/memo.js'

/** The Arc adapter — the same engine any EVM chain uses, bound to the Arc descriptor. */
const arc = createEvmAdapter(ARC_CHAIN)

// ── config (derived from the single source of truth in chains/registry.ts) ────────

/** Arc primary RPC (not env-overridden). */
export const ARC_RPC: string = ARC_CHAIN.rpcUrls[0]
/** Arc block explorer base URL. */
export const ARC_EXPLORER: string = ARC_CHAIN.explorer as string
/** Every Arc RPC, primary first (env-overridable via ARC_RPC_URL), for a fallback transport. */
export const ARC_RPCS: string[] = resolveRpcUrls(ARC_CHAIN, process.env)

/** Deployed on Arc Testnet (docs.arc.io). Typed as addresses for viem call sites. */
export const CONTRACTS = {
  identityRegistry: ARC_CHAIN.contracts.identityRegistry as `0x${string}`,
  reputationRegistry: ARC_CHAIN.contracts.reputationRegistry as `0x${string}`,
  validationRegistry: ARC_CHAIN.contracts.validationRegistry as `0x${string}`,
  agenticCommerce: ARC_CHAIN.contracts.agenticCommerce as `0x${string}`,
  usdc: ARC_CHAIN.contracts.usdc as `0x${string}`,
} as const

// ── public API (unchanged signatures, delegating to the Arc adapter) ──────────────

/** Read the real ERC-8004 registry and ERC-8183 commerce contracts, live. */
export const readArcContracts = () => arc.readContracts()

/**
 * Register an agent on the real ERC-8004 IdentityRegistry. Without a signer key it
 * returns the exact prepared call; with one, it broadcasts and returns the tx hash
 * plus the minted agent id (parsed from the Transfer event).
 */
export const registerAgentOnchain = (metadataUri: string, env: NodeJS.ProcessEnv = process.env) =>
  arc.registerAgent(metadataUri, env)

/** Create an ERC-8183 job (escrow-based agentic commerce). Prepared without a key. */
export const createJobOnchain = (
  input: { provider: string; evaluator: string; description: string; expiresInHours?: number },
  env: NodeJS.ProcessEnv = process.env,
) => arc.createJob(input, env)

/**
 * Run the FULL ERC-8183 escrow lifecycle in one shot (6 real txs). Prepared without a key.
 * `outcome: 'complete'` (default) releases the escrow to the provider on delivery;
 * `outcome: 'refund'` disputes the deliverable and refunds the client (buyer protection).
 */
export const runEscrowJobDemo = (
  input: { budgetUsd?: number; description?: string; outcome?: 'complete' | 'refund' } = {},
  env: NodeJS.ProcessEnv = process.env,
) => arc.runEscrowDemo(input, env)

/** Evaluator disputes a job: rejects the deliverable, refunding the client on-chain. */
export const rejectJobOnchain = (jobId: bigint, reason: string, env: NodeJS.ProcessEnv = process.env) =>
  arc.rejectJob(jobId, reason, env)

/** Reclaim escrow for the client after a job's deadline (expiry refund). */
export const claimJobRefundOnchain = (jobId: bigint, env: NodeJS.ProcessEnv = process.env) =>
  arc.claimJobRefund(jobId, env)

/** Read a job's live on-chain state (status, parties, budget). No key needed. */
export const readJobOnchain = (jobId: bigint, env: NodeJS.ProcessEnv = process.env) =>
  arc.readJob(jobId, env)

/** Lock a task's escrow ON-CHAIN at hire (createJob -> setBudget -> approve -> fund). Returns
 *  the ERC-8183 jobId. Prepared without a key. */
export const fundEscrowOnchain = (
  input: { budgetUsd?: number; description?: string },
  env: NodeJS.ProcessEnv = process.env,
) => arc.fundEscrow(input, env)

/** Release a funded escrow (submit -> complete), paying the provider. Prepared without a key. */
export const completeEscrowOnchain = (jobId: bigint, env: NodeJS.ProcessEnv = process.env) =>
  arc.completeEscrow(jobId, env)

/** Settle a payment in real USDC on Arc (ERC-20 transfer). Prepared without a key. */
export const payUsdcOnchain = (to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env) =>
  arc.payUsdc(to, amountUsd, env)

/**
 * Settle real USDC on Arc THROUGH the Memo precompile, attaching an on-chain audit
 * trail of why the agent paid ({agentId, instructionId, service, policyDecision}).
 * Falls back to a bare transfer on a chain without a Memo precompile; prepared without
 * a key. Keeps the `{ executed, txHash, explorerUrl, memoId, memo }` shape.
 */
export const payUsdcWithMemoOnchain = (
  to: string,
  amountUsd: number,
  memo: MemoInput,
  env: NodeJS.ProcessEnv = process.env,
) => arc.payUsdcWithMemo(to, amountUsd, memo, env)

/** Read the on-chain Memo audit trail (by indexed memoId/sender, block-bounded). */
export const readMemosOnchain = (
  filter: { sender?: string; memoId?: string; fromBlock?: bigint; maxBlocks?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
) => arc.readMemos(filter, env)

/** Settle many USDC transfers atomically in ONE Arc tx via Multicall3From (EOA preserved).
 *  Falls back to a sequential loop on a chain without the precompile; prepared without a key. */
export const payUsdcBatchOnchain = (
  payments: { to: string; amountUsd: number }[],
  env: NodeJS.ProcessEnv = process.env,
) => arc.payUsdcBatch(payments, env)

/** Deploy an AgentSpendPolicy vault for an agent (owner=human, operator=agent signer). */
export const deployPolicyVault = (
  input: { owner?: string; operator?: string; dailyCapUsd: number; autoApproveUsd: number },
  env: NodeJS.ProcessEnv = process.env,
) => arc.deployVault(input, env)

/** Agent-initiated payment, enforced on-chain. Reverts (with reason) if a gate fails. */
export const policyPay = (vault: string, to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env) =>
  arc.policyPay(vault, to, amountUsd, env)

/** Owner settles a human-approved payment (bypasses ceiling/allowlist/freeze). */
export const policyOwnerPay = (vault: string, to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env) =>
  arc.policyOwnerPay(vault, to, amountUsd, env)

/** Owner updates the on-chain policy (cap, auto-approve ceiling, allowlist flag). */
export const policySetPolicy = (
  vault: string,
  input: { dailyCapUsd: number; autoApproveUsd: number; allowlistEnabled: boolean },
  env: NodeJS.ProcessEnv = process.env,
) => arc.policySetPolicy(vault, input, env)

/** Owner freezes/unfreezes all agent spending. */
export const policySetFrozen = (vault: string, frozen: boolean, env: NodeJS.ProcessEnv = process.env) =>
  arc.policySetFrozen(vault, frozen, env)

/** Owner grants / extends / revokes the agent's session key (UNIX expiry in seconds;
 *  future = grant/extend, now/past = revoke, 0 = no time bound). */
export const policySetSessionExpiry = (vault: string, expiryUnix: number, env: NodeJS.ProcessEnv = process.env) =>
  arc.policySetSessionExpiry(vault, expiryUnix, env)

/** Owner adds/removes a payee from the on-chain allowlist. */
export const policySetAllowed = (vault: string, payee: string, ok: boolean, env: NodeJS.ProcessEnv = process.env) =>
  arc.policySetAllowed(vault, payee, ok, env)

/** Owner withdraws USDC from the vault. */
export const policyWithdraw = (vault: string, to: string, amountUsd: number, env: NodeJS.ProcessEnv = process.env) =>
  arc.policyWithdraw(vault, to, amountUsd, env)

/** Read the live on-chain policy + balance of a vault (no key needed). */
export const readPolicyVault = (vault: string) => arc.readVault(vault)

/**
 * Attest an agent's KYA result on the ERC-8004 ValidationRegistry (two real txs).
 * Prepared without a key. Requires our signer to own the ERC-8004 agentId.
 */
export const recordValidationOnchain = (agentId: bigint, requestUri: string, env: NodeJS.ProcessEnv = process.env, opts?: { response?: number; tag?: string }) =>
  arc.recordValidation(agentId, requestUri, env, opts)

/**
 * Read an agent's on-chain KYA validation summary on ARC (no key needed).
 *
 * Delegates to the registry-driven module so there is one implementation and one honest
 * shape, rather than an Arc path and a "other chains" path that could answer differently.
 * The result gains `supported` and `chain`; every existing caller reads `kyaCount` and is
 * unaffected. To read another chain's registry, call `readValidationOn` directly.
 */
export const readValidation = (agentId: bigint, env: NodeJS.ProcessEnv = process.env) =>
  readValidationOn(ARC_CHAIN.id, agentId, env)

/**
 * Anchor an agent's deterministic 0-1000 reputation on the ERC-8004 ReputationRegistry as a
 * signed observer attestation (score normalized to the standard's 0-100 scale; the raw score
 * + tag are committed in the feedback hash). Per ERC-8004 the validator must NOT own the
 * agent, so it uses a distinct ARC_VALIDATOR_KEY (falling back to the signer) and fails fast
 * on self-attestation. Prepared (not broadcast) without a validator key.
 */
export const recordReputationOnchain = (
  agentId: bigint,
  score: number,
  env: NodeJS.ProcessEnv = process.env,
  opts?: { validatorEnvVar?: string; tag?: string; evidenceUri?: string },
) => arc.recordReputation(agentId, score, env, opts)

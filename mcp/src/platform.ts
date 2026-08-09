/**
 * A-Identity platform backend: agents, wallets, instructions, marketplace.
 *
 * The write side of the product, kept honest:
 *  - Wallets: a real keypair is generated with viem; the PRIVATE KEY IS RETURNED
 *    ONCE and never stored. We keep only the address. No custody.
 *  - Balances: read live from the Arc testnet RPC (native USDC, 18 decimals).
 *  - Funding: via the Circle faucet (faucet.circle.com); we link, a human clicks.
 *  - On-chain registration: prepared and queued. Broadcasting a transaction
 *    needs a funded key and a human, so it stays human-on-the-loop.
 *  - Instructions (pay / purchase / rental / batch): checked against the agent's
 *    permission policy. Under the auto-approve line they auto-approve; above it
 *    they wait for a human. Execution on testnet is simulated until a signer
 *    exists, and marked as such.
 *
 * State persists to mcp/data/platform.json so restarts keep the demo alive.
 */
export type { Permissions, VelocityPolicy, Service, PlatformAgent, Wallet, InstructionType, Instruction, State, FeedbackEntry } from './platform/core.js'
export { __resetPlatformStateForTests, initState, refreshPlatformState } from './platform/core.js'
export { createWallet, recordWallet, assignWallet, getWalletBalance, createAgent, listPlatformAgents, anchorAgentOnchain } from './platform/agents.js'
export { startKyaChallenge, verifyKya, getAgentKya, revokeAgentKya } from './platform/kya.js'
export { provisionAgentVault, getAgentCirclePolicyPlan, getAgentVault, grantAgentSessionKey, provisionCircleWallet, getAgentCircleWallet, getAgentTreasury, startAgentAutoYield, stopAgentAutoYield } from './platform/vault.js'
export type { VaultSyncResult } from './platform/vault.js'
export { sanitizeVelocity, updateAgentPermissions, agentPolicy } from './platform/permissions.js'
export { getAgentActionPolicy, updateAgentActionPolicy, checkAgentAction, recordAuditOutcome, listAgentAudits, registerAgentFromManifest, agentRegistration, setBadgeVisibility, agentBadge, platformTraction, guardrailSelfCheck, agentGuardrailProfile } from './platform/guardrail.js'
export type { RegistrationResult } from './platform/guardrail.js'
export { agentReputation } from './platform/reputation.js'
export { VELOCITY_COUNTED_STATUSES, countRecentActions, evaluateSpendPreflight, spendPreflight, createInstruction, rejectInstruction, approveInstruction, executeInstruction, listInstructions, listInstructionsForOwner, agentAccess, appLayerAudit, batchPaymentPlan, __setSettlementForTests } from './platform/instructions.js'
export type { SpendPreflightCode, SpendPreflightVaultError, SpendPreflight } from './platform/instructions.js'
export { followAgent, feedbackSummary, agentFeedback, addAgentFeedback, semanticSearchAgents, consumeSemanticQuota, marketplace, marketplaceLeaderboard, platformStats } from './platform/feed.js'
export { hireAgent, postOpenTask, bidOnTask, acceptBid, listOpenTasks, deliverTask, releaseTask, disputeTask, getTask, listTasksForClient, listTasksForAgent, marketplaceCatalog } from './platform/tasks.js'
export { agentManifest, registerExternalAgent } from './platform/manifest.js'

/**
 * The browser's copy of the AgentSpendPolicy artifact, rendered from the backend's.
 *
 * The frontend is a separate package with a separate deploy and cannot import from mcp/, so
 * /app/vault/arc gets a GENERATED module instead: the ABI it encodes calls with, the creation
 * code a browser wallet deploys, and the runtime plus immutable ranges it checks a deployed
 * vault against. Pasting any of those by hand is how a page ends up deploying a build nobody
 * reviewed, so the text is rendered here from the compiled artifact, written by
 * scripts/gen-frontend-contracts.mjs, and compared byte for byte by frontend-sync.test.ts
 * and, without an mcp build, by the root scripts/check-vault-artifact.mjs.
 *
 * Lives here rather than in the generator script so the drift test renders the expected
 * text with the exact code that writes it, the same arrangement as chains/public-view.ts.
 */
import {
  AgentSpendPolicyAbi,
  AgentSpendPolicyBytecode,
  AgentSpendPolicyCompiler,
  AgentSpendPolicyDeployedBytecode,
  AgentSpendPolicyImmutableReferences,
  AgentSpendPolicySourceSha256,
} from './AgentSpendPolicy.js'

/** Where the generated module lives, from the repository root. */
export const FRONTEND_VAULT_MODULE = 'src/lib/contracts/agent-spend-policy.ts'

const GENERATED_HEADER = `/**
 * GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Source of truth: mcp/contracts/AgentSpendPolicy.sol, compiled by mcp/scripts/compile-contracts.mjs
 * Regenerate:     cd mcp && npm run compile && npm run gen:contracts
 *
 * Editing this file directly fails \`cd mcp && npm test\` (mcp/src/contracts/frontend-sync.test.ts)
 * and the root \`npm run build\` (scripts/check-vault-artifact.mjs). A browser wallet deploys
 * exactly the creation code below, so it must be the compiled, reviewed build and nothing else.
 */
`

/** Render the frontend's `src/lib/contracts/agent-spend-policy.ts` module text. */
export function renderFrontendVaultModule(): string {
  const compiler = { solc: AgentSpendPolicyCompiler.solc, optimizerRuns: AgentSpendPolicyCompiler.optimizer.runs }
  return `${GENERATED_HEADER}
/** Every function, event and custom error of the contract, as solc emitted them. */
export const AGENT_SPEND_POLICY_ABI = ${JSON.stringify(AgentSpendPolicyAbi, null, 2)} as const

/** The creation code a wallet deploys. The constructor arguments are appended ABI-encoded. */
export const AGENT_SPEND_POLICY_BYTECODE = '${AgentSpendPolicyBytecode}' as const

/**
 * The runtime code of this build with every immutable left as zero bytes. A deployed vault
 * runs this build when its code, with the ranges below set to zero, equals this exactly.
 */
export const AGENT_SPEND_POLICY_RUNTIME = '${AgentSpendPolicyDeployedBytecode}' as const

/** The byte ranges the constructor fills with the two immutables (owner and usdc), in order. */
export const AGENT_SPEND_POLICY_IMMUTABLES = ${JSON.stringify(AgentSpendPolicyImmutableReferences)} as const

/** sha256 of the Solidity source this build was compiled from. */
export const AGENT_SPEND_POLICY_SOURCE_SHA256 = '${AgentSpendPolicySourceSha256}' as const

/** The compiler and optimizer setting that produced the bytecode above. */
export const AGENT_SPEND_POLICY_COMPILER = ${JSON.stringify(compiler)} as const
`
}

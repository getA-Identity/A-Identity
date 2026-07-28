/**
 * Policy Engine v2 module, public surface.
 *
 *   import { evaluateAction, defaultActionPolicy, applyPolicyPatch } from './policy/index.js'
 *
 * Caller-agnostic by contract: nothing in this module imports a brokerage client, and the
 * engine never branches on who is asking. A caller (a Robinhood client, a card surface,
 * anything) is an adapter outside this module that normalizes its own shape into
 * NormalizedIntent. See docs/compliance-robinhood.md section 4 and
 * ../../../MULTICHAIN-STRATEGY.md for the seam this mirrors.
 */
export * from './types.js'
export * from './registry.js'
export * from './policy.js'
export * from './audit.js'
export { evaluateAction } from './engine.js'

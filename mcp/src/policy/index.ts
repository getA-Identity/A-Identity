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
export * from './compliance.js'
export * from './badge.js'
export * from './meter.js'
export * from './mcc.js'
// Phase 7, schema only. Exported so it can be reviewed and built against, and inert by
// construction: it holds types and frozen data, the `bet` surface stays `planned`, and
// bet-schema.test.ts fails if either changes.
export * from './bet-schema.js'
export { evaluateAction } from './engine.js'

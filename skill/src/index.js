/**
 * @a-identity/guardrails
 *
 * Plain ESM with no build step, on purpose: a guardrail that people are asked to trust
 * should be readable in the form it ships in, and auditable without compiling it first.
 *
 * The enforcement path is `createGuard`. Everything it needs arrives injected, so it can be
 * driven against any client and tested without an account, a network or invented market
 * data. See SKILL.md for the discipline an agent follows and README.md for what this can
 * and cannot promise.
 */
export { createGuard, classifyTool, intentFromPreview, assertNoAmbientLiveWrite, GuardConfigError } from './guard.js'
export { CALLERS, getCaller, defaultCaller, supportedCallers } from './callers.js'
export { DEFAULT_POLICY, INVARIANTS, DISCLOSURE, enforcementNote } from './defaults.js'

/**
 * Fixed guardrail defaults (Phase 2.2).
 *
 * These are the settings a user gets before they configure anything, chosen so that an
 * unconfigured install is still safe. Two of them are not settings at all: `allowMargin`
 * and `denyIsFinal` are frozen, because a guardrail an agent can talk its way past is
 * decoration.
 */

/** Sent as the initial policy when the user has none. Mirrors the backend defaults. */
export const DEFAULT_POLICY = Object.freeze({
  perActionCapUsd: 100,
  dailyCapUsd: 500,
  humanApprovalAboveUsd: 100,
  frozen: false,
  trade: Object.freeze({
    allowSymbols: [],
    denySymbols: [],
    /** Options are opt-in. Leverage should never arrive by default. */
    allowOptions: false,
    tradingHoursUtc: null,
    maxConcentrationPct: 100,
  }),
})

/**
 * Behavior the skill will not let a config file, a prompt, or an agent change.
 * Enforced in guard.js and covered by the bypass suite.
 */
export const INVARIANTS = Object.freeze({
  /** Margin means losing more than the account holds. Not offered, not flippable. */
  allowMargin: false,
  /** A DENY ends the action. There is no override path for the agent. */
  denyIsFinal: true,
  /**
   * OFF by default. A WARN means a human decides, and "the agent said yes" is not a human
   * deciding. Turning this on is a deliberate user act, and it can never satisfy a DENY.
   */
  autoExecuteOnWarn: false,
  /** The skill never reads, forwards, logs or stores a venue credential. */
  holdsVenueCredentials: false,
  /** Snapshots are gathered by the skill, never accepted from the agent being checked. */
  acceptsAgentSuppliedSnapshot: false,
})

/** Appended to every user-facing output. Non-negotiable. */
export const DISCLOSURE =
  'A-Identity enforces limits you set. It does not place orders, does not give investment advice, and never holds your venue credentials. Not investment advice.'

/**
 * The one-line summary of what the guard can and cannot promise for a given caller. Kept
 * next to the invariants so an honest claim is the easy thing to print.
 */
export function enforcementNote(caller) {
  return caller.enforcement === 'process'
    ? `Process-level: writes stay previews unless this skill grants ${caller.liveWriteEnvVar} for a single approved command, so a denied action cannot execute even if the agent retries.`
    : 'Wrapper-level: every intent this skill sees is checked, and the skill is the only route it asks you to grant. It cannot contain an agent you have separately handed another way into the account.'
}

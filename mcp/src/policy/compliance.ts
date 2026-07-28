/**
 * The guardrail profile (Phase 1.6): what a THIRD PARTY may learn about an agent's
 * policy discipline.
 *
 * This is the thing worth selling. Charging an owner per check on their own account taxes
 * safety and, worse, payment cannot prove ownership, so an x402 gate on an owner-scoped
 * call would let a stranger probe someone's caps and holdings. Selling a counterparty a
 * privacy-preserving answer to "does this agent operate under an enforced policy, and does
 * it respect the verdicts?" has neither problem: the payer is a stranger, and a stranger is
 * exactly who should pay for information about someone else.
 *
 * Everything here is a BAND, never a value. What must never appear in the output:
 * caps, allowlists, denylists, symbols, USD amounts, portfolio values, snapshot hashes,
 * exact decision counts. Those are the owner's private position and strategy. The
 * `no-leak` tests in compliance.test.ts enforce that rather than trusting this comment.
 */
import type { AuditEntry } from './audit.js'

export type Band = 'none' | 'low' | 'medium' | 'high'
export type VolumeBand = 'none' | 'few' | 'some' | 'many'

export type GuardrailProfile = {
  /**
   * Three genuinely different states, kept apart because collapsing them is dishonest in
   * both directions:
   *   observed        we can see this agent's policy state and the bands below are real
   *   not_registered  we CAN read our roster and this agent is not in it
   *   unavailable     we cannot read policy state at all, so nothing below means anything
   *
   * `not_registered` is information (the agent does not use A-Identity guardrails);
   * `unavailable` is the absence of information. Reporting either as a clean profile would
   * let a buyer read "no data" as "no problems".
   */
  observability: 'observed' | 'not_registered' | 'unavailable'
  /** True only when the owner configured a policy AND decisions have been recorded
   *  against it. A configured policy nobody ever consulted is not enforcement. */
  policyEnforced: boolean
  /** How much history backs the bands below. */
  decisionsObserved: VolumeBand
  /** Share of decisions the policy refused. */
  blockRate: Band
  /** Attempts to record a blocked action as executed. The strongest negative signal. */
  overrideAttempts: Band
  /** Share of decisions made on incomplete data, where the engine failed closed. */
  unverifiableRate: Band
  /** Share of decisions that needed a human and never got a recorded outcome. */
  danglingApprovals: Band
  /** Whether the policy is being edited around the actions it governs. */
  policyStability: 'stable' | 'recently_changed' | 'unknown'
  /** Day precision on purpose: an exact timestamp leaks activity timing. */
  lastDecisionDate: string | null
  /** Caveats a buyer must read before treating a band as a judgement. */
  disclosure: string[]
}

const volumeBand = (n: number): VolumeBand => (n === 0 ? 'none' : n < 10 ? 'few' : n < 100 ? 'some' : 'many')

/** Rate bands. A zero rate is `none` so "clean" is distinguishable from "a little". */
const rateBand = (numerator: number, denominator: number): Band => {
  if (denominator === 0 || numerator === 0) return 'none'
  const r = numerator / denominator
  return r < 0.1 ? 'low' : r < 0.35 ? 'medium' : 'high'
}

const countBand = (n: number): Band => (n === 0 ? 'none' : n <= 2 ? 'low' : n < 10 ? 'medium' : 'high')

const emptyBands = {
  policyEnforced: false,
  decisionsObserved: 'none',
  blockRate: 'none',
  overrideAttempts: 'none',
  unverifiableRate: 'none',
  danglingApprovals: 'none',
  policyStability: 'unknown',
  lastDecisionDate: null,
} as const

/** Policy state could not be read at all. Absence of information, not innocence. */
export function unobservableProfile(): GuardrailProfile {
  return {
    observability: 'unavailable',
    ...emptyBands,
    disclosure: [
      'Policy state could not be read, so this is NOT evidence that the agent lacks guardrails. Treat every band as unknown.',
    ],
  }
}

/**
 * We can read our roster and this agent is not on it. Distinct from `unavailable`: this
 * is a real finding (the agent does not use A-Identity guardrails), but it still says
 * nothing about guardrails it might enforce somewhere else.
 */
export function notRegisteredProfile(): GuardrailProfile {
  return {
    observability: 'not_registered',
    ...emptyBands,
    disclosure: [
      'This agent is not registered with A-Identity, so there is no policy state for it here. It may still be bounded by guardrails we cannot see.',
    ],
  }
}

/**
 * Build the profile from an agent's audit trail.
 *
 * `policyConfigured` and `policyVersion` come from the stored policy: they distinguish an
 * owner who set rules from one who never opened the screen.
 */
export function guardrailProfile(input: {
  entries: AuditEntry[]
  policyConfigured: boolean
  policyVersion: number
  /** Injected so the result is reproducible and the tests are deterministic. */
  now: Date
}): GuardrailProfile {
  const { entries, policyConfigured, policyVersion, now } = input
  const total = entries.length

  const denied = entries.filter((e) => e.verdict === 'DENY')
  const warned = entries.filter((e) => e.verdict === 'WARN')
  const overrides = entries.reduce((a, e) => a + (e.overrideAttempts ?? 0), 0)
  const unverifiable = entries.filter((e) => e.unverifiable).length
  const dangling = warned.filter((e) => e.outcome === 'awaiting_human' || e.outcome === 'abandoned').length

  const timestamps = entries.map((e) => Date.parse(e.ts)).filter((t) => Number.isFinite(t))
  const last = timestamps.length ? new Date(Math.max(...timestamps)) : null

  // A policy edited many times is not automatically suspicious, but a policy edited very
  // recently, right around the actions it governs, is worth a counterparty's attention.
  const editedRecently =
    last !== null && policyVersion > 1 && now.getTime() - last.getTime() < 24 * 60 * 60 * 1000
  const policyStability: GuardrailProfile['policyStability'] = !policyConfigured
    ? 'unknown'
    : editedRecently && policyVersion > 3
      ? 'recently_changed'
      : 'stable'

  const disclosure = [
    'Every field is a band, not a value. Caps, allowlists, symbols, amounts and holdings are never disclosed.',
    'A high blockRate is NOT by itself a negative signal: it can mean a tight policy doing its job just as easily as an agent pushing at its limits.',
  ]
  if (total === 0) {
    disclosure.push('No decisions recorded yet, so the bands describe absence of history rather than good behavior.')
  }
  if (overrides > 0) {
    disclosure.push('This operator attempted to record a blocked action as executed. The attempt was refused, and it is counted here.')
  }

  return {
    observability: 'observed',
    policyEnforced: policyConfigured && total > 0,
    decisionsObserved: volumeBand(total),
    blockRate: rateBand(denied.length, total),
    overrideAttempts: countBand(overrides),
    unverifiableRate: rateBand(unverifiable, total),
    danglingApprovals: rateBand(dangling, warned.length),
    policyStability,
    lastDecisionDate: last ? last.toISOString().slice(0, 10) : null,
    disclosure,
  }
}

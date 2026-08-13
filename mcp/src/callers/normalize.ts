/**
 * Resolve one `pre_action_check` request into the neutral shapes the engine consumes,
 * plus the provenance that says where those shapes came from.
 *
 * Pure: no state, no clock, no network. That is what lets the decision path stay a
 * function and lets this be unit-tested against payloads no venue has ever sent us.
 *
 * ── the two accepted shapes, and why the direct one stays loose ──────────────────────
 *
 * DIRECT   `{ surface, intent, snapshot? }` - the caller already speaks NormalizedIntent.
 * ADAPTED  `{ surface, callerId, action, account? }` - a registered adapter translates the
 *          venue's own payload.
 *
 * On the direct path the intent is passed through UNVALIDATED and on purpose. A malformed
 * intent must reach `evaluateAction` and come back as a recorded DENY with a reason. If
 * this module rejected it instead, the caller would get a protocol error and NO audit row
 * would exist, which loses exactly the property the product sells: that a refused action
 * leaves a receipt. Validation of an intent is a policy decision, not a parsing step.
 *
 * The adapted path is different, and stricter, because there the failure is ours: an
 * adapter that cannot value an order must say so rather than hand the engine a number it
 * invented.
 */
import type { AccountSnapshot, AuditProvenance, NormalizedIntent } from '../policy/index.js'
import { getCaller, type CallerDescriptor } from './registry.js'

/** Why a request could not be resolved. Stable codes, so a UI does not match on prose. */
export type ResolveFailureCode =
  /** Neither an `intent` nor a `callerId` was supplied. */
  | 'input_required'
  /** Both an `intent` and a `callerId` were supplied: two sources of truth, no winner. */
  | 'ambiguous_input'
  /** `callerId` names nothing in the registry. */
  | 'unknown_caller'
  /** The caller is registered but carries no adapter yet. */
  | 'caller_not_normalizable'
  /** The caller belongs to a different surface than the request asked for. */
  | 'surface_mismatch'
  /** `callerId` was supplied without an `action` payload to translate. */
  | 'action_required'
  /** The adapter refused the action payload. Its reason is carried through verbatim. */
  | 'action_not_normalizable'
  /** The adapter refused the account payload. */
  | 'account_not_normalizable'

export type ResolveOk = {
  ok: true
  intent: NormalizedIntent
  snapshot?: AccountSnapshot
  provenance: AuditProvenance
}
export type ResolveFail = { ok: false; code: ResolveFailureCode; reason: string }
export type ResolveResult = ResolveOk | ResolveFail

const fail = (code: ResolveFailureCode, reason: string): ResolveFail => ({ ok: false, code, reason })

/** Provenance for a request that arrived already speaking the engine's vocabulary. */
function directProvenance(hasSnapshot: boolean): AuditProvenance {
  return {
    callerId: null,
    venue: null,
    // Nothing we can name stood between the agent and the venue. That may be untrue in
    // fact (a wrapper we never heard of may exist), which is precisely why the honest
    // value is the weakest one: we record what we know, not what we hope.
    enforcement: 'none',
    intentSource: 'direct',
    snapshotSource: hasSnapshot ? 'direct' : 'absent',
  }
}

function callerProvenance(caller: CallerDescriptor, hasSnapshot: boolean): AuditProvenance {
  return {
    callerId: caller.id,
    venue: caller.venue,
    enforcement: caller.enforcement,
    intentSource: 'caller-adapter',
    snapshotSource: hasSnapshot ? 'caller-adapter' : 'absent',
  }
}

export type CallerInput = {
  surface: string
  intent?: unknown
  snapshot?: unknown
  callerId?: string
  action?: unknown
  account?: unknown
}

/**
 * Turn a request into `{ intent, snapshot?, provenance }` or a typed failure.
 *
 * Backwards compatible by construction: a request with no `callerId` takes the original
 * path and returns the original values, plus a provenance block that says so.
 */
export function resolveCallerInput(input: CallerInput): ResolveResult {
  const hasIntent = input.intent !== undefined && input.intent !== null
  const hasCaller = typeof input.callerId === 'string' && input.callerId.trim() !== ''

  if (hasIntent && hasCaller) {
    return fail(
      'ambiguous_input',
      'Send either a pre-normalized `intent` or a `callerId` with the venue `action`, not both. With both, the audit row could not honestly say which one produced the verdict.',
    )
  }

  if (!hasCaller) {
    if (!hasIntent || typeof input.intent !== 'object') {
      return fail('input_required', 'Send an `intent` object, or a `callerId` with the venue `action` payload.')
    }
    // Deliberately NOT validated here. See the module docstring: a malformed intent has to
    // reach the engine so the refusal is recorded.
    return {
      ok: true,
      intent: input.intent as NormalizedIntent,
      ...(input.snapshot && typeof input.snapshot === 'object'
        ? { snapshot: input.snapshot as AccountSnapshot }
        : {}),
      provenance: directProvenance(Boolean(input.snapshot && typeof input.snapshot === 'object')),
    }
  }

  const callerId = (input.callerId as string).trim()
  const caller = getCaller(callerId)
  if (!caller) {
    return fail('unknown_caller', `No caller is registered as "${callerId}". Read GET /api/callers for the current list.`)
  }
  if (!caller.adapter) {
    return fail(
      'caller_not_normalizable',
      `Caller "${caller.id}" is registered but carries no adapter yet, so its payload shape cannot be translated. Send a pre-normalized \`intent\` instead.`,
    )
  }
  if (caller.surface !== input.surface) {
    return fail(
      'surface_mismatch',
      `Caller "${caller.id}" acts on the "${caller.surface}" surface, not "${input.surface}". Checking it against the wrong rule set would answer a question nobody asked.`,
    )
  }
  if (input.action === undefined || input.action === null) {
    return fail('action_required', `Caller "${caller.id}" needs an \`action\` payload: the venue's own action, unmodified.`)
  }

  const intent = caller.adapter.normalizeAction(input.action)
  if (!intent.ok) return fail('action_not_normalizable', intent.reason)

  if (input.account === undefined || input.account === null) {
    // No account payload is allowed: the engine fails closed on every rule that needs one,
    // so this produces a DENY with a reason rather than a permissive answer.
    return { ok: true, intent: intent.value, provenance: callerProvenance(caller, false) }
  }

  const snapshot = caller.adapter.normalizeAccount(input.account)
  if (!snapshot.ok) return fail('account_not_normalizable', snapshot.reason)

  return { ok: true, intent: intent.value, snapshot: snapshot.value, provenance: callerProvenance(caller, true) }
}

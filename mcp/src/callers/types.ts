/**
 * The caller seam (Phase 6.2).
 *
 * A caller is anything that wants a verdict before acting: a brokerage client, a card
 * client, a crypto API. Each one speaks its own shapes, and this is where those shapes are
 * translated into the neutral ones the engine understands.
 *
 * The rule that makes this a seam rather than a pile of special cases: translation lives
 * HERE, decisions live in `policy/`. Nothing in `policy/` may import a caller (a test in
 * policy/engine.test.ts enforces that), and nothing here may decide anything. An adapter
 * that starts returning verdicts has stopped being an adapter.
 *
 * Adapters are PURE. They take a payload the venue produced and return normalized data,
 * with no network, no credentials and no clock. That is what lets a venue integration be
 * unit-tested before the venue is even reachable, which is exactly the situation for crypto:
 * Robinhood's crypto MCP surface does not exist yet, so this is written against the REST API
 * they already document and will plug into `pre_action_check` unchanged when it ships.
 */
import type { AccountSnapshot, NormalizedIntent } from '../policy/index.js'

/** Why a payload could not be translated. A caller must not guess past this. */
export type NormalizeFailure = { ok: false; reason: string }
export type NormalizeOk<T> = { ok: true; value: T }
export type NormalizeResult<T> = NormalizeOk<T> | NormalizeFailure

export const fail = (reason: string): NormalizeFailure => ({ ok: false, reason })
export const ok = <T>(value: T): NormalizeOk<T> => ({ ok: true, value })

/**
 * One caller's translation layer.
 *
 * `id` matches the caller descriptor the Guarded Skill uses, so a decision, an audit row and
 * a skill config all name the same thing.
 */
export interface CallerAdapter<TAction = unknown, TAccount = unknown> {
  readonly id: string
  readonly venue: string
  /** Which policy surface this caller's actions belong to. */
  readonly surface: 'trade' | 'spend' | 'bet'
  /**
   * Turn a venue action payload into a neutral intent.
   *
   * The USD amount must come from the venue's own numbers, never from a model's arithmetic:
   * the whole point is to check the action the venue would actually execute. When the payload
   * does not carry enough to compute it, FAIL rather than estimate. A refusal for missing
   * data is recoverable; a check against an invented amount is not.
   */
  normalizeAction(action: TAction): NormalizeResult<NormalizedIntent>
  /**
   * Turn venue account state into a neutral snapshot. Partial is allowed: the engine fails
   * closed on any rule whose input is missing, so an incomplete snapshot produces a DENY
   * rather than a wrong ALLOW.
   */
  normalizeAccount(account: TAccount): NormalizeResult<AccountSnapshot>
}

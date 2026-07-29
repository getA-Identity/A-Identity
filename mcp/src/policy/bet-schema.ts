/**
 * `pre_bet_check` SCHEMA ONLY (Phase 7). There is deliberately no rule, no adapter and no
 * tool registration to go with it, and `bet-schema.test.ts` enforces that this file stays
 * inert: it exports types and frozen data, and not one function.
 *
 * ── Why schema only, and why that is not laziness ─────────────────────────────────────
 *
 * 1. THE SURFACE DOES NOT EXIST. Robinhood's agentic beta covers equities, and event
 *    contracts / prediction markets are named as roadmap with no date (TechCrunch and
 *    PredictionNews, 27-28 May 2026). Compare Phase 6.2: crypto got a real adapter because
 *    a documented REST API exists to translate. Nothing is published here, so writing rules
 *    would mean inventing the venue's payload shape and then testing our invention. The line
 *    is the same one we held all the way through: translate what is documented, refuse to
 *    guess what is not.
 *
 * 2. IT IS A DIFFERENT LEGAL ENTITY. Event contracts run through Robinhood Derivatives LLC
 *    under CFTC rules, not through the broker-dealer. Whatever we would have to be right
 *    about to authorize a trade, we would have to be right about something else entirely to
 *    authorize a bet.
 *
 * 3. THE CURRENT INTENT TYPE CANNOT EXPRESS A BET WITHOUT LYING. `NormalizedIntent.side` is
 *    `'buy' | 'sell'`. A prediction contract is directional on an OUTCOME (yes/no), and
 *    flattening that onto buy/sell loses the only thing that says what was wagered. Rather
 *    than widen the live type for a surface that cannot run, the shape lives here until the
 *    venue is real. Half-wiring it would have been the actual mistake.
 *
 * The registry keeps `bet` at `status: 'planned'`, and `evaluateAction` refuses a non-live
 * surface before any rule runs. So this schema can be read, reviewed and built against, and
 * it still cannot authorize a single dollar. Honest status, enforced rather than promised.
 */
import type { Surface } from './types.js'

// ── what makes a bet unlike a trade ──────────────────────────────────────────────────
//
// These three are the whole reason `bet` gets its own policy block instead of reusing the
// trade caps. Each one makes the SAME dollar figure mean something riskier.
//
// TOTAL LOSS IS THE BASE CASE, NOT THE TAIL. An equity position rarely reaches zero; a
// losing event contract always does, by construction. So `perActionCapUsd: 250` on the trade
// surface caps an amount that is mostly still there tomorrow, and the same 250 on a bet caps
// an amount that is routinely gone. Inheriting the number would quietly move the risk.
//
// THERE IS NO EXIT. Robinhood's own prediction market is documented as thinner than the
// venues built for it, and a contract nobody will buy back cannot be reduced. Every other
// surface can be unwound at some price; here a position is a decision that stands until
// resolution. That is why the interesting ceiling is cumulative OPEN stake, not daily flow.
//
// RESOLUTION LOCKS CAPITAL. A daily cap bounds nothing over a month if nothing resolves for
// a month: thirty in-policy days compound into one very large position. Bounding it needs
// open-position accounting the snapshot does not carry today, which is precisely why the
// rules below stay unimplemented instead of being written against fields nobody supplies.

/** The outcome side of a prediction contract. NOT buy/sell: see point 3 above. */
export type BetSide = 'yes' | 'no'

/**
 * Normalized categories. Coarse on purpose: the regulatory treatment differs sharply
 * between them, and a fine-grained taxonomy would imply we can tell the difference between
 * cases we cannot.
 */
export type BetCategory = 'election' | 'sports' | 'economics' | 'crypto' | 'weather' | 'other'

/**
 * The `pre_bet_check` input.
 *
 * Required is kept to the four fields a refusal can be justified from. Everything optional
 * is a field the venue may or may not report, and a rule that needs a missing one FAILS
 * CLOSED, exactly as on the live surfaces.
 */
export type BetIntent = {
  /** The venue's contract or market id. Recorded, never parsed for meaning. */
  eventId: string
  category: BetCategory
  /** USD the user can lose IN FULL. This is the amount at risk, so it maps to the engine's
   *  `notionalUsd` when the surface goes live: the maximum loss, not the maximum payout. */
  stakeUsd: number
  side: BetSide
  /** Price per contract as the venue quotes it, conventionally 0..1. */
  contractPriceUsd?: number
  contracts?: number
  /** Payout if it resolves in favor. Exposure, not risk: it never becomes the cap input,
   *  because capping upside is not a safety control. Carried for the audit row. */
  maxPayoutUsd?: number
  /** ISO 8601. Capital is locked until this, which is what a daily cap cannot see. */
  resolvesAt?: string
  /** The counterparty entity, e.g. "Robinhood Derivatives LLC". Recorded so an audit row
   *  names who actually held the money, which is not the broker-dealer. */
  venueEntity?: string
  /** Free-form label for reason strings only. Never an input to a decision. */
  label?: string
}

/**
 * The policy block the surface WOULD read.
 *
 * One deliberate inconsistency with `TradePolicy`, called out here because a future edit
 * that "fixes" it would open everything: on the trade surface an empty `allowSymbols` means
 * NO RESTRICTION, and here an empty `categoryAllow` means NOTHING IS ALLOWED. Prediction
 * categories are not interchangeable in the eyes of a regulator, so the default has to be
 * that the user names what they want rather than discovering what they got.
 */
export type BetPolicy = {
  /** Per-bet ceiling on stake. Its own number, never inherited from `perActionCapUsd`. */
  stakeCapUsd: number
  /** Sum of stake placed today. */
  dailyStakeCapUsd: number
  /** Sum of stake in UNRESOLVED positions. The ceiling that actually binds, given no exit. */
  maxOpenStakeUsd: number
  /** Empty = nothing allowed. Inverted against TradePolicy on purpose, see above. */
  categoryAllow: BetCategory[]
  /** Always wins over the allow list, same precedence as every other surface. */
  categoryDeny: BetCategory[]
  /**
   * Default TRUE, and the strongest honest default in the schema: every bet pauses for a
   * human regardless of size. An autonomous agent placing a wager it cannot exit, on an
   * outcome it cannot influence, is not a case where a dollar threshold is the right control.
   */
  requireHumanApproval: boolean
  /** null = no limit. Beyond this many days to resolution, stake is locked too long to be
   *  covered by any daily accounting. */
  maxResolutionDays: number | null
}

/**
 * Snapshot fields the surface would need, and which no caller supplies today.
 *
 * This is the concrete blocker, stated as a type rather than a promise: `maxOpenStakeUsd`
 * cannot be checked without `openStakeUsd`, so on the day someone wires this up, every rule
 * below fails closed until a caller can read open positions. That is the correct behavior
 * and it is why the surface is not merely unfinished, it is unfinishable from here.
 */
export type BetAccountFields = {
  /** Stake across all unresolved positions. */
  openStakeUsd?: number
  /** Stake placed today, across resolutions. */
  todayStakeUsd?: number
  /** Open stake per category, for a per-category ceiling. */
  openStakeByCategoryUsd?: Record<BetCategory, number>
}

/**
 * The tool's input schema, as data.
 *
 * Written in the shape the MCP tools already use so it needs translating, not designing,
 * when the venue ships. It is NOT registered: a test asserts no live tool named
 * `pre_bet_check` exists, because a schema that is reachable is not a schema, it is a
 * feature.
 */
export const PRE_BET_CHECK_SCHEMA = Object.freeze({
  name: 'pre_bet_check',
  surface: 'bet' as Surface,
  status: 'planned' as const,
  description:
    'Check a prediction-market wager against the owner policy BEFORE it is placed. Not implemented: the surface is planned, and any call would be refused with SURFACE_NOT_LIVE.',
  required: Object.freeze(['eventId', 'category', 'stakeUsd', 'side']),
  optional: Object.freeze([
    'contractPriceUsd',
    'contracts',
    'maxPayoutUsd',
    'resolvesAt',
    'venueEntity',
    'label',
  ]),
})

/**
 * The rules this surface would carry, as data, none implemented.
 *
 * Recorded so the decision about each one is reviewable now, while it is cheap, instead of
 * being made in a hurry on the day the venue ships. `needs` names what has to exist first,
 * which is the honest reason each is absent.
 */
export const BET_RULES_SKETCH = Object.freeze([
  Object.freeze({
    code: 'BET_CATEGORY_NOT_ALLOWED',
    verdict: 'DENY',
    rule: 'The category is not in categoryAllow. Empty list denies everything.',
    needs: 'nothing further, this one is decidable from the intent alone',
  }),
  Object.freeze({
    code: 'BET_CATEGORY_DENIED',
    verdict: 'DENY',
    rule: 'The category is in categoryDeny, which outranks the allow list.',
    needs: 'nothing further',
  }),
  Object.freeze({
    code: 'BET_STAKE_CAP',
    verdict: 'DENY',
    rule: 'stakeUsd exceeds stakeCapUsd. Its own ceiling because a bet can lose all of it.',
    needs: 'nothing further',
  }),
  Object.freeze({
    code: 'BET_DAILY_CAP',
    verdict: 'DENY',
    rule: 'todayStakeUsd + stakeUsd exceeds dailyStakeCapUsd.',
    needs: 'AccountSnapshot.todayStakeUsd, which no caller reports',
  }),
  Object.freeze({
    code: 'BET_OPEN_STAKE_CAP',
    verdict: 'DENY',
    rule: 'openStakeUsd + stakeUsd exceeds maxOpenStakeUsd. The ceiling that binds when there is no exit.',
    needs: 'AccountSnapshot.openStakeUsd, which requires reading unresolved positions',
  }),
  Object.freeze({
    code: 'BET_RESOLUTION_TOO_FAR',
    verdict: 'WARN',
    rule: 'resolvesAt is beyond maxResolutionDays, so the stake is locked past any daily accounting.',
    needs: 'the venue to report resolvesAt, and an injected clock (the engine already has one)',
  }),
  Object.freeze({
    code: 'BET_NEEDS_HUMAN',
    verdict: 'WARN',
    rule: 'requireHumanApproval is true, so every wager pauses regardless of size.',
    needs: 'nothing further, and it is the default',
  }),
])

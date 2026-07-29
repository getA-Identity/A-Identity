/**
 * Policy Engine v2 type foundation (Phase 1.1).
 *
 * Built on the same principles the multichain work established (see
 * ../../../MULTICHAIN-STRATEGY.md), because the problem is the same shape: many callers,
 * one core, and no per-caller branching allowed to leak inward.
 *
 *   config is DATA          -> an ActionPolicy is a plain object the user owns
 *   core is caller-agnostic -> the engine never learns which client produced an intent
 *   one adapter per caller  -> a caller normalizes ITS shape into NormalizedIntent
 *   lifecycle status flags  -> a surface is live | planned, and planned cannot execute
 *   honest results          -> a verdict carries every reason, never a bare boolean
 *
 * Nothing in this module may import a caller-specific module (Robinhood or otherwise).
 * That is a hard rule recorded in docs/compliance-robinhood.md: the engine carries no
 * dependency on any particular brokerage, official or unofficial.
 */

/** Which kind of action a policy is being asked about. Selects the rule set. */
export type Surface = 'trade' | 'spend' | 'bet'

/** Lifecycle status of a surface. Only `live` surfaces can produce an ALLOW. */
export type SurfaceStatus = 'live' | 'planned'

/**
 * What the action actually does. A policy layer that only understands orders is trivially
 * evaded: a daily cap means nothing if the agent can install a recurring buy, flip on
 * stock lending, or wire money out instead. Every mutating path gets a kind.
 */
export type ActionKind =
  /** Place an order (equity or option). */
  | 'order'
  /** A card purchase at a merchant. */
  | 'purchase'
  /** Cancel an existing order. Cancelling a protective leg RAISES risk. */
  | 'cancel'
  /** Create or edit a standing/recurring order: one approval, many future executions. */
  | 'recurring'
  /** Change account configuration (margin, lending, PDT, DRIP, sweep, expiration). */
  | 'settings'
  /** Move money out of the account. Highest severity. */
  | 'transfer'
  /** Pull documents (tax forms). Not a trade, but data egress. */
  | 'document'

export type Side = 'buy' | 'sell'
export type AssetClass = 'equity' | 'option'

/**
 * The caller-neutral intent. A caller adapter produces this; the engine consumes only
 * this. `notionalUsd` must come from the caller's own dry-run/preview of the action, not
 * from a model's arithmetic, so the engine checks the action the venue would actually
 * receive (see docs/robinhood-intent-capture.md, layer 3).
 */
export type NormalizedIntent = {
  kind: ActionKind
  /** Absolute USD value at risk in this action. Always >= 0. */
  notionalUsd: number
  side?: Side
  symbol?: string
  assetClass?: AssetClass
  /** True when this action removes downside protection (e.g. cancelling a covered call). */
  protective?: boolean
  /** For `settings`: which switch is being changed, normalized to lowercase. */
  settingKey?: string
  /** For `settings`: the requested value. */
  settingValue?: boolean | string | number
  /** For `recurring`: how often it will fire, for the standing-authority reason text. */
  cadence?: string
  /** Spend surface: the merchant name as the venue reports it. */
  merchant?: string
  /** Spend surface: ISO 18245 merchant category code, when the venue supplies one. */
  mcc?: string
  /** Spend surface: which card is being used. Agent cards are per-agent virtual cards, so
   *  this is what makes a per-card ceiling meaningful. */
  cardId?: string
  /** Free-form label used only in reason strings. Never used in a decision. */
  label?: string
}

/**
 * Account state the engine needs to decide. Supplied by the CALLER adapter, which reads
 * it itself immediately before the check. It is never supplied by the agent being
 * policed: an agent that can author its own snapshot can buy an ALLOW by lying about
 * buying power (docs/robinhood-intent-capture.md, bypass 8).
 *
 * Optional fields are optional because not every caller can produce them. A rule that
 * needs a field it does not have FAILS CLOSED rather than passing.
 */
export type AccountSnapshot = {
  /** Cumulative USD notional already actioned today, for the daily cap. */
  todayNotionalUsd: number
  positions: { symbol: string; shares?: number; valueUsd: number }[]
  /** Total portfolio value, needed for concentration. Absent = concentration unverifiable. */
  portfolioValueUsd?: number
  /** Buying power as the venue reports it. On a margin account this may INCLUDE
   *  borrowable funds, which is why it cannot by itself prove an order is unmargined. */
  buyingPowerUsd?: number
  /** Settled cash actually available. This is what proves an order needs no margin. */
  cashAvailableUsd?: number
  /** Margin currently drawn. Any positive value under a no-margin policy is a violation. */
  marginUsedUsd?: number
  accountType?: 'individual' | 'margin' | 'cash' | 'ira' | 'roth_ira' | 'sep_ira' | 'hsa'
  /** Spend surface: USD already spent today per card id. Absent = a per-card ceiling
   *  cannot be checked, so a rule that needs it fails closed. */
  cardSpentTodayUsd?: Record<string, number>
  /** Spend surface: USD already spent today per normalized category. */
  categorySpentTodayUsd?: Record<string, number>
}

/** A UTC clock window, inclusive of start, exclusive of end. "HH:MM" 24h. */
export type UtcWindow = { start: string; end: string }

/** Trade-surface policy block. */
export type TradePolicy = {
  /** Empty = no allowlist restriction. Non-empty = ONLY these symbols. */
  allowSymbols: string[]
  /** Always wins over the allowlist. */
  denySymbols: string[]
  /** Options are off unless the user turns them on. Leverage is opt-in. */
  allowOptions: boolean
  /**
   * HARD false, at the type level. Margin means an agent can lose more than the account
   * holds, so this is not a switch the product exposes. Typed as the literal `false` so a
   * future edit that tries to enable it fails to compile rather than shipping.
   */
  allowMargin: false
  /** null = no clock restriction. */
  tradingHoursUtc: UtcWindow | null
  /** Max share of portfolio value one symbol may reach AFTER the action. 100 = unlimited. */
  maxConcentrationPct: number
}

/**
 * Spend-surface policy block.
 *
 * Deliberately does NOT restate what the venue already gives you. Robinhood's agent card
 * already carries one spending limit, a monthly cap and an all-or-nothing approval toggle,
 * so duplicating those would ship a worse copy of a control that already exists. What it
 * does not have, and what this adds, is WHERE and on WHAT the money may go: merchants,
 * categories, per-card ceilings, and a refusal that arrives with a reason and a record.
 */
export type SpendPolicy = {
  /** Empty = no restriction. Non-empty = ONLY these merchants. Matched case-insensitively
   *  as a substring, because venues report merchant names inconsistently. */
  merchantAllow: string[]
  /** Always wins over the allow list. */
  merchantDeny: string[]
  /** Per-category USD ceiling for the day, keyed by a normalized category. */
  categoryLimits: Record<string, number>
  /** Per-card USD ceiling for the day, keyed by card id. A per-agent virtual card is the
   *  unit the venue actually hands out, so this is the ceiling that matches reality. */
  cardCaps: Record<string, number>
  /**
   * Categories an agent card should not quietly reach at all. Defaults to cash advance,
   * quasi-cash (which covers crypto purchases) and gambling: on a card an agent drives,
   * those turn a spending mistake into an unrecoverable one. Emptying the list is the
   * user's call, and it should be a deliberate act rather than an oversight.
   */
  categoryDeny: string[]
}

/**
 * The user's policy. Versioned so an audit entry can name the exact policy that produced
 * a verdict (Phase 1.3 owns storage and version bumping).
 */
export type ActionPolicy = {
  policyId: string
  version: number
  updatedAt: string
  /** Emergency off switch: every action stops. */
  frozen: boolean
  /** Ceiling for a single action. */
  perActionCapUsd: number
  /** Ceiling for the sum of today's actions. */
  dailyCapUsd: number
  /** At or above this, a human must confirm. WARN, not DENY. */
  humanApprovalAboveUsd: number
  trade: TradePolicy
  spend?: SpendPolicy
}

export type Verdict = 'ALLOW' | 'WARN' | 'DENY'

/** One rule's finding. `code` is stable and machine-readable; `reason` is for humans. */
export type RuleFinding = { verdict: Exclude<Verdict, 'ALLOW'>; code: string; reason: string }

/**
 * The engine's answer. No side effects, no execution: the caller acts on this. Same shape
 * as the existing prepared-or-executed golden rule, one level up.
 */
export type Decision = {
  verdict: Verdict
  reasons: string[]
  /** Stable codes for the same findings, so UI and tests do not match on prose. */
  codes: string[]
  surface: Surface
  kind: ActionKind
  policyId: string
  policyVersion: number
  /** True when a rule could not be evaluated for lack of snapshot data and failed closed. */
  unverifiable: boolean
}

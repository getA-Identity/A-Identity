/**
 * The decision core (Phase 1.2). Pure, deterministic, caller-agnostic.
 *
 * `evaluateAction` is a function of (policy, intent, snapshot, clock) and nothing else. No
 * I/O, no network, no clock reads unless injected, no knowledge of who is asking. Identical
 * inputs always produce an identical verdict, which is what lets us say honestly that a
 * verdict is a comparison against the user's own rules rather than an opinion about a
 * trade (docs/compliance-robinhood.md section 3).
 *
 * Shape follows the chain adapter seam: a list of rules is DATA, the pipeline that runs
 * them is generic, and a new surface adds rules rather than editing the pipeline. Every
 * rule runs, so the human sees every violation at once instead of fixing them one refusal
 * at a time.
 *
 * Fail closed. A rule that needs a snapshot field it does not have returns DENY, not
 * silence. Unverifiable is never treated as fine, which mirrors how the upstream tooling
 * hard-fails on a dead quote or an ambiguous ticker.
 */
import type {
  AccountSnapshot,
  ActionKind,
  ActionPolicy,
  Decision,
  NormalizedIntent,
  RuleFinding,
  Surface,
  UtcWindow,
} from './types.js'
import { getSurface } from './registry.js'
import { isKnownMcc, resolveCategory } from './mcc.js'

/** Everything a rule may look at. */
type RuleContext = {
  policy: ActionPolicy
  intent: NormalizedIntent
  snapshot?: AccountSnapshot
  /** Injected clock, so tests are deterministic and a verdict is reproducible. */
  now: Date
}

/** A rule returns a finding, or null when it has nothing to say. */
type Rule = (ctx: RuleContext) => RuleFinding | null

const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const norm = (s: string | undefined) => (s ?? '').trim().toUpperCase()

// ── shared rules (every surface) ─────────────────────────────────────────────────

const frozen: Rule = ({ policy }) =>
  policy.frozen
    ? { verdict: 'DENY', code: 'FROZEN', reason: 'The policy is frozen: all agent actions are stopped.' }
    : null

const perActionCap: Rule = ({ policy, intent }) =>
  intent.notionalUsd > policy.perActionCapUsd
    ? {
        verdict: 'DENY',
        code: 'PER_ACTION_CAP',
        reason: `Action is ${usd(intent.notionalUsd)}, above the per-action cap of ${usd(policy.perActionCapUsd)}.`,
      }
    : null

/**
 * The daily cap is what actually stops structuring: an agent that splits one over-cap
 * order into many under-cap ones passes the per-action rule and fails here
 * (docs/robinhood-intent-capture.md, bypass 6).
 */
const dailyCap: Rule = ({ policy, intent, snapshot }) => {
  if (!snapshot) {
    return { verdict: 'DENY', code: 'DAILY_CAP_UNVERIFIABLE', reason: 'No account snapshot, so the daily cap cannot be checked.' }
  }
  const total = snapshot.todayNotionalUsd + intent.notionalUsd
  return total > policy.dailyCapUsd
    ? {
        verdict: 'DENY',
        code: 'DAILY_CAP',
        reason: `This action would bring today to ${usd(total)}, above the daily cap of ${usd(policy.dailyCapUsd)}.`,
      }
    : null
}

/** Above the approval line the action is not refused, it waits for a human. */
const humanApproval: Rule = ({ policy, intent }) =>
  intent.notionalUsd >= policy.humanApprovalAboveUsd
    ? {
        verdict: 'WARN',
        code: 'HUMAN_APPROVAL',
        reason: `Action is ${usd(intent.notionalUsd)}, at or above the ${usd(policy.humanApprovalAboveUsd)} human-approval line.`,
      }
    : null

// ── trade-surface rules ──────────────────────────────────────────────────────────

/**
 * Action kinds a ticker rule can meaningfully apply to.
 *
 * A transfer, a settings change and a document pull have no security, so a ticker allow or
 * deny list says nothing about them. Applying the list anyway used to DENY every one of
 * them with "this action carries no symbol": setting "only trade AAPL" silently also blocked
 * transfers, and worse, it stopped a transfer from ever reaching its human-approval WARN.
 * Over-blocking is not the safe side when it replaces a human decision with a confusing
 * refusal.
 */
const SYMBOL_KINDS = new Set<ActionKind>(['order', 'cancel', 'recurring'])

const symbolDenied: Rule = ({ policy, intent }) => {
  if (!SYMBOL_KINDS.has(intent.kind)) return null
  const sym = norm(intent.symbol)
  if (!sym) return null
  return policy.trade.denySymbols.map(norm).includes(sym)
    ? { verdict: 'DENY', code: 'SYMBOL_DENIED', reason: `${sym} is on your deny list.` }
    : null
}

const symbolNotAllowed: Rule = ({ policy, intent }) => {
  if (!SYMBOL_KINDS.has(intent.kind)) return null
  // "The user set no allow list" and "the user set one that happens to match nothing" are
  // different. Only the first means no restriction. Deciding that from the FILTERED list
  // would let a junk-only list silently switch the restriction off, and for a guardrail
  // under-blocking is the dangerous direction.
  if (!policy.trade.allowSymbols.length) return null
  const allow = policy.trade.allowSymbols.map(norm).filter(Boolean)
  if (!allow.length) {
    return {
      verdict: 'DENY',
      code: 'SYMBOL_NOT_ALLOWED',
      reason: 'Your allow list has no usable symbols in it, so nothing can match it.',
    }
  }
  const sym = norm(intent.symbol)
  // A symbol-bearing action with no symbol, under an allow list, still fails closed: there
  // the missing ticker is exactly what the rule needed to see.
  if (!sym) {
    return { verdict: 'DENY', code: 'SYMBOL_UNKNOWN', reason: 'An allow list is set but this action carries no symbol.' }
  }
  return allow.includes(sym)
    ? null
    : { verdict: 'DENY', code: 'SYMBOL_NOT_ALLOWED', reason: `${sym} is not on your allow list.` }
}

const optionsBlocked: Rule = ({ policy, intent }) =>
  intent.assetClass === 'option' && !policy.trade.allowOptions
    ? { verdict: 'DENY', code: 'OPTIONS_BLOCKED', reason: 'Options are off in your policy.' }
    : null

/**
 * Margin is hard-off. `buyingPowerUsd` cannot settle this on its own: on a margin account
 * the venue's buying power already includes borrowable funds, so an order inside buying
 * power can still be a margin order. Only settled cash proves otherwise, so without
 * `cashAvailableUsd` this fails closed.
 */
const marginBlocked: Rule = ({ intent, snapshot }) => {
  if (intent.kind !== 'order' || intent.side !== 'buy') return null
  if (!snapshot) {
    return { verdict: 'DENY', code: 'MARGIN_UNVERIFIABLE', reason: 'No account snapshot, so a no-margin buy cannot be proven.' }
  }
  if ((snapshot.marginUsedUsd ?? 0) > 0) {
    return {
      verdict: 'DENY',
      code: 'MARGIN_IN_USE',
      reason: `The account already carries ${usd(snapshot.marginUsedUsd as number)} of margin, and your policy forbids margin.`,
    }
  }
  if (snapshot.cashAvailableUsd === undefined) {
    return {
      verdict: 'DENY',
      code: 'MARGIN_UNVERIFIABLE',
      reason: 'Settled cash is unknown, so this buy cannot be shown to avoid margin. Buying power alone can include borrowed funds.',
    }
  }
  return intent.notionalUsd > snapshot.cashAvailableUsd
    ? {
        verdict: 'DENY',
        code: 'MARGIN_REQUIRED',
        reason: `Buy of ${usd(intent.notionalUsd)} exceeds settled cash of ${usd(snapshot.cashAvailableUsd)}, so it would borrow. Your policy forbids margin.`,
      }
    : null
}

/** "HH:MM" to minutes since UTC midnight, or null if malformed. */
function minutesOfDay(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Windows that wrap past midnight are supported (start > end). */
function withinWindow(now: Date, w: UtcWindow): boolean | null {
  const start = minutesOfDay(w.start)
  const end = minutesOfDay(w.end)
  if (start === null || end === null) return null
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes()
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end
}

const outsideTradingHours: Rule = ({ policy, intent, now }) => {
  const w = policy.trade.tradingHoursUtc
  if (!w || intent.kind !== 'order') return null
  // Crypto trades round the clock, so a market-session window written for equities does not
  // describe it. Applying the window anyway would refuse every crypto order outside
  // 13:30-20:00 UTC, which is not the limit the user set: they set an equity session.
  if (intent.assetClass === 'crypto') return null
  const inside = withinWindow(now, w)
  if (inside === null) {
    return { verdict: 'DENY', code: 'HOURS_MALFORMED', reason: 'The trading-hours window in your policy is malformed.' }
  }
  return inside
    ? null
    : {
        verdict: 'DENY',
        code: 'OUTSIDE_HOURS',
        reason: `Now is outside your ${w.start}-${w.end} UTC trading window.`,
      }
}

/**
 * Concentration is checked on the post-action position, and only for buys: a sell reduces
 * concentration, so gating it would block the fix for a breach.
 */
const overConcentrated: Rule = ({ policy, intent, snapshot }) => {
  const limit = policy.trade.maxConcentrationPct
  if (limit >= 100 || intent.kind !== 'order' || intent.side !== 'buy') return null
  const sym = norm(intent.symbol)
  if (!sym) return null
  if (!snapshot) {
    return { verdict: 'DENY', code: 'CONCENTRATION_UNVERIFIABLE', reason: 'No account snapshot, so concentration cannot be checked.' }
  }
  const total = snapshot.portfolioValueUsd
  if (total === undefined || total <= 0) {
    return {
      verdict: 'DENY',
      code: 'CONCENTRATION_UNVERIFIABLE',
      reason: 'Portfolio value is unknown, so post-trade concentration cannot be checked.',
    }
  }
  const existing = snapshot.positions
    .filter((p) => norm(p.symbol) === sym)
    .reduce((a, p) => a + p.valueUsd, 0)
  const pct = ((existing + intent.notionalUsd) / (total + intent.notionalUsd)) * 100
  return pct > limit
    ? {
        verdict: 'DENY',
        code: 'CONCENTRATION',
        reason: `After this buy, ${sym} would be ${pct.toFixed(1)}% of the portfolio, above your ${limit}% limit.`,
      }
    : null
}

// ── spend-surface rules ──────────────────────────────────────────────────────────
//
// These add what the venue does not already give you. Robinhood's agent card carries a
// spending limit, a monthly cap and an approval toggle of its own, so the value here is
// WHERE and on WHAT the money goes, plus a refusal that arrives with a reason.

/** Merchant matching is substring and case-insensitive: venues report names inconsistently
 *  ("AMZN Mktp US*2H4" is Amazon), so exact matching would quietly fail to match. */
const matchesMerchant = (patterns: string[], merchant: string): boolean => {
  const m = merchant.trim().toLowerCase()
  if (!m) return false
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase()
    return pat.length > 0 && m.includes(pat)
  })
}

const spendPolicyOf = (policy: ActionPolicy) => policy.spend

const merchantDenied: Rule = ({ policy, intent }) => {
  const sp = spendPolicyOf(policy)
  if (!sp || !intent.merchant) return null
  return matchesMerchant(sp.merchantDeny, intent.merchant)
    ? { verdict: 'DENY', code: 'MERCHANT_DENIED', reason: `"${intent.merchant}" matches your merchant deny list.` }
    : null
}

const merchantNotAllowed: Rule = ({ policy, intent }) => {
  const sp = spendPolicyOf(policy)
  if (!sp) return null
  // Same distinction as the symbol allow list: an empty list is no restriction, a list of
  // junk is a restriction nothing satisfies.
  if (!sp.merchantAllow.length) return null
  const allow = sp.merchantAllow.filter((s) => s.trim())
  if (!allow.length) {
    return {
      verdict: 'DENY',
      code: 'MERCHANT_NOT_ALLOWED',
      reason: 'Your merchant allow list has no usable entries in it, so nothing can match it.',
    }
  }
  if (!intent.merchant) {
    // Under an allow list, a purchase with no merchant is exactly the case the rule needed
    // to see, so it fails closed.
    return { verdict: 'DENY', code: 'MERCHANT_UNKNOWN', reason: 'A merchant allow list is set but this purchase names no merchant.' }
  }
  return matchesMerchant(allow, intent.merchant)
    ? null
    : { verdict: 'DENY', code: 'MERCHANT_NOT_ALLOWED', reason: `"${intent.merchant}" is not on your merchant allow list.` }
}

/** Cash advance, quasi-cash and gambling by default. On a card an agent drives, these turn
 *  a spending mistake into one you cannot claw back. */
const categoryDenied: Rule = ({ policy, intent }) => {
  const sp = spendPolicyOf(policy)
  if (!sp) return null
  const category = resolveCategory(intent.mcc, intent.label)
  return sp.categoryDeny.map((c) => c.trim().toLowerCase()).includes(category)
    ? {
        verdict: 'DENY',
        code: 'CATEGORY_DENIED',
        reason: `This is a "${category.replace(/_/g, ' ')}" purchase, which your policy does not allow on an agent card.`,
      }
    : null
}

const categoryOverLimit: Rule = ({ policy, intent, snapshot }) => {
  const sp = spendPolicyOf(policy)
  if (!sp) return null
  const category = resolveCategory(intent.mcc, intent.label)
  const limit = sp.categoryLimits[category]
  if (limit === undefined) return null
  if (!snapshot) {
    return { verdict: 'DENY', code: 'CATEGORY_UNVERIFIABLE', reason: 'No account snapshot, so the category limit cannot be checked.' }
  }
  const spent = snapshot.categorySpentTodayUsd?.[category]
  if (spent === undefined) {
    return {
      verdict: 'DENY',
      code: 'CATEGORY_UNVERIFIABLE',
      reason: `Today's spend in "${category.replace(/_/g, ' ')}" is unknown, so its limit cannot be checked.`,
    }
  }
  const total = spent + intent.notionalUsd
  return total > limit
    ? {
        verdict: 'DENY',
        code: 'CATEGORY_LIMIT',
        reason: `This would bring "${category.replace(/_/g, ' ')}" to ${usd(total)} today, above your ${usd(limit)} limit${isKnownMcc(intent.mcc) ? '' : ' (category taken from the caller, not from a recognized MCC)'}.`,
      }
    : null
}

const cardOverCap: Rule = ({ policy, intent, snapshot }) => {
  const sp = spendPolicyOf(policy)
  if (!sp || !intent.cardId) return null
  const cap = sp.cardCaps[intent.cardId]
  if (cap === undefined) return null
  if (!snapshot) {
    return { verdict: 'DENY', code: 'CARD_CAP_UNVERIFIABLE', reason: 'No account snapshot, so the per-card ceiling cannot be checked.' }
  }
  const spent = snapshot.cardSpentTodayUsd?.[intent.cardId]
  if (spent === undefined) {
    return {
      verdict: 'DENY',
      code: 'CARD_CAP_UNVERIFIABLE',
      reason: `Today's spend on card ${intent.cardId} is unknown, so its ceiling cannot be checked.`,
    }
  }
  const total = spent + intent.notionalUsd
  return total > cap
    ? {
        verdict: 'DENY',
        code: 'CARD_CAP',
        reason: `This would bring card ${intent.cardId} to ${usd(total)} today, above its ${usd(cap)} ceiling.`,
      }
    : null
}

// ── non-order rules: the paths a cap-only policy misses ───────────────────────────

/** Cancelling a protective leg removes downside cover, so it is a risk increase. */
const protectiveCancel: Rule = ({ intent }) =>
  intent.kind === 'cancel' && intent.protective
    ? {
        verdict: 'WARN',
        code: 'PROTECTIVE_CANCEL',
        reason: 'This cancels a protective leg, which raises risk. A human should confirm.',
      }
    : null

/**
 * One approval on a recurring order authorizes every future execution, so it never meets
 * a per-action check again. The human is told that explicitly.
 */
const standingAuthority: Rule = ({ intent }) =>
  intent.kind === 'recurring'
    ? {
        verdict: 'WARN',
        code: 'STANDING_AUTHORITY',
        reason: `This creates a standing order${intent.cadence ? ` (${intent.cadence})` : ''} that will keep executing without a new check each time.`,
      }
    : null

/** Settings that raise risk. Margin and lending are refused outright under a no-margin policy. */
const RISK_RAISING_SETTINGS = new Set(['margin', 'lending', 'stock_lending', 'pdt', 'sweep'])

const riskRaisingSetting: Rule = ({ intent }) => {
  if (intent.kind !== 'settings') return null
  const key = (intent.settingKey ?? '').trim().toLowerCase()
  const enabling = intent.settingValue === true || intent.settingValue === 'true' || intent.settingValue === 1
  if (!key) {
    return { verdict: 'DENY', code: 'SETTING_UNKNOWN', reason: 'A settings change with no named switch cannot be evaluated.' }
  }
  if ((key === 'margin' || key.includes('lending')) && enabling) {
    return {
      verdict: 'DENY',
      code: 'SETTING_FORBIDDEN',
      reason: `Enabling "${key}" is forbidden: your policy sets margin and lending off, and that is not agent-changeable.`,
    }
  }
  return RISK_RAISING_SETTINGS.has(key)
    ? { verdict: 'WARN', code: 'SETTING_RISK', reason: `Changing "${key}" alters account risk without placing a trade. A human should confirm.` }
    : null
}

/** Money leaving the account is the highest-severity path, regardless of size. */
const transferGuard: Rule = ({ intent }) =>
  intent.kind === 'transfer'
    ? { verdict: 'WARN', code: 'TRANSFER', reason: 'Moving money out of the account always requires a human.' }
    : null

/** Pulling tax documents is data egress, not a trade. */
const documentGuard: Rule = ({ intent }) =>
  intent.kind === 'document'
    ? { verdict: 'WARN', code: 'DOCUMENT_EGRESS', reason: 'Downloading account documents needs a human. It is data egress, not a trade.' }
    : null

// ── the rule sets, as DATA per surface ───────────────────────────────────────────

const SHARED: Rule[] = [frozen, perActionCap, dailyCap, humanApproval]

const TRADE_RULES: Rule[] = [
  ...SHARED,
  symbolDenied,
  symbolNotAllowed,
  optionsBlocked,
  marginBlocked,
  outsideTradingHours,
  overConcentrated,
  protectiveCancel,
  standingAuthority,
  riskRaisingSetting,
  transferGuard,
  documentGuard,
]

/** Adding a surface adds an entry here, not a branch in the pipeline. */
const SPEND_RULES: Rule[] = [
  ...SHARED,
  merchantDenied,
  merchantNotAllowed,
  categoryDenied,
  categoryOverLimit,
  cardOverCap,
  standingAuthority,
  transferGuard,
]

/** Adding a surface adds an entry here, not a branch in the pipeline. */
const RULES_BY_SURFACE: Record<Surface, Rule[]> = {
  trade: TRADE_RULES,
  spend: SPEND_RULES,
  // Phase 7 is schema only by design, and the registry keeps `bet` planned, so it is
  // refused before any rule would run.
  bet: SHARED,
}

// ── the pipeline ─────────────────────────────────────────────────────────────────

const UNVERIFIABLE_CODES = new Set([
  'DAILY_CAP_UNVERIFIABLE',
  'MARGIN_UNVERIFIABLE',
  'CONCENTRATION_UNVERIFIABLE',
  'CATEGORY_UNVERIFIABLE',
  'CARD_CAP_UNVERIFIABLE',
])

function deny(surface: Surface, intent: NormalizedIntent, policy: ActionPolicy, code: string, reason: string): Decision {
  return {
    verdict: 'DENY',
    reasons: [reason],
    codes: [code],
    surface,
    kind: intent.kind,
    policyId: policy.policyId,
    policyVersion: policy.version,
    unverifiable: UNVERIFIABLE_CODES.has(code),
  }
}

/**
 * Evaluate one action against one policy. The only entry point.
 *
 * `now` is injected so the result is reproducible: the same inputs at the same instant
 * always yield the same decision, which is what makes the audit trail meaningful and the
 * unit tests deterministic (same pattern as `computeAgentReputation(s, asOf)`).
 */
export function evaluateAction(input: {
  surface: string
  policy: ActionPolicy
  intent: NormalizedIntent
  snapshot?: AccountSnapshot
  now?: Date
}): Decision {
  const { policy, intent, snapshot } = input
  const now = input.now ?? new Date()

  const descriptor = getSurface(input.surface)
  if (!descriptor) {
    return deny('trade', intent, policy, 'UNKNOWN_SURFACE', `Unknown surface "${input.surface}".`)
  }
  const surface = descriptor.id

  // A planned surface has a fixed schema so callers can be built, but it must never
  // authorize anything. Honest status, enforced rather than documented.
  if (descriptor.status !== 'live') {
    return deny(surface, intent, policy, 'SURFACE_NOT_LIVE', `The ${descriptor.name} surface is not live yet, so no action can be authorized.`)
  }

  if (!descriptor.kinds.includes(intent.kind)) {
    return deny(surface, intent, policy, 'KIND_NOT_ON_SURFACE', `Action kind "${intent.kind}" is not valid on the ${descriptor.name} surface.`)
  }

  // Malformed intent is refused, not guessed at. An unparseable preview is exactly the
  // case where a policy layer must not wave something through.
  if (!Number.isFinite(intent.notionalUsd) || intent.notionalUsd < 0) {
    return deny(surface, intent, policy, 'INTENT_MALFORMED', 'The action has no usable USD amount, so it cannot be checked.')
  }

  const ctx: RuleContext = { policy, intent, snapshot, now }
  const findings = RULES_BY_SURFACE[surface].map((r) => r(ctx)).filter((f): f is RuleFinding => f !== null)

  if (!findings.length) {
    return {
      verdict: 'ALLOW',
      reasons: [],
      codes: [],
      surface,
      kind: intent.kind,
      policyId: policy.policyId,
      policyVersion: policy.version,
      unverifiable: false,
    }
  }

  // DENY beats WARN. Every finding is reported either way, so one round trip tells the
  // human everything that is wrong instead of revealing it one refusal at a time.
  const denied = findings.some((f) => f.verdict === 'DENY')
  return {
    verdict: denied ? 'DENY' : 'WARN',
    reasons: findings.map((f) => f.reason),
    codes: findings.map((f) => f.code),
    surface,
    kind: intent.kind,
    policyId: policy.policyId,
    policyVersion: policy.version,
    unverifiable: findings.some((f) => UNVERIFIABLE_CODES.has(f.code)),
  }
}

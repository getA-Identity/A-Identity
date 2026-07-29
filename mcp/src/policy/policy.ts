/**
 * Policy defaults and the sanitizer (Phase 1.1).
 *
 * Same job `sanitizePermissions` does for the USDC surface in platform.ts, and the same
 * hard lesson behind it: an unclamped 1e308 approval line silently disables human
 * approval, and a NaN cap compares false against everything. Only well-formed fields
 * survive to be merged, and the guardrail defaults are chosen so that a policy the user
 * has not finished configuring is still safe.
 */
import type { ActionPolicy, SpendPolicy, TradePolicy } from './types.js'
import { HIGH_RISK_CATEGORIES } from './mcc.js'

/** Same ceiling `sanitizePermissions` uses, so the two surfaces cannot disagree. */
const MAX_USD = 1_000_000
const MAX_LIST = 100
const MAX_SYMBOL_LEN = 12

/**
 * Safe-by-default guardrails (Phase 2.2 fixes these as the skill's defaults too):
 * options off, margin off and unflippable, a $100 human-approval line, and caps low
 * enough that an unconfigured policy cannot do real damage.
 */
export const DEFAULT_TRADE_POLICY: TradePolicy = {
  allowSymbols: [],
  denySymbols: [],
  allowOptions: false,
  allowMargin: false,
  tradingHoursUtc: null,
  maxConcentrationPct: 100,
}

export const DEFAULT_SPEND_POLICY: SpendPolicy = {
  merchantAllow: [],
  merchantDeny: [],
  categoryLimits: {},
  cardCaps: {},
  // Cash advance, quasi-cash and gambling are denied out of the box. Emptying the list is
  // the user's call; arriving at it by default is not.
  categoryDeny: [...HIGH_RISK_CATEGORIES],
}

export function defaultActionPolicy(policyId: string, updatedAt: string): ActionPolicy {
  return {
    policyId,
    version: 1,
    updatedAt,
    frozen: false,
    perActionCapUsd: 100,
    dailyCapUsd: 500,
    humanApprovalAboveUsd: 100,
    trade: { ...DEFAULT_TRADE_POLICY },
    spend: { ...DEFAULT_SPEND_POLICY },
  }
}

const clampUsd = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_USD, Math.max(0, v)) : undefined

const clampPct = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : undefined

const symbolList = (v: unknown): string[] | undefined =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim().toUpperCase())
        .filter((x) => x.length > 0 && x.length <= MAX_SYMBOL_LEN)
        .slice(0, MAX_LIST)
    : undefined

const isHhMm = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())

/**
 * Sanitize a client-supplied trade-policy patch.
 *
 * `allowMargin` is deliberately absent: it is the literal `false` in the type and is set
 * from the default, so no client patch can turn margin on. That is the one guardrail we
 * do not expose as a switch, and leaving it out of the sanitizer is how that is enforced
 * at runtime as well as at compile time.
 */
export function sanitizeTradePolicy(partial: unknown): Partial<TradePolicy> {
  const out: Partial<TradePolicy> = {}
  if (typeof partial !== 'object' || partial === null) return out
  const p = partial as Record<string, unknown>

  const allow = symbolList(p.allowSymbols)
  if (allow) out.allowSymbols = allow
  const deny = symbolList(p.denySymbols)
  if (deny) out.denySymbols = deny
  if (p.allowOptions !== undefined) out.allowOptions = Boolean(p.allowOptions)
  const pct = clampPct(p.maxConcentrationPct)
  if (pct !== undefined) out.maxConcentrationPct = pct

  if (p.tradingHoursUtc === null) {
    out.tradingHoursUtc = null
  } else if (typeof p.tradingHoursUtc === 'object' && p.tradingHoursUtc !== null) {
    const w = p.tradingHoursUtc as Record<string, unknown>
    // A half-specified or malformed window is dropped rather than half-applied: the
    // engine DENYs on a malformed window, and silently inventing the missing half would
    // be worse than having no window at all.
    if (isHhMm(w.start) && isHhMm(w.end)) {
      out.tradingHoursUtc = { start: w.start.trim(), end: w.end.trim() }
    }
  }
  return out
}

/** Sanitize a client-supplied policy patch. Version and timestamp are server-owned. */
export function sanitizeActionPolicy(partial: unknown): Partial<Omit<ActionPolicy, 'policyId' | 'version' | 'updatedAt'>> {
  const out: Partial<Omit<ActionPolicy, 'policyId' | 'version' | 'updatedAt'>> = {}
  if (typeof partial !== 'object' || partial === null) return out
  const p = partial as Record<string, unknown>

  const perAction = clampUsd(p.perActionCapUsd)
  if (perAction !== undefined) out.perActionCapUsd = perAction
  const daily = clampUsd(p.dailyCapUsd)
  if (daily !== undefined) out.dailyCapUsd = daily
  const approval = clampUsd(p.humanApprovalAboveUsd)
  if (approval !== undefined) out.humanApprovalAboveUsd = approval
  if (p.frozen !== undefined) out.frozen = Boolean(p.frozen)

  if (p.trade !== undefined) {
    const trade = sanitizeTradePolicy(p.trade)
    if (Object.keys(trade).length) out.trade = { ...DEFAULT_TRADE_POLICY, ...trade }
  }
  if (p.spend !== undefined) {
    const spend = sanitizeSpendPolicy(p.spend)
    if (Object.keys(spend).length) out.spend = { ...DEFAULT_SPEND_POLICY, ...spend }
  }
  return out
}

const MAX_MERCHANT_LEN = 60
const MAX_CATEGORY_LEN = 40

const stringList = (v: unknown, maxLen: number): string[] | undefined =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => x.length > 0 && x.length <= maxLen)
        .slice(0, MAX_LIST)
    : undefined

/** A {key: usd} map, with both halves bounded. */
const usdMap = (v: unknown, keyMaxLen: number): Record<string, number> | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, raw] of Object.entries(v as Record<string, unknown>).slice(0, MAX_LIST)) {
    const key = k.trim().toLowerCase()
    const amount = clampUsd(raw)
    if (key && key.length <= keyMaxLen && amount !== undefined) out[key] = amount
  }
  return out
}

/** Sanitize a client-supplied spend-policy patch. */
export function sanitizeSpendPolicy(partial: unknown): Partial<SpendPolicy> {
  const out: Partial<SpendPolicy> = {}
  if (typeof partial !== 'object' || partial === null) return out
  const p = partial as Record<string, unknown>

  const allow = stringList(p.merchantAllow, MAX_MERCHANT_LEN)
  if (allow) out.merchantAllow = allow
  const deny = stringList(p.merchantDeny, MAX_MERCHANT_LEN)
  if (deny) out.merchantDeny = deny
  const catDeny = stringList(p.categoryDeny, MAX_CATEGORY_LEN)
  if (catDeny) out.categoryDeny = catDeny.map((c) => c.toLowerCase().replace(/\s+/g, '_'))
  const catLimits = usdMap(p.categoryLimits, MAX_CATEGORY_LEN)
  if (catLimits) out.categoryLimits = catLimits
  const cardCaps = usdMap(p.cardCaps, MAX_CATEGORY_LEN)
  if (cardCaps) out.cardCaps = cardCaps
  return out
}

/**
 * Normalize whatever is in storage into a usable policy (Phase 1.3).
 *
 * Persisted state is JSON in Postgres or a file, written by older builds and hand-editable
 * in dev, so a stored policy can be absent, partial, or shaped like a previous version.
 * The engine must never see `undefined.trade`, and a half-written policy must not read as
 * permissive, so everything is merged over the safe defaults.
 *
 * `configured` distinguishes "the user set this" from "this is the default we are showing
 * them", which the UI needs in order not to imply the user made choices they never made.
 */
export function resolveActionPolicy(
  stored: unknown,
  fallbackPolicyId: string,
  now: string,
): { policy: ActionPolicy; configured: boolean } {
  const base = defaultActionPolicy(fallbackPolicyId, now)
  if (typeof stored !== 'object' || stored === null) return { policy: base, configured: false }

  const s = stored as Record<string, unknown>
  const clean = sanitizeActionPolicy(s)
  const version = typeof s.version === 'number' && Number.isFinite(s.version) && s.version >= 1 ? Math.floor(s.version) : 1
  return {
    policy: {
      ...base,
      ...clean,
      policyId: typeof s.policyId === 'string' && s.policyId ? s.policyId : fallbackPolicyId,
      version,
      updatedAt: typeof s.updatedAt === 'string' && s.updatedAt ? s.updatedAt : now,
      // Merge the block explicitly: a stored policy missing `trade` entirely must still
      // come back with the safe defaults rather than an undefined block.
      trade: { ...base.trade, ...(clean.trade ?? {}), allowMargin: false },
      spend: { ...base.spend, ...(clean.spend ?? {}) } as ActionPolicy['spend'],
    },
    configured: true,
  }
}

/**
 * Merge a sanitized patch onto an existing policy, bumping the version. Kept here so the
 * version can never be bumped without going through the sanitizer.
 */
export function applyPolicyPatch(current: ActionPolicy, patch: unknown, updatedAt: string): ActionPolicy {
  const clean = sanitizeActionPolicy(patch)
  return {
    ...current,
    ...clean,
    // Margin stays off no matter what arrives, belt and braces with the literal type.
    trade: { ...current.trade, ...(clean.trade ?? {}), allowMargin: false },
    spend: { ...(current.spend ?? DEFAULT_SPEND_POLICY), ...(clean.spend ?? {}) },
    version: current.version + 1,
    updatedAt,
  }
}

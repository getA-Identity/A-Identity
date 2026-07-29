/**
 * Merchant category handling for the spend surface (Phase 4).
 *
 * ISO 18245 defines several hundred merchant category codes. This map is DELIBERATELY
 * SMALL: it covers only codes whose meaning is unambiguous and well established, because a
 * wrong mapping here would silently apply the wrong spending limit to a real purchase, and
 * a confidently wrong category is worse than no category at all.
 *
 * Anything not listed falls back to the category label the caller supplied, and if the
 * caller supplied none, to `uncategorized`. A policy that limits `uncategorized` therefore
 * still bites, which keeps the unknown case safe rather than exempt.
 */

/** The three categories an agent-driven card should not quietly reach. */
export const HIGH_RISK_CATEGORIES = ['cash_advance', 'quasi_cash', 'gambling'] as const

/** Unambiguous, widely documented MCCs only. */
const MCC_CATEGORY: Record<string, string> = {
  // Cash and cash-like. On an agent card these are the ones that turn a mistake into an
  // unrecoverable one, which is why they are the default deny set.
  '6010': 'cash_advance', // manual cash disbursement
  '6011': 'cash_advance', // ATM / automated cash disbursement
  '6051': 'quasi_cash', // non-financial institutions: money orders, foreign currency, crypto
  '7995': 'gambling', // betting, casino gaming

  // Everyday categories, useful for per-category ceilings.
  '5411': 'groceries', // grocery stores, supermarkets
  '5812': 'restaurants', // eating places, restaurants
  '5814': 'fast_food', // fast food restaurants
  '5541': 'fuel', // service stations
  '5542': 'fuel', // automated fuel dispensers
  '4111': 'transit', // local commuter transport
  '4121': 'rideshare_taxi', // taxicabs, limousines
  '4511': 'airlines', // airlines, air carriers
  '7011': 'lodging', // lodging, hotels, resorts
  '5912': 'pharmacy', // drug stores, pharmacies
  '5734': 'software', // computer software stores
  '5968': 'subscriptions', // direct marketing: continuity, subscription merchants
}

/**
 * Resolve a spending category. The MCC wins when we recognize it, since it comes from the
 * card network rather than from a name someone typed.
 */
export function resolveCategory(mcc?: string, fallback?: string): string {
  const code = (mcc ?? '').trim()
  const known = MCC_CATEGORY[code]
  if (known) return known
  const label = (fallback ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  return label || 'uncategorized'
}

/** True when we recognize this MCC at all. Used to be honest in a reason string. */
export function isKnownMcc(mcc?: string): boolean {
  return Boolean(MCC_CATEGORY[(mcc ?? '').trim()])
}

/** How many codes we claim to know. Kept honest in the docs and asserted in tests. */
export const KNOWN_MCC_COUNT = Object.keys(MCC_CATEGORY).length

/**
 * Module-scope types, consts, and pure helpers of the marketplace screen,
 * moved verbatim from Marketplace.tsx and shared with the marketplace/
 * components. Must preserve the exact shapes and values: the SORT_KEYS order
 * drives the sort dropdown, the saved-search revival defaults keep older
 * localStorage presets alive, and fmtUsd/cheapestService feed the price line.
 *
 * MarketAgent here is the roster's own shape; a deliberately diverged twin
 * lives in src/components/app/profile/types.ts (that one makes `chain`
 * optional, lifts `positivePct` out of `feedbackBreakdown`, and adds
 * `registration`). The two screens read different slices of the same payload;
 * do not try to unify them.
 */

import type { CSSProperties } from 'react'

export type Service = { name: string; priceUsd: number; unit: string }

export type MarketAgent = {
  id: string
  name: string
  logoUrl?: string
  description: string
  category: string
  capabilities: string[]
  /** The chain this agent's identity and payable wallet live on. Stays the primary one:
   *  the wallet line and every settlement claim are about THIS chain. */
  chain: string
  /**
   * Every network the agent is really registered on, identity chain first, as registry
   * chain slugs. The backend rolls it up from the agent's identity chain plus the chains
   * we have deployed its spend vaults on (see agentChainIds in mcp/src/marketplace.ts),
   * so it is never padded with a chain we merely support.
   *
   * Optional so a payload that has not started sending it degrades to the single `chain`
   * instead of emptying the card. Absent means "we were not told", not "one chain".
   */
  chains?: string[]
  kya: string
  onchain: string
  onchainTx?: string
  onchainExplorer?: string
  onchainAgentId?: string
  reputation?: { score: number; breakdown: { settlement: number; validation: number; tenure: number } }
  walletAddress: string | null
  followers: number
  followedByViewer: boolean
  activity: { at: string; text: string }[]
  createdAt: string
  // Commerce fields (all real backend state; optional so an older payload degrades
  // to the plain card instead of crashing the roster).
  services?: Service[]
  priceFromUsd?: number | null
  soldCount?: number
  feedback?: { avg: number | null; count: number }
  feedbackBreakdown?: { positive: number; neutral: number; negative: number; positivePct: number | null }
  online?: boolean
  payments?: string[]
  cardStyle?: number | null
  /**
   * Paid tier, for the Pro / Premium badge in a card's corner. NOT SERVED YET:
   * we sell no tiers, no agent record carries one, and the badge that reads this
   * therefore renders for nobody. Declared here so the component is typed and
   * ready the day the marketplace payload starts sending it. See TierBadge in
   * AgentCardChrome.tsx.
   */
  tier?: 'pro' | 'premium' | null
}

export type SortKey = 'default' | 'reputation' | 'followers' | 'newest' | 'rating' | 'price' | 'selling'
export const SORT_KEYS: SortKey[] = ['default', 'reputation', 'followers', 'newest', 'rating', 'price', 'selling']
export const SORT_LABELS: Record<SortKey, string> = {
  default: 'Default',
  reputation: 'Top reputation',
  followers: 'Most followed',
  newest: 'Newest',
  rating: 'Highest rating',
  price: 'Lowest price',
  selling: 'Best selling',
}

export type PayFilter = 'all' | 'escrow' | 'x402'

/** A saved toolbar preset. Older entries (query/sort/showAll/view only) are
 *  revived with defaults for the newer filter fields, so nothing saved before
 *  this redesign is lost or crashes the parse. */
export type SavedSearch = {
  name: string
  query: string
  sort: SortKey
  showAll: boolean
  view: 'list' | 'grid'
  cats: string[]
  online: boolean
  pay: PayFilter
  chain: string
}

export function reviveSavedSearches(raw: string | null): SavedSearch[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
      .filter((x) => typeof x.name === 'string')
      .map((x) => ({
        name: x.name as string,
        query: typeof x.query === 'string' ? x.query : '',
        sort: SORT_KEYS.includes(x.sort as SortKey) ? (x.sort as SortKey) : 'default',
        showAll: Boolean(x.showAll),
        view: x.view === 'grid' ? 'grid' : 'list',
        cats: Array.isArray(x.cats) ? (x.cats as unknown[]).filter((c): c is string => typeof c === 'string') : [],
        online: Boolean(x.online),
        pay: x.pay === 'escrow' || x.pay === 'x402' ? x.pay : 'all',
        chain: typeof x.chain === 'string' ? x.chain : 'all',
      }))
  } catch {
    return []
  }
}

export const fmtUsd = (n: number) => (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2))

/** The cheapest listed service, for the "from $X per unit" line. Falls back to the
 *  server's priceFromUsd (without a unit) if the services array is ever absent.
 *
 *  Takes only the two price fields, not a whole MarketAgent, so the agent profile
 *  can reuse it: that screen's deliberately diverged twin of MarketAgent carries
 *  the identical `services` and `priceFromUsd` shapes but makes `chain` optional. */
export function cheapestService(
  a: Pick<MarketAgent, 'services' | 'priceFromUsd'>,
): { priceUsd: number; unit: string } | null {
  if (a.services && a.services.length > 0) {
    const s = a.services.reduce((min, sv) => (sv.priceUsd < min.priceUsd ? sv : min))
    return { priceUsd: s.priceUsd, unit: s.unit.replace(/^per\s+/i, '').trim() }
  }
  if (typeof a.priceFromUsd === 'number') return { priceUsd: a.priceFromUsd, unit: '' }
  return null
}

/* ------------------------------------------------------- storefront card paint */

/** Category-to-tint map, mirrored from src/components/AgentAvatar.tsx. */
const AVATAR_TINTS: { match: RegExp; tint: number }[] = [
  { match: /trad|financ|defi|invest/i, tint: 1 },
  { match: /research|data|analy/i, tint: 2 },
  { match: /content|writ|market/i, tint: 3 },
  { match: /dev|code|ops|engineer/i, tint: 4 },
  { match: /support|service|customer/i, tint: 5 },
]

function hashSeed(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

/**
 * Which of the six --cat tokens paints this agent's card banner.
 *
 * The owner's picked card style wins, because that is a real stored choice. With
 * none set we fall back to exactly the tint AgentAvatar derives (category match
 * first, then a stable hash of the seed), so the banner can never disagree with
 * the mark sitting on it. That mapping is duplicated above on purpose:
 * AgentAvatar is owned elsewhere and exports no tint helper. If its CATEGORIES
 * list ever changes, mirror it here; that file stays the source of truth.
 */
export function cardTint(a: {
  cardStyle?: number | null
  category?: string
  onchainAgentId?: string
  id: string
}): number {
  if (typeof a.cardStyle === 'number' && a.cardStyle >= 1 && a.cardStyle <= 6) return Math.round(a.cardStyle)
  const known = a.category ? AVATAR_TINTS.find((c) => c.match.test(a.category as string)) : undefined
  if (known) return known.tint
  return (hashSeed(a.onchainAgentId || a.id) % 6) + 1
}

/** The banner paint: two soft lights over a diagonal ramp of the agent's own tint. */
export function bannerStyle(tint: number): CSSProperties {
  const c = `var(--cat-${tint})`
  return {
    backgroundColor: c,
    backgroundImage: [
      `radial-gradient(115% 150% at 12% 12%, color-mix(in srgb, ${c} 40%, white) 0%, transparent 58%)`,
      `radial-gradient(95% 130% at 88% 4%, color-mix(in srgb, var(--accent) 70%, transparent) 0%, transparent 64%)`,
      `linear-gradient(128deg, ${c} 0%, color-mix(in srgb, ${c} 42%, var(--accent-deep)) 100%)`,
    ].join(', '),
  }
}

/**
 * The class that turns AgentAvatar's rounded square into the storefront circle.
 *
 * AgentAvatar is owned elsewhere, so the circle is imposed from the outside: the
 * two child variants round the mark itself (an img for an uploaded logo, a div
 * for the generated glyph) and leave the verdict owl, a span, untouched. A logo
 * must never hide a risk signal, so the owl stays exactly where AgentAvatar puts it.
 */
export const CIRCLE_MARK = 'rounded-full [&>img]:rounded-full [&>img]:border-0 [&>div]:rounded-full'

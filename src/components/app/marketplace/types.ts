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

export type Service = { name: string; priceUsd: number; unit: string }

export type MarketAgent = {
  id: string
  name: string
  logoUrl?: string
  description: string
  category: string
  capabilities: string[]
  chain: string
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
 *  server's priceFromUsd (without a unit) if the services array is ever absent. */
export function cheapestService(a: MarketAgent): { priceUsd: number; unit: string } | null {
  if (a.services && a.services.length > 0) {
    const s = a.services.reduce((min, sv) => (sv.priceUsd < min.priceUsd ? sv : min))
    return { priceUsd: s.priceUsd, unit: s.unit.replace(/^per\s+/i, '').trim() }
  }
  if (typeof a.priceFromUsd === 'number') return { priceUsd: a.priceFromUsd, unit: '' }
  return null
}

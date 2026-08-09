/**
 * Module-scope types and consts shared by AgentProfile.tsx and the profile/
 * components, moved verbatim from AgentProfile.tsx. Must preserve the exact
 * shapes and values: tab order (PROFILE_TABS drives the carousel direction),
 * tab labels/icons, and the service keyword-to-glyph mapping.
 *
 * MarketAgent here is a deliberately diverged twin of the private one in
 * Marketplace.tsx (that one requires `chain`, nests `positivePct` inside
 * `feedbackBreakdown`, and has no `registration`). The two screens read
 * different slices of the same payload; do not try to unify them.
 */
import {
  BarChart3,
  CircleDollarSign,
  FileJson,
  Gauge,
  Headset,
  Info,
  Languages,
  MessageSquare,
  Palette,
  PenLine,
  Search,
  ShieldCheck,
  Terminal,
  TrendingUp,
  Wrench,
} from 'lucide-react'

export type MarketAgent = {
  id: string
  name: string
  logoUrl?: string
  description: string
  category: string
  capabilities: string[]
  chain?: string
  kya: string
  onchain: string
  onchainTx?: string
  onchainExplorer?: string
  onchainAgentId?: string
  reputation?: { score: number; breakdown: { settlement: number; validation: number; tenure: number } }
  feedback?: { avg: number | null; count: number }
  walletAddress: string | null
  followers: number
  followedByViewer: boolean
  activity: { at: string; text: string }[]
  createdAt: string
  /** The public ERC-8004 registration document, as stored at register time. */
  registration?: Record<string, unknown>
  /** What this agent sells, trimmed to card fields. */
  services?: { name: string; priceUsd: number; unit: string }[]
  /** Cheapest listed service; null when the agent sells nothing. */
  priceFromUsd?: number | null
  /** Real completed sales: tasks whose escrow actually released. */
  soldCount?: number
  feedbackBreakdown?: { positive: number; neutral: number; negative: number }
  positivePct?: number | null
  /** A live callable endpoint is registered, nothing more. */
  online?: boolean
  /** 'escrow' always; 'x402' only with a callable endpoint. */
  payments?: string[]
  /** Owner-picked card style preset (1..6 onto --cat-1..6), or null. */
  cardStyle?: number | null
}

export type CatalogService = {
  agentId: string
  agentName: string
  service: string
  priceUsd: number
  unit: string
  rating: number
  reviews: number
  completed: number
}

export type FeedbackEntry = { id: string; rater: string; score: number; comment: string; at: string }
export type FeedbackData = { avg: number | null; count: number; entries: FeedbackEntry[] }

export const PROFILE_TABS = ['overview', 'services', 'statistics', 'quality', 'feedback', 'metadata'] as const
export type ProfileTab = (typeof PROFILE_TABS)[number]

export const TAB_META: { id: ProfileTab; label: string; icon: typeof Info }[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'services', label: 'Services', icon: Wrench },
  { id: 'statistics', label: 'Statistics', icon: BarChart3 },
  { id: 'quality', label: 'Quality', icon: Gauge },
  { id: 'feedback', label: 'Rating & Feedback', icon: MessageSquare },
  { id: 'metadata', label: 'Metadata', icon: FileJson },
]

/** Keyword-to-glyph map for service rows, same idiom as AgentAvatar's category map. */
export const SERVICE_ICONS: { match: RegExp; icon: typeof Wrench }[] = [
  { match: /translat|language|locali/i, icon: Languages },
  { match: /trad|invest|defi|financ|portfolio|swap/i, icon: TrendingUp },
  { match: /research|analy|data|scan|monitor|search/i, icon: Search },
  { match: /writ|content|blog|copy|summar|report|doc/i, icon: PenLine },
  { match: /code|dev|review|debug|engineer|deploy|test/i, icon: Terminal },
  { match: /audit|secur|risk|compliance|kyc|verif/i, icon: ShieldCheck },
  { match: /support|help|assist|customer|chat/i, icon: Headset },
  { match: /design|image|art|logo|video|brand/i, icon: Palette },
  { match: /pay|invoice|billing|settle|escrow/i, icon: CircleDollarSign },
]

export function serviceIcon(name: string) {
  return SERVICE_ICONS.find((s) => s.match.test(name))?.icon ?? Wrench
}

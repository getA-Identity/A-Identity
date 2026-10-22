import {
  CalendarCheck2,
  CheckCircle2,
  Fingerprint,
  Handshake,
  LayoutDashboard,
  Link2,
  ListOrdered,
  LoaderCircle,
  ShieldCheck,
  SlidersHorizontal,
  Telescope,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import type { ChainStatus } from '../../lib/chains'
import type { RoadmapStatus, RoadmapTrackId } from '../../lib/roadmap'

/**
 * How each status and track is drawn, in one place, so the legend, the summary tiles, the
 * filter buttons and the cards cannot disagree.
 *
 * Tone is meaning, drawn from the semantic tokens only. Shipped is `ok` because it is done
 * and checkable; in progress is the accent because it is the live edge of the product;
 * committed is `warn` because a date we owe is the one thing on this page to watch; next
 * and later are neutral, at two weights, because neither carries a date and the page should
 * not pretend otherwise. Every status also has its own glyph, so colour is never the only
 * channel.
 */
export const STATUS_UI: Record<
  RoadmapStatus,
  { Icon: LucideIcon; chip: string; dot: string; number: string }
> = {
  shipped: {
    Icon: CheckCircle2,
    chip: 'bg-ok/10 text-ok ring-ok/25',
    dot: 'border-ok bg-ok',
    number: 'text-ok',
  },
  'in-progress': {
    Icon: LoaderCircle,
    chip: 'bg-accent/10 text-accent ring-accent/20',
    dot: 'border-accent bg-accent',
    number: 'text-accent',
  },
  committed: {
    Icon: CalendarCheck2,
    chip: 'bg-warn/12 text-warn ring-warn/30',
    dot: 'border-warn bg-warn',
    number: 'text-warn',
  },
  next: {
    Icon: ListOrdered,
    chip: 'bg-foreground/[0.06] text-foreground/70 ring-foreground/10',
    dot: 'border-foreground/40 bg-background',
    number: 'text-foreground/75',
  },
  later: {
    Icon: Telescope,
    chip: 'bg-transparent text-foreground/60 ring-foreground/20',
    dot: 'border-foreground/25 bg-background',
    number: 'text-foreground/50',
  },
}

export const TRACK_ICON: Record<RoadmapTrackId, LucideIcon> = {
  identity: Fingerprint,
  'spending-limits': SlidersHorizontal,
  'payment-rails': Zap,
  chains: Link2,
  platform: LayoutDashboard,
  'trust-security': ShieldCheck,
  ecosystem: Handshake,
}

/** The registry's lifecycle statuses, in the order the summary lists them. */
export const CHAIN_STATUS_ORDER: readonly ChainStatus[] = ['live', 'beta', 'planned', 'deprecated']

export const CHAIN_STATUS_UI: Record<ChainStatus, { label: string; cls: string }> = {
  live: { label: 'Live', cls: 'text-ok' },
  beta: { label: 'Beta', cls: 'text-warn' },
  planned: { label: 'Planned', cls: 'text-foreground/55' },
  deprecated: { label: 'Deprecated', cls: 'text-danger' },
}

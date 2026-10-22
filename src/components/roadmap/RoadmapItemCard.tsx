import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, ChevronDown } from 'lucide-react'
import ChainLogo from '../app/ChainLogo'
import { CHAIN_BY_ID } from '../../lib/chains'
import { resolveEvidence, trackMeta, type RoadmapItem, type RoadmapLink } from '../../lib/roadmap'
import { revealAt } from '../ui/section'
import { cn } from '../../lib/utils'
import { StatusBadge } from './StatusBadge'
import { STATUS_UI, TRACK_ICON } from './roadmap-ui'

/**
 * One evidence link, drawn as a small pill. A route goes through the router; an API answer,
 * a well-known document, a docs page or a repository file opens in a new tab and says so
 * with the arrow, because leaving the site should never be a surprise.
 */
function EvidenceLink({ link }: { link: RoadmapLink }) {
  const { href, kind } = resolveEvidence(link.href)
  const cls =
    'inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11.5px] font-semibold leading-tight text-foreground/80 transition-colors hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  if (kind === 'route') {
    return (
      <Link to={href} className={cls}>
        <span className="truncate">{link.label}</span>
      </Link>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      <span className="truncate">{link.label}</span>
      <ArrowUpRight size={12} aria-hidden="true" className="shrink-0" />
    </a>
  )
}

/**
 * The card every section shares: the status (when the section does not already say it),
 * the track, the date or the due date, the title, the summary, the longer text behind a
 * native disclosure, then the chains and the evidence pinned to the foot so a row of cards
 * aligns. `marker` is the timeline's slot for its dot, drawn outside the card.
 */
export function RoadmapItemCard({
  item,
  index = 0,
  showStatus = false,
  marker,
  className = '',
}: {
  item: RoadmapItem
  index?: number
  showStatus?: boolean
  marker?: ReactNode
  className?: string
}) {
  const track = trackMeta(item.track)
  const TrackIcon = TRACK_ICON[item.track]
  const chains = (item.chains ?? []).map((id) => CHAIN_BY_ID[id]).filter(Boolean)
  const when =
    item.status === 'shipped' && item.date ? (
      <time dateTime={item.date} className="font-mono text-[11px] tracking-[0.08em] text-foreground/50">
        {item.date}
      </time>
    ) : item.status === 'committed' && item.due ? (
      <span className={cn('font-mono text-[11px] uppercase tracking-[0.08em]', STATUS_UI.committed.number)}>
        Due <time dateTime={item.due}>{item.due}</time>
      </span>
    ) : null

  return (
    <motion.li
      {...revealAt(index % 2)}
      className={cn('relative flex flex-col rounded-2xl border border-border bg-card p-5 sm:p-6', className)}
    >
      {marker}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {showStatus && <StatusBadge status={item.status} />}
        <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/55">
          <TrackIcon size={12} strokeWidth={2.2} aria-hidden="true" />
          {track.label}
        </span>
        {when && <span className="ml-auto">{when}</span>}
      </div>

      <h3
        className="mt-3 text-[1.1rem] font-bold leading-snug tracking-tight text-foreground sm:text-xl"
        style={{ fontFamily: 'var(--font-heading)' }}
      >
        {item.title}
      </h3>
      <p className="mt-2 text-[14.5px] leading-relaxed text-foreground/70">{item.summary}</p>

      {item.details && (
        <details className="group mt-3">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12.5px] font-semibold text-accent underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            More
            <ChevronDown
              size={13}
              aria-hidden="true"
              className="transition-transform duration-200 group-open:rotate-180"
            />
          </summary>
          <p className="mt-2 text-[13.5px] leading-relaxed text-foreground/70">{item.details}</p>
        </details>
      )}

      {(chains.length > 0 || (item.evidence?.length ?? 0) > 0) && (
        <div className="mt-auto space-y-2.5 border-t border-border pt-3.5">
          {chains.length > 0 && (
            <ul className="flex flex-wrap items-center gap-1.5" aria-label="Chains">
              {chains.map((c) => (
                <li
                  key={c.id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.04] py-0.5 pl-0.5 pr-2 text-[11px] font-semibold text-foreground/75"
                >
                  <ChainLogo id={c.id} size={18} />
                  {c.shortName}
                </li>
              ))}
            </ul>
          )}
          {item.evidence && item.evidence.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">
                Check
              </span>
              {item.evidence.map((ev) => (
                <EvidenceLink key={`${ev.href}:${ev.label}`} link={ev} />
              ))}
            </div>
          )}
        </div>
      )}
    </motion.li>
  )
}

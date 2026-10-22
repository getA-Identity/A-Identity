import { motion } from 'framer-motion'
import ChainLogo from '../app/ChainLogo'
import { CHAINS, type Chain } from '../../lib/chains'
import { ROADMAP_STATUSES, type RoadmapStatus } from '../../lib/roadmap'
import { revealAt } from '../ui/section'
import { cn } from '../../lib/utils'
import { CHAIN_STATUS_ORDER, CHAIN_STATUS_UI, STATUS_UI } from './roadmap-ui'

/**
 * The strip under the opening: one tile per status with its count, then the chains by
 * registry status. Every number here is derived at render time, the item counts from the
 * roadmap data and the chain counts from the generated registry mirror, so this strip
 * cannot say something the rest of the page does not.
 */
export function RoadmapSummary({ counts }: { counts: Record<RoadmapStatus, number> }) {
  const buckets = CHAIN_STATUS_ORDER.map((status) => ({
    status,
    chains: CHAINS.filter((c) => c.status === status),
  })).filter((b) => b.chains.length > 0)

  return (
    <div className="space-y-4">
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ROADMAP_STATUSES.map((s, i) => {
          const { Icon, number } = STATUS_UI[s.id]
          return (
            <motion.li
              {...revealAt(i)}
              key={s.id}
              className="flex flex-col rounded-2xl border border-border bg-card px-4 py-4 sm:px-5"
            >
              <span className="flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/50">
                <Icon size={12} strokeWidth={2.3} aria-hidden="true" />
                {s.label}
              </span>
              <span
                className={cn('mt-2 text-3xl font-bold leading-none tracking-tight sm:text-4xl', number)}
                style={{ fontFamily: 'var(--font-heading)' }}
              >
                {counts[s.id]}
              </span>
              <span className="mt-1.5 text-[11.5px] leading-snug text-foreground/50">
                {counts[s.id] === 1 ? 'item' : 'items'}
              </span>
            </motion.li>
          )
        })}
      </ul>

      <motion.div
        {...revealAt(2)}
        className="rounded-2xl border border-border bg-card px-4 py-4 sm:px-5 sm:py-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/50">
            Chains in the registry
          </span>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/40">
            {buckets.map((b) => `${b.chains.length} ${CHAIN_STATUS_UI[b.status].label.toLowerCase()}`).join(', ')}
          </span>
        </div>
        <div className="mt-3 space-y-2.5">
          {buckets.map((b) => (
            <ChainRow key={b.status} status={b.status} chains={b.chains} />
          ))}
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-foreground/45">
          Read from the chain registry at render time. A chain is live only after our own agent is
          minted and our own rail has settled on it.
        </p>
      </motion.div>
    </div>
  )
}

function ChainRow({ status, chains }: { status: Chain['status']; chains: Chain[] }) {
  const ui = CHAIN_STATUS_UI[status]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className={cn('w-16 shrink-0 font-mono text-[10.5px] font-bold uppercase tracking-[0.14em]', ui.cls)}>
        {ui.label}
      </span>
      <ul className="flex flex-wrap items-center gap-1.5" aria-label={`${ui.label} chains`}>
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
    </div>
  )
}

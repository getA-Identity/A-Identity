import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import type { ChainId } from '../../lib/chains'
import { cn } from '../../lib/utils'
import ChainLogo from '../app/ChainLogo'
import { revealAt } from '../ui/section'
import { BarList, type BarRow } from './charts'
import { int } from './format'
import { CountUp, SourceTag, ValueSkeleton } from './kit'

/**
 * One settlement rail, as a card: the chain it runs on, what it has taken, and the
 * per-tool breakdown behind that total.
 *
 * The rails get equal weight even though their numbers are nothing alike, because the
 * point of showing both is that the same product earns on two mainnets, not that one is
 * winning. `caveat` is the load-bearing slot: a rail whose traffic is all our own says so
 * here, directly under its own headline number, rather than in a footnote at the bottom of
 * the page where the number has already done its work.
 */
export function RailCard({
  chain,
  name,
  network,
  settlements,
  volumeUsd,
  volumeDigits = 3,
  tools,
  toolsQualifier,
  toolsEmptyNote,
  caveat,
  source,
  sourceHref,
  href,
  to,
  linkLabel,
  index = 0,
}: {
  chain: ChainId
  name: string
  /** CAIP-2 or a human network name, read from the same response as the numbers. */
  network: ReactNode
  settlements: number | null
  volumeUsd: number | null
  volumeDigits?: number
  tools: BarRow[]
  /** Small print under the tool-list heading, for when the rows need a scope qualifier
   *  (e.g. a facilitator log that breaks tools down rail-wide rather than per chain). */
  toolsQualifier?: ReactNode
  /** Override for the no-rows note. The default says "no paid calls yet", which is a
   *  FALSE statement on a card whose settlement count is nonzero but whose source simply
   *  does not break tools down for this chain; such a card must say that instead. */
  toolsEmptyNote?: string
  /** The honest qualifier on this rail's headline, e.g. whose wallet paid. */
  caveat?: ReactNode
  source: string
  sourceHref?: string
  href?: string
  to?: string
  linkLabel: string
  index?: number
}) {
  const link = (
    <span className="group/link inline-flex items-center gap-1.5 text-sm font-semibold text-accent">
      {linkLabel}
      <ArrowUpRight size={14} className="transition-transform group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5 motion-reduce:transition-none" />
    </span>
  )

  return (
    <motion.article
      {...revealAt(index)}
      className={cn(
        'flex min-w-0 flex-col rounded-3xl border border-border bg-card p-5 transition-colors hover:border-accent/30 sm:p-7',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <ChainLogo id={chain} size={30} />
          <div className="min-w-0">
            <h3 className="truncate text-base font-bold tracking-tight text-foreground">{name}</h3>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-foreground/40">{network}</p>
          </div>
        </div>
        <SourceTag label={source} href={sourceHref} />
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <div className="text-[clamp(2.2rem,7vw,3rem)] font-semibold leading-none tracking-[-0.035em] text-foreground tabular-nums">
            {settlements == null ? <ValueSkeleton className="w-24" /> : <CountUp value={settlements} format={int} />}
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-[0.1em] text-foreground/45">Settlements</p>
        </div>
        <div>
          <div className="text-[clamp(1.4rem,4.4vw,1.8rem)] font-semibold leading-none tracking-[-0.03em] text-ok tabular-nums">
            {volumeUsd == null ? (
              <ValueSkeleton className="w-20" />
            ) : (
              <CountUp
                value={volumeUsd}
                format={(n) =>
                  `$${n.toLocaleString('en-US', { minimumFractionDigits: volumeDigits, maximumFractionDigits: volumeDigits })}`
                }
              />
            )}
          </div>
          <p className="mt-2 text-xs font-medium uppercase tracking-[0.1em] text-foreground/45">Settled value</p>
        </div>
      </div>

      {caveat && <div className="mt-4 rounded-xl border border-border bg-background p-3.5 text-xs leading-relaxed text-foreground/55">{caveat}</div>}

      <div className="mt-6">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">Paid calls by tool</h4>
        {toolsQualifier && <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/40">{toolsQualifier}</p>}
        <BarList
          className="mt-3.5"
          rows={tools}
          emptyNote={toolsEmptyNote ?? 'No paid calls on this rail yet. The first settlement draws the first bar.'}
        />
      </div>

      <div className="mt-6 pt-1">
        {to ? (
          <Link to={to}>{link}</Link>
        ) : (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {link}
          </a>
        )}
      </div>
    </motion.article>
  )
}

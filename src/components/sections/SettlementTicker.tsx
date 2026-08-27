import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { ASP_BASE } from '../../lib/mcpBase'

/**
 * Every settlement we have ever taken, as clickable rows.
 *
 * The category has no customer quotes to show, so the strongest available proof is the
 * chain itself: this reads the live /proof.json from the ASP and renders each settlement
 * as a link into OKLink. A visitor does not have to believe the number above it, because
 * any single row can be opened and checked in one click.
 *
 * Nothing here is generated: the rows are the real USD₮0 transfers on X Layer mainnet that
 * paid for tool calls. If the feed cannot be reached, the panel says so and keeps the link
 * to the full proof page rather than inventing rows.
 */

// Fetched through ASP_BASE (same-origin /asp proxy in prod, so ad blockers that list
// *.onrender.com cannot fake an outage); the human-facing proof page stays on the ASP's
// real origin because it is the ASP's own document, not ours.
const PROOF_PAGE = 'https://a-identity-asp.onrender.com/proof'

type Settlement = { round: number; tool: string; amountUsd: number; txHash: string; txUrl: string }
type Feed = { settlements: Settlement[]; total: number; totalUsd: number; payToUrl?: string }

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`

export default function SettlementTicker() {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    // Deferred to idle. This section is far below the fold and the fetch goes to
    // a backend that may be cold, so on a phone it was competing for bandwidth
    // with the fonts and the entry chunk while the hero was still painting. The
    // ledger is proof, not the first thing anyone reads.
    const idle =
      window.requestIdleCallback?.(() => alive && load(), { timeout: 3000 }) ??
      window.setTimeout(() => alive && load(), 1200)

    function load() {
    fetch(`${ASP_BASE}/proof.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { realOnchainRevenue?: Record<string, unknown> }) => {
        const rev = d.realOnchainRevenue
        const list = Array.isArray(rev?.settlements) ? (rev.settlements as Settlement[]) : []
        if (!alive || list.length === 0) {
          if (alive) setFailed(true)
          return
        }
        setFeed({
          // Newest first: the seeding rounds ran in order, so the tail is the latest.
          settlements: [...list].reverse(),
          total: Number(rev?.totalSettlements ?? list.length),
          totalUsd: Number(rev?.totalUsd ?? 0),
          payToUrl: typeof rev?.payToUrl === 'string' ? rev.payToUrl : undefined,
        })
      })
      .catch(() => alive && setFailed(true))
    }

    return () => {
      alive = false
      if (typeof idle === 'number') window.clearTimeout(idle)
      else window.cancelIdleCallback?.(idle)
    }
  }, [])

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-32px_rgba(16,24,40,0.35)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Every settlement, on-chain
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/35">
          USD₮0 · X Layer mainnet
        </p>
      </div>

      <div className="hidden grid-cols-[minmax(0,1fr)_88px_minmax(0,1.1fr)_18px] gap-x-4 border-b border-border/60 px-5 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-foreground/35 sm:grid">
        <span>Tool paid for</span>
        <span className="justify-self-end">Amount</span>
        <span className="justify-self-end">Transaction</span>
        <span />
      </div>

      {/* Fixed height with its own scroll: a hundred and twenty rows must never grow the page. */}
      <div className="h-[264px] divide-y divide-border/60 overflow-y-auto overscroll-y-contain">
        {feed?.settlements.map((s, i) => (
          <motion.a
            key={s.txHash + i}
            href={s.txUrl}
            target="_blank"
            rel="noopener noreferrer"
            initial={i < 8 ? { opacity: 0, y: -8 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, delay: Math.min(i, 8) * 0.04, ease: [0.16, 1, 0.3, 1] }}
            className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-3 transition-colors hover:bg-accent/[0.05] sm:grid-cols-[minmax(0,1fr)_88px_minmax(0,1.1fr)_18px]"
          >
            <span className="truncate font-mono text-[13px] font-semibold text-foreground">
              {s.tool}
            </span>
            <span className="justify-self-end font-mono text-[13px] font-semibold text-emerald-600 dark:text-emerald-400">
              ${s.amountUsd.toFixed(3)}
            </span>
            <span className="col-span-2 truncate font-mono text-[11px] text-foreground/45 sm:col-span-1 sm:justify-self-end">
              {short(s.txHash)}
            </span>
            <ArrowUpRight
              size={13}
              className="hidden text-foreground/25 transition-colors group-hover:text-accent sm:block"
            />
          </motion.a>
        ))}

        {!feed && !failed && (
          <div className="flex h-full items-center justify-center font-mono text-xs text-foreground/40">
            reading the chain…
          </div>
        )}

        {failed && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-sm text-foreground/55">
              The live feed did not answer just now. The record is still on-chain.
            </p>
            <a
              href={PROOF_PAGE}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
            >
              Open the proof page <ArrowUpRight size={14} />
            </a>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3 text-xs text-foreground/45">
        <span>
          {feed ? (
            <>
              <span className="font-mono font-semibold text-foreground">{feed.total}</span>{' '}
              settlements, <span className="font-mono">${feed.totalUsd.toFixed(3)}</span> taken in
              total. Every row opens on OKLink.
            </>
          ) : (
            'Every row opens the transaction on OKLink.'
          )}
        </span>
        <a
          href={feed?.payToUrl ?? PROOF_PAGE}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-accent hover:underline"
        >
          The receiving wallet
        </a>
      </div>
    </div>
  )
}

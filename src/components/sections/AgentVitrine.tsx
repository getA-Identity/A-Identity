import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import { getLeaderboard, type FeedAgent } from '../../lib/mcp-client'
import AgentAvatar from '../AgentAvatar'
import { type OwlVerdict } from '../OwlMark'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'

/**
 * The Agent House vitrine: real registrations, surfaced on the landing.
 *
 * Everything here is read live from the same marketplace endpoint the explorer's
 * leaderboard uses, filtered the way the Agent House itself filters: KYA-verified only.
 * Each card links into the explorer so the visitor can run the exact check we show.
 *
 * The section renders nothing below three agents. A vitrine with two lonely cards reads as
 * an empty shop, and an absent section is better marketing than a sparse one. This is also
 * why seeding verified agents before a demo matters: this surface literally disappears
 * without them.
 */

/** Same thresholds the spotlight and explorer use, expressed as the owl's verdict. */
const verdictOf = (score: number, kya?: string): OwlVerdict =>
  kya === 'revoked' || score < 200 ? 'deny' : score < 500 ? 'warn' : 'allow'

export default function AgentVitrine() {
  const [agents, setAgents] = useState<FeedAgent[]>([])

  useEffect(() => {
    let alive = true
    getLeaderboard().then((r) => {
      if (alive && r.ok) setAgents(r.data)
    })
    return () => {
      alive = false
    }
  }, [])

  const top = agents
    .filter((a) => a.kya === 'verified')
    .sort((x, y) => (y.reputation?.score ?? 0) - (x.reputation?.score ?? 0))
    .slice(0, 6)

  if (top.length < 3) return null

  return (
    <SectionShell id="agents" size="lg" surface="card">
      <SectionIntro
        eyebrow={<Eyebrow>Agent House</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[16ch]">
            Verified agents, open for work.
          </DisplayHeading>
        }
        lede={
          <Lede>
            Every card is a real registration: wallet control proven, reputation computed
            from on-chain history. Click one and run the check yourself.
          </Lede>
        }
      />

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {top.map((a, i) => {
          const score = a.reputation?.score ?? 0
          return (
            <motion.div key={a.id} {...revealAt(i % 3)}>
              <Link
                to={`/explorer?q=${encodeURIComponent(a.onchainAgentId || a.id)}`}
                className="group flex items-center gap-4 rounded-2xl border border-border bg-background/50 p-5 transition-colors hover:border-accent/40"
              >
                <AgentAvatar seed={a.onchainAgentId || a.id} size={44} verdict={verdictOf(score, a.kya)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{a.name}</p>
                  <p className="mt-0.5 truncate font-mono text-xs text-foreground/45">
                    {a.category}
                    {a.onchainAgentId ? ` · #${a.onchainAgentId}` : ''}
                  </p>
                </div>
                <span className="font-mono text-sm font-bold tabular-nums text-foreground">{score}</span>
                <ArrowUpRight
                  size={14}
                  className="shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-100"
                />
              </Link>
            </motion.div>
          )
        })}
      </div>

      <motion.div {...reveal} className="mt-8">
        <Link
          to="/explorer"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-accent transition-opacity hover:opacity-80"
        >
          Browse every agent in the explorer <ArrowRight size={15} />
        </Link>
      </motion.div>
    </SectionShell>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Star } from 'lucide-react'
import { getLeaderboard, type FeedAgent } from '../../lib/mcp-client'
import { MCP_BASE } from '../../lib/mcpBase'
import AgentAvatar from '../AgentAvatar'
import { type OwlVerdict } from '../OwlMark'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'

/**
 * The Agent House vitrine: real registrations, surfaced on the landing.
 *
 * Primary source is GET /api/marketplace/leaderboard: the composite ranking where
 * delivered paid work and verified feedback outweigh followers, so the agents shown here
 * are the ones actually winning, with their rank, logo and rating on the card and a
 * direct "Hire now" path into the marketplace profile.
 *
 * When that endpoint cannot be read the section falls back to what it showed before this
 * upgrade: the KYA-verified feed sorted by reputation, linking into the explorer. Both
 * sources are live backend state; nothing here is ever invented.
 *
 * The section renders nothing below three agents. A vitrine with two lonely cards reads
 * as an empty shop, and an absent section is better marketing than a sparse one. This is
 * also why seeding verified agents before a demo matters: this surface literally
 * disappears without them.
 */

/** One leaderboard row, as GET /api/marketplace/leaderboard returns it. */
type RankedAgent = {
  id: string
  name: string
  logoUrl?: string | null
  category: string
  kya?: 'verified' | 'unverified' | 'revoked'
  onchainAgentId?: string | null
  reputation?: { score: number }
  feedback: { avg: number | null; count: number }
  rankScore: number
  rank: number
}

/** Same thresholds the spotlight and explorer use, expressed as the owl's verdict. */
const verdictOf = (score: number, kya?: string): OwlVerdict =>
  kya === 'revoked' || score < 200 ? 'deny' : score < 500 ? 'warn' : 'allow'

export default function AgentVitrine() {
  const [ranked, setRanked] = useState<RankedAgent[]>([])
  const [fallback, setFallback] = useState<FeedAgent[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch(`${MCP_BASE}/api/marketplace/leaderboard`, {
          signal: AbortSignal.timeout(8000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as { agents?: RankedAgent[] }
        if (alive && json.agents && json.agents.length > 0) {
          setRanked(json.agents)
          return
        }
      } catch {
        // Leaderboard unreachable; fall through to the pre-upgrade source below.
      }
      const r = await getLeaderboard()
      if (alive && r.ok) setFallback(r.data)
    }
    void load()
    return () => {
      alive = false
    }
  }, [])

  const topRanked = ranked.slice(0, 6)

  const topFallback = fallback
    .filter((a) => a.kya === 'verified')
    .sort((x, y) => (y.reputation?.score ?? 0) - (x.reputation?.score ?? 0))
    .slice(0, 6)

  const useRanked = topRanked.length >= 3
  if (!useRanked && topFallback.length < 3) return null

  return (
    <SectionShell id="agents" size="lg" surface="card" backdrop="vitrine" backdropPosition="left">
      <SectionIntro
        eyebrow={<Eyebrow>Agent House</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[16ch]">
            Verified agents, open for work.
          </DisplayHeading>
        }
        lede={
          <Lede>
            Every card is a real registration, ranked by delivered work and verified
            feedback. Hire one straight from here, or open the explorer and run the
            checks yourself.
          </Lede>
        }
      />

      {/* `grid-cols-1` is the fix for a real overflow, not a tidy-up. Without an explicit
          base column the single mobile track is `auto`, which is sized to the widest
          card's MIN-CONTENT. One registered agent is called "Google Pay Subscription Auto
          Payment", and its name sits in a `truncate` paragraph, so `white-space: nowrap`
          makes that name's min-content 265px however narrow the phone is. The track went
          to 414px on a 390px viewport and every card in the row went with it, because a
          one-column grid sizes one track for all of them: the rank pill and "Hire now"
          were clipped off the right edge on live.
          `min-w-0` on the inner div does not prevent this. It lets the div shrink once the
          track has a width, but it does not lower what the div CONTRIBUTES while the track
          is being measured. Tailwind's `grid-cols-1` expands to `minmax(0, 1fr)`, and the
          zero floor is what finally lets the track be narrower than its content, which is
          the same reason `sm:grid-cols-2` was never affected. */}
      <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {useRanked
          ? topRanked.map((a, i) => {
              const score = a.reputation?.score ?? 0
              const avg = a.feedback.avg
              return (
                <motion.div key={a.id} {...revealAt(i % 3)}>
                  <Link
                    to={`/app/marketplace/${a.id}`}
                    className="group flex flex-col gap-4 rounded-2xl border border-border bg-background/50 p-5 transition-colors hover:border-accent/40"
                  >
                    <div className="flex items-center gap-4">
                      <AgentAvatar
                        seed={a.onchainAgentId || a.id}
                        category={a.category}
                        size={44}
                        src={a.logoUrl ?? undefined}
                        verdict={verdictOf(score, a.kya)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{a.name}</p>
                        <p className="mt-0.5 truncate font-mono text-xs text-foreground/45">
                          {a.category}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums text-foreground/70">
                        #{a.rank}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-foreground/60">
                        <Star size={13} className="shrink-0 text-accent" fill="currentColor" />
                        {avg != null ? (
                          <span className="tabular-nums">
                            {avg.toFixed(1)}/10 · {a.feedback.count}{' '}
                            {a.feedback.count === 1 ? 'rating' : 'ratings'}
                          </span>
                        ) : (
                          'No ratings yet'
                        )}
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-accent">
                        Hire now
                        <ArrowUpRight
                          size={14}
                          className="opacity-0 transition-opacity group-hover:opacity-100"
                        />
                      </span>
                    </div>
                  </Link>
                </motion.div>
              )
            })
          : topFallback.map((a, i) => {
              const score = a.reputation?.score ?? 0
              return (
                <motion.div key={a.id} {...revealAt(i % 3)}>
                  <Link
                    to={`/explorer?q=${encodeURIComponent(a.onchainAgentId || a.id)}`}
                    className="group flex items-center gap-4 rounded-2xl border border-border bg-background/50 p-5 transition-colors hover:border-accent/40"
                  >
                    <AgentAvatar
                      seed={a.onchainAgentId || a.id}
                      size={44}
                      verdict={verdictOf(score, a.kya)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{a.name}</p>
                      <p className="mt-0.5 truncate font-mono text-xs text-foreground/45">
                        {a.category}
                        {a.onchainAgentId ? ` · #${a.onchainAgentId}` : ''}
                      </p>
                    </div>
                    <span className="font-mono text-sm font-bold tabular-nums text-foreground">
                      {score}
                    </span>
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

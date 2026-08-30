import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, BadgeCheck, Star, Store } from 'lucide-react'
import { getLeaderboard, type FeedAgent } from '../../lib/mcp-client'
import { MCP_BASE } from '../../lib/mcpBase'
import { CHAIN_BY_ID } from '../../lib/chains'
import AgentAvatar from '../AgentAvatar'
import ChainLogo from '../app/ChainLogo'
import { type OwlVerdict } from '../OwlMark'
import { Button } from '../ui/button'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'
import { OUR_AGENTS, type OnchainAgent } from './AgentRing'

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
 * The RANKED block renders nothing below three agents: a ranking with two lonely cards
 * reads as an empty shop, and an absent ranking is better marketing than a sparse one.
 * Seeding verified agents before a demo still matters for that reason. What no longer
 * disappears is the section itself, because our own agents are always on it.
 *
 * Above the ranking sits the house's own shelf. Every agent here used to belong to
 * somebody else, which made the shop look like it carried no stock of its own while we
 * hold eight registrations across seven networks. They are on the page now, and each one
 * names the networks it is actually registered on. The roster is the one AgentRing
 * publishes, mirrored from the agent card's `registrations` and
 * mcp/src/chains/provenance.ts, so a badge here is a claim the ring can answer for, with
 * a mint transaction where one exists and a plain admission where one does not (#8913 has
 * none). That is also why the leaderboard cards below carry no chain badge: the
 * leaderboard payload has no chain field, and a badge we cannot source is one we do not
 * draw.
 */

/** One of our agents, with every network it holds a registration on. */
type OurAgent = { identity: string; registrations: OnchainAgent[] }

/**
 * The ring's roster, grouped by identity. Order is by breadth, so the oracle that answers
 * on five mainnets leads and the single-chain showcase agent follows. Derived, so a new
 * registration re-sorts this without anyone remembering to.
 */
const OUR_ROSTER: OurAgent[] = (() => {
  const byIdentity = new Map<string, OnchainAgent[]>()
  for (const a of OUR_AGENTS) {
    const found = byIdentity.get(a.identity)
    if (found) found.push(a)
    else byIdentity.set(a.identity, [a])
  }
  return [...byIdentity.entries()]
    .map(([identity, registrations]) => ({ identity, registrations }))
    .sort((x, y) => y.registrations.length - x.registrations.length)
})()

/**
 * One line per identity, cut from the missions the ring already carries so the two
 * surfaces cannot tell different stories. An identity with no line here falls back to its
 * first registration's mission rather than rendering an empty card.
 */
const BLURB: Record<string, string> = {
  'A-Identity Trust Oracle':
    'Other agents pay it per call, in real stablecoins, to answer one question before money moves: can this counterparty be trusted?',
  Meridian:
    'The phase-1 showcase research agent. It buys market data through the policy-gated wallet, and its wallet control is attested on-chain.',
}

const blurbOf = (o: OurAgent) => BLURB[o.identity] ?? o.registrations[0].mission

/**
 * Token ids that are ours, so a leaderboard row we registered says so.
 *
 * `#0` is excluded deliberately. It is a real registration of ours on Robinhood Chain, but
 * it is also the id a marketplace record could carry by accident, and claiming somebody
 * else's agent as our own is a worse failure than missing one of ours.
 */
const OURS_BY_TOKEN = new Map(
  OUR_AGENTS.filter((a) => a.tokenId !== '0').map((a) => [a.tokenId, a.identity] as const),
)

const isOurs = (onchainAgentId?: string | null) =>
  onchainAgentId != null && OURS_BY_TOKEN.has(onchainAgentId)

/** The marker that separates the house's own stock from the shop's. */
function OursChip() {
  return (
    <span className="shrink-0 rounded-full border border-accent/30 bg-accent/10 px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-accent">
      Ours
    </span>
  )
}

/**
 * One leaderboard row, as GET /api/marketplace/leaderboard returns it.
 *
 * There is no `chain` here because the endpoint does not send one (see
 * marketplaceLeaderboard in mcp/src/platform/feed.ts). Network badges therefore appear
 * only on the roster above, where every registration has a mint transaction behind it.
 */
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
  /* A ranking needs a crowd to mean anything; the house's own shelf does not. This used to
     return null for the whole section, which took our eight registrations off the page
     every time the backend was cold. Only the ranked block waits for a crowd now. */
  const showRanked = useRanked || topFallback.length >= 3

  return (
    <SectionShell id="agents" size="lg" surface="card" backdrop="vitrine" backdropPosition="left">
      <SectionIntro
        eyebrow={<Eyebrow icon={Store}>Agent House</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[16ch]">
            Verified agents, open for work.
          </DisplayHeading>
        }
        lede={
          <Lede>
            Our own agents first, then everyone else, ranked by delivered work and verified
            feedback. Every card is a real registration.
          </Lede>
        }
      />

      {/* The house's own shelf. Two cards rather than eight, because eight would be the
          ring in LiveProof again: this says WHO we run and WHERE, and hands the receipts
          off to the section that exists for them. */}
      <div className="mt-12 grid gap-4 md:grid-cols-2">
        {OUR_ROSTER.map((o, i) => {
          const networks = new Set(o.registrations.map((r) => r.chain)).size
          return (
            <motion.article
              key={o.identity}
              {...revealAt(i)}
              className="flex flex-col gap-4 rounded-2xl border border-accent/30 bg-background/60 p-5"
            >
              <div className="flex items-start gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
                  <BadgeCheck size={20} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-semibold text-foreground">{o.identity}</p>
                    <OursChip />
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-foreground/60">
                    {o.registrations.length}{' '}
                    {o.registrations.length === 1 ? 'registration' : 'registrations'} on{' '}
                    {networks} {networks === 1 ? 'network' : 'networks'}
                  </p>
                </div>
              </div>

              <p className="text-sm leading-relaxed text-foreground/70">{blurbOf(o)}</p>

              {/* One chip per registration: the network's own mark, its name from the
                  generated registry, and the token id this agent holds there. A chip claims
                  only that the agent IS registered on that network, which the identity ring
                  further down the page backs with a receipt or says it cannot. */}
              <div className="mt-auto flex flex-wrap items-center gap-1.5">
                {o.registrations.map((r) => (
                  <span
                    key={`${r.chain}-${r.tokenId}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-semibold text-foreground/70"
                  >
                    <ChainLogo id={r.chain} size={14} />
                    {CHAIN_BY_ID[r.chain].shortName}
                    <span className="font-mono tabular-nums text-foreground/60">#{r.tokenId}</span>
                  </span>
                ))}
              </div>
            </motion.article>
          )
        })}
      </div>

      <motion.p {...reveal} className="mt-3 text-xs leading-relaxed text-foreground/60">
        A badge means that agent really is registered on that network. Every receipt, and
        the one registration that has no mint transaction of its own, is listed below.{' '}
        <a href="#okx-asp" className="font-semibold text-accent hover:underline">
          See every identity and its receipts
        </a>
        .
      </motion.p>

      {showRanked && (
        <>
          <motion.h3
            {...reveal}
            className="mt-14 text-sm font-bold uppercase tracking-[0.14em] text-foreground/70"
          >
            And the rest of the house
          </motion.h3>

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
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                            <div className="flex items-center gap-1.5">
                              <p className="truncate text-sm font-semibold text-foreground">{a.name}</p>
                              {isOurs(a.onchainAgentId) && <OursChip />}
                            </div>
                            <p className="mt-0.5 truncate font-mono text-xs text-foreground/60">
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
                          <div className="flex items-center gap-1.5">
                            <p className="truncate text-sm font-semibold text-foreground">{a.name}</p>
                            {isOurs(a.onchainAgentId) && <OursChip />}
                          </div>
                          <p className="mt-0.5 truncate font-mono text-xs text-foreground/60">
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
        </>
      )}

      {/* Same pill QuickStart and the console section close on: the end of a shop is where
          a visitor decides to walk in, and a text link is not a door. */}
      <motion.div {...reveal} className="mt-10">
        <Button asChild size="lg">
          <Link to="/explorer">
            Browse every agent in the explorer <ArrowRight size={16} />
          </Link>
        </Button>
      </motion.div>
    </SectionShell>
  )
}

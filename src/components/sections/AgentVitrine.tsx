import { useEffect, useId, useState, type FocusEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, BadgeCheck, ChevronDown, Star, Store } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
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
 *
 * MOTION, and what it is allowed to say.
 *
 * Three things move here, and none of them may be read as an event.
 *
 *   1. The registration strip is a marquee of the roster. It is decoration over facts
 *      that have been true since the day each token was minted, so it carries its own
 *      disclaimer ("standing on-chain, not a live feed"), it never animates a chip IN,
 *      and every chip names the agent it belongs to. A badge is never separated from its
 *      owner, and no chain can be mistaken for one being registered while you watch.
 *   2. A house card opens its registrations on hover, on keyboard focus, and on a tap of
 *      its own toggle, because hover is not an interaction on a phone.
 *   3. A leaderboard card fades in two numbers it already fetched (reputation and rank
 *      score) on hover or focus.
 *
 * Reduced motion is honored per animation, deliberately: `.console-shell` crushes
 * durations for the app console, and the landing sits outside that scope, so nothing here
 * inherits an escape hatch. The marquee drops to one scrollable copy, the card panel
 * opens with a zero-length transition, and the CSS in index.css stops the keyframes as a
 * second line of defense.
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

const keyOf = (a: OnchainAgent) => `${a.chain}-${a.tokenId}`

/**
 * Where a reader can check a registration for themselves.
 *
 * Derived from the generated chain registry, never typed: the mint transaction when we
 * hold one, and otherwise the identity registry contract, which is the only honest answer
 * for #8913. A chain with no explorer in the registry gets no link rather than a guess.
 */
function receiptHref(a: OnchainAgent): string | undefined {
  const chain = CHAIN_BY_ID[a.chain]
  if (!chain.explorer) return undefined
  if (a.tx) return `${chain.explorer}/tx/${a.tx}`
  const registry = chain.registries.identity
  return registry ? `${chain.explorer}/address/${registry}` : undefined
}

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

/** True when this focus event came from the keyboard rather than from a tap or a click. */
function isKeyboardFocus(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return typeof el?.matches === 'function' && el.matches(':focus-visible')
}

/** True when focus has left the element the handler is bound to. */
function focusLeft(e: FocusEvent<HTMLElement>): boolean {
  return !e.currentTarget.contains(e.relatedTarget as Node | null)
}

/* ------------------------------------------------------- the registration strip */

/**
 * One registration, as a chip that can stand on its own.
 *
 * Self-contained on purpose: the network mark, the network's name and the token id travel
 * together with the NAME OF THE AGENT that holds them, because a moving badge that has
 * been separated from its owner is a badge that claims nothing. The chip links to where
 * the claim can be checked, which is the mint transaction where there is one.
 *
 * `tabbable` is false for the duplicated copy the loop needs. That copy is aria-hidden and
 * out of the tab order, so the strip announces the roster once and a Tab key walks it once.
 */
function RegistrationChip({ a, tabbable }: { a: OnchainAgent; tabbable: boolean }) {
  const chain = CHAIN_BY_ID[a.chain]
  const href = receiptHref(a)
  const body = (
    <>
      <ChainLogo id={a.chain} size={20} />
      <span className="flex flex-col leading-tight">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-foreground/60">
          {a.identity}
        </span>
        <span className="text-[13px] font-semibold text-foreground">
          {chain.shortName}{' '}
          <span className="font-mono tabular-nums text-foreground/70">#{a.tokenId}</span>
        </span>
      </span>
    </>
  )
  const className =
    'mr-3 inline-flex shrink-0 items-center gap-2.5 rounded-full border border-border bg-background/70 py-1.5 pl-2 pr-4 transition-colors hover:border-accent/50'
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      tabIndex={tabbable ? undefined : -1}
      aria-label={`${a.identity} on ${chain.shortName}, token ${a.tokenId}. Opens the network explorer.`}
      className={className}
    >
      {body}
    </a>
  ) : (
    <span className={className}>{body}</span>
  )
}

/**
 * The roster, flowing. One pass of eight registrations, the way a brand strip rotates.
 *
 * The loop needs the list twice so the track can travel exactly one copy and land back on
 * itself; see the keyframes in index.css for why the gutter is a margin on the chip rather
 * than a flex gap. Hover and focus stop it (CSS, so no React state runs on every pointer
 * move), and reduced motion is not "the same strip, frozen": it renders ONE copy inside a
 * scrollable box, so a reader who asked for stillness can still reach every chip.
 */
function RegistrationStrip() {
  const reduced = useReducedMotion() ?? false
  const copies = reduced ? 1 : 2

  /* Focusing a chip that has drifted past the right edge makes the browser scroll this
     overflow box to reveal it, which is correct while the chip is focused (the strip is
     paused, so it stays put) but must not outlive the focus, or every later frame draws
     shifted. Reset on the way out. */
  const onBlurCapture = (e: FocusEvent<HTMLDivElement>) => {
    if (focusLeft(e)) e.currentTarget.scrollLeft = 0
  }

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-foreground/70">
          Every registration we hold
        </p>
        <p className="text-xs text-foreground/60">
          Standing on-chain since each was minted. The strip moves; the registry does not.
        </p>
      </div>
      <div
        onBlurCapture={onBlurCapture}
        className={`vitrine-marquee relative mt-3 ${reduced ? 'overflow-x-auto' : 'overflow-hidden'}`}
      >
        <div className={`flex w-max ${reduced ? '' : 'vitrine-marquee-track'}`}>
          {Array.from({ length: copies }, (_, copy) => (
            <div key={copy} className="flex" aria-hidden={copy > 0 ? true : undefined}>
              {OUR_AGENTS.map((a) => (
                <RegistrationChip key={keyOf(a)} a={a} tabbable={copy === 0} />
              ))}
            </div>
          ))}
        </div>
        {/* The chips are meant to arrive from and leave into the section's own surface
            rather than being sliced off by a hard edge. Only while the strip is a marquee:
            an absolutely positioned child of a scroll box travels WITH the content, so in
            the reduced-motion strip these would slide away from the edges they are meant
            to soften. There is nothing for them to soften there anyway. */}
        {!reduced && (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-card to-transparent"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card to-transparent"
            />
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- the house's shelf */

/**
 * One registration as a poster tile: the network's own colour, its mark, the token id,
 * and the two facts that keep the tile honest. Which network it really is, stated rather
 * than implied, because the rehearsal registration on Robinhood Chain testnet is in this
 * list and a poster is exactly where a testnet could quietly pass for a mainnet. And
 * whether we hold its mint transaction, because one registration does not and the tile
 * says so instead of linking somewhere that looks like a receipt.
 */
function RegistrationTile({ r }: { r: OnchainAgent }) {
  const chain = CHAIN_BY_ID[r.chain]
  const href = receiptHref(r)
  const className =
    'block overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-accent/50'
  const body: ReactNode = (
    <>
      <span className="flex h-12 items-center justify-center" style={{ background: chain.color }}>
        <ChainLogo id={r.chain} size={26} />
      </span>
      <span className="block p-2">
        <span className="flex items-baseline justify-between gap-1">
          <span className="truncate text-[11px] font-semibold text-foreground">
            {chain.shortName}
          </span>
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/70">
            #{r.tokenId}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-foreground/60">
          {chain.testnet ? 'testnet' : 'mainnet'} ·{' '}
          {r.tx ? 'mint tx on record' : 'no mint receipt'}
        </span>
      </span>
    </>
  )
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {body}
    </a>
  ) : (
    <div className={className}>{body}</div>
  )
}

/** The networks an agent holds, as a stack of marks that fans open when the card does. */
function NetworkStack({ chains, open, still }: { chains: OnchainAgent['chain'][]; open: boolean; still: boolean }) {
  return (
    <span className="flex items-center" aria-hidden="true">
      {chains.map((c, i) => (
        <span
          key={c}
          className="rounded-full ring-2 ring-background"
          style={{
            marginLeft: i === 0 ? 0 : open ? 3 : -9,
            transition: `margin-left ${still ? 0 : 260}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          }}
        >
          <ChainLogo id={c} size={26} />
        </span>
      ))}
    </span>
  )
}

/**
 * One of our agents, opening on hover.
 *
 * Three ways in, because hover is not an interaction everywhere:
 *   - the pointer enters the card,
 *   - focus arrives from the KEYBOARD (a tap that happens to focus the toggle does not
 *     count, or the toggle could never close what the tap just opened),
 *   - the toggle is pressed, which is the touch path and the one a keyboard user can
 *     operate.
 *
 * The toggle wins while it is pressed and gives control back the moment the pointer and
 * focus have both left, so a card never ends up stuck open behind the reader's back.
 */
function HouseCard({ agent, index }: { agent: OurAgent; index: number }) {
  const panelId = useId()
  const still = useReducedMotion() ?? false
  const [hovered, setHovered] = useState(false)
  const [keyed, setKeyed] = useState(false)
  /** null means "follow the pointer and focus"; a boolean is the reader overriding that. */
  const [manual, setManual] = useState<boolean | null>(null)

  const auto = hovered || keyed
  const open = manual ?? auto
  const networks = [...new Set(agent.registrations.map((r) => r.chain))]

  return (
    <motion.article
      {...revealAt(index)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false)
        setManual(null)
      }}
      onFocusCapture={(e) => {
        if (isKeyboardFocus(e.target)) setKeyed(true)
      }}
      onBlurCapture={(e) => {
        if (!focusLeft(e)) return
        setKeyed(false)
        setManual(null)
      }}
      className="flex flex-col gap-4 rounded-2xl border border-accent/30 bg-background/60 p-5 transition-colors hover:border-accent/60"
    >
      <div className="flex items-start gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-accent/30 bg-accent/10 text-accent">
          <BadgeCheck size={20} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold text-foreground">{agent.identity}</p>
            <OursChip />
          </div>
          <p className="mt-0.5 font-mono text-xs text-foreground/60">
            {agent.registrations.length}{' '}
            {agent.registrations.length === 1 ? 'registration' : 'registrations'} on{' '}
            {networks.length} {networks.length === 1 ? 'network' : 'networks'}
          </p>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-foreground/70">{blurbOf(agent)}</p>

      <div className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <NetworkStack chains={networks} open={open} still={still} />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setManual(!open)}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground/80 transition-colors hover:border-accent/50 hover:text-accent"
        >
          {open ? 'Hide the registrations' : 'See the registrations'}
          <ChevronDown
            size={13}
            aria-hidden="true"
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </div>

      {/* The preview. One tile per registration, in the network's own colour, carrying the
          token id and two facts a reader can check: which network it is (mainnet or
          testnet, stated, because the rehearsal registration is in this list) and whether
          we hold its mint transaction. The tile links to that transaction, or to the
          registry contract for the one registration that has no mint receipt of ours. */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            id={panelId}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: still ? 0 : 0.32, ease: EASE_OUT_EXPO }}
            className="overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
              {agent.registrations.map((r) => (
                <RegistrationTile key={keyOf(r)} r={r} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
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
      <div className="mt-12 grid items-start gap-4 md:grid-cols-2">
        {OUR_ROSTER.map((o, i) => (
          <HouseCard key={o.identity} agent={o} index={i} />
        ))}
      </div>

      <RegistrationStrip />

      <motion.p {...reveal} className="mt-3 text-xs leading-relaxed text-foreground/60">
        A chip means that agent really is registered on that network, and it opens the
        transaction that put it there. Every receipt, and the one registration that has no
        mint transaction of its own, is listed below.{' '}
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
                              className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                            />
                          </span>
                        </div>
                        {/* The two numbers the ranking is actually made of. They are in the
                            payload already and stay in the accessibility tree at all times;
                            only their opacity waits for a pointer or for focus, so the idle
                            card keeps the name, the rank and the rating as its whole
                            message. No transform, so nothing here needs a motion escape
                            hatch beyond the fade the reader asked to keep. */}
                        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3 font-mono text-[11px] tabular-nums text-foreground/60 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100">
                          <span>reputation {score}/1000</span>
                          <span>rank score {a.rankScore.toFixed(1)}</span>
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
                          className="shrink-0 text-accent opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
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

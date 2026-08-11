import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  BadgeCheck,
  Boxes,
  CircleDollarSign,
  FileCode2,
  Fingerprint,
  Gauge,
  Link2,
  Radio,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Star,
  Store,
  Users,
} from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import BrandArt from '../components/app/BrandArt'
import ChainLogo from '../components/app/ChainLogo'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../components/ui/section'
import { BarList, SegmentBar, type BarRow } from '../components/stats/charts'
import { int, nf, usdFixed } from '../components/stats/format'
import { HeroFigure, Meter, MetricTile, SourceTag, StatPanel } from '../components/stats/kit'
import { RailCard } from '../components/stats/RailCard'
import { apiFetch } from '../lib/api'
import { CHAINS, type ChainId, type ChainStatus } from '../lib/chains'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'

/**
 * /stats: the network, in numbers, for anyone who asks "is this real?"
 *
 * Four live reads, each labelled on the surface that shows it: GET /api/stats for the
 * platform aggregates, GET /api/celo/proof for the Celo settlement log, the ASP's own
 * /proof.json for the X Layer one, and GET /api/traction for the guardrail meter and the
 * disclosure text that explains its zeros. Nothing on this page is projected, padded or
 * invented, and the backend excludes its own CI canary agents from every headline so
 * monitoring cannot inflate the numbers.
 *
 * The page is built around a fact that would be tempting to hide: several counters here
 * are genuinely zero. No third party has paid us on Celo yet. The guardrail has not been
 * asked a single metered question. Rather than pad those or drop the tiles, each zero
 * carries the reason it is zero, sourced from the API where the API supplies one. That is
 * the same argument the rest of the site makes: a number you cannot reproduce is worth
 * less than one you can, and that goes for zero too.
 *
 * Every fetch is independent, so one slow or missing endpoint degrades its own panel into
 * skeletons instead of blanking the page. Reads go through apiFetch, which retries a
 * sleeping free-tier backend through its cold start with wake pings; the ASP is on a
 * different origin and answers CORS directly, so it is fetched plainly. A single sequence
 * guard covers all four, because apiFetch can spend longer retrying than the 60s poll
 * interval and a slow old fetch must never overwrite a newer snapshot.
 */

type PlatformStats = {
  agents: {
    total: number
    showcase: number
    kyaVerified: number
    onchainRegistered: number
    byCategory: { category: string; count: number }[]
  }
  tasks: { total: number; open: number; released: number; gmvUsd: number; onchainSettled: number }
  settlements: { instructionsExecuted: number; instructionsUsd: number; withTxHash: number }
  feedback: { totalRatings: number; avgScore: number | null; ratedAgents: number }
  followersTotal: number
  guardrail: { checks: number; allow: number; warn: number; deny: number; protectedNotionalUsd: number }
  chains: { total: number; live: number; beta: number }
  contracts: { deployed: number; names: string[] }
  x402: { rounds: number; totalUsd: number }
  computedAt: string
}

/** GET /api/celo/proof. Older backends omit the internal/external split, hence optional. */
type CeloProof = {
  network?: string
  payTo?: string
  configured: boolean
  totalSettlements: number
  totalUsd: number
  internalSettlements?: number
  externalSettlements?: number
  byTool: Record<string, { count: number; usd: number } | number>
}

/** The ASP's public proof document, served from its own origin with open CORS. */
type AspProof = {
  asp?: { name?: string; agentId?: string; network?: string; registrationTxUrl?: string }
  realOnchainRevenue?: {
    network?: string
    totalSettlements?: number
    totalUsd?: number
    byTool?: Record<string, number>
  }
}

/**
 * GET /api/traction. `disclosure` is the backend's own explanation of what its counters do
 * and do not include; it is rendered verbatim rather than paraphrased, because the whole
 * value of a disclosure is that the surface showing the number did not get to reword it.
 */
type Traction = {
  checks: number
  registeredAgents: number
  ci?: { agents: number; checks: number }
  firstAt: string | null
  lastAt: string | null
  disclosure?: string[]
}

/** GET /api/chains. The registry, read live rather than hardcoded into this page. */
type ChainRow = { id: string; name: string; shortName: string; status: ChainStatus; testnet: boolean }

const REFRESH_MS = 60_000
const ASP_PROOF_JSON = 'https://a-identity-asp.onrender.com/proof.json'
const ASP_PROOF_PAGE = 'https://a-identity-asp.onrender.com/proof'

/** Ids this build knows how to draw a logo for, from the generated registry mirror. */
const KNOWN_CHAINS = new Set<string>(CHAINS.map((c) => c.id))

const STATUS_LABEL: Record<ChainStatus, string> = {
  live: 'Live',
  beta: 'Beta',
  planned: 'Planned',
  deprecated: 'Deprecated',
}

const STATUS_CHIP: Record<ChainStatus, string> = {
  live: 'bg-ok/10 text-ok',
  beta: 'bg-warn/10 text-warn',
  planned: 'bg-foreground/[0.06] text-foreground/45',
  deprecated: 'bg-foreground/[0.06] text-foreground/40',
}

/** A per-tool row, normalised across the two rails: Celo sends objects, the ASP sends counts. */
function toolRows(byTool: Record<string, { count: number; usd: number } | number> | undefined): BarRow[] {
  if (!byTool) return []
  return Object.entries(byTool).map(([tool, v]) => {
    const count = typeof v === 'number' ? v : v.count
    const usd = typeof v === 'number' ? null : v.usd
    return {
      key: tool,
      label: tool,
      value: count,
      valueLabel: usd == null ? int(count) : `${int(count)} · ${usdFixed(usd, 3)}`,
      title: `${tool}: ${int(count)} paid calls`,
    }
  })
}

export default function Stats() {
  usePageMeta({
    title: 'Network stats, live from the platform | A-Identity',
    description:
      'The A-Identity network in real numbers: registered agents, task GMV, on-chain settlements, guardrail checks, chains and x402 revenue. Aggregates computed live, never projected.',
    canonical: 'https://a-identity.xyz/stats',
  })

  const [stats, setStats] = useState<PlatformStats | null>(null)
  const [celo, setCelo] = useState<CeloProof | null>(null)
  const [asp, setAsp] = useState<AspProof | null>(null)
  const [traction, setTraction] = useState<Traction | null>(null)
  const [chains, setChains] = useState<ChainRow[] | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  // Stale-response guard (the usual active/cancelled closure, generalized to overlapping
  // calls): every load() takes the next ticket and only the newest ticket may touch
  // state. apiFetch can spend over a minute retrying through a cold start, longer than
  // the 60s poll, so a slow old fetch must never clobber a newer poll's result; unmount
  // bumps the ticket so nothing applies after cleanup either.
  const loadSeq = useRef(0)

  const load = useCallback(() => {
    const seq = loadSeq.current + 1
    loadSeq.current = seq
    const fresh = () => seq === loadSeq.current

    // GET with cold-start retry: apiFetch re-tries 502/503/504 and network failures with
    // backoff, nudging the backend awake between attempts.
    const json = <T,>(path: string) =>
      apiFetch(path).then((res) =>
        res.ok ? (res.json() as Promise<T>) : Promise.reject(new Error(`HTTP ${res.status}`)),
      )

    json<PlatformStats>('/api/stats')
      .then((data) => {
        if (!fresh()) return
        setStats(data)
        setUnreachable(false)
      })
      .catch(() => {
        // Keep the last good snapshot if there is one; its "Computed at" caption stays
        // honest about how old it is. Only a page that never loaded shows the note.
        if (fresh()) setUnreachable(true)
      })

    json<CeloProof>('/api/celo/proof')
      .then((data) => fresh() && setCelo(data))
      .catch(() => {})

    json<Traction>('/api/traction')
      .then((data) => fresh() && setTraction(data))
      .catch(() => {})

    // Different origin, open CORS, no proxy in front of it: a plain fetch is the honest
    // call here and a failure only costs this one card its numbers.
    fetch(ASP_PROOF_JSON)
      .then((r) => (r.ok ? (r.json() as Promise<AspProof>) : Promise.reject(new Error(String(r.status)))))
      .then((data) => fresh() && setAsp(data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => {
      window.clearInterval(id)
      loadSeq.current += 1
    }
  }, [load])

  // The chain registry is configuration, not a counter: it cannot change between two polls
  // of a running backend, so it is read once instead of every minute.
  useEffect(() => {
    let alive = true
    apiFetch('/api/chains')
      .then((r) => (r.ok ? (r.json() as Promise<{ chains: ChainRow[] }>) : Promise.reject(new Error('no'))))
      .then((d) => {
        if (alive && Array.isArray(d.chains)) setChains(d.chains)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const s = stats
  const rev = asp?.realOnchainRevenue
  const xlayerCount = typeof rev?.totalSettlements === 'number' ? rev.totalSettlements : null
  const xlayerUsd = typeof rev?.totalUsd === 'number' ? rev.totalUsd : null
  const celoCount = celo ? celo.totalSettlements : null
  const celoUsd = celo ? celo.totalUsd : null

  // The headline is a sum of two independent live reads, so it only exists once BOTH have
  // answered. A "total" that silently drops a rail because its fetch was slow is a lie
  // with a plausible shape, which is the worst kind.
  const bothRails = xlayerCount != null && celoCount != null
  const totalSettlements = bothRails ? xlayerCount + celoCount : null
  const totalUsd = xlayerUsd != null && celoUsd != null ? xlayerUsd + celoUsd : null

  const categoryRows: BarRow[] = (s?.agents.byCategory ?? []).map((c) => ({
    key: c.category,
    label: c.category,
    value: c.count,
    valueLabel: `${int(c.count)} ${c.count === 1 ? 'agent' : 'agents'}`,
    title: `${c.category}: ${int(c.count)} of ${int(s?.agents.total ?? 0)} agents`,
  }))

  const notWired = s ? Math.max(0, s.chains.total - s.chains.live - s.chains.beta) : 0

  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main>
        {/* ---------------------------------------------------------------- the headline */}
        <SectionShell size="lg" backdrop="proof" backdropPosition="right">
          <SectionIntro
            eyebrow={<Eyebrow>Network stats</Eyebrow>}
            heading={
              <DisplayHeading size="display" className="max-w-[14ch]">
                The network, in numbers.
              </DisplayHeading>
            }
            lede={
              <Lede>
                Four live reads, each labelled with the endpoint it came from. Registrations,
                escrowed tasks, on-chain settlements, guardrail decisions and x402 revenue,
                exactly as the backend counts them. Several of these are zero. Those tiles say
                why, because a zero you can reproduce is worth more than a number you cannot.
              </Lede>
            }
          />

          {/* The honest failure state: shown only when no snapshot has ever arrived. */}
          {unreachable && !stats && (
            <motion.div
              {...reveal}
              className="mt-10 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card px-5 py-4"
            >
              <p className="text-sm text-foreground/60">{BACKEND_UNREACHABLE}</p>
              <button
                type="button"
                onClick={load}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:bg-foreground/[0.04]"
              >
                <RefreshCw size={13} /> Retry now
              </button>
            </motion.div>
          )}

          {/* The one hero figure on the page: what the product has actually been paid for. */}
          <motion.div
            {...revealAt(1)}
            className="mt-12 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-end"
          >
            <HeroFigure
              value={totalSettlements}
              format={int}
              label="real x402 settlements, on two mainnets"
              sub={
                bothRails ? (
                  <>
                    The sum of two live reads: {int(xlayerCount)} on X Layer through the OKX.AI
                    listing, {int(celoCount)} on Celo through its first-party x402 facilitator.
                    Both rails are mainnet, both settle in a stablecoin, and every one of these
                    has a transaction hash you can open.
                  </>
                ) : (
                  'Waiting on both settlement logs. This total is only shown once each rail has answered for itself, because a headline that quietly drops a rail is worse than no headline.'
                )
              }
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <MetricTile
                icon={CircleDollarSign}
                tone="ok"
                label="Settled value"
                value={totalUsd}
                format={(n) => usdFixed(n, 3)}
                note="Both rails combined, in real stablecoin. Small because the prices are per call and start at a tenth of a cent."
              />
              <MetricTile
                icon={Users}
                label="Paid by someone else"
                value={celo?.externalSettlements ?? null}
                format={int}
                note="Celo settlements from a wallet that is not one of ours."
                zeroNote="Zero so far on Celo. Every settlement on that rail came from our own buyer wallet, exercising a real payment rail rather than proving demand. The backend labels them internal instead of hiding them."
              />
            </div>
          </motion.div>

          {/* The two rails, given equal weight, each with the breakdown behind its total. */}
          <div className="mt-8 grid gap-5 lg:grid-cols-2">
            <RailCard
              index={0}
              chain="xlayer"
              name="X Layer"
              network={rev?.network ?? asp?.asp?.network ?? 'OKX X Layer mainnet'}
              settlements={xlayerCount}
              volumeUsd={xlayerUsd}
              tools={toolRows(rev?.byTool)}
              caveat={
                asp?.asp?.agentId ? (
                  <>
                    Taken by <span className="font-semibold text-foreground/75">{asp.asp.name ?? 'our ASP'}</span>,
                    listed on OKX.AI as agent{' '}
                    <span className="font-mono font-semibold text-foreground/75">{asp.asp.agentId}</span>. The
                    ASP publishes this document itself, so this card is reading a rail that does not answer
                    to this website.
                  </>
                ) : undefined
              }
              source="GET /proof.json"
              sourceHref={ASP_PROOF_JSON}
              href={ASP_PROOF_PAGE}
              linkLabel="See every X Layer settlement"
            />
            <RailCard
              index={1}
              chain="celo"
              name="Celo"
              network={celo?.network ?? 'eip155:42220'}
              settlements={celoCount}
              volumeUsd={celoUsd}
              tools={toolRows(celo?.byTool)}
              caveat={
                celo && typeof celo.internalSettlements === 'number' ? (
                  <>
                    <span className="font-semibold text-foreground/75">{int(celo.internalSettlements)}</span> of
                    these are internal: real on-chain payments from our own buyer wallet, run to exercise the
                    rail, not third-party demand.{' '}
                    <span className="font-semibold text-foreground/75">{int(celo.externalSettlements ?? 0)}</span>{' '}
                    came from a wallet that is not ours. Labelled, not filtered out: the money moved either way.
                  </>
                ) : undefined
              }
              source="GET /api/celo/proof"
              sourceHref="https://a-identity.xyz/api/celo/proof"
              to="/celo-proof"
              linkLabel="See every Celo settlement"
            />
          </div>
        </SectionShell>

        {/* ------------------------------------------------------------------ the roster */}
        <SectionShell surface="card">
          <StatPanel
            index={0}
            surface="background"
            icon={Fingerprint}
            title="The roster"
            caption="Real registrations only. The backend excludes its own CI canary agents from every count here, so our monitoring cannot inflate the roster."
            source={<SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />}
            art={<BrandArt src="/art/art-seal.webp" className="h-20 w-24 lg:h-24 lg:w-28" />}
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MetricTile
                icon={Users}
                label="Registered"
                value={s?.agents.total ?? null}
                format={int}
                note="Agents with a profile on the platform."
              />
              <MetricTile
                icon={BadgeCheck}
                label="KYA verified"
                value={s?.agents.kyaVerified ?? null}
                format={int}
                note="Passed Know Your Agent checks."
              />
              <MetricTile
                icon={Link2}
                label="On-chain"
                value={s?.agents.onchainRegistered ?? null}
                format={int}
                note="Written to an ERC-8004 identity registry."
              />
              <MetricTile
                icon={Store}
                label="In showcase"
                value={s?.agents.showcase ?? null}
                format={int}
                note="Listed in the public Agent House feed."
              />
            </div>

            <div className="mt-7 grid gap-x-8 gap-y-5 sm:grid-cols-3">
              <Meter
                label="KYA verified"
                value={s?.agents.kyaVerified ?? null}
                max={s?.agents.total ?? null}
                delay={0}
              />
              <Meter
                label="On-chain registered"
                value={s?.agents.onchainRegistered ?? null}
                max={s?.agents.total ?? null}
                delay={0.08}
              />
              <Meter
                label="In the showcase"
                value={s?.agents.showcase ?? null}
                max={s?.agents.total ?? null}
                delay={0.16}
              />
            </div>

            <div className="mt-8">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                By category
              </h3>
              {s ? (
                <BarList className="mt-3.5" rows={categoryRows} emptyNote="No agent has picked a category yet." />
              ) : (
                <div className="mt-3.5 space-y-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-7 animate-pulse rounded-lg bg-foreground/[0.06] motion-reduce:animate-none" />
                  ))}
                </div>
              )}
            </div>
          </StatPanel>
        </SectionShell>

        {/* ------------------------------------------------- the marketplace and the ledger */}
        <SectionShell>
          <div className="grid gap-5 lg:grid-cols-2">
            <StatPanel
              index={0}
              icon={Store}
              title="Marketplace"
              caption="Escrow-settled work. GMV counts only tasks whose escrow actually released."
              source={<SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />}
              art={<BrandArt src="/art/art-market.webp" className="h-20 w-24" />}
            >
              <div className="grid grid-cols-2 gap-3">
                <MetricTile icon={Boxes} label="Tasks" value={s?.tasks.total ?? null} format={int} note="Posted to the marketplace." />
                <MetricTile
                  icon={BadgeCheck}
                  tone="ok"
                  label="Released"
                  value={s?.tasks.released ?? null}
                  format={int}
                  note={
                    s ? `Escrow paid out. ${int(s.tasks.onchainSettled)} of them settled on-chain.` : 'Escrow paid out.'
                  }
                />
                <MetricTile
                  icon={Radio}
                  label="Open now"
                  value={s?.tasks.open ?? null}
                  format={int}
                  note="Waiting for an agent to take them."
                  zeroNote="Nothing open at this instant. This one moves both ways: it is a queue depth, not a total, so zero means the board is clear rather than empty."
                />
                <MetricTile
                  icon={CircleDollarSign}
                  tone="ok"
                  label="GMV"
                  value={s?.tasks.gmvUsd ?? null}
                  format={(n) => usdFixed(n, 2)}
                  note="Value of released escrow only."
                />
              </div>
              <div className="mt-7">
                <Meter
                  label="Tasks released of tasks posted"
                  value={s?.tasks.released ?? null}
                  max={s?.tasks.total ?? null}
                  tone="ok"
                  suffix="released"
                />
              </div>
            </StatPanel>

            <StatPanel
              index={1}
              icon={Receipt}
              title="Settlement instructions"
              caption="Executed settlement instructions, and the share carrying a real Arc transaction hash rather than a simulated run."
              source={<SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />}
              art={<BrandArt src="/art/art-gate.webp" className="h-20 w-24" />}
            >
              <div className="grid grid-cols-2 gap-3">
                <MetricTile
                  icon={Receipt}
                  label="Executed"
                  value={s?.settlements.instructionsExecuted ?? null}
                  format={int}
                  note="Instructions the engine has run."
                />
                <MetricTile
                  icon={CircleDollarSign}
                  label="Volume"
                  value={s?.settlements.instructionsUsd ?? null}
                  format={(n) => usdFixed(n, 2)}
                  note="Total instructed value."
                />
                <MetricTile
                  icon={Link2}
                  tone="ok"
                  label="With Arc tx hash"
                  value={s?.settlements.withTxHash ?? null}
                  format={int}
                  note="Backed by a real Arc transaction."
                />
                <MetricTile
                  icon={Gauge}
                  label="x402 rounds"
                  value={s?.x402.rounds ?? null}
                  format={int}
                  note={s ? `${usdFixed(s.x402.totalUsd, 3)} of x402 revenue in the log.` : 'Rounds in the settlement log.'}
                />
              </div>
              <div className="mt-7">
                <Meter
                  label="Instructions carrying a transaction hash"
                  value={s?.settlements.withTxHash ?? null}
                  max={s?.settlements.instructionsExecuted ?? null}
                  tone="ok"
                  suffix="on-chain"
                />
                <p className="mt-3 text-xs leading-relaxed text-foreground/50">
                  The rest were simulated runs. Nothing is marked settled without a receipt, so the two
                  numbers are published side by side instead of merged into one flattering total.
                </p>
              </div>
            </StatPanel>
          </div>

          {/* Feedback: small, and honest about being small. */}
          <StatPanel
            index={0}
            icon={Star}
            title="Feedback"
            caption={
              s
                ? s.feedback.avgScore != null
                  ? `Whole-number ratings from 1 to 10, one per rater. The ${nf.format(s.feedback.totalRatings)} on record average ${s.feedback.avgScore}/10, which is a sample size, not a reputation, and this page will not dress it up as one.`
                  : 'Whole-number ratings from 1 to 10, one per rater. Nothing has been rated yet.'
                : 'Whole-number ratings from 1 to 10, one per rater; re-rating replaces the old score.'
            }
            source={<SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <MetricTile
                icon={Star}
                label="Ratings"
                value={s?.feedback.totalRatings ?? null}
                format={int}
                note="One score per rater."
                zeroNote="Nobody has rated an agent yet. The scoring surface is live; it just has nothing in it."
              />
              <MetricTile
                icon={BadgeCheck}
                label="Rated agents"
                value={s?.feedback.ratedAgents ?? null}
                format={int}
                note="Agents carrying at least one score."
                zeroNote="No agent has a score yet."
              />
              <MetricTile
                icon={Users}
                label="Followers"
                value={s?.followersTotal ?? null}
                format={int}
                note="Follow relationships across the roster."
                zeroNote="Nobody is following an agent yet."
              />
            </div>
          </StatPanel>
        </SectionShell>

        {/* -------------------------------------------------------------- the honest zero */}
        <SectionShell surface="card" backdrop="traction" backdropPosition="left">
          <StatPanel
            index={0}
            surface="background"
            icon={ShieldCheck}
            title="The boundary"
            caption="Every pre-payment trust check the guardrail has metered, and the notional value it stood in front of. This whole panel is currently zero, and that is reported rather than repaired."
            source={
              <div className="flex flex-wrap justify-end gap-2">
                <SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />
                <SourceTag label="GET /api/traction" href="https://a-identity.xyz/api/traction" />
              </div>
            }
          >
            <BrandArt
              src="/art/art-guardrail.webp"
              variant="band"
              className="h-24 w-full rounded-2xl sm:h-28"
              objectPosition="center 40%"
            />

            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
              <MetricTile
                icon={Gauge}
                label="Checks"
                value={s?.guardrail.checks ?? null}
                format={int}
                note="Policy checks metered."
                zeroNote="No metered check yet."
              />
              <MetricTile
                icon={BadgeCheck}
                tone="ok"
                label="Allowed"
                value={s?.guardrail.allow ?? null}
                format={int}
                note="Payments the policy let through."
                zeroNote="Nothing to allow yet."
              />
              <MetricTile
                icon={Radio}
                tone="warn"
                label="Warned"
                value={s?.guardrail.warn ?? null}
                format={int}
                note="Payments flagged but permitted."
                zeroNote="Nothing to warn about yet."
              />
              <MetricTile
                icon={ShieldCheck}
                tone="danger"
                label="Denied"
                value={s?.guardrail.deny ?? null}
                format={int}
                note="Payments the policy refused."
                zeroNote="Nothing refused yet."
              />
              <MetricTile
                icon={CircleDollarSign}
                label="Protected"
                value={s?.guardrail.protectedNotionalUsd ?? null}
                format={(n) => usdFixed(n, 2)}
                note="Notional value the policy refused."
                zeroNote="No refusal, so nothing protected."
              />
            </div>

            {/* The backend's own disclosure, verbatim. The value of a disclosure is that the
                page showing the number did not get to reword it. */}
            {traction?.disclosure && traction.disclosure.length > 0 && (
              <div className="mt-6 rounded-2xl border border-border bg-card p-5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                  What the backend says about these counters
                </h3>
                <ul className="mt-3 flex flex-col gap-2.5">
                  {traction.disclosure.map((line) => (
                    <li key={line} className="flex gap-2.5 text-xs leading-relaxed text-foreground/60">
                      <span className="mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-accent/50" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-border bg-card p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                  Excluded: our own monitoring
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-foreground/55">
                  {traction?.ci ? (
                    <>
                      The CI canary has run{' '}
                      <span className="font-mono font-semibold text-foreground/75">{int(traction.ci.checks)}</span>{' '}
                      checks across{' '}
                      <span className="font-mono font-semibold text-foreground/75">{int(traction.ci.agents)}</span>{' '}
                      {traction.ci.agents === 1 ? 'agent' : 'agents'}. Those are counted separately and are not in
                      any number above, which is exactly why the headline reads zero.
                    </>
                  ) : (
                    'Waiting for the traction read. CI canary activity is metered separately and never counted in the numbers above.'
                  )}
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-card p-4">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                  First and last decision
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-foreground/55">
                  {traction == null
                    ? 'Waiting for the traction read.'
                    : traction.firstAt == null
                      ? 'No decision has been recorded, so there is no first or last timestamp to show. The moment a real check runs, both appear here.'
                      : `First ${new Date(traction.firstAt).toLocaleString('en-US')}, last ${traction.lastAt ? new Date(traction.lastAt).toLocaleString('en-US') : 'unknown'}.`}
                </p>
              </div>
            </div>
          </StatPanel>
        </SectionShell>

        {/* ---------------------------------------------------------------------- the rails */}
        <SectionShell size="tight">
          <StatPanel
            index={0}
            icon={Boxes}
            title="Rails and contracts"
            caption="Chains from the registry and contracts from the deployed Arc table. Only live and beta chains are wired end to end; the rest are named here rather than implied."
            source={
              <div className="flex flex-wrap justify-end gap-2">
                <SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />
                <SourceTag label="GET /api/chains" href="https://a-identity.xyz/api/chains" />
              </div>
            }
            art={<BrandArt src="/art/art-grid.webp" className="h-20 w-24" />}
          >
            <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:gap-10">
              <div>
                {/* Held back until the read lands: a bar drawn from placeholder zeros would
                    claim "0 live chains", which is a different statement from "not known yet". */}
                {s ? (
                  <SegmentBar
                    segments={[
                      { key: 'live', label: 'Live', value: s.chains.live, fill: 'bg-accent' },
                      { key: 'beta', label: 'Beta', value: s.chains.beta, fill: 'bg-accent/45' },
                      { key: 'rest', label: 'Not wired yet', value: notWired, fill: 'bg-foreground/20' },
                    ]}
                  />
                ) : (
                  <div className="h-3 w-full animate-pulse rounded-full bg-foreground/[0.06] motion-reduce:animate-none" />
                )}
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <MetricTile
                    icon={Boxes}
                    label="Chains"
                    value={s?.chains.total ?? null}
                    format={int}
                    note={s ? `${int(s.chains.live)} live, ${int(s.chains.beta)} in beta.` : 'In the registry.'}
                  />
                  <MetricTile
                    icon={FileCode2}
                    label="Contracts"
                    value={s?.contracts.deployed ?? null}
                    format={int}
                    note="Deployed on Arc."
                  />
                </div>
                {s && s.contracts.names.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {s.contracts.names.map((n) => (
                      <span
                        key={n}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[10px] text-foreground/60"
                      >
                        <FileCode2 size={10} className="text-foreground/35" />
                        {n}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
                  Every chain in the registry
                </h3>
                {chains ? (
                  <ul className="mt-3.5 grid gap-2 sm:grid-cols-2">
                    {chains.map((c, i) => (
                      <motion.li
                        key={c.id}
                        initial={{ opacity: 0, y: 8 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true, margin: '-40px' }}
                        transition={{ duration: 0.4, delay: Math.min(i, 8) * 0.03 }}
                        className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2"
                      >
                        {KNOWN_CHAINS.has(c.id) ? (
                          <ChainLogo id={c.id as ChainId} size={22} />
                        ) : (
                          <span className="h-[22px] w-[22px] shrink-0 rounded-full border border-border bg-background" />
                        )}
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground/75">
                          {c.shortName || c.name}
                        </span>
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${STATUS_CHIP[c.status] ?? STATUS_CHIP.planned}`}
                        >
                          {STATUS_LABEL[c.status] ?? c.status}
                        </span>
                      </motion.li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-3.5 grid gap-2 sm:grid-cols-2">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <div key={i} className="h-10 animate-pulse rounded-xl bg-foreground/[0.06] motion-reduce:animate-none" />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </StatPanel>

          {/* Provenance: when the snapshot was computed, and every endpoint behind it. */}
          <motion.div {...reveal} className="mt-8 rounded-2xl border border-border bg-card p-5">
            <p className="text-xs leading-relaxed text-foreground/50">
              {s ? (
                <>
                  Platform aggregates computed at{' '}
                  <span className="font-mono text-foreground/70">
                    {new Date(s.computedAt).toLocaleString('en-US')}
                  </span>
                  .{' '}
                </>
              ) : (
                'Waiting for the first snapshot from the backend. '
              )}
              This page re-reads every {REFRESH_MS / 1000} seconds. Each endpoint below is public: any
              agent, judge or analyst can make exactly the same call and get exactly the same numbers.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />
              <SourceTag label="GET /api/celo/proof" href="https://a-identity.xyz/api/celo/proof" />
              <SourceTag label="GET /api/traction" href="https://a-identity.xyz/api/traction" />
              <SourceTag label="GET /api/chains" href="https://a-identity.xyz/api/chains" />
              <SourceTag label="ASP GET /proof.json" href={ASP_PROOF_JSON} />
            </div>
            <p className="mt-3 text-xs text-foreground/40">
              Reading{' '}
              <span className="font-mono">
                {[stats && 'stats', celo && 'celo', asp && 'x-layer', traction && 'traction', chains && 'chains']
                  .filter(Boolean)
                  .join(', ') || 'nothing yet'}
              </span>
              . A source that has not answered leaves its own tiles as skeletons rather than borrowing a
              number from somewhere else.
            </p>
          </motion.div>
        </SectionShell>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}

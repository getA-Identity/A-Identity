import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
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
import ChainLogo from '../components/app/ChainLogo'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../components/ui/section'
import { BarList, SegmentBar, type BarRow } from '../components/stats/charts'
import { int, nf, usdFixed } from '../components/stats/format'
import { HeroFigure, Meter, MetricTile, SourceTag, StatPanel } from '../components/stats/kit'
import { EvidenceChip, LogTile, LogsAgreementLine } from '../components/stats/LogTile'
import { RailCard } from '../components/stats/RailCard'
import { apiFetch } from '../lib/api'
import { CHAINS, type ChainId, type ChainStatus } from '../lib/chains'
import { usePageMeta } from '../lib/head'
import { BACKEND_UNREACHABLE } from '../lib/mcpBase'
import {
  SETTLEMENT_LOGS,
  SEASON_URL,
  chainRows,
  crossLogTotals,
  fetchSeason,
  fetchSettlementLogs,
  okReads,
  type ChainRow as SettledChain,
  type ChainSource,
  type LogResults,
  type SeasonSummary,
  type ToolRow,
} from '../lib/settlement-logs'

/**
 * /stats: the network, in numbers, for anyone who asks "is this real?"
 *
 * Live reads only, each labelled on the surface that shows it: GET /api/stats for the
 * platform aggregates, every published settlement log through the one shared spec in
 * src/lib/settlement-logs.ts (the same list /proof reads, so the two pages cannot drift),
 * GET /api/arc/season for the Arc Acceleration Season note, GET /api/traction for the
 * guardrail meter and the disclosure text that explains its zeros, and GET /api/chains for
 * the registry. Nothing on this page is projected, padded or invented, and the backend
 * excludes its own CI canary agents from every headline so monitoring cannot inflate the
 * numbers.
 *
 * The page is built around a fact that would be tempting to hide: several counters here
 * are genuinely zero or nearly so. Almost every settlement on every rail was paid by a
 * buyer wallet of ours. The guardrail has not been asked a single metered question. Rather
 * than pad those or drop the tiles, each zero carries the reason it is zero, sourced from
 * the API where the API supplies one. That is the same argument the rest of the site
 * makes: a number you cannot reproduce is worth less than one you can, and that goes for
 * zero too.
 *
 * Every fetch is independent, so one slow or missing endpoint degrades its own panel into
 * skeletons instead of blanking the page. Reads go through apiFetch, which retries a
 * sleeping free-tier backend through its cold start with wake pings; the ASP is on a
 * different origin and answers CORS directly, so it is fetched plainly. A single sequence
 * guard covers every polled read, because apiFetch can spend longer retrying than the 60s poll
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
  /** onchainUsd / simulatedUsd are the split the backend publishes so the two are never
   *  read as one settled total; older backends omit them, hence optional. */
  settlements: {
    instructionsExecuted: number
    instructionsUsd: number
    withTxHash: number
    onchainUsd?: number
    simulatedUsd?: number
  }
  feedback: { totalRatings: number; avgScore: number | null; ratedAgents: number }
  followersTotal: number
  guardrail: { checks: number; allow: number; warn: number; deny: number; protectedNotionalUsd: number }
  chains: { total: number; live: number; beta: number }
  contracts: { deployed: number; names: string[] }
  x402: { rounds: number; totalUsd: number }
  computedAt: string
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

/** Per-tool rows as bars. The shared normalizer already evened out the shapes (most logs
 *  send objects, the ASP sends bare counts); a USD figure prints only where the log has one. */
function toolBars(rows: ToolRow[], prefix = ''): BarRow[] {
  return rows.map((r) => ({
    key: `${prefix}${r.tool}`,
    label: r.tool,
    value: r.count,
    valueLabel: r.usd == null ? int(r.count) : `${int(r.count)} · ${usdFixed(r.usd, 3)}`,
    title: `${r.tool}: ${int(r.count)} paid calls`,
  }))
}

/**
 * What qualifies a chain's count that the logs cannot say about themselves: who runs the
 * rail, what it settles in, what changed since. No number lives here; counts, payers and
 * windows come from the logs, and these notes only explain the rail behind them.
 */
const CHAIN_NOTES: Partial<Record<ChainId, string>> = {
  'arc-mainnet':
    "Circle's stablecoin-native L1, selling since 2026-09-16 on two rails at once: our own EIP-3009 facilitator, whose gas is itself USDC, and Circle Gateway nanopayments, which Gateway batches on-chain. Both rails' rows are on this one card.",
  base:
    'The same facilitator and the same engine, settling in native Circle USDC. Agent #73232 is ours on the canonical registry. The rail\'s first settlement was broadcast from an operator machine and lives on the proof page; this card counts only what the production facilitator has settled here, read live, so the two can differ.',
  arbitrum:
    'The same facilitator and the same engine, settling in native Circle USDC. Other facilitators already serve this chain, which is the point: here our receipts can be compared against a baseline.',
  rhchain:
    'We run our own x402 facilitator here, as on every chain we sell on, though other facilitators serve this chain too: the buyer signs and pays no gas, we broadcast, and a settlement only counts once the receipt carries the matching transfer.',
  stellar:
    'The buyer signs a Soroban authorization entry and pays no fee; whoever assembles the transaction pays it, and a row counts only after our own read of the SEP-41 transfer event.',
  algorand:
    "x402 v2 in native Circle USDC: the buyer signs a fee-zero ASA transfer inside a pooled-fee group, the GoPlausible facilitator broadcasts, and a row counts only after our own indexer read. The log keeps a window, so the count here is its latest rows rather than the rail's history; the all-time record is the payTo account's transfers on any indexer.",
  celo:
    'The payment rail here is not ours: settlement runs through the first-party facilitator Celo operates, and a row is counted when that facilitator answers settled, which this site does not read back from the chain.',
  xlayer:
    'Listed on OKX.AI until 2026-09-26, selling in the demo and seeding runs of 2026-07-17 to 2026-07-24. The list is fixed inside the ASP rather than a running counter, and the ASP publishes it itself, so this card reads a rail that does not answer to this website.',
}

/**
 * Above this share of the labelled settlements, our own wallets are nearly all of them and
 * the value tiles say so where the figure is shown: the settled value is then mostly our
 * own self-funded payments that exercised the rails, not revenue or demand.
 */
const SELF_FUNDED_SHARE = 0.9

/** A share as a whole percent, rounded down so 99.6% never prints as 100%. */
const pctFloor = (share: number) => `${Math.floor(share * 100)}%`

/** "row" or "rows", for a count printed beside it. */
const rowsWord = (n: number) => (n === 1 ? 'row' : 'rows')

/**
 * A log as the subject of a sentence: "the Stellar x402 log", or "our EIP-3009 facilitator
 * log" for a label that already starts with "Our", so no sentence reads "the Our". `lead`
 * capitalizes it for the start of a sentence.
 */
function logPhrase(label: string, lead = false): string {
  const ours = /^our\s+/i.test(label)
  const phrase = ours ? `our ${label.replace(/^our\s+/i, '')} log` : `the ${label} log`
  return lead ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase
}

/** The payer split for one log's rows on one chain, in that log's own scope. */
function splitSentence(src: ChainSource): string {
  if (src.splitScope === 'chain' && src.internal != null) {
    const ext = src.external ?? Math.max(0, src.count - src.internal)
    return `${int(src.internal)} of these are internal, real payments from our own buyer wallet run to exercise the rail, not third-party demand; ${int(ext)} came from a wallet that is not ours. Labelled, not filtered out: the money moved either way.`
  }
  if (src.splitScope === 'inferred' && src.internal != null) {
    const all = src.external === 0 ? 'internal' : 'external'
    const why =
      all === 'internal'
        ? `: ${src.count === 1 ? 'a real payment' : 'real payments'} from our own buyer wallet, run to exercise the rail, not third-party demand`
        : ''
    return `${logPhrase(src.label, true)} labels every one of its rows ${all}, and that covers the ${int(src.count)} ${rowsWord(src.count)} on this chain${why}. Labelled, not filtered out.`
  }
  if (src.splitScope === 'log' && src.internal != null) {
    return `${logPhrase(src.label, true)} splits payers rail-wide rather than per chain: ${int(src.internal)} of its ${int(src.logCount)} rows are internal and ${int(src.external ?? 0)} came from wallets that are not ours. This chain holds ${int(src.count)} of those rows.`
  }
  return src.payers ?? 'This log does not label which payers are its own, so its rows are counted as unknown, not as external.'
}

export default function Stats() {
  usePageMeta({
    title: 'Network stats, live from the platform | A-Identity',
    description:
      'The A-Identity network in real numbers: registered agents, task GMV, on-chain settlements, guardrail checks, chains and x402 settlements. Aggregates computed live, never projected.',
    canonical: 'https://a-identity.xyz/stats',
  })

  const [stats, setStats] = useState<PlatformStats | null>(null)
  // Every settlement log, keyed by log. A log that failed is marked so, never shown as zero.
  const [logs, setLogs] = useState<LogResults>({})
  const [logsReadAt, setLogsReadAt] = useState<number | null>(null)
  const [season, setSeason] = useState<SeasonSummary | null>(null)
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

    // Every published settlement log, through the shared spec, each landing on its own. A
    // refresh that fails keeps the last good read; only a log never read is marked failed.
    void fetchSettlementLogs({
      backend: (path) => apiFetch(path),
      onEach: (result) => {
        if (!fresh()) return
        setLogs((prev) => {
          const last = prev[result.spec.key]
          if (result.status === 'failed' && last?.status === 'ok') return prev
          return { ...prev, [result.spec.key]: result }
        })
        setLogsReadAt(result.readAt)
      },
    })

    // The Arc Acceleration Season document counts Arc Mainnet checks from the same two
    // logs. Quoted only when actually read; nothing from it is copied into the page.
    void fetchSeason((path) => apiFetch(path)).then((data) => {
      if (fresh() && data) setSeason(data)
    })

    json<Traction>('/api/traction')
      .then((data) => fresh() && setTraction(data))
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

  // The cross-log figures. `total` exists only once EVERY log has answered: a total that
  // silently drops a rail because its fetch was slow is a lie with a plausible shape, which
  // is the worst kind. The payer split sums only the logs that label payers.
  const totals = crossLogTotals(logs)
  const complete = totals.total != null
  const answeredLogs = okReads(logs)
  const rails: SettledChain[] = chainRows(logs)
  const waitingOn = [...totals.pending, ...totals.failed].map((l) => l.label)

  // The USD headline is `usdKnown`, the sum over the logs that publish a USD figure, with
  // the logs that publish none named beside it: the strict all-logs `usd` stays null for
  // good while any log omits one, and a skeleton that never resolves says nothing.
  const usdLogs = totals.answered - totals.usdUnknownLogs.length
  const usdScope =
    totals.usdUnknownLogs.length === 0
      ? `Every log's own USD figure, summed, in real stablecoin, across all ${int(SETTLEMENT_LOGS.length)} logs.`
      : `Summed in real stablecoin across the ${int(usdLogs)} ${usdLogs === 1 ? 'log that publishes' : 'logs that publish'} a USD figure; ${totals.usdUnknownLogs.map((l) => l.label).join(' and ')} ${totals.usdUnknownLogs.length === 1 ? 'does not, so its' : 'do not, so their'} rows are counted in the headline but not here.`

  // Who paid, by count, over the logs that label payers. No log splits its USD by payer, so
  // count is the honest basis; when our own wallets are nearly all of it, both value tiles
  // say so under the figure itself, because that value is seeding, not revenue or demand.
  const labelled = totals.internal + totals.external
  const internalShare = labelled > 0 ? totals.internal / labelled : null
  const selfFundedSentence =
    internalShare != null && internalShare >= SELF_FUNDED_SHARE
      ? internalShare === 1
        ? `Every one of the ${int(labelled)} settlements a log can label was our own self-funded payment that exercised the rails, counted and labelled internal, so the settled value is our own money, not revenue or demand.`
        : `${int(totals.internal)} of the ${int(labelled)} settlements a log can label, ${pctFloor(internalShare)} by count, were our own self-funded payments that exercised the rails, counted and labelled internal, so most of the settled value is our own money, not revenue or demand.`
      : ''

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
                Every figure is a live read, labelled with the endpoint it came from.
                Registrations, escrowed tasks, on-chain settlements, guardrail decisions and x402
                settlements, exactly as the backend counts them, with our own payments labelled
                as ours. Several of these are zero. Those tiles say why, because a zero you can
                reproduce is worth more than a number you cannot.
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
              value={totals.total}
              format={int}
              label="settlements across every published log"
              sub={
                complete ? (
                  <>
                    The sum of {int(SETTLEMENT_LOGS.length)} live reads, one per settlement log, each counted on its
                    own terms and labelled with the evidence that counted it below. Each settled in stablecoin on the
                    chain its log names; where that chain is a testnet, it moved test money, and the card for that
                    chain below says so.{' '}
                    {totals.external === 0
                      ? 'Every labelled payer so far was a buyer wallet of ours, so read it as rails that work, not as demand.'
                      : `${int(totals.external)} of them were paid by a wallet that is not ours; the rest that a log can label were our own.`}{' '}
                    {totals.unlabeled > 0 &&
                      `${int(totals.unlabeled)} sit in a log that does not label payers and are counted as unknown, not as external.`}{' '}
                    {totals.cappedLogs.length > 0 &&
                      `The ${totals.cappedLogs.map((l) => l.label).join(' and ')} log keeps only a window of rows, so this total is a window there, not a history.`}
                  </>
                ) : (
                  <>
                    Waiting on {waitingOn.length > 0 ? waitingOn.join(', ') : 'the settlement logs'}. This total is only
                    shown once every log has answered for itself, because a headline that quietly drops a rail is worse
                    than no headline.
                  </>
                )
              }
            />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <MetricTile
                icon={CircleDollarSign}
                tone="ok"
                label="Settled value"
                value={complete ? totals.usdKnown : null}
                format={(n) => usdFixed(n, 3)}
                note={
                  complete
                    ? `${usdScope} ${selfFundedSentence || 'Our own payments are in it and labelled in the payer split beside it. Prices are per call and start at a tenth of a cent, so most rails stay small.'}`
                    : 'Every log that publishes a USD figure, summed, in real stablecoin, once every log has answered. Our own payments are in it and labelled in the payer split beside it.'
                }
                zeroNote={
                  usdLogs === 0
                    ? 'No published log carries a USD figure, so there is nothing to sum here; the counts stand on their own.'
                    : 'The logs that publish a USD figure report nothing settled yet.'
                }
              />
              <MetricTile
                icon={Users}
                label="Paid by someone else"
                value={complete ? totals.external : null}
                format={int}
                note={
                  complete
                    ? `Settlements from a wallet that is not ours, across the ${int(SETTLEMENT_LOGS.length - totals.unlabeledLogs.length)} logs that label payers. ${selfFundedSentence || `${int(totals.internal)} were internal.`} ${totals.unlabeled > 0 ? `${int(totals.unlabeled)} more sit in a log that does not split payers and are counted as unknown, not as external.` : ''}`
                    : 'Settlements from a wallet that is not ours, summed only across the logs that label payers.'
                }
                zeroNote={`Zero so far. ${selfFundedSentence || `Every settlement a log can label came from our own buyer wallets: ${int(totals.internal)} internal payments that prove the rails work, not demand.`} Labelled instead of hidden.${totals.unlabeled > 0 ? ` ${int(totals.unlabeled)} more sit in a log that does not split payers and are counted as unknown.` : ''}`}
              />
            </div>
          </motion.div>

          {/* Per log: the same tiles /proof shows, from the same spec, so the two pages agree. */}
          <div className="mt-10">
            <h2 className="text-lg font-bold tracking-tight text-foreground">Every settlement log</h2>
            <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-foreground/55">
              The headline above is the sum of these. Each log counts on its own terms, named on its tile: a chain
              receipt we read, a facilitator credit we read back, our own event read, a facilitator's word, or a fixed
              ledger. Payments from wallets we own are labelled wherever the log can tell; a log that cannot is counted
              as unknown, never as external.
            </p>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {SETTLEMENT_LOGS.map((spec) => (
                <LogTile key={spec.key} spec={spec} result={logs[spec.key]} />
              ))}
            </div>
            {season && (
              <p className="mt-4 max-w-[75ch] text-xs leading-relaxed text-foreground/50">
                The Arc Mainnet rows in the facilitator and Gateway logs include the{' '}
                {season.programName ?? 'Arc Acceleration Season'} checks the season endpoint counts from the same two
                logs: {int(season.internalChecks ?? 0)} internal and {int(season.externalChecks ?? 0)} external as of{' '}
                {season.asOf ? season.asOf.slice(0, 10) : 'this read'}.{' '}
                <Link to={season.evidenceHref} className="font-semibold text-accent underline-offset-4 hover:underline">
                  Progress against each metric is on /proof/arc
                </Link>
                .
              </p>
            )}
            <div className="mt-4">
              <LogsAgreementLine
                readAt={logsReadAt}
                answered={answeredLogs.length}
                total={SETTLEMENT_LOGS.length}
                other={{ to: '/proof', label: '/proof' }}
              />
            </div>
          </div>

          {/* Per chain: one card for every network any log has settled on, derived, never listed by
              hand. A chain that sells on two rails (Arc Mainnet) gets both logs on one card. */}
          <div className="mt-10">
            <h2 className="text-lg font-bold tracking-tight text-foreground">Every chain with a settlement</h2>
            <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-foreground/55">
              The same rows, folded per chain. A chain appears here the moment any log counts a settlement on it;
              nothing is listed by hand and the names and status come from the chain registry.
            </p>
            {rails.length === 0 ? (
              <div className="mt-6 grid gap-5 lg:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-72 animate-pulse rounded-3xl border border-border bg-card motion-reduce:animate-none" />
                ))}
              </div>
            ) : (
              <div className="mt-6 grid gap-5 lg:grid-cols-3">
                {rails.map((row, i) => {
                  const kinds = [...new Set(row.sources.map((src) => src.evidence))]
                  const tools = row.sources.flatMap((src) => toolBars(src.tools, row.sources.length > 1 ? `${src.key}:` : ''))
                  const railWide = row.sources.filter((src) => src.tools.length === 0)
                  const railWideRows = railWide.reduce((n, src) => n + src.count, 0)
                  const noBars = railWideRows === 1 ? 'row here draws no bar' : 'rows here draw no bars'
                  const railWideNote =
                    railWide.length === 0
                      ? undefined
                      : railWide.length === 1
                        ? `${logPhrase(railWide[0].label, true)} breaks paid calls down per tool for the rail as a whole, not per chain, so its ${int(railWideRows)} ${noBars}. Every row is on the proof page.`
                        : `${int(railWide.length)} logs, ${railWide.map((src) => src.label).join(' and ')}, break paid calls down per tool for the rail as a whole, not per chain, so their ${int(railWideRows)} ${noBars}. Every row is on the proof page.`
                  const primary = row.sources[0]
                  const page = row.sources.find((src) => src.pageHref)?.pageHref ?? primary.href
                  const sourceLabel =
                    row.sources.length === 1
                      ? primary.key === 'xlayer'
                        ? 'ASP GET /proof.json'
                        : `GET ${primary.href.replace('https://a-identity.xyz', '')}`
                      : `${row.sources.length} logs`
                  const payerChip =
                    row.internal == null
                      ? { text: 'payers unlabelled', cls: 'bg-foreground/[0.06] text-foreground/45' }
                      : row.external === 0
                        ? { text: 'all internal, self-funded', cls: 'bg-foreground/[0.06] text-foreground/45' }
                        : { text: `${int(row.external ?? 0)} external`, cls: 'bg-ok/10 text-ok' }
                  const isArc = row.chain?.id === 'arc-mainnet'
                  return (
                    <RailCard
                      key={row.caip2}
                      index={i}
                      chain={row.chain?.id}
                      name={row.name}
                      network={row.caip2}
                      testnet={row.testnet}
                      chips={
                        <>
                          {kinds.map((k) => (
                            <EvidenceChip key={k} kind={k} />
                          ))}
                          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${payerChip.cls}`}>
                            {payerChip.text}
                          </span>
                          {row.assets.length > 0 && (
                            <span className="inline-flex items-center rounded-full bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] text-foreground/55">
                              {row.assets.join(', ')}
                            </span>
                          )}
                        </>
                      }
                      settlements={row.count}
                      volumeUsd={row.usd}
                      tools={tools}
                      toolsQualifier={tools.length > 0 ? railWideNote : undefined}
                      toolsEmptyNote={railWideNote}
                      caveat={
                        <>
                          {row.chain && CHAIN_NOTES[row.chain.id] ? <>{CHAIN_NOTES[row.chain.id]} </> : null}
                          {row.sources.map((src) => (
                            <span key={src.key}>
                              {row.sources.length > 1 ? (
                                <>
                                  <span className="font-semibold text-foreground/75">{int(src.count)}</span> through{' '}
                                  {src.label}
                                  {src.cappedAt ? `, in its latest ${int(src.cappedAt)} rows` : ''}. {splitSentence(src)}{' '}
                                </>
                              ) : (
                                <>{splitSentence(src)} </>
                              )}
                            </span>
                          ))}
                          {primary.key === 'xlayer' && primary.payer ? (
                            <>
                              Every row was paid by{' '}
                              <span className="font-mono font-semibold text-foreground/75" title={primary.payer}>
                                {primary.payer.slice(0, 6)}...{primary.payer.slice(-4)}
                              </span>
                              , the wallet that owns that listing on the X Layer registry: our own buyer, so all of
                              them are internal even though the ledger itself does not say so.{' '}
                            </>
                          ) : null}
                          {isArc && season ? (
                            <>
                              These rows include the {season.programName ?? 'Arc Acceleration Season'} checks:{' '}
                              <span className="font-semibold text-foreground/75">{int(season.internalChecks ?? 0)}</span>{' '}
                              internal and{' '}
                              <span className="font-semibold text-foreground/75">{int(season.externalChecks ?? 0)}</span>{' '}
                              external across both rails, as{' '}
                              <a href={SEASON_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent underline-offset-4 hover:underline">
                                GET /api/arc/season
                              </a>{' '}
                              counts them from these same logs; the progress block is on{' '}
                              <Link to={season.evidenceHref} className="font-semibold text-accent underline-offset-4 hover:underline">
                                /proof/arc
                              </Link>
                              .
                            </>
                          ) : null}
                        </>
                      }
                      source={sourceLabel}
                      sourceHref={row.sources.length === 1 ? primary.href : undefined}
                      to={page.startsWith('/') ? page : undefined}
                      href={page.startsWith('/') ? undefined : page}
                      linkLabel={`See the ${row.name} proof`}
                    />
                  )
                })}
              </div>
            )}
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
              caption="Escrow-settled work. GMV counts only tasks whose escrow actually released. The escrow contract runs on Arc testnet, so this is test USDC, not revenue."
              source={<SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />}
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
                  note="Value of released escrow only, in Arc testnet USDC."
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
              caption="Executed settlement instructions, and the share carrying a real transaction hash rather than a simulated run. An agent's vault sits on Arc testnet unless it names another chain, and an on-chain run there moves test USDC."
              source={<SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />}
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
                  label={s && typeof s.settlements.onchainUsd !== 'number' ? 'Volume' : 'Moved on-chain'}
                  value={s ? (s.settlements.onchainUsd ?? s.settlements.instructionsUsd) : null}
                  format={(n) => usdFixed(n, 2)}
                  note={
                    s && typeof s.settlements.onchainUsd === 'number'
                      ? `Value of the runs with a transaction. Another ${usdFixed(s.settlements.simulatedUsd ?? 0, 2)} ran simulated, with no signer, and is never counted as settled.`
                      : 'Total instructed value; this backend does not split on-chain from simulated.'
                  }
                />
                <MetricTile
                  icon={Link2}
                  tone="ok"
                  label="With tx hash"
                  value={s?.settlements.withTxHash ?? null}
                  format={int}
                  note="Backed by a real transaction on the vault's chain."
                />
                <MetricTile
                  icon={Gauge}
                  label="X Layer x402 rounds"
                  value={s?.x402.rounds ?? null}
                  format={int}
                  note={s ? `Runs in the fixed X Layer settlement log, ${usdFixed(s.x402.totalUsd, 3)} in all, every row paid by our own buyer wallet: a working rail, not revenue.` : 'Runs in the X Layer settlement log.'}
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
            caption={
              s && s.guardrail.checks > 0
                ? 'Every pre-payment trust check the guardrail has metered, and the notional value it stood in front of.'
                : 'Every pre-payment trust check the guardrail has metered, and the notional value it stood in front of. This whole panel is currently zero, and that is reported rather than repaired.'
            }
            source={
              <div className="flex flex-wrap justify-end gap-2">
                <SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />
                <SourceTag label="GET /api/traction" href="https://a-identity.xyz/api/traction" />
              </div>
            }
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
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
                      any number above{traction.checks === 0 ? ', which is exactly why the headline reads zero' : ''}.
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
            caption="Chains from the registry and contracts from the Arc testnet table the platform calls. Only live and beta chains are wired end to end; the rest are named here rather than implied."
            source={
              <div className="flex flex-wrap justify-end gap-2">
                <SourceTag label="GET /api/stats" href="https://a-identity.xyz/api/stats" />
                <SourceTag label="GET /api/chains" href="https://a-identity.xyz/api/chains" />
              </div>
            }
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
                    note="On Arc testnet, called by the platform. The registries and usdc are their authors' and Circle's, not ours."
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
              {SETTLEMENT_LOGS.map((spec) => (
                <SourceTag
                  key={spec.key}
                  label={spec.path ? `GET ${spec.path}` : 'ASP GET /proof.json'}
                  href={spec.href}
                />
              ))}
              <SourceTag label="GET /api/arc/season" href={SEASON_URL} />
              <SourceTag label="GET /api/traction" href="https://a-identity.xyz/api/traction" />
              <SourceTag label="GET /api/chains" href="https://a-identity.xyz/api/chains" />
            </div>
            <p className="mt-3 text-xs text-foreground/40">
              Reading{' '}
              <span className="font-mono">
                {[
                  stats && 'stats',
                  ...SETTLEMENT_LOGS.map((spec) => logs[spec.key]?.status === 'ok' && spec.key),
                  season && 'arc-season',
                  traction && 'traction',
                  chains && 'chains',
                ]
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

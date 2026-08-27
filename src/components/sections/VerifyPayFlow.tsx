import { useEffect, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bot, User } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DOCS_URL } from '../../lib/brand'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal } from '../ui/section'

/**
 * The two things the product does, running, presented as the thing a finance
 * product actually shows you: a settlement ledger. Rows arrive at the top the
 * way payments arrive, each one carrying its verdict, its amount and how (or
 * whether) it settled. The denials are in the feed on purpose, with the amount
 * struck through: a ledger that only ever says yes has not shown you the
 * product. Under prefers-reduced-motion the feed holds still, fully populated.
 */

type Verdict = 'ALLOW' | 'DENY'

const LEDGER: {
  from: string
  to: string
  reason: string
  verdict: Verdict
  amount: string
  settle: string
  bridge?: boolean
  you?: boolean
}[] = [
  { from: 'Research agent', to: 'Data API', reason: 'KYA attested, reputation 720', verdict: 'ALLOW', amount: '$0.004', settle: 'Settled · USDC on Arc' },
  { from: 'Unknown agent', to: 'Your agent', reason: 'No on-chain identity', verdict: 'DENY', amount: '$240.00', settle: 'Refused · never funded' },
  { from: 'Your agent', to: 'Compute vendor', reason: 'Inside the daily cap', verdict: 'ALLOW', amount: '$1.20', settle: 'Settled · Gateway + CCTP', bridge: true, you: true },
  { from: 'Translator #4471', to: 'Verifier agent', reason: 'Escrow release on delivery', verdict: 'ALLOW', amount: '$2.00', settle: 'Settled · USDC on Arc' },
  { from: 'Scraper bot', to: 'Your agent', reason: 'Sybil cluster flagged', verdict: 'DENY', amount: '$18.40', settle: 'Refused · never funded' },
  { from: 'Your agent', to: 'Inference API', reason: 'Auto-approved, under $5', verdict: 'ALLOW', amount: '$0.05', settle: 'Settled · USDC on Arc', you: true },
]

/** Rows kept in the feed. The card scrolls internally past ~4.5 of them. */
const VISIBLE = 6

function VerdictPill({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={
        verdict === 'ALLOW'
          ? 'inline-block rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] font-bold text-emerald-600 dark:text-emerald-400'
          : 'inline-block rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-0.5 font-mono text-[10px] font-bold text-red-600 dark:text-red-400'
      }
    >
      {verdict}
    </span>
  )
}

function LedgerRow({ entry }: { entry: (typeof LEDGER)[number] }) {
  const denied = entry.verdict === 'DENY'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 px-5 py-3.5 sm:grid-cols-[minmax(0,1fr)_76px_88px_minmax(150px,0.6fr)]">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
          {entry.you ? (
            <User size={13} className="shrink-0 text-foreground/40" />
          ) : (
            <Bot size={13} className="shrink-0 text-foreground/40" />
          )}
          {entry.from}
          <ArrowRight size={12} className="shrink-0 text-foreground/25" />
          <span className="truncate font-normal text-foreground/55">{entry.to}</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-foreground/40">{entry.reason}</p>
      </div>
      <div className="justify-self-start sm:justify-self-center">
        <VerdictPill verdict={entry.verdict} />
      </div>
      <p
        className={`justify-self-end font-mono text-sm font-semibold ${
          denied ? 'text-foreground/35 line-through' : 'text-foreground'
        }`}
      >
        {entry.amount}
      </p>
      <p
        className={`col-span-3 truncate font-mono text-[11px] sm:col-span-1 sm:justify-self-end sm:text-right ${
          denied
            ? 'text-red-600/80 dark:text-red-400/80'
            : entry.bridge
              ? 'text-accent'
              : 'text-emerald-600/90 dark:text-emerald-400/90'
        }`}
      >
        {entry.settle}
      </p>
    </div>
  )
}

function SettlementLedger() {
  const reduced = useReducedMotion() ?? false
  const [rows, setRows] = useState<{ seq: number; idx: number }[]>(() =>
    Array.from({ length: VISIBLE }, (_, i) => ({ seq: VISIBLE - 1 - i, idx: (VISIBLE - 1 - i) % LEDGER.length })),
  )

  /**
   * The feed used to remove old rows through AnimatePresence exits, which is fine on a
   * visible tab and a leak on a hidden one: framer drives exits with requestAnimationFrame,
   * a background tab pauses rAF, the interval keeps firing, and the exiting rows never
   * finish leaving. Come back after a few minutes and the card is thirty rows tall.
   *
   * So removal is now synchronous (slice, no exit animation, nothing to wait on) and the
   * timer only runs while the tab is actually visible. Rows still animate IN, which is the
   * part a reader can see.
   */
  useEffect(() => {
    if (reduced) return
    let seq = VISIBLE
    let timer: ReturnType<typeof setInterval> | undefined

    const tick = () => {
      setRows((prev) => [{ seq, idx: seq % LEDGER.length }, ...prev].slice(0, VISIBLE))
      seq += 1
    }
    const start = () => {
      if (timer === undefined) timer = setInterval(tick, 2600)
    }
    const stop = () => {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }
    const onVisibility = () => (document.hidden ? stop() : start())

    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reduced])

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-32px_rgba(16,24,40,0.35)]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        {/* No live-pulse dot here. The rows below are a scripted illustration of the
            verify-then-pay order, not a feed, and a pinging green dot is the one visual
            convention every reader takes as "this is happening now". The real ledgers are
            one click away and are labelled as such. */}
        <p className="text-sm font-semibold text-foreground">Settlement ledger, illustrated</p>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/35">
          verify then pay · usdc
        </p>
      </div>

      {/* column heads (desktop) */}
      <div className="hidden grid-cols-[minmax(0,1fr)_76px_88px_minmax(150px,0.6fr)] gap-x-4 border-b border-border/60 px-5 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-foreground/35 sm:grid">
        <span>Counterparties</span>
        <span className="justify-self-center">Verdict</span>
        <span className="justify-self-end">Amount</span>
        <span className="justify-self-end">Settlement</span>
      </div>

      {/* The feed. Capped height with its own scroll, so a live list never grows the page:
          about four and a half rows are visible and the rest is one flick away. */}
      <div className="max-h-[280px] divide-y divide-border/60 overflow-y-auto overscroll-y-contain">
        {rows.map((r) => (
          <motion.div
            key={r.seq}
            initial={reduced ? false : { opacity: 0, y: -14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            <LedgerRow entry={LEDGER[r.idx]} />
          </motion.div>
        ))}
      </div>
    </div>
  )
}

export default function VerifyPayFlow() {
  return (
    <SectionShell id="flow" surface="card" size="lg" backdrop="ledger" backdropPosition="left">
      <SectionIntro
        eyebrow={<Eyebrow>Verify, then pay</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[16ch]">
            Every payment goes through the check first.
          </DisplayHeading>
        }
        lede={
          <Lede>
            An agent asks. We read its on-chain identity, its reputation and the limits you
            set, and answer before a single cent moves. Clean counterparties settle at machine
            speed. The rest stop here.
          </Lede>
        }
      />

      <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.16 }} className="mt-12">
        <SettlementLedger />

        {/* Legend and actions. On a phone this was one wrapping row: the three legend items
            stacked 12px apart with no room to breathe, and then `ml-auto` shoved the two
            links to the right edge on a line of their own, reading as though they belonged
            to nothing. Below `sm` it is now an explicit column with real spacing, and the
            links are their own block behind a rule instead of a stray right-aligned tail.
            The dots are `shrink-0` and top-aligned so the long Gateway line wraps under its
            own text rather than under its bullet. */}
        <div className="mt-6 flex flex-col gap-3.5 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-3">
          <span className="flex items-start gap-2 text-foreground/55 sm:items-center">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500 sm:mt-0" />
            Settles in USDC on Arc
          </span>
          <span className="flex items-start gap-2 text-foreground/55 sm:items-center">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500 sm:mt-0" />
            Refused before it moves
          </span>
          <span className="flex items-start gap-2 text-foreground/55 sm:items-center">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent sm:mt-0" />
            Cross-chain settle via Circle Gateway + CCTP
          </span>
          <span className="mt-1 flex items-center gap-5 border-t border-border/60 pt-4 sm:mt-0 sm:ml-auto sm:border-0 sm:pt-0">
            <Link
              to="/explorer"
              className="inline-flex items-center gap-1.5 font-semibold text-foreground/55 transition-colors hover:text-foreground"
            >
              View more
            </Link>
            <Link
              to="/explorer"
              className="inline-flex items-center gap-1.5 font-semibold text-accent transition-opacity hover:opacity-80"
            >
              Run one yourself <ArrowRight size={15} />
            </Link>
          </span>
        </div>
      </motion.div>

      <motion.p {...reveal} transition={{ ...reveal.transition, delay: 0.24 }} className="mt-6 text-sm text-foreground/40">
        The same verify-then-pay flow is available as an SDK and an MCP server.{' '}
        <a
          href={`${DOCS_URL}/developers/sdk`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-accent hover:underline"
        >
          Put it in your own project
        </a>
        .
      </motion.p>
    </SectionShell>
  )
}

import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
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

const VISIBLE = 5

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

  useEffect(() => {
    if (reduced) return
    let seq = VISIBLE
    const t = setInterval(() => {
      setRows((prev) => [{ seq, idx: seq % LEDGER.length }, ...prev].slice(0, VISIBLE))
      seq += 1
    }, 2600)
    return () => clearInterval(t)
  }, [reduced])

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_60px_-32px_rgba(16,24,40,0.35)]">
      {/* header */}
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </span>
          Settlement ledger
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/35">
          verify → pay · usdc
        </p>
      </div>

      {/* column heads (desktop) */}
      <div className="hidden grid-cols-[minmax(0,1fr)_76px_88px_minmax(150px,0.6fr)] gap-x-4 border-b border-border/60 px-5 py-2 font-mono text-[9px] uppercase tracking-[0.16em] text-foreground/35 sm:grid">
        <span>Counterparties</span>
        <span className="justify-self-center">Verdict</span>
        <span className="justify-self-end">Amount</span>
        <span className="justify-self-end">Settlement</span>
      </div>

      {/* the feed */}
      <div className="divide-y divide-border/60">
        <AnimatePresence initial={false} mode="popLayout">
          {rows.map((r) => (
            <motion.div
              key={r.seq}
              layout
              initial={reduced ? false : { opacity: 0, y: -18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            >
              <LedgerRow entry={LEDGER[r.idx]} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

export default function VerifyPayFlow() {
  return (
    <SectionShell id="flow" surface="card" size="lg">
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

        <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
          <span className="flex items-center gap-2 text-foreground/55">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            Settles in USDC on Arc
          </span>
          <span className="flex items-center gap-2 text-foreground/55">
            <span className="h-2 w-2 rounded-full bg-red-500" />
            Refused before it moves
          </span>
          <span className="flex items-center gap-2 text-foreground/55">
            <span className="h-2 w-2 rounded-full bg-accent" />
            Cross-chain settle via Circle Gateway + CCTP
          </span>
          <Link
            to="/explorer"
            className="ml-auto inline-flex items-center gap-1.5 font-semibold text-accent transition-opacity hover:opacity-80"
          >
            Run one yourself <ArrowRight size={15} />
          </Link>
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

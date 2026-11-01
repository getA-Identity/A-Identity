import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { animate, motion, useInView } from 'framer-motion'
import { ArrowUpRight, Radio } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { ASP_BASE } from '../../lib/mcpBase'
import { SectionBackdrop } from '../ui/section-backdrop'
import { Button } from '../ui/button'
import AgentRing from './AgentRing'
import SettlementTicker from './SettlementTicker'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const PROOF_URL = 'https://a-identity-asp.onrender.com/proof'

const CELO_PROOF_URL = '/celo-proof'

// Hand-maintained and therefore easy to let rot: the settlement count sat at 120 and the
// test count at 163 long after both had moved. Numbers here must match what the two proof
// endpoints report (asp /proof.json and /api/celo/proof), and both are linked below so a
// reader can check rather than trust.
const STATS = [
  // Every number here is pinned by mcp/src/frontend-stats.test.ts against the code that
  // produces it. They were 546 and 522 and had drifted from 120 and 922, which is the
  // exact failure this section exists to argue against: a figure a reader cannot check.
  // The settlement count is the X Layer ledger alone. It used to say "X Layer + Celo",
  // and Celo's count comes from a live endpoint, so the sum was a number nothing in the
  // repository could reproduce.
  // The section's lede promises that every counter labels our own traffic, and this one
  // did not: all 120 came from our own buyer wallet (mcp/src/asp/proof.ts names it).
  { n: 120, k: '120', v: 'real settlements', sub: 'X Layer mainnet, all from our own buyer wallet' },
  { n: null, k: '#0', v: 'first registry token', sub: 'Robinhood Chain mainnet' },
  { n: 1813, k: '1813', v: 'tests, green', sub: 'deterministic scores' },
] as const

/** A number that counts itself up the first time it scrolls into view. */
function CountUp({ to, fallback }: { to: number | null; fallback: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true, margin: '-60px' })
  useEffect(() => {
    if (!seen || to === null || !ref.current) return
    const controls = animate(0, to, {
      duration: 1.2,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        if (ref.current) ref.current.textContent = String(Math.round(v))
      },
    })
    return () => controls.stop()
  }, [seen, to])
  return <span ref={ref}>{to === null ? fallback : '0'}</span>
}

type Ping = { status: string; ms: number; note: string; ok: boolean }

/**
 * Proof, not promises, and now a wire you can touch: the ping button makes a REAL
 * request to the free trust_preview tool on the live ASP and prints the status,
 * the latency and the answer. A failed or rate-limited call prints too, because
 * a proof section that can only succeed is a promise with extra steps.
 */
export default function LiveProof() {
  const [pinging, setPinging] = useState(false)
  const [ping, setPing] = useState<Ping | null>(null)

  const runPing = async () => {
    setPinging(true)
    setPing(null)
    const t0 = performance.now()
    try {
      // Same-origin /asp proxy in prod: the ping must measure the ASP, not whether the
      // visitor's ad blocker lists *.onrender.com.
      const r = await fetch(`${ASP_BASE}/tools/trust_preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: '849980' }),
      })
      const ms = Math.round(performance.now() - t0)
      const body = (await r.json().catch(() => null)) as Record<string, unknown> | null
      const band =
        (body?.band as string) ??
        (body?.trustBand as string) ??
        ((body?.result as Record<string, unknown>)?.band as string) ??
        undefined
      setPing({
        status: `HTTP ${r.status}`,
        ms,
        ok: r.ok,
        note: r.ok ? (band ? `band: ${band}` : 'answered') : 'rate-limited or busy, the tool is still real',
      })
    } catch {
      setPing({
        status: 'no response',
        ms: Math.round(performance.now() - t0),
        ok: false,
        note: 'network blocked the call, the proof link below still works',
      })
    }
    setPinging(false)
  }

  return (
    <section id="okx-asp" className="relative w-full overflow-hidden bg-card px-5 py-16 text-foreground sm:px-8 sm:py-20">
      <SectionBackdrop name="proof" position="right" />
      <div className="mx-auto max-w-[1080px]">
        <motion.h2 {...reveal} className="text-3xl font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]" style={{ fontFamily: 'var(--font-heading)' }}>
          Not a demo. Live, and settling on-chain.
        </motion.h2>
        <motion.p {...reveal} className="mt-4 max-w-[56ch] text-lg font-medium leading-relaxed text-foreground/70 sm:text-xl">
          A trust oracle on eight mainnets, live on Arc Mainnet since the day the network opened.
          Per-call checks settle in real stablecoins, and every number here is on-chain.
        </motion.p>

        {/* The networks, in the order of emphasis the product decided on, set in full
            foreground: this is the line a visitor should be able to quote afterwards. */}
        <motion.p {...reveal} className="mt-5 flex max-w-[60ch] items-start gap-2.5 text-base font-semibold leading-snug text-foreground sm:text-lg">
          <span className="mt-[0.45em] inline-block h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden="true" />
          <span>
            Live on Arc Mainnet, Stellar and Algorand, then Base, Arbitrum One, Robinhood Chain,
            OKX X Layer and Celo.
          </span>
        </motion.p>

        {/* The qualifier stays, because the counters below mean nothing without it. */}
        <motion.p {...reveal} className="mt-4 max-w-[60ch] text-sm leading-relaxed text-foreground/70">
          Published as proof that an open payment rail works end to end with an identity layer,
          not as a revenue line: per-call amounts are fractions of a cent by design, and every
          counter labels which traffic is our own.
        </motion.p>

        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
          {STATS.map((s) => (
            <motion.div
              key={s.v}
              whileHover={{ y: -3 }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className="bg-card p-7"
            >
              <div className="font-mono text-4xl font-bold tracking-tight text-foreground">
                <CountUp to={s.n} fallback={s.k} />
              </div>
              <div className="mt-2 text-[15px] font-semibold text-foreground">{s.v}</div>
              <div className="mt-1 text-sm text-foreground/70">{s.sub}</div>
            </motion.div>
          ))}
        </div>

        {/* The #6271 card above is one of eight: the full identity inventory, as a ring. */}
        <AgentRing />

        {/* The wire you can touch. */}
        <motion.div {...reveal} className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
          <button
            type="button"
            onClick={runPing}
            disabled={pinging}
            className="inline-flex min-h-10 items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-5 py-2.5 text-sm font-semibold text-accent transition hover:bg-accent/15 disabled:opacity-60"
          >
            <Radio size={15} className={pinging ? 'animate-pulse' : ''} />
            {pinging ? 'Calling the live oracle…' : 'Ping the live oracle'}
          </button>

          {ping && (
            <motion.span
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className="font-mono text-xs text-foreground/70"
            >
              <span className={ping.ok ? 'font-bold text-ok' : 'font-bold text-warn'}>
                {ping.status}
              </span>{' '}
              · {ping.ms}ms · {ping.note}
            </motion.span>
          )}
        </motion.div>

        {/* The proof pages, as buttons rather than a run of inline links: Arc is the one the
            season leads with, so it is the primary; the rest are the same shape, outlined. */}
        <motion.div {...reveal} className="mt-5 flex flex-wrap items-center gap-3">
          <Button asChild size="lg">
            <Link to="/arc">
              Arc Mainnet, live <ArrowUpRight size={16} />
            </Link>
          </Button>

          {/* The page a visitor can run, next to the receipts it writes. */}
          <Button asChild variant="outline" className="bg-background">
            <Link to="/stellar?network=testnet">
              The Stellar demo, on testnet <ArrowUpRight size={15} />
            </Link>
          </Button>

          <Button asChild variant="outline" className="bg-background">
            <Link to="/proof/stellar">
              The Stellar rail <ArrowUpRight size={15} />
            </Link>
          </Button>

          <Button asChild variant="outline" className="bg-background">
            <Link to="/proof/algorand">
              The Algorand rail <ArrowUpRight size={15} />
            </Link>
          </Button>

          <Button asChild variant="outline" className="bg-background">
            <a href={PROOF_URL} target="_blank" rel="noopener noreferrer">
              See every X Layer settlement <ArrowUpRight size={15} />
            </a>
          </Button>

          <Button asChild variant="outline" className="bg-background">
            <Link to={CELO_PROOF_URL}>
              See every Celo settlement <ArrowUpRight size={15} />
            </Link>
          </Button>
        </motion.div>

        {/* The claim above, made checkable: every settlement as a row that opens on OKLink. */}
        <motion.div {...reveal} transition={{ ...reveal.transition, delay: 0.1 }} className="mt-8">
          <SettlementTicker />
        </motion.div>
      </div>
    </section>
  )
}

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Search, ArrowRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
import OwlMark from '../OwlMark'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/** One-click examples so a first-time visitor never faces an empty input. */
const EXAMPLES = [
  { label: 'Meridian #849980', q: '849980' },
  { label: 'An OKX.AI wallet', q: '0x03c4b193d2a42cb0624da3ac938c5917d5fc98c7' },
  { label: 'Our listing #6271', q: 'eip155:196:8004/6271' },
]

/* ------------------------------------------------------------------------- */
/* The stage: buyer → owl → seller, played on a loop (the ryvo idea, retold   */
/* as our story). A check chip travels to the oracle, a verdict lands, and    */
/* only an ALLOW lets the payment chip cross to the seller; every third run   */
/* is a DENY and the money stays home. Plain DOM + framer, no canvas.        */
/* ------------------------------------------------------------------------- */

type Phase = 'check' | 'verdict' | 'settle' | 'idle'

/** Node x positions as percentages of the stage width. */
const X = { buyer: '13%', owl: '50%', seller: '87%' }

function StageNode({ x, label, children }: { x: string; label: string; children: ReactNode }) {
  return (
    <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-center" style={{ left: x }}>
      <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-border bg-card shadow-sm">
        {children}
      </div>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-foreground/45">{label}</p>
    </div>
  )
}

function Chip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[10px] font-semibold shadow-sm ${className}`}
    >
      {children}
    </span>
  )
}

function VerifyStage() {
  const still = useReducedMotion()
  const [phase, setPhase] = useState<Phase>('idle')
  const [deny, setDeny] = useState(false)
  const [counts, setCounts] = useState({ checks: 0, allowed: 0, denied: 0 })

  useEffect(() => {
    if (still) return
    let alive = true
    let run = 0
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    ;(async () => {
      while (alive) {
        const isDeny = run % 3 === 2
        setDeny(isDeny)
        setPhase('check')
        await wait(1100)
        if (!alive) break
        setPhase('verdict')
        setCounts((c) => ({
          checks: c.checks + 1,
          allowed: c.allowed + (isDeny ? 0 : 1),
          denied: c.denied + (isDeny ? 1 : 0),
        }))
        await wait(950)
        if (!alive) break
        setPhase('settle')
        await wait(isDeny ? 900 : 1300)
        if (!alive) break
        setPhase('idle')
        await wait(650)
        run += 1
      }
    })()
    return () => {
      alive = false
    }
  }, [still])

  // Reduced motion: the diagram at its most informative moment, at rest.
  const verdictVisible = still || phase === 'verdict' || phase === 'settle'
  const showDeny = still ? false : deny

  return (
    <div>
      <div className="relative h-[380px] overflow-hidden rounded-[20px] border border-border bg-card/50">
        {/* dot grid floor */}
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[radial-gradient(circle,rgba(115,66,226,0.14)_1px,transparent_1px)] [background-size:22px_22px]"
        />

        {/* the rail everything travels on */}
        <div className="absolute left-[13%] right-[13%] top-1/2 border-t border-dashed border-border" />

        <StageNode x={X.buyer} label="Buyer agent">
          <span className="font-mono text-lg text-foreground/70">01</span>
        </StageNode>
        <StageNode x={X.owl} label="A-Identity">
          <motion.div
            animate={phase === 'verdict' && !still ? { scale: [1, 1.14, 1] } : { scale: 1 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <OwlMark size={40} verdict={verdictVisible ? (showDeny ? 'deny' : 'allow') : 'neutral'} />
          </motion.div>
        </StageNode>
        <StageNode x={X.seller} label="Seller agent">
          <span className="font-mono text-lg text-foreground/70">02</span>
        </StageNode>

        {/* the check chip: buyer → owl */}
        <AnimatePresence>
          {!still && phase === 'check' && (
            <motion.div
              key="check"
              className="absolute top-[38%] -translate-x-1/2"
              initial={{ left: X.buyer, opacity: 0 }}
              animate={{ left: X.owl, opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.0, ease: 'easeInOut', opacity: { duration: 0.25 } }}
            >
              <Chip className="text-foreground/70">risk_check</Chip>
            </motion.div>
          )}
        </AnimatePresence>

        {/* the verdict, over the owl */}
        <AnimatePresence>
          {verdictVisible && (
            <motion.div
              key={`verdict-${showDeny}`}
              className="absolute left-1/2 top-[16%] -translate-x-1/2"
              initial={{ opacity: 0, y: 8, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.35, ease: EASE_OUT_EXPO }}
            >
              <Chip
                className={
                  showDeny
                    ? 'border-red-500/40 text-red-600 dark:text-red-400'
                    : 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                }
              >
                {showDeny ? 'DENY' : 'ALLOW'}
              </Chip>
            </motion.div>
          )}
        </AnimatePresence>

        {/* settlement: an ALLOW sends the money across; a DENY keeps it home */}
        <AnimatePresence>
          {!still && phase === 'settle' && !deny && (
            <motion.div
              key="pay"
              className="absolute top-[58%] -translate-x-1/2"
              initial={{ left: X.buyer, opacity: 0 }}
              /* Stops at the seller node's edge so it never sits on the node label. */
              animate={{ left: '78%', opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.15, ease: 'easeInOut', opacity: { duration: 0.25 } }}
            >
              <Chip className="border-accent/40 text-accent">+$0.005 USDC</Chip>
            </motion.div>
          )}
          {!still && phase === 'settle' && deny && (
            <motion.div
              key="blocked"
              className="absolute left-[31%] top-[58%] -translate-x-1/2"
              initial={{ opacity: 0, x: -14 }}
              animate={{ opacity: 1, x: [0, -5, 4, -2, 0] }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.55 }}
            >
              <Chip className="border-red-500/40 text-red-600 dark:text-red-400">✕ not funded</Chip>
            </motion.div>
          )}
        </AnimatePresence>

        {/* counters, the ryvo corner */}
        <div className="absolute bottom-4 right-4 flex gap-2">
          {(
            [
              ['Checks', counts.checks, 'text-foreground'],
              ['Allowed', counts.allowed, 'text-emerald-600 dark:text-emerald-400'],
              ['Denied', counts.denied, 'text-red-600 dark:text-red-400'],
            ] as const
          ).map(([label, value, tone]) => (
            <div
              key={label}
              className="min-w-[74px] rounded-lg border border-border bg-card/80 px-3 py-2 backdrop-blur-sm"
            >
              <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-foreground/40">{label}</p>
              <p className={`font-mono text-base font-bold ${tone}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>
      <p className="mt-3 text-xs text-foreground/40">
        The loop is illustrative; the verdict engine behind it is live in the explorer.
      </p>
    </div>
  )
}

/**
 * The live hook: one input that resolves any agent's trust from the chain. Deliberately
 * the first thing after the hero, so the product proves itself before any copy. Submitting
 * (or a chip) opens the step-by-step pipeline in the explorer. On the right, the loop the
 * product enforces, played as a quiet diagram: check, verdict, and money that only moves
 * on an ALLOW. The owl stays, as the checkpoint rather than a poster.
 */
export default function VerifyCta() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const go = (term: string) => { const t = term.trim(); if (t) navigate(`/explorer?q=${encodeURIComponent(t)}`) }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); go(q) }

  return (
    <section id="verify" className="w-full bg-background px-5 py-16 text-foreground sm:px-8 sm:py-20">
      {/* Two columns from lg up: the lookup keeps the reading edge, the stage takes the
          right half. Below lg the stage drops out entirely rather than stacking, because
          on a phone the input is the only thing that matters. */}
      <div className="mx-auto grid max-w-[1160px] items-center gap-10 lg:grid-cols-[minmax(0,1fr)_500px] lg:gap-14">
        <div>
        <motion.h2 {...reveal} className="text-3xl font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]" style={{ fontFamily: 'var(--font-heading)' }}>
          Trust an agent in one lookup.
        </motion.h2>
        <motion.p {...reveal} className="mt-4 max-w-xl text-lg leading-relaxed text-foreground/55">
          Paste a wallet address or token id. We read the chain, not a database, and answer
          in a second.
        </motion.p>

        <motion.form {...reveal} onSubmit={onSubmit} className="mt-9 flex max-w-xl gap-2">
          <div className="relative flex-1">
            <Search size={17} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-foreground/40" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Agent wallet address or token id"
              placeholder="0x wallet address or token id"
              className="h-13 w-full rounded-xl border border-border bg-card py-3.5 pl-11 pr-4 font-mono text-sm text-foreground outline-none transition placeholder:font-sans placeholder:text-foreground/40 focus:border-accent/60"
            />
          </div>
          <button type="submit" className="inline-flex items-center gap-2 rounded-xl bg-accent px-6 text-sm font-semibold text-white transition hover:opacity-90">
            Verify <ArrowRight size={15} />
          </button>
        </motion.form>

        <motion.div {...reveal} className="mt-4 flex flex-wrap items-center gap-2 text-sm text-foreground/45">
          <span>Try</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.q} type="button" onClick={() => go(ex.q)}
              className="rounded-full border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground/65 transition hover:border-accent/50 hover:text-foreground">
              {ex.label}
            </button>
          ))}
        </motion.div>

        {/* What comes back, compressed to one quiet line: the stage on the right
            already acts the verdict out, so prose here would say it twice. */}
        <motion.p
          {...reveal}
          className="mt-8 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-foreground/40"
        >
          <span>identity</span>
          <span aria-hidden="true">·</span>
          <span>wallet proof</span>
          <span aria-hidden="true">·</span>
          <span>reputation 0-1000</span>
          <span aria-hidden="true">·</span>
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">allow</span>
          <span className="font-semibold text-amber-600 dark:text-amber-500">warn</span>
          <span className="font-semibold text-red-600 dark:text-red-400">deny</span>
        </motion.p>
        </div>

        <motion.div {...reveal} className="hidden lg:block" aria-hidden="true">
          <VerifyStage />
        </motion.div>
      </div>
    </section>
  )
}

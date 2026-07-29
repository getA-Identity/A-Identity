import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bot, Check, Landmark, ShieldCheck, User } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DOCS_URL } from '../../lib/brand'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'

/**
 * The two things the product does, running.
 *
 * This replaces the old Web2.5 section, which was removed on purpose: it had the right idea
 * and the wrong execution. Three coins on bezier arcs and a lane of chips scrolling past a
 * gate read as decoration, because nothing in the motion corresponded to anything the system
 * actually does. Motion that does not carry information is noise, and on a trust product it
 * is worse than noise, it undercuts the claim.
 *
 * So the animation here is the state machine. One agent is checked, gets a verdict, and only
 * then does value move. The timeline is a single loop and every beat is a real step: request,
 * check, verdict, settle. The denial is included on purpose. A demo where the answer is
 * always yes is a demo that has not shown you the product.
 *
 * Under `prefers-reduced-motion` the whole thing renders in its settled state rather than
 * being hidden, so the information survives even when the movement does not.
 */

const LOOP = 9

/** The verdict the run lands on. Two of three pass, which is roughly honest. */
type Verdict = 'ALLOW' | 'DENY'

const RUNS: { id: string; from: string; to: string; amount: string; verdict: Verdict; reason: string; settle?: 'direct' | 'bridge' }[] = [
  { id: 'a', from: 'Research agent', to: 'Data API', amount: '$0.004', verdict: 'ALLOW', reason: 'KYA attested, reputation 720', settle: 'direct' },
  { id: 'b', from: 'Unknown agent', to: 'Your agent', amount: '$240.00', verdict: 'DENY', reason: 'No on-chain identity' },
  { id: 'c', from: 'Your agent', to: 'Compute vendor', amount: '$1.20', verdict: 'ALLOW', reason: 'Inside the daily cap', settle: 'bridge' },
]

const VERDICT_COLOR: Record<Verdict, string> = { ALLOW: '#059669', DENY: '#dc2626' }

/**
 * The gate itself. A request enters from the left, is held while it is checked, and either
 * continues or stops dead. The stop is the point: a denied request does not fade out, it
 * hits something.
 */
function Gate({ run, index, reduced }: { run: (typeof RUNS)[number]; index: number; reduced: boolean }) {
  const start = index * (LOOP / RUNS.length)
  const allow = run.verdict === 'ALLOW'
  const bridge = run.settle === 'bridge'
  const color = VERDICT_COLOR[run.verdict]

  // Lane geometry. Verification happens at the midpoint; settlement happens at the dock on
  // the right edge, and a denied request never sees the right half of the lane at all. The
  // space itself is the claim: money only exists past the check.
  const ARRIVE = '30%'
  const DOCK = '66%'

  return (
    <div className="relative h-[84px] overflow-hidden rounded-2xl border border-border bg-background/60">
      {/* The track the request runs along. */}
      <div className="absolute left-6 right-6 top-[58%] h-px bg-border" />

      {/* The checkpoint. */}
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border" />
      <div className="absolute left-1/2 top-[58%] grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-card">
        <ShieldCheck size={15} className="text-foreground/45" />
        <motion.span
          className="pointer-events-none absolute inset-[-3px] rounded-full border-2"
          style={{ borderColor: color }}
          initial={{ opacity: 0 }}
          animate={reduced ? { opacity: 0.55 } : { opacity: [0, 0.55, 0.55, 0] }}
          transition={
            reduced
              ? { duration: 0 }
              : { duration: LOOP, times: [0.26, 0.36, 0.62, 0.68], repeat: Infinity, delay: start }
          }
        />
      </div>

      {/* The Gateway/CCTP arch. Only the cross-chain lane has one, and it lights exactly as
          the settled payment passes under it. */}
      {bridge && (
        <div className="pointer-events-none absolute left-[72%] top-[58%] h-8 w-12 -translate-x-1/2 -translate-y-[92%]">
          <div className="h-full w-full rounded-t-full border-2 border-b-0 border-border" />
          <motion.div
            className="absolute inset-0 rounded-t-full border-2 border-b-0"
            style={{ borderColor: '#7342e2' }}
            initial={{ opacity: 0 }}
            animate={reduced ? { opacity: 0.35 } : { opacity: [0, 0, 0.9, 0] }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: LOOP, times: [0, 0.46, 0.54, 0.64], repeat: Infinity, delay: start }
            }
          />
        </div>
      )}

      {/* The dock, where settled money lands. Every lane has one; on the denied lane it
          stays dark forever, which is the story told without a word. */}
      <div className="absolute left-[88%] top-[58%] grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-card">
        <Landmark size={12} className="text-foreground/35" />
        {allow && (
          <motion.span
            className="pointer-events-none absolute inset-[-3px] rounded-full border-2"
            style={{ borderColor: '#059669' }}
            initial={{ opacity: 0 }}
            animate={reduced ? { opacity: 0.5 } : { opacity: [0, 0, 0.6, 0.6, 0] }}
            transition={
              reduced
                ? { duration: 0 }
                : { duration: LOOP, times: [0, 0.54, 0.6, 0.86, 0.94], repeat: Infinity, delay: start }
            }
          />
        )}
      </div>

      {/* The request in flight. An allowed one ends at the dock instead of sliding off the
          edge, because "left the frame" and "settled" are different claims. */}
      <motion.div
        className="absolute top-[58%] -translate-y-1/2"
        initial={{ left: '-22%', opacity: 0 }}
        animate={
          reduced
            ? allow
              ? { left: DOCK, opacity: 0 }
              : { left: ARRIVE, opacity: 1 }
            : {
                left: ['-22%', ARRIVE, ARRIVE, allow ? DOCK : ARRIVE, allow ? DOCK : ARRIVE],
                opacity: [0, 1, 1, 1, 0],
              }
        }
        transition={
          reduced
            ? { duration: 0 }
            : {
                duration: LOOP,
                times: [0, 0.2, 0.36, 0.52, allow ? 0.58 : 0.68],
                repeat: Infinity,
                delay: start,
                ease: 'easeInOut',
              }
        }
      >
        <span
          className="flex items-center gap-2 whitespace-nowrap rounded-full border bg-card px-3 py-1.5 font-mono text-xs font-semibold shadow-sm"
          style={{ borderColor: `${color}55`, color }}
        >
          {run.amount}
        </span>
      </motion.div>

      {/* The settled chip: the same amount, now as money that arrived. */}
      {allow && (
        <motion.div
          className="absolute top-[58%] -translate-y-1/2"
          style={{ left: DOCK }}
          initial={{ opacity: 0, scale: 0.85 }}
          animate={reduced ? { opacity: 1, scale: 1 } : { opacity: [0, 0, 1, 1, 0], scale: [0.85, 0.85, 1, 1, 1] }}
          transition={
            reduced
              ? { duration: 0 }
              : { duration: LOOP, times: [0, 0.56, 0.62, 0.88, 0.96], repeat: Infinity, delay: start }
          }
        >
          <span
            className="flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 font-mono text-[11px] font-bold text-white shadow-sm"
            style={{ background: '#059669' }}
          >
            <Check size={11} /> {run.amount}
          </span>
        </motion.div>
      )}

      {/* The verdict, stamped above the checkpoint once the check resolves. */}
      <motion.span
        className="absolute left-1/2 top-2.5 -translate-x-1/2 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.1em]"
        style={{ color, background: `${color}1a` }}
        initial={{ opacity: 0, y: 4 }}
        animate={
          reduced
            ? { opacity: 1, y: 0 }
            : { opacity: [0, 0, 1, 1, 0], y: [4, 4, 0, 0, 0] }
        }
        transition={
          reduced
            ? { duration: 0 }
            : { duration: LOOP, times: [0, 0.32, 0.38, 0.62, 0.68], repeat: Infinity, delay: start }
        }
      >
        {run.verdict}
      </motion.span>

      {/* What this lane settles in. Static, because it describes the lane, not the moment. */}
      <span className="absolute bottom-1.5 right-3 font-mono text-[9px] uppercase tracking-wider text-foreground/30">
        {allow ? (bridge ? 'USDC · cross-chain' : 'USDC · Arc') : 'never funded'}
      </span>
    </div>
  )
}

function RunRow({ run, index, reduced }: { run: (typeof RUNS)[number]; index: number; reduced: boolean }) {
  return (
    <motion.div {...revealAt(index)} className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)] sm:items-center">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">
          {run.from === 'Your agent' ? <User size={13} className="shrink-0 text-foreground/40" /> : <Bot size={13} className="shrink-0 text-foreground/40" />}
          {run.from}
          <ArrowRight size={12} className="shrink-0 text-foreground/25" />
          <span className="truncate font-normal text-foreground/55">{run.to}</span>
        </p>
        <p className="mt-1 truncate text-xs text-foreground/40">{run.reason}</p>
      </div>
      <Gate run={run} index={index} reduced={reduced} />
    </motion.div>
  )
}

export default function VerifyPayFlow() {
  const reduced = useReducedMotion() ?? false

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

      <motion.div
        {...reveal}
        transition={{ ...reveal.transition, delay: 0.16 }}
        className="mt-14 rounded-3xl border border-border bg-background/40 p-6 sm:p-10"
      >
        <div className="flex flex-col gap-7">
          {RUNS.map((run, i) => (
            <RunRow key={run.id} run={run} index={i} reduced={reduced} />
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-border pt-6 text-sm">
          <span className="flex items-center gap-2 text-foreground/55">
            <span className="h-2 w-2 rounded-full" style={{ background: VERDICT_COLOR.ALLOW }} />
            Settles in USDC on Arc
          </span>
          <span className="flex items-center gap-2 text-foreground/55">
            <span className="h-2 w-2 rounded-full" style={{ background: VERDICT_COLOR.DENY }} />
            Refused before it moves
          </span>
          <span className="flex items-center gap-2 text-foreground/55">
            <span className="h-2 w-2 rounded-full" style={{ background: '#7342e2' }} />
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

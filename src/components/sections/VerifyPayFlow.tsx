import { motion, useReducedMotion } from 'framer-motion'
import { ArrowRight, Bot, ShieldCheck, User } from 'lucide-react'
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

const RUNS: { id: string; from: string; to: string; amount: string; verdict: Verdict; reason: string }[] = [
  { id: 'a', from: 'Research agent', to: 'Data API', amount: '$0.004', verdict: 'ALLOW', reason: 'KYA attested, reputation 720' },
  { id: 'b', from: 'Unknown agent', to: 'Your agent', amount: '$240.00', verdict: 'DENY', reason: 'No on-chain identity' },
  { id: 'c', from: 'Your agent', to: 'Compute vendor', amount: '$1.20', verdict: 'ALLOW', reason: 'Inside the daily cap' },
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
  const color = VERDICT_COLOR[run.verdict]

  // Geometry, and the reason for each number. The checkpoint sits at the midpoint. The
  // request stops short of it rather than on top of it, because a request that overlaps the
  // gate reads as already through. The verdict is stamped above the gate, and the lane is
  // tall enough that the stamp and the request never occupy the same band.
  const ARRIVE = '30%'
  const PASS = '104%'

  return (
    <div className="relative h-[84px] overflow-hidden rounded-2xl border border-border bg-background/60">
      {/* The track the request runs along. */}
      <div className="absolute left-6 right-6 top-[58%] h-px bg-border" />

      {/* The checkpoint. */}
      <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-border" />
      <div className="absolute left-1/2 top-[58%] grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-card">
        <ShieldCheck size={15} className="text-foreground/45" />
        {/* The verdict ring is a separate element whose opacity animates, rather than an
            animated borderColor. A hardcoded resting colour would have to be one of light or
            dark and would be invisible in the other; this leaves `border-border` to the token
            system and only adds colour while the check is resolving. */}
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

      {/* The request. */}
      <motion.div
        className="absolute top-[58%] -translate-y-1/2"
        // No `initial={false}` here: paired with a keyframe array it makes framer skip the
        // animation and pin the element to the LAST frame, which is opacity 0. The lane
        // rendered permanently empty for exactly that reason.
        initial={{ left: '-22%', opacity: 0 }}
        animate={
          reduced
            ? { left: allow ? PASS : ARRIVE, opacity: 1 }
            : {
                left: ['-22%', ARRIVE, ARRIVE, allow ? PASS : ARRIVE, allow ? PASS : ARRIVE],
                opacity: [0, 1, 1, 1, 0],
              }
        }
        transition={
          reduced
            ? { duration: 0 }
            : {
                duration: LOOP,
                times: [0, 0.2, 0.36, 0.56, 0.68],
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

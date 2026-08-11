import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { Search, ArrowRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { SectionBackdrop } from '../ui/section-backdrop'

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
/* The stage: the oracle as a terminal (the base.org agents stance). A pixel- */
/* block owl banner, then verification transcripts typed line by line: two   */
/* ALLOW runs for every DENY, counters ticking in the status row. It paints  */
/* from the shared terminal tokens (index.css), so the tty follows the theme */
/* instead of punching a dark hole in a light page: the window chrome and    */
/* the mono type carry the terminal, not the ground.                         */
/* ------------------------------------------------------------------------- */

/** The owl as pixel blocks, 17 columns. '#' is a lit cell. */
const OWL_ROWS = [
  '..##...........##',
  '#################',
  '.#####.....#####.',
  '.#...#..#..#...#.',
  '.#.#.#.###.#.#.#.',
  '.#...#..#..#...#.',
  '.#####.....#####.',
  '...##.......##...',
]

type LogLine = {
  /** The bracketed tag, or a bare prompt line when body is absent. */
  tag: string
  body?: string
  /** Right-aligned outcome after a dotted leader. */
  tail?: string
  tone?: 'ok' | 'bad' | 'accent'
}

const RUN_ALLOW: LogLine[] = [
  { tag: '$ risk_check 0x03c4…98c7' },
  { tag: '[resolve]', body: 'ERC-8004 identity #849980', tail: 'ok', tone: 'ok' },
  { tag: '[kya]', body: 'wallet-proof attestation', tail: 'ok', tone: 'ok' },
  { tag: '[score]', body: 'reputation 539 / 1000' },
  { tag: '[verdict]', body: 'ALLOW', tone: 'ok' },
  { tag: '[pay]', body: '+$0.005 USDC on Arc', tail: 'settled', tone: 'accent' },
]

const RUN_DENY: LogLine[] = [
  { tag: '$ risk_check 0x8f21…c4d9' },
  { tag: '[resolve]', body: 'ERC-8004 identity', tail: 'none', tone: 'bad' },
  { tag: '[sybil]', body: 'operator cluster', tail: 'flagged', tone: 'bad' },
  { tag: '[verdict]', body: 'DENY', tone: 'bad' },
  { tag: '[pay]', body: 'not funded', tone: 'bad' },
]

const TAG_COLOR = 'text-term-prompt'
const TONE: Record<NonNullable<LogLine['tone']>, string> = {
  ok: 'text-term-ok',
  bad: 'text-term-bad',
  accent: 'text-term-prompt',
}

function TerminalLine({ line, active }: { line: LogLine; active: boolean }) {
  const bare = line.body === undefined
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18 }}
      className="flex items-baseline gap-2 whitespace-nowrap"
    >
      <span className={bare ? 'text-term-fg' : TAG_COLOR}>{line.tag}</span>
      {line.body && (
        <span className={line.tone && !line.tail ? `font-semibold ${TONE[line.tone]}` : 'text-term-dim'}>
          {line.body}
        </span>
      )}
      {line.tail && (
        <>
          <span className="mx-1 flex-1 border-b border-dotted border-term-dot" aria-hidden="true" />
          <span className={`font-semibold ${TONE[line.tone ?? 'ok']}`}>{line.tail}</span>
        </>
      )}
      {active && <span className="ml-0.5 inline-block h-3.5 w-2 animate-pulse bg-term-caret" />}
    </motion.div>
  )
}

function VerifyStage() {
  const still = useReducedMotion()
  const [runIdx, setRunIdx] = useState(0)
  const [visible, setVisible] = useState(0)
  const [counts, setCounts] = useState({ checks: 0, allowed: 0, denied: 0 })

  const deny = !still && runIdx % 3 === 2
  const lines = still ? RUN_ALLOW : deny ? RUN_DENY : RUN_ALLOW

  useEffect(() => {
    if (still) return
    let alive = true
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    ;(async () => {
      let run = 0
      while (alive) {
        const isDeny = run % 3 === 2
        const script = isDeny ? RUN_DENY : RUN_ALLOW
        setRunIdx(run)
        setVisible(0)
        await wait(500)
        for (let i = 1; i <= script.length && alive; i++) {
          setVisible(i)
          if (script[i - 1].tag === '[verdict]') {
            setCounts((c) => ({
              checks: c.checks + 1,
              allowed: c.allowed + (isDeny ? 0 : 1),
              denied: c.denied + (isDeny ? 1 : 0),
            }))
          }
          await wait(i === 1 ? 620 : 430)
        }
        await wait(2100)
        run += 1
      }
    })()
    return () => {
      alive = false
    }
  }, [still])

  const shown = still ? RUN_ALLOW.length : visible

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-accent/25 bg-term shadow-[0_0_0_1px_var(--term-ring),0_24px_70px_-24px_var(--term-glow)]">
        {/* window chrome */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-chrome px-4 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-term-dot" />
            <span className="h-2.5 w-2.5 rounded-full border border-term-dot" />
            <span className="h-2.5 w-2.5 rounded-full border border-term-dot" />
          </div>
          <span className="font-mono text-[10px] tracking-[0.14em] text-term-faint">tty · arc</span>
        </div>

        <div className="p-6 sm:p-7">
          {/* the owl, as terminal pixels */}
          <div aria-hidden="true" className="flex flex-col gap-[3px]">
            {OWL_ROWS.map((row, r) => (
              <div key={r} className="flex gap-[3px]">
                {row.split('').map((c, i) => (
                  <span
                    key={i}
                    className={`h-[9px] w-[9px] ${c === '#' ? 'bg-term-pixel' : 'bg-transparent'}`}
                  />
                ))}
              </div>
            ))}
          </div>

          <p className={`mt-4 font-mono text-[13px] font-semibold tracking-[0.06em] ${TAG_COLOR}`}>
            == A-IDENTITY TRUST ORACLE ==
          </p>
          <div className="mt-2 border-t border-dashed border-term-border" />

          {/* the transcript; fixed height so the loop never reflows the page */}
          <div className="mt-3 flex h-[150px] flex-col font-mono text-[12.5px] leading-[25px]">
            {lines.slice(0, shown).map((line, i) => (
              <TerminalLine key={`${runIdx}-${i}`} line={line} active={!still && i === shown - 1} />
            ))}
          </div>

          {/* status row */}
          <div className="mt-2 flex gap-4 border-t border-term-border pt-3 font-mono text-[11px] text-term-faint">
            <span>
              checks <span className="text-term-dim">{counts.checks}</span>
            </span>
            <span>
              allowed <span className="text-term-ok">{counts.allowed}</span>
            </span>
            <span>
              denied <span className="text-term-bad">{counts.denied}</span>
            </span>
            <span className="ml-auto hidden sm:inline">live engine · /explorer</span>
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-foreground/40">
        The transcript is illustrative; the verdict engine behind it is live in the explorer.
      </p>
    </div>
  )
}

/**
 * The live hook: one input that resolves any agent's trust from the chain. Deliberately
 * the first thing after the hero, so the product proves itself before any copy. Submitting
 * (or a chip) opens the step-by-step pipeline in the explorer. On the right, the oracle
 * played as a terminal: verification transcripts typed line by line, money that only
 * settles after an ALLOW.
 */
export default function VerifyCta() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const go = (term: string) => { const t = term.trim(); if (t) navigate(`/explorer?q=${encodeURIComponent(t)}`) }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); go(q) }

  return (
    <section id="verify" className="relative w-full overflow-hidden bg-background px-5 py-16 text-foreground sm:px-8 sm:py-20">
      <SectionBackdrop name="lookup" position="left" />
      {/* Two columns from lg up: the lookup keeps the reading edge, the terminal takes the
          right half. Below lg the terminal drops out entirely rather than stacking, because
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

        </div>

        <motion.div {...reveal} className="hidden lg:block" aria-hidden="true">
          <VerifyStage />
        </motion.div>
      </div>
    </section>
  )
}

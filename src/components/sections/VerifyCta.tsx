import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, Fingerprint, BadgeCheck, Gauge, Scale, ArrowRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/** One-click examples so a first-time visitor never faces an empty input. */
const EXAMPLES = [
  { label: 'Meridian · #849980', q: '849980', hint: 'a verified Arc agent' },
  { label: 'An OKX.AI agent wallet', q: '0x03c4b193d2a42cb0624da3ac938c5917d5fc98c7', hint: 'resolved from the OKX.AI registry' },
  { label: 'Our OKX.AI listing · #6271', q: 'eip155:196:8004/6271', hint: 'CAIP id on X Layer' },
]

const STEPS = [
  { Icon: Fingerprint, title: 'Resolve', tag: 'ERC-8004', desc: 'live on-chain identity read' },
  { Icon: BadgeCheck, title: 'Know Your Agent', tag: 'KYA', desc: 'wallet control attested' },
  { Icon: Gauge, title: 'Score', tag: '0-1000', desc: 'deterministic reputation' },
  { Icon: Scale, title: 'Decide', tag: 'verdict', desc: 'ALLOW / WARN / DENY' },
]

/**
 * "Verify an agent now" — the guided, zero-friction entry into the verification
 * pipeline. One input, one button, one-click examples; submitting lands on
 * /explorer?q=… where the step-by-step pipeline plays out on live data.
 */
export default function VerifyCta() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  const go = (term: string) => {
    const t = term.trim()
    if (t) navigate(`/explorer?q=${encodeURIComponent(t)}`)
  }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); go(q) }

  return (
    <section id="verify" className="w-full bg-background px-5 py-20 text-foreground sm:px-8 sm:py-24">
      <div className="mx-auto max-w-[1100px]">
        <motion.h2
          {...reveal}
          className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Verify an agent right now.
        </motion.h2>
        <motion.p {...reveal} className="mt-3 max-w-2xl text-lg leading-relaxed text-foreground/65">
          Paste any agent&apos;s wallet address or token id. We read the chain, not a database:
          Arc and the OKX.AI registry on X Layer. No login.
        </motion.p>

        {/* the one action */}
        <motion.form {...reveal} onSubmit={onSubmit} className="mt-8 flex max-w-2xl gap-2">
          <div className="relative flex-1">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground/40" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Agent wallet address or token id"
              placeholder="0x wallet address or token id"
              className="h-12 w-full rounded-xl border border-border bg-card pl-10 pr-4 font-mono text-sm text-foreground outline-none transition placeholder:font-sans placeholder:text-foreground/40 focus:border-accent/60"
            />
          </div>
          <button
            type="submit"
            className="inline-flex h-12 items-center gap-2 rounded-xl bg-accent px-6 text-sm font-semibold text-white transition hover:opacity-90"
          >
            Verify <ArrowRight size={15} />
          </button>
        </motion.form>

        {/* one-click examples: never an empty-input dead end */}
        <motion.div {...reveal} className="mt-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-foreground/45">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex.q}
              type="button"
              onClick={() => go(ex.q)}
              title={ex.hint}
              className="rounded-full border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground/70 transition hover:border-accent/50 hover:text-foreground"
            >
              {ex.label}
            </button>
          ))}
        </motion.div>

        {/* what will happen: the 4 pipeline stages, so the user knows before clicking */}
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((s, i) => (
            <motion.div {...reveal} key={s.title} className="rounded-2xl border border-sand bg-card p-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><s.Icon size={15} /></span>
                <span className="font-mono text-[10px] uppercase tracking-wide text-foreground/45">step {i + 1} · {s.tag}</span>
              </div>
              <div className="mt-3 text-sm font-semibold text-foreground">{s.title}</div>
              <p className="mt-1 text-sm text-foreground/60">{s.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

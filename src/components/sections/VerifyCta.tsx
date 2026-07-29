import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Search, ArrowRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { OwlMascot3D } from '../OwlMascot'

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

/**
 * The live hook: one input that resolves any agent's trust from the chain. Deliberately
 * the first thing after the hero, so the product proves itself before any copy. Submitting
 * (or a chip) opens the step-by-step pipeline in the explorer.
 */
export default function VerifyCta() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const go = (term: string) => { const t = term.trim(); if (t) navigate(`/explorer?q=${encodeURIComponent(t)}`) }
  const onSubmit = (e: FormEvent) => { e.preventDefault(); go(q) }

  return (
    <section id="verify" className="w-full bg-background px-5 py-24 text-foreground sm:px-8 sm:py-32">
      {/* Two columns from lg up: the lookup keeps the reading edge, the owl takes the empty
          right half it was already leaving behind. Below lg the owl drops out entirely
          rather than stacking, because on a phone the input is the only thing that matters. */}
      <div className="mx-auto grid max-w-[1080px] items-center gap-12 lg:grid-cols-[minmax(0,1fr)_320px]">
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

        <motion.p {...reveal} className="mt-7 max-w-xl text-sm leading-relaxed text-foreground/45">
          You get its on-chain identity, whether wallet control is proven, a reputation score
          from 0 to 1000, and a plain verdict:{' '}
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">allow</span>,{' '}
          <span className="font-semibold text-amber-600 dark:text-amber-500">warn</span>, or{' '}
          <span className="font-semibold text-red-600 dark:text-red-400">deny</span>.
        </motion.p>
        </div>

        <motion.div {...reveal} className="order-first justify-self-center lg:order-none" aria-hidden="true">
          <OwlMascot3D className="h-[180px] w-[180px] sm:h-[240px] sm:w-[240px] lg:h-[320px] lg:w-[320px]" />
        </motion.div>
      </div>
    </section>
  )
}

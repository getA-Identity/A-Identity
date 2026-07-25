import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const PROOF_URL = 'https://a-identity-asp.onrender.com/proof'

const STATS = [
  { k: '120', v: 'real settlements', sub: 'USD₮0 on X Layer' },
  { k: '#6271', v: 'live agent', sub: 'listed on OKX.AI' },
  { k: '163', v: 'tests, green', sub: 'deterministic scores' },
]

/**
 * Proof, not promises. The hackathon-grade "it is real and already earning" beat, kept
 * lean: a claim, a subtitle, three verifiable numbers, and one link out to the on-chain
 * proof. The tool-by-tool detail lives in the docs, not here.
 */
export default function LiveProof() {
  return (
    <section id="okx-asp" className="w-full bg-card px-5 py-24 text-foreground sm:px-8 sm:py-32">
      <div className="mx-auto max-w-[1080px]">
        <motion.h2 {...reveal} className="text-3xl font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]" style={{ fontFamily: 'var(--font-heading)' }}>
          Not a demo. Live and earning.
        </motion.h2>
        <motion.p {...reveal} className="mt-4 max-w-xl text-lg leading-relaxed text-foreground/55">
          A-Identity runs as a trust oracle on OKX.AI, selling per-call checks that settle in
          real stablecoins on X Layer mainnet. Every number here is on-chain.
        </motion.p>

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
          {STATS.map((s) => (
            <div key={s.v} className="bg-card p-7">
              <div className="font-mono text-4xl font-bold tracking-tight text-foreground">{s.k}</div>
              <div className="mt-2 text-[15px] font-medium text-foreground/70">{s.v}</div>
              <div className="mt-1 text-sm text-foreground/45">{s.sub}</div>
            </div>
          ))}
        </div>

        <motion.a
          {...reveal}
          href={PROOF_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline"
        >
          See every settlement on-chain <ArrowUpRight size={15} />
        </motion.a>
      </div>
    </section>
  )
}

import { motion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const ITEMS = [
  {
    term: 'A verifiable identity',
    body: 'An ERC-8004 passport and a Know Your Agent check, so anyone can confirm who an agent is before trusting it with money or work.',
  },
  {
    term: 'A wallet with limits',
    body: 'Spend caps, payee allowlists and a freeze switch, enforced on-chain. An agent can pay on its own, but never past the line you draw.',
  },
  {
    term: 'Verify-first payments',
    body: 'Before any transfer, a live check on the counterparty returns allow, warn, or deny. Unknown or flagged agents get denied, not funded.',
  },
]

/**
 * What A-Identity gives an agent. Editorial three-item list (no cards, no badges, no
 * numbering): the term reads as the headline, the body as the subtitle, hairline-separated.
 */
export default function WhatYouGet() {
  return (
    <section className="w-full bg-card px-5 py-24 text-foreground sm:px-8 sm:py-32">
      <div className="mx-auto max-w-[1080px]">
        <motion.h2 {...reveal} className="text-3xl font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]" style={{ fontFamily: 'var(--font-heading)' }}>
          What every agent gets.
        </motion.h2>
        <motion.p {...reveal} className="mt-4 max-w-xl text-lg leading-relaxed text-foreground/55">
          Two things an agent does not have today, and the one rule that ties them together.
        </motion.p>

        <div className="mt-14 flex flex-col">
          {ITEMS.map((it, i) => (
            <motion.div
              key={it.term}
              {...reveal}
              transition={{ ...reveal.transition, delay: i * 0.08 }}
              className="grid grid-cols-1 gap-3 border-t border-border py-8 sm:grid-cols-[minmax(0,340px)_1fr] sm:gap-10"
            >
              <h3 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{it.term}</h3>
              <p className="max-w-lg text-[15px] leading-relaxed text-foreground/55 sm:pt-1">{it.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

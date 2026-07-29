import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import { DOCS_URL, EASE_OUT_EXPO } from '../lib/brand'
import ThemeScope from '../components/ThemeScope'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const BELIEFS = [
  {
    title: 'Agents are economic actors now.',
    body: 'Over a hundred million agents already buy data, call tools, and trigger payments. They act faster than any human can click. What they lack is a way to prove who they are and settle value without a person in the middle of every step.',
  },
  {
    title: 'Identity comes before money.',
    body: 'You would not wire funds to a stranger with no name. Agents should not either. A verifiable on-chain identity (ERC-8004) and a portable reputation come first. Payment is what happens after trust is established, not before.',
  },
  {
    title: 'Open rails beat walled gardens.',
    body: 'Card networks and closed wallets are building agent products that route through their own toll booths. We bet on open standards: ERC-8004 for identity, x402 for payment, MCP for connection. Interoperable, inspectable, owned by no one.',
  },
  {
    title: 'A human stays in the tower.',
    body: 'Autonomy is not abdication. Agents act inside the limits and policies you set. Anything that holds a key, deploys a contract, or moves real value waits for a human to approve it. Human-on-the-loop, by design, not as an afterthought.',
  },
]

const PRINCIPLES = [
  'Verify first, then pay.',
  'Real stablecoins, real settlement.',
  'Reputation you can carry across chains.',
  'No autonomous custody of keys or funds.',
  'Every surface is readable by an agent.',
]

export default function Manifesto() {
  return (
    <ThemeScope surface="background" className="w-full" style={{ fontFamily: 'var(--font-body)' }}>
      <PageHeader />

      <main className="mx-auto w-full max-w-[820px] px-5 py-16 sm:px-8 sm:py-24">
        <motion.span {...reveal} className="text-sm font-semibold tracking-wide text-accent">
          Manifesto
        </motion.span>
        <motion.h1
          {...reveal}
          className="mt-4 text-4xl font-bold leading-[1.1] tracking-tight text-foreground sm:text-5xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          The agentic economy needs a passport.
        </motion.h1>
        <motion.p {...reveal} className="mt-6 text-lg leading-relaxed text-foreground/65">
          Software is starting to transact on its own. That is not a someday story, it is a
          this-year one. We are building the layer that lets agents prove they are real and pay
          each other safely, with humans supervising the parts that matter.
        </motion.p>

        <div className="mt-14 flex flex-col gap-10">
          {BELIEFS.map((b, i) => (
            <motion.section {...reveal} key={b.title} className="border-l-2 border-accent/25 pl-6">
              <div className="text-xs font-semibold tracking-wide text-accent/70">
                {String(i + 1).padStart(2, '0')}
              </div>
              <h2 className="mt-2 text-xl font-bold tracking-tight text-foreground sm:text-2xl">
                {b.title}
              </h2>
              <p className="mt-3 leading-relaxed text-foreground/65">{b.body}</p>
            </motion.section>
          ))}
        </div>

        {/* Principles */}
        <motion.div
          {...reveal}
          className="mt-16 rounded-3xl border border-border bg-card p-8 sm:p-10"
        >
          <h2 className="text-lg font-bold tracking-tight text-foreground">What we hold to</h2>
          <ul className="mt-5 flex flex-col gap-3">
            {PRINCIPLES.map((p) => (
              <li key={p} className="flex items-start gap-3 text-foreground/75">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                <span className="leading-relaxed">{p}</span>
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Closing CTA */}
        <motion.div {...reveal} className="mt-14 flex flex-wrap items-center gap-4">
          <Link
            to="/signup"
            className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
          >
            Claim an Agent ID
          </Link>
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground/70 transition-colors hover:text-foreground"
          >
            Read the docs <ArrowUpRight size={15} />
          </a>
        </motion.div>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}

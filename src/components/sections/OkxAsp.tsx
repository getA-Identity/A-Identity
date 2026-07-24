import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

const PROOF_URL = 'https://a-identity-asp.onrender.com/proof'

const TOOLS = [
  { name: 'trust_preview', price: 'free', desc: 'coarse trust band + flags' },
  { name: 'verify_agent', price: '$0.001', desc: 'ERC-8004 identity + KYA + liveness' },
  { name: 'reputation_score', price: '$0.002', desc: 'on-chain 0–1000 reputation' },
  { name: 'risk_check', price: '$0.005', desc: 'pre-tx ALLOW / WARN / DENY' },
  { name: 'counterparty_check', price: '$0.008', desc: 'two-agent deal verdict + self-deal' },
  { name: 'agent_passport', price: '$0.01', desc: 'full trust passport' },
]

const STATS = [
  ['120', 'real on-chain settlements'],
  ['x402', 'on X Layer mainnet'],
  ['ERC-8004', 'identity + KYA'],
]

/**
 * "Live on OKX.AI" section — the shipped, revenue-generating realization of the
 * agent-trust story: A-Identity as an A2MCP ASP (Agent #6271) with six pay-per-call
 * tools (one free tier) and real on-chain settlements, linking to the public proof page.
 */
export default function OkxAsp() {
  return (
    <section id="okx-asp" className="w-full bg-background px-5 py-20 text-foreground sm:px-8 sm:py-28">
      <div className="mx-auto max-w-[1100px]">
        <motion.span
          {...reveal}
          className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-sm font-semibold text-accent"
        >
          <span className="h-2 w-2 rounded-full bg-accent" /> Live on OKX.AI · Agent #6271
        </motion.span>

        <motion.h2
          {...reveal}
          className="mt-4 text-2xl font-bold leading-tight tracking-tight sm:text-3xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          The trust oracle for the agent economy — live.
        </motion.h2>

        <motion.p {...reveal} className="mt-5 max-w-2xl text-lg leading-relaxed text-foreground/65">
          A-Identity is live on OKX.AI as an A2MCP ASP. Before any agent-to-agent transaction, an
          agent calls us to verify the counterparty — pay-per-call via x402 on X Layer mainnet.
        </motion.p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TOOLS.map((t) => (
            <motion.div {...reveal} key={t.name} className="rounded-2xl border border-sand bg-card p-5">
              <div className="flex items-baseline justify-between gap-2">
                <code className="font-mono text-sm font-semibold text-foreground">{t.name}</code>
                <span className="text-sm font-bold text-accent">{t.price}</span>
              </div>
              <p className="mt-2 text-sm text-foreground/60">{t.desc}</p>
            </motion.div>
          ))}
        </div>

        <motion.div {...reveal} className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-foreground/70">
          {STATS.map(([n, label]) => (
            <span key={label}>
              <b className="text-foreground">{n}</b> {label}
            </span>
          ))}
        </motion.div>

        <motion.a
          {...reveal}
          href={PROOF_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-8 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90"
        >
          See the on-chain proof <ArrowRight size={16} />
        </motion.a>
      </div>
    </section>
  )
}

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Fingerprint, ShieldCheck, Coins, ArrowRight, Check, ShieldAlert, ShieldX,
  Landmark, BadgeCheck, Gauge, ServerCog, Lock, Wallet, Repeat, Zap, Boxes, ArrowDown,
} from 'lucide-react'
import Navbar from '../components/Navbar'
import SiteFooter from '../components/sections/SiteFooter'
import { useTheme } from '../components/ThemeProvider'
import { EASE_OUT_EXPO } from '../lib/brand'

/**
 * /architecture — an interactive, animated view of how A-Identity works, built for
 * the curious and for developers. One rule (verify first, then pay) rendered as an
 * animated decision, then the three enforcement layers as hover-to-expand cards with
 * a trust "packet" flowing through them. Minimal prose; the diagram carries the story.
 */

const ACCENT = '#7342E2'

type Node = { icon: typeof Fingerprint; name: string; desc: string }
type Layer = { n: number; title: string; tag: string; icon: typeof Fingerprint; nodes: Node[] }

const LAYERS: Layer[] = [
  {
    n: 1,
    title: 'Identity',
    tag: 'verify first',
    icon: Fingerprint,
    nodes: [
      { icon: BadgeCheck, name: 'ERC-8004 identity', desc: 'Live on-chain read of the IdentityRegistry. Real token, real owner.' },
      { icon: ShieldCheck, name: 'Know Your Agent', desc: 'Wallet-control attested in the ValidationRegistry. Revocable.' },
      { icon: Gauge, name: 'Reputation 0-1000', desc: 'Deterministic score + Sybil detection + an ALLOW / WARN / DENY verdict.' },
    ],
  },
  {
    n: 2,
    title: 'Bounded authority',
    tag: '3 enforcement layers',
    icon: ShieldCheck,
    nodes: [
      { icon: ServerCog, name: 'Server policy', desc: 'A pre-check on every instruction before anything is signed.' },
      { icon: Lock, name: 'On-chain vault', desc: 'Spend caps, allowlists and freeze enforced by a contract on Arc.' },
      { icon: Wallet, name: 'Circle Agent Wallet', desc: 'Hosted wallet-layer screening as a third independent gate.' },
    ],
  },
  {
    n: 3,
    title: 'Payment rails',
    tag: 'pay at machine speed',
    icon: Coins,
    nodes: [
      { icon: Zap, name: 'x402', desc: 'Pay-per-call over the HTTP 402 standard, settled in stablecoins.' },
      { icon: Repeat, name: 'Nanopayments', desc: 'Gasless, sub-cent, batched through Circle Gateway.' },
      { icon: Boxes, name: 'ERC-8183 escrow', desc: 'Job escrow with dispute and refund for agent-to-agent work.' },
    ],
  },
]

/** The verify-first decision, animated. Hover a verdict to see what happens. */
const VERDICTS = [
  { key: 'ALLOW', icon: ShieldCheck, color: '#059669', line: 'verified, attested, trusted, pay in USDC' },
  { key: 'WARN', icon: ShieldAlert, color: '#d97706', line: 'thin history or caution signals, proceed with care' },
  { key: 'DENY', icon: ShieldX, color: '#dc2626', line: 'revoked, Sybil or unknown, do not pay' },
] as const

function Packet() {
  // A trust "packet" that continuously flows down the spine, tying the layers together.
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-0 z-20 h-3 w-3 -translate-x-1/2 rounded-full"
      style={{ background: ACCENT, boxShadow: `0 0 16px 4px ${ACCENT}66` }}
      animate={{ top: ['0%', '100%'], opacity: [0, 1, 1, 0] }}
      transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut', times: [0, 0.1, 0.9, 1] }}
    />
  )
}

function LayerCard({ layer, index }: { layer: Layer; index: number }) {
  const [open, setOpen] = useState(false)
  const Icon = layer.icon
  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.5, ease: EASE_OUT_EXPO, delay: index * 0.08 }}
      onHoverStart={() => setOpen(true)}
      onHoverEnd={() => setOpen(false)}
      className="relative w-full"
    >
      <motion.div
        animate={{ borderColor: open ? `${ACCENT}80` : 'var(--border)', boxShadow: open ? `0 18px 50px -20px ${ACCENT}55` : '0 1px 0 0 rgba(0,0,0,0)' }}
        className="cursor-default rounded-2xl border bg-card p-5 sm:p-6"
      >
        <div className="flex items-center gap-4">
          <motion.span
            animate={{ scale: open ? 1.06 : 1, backgroundColor: open ? ACCENT : `${ACCENT}14`, color: open ? '#fff' : ACCENT }}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl"
          >
            <Icon size={20} />
          </motion.span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[11px] text-foreground/40">0{layer.n}</span>
              <h3 className="text-lg font-bold tracking-tight text-foreground">{layer.title}</h3>
            </div>
            <span className="text-sm text-foreground/55">{layer.tag}</span>
          </div>
          <motion.span animate={{ rotate: open ? 90 : 0, color: open ? ACCENT : 'var(--foreground)' }} className="opacity-40">
            <ArrowRight size={18} />
          </motion.span>
        </div>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.28, ease: EASE_OUT_EXPO }}
              className="overflow-hidden"
            >
              <div className="mt-5 grid gap-3 sm:grid-cols-3">
                {layer.nodes.map((node, i) => {
                  const NIcon = node.icon
                  return (
                    <motion.div
                      key={node.name}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 + i * 0.06, ease: EASE_OUT_EXPO }}
                      className="rounded-xl border border-border bg-background p-4"
                    >
                      <NIcon size={16} className="text-accent" />
                      <div className="mt-2 text-sm font-semibold text-foreground">{node.name}</div>
                      <p className="mt-1 text-[13px] leading-relaxed text-foreground/55">{node.desc}</p>
                    </motion.div>
                  )
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

function VerdictRow() {
  const [active, setActive] = useState<string | null>(null)
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {VERDICTS.map((v) => {
        const Icon = v.icon
        const on = active === v.key
        return (
          <motion.button
            key={v.key}
            type="button"
            onHoverStart={() => setActive(v.key)}
            onHoverEnd={() => setActive((k) => (k === v.key ? null : k))}
            onFocus={() => setActive(v.key)}
            animate={{ borderColor: on ? `${v.color}88` : 'var(--border)', backgroundColor: on ? `${v.color}12` : 'var(--card)' }}
            className="rounded-xl border p-4 text-left"
          >
            <span className="inline-flex items-center gap-2 text-sm font-bold" style={{ color: v.color }}>
              <Icon size={16} /> {v.key}
            </span>
            <AnimatePresence mode="wait">
              <motion.p
                key={on ? 'on' : 'off'}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="mt-1.5 text-[13px] leading-relaxed text-foreground/60"
              >
                {v.line}
              </motion.p>
            </AnimatePresence>
          </motion.button>
        )
      })}
    </div>
  )
}

export default function Architecture() {
  const { theme } = useTheme()
  return (
    <div className={theme === 'dark' ? 'dark' : ''}>
      <div className="min-h-screen w-full bg-background text-foreground" style={{ fontFamily: 'var(--font-body)' }}>
        <Navbar />

        <main className="mx-auto w-full max-w-[900px] px-5 pb-24 pt-28 sm:px-8 sm:pt-32">
          {/* hero */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
              How it works
            </span>
            <h1 className="mt-4 text-3xl font-bold leading-tight tracking-tight sm:text-4xl" style={{ fontFamily: 'var(--font-heading)' }}>
              Verify first. <span className="text-accent">Pay at machine speed.</span>
            </h1>
            <p className="mt-3 max-w-xl text-lg leading-relaxed text-foreground/60">
              One rule, three layers, all anchored on-chain. Hover anything to open it up.
            </p>
          </motion.div>

          {/* the decision */}
          <section className="mt-12">
            <div className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-foreground/50">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-accent/10 font-mono text-[11px] text-accent">?</span>
              The one question, before any payment
            </div>
            <VerdictRow />
          </section>

          {/* the flow */}
          <section className="relative mt-12">
            {/* the spine + flowing packet */}
            <div className="pointer-events-none absolute bottom-0 left-1/2 top-0 hidden w-px -translate-x-1/2 bg-border sm:block">
              <Packet />
            </div>

            <div className="flex flex-col items-stretch gap-4">
              <FlowChip icon={Fingerprint} label="An AI agent (or a human) shows up" muted />
              <Connector />
              {LAYERS.map((layer, i) => (
                <div key={layer.n} className="flex flex-col gap-4">
                  <LayerCard layer={layer} index={i} />
                  {i < LAYERS.length - 1 && <Connector />}
                </div>
              ))}
              <Connector />
              <FlowChip icon={Landmark} label="Settle in USDC on Circle Arc, cross-chain via Gateway + CCTP" accent />
            </div>
          </section>

          {/* the OKX branch */}
          <section className="mt-12">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
              className="rounded-2xl border border-accent/30 bg-accent/[0.06] p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-sm font-bold text-accent">
                    <Zap size={16} /> Live on OKX.AI as Agent #6271
                  </div>
                  <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-foreground/60">
                    The identity layer is also sold as six pay-per-call tools over x402 on X Layer mainnet.
                    120 real settlements, verifiable on-chain.
                  </p>
                </div>
                <Link
                  to="/explorer"
                  className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
                >
                  Try the Trust Explorer <ArrowRight size={15} />
                </Link>
              </div>
            </motion.div>
          </section>
        </main>

        <SiteFooter />
      </div>
    </div>
  )
}

function Connector() {
  return (
    <div className="flex justify-center py-0.5" aria-hidden>
      <motion.span
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 0.4 }}
        viewport={{ once: true }}
        className="text-foreground/40"
      >
        <ArrowDown size={16} />
      </motion.span>
    </div>
  )
}

function FlowChip({ icon: Icon, label, muted, accent }: { icon: typeof Fingerprint; label: string; muted?: boolean; accent?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
      className={`relative z-10 mx-auto flex items-center gap-3 rounded-full border px-5 py-3 ${
        accent ? 'border-accent/40 bg-accent/10' : 'border-border bg-card'
      }`}
    >
      <Icon size={18} className={accent ? 'text-accent' : muted ? 'text-foreground/50' : 'text-foreground'} />
      <span className={`text-sm font-medium ${accent ? 'text-foreground' : 'text-foreground/70'}`}>{label}</span>
      {accent && <Check size={16} className="text-accent" />}
    </motion.div>
  )
}

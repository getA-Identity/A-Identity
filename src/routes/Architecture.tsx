import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence, useInView } from 'framer-motion'
import {
  Fingerprint, ShieldCheck, Coins, ArrowRight, ArrowUpRight, Landmark,
  BadgeCheck, Gauge, ServerCog, Lock, Wallet, Repeat, Zap, Boxes, RotateCw, Circle,
} from 'lucide-react'
import Navbar from '../components/Navbar'
import SiteFooter from '../components/sections/SiteFooter'
import { useTheme } from '../components/ThemeProvider'
import { EASE_OUT_EXPO } from '../lib/brand'
import { usePageMeta } from '../lib/head'

/**
 * /architecture, the system, told the way an engineer would read it: monospace
 * indices, hairline borders, a blueprint grid, a real request/response terminal, and
 * a bento of the pieces. Restrained palette (one accent), theme-aware, interaction-first.
 * Built for the curious and for developers.
 */

const ACCENT = '#7342E2'

type Stage = {
  idx: string
  id: string
  title: string
  kicker: string
  icon: typeof Fingerprint
  standard: string
  ref: string
  line: string
  nodes: { icon: typeof Fingerprint; name: string; meta: string; desc: string }[]
}

const STAGES: Stage[] = [
  {
    idx: '01',
    id: 'identity',
    title: 'Identity',
    kicker: 'verify first',
    icon: Fingerprint,
    standard: 'ERC-8004',
    ref: '0x8004A8…BD9e',
    line: 'Who is this agent, and can its keys be proven?',
    nodes: [
      { icon: BadgeCheck, name: 'IdentityRegistry', meta: 'ownerOf · tokenURI', desc: 'A live on-chain read. Real token, real owner, no database.' },
      { icon: ShieldCheck, name: 'ValidationRegistry', meta: 'KYA · revocable', desc: 'Wallet control attested on-chain, and revocable on incident.' },
      { icon: Gauge, name: 'Reputation', meta: '0-1000 · Sybil', desc: 'Deterministic score, decayed by recency, with a Sybil check.' },
    ],
  },
  {
    idx: '02',
    id: 'authority',
    title: 'Bounded authority',
    kicker: 'three enforcement layers',
    icon: ShieldCheck,
    standard: 'AgentSpendPolicy',
    ref: 'per-agent vault',
    line: 'How much is this agent allowed to move, and who can stop it?',
    nodes: [
      { icon: ServerCog, name: 'Server policy', meta: 'pre-check', desc: 'Every instruction is checked before anything is signed.' },
      { icon: Lock, name: 'On-chain vault', meta: 'caps · freeze', desc: 'Spend caps, allowlists and freeze enforced by a contract.' },
      { icon: Wallet, name: 'Circle Agent Wallet', meta: 'hosted', desc: 'Hosted wallet-layer screening as a third independent gate.' },
    ],
  },
  {
    idx: '03',
    id: 'rails',
    title: 'Payment rails',
    kicker: 'pay at machine speed',
    icon: Coins,
    standard: 'x402',
    ref: 'eip155:196',
    line: 'How does value actually move, per call or per job?',
    nodes: [
      { icon: Zap, name: 'x402', meta: 'HTTP 402', desc: 'Pay-per-call over the 402 standard, settled in stablecoins.' },
      { icon: Repeat, name: 'Nanopayments', meta: 'gasless', desc: 'Sub-cent, gasless, batched through Circle Gateway.' },
      { icon: Boxes, name: 'ERC-8183 escrow', meta: 'dispute', desc: 'Job escrow with dispute and refund for agent work.' },
    ],
  },
  {
    idx: '04',
    id: 'settle',
    title: 'Settlement',
    kicker: 'anchored, cross-chain',
    icon: Landmark,
    standard: 'USDC',
    ref: 'Arc · CCTP',
    line: 'Where does it land, and how does it cross chains?',
    nodes: [
      { icon: Landmark, name: 'USDC on Arc', meta: 'sub-second', desc: 'Native settlement with sub-second finality, gas in USDC.' },
      { icon: Repeat, name: 'Circle Gateway', meta: 'unified', desc: 'A chain-abstracted balance behind a single unified view.' },
      { icon: ArrowUpRight, name: 'CCTP', meta: 'burn/mint', desc: 'Canonical cross-chain USDC by burn-and-mint, no bridges.' },
    ],
  },
]

/** A monospace kicker: 01 / LABEL, the editorial index used across the page. */
function Index({ n, label }: { n: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-foreground/40">
      <span className="text-accent">{n}</span>
      <span className="h-px w-4 bg-foreground/20" />
      {label}
    </span>
  )
}

/** The blueprint grid, faded toward the edges. Theme-aware via --border. */
function Blueprint() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10"
      style={{
        backgroundImage:
          'linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)',
        backgroundSize: '56px 56px',
        maskImage: 'radial-gradient(ellipse 70% 55% at 50% 30%, #000 30%, transparent 100%)',
        WebkitMaskImage: 'radial-gradient(ellipse 70% 55% at 50% 30%, #000 30%, transparent 100%)',
        opacity: 0.6,
      }}
    />
  )
}

/** The interactive system: an indexed rail (left) drives a detail panel (right). */
function System() {
  const [active, setActive] = useState(0)
  const s = STAGES[active]
  return (
    <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-[minmax(0,240px)_1fr]">
      {/* rail */}
      <div className="flex flex-col bg-background">
        {STAGES.map((stage, i) => {
          const on = i === active
          const Icon = stage.icon
          return (
            <button
              key={stage.id}
              type="button"
              onMouseEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onClick={() => setActive(i)}
              className="group relative flex items-center gap-3 border-b border-border px-4 py-4 text-left last:border-b-0"
            >
              {on && (
                <motion.span layoutId="rail-active" className="absolute inset-y-0 left-0 w-0.5" style={{ background: ACCENT }} />
              )}
              <span className={`font-mono text-xs ${on ? 'text-accent' : 'text-foreground/35'}`}>{stage.idx}</span>
              <Icon size={16} className={on ? 'text-foreground' : 'text-foreground/40'} />
              <span className={`text-sm font-semibold ${on ? 'text-foreground' : 'text-foreground/55'}`}>{stage.title}</span>
            </button>
          )
        })}
      </div>

      {/* panel */}
      <div className="relative min-h-[300px] bg-background p-6 sm:p-8">
        {/* scan-line sweep on change */}
        <AnimatePresence mode="wait">
          <motion.div
            key={s.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Index n={s.idx} label={s.kicker} />
              <span className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-foreground/50">
                {s.standard} <span className="text-foreground/25">·</span> {s.ref}
              </span>
            </div>
            <h3 className="mt-4 text-2xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
              {s.title}
            </h3>
            <p className="mt-1.5 max-w-md text-[15px] leading-relaxed text-foreground/55">{s.line}</p>

            <div className="mt-6 grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
              {s.nodes.map((node, i) => {
                const NIcon = node.icon
                return (
                  <motion.div
                    key={node.name}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.04 + i * 0.05, ease: EASE_OUT_EXPO }}
                    className="group bg-background p-4 transition-colors hover:bg-accent/[0.04]"
                  >
                    <div className="flex items-center justify-between">
                      <NIcon size={15} className="text-accent" />
                      <span className="font-mono text-[10px] uppercase tracking-wide text-foreground/35">{node.meta}</span>
                    </div>
                    <div className="mt-2.5 text-[13px] font-semibold text-foreground">{node.name}</div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/50">{node.desc}</p>
                  </motion.div>
                )
              })}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}

/**
 * A real request/response, revealed line by line like a terminal. Replayable.
 *
 * Painted from the shared terminal tokens (index.css), so it follows the page theme
 * rather than staying a dark slab on a light architecture page. The macOS traffic
 * lights keep their fixed red/amber/green: those three are a quotation of a window
 * title bar, not status, and they read the same on either ground.
 */
type TLine = { kind: 'cmd' | 'in' | 'out'; text: string; tone?: 'deny' | 'ok' }
const CALL: TLine[] = [
  { kind: 'cmd', text: 'POST /tools/risk_check  { "agentId": "0xc60e…1b69" }' },
  { kind: 'out', text: '402  PAYMENT-REQUIRED   eip155:196 · USD₮0 · $0.005' },
  { kind: 'cmd', text: 'sign + retry            X-PAYMENT: <settled on X Layer>' },
  { kind: 'in', text: 'resolve identity        ERC-8004 · owner verified' },
  { kind: 'in', text: 'know your agent         no KYA attestation' },
  { kind: 'in', text: 'score                   0 / 1000 · no history' },
  { kind: 'out', text: '200  DENY               reputation 0 is below 200', tone: 'deny' },
]

function Terminal() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '-80px' })
  const [n, setN] = useState(0)
  const [runKey, setRunKey] = useState(0)

  useEffect(() => {
    if (!inView) return
    setN(0)
    let i = 0
    const t = setInterval(() => {
      i += 1
      setN(i)
      if (i >= CALL.length) clearInterval(t)
    }, 480)
    return () => clearInterval(t)
  }, [inView, runKey])

  const done = n >= CALL.length
  return (
    <div ref={ref} className="overflow-hidden rounded-xl border border-border bg-term">
      <div className="flex items-center justify-between border-b border-term-border bg-term-chrome px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#ff5f57' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#febc2e' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#28c840' }} />
          <span className="ml-2 font-mono text-[11px] text-term-faint">agent verifies a counterparty, then pays</span>
        </div>
        <button
          type="button"
          onClick={() => setRunKey((k) => k + 1)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] text-term-faint transition-colors hover:bg-term-hover hover:text-term-fg"
        >
          <RotateCw size={12} /> replay
        </button>
      </div>
      <div className="min-h-[196px] space-y-1.5 p-4 font-mono text-[12.5px] leading-relaxed sm:p-5">
        {CALL.slice(0, n).map((l, i) => (
          <motion.div
            key={`${runKey}-${i}`}
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex gap-2.5"
          >
            <span className="select-none text-term-dot">
              {l.kind === 'cmd' ? '›' : l.kind === 'in' ? ' ·' : '<-'}
            </span>
            <span
              className={
                l.tone === 'deny'
                  ? 'font-semibold text-term-bad'
                  : l.tone === 'ok'
                  ? 'text-term-ok'
                  : l.kind === 'cmd'
                  ? 'text-term-fg'
                  : l.kind === 'out'
                  ? 'text-term-dim'
                  : 'text-term-faint'
              }
            >
              {l.text}
            </span>
          </motion.div>
        ))}
        {!done && <span className="ml-4 inline-block h-3.5 w-2 animate-pulse bg-term-caret align-middle" />}
      </div>
    </div>
  )
}

// Pinned by mcp/src/frontend-stats.test.ts. The test count read 163 and the chain count 2
// while the registry carried seven identity chains, which is the drift class this page is
// otherwise about.
const STATS = [
  { k: '120', v: 'real x402 settlements', mono: 'X Layer mainnet' },
  { k: '955', v: 'unit tests, green', mono: 'deterministic' },
  { k: '7', v: 'services, one free', mono: '$0 to $0.01' },
  { k: '8', v: 'chains read live', mono: 'ERC-8004 registries' },
]

export default function Architecture() {
  const { theme } = useTheme()

  usePageMeta({
    title: 'Architecture · A-Identity',
    description:
      'How the system fits together: ERC-8004 identity, three layers of spend enforcement, the payment rails an agent can settle on, and cross-chain USDC underneath.',
    canonical: 'https://a-identity.xyz/architecture',
  })

  return (
    <div className={theme === 'dark' ? 'dark' : ''}>
      <div className="relative min-h-screen w-full overflow-hidden bg-background text-foreground" style={{ fontFamily: 'var(--font-body)' }}>
        <Navbar />

        <main className="relative mx-auto w-full max-w-[1040px] px-5 pb-28 pt-28 sm:px-8 sm:pt-36">
          {/* hero */}
          <section className="relative">
            <Blueprint />
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}>
              <Index n="A-IDENTITY" label="system architecture" />
              <h1 className="mt-5 max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl" style={{ fontFamily: 'var(--font-heading)' }}>
                Verify first.
                <br />
                <span className="text-accent">Pay at machine speed.</span>
              </h1>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-foreground/55">
                One rule, four stages, all anchored on-chain. Read it top to bottom, or
                open any stage.
              </p>
              <div className="mt-8 flex flex-wrap gap-2 font-mono text-[11px] text-foreground/45">
                {['ERC-8004', 'x402', 'ERC-8183', 'CCTP', 'MCP'].map((t) => (
                  <span key={t} className="rounded-md border border-border px-2 py-1">{t}</span>
                ))}
              </div>
            </motion.div>
          </section>

          {/* the system */}
          <section className="mt-20">
            <div className="mb-5 flex items-baseline justify-between">
              <Index n="v" label="the request path" />
              <span className="hidden font-mono text-[11px] text-foreground/35 sm:inline">hover a stage</span>
            </div>
            <System />
          </section>

          {/* real call */}
          <section className="mt-16 grid gap-6 lg:grid-cols-[1fr_minmax(0,420px)] lg:items-center">
            <div>
              <Index n="02" label="what a real call looks like" />
              <h2 className="mt-4 text-2xl font-bold tracking-tight sm:text-3xl" style={{ fontFamily: 'var(--font-heading)' }}>
                An agent verifies, then pays. No mocks.
              </h2>
              <p className="mt-3 max-w-md text-[15px] leading-relaxed text-foreground/55">
                A buyer calls a paid tool, hits a real 402 on X Layer mainnet, settles in
                USD₮0, and gets a deterministic verdict with its reasons. An unknown
                counterparty is denied before any money moves.
              </p>
              <Link to="/explorer" className="mt-6 inline-flex items-center gap-2 font-mono text-[13px] font-semibold text-accent hover:underline">
                run it yourself in the explorer <ArrowRight size={14} />
              </Link>
            </div>
            <Terminal />
          </section>

          {/* bento: proof + OKX */}
          <section className="mt-16">
            <Index n="03" label="live on OKX.AI" />
            <div className="mt-5 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
              {/* wide cell */}
              <div className="relative bg-background p-6 sm:col-span-2 sm:row-span-2">
                <div className="flex items-center gap-2 font-mono text-[11px] text-accent">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                  </span>
                  AGENT #6271
                </div>
                <h3 className="mt-4 text-xl font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
                  A-Identity Trust Oracle
                </h3>
                <p className="mt-2 max-w-sm text-sm leading-relaxed text-foreground/55">
                  The identity layer, sold as six pay-per-call tools over x402 on X Layer
                  mainnet. Every number is real and verifiable on-chain.
                </p>
                <Link to="/explorer" className="mt-6 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90">
                  Open the Trust Explorer <ArrowRight size={15} />
                </Link>
              </div>
              {STATS.map((st) => (
                <div key={st.v} className="group bg-background p-5 transition-colors hover:bg-accent/[0.04]">
                  <div className="font-mono text-3xl font-bold tracking-tight text-foreground">{st.k}</div>
                  <div className="mt-1 text-[13px] text-foreground/60">{st.v}</div>
                  <div className="mt-2 font-mono text-[10px] uppercase tracking-wide text-foreground/35">{st.mono}</div>
                </div>
              ))}
            </div>
          </section>

          {/* human-on-the-loop footer note */}
          <section className="mt-14 flex items-start gap-3 border-t border-border pt-8">
            <Circle size={7} className="mt-1.5 shrink-0 fill-accent text-accent" />
            <p className="max-w-xl text-sm leading-relaxed text-foreground/50">
              Anything that holds a key, deploys a contract, or moves real value stays
              human-on-the-loop. Agents act inside the limits you set, a person in the
              tower, not in the driver's seat.
            </p>
          </section>
        </main>

        <SiteFooter />
      </div>
    </div>
  )
}

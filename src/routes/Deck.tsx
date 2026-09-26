import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { usePageMeta } from '../lib/head'

/**
 * The pitch deck: eight slides on a fixed 1600x900 stage, scaled to fit the window.
 *
 * Driven by the arrow keys, space, a swipe, the dots or the two click zones, and it keeps its
 * place in the hash (#3), so a link can open on a given slide. `?print=1` renders every slide
 * stacked at its final frame, one per page, which is how the investor-deck PDF is taken:
 * the PDF and the live deck are the same components, so they cannot drift apart.
 *
 * Every number here is one the public ledger or the grant application already states, and
 * the honest labels travel with them: the first Arc Mainnet payments are ours and say so,
 * escrow counts are Arc testnet, and everything under "Next" is planned, not integrated.
 *
 * Unlinked and noindex, like /motion and /mascot. Always dark: the art is lit for navy.
 */

const W = 1600
const H = 900
const EASE = [0.16, 1, 0.3, 1] as const

const PrintCtx = createContext(false)
const usePrint = () => useContext(PrintCtx)

// ── motion primitives ─────────────────────────────────────────────────────────────

/** Fades and lifts in after `delay`; in print mode it renders the final frame at once. */
function Reveal({
  delay = 0,
  y = 22,
  className,
  children,
}: {
  delay?: number
  y?: number
  className?: string
  children: ReactNode
}) {
  const print = usePrint()
  return (
    <motion.div
      className={className}
      initial={print ? false : { opacity: 0, y, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 0.9, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  )
}

/** A number that counts up once the slide is on screen. */
function Counter({ to, delay = 0, suffix = '' }: { to: number; delay?: number; suffix?: string }) {
  const print = usePrint()
  const value = useMotionValue(print ? to : 0)
  const text = useTransform(value, (v) => `${Math.round(v).toLocaleString('en-US')}${suffix}`)
  useEffect(() => {
    if (print) return
    const controls = animate(value, to, { duration: 1.8, delay, ease: EASE })
    return () => controls.stop()
  }, [print, to, delay, value])
  return <motion.span>{text}</motion.span>
}

/** Brand art, faded into the navy at its edges so it sits in the slide instead of on it. */
function Art({ src, className, float = true }: { src: string; className?: string; float?: boolean }) {
  const print = usePrint()
  const mask = 'radial-gradient(closest-side, black 58%, transparent 100%)'
  return (
    <motion.img
      src={src}
      alt=""
      draggable={false}
      className={className}
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      animate={print || !float ? undefined : { y: [0, -16, 0], rotate: [0, 1.2, 0] }}
      transition={{ duration: 7, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}

/** The mascot, bobbing gently. Transparent renders, so no edge mask. */
function Owl({ src, className, style }: { src: string; className?: string; style?: React.CSSProperties }) {
  const print = usePrint()
  return (
    <motion.img
      src={src}
      alt=""
      draggable={false}
      className={className}
      style={{ filter: 'drop-shadow(0 24px 40px rgba(0,0,0,0.45))', ...style }}
      animate={print ? undefined : { y: [0, -10, 0], rotate: [0, -2, 0] }}
      transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}

/** Two dashed rings turning in opposite directions, the deck's recurring orbit motif. */
function Orbits({ size, className }: { size: number; className?: string }) {
  const print = usePrint()
  const spin = (dir: 1 | -1, duration: number) =>
    print ? {} : { animate: { rotate: 360 * dir }, transition: { duration, repeat: Infinity, ease: 'linear' as const } }
  return (
    <div className={`pointer-events-none absolute ${className ?? ''}`} style={{ width: size, height: size }}>
      <motion.svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" {...spin(1, 60)}>
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--accent)" strokeOpacity="0.45" strokeWidth="0.25" strokeDasharray="0.8 2.4" />
        <circle cx="50" cy="1" r="0.9" fill="var(--accent)" />
      </motion.svg>
      <motion.svg viewBox="0 0 100 100" className="absolute inset-[12%] h-[76%] w-[76%]" {...spin(-1, 44)}>
        <circle cx="50" cy="50" r="49" fill="none" stroke="var(--usdc)" strokeOpacity="0.4" strokeWidth="0.3" strokeDasharray="6 5" />
        <circle cx="99" cy="50" r="1.1" fill="var(--usdc)" />
      </motion.svg>
    </div>
  )
}

/** The page behind every slide: navy depth, two drifting glows and a faint grid. */
function Backdrop() {
  const print = usePrint()
  const drift = (x: number[], y: number[], duration: number) =>
    print ? {} : { animate: { x, y }, transition: { duration, repeat: Infinity, ease: 'easeInOut' as const } }
  const grid = 'radial-gradient(ellipse 70% 60% at 50% 40%, black, transparent 85%)'
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{ background: 'radial-gradient(130% 100% at 50% -10%, var(--card), var(--background) 62%)' }}
      />
      <motion.div
        className="absolute -left-48 -top-56 h-[760px] w-[760px] rounded-full blur-[130px]"
        style={{ background: 'color-mix(in srgb, var(--accent) 34%, transparent)' }}
        {...drift([0, 90, 0], [0, 60, 0], 20)}
      />
      <motion.div
        className="absolute -bottom-72 -right-40 h-[720px] w-[720px] rounded-full blur-[140px]"
        style={{ background: 'color-mix(in srgb, var(--usdc) 26%, transparent)' }}
        {...drift([0, -70, 0], [0, -40, 0], 24)}
      />
      {/* The grid is screen-only: PDF viewers rasterize a repeating gradient into coarse tiles. */}
      {!print && (
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          maskImage: grid,
          WebkitMaskImage: grid,
        }}
      />
      )}
    </div>
  )
}

// ── layout pieces ─────────────────────────────────────────────────────────────────

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[15px] font-semibold uppercase tracking-[0.22em] text-accent">
      <span className="h-px w-10 bg-accent" />
      {children}
    </div>
  )
}

function Title({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <h2 className={`font-heading text-[64px] leading-[1.02] tracking-[-0.02em] ${className}`}>{children}</h2>
}

function Chip({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'ok' | 'usdc' | 'muted' }) {
  const color = { accent: 'var(--accent)', ok: 'var(--ok)', usdc: 'var(--usdc)', muted: 'var(--foreground)' }[tone]
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[15px] font-medium"
      style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {children}
    </span>
  )
}

function Slide({ n, children, brand = true }: { n: number; children: ReactNode; brand?: boolean }) {
  return (
    <section className="relative overflow-hidden bg-background text-foreground" style={{ width: W, height: H }}>
      <Backdrop />
      <div className="relative h-full px-24 pb-20 pt-20">{children}</div>
      <div className="absolute inset-x-24 bottom-8 flex items-center justify-between text-[14px] text-foreground/55">
        {brand ? <img src="/brand/lockup-horizontal-full-cream.png" alt="A-Identity" className="h-9 w-auto opacity-90" /> : <span />}
        <span className="font-mono tracking-widest">
          {String(n).padStart(2, '0')} / {String(SLIDES.length).padStart(2, '0')}
        </span>
      </div>
    </section>
  )
}

// ── 1. title ──────────────────────────────────────────────────────────────────────

function SlideTitle() {
  const print = usePrint()
  return (
    <Slide n={1} brand={false}>
      <div className="grid h-full grid-cols-[1.15fr_1fr] items-center gap-10">
        <div>
          <Reveal>
            <img src="/brand/lockup-horizontal-full-cream.png" alt="A-Identity" className="mb-10 h-16 w-auto" />
          </Reveal>
          <Reveal delay={0.06}>
            <Eyebrow>Pitch deck · 2026</Eyebrow>
          </Reveal>
          <Reveal delay={0.12}>
            <h1 className="mt-8 font-heading text-[92px] leading-[0.98] tracking-[-0.03em]">
              The passport and wallet for <span className="whitespace-nowrap text-accent">AI agents.</span>
            </h1>
          </Reveal>
          <Reveal delay={0.28}>
            <p className="mt-8 max-w-[640px] text-[24px] leading-[1.45] text-foreground/75">
              A-Identity verifies who an agent pays, and a contract on Arc Mainnet caps what it can spend, so even a
              compromised agent cannot exceed its owner's limit.
            </p>
          </Reveal>
          <Reveal delay={0.44} className="mt-10 flex flex-wrap gap-3">
            <Chip tone="ok">Live on Arc Mainnet since 16 Sep 2026</Chip>
            <Chip>Agent #0 on the canonical ERC-8004 registry</Chip>
            <Chip tone="usdc">Settles in USDC through Circle Gateway</Chip>
          </Reveal>
        </div>
        <div className="relative flex h-full items-center justify-center">
          <Orbits size={620} className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
          <div
            className="absolute left-1/2 top-1/2 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[90px]"
            style={{ background: 'color-mix(in srgb, var(--accent) 38%, transparent)' }}
          />
          <Reveal delay={0.2} y={40} className="relative">
            <Owl src="/mascots/owl-card.png" className="w-[500px]" />
          </Reveal>
          <motion.div
            className="absolute right-6 top-[22%] rounded-2xl border border-border bg-card/80 px-5 py-4 backdrop-blur"
            initial={print ? false : { opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.9, duration: 0.8, ease: EASE }}
          >
            <div className="text-[13px] uppercase tracking-widest text-foreground/55">KYA</div>
            <div className="mt-1 text-[20px] font-semibold text-ok">Wallet control proven</div>
          </motion.div>
          <motion.div
            className="absolute bottom-[20%] left-2 rounded-2xl border border-border bg-card/80 px-5 py-4 backdrop-blur"
            initial={print ? false : { opacity: 0, x: -30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 1.1, duration: 0.8, ease: EASE }}
          >
            <div className="text-[13px] uppercase tracking-widest text-foreground/55">Spend vault</div>
            <div className="mt-1 text-[20px] font-semibold">
              Daily cap <span className="text-usdc">1.00 USDC</span>
            </div>
          </motion.div>
        </div>
      </div>
    </Slide>
  )
}

// ── 2. problem ────────────────────────────────────────────────────────────────────

function SybilCluster() {
  const print = usePrint()
  const dots = Array.from({ length: 12 }, (_, i) => {
    const a = (i / 12) * Math.PI * 2
    return { x: 60 + Math.cos(a) * 42, y: 60 + Math.sin(a) * 42 }
  })
  return (
    <svg viewBox="0 0 120 120" className="h-[150px] w-[150px]">
      {dots.map((d, i) => (
        <motion.line
          key={`l${i}`}
          x1="60"
          y1="60"
          x2={d.x}
          y2={d.y}
          stroke="var(--danger)"
          strokeWidth="0.6"
          initial={{ opacity: 0.25 }}
          animate={print ? undefined : { opacity: [0.15, 0.7, 0.15] }}
          transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.12 }}
        />
      ))}
      {dots.map((d, i) => (
        <circle key={`c${i}`} cx={d.x} cy={d.y} r="4.2" fill="var(--danger)" fillOpacity="0.85" />
      ))}
      <circle cx="60" cy="60" r="7" fill="var(--foreground)" />
    </svg>
  )
}

function DrainingWallet() {
  const print = usePrint()
  return (
    <div className="flex h-[150px] w-full flex-col justify-center gap-3">
      <div className="flex justify-between text-[14px] text-foreground/55">
        <span>wallet</span>
        <span>limit in app code</span>
      </div>
      <div className="relative h-7 w-full overflow-hidden rounded-full border border-border bg-card">
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ background: 'linear-gradient(90deg, var(--danger), var(--warn))' }}
          initial={{ width: print ? '12%' : '100%' }}
          animate={print ? undefined : { width: ['100%', '8%', '8%', '100%'] }}
          transition={{ duration: 4.5, repeat: Infinity, times: [0, 0.55, 0.85, 1], ease: 'easeInOut' }}
        />
        <div className="absolute inset-y-0 left-[60%] w-[2px] bg-foreground/70" />
      </div>
      <div className="text-[14px] text-foreground/55">the cap was a variable in the same process</div>
    </div>
  )
}

function PaymentStream() {
  const print = usePrint()
  return (
    <div className="relative h-[150px] w-full overflow-hidden">
      {Array.from({ length: 3 }).map((_, row) => (
        <div key={row} className="absolute inset-x-0" style={{ top: 30 + row * 38 }}>
          {Array.from({ length: 7 }).map((__, i) => (
            <motion.span
              key={i}
              className="absolute h-2.5 w-2.5 rounded-full bg-usdc"
              style={{ left: `${i * 15}%` }}
              initial={{ opacity: 0.6 }}
              animate={print ? undefined : { x: [0, 60], opacity: [0, 1, 0] }}
              transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.22 + row * 0.35, ease: 'linear' }}
            />
          ))}
        </div>
      ))}
      <div className="absolute bottom-0 left-0 text-[14px] text-foreground/55">$0.001 each, all day, no chargeback</div>
    </div>
  )
}

function SlideProblem() {
  const cards = [
    {
      title: 'Reputation is cheap to fake',
      body: 'One operator spins up a hundred agents that hire each other and manufactures a spotless track record.',
      visual: <SybilCluster />,
    },
    {
      title: 'Limits live in application code',
      body: 'A prompt injection, a stolen key or a loop bug drains the wallet the limit was meant to protect.',
      visual: <DrainingWallet />,
    },
    {
      title: 'No human in the loop',
      body: 'Agent payments are sub-cent, always on and final. Nobody approves each one, and there is no chargeback.',
      visual: <PaymentStream />,
    },
  ]
  return (
    <Slide n={2}>
      <Reveal>
        <Eyebrow>The problem</Eyebrow>
      </Reveal>
      <Reveal delay={0.1}>
        <Title className="mt-6 max-w-[1150px]">Agents already pay agents. Trust and spending still live apart.</Title>
      </Reveal>
      <div className="mt-14 grid grid-cols-3 gap-7">
        {cards.map((c, i) => (
          <Reveal key={c.title} delay={0.3 + i * 0.14}>
            <div className="h-[410px] rounded-3xl border border-border bg-card/70 p-8 backdrop-blur">
              <div className="flex h-[160px] items-center justify-center">{c.visual}</div>
              <h3 className="mt-6 text-[28px] font-semibold leading-tight">{c.title}</h3>
              <p className="mt-3 text-[18px] leading-[1.5] text-foreground/70">{c.body}</p>
            </div>
          </Reveal>
        ))}
      </div>
      <Reveal delay={0.8} className="mt-9 text-[19px] text-foreground/70">
        <span className="font-semibold text-foreground">Why now:</span> ERC-8004 gave agents a standard identity, and USDC
        gas on Arc with Circle Nanopayments made sub-cent payments economic.
      </Reveal>
    </Slide>
  )
}

// ── 3. solution ───────────────────────────────────────────────────────────────────

const VERDICTS = [
  { label: 'ALLOW', color: 'var(--ok)', owl: '/mascots/owl-soft-allow.png', note: 'payee added to the vault allowlist' },
  { label: 'WARN', color: 'var(--warn)', owl: '/mascots/owl-soft-warn.png', note: 'nothing written, a human decides' },
  { label: 'DENY', color: 'var(--danger)', owl: '/mascots/owl-soft-deny.png', note: 'payee removed, the contract refuses' },
]

function SlideSolution() {
  const print = usePrint()
  const [active, setActive] = useState(0)
  useEffect(() => {
    if (print) return
    const id = window.setInterval(() => setActive((a) => (a + 1) % VERDICTS.length), 1900)
    return () => window.clearInterval(id)
  }, [print])

  const nodes = [
    { k: 'Identity', t: 'ERC-8004 agent', s: 'KYA: the agent proves on chain it controls the wallet it claims.' },
    { k: 'Risk engine', t: '0-1000 reputation', s: 'Computed from real payments and jobs, with Sybil signals.' },
    { k: 'Spend vault', t: 'AgentSpendPolicy', s: 'Daily cap, per-payment ceiling, payee allowlist, freeze.' },
    { k: 'Settlement', t: 'USDC on Arc', s: 'Circle Gateway nanopayments or EIP-3009, receipt required.' },
  ]
  const xs = [272, 624, 976, 1328]

  return (
    <Slide n={3}>
      <Reveal>
        <Eyebrow>The solution</Eyebrow>
      </Reveal>
      <Reveal delay={0.1}>
        <Title className="mt-6">Verify, then pay.</Title>
      </Reveal>
      <Reveal delay={0.18}>
        <p className="mt-3 text-[26px] text-foreground/60">One system, enforced on chain.</p>
      </Reveal>
      {/* The owl's eyes follow the verdict the chips are showing. */}
      <div className="absolute right-24 top-12 h-[210px] w-[210px]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.img
            key={active}
            src={VERDICTS[active].owl}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full"
            style={{ filter: 'drop-shadow(0 20px 36px rgba(0,0,0,0.45))' }}
            initial={print ? false : { opacity: 0, scale: 0.92, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: -6 }}
            transition={{ duration: 0.35, ease: EASE }}
          />
        </AnimatePresence>
      </div>

      <div className="relative mt-10" style={{ height: 320, marginLeft: -96, marginRight: -96 }}>
        <svg className="absolute inset-0" width={W} height={320}>
          {xs.slice(0, -1).map((x, i) => (
            <motion.line
              key={x}
              x1={x + 120}
              y1={70}
              x2={xs[i + 1] - 120}
              y2={70}
              stroke="var(--accent)"
              strokeWidth="2"
              strokeDasharray="6 8"
              initial={print ? false : { pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.8 }}
              transition={{ delay: 0.6 + i * 0.35, duration: 0.8, ease: EASE }}
            />
          ))}
          {!print && (
            <motion.circle
              r="9"
              cy={70}
              fill="var(--usdc)"
              initial={{ cx: xs[0] + 120, opacity: 0 }}
              animate={{ cx: [xs[0] + 120, xs[3] - 120], opacity: [0, 1, 1, 0] }}
              transition={{ delay: 1.8, duration: 3.2, repeat: Infinity, repeatDelay: 0.6, ease: 'easeInOut' }}
              style={{ filter: 'drop-shadow(0 0 10px var(--usdc))' }}
            />
          )}
        </svg>
        {nodes.map((n, i) => (
          <Reveal key={n.k} delay={0.3 + i * 0.18} className="absolute top-0" y={30}>
            <div style={{ position: 'absolute', left: xs[i] - 150, width: 300 }} className="text-center">
              <div className="mx-auto flex h-[140px] w-[240px] flex-col items-center justify-center rounded-3xl border border-border bg-card/80 backdrop-blur">
                <div className="text-[13px] uppercase tracking-[0.2em] text-accent">{n.k}</div>
                <div className="mt-2 text-[26px] font-semibold">{n.t}</div>
              </div>
              <p className="mx-auto mt-5 w-[270px] text-[17px] leading-[1.45] text-foreground/70">{n.s}</p>
              {i === 1 && (
                <div className="mt-5 flex justify-center gap-2">
                  {VERDICTS.map((v, vi) => (
                    <motion.span
                      key={v.label}
                      className="rounded-full px-3 py-1 text-[14px] font-bold tracking-wider"
                      animate={{
                        background: vi === active ? v.color : 'transparent',
                        color: vi === active ? 'var(--background)' : v.color,
                        scale: vi === active ? 1.08 : 1,
                      }}
                      transition={{ duration: 0.4 }}
                      style={{ border: `1.5px solid ${v.color}` }}
                    >
                      {v.label}
                    </motion.span>
                  ))}
                </div>
              )}
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal delay={1.2} className="mt-8 grid grid-cols-3 gap-6">
        {[
          ['The contract refuses, not our server.', 'An over-limit pay() reverts with a typed error.'],
          ["The agent's key can only call pay().", 'The owner keeps freeze, policy and withdraw.'],
          ['One line to adopt.', 'npm @a-identity/trust-guard, or our hosted MCP server.'],
        ].map(([a, b]) => (
          <div key={a} className="rounded-2xl border border-border bg-card/50 px-6 py-5">
            <div className="text-[20px] font-semibold">{a}</div>
            <div className="mt-1 text-[16px] text-foreground/60">{b}</div>
          </div>
        ))}
      </Reveal>
    </Slide>
  )
}

// ── 4. built on circle ────────────────────────────────────────────────────────────

function SlideCircle() {
  const live = [
    ['USDC', 'The settlement asset and the gas token on Arc. The vault holds it; pay() moves it.'],
    ['CCTP V2', 'USDC burned on Base, minted on Arc Mainnet by Circle\'s forwarding service.'],
    ['Gateway Nanopayments', 'The buyer signs off-chain at zero gas; Gateway credits at once and settles in batches.'],
    ['USDC EIP-3009', 'Our own facilitator: the buyer signs, we broadcast, nothing counts without a receipt.'],
  ]
  const next = [
    ['Wallets', 'Passkey owners via Modular Wallets, agent keys via Developer-Controlled Wallets'],
    ['App Kits + EURC', 'USDC to EURC swaps under one spend policy'],
    ['USYC', 'Idle treasury parked, once allowlisted'],
    ['Paymaster', 'Gas in USDC on Base and Arbitrum'],
    ['Agent Stack', 'Our limits as Circle CLI policies'],
  ]
  return (
    <Slide n={4}>
      <Reveal>
        <Eyebrow>Built on Circle</Eyebrow>
      </Reveal>
      <Reveal delay={0.1}>
        <Title className="mt-6">Circle is the rail under every payment.</Title>
      </Reveal>
      <div className="mt-14 grid grid-cols-[1.25fr_360px_1fr] items-center gap-10">
        <div>
          <Reveal delay={0.25}>
            <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold uppercase tracking-[0.2em] text-ok">
              <span className="h-2 w-2 rounded-full bg-ok" /> Live on Arc Mainnet
            </div>
          </Reveal>
          <div className="grid grid-cols-2 gap-4">
            {live.map(([k, v], i) => (
              <Reveal key={k} delay={0.35 + i * 0.12}>
                <div className="h-[214px] rounded-2xl border border-border bg-card/75 p-6 backdrop-blur">
                  <div className="text-[22px] font-semibold leading-tight text-usdc">{k}</div>
                  <p className="mt-3 text-[16px] leading-[1.45] text-foreground/70">{v}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
        <div className="relative flex h-[380px] items-center justify-center">
          <Orbits size={360} className="left-0 top-[10px]" />
          <Reveal delay={0.3} className="relative flex items-center gap-5">
            <img src="/logos/circle-mark.webp" alt="Circle" className="h-24 w-24 rounded-full" />
            <span className="text-[30px] text-foreground/40">+</span>
            <img src="/logos/arc-mark.webp" alt="Arc" className="h-24 w-24 rounded-full" />
          </Reveal>
        </div>
        <div>
          <Reveal delay={0.5}>
            <div className="mb-4 flex items-center gap-2 text-[14px] font-semibold uppercase tracking-[0.2em] text-foreground/55">
              <span className="h-2 w-2 rounded-full bg-foreground/50" /> Next, in the grant milestones
            </div>
          </Reveal>
          <div className="space-y-4">
            {next.map(([k, v], i) => (
              <Reveal key={k} delay={0.6 + i * 0.1}>
                <div className="rounded-xl border border-dashed border-border px-5 py-3">
                  <span className="text-[18px] font-semibold">{k}</span>
                  <span className="text-[15px] text-foreground/60"> · {v}</span>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </Slide>
  )
}

// ── 5. traction ───────────────────────────────────────────────────────────────────

const RECEIPTS = [
  ['CCTP V2 mint from Base, 0.945097 USDC', '0x1f3dd9785a'],
  ["Agent #0 minted, the registry's first identity", '0x1d9f57113c'],
  ['Reputation anchored on the canonical ReputationRegistry', '0xbc70c4ce2d'],
  ['Spend vault deployed, holding real USDC', '0xabf41b6f12'],
  ['0.01 USDC paid in policy; 0.50 refused by the contract', '0x9975968a2c'],
  ['First Circle Gateway nanopayment', '0x8a47eac41a'],
  ['First EIP-3009 settlement', '0xd44287c8d7'],
]

const MAINNETS = ['arc', 'stellar', 'algorand', 'base', 'arbitrum', 'rhchain', 'xlayer', 'celo']

function SlideTraction() {
  const print = usePrint()
  return (
    <Slide n={5}>
      <Reveal>
        <Eyebrow>Traction</Eyebrow>
      </Reveal>
      <Reveal delay={0.1}>
        <Title className="mt-6">Live on Arc Mainnet since the day it opened.</Title>
      </Reveal>
      <div className="mt-12 grid grid-cols-[1.1fr_1fr] gap-14">
        <div className="relative pl-8">
          <motion.div
            className="absolute left-[7px] top-2 w-[2px] origin-top bg-accent"
            style={{ height: 'calc(100% - 16px)' }}
            initial={print ? false : { scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{ delay: 0.3, duration: 1.6, ease: EASE }}
          />
          <Reveal delay={0.2} className="mb-4 text-[14px] font-semibold uppercase tracking-[0.2em] text-foreground/55">
            16 September 2026 · Arc Mainnet launch day
          </Reveal>
          <div className="space-y-[18px]">
            {RECEIPTS.map(([label, hash], i) => (
              <Reveal key={hash} delay={0.4 + i * 0.13} y={12}>
                <div className="relative flex items-center justify-between gap-6">
                  <span className="absolute -left-[31px] h-3.5 w-3.5 rounded-full border-2 border-accent bg-background" />
                  <span className="text-[19px]">{label}</span>
                  <span className="shrink-0 font-mono text-[14px] text-foreground/45">{hash}</span>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={1.4} className="mt-6 text-[15px] text-foreground/55">
            The first Arc Mainnet payments are our own and are labeled internal.
            <br />
            Every receipt: <span className="whitespace-nowrap text-foreground/80">a-identity.xyz/proof/arc</span>
          </Reveal>
        </div>
        <div>
          <div className="grid grid-cols-2 gap-4">
            {[
              { v: 8, s: '', l: 'mainnets live' },
              { v: 17, s: '', l: 'KYA-verified agents' },
              { v: 20, s: '', l: 'escrow jobs settled on Arc testnet' },
              { v: 1419, s: '', l: 'unit tests gate every deploy' },
            ].map((c, i) => (
              <Reveal key={c.l} delay={0.5 + i * 0.12}>
                <div className="rounded-2xl border border-border bg-card/75 p-6 backdrop-blur">
                  <div className="font-heading text-[58px] leading-none text-foreground">
                    <Counter to={c.v} delay={0.6 + i * 0.12} suffix={c.s} />
                  </div>
                  <div className="mt-2 text-[16px] text-foreground/60">{c.l}</div>
                </div>
              </Reveal>
            ))}
          </div>
          <Reveal delay={1.1} className="mt-8">
            <div className="text-[14px] font-semibold uppercase tracking-[0.2em] text-foreground/55">Settling on</div>
            <div className="mt-4 flex flex-wrap gap-3">
              {MAINNETS.map((c, i) => (
                <motion.div
                  key={c}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card"
                  initial={print ? false : { opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 1.2 + i * 0.07, duration: 0.5, ease: EASE }}
                >
                  <img src={`/chains/${c}.svg`} alt={c} className="h-8 w-8" />
                </motion.div>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </Slide>
  )
}

// ── 6. team ───────────────────────────────────────────────────────────────────────

type Person = { initials: string; photo?: string; name: string; role: string; focus: string; points: string[] }

// `photo` takes a path under /public; until one is set the card shows the initials ring.
const PEOPLE: Person[] = [
  {
    initials: 'AD',
    name: 'Aybars Dorman',
    role: 'Co-Founder & CEO',
    focus: 'Product, go-to-market, business development',
    points: [
      '27,500+ users onboarded to BiLira through partnerships he led, including a learn-to-earn program with Circle',
      '293 developers onboarded at TON Society Türkiye',
      'Dorman Review: 3,417 subscribers. SDF ambassador, CoinDesk Türkiye columnist',
    ],
  },
  {
    initials: 'MC',
    name: 'Meriç Cintosun',
    role: 'Co-Founder & CTO',
    focus: 'Full stack, frontend to contracts',
    points: [
      'Took A-Identity to 8 live mainnets, Arc Mainnet on its launch day',
      'The spend vault in Solidity and in Rust, and our own x402 facilitators',
      '1st Stellar HackPera, 2nd Casper Agentic Buildathon, 1st SUI Bootcamp, 1st MultiversX Xperience',
    ],
  },
  {
    initials: 'MP',
    name: 'Müge Ayşe Polat',
    role: 'Head of Brand and Strategy',
    focus: 'Positioning, go-to-market, ecosystem',
    points: [
      'Leads positioning, go-to-market, the investor narrative and partnerships',
      'Drives ecosystem strategy across AI agents, digital trust and Web3',
      'Growth and strategy background across global platforms and behavioral science',
    ],
  },
]

function SlideTeam() {
  const print = usePrint()
  return (
    <Slide n={6}>
      <div className="flex items-start justify-between">
        <div>
          <Reveal>
            <Eyebrow>Team</Eyebrow>
          </Reveal>
          <Reveal delay={0.1}>
            <Title className="mt-6">Builders who ship, and who grow users.</Title>
          </Reveal>
        </div>
        <Reveal delay={0.3} y={30}>
          <Owl src="/mascots/owl-wing.png" className="-mt-8 w-[170px]" />
        </Reveal>
      </div>
      <div className="mt-8 grid grid-cols-3 gap-6">
        {PEOPLE.map((p, pi) => (
          <Reveal key={p.name} delay={0.3 + pi * 0.18}>
            <div className="h-[500px] rounded-3xl border border-border bg-card/75 p-8 backdrop-blur">
              <div className="relative h-[104px] w-[104px]">
                <motion.div
                  className="absolute inset-0 rounded-full"
                  style={{ background: 'conic-gradient(from 0deg, var(--accent), var(--usdc), var(--accent))' }}
                  animate={print ? undefined : { rotate: 360 }}
                  transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                />
                <div className="absolute inset-[3px] flex items-center justify-center overflow-hidden rounded-full bg-card font-heading text-[34px]">
                  {p.photo ? <img src={p.photo} alt={p.name} className="h-full w-full object-cover" /> : p.initials}
                </div>
              </div>
              <div className="mt-6 font-heading text-[32px] leading-tight">{p.name}</div>
              <div className="mt-1 text-[18px] font-semibold text-accent">{p.role}</div>
              <div className="mt-1 text-[15px] text-foreground/55">{p.focus}</div>
              <ul className="mt-6 space-y-3">
                {p.points.map((pt, i) => (
                  <Reveal key={pt} delay={0.55 + pi * 0.18 + i * 0.08} y={10}>
                    <li className="flex gap-3 text-[17px] leading-[1.45] text-foreground/80">
                      <span className="mt-[10px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                      {pt}
                    </li>
                  </Reveal>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>
    </Slide>
  )
}

// ── 7. roadmap and ask ────────────────────────────────────────────────────────────

const MILESTONES = [
  {
    n: '01',
    date: '30 Nov 2026',
    usdc: '7,000',
    title: 'KYA and escrow on Arc Mainnet, and the first third-party payers',
    products: 'USDC · Gateway · CCTP',
    metric: 'First external paid checks, 25 agents KYA-attested',
  },
  {
    n: '02',
    date: '15 Jan 2027',
    usdc: '5,000',
    title: (
      <>
        Keys without custody: passkey owners, <span className="whitespace-nowrap">agent-held keys</span>
      </>
    ),
    products: 'Wallets · Agent Stack',
    metric: '10 vaults no A-Identity key can move',
  },
  {
    n: '03',
    date: '15 Feb 2027',
    usdc: '5,000',
    title: 'Circle rails at production scale on Arc',
    products: 'Gateway · CCTP · App Kits · EURC · USYC · Paymaster',
    metric: 'A mainnet receipt per product, 1,000 nanopayments',
  },
  {
    n: '04',
    date: '31 Mar 2027',
    usdc: '3,000',
    title: 'Verify-then-pay in every agent framework',
    products: 'Gateway nanopayments · USDC',
    metric: '500 agents, 50 paying third parties',
  },
]

function SlideRoadmap() {
  const print = usePrint()
  return (
    <Slide n={7}>
      <div className="flex items-end justify-between">
        <div>
          <Reveal>
            <Eyebrow>Roadmap and ask</Eyebrow>
          </Reveal>
          <Reveal delay={0.1}>
            <Title className="mt-6 max-w-[980px]">Four milestones, paid on proof.</Title>
          </Reveal>
        </div>
        <Reveal delay={0.3} className="text-right">
          <div className="font-heading text-[88px] leading-none text-accent">
            <Counter to={20000} delay={0.4} />
          </div>
          <div className="mt-2 text-[20px] text-foreground/70">USDC requested in total</div>
        </Reveal>
      </div>

      <div className="relative mt-16">
        <div className="absolute left-0 right-0 top-[18px] h-[2px] bg-border" />
        <motion.div
          className="absolute left-0 right-0 top-[18px] h-[2px] origin-left"
          style={{ background: 'linear-gradient(90deg, var(--accent), var(--usdc))' }}
          initial={print ? false : { scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ delay: 0.5, duration: 1.6, ease: EASE }}
        />
        <div className="grid grid-cols-4 gap-6">
          {MILESTONES.map((m, i) => (
            <div key={m.n}>
              <motion.div
                className="relative z-10 flex h-[38px] w-[38px] items-center justify-center rounded-full border-2 border-accent bg-background text-[14px] font-bold"
                initial={print ? false : { scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ delay: 0.7 + i * 0.35, duration: 0.5, ease: EASE }}
              >
                {m.n}
              </motion.div>
              <Reveal delay={0.85 + i * 0.35} y={16}>
                <div className="mt-6 h-[370px] rounded-3xl border border-border bg-card/75 p-7 backdrop-blur">
                  <div className="flex items-baseline justify-between">
                    <span className="text-[15px] text-foreground/55">{m.date}</span>
                    <span className="text-[22px] font-semibold text-usdc">{m.usdc} USDC</span>
                  </div>
                  <div className="mt-4 text-[23px] font-semibold leading-[1.25]">{m.title}</div>
                  <div className="mt-5 text-[13px] uppercase tracking-[0.16em] text-accent">Circle</div>
                  <div className="mt-1 text-[16px] text-foreground/75">{m.products}</div>
                  <div className="mt-4 text-[13px] uppercase tracking-[0.16em] text-ok">Success metric</div>
                  <div className="mt-1 text-[16px] text-foreground/75">{m.metric}</div>
                </div>
              </Reveal>
            </div>
          ))}
        </div>
      </div>
    </Slide>
  )
}

// ── 8. close ──────────────────────────────────────────────────────────────────────

function SlideClose() {
  const print = usePrint()
  const links = [
    ['Product', 'a-identity.xyz'],
    ['Arc Mainnet receipts', 'a-identity.xyz/proof/arc'],
    ['Code', 'github.com/getA-Identity/A-Identity'],
    ['X', 'x.com/ai_dentity'],
  ]
  return (
    <Slide n={8} brand={false}>
      <div className="grid h-full grid-cols-[1fr_1fr] items-center gap-10">
        <div>
          <Reveal>
            <img src="/brand/lockup-horizontal-full-cream.png" alt="A-Identity" className="h-[72px] w-auto" />
          </Reveal>
          <Reveal delay={0.15}>
            <h2 className="mt-12 font-heading text-[112px] leading-[0.95] tracking-[-0.03em]">
              Verify,
              <br />
              then <span className="text-accent">pay.</span>
            </h2>
          </Reveal>
          <Reveal delay={0.35}>
            <p className="mt-8 max-w-[560px] text-[24px] leading-[1.45] text-foreground/75">
              The trust layer for agent payments, live on Arc Mainnet and settling in USDC.
            </p>
          </Reveal>
          <Reveal delay={0.5} className="mt-10 space-y-3">
            {links.map(([k, v]) => (
              <div key={v} className="flex items-baseline gap-4 text-[20px]">
                <span className="w-[230px] text-[14px] uppercase tracking-[0.18em] text-foreground/50">{k}</span>
                <a href={`https://${v}`} className="font-medium hover:text-accent">
                  {v}
                </a>
              </div>
            ))}
          </Reveal>
          <Reveal delay={0.7} className="mt-10 text-[17px] text-foreground/60">
            {['Aybars Dorman, CEO', 'Meriç Cintosun, CTO', 'Müge Ayşe Polat, Head of Brand and Strategy'].map((who, i) => (
              <span key={who} className="whitespace-nowrap">
                {i > 0 && ' · '}
                {who}
              </span>
            ))}
          </Reveal>
        </div>
        <div className="relative flex h-full items-center justify-center">
          <Reveal delay={0.2} y={40} className="relative">
            <motion.div
              className="absolute left-1/2 top-[40%] h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
              style={{ background: 'color-mix(in srgb, var(--accent) 55%, transparent)' }}
              animate={print ? undefined : { opacity: [0.35, 0.8, 0.35], scale: [0.9, 1.15, 0.9] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
            />
            <Art src="/art/art-gateway.webp" className="relative w-[720px]" float={false} />
            <Owl src="/mascots/owl-soft.png" className="absolute bottom-[10%] left-1/2 w-[190px] -translate-x-1/2" />
          </Reveal>
        </div>
      </div>
    </Slide>
  )
}

const SLIDES = [SlideTitle, SlideProblem, SlideSolution, SlideCircle, SlideTraction, SlideTeam, SlideRoadmap, SlideClose]

// ── the deck ──────────────────────────────────────────────────────────────────────

function useFitScale() {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const fit = () => setScale(Math.min(window.innerWidth / W, window.innerHeight / H))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return scale
}

function readHash() {
  const n = Number(window.location.hash.replace('#', ''))
  return Number.isInteger(n) && n >= 1 && n <= SLIDES.length ? n - 1 : 0
}

function PrintDeck() {
  return (
    <PrintCtx.Provider value={true}>
      <style>{`@page { size: ${W}px ${H}px; margin: 0 } html, body { margin: 0; background: #0e161e } .deck-page { break-after: page }`}</style>
      <div className="dark">
        {SLIDES.map((S, i) => (
          <div key={i} className="deck-page">
            <S />
          </div>
        ))}
      </div>
    </PrintCtx.Provider>
  )
}

function LiveDeck() {
  const scale = useFitScale()
  const [[index, dir], setState] = useState<[number, 1 | -1]>(() => [readHash(), 1])
  const touchX = useRef<number | null>(null)

  const go = useCallback((next: number) => {
    setState(([cur]) => {
      const clamped = Math.max(0, Math.min(SLIDES.length - 1, next))
      return clamped === cur ? [cur, 1] : [clamped, clamped > cur ? 1 : -1]
    })
  }, [])

  useEffect(() => {
    window.history.replaceState(null, '', `#${index + 1}`)
  }, [index])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) {
        e.preventDefault()
        go(index + 1)
      } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) {
        e.preventDefault()
        go(index - 1)
      } else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(SLIDES.length - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, index])

  const Current = SLIDES[index]
  const left = (window.innerWidth - W * scale) / 2
  const top = (window.innerHeight - H * scale) / 2

  return (
    <div
      className="dark fixed inset-0 cursor-pointer overflow-hidden bg-background text-foreground"
      // Click zones: the left third goes back, the rest goes forward. Links and the nav keep
      // their own clicks, so the last slide's links stay usable.
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return
        go(index + (e.clientX < window.innerWidth / 3 ? -1 : 1))
      }}
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return
        const dx = e.changedTouches[0].clientX - touchX.current
        if (Math.abs(dx) > 50) go(index + (dx < 0 ? 1 : -1))
        touchX.current = null
      }}
    >
      <div className="absolute origin-top-left" style={{ width: W, height: H, left, top, transform: `scale(${scale})` }}>
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div
            key={index}
            custom={dir}
            variants={{
              enter: (d: number) => ({ opacity: 0, x: d * 70, filter: 'blur(12px)' }),
              center: { opacity: 1, x: 0, filter: 'blur(0px)' },
              exit: (d: number) => ({ opacity: 0, x: d * -70, filter: 'blur(12px)' }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.55, ease: EASE }}
          >
            <Current />
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="absolute inset-x-0 top-0 h-[3px] bg-border">
        <motion.div
          className="h-full"
          style={{ background: 'linear-gradient(90deg, var(--accent), var(--usdc))' }}
          animate={{ width: `${((index + 1) / SLIDES.length) * 100}%` }}
          transition={{ duration: 0.6, ease: EASE }}
        />
      </div>
      <nav className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-card/80 px-3 py-2 backdrop-blur">
        <button aria-label="Previous slide" onClick={() => go(index - 1)} className="rounded-full p-1 text-foreground/70 hover:text-foreground">
          <ChevronLeft size={18} />
        </button>
        {SLIDES.map((_, i) => (
          <button
            key={i}
            aria-label={`Slide ${i + 1}`}
            onClick={() => go(i)}
            className={`h-2 rounded-full transition-all ${i === index ? 'w-6 bg-accent' : 'w-2 bg-foreground/30 hover:bg-foreground/60'}`}
          />
        ))}
        <button aria-label="Next slide" onClick={() => go(index + 1)} className="rounded-full p-1 text-foreground/70 hover:text-foreground">
          <ChevronRight size={18} />
        </button>
      </nav>
    </div>
  )
}

export default function Deck() {
  usePageMeta({
    title: 'A-Identity · Pitch Deck',
    description: 'The passport and wallet for AI agents, live on Arc Mainnet and settling in USDC through Circle.',
    noindex: true,
  })
  const print = useMemo(() => new URLSearchParams(window.location.search).has('print'), [])
  return print ? <PrintDeck /> : <LiveDeck />
}

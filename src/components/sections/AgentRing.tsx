import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useAnimationFrame, useReducedMotion } from 'framer-motion'
import { ArrowUpRight, X } from 'lucide-react'
import { CHAIN_BY_ID, type ChainId } from '../../lib/chains'
import ChainLogo from '../app/ChainLogo'
import { EASE_OUT_EXPO } from '../../lib/brand'

/**
 * Every ERC-8004 identity we hold, as a slowly turning ring of poster cards:
 * one card per agent, eight agents across seven networks. Avalanche is absent
 * because we hold no agent there, and the ring must never imply one.
 *
 * Look: portrait cards whose artwork ground is the chain's own brand color
 * (flat, no gradients) with the official mark on its ChainLogo disc, so every
 * mark keeps contrast on its own brand color. Type on the artwork flips
 * between ink and white by ground luminance. Back faces stay visible and pass
 * by mirrored, like the reference recording (agents-movie.mov).
 *
 * Clicking a card opens a page-like detail panel: the agent's mission, owner,
 * registry, registration tx and reputation anchor, every address linking out
 * through the explorer that derives from the generated chain registry. The
 * ring pauses while the panel is open.
 *
 * The agent list is a hand-typed mirror of public/.well-known/agent-card.json
 * `registrations` plus mcp/src/chains/provenance.ts; nothing here is invented
 * and the one agent with no recorded mint tx (#8913) says so instead of
 * faking a receipt.
 */

type OnchainAgent = {
  chain: ChainId
  tokenId: string
  owner: string
  tx?: string
  note: string
  mission: string
  anchor?: { score: number; tx: string }
}

const OWNER_EVM = '0xd305607510E0Db2c95807173c7A05BEA53c1ed36'
const OWNER_OKX = '0x169ead25d35c146f3f3a7d2936ae37eab2e256d1'
const OWNER_CELO = '0xF43F43D8aee114a71B164e1f6214BC7625a5742D'

const AGENTS: OnchainAgent[] = [
  {
    chain: 'xlayer',
    tokenId: '6271',
    owner: OWNER_OKX,
    tx: '0x03a614a902ed742526047dffa165378cb16350a81bf083d4672f6d7a9ecfb078',
    note: 'Listed on OKX.AI. The live paid Trust Oracle.',
    mission:
      'The live Trust Oracle on OKX.AI. Other agents pay it per call, in real stablecoins, to answer one question before money moves: can this counterparty be trusted? It sells verify_agent, reputation_score, risk_check and agent_passport over x402.',
  },
  {
    chain: 'rhchain',
    tokenId: '0',
    owner: OWNER_EVM,
    tx: '0x602ce85ad044836b39918311a3031dcd689e4be0d23aed9ed0ac9227d46ec79e',
    note: "The registry's first mint, and it is ours.",
    mission:
      'The identity behind the Robinhood Chain x402 rail, where paid trust calls settle in USDG through the facilitator we run ourselves. Token #0 is the first mint the mainnet registry ever recorded; its tokenURI points back at our public agent card.',
    anchor: { score: 60, tx: '0xe11d5d0f46a9b08b8fe6c623ad0f35e898a3c2db67937377083253fe6b260979' },
  },
  {
    chain: 'arbitrum',
    tokenId: '1259',
    owner: OWNER_EVM,
    tx: '0x23275840eb9a8b85a752769c113109a753f39b592236c85093cf94f6a517b2f3',
    note: 'Reputation anchored by our oracle validator.',
    mission:
      'The identity behind the Arbitrum One x402 rail, settling native Circle USDC through our own EIP-3009 facilitator. Arbitrum is the chain where our rail runs next to well-served alternatives, so it is where the receipts are easiest to compare.',
    anchor: { score: 60, tx: '0x435a5c62bda28db23505812b9deb93dfce7aff3831e8449a5274fd0e7ecc376a' },
  },
  {
    chain: 'base',
    tokenId: '73232',
    owner: OWNER_EVM,
    tx: '0xb428bf8e79df3c44157c134df1858eb75fe3758b74868445c1dcd07948705bf0',
    note: 'Reputation anchored by our oracle validator.',
    mission:
      'The identity behind the Base x402 rail, settling native Circle USDC through our own EIP-3009 facilitator. Its operating wallets were funded from Stellar pubnet USDC through a NEAR Intents swap, and that trail is part of the public ledger.',
    anchor: { score: 60, tx: '0x4f0295d12dcdc356cc7ac12b8317f1ff07289e4584725895f9b482a2223b2aa6' },
  },
  {
    chain: 'celo',
    tokenId: '9759',
    owner: OWNER_CELO,
    tx: '0x0a821026621e5b35ff5602f81348b276b0d0f1b61a3892365658295fc5bcb22e',
    note: 'The identity behind the Celo x402 rail.',
    mission:
      'The identity behind the Celo x402 rail, where payments settle in USDC through the first-party facilitator Celo runs. Deliberately owned by the same wallet that receives those payments, and its tokenURI points at our public agent card.',
  },
  {
    chain: 'arc',
    tokenId: '849980',
    owner: OWNER_EVM,
    tx: '0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54',
    note: 'Meridian. KYA attested on-chain.',
    mission:
      'Meridian, the phase-1 showcase research agent. It buys market data through the policy-gated wallet, its KYA wallet-control proof is attested on-chain through the ValidationRegistry, and its 542/1000 score comes from real platform settlement history.',
    anchor: { score: 542, tx: '0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c' },
  },
  {
    chain: 'xlayer',
    tokenId: '8913',
    owner: OWNER_OKX,
    note: 'Second listing on the same registry.',
    mission:
      'The second OKX.AI listing of the Trust Oracle, held on the same X Layer registry and the same wallet as #6271. No mint receipt is recorded in our ledger for this one, so its proof is the registry itself: ownerOf resolves it live.',
  },
  {
    chain: 'rhchain-testnet',
    tokenId: '0',
    owner: OWNER_EVM,
    tx: '0x20918ec68186bd4aaee7c36d33d0383f1bc6a2bc921e72e3b812d034da5212fd',
    note: 'Full registry family, rehearsed first.',
    mission:
      'The rehearsal identity. Robinhood testnet is the only chain family where all three canonical registries run together, so identity, reputation and validation were proven here, with test money, before anything touched mainnet.',
  },
]

/** Type on a brand-color ground: ink on the two near-white brands, white otherwise. */
function inkOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.62 ? 'rgba(15,23,42,0.9)' : 'rgba(255,255,255,0.95)'
}

const short = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`

/** Portrait poster card: flat brand-color artwork with the mark on its disc,
 *  paper footer below. Clicking opens the detail panel. */
function AgentCard({
  agent,
  index,
  onSelect,
  className,
}: {
  agent: OnchainAgent
  index: number
  onSelect: (a: OnchainAgent) => void
  className?: string
}) {
  const chain = CHAIN_BY_ID[agent.chain]
  const ink = inkOn(chain.color)
  return (
    <button
      type="button"
      onClick={() => onSelect(agent)}
      className={
        'relative flex h-[330px] w-[235px] shrink-0 cursor-pointer flex-col overflow-hidden rounded-[20px] border border-border bg-card text-left shadow-xl transition hover:border-accent/50 ' +
        (className ?? '')
      }
    >
      {/* Artwork: the chain's brand color as the ground, the mark on its disc */}
      <div className="relative h-[62%] w-full overflow-hidden border-b border-border" style={{ background: chain.color }}>
        <ChainLogo
          id={agent.chain}
          size={104}
          className="pointer-events-none absolute left-1/2 top-[44%] -translate-x-1/2 -translate-y-1/2 shadow-lg"
        />
        <div className="flex items-start justify-between p-4" style={{ color: ink }}>
          <div className="text-[11px] font-semibold uppercase leading-tight tracking-[0.08em]">
            A-Identity
            <br />
            Agents &copy;
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em]">
            {chain.testnet ? 'testnet' : 'mainnet'}
          </div>
        </div>
        <div className="absolute bottom-3 left-4 right-4" style={{ color: ink }}>
          <div className="font-mono text-[30px] font-bold leading-none tracking-tight">#{agent.tokenId}</div>
          <div className="mt-1 text-[13px] font-semibold">{chain.shortName}</div>
        </div>
      </div>
      {/* Paper footer */}
      <div className="flex h-[38%] w-full flex-col justify-between bg-card p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] leading-snug text-foreground/65">{agent.note}</p>
          <span className="shrink-0 font-mono text-[10px] text-foreground/45">
            [{index + 1}/{AGENTS.length}]
          </span>
        </div>
        <div className="flex items-end justify-between">
          <ChainLogo id={agent.chain} size={22} />
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent">
            details <ArrowUpRight size={11} />
          </span>
        </div>
      </div>
    </button>
  )
}

/** The page-like detail panel a card opens into. */
function AgentDetail({ agent, onClose }: { agent: OnchainAgent; onClose: () => void }) {
  const chain = CHAIN_BY_ID[agent.chain]
  const ink = inkOn(chain.color)
  const registry = chain.registries.identity
  const explorer = chain.explorer
  const rows: { label: string; value: string; href?: string }[] = [
    { label: 'Owner wallet', value: short(agent.owner), href: explorer ? `${explorer}/address/${agent.owner}` : undefined },
    ...(registry
      ? [{ label: 'Identity registry', value: short(registry), href: explorer ? `${explorer}/address/${registry}` : undefined }]
      : []),
    ...(agent.tx
      ? [{ label: 'Registration tx', value: short(agent.tx), href: explorer ? `${explorer}/tx/${agent.tx}` : undefined }]
      : [{ label: 'Registration tx', value: 'not recorded; ownerOf resolves it live' }]),
    ...(agent.anchor
      ? [
          {
            label: 'Reputation anchor',
            value: `${agent.anchor.score}/1000 on-chain`,
            href: explorer ? `${explorer}/tx/${agent.anchor.tx}` : undefined,
          },
        ]
      : [{ label: 'Reputation anchor', value: 'none on this chain yet' }]),
    { label: 'CAIP-2 network', value: chain.caip2 },
  ]
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Agent ${agent.tokenId} on ${chain.shortName}`}
    >
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 24, scale: 0.96 }}
        transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
        className="max-h-[86vh] w-full max-w-[540px] overflow-y-auto rounded-3xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Brand-color header, same ground as the card artwork */}
        <div className="relative p-6" style={{ background: chain.color, color: ink }}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 grid h-8 w-8 place-items-center rounded-full transition hover:opacity-70"
            style={{ color: ink }}
          >
            <X size={18} />
          </button>
          <div className="flex items-center gap-4">
            <ChainLogo id={agent.chain} size={56} className="shadow-lg" />
            <div>
              <div className="font-mono text-3xl font-bold leading-none tracking-tight">#{agent.tokenId}</div>
              <div className="mt-1.5 text-sm font-semibold">
                {chain.shortName}
                <span className="ml-2 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ borderColor: ink }}>
                  {chain.testnet ? 'testnet' : 'mainnet'}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-foreground/45">Mission</div>
          <p className="mt-2 text-[15px] leading-relaxed text-foreground/80">{agent.mission}</p>
          <div className="mt-6 overflow-hidden rounded-xl border border-border">
            {rows.map((r, i) => (
              <motion.div
                key={r.label}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.12 + i * 0.05, duration: 0.35, ease: EASE_OUT_EXPO }}
                className={`flex items-center justify-between gap-3 px-4 py-3 ${i > 0 ? 'border-t border-border' : ''}`}
              >
                <span className="text-[13px] text-foreground/60">{r.label}</span>
                {r.href ? (
                  <a
                    href={r.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-[13px] font-semibold text-accent hover:underline"
                  >
                    {r.value} <ArrowUpRight size={12} />
                  </a>
                ) : (
                  <span className="font-mono text-[13px] text-foreground/80">{r.value}</span>
                )}
              </motion.div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-foreground/50">
            Every link opens on {explorer ? new URL(explorer).hostname : 'the explorer'}, derived from the chain
            registry rather than typed by hand. Resolve agents by ownerOf, never by a card URL someone else can copy.
          </p>
        </div>
      </motion.div>
    </motion.div>
  )
}

/** The ring is authored at one fixed stage size and scaled down as a whole to
 *  fit narrower screens, so the 3D geometry never distorts: 860px of width is
 *  scale 1, anything narrower shrinks proportionally. */
const STAGE_W = 860
const STAGE_H = 430

/** The 3D ring. Cards sit on a circle and the whole circle turns. Back faces
 *  stay visible and pass by mirrored. Hover pauses; on touch a tap pauses it
 *  briefly; an open detail panel pauses it entirely. */
function Ring({ frozen, onSelect }: { frozen: boolean; onSelect: (a: OnchainAgent) => void }) {
  const measureRef = useRef<HTMLDivElement>(null)
  const ref = useRef<HTMLDivElement>(null)
  const angle = useRef(0)
  const touchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [paused, setPaused] = useState(false)
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const el = measureRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setScale(Math.min(1, el.clientWidth / STAGE_W))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => () => { if (touchTimer.current) clearTimeout(touchTimer.current) }, [])
  useAnimationFrame((_, delta) => {
    if (paused || frozen || !ref.current) return
    angle.current = (angle.current + delta * (360 / 46000)) % 360
    ref.current.style.transform = `rotateY(${angle.current}deg)`
  })
  const pauseForTouch = () => {
    setPaused(true)
    if (touchTimer.current) clearTimeout(touchTimer.current)
    touchTimer.current = setTimeout(() => setPaused(false), 3500)
  }
  const step = 360 / AGENTS.length
  const glow = `linear-gradient(100deg, ${AGENTS.map((a) => CHAIN_BY_ID[a.chain].color).join(', ')})`
  return (
    <div ref={measureRef} className="relative w-full" style={{ height: STAGE_H * scale }}>
      <div
        className="absolute left-1/2 top-0"
        style={{
          width: STAGE_W,
          height: STAGE_H,
          transform: `translateX(-50%) scale(${scale})`,
          transformOrigin: 'top center',
          perspective: '1500px',
        }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onTouchStart={pauseForTouch}
      >
        {/* Iridescent stage glow behind the carousel */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-[300px] w-[86%] -translate-x-1/2 -translate-y-1/2 rounded-[50%] opacity-25 blur-3xl"
          style={{ background: glow }}
        />
        <div ref={ref} className="absolute inset-0" style={{ transformStyle: 'preserve-3d' }}>
          {AGENTS.map((a, i) => (
            <div
              key={`${a.chain}-${a.tokenId}`}
              className="absolute left-1/2 top-1/2"
              style={{ transform: `translate(-50%, -50%) rotateY(${i * step}deg) translateZ(400px)` }}
            >
              <AgentCard agent={a} index={i} onSelect={onSelect} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function AgentRing() {
  const reduced = useReducedMotion()
  const [active, setActive] = useState<OnchainAgent | null>(null)
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setActive(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
      className="mt-12"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-heading)' }}>
          Every identity we hold
        </h3>
        <span className="font-mono text-xs text-foreground/55">
          8 agents · 7 networks · tap a card for its story
        </span>
      </div>
      {reduced ? null : (
        <div className="mt-4 hidden md:block">
          <Ring frozen={active !== null} onSelect={setActive} />
        </div>
      )}
      <div
        className={`-mx-5 mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-3 sm:-mx-8 sm:px-8 ${
          reduced ? 'md:mx-0 md:px-0' : 'md:hidden'
        }`}
      >
        {AGENTS.map((a, i) => (
          <AgentCard key={`${a.chain}-${a.tokenId}`} agent={a} index={i} onSelect={setActive} className="snap-start" />
        ))}
      </div>
      <AnimatePresence>{active && <AgentDetail agent={active} onClose={() => setActive(null)} />}</AnimatePresence>
    </motion.div>
  )
}

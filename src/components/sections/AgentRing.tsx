import { useEffect, useRef, useState } from 'react'
import { motion, useAnimationFrame, useReducedMotion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { CHAIN_BY_ID, type ChainId } from '../../lib/chains'
import ChainLogo from '../app/ChainLogo'
import { EASE_OUT_EXPO } from '../../lib/brand'

/**
 * Every ERC-8004 identity we hold, as a slowly turning ring of poster cards:
 * one card per agent, eight agents across seven networks. Avalanche is absent
 * because we hold no agent there, and the ring must never imply one.
 *
 * Each card is a real two-sided object. The front is the poster: the chain's
 * brand color as a flat ground (no gradients), the official mark on its
 * ChainLogo disc, type flipping between ink and white by ground luminance.
 * Clicking turns the card over IN PLACE, like a page, and the back carries
 * the agent's story: mission, owner, registry, registration tx, reputation
 * anchor, every address linking out through the explorer derived from the
 * generated chain registry. Cards passing the rear of the ring show their
 * backs naturally, the way a real carousel of cards would.
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
      'The live Trust Oracle on OKX.AI. Other agents pay it per call, in real stablecoins, to answer one question before money moves: can this counterparty be trusted?',
  },
  {
    chain: 'rhchain',
    tokenId: '0',
    owner: OWNER_EVM,
    tx: '0x602ce85ad044836b39918311a3031dcd689e4be0d23aed9ed0ac9227d46ec79e',
    note: "The registry's first mint, and it is ours.",
    mission:
      'The identity behind the Robinhood Chain x402 rail, settling USDG through our own facilitator. Token #0 is the first mint this mainnet registry ever recorded.',
    anchor: { score: 60, tx: '0xe11d5d0f46a9b08b8fe6c623ad0f35e898a3c2db67937377083253fe6b260979' },
  },
  {
    chain: 'arbitrum',
    tokenId: '1259',
    owner: OWNER_EVM,
    tx: '0x23275840eb9a8b85a752769c113109a753f39b592236c85093cf94f6a517b2f3',
    note: 'Reputation anchored by our oracle validator.',
    mission:
      'The identity behind the Arbitrum One x402 rail, settling native Circle USDC through our own EIP-3009 facilitator, next to well-served alternatives on purpose.',
    anchor: { score: 60, tx: '0x435a5c62bda28db23505812b9deb93dfce7aff3831e8449a5274fd0e7ecc376a' },
  },
  {
    chain: 'base',
    tokenId: '73232',
    owner: OWNER_EVM,
    tx: '0xb428bf8e79df3c44157c134df1858eb75fe3758b74868445c1dcd07948705bf0',
    note: 'Reputation anchored by our oracle validator.',
    mission:
      'The identity behind the Base x402 rail, settling native Circle USDC. Its operating wallets were funded from Stellar pubnet USDC through a NEAR Intents swap.',
    anchor: { score: 60, tx: '0x4f0295d12dcdc356cc7ac12b8317f1ff07289e4584725895f9b482a2223b2aa6' },
  },
  {
    chain: 'celo',
    tokenId: '9759',
    owner: OWNER_CELO,
    tx: '0x0a821026621e5b35ff5602f81348b276b0d0f1b61a3892365658295fc5bcb22e',
    note: 'The identity behind the Celo x402 rail.',
    mission:
      'The identity behind the Celo x402 rail, where payments settle in USDC through the first-party facilitator Celo runs. Owned by the wallet that receives those payments.',
  },
  {
    chain: 'arc',
    tokenId: '849980',
    owner: OWNER_EVM,
    tx: '0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54',
    note: 'Meridian. KYA attested on-chain.',
    mission:
      'Meridian, the phase-1 showcase research agent: buys market data through the policy-gated wallet, KYA attested on-chain, scored 542/1000 from real settlements.',
    anchor: { score: 542, tx: '0x3f5429819347fb0f75e66ee1416fc2c9ad3dade8fb1bf8dac1b9d2606de92a8c' },
  },
  {
    chain: 'xlayer',
    tokenId: '8913',
    owner: OWNER_OKX,
    note: 'Second listing on the same registry.',
    mission:
      'The second OKX.AI listing of the Trust Oracle, on the same X Layer registry and wallet as #6271. No mint receipt in our ledger; the registry itself is the proof.',
  },
  {
    chain: 'rhchain-testnet',
    tokenId: '0',
    owner: OWNER_EVM,
    tx: '0x20918ec68186bd4aaee7c36d33d0383f1bc6a2bc921e72e3b812d034da5212fd',
    note: 'Full registry family, rehearsed first.',
    mission:
      'The rehearsal identity. The only chain family where all three canonical registries run together, so identity, reputation and KYA were proven here with test money first.',
  },
]

const keyOf = (a: OnchainAgent) => `${a.chain}-${a.tokenId}`

/** Type on a brand-color ground: ink on the two near-white brands, white otherwise. */
function inkOn(hex: string): string {
  const n = parseInt(hex.replace('#', ''), 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.62 ? 'rgba(15,23,42,0.9)' : 'rgba(255,255,255,0.95)'
}

const short = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`

function FactRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-[10px] text-foreground/55">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-0.5 font-mono text-[10px] font-semibold text-accent hover:underline"
        >
          {value} <ArrowUpRight size={9} />
        </a>
      ) : (
        <span className="text-right font-mono text-[10px] text-foreground/75">{value}</span>
      )}
    </div>
  )
}

/** A two-sided poster card that flips in place. Front: the brand-color poster.
 *  Back: the agent's story and its on-chain facts. */
function AgentCard({
  agent,
  index,
  flipped,
  onToggle,
  className,
}: {
  agent: OnchainAgent
  index: number
  flipped: boolean
  onToggle: (key: string) => void
  className?: string
}) {
  const chain = CHAIN_BY_ID[agent.chain]
  const ink = inkOn(chain.color)
  const explorer = chain.explorer
  const registry = chain.registries.identity
  return (
    <button
      type="button"
      onClick={() => onToggle(keyOf(agent))}
      aria-pressed={flipped}
      className={'relative h-[330px] w-[235px] shrink-0 cursor-pointer text-left ' + (className ?? '')}
      style={{ perspective: '1100px' }}
    >
      <motion.div
        className="relative h-full w-full"
        style={{ transformStyle: 'preserve-3d' }}
        animate={{ rotateY: flipped ? 180 : 0 }}
        transition={{ duration: 0.7, ease: EASE_OUT_EXPO }}
      >
        {/* FRONT: the poster */}
        <div
          className="absolute inset-0 flex flex-col overflow-hidden rounded-[20px] border border-border bg-card shadow-xl transition hover:border-accent/50"
          style={{ backfaceVisibility: 'hidden' }}
        >
          <div className="relative h-[62%] w-full overflow-hidden border-b border-border" style={{ background: chain.color }}>
            <ChainLogo
              id={agent.chain}
              size={104}
              className="pointer-events-none absolute left-1/2 top-[46%] -translate-x-1/2 -translate-y-1/2 shadow-lg"
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
            <div className="absolute bottom-3 left-4 right-4 flex items-baseline justify-between" style={{ color: ink }}>
              <span className="text-[13px] font-semibold">{chain.shortName}</span>
              <span className="font-mono text-[13px] font-bold tracking-tight">#{agent.tokenId}</span>
            </div>
          </div>
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
                turn over <ArrowUpRight size={11} />
              </span>
            </div>
          </div>
        </div>
        {/* BACK: the story */}
        <div
          className="absolute inset-0 flex flex-col overflow-hidden rounded-[20px] border border-border bg-card shadow-xl"
          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
        >
          <div className="h-1.5 w-full shrink-0" style={{ background: chain.color }} />
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-foreground">{chain.shortName}</span>
              <span className="font-mono text-[11px] font-bold text-foreground/70">#{agent.tokenId}</span>
            </div>
            <p className="mt-2 overflow-y-auto text-[11px] leading-snug text-foreground/75">{agent.mission}</p>
            <div className="mt-auto divide-y divide-border border-t border-border pt-1">
              <FactRow label="Owner" value={short(agent.owner)} href={explorer ? `${explorer}/address/${agent.owner}` : undefined} />
              {agent.tx ? (
                <FactRow label="Mint tx" value={short(agent.tx)} href={explorer ? `${explorer}/tx/${agent.tx}` : undefined} />
              ) : (
                <FactRow
                  label="Mint tx"
                  value="ownerOf resolves live"
                  href={explorer && registry ? `${explorer}/address/${registry}` : undefined}
                />
              )}
              {agent.anchor ? (
                <FactRow
                  label="Anchor"
                  value={`${agent.anchor.score}/1000`}
                  href={explorer ? `${explorer}/tx/${agent.anchor.tx}` : undefined}
                />
              ) : (
                <FactRow label="Anchor" value="none yet" />
              )}
              <FactRow label="Network" value={chain.caip2} />
            </div>
            <div className="mt-2 text-right text-[10px] font-semibold text-accent">turn back</div>
          </div>
        </div>
      </motion.div>
    </button>
  )
}

/** The ring is authored at one fixed stage size and scaled down as a whole to
 *  fit narrower screens, so the 3D geometry never distorts: 860px of width is
 *  scale 1, anything narrower shrinks proportionally. */
const STAGE_W = 860
const STAGE_H = 430

/** The 3D ring. Cards sit on a circle and the whole circle turns. Hover
 *  pauses; on touch a tap pauses it briefly; a turned-over card pauses it
 *  entirely so the back can be read. */
function Ring({
  flippedKey,
  onToggle,
}: {
  flippedKey: string | null
  onToggle: (key: string) => void
}) {
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
    if (paused || flippedKey !== null || !ref.current) return
    // Negative rotateY so the front row of cards travels left to right:
    // clockwise when the ring is viewed from above.
    angle.current = (angle.current - delta * (360 / 46000)) % 360
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
              key={keyOf(a)}
              className="absolute left-1/2 top-1/2"
              style={{ transform: `translate(-50%, -50%) rotateY(${i * step}deg) translateZ(400px)`, transformStyle: 'preserve-3d' }}
            >
              <AgentCard agent={a} index={i} flipped={flippedKey === keyOf(a)} onToggle={onToggle} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function AgentRing() {
  const reduced = useReducedMotion()
  const [flippedKey, setFlippedKey] = useState<string | null>(null)
  const toggle = (key: string) => setFlippedKey((cur) => (cur === key ? null : key))
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
          8 agents · 7 networks · turn a card over for its story
        </span>
      </div>
      {reduced ? null : (
        <div className="mt-4 hidden md:block">
          <Ring flippedKey={flippedKey} onToggle={toggle} />
        </div>
      )}
      <div
        className={`-mx-5 mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-3 sm:-mx-8 sm:px-8 ${
          reduced ? 'md:mx-0 md:px-0' : 'md:hidden'
        }`}
      >
        {AGENTS.map((a, i) => (
          <AgentCard
            key={keyOf(a)}
            agent={a}
            index={i}
            flipped={flippedKey === keyOf(a)}
            onToggle={toggle}
            className="snap-start"
          />
        ))}
      </div>
    </motion.div>
  )
}

import { useRef, useState } from 'react'
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
 * The look follows the reference recording (agents-movie.mov): portrait cards
 * with a large gradient artwork over a paper footer, the front card reading
 * big through perspective, cards passing the back of the ring mirrored, and an
 * iridescent glow behind the whole carousel. The artwork gradient is built
 * from each chain's own brand color out of the generated registry.
 *
 * The agent list is a hand-typed mirror of public/.well-known/agent-card.json
 * `registrations` plus mcp/src/chains/provenance.ts. Explorer links derive
 * from `CHAIN_BY_ID`, never typed by hand; the tx hashes are the registration
 * mints those two files record.
 *
 * Motion: useAnimationFrame so hover pauses the spin exactly, and
 * prefers-reduced-motion (or a small screen) gets the same cards as a flat
 * snap-scroll row instead of a 3D carousel.
 */

type OnchainAgent = { chain: ChainId; tokenId: string; tx?: string; note: string }

const AGENTS: OnchainAgent[] = [
  {
    chain: 'xlayer',
    tokenId: '6271',
    tx: '0x03a614a902ed742526047dffa165378cb16350a81bf083d4672f6d7a9ecfb078',
    note: 'Listed on OKX.AI. The live paid Trust Oracle.',
  },
  {
    chain: 'rhchain',
    tokenId: '0',
    tx: '0x602ce85ad044836b39918311a3031dcd689e4be0d23aed9ed0ac9227d46ec79e',
    note: "The registry's first mint, and it is ours.",
  },
  {
    chain: 'arbitrum',
    tokenId: '1259',
    tx: '0x23275840eb9a8b85a752769c113109a753f39b592236c85093cf94f6a517b2f3',
    note: 'Reputation anchored by our oracle validator.',
  },
  {
    chain: 'base',
    tokenId: '73232',
    tx: '0xb428bf8e79df3c44157c134df1858eb75fe3758b74868445c1dcd07948705bf0',
    note: 'Reputation anchored by our oracle validator.',
  },
  {
    chain: 'celo',
    tokenId: '9759',
    tx: '0x0a821026621e5b35ff5602f81348b276b0d0f1b61a3892365658295fc5bcb22e',
    note: 'The identity behind the Celo x402 rail.',
  },
  {
    chain: 'arc',
    tokenId: '849980',
    tx: '0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54',
    note: 'Meridian. KYA attested on-chain.',
  },
  {
    chain: 'xlayer',
    tokenId: '8913',
    // No mint tx is recorded for this one, so the card opens the registry it
    // resolves on (ownerOf works there) rather than pretending to a receipt.
    note: 'Second listing on the same registry.',
  },
  {
    chain: 'rhchain-testnet',
    tokenId: '0',
    tx: '0x20918ec68186bd4aaee7c36d33d0383f1bc6a2bc921e72e3b812d034da5212fd',
    note: 'Full registry family, rehearsed first.',
  },
]

function agentHref(a: OnchainAgent): string | null {
  const chain = CHAIN_BY_ID[a.chain]
  if (!chain.explorer) return null
  if (a.tx) return `${chain.explorer}/tx/${a.tx}`
  const registry = chain.registries.identity
  return registry ? `${chain.explorer}/address/${registry}` : null
}

/** The official network mark, big, as the card's artwork. Mirrors the LOGO map
 *  in components/app/ChainLogo.tsx (testnets share their mainnet's mark). */
const MARK: Partial<Record<ChainId, string>> = {
  arc: '/chains/arc.svg',
  base: '/chains/base.svg',
  arbitrum: '/chains/arbitrum.svg',
  xlayer: '/chains/xlayer.svg',
  rhchain: '/chains/rhchain.svg',
  'rhchain-testnet': '/chains/rhchain.svg',
  celo: '/chains/celo.svg',
}

/** Marks too light to survive a white ground, same rule as ChainLogo's disc. */
const INK_GROUND = new Set<ChainId>(['rhchain', 'rhchain-testnet'])

/** Portrait poster card like the reference deck: the chain's own logo as the
 *  artwork on a flat ground, a paper footer below. No gradients. */
function AgentCard({ agent, index, className }: { agent: OnchainAgent; index: number; className?: string }) {
  const chain = CHAIN_BY_ID[agent.chain]
  const href = agentHref(agent)
  const dark = INK_GROUND.has(agent.chain)
  const ink = dark ? 'rgba(255,255,255,0.94)' : 'rgba(15,23,42,0.88)'
  const body = (
    <>
      {/* Artwork: the network mark, big and crisp on its own ground */}
      <div
        className="relative h-[62%] w-full overflow-hidden border-b border-border"
        style={{ background: dark ? '#192837' : '#ffffff' }}
      >
        <img
          src={MARK[agent.chain]}
          alt=""
          loading="lazy"
          decoding="async"
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-[44%] h-[110px] w-[110px] -translate-x-1/2 -translate-y-1/2 object-contain"
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
          {href && (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-accent">
              proof <ArrowUpRight size={11} />
            </span>
          )}
        </div>
      </div>
    </>
  )
  const cardClass =
    'relative flex h-[330px] w-[235px] shrink-0 flex-col overflow-hidden rounded-[20px] border border-border bg-card shadow-xl ' +
    (className ?? '')
  if (!href) return <div className={cardClass}>{body}</div>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cardClass} transition hover:border-accent/50`}>
      {body}
    </a>
  )
}

/** The 3D ring. Cards sit on a circle and the whole circle turns. Back faces
 *  stay visible and pass by mirrored, exactly like the reference recording. */
function Ring() {
  const ref = useRef<HTMLDivElement>(null)
  const angle = useRef(0)
  const [paused, setPaused] = useState(false)
  useAnimationFrame((_, delta) => {
    if (paused || !ref.current) return
    angle.current = (angle.current + delta * (360 / 46000)) % 360
    ref.current.style.transform = `rotateY(${angle.current}deg)`
  })
  const step = 360 / AGENTS.length
  const glow = `linear-gradient(100deg, ${AGENTS.map((a) => CHAIN_BY_ID[a.chain].color).join(', ')})`
  return (
    <div
      className="relative mx-auto h-[430px] w-full max-w-[860px]"
      style={{ perspective: '1500px' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
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
            <AgentCard agent={a} index={i} />
          </div>
        ))}
      </div>
    </div>
  )
}

export default function AgentRing() {
  const reduced = useReducedMotion()
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
          8 agents · 7 networks · every card opens its on-chain proof
        </span>
      </div>
      {reduced ? null : (
        <div className="mt-4 hidden md:block">
          <Ring />
        </div>
      )}
      <div className={`mt-6 flex snap-x gap-4 overflow-x-auto pb-2 ${reduced ? '' : 'md:hidden'}`}>
        {AGENTS.map((a, i) => (
          <AgentCard key={`${a.chain}-${a.tokenId}`} agent={a} index={i} className="snap-start" />
        ))}
      </div>
    </motion.div>
  )
}

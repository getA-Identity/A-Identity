import { useRef, useState } from 'react'
import { motion, useAnimationFrame, useReducedMotion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { CHAIN_BY_ID, type ChainId } from '../../lib/chains'
import ChainLogo from '../app/ChainLogo'
import { EASE_OUT_EXPO } from '../../lib/brand'

/**
 * Every ERC-8004 identity we hold, as a slowly turning ring of cards: one card
 * per agent, eight agents across seven networks. Avalanche is absent because we
 * hold no agent there, and the ring must never imply one.
 *
 * The agent list is a hand-typed mirror of public/.well-known/agent-card.json
 * `registrations` plus mcp/src/chains/provenance.ts. Explorer links derive from
 * the generated chain registry (`CHAIN_BY_ID`), never typed by hand; the tx
 * hashes are the registration mints those two files record.
 *
 * Motion: the ring spins via useAnimationFrame so hover pauses it exactly, and
 * prefers-reduced-motion (or a small screen) gets the same cards as a flat
 * snap-scroll row instead of a 3D carousel.
 */

type OnchainAgent = { chain: ChainId; tokenId: string; tx?: string; note: string }

const AGENTS: OnchainAgent[] = [
  {
    chain: 'xlayer',
    tokenId: '6271',
    tx: '0x03a614a902ed742526047dffa165378cb16350a81bf083d4672f6d7a9ecfb078',
    note: 'listed on OKX.AI',
  },
  {
    chain: 'rhchain',
    tokenId: '0',
    tx: '0x602ce85ad044836b39918311a3031dcd689e4be0d23aed9ed0ac9227d46ec79e',
    note: "the registry's first mint",
  },
  {
    chain: 'arbitrum',
    tokenId: '1259',
    tx: '0x23275840eb9a8b85a752769c113109a753f39b592236c85093cf94f6a517b2f3',
    note: 'reputation anchored on-chain',
  },
  {
    chain: 'base',
    tokenId: '73232',
    tx: '0xb428bf8e79df3c44157c134df1858eb75fe3758b74868445c1dcd07948705bf0',
    note: 'reputation anchored on-chain',
  },
  {
    chain: 'celo',
    tokenId: '9759',
    tx: '0x0a821026621e5b35ff5602f81348b276b0d0f1b61a3892365658295fc5bcb22e',
    note: 'behind the Celo x402 rail',
  },
  {
    chain: 'arc',
    tokenId: '849980',
    tx: '0x506b125f3a0481667e3a00dcb86f48cbcaa35c643af963365e9389b06a8f8e54',
    note: 'KYA attested, phase-1 showcase',
  },
  {
    chain: 'xlayer',
    tokenId: '8913',
    // No mint tx is recorded for this one, so the card opens the registry it
    // resolves on (ownerOf works there) rather than pretending to a receipt.
    note: 'second listing, same registry',
  },
  {
    chain: 'rhchain-testnet',
    tokenId: '0',
    tx: '0x20918ec68186bd4aaee7c36d33d0383f1bc6a2bc921e72e3b812d034da5212fd',
    note: 'full registry family rehearsal',
  },
]

function agentHref(a: OnchainAgent): string | null {
  const chain = CHAIN_BY_ID[a.chain]
  if (!chain.explorer) return null
  if (a.tx) return `${chain.explorer}/tx/${a.tx}`
  const registry = chain.registries.identity
  return registry ? `${chain.explorer}/address/${registry}` : null
}

function AgentCard({ agent, className }: { agent: OnchainAgent; className?: string }) {
  const chain = CHAIN_BY_ID[agent.chain]
  const href = agentHref(agent)
  const body = (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{ background: `radial-gradient(130% 85% at 50% 0%, ${chain.color}2e, transparent 70%)` }}
      />
      <div className="relative flex items-center justify-between">
        <ChainLogo id={agent.chain} size={34} />
        <span
          className="rounded-full border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ color: chain.color }}
        >
          {chain.testnet ? 'testnet' : 'mainnet'}
        </span>
      </div>
      <div className="relative mt-5 font-mono text-3xl font-bold tracking-tight text-foreground">
        #{agent.tokenId}
      </div>
      <div className="relative mt-1 text-sm font-semibold text-foreground/80">{chain.shortName}</div>
      <div className="relative mt-0.5 text-xs leading-snug text-foreground/55">{agent.note}</div>
      {href && (
        <div className="relative mt-auto inline-flex items-center gap-1 text-xs font-semibold text-accent">
          proof <ArrowUpRight size={12} />
        </div>
      )}
    </>
  )
  const cardClass =
    'relative flex h-[220px] w-[190px] shrink-0 flex-col rounded-2xl border border-border bg-card p-5 shadow-sm ' +
    (className ?? '')
  if (!href) return <div className={cardClass}>{body}</div>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${cardClass} transition hover:border-accent/50`}>
      {body}
    </a>
  )
}

/** The 3D ring. Cards sit on a circle and the whole circle turns; back faces are
 *  hidden, so at any moment the front half of the ring reads like the reference
 *  carousel instead of mirrored text. */
function Ring() {
  const ref = useRef<HTMLDivElement>(null)
  const angle = useRef(0)
  const [paused, setPaused] = useState(false)
  useAnimationFrame((_, delta) => {
    if (paused || !ref.current) return
    angle.current = (angle.current + delta * (360 / 42000)) % 360
    ref.current.style.transform = `rotateY(${angle.current}deg)`
  })
  const step = 360 / AGENTS.length
  return (
    <div
      className="relative mx-auto h-[300px] w-full max-w-[760px] overflow-visible"
      style={{ perspective: '1300px' }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div ref={ref} className="absolute inset-0" style={{ transformStyle: 'preserve-3d' }}>
        {AGENTS.map((a, i) => (
          <div
            key={`${a.chain}-${a.tokenId}`}
            className="absolute left-1/2 top-1/2"
            style={{
              transform: `translate(-50%, -50%) rotateY(${i * step}deg) translateZ(310px)`,
              backfaceVisibility: 'hidden',
            }}
          >
            <AgentCard agent={a} />
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
        <div className="mt-6 hidden md:block">
          <Ring />
        </div>
      )}
      <div className={`mt-6 flex snap-x gap-4 overflow-x-auto pb-2 ${reduced ? '' : 'md:hidden'}`}>
        {AGENTS.map((a) => (
          <AgentCard key={`${a.chain}-${a.tokenId}`} agent={a} className="snap-start" />
        ))}
      </div>
    </motion.div>
  )
}

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, BadgeCheck } from 'lucide-react'
import { reveal, revealAt } from '../ui/section'
import { CHAIN_BY_ID } from '../../lib/chains'
import { getJson } from '../../lib/rail'

/**
 * The Arc Mainnet spotlight: the one thing the landing wants a visitor to remember this
 * season, placed directly under the hero.
 *
 * The claim is worded to stay true forever and to be checked, not trusted. "Agent #0" is
 * the first token the canonical ERC-8004 identity registry on Arc Mainnet ever minted, and
 * it is ours; the card reads ownerOf(0) live through /api/proof/arc on every visit and says
 * which block it read. It deliberately does not say "the first agent on Arc": agents can
 * exist on Arc outside this registry, and we cannot count those.
 */

const ARC = CHAIN_BY_ID['arc-mainnet']
const ARC_GRADIENT = 'linear-gradient(155deg, #011667 0%, #3B1046 55%, #7B0E25 100%)'
const REGISTRY = ARC.registries.identity ?? ''

type Artifact = { kind: string; label: string; txHash: string; explorerUrl: string | null }
type Live = { reachable: boolean; blockNumber?: string; owner?: string; matchesLedger?: boolean }
type Net = { chain: string; agent?: { tokenId: string; owner: string }; artifactsLinked: Artifact[]; live: Live }

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

export default function ArcSpotlight() {
  const [net, setNet] = useState<Net | null>(null)

  useEffect(() => {
    let alive = true
    void getJson<{ networks: Net[] }>('/api/proof/arc').then((r) => {
      const n = r?.networks.find((x) => x.chain === ARC.id)
      if (alive && n) setNet(n)
    })
    return () => {
      alive = false
    }
  }, [])

  const mint = net?.artifactsLinked.find((a) => a.kind === 'mint')
  const verified = Boolean(net?.live.reachable && net.live.matchesLedger)
  const owner = net?.agent?.owner

  return (
    <section className="relative w-full bg-background px-5 py-12 sm:px-8 sm:py-16" aria-labelledby="arc-spotlight-title">
      <motion.div
        {...reveal}
        className="relative mx-auto max-w-[1100px] overflow-hidden rounded-[28px] text-white shadow-[0_30px_90px_-30px_rgba(59,16,70,0.65)]"
        style={{ background: ARC_GRADIENT }}
      >
        {/* Soft light in the corner and a faint grid, so the gradient reads as a surface
            rather than a flat fill. Both are decoration and hidden from assistive tech. */}
        <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '44px 44px' }}
        />

        <div className="relative grid items-center gap-10 p-7 sm:p-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-12 lg:p-14">
          <div>
            <motion.div {...revealAt(0)} className="flex flex-wrap items-center gap-2.5">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/10 ring-1 ring-white/20">
                <img src="/logos/arc-mark.webp" alt="" width={18} height={17} className="h-[17px] w-[18px]" />
              </span>
              <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/70">Arc Mainnet · Sep 16, 2026</span>
            </motion.div>

            <motion.h2
              {...revealAt(1)}
              id="arc-spotlight-title"
              className="mt-5 text-[clamp(2.4rem,5.6vw,4.2rem)] font-bold leading-[0.98] tracking-[-0.035em]"
              style={{ fontFamily: 'var(--font-heading)', textWrap: 'balance' }}
            >
              Agent #0 on Arc Mainnet.
            </motion.h2>

            <motion.p {...revealAt(2)} className="mt-5 max-w-[48ch] text-[17px] leading-relaxed text-white/75">
              The day Arc opened, A-Identity minted the first identity on its ERC-8004 registry, then put a spend vault
              holding real USDC and two payment rails beside it.
            </motion.p>

            <motion.div {...revealAt(3)} className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/arc"
                className="inline-flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-[#1b0f3a] transition-transform hover:scale-[1.03]"
              >
                See it on Arc <ArrowRight size={16} />
              </Link>
              {mint?.explorerUrl && (
                <a
                  href={mint.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-full border border-white/25 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                >
                  Open the mint <ArrowUpRight size={16} />
                </a>
              )}
            </motion.div>
          </div>

          {/* The passport: what the registry itself says about token #0, read live. */}
          <motion.div
            {...revealAt(2)}
            whileHover={{ rotate: -1, y: -4 }}
            transition={{ type: 'spring', stiffness: 260, damping: 22 }}
            className="relative mx-auto w-full max-w-[380px] rounded-2xl border border-white/20 bg-white/[0.08] p-6 backdrop-blur-md"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/55">ERC-8004 identity</div>
                <div className="mt-1 font-mono text-[11px] text-white/60">{REGISTRY ? short(REGISTRY) : ''}</div>
              </div>
              <img src="/logos/arc-mark.webp" alt="" width={22} height={21} className="h-[21px] w-[22px] opacity-80" />
            </div>

            <div className="mt-6 flex items-baseline gap-2">
              <span className="text-[64px] font-bold leading-none tracking-[-0.04em]" style={{ fontFamily: 'var(--font-heading)' }}>
                #0
              </span>
              <span className="text-sm font-semibold text-white/70">first mint</span>
            </div>

            <dl className="mt-6 grid gap-3 text-[13px]">
              <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-3">
                <dt className="text-white/55">Holder</dt>
                <dd className="font-semibold">A-Identity{owner ? <span className="ml-2 font-mono text-[11px] font-normal text-white/55">{short(owner)}</span> : null}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-3">
                <dt className="text-white/55">Network</dt>
                <dd className="font-mono text-[12px]">{ARC.caip2}</dd>
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-3">
                <dt className="text-white/55">On-chain check</dt>
                <dd className={`inline-flex items-center gap-1.5 font-semibold ${verified ? 'text-emerald-300' : 'text-white/60'}`}>
                  {verified ? (
                    <>
                      <BadgeCheck size={15} /> read live at block {Number(net?.live.blockNumber ?? 0).toLocaleString('en-US')}
                    </>
                  ) : (
                    <span className="inline-block h-3.5 w-28 animate-pulse rounded bg-white/15" />
                  )}
                </dd>
              </div>
            </dl>
          </motion.div>
        </div>
      </motion.div>
    </section>
  )
}

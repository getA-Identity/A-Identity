import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, ArrowUpRight } from 'lucide-react'
import { DOCS_URL } from '../../lib/brand'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'

/**
 * The stack, as a carousel (the base.org ecosystem stance).
 *
 * A snap-scrolling rail of bounded, art-forward tiles: copy up top, the palette
 * illustration bleeding out of the card's lower half, the last card peeking past
 * the viewport edge as the invitation to scroll. Round prev/next buttons ride the
 * heading; trackpads, touch and drag all work natively because the rail is real
 * overflow scroll with snap points, not a transform we fake ourselves.
 *
 * Every tile is something this product actually ships today, with its one-line
 * job and a link into the existing docs page. Nothing aspirational: the six
 * entries are the same six surfaces the footer and the docs site already commit to.
 */
const PROTOCOLS = [
  {
    tag: 'ERC-8004',
    color: '#7342E2',
    title: 'Verify',
    body: 'An on-chain passport for every agent, checkable by anyone before money moves.',
    art: '/art/art-seal.webp',
    alt: 'An embossed seal medallion with concentric rings',
    href: `${DOCS_URL}/protocols/erc-8004`,
  },
  {
    tag: 'x402',
    color: '#2775CA',
    title: 'Pay',
    body: 'HTTP 402 made real: pay-per-request APIs, settled in stablecoins.',
    art: '/art/art-gate.webp',
    alt: 'A toll gate with a glowing orb passing through',
    href: `${DOCS_URL}/protocols/x402`,
  },
  {
    tag: 'MCP',
    color: '#1AAB7A',
    title: 'Connect',
    body: 'One endpoint any agent framework can plug into, from Claude Code to a curl.',
    art: '/art/art-network.webp',
    alt: 'A ring of nodes orbiting a core',
    href: `${DOCS_URL}/protocols/mcp`,
  },
  {
    tag: 'Circle Nanopayments',
    color: '#0B53BF',
    title: 'Stream',
    body: 'Sub-cent settlement on Circle rails, gasless for the paying agent.',
    art: '/art/art-gateway.webp',
    alt: 'Two arcs bridging with a coin mid-flight',
    href: `${DOCS_URL}/protocols/nanopayments`,
  },
  {
    tag: 'ERC-8183',
    color: '#D97706',
    title: 'Escrow',
    body: 'Hire, deliver, release, with dispute and refund paths when a job goes sideways.',
    art: '/art/art-knot.webp',
    alt: 'Two ropes tied in a square knot',
    href: `${DOCS_URL}/protocols/escrow`,
  },
  {
    tag: 'Reputation',
    color: '#059669',
    title: 'Score',
    body: 'A deterministic 0 to 1000, computed from on-chain history rather than vibes.',
    art: '/art/art-guardrail.webp',
    alt: 'A sweeping curved rail traced by a light line',
    href: `${DOCS_URL}/concepts/reputation`,
  },
]

/** Card width + rail gap, the distance one arrow press travels. */
const STEP = 360 + 20

export default function ProtocolsWall() {
  const trackRef = useRef<HTMLDivElement>(null)
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(true)

  const sync = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    setCanPrev(el.scrollLeft > 4)
    setCanNext(el.scrollLeft < el.scrollWidth - el.clientWidth - 4)
  }, [])

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    sync()
    el.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('resize', sync)
    return () => {
      el.removeEventListener('scroll', sync)
      window.removeEventListener('resize', sync)
    }
  }, [sync])

  const nudge = (dir: -1 | 1) => trackRef.current?.scrollBy({ left: dir * STEP, behavior: 'smooth' })

  return (
    <SectionShell id="protocols" size="lg" backdrop="protocols">
      <div className="flex items-end justify-between gap-6">
        <SectionIntro
          eyebrow={<Eyebrow>The stack</Eyebrow>}
          heading={
            <DisplayHeading size="section" className="max-w-[14ch]">
              Six protocols, one passport.
            </DisplayHeading>
          }
          lede={
            <Lede>
              Everything an agent needs to be trusted with money, each piece open and each one
              live today. Click through for the reference.
            </Lede>
          }
        />
        {/* The rail controls, riding the heading the way base.org rides its. */}
        <motion.div {...reveal} className="mb-1 hidden shrink-0 gap-2 sm:flex">
          <button
            type="button"
            aria-label="Scroll carousel left"
            onClick={() => nudge(-1)}
            disabled={!canPrev}
            className="grid h-11 w-11 place-items-center rounded-full border border-border bg-card text-foreground transition enabled:hover:border-accent/50 enabled:hover:text-accent disabled:opacity-30"
          >
            <ArrowLeft size={17} />
          </button>
          <button
            type="button"
            aria-label="Scroll carousel right"
            onClick={() => nudge(1)}
            disabled={!canNext}
            className="grid h-11 w-11 place-items-center rounded-full border border-border bg-card text-foreground transition enabled:hover:border-accent/50 enabled:hover:text-accent disabled:opacity-30"
          >
            <ArrowRight size={17} />
          </button>
        </motion.div>
      </div>

      {/* The rail. Full-bleed to the viewport's right edge so the next card peeks,
          padded back so the first card still sits on the content axis. Native
          overflow scroll + mandatory snap points; the scrollbar is hidden. */}
      <div
        ref={trackRef}
        /* snap-proximity, not mandatory: mandatory snapping fights diagonal trackpad
           gestures and makes the page's vertical scroll stutter over the rail.
           overscroll-x-contain keeps a rail overshoot from chaining into the page. */
        /* Trailing inset via an ::after spacer rather than padding-right, which flex
           scrollers are allowed to swallow: scrolled to the end, the last card now
           stops on the same content axis the first card starts on. The spacer is
           inset minus the 20px the gap already contributes. */
        className="mt-12 flex snap-x snap-proximity gap-5 overflow-x-auto overscroll-x-contain pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden mx-[calc(50%-50vw)] w-screen pl-[max(calc((100vw-1100px)/2),20px)] scroll-px-[max(calc((100vw-1100px)/2),20px)] after:block after:w-[max(calc((100vw-1100px)/2-20px),1px)] after:shrink-0 after:content-['']"
      >
        {PROTOCOLS.map((p, i) => (
          <motion.a
            key={p.tag}
            {...revealAt(i % 3)}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            /* The protocol's own color leads the card: a top rule in full strength,
               a tinted surface, a matching tag, and a border that goes brand on hover. */
            className="group relative flex h-[420px] shrink-0 snap-start basis-[min(85vw,360px)] flex-col overflow-hidden rounded-2xl border transition-colors"
            style={{
              borderColor: `color-mix(in srgb, ${p.color} 22%, var(--border))`,
              background: `linear-gradient(180deg, color-mix(in srgb, ${p.color} 9%, var(--card)) 0%, var(--card) 62%)`,
            }}
          >
            <span
              aria-hidden="true"
              className="absolute inset-x-0 top-0 h-1 transition-all duration-300 group-hover:h-1.5"
              style={{ background: p.color }}
            />
            <div className="p-6 pb-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xl font-bold tracking-tight text-foreground">{p.title}</h3>
                <span
                  className="rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
                  style={{
                    color: p.color,
                    background: `color-mix(in srgb, ${p.color} 14%, transparent)`,
                  }}
                >
                  {p.tag}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-foreground/55">{p.body}</p>
              <span
                className="mt-3 inline-flex items-center gap-1 text-sm font-semibold opacity-0 transition-opacity group-hover:opacity-100"
                style={{ color: p.color }}
              >
                Read the docs <ArrowUpRight size={13} />
              </span>
            </div>
            <div className="mt-auto overflow-hidden">
              <img
                src={p.art}
                alt={p.alt}
                loading="lazy"
                decoding="async"
                className="h-[200px] w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
              />
            </div>
          </motion.a>
        ))}
      </div>
    </SectionShell>
  )
}

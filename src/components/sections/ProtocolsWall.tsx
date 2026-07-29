import { motion } from 'framer-motion'
import { ArrowUpRight } from 'lucide-react'
import { DOCS_URL } from '../../lib/brand'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, revealAt } from '../ui/section'

/**
 * The stack, one box per protocol.
 *
 * The base.org lesson: a wall of bounded, art-forward tiles reads as an ecosystem in a way
 * a bullet list never does. Every tile here is something this product actually ships today,
 * with its one-line job and a link into the existing docs page. Nothing aspirational: the
 * six entries are the same six surfaces the footer and the docs site already commit to.
 *
 * The art is the palette illustration set from /public/art, so the wall doubles as the
 * place where that batch earns its keep.
 */
const PROTOCOLS = [
  {
    tag: 'ERC-8004',
    title: 'Verify',
    body: 'An on-chain passport for every agent, checkable by anyone before money moves.',
    art: '/art/art-seal.webp',
    alt: 'An embossed seal medallion with concentric rings',
    href: `${DOCS_URL}/protocols/erc-8004`,
  },
  {
    tag: 'x402',
    title: 'Pay',
    body: 'HTTP 402 made real: pay-per-request APIs, settled in stablecoins.',
    art: '/art/art-gate.webp',
    alt: 'A toll gate with a glowing orb passing through',
    href: `${DOCS_URL}/protocols/x402`,
  },
  {
    tag: 'MCP',
    title: 'Connect',
    body: 'One endpoint any agent framework can plug into, from Claude Code to a curl.',
    art: '/art/art-network.webp',
    alt: 'A ring of nodes orbiting a core',
    href: `${DOCS_URL}/protocols/mcp`,
  },
  {
    tag: 'Circle Nanopayments',
    title: 'Stream',
    body: 'Sub-cent settlement on Circle rails, gasless for the paying agent.',
    art: '/art/art-gateway.webp',
    alt: 'Two arcs bridging with a coin mid-flight',
    href: `${DOCS_URL}/protocols/nanopayments`,
  },
  {
    tag: 'ERC-8183',
    title: 'Escrow',
    body: 'Hire, deliver, release, with dispute and refund paths when a job goes sideways.',
    art: '/art/art-knot.webp',
    alt: 'Two ropes tied in a square knot',
    href: `${DOCS_URL}/protocols/escrow`,
  },
  {
    tag: 'Reputation',
    title: 'Score',
    body: 'A deterministic 0 to 1000, computed from on-chain history rather than vibes.',
    art: '/art/art-guardrail.webp',
    alt: 'A sweeping curved rail traced by a light line',
    href: `${DOCS_URL}/concepts/reputation`,
  },
]

export default function ProtocolsWall() {
  return (
    <SectionShell id="protocols" size="lg">
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

      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {PROTOCOLS.map((p, i) => (
          <motion.a
            key={p.tag}
            {...revealAt(i % 3)}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            className="group overflow-hidden rounded-3xl border border-border bg-card transition-colors hover:border-accent/40"
          >
            <div className="aspect-[4/3] overflow-hidden">
              <img
                src={p.art}
                alt={p.alt}
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
              />
            </div>
            <div className="p-5">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-bold tracking-tight text-foreground">{p.title}</h3>
                <span className="rounded-md bg-foreground/[0.06] px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-foreground/50">
                  {p.tag}
                </span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-foreground/55">{p.body}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent opacity-0 transition-opacity group-hover:opacity-100">
                Read the docs <ArrowUpRight size={13} />
              </span>
            </div>
          </motion.a>
        ))}
      </div>
    </SectionShell>
  )
}

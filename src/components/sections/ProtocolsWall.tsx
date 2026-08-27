import type { CSSProperties } from 'react'
import { motion } from 'framer-motion'
import { ArrowUpRight, Boxes, Fingerprint, Gauge, Plug, Trophy, Zap } from 'lucide-react'
import { DOCS_URL } from '../../lib/brand'
import { CHAINS, type ChainId, type ChainStatus } from '../../lib/chains'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, SectionIntro, reveal, revealAt } from '../ui/section'

/**
 * The stack, as a plain grid.
 *
 * This used to be a snap-scrolling rail of 420px art cards, which meant three of the six
 * protocols were off-screen and the copy on the visible three described a standard rather
 * than a thing you can do. Both problems had the same cause: the section was selling the
 * architecture instead of the product.
 *
 * So: six cards, all six on screen from lg up, and each one says the concrete job it does
 * plus where in the console you do it. The protocol name drops to a quiet mono tag,
 * because a person deciding whether to sign up does not care that escrow is ERC-8183;
 * they care that the money waits until the work lands. The colour survives only as the
 * icon tile, which is enough to tell the cards apart and calm enough to read as one grid.
 *
 * Nothing here is aspirational: every card points at a surface that exists today, and the
 * status line under the grid is derived from the generated chain registry rather than
 * typed by hand, so it cannot drift away from what is actually wired.
 */
const PROTOCOLS = [
  {
    tag: 'ERC-8004',
    color: '#7342E2',
    Icon: Fingerprint,
    title: 'Give your agent an ID',
    body: 'Register an agent and it gets an on-chain passport on Arc, plus a wallet proof anyone can check before they trust it with money.',
    whereLabel: 'Console',
    where: 'Agent ID',
    href: `${DOCS_URL}/protocols/erc-8004`,
  },
  {
    tag: 'x402',
    color: '#2775CA',
    Icon: Zap,
    title: 'Charge per call',
    body: "Put a price on your agent's API and it answers only once the payment lands. Our own trust checks already sell this way, settled in stablecoins.",
    whereLabel: 'Console',
    where: 'Settlements, Agent commerce tab',
    href: `${DOCS_URL}/protocols/x402`,
  },
  {
    tag: 'MCP',
    color: '#1AAB7A',
    Icon: Plug,
    title: 'Plug in from any framework',
    body: 'One endpoint your agent connects to: look up an agent, hire one, check a payment against its limits. Claude Code, Cursor or a plain curl all work, and reads need no key.',
    whereLabel: 'For your agent',
    where: 'any MCP client',
    href: `${DOCS_URL}/protocols/mcp`,
  },
  {
    tag: 'Circle Nanopayments',
    color: '#0B53BF',
    Icon: Gauge,
    title: 'Pay fractions of a cent',
    body: 'Sub-cent USDC, authorised off-chain and settled in batches through Circle Gateway, so the paying agent never needs gas.',
    whereLabel: 'Console',
    where: 'Settlements, Agent commerce tab',
    href: `${DOCS_URL}/protocols/nanopayments`,
  },
  {
    tag: 'ERC-8183',
    color: '#D97706',
    Icon: Boxes,
    title: 'Hold the money until the work lands',
    body: 'Hire another agent and the USDC waits in escrow on Arc. It releases on delivery, or refunds you in the same transaction when the work is rejected.',
    whereLabel: 'Console',
    where: 'Marketplace, paid out in Earnings',
    href: `${DOCS_URL}/protocols/escrow`,
  },
  {
    tag: 'Reputation',
    color: '#059669',
    Icon: Trophy,
    title: 'See who is worth paying',
    body: 'Every agent carries a score from 0 to 1000, computed from settled payments, validation and tenure. The marketplace ranks by it and your dashboard shows yours.',
    whereLabel: 'Console',
    where: 'Dashboard and Marketplace',
    href: `${DOCS_URL}/concepts/reputation`,
  },
]

/**
 * A testnet mirror that says nothing its mainnet twin does not is dropped from the status
 * line; everything else is read from src/lib/chains.ts, which is generated from
 * mcp/src/chains/registry.ts. A promotion in the registry moves this sentence with it.
 *
 * This was a hand-written set of two, and it was missing the third. `stellar-testnet` sat
 * outside it, so the public sentence read "Stellar, Stellar test and Base are in beta":
 * a testnet named in a marketing line, immediately after its own mainnet twin, adding a
 * name without adding information. That is the exact case this rule exists to remove, and
 * a list you have to remember to extend is how it got missed.
 *
 * Derived instead. A chain is a mirror when it is a testnet AND some mainnet chain here
 * shares its name root, which is what "mirror" means: Stellar Testnet mirrors Stellar,
 * Celo Sepolia mirrors Celo, Robinhood Chain Testnet mirrors Robinhood Chain. Arc has no
 * mainnet twin, so it stays in the sentence, which is correct: Arc is the one testnet this
 * product genuinely runs on and the line goes on to say so in as many words.
 */
const isMirror = (c: { id: ChainId; testnet: boolean }) =>
  c.testnet && CHAINS.some((o) => !o.testnet && o.id !== c.id && c.id.startsWith(`${o.id}-`))

/** Console column-width names get their real ones in prose. */
const nameOf = (id: ChainId, shortName: string) =>
  id === 'rhchain' ? 'Robinhood Chain' : id === 'rhchain-testnet' ? 'Robinhood Chain Testnet' : shortName

const chainsWith = (status: ChainStatus) =>
  CHAINS.filter((c) => c.status === status && !isMirror(c)).map((c) => nameOf(c.id, c.shortName))

/** "a, b and c". */
function listOf(names: string[]) {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const LIVE = chainsWith('live')
const BETA = chainsWith('beta')
const PLANNED = chainsWith('planned')

const CHAIN_LINE = [
  LIVE.length > 0 ? `Live on ${listOf(LIVE)} today.` : '',
  BETA.length > 0 ? `${listOf(BETA)} ${BETA.length === 1 ? 'is' : 'are'} in beta.` : '',
  PLANNED.length > 0 ? `${listOf(PLANNED)} ${PLANNED.length === 1 ? 'is' : 'are'} planned.` : '',
]
  .filter(Boolean)
  .join(' ')

export default function ProtocolsWall() {
  return (
    <SectionShell id="protocols" size="lg" backdrop="protocols">
      <SectionIntro
        eyebrow={<Eyebrow>The stack</Eyebrow>}
        heading={
          <DisplayHeading size="section" className="max-w-[18ch]">
            Six protocols, and what each one lets you do.
          </DisplayHeading>
        }
        lede={
          <Lede className="text-foreground/70">
            Open standards under the hood. In the console each one is a button: register an
            agent, charge per call, hold money in escrow, check who you are about to pay.
          </Lede>
        }
      />

      {/* All six on one screen from lg up. Two columns at sm, one below that, so the set
          is still a set on a 360px phone instead of a rail with five cards hidden. */}
      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PROTOCOLS.map((p, i) => (
          <motion.a
            key={p.tag}
            {...revealAt(i % 3)}
            href={p.href}
            target="_blank"
            rel="noopener noreferrer"
            /* The protocol colour rides one custom property, so the icon tile can lift it
               toward white under the scoped .dark class. A deep blue at full strength on a
               dark card is a smudge; mixed with white it stays the same brand hue and
               stays legible. */
            style={{ '--pc': p.color } as CSSProperties}
            className="group flex h-full flex-col rounded-2xl border border-border bg-card p-5 transition-colors duration-200 hover:border-accent/40 hover:bg-[color-mix(in_srgb,var(--color-accent)_4%,var(--card))] sm:p-6"
          >
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--pc)_12%,var(--card))] text-[color:var(--pc)] dark:bg-[color-mix(in_srgb,var(--pc)_20%,var(--card))] dark:text-[color-mix(in_srgb,var(--pc)_55%,white)]">
                <p.Icon size={18} aria-hidden="true" />
              </span>
              <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/45">
                {p.tag}
              </span>
            </div>

            <h3 className="mt-4 text-lg font-bold leading-snug tracking-tight text-foreground">
              {p.title}
            </h3>
            <p className="mt-2 text-[15px] leading-relaxed text-foreground/60">{p.body}</p>

            <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-5">
              <span className="text-xs text-foreground/45">
                <span className="font-semibold text-foreground/65">{p.whereLabel}</span> · {p.where}
              </span>
              {/* ml-auto, not just justify-between: when the console line is long enough
                  to wrap, this keeps the docs link on the right edge instead of stranding
                  it under the start of the row. */}
              <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-foreground/45 transition-colors group-hover:text-accent">
                Docs <ArrowUpRight size={12} />
              </span>
            </div>
          </motion.a>
        ))}
      </div>

      <motion.p
        {...reveal}
        transition={{ ...reveal.transition, delay: 0.12 }}
        className="mt-6 max-w-[70ch] text-sm leading-relaxed text-foreground/50"
      >
        {CHAIN_LINE} Identity and escrow settle on Arc, which is a public testnet: real
        contracts, real transactions, test money.
      </motion.p>
    </SectionShell>
  )
}

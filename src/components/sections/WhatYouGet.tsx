import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, reveal } from '../ui/section'
import { cn } from '../../lib/utils'

/**
 * What A-Identity gives an agent. Same three claims as always, staged as one
 * accent-tinted panel (the dashx compliance-panel stance): eyebrow top-left, the
 * heading, lede and a claim selector anchored bottom-left, and on the right a
 * layered cluster of frosted "document window" cards, each one the paper trail
 * of a claim: the KYA verification log, the spend policy, the risk verdict.
 *
 * The cluster is interactive: the selector buttons, or hovering/clicking a
 * window, bring that claim's card to the front slot with a spring, while the
 * other two dim into the back slots. Because the cards share slots instead of
 * each owning a strip of vertical space, the panel stays under 90vh.
 *
 * Slot positions are framer-motion `animate` transforms on plain grid-stacked
 * wrappers, so they never depend on a positioned ancestor and never race
 * another animation. Two skeleton windows bleed past the panel edges for
 * depth and are cropped by overflow-hidden on purpose. Everything is semantic
 * tokens + the brand accent, so the panel holds in both themes inside the
 * landing's scoped dark.
 */

type Row = { label: string; value: string; tone?: 'accent' | 'ok' }

const CARDS: {
  doc: string
  term: string
  rows: Row[]
  note: string
}[] = [
  {
    doc: 'KYA Verification Log',
    term: 'A verifiable identity',
    rows: [
      { label: 'Agent', value: 'Meridian #849980' },
      { label: 'Status', value: 'Verified', tone: 'ok' },
      { label: 'Method', value: 'Wallet-proof KYA' },
      { label: 'Registry', value: 'ERC-8004 on Arc' },
    ],
    note: 'An ERC-8004 passport and a Know Your Agent check, so anyone can confirm who an agent is before trusting it with money or work.',
  },
  {
    doc: 'Spend Policy',
    term: 'A wallet with limits',
    rows: [
      { label: 'Daily cap', value: '$50.00' },
      { label: 'Auto-approve', value: 'up to $5.00' },
      { label: 'Freeze switch', value: 'Armed', tone: 'accent' },
    ],
    note: 'Spend caps, payee allowlists and a freeze switch, enforced on-chain. An agent can pay on its own, but never past the line you draw.',
  },
  {
    doc: 'Risk Verdict',
    term: 'Verify-first payments',
    rows: [
      { label: 'Counterparty', value: 'agent #4471' },
      { label: 'Verdict', value: 'ALLOW', tone: 'ok' },
      { label: 'Reputation', value: '539 / 1000' },
      { label: 'Sybil check', value: 'Clear' },
    ],
    note: 'Before any transfer, a live check on the counterparty returns allow, warn, or deny. Unknown or flagged agents get denied, not funded.',
  },
]

/** Where a card can sit on desktop: two dimmed back slots and the front slot. */
const BACK_SLOTS = [
  { x: 8, y: 16, scale: 0.96, opacity: 0.55 },
  { x: 495, y: 8, scale: 0.96, opacity: 0.55 },
] as const
const FRONT_SLOT = { x: 250, y: 225, scale: 1, opacity: 1 } as const

/** The selector and the slot choreography only exist from lg up. */
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const sync = () => setIsDesktop(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])
  return isDesktop
}

/** The three-dot title bar every window card shares. */
function WindowChrome() {
  return (
    <div className="flex items-center gap-1.5 border-b border-border/60 px-4 py-2.5">
      <span className="h-2 w-2 rounded-full bg-foreground/15" />
      <span className="h-2 w-2 rounded-full bg-foreground/15" />
      <span className="h-2 w-2 rounded-full bg-foreground/15" />
    </div>
  )
}

/** A grey placeholder line, for the decorative windows. */
function Bar({ className = '' }: { className?: string }) {
  return <div className={cn('h-2.5 rounded-full bg-foreground/10', className)} />
}

function WindowCard({ doc, term, rows, note }: (typeof CARDS)[number]) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card/75 shadow-[0_24px_60px_-24px_rgba(16,24,40,0.35)] backdrop-blur-xl">
      <WindowChrome />
      <div className="p-5">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/40">
          {doc}
        </p>
        <p className="mt-1 text-lg font-bold tracking-tight text-foreground">{term}</p>
        <dl className="mt-4 flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-4 text-sm">
              <dt className="text-foreground/45">{r.label}</dt>
              <dd
                className={cn(
                  'text-right font-semibold',
                  r.tone === 'accent' && 'text-accent',
                  r.tone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
                  !r.tone && 'text-foreground',
                )}
              >
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 border-t border-border/60 pt-4 text-sm leading-relaxed text-foreground/55">
          {note}
        </p>
      </div>
    </div>
  )
}

/** A depth-only window: chrome + skeleton lines, no content. Hidden from readers. */
function GhostWindow({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'rounded-2xl border border-border/60 bg-card/50 shadow-[0_24px_60px_-24px_rgba(16,24,40,0.25)] backdrop-blur-lg',
        className,
      )}
    >
      <WindowChrome />
      <div className="flex flex-col gap-3 p-5">
        <Bar className="w-3/5" />
        <Bar className="w-4/5" />
        <Bar className="w-2/4" />
        <Bar className="w-3/4" />
        <Bar className="w-2/5" />
      </div>
    </div>
  )
}

export default function WhatYouGet() {
  const [active, setActive] = useState(2)
  const isDesktop = useIsDesktop()
  const inactive = CARDS.map((_, i) => i).filter((i) => i !== active)

  return (
    <SectionShell size="lg" surface="card" width="wide" backdrop="claims">
      <motion.div
        {...reveal}
        className="relative overflow-hidden rounded-[24px] border border-border bg-[color-mix(in_srgb,var(--color-accent)_5%,var(--card))] shadow-[0_12px_44px_-16px_rgba(25,40,55,0.25)] dark:bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--card))]"
      >
        <div className="flex flex-col lg:min-h-[min(660px,90vh)] lg:flex-row lg:justify-between">
          {/* Left: eyebrow pinned top; heading, lede and the claim selector anchored
              bottom (dashx stance). */}
          <div className="flex shrink-0 flex-col p-7 sm:p-10 lg:w-[440px] lg:p-12">
            <Eyebrow className="text-foreground/50">What every agent gets</Eyebrow>
            <div className="mt-8 lg:mt-auto lg:pt-10">
              <DisplayHeading size="section" className="max-w-[16ch]">
                What every agent gets.
              </DisplayHeading>
              <Lede className="mt-5">
                Two things an agent does not have today, and the one rule that ties them
                together.
              </Lede>

              {/* Claim selector: brings the matching window to the front. */}
              <div className="mt-8 hidden flex-col gap-2 lg:flex" role="tablist" aria-label="Agent claims">
                {CARDS.map((c, i) => (
                  <button
                    key={c.term}
                    type="button"
                    role="tab"
                    aria-selected={active === i}
                    onClick={() => setActive(i)}
                    className={cn(
                      'flex items-baseline gap-3 rounded-xl border px-4 py-3 text-left text-sm font-semibold transition-colors duration-200',
                      active === i
                        ? 'border-accent/40 bg-accent/15 text-accent dark:text-[color-mix(in_srgb,var(--color-accent)_50%,white)]'
                        : 'border-transparent text-foreground/55 hover:bg-accent/10 hover:text-foreground/80',
                    )}
                  >
                    <span className="font-mono text-xs opacity-60">{i + 1}</span>
                    {c.term}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right: the layered window cluster. A plain column on small screens; from lg
              up, a single-cell grid stack where framer-motion springs each card between
              the front slot and the two dimmed back slots. */}
          <div className="relative flex flex-col gap-5 p-7 pt-0 sm:p-10 sm:pt-0 lg:grid lg:flex-1 lg:place-items-start lg:p-0">
            {/* Accent glow behind the cluster. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute right-[-10%] top-[10%] hidden h-[80%] w-[90%] rounded-full bg-[radial-gradient(closest-side,rgba(115,66,226,0.28),transparent)] lg:block"
            />

            <div className="hidden lg:col-start-1 lg:row-start-1 lg:block lg:w-[280px] lg:translate-x-[555px] lg:translate-y-[-24px]">
              <GhostWindow />
            </div>
            <div className="hidden lg:col-start-1 lg:row-start-1 lg:block lg:w-[300px] lg:translate-x-[70px] lg:translate-y-[450px]">
              <GhostWindow />
            </div>

            {CARDS.map((c, i) => {
              const slot = i === active ? FRONT_SLOT : BACK_SLOTS[inactive.indexOf(i)]
              return (
                <motion.div
                  key={c.term}
                  initial={{ opacity: 0 }}
                  animate={
                    isDesktop
                      ? { x: slot.x, y: slot.y, scale: slot.scale, opacity: slot.opacity }
                      : { x: 0, y: 0, scale: 1, opacity: 1 }
                  }
                  transition={{ type: 'spring', stiffness: 230, damping: 28 }}
                  style={{ zIndex: i === active ? 40 : 10 + i }}
                  /* Activation is click-only: activating on mouseenter would ping-pong
                     forever when a swapped-in card lands under a resting cursor. */
                  whileHover={isDesktop && i !== active ? { scale: 0.99, opacity: 0.85 } : undefined}
                  onClick={() => setActive(i)}
                  className="lg:col-start-1 lg:row-start-1 lg:w-[330px] lg:cursor-pointer"
                >
                  <WindowCard {...c} />
                </motion.div>
              )
            })}
          </div>
        </div>
      </motion.div>
    </SectionShell>
  )
}

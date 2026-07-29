import { motion } from 'framer-motion'
import { DisplayHeading, Eyebrow, Lede } from '../ui/display'
import { SectionShell, reveal } from '../ui/section'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { cn } from '../../lib/utils'

/**
 * What A-Identity gives an agent. Same three claims as always, now staged as one
 * accent-tinted panel (the dashx compliance-panel stance): eyebrow top-left, the
 * heading and lede anchored bottom-left, and on the right a layered cluster of
 * frosted "document window" cards, each one the paper trail of a claim: the KYA
 * verification log, the spend policy, the pre-payment risk verdict. Two extra
 * skeleton windows sit behind and below purely for depth; the bottom one bleeds
 * past the panel edge and is cropped by overflow-hidden on purpose.
 *
 * Everything is semantic tokens + the brand accent, so the panel holds in both
 * themes inside the landing's scoped dark.
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

function WindowCard({
  doc,
  term,
  rows,
  note,
  className = '',
  delay = 0,
}: {
  doc: string
  term: string
  rows: Row[]
  note: string
  className?: string
  delay?: number
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.7, ease: EASE_OUT_EXPO, delay }}
      className={cn(
        'rounded-2xl border border-border/70 bg-card/75 shadow-[0_24px_60px_-24px_rgba(16,24,40,0.35)] backdrop-blur-xl',
        className,
      )}
    >
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
    </motion.div>
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
  return (
    <SectionShell size="lg" surface="card" width="wide">
      <motion.div
        {...reveal}
        className="relative overflow-hidden rounded-[24px] border border-accent/10 bg-accent/10 shadow-[0_12px_44px_-12px_rgba(115,66,226,0.35)] dark:bg-accent/[0.14]"
      >
        <div className="flex flex-col lg:min-h-[760px] lg:flex-row lg:justify-between">
          {/* Left: eyebrow pinned top, heading + lede anchored bottom (dashx stance). */}
          <div className="flex shrink-0 flex-col p-7 sm:p-10 lg:w-[440px] lg:p-12">
            <Eyebrow className="text-foreground/50">What every agent gets</Eyebrow>
            <div className="mt-8 lg:mt-auto lg:pt-10">
              <DisplayHeading
                size="section"
                className="max-w-[16ch] text-accent dark:text-[color-mix(in_srgb,var(--color-accent)_60%,white)]"
              >
                What every agent gets.
              </DisplayHeading>
              <Lede className="mt-5 text-accent/75 dark:text-[color-mix(in_srgb,var(--color-accent)_45%,white)]">
                Two things an agent does not have today, and the one rule that ties them
                together.
              </Lede>
            </div>
          </div>

          {/* Right: the layered window cluster. A plain column on small screens; from lg
              up, a single-cell grid stack where each wrapper carries its own translate,
              width and z-index. Translates never depend on a positioned ancestor and
              never fight framer-motion (which animates the card INSIDE the wrapper), so
              the collage lands in the same place every run. The panel's overflow-hidden
              crops the two skeleton windows that bleed past the edges on purpose. */}
          <div className="relative flex flex-col gap-5 p-7 pt-0 sm:p-10 sm:pt-0 lg:grid lg:flex-1 lg:place-items-start lg:p-0">
            {/* Accent glow behind the cluster. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute right-[-10%] top-[10%] hidden h-[80%] w-[90%] rounded-full bg-[radial-gradient(closest-side,rgba(115,66,226,0.28),transparent)] lg:block"
            />

            <div className="hidden lg:col-start-1 lg:row-start-1 lg:block lg:w-[280px] lg:translate-x-[550px] lg:translate-y-[-20px]">
              <GhostWindow />
            </div>
            <div className="hidden lg:col-start-1 lg:row-start-1 lg:block lg:w-[300px] lg:translate-x-[90px] lg:translate-y-[560px]">
              <GhostWindow />
            </div>

            <div className="lg:z-20 lg:col-start-1 lg:row-start-1 lg:w-[320px] lg:translate-x-[8px] lg:translate-y-[40px]">
              <WindowCard {...CARDS[0]} />
            </div>
            <div className="lg:z-10 lg:col-start-1 lg:row-start-1 lg:w-[310px] lg:translate-x-[130px] lg:translate-y-[420px]">
              <WindowCard {...CARDS[1]} delay={0.12} />
            </div>
            <div className="lg:z-30 lg:col-start-1 lg:row-start-1 lg:w-[330px] lg:translate-x-[450px] lg:translate-y-[120px]">
              <WindowCard {...CARDS[2]} delay={0.24} />
            </div>
          </div>
        </div>
      </motion.div>
    </SectionShell>
  )
}

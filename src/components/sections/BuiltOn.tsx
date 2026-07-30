import { useState, type ReactElement } from 'react'
import { motion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/* Real brand marks (currentColor, so they inherit the monochrome treatment and light up
 * to the brand hue on hover). OKX and Circle are the official marks; Arc is a redrawn
 * arch mark (Circle Arc) in matching monochrome. */
function OkxMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M 7.15 8.685 C 7.18 8.705 7.2 8.745 7.2 8.785 L 7.2 15.225 C 7.2 15.265 7.18 15.305 7.15 15.325 C 7.121 15.355 7.082 15.372 7.04 15.375 L 0.16 15.375 C 0.118 15.372 0.079 15.355 0.05 15.325 C 0.02 15.3 0.002 15.264 0 15.225 L 0 8.785 C 0 8.745 0.02 8.705 0.05 8.685 C 0.079 8.655 0.118 8.638 0.16 8.635 L 7.04 8.635 C 7.08 8.635 7.12 8.655 7.15 8.685 Z M 4.8 11.035 C 4.798 10.996 4.78 10.96 4.75 10.935 C 4.721 10.905 4.682 10.887 4.64 10.885 L 2.56 10.885 C 2.52 10.885 2.481 10.899 2.45 10.925 C 2.42 10.95 2.402 10.986 2.4 11.025 L 2.4 12.975 C 2.4 13.015 2.42 13.055 2.45 13.075 C 2.48 13.115 2.52 13.125 2.56 13.125 L 4.64 13.125 C 4.68 13.125 4.72 13.115 4.75 13.085 C 4.78 13.06 4.798 13.024 4.8 12.985 L 4.8 11.035 Z M 21.6 11.035 L 21.6 12.975 C 21.6 13.065 21.53 13.125 21.44 13.125 L 19.36 13.125 C 19.27 13.125 19.2 13.065 19.2 12.975 L 19.2 11.035 C 19.2 10.955 19.27 10.885 19.36 10.885 L 21.44 10.885 C 21.53 10.885 21.6 10.945 21.6 11.035 Z M 19.2 8.785 L 19.2 10.735 C 19.2 10.815 19.13 10.885 19.04 10.885 L 16.96 10.885 C 16.87 10.885 16.8 10.815 16.8 10.735 L 16.8 8.785 C 16.8 8.705 16.87 8.635 16.96 8.635 L 19.04 8.635 C 19.13 8.635 19.2 8.705 19.2 8.785 Z M 24 8.785 L 24 10.735 C 24 10.815 23.93 10.885 23.84 10.885 L 21.76 10.885 C 21.67 10.885 21.6 10.815 21.6 10.735 L 21.6 8.785 C 21.6 8.705 21.67 8.635 21.76 8.635 L 23.84 8.635 C 23.93 8.635 24 8.705 24 8.785 Z M 19.2 13.285 L 19.2 15.225 C 19.2 15.305 19.13 15.375 19.04 15.375 L 16.96 15.375 C 16.87 15.375 16.8 15.305 16.8 15.225 L 16.8 13.275 C 16.8 13.195 16.87 13.125 16.96 13.125 L 19.04 13.125 C 19.13 13.125 19.2 13.195 19.2 13.275 L 19.2 13.285 Z M 24 13.285 L 24 15.225 C 24 15.305 23.93 15.375 23.84 15.375 L 21.76 15.375 C 21.67 15.375 21.6 15.305 21.6 15.225 L 21.6 13.275 C 21.6 13.195 21.67 13.125 21.76 13.125 L 23.84 13.125 C 23.93 13.125 24 13.195 24 13.275 L 24 13.285 Z M 15.6 8.785 L 15.6 10.735 C 15.6 10.815 15.53 10.885 15.44 10.885 L 13.36 10.885 C 13.27 10.885 13.2 10.815 13.2 10.735 L 13.2 8.785 C 13.2 8.705 13.27 8.635 13.36 8.635 L 15.44 8.635 C 15.53 8.635 15.6 8.705 15.6 8.785 Z M 15.6 13.285 L 15.6 15.225 C 15.6 15.305 15.53 15.375 15.44 15.375 L 13.36 15.375 C 13.27 15.375 13.2 15.305 13.2 15.225 L 13.2 13.275 C 13.2 13.195 13.27 13.125 13.36 13.125 L 15.44 13.125 C 15.53 13.125 15.6 13.195 15.6 13.275 L 15.6 13.285 Z M 13.2 12.985 C 13.195 13.069 13.125 13.135 13.04 13.135 L 10.8 13.135 L 10.8 15.215 C 10.8 15.255 10.78 15.295 10.75 15.325 C 10.719 15.351 10.68 15.365 10.64 15.365 L 8.56 15.365 C 8.516 15.368 8.473 15.353 8.44 15.325 C 8.414 15.298 8.399 15.262 8.4 15.225 L 8.4 8.775 C 8.4 8.735 8.41 8.695 8.44 8.675 C 8.472 8.643 8.515 8.625 8.56 8.625 L 10.64 8.625 C 10.68 8.625 10.72 8.645 10.75 8.675 C 10.78 8.695 10.8 8.735 10.8 8.775 L 10.8 10.875 L 13.04 10.875 C 13.08 10.875 13.12 10.885 13.15 10.915 C 13.18 10.945 13.2 10.985 13.2 11.015 L 13.2 12.965 L 13.2 12.985 Z" />
    </svg>
  )
}
function CircleMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M20.788 3.832c-.101-.105-.197-.213-.301-.317-.103-.103-.211-.202-.32-.302A11.903 11.903 0 0 0 12 0a11.926 11.926 0 0 0-8.486 3.514C-1.062 8.09-1.16 15.47 3.213 20.168c.099.108.197.214.3.32.104.103.21.2.317.3A11.92 11.92 0 0 0 12 24c3.206 0 6.22-1.247 8.487-3.512 4.576-4.576 4.673-11.956.301-16.656zm-16.655.301A11.057 11.057 0 0 1 12 .874c2.825 0 5.49 1.048 7.55 2.958l-1.001 1.002A9.646 9.646 0 0 0 12 2.292a9.644 9.644 0 0 0-6.865 2.844A9.644 9.644 0 0 0 2.292 12c0 2.448.9 4.753 2.542 6.549L3.831 19.55C-.201 15.191-.101 8.367 4.133 4.133zm13.798 1.318v.002l-1.015 1.014A7.346 7.346 0 0 0 12 4.589 7.357 7.357 0 0 0 6.761 6.76 7.362 7.362 0 0 0 4.589 12a7.34 7.34 0 0 0 1.877 4.913l-1.014 1.016A8.77 8.77 0 0 1 3.167 12a8.77 8.77 0 0 1 2.588-6.245A8.771 8.771 0 0 1 12 3.167c2.213 0 4.301.809 5.931 2.284zM18.537 12c0 1.745-.681 3.387-1.916 4.622S13.746 18.538 12 18.538a6.491 6.491 0 0 1-4.296-1.621l-.001-.004c-.11-.094-.22-.188-.324-.291a6.027 6.027 0 0 1-.293-.326A6.47 6.47 0 0 1 5.466 12c0-1.746.679-3.387 1.914-4.621A6.488 6.488 0 0 1 12 5.465c1.599 0 3.105.576 4.295 1.62.111.096.224.19.326.295.104.104.2.214.295.324A6.482 6.482 0 0 1 18.537 12zM7.084 17.534h.001A7.349 7.349 0 0 0 12 19.413a7.35 7.35 0 0 0 5.239-2.174A7.354 7.354 0 0 0 19.412 12a7.364 7.364 0 0 0-1.876-4.916l1.013-1.012A8.777 8.777 0 0 1 20.834 12a8.765 8.765 0 0 1-2.589 6.246A8.764 8.764 0 0 1 12 20.834a8.782 8.782 0 0 1-5.93-2.285l1.014-1.015zm12.783 2.333A11.046 11.046 0 0 1 12 23.125a11.042 11.042 0 0 1-7.551-2.957l1.004-1.001a9.64 9.64 0 0 0 6.549 2.542 9.639 9.639 0 0 0 6.865-2.846A9.642 9.642 0 0 0 21.71 12a9.64 9.64 0 0 0-2.543-6.548l1.001-1.002c4.031 4.359 3.935 11.182-.301 15.417z" />
    </svg>
  )
}
function ArcMark(props: { className?: string }) {
  // The Circle Arc mark: a tall arch whose right leg sweeps into a pointed tail.
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M4.8 20.8C4.8 6.8 17.4 6.4 17 18.6c-.12 3.4-3.7 4.2-7 2.2" />
    </svg>
  )
}

type Rail = { id: string; Mark: (p: { className?: string }) => ReactElement; name: string; color: string; role: string }
const RAILS: Rail[] = [
  { id: 'circle', Mark: CircleMark, name: 'Circle', color: '#2775CA', role: 'USDC, Gateway and CCTP. The settlement dollar, chain-abstracted.' },
  { id: 'arc', Mark: ArcMark, name: 'Circle Arc', color: '#5B8DEF', role: 'Where identity and reputation live. Sub-second finality, gas in USDC.' },
  { id: 'xlayer', Mark: OkxMark, name: 'OKX X Layer', color: 'var(--foreground)', role: 'Where trust checks settle. x402 pay-per-call in USD₮0, on mainnet.' },
]

/* Each in its own brand hue, so a new chain slots straight into its palette. */
const NEXT: { name: string; color: string }[] = [
  { name: 'Base', color: '#0052FF' },
  { name: 'Arbitrum', color: '#28A0F0' },
  { name: 'Avalanche', color: '#E84142' },
  { name: 'Stellar', color: '#7D00FF' },
  { name: 'Solana', color: '#14F195' },
]

/**
 * Where A-Identity runs. Honest "built on", not "trusted by": the three infrastructures
 * are real and live today (Circle products, Circle Arc, OKX X Layer). Interactive, unified
 * monochrome that lights up to each brand hue on hover, with a clearly-labeled roadmap row.
 */
export default function BuiltOn() {
  const [active, setActive] = useState<string | null>(null)
  return (
    <section className="w-full bg-background px-5 py-16 text-foreground sm:px-8 sm:py-20">
      <div className="mx-auto max-w-[1080px]">
        <motion.h2 {...reveal} className="text-3xl font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]" style={{ fontFamily: 'var(--font-heading)' }}>
          Built on rails that already move money.
        </motion.h2>
        <motion.p {...reveal} className="mt-4 max-w-xl text-lg leading-relaxed text-foreground/55">
          A-Identity does not reinvent settlement. It runs on Circle and OKX, live today.
        </motion.p>

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
          {RAILS.map((r, i) => {
            const on = active === r.id
            return (
              <motion.div
                key={r.id}
                {...reveal}
                transition={{ ...reveal.transition, delay: i * 0.08 }}
                onMouseEnter={() => setActive(r.id)}
                onMouseLeave={() => setActive((a) => (a === r.id ? null : a))}
                className="group relative flex flex-col bg-card p-7 transition-colors"
              >
                <div className="flex items-center justify-between">
                  {/* Each mark carries its own brand hue; hover just brings it to full. */}
                  <motion.span animate={{ opacity: on ? 1 : 0.82 }} style={{ color: r.color }} className="block h-8 w-8">
                    <r.Mark className="h-8 w-8" />
                  </motion.span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wide text-foreground/35">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: '#10b981' }} />
                      <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: '#10b981' }} />
                    </span>
                    live
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold tracking-tight text-foreground">{r.name}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-foreground/55">{r.role}</p>
                <motion.span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-0.5"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: on ? 1 : 0 }}
                  transition={{ duration: 0.3, ease: EASE_OUT_EXPO }}
                  style={{ background: r.color, transformOrigin: 'left' }}
                />
              </motion.div>
            )
          })}
        </div>

        <motion.div {...reveal} className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <span className="font-mono text-[11px] uppercase tracking-wide text-foreground/40">Next</span>
          {NEXT.map((n) => (
            <span key={n.name} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-xs text-foreground/55">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: n.color }} />
              {n.name}
            </span>
          ))}
          <span className="text-xs text-foreground/35">one chain-agnostic core, one adapter per chain</span>
        </motion.div>
      </div>
    </section>
  )
}

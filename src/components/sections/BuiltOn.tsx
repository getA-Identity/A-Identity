import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/* Real brand marks (currentColor, tinted per rail). OKX and Circle are the official
 * marks; Arc is a redrawn arch mark (Circle Arc) in matching monochrome. Rails whose
 * marks we do not ship yet get a drawn monogram tile instead of a wrong logo. */
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
      <path d="M20.788 3.832c-.101-.105-.197-.213-.301-.317-.103-.103-.211-.202-.32-.302A11.903 11.903 0 0 0 12 0a11.926 11.926 0 0 0-8.486 3.514C-1.062 8.09-1.16 15.47 3.213 20.168c.099.108.197.214.3.32.104.103.21.2.317.3A11.92 11.92 0 0 0 12 24c3.206 0 6.22-1.247 8.487-3.512 4.576-4.576 4.673-11.956.301-16.656zm-16.655.301A11.057 11.057 0 0 1 12 .874c2.825 0 5.49 1.048 7.55 2.958l-1.001 1.002A9.646 9.646 0 0 0 12 2.292a9.644 9.644 0 0 0-6.865 2.844A9.644 9.644 0 0 0 2.292 12c0 2.448.9 4.753 2.542 6.549L3.831 19.55C-.201 15.191-.101 8.367 4.133 4.133zm13.798 1.318v.002l-1.015 1.014A7.346 7.346 0 0 0 12 4.589 7.357 7.357 0 0 0 6.761 6.76 7.362 7.362 0 0 0 4.589 12a7.34 7.34 0 0 0 1.877 4.913l-1.014 1.016A8.77 8.77 0 0 1 3.167 12a8.77 8.77 0 0 1 2.588-6.245A8.771 8.771 0 0 1 12 3.167c2.213 0 4.301.809 5.931 2.284zM18.537 12c0 1.745-.681 3.387-1.916 4.622S13.746 18.538 12 18.538a6.491 6.491 0 0 1-4.296-1.621l-.001-.004c-.11-.094-.22-.188-.324-.291a6.027 6.027 0 0 1-.293-.326A6.47 6.47 0 0 1 5.466 12c0-1.746.679-3.387 1.914-4.621A6.488 6.488 0 0 1 12 5.465c1.599 0 3.105.576 4.295 1.62.111.096.224.19.326.295.104.104.2.214.295.324A6.482 6.482 0 0 1 18.537 12zM7.084 17.534h.001A7.349 7.349 0 0 0 12 19.413a7.35 7.35 0 0 0 5.239-2.174A7.354 7.354 0 0 0 19.412 12a7.364 7.364 0 0 0-1.876-4.916l1.013-1.012A8.777 8.777 0 0 1 20.834 12a8.765 8.765 0 0 1-2.589 6.246A8.764 8.764 0 0 1 12 20.834a8.782 8.782 0 0 1-5.93-2.285l1.014-1.015z" />
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
function StellarMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12.003 1.716c-1.37 0-2.7.27-3.948.78A10.18 10.18 0 0 0 2.66 7.901a10.136 10.136 0 0 0-.797 3.954c0 .258.01.516.027.775a1.942 1.942 0 0 1-1.055 1.88L0 14.934v1.902l2.463-1.26.072-.032v.005l.77-.39.758-.385.066-.039 14.807-7.56 1.666-.847 3.392-1.732V2.694L17.792 5.86 3.744 13.025l-.104.055-.017-.115a8.286 8.286 0 0 1-.071-1.105c0-2.255.88-4.377 2.474-5.977a8.462 8.462 0 0 1 2.71-1.82 8.513 8.513 0 0 1 3.2-.654h.067a8.41 8.41 0 0 1 4.09 1.055l1.628-.83.126-.066a10.11 10.11 0 0 0-5.845-1.853zM24 7.143 5.047 16.808l-1.666.847L0 19.382v1.902l3.282-1.671 2.91-1.485 14.058-7.153.105-.055.016.115c.05.369.072.743.072 1.11 0 2.255-.88 4.383-2.475 5.978a8.461 8.461 0 0 1-2.71 1.82 8.305 8.305 0 0 1-3.2.654h-.06c-1.441 0-2.86-.369-4.102-1.061l-.066.033-1.683.857c.594.418 1.232.776 1.903 1.062a10.11 10.11 0 0 0 3.947.797 10.09 10.09 0 0 0 7.17-2.975 10.136 10.136 0 0 0 2.969-7.18c0-.259-.005-.523-.027-.781a1.942 1.942 0 0 1 1.055-1.88L24 9.044z" />
    </svg>
  )
}
function RobinhoodMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M2.84 24h.53c.096 0 .192-.048.224-.128C7.591 13.696 11.94 8.656 14.67 5.638c.112-.128.064-.225-.096-.225h-4.88a.55.55 0 0 0-.45.225L5.746 9.972c-.514.642-.642 1.236-.642 2.086v4.43c-1.14 3.194-1.862 5.361-2.392 7.32-.032.125.016.192.129.192M20.447.646c-.754-.802-4.157-.834-5.73-.224a3 3 0 0 0-.786.465 41 41 0 0 0-3.323 3.178c-.112.113-.064.225.097.225h5.409c.497 0 .786.289.786.786v6.1c0 .16.128.208.225.064l3.258-4.254c.53-.69.69-.898.835-1.861.192-1.413.08-3.58-.77-4.479m-6.982 16.18 2.231-3.676a.7.7 0 0 0 .064-.29V6.73c0-.16-.112-.225-.224-.097-3.355 3.74-5.971 7.672-8.395 12.407-.06.12.016.225.16.177l5.009-1.54c.565-.174.882-.402 1.155-.852" />
    </svg>
  )
}

type Rail = {
  id: string
  Mark: (p: { className?: string }) => ReactElement
  name: string
  color: string
  role: string
  detail: string
  status: 'live' | 'next'
}

const RAILS: Rail[] = [
  {
    id: 'circle',
    Mark: CircleMark,
    name: 'Circle',
    color: '#2775CA',
    role: 'The settlement dollar, chain-abstracted.',
    detail: 'USDC, Gateway unified balances, gasless Nanopayments and CCTP burn-and-mint, all live on this product today.',
    status: 'live',
  },
  {
    id: 'arc',
    Mark: ArcMark,
    name: 'Circle Arc',
    color: '#5B8DEF',
    role: 'Where identity and reputation live.',
    detail: 'ERC-8004 passports, KYA attestations, spend vaults and escrow settle here, with sub-second finality and gas paid in USDC.',
    status: 'live',
  },
  {
    id: 'xlayer',
    Mark: OkxMark,
    name: 'OKX X Layer',
    color: 'var(--foreground)',
    role: 'Where trust checks are sold.',
    detail: 'The Trust Oracle answers per-call over x402 and settles in USD₮0 on mainnet, 120 settlements and counting.',
    status: 'live',
  },
  {
    id: 'stellar',
    Mark: StellarMark,
    name: 'Stellar',
    color: '#7D00FF',
    role: 'First stop of the multichain rollout.',
    detail: 'The same passport and caps over Soroban rails: one chain-agnostic core, one adapter per chain, Stellar is next in line.',
    status: 'next',
  },
  {
    id: 'robinhood',
    Mark: RobinhoodMark,
    name: 'Robinhood Chain',
    color: '#00C805',
    role: 'Where retail agents will trade.',
    detail: 'A planned adapter for the chain built around agentic trading, so the guardrails travel with the money there too.',
    status: 'next',
  },
]

/**
 * Where A-Identity runs, one rail at a time. Honest "built on", not "trusted by":
 * the three live infrastructures are real today, and the two roadmap rails wear a
 * clearly-labeled NEXT pill instead of pretending. One slide per rail (the carousel
 * treatment), native snap scroll with arrows and dots, so each rail gets the floor
 * instead of sharing a cramped grid.
 */
export default function BuiltOn() {
  const trackRef = useRef<HTMLDivElement>(null)
  const [idx, setIdx] = useState(0)

  const sync = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    setIdx(Math.round(el.scrollLeft / el.clientWidth))
  }, [])

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    el.addEventListener('scroll', sync, { passive: true })
    return () => el.removeEventListener('scroll', sync)
  }, [sync])

  const goTo = (i: number) => {
    const el = trackRef.current
    if (!el) return
    const clamped = Math.max(0, Math.min(RAILS.length - 1, i))
    el.scrollTo({ left: clamped * el.clientWidth, behavior: 'smooth' })
  }

  return (
    <section className="w-full bg-background px-5 py-16 text-foreground sm:px-8 sm:py-20">
      <div className="mx-auto max-w-[1080px]">
        <div className="flex items-end justify-between gap-6">
          <div>
            <motion.h2 {...reveal} className="text-3xl font-bold leading-[1.1] tracking-tight sm:text-[2.6rem]" style={{ fontFamily: 'var(--font-heading)' }}>
              Built on rails that already move money.
            </motion.h2>
            <motion.p {...reveal} className="mt-4 max-w-xl text-lg leading-relaxed text-foreground/55">
              A-Identity does not reinvent settlement. It runs on Circle and OKX, live today.
            </motion.p>
          </div>
          <motion.div {...reveal} className="mb-1 hidden shrink-0 gap-2 sm:flex">
            <button
              type="button"
              aria-label="Previous rail"
              onClick={() => goTo(idx - 1)}
              disabled={idx === 0}
              className="grid h-11 w-11 place-items-center rounded-full border border-border bg-card text-foreground transition enabled:hover:border-accent/50 enabled:hover:text-accent disabled:opacity-30"
            >
              <ArrowLeft size={17} />
            </button>
            <button
              type="button"
              aria-label="Next rail"
              onClick={() => goTo(idx + 1)}
              disabled={idx === RAILS.length - 1}
              className="grid h-11 w-11 place-items-center rounded-full border border-border bg-card text-foreground transition enabled:hover:border-accent/50 enabled:hover:text-accent disabled:opacity-30"
            >
              <ArrowRight size={17} />
            </button>
          </motion.div>
        </div>

        {/* One rail per view: native snap scroll, arrows and dots drive the same track. */}
        <motion.div {...reveal}>
          <div
            ref={trackRef}
            className="mt-10 flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain rounded-2xl [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {RAILS.map((r) => (
              <article
                key={r.id}
                className="w-full shrink-0 snap-center"
                aria-label={`${r.name}: ${r.role}`}
              >
                <div className="relative grid gap-8 overflow-hidden rounded-2xl border border-border bg-card p-8 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:p-12">
                  {/* The rail's own mark as a translucent watermark, bleeding off the
                      right edge, so every slide carries its brand without shouting it. */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-16 top-1/2 -translate-y-1/2 opacity-[0.05]"
                    style={{ color: r.color }}
                  >
                    <r.Mark className="h-[340px] w-[340px]" />
                  </div>
                  <div
                    className="relative grid h-24 w-24 place-items-center rounded-3xl border border-border"
                    style={{ color: r.color, background: `color-mix(in srgb, ${r.color} 8%, var(--card))` }}
                  >
                    <r.Mark className="h-12 w-12" />
                  </div>
                  <div className="relative">
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-2xl font-bold tracking-tight text-foreground">{r.name}</h3>
                      {r.status === 'live' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          </span>
                          live
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-dashed border-border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-foreground/45">
                          next
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-lg font-medium text-foreground/80">{r.role}</p>
                    <p className="mt-2 max-w-[56ch] text-[15px] leading-relaxed text-foreground/55">{r.detail}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>

          {/* Dots: one per rail, the active one stretched. */}
          <div className="mt-5 flex items-center justify-center gap-2">
            {RAILS.map((r, i) => (
              <button
                key={r.id}
                type="button"
                aria-label={`Go to ${r.name}`}
                onClick={() => goTo(i)}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === idx ? 'w-7 bg-accent' : 'w-1.5 bg-foreground/20 hover:bg-foreground/40'
                }`}
              />
            ))}
          </div>

          <p className="mt-4 text-center text-xs text-foreground/35">
            one chain-agnostic core, one adapter per chain
          </p>
        </motion.div>
      </div>
    </section>
  )
}

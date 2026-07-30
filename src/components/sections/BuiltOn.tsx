import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'
import { SectionBackdrop } from '../ui/section-backdrop'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.6, ease: EASE_OUT_EXPO },
}

/* Real brand marks (currentColor, tinted per rail). OKX and Circle are the official
 * marks; Arc is a redrawn arch mark (Circle Arc) in matching monochrome. Rails whose
 * marks we do not ship yet get a drawn monogram tile instead of a wrong logo. */
/** OKX ships no file in this repo, so its official monochrome mark stays as a path. */
function OkxMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M 7.15 8.685 C 7.18 8.705 7.2 8.745 7.2 8.785 L 7.2 15.225 C 7.2 15.265 7.18 15.305 7.15 15.325 C 7.121 15.355 7.082 15.372 7.04 15.375 L 0.16 15.375 C 0.118 15.372 0.079 15.355 0.05 15.325 C 0.02 15.3 0.002 15.264 0 15.225 L 0 8.785 C 0 8.745 0.02 8.705 0.05 8.685 C 0.079 8.655 0.118 8.638 0.16 8.635 L 7.04 8.635 C 7.08 8.635 7.12 8.655 7.15 8.685 Z M 4.8 11.035 C 4.798 10.996 4.78 10.96 4.75 10.935 C 4.721 10.905 4.682 10.887 4.64 10.885 L 2.56 10.885 C 2.52 10.885 2.481 10.899 2.45 10.925 C 2.42 10.95 2.402 10.986 2.4 11.025 L 2.4 12.975 C 2.4 13.015 2.42 13.055 2.45 13.075 C 2.48 13.115 2.52 13.125 2.56 13.125 L 4.64 13.125 C 4.68 13.125 4.72 13.115 4.75 13.085 C 4.78 13.06 4.798 13.024 4.8 12.985 L 4.8 11.035 Z M 21.6 11.035 L 21.6 12.975 C 21.6 13.065 21.53 13.125 21.44 13.125 L 19.36 13.125 C 19.27 13.125 19.2 13.065 19.2 12.975 L 19.2 11.035 C 19.2 10.955 19.27 10.885 19.36 10.885 L 21.44 10.885 C 21.53 10.885 21.6 10.945 21.6 11.035 Z M 19.2 8.785 L 19.2 10.735 C 19.2 10.815 19.13 10.885 19.04 10.885 L 16.96 10.885 C 16.87 10.885 16.8 10.815 16.8 10.735 L 16.8 8.785 C 16.8 8.705 16.87 8.635 16.96 8.635 L 19.04 8.635 C 19.13 8.635 19.2 8.705 19.2 8.785 Z M 24 8.785 L 24 10.735 C 24 10.815 23.93 10.885 23.84 10.885 L 21.76 10.885 C 21.67 10.885 21.6 10.815 21.6 10.735 L 21.6 8.785 C 21.6 8.705 21.67 8.635 21.76 8.635 L 23.84 8.635 C 23.93 8.635 24 8.705 24 8.785 Z M 19.2 13.285 L 19.2 15.225 C 19.2 15.305 19.13 15.375 19.04 15.375 L 16.96 15.375 C 16.87 15.375 16.8 15.305 16.8 15.225 L 16.8 13.275 C 16.8 13.195 16.87 13.125 16.96 13.125 L 19.04 13.125 C 19.13 13.125 19.2 13.195 19.2 13.275 L 19.2 13.285 Z M 24 13.285 L 24 15.225 C 24 15.305 23.93 15.375 23.84 15.375 L 21.76 15.375 C 21.67 15.375 21.6 15.305 21.6 15.225 L 21.6 13.275 C 21.6 13.195 21.67 13.125 21.76 13.125 L 23.84 13.125 C 23.93 13.125 24 13.195 24 13.275 L 24 13.285 Z M 15.6 8.785 L 15.6 10.735 C 15.6 10.815 15.53 10.885 15.44 10.885 L 13.36 10.885 C 13.27 10.885 13.2 10.815 13.2 10.735 L 13.2 8.785 C 13.2 8.705 13.27 8.635 13.36 8.635 L 15.44 8.635 C 15.53 8.635 15.6 8.705 15.6 8.785 Z M 15.6 13.285 L 15.6 15.225 C 15.6 15.305 15.53 15.375 15.44 15.375 L 13.36 15.375 C 13.27 15.375 13.2 15.305 13.2 15.225 L 13.2 13.275 C 13.2 13.195 13.27 13.125 13.36 13.125 L 15.44 13.125 C 15.53 13.125 15.6 13.195 15.6 13.275 L 15.6 13.285 Z M 13.2 12.985 C 13.195 13.069 13.125 13.135 13.04 13.135 L 10.8 13.135 L 10.8 15.215 C 10.8 15.255 10.78 15.295 10.75 15.325 C 10.719 15.351 10.68 15.365 10.64 15.365 L 8.56 15.365 C 8.516 15.368 8.473 15.353 8.44 15.325 C 8.414 15.298 8.399 15.262 8.4 15.225 L 8.4 8.775 C 8.4 8.735 8.41 8.695 8.44 8.675 C 8.472 8.643 8.515 8.625 8.56 8.625 L 10.64 8.625 C 10.68 8.625 10.72 8.645 10.75 8.675 C 10.78 8.695 10.8 8.735 10.8 8.775 L 10.8 10.875 L 13.04 10.875 C 13.08 10.875 13.12 10.885 13.15 10.915 C 13.18 10.945 13.2 10.985 13.2 11.015 L 13.2 12.965 L 13.2 12.985 Z" />
    </svg>
  )
}
type Rail = {
  id: string
  name: string
  /** The rail's own logo, extracted from the brand's artwork into /public/logos. */
  logo?: string
  /** Fallback for a brand whose file we do not ship (OKX). */
  Mark?: (p: { className?: string }) => ReactElement
  /** The tile behind the mark, in the brand's own presentation. */
  tileBg: string
  /** Drives the slide's tint, border and watermark. */
  color: string
  role: string
  detail: string
  status: 'live' | 'next'
}

const RAILS: Rail[] = [
  /* Every colour and tile below is taken from the brand's own artwork rather than a
     guess: Circle's gradient mark on its white field, Arc's white arch on the navy to
     crimson gradient it ships on, Stellar's black glyph on Stellar yellow, Base's blue
     square, and Robin Neon for Robinhood. OKX is a monochrome brand, so it rides the
     foreground token and stays correct in both themes. */
  {
    id: 'circle',
    name: 'Circle',
    logo: '/logos/circle-mark.png',
    tileBg: '#ffffff',
    color: '#4FBDEA',
    role: 'The settlement dollar, chain-abstracted.',
    detail: 'USDC, Gateway unified balances, gasless Nanopayments and CCTP burn-and-mint, all live on this product today.',
    status: 'live',
  },
  {
    id: 'arc',
    name: 'Circle Arc',
    logo: '/logos/arc-mark.png',
    tileBg: 'linear-gradient(155deg, #011667 0%, #3B1046 55%, #7B0E25 100%)',
    color: '#3B1B6E',
    role: 'Where identity and reputation live.',
    detail: 'ERC-8004 passports, KYA attestations, spend vaults and escrow settle here, with sub-second finality and gas paid in USDC.',
    status: 'live',
  },
  {
    id: 'xlayer',
    name: 'OKX X Layer',
    Mark: OkxMark,
    tileBg: 'color-mix(in srgb, var(--foreground) 7%, var(--card))',
    color: 'var(--foreground)',
    role: 'Where trust checks are sold.',
    detail: 'The Trust Oracle answers per-call over x402 and settles in USD\u20AE0 on mainnet, 120 settlements and counting.',
    status: 'live',
  },
  {
    id: 'stellar',
    name: 'Stellar',
    logo: '/logos/stellar-mark.png',
    tileBg: '#FFDA00',
    color: '#FFDA00',
    role: 'First stop of the multichain rollout.',
    detail: 'The same passport and caps over Soroban rails: one chain-agnostic core, one adapter per chain, Stellar is next in line.',
    status: 'next',
  },
  {
    id: 'base',
    name: 'Base',
    logo: '/logos/base-mark.png',
    tileBg: '#ffffff',
    color: '#0000FF',
    role: 'Where the agent economy already trades.',
    detail: 'A planned adapter for Base, so a passport minted on Arc can be presented, scored and paid against on Base too.',
    status: 'next',
  },
  {
    id: 'robinhood',
    name: 'Robinhood Chain',
    logo: '/logos/robinhood-mark.png',
    tileBg: '#CCFF00',
    color: '#CCFF00',
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
    <section className="relative w-full overflow-hidden bg-background px-5 py-16 text-foreground sm:px-8 sm:py-20">
      <SectionBackdrop name="rails" position="right" />
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
                <div
                  /* The rail's own hue leads the slide: a tinted surface and a border in
                     its brand color, so each slide reads as that chain rather than as a
                     generic card wearing a small logo. */
                  className="relative grid gap-8 overflow-hidden rounded-2xl border p-8 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:p-12"
                  style={{
                    borderColor: `color-mix(in srgb, ${r.color} 24%, var(--border))`,
                    background: `linear-gradient(135deg, color-mix(in srgb, ${r.color} 10%, var(--card)) 0%, var(--card) 55%)`,
                  }}
                >
                  {/* The rail's own mark as a translucent watermark, bleeding off the
                      right edge, so every slide carries its brand without shouting it. */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-16 top-1/2 grid h-[340px] w-[340px] -translate-y-1/2 place-items-center opacity-[0.06]"
                    style={{ color: r.color }}
                  >
                    {r.logo ? (
                      <img src={r.logo} alt="" className="max-h-full max-w-full object-contain" />
                    ) : (
                      r.Mark && <r.Mark className="h-full w-full" />
                    )}
                  </div>

                  {/* The tile is the brand's own presentation: Circle's gradient mark on
                      white, Arc's white arch on its navy-to-crimson field, Stellar black
                      on Stellar yellow. */}
                  <div
                    className="relative grid h-24 w-24 place-items-center overflow-hidden rounded-3xl border border-border/60 shadow-sm"
                    style={{ color: r.color, background: r.tileBg }}
                  >
                    {r.logo ? (
                      <img
                        src={r.logo}
                        alt={`${r.name} logo`}
                        className="h-12 w-12 object-contain"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : (
                      r.Mark && <r.Mark className="h-12 w-12" />
                    )}
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

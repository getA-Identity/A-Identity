import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, type Variants } from 'framer-motion'
import { ArrowRight, Sparkles } from 'lucide-react'
import { CAL_URL, EASE_OUT_EXPO } from '../lib/brand'

/*
 * Centered hero over the background video (the dashx stance): claim, lede and the
 * CTA pair stacked on the center axis, and under them the real /app console as a
 * wide framed still that the fold crops on desktop, so the first screen ends on
 * the product itself. The interactive live trust lookup stays one keystroke away
 * in the ⌘K spotlight; the small link under the CTAs opens it. Palette unchanged
 * (accent #7342E2 + semantic tokens).
 *
 * The still is a capture of the live console in dark theme (public/console-hero.webp,
 * regenerate by re-shooting /app); it reads as a product photo, so it does not
 * flip with the theme.
 */

const ACCENT = '#7342E2'
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '')

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20, filter: 'blur(8px)' },
  visible: (i: number) => ({ opacity: 1, y: 0, filter: 'blur(0px)', transition: { delay: i * 0.12, duration: 0.7, ease: EASE_OUT_EXPO } }),
}

export default function Hero() {
  const navigate = useNavigate()
  const kbd = isMac ? '⌘K' : 'Ctrl K'
  const openSpotlight = () => window.dispatchEvent(new Event('open-trust-spotlight'))

  /* The console still stays hidden while the page is at rest, so the first
     screen belongs to the video; the first light scroll (~24px) raises it into
     place. One-way on purpose: once seen it stays, so scrolling back up does
     not blink the frame out from under the reader. */
  const [consoleRevealed, setConsoleRevealed] = useState(false)
  useEffect(() => {
    const onScroll = () => {
      if (window.scrollY > 24) setConsoleRevealed(true)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <section
      className="relative z-10 mx-auto flex w-full max-w-[1280px] flex-col items-center px-5 text-center sm:px-8"
      style={{ paddingTop: 'clamp(40px, 7vw, 80px)' }}
    >
      <motion.h1
        custom={0}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        style={{
          fontFamily: 'var(--font-heading)',
          fontSize: 'clamp(2.6rem, 6.6vw, 4.8rem)',
          lineHeight: 1.02,
          letterSpacing: '-0.035em',
          color: 'var(--foreground)',
          textWrap: 'balance',
        }}
      >
        Trust, before you pay.
      </motion.h1>

      <motion.p
        custom={1}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="mt-5 max-w-[46ch] text-foreground/65"
        style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(1rem, 2.4vw, 1.2rem)', lineHeight: 1.6 }}
      >
        A verified on-chain identity and a bounded wallet for every AI agent.
      </motion.p>

      <motion.div
        custom={2}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        className="mt-8 flex flex-wrap items-center justify-center gap-3.5"
      >
        <motion.button
          type="button"
          onClick={() => navigate('/signup')}
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          className="inline-flex items-center gap-2.5 rounded-full px-7 py-3.5 text-sm font-semibold text-white sm:px-8 sm:py-4 sm:text-base"
          style={{ background: ACCENT, boxShadow: '0 10px 34px rgba(115,66,226,0.34)', border: '1px solid transparent' }}
        >
          Get your Agent ID <ArrowRight size={18} />
        </motion.button>

        <motion.a
          href={CAL_URL}
          target="_blank"
          rel="noopener noreferrer"
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          className="inline-flex items-center rounded-full border border-border bg-card px-7 py-3.5 text-sm font-semibold text-foreground sm:px-8 sm:py-4 sm:text-base"
        >
          Book a call
        </motion.a>
      </motion.div>

      <motion.button
        custom={3}
        variants={fadeUp}
        initial="hidden"
        animate="visible"
        type="button"
        onClick={openSpotlight}
        className="group mt-5 inline-flex items-center gap-2 text-sm font-semibold text-foreground/60 transition-colors hover:text-foreground"
      >
        <Sparkles size={15} style={{ color: ACCENT }} className="transition-transform group-hover:rotate-12" />
        Verify an agent right now
        <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground/55">
          {kbd}
        </kbd>
      </motion.button>

      {/* The console itself, horizontal, as the hero's floor. On desktop the header is
          exactly one viewport tall and overflow-hidden, so the fold crops this frame the
          way dashx crops its dashboard; on mobile it simply flows. It occupies its layout
          slot from the start (transform/opacity only), so the reveal never shifts the
          copy above it. */}
      <motion.div
        initial={false}
        animate={
          consoleRevealed
            ? { opacity: 1, y: 0, scale: 1 }
            : { opacity: 0, y: 110, scale: 0.98 }
        }
        transition={{ duration: 0.9, ease: EASE_OUT_EXPO }}
        className="mt-12 w-full max-w-[1160px]"
      >
        <div className="overflow-hidden rounded-t-[20px] border border-b-0 border-border/70 bg-card shadow-[0_-12px_80px_-20px_rgba(115,66,226,0.35),0_24px_80px_-24px_rgba(16,24,40,0.5)]">
          <img
            src="/console-hero.webp"
            alt="The A-Identity agent console: reputation, wallet balance, on-chain settlements and the daily cap for the showcase agent Meridian."
            width={2560}
            height={1360}
            loading="eager"
            decoding="async"
            className="block w-full"
          />
        </div>
      </motion.div>
    </section>
  )
}

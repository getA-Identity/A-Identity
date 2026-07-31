import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, type Variants } from 'framer-motion'
import { ArrowRight, Sparkles } from 'lucide-react'
import { CAL_URL, EASE_OUT_EXPO } from '../lib/brand'
import { useTheme } from './ThemeProvider'

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
 * flip with the theme. Ship the recapture at 1280x484: the frame is 1158px wide at
 * its widest, so anything past that is bytes nobody sees, and the declared width and
 * height below have to match the file or the box shifts as it decodes.
 */

const ACCENT = '#7342E2'
const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '')

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 20, filter: 'blur(8px)' },
  visible: (i: number) => ({ opacity: 1, y: 0, filter: 'blur(0px)', transition: { delay: i * 0.12, duration: 0.7, ease: EASE_OUT_EXPO } }),
}

export default function Hero() {
  const navigate = useNavigate()
  const { theme } = useTheme()
  const kbd = isMac ? '⌘K' : 'Ctrl K'
  const openSpotlight = () => window.dispatchEvent(new Event('open-trust-spotlight'))

  /* The console still stays hidden while the page is at rest, so the first
     screen belongs to the video; a light scroll raises it into place and
     scrolling back to the very top lowers it out again. The two thresholds
     are deliberately apart (show past 32px, hide only under 12px) so the
     frame never flickers while the reader hovers around the boundary, and
     the state writes are batched through rAF so a fast trackpad cannot
     queue a render per scroll event. */
  const [consoleRevealed, setConsoleRevealed] = useState(false)
  useEffect(() => {
    let ticking = false
    const update = () => {
      ticking = false
      setConsoleRevealed((prev) => (prev ? window.scrollY > 12 : window.scrollY > 32))
    }
    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(update)
      }
    }
    update()
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
            : { opacity: 0, y: 120, scale: 0.97 }
        }
        transition={
          consoleRevealed
            ? // Entering: a soft spring, so the frame decelerates into place and
              // settles with a barely-there overshoot instead of a hard stop.
              {
                type: 'spring',
                stiffness: 120,
                damping: 22,
                mass: 0.9,
                opacity: { duration: 0.4, ease: 'easeOut' },
              }
            : // Leaving: a quicker tween; an exit should clear the stage, not perform.
              { duration: 0.45, ease: EASE_OUT_EXPO, opacity: { duration: 0.3 } }
        }
        style={{ willChange: 'transform, opacity' }}
        className="mt-12 w-full max-w-[1160px]"
      >
        <div className="relative overflow-hidden rounded-t-[20px] border border-b-0 border-border/70 bg-card shadow-[0_-12px_80px_-20px_rgba(115,66,226,0.35),0_24px_80px_-24px_rgba(16,24,40,0.5)]">
          {/* Both theme stills stay mounted and crossfade with the theme toggle, so the
              switch reads as the console changing its own theme rather than a reload.
              That does mean two files on the wire, and it stays that way on purpose: the
              build prerenders this page to static HTML, so the second <img> is in the
              markup the preload scanner reads no matter what React does later, and the
              only way to keep it out is to mount it on the toggle itself, which is the
              one moment it has to be decoded already. So instead of dropping it, it is
              made cheap: 1280px stills at ~25 KB each (down from 2560px/~54 KB), and the
              still the current theme is not showing is demoted to lazy + low priority so
              it queues behind everything the first screen actually needs. */}
          <img
            src="/console-hero.webp"
            alt="The A-Identity agent console: reputation, wallet balance, on-chain settlements and the daily cap for the showcase agent Meridian."
            width={1280}
            height={484}
            loading={theme === 'dark' ? 'eager' : 'lazy'}
            fetchPriority={theme === 'dark' ? 'high' : 'low'}
            decoding="async"
            className={`block w-full transition-opacity duration-700 ${theme === 'dark' ? 'opacity-100' : 'opacity-0'}`}
          />
          <img
            src="/console-hero-light.webp"
            alt=""
            aria-hidden="true"
            width={1280}
            height={484}
            loading={theme === 'dark' ? 'lazy' : 'eager'}
            fetchPriority={theme === 'dark' ? 'low' : 'high'}
            decoding="async"
            className={`absolute inset-0 block w-full transition-opacity duration-700 ${theme === 'dark' ? 'opacity-0' : 'opacity-100'}`}
          />
        </div>
      </motion.div>
    </section>
  )
}

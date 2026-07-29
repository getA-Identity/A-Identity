import { useNavigate } from 'react-router-dom'
import { motion, type Variants } from 'framer-motion'
import { ArrowRight, ArrowUpRight, Sparkles } from 'lucide-react'
import { CAL_URL, EASE_OUT_EXPO } from '../lib/brand'
import LiveTicker from './sections/LiveTicker'

/*
 * Clean, left-weighted hero (sits over the video's scrimmed side). The interactive live
 * trust lookup moved into the ⌘K spotlight (TrustSpotlight) so the hero stays uncluttered;
 * the "Verify an agent" button opens it. Palette unchanged (accent #7342E2 + ink + cream).
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

  return (
    <section className="relative z-10 mx-auto w-full max-w-[1280px] px-5 sm:px-8" style={{ paddingTop: 'clamp(56px, 10vw, 104px)' }}>
      {/* Split hero: the claim on the left, the proof on the right. The ticker column is the
          BlockRun lesson: a landing that opens with its own verifiable numbers does not need
          to spend copy convincing anyone. Below lg it stacks under the CTAs. */}
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="max-w-[640px]">
        <motion.h1 custom={0} variants={fadeUp} initial="hidden" animate="visible"
          style={{ fontFamily: 'var(--font-heading)', fontSize: 'clamp(2.4rem, 6.5vw, 4.4rem)', lineHeight: 1.0, letterSpacing: '-0.035em', color: 'var(--foreground)' }}>
          Trust, before<br />you pay.
        </motion.h1>

        <motion.p custom={1} variants={fadeUp} initial="hidden" animate="visible"
          className="mt-6 max-w-md text-foreground/65"
          style={{ fontFamily: 'var(--font-body)', fontSize: 'clamp(1rem, 2.4vw, 1.15rem)', lineHeight: 1.6 }}>
          A verified on-chain identity and a bounded wallet for every AI agent.
        </motion.p>

        <motion.div custom={2} variants={fadeUp} initial="hidden" animate="visible" className="mt-9 flex flex-wrap items-center gap-3.5">
          <motion.button type="button" onClick={() => navigate('/signup')} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            className="inline-flex items-center gap-2.5 rounded-full px-6 py-3.5 text-sm font-semibold text-white sm:text-base"
            style={{ background: ACCENT, boxShadow: '0 10px 34px rgba(115,66,226,0.34)', border: '1px solid transparent' }}>
            Get your Agent ID <ArrowRight size={18} />
          </motion.button>

          <motion.button type="button" onClick={openSpotlight} whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
            className="group inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-5 py-3.5 text-sm font-semibold text-foreground backdrop-blur-md transition-colors hover:border-accent/50 sm:text-base"
            style={{ borderColor: undefined }}>
            <Sparkles size={17} style={{ color: ACCENT }} className="transition-transform group-hover:rotate-12" />
            Verify an agent
            <kbd className="ml-1 hidden rounded border border-border px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground/55 sm:inline">{kbd}</kbd>
          </motion.button>

          <a
            href={CAL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-2 py-3 text-sm font-semibold text-foreground/60 transition-colors hover:text-foreground"
          >
            Book a call <ArrowUpRight size={15} />
          </a>
        </motion.div>
      </div>

      <motion.div custom={3} variants={fadeUp} initial="hidden" animate="visible" className="w-full max-w-[440px] lg:max-w-none">
        <LiveTicker />
      </motion.div>
      </div>
    </section>
  )
}

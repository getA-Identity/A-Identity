import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight, ShieldCheck } from 'lucide-react'
import { Button } from '../ui/button'
import { CAL_URL, EASE_OUT_EXPO } from '../../lib/brand'
import { OwlMascot } from '../OwlMascot'
import { SectionBackdrop } from '../ui/section-backdrop'

const ACCENT = '#7342E2'

/**
 * The closing ask. One clear action, restated. Opens the same claim/verify popup so a
 * visitor never has to leave to start.
 */
export default function CloseCta() {
  const navigate = useNavigate()
  const openSpotlight = () => window.dispatchEvent(new Event('open-trust-spotlight'))
  return (
    <section className="relative w-full overflow-hidden bg-background px-5 py-16 text-foreground sm:px-8 sm:py-20">
      <SectionBackdrop name="cta" position="right" />
      {/* The dashx close: one tinted band, centered, the owl presiding. Same ask as before,
          plus the booking link for whoever wants a human first. */}
      <div className="mx-auto max-w-[1080px] rounded-[2rem] border border-accent/20 bg-accent/[0.05] px-6 py-14 text-center sm:px-12 sm:py-16">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
        >
          <OwlMascot variant="soft" width={220} className="mx-auto -mb-3 w-[220px] max-w-full" />
        </motion.div>
        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
          className="mx-auto max-w-2xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Give your agent an identity.
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO, delay: 0.08 }}
          className="mx-auto mt-5 max-w-md text-lg font-medium leading-relaxed text-foreground/75"
        >
          It takes one signature. No gas, no signup.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO, delay: 0.16 }}
          className="mt-9 flex flex-wrap items-center justify-center gap-3.5"
        >
          <Button
            type="button"
            size="lg"
            onClick={() => navigate('/signup')}
            className="px-7 py-3.5 text-[15px] sm:text-base"
            style={{ boxShadow: '0 10px 34px rgba(115,66,226,0.34)' }}
          >
            Get your Agent ID <ArrowRight size={18} />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={openSpotlight}
            className="bg-card px-6 py-3.5 text-[15px] hover:border-accent/50 sm:text-base"
          >
            <ShieldCheck size={17} style={{ color: ACCENT }} />
            Verify an agent
          </Button>
          <Button asChild variant="ghost" size="lg" className="text-foreground/80 hover:text-foreground">
            <a href={CAL_URL} target="_blank" rel="noopener noreferrer">
              Book a call <ArrowUpRight size={15} />
            </a>
          </Button>
        </motion.div>
      </div>
    </section>
  )
}

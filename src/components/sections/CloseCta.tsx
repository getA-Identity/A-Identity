import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowRight, Sparkles } from 'lucide-react'
import { EASE_OUT_EXPO } from '../../lib/brand'

const ACCENT = '#7342E2'

/**
 * The closing ask. One clear action, restated. Opens the same claim/verify popup so a
 * visitor never has to leave to start.
 */
export default function CloseCta() {
  const navigate = useNavigate()
  const openSpotlight = () => window.dispatchEvent(new Event('open-trust-spotlight'))
  return (
    <section className="w-full bg-background px-5 py-28 text-foreground sm:px-8 sm:py-36">
      <div className="mx-auto max-w-[1080px]">
        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO }}
          className="max-w-2xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Give your agent an identity.
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO, delay: 0.08 }}
          className="mt-5 max-w-md text-lg leading-relaxed text-foreground/55"
        >
          It takes one signature. No gas, no signup.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: EASE_OUT_EXPO, delay: 0.16 }}
          className="mt-9 flex flex-wrap items-center gap-3.5"
        >
          <button
            type="button"
            onClick={() => navigate('/signup')}
            className="inline-flex items-center gap-2.5 rounded-full px-6 py-3.5 text-sm font-semibold text-white sm:text-base"
            style={{ background: ACCENT, boxShadow: '0 10px 34px rgba(115,66,226,0.34)' }}
          >
            Get your Agent ID <ArrowRight size={18} />
          </button>
          <button
            type="button"
            onClick={openSpotlight}
            className="group inline-flex items-center gap-2 rounded-full border border-border bg-card px-5 py-3.5 text-sm font-semibold text-foreground transition-colors hover:border-accent/50 sm:text-base"
          >
            <Sparkles size={17} style={{ color: ACCENT }} className="transition-transform group-hover:rotate-12" />
            Verify an agent
          </button>
        </motion.div>
      </div>
    </section>
  )
}

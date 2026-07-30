import { motion } from 'framer-motion'
import { Eyebrow } from '../ui/display'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: EASE_OUT_EXPO },
}

/**
 * The one-idea editorial beat: why this layer needs to exist now. Restyled to the
 * globalblaw stance: a small tracked eyebrow, a large heading in the BODY face at
 * normal weight (the quiet-confidence voice, deliberately not the display bold every
 * other section uses), and a full-measure paragraph, all on one left edge. No cards,
 * no grid; the restraint is the design.
 */
export default function Shift() {
  return (
    <section className="w-full bg-background px-5 py-16 text-foreground sm:px-8 sm:py-24">
      <div className="mx-auto max-w-[1080px]">
        <motion.div {...reveal}>
          <Eyebrow className="mb-3">Why now</Eyebrow>
        </motion.div>
        <motion.h2
          {...reveal}
          className="text-[clamp(1.8rem,3.4vw,2.45rem)] font-normal leading-[1.1] tracking-[-0.015em] text-foreground"
          style={{ fontFamily: 'var(--font-body)' }}
        >
          Agents can already book the flight. They still pay with your card and your
          password.
        </motion.h2>
        <motion.p
          {...reveal}
          transition={{ ...reveal.transition, delay: 0.1 }}
          className="mt-4 max-w-[52rem] text-[1.05rem] leading-[1.75] text-foreground/60"
        >
          The hard part is no longer making agents capable. It is letting them prove who they
          are and move money on their own, without handing over the keys to everything.
          That is the layer A-Identity builds.
        </motion.p>
      </div>
    </section>
  )
}

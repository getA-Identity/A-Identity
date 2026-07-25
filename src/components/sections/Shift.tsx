import { motion } from 'framer-motion'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: EASE_OUT_EXPO },
}

/**
 * The one-idea editorial beat: why this layer needs to exist now. No cards, no grid,
 * a single confident statement that earns the rest of the page.
 */
export default function Shift() {
  return (
    <section className="w-full bg-background px-5 py-28 text-foreground sm:px-8 sm:py-36">
      <div className="mx-auto max-w-[1080px]">
        <motion.p
          {...reveal}
          className="max-w-3xl text-3xl font-bold leading-[1.2] tracking-tight sm:text-[2.7rem]"
          style={{ fontFamily: 'var(--font-heading)' }}
        >
          Agents can already book the flight.
          <br />
          They still pay with your card and your password.
        </motion.p>
        <motion.p {...reveal} transition={{ ...reveal.transition, delay: 0.1 }} className="mt-7 max-w-xl text-lg leading-relaxed text-foreground/55">
          The hard part is no longer making agents capable. It is letting them prove who they
          are and move money on their own, without handing over the keys to everything.
          That is the layer A-Identity builds.
        </motion.p>
      </div>
    </section>
  )
}

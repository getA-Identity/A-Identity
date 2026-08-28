import { motion } from 'framer-motion'
import { Clock } from 'lucide-react'
import { Eyebrow } from '../ui/display'
import { EASE_OUT_EXPO } from '../../lib/brand'

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-80px' },
  transition: { duration: 0.7, ease: EASE_OUT_EXPO },
}

/** Staggered version, so the block arrives top to bottom rather than all at once. */
const revealAt = (i: number) => ({
  ...reveal,
  transition: { ...reveal.transition, delay: i * 0.07 },
})

/**
 * The one-idea editorial beat: why this layer needs to exist now.
 *
 * Centered rather than left-aligned, because this section makes a single claim and a
 * single claim wants a stage, not a column. The heading stays in the BODY face at normal
 * weight (the quiet-confidence voice, deliberately not the display bold every other
 * section uses) but it is bigger now, and so is the room around it: this is the argument
 * the rest of the page is built on, and it was sized like a footnote.
 *
 * The subtitle is the part that changed most. It carried the actual argument while
 * rendering at body size in 60% foreground, which is the styling of fine print. It is now
 * a real second line: larger, medium weight, 75% foreground, on a measure short enough to
 * read in one pass, with the conclusion split onto its own full-contrast line.
 *
 * The eyebrow badge carries the clock itself: a detached icon tile above a whisper of a
 * label read as two unrelated ornaments, and this block opens the page's argument.
 */
export default function Shift() {
  return (
    <section className="w-full bg-background px-5 py-24 text-foreground sm:px-8 sm:py-32">
      <div className="mx-auto flex max-w-[960px] flex-col items-center text-center">
        <motion.div {...revealAt(0)}>
          <Eyebrow icon={Clock}>Why now</Eyebrow>
        </motion.div>

        <motion.h2
          {...revealAt(1)}
          className="mt-6 max-w-[26ch] text-[clamp(2.1rem,4.8vw,3.4rem)] font-normal leading-[1.06] tracking-[-0.02em] text-foreground"
          style={{ fontFamily: 'var(--font-body)', textWrap: 'balance' }}
        >
          Agents can already book the flight. They still pay with your card and your
          password.
        </motion.h2>

        <motion.p
          {...revealAt(2)}
          className="mt-7 max-w-[52ch] text-[clamp(1.15rem,2vw,1.45rem)] font-medium leading-[1.55] text-foreground/75"
          style={{ textWrap: 'pretty' }}
        >
          The hard part is no longer making agents capable. It is letting them prove who they
          are and move money on their own, without handing over the keys to everything.
        </motion.p>

        <motion.p
          {...revealAt(3)}
          className="mt-5 text-[clamp(1.05rem,1.7vw,1.25rem)] font-semibold tracking-[-0.01em] text-foreground"
        >
          That is the layer A-Identity builds.
        </motion.p>
      </div>
    </section>
  )
}

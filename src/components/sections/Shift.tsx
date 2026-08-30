import { motion } from 'framer-motion'
import { Clock } from 'lucide-react'
import { Eyebrow } from '../ui/display'
import { SectionShell, revealAt } from '../ui/section'

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
 * a real second line: larger, medium weight, on a measure short enough to read in one
 * pass, with the conclusion split onto its own full-contrast line.
 *
 * It also has pictures now, and that is a structural change rather than a decorative one.
 * This was the only landing section written as a bare <section>, so it could not take a
 * backdrop at all: fourteen sections had a horizon and the one carrying the argument had
 * a blank wall. Moving it onto SectionShell buys the `rails` still (a coin travelling on
 * a rail, which is exactly the sentence underneath it) and the autopilot dial sits above
 * the eyebrow as the section's own mark. Both are existing brand assets, and both are
 * decoration over copy that already says the same thing, so neither is announced to
 * assistive tech.
 */
export default function Shift() {
  return (
    <SectionShell size="lg" backdrop="rails" backdropPosition="center">
      <div className="mx-auto flex max-w-[960px] flex-col items-center text-center">
        {/* A person and an agent, side by side rather than one replacing the other, which
            is the whole argument of this section. Transparent ground, so it reads on the
            rails backdrop in either theme. */}
        <motion.img
          {...revealAt(0)}
          src="/art/alpha/together.webp"
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          className="pointer-events-none h-28 w-auto select-none object-contain sm:h-32"
        />

        <motion.div {...revealAt(1)} className="mt-4">
          <Eyebrow icon={Clock}>Why now</Eyebrow>
        </motion.div>

        <motion.h2
          {...revealAt(2)}
          className="mt-6 max-w-[26ch] text-[clamp(2.1rem,4.8vw,3.4rem)] font-normal leading-[1.06] tracking-[-0.02em] text-foreground"
          style={{ fontFamily: 'var(--font-body)', textWrap: 'balance' }}
        >
          Agents can already book the flight. They still pay with your card and your
          password.
        </motion.h2>

        <motion.p
          {...revealAt(3)}
          className="mt-7 max-w-[46ch] text-[clamp(1.15rem,2vw,1.45rem)] font-medium leading-[1.55] text-foreground/80"
          style={{ textWrap: 'pretty' }}
        >
          Making agents capable is done. Letting them prove who they are and pay for
          themselves, without your keys, is not.
        </motion.p>

        <motion.p
          {...revealAt(4)}
          className="mt-5 text-[clamp(1.05rem,1.7vw,1.25rem)] font-semibold tracking-[-0.01em] text-foreground"
        >
          That is the layer A-Identity builds.
        </motion.p>
      </div>
    </SectionShell>
  )
}

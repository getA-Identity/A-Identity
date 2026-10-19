import { motion, useReducedMotion } from 'framer-motion'
import { reveal } from '../ui/section'
import { MEMBERSHIPS, MEMBERSHIP_MARQUEE_MIN, type Membership } from '../../lib/memberships'

/**
 * The "Member of" band under the Arc spotlight: the programs that admitted us, each as
 * a badge that links to the program's own page.
 *
 * It is a credibility strip, so it is quiet by design: hairlines above and below, the
 * page's own background, marks resting in monochrome. Motion is reserved for intent: a
 * badge under the pointer lifts, its mark takes its colour back, the caption picks up
 * the accent and a rule draws in beneath it. Keyboard focus gets the same treatment, and
 * reduced-motion users get the colour change without the movement.
 *
 * With enough badges the row becomes a marquee (the threshold lives next to the data),
 * which pauses under the pointer or keyboard focus so nothing slides away from a reader.
 * Today the list is short, so the row is a centred static one; the marquee switches on
 * by itself once the list is long enough to deserve it.
 */

const EASE = 'ease-[cubic-bezier(0.22,1,0.36,1)]'

function Badge({ m, tabbable = true }: { m: Membership; tabbable?: boolean }) {
  return (
    <a
      href={m.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={m.label}
      tabIndex={tabbable ? undefined : -1}
      className={`group relative flex shrink-0 items-center gap-3 rounded-2xl border border-transparent px-4 py-3 transition-[transform,border-color,background-color] duration-500 ${EASE} hover:-translate-y-0.5 hover:border-border hover:bg-card focus-visible:-translate-y-0.5 focus-visible:border-accent focus-visible:outline-none motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:focus-visible:translate-y-0`}
    >
      <img
        src={m.mark.src}
        width={m.mark.width}
        height={m.mark.height}
        alt=""
        aria-hidden="true"
        loading="lazy"
        decoding="async"
        className="h-9 w-9 shrink-0 object-contain opacity-70 grayscale transition-[filter,opacity] duration-500 group-hover:opacity-100 group-hover:grayscale-0 group-focus-visible:opacity-100 group-focus-visible:grayscale-0"
      />
      <span className="flex flex-col leading-none">
        <span className="font-heading text-[17px] tracking-[-0.01em] text-foreground/80 transition-colors duration-500 group-hover:text-foreground group-focus-visible:text-foreground">
          {m.org}
        </span>
        <span className="mt-1.5 text-[10.5px] font-bold uppercase tracking-[0.16em] text-foreground/50 transition-colors duration-500 group-hover:text-accent group-focus-visible:text-accent">
          {m.program}
        </span>
      </span>
      {/* The rule that draws in from the left. Decoration, so hidden from assistive tech. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-4 bottom-1.5 h-px origin-left scale-x-0 bg-accent transition-transform duration-500 ${EASE} group-hover:scale-x-100 group-focus-visible:scale-x-100 motion-reduce:transition-none`}
      />
    </a>
  )
}

function Row() {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-2 sm:gap-4">
      {MEMBERSHIPS.map((m) => (
        <li key={m.id}>
          <Badge m={m} />
        </li>
      ))}
    </ul>
  )
}

/* Two identical copies and a translate of exactly half, so the loop point is invisible.
 * The second copy is hidden from assistive tech and its links are not tabbable, so a
 * screen reader hears each membership once. */
function Marquee() {
  return (
    <div className="member-marquee relative min-w-0 flex-1 overflow-hidden">
      <div className="member-marquee-track flex w-max">
        {[0, 1].map((copy) => (
          <ul key={copy} className="flex items-center gap-4 pr-4" aria-hidden={copy > 0 ? true : undefined}>
            {MEMBERSHIPS.map((m) => (
              <li key={m.id}>
                <Badge m={m} tabbable={copy === 0} />
              </li>
            ))}
          </ul>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-background to-transparent"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent"
      />
    </div>
  )
}

export default function MemberOf() {
  const reduced = useReducedMotion()
  if (MEMBERSHIPS.length === 0) return null
  const marquee = MEMBERSHIPS.length >= MEMBERSHIP_MARQUEE_MIN && !reduced
  return (
    <section aria-label="Program memberships" className="relative w-full border-y border-border bg-background px-5 py-7 sm:px-8">
      <motion.div
        {...reveal}
        className="mx-auto flex max-w-[1100px] flex-col items-center gap-4 sm:flex-row sm:justify-center sm:gap-8"
      >
        <p className="shrink-0 text-[11px] font-bold uppercase tracking-[0.18em] text-foreground/55">Member of</p>
        {marquee ? <Marquee /> : <Row />}
      </motion.div>
    </section>
  )
}

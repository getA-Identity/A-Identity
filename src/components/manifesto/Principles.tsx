import { motion } from 'framer-motion'
import { revealAt } from '../ui/section'
import { PRINCIPLES } from './content'

/**
 * The ten laws as numbered cards: the law in one line, one sentence of why, and the part
 * of the product that keeps it. Two columns from the sm breakpoint, one below it; the
 * "in the product" line is pinned to the card's foot so a row of two cards aligns.
 */
export function Principles() {
  return (
    <ol className="mt-10 grid gap-4 sm:grid-cols-2 sm:gap-5">
      {PRINCIPLES.map((p, i) => (
        <motion.li
          {...revealAt(i % 2)}
          key={p.n}
          className="flex flex-col rounded-2xl border border-border bg-card p-5 sm:p-6"
        >
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] font-bold tracking-[0.14em] text-accent">{p.n}</span>
            <span className="h-px flex-1 bg-foreground/10" />
          </div>
          <h3
            className="mt-3 text-[1.15rem] font-bold leading-snug tracking-tight text-foreground sm:text-xl"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            {p.law}
          </h3>
          <p className="mt-2 text-[14.5px] leading-relaxed text-foreground/65">{p.why}</p>
          <div className="mt-auto border-t border-border pt-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/45">
              In the product
            </span>
            <p className="mt-1 text-[13.5px] leading-relaxed text-foreground/80">{p.product}</p>
          </div>
        </motion.li>
      ))}
    </ol>
  )
}

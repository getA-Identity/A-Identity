import { motion } from 'framer-motion'
import { Ban } from 'lucide-react'
import { reveal } from '../ui/section'
import { REFUSALS } from './content'

/**
 * Four refusals, one line each, with where the code says no written in words rather than
 * file paths: a reader of this page should not need the repository open to follow it.
 */
export function Refusals() {
  return (
    <ul className="mt-10 overflow-hidden rounded-2xl border border-border bg-card">
      {REFUSALS.map((r) => (
        <motion.li
          {...reveal}
          key={r.title}
          className="flex gap-4 border-t border-border p-5 first:border-t-0 sm:gap-5 sm:p-6"
        >
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger ring-1 ring-inset ring-danger/25">
            <Ban size={15} strokeWidth={2.4} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3
              className="text-base font-bold tracking-tight text-foreground sm:text-lg"
              style={{ fontFamily: 'var(--font-heading)' }}
            >
              {r.title}
            </h3>
            <p className="mt-1.5 text-[14.5px] leading-relaxed text-foreground/65">
              <span className="font-semibold text-foreground/80">Where the code says no: </span>
              {r.enforced}
            </p>
          </div>
        </motion.li>
      ))}
    </ul>
  )
}

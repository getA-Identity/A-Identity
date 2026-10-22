import { motion } from 'framer-motion'
import { ArrowRight, Fingerprint, KeyRound, Network, Receipt, ShieldCheck, type LucideIcon } from 'lucide-react'
import { reveal } from '../ui/section'
import { MECHANISMS } from './content'

const ICONS: readonly LucideIcon[] = [Fingerprint, KeyRound, ShieldCheck, Receipt, Network]

/**
 * Principle, mechanism, standard: five rows that map the vocabulary of the manifesto onto
 * the parts of the product. One grid that is three columns from md and a stacked card
 * below it, so nothing has to scroll sideways on a phone.
 */
export function MechanismMap() {
  return (
    <div className="mt-10 overflow-hidden rounded-2xl border border-border bg-card">
      <div className="hidden grid-cols-[160px_220px_1fr] gap-x-6 border-b border-border px-6 py-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/45 md:grid">
        <span>Principle</span>
        <span>Mechanism</span>
        <span>The standard behind it</span>
      </div>
      {MECHANISMS.map((m, i) => {
        const Icon = ICONS[i]
        return (
          <motion.div
            {...reveal}
            key={m.principle}
            className="grid gap-x-6 gap-y-2 border-b border-border px-5 py-5 last:border-b-0 sm:px-6 md:grid-cols-[160px_220px_1fr] md:items-start"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                <Icon size={14} strokeWidth={2.4} aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-foreground">{m.principle}</span>
            </div>
            <div className="flex items-baseline gap-2 md:block">
              <ArrowRight size={13} className="relative top-0.5 shrink-0 text-foreground/35 md:hidden" aria-hidden="true" />
              <span className="text-base font-bold tracking-tight text-foreground" style={{ fontFamily: 'var(--font-heading)' }}>
                {m.mechanism}
              </span>
              <span className="block text-[12.5px] leading-snug text-foreground/55">{m.gloss}</span>
            </div>
            <p className="text-sm leading-relaxed text-foreground/65">{m.standard}</p>
          </motion.div>
        )
      })}
    </div>
  )
}

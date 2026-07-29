import type { ReactNode } from 'react'
import { CheckCircle2, ExternalLink } from 'lucide-react'

/**
 * One completed step in a settlement flow: a tick, what happened, and where to verify it.
 *
 * The gateway and nanopay panels each carried a private copy of this, identical down to the
 * icon sizes. It reads as a receipt line, which is why the tick is not optional: every place
 * this renders, the thing already happened.
 *
 * The explorer link is the point of the component. A demo panel that only says "done" is a
 * claim; one that hands you the transaction is evidence.
 */
export function DataRow({
  label,
  value,
  link,
  linkText,
  badge,
}: {
  label: string
  value?: string
  link?: string
  linkText?: string
  badge?: ReactNode
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-foreground/8 bg-background/40 px-3 py-2">
      <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />
      <span className="text-foreground/75">{label}</span>
      {badge}
      <span className="ml-auto flex items-center gap-2">
        {value && <span className="text-xs font-semibold text-foreground/50">{value}</span>}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-accent hover:underline"
          >
            {linkText ?? 'link'} <ExternalLink size={9} />
          </a>
        )}
      </span>
    </div>
  )
}

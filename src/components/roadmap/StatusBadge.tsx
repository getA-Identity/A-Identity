import { statusMeta, type RoadmapStatus } from '../../lib/roadmap'
import { cn } from '../../lib/utils'
import { STATUS_UI } from './roadmap-ui'

/**
 * The status pill. The word is always rendered and the glyph differs per status, so the
 * answer survives greyscale and a screen reader alike; the aria-label spells it out rather
 * than leaving an uppercase word next to an unlabelled icon.
 */
export function StatusBadge({
  status,
  size = 'sm',
  className = '',
}: {
  status: RoadmapStatus
  size?: 'sm' | 'md'
  className?: string
}) {
  const { Icon, chip } = STATUS_UI[status]
  const { label } = statusMeta(status)
  return (
    <span
      aria-label={`Status: ${label}`}
      className={cn(
        'inline-flex shrink-0 items-center rounded-full font-bold uppercase leading-none tracking-[0.08em] ring-1 ring-inset',
        size === 'sm' ? 'gap-1.5 px-2.5 py-1 text-[11px]' : 'gap-2 px-3.5 py-1.5 text-[13px]',
        chip,
        className,
      )}
    >
      <Icon size={size === 'sm' ? 12 : 15} strokeWidth={2.4} aria-hidden="true" />
      {label}
    </span>
  )
}

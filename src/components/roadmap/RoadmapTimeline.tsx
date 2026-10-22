import type { ShippedMonth } from '../../lib/roadmap'
import { cn } from '../../lib/utils'
import { RoadmapItemCard } from './RoadmapItemCard'
import { STATUS_UI } from './roadmap-ui'

/**
 * The shipped items along one vertical line, newest first, grouped by month.
 *
 * The line and its markers are drawn from the left gutter: a larger ring where a month
 * begins, a small filled dot per item, both centred on the rule. The offsets below are
 * computed, not tuned: the gutter is 28px on phones (the rule sits 6px in) and 40px from
 * `sm` (9px in), and each marker is shifted left by the gutter plus half its own width so
 * its centre lands on the rule.
 */
export function RoadmapTimeline({ months }: { months: ShippedMonth[] }) {
  let running = 0
  return (
    <div className="relative mt-10 pl-7 sm:pl-10">
      <span aria-hidden="true" className="absolute bottom-4 left-[6px] top-4 w-px bg-border sm:left-[9px]" />
      <ol className="space-y-10">
        {months.map((month) => (
          <li key={month.key} className="relative">
            <div className="relative mb-4 flex items-baseline gap-3">
              <span
                aria-hidden="true"
                className="absolute left-[-29px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-ok bg-background sm:left-[-39px] sm:h-[18px] sm:w-[18px]"
              />
              <p className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-foreground/60">
                {month.label}
              </p>
              <span className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/40">
                {month.items.length} shipped
              </span>
            </div>
            <ul className="space-y-4">
              {month.items.map((item) => (
                <RoadmapItemCard
                  key={item.id}
                  item={item}
                  index={running++}
                  marker={
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute left-[-27px] top-7 h-2.5 w-2.5 rounded-full border-2 sm:left-[-36px] sm:top-8',
                        STATUS_UI.shipped.dot,
                      )}
                    />
                  }
                />
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  )
}

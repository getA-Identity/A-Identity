import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

/**
 * The console's single page shell.
 *
 * Every screen used to set its own width, five different max-widths across seven pages,
 * so the frame jumped on each navigation and the heading landed somewhere new every
 * time. The canvas now lives in AppLayout and never moves. A page only chooses how wide
 * its BODY runs inside that canvas, and because the body column is left-aligned rather
 * than centred, the heading stays anchored to the same edge either way.
 *
 * `width`:
 *   'full' (default) for dashboards, card grids and tables, which want the whole canvas
 *   'form'           for reading and editing, where a long measure hurts more than the
 *                    empty space on the right
 */
export default function AppPage({
  title,
  description,
  actions,
  width = 'full',
  children,
}: {
  title: ReactNode
  description?: ReactNode
  /** Right-hand side of the header row: a status pill, a primary action. */
  actions?: ReactNode
  width?: 'full' | 'form'
  children: ReactNode
}) {
  return (
    <div className="w-full">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-foreground/55">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>

      {/* The shell owns the gap under the header. `first-child:mt-0` lets each page keep
          its own rhythm between blocks without the first one double-spacing, and it
          still works when that first block is a conditional banner. */}
      <div className={cn('mt-6 [&>*:first-child]:mt-0', width === 'form' && 'max-w-3xl')}>
        {children}
      </div>
    </div>
  )
}

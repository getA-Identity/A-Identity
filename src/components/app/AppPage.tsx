import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { useConsoleAmbient } from './consoleAmbient'

/**
 * The console's single page shell.
 *
 * The measure lives here: every page runs in one centered column so the frame
 * never shifts between screens. `width` only chooses how wide the BODY runs
 * inside it ('full' for dashboards and grids, 'form' for reading and editing).
 *
 * The head and the body's direct children are the console's animation "rows":
 * the screen-transition stagger in console.css targets `.console-page-head` and
 * `.console-page-body > *`, so a page gets its entrance choreography for free
 * by keeping its top-level blocks as direct children.
 *
 * `ambient` asks the SHELL to draw the cursor-reactive dot field behind the
 * whole content pane (hero surfaces only; dense working screens stay quiet).
 * The shell owns the layer because it has to run edge to edge, wider than this
 * page's column, and stay put while the page scrolls over it.
 */
export default function AppPage({
  title,
  description,
  actions,
  width = 'full',
  ambient = false,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  /** Right-hand side of the header row: a status pill, a primary action. */
  actions?: ReactNode
  width?: 'full' | 'form'
  /** Cursor-reactive dot layer behind the pane (Overview-style hero surfaces). */
  ambient?: boolean
  children: ReactNode
}) {
  useConsoleAmbient(ambient)
  return (
    <div className="relative mx-auto w-full max-w-[920px]">
      <header className="console-page-head relative flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-2xl">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-foreground/55">{description}</p>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>

      {/* The shell owns the gap under the header. `first-child:mt-0` lets each page keep
          its own rhythm between blocks without the first one double-spacing. */}
      <div
        className={cn(
          'console-page-body relative mt-6 [&>*:first-child]:mt-0',
          width === 'form' && 'max-w-3xl',
        )}
      >
        {children}
      </div>
    </div>
  )
}

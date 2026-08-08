import { useEffect, useState } from 'react'

type Phase = 'idle' | 'exiting' | 'entering'

/** Exit pane run (cn-pane-out-*). */
const EXIT_MS = 160
/** Enter pane run (cn-pane-in-*). */
const ENTER_MS = 340

/**
 * Directional tab transition. The pane renders the COMMITTED tab; on change the
 * old pane slides out toward the click direction (160ms), the committed tab
 * swaps, and the new pane slides in from the opposite side (320ms). Direction
 * comes from comparing tab indices in `order`, so clicking a tab to the right
 * always reads as moving forward.
 *
 * Render the returned `shown` tab's content inside a div with `className`, and
 * keep an `overflow-x: clip` ancestor (`cn-tab-clip`) so the +/-48px travel
 * never creates a horizontal scrollbar.
 */
export function useTabCarousel<T extends string>(active: T, order: readonly T[]) {
  const [shown, setShown] = useState<T>(active)
  const [phase, setPhase] = useState<Phase>('idle')
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd')

  useEffect(() => {
    if (active === shown) return
    setDir(order.indexOf(active) > order.indexOf(shown) ? 'fwd' : 'back')
    setPhase('exiting')
    const t = setTimeout(() => {
      setShown(active)
      setPhase('entering')
    }, EXIT_MS)
    return () => clearTimeout(t)
  }, [active, shown, order])

  useEffect(() => {
    if (phase !== 'entering') return
    const t = setTimeout(() => setPhase('idle'), ENTER_MS)
    return () => clearTimeout(t)
  }, [phase, shown])

  const className = `cn-pane${phase !== 'idle' ? ` phase-${phase} dir-${dir}` : ''}`
  return { shown, className }
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useLocation, useOutlet } from 'react-router-dom'

export type ScreenPhase = 'entering' | 'exiting' | 'idle'

/** Exit run = 140ms rows + 60ms max stagger (see console.css). */
const EXIT_MS = 200
/** Enter run = 400ms rows + 160ms max stagger. */
const ENTER_MS = 560

/**
 * Routes render a COMMITTED location, not the live one.
 *
 * On navigation the old screen stays mounted for {@link EXIT_MS} playing its row
 * exit, then the committed outlet swaps and the new screen plays its row enter.
 * Pure timers, no animationend listeners: the constants are tuned to the CSS
 * durations, and because the keyframes use `both` fill, reduced-motion (which
 * crushes durations to 0.01ms) degrades to instant swaps while the timers run
 * unchanged.
 *
 * The outlet element is frozen by value: `useOutlet()` returns a new element for
 * the live location every render, but we keep rendering the element captured at
 * commit time, so the old page's route context stays intact during its exit.
 */
export function useScreenTransition(): { node: ReactNode; screenKey: string; phase: ScreenPhase } {
  const location = useLocation()
  const outlet = useOutlet()
  const liveOutlet = useRef(outlet)
  liveOutlet.current = outlet

  const [shown, setShown] = useState<{ key: string; node: ReactNode }>(() => ({
    key: location.pathname,
    node: outlet,
  }))
  const [phase, setPhase] = useState<ScreenPhase>('entering')

  useEffect(() => {
    if (location.pathname === shown.key) return
    setPhase('exiting')
    const t = setTimeout(() => {
      setShown({ key: location.pathname, node: liveOutlet.current })
      setPhase('entering')
    }, EXIT_MS)
    // A navigation arriving mid-exit clears this timer and restarts the exit
    // against the newest destination, so rapid clicks never interleave swaps.
    return () => clearTimeout(t)
  }, [location.pathname, shown.key])

  useEffect(() => {
    if (phase !== 'entering') return
    const t = setTimeout(() => setPhase('idle'), ENTER_MS)
    return () => clearTimeout(t)
  }, [phase, shown.key])

  return { node: shown.node, screenKey: shown.key, phase }
}

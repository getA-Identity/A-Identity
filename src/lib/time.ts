import { useEffect, useState } from 'react'

/**
 * Relative-time helpers for the console.
 *
 * Kept out of the component file so the component module exports only a component: mixing
 * the two breaks fast refresh, and the console is exactly the surface you iterate on with
 * the browser open.
 */

/** "just now" / "8s ago" / "12m ago" / "3h ago" / "2d ago". */
export function relTime(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/**
 * A clock that re-renders the caller on an interval.
 *
 * Stops while the tab is hidden, so a backgrounded console is not waking up every few
 * seconds to recompute the word "ago", and catches up the moment it comes back.
 */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (id) clearInterval(id)
      id = undefined
    }
    const start = () => {
      stop()
      id = setInterval(() => setNow(Date.now()), intervalMs)
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        setNow(Date.now())
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [intervalMs])
  return now
}

import { useEffect, useState } from 'react'
import { apiFetch } from './api'

/**
 * Helpers shared by the per-chain landing pages (/arc, /algorand). Kept out of the component
 * file so fast refresh keeps working there.
 */

export function useCountUp(target: number | null, duration = 900) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (target == null) return
    const start = performance.now()
    let raf = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration)
      setValue(target * (1 - Math.pow(1 - t, 3)))
      if (t < 1) raf = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}

/** A GET that answers null instead of throwing, so a slow rail never blanks a page. */
export async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await apiFetch(path)
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

/** The agents a visitor can check with one click. */
export const CHECK_EXAMPLES = [
  { label: 'Meridian', q: '849980' },
  { label: 'OKX.AI #6271', q: 'eip155:196:8004/6271' },
]


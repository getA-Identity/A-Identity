/**
 * Character-by-character typewriter used by the agent profile certificate
 * hero. Extracted verbatim from AgentProfile.tsx; must preserve the reveal
 * timing, the instant fill under prefers-reduced-motion, and the
 * `lines.join('\n')` dependency (restart on content change, not on array
 * identity) exactly as they were.
 */
import { useEffect, useState } from 'react'

/**
 * Reveal a set of labelled lines one after another, character by character,
 * like a certificate being typed onto the card. Reduced motion (or a finished
 * run) renders everything instantly.
 */
export function useTypewriter(lines: string[], speedMs = 22) {
  const [progress, setProgress] = useState(0) // total characters revealed
  const total = lines.reduce((s, l) => s + l.length, 0)

  useEffect(() => {
    setProgress(0)
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setProgress(total)
      return
    }
    const iv = setInterval(() => {
      setProgress((p) => {
        if (p >= total) {
          clearInterval(iv)
          return p
        }
        return p + 1
      })
    }, speedMs)
    return () => clearInterval(iv)
  }, [lines.join('\n'), total, speedMs]) // eslint-disable-line react-hooks/exhaustive-deps

  let remaining = progress
  const revealed = lines.map((l) => {
    const take = Math.max(0, Math.min(l.length, remaining))
    remaining -= take
    return l.slice(0, take)
  })
  const activeLine = revealed.findIndex((r, i) => r.length < lines[i].length)
  return { revealed, done: progress >= total, activeLine }
}

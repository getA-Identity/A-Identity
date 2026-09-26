/** Small text helpers shared by the /check page and its paid checks. */

export const n = (v: number) => v.toLocaleString('en-US')
export const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`

/** "Aug 16", or "Aug 16, 2025" when it is not this year. UTC, so it is the same day for everyone. */
export function day(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', timeZone: 'UTC' })
}

/** Ends a sentence with a full stop unless it already has its own. */
export const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`)

/** An Algorand address short enough for a button: ABCD...WXYZ. */
export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}...${a.slice(-4)}` : a)

export const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

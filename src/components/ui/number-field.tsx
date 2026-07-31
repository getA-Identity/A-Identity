import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

/**
 * A money/number input that survives half-typed values.
 *
 * A controlled `<input type="number">` reports `value === ''` while the text is not yet a
 * valid number ("0.", "1e"), so parsing on every keystroke rewrites the field and eats the
 * character just typed: "0.5" is impossible to enter, which matters for the auto-approve
 * threshold. This keeps the raw text locally, publishes the parsed number as soon as it IS
 * parseable, clamps to [min, max], and re-syncs from the prop only when the value really
 * changed on the outside (initial load, reset, another agent selected).
 */
export function NumberField({
  value,
  onChange,
  min = 0,
  max,
  className,
  id,
  label,
}: {
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  className?: string
  id?: string
  /** Accessible name, when there is no visible <label htmlFor>. */
  label?: string
}) {
  const [text, setText] = useState(() => String(value))
  // The last number this field handed upward. Lets us tell "the parent changed the value"
  // apart from "the parent is echoing back what we just published".
  const published = useRef(value)

  useEffect(() => {
    if (value !== published.current) {
      published.current = value
      setText(String(value))
    }
  }, [value])

  const clamp = (n: number) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n))

  const onType = (raw: string) => {
    setText(raw)
    const n = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(n)) return // mid-typing, publish nothing yet
    const next = clamp(n)
    published.current = next
    onChange(next)
  }

  // Normalize on the way out: an empty or unparseable field reverts to the last good
  // number, and a clamped one shows the number that was actually applied.
  const onBlur = () => setText(String(published.current))

  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={text}
      onChange={(e) => onType(e.target.value)}
      onBlur={onBlur}
      className={cn(
        'w-full rounded-xl border border-foreground/10 bg-background/40 px-3 py-2.5 text-sm tabular-nums outline-none focus:border-accent',
        className,
      )}
    />
  )
}

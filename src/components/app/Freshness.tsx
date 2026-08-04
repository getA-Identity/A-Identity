import { cn } from '../../lib/utils'
import { relTime, useNow } from '../../lib/time'

/**
 * "updated 8s ago", ticking.
 *
 * The console reads real figures off a chain and then never says when it read them, which
 * leaves the reader to decide for themselves whether a number is current. "live" is an
 * assertion; a timestamp is evidence. Every live figure carries one.
 *
 * `at` is the wall-clock ms when the value was READ, not when it happened on-chain. Those
 * are different claims and this component only makes the first one.
 */
export default function Freshness({
  at,
  prefix = 'updated',
  className,
}: {
  /** ms timestamp of the read, or null while we have not read anything yet. */
  at: number | null
  prefix?: string
  className?: string
}) {
  const now = useNow()
  if (at == null) return null
  return (
    <span
      className={cn('whitespace-nowrap tabular-nums', className)}
      title={`Read at ${new Date(at).toLocaleTimeString()}`}
    >
      {prefix} {relTime(at, now)}
    </span>
  )
}

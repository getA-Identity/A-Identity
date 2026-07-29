import OwlMark, { type OwlVerdict } from './OwlMark'

/**
 * An agent's avatar: a deterministic identicon, with the owl reporting its verdict.
 *
 * Both halves are load-bearing and neither replaces the other. The identicon is derived from
 * the address or token id, so two agents never look alike and a swapped address is visible
 * at a glance, which matters more in a trust product than it does in a social one. The owl
 * badge is the decision, so a list of agents can be scanned for risk without reading a
 * single pill.
 *
 * Dropping the identicon in favour of a shared owl would have made every row look the same,
 * which is the opposite of what an avatar is for.
 */

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

export default function AgentAvatar({
  seed,
  size = 44,
  verdict,
  className = '',
}: {
  seed: string
  size?: number
  /** Omitted when nothing has been decided yet, and then no badge is drawn. */
  verdict?: OwlVerdict
  className?: string
}) {
  const h = hash(seed)
  const hue = h % 360
  const fg = `hsl(${hue} 62% 52%)`
  const cells: boolean[] = []
  for (let c = 0; c < 3; c++) for (let r = 0; r < 5; r++) cells[r * 3 + c] = ((h >> (r * 3 + c)) & 1) === 1
  const at = (r: number, c: number) => cells[r * 3 + (c < 3 ? c : 4 - c)]
  const u = size / 5

  // Large enough to read the eye colour, small enough not to cover the identicon.
  const badge = Math.max(16, Math.round(size * 0.52))

  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        className="rounded-lg"
        style={{ background: `hsl(${hue} 40% 96% / 0.06)` }}
        aria-hidden="true"
      >
        {Array.from({ length: 5 }).map((_, r) =>
          Array.from({ length: 5 }).map((_, c) =>
            at(r, c) ? <rect key={`${r}-${c}`} x={c * u} y={r * u} width={u} height={u} fill={fg} /> : null,
          ),
        )}
      </svg>

      {verdict && (
        // The ring is the page surface, not a colour, so the badge reads as lifted off the
        // identicon on every background this lands on.
        <span
          className="absolute -bottom-1 -right-1 grid place-items-center rounded-full bg-card ring-2 ring-[var(--background)]"
          style={{ width: badge, height: badge }}
        >
          <OwlMark verdict={verdict} size={Math.round(badge * 0.86)} />
        </span>
      )}
    </div>
  )
}

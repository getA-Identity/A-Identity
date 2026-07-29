/**
 * The owl as a flat vector mark.
 *
 * The PNG cutouts in OwlMascot are renders: they carry shading, they weigh 200-300 KB, and
 * below roughly 48px the concentric ring eyes turn to mush. This is the same owl redrawn as
 * geometry so it survives a 16px avatar, and so it can be recoloured at runtime, which a
 * render cannot.
 *
 * The eyes are the verdict. That is the whole point of giving a trust product a mascot: the
 * ALLOW / WARN / DENY colours here are the same ones the explorer's risk pill uses, so the
 * owl is reporting the decision rather than decorating next to it. `neutral` is the brand
 * accent, for every surface that is not reporting an outcome.
 *
 * Body colours are the fixed brand palette, not semantic tokens. The mascot keeps its own
 * colours in light and dark alike, the same way a logo does.
 */

export type OwlVerdict = 'neutral' | 'allow' | 'warn' | 'deny'

/** Matches Explorer's VERDICT map, so a pill and a mark never disagree on screen. */
const EYE: Record<OwlVerdict, string> = {
  neutral: '#7342e2',
  allow: '#059669',
  warn: '#d97706',
  deny: '#dc2626',
}

const INK = '#192837'
const CREAM = '#f2f2ee'
const SAND = '#cfc8c5'

const LABEL: Record<OwlVerdict, string> = {
  neutral: 'A-Identity owl',
  allow: 'Verdict: allow',
  warn: 'Verdict: warn',
  deny: 'Verdict: deny',
}

export default function OwlMark({
  verdict = 'neutral',
  size = 32,
  className = '',
  title,
}: {
  verdict?: OwlVerdict
  size?: number
  className?: string
  /** Supply to expose the mark to assistive tech; omitted means decorative. */
  title?: string
}) {
  const eye = EYE[verdict]
  const labelled = title ?? (verdict === 'neutral' ? undefined : LABEL[verdict])

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={labelled ? 'img' : undefined}
      aria-label={labelled}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    >
      {/* Feet first, so the body overlaps them and they read as tucked under. */}
      <path d="M22 52h7v6a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z" fill={SAND} />
      <path d="M35 52h7v6a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3z" fill={SAND} />

      {/* Body: a single egg. The silhouette is the whole mark at small sizes. */}
      <path
        d="M32 3c12.7 0 21.5 10.4 21.5 24.6C53.5 43.4 44.6 57 32 57S10.5 43.4 10.5 27.6C10.5 13.4 19.3 3 32 3z"
        fill={CREAM}
      />

      {/* Wing patches, clipped to the body so they never spill past the silhouette. */}
      <path d="M13.2 34c-1.6-6.6-.6-13 2.4-13s5 5.6 4.4 12.6c-.5 6-2.2 10-4 10-1.4 0-2.2-4-2.8-9.6z" fill={INK} />
      <path d="M50.8 34c1.6-6.6.6-13-2.4-13s-5 5.6-4.4 12.6c.5 6 2.2 10 4 10 1.4 0 2.2-4 2.8-9.6z" fill={INK} />

      {/* Facial disc. */}
      <ellipse cx="32" cy="24" rx="17.6" ry="15.4" fill={INK} />

      {/* Eyes: the verdict. Ring plus pupil, thick enough to hold at 16px. */}
      <circle cx="24.2" cy="23.4" r="6.4" fill="none" stroke={eye} strokeWidth="3.6" />
      <circle cx="39.8" cy="23.4" r="6.4" fill="none" stroke={eye} strokeWidth="3.6" />
      <circle cx="24.2" cy="23.4" r="1.9" fill={eye} />
      <circle cx="39.8" cy="23.4" r="1.9" fill={eye} />

      {/* Beak. */}
      <path d="M32 27.6l3.4 6.2h-6.8z" fill={SAND} />
    </svg>
  )
}

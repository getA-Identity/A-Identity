import { useId } from 'react'

type LogoProps = {
  /** Square edge length in px. Defaults to 32. */
  size?: number
  /**
   * Fill for the mark. Defaults to `currentColor`, so the logo inherits whatever text
   * color surrounds it and is therefore correct in both themes without the caller having
   * to think about it.
   *
   * This used to default to the ink hex, and that was the bug: a shared component that
   * hardcodes a color makes every call site wrong-by-default on a dark surface, and the
   * only way to be right was to remember to pass `fill="currentColor"`. Three call sites
   * remembered and three did not, which is exactly the distribution you get from a default
   * that has to be overridden to be correct.
   *
   * Pass an explicit color only where the background is fixed regardless of theme (the
   * brand-page swatches), so the intent is visible instead of inherited.
   */
  fill?: string
  className?: string
}

/**
 * The A-Identity mark (2026-08 rebrand): the A-I ribbon monogram. An A and an I
 * letterform crossed by a ribbon, drawn on a 512 grid. The geometry comes from the
 * brand kit's mark-mono SVGs and is the single canonical copy in this codebase; the
 * static favicon and the docs logo duplicate it only because static files cannot
 * import TypeScript, and each says so in a comment.
 *
 * Unlike the previous angular mark this is NOT a single path: the ribbon cuts a gap
 * through the letterforms (a luminance mask, color-independent), then draws itself on
 * top. `LogoGlyph` is the whole drawing as an embeddable group, so consumers that
 * compose the mark into their own SVG (BlogCover's watermark) reuse the exact
 * geometry rather than keeping a drifting copy.
 */
export const MARK_VIEWBOX = '0 0 512 512'

/** The ribbon, and the short tail it folds into. Also used, stroked, as the mask cutout. */
const RIBBON_PATHS = [
  'M 108 290 C 240 276 340 282 466 306 L 440 362 C 330 340 240 336 108 352 Z',
  'M 440 362 L 466 352 L 458 430 Q 446 441 436 428 Z',
]

/** The letterforms: the A's legs, then the I stroke. */
const BODY_PATHS = [
  'M 40 472 L 168 48 Q 200 20 232 48 L 344 472 L 282 472 L 200 190 L 102 472 Z',
  'M 368 472 L 381 70 Q 383 56 397 56 L 429 56 Q 443 56 442 70 L 430 472 Z',
]

/**
 * The mark as an embeddable `<g>`, for callers composing it into a larger SVG. The mask
 * id comes from useId because the mark renders several times per page (navbar, footer,
 * mobile sheet, one watermark per blog card): a fixed id would make every instance
 * resolve to whichever mask happened to mount first.
 */
export function LogoGlyph({ fill = 'currentColor' }: { fill?: string }) {
  const maskId = useId()
  return (
    <g>
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" fill="#fff" />
          {RIBBON_PATHS.map((d) => (
            <path key={d} d={d} fill="#000" stroke="#000" strokeWidth="16" />
          ))}
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        {BODY_PATHS.map((d) => (
          <path key={d} d={d} fill={fill} />
        ))}
      </g>
      {RIBBON_PATHS.map((d) => (
        <path key={d} d={d} fill={fill} />
      ))}
    </g>
  )
}

export default function Logo({ size = 32, fill = 'currentColor', className }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      fill="none"
      overflow="visible"
      viewBox={MARK_VIEWBOX}
      className={className}
      aria-hidden="true"
    >
      <LogoGlyph fill={fill} />
    </svg>
  )
}

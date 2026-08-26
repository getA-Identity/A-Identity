type LogoV2Props = {
  /** Square edge length in px. Defaults to 32. */
  size?: number
  /**
   * `gradient` is the primary mark (navy A, violet I, lavender ribbon).
   * `mono` is the single-colour cut for stamps, engraving and low-colour chrome;
   * it inherits `currentColor` unless an explicit `fill` is passed, mirroring the
   * inherit-by-default lesson from the previous mark.
   */
  variant?: 'gradient' | 'mono'
  /** Mono fill only. Ignored by the gradient variant. */
  fill?: string
  className?: string
}

/**
 * The ribbon monogram, the approved 2026 mark: an A and an I bound by one ribbon.
 *
 * How it encodes the product: the A is the agent, the I is the identity, and the
 * ribbon is the verification that ties them. The same stroke is the crossbar of
 * the A and the wrap on the I, because in this product trust and payment are one
 * continuous motion: verify first, then pay.
 *
 * Geometry, 512 grid:
 * - A: apex x=200, outer legs (40,472)-(168,48) and (232,48)-(344,472), stroke 62,
 *   soft apex (quadratic), inner counter apex (200,190).
 * - I: sheared bar, bottom (368..430, y=472), top (383..443, y=56), rounded top.
 * - Ribbon: 62-tall band rising from (96,331) to (470,255) on a gentle curve,
 *   passing BEHIND the left leg (a leg overlay restores it), in front of the
 *   right leg and the I, then folding down the I's right side as a short tail.
 *
 * This is the vector master interpreted from the approved render; the gradient
 * stops live inside the logo only. Site surfaces keep their own tokens.
 */

// The A, one path: outer chevron with soft apex, triangular counter.
const A_PATH =
  'M 40 472 L 168 48 Q 200 20 232 48 L 344 472 L 282 472 L 200 190 L 102 472 Z'

// Segment of the left leg redrawn over the ribbon, so the band reads as passing
// behind it. Edges reuse the exact leg slopes between y=280 and y=380.
const A_LEFT_LEG_OVERLAY = 'M 98 280 L 168.7 280 L 134 380 L 67.8 380 Z'

// The I: sheared bar with a rounded top, standing a touch taller than the A.
const I_PATH =
  'M 368 472 L 381 70 Q 383 56 397 56 L 429 56 Q 443 56 442 70 L 430 472 Z'

// The ribbon, front band: near-flat with a gentle fall to the right, the left tip
// hidden behind the leg overlay, the right end cut on the wrap angle at the I.
const RIBBON_PATH =
  'M 108 290 C 240 276 340 282 466 306 L 440 362 C 330 340 240 336 108 352 Z'

// The short tail folding down the I's right side after the wrap.
const TAIL_PATH = 'M 440 362 L 466 352 L 458 430 Q 446 441 436 428 Z'

export default function LogoV2({
  size = 32,
  variant = 'gradient',
  fill = 'currentColor',
  className,
}: LogoV2Props) {
  if (variant === 'mono') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 512 512"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        {/* The gap mask separates the letters from the ribbon so the weave stays
            readable in one colour: the band (grown by a 16px stroke) is knocked
            out of the letterforms, then drawn solid on top. */}
        <defs>
          <mask id="aid-mono-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
            <rect width="512" height="512" fill="#fff" />
            <path d={RIBBON_PATH} fill="#000" stroke="#000" strokeWidth="16" />
            <path d={TAIL_PATH} fill="#000" stroke="#000" strokeWidth="16" />
          </mask>
        </defs>
        <g mask="url(#aid-mono-gap)">
          <path d={A_PATH} fill={fill} />
          <path d={I_PATH} fill={fill} />
        </g>
        <path d={RIBBON_PATH} fill={fill} />
        <path d={TAIL_PATH} fill={fill} />
      </svg>
    )
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="aid-a" x1="200" y1="20" x2="120" y2="472" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#24398E" />
          <stop offset="1" stopColor="#081B4E" />
        </linearGradient>
        <linearGradient id="aid-i" x1="410" y1="56" x2="400" y2="472" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8F7BF8" />
          <stop offset="0.55" stopColor="#6E54F6" />
          <stop offset="1" stopColor="#24398E" />
        </linearGradient>
        <linearGradient id="aid-ribbon" x1="110" y1="320" x2="466" y2="330" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9F8BF7" />
          <stop offset="0.45" stopColor="#C9BBFF" />
          <stop offset="1" stopColor="#8A75F2" />
        </linearGradient>
        <linearGradient id="aid-tail" x1="450" y1="356" x2="450" y2="436" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4A39BD" />
          <stop offset="1" stopColor="#6E54F6" />
        </linearGradient>
      </defs>
      {/* Paint order is the weave: I, then A, the tail folding down the I, the band
          across both letters, and finally the left leg restored on top. */}
      <path d={I_PATH} fill="url(#aid-i)" />
      <path d={A_PATH} fill="url(#aid-a)" />
      <path d={TAIL_PATH} fill="url(#aid-tail)" />
      <path d={RIBBON_PATH} fill="url(#aid-ribbon)" />
      <path d={A_LEFT_LEG_OVERLAY} fill="url(#aid-a)" />
    </svg>
  )
}

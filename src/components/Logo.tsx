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
 * The A-Identity mark, a geometric angular interlock on a 256 grid. Pure path geometry, so
 * it stays crisp at any `size`.
 */
export const MARK_PATH =
  'M 64 128 L 64.5 128 L 32 95 L 0 64 L 0 0 L 64 0 L 128 64 L 128 64.5 L 161 32 L 192 0 L 256 0 L 256 64 L 192 128 L 128 128 L 128 192 L 96 223 L 63.5 256 L 0 256 L 0 192 Z M 256 192 L 224 223 L 191.5 256 L 128 256 L 128 192 L 192 128 L 256 128 Z'

export default function Logo({ size = 32, fill = 'currentColor', className }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      fill="none"
      overflow="visible"
      viewBox="0 0 256 256"
      className={className}
      aria-hidden="true"
    >
      <path d={MARK_PATH} fill={fill} />
    </svg>
  )
}

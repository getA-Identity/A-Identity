type LogoProps = {
  /** Square edge length in px. Defaults to 32. */
  size?: number
  /**
   * Ignored since the 2026-08 rebrand, kept so existing call sites compile.
   *
   * The mark is now a RASTER: the gradient A-I monogram from the brand kit's
   * main_logo.png (background removed, served from /logo/mark.png). A raster cannot be
   * recoloured with currentColor the way the old vector mark was, so `fill` has nothing
   * to act on. The gradient indigo-violet reads on both light and dark surfaces, which
   * is the trade the rebrand made explicitly: one authentic logo everywhere instead of
   * a theme-adaptive redrawing of it.
   */
  fill?: string
  className?: string
}

/**
 * The A-Identity mark (2026-08 rebrand): the gradient A-I monogram, crossed by a
 * ribbon. Source of truth is the brand kit's main_logo.png; /logo/mark.png is the
 * background-removed square crop of its mark, and /logo/logo-full.png is the full
 * lockup with the wordmark. All derived assets (favicon.png, apple-touch-icon.png,
 * docs/logo.png, the OG card) are cut from the same source, never redrawn.
 */
export default function Logo({ size = 32, className }: LogoProps) {
  return (
    <img
      src="/logo/mark.png"
      width={size}
      height={size}
      className={className}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}

import { cn } from '../../lib/utils'

/**
 * Brand art, placed so it survives both themes.
 *
 * Every illustration in `public/art` is an opaque rectangle rendered on a deep navy
 * ground. Dropped into a card raw it punches a dark hole through the light theme, so
 * nothing here is ever used as a plain <img>. Two treatments, and which one is correct
 * depends entirely on the container:
 *
 *   `medallion` dissolves the edges with a radial mask, turning the navy into a soft disc
 *   on a light surface and letting it vanish into the page on a dark one. This is the
 *   treatment for art sitting directly on a card.
 *
 *   `band` keeps the rectangle and crops it, which only works where the container is
 *   deliberately dark already. Only the two horizontal compositions (gateway, guardrail)
 *   survive a wide crop; the rest are 4:3 with a centred subject and lose it.
 *
 * The art is decoration over copy that already says the same thing, so it is hidden from
 * assistive tech rather than given an alt text that repeats the heading underneath it.
 */
export default function BrandArt({
  src,
  variant = 'medallion',
  className,
  eager,
  objectPosition,
}: {
  /** Path under /art or /mascots, e.g. "/art/art-market.webp". */
  src: string
  variant?: 'medallion' | 'band'
  className?: string
  /** Only for art above the fold on first paint. Everything else stays lazy. */
  eager?: boolean
  objectPosition?: string
}) {
  const mask =
    variant === 'medallion'
      ? 'radial-gradient(circle at 50% 50%, black 58%, transparent 85%)'
      : undefined

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      className={cn('pointer-events-none select-none', className)}
      style={{
        objectFit: 'cover',
        objectPosition,
        ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : null),
      }}
    />
  )
}

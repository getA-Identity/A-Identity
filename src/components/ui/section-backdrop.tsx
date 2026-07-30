import { cn } from '../../lib/utils'

/**
 * The soft brand still that sits behind a section.
 *
 * One generated ceramic form per section (public/section-bg), each matching what the
 * section is about: the lens for the lookup, the gateway for the check, the rails for
 * the chains. They are deliberately whisper-quiet, because a background that competes
 * with the copy is a background that should not exist.
 *
 * Blending, not opacity alone, is what makes one asset work in both themes. Every still
 * is a violet form on an off-white field, so `multiply` drops the field entirely: white
 * multiplied by any surface is that surface. In dark mode the same trick would erase the
 * form too, so there it inverts, rotates the hue back toward violet, and screens instead,
 * which drops the (now near-black) field the same way.
 *
 * Decorative by construction: aria-hidden, pointer-events-none, lazy, and never in the
 * flow. It also never paints on small screens, where a phone should spend its bytes on
 * the content.
 */
export function SectionBackdrop({
  name,
  className = '',
  position = 'right',
}: {
  /** File stem under /public/section-bg. */
  name: string
  className?: string
  /** Which side of the section the still sits on. */
  position?: 'right' | 'left' | 'center'
}) {
  /* Pushed well past the content edge on purpose: the still is texture at the margin,
     not a picture behind the paragraph. */
  const place =
    position === 'left'
      ? 'left-[-20%] top-1/2 -translate-y-1/2'
      : position === 'center'
        ? 'left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2'
        : 'right-[-18%] top-1/2 -translate-y-1/2'

  return (
    <img
      src={`/section-bg/${name}.webp`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      draggable={false}
      className={cn(
        'pointer-events-none absolute hidden w-[min(54vw,760px)] select-none lg:block',
        /* The radial mask is what keeps this from reading as a pasted rectangle: the
           still fades to nothing well before its own edge, so only the form survives.
           The opaque core reaches further out than it used to, which is most of why
           the form now reads instead of hiding. */
        '[mask-image:radial-gradient(ellipse_at_center,black_42%,transparent_76%)]',
        '[-webkit-mask-image:radial-gradient(ellipse_at_center,black_42%,transparent_76%)]',
        'opacity-[0.62] mix-blend-multiply',
        'dark:opacity-[0.42] dark:invert dark:hue-rotate-180 dark:mix-blend-screen',
        place,
        className,
      )}
    />
  )
}

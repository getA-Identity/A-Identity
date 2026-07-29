import { createElement, useEffect, useRef, useState } from 'react'

/**
 * The A-Identity owl.
 *
 * Three variants, each tied to a state rather than to a mood, so the mascot is doing the
 * product's job instead of decorating around it:
 *
 *   soft       the default face of the brand. Landing.
 *   geometric  a positive outcome. Agent registered, KYA proven.
 *   officer    something went wrong. 404, render error.
 *
 * Colours come from the brand tokens (ink #192837, accent #7342e2, cream #f2f2ee,
 * sand #cfc8c5), baked into the model textures rather than applied in CSS. That is also
 * why these are PNG cutouts and not SVG: they are renders, and a favicon-grade flat mark
 * still needs to be drawn by hand from the same geometry.
 */

export type OwlVariant = 'soft' | 'geometric' | 'officer'

const ALT: Record<OwlVariant, string> = {
  soft: 'The A-Identity owl',
  geometric: 'The A-Identity owl, marking a verified result',
  officer: 'The A-Identity owl, standing watch over an error',
}

/**
 * Static cutout. This is the default: an inline success or error state should not pay for
 * a 3D runtime, and a PNG cannot fail to load a decoder.
 */
export function OwlMascot({
  variant = 'soft',
  className = '',
  width,
}: {
  variant?: OwlVariant
  className?: string
  /** Rendered width in px. Sets intrinsic sizing so the image reserves its own space. */
  width?: number
}) {
  return (
    <img
      src={`/mascots/owl-${variant}.png`}
      alt={ALT[variant]}
      width={width}
      className={className}
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  )
}

const VIEWER_SRC = 'https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js'

/** Below this the owl stays a PNG: a phone should not download a mesh to see a bird. */
const MIN_3D_WIDTH = 1024

/**
 * The owl, 3D where that is affordable and a PNG everywhere else.
 *
 * The static cutout always renders, and the 3D canvas is an upgrade layered over it. That
 * ordering is what makes this safe to drop anywhere: on a phone, on a slow link, or with a
 * CDN that never answers, the component still shows an owl at the right size.
 *
 * Four gates before the mesh loads: the viewport must be at least desktop width, the element
 * must be near the screen, the module must actually arrive, and auto-rotation is dropped for
 * anyone who asked for reduced motion.
 */
export function OwlMascot3D({
  variant = 'soft',
  className = '',
  imgClassName = '',
}: {
  variant?: OwlVariant
  className?: string
  /** Sizing for the PNG layer, which is what mobile actually sees. */
  imgClassName?: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [wide, setWide] = useState(false)
  const [ready, setReady] = useState(false)
  const [reduced, setReduced] = useState(false)
  const active = near && wide

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Tracked live rather than read once, so rotating a tablet or dragging a window across
  // the breakpoint settles on the right treatment instead of keeping whatever loaded first.
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${MIN_3D_WIDTH}px)`)
    setWide(mq.matches)
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true)
          io.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    io.observe(host)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!active) return
    if (document.querySelector('script[data-model-viewer]')) {
      setReady(true)
      return
    }
    const script = document.createElement('script')
    script.type = 'module'
    script.src = VIEWER_SRC
    script.dataset.modelViewer = 'true'
    script.onload = () => setReady(true)
    // A CDN that does not answer must not leave a hole in the page: the poster stays.
    script.onerror = () => setReady(false)
    document.head.appendChild(script)
  }, [active])

  return (
    <div ref={hostRef} className={`relative ${className}`}>
      {/* Paints instantly and stays behind the canvas, so there is never an empty box. */}
      <OwlMascot
        variant={variant}
        className={`h-full w-full object-contain transition-opacity duration-500 ${
          active && ready ? 'opacity-0' : 'opacity-100'
        } ${imgClassName}`}
      />
      {active && ready && (
        <div className="absolute inset-0">
          {createElement('model-viewer', {
            src: `/mascots/owl-${variant}.glb`,
            alt: ALT[variant],
            'camera-controls': true,
            'auto-rotate': !reduced,
            'auto-rotate-delay': 600,
            'rotation-per-second': '14deg',
            'camera-orbit': '15deg 78deg 140%',
            'min-camera-orbit': 'auto 55deg auto',
            'max-camera-orbit': 'auto 100deg auto',
            'disable-zoom': true,
            'shadow-intensity': '0',
            'environment-image': 'neutral',
            exposure: '1.15',
            'interaction-prompt': 'none',
            'touch-action': 'pan-y',
            style: { width: '100%', height: '100%', backgroundColor: 'transparent' },
          })}
        </div>
      )}
    </div>
  )
}

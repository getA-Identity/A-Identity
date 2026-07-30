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
 *
 * The PNGs are rendered from the GLBs through the same camera the 3D viewer uses and are
 * deliberately NOT trimmed to the mesh, so the poster and the model frame identically and
 * the handover is invisible. The cost is transparent padding, which means a standalone use
 * needs to be sized roughly a third larger than the owl you want to see.
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
      /* Every cutout is rendered square (700x700), padding included, so the height is the
         width. Declaring both is what actually reserves the box: a lone `width` leaves the
         height at 0 until the PNG decodes, and the page jumps by the owl's full height. */
      height={width}
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
 * A fixed three-quarter framing per variant, and deliberately no auto-rotation.
 *
 * Spinning meant the owl was showing its back or a flat side profile most of the time, and
 * on a wide angle it pushed past the frame. Composition on a landing page and on a 404 is
 * not something to leave to whatever second the visitor arrives in, so the camera is pinned
 * to an angle that reads well and the model can still be dragged.
 *
 * `auto` radius asks model-viewer to frame the whole mesh, which is what makes these fill
 * their box consistently even though the three meshes have very different proportions.
 */
const ORBIT: Record<OwlVariant, string> = {
  soft: '18deg 76deg auto',
  geometric: '18deg 76deg auto',
  // Tighter than the others: the officer is tall and narrow, so `auto` leaves it floating in
  // a lot of side margin on a page where it is meant to be the largest thing on screen.
  officer: '12deg 79deg 88%',
}

/**
 * The owl, 3D where that is affordable and a PNG everywhere else.
 *
 * The static cutout always renders, and the 3D canvas is an upgrade layered over it. That
 * ordering is what makes this safe to drop anywhere: on a phone, on a slow link, or with a
 * CDN that never answers, the component still shows an owl at the right size.
 *
 * Three gates before the mesh loads: the viewport must be at least desktop width, the element
 * must be near the screen, and the module must actually arrive. Drag easing is dropped for
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
  const viewerRef = useRef<HTMLElement>(null)
  const [near, setNear] = useState(false)
  const [wide, setWide] = useState(false)
  const [ready, setReady] = useState(false)
  const [painted, setPainted] = useState(false)
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

  /**
   * The poster hands over on the mesh's `load` event, not on the script's.
   *
   * Those are seconds apart: the module lands quickly, the GLB does not. Fading the PNG when
   * the script arrived left the owl missing entirely for the whole download, which is the
   * exact gap the poster exists to cover.
   */
  useEffect(() => {
    setPainted(false)
    if (!(active && ready)) return
    const el = viewerRef.current as (HTMLElement & { loaded?: boolean }) | null
    if (!el) return
    if (el.loaded) {
      setPainted(true)
      return
    }
    const onLoad = () => setPainted(true)
    el.addEventListener('load', onLoad)
    return () => el.removeEventListener('load', onLoad)
  }, [active, ready, variant])

  return (
    <div ref={hostRef} className={`relative ${className}`}>
      {/* Paints instantly and stays behind the canvas, so there is never an empty box. */}
      <OwlMascot
        variant={variant}
        className={`h-full w-full object-contain transition-opacity duration-500 ${
          painted ? 'opacity-0' : 'opacity-100'
        } ${imgClassName}`}
      />
      {active && ready && (
        <div className="absolute inset-0">
          {createElement('model-viewer', {
            ref: viewerRef,
            src: `/mascots/owl-${variant}.glb`,
            alt: ALT[variant],
            'camera-controls': true,
            'camera-orbit': ORBIT[variant],
            // Dragging is allowed, but only within the arc where the owl still looks like
            // itself. Past these it turns into a featureless back or a view up its chin.
            'min-camera-orbit': '-55deg 62deg auto',
            'max-camera-orbit': '55deg 94deg auto',
            'disable-zoom': true,
            'disable-pan': true,
            'interpolation-decay': reduced ? 0 : 120,
            'shadow-intensity': '0',
            'environment-image': 'neutral',
            exposure: '1.15',
            'interaction-prompt': 'none',
            'touch-action': 'pan-y',
            style: { width: '100%', height: '100%', backgroundColor: 'transparent' },
          },
          // Slotting an empty element replaces model-viewer's built-in loading bar. The
          // matching ::part rule in index.css covers the same thing from the other side.
          createElement('div', { key: 'progress-bar', slot: 'progress-bar' }),
        )}
        </div>
      )}
    </div>
  )
}

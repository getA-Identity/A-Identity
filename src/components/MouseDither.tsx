import { useEffect, useRef } from 'react'

/**
 * A landing-wide pointer companion (the base.org idea, in our palette): a small
 * cluster of accent pixel squares over a soft glow that trails the cursor with a
 * lerp, so it arrives a beat after the pointer and drifts while the mouse rests.
 *
 * Decorative only: fixed, pointer-events-none, aria-hidden. It renders nothing
 * for touch/coarse pointers and for prefers-reduced-motion, and hides itself
 * when the pointer leaves the window. The loop is a single rAF writing one
 * transform (translate3d), so it never touches layout.
 */

/** The dither: hand-placed 4px squares on an 8px grid, denser toward the center. */
const PIXELS: { x: number; y: number; o: number }[] = [
  { x: 16, y: 0, o: 0.9 },
  { x: 24, y: 0, o: 0.5 },
  { x: 8, y: 8, o: 0.6 },
  { x: 16, y: 8, o: 1 },
  { x: 24, y: 8, o: 0.8 },
  { x: 32, y: 8, o: 0.35 },
  { x: 0, y: 16, o: 0.4 },
  { x: 8, y: 16, o: 0.9 },
  { x: 16, y: 16, o: 0.7 },
  { x: 24, y: 16, o: 0.95 },
  { x: 8, y: 24, o: 0.45 },
  { x: 16, y: 24, o: 0.75 },
  { x: 32, y: 24, o: 0.55 },
  { x: 24, y: 32, o: 0.35 },
]

export default function MouseDither() {
  const layerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)').matches
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const layer = layerRef.current
    if (!fine || still || !layer) return

    let raf = 0
    let seen = false
    const target = { x: -200, y: -200 }
    const pos = { x: -200, y: -200 }

    const onMove = (e: MouseEvent) => {
      target.x = e.clientX + 18
      target.y = e.clientY + 18
      if (!seen) {
        seen = true
        pos.x = target.x
        pos.y = target.y
        layer.style.opacity = '1'
      }
    }
    const onLeave = () => {
      seen = false
      layer.style.opacity = '0'
    }

    const tick = () => {
      pos.x += (target.x - pos.x) * 0.09
      pos.y += (target.y - pos.y) * 0.09
      layer.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`
      raf = requestAnimationFrame(tick)
    }

    window.addEventListener('mousemove', onMove, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('mousemove', onMove)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-40 hidden lg:block">
      <div
        ref={layerRef}
        className="absolute left-0 top-0 opacity-0 transition-opacity duration-300"
        style={{ transform: 'translate3d(-200px, -200px, 0)' }}
      >
        {/* soft glow under the pixels */}
        <div className="absolute -left-6 -top-6 h-24 w-24 rounded-full bg-accent/15 blur-2xl" />
        {PIXELS.map((p, i) => (
          <div
            key={i}
            className="absolute bg-accent"
            style={{ left: p.x, top: p.y, width: 4, height: 4, opacity: p.o }}
          />
        ))}
      </div>
    </div>
  )
}

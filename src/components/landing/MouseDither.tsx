import { useEffect, useRef } from 'react'
import OwlMark from '../OwlMark'

/**
 * A landing-wide pointer companion: the brand owl (OwlMark, the same vector
 * mark the explorer uses) over a soft accent glow, trailing the cursor with a
 * lerp so it arrives a beat after the pointer and settles while the mouse
 * rests. It hugs the cursor tip (a ~14px offset) rather than hanging off the
 * corner, and leans into the direction of travel for a touch of life.
 *
 * Decorative only: fixed, pointer-events-none, aria-hidden. It renders nothing
 * for touch/coarse pointers and for prefers-reduced-motion, and hides itself
 * when the pointer leaves the window. The loop is a single rAF writing one
 * transform per layer, so it never touches layout.
 */
export default function MouseDither() {
  const layerRef = useRef<HTMLDivElement>(null)
  const owlRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const fine = window.matchMedia('(pointer: fine)').matches
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const layer = layerRef.current
    const owl = owlRef.current
    if (!fine || still || !layer || !owl) return

    let raf = 0
    let seen = false
    const target = { x: -200, y: -200 }
    const pos = { x: -200, y: -200 }

    const onMove = (e: MouseEvent) => {
      target.x = e.clientX + 14
      target.y = e.clientY + 12
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
      const dx = target.x - pos.x
      pos.x += dx * 0.11
      pos.y += (target.y - pos.y) * 0.11
      layer.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`
      // Lean into the direction of travel; eases back upright at rest.
      const tilt = Math.max(-14, Math.min(14, dx * 0.12))
      owl.style.transform = `rotate(${tilt}deg)`
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
        {/* soft glow under the owl */}
        <div className="absolute -left-5 -top-5 h-[68px] w-[68px] rounded-full bg-accent/20 blur-xl" />
        <div ref={owlRef} className="relative drop-shadow-[0_2px_6px_rgba(25,40,55,0.35)]">
          <OwlMark size={28} />
        </div>
      </div>
    </div>
  )
}

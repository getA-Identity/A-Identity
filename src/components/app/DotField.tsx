import { useEffect, useRef } from 'react'
import { cn } from '../../lib/utils'

/**
 * Cursor-reactive ambient dot layer.
 *
 * Renders two pointer-transparent layers (see console.css): a static dot
 * lattice with a slowly spinning conic wash revealed around the cursor, and a
 * ripple ring that expands every 6s from wherever the cursor was when the
 * cycle started.
 *
 * All motion lives in CSS. The only JS here is a rAF loop lerping `--cn-x/y`
 * toward the pointer (factor 0.5, parked far offscreen when the pointer
 * leaves) and an `animationiteration` listener snapshotting the raw cursor
 * into `--cn-px/py` for the ripple origin. Listeners attach to the PARENT
 * element, which must be `position: relative`; the field itself never takes
 * pointer events.
 */
export default function DotField({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const field = ref.current
    const host = field?.parentElement
    if (!field || !host) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const ripple = field.querySelector<HTMLElement>('.cn-dots-ripple')
    const raw = { x: -9999, y: -9999 }
    const eased = { x: -9999, y: -9999 }
    let rafId = 0
    let running = false

    const tick = () => {
      eased.x += (raw.x - eased.x) * 0.5
      eased.y += (raw.y - eased.y) * 0.5
      field.style.setProperty('--cn-x', `${eased.x.toFixed(1)}px`)
      field.style.setProperty('--cn-y', `${eased.y.toFixed(1)}px`)
      const settled = Math.abs(raw.x - eased.x) < 0.5 && Math.abs(raw.y - eased.y) < 0.5
      if (settled && raw.x === -9999) {
        running = false
        return
      }
      rafId = requestAnimationFrame(tick)
    }
    const wake = () => {
      if (!running) {
        running = true
        rafId = requestAnimationFrame(tick)
      }
    }

    const onMove = (e: PointerEvent) => {
      const r = field.getBoundingClientRect()
      raw.x = e.clientX - r.left
      raw.y = e.clientY - r.top
      wake()
    }
    const onLeave = () => {
      raw.x = -9999
      raw.y = -9999
      wake()
    }
    // Each ripple cycle emanates from where the cursor was at cycle start.
    const onIteration = (e: AnimationEvent) => {
      if (e.animationName !== 'cn-dots-ripple' || !ripple) return
      ripple.style.setProperty('--cn-px', `${raw.x}px`)
      ripple.style.setProperty('--cn-py', `${raw.y}px`)
    }

    host.addEventListener('pointermove', onMove)
    host.addEventListener('pointerleave', onLeave)
    ripple?.addEventListener('animationiteration', onIteration)
    return () => {
      host.removeEventListener('pointermove', onMove)
      host.removeEventListener('pointerleave', onLeave)
      ripple?.removeEventListener('animationiteration', onIteration)
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <div ref={ref} className={cn('cn-dots', className)} aria-hidden="true">
      <div className="cn-dots-ripple" />
    </div>
  )
}

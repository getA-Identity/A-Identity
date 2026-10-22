import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { ArrowUp } from 'lucide-react'
import { hasCornerFab } from '../lib/feedback'

/**
 * Back to top, bottom-right, at the top of the corner stack.
 *
 * Appears only after real scrolling: a page you can see the top of does not need a button
 * to reach it. Positioned as part of the bottom-right stack, because two controls loose in
 * the same corner read as an accident. The stack, from the bottom: the landing's "Verify an
 * agent" FAB where it exists, the feedback button (every page), then this. Each slot is
 * 44px tall with a 20px gap, so on the landing this sits one slot higher than elsewhere,
 * and hasCornerFab is the single place that decides which pages have the extra slot.
 */
export default function ScrollTopButton() {
  const [show, setShow] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 700)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!show) return null
  const slot = hasCornerFab(pathname) ? '9.5rem' : '5.5rem'
  return (
    <button
      type="button"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed right-6 z-40 grid h-11 w-11 place-items-center rounded-full border border-border bg-card/90 text-foreground/60 shadow-lg backdrop-blur transition-colors hover:text-foreground print:hidden"
      style={{ bottom: `calc(${slot} + env(safe-area-inset-bottom, 0px))` }}
    >
      <ArrowUp size={17} />
    </button>
  )
}

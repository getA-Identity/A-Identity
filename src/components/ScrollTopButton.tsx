import { useEffect, useState } from 'react'
import { ArrowUp } from 'lucide-react'

/**
 * Back to top, bottom-right, above the spotlight FAB.
 *
 * Appears only after real scrolling: a page you can see the top of does not need a button
 * to reach it. Positioned as part of the bottom-right stack (this, then the FAB below it),
 * because two controls loose in the same corner read as an accident.
 */
export default function ScrollTopButton() {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 700)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  if (!show) return null
  return (
    <button
      type="button"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-[5.5rem] right-6 z-40 grid h-11 w-11 place-items-center rounded-full border border-border bg-card/90 text-foreground/60 shadow-lg backdrop-blur transition-colors hover:text-foreground"
    >
      <ArrowUp size={17} />
    </button>
  )
}

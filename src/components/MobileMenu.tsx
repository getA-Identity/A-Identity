import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import Logo from './Logo'
import AuthButtons from './AuthButtons'
import { EASE_OUT_EXPO, NAV_LINKS } from '../lib/brand'

type MobileMenuProps = {
  open: boolean
  onClose: () => void
}

/**
 * Right-side slide-in navigation sheet for small viewports.
 * Backdrop + sheet are mounted/unmounted via AnimatePresence so the exit
 * transition runs before the nodes leave the tree.
 */
export default function MobileMenu({ open, onClose }: MobileMenuProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-40 md:hidden"
            style={{
              background: 'rgba(25,40,55,0.35)',
              backdropFilter: 'blur(4px)',
              WebkitBackdropFilter: 'blur(4px)',
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            onClick={onClose}
          />

          {/* Sheet */}
          <motion.aside
            className="fixed right-0 top-0 z-50 flex flex-col md:hidden"
            style={{
              width: 'min(88vw, 360px)',
              height: '100dvh',
              background: 'var(--sheet)',
              boxShadow: '-12px 0 48px rgba(25,40,55,0.18)',
              // 100dvh already excludes the browser chrome, but not the notch or the
              // home indicator: without these the close button sits under the status
              // bar and the last nav item under the gesture bar on an iPhone.
              paddingTop: 'env(safe-area-inset-top)',
              paddingBottom: 'env(safe-area-inset-bottom)',
              paddingRight: 'env(safe-area-inset-right)',
            }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.45, ease: EASE_OUT_EXPO }}
          >
            {/* Header: logo + close */}
            <div className="flex items-center justify-between px-6 py-5 text-foreground">
              <Logo fill="currentColor" />
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-foreground/5"
              >
                <X size={24} />
              </button>
            </div>

            {/* Divider */}
            <div className="h-px w-full" style={{ background: 'var(--border)' }} />

            {/* Nav links (staggered) */}
            <nav className="flex flex-1 flex-col gap-1 px-6 py-6">
              {NAV_LINKS.map((link, i) => (
                <motion.a
                  key={link.label}
                  href={link.href}
                  {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  onClick={onClose}
                  className="py-2 text-lg font-medium opacity-90 transition-opacity hover:opacity-100"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.18 + i * 0.07, duration: 0.4, ease: EASE_OUT_EXPO }}
                >
                  {link.label}
                </motion.a>
              ))}
              <motion.a
                href="/architecture"
                onClick={onClose}
                className="py-2 text-lg font-medium opacity-90 transition-opacity hover:opacity-100"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.18 + NAV_LINKS.length * 0.07, duration: 0.4, ease: EASE_OUT_EXPO }}
              >
                Architecture
              </motion.a>
            </nav>

            {/* Bottom CTAs */}
            <div className="px-6 pb-8">
              <AuthButtons stacked onNavigate={onClose} />
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}

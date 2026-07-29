import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import Logo from './Logo'
import AuthButtons from './AuthButtons'
import ThemeToggle from './ThemeToggle'
import { APP_NAME } from '../lib/brand'

/**
 * Shared top bar for standalone marketing pages (manifesto, brand, contact).
 * Logo returns home; a back link and the auth buttons keep navigation obvious.
 */
export default function PageHeader() {
  return (
    <header className="sticky top-0 z-20 w-full border-b border-border bg-background/85 backdrop-blur-md">
      <nav className="mx-auto flex w-full max-w-[1100px] items-center justify-between px-5 py-4 sm:px-8">
        <Link to="/" aria-label={`${APP_NAME} home`} className="flex items-center gap-2">
          <Logo />
          <span className="text-lg font-bold tracking-tight text-foreground">{APP_NAME}</span>
        </Link>

        <div className="flex items-center gap-5">
          <Link
            to="/"
            className="hidden items-center gap-1.5 text-sm font-medium text-foreground/60 transition-colors hover:text-foreground sm:flex"
          >
            <ArrowLeft size={15} />
            Back to home
          </Link>
          {/* These pages became theme-aware, so they need the switch too. Without it a
              reader who arrives straight on /blog is stuck in whatever theme was stored. */}
          <ThemeToggle />
          <div className="hidden sm:block">
            <AuthButtons />
          </div>
        </div>
      </nav>
    </header>
  )
}

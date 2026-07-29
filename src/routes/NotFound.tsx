import { Link } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import ThemeScope from '../components/ThemeScope'
import { OwlMascot3D } from '../components/OwlMascot'

/**
 * 404.
 *
 * The catch-all used to redirect to `/`, which quietly told a visitor their link was fine
 * and they had simply arrived home. A dead link deserves to be named, and the two things
 * worth offering here are the same two things the landing offers: go back, or look an
 * agent up.
 *
 * The officer owl carries the negative states across the app (this page and the render
 * error boundary), so an unhappy path still looks like the product rather than like a stack
 * trace someone forgot to style.
 */
export default function NotFound() {
  return (
    <ThemeScope as="main" className="flex min-h-screen flex-col">
      <PageHeader />

      <div className="mx-auto flex w-full max-w-[900px] flex-1 flex-col items-center justify-center gap-10 px-5 py-16 text-center sm:px-8 md:flex-row md:gap-16 md:text-left">
        <OwlMascot3D
          variant="officer"
          className="h-44 w-44 shrink-0 sm:h-56 sm:w-56 lg:h-72 lg:w-72"
        />

        <div>
          <p className="font-mono text-sm font-semibold tracking-[0.2em] text-foreground/40">404</p>
          <h1 className="mt-3 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Nothing lives at this address.
          </h1>
          <p className="mt-4 max-w-[46ch] text-base leading-relaxed text-foreground/60">
            The link is either out of date or was never real. Neither is your fault, and
            nothing is broken.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 md:justify-start">
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              <ArrowLeft size={16} />
              Back to home
            </Link>
            <Link
              to="/explorer"
              className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-foreground/70 transition-colors hover:text-foreground"
            >
              <Search size={16} />
              Verify an agent
            </Link>
          </div>
        </div>
      </div>
    </ThemeScope>
  )
}

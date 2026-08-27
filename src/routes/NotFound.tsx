import { Link } from 'react-router-dom'
import { ArrowLeft, Search } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import ThemeScope from '../components/ThemeScope'
import { OwlMascot3D } from '../components/OwlMascot'
import { usePageMeta } from '../lib/head'

/**
 * 404.
 *
 * The catch-all used to redirect to `/`, which quietly told a visitor their link was fine
 * and they had simply arrived home. A dead link deserves to be named, and the two things
 * worth offering here are the same two the landing offers: go back, or look an agent up.
 *
 * Centred rather than split left-and-right, because a dead end is not a page with content to
 * read: it is one object and one decision. The owl is the largest thing on the screen and
 * everything else is arranged under it.
 *
 * The officer variant carries every negative state in the app, here and in the render error
 * boundary, so a failure still looks like the product.
 */
export default function NotFound() {
  // Without this, a dead URL inherits the homepage title, description and canonical
  // from index.html, which tells both the tab bar and any crawler that the page is
  // fine. A 404 in an SPA cannot send a status code, so noindex is the next best
  // signal, and the title should say what actually happened.
  usePageMeta({ title: 'Page not found | A-Identity', noindex: true })

  return (
    <ThemeScope as="main" className="flex min-h-screen flex-col">
      <PageHeader />

      <div className="relative flex flex-1 items-center justify-center overflow-hidden px-5 py-12 sm:px-8">
        {/* A single soft pool of light under the owl. It gives the cutout a floor to stand on
            in dark mode, where a transparent PNG otherwise reads as pasted onto the page. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-[560px] -translate-x-1/2 -translate-y-[58%] rounded-full opacity-70 blur-3xl"
          style={{
            background:
              'radial-gradient(circle, color-mix(in srgb, var(--ring) 22%, transparent) 0%, transparent 68%)',
          }}
        />

        <div className="relative flex w-full max-w-[560px] flex-col items-center text-center">
          <OwlMascot3D
            variant="officer"
            className="h-[260px] w-[260px] sm:h-[340px] sm:w-[340px] lg:h-[440px] lg:w-[440px]"
          />

          <p className="mt-2 font-mono text-xs font-semibold uppercase tracking-[0.32em] text-foreground/35">
            Error 404
          </p>
          <h1 className="mt-4 text-[2rem] font-bold leading-[1.08] tracking-tight text-foreground sm:text-[2.75rem]">
            Nothing lives at
            <br />
            this address.
          </h1>
          <p className="mt-5 max-w-[42ch] text-base leading-relaxed text-foreground/55">
            The link is either out of date or was never real. Neither is your fault, and
            nothing is broken.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/"
              className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white transition-transform hover:scale-[1.03]"
              style={{ boxShadow: '0 10px 34px rgba(115,66,226,0.34)' }}
            >
              <ArrowLeft size={16} />
              Back to home
            </Link>
            <Link
              to="/explorer"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-6 py-3 text-sm font-semibold text-foreground backdrop-blur-md transition-colors hover:border-accent/50"
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

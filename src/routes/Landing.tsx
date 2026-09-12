import Navbar from '../components/Navbar'
import Hero from '../components/landing/Hero'
import VerifyCta from '../components/sections/VerifyCta'
import VerifyPayFlow from '../components/sections/VerifyPayFlow'
import QuickStart from '../components/sections/QuickStart'
import ScrollTopButton from '../components/ScrollTopButton'
import LiveProof from '../components/sections/LiveProof'
import LandingFaq from '../components/sections/LandingFaq'
import CloseCta from '../components/sections/CloseCta'
import SiteFooter from '../components/sections/SiteFooter'
import TrustSpotlight from '../components/landing/TrustSpotlight'
import MouseDither from '../components/landing/MouseDither'
import { BACKGROUND_VIDEO } from '../lib/brand'
import { useTheme } from '../components/ThemeProvider'

/**
 * Public landing surface. The hero is a full-viewport block with the
 * background video; the sections underneath each do one job.
 *
 * The `dark` class is applied here (not on <html>) so light/dark theming stays
 * scoped to the landing subtree; only landing components read the semantic tokens.
 */
export default function Landing() {
  const { theme } = useTheme()
  return (
    <div
      /* overflow-x-clip: several sections go full-bleed with w-screen, and 100vw includes
         the scrollbar gutter on desktop, which otherwise gives the whole page a few px of
         horizontal scroll. */
      className={`w-full overflow-x-clip bg-background ${theme === 'dark' ? 'dark' : ''}`}
      style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}
    >
      {/* Hero block. Exactly one viewport tall on desktop with overflow-hidden, so the
          fold crops the console still at the hero's floor; on mobile it grows with the
          content instead. */}
      <header className="relative min-h-screen w-full overflow-hidden pt-[72px] lg:h-screen lg:min-h-0">
        {/* The film is 3.4 MB. The `media` attribute on <source> means a narrow viewport
            never requests it, with no JavaScript, which matters because these pages are
            prerendered. Phones get the 19 KB poster, which is the first frame. */}
        <video
          className="absolute inset-0 h-full w-full object-cover"
          poster="/hero-poster.webp"
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
        >
          <source src={BACKGROUND_VIDEO} type="video/mp4" media="(min-width: 1024px)" />
        </video>
        {/* Dark-mode only scrim, so the light heading stays readable over the bright film. */}
        <div
          className="pointer-events-none absolute inset-0 hidden bg-gradient-to-b from-background/85 via-background/40 to-background/80 dark:block"
          aria-hidden="true"
        />
        <Navbar />
        <Hero />
      </header>

      {/* Five jobs, in the order a visitor needs them: try it, see how it works, see that it
          is real, plug it in, clear the last doubt. Everything else (protocols, safety detail,
          use cases, the chain wall) lives one click away rather than on this scroll. */}
      <VerifyCta />
      <VerifyPayFlow />
      <LiveProof />
      <QuickStart />
      <LandingFaq />
      <CloseCta />
      <SiteFooter />

      {/* Bottom-right stack: back-to-top above the trust lookup FAB */}
      <ScrollTopButton />
      <TrustSpotlight />

      {/* The accent pixel cluster that trails the pointer across the whole landing. */}
      <MouseDither />
    </div>
  )
}

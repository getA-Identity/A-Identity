import Navbar from '../components/Navbar'
import Hero from '../components/Hero'
import VerifyCta from '../components/sections/VerifyCta'
import Shift from '../components/sections/Shift'
import WhatYouGet from '../components/sections/WhatYouGet'
import LiveProof from '../components/sections/LiveProof'
import BuiltOn from '../components/sections/BuiltOn'
import LandingFaq from '../components/sections/LandingFaq'
import CloseCta from '../components/sections/CloseCta'
import SiteFooter from '../components/sections/SiteFooter'
import TrustSpotlight from '../components/TrustSpotlight'
import { BACKGROUND_VIDEO } from '../lib/brand'
import { useTheme } from '../components/ThemeProvider'

/**
 * Public landing surface. The hero is a full-viewport block with the
 * background video; the narrative sections flow underneath on solid
 * backgrounds: problem, pillars, web2.5, positioning, vision, developers, faq, footer.
 *
 * The `dark` class is applied here (not on <html>) so light/dark theming stays
 * scoped to the landing subtree; only landing components read the semantic tokens.
 */
export default function Landing() {
  const { theme } = useTheme()
  return (
    <div
      className={`w-full bg-background ${theme === 'dark' ? 'dark' : ''}`}
      style={{ fontFamily: 'var(--font-body)', color: 'var(--color-text)' }}
    >
      {/* Hero block */}
      <header className="relative min-h-screen w-full overflow-hidden pt-[72px]">
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src={BACKGROUND_VIDEO}
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
        />
        {/* Dark-mode only: the hero video is a bright/light scene tuned for dark
            text, so in dark mode we lay a left-weighted scrim over it to keep the
            (now light) heading and copy readable while leaving the art visible on
            the right. Hidden in light mode → the original look is untouched. */}
        <div
          className="pointer-events-none absolute inset-0 hidden bg-gradient-to-r from-background/90 via-background/50 to-transparent dark:block"
          aria-hidden="true"
        />
        <Navbar />
        <Hero />
      </header>

      {/* Lean narrative: prove it, frame it, show what you get, prove it is real, answer
          the objections, close. The FAQ sits second-to-last on purpose: by then a reader is
          either convinced or has exactly one thing still bothering them, and that is the
          cheapest possible place to handle it. The deeper reference material (protocols, use
          cases, developer docs, blog) still lives off the landing. */}
      <VerifyCta />
      <Shift />
      <WhatYouGet />
      <LiveProof />
      <BuiltOn />
      <LandingFaq />
      <CloseCta />
      <SiteFooter />

      {/* ⌘K / floating magic trust lookup, available across the landing */}
      <TrustSpotlight />
    </div>
  )
}

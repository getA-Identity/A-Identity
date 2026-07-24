import Navbar from '../components/Navbar'
import Hero from '../components/Hero'
import VerifyCta from '../components/sections/VerifyCta'
import Problem from '../components/sections/Problem'
import Pillars from '../components/sections/Pillars'
import Web25Layer from '../components/sections/Web25Layer'
import UseCases from '../components/sections/UseCases'
import Positioning from '../components/sections/Positioning'
import Vision from '../components/sections/Vision'
import DeveloperExperience from '../components/sections/DeveloperExperience'
import OkxAsp from '../components/sections/OkxAsp'
import BlogTeaser from '../components/sections/BlogTeaser'
import FAQ from '../components/sections/FAQ'
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

      {/* Narrative sections */}
      <VerifyCta />
      <Problem />
      <Pillars />
      <Web25Layer />
      <UseCases />
      <Positioning />
      <Vision />
      <DeveloperExperience />
      <OkxAsp />
      <BlogTeaser />
      <FAQ />
      <SiteFooter />

      {/* ⌘K / floating magic trust lookup, available across the landing */}
      <TrustSpotlight />
    </div>
  )
}

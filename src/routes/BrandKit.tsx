import { Check, Download, X } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import SiteFooter from '../components/sections/SiteFooter'
import ThemeScope from '../components/ThemeScope'
import Logo from '../components/Logo'
import OwlMark, { type OwlVerdict } from '../components/OwlMark'
import { OwlMascot3D, type OwlVariant } from '../components/OwlMascot'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { APP_NAME } from '../lib/brand'
import { CHAINS } from '../lib/chains'
import { usePageMeta } from '../lib/head'

/**
 * The brand kit: every visual asset the product owns, on one page.
 *
 * This exists so that "which owl do I use, at what size, in which colour" is answered by
 * looking rather than by asking. Everything shown here ships with the site; the competitor
 * reference material deliberately does not (it lives in _design-refs/, git-ignored, other
 * people's work kept only as local working material).
 *
 * This IS /brand. It used to be an internal, noindex surface at /brand-kit while a thinner
 * press page held the public URL, which meant the good page was unreachable and the public
 * one was out of date. /brand-kit now redirects here, so there is one page and one
 * indexable URL, and the press-kit rules the old page carried live in the Usage section
 * below rather than in a second copy of the palette.
 */

const BRAND = [
  { name: 'ink', hex: '#192837', note: "Body text in light, surfaces in dark. The brand's weight." },
  { name: 'accent', hex: '#7342e2', note: "One job: the action, and the neutral state of the owl's eyes." },
  { name: 'cream', hex: '#f2f2ee', note: 'The page in light mode, the mark on dark chrome.' },
  { name: 'sand', hex: '#cfc8c5', note: 'Muted structure: sheets, beaks, talons.' },
]

/**
 * The downloadable logo tints: the brand palette (sand is structure, not a logo colour),
 * then every live chain in its registry colour. The PNGs under /brand are rendered by
 * scripts/gen-brand-logos.mjs with this exact filter, so the grid and the files can only
 * drift if someone edits one without re-running the other; a new live chain gets its
 * variants by re-running the script, not by editing this page.
 */
const LOGO_TINTS = [
  ...['ink', 'accent', 'cream'].map((name) => {
    const c = BRAND.find((b) => b.name === name)!
    return { key: c.name, name: c.name, hex: c.hex }
  }),
  ...CHAINS.filter((c) => c.status === 'live').map((c) => ({ key: c.id, name: c.shortName, hex: c.color })),
]

/** Perceived-luminance cut: light tints preview on ink, dark tints on white. */
const isLightHex = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150
}

/** The protocol and token colours, for anyone naming one of them next to our mark. */
const PROTOCOL_COLORS = [
  { name: 'ERC-8004', hex: '#7342E2' },
  { name: 'x402 / USDC', hex: '#2775CA' },
  { name: 'MCP', hex: '#1AAB7A' },
  { name: 'USDT', hex: '#26A17B' },
  { name: 'PYUSD', hex: '#0E2A8C' },
]

const VERDICTS: { v: OwlVerdict; label: string }[] = [
  { v: 'neutral', label: 'Neutral' },
  { v: 'allow', label: 'Allow' },
  { v: 'warn', label: 'Warn' },
  { v: 'deny', label: 'Deny' },
]

const ART = [
  { file: 'art-seal', name: 'The seal', idea: 'identity', alt: 'An embossed medallion with concentric rings' },
  { file: 'art-vault', name: 'The vault', idea: 'spend limits', alt: 'A ceramic vault door with a glowing dial' },
  { file: 'art-lens', name: 'The lens', idea: 'verification', alt: 'An aperture closing around a glowing iris' },
  { file: 'art-gate', name: 'The gate', idea: 'x402', alt: 'A toll gate with a glowing orb passing through' },
  { file: 'art-gateway', name: 'The gateway', idea: 'CCTP / Gateway', alt: 'Two arcs bridging with a coin mid-flight' },
  { file: 'art-network', name: 'The network', idea: 'traction', alt: 'A ring of nodes orbiting a core' },
  { file: 'art-guardrail', name: 'The guardrail', idea: 'bounded authority', alt: 'A sweeping curved rail with a light line' },
  { file: 'art-knot', name: 'The knot', idea: 'escrow', alt: 'Two ropes tied in a square knot' },
  { file: 'art-grid', name: 'The grid', idea: 'multichain', alt: 'An isometric tile grid with one lit tile' },
  { file: 'art-market', name: 'The market', idea: 'marketplace', alt: 'Three small kiosks, one glowing' },
]

const MASCOTS: { variant: OwlVariant; name: string; role: string }[] = [
  { variant: 'soft', name: 'Soft', role: 'The default face. Landing, hero surfaces.' },
  { variant: 'geometric', name: 'Geometric', role: 'Positive outcomes: registration, KYA proven.' },
  { variant: 'officer', name: 'Officer', role: 'Negative states: 404, render errors.' },
]

function Swatch({ name, hex, note }: { name: string; hex: string; note?: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="h-24 w-full border-b border-border" style={{ backgroundColor: hex }} />
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-bold text-foreground">{name}</span>
          <span className="font-mono text-xs text-foreground/45">{hex}</span>
        </div>
        {note && <p className="mt-1.5 text-xs leading-relaxed text-foreground/55">{note}</p>}
      </div>
    </div>
  )
}

function AssetLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      download
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold text-foreground/70 transition-colors hover:border-accent/50 hover:text-foreground"
    >
      <Download size={12} />
      {label}
    </a>
  )
}

export default function BrandKit() {
  usePageMeta({
    title: `Brand · ${APP_NAME}`,
    description:
      'The A-Identity brand kit: palette, type scale, marks, mascots, section art and motion rules, with the source files and the usage rules. Everything here is free to reuse as specified.',
    canonical: 'https://a-identity.xyz/brand',
  })

  return (
    <ThemeScope className="min-h-screen">
      <PageHeader />

      <main className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-8">
        <Eyebrow>Brand kit</Eyebrow>
        <DisplayHeading size="display" className="mt-3">
          Everything the brand owns.
        </DisplayHeading>
        <Lede className="mt-5">
          Colours, type, marks, mascots and motion, with the files behind them. If a surface
          needs an asset that is not on this page, the asset does not exist yet.
        </Lede>

        {/* ------------------------------------------------------------- palette --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Palette
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            Four fixed brand colours. Everything else on the site is a semantic token derived
            from them, which is why a surface never hardcodes a hex: light and dark are the
            same code.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {BRAND.map((c) => (
              <Swatch key={c.name} {...c} />
            ))}
          </div>

          <p className="mt-10 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            When a protocol or a stablecoin is named next to our mark, it wears its own
            colour rather than ours. Borrowing the accent for someone else&apos;s standard
            implies we own it.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {PROTOCOL_COLORS.map((c) => (
              <Swatch key={c.name} {...c} />
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------------- type --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Type scale
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            Three steps, fluid between breakpoints, all in the brand heading face. The rule:
            one display per page, sections open with section, groups with sub. Numbers in
            running UI are mono and tabular.
          </p>
          <div className="mt-8 flex flex-col gap-8 rounded-3xl border border-border bg-card p-8 sm:p-10">
            <div>
              <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/35">display</span>
              <DisplayHeading size="display" as="p" className="mt-2">
                Trust, before you pay.
              </DisplayHeading>
            </div>
            <div>
              <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/35">section</span>
              <DisplayHeading size="section" as="p" className="mt-2">
                Every payment goes through the check first.
              </DisplayHeading>
            </div>
            <div>
              <span className="font-mono text-[11px] uppercase tracking-wider text-foreground/35">sub</span>
              <DisplayHeading size="sub" as="p" className="mt-2">
                Bounded authority, human on the loop.
              </DisplayHeading>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- logo --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Logo
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            One mark, three forms: the mark alone, the horizontal lockup, and the stacked
            lockup with the wordmark underneath. The full-colour ribbon monogram is the
            primary logo; every file here is rendered from that one raster and the site&apos;s
            own heading face, never redrawn by hand.
          </p>

          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            {[
              {
                name: 'Mark only',
                img: '/logo/mark.png',
                imgClass: 'h-24 w-24',
                links: [
                  { href: '/logo/mark.png', label: 'png 581' },
                  { href: '/logo/mark-1024.png', label: 'png 1024' },
                ],
              },
              {
                name: 'Horizontal',
                img: '/brand/lockup-horizontal-full-ink.png',
                imgClass: 'max-h-14 w-auto',
                links: [
                  { href: '/brand/lockup-horizontal-full-ink.png', label: 'ink wordmark' },
                  { href: '/brand/lockup-horizontal-full-cream.png', label: 'cream wordmark' },
                ],
              },
              {
                name: 'Vertical',
                img: '/brand/lockup-vertical-full-ink.png',
                imgClass: 'max-h-28 w-auto',
                links: [
                  { href: '/brand/lockup-vertical-full-ink.png', label: 'ink wordmark' },
                  { href: '/brand/lockup-vertical-full-cream.png', label: 'cream wordmark' },
                ],
              },
            ].map((f) => (
              <div key={f.name} className="overflow-hidden rounded-2xl border border-border bg-card">
                <div className="flex h-44 items-center justify-center border-b border-border bg-white p-6">
                  <img src={f.img} alt={`A-Identity logo, ${f.name.toLowerCase()}`} loading="lazy" className={f.imgClass} />
                </div>
                <div className="p-4">
                  <span className="text-sm font-bold text-foreground">{f.name}</span>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {f.links.map((l) => (
                      <AssetLink key={l.href} {...l} />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-10 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            One-colour silhouettes, for chrome that cannot carry the gradient: the brand
            palette first, then every live chain in its own colour for co-branded
            placements. Each tint ships all three forms; the silhouette is the mark&apos;s
            own alpha channel, flat-filled.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {LOGO_TINTS.map((t) => (
              <div key={t.key} className="overflow-hidden rounded-2xl border border-border bg-card">
                <div
                  className="flex h-28 items-center justify-center border-b border-border p-6"
                  style={{ backgroundColor: isLightHex(t.hex) ? '#192837' : '#ffffff' }}
                >
                  <img
                    src={`/brand/lockup-horizontal-${t.key}.png`}
                    alt={`A-Identity lockup in ${t.name}`}
                    loading="lazy"
                    className="max-h-10 w-auto"
                  />
                </div>
                <div className="p-4">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-foreground">{t.name}</span>
                    <span className="font-mono text-xs text-foreground/45">{t.hex}</span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <AssetLink href={`/brand/mark-${t.key}.png`} label="mark" />
                    <AssetLink href={`/brand/lockup-horizontal-${t.key}.png`} label="horizontal" />
                    <AssetLink href={`/brand/lockup-vertical-${t.key}.png`} label="vertical" />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <a
            href="/brand/a-identity-logo-kit.zip"
            download
            className="mt-8 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            <Download size={15} />
            Download the full kit (zip)
          </a>
        </section>

        {/* --------------------------------------------------------------- marks --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Verdict marks
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            The logo carries the company; the owl mark carries a decision. The owl&apos;s
            eyes take the verdict colour, the exact values the explorer&apos;s risk pill uses,
            so a mark and a pill can never disagree on screen. Neutral accent is for surfaces
            that are not reporting an outcome.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-center gap-10 rounded-2xl border border-border bg-card p-8">
              <Logo />
              <Logo className="scale-150" />
            </div>
            <div className="grid grid-cols-4 gap-2 rounded-2xl border border-border bg-card p-6">
              {VERDICTS.map(({ v, label }) => (
                <div key={v} className="flex flex-col items-center gap-3">
                  <OwlMark verdict={v} size={64} />
                  <div className="flex items-end gap-1.5">
                    <OwlMark verdict={v} size={20} />
                    <OwlMark verdict={v} size={16} />
                  </div>
                  <span className="text-[11px] font-semibold text-foreground/50">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------- mascots --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Mascots
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            Three owls, each bound to a state rather than a mood. The GLB is the source, the
            PNG is a poster rendered through the same camera the live viewer uses, and the
            two frame identically by construction. Anything that cannot be mapped to a state
            does not get a variant.
          </p>
          <div className="mt-6 grid gap-5 lg:grid-cols-3">
            {MASCOTS.map((m) => (
              <article key={m.variant} className="overflow-hidden rounded-3xl border border-border bg-card">
                <div className="aspect-square border-b border-border">
                  <OwlMascot3D variant={m.variant} className="h-full w-full" />
                </div>
                <div className="p-5">
                  <h3 className="text-base font-bold text-foreground">{m.name}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-foreground/55">{m.role}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <AssetLink href={`/mascots/owl-${m.variant}.glb`} label="GLB" />
                    <AssetLink href={`/mascots/owl-${m.variant}.png`} label="PNG" />
                    <AssetLink href={`/mascots/ref-${m.variant}.jpg`} label="2D ref" />
                  </div>
                </div>
              </article>
            ))}
          </div>
          {/* Poses: the same soft owl in scene-specific attitudes, for heroes and cards. */}
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[
              { file: 'owl-card', name: 'Perched on the card', note: 'For payment and wallet surfaces.' },
              { file: 'owl-wing', name: 'Presenting', note: 'For introductions: points at whatever sits beside it.' },
              { file: 'owl-tpose', name: 'T-pose (source)', note: 'Rigging source. Meshy pose estimation rejects the proportions, kept for future attempts.' },
            ].map((m) => (
              <figure key={m.file} className="overflow-hidden rounded-2xl border border-border bg-card">
                {m.file !== 'owl-tpose' ? (
                  <img src={`/mascots/${m.file}.png`} alt={m.name} loading="lazy" className="aspect-square w-full object-contain p-4" />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center p-4 text-xs text-foreground/35">GLB only</div>
                )}
                <figcaption className="border-t border-border px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">{m.name}</span>
                    <AssetLink href={`/mascots/${m.file}.glb`} label="GLB" />
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-foreground/50">{m.note}</p>
                </figcaption>
              </figure>
            ))}
          </div>
          <p className="mt-4 text-xs text-foreground/40">
            Full design review, silhouette tests included, lives on{' '}
            <a href="/mascot" className="font-semibold text-accent hover:underline">
              /mascot
            </a>
            .
          </p>
        </section>

        {/* -------------------------------------------------------- illustrations --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Section art
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            Ten abstract pieces, one per product idea, all on the same navy stage with the
            same cream-and-accent vocabulary so any two can sit on one page without arguing.
            Generated in-palette; the navy background makes them read correctly in both
            themes.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ART.map((a) => (
              <figure key={a.file} className="overflow-hidden rounded-2xl border border-border bg-card">
                <img
                  src={`/art/${a.file}.webp`}
                  alt={a.alt}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[4/3] w-full object-cover"
                />
                <figcaption className="flex items-baseline justify-between gap-2 px-4 py-3">
                  <span className="text-sm font-semibold text-foreground">{a.name}</span>
                  <span className="font-mono text-[11px] text-foreground/40">{a.idea}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------ verdict variants --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Verdict owls (experimental)
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            The soft owl retextured with allow, warn and deny eyes. The eye colours landed
            exactly; the body picked up a feathered speckle the flat vinyl set does not have,
            so these stay in the kit as expressive variants and are not wired into any
            surface yet. An honest kit records the misses too.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {(['allow', 'warn', 'deny'] as const).map((v) => (
              <figure key={v} className="overflow-hidden rounded-2xl border border-border bg-card">
                <img src={`/mascots/owl-soft-${v}.png`} alt={`Owl with ${v} eyes`} loading="lazy" className="aspect-square w-full object-contain p-4" />
                <figcaption className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-semibold uppercase tracking-wide" style={{ color: v === 'allow' ? '#059669' : v === 'warn' ? '#d97706' : '#dc2626' }}>{v}</span>
                  <AssetLink href={`/mascots/owl-soft-${v}.glb`} label="GLB" />
                </figcaption>
              </figure>
            ))}
          </div>
        </section>

        {/* --------------------------------------------------------------- usage --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Usage
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            The rules for writing about {APP_NAME} or placing the mark. The name is one word,
            hyphenated, with a capital A and a capital I: A-Identity.
          </p>

          {/* The shipped lockup files themselves, on a FIXED light and a FIXED dark
              panel: the demo and the download can never disagree. */}
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-center rounded-2xl border border-[#192837]/10 bg-white p-12">
              <img src="/brand/lockup-horizontal-full-ink.png" alt={`${APP_NAME} lockup on light`} loading="lazy" className="max-h-10 w-auto" />
            </div>
            <div
              className="flex items-center justify-center rounded-2xl border border-white/10 p-12"
              style={{ background: '#192837' }}
            >
              <img src="/brand/lockup-horizontal-full-cream.png" alt={`${APP_NAME} lockup on dark`} loading="lazy" className="max-h-10 w-auto" />
            </div>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 p-6">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                <Check size={16} /> Do
              </div>
              <ul className="flex flex-col gap-2 text-sm text-foreground/70">
                <li>Write the name as A-Identity, one word, hyphenated.</li>
                <li>Give the mark clear space on cream or ink backgrounds.</li>
                <li>Use the accent purple for the action, and only the action.</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-red-500/25 bg-red-500/10 p-6">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-red-600 dark:text-red-400">
                <X size={16} /> Do not
              </div>
              <ul className="flex flex-col gap-2 text-sm text-foreground/70">
                <li>Do not stretch the logo, or tint it yourself: recolouring is shipped, as the one-colour set above.</li>
                <li>Do not write it as Aidentity, A Identity, or AIdentity.</li>
                <li>Do not place the mark on a busy photo without a panel.</li>
              </ul>
            </div>
          </div>

          <p className="mt-6 text-sm text-foreground/50">
            Need an asset that is not here? Reach us on the{' '}
            <a href="/contact" className="font-semibold text-accent hover:underline">
              contact page
            </a>
            .
          </p>
        </section>

        {/* -------------------------------------------------------------- motion --- */}
        <section className="mt-20 rounded-3xl border border-border bg-card p-8 sm:p-10">
          <DisplayHeading size="sub" as="h2">
            Motion
          </DisplayHeading>
          <div className="mt-4 grid gap-6 text-sm leading-relaxed text-foreground/60 sm:grid-cols-2">
            <div>
              <p className="font-semibold text-foreground">The rule</p>
              <p className="mt-1.5">
                Motion carries information or it does not ship. A request being checked moves;
                a decoration does not. Everything settles rather than hides under
                prefers-reduced-motion.
              </p>
            </div>
            <div>
              <p className="font-semibold text-foreground">The values</p>
              <p className="mt-1.5">
                Reveals: 0.6s, ease [0.16, 1, 0.3, 1], 24px rise, staggered 80ms. The live
                reference is the verify-then-pay flow on the{' '}
                <a href="/#flow" className="font-semibold text-accent hover:underline">
                  landing
                </a>
                .
              </p>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </ThemeScope>
  )
}

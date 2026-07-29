import { Download } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import ThemeScope from '../components/ThemeScope'
import Logo from '../components/Logo'
import OwlMark, { type OwlVerdict } from '../components/OwlMark'
import { OwlMascot3D, type OwlVariant } from '../components/OwlMascot'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { usePageMeta } from '../lib/head'

/**
 * The brand kit: every visual asset the product owns, on one internal page.
 *
 * This exists so that "which owl do I use, at what size, in which colour" is answered by
 * looking rather than by asking, and so the design overhaul about to land has one place to
 * put what it produces. Everything shown here ships with the site; the competitor reference
 * material deliberately does not (it lives in _design-refs/, git-ignored, other people's
 * work kept only as local working material).
 *
 * Unlinked and noindex, like /mascot. It is a working surface, not a marketing page.
 */

const BRAND = [
  { name: 'ink', hex: '#192837', note: 'Body text in light, surfaces in dark. The brand’s weight.' },
  { name: 'accent', hex: '#7342e2', note: 'One job: the action, and the neutral state of the owl’s eyes.' },
  { name: 'cream', hex: '#f2f2ee', note: 'The page in light mode, the mark on dark chrome.' },
  { name: 'sand', hex: '#cfc8c5', note: 'Muted structure: sheets, beaks, talons.' },
]

const VERDICTS: { v: OwlVerdict; label: string }[] = [
  { v: 'neutral', label: 'Neutral' },
  { v: 'allow', label: 'Allow' },
  { v: 'warn', label: 'Warn' },
  { v: 'deny', label: 'Deny' },
]

const MASCOTS: { variant: OwlVariant; name: string; role: string }[] = [
  { variant: 'soft', name: 'Soft', role: 'The default face. Landing, hero surfaces.' },
  { variant: 'geometric', name: 'Geometric', role: 'Positive outcomes: registration, KYA proven.' },
  { variant: 'officer', name: 'Officer', role: 'Negative states: 404, render errors.' },
]

function Swatch({ name, hex, note }: { name: string; hex: string; note: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="h-24 w-full border-b border-border" style={{ backgroundColor: hex }} />
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-bold text-foreground">{name}</span>
          <span className="font-mono text-xs text-foreground/45">{hex}</span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-foreground/55">{note}</p>
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
  usePageMeta({ title: 'Brand Kit — A-Identity', noindex: true })

  return (
    <ThemeScope as="main" className="min-h-screen">
      <PageHeader />

      <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-8">
        <Eyebrow>Internal · brand kit</Eyebrow>
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

        {/* --------------------------------------------------------------- marks --- */}
        <section className="mt-20">
          <DisplayHeading size="sub" as="h2">
            Marks
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            The logo mark carries the company; the owl mark carries a decision. The owl&apos;s
            eyes take the verdict colour, the exact values the explorer&apos;s risk pill uses,
            so a mark and a pill can never disagree on screen. Neutral accent is for surfaces
            that are not reporting an outcome.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="flex items-center justify-center gap-8 rounded-2xl border border-border bg-card p-8">
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
          <p className="mt-4 text-xs text-foreground/40">
            Full design review, silhouette tests included, lives on{' '}
            <a href="/mascot" className="font-semibold text-accent hover:underline">
              /mascot
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
      </div>
    </ThemeScope>
  )
}

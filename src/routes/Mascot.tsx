import { createElement, useEffect, useState } from 'react'
import PageHeader from '../components/PageHeader'
import ThemeScope from '../components/ThemeScope'
import { usePageMeta } from '../lib/head'
import OwlMark, { type OwlVerdict } from '../components/OwlMark'

/**
 * Internal design-review surface for the mascot.
 *
 * The owl won the first round, so this page stopped being a comparison of eight concepts
 * and became a review of one direction with variations. Everything here is brand-palette
 * coloured: ink #192837, accent #7342e2, cream #f2f2ee, sand #cfc8c5.
 *
 * The page is unlinked and noindex. It is a working surface, not a marketing page.
 *
 * Pipeline note for whoever picks this up: the drafts went text -> image -> 3D rather than
 * straight to text-to-3d, because direct text-to-3d gives almost no colour control and the
 * first eight came back grey. The 2D reference is kept next to each model for that reason,
 * it is the actual source of truth for the palette.
 */

const VIEWER_SRC = 'https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js'

type Variant = {
  id: string
  /** Present when a 3D model exists; reference-only variants omit it. */
  model?: string
  ref: string
  tr: string
  en: string
  note: string
  verdict: string
  lead?: boolean
}

const VARIANTS: Variant[] = [
  {
    id: 'geometric',
    model: 'owl-geometric',
    ref: 'ref-geometric',
    tr: 'Geometrik',
    en: 'Geometric',
    note: 'Cream body, ink facial disc, accent ring eyes. The rings read as a seal stamp, which is the one idea the product actually sells.',
    verdict: 'Strongest silhouette and the cleanest palette read. Recommended as the main mark.',
    lead: true,
  },
  {
    id: 'soft',
    model: 'owl-soft',
    ref: 'ref-soft',
    tr: 'Yumuşak',
    en: 'Soft',
    note: 'Rounder, warmer, a plush read rather than an instrument read. Accent lands lighter than the token value.',
    verdict: 'Likeable but generic. Says friendly, does not say verified.',
  },
  {
    id: 'officer',
    model: 'owl-officer',
    ref: 'ref-officer',
    tr: 'Memur',
    en: 'Officer',
    note: 'Ink body, cream chest plate carrying a concentric ring motif, accent eyes lit from inside. The most authority of the three.',
    verdict: 'Carries the negative states: 404 and the render error boundary. Inverts the palette, so it doubles as the dark-mode counterpart.',
  },
]

/**
 * `model-viewer` is a custom element with no JSX intrinsic type. Going through createElement
 * keeps it out of the global JSX namespace, which React 19 moved anyway.
 */
function Viewer({ model, silhouette }: { model: string; silhouette: boolean }) {
  return createElement('model-viewer', {
    src: `/mascots/${model}.glb`,
    alt: model,
    'camera-controls': true,
    'auto-rotate': true,
    'auto-rotate-delay': 0,
    'rotation-per-second': '16deg',
    'shadow-intensity': silhouette ? '0' : '1',
    'shadow-softness': '1',
    exposure: silhouette ? '0.6' : '1.1',
    'environment-image': 'neutral',
    'interaction-prompt': 'none',
    'touch-action': 'pan-y',
    loading: 'eager',
    style: {
      width: '100%',
      height: '100%',
      backgroundColor: 'transparent',
      // The silhouette pass is what a favicon or a sidebar avatar actually shows. A mascot
      // that only works as a hero render is a mascot that fails everywhere it gets used.
      filter: silhouette ? 'brightness(0) contrast(200%)' : 'none',
    },
  })
}

const SWATCHES = [
  { name: 'ink', hex: '#192837' },
  { name: 'accent', hex: '#7342e2' },
  { name: 'cream', hex: '#f2f2ee' },
  { name: 'sand', hex: '#cfc8c5' },
]

export default function Mascot() {
  const [ready, setReady] = useState(false)
  const [silhouette, setSilhouette] = useState(false)
  const [surface, setSurface] = useState<'background' | 'card'>('background')

  usePageMeta({ title: 'Mascot · A-Identity', noindex: true })

  useEffect(() => {
    if (document.querySelector('script[data-model-viewer]')) {
      setReady(true)
      return
    }
    const script = document.createElement('script')
    script.type = 'module'
    script.src = VIEWER_SRC
    script.dataset.modelViewer = 'true'
    script.onload = () => setReady(true)
    document.head.appendChild(script)
  }, [])


  const modelled = VARIANTS.filter((v) => v.model)

  return (
    <ThemeScope as="main" className="min-h-screen" surface={surface}>
      <PageHeader />

      <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-foreground/45">
          Internal · design review
        </p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
          The owl
        </h1>
        <p className="mt-4 max-w-[62ch] text-base leading-relaxed text-foreground/65">
          One direction, three variations, all coloured from the brand tokens. Drag any model
          to rotate it. The still next to each one is the 2D reference the model was built
          from, and it is the accurate record of the palette.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          {SWATCHES.map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <span
                className="h-5 w-5 rounded-full border border-border"
                style={{ backgroundColor: s.hex }}
              />
              <span className="text-xs font-medium text-foreground/55">
                {s.name} <span className="text-foreground/35">{s.hex}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setSilhouette((v) => !v)}
            aria-pressed={silhouette}
            className={`rounded-full border px-4 py-2 text-sm font-medium transition-colors ${
              silhouette
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-foreground/70 hover:text-foreground'
            }`}
          >
            Silhouette test
          </button>
          <button
            type="button"
            onClick={() => setSurface((s) => (s === 'background' ? 'card' : 'background'))}
            className="rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground/70 transition-colors hover:text-foreground"
          >
            Surface: {surface}
          </button>
          <span className="text-sm text-foreground/45">
            {silhouette
              ? 'Flattened to a solid shape, which is what a favicon shows.'
              : 'Use the theme toggle above to check both modes.'}
          </span>
        </div>

        {!ready && <p className="mt-10 text-sm text-foreground/50">Loading the 3D viewer…</p>}

        <section className="mt-10 space-y-8">
          {VARIANTS.map((v) => (
            <article
              key={v.id}
              className="overflow-hidden rounded-2xl border border-border bg-card"
            >
              <div className="grid sm:grid-cols-2">
                <div className="relative aspect-square border-b border-border sm:border-b-0 sm:border-r">
                  {v.model ? (
                    <Viewer model={v.model} silhouette={silhouette} />
                  ) : (
                    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-foreground/40">
                      No 3D model yet
                    </div>
                  )}
                  <span className="pointer-events-none absolute left-3 top-3 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-foreground">
                    {v.model ? '3D' : 'reference only'}
                  </span>
                  {v.lead && (
                    <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-semibold text-background">
                      Recommended
                    </span>
                  )}
                </div>

                <div className="aspect-square border-b border-border sm:border-b-0">
                  <img
                    src={`/mascots/${v.ref}.jpg`}
                    alt={`${v.en} owl reference`}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </div>
              </div>

              <div className="border-t border-border p-6">
                <h2 className="text-xl font-bold tracking-tight text-foreground">
                  {v.tr} <span className="font-normal text-foreground/45">· {v.en}</span>
                </h2>
                <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-foreground/70">
                  {v.note}
                </p>
                <p className="mt-3 max-w-[70ch] text-sm font-medium leading-relaxed text-foreground">
                  {v.verdict}
                </p>
              </div>
            </article>
          ))}
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">Small-size read</h2>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/60">
            The modelled variants at the sizes they get used: a sidebar avatar and a favicon.
            Turn on the silhouette test, and whatever stops being legible here cannot carry the
            mark on its own.
          </p>
          <div className="mt-6 flex flex-wrap gap-10">
            {modelled.map((v) => (
              <div key={v.id} className="flex flex-col items-center gap-3">
                <div className="flex items-end gap-4">
                  <div className="h-24 w-24">
                    <Viewer model={v.model as string} silhouette={silhouette} />
                  </div>
                  <div className="h-12 w-12">
                    <Viewer model={v.model as string} silhouette={silhouette} />
                  </div>
                  <div className="h-8 w-8">
                    <Viewer model={v.model as string} silhouette={silhouette} />
                  </div>
                </div>
                <span className="text-xs font-medium text-foreground/50">{v.tr}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">The flat mark</h2>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/60">
            The renders above stop being legible somewhere under 48px, and they cannot be
            recoloured. So the owl is redrawn as geometry for avatar and badge sizes, and the
            eyes carry the verdict: the same allow, warn and deny colours the explorer&apos;s
            risk pill uses. That is the mascot reporting the decision rather than sitting next
            to it.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(['neutral', 'allow', 'warn', 'deny'] as OwlVerdict[]).map((v) => (
              <div
                key={v}
                className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card p-6"
              >
                <OwlMark verdict={v} size={96} />
                <div className="flex items-end gap-3">
                  <OwlMark verdict={v} size={32} />
                  <OwlMark verdict={v} size={20} />
                  <OwlMark verdict={v} size={16} />
                </div>
                <span className="text-xs font-semibold uppercase tracking-wider text-foreground/45">
                  {v}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-sm text-foreground/45">
            96px, then 32, 20 and 16. The 16px row is the real test.
          </p>
        </section>

        <section className="mt-16 rounded-2xl border border-border bg-card p-6 sm:p-8">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">What is left</h2>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-foreground/70">
            <li>
              <span className="font-semibold text-foreground">Favicon.</span> Deliberately
              untouched. The tab icon is still the A-Identity logo mark, which is already
              theme-aware. The owl is the mascot, not the logo.
            </li>
            <li>
              <span className="font-semibold text-foreground">Rig and animate.</span> Needs a
              T-pose regeneration of whichever variant wins.
            </li>
          </ul>
        </section>
      </div>
    </ThemeScope>
  )
}

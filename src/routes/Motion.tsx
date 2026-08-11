import { createElement, useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import PageHeader from '../components/PageHeader'
import ThemeScope from '../components/ThemeScope'
import { DisplayHeading, Eyebrow, Lede } from '../components/ui/display'
import { usePageMeta } from '../lib/head'
import { BACKGROUND_VIDEO } from '../lib/brand'

/**
 * The motion lab: everything that moves, before it ships.
 *
 * Opened at the user's request as a separate surface precisely so the landing's hero film
 * does NOT change while its successor is being built here. When a cut on this page wins,
 * it gets promoted; until then the landing stays stable.
 *
 * Also the honest record of a dead end: Meshy's auto-rig rejected the mascot (422, pose
 * estimation failed), because it expects a humanoid and a one-piece egg with stub wings is
 * not one. So motion for this brand is frame pipelines and scene animation, not skeletal
 * rigs, and the turntables below are the first output of that pipeline
 * (scripts/turntable.mjs, zero credits, re-runnable).
 *
 * Unlinked and noindex, like /mascot and /brand-kit.
 */

const TURNTABLES = [
  { name: 'Soft', base: '/motion/owl-soft', note: 'The default face. 72 frames, 3s loop, alpha webm + cream mp4.' },
  { name: 'Officer', base: '/motion/owl-officer', note: 'The negative-state owl, same pipeline.' },
]

const POSES = [
  { src: '/mascots/owl-card.glb', name: 'Perched on the card', note: 'Hero candidate: the owl on the product.' },
  { src: '/mascots/owl-wing.glb', name: 'Presenting', note: 'For sections that introduce something beside it.' },
  { src: '/mascots/owl-soft-allow.glb', name: 'Allow eyes', note: 'Soft owl, emerald verdict eyes.' },
  { src: '/mascots/owl-soft-warn.glb', name: 'Warn eyes', note: 'Amber verdict eyes.' },
  { src: '/mascots/owl-soft-deny.glb', name: 'Deny eyes', note: 'Red verdict eyes.' },
]

const STORYBOARD = [
  {
    scene: 'Scene 1 · The rails (0-10s)',
    beats: [
      'The mark forms out of the grid tiles (art-grid), one tile lighting accent.',
      'Camera pulls back: the tile field becomes the chains the product runs on.',
      'The owl turntable enters, settles at three-quarter, eyes neutral accent.',
    ],
  },
  {
    scene: 'Scene 2 · Verify, then pay (10-20s)',
    beats: [
      'KYA: the lens (art-lens) closes around the iris, stamps a seal (art-seal).',
      'The verdict: owl eyes flip to allow-green (owl-soft-allow), gate arm lifts (art-gate).',
      'Payment orb crosses the gateway arcs (art-gateway) and settles; owl nods, loop closes.',
    ],
  },
]

/** Local viewer for arbitrary GLBs; the shared mascot component is deliberately typed to states. */
function GlbViewer({ src }: { src: string }) {
  return createElement('model-viewer', {
    src,
    'camera-controls': true,
    'camera-orbit': '15deg 78deg 105%',
    'disable-zoom': true,
    'shadow-intensity': '0',
    'environment-image': 'neutral',
    exposure: '1.15',
    'interaction-prompt': 'none',
    'touch-action': 'pan-y',
    style: { width: '100%', height: '100%', backgroundColor: 'transparent' },
  })
}

export default function Motion() {
  usePageMeta({ title: 'Motion Lab · A-Identity', noindex: true })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (document.querySelector('script[data-model-viewer]')) {
      setReady(true)
      return
    }
    const s = document.createElement('script')
    s.type = 'module'
    s.src = 'https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js'
    s.dataset.modelViewer = 'true'
    s.onload = () => setReady(true)
    document.head.appendChild(s)
  }, [])

  return (
    <ThemeScope as="main" className="min-h-screen">
      <PageHeader />
      <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-8">
        <Eyebrow>Internal · motion lab</Eyebrow>
        <DisplayHeading size="display" className="mt-3">
          Everything that moves.
        </DisplayHeading>
        <Lede className="mt-5">
          The hero film&apos;s successor is built here, beside the turntables and the poses it
          will be cut from. The landing does not change until a cut on this page wins.
        </Lede>

        <section className="mt-16">
          <DisplayHeading size="sub" as="h2">
            The hero film, as it ships today
          </DisplayHeading>
          <div className="mt-5 overflow-hidden rounded-3xl border border-border bg-card">
            <video src={BACKGROUND_VIDEO} autoPlay muted loop playsInline className="w-full" />
          </div>
        </section>

        <section className="mt-16">
          <DisplayHeading size="sub" as="h2">
            Hero film v2, storyboard
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            Two scenes, about twenty seconds, cut entirely from our own assets. Every beat
            names its source, so the edit is an assembly job rather than an art project.
          </p>
          <div className="mt-6 grid gap-5 md:grid-cols-2">
            {STORYBOARD.map((s) => (
              <div key={s.scene} className="rounded-2xl border border-border bg-card p-6">
                <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-foreground/45">
                  {s.scene}
                </h3>
                <ol className="mt-4 flex flex-col gap-3">
                  {s.beats.map((b, i) => (
                    <li key={b} className="flex gap-3 text-sm leading-relaxed text-foreground/70">
                      <span className="font-mono text-foreground/30">{i + 1}</span>
                      {b}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16">
          <DisplayHeading size="sub" as="h2">
            Turntables
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            Rendered from the GLBs by scripts/turntable.mjs: no credits, re-runnable, alpha
            webm for the site and cream mp4 for anywhere alpha does not survive.
          </p>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            {TURNTABLES.map((t) => (
              <div key={t.name} className="overflow-hidden rounded-3xl border border-border bg-card">
                <video
                  autoPlay
                  muted
                  loop
                  playsInline
                  className="aspect-square w-full object-contain"
                >
                  <source src={`${t.base}.webm`} type="video/webm" />
                  <source src={`${t.base}.mp4`} type="video/mp4" />
                </video>
                <div className="flex items-center justify-between border-t border-border p-4">
                  <div>
                    <p className="text-sm font-bold text-foreground">{t.name}</p>
                    <p className="mt-0.5 text-xs text-foreground/50">{t.note}</p>
                  </div>
                  <div className="flex gap-2">
                    {['webm', 'mp4'].map((ext) => (
                      <a
                        key={ext}
                        href={`${t.base}.${ext}`}
                        download
                        className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-foreground/60 hover:text-foreground"
                      >
                        <Download size={11} />
                        {ext}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16">
          <DisplayHeading size="sub" as="h2">
            Poses and verdict eyes
          </DisplayHeading>
          <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-foreground/55">
            The raw material the film cuts from. Drag to inspect; all live in /public/mascots
            and on /brand.
          </p>
          {!ready && <p className="mt-6 text-sm text-foreground/45">Loading the 3D viewer…</p>}
          <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
            {POSES.map((p) => (
              <div key={p.src} className="overflow-hidden rounded-2xl border border-border bg-card">
                <div className="aspect-square">{ready && <GlbViewer src={p.src} />}</div>
                <div className="border-t border-border p-3">
                  <p className="text-xs font-bold text-foreground">{p.name}</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-foreground/50">{p.note}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-16 rounded-2xl border border-border bg-card p-6">
          <h2 className="text-sm font-bold text-foreground">Why there is no skeletal rig</h2>
          <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-foreground/60">
            Meshy&apos;s auto-rig refused the mascot with a pose-estimation error, and it is
            right to: the rigger expects a humanoid and this body is a single egg with stub
            wings. Motion for this brand is therefore camera and scene work through the frame
            pipeline, which suits a mascot whose whole character is stillness with a verdict.
          </p>
        </section>
      </div>
    </ThemeScope>
  )
}

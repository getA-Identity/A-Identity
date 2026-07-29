import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

/**
 * Renders a GLB into a looping turntable video, no credits involved.
 *
 * This pipeline exists because Meshy's auto-rig rejected the mascot outright (422, pose
 * estimation): the rigger expects a humanoid, and a one-piece egg with stub wings is not
 * one. Frame-by-frame capture through model-viewer gives us motion anyway, with full
 * control of camera and timing, and it costs nothing to re-run.
 *
 * Usage:
 *   node scripts/turntable.mjs <glb-under-public> <out-basename> [frames] [size]
 *   node scripts/turntable.mjs mascots/owl-soft.glb owl-soft 72 720
 *
 * Outputs public/motion/<out>.webm (VP9 with alpha, for the site) and
 * public/motion/<out>.mp4 (H.264 on cream, for anywhere alpha does not survive).
 * Requires: python3 (static server), ffmpeg, playwright.
 */

const [glbPath = 'mascots/owl-soft.glb', outName = 'owl-soft', framesArg = '72', sizeArg = '720'] =
  process.argv.slice(2)
const FRAMES = Number(framesArg)
const SIZE = Number(sizeArg)
const FPS = 24
const TMP = `/tmp/turntable-${outName}`

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const html = `<!doctype html><html><head>
<script type="module" src="https://unpkg.com/@google/model-viewer@4.0.0/dist/model-viewer.min.js"></script>
<style>html,body{margin:0;background:transparent}model-viewer{width:${SIZE}px;height:${SIZE}px;background:transparent}</style>
</head><body><model-viewer id="mv" src="http://localhost:8899/${glbPath}"
  camera-orbit="0deg 78deg 105%" disable-zoom disable-pan shadow-intensity="0"
  environment-image="neutral" exposure="1.15" interaction-prompt="none"></model-viewer></body></html>`

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } })
await page.goto('http://localhost:8899/blank.html')
await page.setContent(html)
await page.waitForFunction(() => document.getElementById('mv')?.loaded === true, { timeout: 60000 })
await page.waitForTimeout(1500)

const el = await page.$('#mv')
for (let i = 0; i < FRAMES; i++) {
  const theta = (360 / FRAMES) * i
  await page.evaluate((t) => {
    document.getElementById('mv').cameraOrbit = `${t}deg 78deg 105%`
  }, theta)
  // interpolation-decay easing is irrelevant here: each frame waits until the camera has
  // effectively settled, which a short fixed delay covers at this step size.
  await page.waitForTimeout(90)
  await el.screenshot({ path: `${TMP}/f${String(i).padStart(3, '0')}.png`, omitBackground: true })
}
await browser.close()

execSync(
  `ffmpeg -y -framerate ${FPS} -i ${TMP}/f%03d.png -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 0 -crf 34 public/motion/${outName}.webm`,
  { stdio: 'ignore' },
)
execSync(
  `ffmpeg -y -f lavfi -i color=c=0xf2f2ee:s=${SIZE}x${SIZE}:r=${FPS} -framerate ${FPS} -i ${TMP}/f%03d.png -filter_complex "[0][1]overlay=shortest=1" -c:v libx264 -pix_fmt yuv420p -crf 22 public/motion/${outName}.mp4`,
  { stdio: 'ignore' },
)
rmSync(TMP, { recursive: true, force: true })
console.log(`done: public/motion/${outName}.webm + .mp4 (${FRAMES}f @ ${FPS}fps)`)

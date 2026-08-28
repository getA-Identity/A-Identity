/**
 * Renders the downloadable logo set for /brand into public/brand/.
 *
 * Three forms (mark only, horizontal lockup, vertical lockup) in the full-color
 * gradient mark plus one-color silhouettes, tinted in the brand palette and in the
 * color of every live chain. Chain colors are read from the generated
 * src/lib/chains.ts (single source of truth: mcp/src/chains/registry.ts), so a chain
 * added to the registry gets its logo variant by re-running this script, not by
 * editing it. The wordmark is set in the same Helvetica Now Display Bold the site
 * ships, and the silhouettes are CSS masks of the real raster mark: the logo is
 * never redrawn, only recolored through its own alpha channel.
 *
 * Run:  node scripts/gen-brand-logos.mjs
 * Then: (cd public/brand && zip -j a-identity-logo-kit.zip *.png ../logo/*.png)
 *
 * The outputs are committed. Re-run when the mark, the brand palette, or the set of
 * live chains changes, and re-run the zip afterwards so the bundle matches the files.
 */

import { chromium } from 'playwright'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = resolve(ROOT, 'public/brand')
mkdirSync(OUT, { recursive: true })

// ---- colors -----------------------------------------------------------------------

const BRAND_COLORS = [
  { key: 'ink', hex: '#192837' },
  { key: 'accent', hex: '#7342e2' },
  { key: 'cream', hex: '#f2f2ee' },
]

/** Live chains from the generated registry mirror (trailing commas stripped for JSON). */
function liveChains() {
  const src = readFileSync(resolve(ROOT, 'src/lib/chains.ts'), 'utf8')
  const open = src.indexOf('= [', src.indexOf('export const CHAINS')) + 2
  let depth = 0
  let end = -1
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']' && --depth === 0) {
      end = i
      break
    }
  }
  const text = src
    .slice(open, end + 1)
    .replace(/,\s*\]/g, ']')
    .replace(/,\s*\}/g, '}')
  return JSON.parse(text).filter((c) => c.status === 'live')
}

const CHAIN_COLORS = liveChains().map((c) => ({ key: c.id, hex: c.color }))
const ALL = [...BRAND_COLORS, ...CHAIN_COLORS]

// ---- page -------------------------------------------------------------------------

const font = resolve(ROOT, 'public/fonts/helvetica-now-display-bold.woff2')
const mark = resolve(ROOT, 'public/logo/mark-1024.png')

const tiles = []

// Full-color lockups: the gradient mark with an ink or cream wordmark.
for (const [key, hex] of [
  ['ink', '#192837'],
  ['cream', '#f2f2ee'],
]) {
  tiles.push(`
    <div class="tile row" data-out="lockup-horizontal-full-${key}.png">
      <img src="file://${mark}" style="height:240px;width:240px" alt="" />
      <span class="word" style="font-size:144px;color:${hex}">A-Identity</span>
    </div>
    <div class="tile col" data-out="lockup-vertical-full-${key}.png">
      <img src="file://${mark}" style="height:320px;width:320px" alt="" />
      <span class="word" style="font-size:104px;color:${hex}">A-Identity</span>
    </div>`)
}

// One-color silhouettes: mask the real mark's alpha with a flat fill.
for (const { key, hex } of ALL) {
  tiles.push(`
    <div class="tile" data-out="mark-${key}.png">
      <div class="sil" style="height:512px;width:512px;background:${hex}"></div>
    </div>
    <div class="tile row" data-out="lockup-horizontal-${key}.png">
      <div class="sil" style="height:240px;width:240px;background:${hex}"></div>
      <span class="word" style="font-size:144px;color:${hex}">A-Identity</span>
    </div>
    <div class="tile col" data-out="lockup-vertical-${key}.png">
      <div class="sil" style="height:320px;width:320px;background:${hex}"></div>
      <span class="word" style="font-size:104px;color:${hex}">A-Identity</span>
    </div>`)
}

const html = `<!doctype html><meta charset="utf-8"><style>
  @font-face {
    font-family: 'Helvetica Now Display';
    src: url('file://${font}') format('woff2');
    font-weight: 700;
  }
  body { margin: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 40px; background: transparent; }
  .tile { display: inline-flex; align-items: center; justify-content: center; }
  .tile.row { gap: 56px; }
  .tile.col { flex-direction: column; gap: 36px; }
  .word { font-family: 'Helvetica Now Display', sans-serif; font-weight: 700; letter-spacing: -0.02em; line-height: 1; white-space: nowrap; }
  .sil { -webkit-mask: url('file://${mark}') center / contain no-repeat; mask: url('file://${mark}') center / contain no-repeat; }
</style><body>${tiles.join('\n')}</body>`

// ---- render -----------------------------------------------------------------------

// A page built with setContent lives on about:blank and Chromium refuses its file://
// subresources (the mark, the mask, the font all fail silently). Serving the HTML AS a
// file makes those same-scheme loads legal.
const htmlPath = resolve(tmpdir(), 'a-identity-brand-tiles.html')
writeFileSync(htmlPath, html)

// CSS mask images are fetched in CORS mode (unlike plain <img>), and a file:// page has
// a null origin, so without this flag every silhouette renders empty while the lockups
// look fine. Fonts survive only because @font-face falls back silently; the load check
// below catches that too.
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1400 } })
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' })
await page.evaluate(() => document.fonts.ready)

// Fail loudly rather than shipping fallback-font or mask-less tiles.
const ok = await page.evaluate(() => ({
  font: document.fonts.check("700 16px 'Helvetica Now Display'"),
  imgs: [...document.images].every((i) => i.naturalWidth > 0),
}))
if (!ok.font || !ok.imgs) {
  await browser.close()
  throw new Error(`asset load failed: ${JSON.stringify(ok)}`)
}

for (const tile of await page.locator('.tile').all()) {
  const out = await tile.getAttribute('data-out')
  await tile.screenshot({ path: resolve(OUT, out), omitBackground: true })
  console.log('wrote', out)
}

await browser.close()
console.log(`${ALL.length} colors, done.`)

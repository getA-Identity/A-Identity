/**
 * Prerender the public routes to real HTML after the Vite build.
 *
 * The problem this solves is not subtle: the deployed index.html has an empty
 * body, so every crawler that does not execute JavaScript sees zero words and
 * zero links. Google renders JS and coped; nothing else did. Seobility read the
 * homepage as 0 words and scored page quality 52 and links 0, and Lighthouse
 * mobile measured LCP at 7.7s because nothing at all is painted until a
 * megabyte of JavaScript has parsed.
 *
 * Rather than adopt a framework or a prerender plugin, this drives the app in
 * the browser we already depend on for tests, and writes what it rendered. The
 * output is a normal static file per route, which Vercel serves from the
 * filesystem before it ever consults the SPA rewrite, so nothing about routing
 * or hydration changes for a visitor with JavaScript.
 *
 * Deliberately excluded: everything under /app (auth-gated, nothing to show a
 * crawler) and the internal design surfaces.
 *
 * Run as part of `npm run build`.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import playwright from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PORT = 4317
const BASE = `http://localhost:${PORT}`

/** Read the routes to prerender straight from the sitemap, so a new page cannot
 *  be published, listed for crawlers, and then left rendering blank for them. */
function routes() {
  const xml = readFileSync(join(ROOT, 'public/sitemap.xml'), 'utf8')
  const locs = [...xml.matchAll(/<loc>https:\/\/a-identity\.xyz([^<]*)<\/loc>/g)].map((m) => m[1] || '/')
  // /login and /signup are forms behind no content; prerendering them buys
  // nothing and risks baking in a transient auth state.
  return [...new Set(locs)].filter((p) => !p.startsWith('/app') && p !== '/login' && p !== '/signup')
}

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
})
const shutdown = () => server.kill()
process.on('exit', shutdown)
process.on('SIGINT', () => {
  shutdown()
  process.exit(1)
})

/** Wait for the preview server rather than sleeping a fixed amount. */
async function waitForServer(timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(2000) })
      if (r.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('vite preview did not start in time')
}

await waitForServer()

const browser = await playwright.chromium.launch()
// A desktop viewport so responsive branches render their fuller markup; the
// content is what matters here, not the layout that gets baked in.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })

const problems = []
let written = 0

for (const route of routes()) {
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  try {
    await page.goto(BASE + route, { waitUntil: 'networkidle', timeout: 60_000 })

    // Scroll the whole page so scroll-triggered reveals have run. Without this
    // every section below the fold is snapshotted at opacity 0, which is exactly
    // the content a crawler came for.
    await page.evaluate(async () => {
      const step = window.innerHeight
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 120))
      }
      window.scrollTo(0, 0)
    })
    await page.waitForTimeout(600)

    // Strip the inline animation state framer leaves behind, so the static file
    // is not a page of invisible text if JavaScript never arrives.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[style*="opacity"]')) {
        const s = el.style
        if (s.opacity && Number(s.opacity) < 1) s.opacity = ''
        if (s.transform) s.transform = ''
      }
    })

    const html = await page.content()

    const words = await page.evaluate(() => (document.body.innerText || '').split(/\s+/).filter(Boolean).length)
    if (words < 30) problems.push(`${route}: only ${words} words rendered`)
    if (errors.length) problems.push(`${route}: page error ${errors[0].slice(0, 90)}`)

    const dir = route === '/' ? DIST : join(DIST, route)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), html)
    written++
    console.log(`  ${route.padEnd(50)} ${String(words).padStart(5)} words`)
  } catch (e) {
    problems.push(`${route}: ${e.message.slice(0, 100)}`)
  } finally {
    await page.close()
  }
}

await browser.close()
server.kill()

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('prerender produced no homepage; refusing to ship an empty dist')
  process.exit(1)
}

console.log(`\nprerendered ${written} routes`)
if (problems.length) {
  console.error('\nprerender problems:')
  for (const p of problems) console.error(`  - ${p}`)
  // A route that rendered nothing is the exact failure this script exists to
  // prevent, so it fails the build rather than shipping a blank page quietly.
  process.exit(1)
}

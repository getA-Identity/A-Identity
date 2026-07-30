/**
 * Copy the committed prerendered HTML over the freshly built dist.
 *
 * Runs at the end of every build, including on Vercel, and needs no browser.
 * Vite has just written dist/index.html as the empty app shell; this replaces it
 * and adds one index.html per route, which the host serves from the filesystem
 * before it ever consults the SPA rewrite.
 *
 * The asset filenames inside the snapshot are content-hashed and change whenever
 * the bundle does, so a snapshot taken against an older build would point every
 * page at script tags that no longer exist. That is checked here rather than
 * discovered in production.
 */
import { cpSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'prerendered')
const DIST = join(ROOT, 'dist')

if (!existsSync(join(SRC, 'index.html'))) {
  console.warn('[prerender] no snapshot in prerendered/; shipping the client-rendered shell')
  process.exit(0)
}

// The snapshot references the entry script by its hashed filename. If that file
// is not in this build, the snapshot is from a different bundle and every
// prerendered page would load a 404 instead of the app.
const home = readFileSync(join(SRC, 'index.html'), 'utf8')
const referenced = [...home.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((m) => m[1])
const present = new Set(readdirSync(join(DIST, 'assets')).map((f) => `assets/${f}`))
const missing = referenced.filter((r) => !present.has(r))
if (missing.length) {
  console.error(
    `[prerender] snapshot references ${missing.length} asset(s) this build did not produce:\n` +
      missing.map((m) => `    ${m}`).join('\n') +
      '\n[prerender] The snapshot is out of date. Run: npm run prerender\n',
  )
  process.exit(1)
}

cpSync(SRC, DIST, { recursive: true, filter: (s) => !s.endsWith('.sources.json') })
console.log(`[prerender] applied snapshot over dist`)

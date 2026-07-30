/**
 * Copy the committed prerendered HTML over the freshly built dist.
 *
 * Runs at the end of every build, including on Vercel, and needs no browser.
 * Vite has just written dist/index.html as the empty app shell; this replaces it
 * and adds one index.html per route, which the host serves from the filesystem
 * before it ever consults the SPA rewrite.
 *
 * The snapshot's value is the rendered BODY. Its asset filenames are worthless
 * and actively dangerous: they are content hashes from whichever machine took
 * the snapshot, and a build on a different host resolves its dependency tree
 * slightly differently and emits different hashes. An earlier version of this
 * script compared them and refused to proceed, which failed a perfectly good
 * Vercel build for a difference that does not matter. So the asset references
 * are rewritten from the shell Vite just produced, which is the only copy that
 * is definitionally correct for this build.
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'prerendered')
const DIST = join(ROOT, 'dist')

if (!existsSync(join(SRC, 'index.html'))) {
  console.warn('[prerender] no snapshot in prerendered/; shipping the client-rendered shell')
  process.exit(0)
}

/** Every /assets/… reference in a document, in order of appearance. */
const assetRefs = (html) => [...html.matchAll(/\/assets\/([A-Za-z0-9._-]+)/g)].map((m) => m[1])

// The shell Vite wrote for THIS build. Read it before the copy overwrites it.
const freshShell = readFileSync(join(DIST, 'index.html'), 'utf8')
const fresh = assetRefs(freshShell)

/** Map a hashed filename to its stable prefix: "index-BbhZ.js" -> "index|js". */
const key = (f) => {
  const dot = f.lastIndexOf('.')
  const ext = f.slice(dot + 1)
  const base = f.slice(0, dot).replace(/-[A-Za-z0-9_-]{6,}$/, '')
  return `${base}|${ext}`
}

const byKey = new Map()
for (const f of fresh) byKey.set(key(f), f)

let files = 0
let rewrites = 0
const unresolved = new Set()

function applyDir(dir, rel = '') {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry)
    if (statSync(abs).isDirectory()) {
      applyDir(abs, join(rel, entry))
      continue
    }
    if (entry !== 'index.html') continue

    let html = readFileSync(abs, 'utf8')

    // The snapshot was taken after the app had run, so it carries modulepreload
    // hints the router injected for lazy chunks. Those filenames are hashed too,
    // and any that this build did not emit would 404 on every page load: a
    // console error on a page whose only job is to look good to a crawler, and
    // a Lighthouse best-practices failure. The runtime re-injects whatever it
    // actually needs, so dropping the stale ones costs nothing.
    html = html.replace(
      /[ \t]*<link[^>]+rel="(?:modulepreload|preload|prefetch)"[^>]*>\n?/g,
      (tag) => {
        const ref = tag.match(/\/assets\/([A-Za-z0-9._-]+)/)?.[1]
        if (!ref) return tag // preloads for fonts and the like are ours, keep them
        return existsSync(join(DIST, 'assets', ref)) ? tag : ''
      },
    )

    for (const old of new Set(assetRefs(html))) {
      const replacement = byKey.get(key(old))
      if (!replacement) continue
      if (replacement !== old) {
        html = html.split(`/assets/${old}`).join(`/assets/${replacement}`)
        rewrites++
      }
    }
    const dest = join(DIST, rel, 'index.html')
    writeFileSync(dest, html)
    files++
  }
}

// Copy first so directories and any non-HTML files land, then rewrite in place.
cpSync(SRC, DIST, { recursive: true, filter: (s) => !s.endsWith('.sources.json') })
applyDir(SRC)

// Report the property that actually matters: a reference that resolves to no
// file. Anything else is bookkeeping about hashes nobody reads.
for (const f of readdirSync(DIST, { recursive: true })) {
  if (typeof f !== 'string' || !f.endsWith('index.html')) continue
  for (const ref of new Set(assetRefs(readFileSync(join(DIST, f), 'utf8')))) {
    if (!existsSync(join(DIST, 'assets', ref))) unresolved.add(`${f} -> ${ref}`)
  }
}

console.log(`[prerender] applied snapshot over dist: ${files} pages, ${rewrites} asset refs rewritten`)
if (unresolved.size) {
  console.error(`[prerender] ${unresolved.size} dangling asset reference(s):`)
  for (const u of [...unresolved].slice(0, 5)) console.error(`    ${u}`)
  process.exit(1)
}

// The entry script is the one reference that must resolve, or every prerendered
// page ships a dead <script> and the site never hydrates.
const home = readFileSync(join(DIST, 'index.html'), 'utf8')
const entry = assetRefs(home).find((f) => f.endsWith('.js'))
if (!entry || !existsSync(join(DIST, 'assets', entry))) {
  console.error(`[prerender] the applied homepage points at a missing entry script (${entry ?? 'none'})`)
  process.exit(1)
}

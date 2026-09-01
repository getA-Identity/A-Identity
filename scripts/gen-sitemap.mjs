/**
 * Generate public/sitemap.xml, including hreflang alternates for translated posts.
 *
 * The alternates are the point. Two URLs carrying the same article in different
 * languages look like duplicate content unless each one declares the other, and
 * a sitemap is the most reliable place to say it: a search engine reads it once
 * for the whole site rather than having to render every page to find a link tag
 * in a client-side head.
 *
 * Only routes with no data behind them are listed by hand. Blog posts come from
 * src/lib/blog.ts and use cases from src/lib/usecases.ts, so a new post or a new
 * use case cannot be published and then quietly left out. That is not a
 * hypothetical: five of the eight use cases rendered, were linked, and were in
 * neither this file nor the prerender snapshot (scripts/prerender.mjs reads its
 * route list back out of the sitemap), so a crawler that does not run JavaScript
 * saw an empty shell on every one of them.
 *
 * Run:   node scripts/gen-sitemap.mjs
 * Check: node scripts/gen-sitemap.mjs --check
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/sitemap.xml')
const BASE = 'https://a-identity.xyz'

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

/**
 * The `slug:` values out of one of the src/lib data modules.
 *
 * Reading the source rather than importing it: these files are TSX-free but still
 * TypeScript, and a build step just to list slugs would be worse than a regex over
 * a file whose shape we control. The four-space indent is part of that contract, so
 * a refactor that changes it fails loudly here instead of silently dropping pages
 * out of the sitemap and out of the prerender that reads it.
 */
function slugsIn(rel, source) {
  const slugs = [...source.matchAll(/^\s{4}slug: '([a-z0-9-]+)',/gm)].map((m) => m[1])
  if (slugs.length === 0) {
    throw new Error(`found no slugs in ${rel}; the parser in scripts/gen-sitemap.mjs needs updating`)
  }
  return slugs
}

const blog = read('src/lib/blog.ts')
const slugs = slugsIn('src/lib/blog.ts', blog)
const useCases = slugsIn('src/lib/usecases.ts', read('src/lib/usecases.ts'))

/** Does this post have a Turkish rendering? Detected by a `tr:` key inside its object. */
const objects = blog.split(/^\s{2}\{$/m)
const translated = new Set()
for (const chunk of objects) {
  const m = chunk.match(/^\s{4}slug: '([a-z0-9-]+)',/m)
  if (m && /^\s{4}tr: \{/m.test(chunk)) translated.add(m[1])
}

/** path, changefreq, priority. Ordered by how much we want them crawled. */
const STATIC = [
  ['/', 'weekly', '1.0'],
  ['/faq', 'monthly', '0.8'],
  ['/blog', 'weekly', '0.8'],
  ['/tr/blog', 'weekly', '0.8'],
  ['/manifesto', 'monthly', '0.7'],
  ['/architecture', 'monthly', '0.7'],
  ...useCases.map((slug) => [`/use-cases/${slug}`, 'monthly', '0.7']),
  ['/contact', 'monthly', '0.6'],
  ['/explorer', 'weekly', '0.6'],
  ['/signup', 'yearly', '0.5'],
  ['/login', 'yearly', '0.5'],
  ['/brand', 'monthly', '0.4'],
  ['/intro', 'monthly', '0.7'],
  ['/stats', 'weekly', '0.6'],
  ['/celo-proof', 'weekly', '0.6'],
  // The index over every rail, and the only proof link the footer carries. Ranked above
  // the per-rail pages because it is the one a crawler should reach first.
  ['/proof', 'weekly', '0.8'],
  ['/proof/arc', 'weekly', '0.6'],
  ['/proof/stellar', 'weekly', '0.6'],
  ['/proof/algorand', 'weekly', '0.6'],
  ['/proof/base', 'weekly', '0.6'],
  ['/proof/robinhood', 'weekly', '0.7'],
  ['/proof/arbitrum', 'weekly', '0.6'],
  ['/proof/celo', 'weekly', '0.6'],
]

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

function urlEntry(loc, { changefreq, priority, alternates }) {
  const alts = (alternates ?? [])
    .map((a) => `    <xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${esc(a.href)}"/>`)
    .join('\n')
  return [
    '  <url>',
    `    <loc>${esc(loc)}</loc>`,
    alts,
    changefreq ? `    <changefreq>${changefreq}</changefreq>` : '',
    priority ? `    <priority>${priority}</priority>` : '',
    '  </url>',
  ]
    .filter(Boolean)
    .join('\n')
}

const entries = []

for (const [path, changefreq, priority] of STATIC) {
  const alternates =
    path === '/blog' || path === '/tr/blog'
      ? [
          { hreflang: 'en', href: `${BASE}/blog` },
          { hreflang: 'tr', href: `${BASE}/tr/blog` },
          { hreflang: 'x-default', href: `${BASE}/blog` },
        ]
      : undefined
  entries.push(urlEntry(`${BASE}${path}`, { changefreq, priority, alternates }))
}

for (const slug of slugs) {
  const hasTr = translated.has(slug)
  // Every version of a cluster must list every version including itself; a page
  // that only points outward leaves the cluster incomplete and it gets ignored.
  const alternates = hasTr
    ? [
        { hreflang: 'en', href: `${BASE}/blog/${slug}` },
        { hreflang: 'tr', href: `${BASE}/tr/blog/${slug}` },
        { hreflang: 'x-default', href: `${BASE}/blog/${slug}` },
      ]
    : undefined
  entries.push(urlEntry(`${BASE}/blog/${slug}`, { changefreq: 'monthly', priority: '0.6', alternates }))
  if (hasTr) {
    entries.push(urlEntry(`${BASE}/tr/blog/${slug}`, { changefreq: 'monthly', priority: '0.6', alternates }))
  }
}

const xml =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n' +
  '        xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
  entries.join('\n') +
  '\n</urlset>\n'

if (process.argv.includes('--check')) {
  const current = readFileSync(OUT, 'utf8')
  if (current !== xml) {
    console.error('sitemap.xml is stale. Run: node scripts/gen-sitemap.mjs')
    process.exit(1)
  }
  console.log(
    `sitemap is current (${entries.length} urls, ${useCases.length} use cases, ${translated.size} translated posts)`,
  )
} else {
  writeFileSync(OUT, xml)
  console.log(`wrote ${OUT}`)
  console.log(
    `  ${entries.length} urls, ${slugs.length} posts, ${translated.size} with a Turkish version, ${useCases.length} use cases`,
  )
}

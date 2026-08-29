/**
 * Generate public/sitemap.xml, including hreflang alternates for translated posts.
 *
 * The alternates are the point. Two URLs carrying the same article in different
 * languages look like duplicate content unless each one declares the other, and
 * a sitemap is the most reliable place to say it: a search engine reads it once
 * for the whole site rather than having to render every page to find a link tag
 * in a client-side head.
 *
 * Static routes are listed here; blog posts are read from src/lib/blog.ts so a
 * new post cannot be published and then quietly left out of the sitemap.
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

/** path, changefreq, priority. Ordered by how much we want them crawled. */
const STATIC = [
  ['/', 'weekly', '1.0'],
  ['/faq', 'monthly', '0.8'],
  ['/blog', 'weekly', '0.8'],
  ['/tr/blog', 'weekly', '0.8'],
  ['/manifesto', 'monthly', '0.7'],
  ['/architecture', 'monthly', '0.7'],
  ['/use-cases/pay-per-data-call', 'monthly', '0.7'],
  ['/use-cases/gpu-hours-rented-by-agent', 'monthly', '0.7'],
  ['/use-cases/idle-usdc-parked-in-usyc', 'monthly', '0.7'],
  ['/contact', 'monthly', '0.6'],
  ['/explorer', 'weekly', '0.6'],
  ['/signup', 'yearly', '0.5'],
  ['/login', 'yearly', '0.5'],
  ['/brand', 'monthly', '0.4'],
  ['/intro', 'monthly', '0.7'],
  ['/stats', 'weekly', '0.6'],
  ['/celo-proof', 'weekly', '0.6'],
  ['/proof/robinhood', 'weekly', '0.7'],
  ['/proof/arbitrum', 'weekly', '0.6'],
  ['/proof/base', 'weekly', '0.6'],
  ['/proof/stellar', 'weekly', '0.6'],
  ['/proof/algorand', 'weekly', '0.6'],
]

// Read the posts out of the source rather than importing it: blog.ts is TSX-free
// but still TypeScript, and a build step just to list slugs would be worse than
// a regex over a file whose shape we control.
const blog = readFileSync(join(ROOT, 'src/lib/blog.ts'), 'utf8')
const slugs = [...blog.matchAll(/^\s{4}slug: '([a-z0-9-]+)',/gm)].map((m) => m[1])
if (slugs.length === 0) throw new Error('found no post slugs in src/lib/blog.ts; the parser needs updating')

/** Does this post have a Turkish rendering? Detected by a `tr:` key inside its object. */
const objects = blog.split(/^\s{2}\{$/m)
const translated = new Set()
for (const chunk of objects) {
  const m = chunk.match(/^\s{4}slug: '([a-z0-9-]+)',/m)
  if (m && /^\s{4}tr: \{/m.test(chunk)) translated.add(m[1])
}

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
  console.log(`sitemap is current (${entries.length} urls, ${translated.size} translated posts)`)
} else {
  writeFileSync(OUT, xml)
  console.log(`wrote ${OUT}`)
  console.log(`  ${entries.length} urls, ${slugs.length} posts, ${translated.size} with a Turkish version`)
}

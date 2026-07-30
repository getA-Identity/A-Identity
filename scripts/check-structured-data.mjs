/**
 * Keep index.html's structured data honest about the page it describes.
 *
 * The FAQ schema on the homepage has to be inline in index.html rather than
 * injected at runtime, because the crawlers that matter most here are the ones
 * that never execute JavaScript. That means the answers exist in two places, and
 * two copies of anything drift. This fails the build when they do.
 *
 * It also checks the advertised prices against the gateway's own PRICES table,
 * so a price change cannot leave a stale figure in a rich result that a search
 * engine will happily keep showing for weeks.
 *
 * Run: node scripts/check-structured-data.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

// ── The graph itself parses ────────────────────────────────────────────────
const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
if (!block) {
  console.error('index.html has no JSON-LD block at all')
  process.exit(1)
}
let graph
try {
  graph = JSON.parse(block[1])['@graph']
} catch (e) {
  console.error(`index.html JSON-LD is not valid JSON: ${e.message}`)
  process.exit(1)
}
const byType = (t) => graph.find((n) => n['@type'] === t)

// ── FAQ answers match the ones the page renders ────────────────────────────
const faqSource = readFileSync(join(ROOT, 'src/components/sections/LandingFaq.tsx'), 'utf8')
// Each entry is `q: '...'` followed by a `plain:` template literal. Reading them
// out of the source beats importing TSX from a plain node script.
const rendered = [...faqSource.matchAll(/\n {4}q: '((?:[^'\\]|\\.)*)',\n {4}plain:\n?\s*'((?:[^'\\]|\\.)*)',/g)].map(
  (m) => ({ q: m[1].replace(/\\'/g, "'"), a: m[2].replace(/\\'/g, "'") }),
)

const faqNode = byType('FAQPage')
if (!faqNode) {
  problems.push('index.html has no FAQPage node, so the homepage questions are invisible to answer engines')
} else if (rendered.length === 0) {
  problems.push('could not read any questions out of LandingFaq.tsx; the parser above needs updating')
} else {
  const schema = faqNode.mainEntity.map((q) => ({ q: q.name, a: q.acceptedAnswer.text }))
  if (schema.length !== rendered.length) {
    problems.push(`FAQPage lists ${schema.length} questions but the page renders ${rendered.length}`)
  }
  for (const item of rendered) {
    const match = schema.find((s) => s.q === item.q)
    if (!match) {
      problems.push(`FAQPage is missing a question the page shows: "${item.q}"`)
      continue
    }
    // The rendered `plain` text is authoritative; the schema must quote it exactly.
    if (match.a.replace(/\s+/g, ' ').trim() !== item.a.replace(/\s+/g, ' ').trim()) {
      problems.push(`FAQPage answer has drifted from the page for: "${item.q}"`)
    }
  }
}

// ── Advertised prices match what the gateway actually charges ──────────────
const payment = readFileSync(join(ROOT, 'mcp/src/asp/payment.ts'), 'utf8')
const charged = Object.fromEntries(
  [...payment.matchAll(/'POST \/tools\/(\w+)': '\$([\d.]+)'/g)].map((m) => [m[1], m[2]]),
)
const offers = byType('SoftwareApplication')?.offers?.offers ?? []
if (offers.length === 0) problems.push('SoftwareApplication has no itemised offers')
for (const offer of offers) {
  const price = charged[offer.name]
  if (price === undefined) {
    // A free tool is legitimately absent from PRICES; anything else is a ghost.
    if (offer.price !== '0') problems.push(`offer "${offer.name}" is priced at ${offer.price} but the gateway does not charge for it`)
    continue
  }
  if (offer.price !== price) {
    problems.push(`offer "${offer.name}" advertises $${offer.price} but the gateway charges $${price}`)
  }
}
for (const [tool, price] of Object.entries(charged)) {
  if (!offers.some((o) => o.name === tool)) {
    problems.push(`the gateway charges $${price} for "${tool}" but no offer advertises it`)
  }
}

if (problems.length) {
  console.error('Structured data is out of step with the site:\n')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  `structured data is consistent (${faqNode.mainEntity.length} FAQ answers, ${offers.length} offers matched against the gateway)`,
)

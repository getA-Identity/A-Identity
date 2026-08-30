/**
 * Keep the machine-facing surface honest about the product it describes.
 *
 * The FAQ schema on the homepage has to be inline in index.html rather than
 * injected at runtime, because the crawlers that matter most here are the ones
 * that never execute JavaScript. That means the answers exist in THREE places:
 * the React source that renders them, the JSON-LD in index.html, and
 * public/index.md, the markdown twin middleware.ts serves to a client asking for
 * `Accept: text/markdown`. Copies of anything drift. This fails the build when
 * they do.
 *
 * It also checks the numbers that are typed by hand and believed by machines:
 * the advertised prices against the gateway's own PRICES table, and the
 * settlement claims against the ledgers behind them. A stale figure in a rich
 * result or an llms.txt is one a search engine or an agent will happily keep
 * repeating for weeks.
 *
 * Run: node scripts/check-structured-data.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
/** Prose wraps and markup indents; neither is drift. Everything else is. */
const flat = (s) => s.replace(/\s+/g, ' ').trim()

// ── The graph itself parses ────────────────────────────────────────────────
const html = read('index.html')
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
const faqSource = read('src/components/sections/LandingFaq.tsx')
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
    if (flat(match.a) !== flat(item.a)) {
      problems.push(`FAQPage answer has drifted from the page for: "${item.q}"`)
    }
  }
}

// ── The markdown twin carries the same FAQ, so it drifts the same way ──────
/**
 * public/index.md is the third copy, and until now it was reconciled against
 * nothing: it kept a six-question FAQ of its own whose wording matched neither
 * the page nor the JSON-LD. An agent that asks for `Accept: text/markdown` got
 * answers no other surface would have given it.
 *
 * `plain` stays authoritative here too. index.md must quote it verbatim, wrapped
 * however the file wraps, which is why the comparison collapses whitespace and
 * nothing else: no bold, no angle-bracket autolinks, no markdown of any kind
 * inside an answer, because every one of those would be a difference nobody
 * could tell from a real edit.
 */
const indexMd = read('public/index.md')
const mdFaq = indexMd.match(/## The questions worth asking first\n\n([\s\S]*?)(?=\n## )/)
if (!mdFaq) {
  problems.push(
    'public/index.md has no "The questions worth asking first" section, so the answers it serves to markdown clients are unchecked',
  )
} else if (rendered.length > 0) {
  // `**Question?**` on its own line, then the answer up to the next question.
  const mdItems = [...mdFaq[1].matchAll(/\*\*(.+?)\*\*\n([\s\S]*?)(?=\n\n\*\*|$)/g)].map((m) => ({
    q: m[1],
    a: m[2],
  }))
  if (mdItems.length !== rendered.length) {
    problems.push(`public/index.md lists ${mdItems.length} questions but the page renders ${rendered.length}`)
  }
  for (const item of rendered) {
    const match = mdItems.find((s) => s.q === item.q)
    if (!match) {
      problems.push(`public/index.md is missing a question the page shows: "${item.q}"`)
      continue
    }
    if (flat(match.a) !== flat(item.a)) {
      problems.push(`public/index.md answer has drifted from the page for: "${item.q}"`)
    }
  }
}

// ── Advertised prices match what the gateway actually charges ──────────────
const payment = read('mcp/src/asp/payment.ts')
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

// ── Settlement claims match the ledgers behind them ───────────────────────
/**
 * Same idea as the price table, for the numbers agents read instead of the page.
 * llms.txt, llms-full.txt and index.md all quoted "120 settlements" with nothing
 * pinning them to anything, so the figure could rot in three files at once.
 *
 * TWO numbers, deliberately kept apart. mcp/src/asp/settlements.ts is the X Layer
 * ledger and nothing else; the other mainnets keep their history in
 * mcp/src/chains/provenance.ts. Adding them together would produce a figure that
 * describes no rail, which is exactly what railProof refuses to do, so the copy
 * states the X Layer count and then counts the OTHER MAINNETS rather than their
 * transactions.
 *
 * Rails and not per-chain transaction counts, on purpose: a provenance artifact is
 * a curated proof rather than a row per settlement (one of them covers an in-policy
 * payment and the typed refusal beside it), so counting artifacts would not be
 * counting settlements. How many mainnets have settled at all is a fact the ledger
 * does state exactly, and it is the one that changes on a go-live.
 */
const PUBLISHED = ['public/llms.txt', 'public/llms-full.txt', 'public/index.md']

const settlementLedger = read('mcp/src/asp/settlements.ts')
const xLayerSettlements = [...settlementLedger.matchAll(/^ {2}\{ round: \d+, tool: '/gm)].length
if (xLayerSettlements === 0) {
  problems.push('read no rows out of mcp/src/asp/settlements.ts; the parser in this script needs updating')
}

/** Registry ids to testnet flags, so "mainnet" is the registry's word and not ours. */
const isTestnet = new Map()
for (const chunk of read('mcp/src/chains/registry.ts').split(/^ {2}\{$/m)) {
  const id = chunk.match(/^ {4}id: '([a-z0-9-]+)',/m)
  const flag = chunk.match(/^ {4}testnet: (true|false),/m)
  if (id && flag) isTestnet.set(id[1], flag[1] === 'true')
}
/** Mainnets with at least one settlement artifact. X Layer is absent by design: its
 *  history lives in the ASP ledger above, which is why the two claims stay separate. */
const settlingMainnets = read('mcp/src/chains/provenance.ts')
  .split(/^ {2}\{$/m)
  .filter((chunk) => /kind: 'settlement'/.test(chunk))
  .map((chunk) => chunk.match(/^ {4}chain: '([a-z0-9-]+)',/m)?.[1])
  .filter((chain) => chain && isTestnet.get(chain) === false)
if (isTestnet.size === 0 || settlingMainnets.length === 0) {
  problems.push(
    'read no settling mainnets out of mcp/src/chains/provenance.ts against the registry; the parser in this script needs updating',
  )
}

/** Prose spells small numbers out, and the claim is prose. */
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }
const asNumber = (s) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()])

/** Each published claim: the phrase that carries it, and the truth it must carry. */
const CLAIMS = [
  {
    what: 'the X Layer settlement count',
    // Named rail in the phrase itself. "120 settlements" said nothing about which
    // chain it counted, which is how it survived three go-lives without moving.
    pattern: /(\d+) x402 settlements on X Layer mainnet/g,
    truth: () => xLayerSettlements,
    source: 'mcp/src/asp/settlements.ts',
    shape: '"<n> x402 settlements on X Layer mainnet"',
  },
  {
    what: 'the number of mainnets settling beside X Layer',
    pattern: /(\w+) more mainnets carry settlements of their own/g,
    truth: () => settlingMainnets.length,
    source: `mcp/src/chains/provenance.ts (${settlingMainnets.join(', ')})`,
    shape: '"<n> more mainnets carry settlements of their own"',
  },
]

for (const rel of PUBLISHED) {
  const text = flat(read(rel))
  for (const claim of CLAIMS) {
    const found = [...text.matchAll(claim.pattern)]
    if (found.length === 0) {
      problems.push(
        `${rel} no longer states ${claim.what} in the form ${claim.shape}, so nothing pins it to ${claim.source}`,
      )
      continue
    }
    for (const m of found) {
      if (asNumber(m[1]) !== claim.truth()) {
        problems.push(
          `${rel} claims "${m[0]}" but ${claim.source} records ${claim.truth()}. Update the copy, not the ledger.`,
        )
      }
    }
  }
}

if (problems.length) {
  console.error('The published surface is out of step with the code behind it:\n')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  `structured data is consistent (${faqNode.mainEntity.length} FAQ answers across index.html and index.md, ` +
    `${offers.length} offers matched against the gateway, ` +
    `${xLayerSettlements} X Layer settlements and ${settlingMainnets.length} other settling mainnets matched against the ledgers)`,
)

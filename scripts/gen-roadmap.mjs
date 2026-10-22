/**
 * Generate ROADMAP.md from src/lib/roadmap.ts.
 *
 * The roadmap page and the GitHub document used to be two hand-written things, which is
 * how a roadmap drifts: the page says a chain is live and the markdown still calls it
 * planned. Now there is one data file, the page imports it, and this script renders the
 * same data into the markdown. `--check` fails the build while the two disagree.
 *
 * Reading the data: this is a plain Node script with no TypeScript compiler in front of
 * it, so it does not import the module. It slices each `export const NAME ... = <literal>`
 * out of the source text and evaluates the literal as JavaScript, under the contract the
 * data file states at its top (plain single-quoted literals, no references to other
 * constants, each exported array closing on its own line at column 0). The same contract
 * as scripts/gen-sitemap.mjs reading blog.ts, applied to a file whose shape we own.
 *
 * It also enforces what the roadmap promises: a shipped item has an ISO date and at least
 * one piece of evidence, a committed item has a due date, nothing else carries a date,
 * every chain id exists in the generated registry mirror, and the output is plain ASCII.
 *
 * Run:   node scripts/gen-roadmap.mjs
 * Check: node scripts/gen-roadmap.mjs --check
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = 'src/lib/roadmap.ts'
const CHAINS_FILE = 'src/lib/chains.ts'
const OUT = join(ROOT, 'ROADMAP.md')
const WIDTH = 90

const fail = (msg) => {
  console.error(`gen-roadmap: ${msg}`)
  process.exit(1)
}

const source = readFileSync(join(ROOT, DATA), 'utf8')

/**
 * The literal assigned to `export const NAME`, evaluated as JavaScript. An array or object
 * literal ends at the first line that is only its closing bracket at column 0; a string
 * constant ends with its line.
 */
function literal(name) {
  const match = source.match(new RegExp(`^export const ${name}\\b[^=\\n]*= `, 'm'))
  if (!match) fail(`${DATA} no longer exports ${name}`)
  const rest = source.slice(match.index + match[0].length)
  const open = rest[0]
  let text
  if (open === '[' || open === '{') {
    const close = open === '[' ? '\n]' : '\n}'
    const end = rest.indexOf(`${close}\n`)
    if (end < 0) fail(`${name}: no closing bracket on its own line at column 0`)
    text = rest.slice(0, end + close.length)
  } else {
    text = rest.slice(0, rest.indexOf('\n'))
  }
  try {
    return new Function(`return (${text})`)()
  } catch (e) {
    fail(
      `${name} in ${DATA} is not a plain JavaScript literal (${e.message}). ` +
        'The data file states the contract at its top: no template literals, no references to other constants, no TypeScript inside the exported literals.',
    )
  }
}

const UPDATED = literal('ROADMAP_UPDATED')
const SITE = literal('ROADMAP_SITE')
const PRINCIPLES = literal('ROADMAP_PRINCIPLES')
const STATUSES = literal('ROADMAP_STATUSES')
const TRACKS = literal('ROADMAP_TRACKS')
const INFLUENCE = literal('ROADMAP_INFLUENCE')
const ITEMS = literal('ROADMAP_ITEMS')

/**
 * The chains, read out of the generated registry mirror the same way: `"id"`, `"name"`
 * and `"status"` sit at a four-space indent in every chain object and nowhere else at that
 * indent. The counts in the document come from here, never from the roadmap data.
 */
const chainsSource = readFileSync(join(ROOT, CHAINS_FILE), 'utf8')
const pick = (key) =>
  [...chainsSource.matchAll(new RegExp(`^ {4}"${key}": "([^"]+)",?$`, 'gm'))].map((m) => m[1])
const chainIds = pick('id')
const chainNames = pick('name')
const chainStatuses = pick('status')
if (!chainIds.length || chainIds.length !== chainNames.length || chainIds.length !== chainStatuses.length) {
  fail(`could not read the chains out of ${CHAINS_FILE}; the parser in scripts/gen-roadmap.mjs needs updating`)
}
const CHAINS = chainIds.map((id, i) => ({ id, name: chainNames[i], status: chainStatuses[i] }))
const chainName = (id) => CHAINS.find((c) => c.id === id)?.name ?? id

// ── Integrity: the promises the roadmap makes, checked before anything is written ──────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const statusIds = STATUSES.map((s) => s.id)
const trackIds = TRACKS.map((t) => t.id)
const seen = new Set()
const problems = []
for (const item of ITEMS) {
  const at = `item "${item.id ?? '(no id)'}"`
  if (!item.id) problems.push(`${at}: no id`)
  else if (seen.has(item.id)) problems.push(`${at}: duplicate id`)
  seen.add(item.id)
  if (!item.title || !item.summary) problems.push(`${at}: needs a title and a summary`)
  if (!statusIds.includes(item.status)) problems.push(`${at}: unknown status ${item.status}`)
  if (!trackIds.includes(item.track)) problems.push(`${at}: unknown track ${item.track}`)
  if (item.status === 'shipped') {
    if (!ISO_DAY.test(item.date ?? '')) problems.push(`${at}: shipped without an ISO date`)
    if (!item.evidence?.length) problems.push(`${at}: shipped without evidence`)
    if (item.due) problems.push(`${at}: a shipped item has no due date`)
  } else if (item.status === 'committed') {
    if (!ISO_DAY.test(item.due ?? '')) problems.push(`${at}: committed without an ISO due date`)
    if (item.date) problems.push(`${at}: committed items carry a due date, not a shipped date`)
  } else {
    if (item.date) problems.push(`${at}: only shipped items carry a date`)
    if (item.due) problems.push(`${at}: only committed items carry a due date`)
  }
  for (const c of item.chains ?? []) {
    if (!chainIds.includes(c)) problems.push(`${at}: chain ${c} is not in ${CHAINS_FILE}`)
  }
  for (const ev of item.evidence ?? []) {
    const ok =
      ev.href.startsWith('https://') ||
      ev.href.startsWith('/') ||
      /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(ev.href)
    if (!ev.label || !ok) problems.push(`${at}: evidence needs a label and a site path, an https URL or a repository path (got ${ev.href})`)
  }
}
if (!ISO_DAY.test(UPDATED)) problems.push(`ROADMAP_UPDATED is not an ISO day: ${UPDATED}`)
if (problems.length) fail(`the roadmap data breaks its own rules:\n  ${problems.join('\n  ')}`)

// ── Rendering ──────────────────────────────────────────────────────────────────────────

const statusLabel = (id) => STATUSES.find((s) => s.id === id)?.label ?? id
const trackLabel = (id) => TRACKS.find((t) => t.id === id)?.label ?? id

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthLabel = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`

/** A site path becomes absolute; an https URL stays; a repository path stays relative so
 *  GitHub resolves it against the file at the root. */
const linkHref = (href) => (href.startsWith('/') ? `${SITE}${href}` : href)
const md = (ev) => `[${ev.label}](${linkHref(ev.href)})`

/** Word-wrap one paragraph, every line prefixed with `indent`. */
function wrap(text, indent = '') {
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && indent.length + candidate.length > WIDTH) {
      lines.push(indent + line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(indent + line)
  return lines.join('\n')
}

function itemBlock(item) {
  const when =
    item.status === 'shipped' ? item.date : item.status === 'committed' ? `due ${item.due}` : null
  const meta = [when, trackLabel(item.track)].filter(Boolean).join('; ')
  const out = [`- **${item.title}** (${meta})`, '', wrap(item.summary, '  ')]
  if (item.details) out.push('', wrap(item.details, '  '))
  const foot = []
  if (item.chains?.length) foot.push(`Chains: ${item.chains.map(chainName).join(', ')}.`)
  if (item.evidence?.length) foot.push(`Evidence: ${item.evidence.map(md).join(', ')}.`)
  if (foot.length) out.push('', `  ${foot.join(' ')}`)
  return out.join('\n')
}

const byStatus = (status) => ITEMS.filter((i) => i.status === status)
const shipped = byStatus('shipped')
  .slice()
  .sort((a, b) => b.date.localeCompare(a.date))

const lines = []
const push = (...xs) => lines.push(...xs)

push('# A-Identity roadmap', '')
push(
  wrap(
    'What shipped, what is underway, what we have committed to, and what comes next, in ' +
      'that order. Dates appear on things that already happened and on the program milestones ' +
      'we signed, nowhere else. Every shipped item names the day it landed and a place to ' +
      `check it. The same data renders ${SITE}/roadmap.`,
  ),
  '',
  `Updated ${UPDATED}.`,
  '',
)

push('## How to read this', '')
for (const s of STATUSES) push(wrap(`- **${s.label}**: ${s.rule}`, '').replace(/\n/g, '\n  '))
push('', 'The rules this document keeps:', '')
PRINCIPLES.forEach((p, i) => push(wrap(`${i + 1}. ${p}`).replace(/\n/g, '\n   ')))
push('')

push('## At a glance', '')
const header = ['Track', ...STATUSES.map((s) => s.label)]
push(`| ${header.join(' | ')} |`)
push(`| --- | ${STATUSES.map(() => '---:').join(' | ')} |`)
for (const t of TRACKS) {
  const row = STATUSES.map((s) => ITEMS.filter((i) => i.track === t.id && i.status === s.id).length)
  push(`| ${t.label} | ${row.join(' | ')} |`)
}
push(`| **All tracks** | ${STATUSES.map((s) => `**${byStatus(s.id).length}**`).join(' | ')} |`, '')
const bucket = (status) => CHAINS.filter((c) => c.status === status)
const chainLine = ['live', 'beta', 'planned']
  .filter((s) => bucket(s).length)
  .map((s) => `${bucket(s).length} ${s} (${bucket(s).map((c) => c.name).join(', ')})`)
  .join(', ')
push(
  wrap(
    `Chains in the registry: ${chainLine}. Read from \`mcp/src/chains/registry.ts\` through ` +
      'its generated mirror, never typed here.',
  ),
  '',
)

push('## Shipped', '')
push(wrap('Newest first. Each item names the day it landed and where to check it.'), '')
let month = ''
for (const item of shipped) {
  const key = item.date.slice(0, 7)
  if (key !== month) {
    month = key
    push(`### ${monthLabel(item.date)}`, '')
  }
  push(itemBlock(item), '')
}

push('## In progress', '')
push(wrap('Work underway now. No completion dates, on purpose.'), '')
for (const item of byStatus('in-progress')) push(itemBlock(item), '')

push('## Committed', '')
push(
  wrap(
    'Program milestones with the due dates in the agreement. These are the only future ' +
      `dates in this document, and the progress against them is published live at ${SITE}/proof/arc ` +
      `and ${SITE}/api/arc/season rather than promised here.`,
  ),
  '',
)
for (const item of byStatus('committed')) push(itemBlock(item), '')

push('## Next', '')
push(wrap('What follows the current work, in order. Undated, deliberately.'), '')
for (const item of byStatus('next')) push(itemBlock(item), '')

push('## Later', '')
push(wrap('Direction rather than schedule: known and wanted, not dated.'), '')
for (const item of byStatus('later')) push(itemBlock(item), '')

push('## How to influence this', '')
for (const l of INFLUENCE) push(`- ${md(l)}`)
push(
  '',
  wrap(
    'A chain lands as a registry entry plus at most one adapter, never as scattered special ' +
      'cases; CONTRIBUTING.md carries the rule. An issue that names the chain, the rail and the ' +
      'evidence you would expect to see is the fastest way to move an item up this list.',
  ),
  '',
)

push('---', '')
push(
  wrap(
    `Generated from \`${DATA}\` by \`scripts/gen-roadmap.mjs\`; do not edit by hand. Edit the ` +
      'data file, run `node scripts/gen-roadmap.mjs`, and `npm run check:roadmap` fails the build ' +
      `while this file is stale. The same data renders the page at ${SITE}/roadmap.`,
  ),
)

const next = lines.join('\n') + '\n'

// ASCII only: the project rule for prose, enforced here because this file is published
// on GitHub and nothing else scans it. Code spans are ASCII too, so no exemption is needed.
const nonAscii = next.split('\n').findIndex((l) => /[^\x20-\x7E]/.test(l))
if (nonAscii >= 0) fail(`line ${nonAscii + 1} of the output is not plain ASCII:\n  ${next.split('\n')[nonAscii]}`)

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    fail(`ROADMAP.md is missing. Run: node scripts/gen-roadmap.mjs`)
  }
  if (current !== next) {
    const a = current.split('\n')
    const b = next.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1
    console.error(
      'ROADMAP.md is stale. Run: node scripts/gen-roadmap.mjs\n' +
        `  first difference at line ${i + 1}:\n` +
        `    have: ${(a[i] ?? '(end of file)').slice(0, 140)}\n` +
        `    want: ${(b[i] ?? '(end of file)').slice(0, 140)}`,
    )
    process.exit(1)
  }
  console.log(
    `ROADMAP.md is current (${shipped.length} shipped, ${byStatus('in-progress').length} in progress, ` +
      `${byStatus('committed').length} committed, ${byStatus('next').length} next, ${byStatus('later').length} later; ` +
      `${CHAINS.length} chains from the registry)`,
  )
} else {
  writeFileSync(OUT, next)
  console.log(`wrote ${OUT}`)
  console.log(
    `  ${shipped.length} shipped, ${byStatus('in-progress').length} in progress, ${byStatus('committed').length} committed, ` +
      `${byStatus('next').length} next, ${byStatus('later').length} later; updated ${UPDATED}`,
  )
}

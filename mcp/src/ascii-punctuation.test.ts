import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * CLAUDE.md ground rule one: plain ASCII punctuation in prose, comments and UI copy. No em
 * dashes, no curly quotes, no arrows outside code.
 *
 * Nothing enforced it, and it had drifted into 75 files and 297 characters, several of
 * them in API-visible strings rather than comments: a route label that read "USDC -> EURC"
 * with a real arrow, refusal reasons, a no-key explanation. A commit had already claimed to
 * have cleaned them all once.
 *
 * A rule with no test is a preference. This is the test.
 *
 * Scope, first pass: source we author, `mcp/src` and `src`. Markdown was deliberately out,
 * and the reason was "the docs carry quoted material from other people and a quote should
 * keep its own punctuation."
 *
 * Scope, second pass: that reason is still good, but it bought a much wider exemption than
 * it paid for. Nearly every .mdx page under docs/ is our own prose, and it is published on
 * the docs site, so the rule went unenforced exactly where it is most visible. The em dash
 * in docs/chains/arc.mdx sat in a sentence of ours, not in anyone's quote. So the .mdx
 * pages are in now, and the quote keeps its exemption by name instead of by proxy:
 *
 *   - Blockquote lines are skipped. That is the original reason, stated precisely: someone
 *     else's words keep someone else's punctuation.
 *   - Fenced blocks and inline code are skipped. The rule itself says "no arrows outside
 *     code", a lifecycle written as `approve -> burn` belongs in code, and pasted output
 *     is not ours to rewrite.
 *   - URLs and link targets are skipped. Punctuation in an address is an address.
 *   - Frontmatter is NOT skipped, on purpose: title and description are our own copy and
 *     they ship as the page's rendered heading and its meta description, which is the most
 *     visible prose on the page rather than the least.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))
const REPO = join(HERE, '../..')

/** The characters the rule names, plus the ones that are the same mistake wearing a
 *  different code point. Written as escapes so this file cannot violate its own rule. */
const BANNED: Record<string, string> = {
  '\u2010': 'hyphen',
  '\u2011': 'non-breaking hyphen',
  '\u2012': 'figure dash',
  '\u2013': 'en dash',
  '\u2014': 'em dash',
  '\u2015': 'horizontal bar',
  '\u2018': 'left single quote',
  '\u2019': 'right single quote',
  '\u201A': 'low single quote',
  '\u201B': 'reversed single quote',
  '\u201C': 'left double quote',
  '\u201D': 'right double quote',
  '\u201E': 'low double quote',
  '\u201F': 'reversed double quote',
  '\u2190': 'left arrow',
  '\u2191': 'up arrow',
  '\u2192': 'right arrow',
  '\u2193': 'down arrow',
  '\u2194': 'left-right arrow',
  '\u21D0': 'double left arrow',
  '\u21D2': 'double right arrow',
}

function filesUnder(dir: string, keep: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) filesUnder(full, keep, out)
    else if (keep.test(name)) out.push(full)
  }
  return out
}

/** One line per banned character, naming where it first shows up. */
function findings(rel: string, text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  for (const [ch, name] of Object.entries(BANNED)) {
    if (!text.includes(ch)) continue
    const at = lines.findIndex((l) => l.includes(ch))
    out.push(`${rel}:${at + 1} contains a ${name}`)
  }
  return out
}

/** Blank every matched character except the newlines, so an exempt region stops being
 *  scanned without shifting the line number every finding reports. */
function blankOut(text: string, pattern: RegExp): string {
  return text.replace(pattern, (m) => m.replace(/[^\n]/g, ' '))
}

/** The markdown regions the rule does not reach. Order matters: masking fenced blocks
 *  first means their backticks cannot pair with a real inline span further down. */
function maskExempt(md: string): string {
  let out = md
  out = blankOut(out, /^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[^\n]*$/gm) // fenced code
  out = blankOut(out, /(`+)[^`]*\1/g) // inline code, which may wrap across a line
  out = blankOut(out, /^[ \t]{0,3}>.*$/gm) // blockquote: someone else's punctuation
  out = blankOut(out, /\]\([^)\n]*\)/g) // markdown link and image targets
  out = blankOut(out, /\b(?:href|src)=(?:"[^"\n]*"|\{[^}\n]*\})/g) // JSX targets
  out = blankOut(out, /\bhttps?:\/\/\S+/g) // bare URLs and autolinks
  return out
}

const ADVICE =
  `Plain ASCII punctuation is project law (CLAUDE.md ground rule 1). Use - for dashes, ` +
  `' and " for quotes, and words rather than arrows in prose`

test('no source file uses non-ASCII punctuation', () => {
  const offenders: string[] = []
  for (const root of ['mcp/src', 'src']) {
    for (const file of filesUnder(join(REPO, root), /\.tsx?$/)) {
      offenders.push(...findings(file.slice(REPO.length + 1), readFileSync(file, 'utf8')))
    }
  }
  assert.deepEqual(offenders, [], `${ADVICE}:\n  ${offenders.join('\n  ')}`)
})

test('no docs page uses non-ASCII punctuation outside a quote or code', () => {
  const offenders: string[] = []
  for (const file of filesUnder(join(REPO, 'docs'), /\.mdx$/)) {
    const rel = file.slice(REPO.length + 1)
    offenders.push(...findings(rel, maskExempt(readFileSync(file, 'utf8'))))
  }
  assert.deepEqual(
    offenders,
    [],
    `${ADVICE}. Quotes, code and URLs are exempt, so a finding here is our own copy on ` +
      `the published docs site:\n  ${offenders.join('\n  ')}`,
  )
})

/** Eleven lines, and every banned character in them sits in an exempt region. */
const EM = '\u2014'
const EXEMPT_FIXTURE = [
  '---', // 1
  'title: "Frontmatter is scanned"', // 2
  '---', // 3
  '', // 4
  `> Someone else said it ${EM} so it keeps their punctuation.`, // 5
  '', // 6
  '```sh', // 7
  `# a pasted snippet ${EM} not ours to rewrite`, // 8
  '```', // 9
  '', // 10
  `Inline \`a ${EM} b\`, a [link](/x${EM}y), and https://x.test/${EM}z.`, // 11
].join('\n')

test('the docs exemptions cover quotes and code, and nothing wider', () => {
  // An exemption that quietly swallows body prose would pass the docs scan while enforcing
  // nothing, which is how the markdown gap opened in the first place. So: the exempt
  // regions are silent, and the two places that are NOT exempt still speak up.
  assert.deepEqual(findings('f.mdx', maskExempt(EXEMPT_FIXTURE)), [])

  const prose = `${EXEMPT_FIXTURE}\n\nA sentence of our own ${EM} caught.`
  assert.deepEqual(findings('f.mdx', maskExempt(prose)), ['f.mdx:13 contains a em dash'])

  const frontmatter = EXEMPT_FIXTURE.replace('is scanned', `is scanned ${EM} not exempt`)
  assert.deepEqual(findings('f.mdx', maskExempt(frontmatter)), ['f.mdx:2 contains a em dash'])
})

test('the rule covers the characters it says it covers', () => {
  // A guard whose banned list quietly shrinks stops guarding without failing. Two anchors:
  // the em dash and the right arrow are the two the rule names by example, and a curly
  // apostrophe is the one that appears most often by accident.
  for (const ch of ['\u2014', '\u2192', '\u2019']) {
    assert.ok(ch in BANNED, `the banned list lost ${JSON.stringify(ch)}`)
  }
})

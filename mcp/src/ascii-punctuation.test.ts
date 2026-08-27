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
 * Scope is source we author: `mcp/src` and `src`. Markdown is deliberately out, because the
 * docs carry quoted material from other people and a quote should keep its own punctuation.
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

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sources(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

test('no source file uses non-ASCII punctuation', () => {
  const offenders: string[] = []
  for (const root of ['mcp/src', 'src']) {
    for (const file of sources(join(REPO, root))) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      for (const [ch, name] of Object.entries(BANNED)) {
        if (!text.includes(ch)) continue
        const at = lines.findIndex((l) => l.includes(ch))
        offenders.push(`${file.slice(REPO.length + 1)}:${at + 1} contains a ${name}`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Plain ASCII punctuation is project law (CLAUDE.md ground rule 1). Use - for dashes, ` +
      `' and " for quotes, and words rather than arrows in prose:\n  ${offenders.join('\n  ')}`,
  )
})

test('the rule covers the characters it says it covers', () => {
  // A guard whose banned list quietly shrinks stops guarding without failing. Two anchors:
  // the em dash and the right arrow are the two the rule names by example, and a curly
  // apostrophe is the one that appears most often by accident.
  for (const ch of ['\u2014', '\u2192', '\u2019']) {
    assert.ok(ch in BANNED, `the banned list lost ${JSON.stringify(ch)}`)
  }
})

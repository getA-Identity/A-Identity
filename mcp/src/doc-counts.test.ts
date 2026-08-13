import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHAINS } from './chains/registry.js'

/**
 * The numbers we quote about ourselves.
 *
 * Five documents claimed 522 unit tests, one claimed 482, and the only number CI checked
 * said something else again. Two smoke scripts printed "9 chains" while the registry held
 * ten. None of that is dishonesty, it is just a count in prose with nothing watching it,
 * which is exactly the shape of claim a test can own.
 *
 * The second assertion in each block matters as much as the first: every listed document
 * must match at least one pattern. Rephrasing a claim into a shape this file does not
 * recognize would otherwise disable the check silently, which is worse than a wrong
 * number because nobody would ever find out.
 */

/** Compiled to dist/, so mcp/src is one level up and the repo root two. */
const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const repo = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = dir + entry
    if (statSync(full).isDirectory()) out.push(...testFiles(full + '/'))
    else if (entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const files = testFiles(SRC)
const declared = files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/^test\(/gm) ?? []).length, 0)

const COUNT_PATTERNS: RegExp[] = [
  /tests-(\d+)%20unit/g, // the README badge
  /(\d+) unit tests/g,
  /(\d+) tests across (\d+)/g,
  /\((\d+) across (\d+) files\)/g,
]

const DOCS_WITH_COUNTS = ['README.md', 'ARCHITECTURE.md', 'CLAUDE.md', 'mcp/README.md', 'ROADMAP.md']

test('every document that quotes a test count quotes the real one', () => {
  for (const doc of DOCS_WITH_COUNTS) {
    const text = repo(doc)
    let matched = 0
    for (const pattern of COUNT_PATTERNS) {
      pattern.lastIndex = 0
      for (const m of text.matchAll(pattern)) {
        matched += 1
        assert.equal(
          Number(m[1]),
          declared,
          `${doc} claims ${m[1]} tests; the suite declares ${declared}. Fix the doc, or add a pattern here if you invented a new phrasing.`,
        )
        if (m[2] !== undefined) {
          assert.equal(
            Number(m[2]),
            files.length,
            `${doc} claims ${m[2]} test files; there are ${files.length}.`,
          )
        }
      }
    }
    assert.ok(
      matched > 0,
      `${doc} is listed as quoting a test count but matches no known phrasing. Either it stopped quoting one (drop it from DOCS_WITH_COUNTS) or the phrasing changed (add a pattern).`,
    )
  }
})

test('nothing claims a chain count the registry does not have', () => {
  // smoke.ts and http-smoke.ts derive theirs now; this is the backstop for prose.
  for (const doc of ['README.md', 'ARCHITECTURE.md', 'public/llms.txt', 'public/llms-full.txt', 'public/index.md']) {
    const text = repo(doc)
    for (const m of text.matchAll(/\b(\d+)\s+chains\b/g)) {
      assert.equal(
        Number(m[1]),
        CHAINS.length,
        `${doc} says "${m[0]}"; the registry has ${CHAINS.length}.`,
      )
    }
  }
})

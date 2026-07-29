import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * The `npm test` script names its test files explicitly, which is deliberate (it runs the
 * built output, and a glob would also pick up stale files in dist). The cost of that choice
 * is that a new test file can be written, pass locally under a glob, and never run in CI.
 *
 * That already happened once: bet-schema.test.ts was added in Phase 7 and was missing from
 * the list. So the list is asserted rather than maintained by hand.
 */

const root = new URL('../', import.meta.url)

function testFiles(dir = new URL('src/', root), prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...testFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`))
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(`${prefix}${entry.name.replace(/\.ts$/, '.js')}`)
    }
  }
  return out
}

test('every test file in src/ is named in the npm test script', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    scripts: { test: string }
  }
  const listed = new Set(
    pkg.scripts.test
      .split(/\s+/)
      .filter((t) => t.startsWith('dist/') && t.endsWith('.test.js'))
      .map((t) => t.slice('dist/'.length)),
  )
  const missing = testFiles().filter((f) => !listed.has(f))
  assert.deepEqual(missing, [], `these test files exist but CI never runs them: ${missing.join(', ')}`)
})

test('the npm test script names no file that no longer exists', () => {
  // The other direction: a deleted test leaves a path that makes `node --test` fail, or
  // worse, silently matches nothing.
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    scripts: { test: string }
  }
  const present = new Set(testFiles())
  const stale = pkg.scripts.test
    .split(/\s+/)
    .filter((t) => t.startsWith('dist/') && t.endsWith('.test.js'))
    .map((t) => t.slice('dist/'.length))
    .filter((f) => !present.has(f))
  assert.deepEqual(stale, [], `the test script names files with no source: ${stale.join(', ')}`)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

/**
 * The proof document serves a test count to reviewers, and it does so as a hardcoded
 * number, because the real total is only known by running the suite and the ASP is a
 * separate process that must answer without running anything.
 *
 * proof.ts argues, in its own comments, that a copied number can go stale and that "a stale
 * figure is exactly the kind of claim that should not exist". It was right and it was also
 * the offender: the count sat at 365 while the suite had moved to 377. So the claim is now
 * asserted against a recount instead of trusted.
 *
 * The recount is static (top-level `test(` declarations), which currently matches the
 * runtime total exactly. If someone generates tests in a loop the two will diverge, this
 * fails, and that is the correct outcome: a public claim about rigor should force a decision
 * rather than drift.
 */

const srcRoot = new URL('../../src/', import.meta.url)

function countDeclaredTests(dir = srcRoot): number {
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      n += countDeclaredTests(new URL(`${entry.name}/`, dir))
    } else if (entry.name.endsWith('.test.ts')) {
      const text = readFileSync(new URL(entry.name, dir), 'utf8')
      n += (text.match(/^test\(/gm) ?? []).length
    }
  }
  return n
}

test('the test count served in /proof matches the suite', () => {
  const proof = readFileSync(new URL('asp/proof.ts', srcRoot), 'utf8')
  const claimed = Number(/tests:\s*(\d+)/.exec(proof)?.[1])
  assert.ok(Number.isFinite(claimed), 'proof.ts no longer states a test count')
  const actual = countDeclaredTests()
  assert.equal(
    claimed,
    actual,
    `/proof claims ${claimed} tests, the suite declares ${actual}. Update the number in asp/proof.ts.`,
  )
})

test('the proof document claims no traction number, only a link to the live one', () => {
  // Same failure mode, higher stakes: a decision count or a protected-value figure copied
  // in here would be stale the moment it was written. The file's own rule.
  const proof = readFileSync(new URL('asp/proof.ts', srcRoot), 'utf8')
  const guardrails = proof.slice(proof.indexOf('guardrails: {'), proof.indexOf('engineering: {'))
  assert.ok(guardrails.includes('/api/traction'), 'the guardrail block stopped linking live traction')
  assert.equal(
    /(checks|decisions|protectedNotionalUsd)\s*:\s*\d/.test(guardrails),
    false,
    'a traction figure was copied into the proof document',
  )
})

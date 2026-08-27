import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CHAINS } from './chains/index.js'
import { SETTLEMENTS } from './asp/settlements.js'
import { PRICES } from './asp/payment.js'

/**
 * The frontend quotes figures the backend owns, and nothing checked them.
 *
 * `doc-counts.test.ts` pins these claims in the markdown. The same claims live in `src/`
 * as hardcoded literals in stat blocks, and there they had drifted badly: a landing
 * section arguing that a number you cannot reproduce is worth less than one you can was
 * itself showing 546 settlements against a real 120, and 522 tests against 874. The
 * architecture page said 163 tests and 2 chains while the registry carried seven.
 *
 * Pinned rather than derived. These are marketing surfaces where a human chooses the
 * wording and the emphasis, so the literal stays a literal and this test makes changing
 * it a deliberate act instead of something nobody notices for months.
 */
const repo = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8')

/** Every `k: '<digits>'` in the file's STATS block, in order. */
function statLiterals(text: string): string[] {
  const block = /const STATS = \[([\s\S]*?)\n\]/.exec(text)
  assert.ok(block, 'no STATS block found; the shape changed and this test needs rewriting, not deleting')
  return [...block[1].matchAll(/k: '([^']+)'/g)].map((m) => m[1])
}

const identityChains = CHAINS.filter((c) => c.contracts.identityRegistry).length
const paidTools = Object.keys(PRICES).length

test('the landing proof block quotes the settlement count and the test count the backend owns', () => {
  const text = repo('src/components/sections/LiveProof.tsx')
  const stats = statLiterals(text)
  assert.ok(
    stats.includes(String(SETTLEMENTS.length)),
    `LiveProof quotes ${stats.join(', ')}; the X Layer ledger has ${SETTLEMENTS.length} settlements`,
  )
  // The test count is the one asp/proof.ts already publishes, so read it from there rather
  // than counting again and inventing a second source of truth for the same number.
  const proof = repo('mcp/src/asp/proof.ts')
  const tests = /tests:\s*(\d+)/.exec(proof)?.[1]
  assert.ok(tests, 'asp/proof.ts no longer declares a test count')
  assert.ok(stats.includes(tests), `LiveProof quotes ${stats.join(', ')}; the suite declares ${tests}`)
})

test('the architecture page quotes the settlement, test, service and chain counts', () => {
  const stats = statLiterals(repo('src/routes/Architecture.tsx'))
  const tests = /tests:\s*(\d+)/.exec(repo('mcp/src/asp/proof.ts'))?.[1]
  for (const [what, want] of [
    ['settlements', String(SETTLEMENTS.length)],
    ['tests', String(tests)],
    // Seven services, six of them paid. The page says "services, one free", so the number
    // it quotes is the total.
    ['services', String(paidTools + 1)],
    ['identity chains', String(identityChains)],
  ] as const) {
    assert.ok(stats.includes(want), `Architecture quotes ${stats.join(', ')}; ${what} is ${want}`)
  }
})

test('no landing surface calls a scripted illustration a live read', () => {
  // The specific defect: a static mock captioned "live from the chain", and a synthetic
  // ledger carrying an animated live-pulse dot. Both read as a feed to anybody scanning.
  const surfaces = [
    'src/components/sections/ConsoleShowcase.tsx',
    'src/components/sections/VerifyPayFlow.tsx',
  ]
  for (const file of surfaces) {
    const text = repo(file)
    assert.doesNotMatch(
      text,
      /live from the chain/i,
      `${file} captions a mock as a live chain read. If it became a real read, delete this assertion in the same commit.`,
    )
  }
  assert.doesNotMatch(
    repo('src/components/sections/VerifyPayFlow.tsx'),
    /animate-ping/,
    'VerifyPayFlow is a scripted illustration; a pinging dot is the one convention readers take as "happening now"',
  )
})

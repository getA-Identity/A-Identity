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
const read = (rel: string): string => readFileSync(new URL(rel, srcRoot), 'utf8')

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

/**
 * On-chain literals we quote must match the file that actually owns them.
 *
 * A blind test-count find-and-replace (779, then 801, then 805) once fired inside
 * hex literals that contained the old count as a substring: the /proof asset
 * address, a README registry address, a settlement tx hash and a mint block all
 * mutated in lockstep with the count. Each guard below pins a quoted literal to
 * its source of truth, so the next count bump cannot silently rewrite an address.
 */

test('the /proof settlement asset address matches the one stats.ts reads on-chain', () => {
  const asset = /asset:\s*'[^']*\((0x[0-9a-fA-F]{40})\)'/.exec(read('asp/proof.ts'))?.[1]
  const usdt0 = /const USDT0 = '(0x[0-9a-fA-F]{40})'/.exec(read('asp/stats.ts'))?.[1]
  assert.ok(asset, 'proof.ts no longer quotes an asset address')
  assert.ok(usdt0, 'stats.ts no longer defines USDT0')
  assert.equal(
    asset,
    usdt0,
    `the /proof asset address (${asset}) drifted from stats.ts (${usdt0}); a count bump likely corrupted a hex literal.`,
  )
})

test('every ValidationRegistry address the README quotes is one the registry declares', () => {
  const registry = read('chains/registry.ts')
  const known = new Set([...registry.matchAll(/validationRegistry:\s*'(0x[0-9a-fA-F]{40})'/g)].map((m) => m[1]))
  assert.ok(known.size > 0, 'registry.ts no longer declares a validationRegistry')
  const quoted = [...read('../../README.md').matchAll(/Validation Registry \| \[`(0x[0-9a-fA-F]{40})`\]/g)].map((m) => m[1])
  assert.ok(quoted.length > 0, 'the README no longer quotes a Validation Registry address')
  for (const addr of quoted) {
    assert.ok(known.has(addr), `the README quotes ValidationRegistry ${addr}, absent from registry.ts (${[...known].join(', ')}).`)
  }
})

test('every X Layer settlement tx the README links exists in the ledger', () => {
  const ledger = read('asp/settlements.ts')
  const linked = [...read('../../README.md').matchAll(/oklink\.com\/x-layer\/evm\/tx\/(0x[0-9a-fA-F]{64})/g)].map((m) => m[1])
  assert.ok(linked.length > 0, 'the README no longer links any X Layer settlement tx')
  for (const tx of linked) {
    assert.ok(ledger.includes(tx), `the README links settlement tx ${tx}, absent from settlements.ts; a count bump likely corrupted the hash.`)
  }
})

test('the mint block the README and ARCHITECTURE quote matches provenance.ts', () => {
  const provenance = read('chains/provenance.ts')
  for (const doc of ['../../README.md', '../../ARCHITECTURE.md']) {
    const blocks = [...read(doc).matchAll(/in block (\d+),/g)].map((m) => m[1])
    assert.ok(blocks.length > 0, `${doc} no longer quotes a mint block`)
    for (const b of blocks) {
      assert.ok(provenance.includes(`blockNumber: ${b}`), `${doc} quotes block ${b}, not a blockNumber in provenance.ts; a count bump likely corrupted it.`)
    }
  }
})

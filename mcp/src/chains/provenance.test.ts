import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROVENANCE, PROOF_RAILS, artifactUrl, contractUrl, provenanceFor } from './provenance.js'
import { getChainById } from './registry.js'
import { proofRailIndex } from './proof.js'

/**
 * The ledger is the page a reviewer clicks, so the failure mode that matters is a claim
 * that cannot be checked: a hash that is not a hash, a link typed by hand, or a chain
 * that quietly has nothing it admits it cannot do.
 */

/** Compiled to dist/chains/, so the repo root is three levels up. */
const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))

test('every provenance entry names a chain the registry actually has', () => {
  for (const p of PROVENANCE) {
    const chain = getChainById(p.chain)
    assert.ok(chain, `provenance names unknown chain ${p.chain}`)
    assert.ok(['live', 'beta'].includes(chain.status), `${p.chain} is ${chain.status}: publish proof for wired chains only`)
    assert.ok(p.summary.length > 40, `${p.chain} needs a real summary`)
  }
})

test('every hash and address is well formed, and every artifact lands on a known chain', () => {
  for (const p of PROVENANCE) {
    for (const a of p.artifacts) {
      assert.match(a.txHash, /^0x[0-9a-f]{64}$/, `${p.chain}: ${a.label} has a malformed tx hash`)
      const on = getChainById(a.onChain)
      assert.ok(on, `${p.chain}: ${a.label} lands on unknown chain ${a.onChain}`)
      assert.ok(on.explorer, `${a.onChain} has no explorer, so this artifact could not be linked`)
      assert.ok(artifactUrl(a)?.includes(a.txHash))
    }
    for (const c of p.contracts) {
      assert.match(c.address, /^0x[0-9a-fA-F]{40}$/, `${p.chain}: ${c.name} has a malformed address`)
      assert.ok(contractUrl(p.chain, c.address)?.includes(c.address))
    }
  }
})

test('no explorer URL is hand written in the ledger', () => {
  // Links must derive from the descriptor of the chain a transaction landed on. A typed
  // URL is how a proof page ends up pointing at the wrong chain's explorer, which is
  // exactly the bug this repo already shipped once on the public explorer page.
  const src = readFileSync(fileURLToPath(new URL('../../src/chains/provenance.ts', import.meta.url)), 'utf8')
  const urls = src.match(/https?:\/\/[^\s'"`]+/g) ?? []
  for (const u of urls) {
    assert.ok(
      u.includes('a-identity.xyz/.well-known/agent-card.json'),
      `provenance.ts contains a hand-written URL (${u}). Derive it with txUrl/addressUrl instead.`,
    )
  }
})

test('an agent entry parses to its own chain and token id', () => {
  for (const p of PROVENANCE) {
    if (!p.agent) continue
    const chain = getChainById(p.chain)!
    assert.equal(p.agent.caip, `${chain.caip2}:8004/${p.agent.tokenId}`, `${p.chain}: caip id disagrees with the descriptor`)
    assert.match(p.agent.owner, /^0x[0-9a-fA-F]{40}$/)
    assert.ok(chain.contracts.identityRegistry, `${p.chain} records an agent but the descriptor has no identity registry`)
  }
})

test('every published chain admits what it cannot do', () => {
  // A chain with an empty caveat list is a chain someone forgot to be honest about.
  for (const p of PROVENANCE) {
    assert.ok(p.caveats.length > 0, `${p.chain} publishes no caveats`)
    for (const c of p.caveats) assert.ok(c.length > 20, `${p.chain} has a throwaway caveat: ${c}`)
  }
})

test('every rail is published, routable and covered by the site checks', () => {
  const slugs = PROOF_RAILS.map((r) => r.slug)
  assert.equal(new Set(slugs).size, slugs.length, 'duplicate rail slug')
  const sitemap = readFileSync(repoFile('public/sitemap.xml'), 'utf8')
  const smoke = readFileSync(repoFile('scripts/smoke.mjs'), 'utf8')
  for (const rail of PROOF_RAILS) {
    assert.match(rail.slug, /^[a-z0-9-]+$/, 'a rail slug is part of a public URL')
    for (const c of rail.chains) assert.ok(provenanceFor(c), `rail ${rail.slug} names ${c}, which has no provenance entry`)
    assert.ok(
      sitemap.includes(`/proof/${rail.slug}<`),
      `/proof/${rail.slug} is missing from public/sitemap.xml. Run: npm run sitemap`,
    )
    assert.ok(
      smoke.includes(`/proof/${rail.slug}`),
      `/proof/${rail.slug} is missing from scripts/smoke.mjs, so nothing would notice if the page broke`,
    )
  }
  assert.deepEqual(proofRailIndex().map((r) => r.slug), slugs)
})

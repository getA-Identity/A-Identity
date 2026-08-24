import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROVENANCE, PROOF_RAILS, artifactUrl, contractUrl, provenanceFor } from './provenance.js'
import { CHAINS, getChainById } from './registry.js'
import { OWNER_ADDRESS_RE, SETTLEMENT_ADDRESS_RE, SHAPE_NAME, TX_HASH_RE } from './stellar/strkey.js'
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
      // Resolve the chain FIRST: hash shape follows the chain a transaction actually
      // landed on, which is the whole reason ChainArtifact carries `onChain` separately
      // from the entry's own chain. A Stellar hash is the same 32 bytes an EVM hash
      // carries, rendered WITHOUT the 0x prefix, and neither branch accepts the other's
      // rendering.
      const on = getChainById(a.onChain)
      assert.ok(on, `${p.chain}: ${a.label} lands on unknown chain ${a.onChain}`)
      assert.match(
        a.txHash,
        TX_HASH_RE[on.ecosystem],
        `${p.chain}: ${a.label} is not a ${SHAPE_NAME[on.ecosystem].tx}`,
      )
      assert.ok(on.explorer, `${a.onChain} has no explorer, so this artifact could not be linked`)
      assert.ok(artifactUrl(a)?.includes(a.txHash))
    }
    const chain = getChainById(p.chain)!
    for (const c of p.contracts) {
      assert.match(
        c.address,
        SETTLEMENT_ADDRESS_RE[chain.ecosystem],
        `${p.chain}: ${c.name} is not a ${SHAPE_NAME[chain.ecosystem].address}`,
      )
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
    // Widened in the same pass as the two above rather than later. It cannot fire today,
    // because ERC-8004 is EVM-only and no Stellar entry records an agent, but leaving one
    // hardcoded 0x here would be a landmine for whoever deploys a Soroban registry.
    assert.match(p.agent.owner, OWNER_ADDRESS_RE[chain.ecosystem])
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

/**
 * Every Stellar hash we publish must be one the deploy record already vouches for.
 *
 * This exists because a hash in this file was WRONG when it shipped to a live page: it was
 * transcribed rather than copied, and it 404'd on Stellar Expert while every existing test
 * passed, because they check shape and containment, not existence. Nothing offline can ask
 * the ledger whether a transaction is real. What it CAN do is refuse to let provenance and
 * the release record disagree, which is the failure that actually happened.
 */
/**
 * Both Stellar release records, not just testnet's. The pubnet deploy on 2026-08-24 wrote
 * its own receipt, and a receipt nothing compares against is a file that rots quietly.
 *
 * Written as two explicit `test()` declarations rather than a loop, because this repo
 * counts `test()` declarations statically (doc-counts.test.ts, and the literal in
 * asp/proof.ts). A loop runs two tests from one declaration and puts the static count one
 * behind the real one forever.
 */
function assertReleaseMatchesProvenance(file: string, chain: string) {
  const release = JSON.parse(readFileSync(repoFile(file), 'utf8')) as {
    contractId: string
    artifacts: { txHash: string; ledger: number; label: string }[]
  }
  const entry = PROVENANCE.find((p) => p.chain === chain)
  assert.ok(entry, `${chain} must have a provenance entry`)

  const recorded = new Map(release.artifacts.map((a) => [a.txHash, a.ledger]))
  const published = entry.artifacts.filter((a) => recorded.has(a.txHash))
  // Every artifact the release cut is published. A release hash that quietly stopped being
  // shown is evidence we chose not to display, which is the other direction of the same rot.
  assert.equal(
    published.length,
    release.artifacts.length,
    `${file} records ${release.artifacts.length} artifacts and provenance publishes ${published.length} of them`,
  )
  for (const a of published) {
    assert.equal(a.blockNumber, recorded.get(a.txHash), `${a.label}: ledger disagrees with ${file}`)
  }
  // And the contract the page points at is the contract that was deployed.
  assert.ok(
    entry.contracts.some((c) => c.address === release.contractId),
    `the ${chain} provenance entry does not name the contract ${file} deployed`,
  )
}

test('every deploy-era Stellar artifact matches the release record byte for byte', () => {
  assertReleaseMatchesProvenance('soroban/releases/testnet-v0.1.0.json', 'stellar-testnet')
})

test('the pubnet release record and the pubnet provenance entry agree', () => {
  assertReleaseMatchesProvenance('soroban/releases/pubnet-v0.1.0.json', 'stellar')
})

/** A caveat that stopped being true is worse than one that was never written. */
test('the Stellar release record does not still say the x402 rail is unbuilt', () => {
  const release = JSON.parse(
    readFileSync(repoFile('soroban/releases/testnet-v0.1.0.json'), 'utf8'),
  ) as { caveats: string[] }
  const stale = release.caveats.find((c) => /^No x402 rail settles on Stellar yet/.test(c))
  assert.equal(stale, undefined, 'that caveat was superseded on 2026-08-15; it must read as history, not as current')
})

/**
 * A caveat may not call a chain `planned` when the registry says it is live or beta.
 *
 * This exists because it happened. The stellar-testnet caveat opened with "the pubnet
 * descriptor is still planned: nothing of value has moved on Stellar mainnet", which was
 * true when written and became false the moment the vault was deployed to pubnet. Worse,
 * both statements then rendered on the SAME /proof/stellar page: a mainnet section listing
 * real settlements, and underneath it a box saying nothing had moved on mainnet.
 *
 * `every published chain admits what it cannot do` only checks that caveats EXIST. Nothing
 * checked whether one had quietly become a lie, which is the direction that costs trust:
 * a missing caveat looks careless, a false one looks like a cover-up.
 */
test('no caveat calls a chain planned that the registry has already promoted', () => {
  // Match the CLAIM SHAPE, then ask what it is about. An earlier version tried to capture
  // the subject with an alternation and, under the `i` flag, the generic branch swallowed
  // "and the pubnet" as the subject and the lookup silently missed. Reading the matched
  // clause is both simpler and harder to get wrong.
  const CLAIM = /[^.]*\b(?:is|stays|remains)\s+(?:still\s+)?`?planned`?/gi
  const promoted = CHAINS.filter((c) => c.status === 'live' || c.status === 'beta')
  const stellarMainnetPromoted = promoted.some((c) => c.ecosystem === 'stellar' && !c.testnet)

  for (const entry of PROVENANCE) {
    for (const caveat of entry.caveats) {
      for (const m of caveat.matchAll(CLAIM)) {
        const clause = m[0]
        // "pubnet" and "mainnet" inside a Stellar caveat name the `stellar` descriptor.
        const aboutStellarMainnet =
          /\b(pubnet|mainnet)\b/i.test(clause) &&
          (entry.chain.startsWith('stellar') || /stellar/i.test(caveat))
        const named = promoted.find(
          (c) => clause.toLowerCase().includes(c.name.toLowerCase()) || clause.includes(c.id),
        )
        assert.ok(
          !(aboutStellarMainnet && stellarMainnetPromoted) && !named,
          `${entry.chain} publishes a caveat asserting "${clause.trim()}", but the registry has ` +
            `already promoted that network. A caveat that stopped being true is worse than one ` +
            `never written: this exact sentence once rendered on /proof/stellar directly beneath ` +
            `a mainnet section listing real settlements.\n  ${caveat}`,
        )
      }
    }
  }
})

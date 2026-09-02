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
      // An artifact on a chain the registry does not model names it in words and gets no
      // link. Exactly one of the two must be set: without this a typo in `onChain` would
      // silently become "external chain", and an artifact with neither would render as
      // having landed on the entry's own chain, which is the mislabelling this replaced.
      assert.notEqual(
        Boolean(a.onChain), Boolean(a.externalChain),
        `${p.chain}: ${a.label} must set exactly one of onChain / externalChain`,
      )
      if (a.externalChain) {
        assert.ok(a.note, `${p.chain}: ${a.label} is on ${a.externalChain}, which the registry does not model, so it must say where to look`)
        assert.equal(artifactUrl(a), null, `${p.chain}: ${a.label} is off-registry, so no link may be derived for it`)
        continue
      }
      const on = getChainById(a.onChain!)
      assert.ok(on, `${p.chain}: ${a.label} lands on unknown chain ${a.onChain}`)
      // An artifact that ADMITS IN PROSE it was sent somewhere else must say so in the
      // field, because the field is what renders and what derives the link. This is the
      // exact shape of the bug that added externalChain: a Sepolia hash carried
      // `onChain: 'arbitrum'` and a note explaining it was really Sepolia, so the page
      // printed the wrong chain and offered a link no explorer could resolve. The note was
      // honest and the field was not, and nothing made them agree.
      const claimed = a.note?.match(/\bSent on ([A-Z][A-Za-z0-9 ]+?)(?:,|\.|$)/)?.[1]
      if (claimed) {
        assert.equal(
          claimed.toLowerCase(), on.name.toLowerCase(),
          `${p.chain}: ${a.label} says it was sent on ${claimed} but names ${on.name}. ` +
            'If the registry does not model that chain, use externalChain and take the link away.',
        )
      }
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
 * The /proof index is the ONE link the footer carries, so a live chain that no rail
 * covers has to be a decision rather than an oversight. The page renders the uncovered
 * set as its own row; this test is what stops that row from growing silently.
 *
 * The allowlist is named with reasons, not counted. Adding a chain to it should feel
 * like admitting something, because it is.
 */
test('every live chain is covered by a proof rail, or named here with a reason', () => {
  const covered = new Set(PROOF_RAILS.flatMap((r) => r.chains))
  const excused: Record<string, string> = {
    xlayer:
      'The OKX submission settles here and its evidence is served by the ASP deployment at ' +
      '/proof on the ASP host, which the index links out to. No provenance entry exists in ' +
      'this repo, so a rail here would have nothing of its own to show.',
  }
  const uncovered = CHAINS.filter((c) => c.status === 'live' && !covered.has(c.id)).map((c) => c.id)
  for (const id of uncovered) {
    assert.ok(
      excused[id],
      `${id} is live but no rail covers it and no reason is recorded. Add a rail to PROOF_RAILS ` +
        'or name the chain in this test with why it has none.',
    )
  }
  for (const id of Object.keys(excused)) {
    assert.ok(!covered.has(id), `${id} now has a rail, so its excuse in this test is stale`)
  }
})

test('the rail index counts what the ledger actually holds', () => {
  for (const entry of proofRailIndex()) {
    assert.ok(entry.lede.length > 40, `rail ${entry.slug} ships a throwaway lede to the index`)
    assert.ok(entry.networks.length > 0, `rail ${entry.slug} renders as an empty card`)
    for (const net of entry.networks) {
      const p = provenanceFor(net.chain)
      assert.ok(p, `rail ${entry.slug} indexes ${net.chain} with no provenance`)
      assert.equal(net.artifacts, p.artifacts.length, `${net.chain}: artifact count drifted`)
      assert.equal(net.contracts, p.contracts.length, `${net.chain}: contract count drifted`)
      assert.equal(net.caveats, p.caveats.length, `${net.chain}: caveat count drifted`)
      assert.equal(net.agentTokenId, p.agent?.tokenId ?? null, `${net.chain}: agent id drifted`)
    }
    const sum = (k: 'artifacts' | 'contracts' | 'caveats') =>
      entry.networks.reduce((n, x) => n + x[k], 0)
    assert.equal(entry.totals.artifacts, sum('artifacts'))
    assert.equal(entry.totals.contracts, sum('contracts'))
    assert.equal(entry.totals.caveats, sum('caveats'))
    assert.equal(entry.mainnet, entry.networks.some((n) => !n.testnet))
  }
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

/**
 * Every Stellar release record, paired with the provenance entry it must not contradict.
 *
 * Both, not just testnet's. The two guards below read this list rather than a filename,
 * because the previous version of the first one hardcoded testnet's path and the pubnet
 * record was therefore never opened by anything.
 */
const STELLAR_RELEASES = [
  { file: 'soroban/releases/testnet-v0.1.0.json', chain: 'stellar-testnet' },
  { file: 'soroban/releases/pubnet-v0.1.0.json', chain: 'stellar' },
] as const

const releaseCaveats = (file: string) =>
  (JSON.parse(readFileSync(repoFile(file), 'utf8')) as { caveats: string[] }).caveats

/**
 * A caveat that stopped being true is worse than one that was never written.
 *
 * The cheap net, and the reason it is worth keeping next to the ledger-driven one below:
 * a release record may not deny the x402 rail in the PRESENT tense, on either network.
 * The subject is not matched at all, because matching it is what failed before. The old
 * pattern was anchored `^No x402 rail settles on Stellar yet`, so the pubnet record's
 * "No x402 rail settles on pubnet yet" would have slipped through on the word `pubnet`
 * even if this test had been reading that file, which it was not. The verb is the tell:
 * `settles` is a claim about now, `settled` inside a dated sentence is history.
 */
test('no Stellar release record denies the x402 rail in the present tense', () => {
  for (const { file } of STELLAR_RELEASES) {
    const stale = releaseCaveats(file).find((c) =>
      /\bno x402 rail\s+(?:settles|sells|runs|exists)\b/i.test(c),
    )
    assert.equal(
      stale,
      undefined,
      `${file} denies the x402 rail as if that were still current. Say WHEN it stopped ` +
        `being true instead: a release record is what was true when it was cut.\n  ${stale}`,
    )
  }
})

/**
 * The same rot, caught by contradiction rather than by vocabulary.
 *
 * Hunting a sentence only ever catches the sentence somebody already noticed. This asks
 * the ledger: if the provenance entry for this network publishes an x402 SETTLEMENT, then
 * a caveat on that network's release record may not say the rail is absent unless it also
 * says when that stopped being true. A rephrasing this file has never seen still fails,
 * as long as it denies a rail the ledger has a receipt for.
 *
 * History is allowed and is the point. The testnet record has denied the rail since
 * 2026-08-15 and passes, because it dates the denial and names what superseded it.
 */
test('a Stellar release caveat may not deny an x402 rail the ledger has settled', () => {
  for (const { file, chain } of STELLAR_RELEASES) {
    const entry = PROVENANCE.find((p) => p.chain === chain)
    assert.ok(entry, `${chain} must have a provenance entry`)
    const settled = entry.artifacts.filter(
      (a) => a.kind === 'settlement' && /x402/i.test(`${a.label} ${a.note ?? ''}`),
    )
    if (settled.length === 0) continue
    for (const caveat of releaseCaveats(file)) {
      // The claim shape: the rail is denied. Tense-agnostic on purpose, because the
      // question this test asks is not how it is phrased but whether it is bounded.
      if (!/\bno x402 rail\b|\bx402 rail (?:is|was) (?:not|un)/i.test(caveat)) continue
      const dated = /\b20\d{2}-\d{2}-\d{2}\b/.test(caveat)
      const bounded = /\b(superseded|at the time of|no longer|until then|since)\b/i.test(caveat)
      assert.ok(
        dated && bounded,
        `${file} carries a caveat denying the x402 rail, but the ${chain} provenance entry ` +
          `publishes ${settled.length} x402 settlement(s), the first of them ` +
          `"${settled[0].label}" (${settled[0].txHash}). Two sources in one repo cannot ` +
          `disagree about whether a rail sells. Denying it is fine as HISTORY: date it and ` +
          `name what superseded it.\n  ${caveat}`,
      )
    }
  }
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

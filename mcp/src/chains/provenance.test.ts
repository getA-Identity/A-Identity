import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROVENANCE, PROOF_RAILS, STELLAR_SOW2, artifactUrl, contractUrl, provenanceFor } from './provenance.js'
import { CHAINS, getChainById } from './registry.js'
import { OWNER_ADDRESS_RE, SETTLEMENT_ADDRESS_RE, SHAPE_NAME, TX_HASH_RE, isAccountId, isContractId } from './stellar/strkey.js'
import { howToVerify, proofRailIndex, sow2Report } from './proof.js'
import { networkPassphrase } from './stellar/client.js'

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

/**
 * SOW 2 asks for a dated evidence section, so a date is part of the claim. A SOW 2 artifact
 * without one cannot be placed in the sprint, and a Stellar artifact without a deliverable
 * cannot be told apart from the rehearsal that preceded it.
 */
const isUtcDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s)
const stellarEntries = () => PROVENANCE.filter((p) => getChainById(p.chain)?.ecosystem === 'stellar')

test('every Stellar artifact is dated and assigned, and every SOW 2 one above all', () => {
  for (const p of PROVENANCE) {
    for (const a of p.artifacts) {
      if (a.date !== undefined) assert.ok(isUtcDay(a.date), `${p.chain}: ${a.label} carries a date that is not a UTC day: ${a.date}`)
      if (a.deliverable?.startsWith('SOW2')) {
        assert.ok(a.date, `${p.chain}: ${a.label} is evidence for ${a.deliverable} and has no date`)
        assert.ok(a.date >= STELLAR_SOW2.sprintStart, `${p.chain}: ${a.label} is dated before the SOW 2 sprint started`)
      }
    }
  }
  for (const p of stellarEntries()) {
    for (const a of p.artifacts) {
      assert.ok(a.date, `${p.chain}: ${a.label} has no date. Read the ledger close time from Horizon, never a commit date.`)
      assert.ok(a.deliverable, `${p.chain}: ${a.label} names no deliverable`)
    }
  }
})

test('the testnet deploy is published as the two transactions it was', () => {
  // The ledger once said "upload and instantiate in one transaction" and listed only the
  // create. Horizon shows an UploadContractWasm one ledger earlier, from the same account.
  const t = provenanceFor('stellar-testnet')!
  const upload = t.artifacts.find((a) => a.txHash.startsWith('242c4ec6'))
  const create = t.artifacts.find((a) => a.txHash.startsWith('718f050b'))
  assert.ok(upload && create, 'both deploy transactions must be published')
  assert.equal(upload.blockNumber, 4147601)
  assert.equal(create.blockNumber, 4147602)
  assert.ok(!/in one transaction/i.test(create.note ?? ''), 'the create note still claims a one-transaction deploy')
})

test('published accounts are valid StrKeys on their own chain, never listed twice', () => {
  let total = 0
  for (const p of PROVENANCE) {
    const seen = new Set<string>()
    for (const acc of p.accounts ?? []) {
      total += 1
      assert.equal(acc.network, p.chain, `${acc.address} is published under ${p.chain} but names ${acc.network}`)
      assert.ok(isAccountId(acc.address) || isContractId(acc.address), `${p.chain}: ${acc.role} is not a valid Stellar StrKey: ${acc.address}`)
      assert.ok(!seen.has(acc.address), `${p.chain}: ${acc.address} is published twice`)
      seen.add(acc.address)
      assert.ok(isUtcDay(acc.publishedAt), `${p.chain}: ${acc.role} has no real publishedAt`)
      assert.ok(acc.role.length > 5 && acc.usedFor.length > 20, `${p.chain}: ${acc.address} needs a role and what it is used for`)
      // An owner label is a statement that the key is NOT ours. Nothing we hold may wear one.
      if (acc.custody.startsWith('owner:')) {
        assert.ok(!/\bours?\b/i.test(acc.role), `${acc.address} is labeled as an outside owner but its role says it is ours`)
      }
    }
  }
  assert.ok(total >= 6, 'the Stellar entries publish the backend and owner accounts the proof page lists')
  // Every account the pubnet stellar.toml publishes is also on the proof page, and the
  // reverse, so the two public lists of our pubnet keys cannot drift apart.
  const toml = readFileSync(repoFile('public/.well-known/stellar.toml'), 'utf8')
  const tomlAccounts = [...(toml.match(/ACCOUNTS=\[([^\]]*)\]/)?.[1] ?? '').matchAll(/"(G[A-Z2-7]{55})"/g)].map((m) => m[1])
  const pubnet = (provenanceFor('stellar')?.accounts ?? []).map((a) => a.address)
  assert.deepEqual([...pubnet].sort(), [...tomlAccounts].sort(), 'stellar.toml and the pubnet accounts list disagree')
})

test('the SOW 2 section resolves every hash and passes no rehearsal off as a deliverable', () => {
  assert.ok(isUtcDay(STELLAR_SOW2.sprintStart))
  assert.deepEqual(STELLAR_SOW2.deliverables.map((d) => d.id), ['D1', 'D2', 'D3'])
  assert.ok(STELLAR_SOW2.caveats.length > 0 && STELLAR_SOW2.caveats.every((c) => c.length > 20))
  assert.match(STELLAR_SOW2.trustModel, /require_auth/)
  const byHash = new Map(stellarEntries().flatMap((p) => p.artifacts.map((a) => [a.txHash, a] as const)))
  for (const d of STELLAR_SOW2.deliverables) {
    assert.ok(d.caption.length > 40, `${d.id} needs a caption that says what will appear`)
    // A site path, optionally with a plain query such as ?network=testnet, never a host.
    for (const l of d.links) assert.match(l.url, /^\/[a-z0-9/-]*(\?[A-Za-z0-9=:&-]+)?$/, `${d.id}: ${l.url} is not a path on this site`)
    if (d.status === 'live') {
      assert.ok(d.date && isUtcDay(d.date), `${d.id} is live with no date`)
      assert.ok(d.artifacts.length > 0 || d.id === 'D1', `${d.id} is live but names no artifact`)
    } else {
      assert.equal(d.date, null, `${d.id} is ${d.status} but carries a date`)
    }
    for (const h of d.artifacts) {
      const a = byHash.get(h)
      assert.ok(a, `${d.id} names ${h}, which no Stellar entry publishes`)
      assert.equal(a.deliverable, `SOW2-${d.id}`, `${d.id} names ${a.label}, which is evidence for ${a.deliverable}`)
      assert.ok(a.date)
    }
  }
  // The 2026-09-19 runs were signed by a software key in our own script. They stay labeled
  // as a rehearsal in the field AND in the label, because the label is what a reader sees.
  // Picked by the runs' own release record rather than by date: the flagship vault's owner
  // also withdrew to our operator that day, which is ours but no part of the runs.
  const runRecord = readFileSync(repoFile('soroban/releases/testnet-passkey-owner-2026-09-19.json'), 'utf8')
  const rehearsal = provenanceFor('stellar-testnet')!.artifacts.filter((a) => runRecord.includes(a.txHash))
  assert.ok(rehearsal.length >= 13)
  for (const a of rehearsal) {
    assert.equal(a.deliverable, 'rehearsal', `${a.label} is from the 2026-09-19 software-key run`)
    assert.match(a.label, /^Rehearsal/, `${a.label} must say it is a rehearsal where a reader sees it`)
    assert.ok(!/the visitor's/i.test(a.note ?? ''), `${a.label} calls our own run the visitor's`)
  }
  // Every later rehearsal too (the 2026-10-03 run on our v0.7.2 build was the next one): the
  // field alone is not what a reader sees, so a rehearsal row says so in its label.
  for (const p of stellarEntries()) {
    for (const a of p.artifacts.filter((x) => x.deliverable === 'rehearsal')) {
      assert.match(a.label, /^Rehearsal/, `${a.label} is a rehearsal and must say so where a reader sees it`)
    }
  }
  const report = sow2Report()
  for (const d of report.deliverables) assert.equal(d.artifactsLinked.length, d.artifacts.length)
})

/**
 * "How to check this yourself" is the one part of a proof page that tells a reviewer what to
 * DO, so a wrong line there costs more than a wrong caption: they run it, it fails, and the
 * failure reads as our evidence being fake. Every rail was served the EVM lines unless it was
 * Stellar, so Algorand was told to compare ERC-8004 registries and read EVM Transfer logs it
 * does not have, and Celo was sent to the log of a facilitator that never sees its payments.
 */
test('every rail tells a reviewer to check only what exists on its own chains', async () => {
  for (const rail of PROOF_RAILS) {
    const chains = rail.chains.map((id) => getChainById(id)!)
    const lines = await howToVerify(rail.chains)
    const text = lines.join('\n')
    assert.ok(lines.length >= 3, `rail ${rail.slug} tells a reviewer almost nothing`)
    for (const l of lines) assert.ok(l.length > 40, `rail ${rail.slug} has a throwaway line: ${l}`)

    const mainnets = chains.filter((c) => !c.testnet)
    const ownFacilitator = mainnets.some((c) => (c.settlementTokens ?? []).some((t) => t.authorization === 'eip3009'))
    assert.equal(
      text.includes('/api/facilitator/proof'), ownFacilitator,
      `rail ${rail.slug} ${ownFacilitator ? 'omits' : 'points at'} the EIP-3009 facilitator log, which ${ownFacilitator ? 'settles' : 'never settles'} its payments`,
    )
    const gateway = mainnets.some((c) => c.gateway)
    assert.equal(text.includes('/api/x402/gateway/proof'), gateway, `rail ${rail.slug}: Gateway line disagrees with the descriptor`)

    if (chains.every((c) => c.ecosystem !== 'evm')) {
      // None of these exist off EVM, and each was once served on a non-EVM rail.
      for (const evmOnly of ['ERC-8004 deployment', 'ownerOf', 'Transfer log', 'block named']) {
        assert.ok(!text.includes(evmOnly), `rail ${rail.slug} tells a reviewer to check "${evmOnly}", which its chains do not have`)
      }
    }
    if (chains.some((c) => c.ecosystem === 'stellar')) assert.match(text, /GET \/api\/x402\/stellar\/proof/)
    if (chains.some((c) => c.ecosystem === 'algorand')) {
      assert.match(text, /GET \/api\/x402\/algorand\/proof/)
      for (const c of chains.filter((x) => x.ecosystem === 'algorand')) {
        for (const t of (c.settlementTokens ?? []).filter((x) => x.authorization === 'algorand-group')) {
          assert.ok(text.includes(`ASA ${t.address}`), `rail ${rail.slug} does not name the ASA it reads, ${t.address}`)
        }
      }
    }
    // A mainnet whose x402 payments someone else's facilitator settles must say the evidence
    // standard is theirs, and must not borrow ours.
    for (const c of mainnets.filter((x) => x.payment.x402 && !(x.settlementTokens ?? []).some((t) => t.authorization !== 'none'))) {
      const line = lines.find((l) => l.startsWith(`On ${c.name} the payment rail is not ours`))
      assert.ok(line, `rail ${rail.slug}: ${c.name} settles through a facilitator we do not run, and nothing says so`)
      assert.match(line, /do not read the transfer back ourselves/)
    }
  }
  // Pinned for the rail whose bug this was, so a refactor cannot drop the Celo pointer.
  assert.match((await howToVerify(['celo'])).join('\n'), /GET \/api\/celo\/proof/)
})

test('the registry line is derived from the registry and admits that mainnet and testnet differ', async () => {
  for (const rail of PROOF_RAILS) {
    const chains = rail.chains.map((id) => getChainById(id)!)
    const withRegistry = chains.filter((c) => c.contracts.identityRegistry)
    const line = (await howToVerify(rail.chains)).find((l) => l.startsWith('The identity registry is'))
    if (withRegistry.length === 0) {
      assert.equal(line, undefined, `rail ${rail.slug} describes an identity registry its chains do not carry`)
      continue
    }
    assert.ok(line, `rail ${rail.slug} carries a registry and does not say where`)
    // Every address the line prints is one the registry holds, and every chain sharing a
    // rail network's address is named, which is the whole check a reviewer is invited to do.
    for (const addr of line.match(/0x[0-9a-fA-F]{40}/g) ?? []) {
      assert.ok(
        CHAINS.some((c) => c.contracts.identityRegistry?.toLowerCase() === addr.toLowerCase()),
        `rail ${rail.slug} prints ${addr}, which is no chain's identity registry`,
      )
    }
    for (const c of withRegistry) {
      assert.ok(line.includes(c.contracts.identityRegistry!), `rail ${rail.slug} omits ${c.name}'s registry`)
      for (const twin of CHAINS.filter((o) => o.id !== c.id && o.contracts.identityRegistry?.toLowerCase() === c.contracts.identityRegistry!.toLowerCase())) {
        assert.ok(line.includes(twin.name), `rail ${rail.slug} says ${c.name}'s registry is shared but leaves out ${twin.name}`)
      }
    }
    const mixed = withRegistry.some((c) => c.testnet) && withRegistry.some((c) => !c.testnet)
    const differ = new Set(withRegistry.map((c) => c.contracts.identityRegistry!.toLowerCase())).size > 1
    assert.equal(line.includes('two different addresses'), mixed && differ, `rail ${rail.slug}: the mainnet/testnet sentence is wrong`)
    assert.ok(!/deliberately identical/.test(line), 'the old blanket claim is back')
  }
})

test('the Stellar fetch command runs on a stock CLI, and an Algorand contract links as an application', async () => {
  const text = (await howToVerify(['stellar', 'stellar-testnet'])).join('\n')
  // The CLI ships local, futurenet, testnet and mainnet; "pubnet" exists only where someone
  // added it, and the built-in mainnet entry has no RPC, so pubnet is named explicitly.
  assert.ok(!text.includes('--network pubnet'), 'the Stellar line names a network the stock CLI does not have')
  const pubnet = getChainById('stellar')!
  assert.ok(text.includes(`--rpc-url ${pubnet.rpcUrls[0]}`), 'the pubnet fetch names no RPC')
  assert.ok(text.includes(`--network-passphrase "${networkPassphrase(pubnet)}"`), 'the pubnet fetch carries the wrong passphrase')
  assert.ok(text.includes('--network testnet'))

  for (const p of PROVENANCE) {
    if (getChainById(p.chain)?.ecosystem !== 'algorand') continue
    for (const c of p.contracts) {
      if (!/^[0-9]+$/.test(c.address)) continue
      assert.match(
        contractUrl(p.chain, c.address) ?? '',
        new RegExp(`/application/${c.address}$`),
        `${p.chain}: ${c.name} is an application but links as something else`,
      )
    }
  }
})

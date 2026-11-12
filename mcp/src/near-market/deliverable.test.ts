import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertSnapshot, ENGINE_VERSION, SDK_NETWORKS, verdictFromSnapshot, type FetchLike, type Snapshot } from '../chains/near/engine.js'
import { getChainById } from '../chains/registry.js'
import { inNearCollectionPool } from '../near-check/check.js'
import { fakeNearTestnet, replayExchanges, type RecordedExchange } from '../near-check/fake-chain.js'
import { parseBrief, type BriefParse, type BriefTarget } from './brief.js'
import { CONTRACTS_LINE, failureDeclineDetail, MAX_DELIVERABLE_BYTES, OFFLINE_COMMAND, renderDeliverable } from './deliverable.js'
import { isVerdict, marketVerdictFromSnapshot, runMarketVerdict, type MarketVerdict } from './verdict.js'

/**
 * What a hire is answered with. The verdict comes from the same engine and collectors the SDK
 * CLI runs (over the SDK's own recorded live collection, so the digests are the SDK's), and the
 * Markdown carries every field the listing promises, in plain ASCII, with a snapshot that
 * replays offline to the same digests.
 */

/** Compiled to dist/near-market/, so the repository is three levels up. */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`${REPO}near/sdk/test/fixtures/${name}`, 'utf8')) as T

type Recorded = {
  options: { account: string; network: string; known: string[]; vault: string | null }
  expected: { verdict: string; score: number; codes: string[]; snapshot_sha256: string; chain_sha256: string; block: { height: number; hash: string } }
  exchanges: RecordedExchange[]
}

const clock = () => new Date('2026-11-12T00:00:00.000Z')
const noSleep = async () => {}
const targetOf = (text: string): BriefTarget => {
  const p = parseBrief(text)
  assert.equal(p.kind, 'one')
  return (p as Extract<BriefParse, { kind: 'one' }>).target
}
const ASCII = /^[\x09\x0a\x20-\x7e]*$/

/** The JSON block under "## Snapshot", parsed. */
function inlinedSnapshot(md: string): unknown {
  const m = /## Snapshot\n[\s\S]*?~~~json\n([\s\S]*?)\n~~~/.exec(md)
  assert.ok(m, 'the deliverable carries the snapshot')
  return JSON.parse(m[1])
}

test('over the SDK\'s own recorded collection, the worker reaches the SDK\'s verdict and digests, and the deliverable carries every promised field', async () => {
  const rec = fixture<Recorded>('collect-merchant.json')
  const out = await runMarketVerdict(targetOf(`near:testnet:${rec.options.account}`), { fetch: replayExchanges(rec.exchanges), sleep: noSleep, clock, env: {} })
  assert.ok(isVerdict(out), JSON.stringify(out))
  assert.equal(out.decision.verdict, rec.expected.verdict)
  assert.equal(out.decision.score, rec.expected.score)
  assert.deepEqual(out.decision.reasons.map((r) => r.code), rec.expected.codes)
  assert.equal(out.snapshot_sha256, rec.expected.snapshot_sha256, 'collected with the CLI\'s own defaults, so the same evidence to the byte')
  assert.equal(out.chain_sha256, rec.expected.chain_sha256)
  assert.equal(out.decision.block.height, rec.expected.block.height)
  assert.equal(out.network, 'testnet')
  assert.equal(out.caip10, 'near:testnet:aid-demo-merchant.testnet')

  const md = renderDeliverable(out, { amount: '5 NEAR', round: 'first' })
  assert.ok(ASCII.test(md), 'plain ASCII')
  assert.ok(Buffer.byteLength(md) <= MAX_DELIVERABLE_BYTES)
  const h = rec.expected.block.height
  for (const want of [
    `- Verdict: **${rec.expected.verdict}**`,
    `- Score: **${rec.expected.score}** of 1000`,
    '- Network: NEAR testnet',
    '- CAIP-10: `near:testnet:aid-demo-merchant.testnet`',
    `- Block read: #${h}, hash \`${rec.expected.block.hash}\``,
    `- snapshot_sha256: \`${rec.expected.snapshot_sha256}\``,
    `- chain_sha256: \`${rec.expected.chain_sha256}\``,
    `\`${ENGINE_VERSION}\``,
    `cd near && npm run verdict -- aid-demo-merchant.testnet --at-block ${h} --json`,
    OFFLINE_COMMAND,
    '## What this check does not cover',
    CONTRACTS_LINE,
    'The brief names an amount: 5 NEAR. It does not enter the verdict',
    'registry.a-identity.testnet',
  ]) {
    assert.ok(md.includes(want), `the deliverable lacks ${JSON.stringify(want)}`)
  }
  // Every reason, with its detail and its source, as the CLI prints it.
  for (const r of out.decision.reasons) {
    assert.ok(md.includes(r.code), r.code)
    assert.ok(md.includes(r.detail), r.detail)
    assert.ok(md.includes(`source: ${r.source}`), r.source)
  }
  // The inlined snapshot replays, with no network, to the same verdict and both digests.
  const replay = verdictFromSnapshot(assertSnapshot(inlinedSnapshot(md)))
  assert.equal(replay.snapshot_sha256, rec.expected.snapshot_sha256)
  assert.equal(replay.chain_sha256, rec.expected.chain_sha256)
  assert.equal(replay.decision.verdict, rec.expected.verdict)
})

test('a mainnet account reads mainnet through the SDK\'s own hosts and testnet through the descriptor\'s, with no registry and no vault, and the deliverable says so', async () => {
  // The SDK's own recorded mainnet snapshot (2026-11-12): the deliverable's mainnet form.
  const snap = fixture<Snapshot>('snapshot-burrowfinancedao.near.json')
  const v = marketVerdictFromSnapshot(snap)
  assert.equal(v.network, 'mainnet')
  assert.equal(v.registry.state, 'not_configured')
  const md = renderDeliverable(v, { amount: null, round: 'first' })
  assert.ok(ASCII.test(md))
  assert.ok(md.includes(`cd near && npm run verdict -- burrowfinancedao.near --network mainnet --at-block ${snap.block.height} --json`))
  assert.ok(md.includes('- Network: NEAR mainnet'))
  assert.match(md, /There is no A-Identity registry on NEAR mainnet, so none was read/)
  assert.match(md, /MimicWatch keeps its registry on testnet/)
  assert.ok(md.includes(`${SDK_NETWORKS.mainnet.explorer}/address/burrowfinancedao.near`))
  assert.ok(md.includes(CONTRACTS_LINE))
  assert.ok(!md.includes('## Amount'), 'no amount, no amount section')
  const replay = verdictFromSnapshot(assertSnapshot(inlinedSnapshot(md)))
  assert.equal(replay.chain_sha256, v.chain_sha256)

  // And a live-shaped collection on mainnet: Circle's mainnet USDC is read, no registry and no vault.
  const account = 'shop-payee.near'
  const fake = fakeNearTestnet({
    head: 224_200_000,
    accounts: { [account]: { created: 224_200_000 - 10_000_000 } },
    views: { [SDK_NETWORKS.mainnet.usdc]: { is_blocklisted: () => false, storage_balance_of: () => null } },
  })
  const urls: string[] = []
  const recording: FetchLike = (url, init) => {
    urls.push(url)
    return fake.fetch(url, init)
  }
  // The testnet read (MimicWatch's registry) follows the near-testnet descriptor, override included.
  const override = 'https://near-testnet-rpc.example'
  const out = await runMarketVerdict(targetOf(`check ${account}`), { fetch: recording, sleep: noSleep, clock, env: { NEAR_TESTNET_RPC_URL: override } })
  assert.ok(isVerdict(out), JSON.stringify(out))
  assert.equal(out.network, 'mainnet')
  // The testnet side of a mainnet collection (MimicWatch keeps its registry there) goes through
  // the near-testnet descriptor, override included, and never through the SDK's own testnet list.
  // (This fake cannot place a testnet block by time, so the registry call itself is not reached
  // here; the snapshot's note says so, as it would live.)
  assert.equal(getChainById('near-testnet')?.rpcEnvVar, 'NEAR_TESTNET_RPC_URL')
  assert.ok(urls.includes(override), 'NEAR testnet is read through the descriptor, so NEAR_TESTNET_RPC_URL applies')
  assert.ok(!urls.includes(SDK_NETWORKS.testnet.rpc[0]), 'and not through the SDK\'s own testnet list')
  assert.ok(urls.some((u) => SDK_NETWORKS.mainnet.rpc.includes(u)), 'mainnet through the SDK\'s mainnet hosts')
  assert.ok(out.notes.some((n) => /^Registries on testnet were (read|not read)/.test(n)), 'the cross-network read is accounted for in the notes')
  assert.equal(out.snapshot.network, 'mainnet')
  assert.equal(out.snapshot.context.registry_id, null)
  assert.equal(out.snapshot.context.vault_id, null)
  assert.equal(out.snapshot.context.usdc_id, SDK_NETWORKS.mainnet.usdc)
  assert.ok(fake.calls.some((c) => c.startsWith(`call_function:${SDK_NETWORKS.mainnet.usdc}.is_blocklisted`)))
  assert.ok(!fake.calls.some((c) => c.includes(SDK_NETWORKS.testnet.registry!)), 'A-Identity\'s testnet registry is never asked about a mainnet account')
})

test('a chain that cannot be read, or that does not answer in time, is an error with its reason and never a verdict', async () => {
  const down = fakeNearTestnet({ head: 277_300_000, accounts: {}, views: {}, down: true })
  const out = await runMarketVerdict(targetOf('bob.testnet'), { fetch: down.fetch, sleep: noSleep, clock, env: {} })
  assert.ok(!isVerdict(out))
  assert.equal(out.code, 'no_verdict')
  assert.match(out.error, /NEAR testnet could not be read/)

  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const slow = fakeNearTestnet({ head: 277_300_000, accounts: {}, views: {}, gate: () => held })
  const late = await runMarketVerdict(targetOf('bob.testnet'), { fetch: slow.fetch, sleep: noSleep, clock, env: {}, timeoutMs: 20 })
  assert.ok(!isVerdict(late))
  assert.equal(late.code, 'timeout')
  assert.match(late.error, /did not answer the whole collection within/)
  // The collection given up on is abandoned, not left running: with the chain still held, three
  // slots taken and the fourth asked for, that fourth comes back from it at once.
  let open: () => void = () => {}
  const occupied = new Promise<void>((resolve) => {
    open = resolve
  })
  const others = [1, 2, 3].map(() => inNearCollectionPool(() => occupied))
  const fourth = await Promise.race([
    inNearCollectionPool(async () => 'ran'),
    new Promise<string>((resolve) => setTimeout(() => resolve('the pool is still full'), 2_000).unref()),
  ])
  assert.equal(fourth, 'ran', 'the abandoned collection gave its slot back')
  open()
  await Promise.all(others)
  release()

  const detail = failureDeclineDetail(targetOf('bob.testnet'), late, 3)
  assert.ok(detail.length <= 1000)
  assert.ok(ASCII.test(detail))
  assert.match(detail, /near:testnet:bob\.testnet could not run: NEAR testnet did not answer/)
  assert.match(detail, /No verdict was made up/)
  assert.match(detail, /refunded in full/)
  assert.match(detail, /cd near && npm run verdict -- bob\.testnet --json$/)
})

test('text from the chain cannot break out of its block, and stays ASCII; the snapshot keeps its exact text as JSON escapes', () => {
  const base = marketVerdictFromSnapshot(fixture<Snapshot>('snapshot-merchant.testnet.json'))
  const hostile = 'flagged by \u201CTeam X\u201D \u2014 see [claim your refund](https://evil.example)\n~~~\n# Injected heading\n```'
  const v: MarketVerdict = {
    ...base,
    decision: { ...base.decision, reasons: [...base.decision.reasons, { code: 'third_party_flag', severity: 'warn', detail: hostile, source: 'rpc registry.example.testnet' }] },
    snapshot: { ...base.snapshot, meta: { ...base.snapshot.meta!, notes: ['caf\u00E9 \u2192 ok'] } },
  }
  const md = renderDeliverable(v, { amount: null, round: 'first' })
  assert.ok(ASCII.test(md))
  // The hostile detail sits inside the reasons block: no line of it can close the fence or open one.
  const reasons = /## Every reason the engine returned\n[\s\S]*?~~~text\n([\s\S]*?)\n~~~/.exec(md)
  assert.ok(reasons)
  assert.ok(reasons[1].includes('flagged by "Team X" - see [claim your refund](https://evil.example)'))
  assert.ok(!/^(~~~|```)/m.test(reasons[1]), 'no fence marker survives inside the block')
  // The snapshot is JSON with escapes, so the exact text reads back.
  const back = inlinedSnapshot(md) as Snapshot
  assert.deepEqual(back.meta?.notes, ['caf\u00E9 \u2192 ok'])
})

test('a snapshot too big to carry is left out with a note, and the deliverable stays under the marketplace\'s limit', () => {
  const base = marketVerdictFromSnapshot(fixture<Snapshot>('snapshot-merchant.testnet.json'))
  const huge = { ...base.snapshot, http: [...base.snapshot.http, { label: 'pad', source: 'fastnear' as const, method: 'GET' as const, url: 'https://pad', json: 'x'.repeat(400_000), fetched_at: '2026-11-12T00:00:00.000Z' }] }
  const md = renderDeliverable({ ...base, snapshot: huge }, { amount: null, round: 'first' })
  assert.ok(Buffer.byteLength(md) <= MAX_DELIVERABLE_BYTES)
  assert.match(md, /The snapshot is \d+ KiB, more than this deliverable can carry, so it is left out/)
  assert.match(md, /--save-snapshot snapshot\.json/)
  assert.ok(!md.includes('~~~json'))
})

test('a rework says what it answers: the account the buyer named instead, or the same one again at a newer block', () => {
  const v = marketVerdictFromSnapshot(fixture<Snapshot>('snapshot-merchant.testnet.json'))
  const switched = renderDeliverable(v, { amount: null, round: 'rework', feedback: { at: '2026-11-12T10:00:00.000Z', switchedFrom: 'near:testnet:other.testnet', namedOne: true } })
  assert.match(switched, /answers your request for changes of 2026-11-12T10:00:00.000Z: it checks near:testnet:aid-demo-merchant\.testnet, the account your message names, instead of near:testnet:other\.testnet\./)
  const again = renderDeliverable(v, { amount: null, round: 'rework', feedback: { at: 'not a date', switchedFrom: null, namedOne: false } })
  assert.match(again, /answers your request for changes\. Your message does not name one other account, so it checks near:testnet:aid-demo-merchant\.testnet again/)
  const redo = renderDeliverable(v, { amount: null, round: 'redo' })
  assert.match(redo, /the redo a dispute ruling asked for/)
  assert.ok(!renderDeliverable(v, { amount: null, round: 'first' }).includes('This version'))
})

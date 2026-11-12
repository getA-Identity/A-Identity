import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getChainById } from '../chains/registry.js'
import { addressUrl } from '../chains/explorer.js'
import { ENGINE_VERSION, SDK_NETWORKS } from '../chains/near/engine.js'
import { __resetNearCheckForTests, isNearAnswer, nearCheck, NEAR_CHECK_LABELS, NEAR_CHECK_TTL_MS, type NearCheckDeps, type NearCheckResult } from './check.js'
import { fakeBlockTs, fakeNearTestnet, replayExchanges, type FakeNearTestnet, type RecordedExchange } from './fake-chain.js'

/**
 * nearCheck, with the network stubbed. The first test is the one the feature stands on: over
 * the SDK's own recorded collection (a live read-only run on 2026-11-12, committed as an SDK
 * fixture), the backend reaches the SDK's own expected verdict, score, reasons and both digests.
 * The rest run against a fake NEAR testnet that answers whatever host it is sent to.
 */

/** Compiled to dist/near-check/, so the repository is three levels up. */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`${REPO}near/sdk/test/fixtures/${name}`, 'utf8')) as T

type Recorded = {
  options: { account: string; network: string; known: string[]; vault: string | null }
  expected: { verdict: string; score: number; codes: string[]; snapshot_sha256: string; chain_sha256: string; block: { height: number; hash: string } }
  exchanges: RecordedExchange[]
}

const chain = getChainById('near-testnet')!
const USDC = chain.documentedTokens!.find((t) => t.symbol === 'USDC')!.address
const REGISTRY = SDK_NETWORKS.testnet.registry!
const VAULT = 'vault.aid-demo-owner.testnet'
const HEAD = 277_300_000
const clock = () => new Date('2026-11-12T00:00:00.000Z')
const noSleep = async () => {}
/** No process environment: an operator's NEAR_TESTNET_RPC_URL must not reach a test. */
const base: NearCheckDeps = { clock, sleep: noSleep, env: {} }

const usdcViews = (registered: boolean) => ({ is_blocklisted: () => false, storage_balance_of: () => (registered ? { total: '1250000000000000000000', available: '0' } : null) })

function answerOf(r: NearCheckResult) {
  assert.ok(isNearAnswer(r), `expected a verdict, got ${JSON.stringify(r)}`)
  return r
}

const finalReads = (calls: string[]) => calls.filter((c) => c === 'block:final').length

test('over the SDK\'s own recorded collection the backend reaches the SDK\'s own verdict, score, reasons and digests', async () => {
  __resetNearCheckForTests()
  const rec = fixture<Recorded>('collect-merchant.json')
  // Collected with exactly the defaults nearCheck uses, so the two must agree to the byte.
  assert.deepEqual(rec.options, { account: 'aid-demo-merchant.testnet', network: 'testnet', known: [], vault: null })
  const calls: string[] = []
  const out = answerOf(await nearCheck(rec.options.account, {}, { ...base, fetch: replayExchanges(rec.exchanges, calls) }))
  assert.equal(out.verdict, rec.expected.verdict)
  assert.equal(out.score, rec.expected.score)
  assert.deepEqual(out.reasons.map((r) => r.code), rec.expected.codes)
  assert.equal(out.snapshot_sha256, rec.expected.snapshot_sha256, 'the same evidence, recorded the same way')
  assert.equal(out.chain_sha256, rec.expected.chain_sha256)
  assert.equal(out.block.height, rec.expected.block.height)
  assert.equal(out.block.hash, rec.expected.block.hash)
  assert.ok(calls.length > 0)
  // What a judge needs beside the verdict: how to recompute it, and what kind of answer it is.
  assert.equal(out.recompute.command, `cd near && npm run verdict -- aid-demo-merchant.testnet --at-block ${rec.expected.block.height}`)
  assert.equal(out.engine_version, ENGINE_VERSION)
  assert.equal(out.caip10, 'near:testnet:aid-demo-merchant.testnet')
  assert.equal(out.network, 'testnet')
  assert.equal(out.explorer, addressUrl(chain, 'aid-demo-merchant.testnet'))
  assert.deepEqual(out.labels, NEAR_CHECK_LABELS)
  assert.match(out.labels.settlement, /nothing settles on NEAR/)
  assert.equal(out.registry.state, 'not_deployed')
  assert.equal(out.registry.id, REGISTRY)
  assert.equal(out.vault, null)
  assert.equal(out.cached, false)
  assert.match(out.evidence, new RegExp(`^near-snapshot sha256:${out.snapshot_sha256} block:${out.block.height} `))
})

test('a name nobody registered is DENY account_not_found, and the registry with no contract is said to hold no verdict', async () => {
  __resetNearCheckForTests()
  const fake = fakeNearTestnet({ head: HEAD, accounts: {}, views: { [USDC]: usdcViews(false) } })
  const out = answerOf(await nearCheck('near:testnet:ghost-payee-zz.testnet', {}, { ...base, fetch: fake.fetch }))
  assert.equal(out.account, 'ghost-payee-zz.testnet', 'the CAIP-10 form names the bare account')
  assert.equal(out.verdict, 'DENY')
  assert.equal(out.reasons[0].code, 'account_not_found')
  assert.deepEqual(out.registry_reasons, ['account_not_found'])
  assert.ok(out.score < 200, 'a DENY scores in the DENY band')
  assert.equal(out.block.height, HEAD)
  assert.match(out.snapshot_sha256, /^[0-9a-f]{64}$/)
  assert.match(out.chain_sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(
    { state: out.registry.state, verdict: out.registry.verdict, open_reports: out.registry.open_reports },
    { state: 'not_deployed', verdict: null, open_reports: null },
  )
  // Nothing was read that the engine does not read for a name that does not exist: no keys, no probes.
  assert.ok(!fake.calls.some((c) => c.startsWith('view_access_key_list')))
})

test('the on-chain registry\'s own verdict and its open reports are surfaced as read, and decide as the engine says', async () => {
  __resetNearCheckForTests()
  const account = 'drainer-shop.testnet'
  const written = String(fakeBlockTs(HEAD - 100))
  const fake = fakeNearTestnet({
    head: HEAD,
    accounts: { [account]: { created: HEAD - 10_000_000 } },
    views: {
      [USDC]: usdcViews(true),
      [REGISTRY]: {
        get_verdict: (a) =>
          a.account_id === account
            ? { verdict: 'DENY', reasons: ['drainer'], evidence: null, score: 40, code_hash: null, updated_at_ns: written, updated_by: 'oracle.a-identity.testnet', expires_at_ns: null }
            : null,
        get_reports: () => [
          { reporter: 'alice.testnet', at_ns: String(fakeBlockTs(HEAD - 50)), reason: 'took the money' },
          { reporter: 'bob.testnet', at_ns: String(fakeBlockTs(HEAD - 40)), reason: 'same' },
        ],
        report_count: () => 2,
        list_verdicts: () => [],
      },
    },
  })
  const out = answerOf(await nearCheck(account, {}, { ...base, fetch: fake.fetch }))
  assert.equal(out.verdict, 'DENY')
  assert.deepEqual(out.registry_reasons, ['registry_deny'])
  assert.ok(out.reasons.some((r) => r.code === 'open_reports' && r.severity === 'warn'))
  assert.deepEqual(out.registry, {
    id: REGISTRY,
    state: 'read',
    verdict: 'DENY',
    reasons: ['drainer'],
    written_by: 'oracle.a-identity.testnet',
    written_at: new Date(Number(BigInt(written) / 1_000_000n)).toISOString(),
    expires_at: null,
    open_reports: 2,
    open_reporters: ['alice.testnet', 'bob.testnet'],
  })
})

test('with a vault, its counters for this payee are read and the recompute command names the vault', async () => {
  __resetNearCheckForTests()
  const account = 'aid-demo-merchant.testnet'
  const fake = fakeNearTestnet({
    head: HEAD,
    accounts: { [account]: { created: HEAD - 1_000, txHeights: [HEAD - 1_000] } },
    views: {
      [USDC]: usdcViews(false),
      [VAULT]: {
        get_config: () => ({ registry_id: REGISTRY, token_id: USDC }),
        paid_count: (a) => (a.payee === account ? 3 : 0),
        refusal_count: () => 1,
        guard_refusal_count: () => 2,
        is_allowed: () => false,
        list_allowlist: () => [],
      },
    },
  })
  const out = answerOf(await nearCheck(account, { vault: VAULT }, { ...base, fetch: fake.fetch }))
  assert.deepEqual(out.vault, { id: VAULT, state: 'read', paid_count: 3, refusal_count: 1, guard_refusal_count: 2, allowlisted: false })
  assert.equal(out.recompute.command, `cd near && npm run verdict -- ${account} --at-block ${HEAD} --vault ${VAULT}`)
  // The engine's own reading of those counters: three payments clear the new-account warnings,
  // the refusal on a DENY that no longer stands still warns, and agent-recorded refusals only inform.
  const code = (c: string) => out.reasons.find((r) => r.code === c)
  assert.equal(code('prior_payments')?.severity, 'positive')
  assert.equal(code('new_account')?.cleared_by, 'prior_payments')
  assert.equal(code('prior_registry_refusals')?.severity, 'warn')
  assert.equal(code('guard_refusals')?.severity, 'info')
  assert.equal(out.verdict, 'WARN')
})

test('mainnet, other networks, bare implicit ids and malformed ids are refused with the reason, before any read', async () => {
  __resetNearCheckForTests()
  const reads: string[] = []
  const deps: NearCheckDeps = { ...base, fetch: async (url) => { reads.push(url); throw new Error('no read may happen for a refused id') } }
  const cases: [string, string][] = [
    ['wrap.near', 'mainnet'],
    ['near:mainnet:wrap.near', 'mainnet'],
    ['near:betanet:alice.testnet', 'other_network'],
    ['ab'.repeat(32), 'ambiguous'],
    ['0x' + 'ab'.repeat(20), 'ambiguous'],
    ['alice', 'ambiguous'],
    ['Alice.testnet', 'invalid'],
    ['near:testnet:Bad..id', 'invalid'],
    ['', 'missing'],
    ['a'.repeat(200), 'too_long'],
  ]
  for (const [input, code] of cases) {
    const out = await nearCheck(input, {}, deps)
    assert.ok('error' in out, `${input} was not refused`)
    assert.equal(out.code, code, `${input}: ${out.error}`)
    assert.equal(out.httpStatus, 400)
  }
  const mainnet = await nearCheck('wrap.near', {}, deps)
  assert.ok('error' in mainnet)
  assert.match(mainnet.error, /testnet only/)
  assert.match(mainnet.error, /npm run verdict -- wrap\.near --network mainnet/)
  const implicit = await nearCheck('0x' + 'ab'.repeat(20), {}, deps)
  assert.ok('error' in implicit)
  assert.match(implicit.error, /near:testnet:0x/)
  const vault = await nearCheck('alice.testnet', { vault: 'vault.near' }, deps)
  assert.ok('error' in vault)
  assert.match(vault.error, /^vault: /)
  assert.deepEqual(reads, [])
})

test('when NEAR testnet does not answer there is no verdict: 503, never a cached guess and never ALLOW', async () => {
  __resetNearCheckForTests()
  const down = fakeNearTestnet({ head: HEAD, accounts: {}, views: {}, down: true })
  const out = await nearCheck('ghost-payee-zz.testnet', {}, { ...base, fetch: down.fetch })
  assert.ok('error' in out)
  assert.equal(out.code, 'no_verdict')
  assert.equal(out.httpStatus, 503)
  assert.match(out.error, /No verdict/)
  // Nothing was kept: the next ask, with the chain back, reads it.
  const up = fakeNearTestnet({ head: HEAD, accounts: {}, views: { [USDC]: usdcViews(false) } })
  const again = answerOf(await nearCheck('ghost-payee-zz.testnet', {}, { ...base, fetch: up.fetch }))
  assert.equal(again.cached, false)
  assert.equal(again.verdict, 'DENY')
})

test('one answer per account and vault for 60 s, and concurrent asks share one collection', async () => {
  __resetNearCheckForTests()
  const account = 'shop-keeper.testnet'
  const spec: FakeNearTestnet = {
    head: HEAD,
    accounts: { [account]: { created: HEAD - 10_000_000 } },
    views: { [USDC]: usdcViews(true), [VAULT]: { get_config: () => ({ registry_id: REGISTRY, token_id: USDC }), paid_count: () => 0, refusal_count: () => 0, guard_refusal_count: () => 0, is_allowed: () => true, list_allowlist: () => [account] } },
  }
  const fake = fakeNearTestnet(spec)
  let t = 1_000_000
  const deps: NearCheckDeps = { ...base, fetch: fake.fetch, now: () => t }
  const [a, b] = await Promise.all([nearCheck(account, {}, deps), nearCheck(account, {}, deps)])
  assert.equal(finalReads(fake.calls), 1, 'two concurrent asks, one collection')
  assert.equal(answerOf(a).snapshot_sha256, answerOf(b).snapshot_sha256)
  t += NEAR_CHECK_TTL_MS - 1
  const kept = answerOf(await nearCheck(`near:testnet:${account}`, {}, deps))
  assert.equal(kept.cached, true, 'the CAIP-10 form is the same account, and the same answer')
  assert.equal(kept.block.height, answerOf(a).block.height)
  assert.equal(finalReads(fake.calls), 1)
  // A vault is a different question, with its own answer.
  const viaVault = answerOf(await nearCheck(account, { vault: VAULT }, deps))
  assert.equal(viaVault.cached, false)
  assert.equal(viaVault.vault?.allowlisted, true)
  assert.equal(finalReads(fake.calls), 2)
  t += 2
  const fresh = answerOf(await nearCheck(account, {}, deps))
  assert.equal(fresh.cached, false, 'past 60 s the chain is read again')
  assert.equal(finalReads(fake.calls), 3)
})

test('an ask not answered in time is told so, and the collection it started still answers the next ask', async () => {
  __resetNearCheckForTests()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const fake = fakeNearTestnet({ head: HEAD, accounts: {}, views: { [USDC]: usdcViews(false) }, gate: () => held })
  try {
    const late = await nearCheck('slow-payee.testnet', {}, { ...base, fetch: fake.fetch, timeoutMs: 20 })
    assert.ok('error' in late)
    assert.equal(late.code, 'timeout')
    assert.equal(late.httpStatus, 503)
  } finally {
    release()
  }
  const next = answerOf(await nearCheck('slow-payee.testnet', {}, { ...base, fetch: fake.fetch }))
  assert.equal(next.verdict, 'DENY')
  const kept = answerOf(await nearCheck('slow-payee.testnet', {}, { ...base, fetch: fake.fetch }))
  assert.equal(kept.cached, true)
  assert.equal(finalReads(fake.calls), 1, 'the timed-out collection was the only one')
})

test('at most four collections run and 32 wait; a new account past that is told to ask again, and nothing is lost', async () => {
  __resetNearCheckForTests()
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  const fake = fakeNearTestnet({ head: HEAD, accounts: {}, views: { [USDC]: usdcViews(false) }, gate: () => held })
  const deps: NearCheckDeps = { ...base, fetch: fake.fetch, timeoutMs: 5 }
  const names = Array.from({ length: 4 + 32 }, (_, i) => `queued-payee-${i}.testnet`)
  try {
    // Each ask times out at once, but its collection keeps its slot or its place in the queue.
    const asked = await Promise.all(names.map((n) => nearCheck(n, {}, deps)))
    assert.ok(asked.every((r) => 'error' in r && r.code === 'timeout'))
    const busy = await nearCheck('one-too-many.testnet', {}, deps)
    assert.ok('error' in busy)
    assert.equal(busy.code, 'busy')
    assert.equal(busy.httpStatus, 503)
    // An account already being collected is not a new one: it joins its collection.
    const joined = await nearCheck(names[0], {}, deps)
    assert.ok('error' in joined && joined.code === 'timeout')
  } finally {
    release()
  }
  // Released, every queued collection finishes and answers, one collection per account.
  const answers = await Promise.all(names.map((n) => nearCheck(n, {}, { ...base, fetch: fake.fetch })))
  assert.ok(answers.every((r) => isNearAnswer(r) && r.verdict === 'DENY'))
  assert.equal(finalReads(fake.calls), names.length)
  assert.equal(answerOf(await nearCheck('one-too-many.testnet', {}, { ...base, fetch: fake.fetch })).verdict, 'DENY', 'with the queue drained, the refused account is read')
})

test('a failure of ours inside the collection is 503 with no verdict, never a 400 that blames the account asked about', async () => {
  __resetNearCheckForTests()
  const fake = fakeNearTestnet({ head: HEAD, accounts: {}, views: { [USDC]: usdcViews(false) } })
  // A bug as a real one surfaces: a TypeError thrown deep inside the collectors, here from a
  // clock that hands back something that is not a Date.
  const broken = (() => ({})) as unknown as () => Date
  const out = await nearCheck('ghost-payee-zz.testnet', {}, { ...base, fetch: fake.fetch, clock: broken })
  assert.ok('error' in out, 'no verdict may come out of a failed collection')
  assert.equal(out.code, 'no_verdict')
  assert.equal(out.httpStatus, 503)
  assert.match(out.error, /failed on our side, not because of the account asked about/)
  assert.doesNotMatch(out.error, /toISOString|is not a function/, 'the internal message stays in the server log')
  // Nothing was kept: with the bug gone, the next ask reads the chain and decides.
  const again = answerOf(await nearCheck('ghost-payee-zz.testnet', {}, { ...base, fetch: fake.fetch }))
  assert.equal(again.cached, false)
  assert.equal(again.verdict, 'DENY')
})

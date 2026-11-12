/**
 * The verdict on a payee, whichever form of its name reaches us, with the reads that leave this
 * process replaced. Offline and deterministic: the platform state is real, the chain is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import algosdk from 'algosdk'
import { addressInQuery, readReputationAnswer, recordNamedBy, tokenInQuery } from '../agent-query.js'
import { agentPassport, counterpartyCheck, reputationScore, riskCheck, trustPreview, verifyAgent, type GatherDeps } from './tools.js'
import { __resetNearCheckForTests, isNearAnswer, nearCheck, NEAR_CHECK_LABELS, type NearCheckResult } from '../near-check/check.js'
import { fakeNearTestnet, replayExchanges, type RecordedExchange } from '../near-check/fake-chain.js'
import { getChainById } from '../chains/registry.js'
import { merchantCheck } from '../commerce.js'
import { handlePublicRoutes } from '../http/public-routes.js'
import { __resetPlatformStateForTests, assignWallet, createAgent, recordWallet, reputationForQuery, type PlatformAgent } from '../platform.js'
import { state } from '../platform/core.js'
import { ARC_TESTNET } from '../arc.js'
import type { AgentIdentity } from '../data.js'

__resetPlatformStateForTests()

const ARC_ID = ARC_TESTNET.id
const OTHER_CHAIN_ID = ARC_ID + 1
const DAY = 86_400_000
const wallet = () => privateKeyToAccount(generatePrivateKey()).address

/** A record that gets ALLOW: anchored or holding a proven wallet, attested, settled, and old enough. */
function strongRecord(address: string, over: Partial<PlatformAgent> = {}): PlatformAgent {
  const agent = createAgent({ name: 'Strong', description: '', category: 'Research', capabilities: [], permissions: {}, walletAddress: address, owner: `owner-${address}@test` })
  agent.kya = 'verified'
  agent.kyaProof = { address, at: new Date().toISOString(), method: 'wallet-signature' }
  agent.createdAt = new Date(Date.now() - 400 * DAY).toISOString()
  agent.onchain = 'registered'
  Object.assign(agent, over)
  for (let i = 0; i < 40; i++) {
    state.instructions.push({ id: `ix_${agent.id}_${i}`, agentId: agent.id, type: 'payment', amountUsd: 50, count: 1, payee: 'p', memo: '', status: 'executed_onchain', policyNote: '', createdAt: new Date(Date.now() - i * DAY).toISOString() } as (typeof state.instructions)[number])
  }
  return agent
}

/** A record that reads Sybil high: every job hired by its own operator. */
function sybilRecord(address: string, tokenId: string): PlatformAgent {
  const agent = createAgent({ name: 'Wash', description: '', category: 'Research', capabilities: [], permissions: {}, walletAddress: address, owner: `wash-${address}@test` })
  agent.kya = 'verified'
  agent.kyaProof = { address, at: new Date().toISOString(), method: 'wallet-signature' }
  agent.onchainAgentId = tokenId
  agent.onchain = 'registered'
  for (let i = 0; i < 3; i++) {
    state.tasks.push({ id: `task_${agent.id}_${i}`, client: agent.owner as string, agentId: agent.id, service: 's', priceUsd: 1, description: '', status: 'released', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as (typeof state.tasks)[number])
  }
  return agent
}

const identityOf = (tokenId: number, owner: string, chain: AgentIdentity['chain'] = 'arc') => ({ agentId: `eip155:${ARC_ID}:8004/${tokenId}`, tokenId, owner, registrationUri: '', domain: '', valid: false, registeredAt: '', chain })

/**
 * No chain, unless the test says what the chain answers. The NEAR engine is not reachable from
 * here at all: a form that is not NEAR testnet must never get there, so a read of it fails the
 * test that made it. That turns every test in this file into a proof that its forms behave as
 * they did before the NEAR branch existed.
 */
const offline = (resolveIdentity: GatherDeps['resolveIdentity'] = async () => null): GatherDeps => ({
  resolveIdentity,
  readValidation: (async () => null) as never,
  readHumanProof: (async () => null) as never,
  nearCheck: async (account) => {
    throw new Error(`${account} reached the NEAR engine, and no form in this test may`)
  },
})

test('the forms of a query: an address in any spelling, a token with or without its chain, and nothing else', () => {
  const a = '0x' + 'aB'.repeat(20)
  assert.equal(addressInQuery(a), a)
  assert.equal(addressInQuery('0X' + 'aB'.repeat(20)), a)
  assert.equal(addressInQuery(`eip155:${ARC_ID}:${a}`), a)
  assert.equal(addressInQuery(`eip155:${ARC_ID}:8004/849980`), null)
  assert.equal(addressInQuery('agent_x'), null)
  assert.deepEqual(tokenInQuery('849980'), { tokenId: '849980', chainId: null })
  assert.deepEqual(tokenInQuery('#849980'), { tokenId: '849980', chainId: null })
  assert.deepEqual(tokenInQuery(`eip155:${ARC_ID}:8004/849980`), { tokenId: '849980', chainId: ARC_ID })
  // Digits at the end of something else are not a token.
  assert.equal(tokenInQuery(a), null)
  assert.equal(tokenInQuery(`eip155:${ARC_ID}:0xdeadbeefdeadbeefdeadbeefdeadbeefde849980`), null)
  assert.equal(tokenInQuery(`eip155:${ARC_ID}:8004/owned-by-${a}`), null)
  assert.equal(tokenInQuery('agent_849980'), null)
  // And a token answers only on the chain it names.
  const anchored = [{ id: 'x', onchainAgentId: '36', chainId: ARC_ID }]
  assert.equal(recordNamedBy(anchored, `eip155:${ARC_ID}:8004/36`)?.id, 'x')
  assert.equal(recordNamedBy(anchored, `eip155:${OTHER_CHAIN_ID}:8004/36`), null)
  assert.equal(recordNamedBy(anchored, '#36')?.id, 'x')
  assert.equal(recordNamedBy(anchored, 'eip155:1:0x000000000000000000000000000000000000abc36'), null)
})

test('a payee gets the same verdict by address, CAIP-10, 0X and CAIP token id', async () => {
  const address = wallet()
  const agent = strongRecord(address, { onchainAgentId: '777001' })
  const forms = [address, address.toLowerCase(), `0X${address.slice(2)}`, `eip155:${ARC_ID}:${address}`, `eip155:${ARC_ID}:8004/777001`, '777001', '#777001', agent.id]
  for (const form of forms) {
    const r = await riskCheck(form, null, offline(async () => identityOf(777001, address)))
    assert.equal(r.decision, 'ALLOW', `${form}: ${r.reasons.join(' | ')}`)
    assert.equal(r.signals.onPlatform, true, form)
    assert.equal(r.agentId, form, 'the answer names what was asked, so a client can compare it')
  }
})

test('a token of the same number on another chain is not this record', async () => {
  const address = wallet()
  strongRecord(address, { onchainAgentId: '777002' })
  const foreign = `eip155:${OTHER_CHAIN_ID}:8004/777002`
  const someoneElse = wallet()
  const r = await riskCheck(foreign, null, offline(async () => identityOf(777002, someoneElse, 'arc-mainnet')))
  assert.equal(r.signals.onPlatform, false)
  assert.equal(r.decision, 'WARN')
})

test('a token held by an address a record proved gets that record, including its DENY', async () => {
  const address = wallet()
  const onMainnet = `eip155:${OTHER_CHAIN_ID}:8004/104498`
  strongRecord(address)
  const good = await riskCheck(onMainnet, null, offline(async () => identityOf(104498, address)))
  assert.equal(good.decision, 'ALLOW', good.reasons.join(' | '))

  const bad = wallet()
  sybilRecord(bad, '777003')
  const denied = await riskCheck(`eip155:${OTHER_CHAIN_ID}:8004/104499`, null, offline(async () => identityOf(104499, bad)))
  assert.equal(denied.decision, 'DENY')
  assert.match(denied.reasons[0], /Sybil/)

  // A record that merely names the owner is not that owner.
  const owner = wallet()
  createAgent({ name: 'Names', description: '', category: 'Research', capabilities: [], permissions: {}, walletAddress: owner, owner: 'squat@test' })
  const unknown = await riskCheck(`eip155:${OTHER_CHAIN_ID}:8004/104500`, null, offline(async () => identityOf(104500, owner)))
  assert.equal(unknown.decision, 'WARN')
  assert.equal(unknown.signals.onPlatform, false)
})

test('an id that reaches no record is refused with reasons that say we could not look, and no chain-only score', async () => {
  const r = await riskCheck('not-a-real-id', { amountUsd: 5 }, offline())
  assert.equal(r.decision, 'DENY', 'failing closed stays')
  assert.equal(r.signals.onPlatform, undefined)
  assert.equal(r.reasons.length, 1)
  assert.match(r.reasons[0], /could not look/)
  assert.match(r.reasons[0], /hold no evidence/)
  assert.match(r.reasons[0], /0x address/)
  assert.ok(!/below the safe threshold|New agent|KYA/.test(r.reasons[0]))
  // A token whose read failed is the same thing, and an unknown address is not.
  const token = await riskCheck(`eip155:${OTHER_CHAIN_ID}:8004/1`, null, offline())
  assert.equal(token.decision, 'DENY')
  assert.match(token.reasons[0], /could not look/)
  const stranger = await riskCheck(wallet(), null, offline())
  assert.equal(stranger.decision, 'WARN')
  assert.equal(stranger.signals.onPlatform, false)
})

test('a refresh that fails: a found record cannot say it holds nothing, and an unknown address is not called clean or bad', async () => {
  const address = wallet()
  const low = createAgent({ name: 'Low', description: '', category: 'Research', capabilities: [], permissions: {}, walletAddress: address, owner: 'low@test' })
  low.kya = 'verified'
  low.kyaProof = { address, at: new Date().toISOString(), method: 'wallet-signature' }
  const fresh = await riskCheck(address, null, offline())
  assert.equal(fresh.decision, 'WARN', 'with a good read: nothing against it')
  assert.equal(fresh.signals.adverseRecord, false)

  const failing: GatherDeps = { ...offline(), refreshState: async () => false }
  const stale = await riskCheck(address, null, failing)
  assert.equal(stale.signals.onPlatform, true)
  assert.equal(stale.signals.adverseRecord, undefined, 'a statement about a store we could not read')
  assert.equal(stale.decision, 'DENY')
  assert.ok(!stale.reasons.some((x) => /holds nothing against it/.test(x)))
  assert.ok(stale.reasons.some((x) => /could not be refreshed/.test(x)))

  const unknown = await riskCheck(wallet(), null, failing)
  assert.equal(unknown.decision, 'DENY')
  assert.equal(unknown.reasons.length, 1)
  assert.match(unknown.reasons[0], /could not read our platform records/)
  assert.match(unknown.reasons[0], /hold no evidence/)
})

test('the same payee by platform id reads the wallet the record proved, and a wallet it only names is not read', async () => {
  const address = wallet()
  const proven = strongRecord(address, { onchain: 'queued' })
  const asked: string[] = []
  const read = offline(async (q) => {
    asked.push(q)
    return q === address ? identityOf(104498, address) : null
  })
  const byAddress = await riskCheck(address, null, read)
  const byId = await riskCheck(proven.id, null, read)
  assert.equal(byAddress.decision, 'ALLOW', byAddress.reasons.join(' | '))
  assert.equal(byId.decision, 'ALLOW', byId.reasons.join(' | '))
  assert.ok(!byId.reasons.some((x) => /No on-chain identity/.test(x)))
  assert.deepEqual(asked, [address, address])

  const named = createAgent({ name: 'Names', description: '', category: 'Research', capabilities: [], permissions: {}, walletAddress: address, owner: 'squat2@test' })
  const squat: string[] = []
  await riskCheck(named.id, null, offline(async (q) => { squat.push(q); return identityOf(104498, address) }))
  assert.deepEqual(squat, [named.id], 'a free registration does not borrow the identity of a wallet it names')
})

test('/api/reputation, get_reputation and risk_check agree on a CAIP id of a Sybil-high record', async () => {
  const bad = wallet()
  const agent = sybilRecord(bad, '891731')
  const caip = `eip155:${ARC_ID}:8004/891731`

  const paid = await riskCheck(caip, null, offline(async () => identityOf(891731, bad)))
  assert.equal(paid.decision, 'DENY')
  assert.match(paid.reasons[0], /Sybil/)

  let status = 0
  let body: { found?: boolean; lookedUp?: boolean; reputation?: { agentId: string; sybil: { level: string } } } = {}
  const res = { writeHead: (s: number) => { status = s }, setHeader: () => {}, end: (b?: string) => { body = b ? JSON.parse(b) : {} } }
  await handlePublicRoutes({ req: { method: 'GET', headers: {} }, res, url: new URL(`http://localhost/api/reputation?id=${encodeURIComponent(caip)}`) } as never)
  assert.equal(status, 200)
  assert.equal(body.reputation?.agentId, agent.id)
  assert.equal(body.reputation?.sybil.level, 'high')

  // get_reputation is the same function over the same read, so it is asserted on both.
  const answer = await readReputationAnswer<{ agentId: string }>(caip, reputationForQuery, async () => null)
  assert.equal(answer.kind, 'record')
  assert.equal(answer.kind === 'record' ? answer.reputation.agentId : null, agent.id)
  assert.match(readFileSync(new URL('../../src/server.ts', import.meta.url), 'utf8'), /readReputationAnswer\(agentId,/)
  assert.match(readFileSync(new URL('../../src/http/public-routes.ts', import.meta.url), 'utf8'), /readReputationAnswer<[^\n]+>\(id, reputationForQuery,/)

  // A token held by the proven address of a record reaches it too, on the free read.
  const viaOwner = await readReputationAnswer<{ agentId: string }>(`eip155:${OTHER_CHAIN_ID}:8004/104501`, reputationForQuery, async () => identityOf(104501, bad))
  assert.equal(viaOwner.kind === 'record' ? viaOwner.reputation.agentId : null, agent.id)
})

test('a free read says whether it looked: only an address was looked up in full', async () => {
  assert.deepEqual(await readReputationAnswer('not-a-real-id', reputationForQuery, async () => null), { kind: 'none', lookedUp: false })
  assert.deepEqual(await readReputationAnswer(`eip155:${OTHER_CHAIN_ID}:8004/2`, reputationForQuery, async () => { throw new Error('rpc down') }), { kind: 'none', lookedUp: false })
  assert.deepEqual(await readReputationAnswer(wallet(), reputationForQuery, async () => null), { kind: 'none', lookedUp: true })
  assert.deepEqual(await readReputationAnswer(`eip155:${OTHER_CHAIN_ID}:8004/3`, reputationForQuery, async () => identityOf(3, wallet())), { kind: 'identity-only', partial: false })
})

test('merchant_check: the digits an address or a CAIP-10 account ends in are not a token, on any path', async () => {
  const anchored = strongRecord(wallet(), { onchainAgentId: '849981' })
  const tail = `0xdeadbeefdeadbeefdeadbeefdeadbeefde849981`
  const partial = { agentId: `eip155:${ARC_ID}:8004/owned-by-${tail.toLowerCase()}`, tokenId: 0, owner: tail, registrationUri: '', domain: '', valid: false, registeredAt: '', chain: 'arc', partial: true }
  const forms: Array<[string, typeof partial | null]> = [[tail, partial], [`eip155:${ARC_ID}:${tail}`, null], [`0X${tail.slice(2)}`, partial]]
  for (const [agentId, identity] of forms) {
    const r = await merchantCheck({ agentId }, { resolveIdentity: async () => identity as never })
    assert.ok(!('error' in r))
    assert.equal(r.reputation, null, `${agentId} must not read record ${anchored.id}`)
  }
})

test('merchant_check: a record reached by id counts as identity, by its anchor or the wallet it proved', async () => {
  const address = wallet()
  const proven = strongRecord(address, { onchain: 'queued' })
  const byId = await merchantCheck({ agentId: proven.id }, { resolveIdentity: async (q) => (q === address ? identityOf(104498, address) : null) as never })
  assert.ok(!('error' in byId))
  assert.equal(byId.verdict, 'ALLOW', byId.reasons.map((x) => x.detail).join(' | '))

  const anchored = strongRecord(wallet(), { onchainAgentId: '849982' })
  const byAnchorId = await merchantCheck({ agentId: anchored.id }, { resolveIdentity: async () => null })
  assert.ok(!('error' in byAnchorId))
  assert.ok(!byAnchorId.reasons.some((x) => x.code === 'no_onchain_identity'), byAnchorId.reasons.map((x) => x.detail).join(' | '))

  const named = wallet()
  const unproven = createAgent({ name: 'Names', description: '', category: 'Research', capabilities: [], permissions: {}, walletAddress: named, owner: 'squat3@test' })
  const squat = await merchantCheck({ agentId: unproven.id }, { resolveIdentity: async () => null })
  assert.ok(!('error' in squat))
  assert.ok(squat.reasons.some((x) => x.code === 'no_onchain_identity'), 'a wallet it only names is no identity')
})

test('moving off an address and back does not clear a DENY there, in the verdict or the free read', async () => {
  const a = wallet()
  const b = wallet()
  const agent = sybilRecord(a, '777010')
  recordWallet(a)
  recordWallet(b)
  assert.ok(!('error' in assignWallet(b, agent.id, agent.owner)))
  assert.equal((await riskCheck(a, null, offline())).decision, 'DENY')
  assert.ok(!('error' in assignWallet(a, agent.id, agent.owner)))
  assert.equal(agent.kya, 'unverified')
  const back = await riskCheck(a, null, offline())
  assert.equal(back.decision, 'DENY', back.reasons.join(' | '))
  assert.match(back.reasons[0], /Sybil/)
  assert.equal(back.signals.onPlatform, true)
  assert.ok(back.reasons.some((x) => /that proof is not current/.test(x)))
  const read = reputationForQuery(a)
  assert.equal('error' in read ? null : read.sybil.level, 'high', 'and the free read does not say Unknown agent')
})

test('a stranger who hires and disputes a vendor moves its score, and never makes it a DENY', async () => {
  const address = wallet()
  const vendor = createAgent({ name: 'Vendor', description: '', category: 'Research', capabilities: [], permissions: {}, walletAddress: address, owner: 'vendor@test' })
  vendor.kya = 'verified'
  vendor.kyaProof = { address, at: new Date().toISOString(), method: 'wallet-signature' }
  const before = await riskCheck(address, { amountUsd: 500 }, offline())
  assert.equal(before.decision, 'WARN')
  const past = new Date(Date.now() - 1000).toISOString()
  for (const over of [{ deliverable: 'the work' }, { deadlineAt: past }]) {
    state.tasks.push({ id: `task_${Math.random()}`, client: 'stranger@test', agentId: vendor.id, service: 's', priceUsd: 0.000001, description: '', status: 'refunded', createdAt: past, updatedAt: new Date().toISOString(), ...over } as (typeof state.tasks)[number])
  }
  const after = await riskCheck(address, { amountUsd: 500 }, offline())
  assert.equal(after.decision, 'WARN', after.reasons.join(' | '))
  assert.equal(after.signals.adverseRecord, false)
  assert.ok(after.reasons.some((x) => /holds 2 jobs a client refunded or disputed/.test(x)))
})

// -- NEAR testnet, the last form (2026-11-12) ---------------------------------------------------

/** The repository root, from dist/asp/. */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const merchantRun = JSON.parse(readFileSync(`${REPO}near/sdk/test/fixtures/collect-merchant.json`, 'utf8')) as {
  options: { account: string }
  expected: { verdict: string; score: number; codes: string[]; chain_sha256: string; block: { height: number } }
  exchanges: RecordedExchange[]
}
const NEAR_USDC = getChainById('near-testnet')!.documentedTokens!.find((t) => t.symbol === 'USDC')!.address

/** The trust tools' NEAR read, over the SDK's own recorded collection of the demo merchant. */
const nearReplay = (): GatherDeps => ({
  ...offline(),
  nearCheck: (account) =>
    nearCheck(account, {}, { fetch: replayExchanges(merchantRun.exchanges), clock: () => new Date('2026-11-12T00:00:00.000Z'), sleep: async () => {}, env: {} }),
})

/** Every key path of a JSON value's objects, as a serialized answer has them. */
function keyPaths(v: unknown, at = ''): string[] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${at}${k}`, ...keyPaths(x, `${at}${k}.`)])
}
const shapeOf = (v: unknown) => keyPaths(JSON.parse(JSON.stringify(v))).sort()

test('no form that is not NEAR testnet reaches the NEAR engine: each answers in every tool exactly as before', async () => {
  strongRecord(wallet())
  const evm = wallet()
  const opaque = [
    'not-a-real-id',
    'agent_doesnotexist0',
    Keypair.random().publicKey(),
    StrKey.encodeContract(randomBytes(32)),
    algosdk.generateAccount().addr.toString(),
    'example.com',
    'pay.example.org/checkout',
    'alice.tg',
    'wrap.near',
    'near:mainnet:wrap.near',
    'near:betanet:alice.testnet',
    'Alice.testnet',
    'alice',
    'ab'.repeat(32),
    `eip155:${OTHER_CHAIN_ID}:8004/9`,
    '849981234',
  ]
  for (const form of opaque) {
    const r = await riskCheck(form, null, offline())
    assert.equal(r.decision, 'DENY', `${form}: ${r.reasons.join(' | ')}`)
    assert.equal(r.reasons.length, 1, form)
    assert.match(r.reasons[0], /could not look/, form)
    assert.equal(r.signals.onPlatform, undefined, form)
  }
  // A lowercase 0x address is also the shape of a NEAR eth-implicit account; it stays an EVM address.
  const lower = evm.toLowerCase()
  const unknown = await riskCheck(lower, null, offline())
  assert.equal(unknown.decision, 'WARN')
  assert.equal(unknown.signals.onPlatform, false)
  // And in every other tool that scores through gather(), not a word of NEAR.
  for (const form of [opaque[0], opaque[2], opaque[4], opaque[8], lower]) {
    const outputs = [
      await verifyAgent(form, offline()),
      await trustPreview(form, offline()),
      await counterpartyCheck(lower, form, { amountUsd: 5 }, offline()),
      await agentPassport(form, offline()),
      await reputationScore(form, offline()),
    ]
    for (const out of outputs) assert.doesNotMatch(JSON.stringify(out), /NEAR|near:testnet|npm run verdict/, `${form}: ${out.tool}`)
  }
})

test('a NEAR testnet account gets the NEAR SDK\'s own verdict in every trust tool, as near:testnet:<id> or a bare .testnet name, with no field added', async () => {
  __resetNearCheckForTests()
  const id = merchantRun.options.account
  const { verdict, score, codes, chain_sha256, block } = merchantRun.expected
  const recompute = `cd near && npm run verdict -- ${id} --at-block ${block.height}`

  for (const form of [id, `near:testnet:${id}`]) {
    const r = await riskCheck(form, null, nearReplay())
    assert.equal(r.agentId, form, 'the answer names what was asked')
    assert.equal(r.decision, verdict, r.reasons.join(' | '))
    assert.equal(r.risk, 'medium')
    assert.match(r.reasons[0], new RegExp(`^NEAR testnet account ${id}: ${verdict} \\(score ${score} of 1000`))
    assert.ok(r.reasons[0].includes(recompute) && r.reasons[0].includes(chain_sha256), r.reasons[0])
    for (const code of codes) assert.ok(r.reasons.some((x) => x.includes(` ${code}`)), `the reasons name ${code}`)
    assert.ok(r.reasons.some((x) => /has no contract at block/.test(x)), 'the registry is reported as read')
    assert.match(r.reasons.at(-1)!, /Testnet only, read live, and nothing settles on NEAR/)
    assert.match(r.reasons.at(-1)!, /GET https:\/\/a-identity\.xyz\/api\/near\/check\?account=/)
    assert.equal(r.signals.reputationScore, score)
    assert.equal(r.signals.onPlatform, false)
    assert.equal(r.signals.onchainVerified, false)
  }

  // An amount does not move a NEAR verdict, as it does not in the SDK; the reasons say so.
  const large = await riskCheck(id, { amountUsd: 5000 }, nearReplay())
  assert.equal(large.decision, verdict)
  assert.ok(large.reasons.some((x) => /\$5000\) does not enter a NEAR verdict/.test(x)))

  // The same answer in the other tools, carried in the text fields they already have.
  const evm = wallet()
  const shapes = async (form: string, deps: GatherDeps) => ({
    verify: await verifyAgent(form, deps),
    preview: await trustPreview(form, deps),
    deal: await counterpartyCheck(evm, form, { amountUsd: 25 }, deps),
    passport: await agentPassport(form, deps),
    score: await reputationScore(form, deps),
    risk: await riskCheck(form, { amountUsd: 25 }, deps),
  })
  const near = await shapes(id, nearReplay())
  const other = await shapes(evm.toLowerCase(), offline())
  for (const k of Object.keys(near) as (keyof typeof near)[]) {
    assert.deepEqual(shapeOf(near[k]), shapeOf(other[k]), `${k}: a NEAR answer carries exactly the fields every other answer carries`)
  }
  assert.equal(near.verify.verified, false)
  assert.equal(near.verify.kya_status, 'unknown')
  assert.equal(near.verify.source, 'none')
  assert.equal(near.verify.liveness.checked, false)
  assert.match(near.verify.liveness.note, new RegExp(`NEAR verdict on it is ${verdict} on ${codes.filter((c) => c === 'new_account' || c === 'low_activity').join(', ')}, score ${score}`))
  assert.ok(near.verify.liveness.note.includes(recompute))
  assert.equal(near.preview.scoreBand, 'low', `${score} is in the WARN band`)
  assert.match(near.preview.upgrade.note, /^The free preview is coarse by design\./)
  assert.match(near.preview.upgrade.note, /api\/near\/check\?account=aid-demo-merchant\.testnet/)
  assert.equal(near.deal.decision, verdict)
  assert.equal(near.deal.counterparty.reputation, score)
  assert.equal(near.deal.sameOperator, false)
  assert.equal(near.passport.risk.decision, verdict)
  assert.equal(near.score.score, score)
  assert.match(near.score.basis, /^NEAR testnet verdict engine score/)
})

test('a NEAR account nobody registered is DENY in the trust tools, and no NEAR verdict at all is DENY that says we could not look', async () => {
  __resetNearCheckForTests()
  const fake = fakeNearTestnet({ head: 277_300_000, accounts: {}, views: { [NEAR_USDC]: { is_blocklisted: () => false, storage_balance_of: () => null } } })
  const unregistered: GatherDeps = { ...offline(), nearCheck: (account) => nearCheck(account, {}, { fetch: fake.fetch, sleep: async () => {}, env: {} }) }
  const denied = await riskCheck('nobody-registered-this-zz.testnet', null, unregistered)
  assert.equal(denied.decision, 'DENY')
  assert.equal(denied.risk, 'high')
  assert.ok(denied.reasons.some((x) => /^DENY account_not_found: named account nobody-registered-this-zz\.testnet does not exist/.test(x)), denied.reasons.join(' | '))
  // An implicit account is NEAR only in its CAIP-10 form, and reaches the engine as such: never
  // funded is a soft WARN there, not a DENY. Bare, the same 64 hex is the opaque id it always was.
  const implicit = 'cd'.repeat(32)
  const unfunded = await riskCheck(`near:testnet:${implicit}`, null, unregistered)
  assert.equal(unfunded.decision, 'WARN', unfunded.reasons.join(' | '))
  assert.ok(unfunded.reasons.some((x) => x.startsWith('WARN implicit_unfunded:')))
  const bare = await riskCheck(implicit, null, offline())
  assert.equal(bare.decision, 'DENY')
  assert.match(bare.reasons[0], /could not look/)

  const failed: NearCheckResult = { code: 'no_verdict', httpStatus: 503, error: 'No verdict: no NEAR RPC host answered.' }
  const down: GatherDeps = { ...offline(), nearCheck: async () => failed }
  const r = await riskCheck('near:testnet:aid-demo-merchant.testnet', null, down)
  assert.equal(r.decision, 'DENY', 'failing closed, as every form does when a read fails')
  assert.equal(r.reasons.length, 1)
  assert.match(r.reasons[0], /No NEAR verdict could be computed for aid-demo-merchant\.testnet/)
  assert.match(r.reasons[0], /hold no evidence against it/)
  assert.match(r.reasons[0], /could not look/)
  assert.equal(r.signals.onPlatform, undefined, 'nothing was read, so it is not "no record"')
  const preview = await trustPreview('aid-demo-merchant.testnet', down)
  assert.match(preview.upgrade.note, /strict default, not evidence/)
  const verify = await verifyAgent('aid-demo-merchant.testnet', down)
  assert.match(verify.liveness.note, /No NEAR verdict could be computed/)
})

test('what a NEAR answer notes about its sources, the NearBlocks attribution among them, reaches the trust tools\' text', async () => {
  __resetNearCheckForTests()
  const id = 'shop-with-contract-zz.testnet'
  const head = 277_300_000
  // An account with a contract: its deployments are read from NearBlocks, whose terms ask for the
  // attribution the snapshot then notes.
  const fake = fakeNearTestnet({
    head,
    accounts: { [id]: { created: head - 10_000_000, codeHash: 'FakeCode'.padEnd(44, 'x') } },
    views: { [NEAR_USDC]: { is_blocklisted: () => false, storage_balance_of: () => null } },
  })
  const read = (account: string) => nearCheck(account, {}, { fetch: fake.fetch, sleep: async () => {}, env: {} })
  const direct = await read(id)
  assert.ok(isNearAnswer(direct), JSON.stringify(direct))
  const attribution = direct.notes.find((n) => /Powered by Nearblocks\.io APIs/.test(n))
  assert.ok(attribution, `the snapshot notes the NearBlocks attribution: ${JSON.stringify(direct.notes)}`)

  const deps: GatherDeps = { ...offline(), nearCheck: read }
  const risk = await riskCheck(id, null, deps)
  assert.ok(risk.reasons.includes(attribution), risk.reasons.join(' | '))
  assert.match(risk.reasons.at(-1)!, /^Testnet only, read live/, 'the label stays the last reason')
  const deal = await counterpartyCheck(wallet(), id, { amountUsd: 5 }, deps)
  assert.ok(deal.reasons.includes(attribution), deal.reasons.join(' | '))
  const verify = await verifyAgent(id, deps)
  assert.ok(verify.liveness.note.includes(attribution), verify.liveness.note)
  const preview = await trustPreview(id, deps)
  assert.ok(preview.upgrade.note.includes(attribution), preview.upgrade.note)
  // And the read label names the indexer that answers, rather than claiming two were read.
  assert.match(NEAR_CHECK_LABELS.read, /FastNEAR, with NearBlocks as its fallback/)
  assert.doesNotMatch(NEAR_CHECK_LABELS.read, /two indexers/)
})

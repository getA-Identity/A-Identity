/**
 * The verdict on a payee, whichever form of its name reaches us, with the reads that leave this
 * process replaced. Offline and deterministic: the platform state is real, the chain is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { addressInQuery, readReputationAnswer, recordNamedBy, tokenInQuery } from '../agent-query.js'
import { riskCheck, type GatherDeps } from './tools.js'
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

/** No chain, unless the test says what the chain answers. */
const offline = (resolveIdentity: GatherDeps['resolveIdentity'] = async () => null): GatherDeps => ({
  resolveIdentity,
  readValidation: (async () => null) as never,
  readHumanProof: (async () => null) as never,
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  __resetPlatformStateForTests,
  createAgent,
  listPlatformAgents,
  recordAtAddress,
  recordHoldsEvidence,
  recordWallet,
  assignWallet,
  agentGuardrailProfile,
  agentReputation,
  reputationForQuery,
  startCirclePolicyChallenge,
  attestCirclePolicy,
  getCirclePolicyAttestation,
  circleAgentWalletFor,
  bandsFromPolicy,
  capBand,
  policyHashOf,
  type PlatformAgent,
} from '../platform.js'
import { state, MAX_FORMER_PROVEN_WALLETS } from './core.js'
import { startKyaChallenge, verifyKya } from './kya.js'
import { recordAuditOutcome } from './guardrail.js'
import { capAudits, MAX_AUDITS_PER_AGENT } from '../policy/index.js'
import type { ContractSignatureCheck } from '../erc1271.js'
import { adverseRecordFrom } from '../asp/risk.js'
import { handlePublicRoutes } from '../http/public-routes.js'
import type { Task } from '../marketplace.js'

/**
 * The owner-attested Circle policy.
 *
 * Two things these tests exist to keep true. The attestation is bands and a signed hash,
 * never the policy: a raw cap, a raw allowlist address or the wallet id must not survive
 * into anything a third party can read. And it is never enforcement: the guardrail
 * profile carries it under `attestations` with its own disclosure, and `policyEnforced`
 * does not move because of it.
 */
__resetPlatformStateForTests()

// Keys are generated when the tests run: nothing key-shaped lives in the tree.
const eoa = privateKeyToAccount(generatePrivateKey())
const SCA = '0x00000000000000000000000000000000000000cA'
const SCA_SIG = ('0x' + 'cd'.repeat(65)) as `0x${string}`
const OWNER = 'owner@test'

/** The shape Circle CLI 1.0 prints for `wallet limit --output json`, with values that must never leak. */
const CLI_JSON = JSON.stringify({
  walletId: 'wal-7f3e2c11-secret',
  blockchain: 'BASE',
  policies: [
    { policyType: 'STABLECOIN', ruleType: 'TRANSFER_LIMIT', perTxLimit: '2.50', dailyLimit: '40.00', origin: 'CUSTOM', policyId: 'pol-9a8b' },
    { policyType: 'STABLECOIN', ruleType: 'RECIPIENT_ALLOWLIST', addresses: ['0x1111111111111111111111111111111111111111'], origin: 'CUSTOM' },
  ],
})

let seq = 0
function seed(wallet: string): PlatformAgent {
  seq += 1
  const agent = createAgent({ name: `Policy Agent ${seq}`, description: 'Seeded for attestation tests.', category: 'Research', capabilities: [], permissions: {}, owner: OWNER })
  const row = state.agents.find((a) => a.id === agent.id) as PlatformAgent
  row.walletAddress = wallet
  return row
}

test('cap bands step at 1, 10 and 100 USDC, and an absent or Uncapped limit is uncapped', () => {
  assert.equal(capBand(undefined), 'uncapped')
  assert.equal(capBand('Uncapped'), 'uncapped')
  assert.equal(capBand('0'), 'uncapped')
  assert.equal(capBand('0.25'), 'dust')
  assert.equal(capBand('2.50'), 'small')
  assert.equal(capBand(40), 'moderate')
  assert.equal(capBand('250.00'), 'large')
})

test('bands come from the CLI shape and say so; anything else parses to unknown, not to a policy', () => {
  const { bands, circleChain } = bandsFromPolicy(JSON.parse(CLI_JSON))
  assert.equal(bands.parsed, true)
  assert.equal(circleChain, 'BASE')
  assert.deepEqual(bands.transferLimits, { perTx: 'small', daily: 'moderate', weekly: 'uncapped', monthly: 'uncapped' })
  assert.equal(bands.recipientAllowlist, true)
  assert.equal(bands.contractAllowlist, false)
  assert.equal(bands.origin, 'custom')
  const mixed = bandsFromPolicy({ policies: [{ ruleType: 'TRANSFER_LIMIT', perTxLimit: '1', origin: 'CODE_DEFAULT' }, { ruleType: 'transfer-limit', dailyLimit: '5', origin: 'CUSTOM' }] })
  assert.equal(mixed.bands.origin, 'mixed')
  assert.equal(mixed.bands.transferLimits.perTx, 'small')
  for (const bad of [null, 'text', [], {}, { policies: 'no' }]) {
    const b = bandsFromPolicy(bad).bands
    assert.equal(b.parsed, false, JSON.stringify(bad))
    assert.equal(b.transferLimits.perTx, 'uncapped')
  }
})

test('the challenge hashes the exact text and refuses anything that is not JSON', () => {
  const agent = seed(eoa.address)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  assert.equal(c.policyHash, policyHashOf(CLI_JSON))
  assert.ok(c.message.includes(c.policyHash))
  assert.ok(c.message.includes(eoa.address))
  assert.equal(c.bands.parsed, true)
  assert.match((startCirclePolicyChallenge(agent.id, 'not json', OWNER) as { error: string }).error, /must be JSON/)
  assert.match((startCirclePolicyChallenge(agent.id, CLI_JSON, 'stranger') as { error: string }).error, /Forbidden/)
  assert.match((startCirclePolicyChallenge(seed('').id, CLI_JSON, OWNER) as { error: string }).error, /no wallet/)
})

test('a key-held wallet attests, and the stored record carries bands, hash and signature but never the policy', async () => {
  const agent = seed(eoa.address)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const signature = await eoa.signMessage({ message: c.message })
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, signature, OWNER)
  assert.ok(!('error' in r), JSON.stringify(r))
  assert.equal(r.attestation.method, 'wallet-signature')
  assert.equal(r.attestation.circleChain, 'BASE')
  assert.equal(r.attestation.bands.transferLimits.daily, 'moderate')
  // The record's `at` is an ISO timestamp, and one taken at hh:mm:x2.50x contains "2.50": it is
  // blanked so the leak check reads policy values, not the clock. CI failed exactly that way
  // on 2026-10-03 (a run at 17:33:22.50x), with nothing leaked.
  const record = getCirclePolicyAttestation(agent.id)
  assert.ok('attestation' in record && record.attestation && !Number.isNaN(Date.parse(record.attestation.at)), 'the attestation carries a real timestamp')
  const stored = JSON.stringify(record).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<at>')
  for (const secret of ['wal-7f3e2c11', '2.50', '40.00', '0x1111111111111111111111111111111111111111', 'pol-9a8b', 'perTxLimit', 'dailyLimit']) {
    assert.equal(stored.includes(secret), false, `attestation leaked ${secret}`)
  }
  assert.ok(stored.includes(r.attestation.policyHash))
  // A replay of the same challenge is refused: the nonce was consumed.
  const again = await attestCirclePolicy(agent.id, CLI_JSON, c.message, signature, OWNER)
  assert.ok('error' in again)
})

test('a contract account attests through ERC-1271 on the chain Circle named, and the proof records it', async () => {
  const agent = seed(SCA)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const asked: string[] = []
  const check: ContractSignatureCheck = async (chain) => { asked.push(chain.id); return chain.id === 'base' }
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, SCA_SIG, OWNER, { deps: { checkContract: check } })
  assert.ok(!('error' in r), JSON.stringify(r))
  assert.equal(r.attestation.method, 'erc1271-signature')
  assert.equal(r.attestation.chain, 'base')
  // blockchain: BASE narrowed the question to Base alone.
  assert.deepEqual(asked, ['base'])
})

test('changing the policy text between challenge and attest is refused, and so is a bad signature', async () => {
  const agent = seed(eoa.address)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const signature = await eoa.signMessage({ message: c.message })
  const swapped = await attestCirclePolicy(agent.id, CLI_JSON.replace('40.00', '4000.00'), c.message, signature, OWNER)
  assert.ok('error' in swapped)
  assert.match(swapped.error, /differs/)
  const forged = await attestCirclePolicy(agent.id, CLI_JSON, c.message, SCA_SIG, OWNER, { deps: { checkContract: async () => false } })
  assert.ok('error' in forged)
  assert.equal(agent.circlePolicyAttestation, undefined)
})

test('the guardrail profile carries the attestation as owner-attested, bands only, and policyEnforced does not move', async () => {
  const agent = seed(eoa.address)
  const before = agentGuardrailProfile(agent.id)
  assert.equal(before.profile.attestations, undefined)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, await eoa.signMessage({ message: c.message }), OWNER)
  assert.ok(!('error' in r))
  const after = agentGuardrailProfile(agent.id)
  assert.equal(after.profile.policyEnforced, before.profile.policyEnforced)
  assert.equal(after.profile.attestations?.length, 1)
  const att = after.profile.attestations![0]
  assert.equal(att.source, 'circle-agent-wallet')
  assert.equal(att.kind, 'owner-attested')
  assert.equal(att.attestedOn.length, 10)
  assert.match(att.disclosure, /does not treat this as enforcement/)
  const json = JSON.stringify(after.profile)
  for (const secret of ['wal-7f3e2c11', '2.50', '40.00', '0x1111111111111111111111111111111111111111', eoa.address, '"signature":', '"message":', 'policyHash']) {
    assert.equal(json.includes(secret), false, `profile leaked ${secret}`)
  }
  assert.equal(/\d{2}:\d{2}:\d{2}/.test(json), false, 'exact attestation timing must not leak')
})

test('a wallet is marked as a Circle agent wallet by its attestation, and loses the mark when the agent changes wallet', async () => {
  const fresh = privateKeyToAccount(generatePrivateKey())
  const agent = seed(fresh.address)
  assert.equal(circleAgentWalletFor(fresh.address), null)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, await fresh.signMessage({ message: c.message }), OWNER)
  assert.ok(!('error' in r))
  const mark = circleAgentWalletFor(fresh.address.toUpperCase().replace('0X', '0x'))
  assert.equal(mark?.agentId, agent.id)
  assert.equal(mark?.method, 'wallet-signature')
  recordWallet(SCA)
  const moved = assignWallet(SCA, agent.id, OWNER)
  assert.ok(!('error' in moved))
  assert.equal(agent.circlePolicyAttestation, undefined)
  assert.equal(circleAgentWalletFor(fresh.address), null)
})

test('a proven wallet the agent moves off stays on its record, so a later revocation still reads there', () => {
  const fresh = privateKeyToAccount(generatePrivateKey())
  const agent = seed(fresh.address)
  // Named but never proven: moving off it records nothing, because nothing was proven about it.
  recordWallet(SCA)
  assert.ok(!('error' in assignWallet(SCA, agent.id, OWNER)))
  assert.equal(agent.formerProvenWallets, undefined)

  const next = privateKeyToAccount(generatePrivateKey()).address
  agent.kya = 'verified'
  agent.kyaProof = { address: SCA, at: new Date().toISOString(), method: 'wallet-signature' }
  recordWallet(next)
  assert.ok(!('error' in assignWallet(next, agent.id, OWNER)))
  assert.equal(agent.kya, 'unverified', 'KYA is about the wallet it proved')
  assert.equal(agent.kyaProof, undefined)
  assert.deepEqual(agent.formerProvenWallets, [SCA])

  agent.kya = 'revoked'
  assert.equal(recordAtAddress(listPlatformAgents(), SCA).record?.id, agent.id)
  assert.equal(recordAtAddress(listPlatformAgents(), SCA).currentWallet, false)
})

// ── a wallet the record never proved does not read as that record ─────────────────

test('someone who proves their own wallet, revokes, then assigns a vendor\'s wallet cannot force DENY on the vendor', () => {
  const own = privateKeyToAccount(generatePrivateKey()).address
  const vendor = privateKeyToAccount(generatePrivateKey()).address
  const griefer = seed(own)
  griefer.kya = 'revoked'
  griefer.kyaProof = { address: own, at: new Date().toISOString(), method: 'wallet-signature' }
  recordWallet(vendor)
  assert.ok(!('error' in assignWallet(vendor, griefer.id, OWNER)))
  assert.equal(griefer.walletAddress, vendor)
  assert.equal(griefer.kya, 'revoked', 'assignWallet keeps it, which is the way in')

  const at = recordAtAddress(listPlatformAgents(), vendor)
  assert.equal(at.record, null)
  assert.equal(at.claim?.id, griefer.id, 'returned so the reasons can say so')
  assert.ok('error' in reputationForQuery(vendor), 'the free read does not answer with that record either')
  // The wallet it did prove stays bound, and the record itself stays revoked by its own id.
  assert.equal(recordAtAddress(listPlatformAgents(), own).record?.id, griefer.id)
  const atOwn = reputationForQuery(own)
  assert.equal('error' in atOwn ? null : atOwn.kya, 'revoked')
  const byId = reputationForQuery(griefer.id)
  assert.equal('error' in byId ? null : byId.kya, 'revoked')
})

test('the free read answers an address with the record that proved it, and never with one that only names it', () => {
  const wallet = privateKeyToAccount(generatePrivateKey()).address
  const named = seed(wallet)
  assert.ok('error' in reputationForQuery(wallet), 'named without proof')
  assert.ok('error' in agentReputation(wallet), 'agentReputation does not read an address at all')
  assert.ok(!('error' in reputationForQuery(named.id)), 'by its own id it is still itself')

  named.kya = 'verified'
  const proven = reputationForQuery(wallet.toLowerCase())
  assert.equal('error' in proven ? null : proven.agentId, named.id)
  assert.equal('error' in proven ? null : proven.kya, 'verified')

  // Moved off: it can count against the old address, and it does not vouch for it.
  named.kyaProof = { address: wallet, at: new Date().toISOString(), method: 'wallet-signature' }
  const next = privateKeyToAccount(generatePrivateKey()).address
  recordWallet(next)
  assert.ok(!('error' in assignWallet(next, named.id, OWNER)))
  named.kya = 'verified'
  const former = reputationForQuery(wallet)
  assert.equal('error' in former ? null : former.agentId, named.id)
  assert.equal('error' in former ? null : former.kya, 'unverified')
})

test('an owner cannot clear what a record proved by moving off an address and back', () => {
  const a = privateKeyToAccount(generatePrivateKey()).address
  const b = privateKeyToAccount(generatePrivateKey()).address
  const agent = seed(a)
  agent.kya = 'verified'
  agent.kyaProof = { address: a, at: new Date().toISOString(), method: 'wallet-signature' }
  recordWallet(a)
  recordWallet(b)
  assert.ok(!('error' in assignWallet(b, agent.id, OWNER)))
  assert.equal(recordAtAddress(listPlatformAgents(), a).record?.id, agent.id)

  // Back to A, with two unsigned calls: the record has no current proof of it and stays eligible there.
  assert.ok(!('error' in assignWallet(a, agent.id, OWNER)))
  assert.equal(agent.kya, 'unverified')
  const at = recordAtAddress(listPlatformAgents(), a)
  assert.equal(at.record?.id, agent.id, 'it reads as that record, not as a mere claim')
  assert.equal(at.currentWallet, false, 'and it does not vouch for the wallet until it proves it again')
  assert.equal(at.claim, null)
  const read = reputationForQuery(a)
  assert.equal('error' in read ? null : read.agentId, agent.id, 'the free read does not say Unknown agent')
  assert.equal('error' in read ? null : read.provenWallet, null, 'and offers no wallet to read an identity from')
  // B was never proved, so it is not bound by any of this.
  assert.equal(recordAtAddress(listPlatformAgents(), b).record, null)
})

test('a revoked record that moves and proves a new wallet does not forget the one it left', async () => {
  const first = privateKeyToAccount(generatePrivateKey())
  const second = privateKeyToAccount(generatePrivateKey())
  const agent = seed(first.address)
  agent.kya = 'revoked'
  agent.kyaProof = { address: first.address, at: new Date().toISOString(), method: 'wallet-signature' }
  recordWallet(second.address)
  assert.ok(!('error' in assignWallet(second.address, agent.id, OWNER)))
  assert.deepEqual(agent.formerProvenWallets, [first.address], 'revoked or not, what it proved stays when it leaves')

  // Proving the new wallet overwrites kyaProof, even when the history was not written by the move.
  agent.formerProvenWallets = undefined
  const challenge = startKyaChallenge(agent.id, OWNER)
  assert.ok(!('error' in challenge))
  const signature = await second.signMessage({ message: challenge.message })
  const verified = await verifyKya(agent.id, challenge.message, signature, OWNER)
  assert.ok(!('error' in verified), JSON.stringify(verified))
  assert.equal(agent.kyaProof?.address, second.address)
  assert.deepEqual(agent.formerProvenWallets, [first.address])
  assert.equal(recordAtAddress(listPlatformAgents(), first.address).record?.id, agent.id)
})

test('the history of proven wallets is bounded by refusing a move, never by dropping an address', () => {
  const first = privateKeyToAccount(generatePrivateKey()).address
  const agent = seed(first)
  const move = (address: string) => {
    recordWallet(address)
    return assignWallet(address, agent.id, OWNER)
  }
  agent.formerProvenWallets = Array.from({ length: MAX_FORMER_PROVEN_WALLETS }, (_, i) => `0x${String(i).padStart(40, '0')}`)
  const kept = agent.formerProvenWallets[0]
  agent.kya = 'verified'
  const refused = move(privateKeyToAccount(generatePrivateKey()).address)
  assert.ok('error' in refused, 'a further move would forget a proven address')
  assert.equal(agent.walletAddress, first, 'nothing changed')
  assert.equal(agent.kya, 'verified')
  assert.equal(recordAtAddress(listPlatformAgents(), kept).record?.id, agent.id)
  // A wallet it never proved is not added, so moving off that is not limited.
  agent.kya = 'unverified'
  assert.ok(!('error' in move(privateKeyToAccount(generatePrivateKey()).address)))
  assert.equal(agent.formerProvenWallets.length, MAX_FORMER_PROVEN_WALLETS)
})

test('a clean record cannot shadow one with evidence at an address that record proved, now or before', () => {
  const wallet = privateKeyToAccount(generatePrivateKey()).address
  const bad = seed(wallet)
  bad.kya = 'verified'
  const clean = seed(wallet)
  clean.kya = 'verified'
  const answer = () => { const r = reputationForQuery(wallet); return 'error' in r ? null : r.agentId }
  // With nothing against either, the first proven one answers, as it did.
  assert.equal(answer(), bad.id)
  // Evidence on the later one wins too.
  state.audits[clean.id] = [{ id: 'a', verdict: 'DENY', outcome: 'refused', overrideAttempts: 1 } as never]
  assert.equal(answer(), clean.id)
  assert.equal(recordAtAddress(listPlatformAgents(), wallet, recordHoldsEvidence).record?.id, clean.id)
  assert.equal(recordAtAddress(listPlatformAgents(), wallet).record?.id, bad.id, 'told nothing, it picks by proof alone')
  delete state.audits[clean.id]

  // Moved off the address, and a clean record now sits there: the old one still answers for it.
  const elsewhere = privateKeyToAccount(generatePrivateKey()).address
  recordWallet(elsewhere)
  assert.ok(!('error' in assignWallet(elsewhere, bad.id, OWNER)))
  state.audits[bad.id] = [{ id: 'a', verdict: 'DENY', outcome: 'refused', overrideAttempts: 1 } as never]
  assert.equal(answer(), bad.id)
  const at = recordAtAddress(listPlatformAgents(), wallet, recordHoldsEvidence)
  assert.equal(at.currentWallet, false)
  delete state.audits[bad.id]
  assert.equal(answer(), clean.id, 'with nothing against it, the wallet is the clean one\'s')
})

test('GET /api/reputation answers an address by proof, and the digits an address ends in are not a token id', async () => {
  const get = async (id: string) => {
    let status = 0
    let body: unknown = null
    const res = { writeHead: (s: number) => { status = s }, setHeader: () => {}, end: (b?: string) => { body = b ? JSON.parse(b) : null } }
    const url = new URL(`http://localhost/api/reputation?id=${encodeURIComponent(id)}`)
    const handled = await handlePublicRoutes({ req: { method: 'GET', headers: {} }, res, url } as never)
    assert.equal(handled, true)
    return { status, body: body as { found: boolean; reputation?: { agentId: string } } }
  }
  const named = privateKeyToAccount(generatePrivateKey()).address
  const agent = seed(named)
  assert.equal((await get(named)).status, 404, 'named without proof')
  assert.equal((await get(agent.id)).body.reputation?.agentId, agent.id)

  // An agent anchored at token 36, and a wallet nobody holds a record of that happens to end in 36.
  const anchored = seed(privateKeyToAccount(generatePrivateKey()).address)
  anchored.onchainAgentId = '36'
  const stranger = '0x00000000000000000000000000000000000abc36'
  assert.equal((await get(stranger)).status, 404)
  assert.equal((await get('eip155:5042002:8004/36')).body.reputation?.agentId, anchored.id, 'a CAIP id still maps to its anchor')
  delete anchored.onchainAgentId
})

// ── what a record really holds against an agent ───────────────────────────────────

test('what counts as evidence on a platform record, from what the record really holds', () => {
  const agent = seed(privateKeyToAccount(generatePrivateKey()).address)
  const evidence = () => adverseRecordFrom(agentReputation(agent.id) as never)
  const at = (ms: number) => new Date(ms).toISOString()
  const NOW = Date.now()
  const job = (over: Partial<Task>): Task => ({ id: `task_${Math.random()}`, client: 'stranger@test', agentId: agent.id, service: 's', priceUsd: 1, description: '', status: 'refunded', createdAt: at(NOW), updatedAt: at(NOW), deadlineAt: at(NOW + 3_600_000), ...over })
  const without = () => {
    state.tasks = state.tasks.filter((t) => t.agentId !== agent.id)
    state.instructions = state.instructions.filter((i) => i.agentId !== agent.id)
    delete state.audits[agent.id]
  }
  assert.equal(evidence(), false, 'a new agent with nothing on its record: nothing against it, so nothing to deny on')

  // A contest is free to write while the platform funds the escrow, so no shape of it is evidence: not
  // a same-minute refund, not one after a delivery, not one after a deadline. The scorer still sees it.
  for (const shape of [{}, { deliverable: 'the work' }, { status: 'disputed' as const, deliverable: '' }, { deadlineAt: at(NOW - 1000) }]) {
    state.tasks.push(job(shape))
    assert.equal(evidence(), false, JSON.stringify(shape))
    const rep = agentReputation(agent.id)
    assert.equal('error' in rep ? null : rep.behavioral.contestedJobs, 1, 'the scorer still sees it')
    without()
  }

  // A settlement a human rejected counts, and the velocity breaker's refusal does not.
  const ix = { id: 'ix', agentId: agent.id, type: 'payment', amountUsd: 1, count: 1, payee: 'p', memo: '', status: 'rejected', policyNote: '', createdAt: at(NOW) } as (typeof state.instructions)[number]
  state.instructions.push({ ...ix, denyCode: 'velocity_exceeded' })
  assert.equal(evidence(), false)
  state.instructions.push(ix)
  assert.equal(evidence(), true)
  without()

  // A guardrail override attempt counts, and a DENY the policy gave by itself does not.
  state.audits[agent.id] = [{ id: 'a', verdict: 'DENY', outcome: 'refused' } as never]
  assert.equal(evidence(), false)
  state.audits[agent.id] = [{ id: 'a', verdict: 'DENY', outcome: 'refused', overrideAttempts: 1 } as never]
  assert.equal(evidence(), true)
  without()

  // The evidence survives the audit cap, because it is read from the monotonic meter.
  const auditId = 'aud_kept'
  state.audits[agent.id] = [{ id: auditId, verdict: 'DENY', outcome: 'refused' } as never]
  assert.ok('error' in recordAuditOutcome(agent.id, auditId, 'executed', OWNER))
  assert.equal(evidence(), true)
  const scored = agentReputation(agent.id)
  assert.equal('error' in scored ? null : scored.discipline.overrideAttempts, 1)
  state.audits[agent.id] = capAudits(Array.from({ length: MAX_AUDITS_PER_AGENT + 1 }, (_, i) => ({ id: `row${i}`, verdict: 'ALLOW', outcome: 'executed' }) as never))
  assert.equal(state.audits[agent.id].length, MAX_AUDITS_PER_AGENT)
  assert.equal(evidence(), true, '500 free checks do not erase it')
  const after = agentReputation(agent.id)
  assert.equal('error' in after ? null : after.discipline.overrideAttempts, 1)
  assert.equal('error' in after ? null : after.breakdown.discipline, 'error' in scored ? null : scored.breakdown.discipline, 'the score penalty does not go with the rows')
  without()
  delete state.meters[agent.id]

  // A low star rating alone does not count.
  state.tasks.push(job({ status: 'released', settlement: 'simulated', review: { by: 'stranger@test', rating: 1, text: '', at: at(NOW) } }), job({ status: 'released', settlement: 'simulated', review: { by: 'other@test', rating: 1, text: '', at: at(NOW) } }))
  assert.equal(evidence(), false)
  without()
})

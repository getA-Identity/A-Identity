import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import {
  __resetPlatformStateForTests,
  createAgent,
  markImportedAgent,
  startClaimChallenge,
  verifyAgentClaim,
  agentReputation,
  type PlatformAgent,
} from '../platform.js'
import { state } from './core.js'
import { recordAuditOutcome } from './guardrail.js'
import { adverseRecordFrom } from '../asp/risk.js'

/**
 * Claiming an imported record.
 *
 * The rule these tests exist to protect is the re-read: a claim is settled against what
 * the chain says NOW, never against the owner we stored at import time. Trusting the
 * stored value would let someone who has since sold the token claim it, and that failure
 * is invisible in every test that only exercises the happy path, so it gets its own case
 * where the stored owner and the live owner deliberately disagree.
 */
__resetPlatformStateForTests()

const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const OTHER_KEY = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const
const holder = privateKeyToAccount(OWNER_KEY)
const stranger = privateKeyToAccount(OTHER_KEY)

const CHAIN = 'base'
const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'

let seq = 0
function seedImported(owner = holder.address): PlatformAgent {
  seq += 1
  const agent = createAgent({
    name: `Imported Agent ${seq}`,
    description: 'Seeded for claim tests.',
    category: 'Research',
    capabilities: [],
    permissions: {},
    owner: 'importer@test',
  })
  const r = markImportedAgent(agent.id, {
    chain: CHAIN,
    tokenId: String(1000 + seq),
    registry: REGISTRY,
    owner,
    at: new Date().toISOString(),
  })
  assert.ok(!('error' in r), 'seeding an import must succeed')
  return state.agents.find((a) => a.id === agent.id) as PlatformAgent
}

/** A stub standing in for the live ownerOf read, so no test touches a network. */
const liveOwner = (owner: string) => async () => ({ owner })
const liveFails = (error: string) => async () => ({ error })

test('an imported record is unclaimed, not unverified, and records where it came from', () => {
  const agent = seedImported()
  assert.equal(agent.kya, 'unclaimed')
  assert.equal(agent.importedFrom?.chain, CHAIN)
  assert.equal(agent.importedFrom?.owner, holder.address)
})

test('marking an import never downgrades a record that is already verified or revoked', () => {
  const agent = seedImported()
  agent.kya = 'verified'
  const r = markImportedAgent(agent.id, {
    chain: CHAIN, tokenId: '999', registry: REGISTRY, owner: stranger.address, at: new Date().toISOString(),
  })
  assert.deepEqual(r, { kya: 'verified' })
  assert.equal(state.agents.find((a) => a.id === agent.id)?.kya, 'verified')
})

test('an agent that was never imported has nothing to claim', () => {
  const agent = createAgent({
    name: 'Ordinary Agent', description: 'Not an import.', category: 'Research',
    capabilities: [], permissions: {}, owner: 'someone@test',
  })
  const r = startClaimChallenge(agent.id)
  assert.ok('error' in r)
  assert.match(r.error, /not an unclaimed import/)
})

test('the on-chain owner claims the record, and the same signature proves KYA', async () => {
  const agent = seedImported()
  const ch = startClaimChallenge(agent.id)
  assert.ok(!('error' in ch))
  const signature = await holder.signMessage({ message: ch.message })

  const r = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, 'claimant@test', {
    readOwner: liveOwner(holder.address),
  })
  assert.ok(!('error' in r), `claim should settle: ${JSON.stringify(r)}`)

  const after = state.agents.find((a) => a.id === agent.id) as PlatformAgent
  assert.equal(after.kya, 'verified')
  assert.equal(after.walletAddress, holder.address)
  assert.equal(after.owner, 'claimant@test', 'the record changes hands')
  assert.equal(after.claimProof?.address, holder.address)
  assert.equal(after.kyaProof?.address, holder.address, 'the claim signature IS the wallet-control proof')
})

test('a former owner cannot claim: ownership is re-read, not taken from the import record', async () => {
  // The stored owner is the signer, which is exactly the state a stale record would be in
  // after the token moved. Only the live read knows better.
  const agent = seedImported(holder.address)
  const ch = startClaimChallenge(agent.id)
  assert.ok(!('error' in ch))
  const signature = await holder.signMessage({ message: ch.message })

  const r = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, 'claimant@test', {
    readOwner: liveOwner(stranger.address),
  })
  assert.ok('error' in r)
  assert.match(r.error, /is owned by/)
  const after = state.agents.find((a) => a.id === agent.id) as PlatformAgent
  assert.equal(after.kya, 'unclaimed', 'a refused claim changes nothing')
  assert.equal(after.owner, 'importer@test')
})

test('a signature from the wrong wallet is refused before the chain is asked', async () => {
  const agent = seedImported()
  const ch = startClaimChallenge(agent.id)
  assert.ok(!('error' in ch))
  const signature = await stranger.signMessage({ message: ch.message })

  let asked = false
  const r = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, 'claimant@test', {
    readOwner: async () => { asked = true; return { owner: holder.address } },
  })
  assert.ok('error' in r)
  assert.match(r.error, /Signature does not match/)
  assert.equal(asked, false, 'a bad signature must not be able to probe the chain read')
  assert.equal(state.agents.find((a) => a.id === agent.id)?.kya, 'unclaimed')
})

test('a claim without a live challenge is refused', async () => {
  const agent = seedImported()
  const message = `A-Identity claim: prove you control agent #1 on ${CHAIN}\nRecord: ${agent.id}\nNonce: deadbeef`
  const signature = await holder.signMessage({ message })
  const r = await verifyAgentClaim(agent.id, message, signature, holder.address, 'claimant@test', {
    readOwner: liveOwner(holder.address),
  })
  assert.ok('error' in r)
  assert.match(r.error, /Stale or missing challenge/)
})

test('an unreadable chain refuses the claim rather than settling it on the stored owner', async () => {
  const agent = seedImported()
  const ch = startClaimChallenge(agent.id)
  assert.ok(!('error' in ch))
  const signature = await holder.signMessage({ message: ch.message })
  const r = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, 'claimant@test', {
    readOwner: liveFails('the RPC did not answer'),
  })
  assert.ok('error' in r)
  assert.match(r.error, /RPC did not answer/)
  assert.equal(state.agents.find((a) => a.id === agent.id)?.kya, 'unclaimed')
})

test('a settled claim cannot be replayed with the same challenge', async () => {
  const agent = seedImported()
  const ch = startClaimChallenge(agent.id)
  assert.ok(!('error' in ch))
  const signature = await holder.signMessage({ message: ch.message })
  const first = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, 'first@test', {
    readOwner: liveOwner(holder.address),
  })
  assert.ok(!('error' in first))
  const second = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, 'second@test', {
    readOwner: liveOwner(holder.address),
  })
  assert.ok('error' in second, 'the record is no longer unclaimed, so there is nothing to claim')
  assert.equal(state.agents.find((a) => a.id === agent.id)?.owner, 'first@test')
})

// ── what a stranger wrote on a record does not follow it to the real owner ─────────

test('rows the importer wrote are not evidence on the record, before the claim or after it', async () => {
  const agent = seedImported()
  const importer = agent.owner as string
  const evidence = () => adverseRecordFrom(agentReputation(agent.id) as never)
  const row = { id: `ix_${agent.id}`, agentId: agent.id, type: 'payment', amountUsd: 1, count: 1, payee: 'p', memo: '', status: 'rejected', policyNote: '', createdAt: new Date(Date.now() - 60_000).toISOString() } as (typeof state.instructions)[number]
  state.instructions.push(row)
  state.audits[agent.id] = [{ id: `aud_${agent.id}`, ts: new Date(Date.now() - 60_000).toISOString(), verdict: 'DENY', outcome: 'refused' } as never]
  assert.ok('error' in recordAuditOutcome(agent.id, `aud_${agent.id}`, 'executed', importer), 'the importer owns the row, so it can write this')
  assert.equal(evidence(), false, 'on an unclaimed record the owner is the importer, so none of it is conduct')

  const ch = startClaimChallenge(agent.id)
  assert.ok(!('error' in ch))
  const signature = await holder.signMessage({ message: ch.message })
  const r = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, 'vendor@test', { readOwner: liveOwner(holder.address) })
  assert.ok(!('error' in r))
  assert.equal(evidence(), false, "the vendor's wallet does not inherit a DENY by following the claim flow")
  const read = agentReputation(agent.id)
  assert.equal('error' in read ? null : read.discipline.rejectedSettlements, 0)
  assert.equal('error' in read ? null : read.discipline.overrideAttempts, 0)

  // What the real owner does from here on is its own conduct.
  assert.ok('error' in recordAuditOutcome(agent.id, `aud_${agent.id}`, 'executed', 'vendor@test'))
  const after = agentReputation(agent.id)
  assert.equal('error' in after ? null : after.discipline.overrideAttempts, 1)
  assert.equal(evidence(), true)
  state.instructions = state.instructions.filter((i) => i.agentId !== agent.id)
  delete state.audits[agent.id]
  delete state.meters[agent.id]
})

test('a claim with no session takes the record from the importer', async () => {
  const agent = seedImported()
  assert.ok(agent.owner, 'the importer owned it')
  const ch = startClaimChallenge(agent.id)
  assert.ok(!('error' in ch))
  const signature = await holder.signMessage({ message: ch.message })
  const r = await verifyAgentClaim(agent.id, ch.message, signature, holder.address, undefined, { readOwner: liveOwner(holder.address) })
  assert.ok(!('error' in r))
  assert.equal(agent.owner, undefined, 'or it could revoke the record and DENY the wallet just proved')
})

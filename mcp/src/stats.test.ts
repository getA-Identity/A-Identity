import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPlatformStateForTests,
  createAgent,
  registerAgentFromManifest,
  listPlatformAgents,
  addAgentFeedback,
  marketplace,
  platformStats,
  type Instruction,
  type PlatformAgent,
  type Service,
} from './platform.js'
import type { Task, TaskStatus } from './marketplace.js'
import { CHAINS } from './chains/index.js'
import { SETTLEMENTS } from './asp/settlements.js'

// Persistence is OFF for this whole process from the first line: these tests seed the
// in-memory state and must never overwrite the real persisted dev state.
__resetPlatformStateForTests()

const NOW = new Date().toISOString()

/** A KYA-verified agent with a showcase-length description (the default feed rule). */
function seedAgent(over: {
  name?: string
  description?: string
  category?: string
  services?: Service[]
  endpoint?: string
  cardStyle?: unknown
} = {}): PlatformAgent {
  const a = createAgent({
    name: over.name ?? 'Test Agent',
    description: over.description ?? 'A seeded agent with a description long enough for the showcase.',
    category: over.category ?? 'Research',
    capabilities: [],
    services: over.services,
    endpoint: over.endpoint,
    cardStyle: over.cardStyle,
    permissions: {},
    owner: 'owner@test',
  })
  a.kya = 'verified'
  return a
}

let taskSeq = 0
function mkTask(agentId: string, status: TaskStatus, priceUsd: number, settlement?: 'onchain' | 'simulated'): Task {
  taskSeq += 1
  return {
    id: `task_test_${taskSeq}`,
    client: 'client@test',
    agentId,
    service: 'Seeded service',
    priceUsd,
    description: '',
    status,
    ...(settlement ? { settlement } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

let ixSeq = 0
function mkInstruction(agentId: string, status: Instruction['status'], amountUsd: number, count = 1, txHash?: string): Instruction {
  ixSeq += 1
  return {
    id: `ix_test_${ixSeq}`,
    agentId,
    type: 'payment',
    amountUsd,
    count,
    payee: '0x000000000000000000000000000000000000dEaD',
    memo: '',
    status,
    policyNote: 'seeded',
    ...(txHash ? { txHash } : {}),
    createdAt: NOW,
  }
}

// ── marketplace row: the new derived fields ─────────────────────────────────────────

test('marketplace row carries services, priceFromUsd, soldCount, breakdown, online, payments, cardStyle', () => {
  const state = __resetPlatformStateForTests()
  const a = seedAgent({
    name: 'Seller',
    services: [
      { name: 'Translate a document', priceUsd: 1.5, unit: 'per document' },
      { name: 'Summarize', priceUsd: 0.5, unit: 'per doc' },
    ],
    endpoint: 'https://agent.example.com/a2a',
    cardStyle: 3,
  })
  const b = seedAgent({ name: 'Bare' }) // no services, no endpoint, no cardStyle

  state.tasks.push(
    mkTask(a.id, 'released', 2),
    mkTask(a.id, 'released', 1),
    mkTask(a.id, 'funded', 3), // not a sale yet
    mkTask(b.id, 'released', 1),
  )

  // 9 = positive, 5 = neutral, 2 = negative.
  assert.ok(!('error' in addAgentFeedback(a.id, 'r1@test', 9)))
  assert.ok(!('error' in addAgentFeedback(a.id, 'r2@test', 5)))
  assert.ok(!('error' in addAgentFeedback(a.id, 'r3@test', 2)))

  const feed = marketplace(undefined, true)
  const rowA = feed.agents.find((r) => r.id === a.id)
  const rowB = feed.agents.find((r) => r.id === b.id)
  assert.ok(rowA)
  assert.ok(rowB)

  assert.deepEqual(rowA.services, [
    { name: 'Translate a document', priceUsd: 1.5, unit: 'per document' },
    { name: 'Summarize', priceUsd: 0.5, unit: 'per doc' },
  ])
  assert.equal(rowA.priceFromUsd, 0.5)
  assert.equal(rowA.soldCount, 2)
  assert.deepEqual(rowA.feedbackBreakdown, { positive: 1, neutral: 1, negative: 1, positivePct: 33 })
  assert.equal(rowA.online, true)
  assert.deepEqual(rowA.payments, ['escrow', 'x402'])
  assert.equal(rowA.cardStyle, 3)

  assert.deepEqual(rowB.services, [])
  assert.equal(rowB.priceFromUsd, null)
  assert.equal(rowB.soldCount, 1)
  assert.deepEqual(rowB.feedbackBreakdown, { positive: 0, neutral: 0, negative: 0, positivePct: null })
  assert.equal(rowB.online, false)
  assert.deepEqual(rowB.payments, ['escrow'])
  assert.equal(rowB.cardStyle, null)
})

test('feedbackBreakdown bands cover the whole 1..10 scale and re-rating replaces', () => {
  const state = __resetPlatformStateForTests()
  const a = seedAgent({ name: 'Rated' })
  // Band edges: 7 is positive, 6 and 4 are neutral, 3 is negative.
  addAgentFeedback(a.id, 'e1@test', 7)
  addAgentFeedback(a.id, 'e2@test', 6)
  addAgentFeedback(a.id, 'e3@test', 4)
  addAgentFeedback(a.id, 'e4@test', 3)
  let row = marketplace(undefined, true).agents.find((r) => r.id === a.id)
  assert.ok(row)
  assert.deepEqual(row.feedbackBreakdown, { positive: 1, neutral: 2, negative: 1, positivePct: 25 })

  // One entry per rater: e4 re-rates 10, so their negative entry is replaced, not stacked.
  addAgentFeedback(a.id, 'e4@test', 10)
  row = marketplace(undefined, true).agents.find((r) => r.id === a.id)
  assert.ok(row)
  assert.deepEqual(row.feedbackBreakdown, { positive: 2, neutral: 2, negative: 0, positivePct: 50 })
  assert.equal(state.feedback[a.id].length, 4)
})

// ── cardStyle sanitization ──────────────────────────────────────────────────────────

test('cardStyle through createAgent: whole 1..6 sticks, everything else means unset', () => {
  __resetPlatformStateForTests()
  assert.equal(seedAgent({ cardStyle: 1 }).cardStyle, 1)
  assert.equal(seedAgent({ cardStyle: 6 }).cardStyle, 6)
  for (const bad of [0, 7, 2.5, NaN, Infinity, '3', null, true, [], {}]) {
    assert.equal(seedAgent({ cardStyle: bad }).cardStyle, undefined, `cardStyle ${String(bad)} must be dropped`)
  }
  assert.equal(seedAgent({}).cardStyle, undefined)
})

test('cardStyle through registerAgentFromManifest: sanitized the same way', () => {
  __resetPlatformStateForTests()
  const created = (manifest: Record<string, unknown>) => {
    const r = registerAgentFromManifest(manifest as never, 'owner@test')
    assert.ok(!('error' in r), 'registration must succeed')
    const agent = listPlatformAgents().find((a) => a.id === r.agentId)
    assert.ok(agent)
    return agent
  }
  assert.equal(created({ name: 'Styled', cardStyle: 5 }).cardStyle, 5)
  assert.equal(created({ name: 'StringStyle', cardStyle: '5' }).cardStyle, undefined)
  assert.equal(created({ name: 'OutOfRange', cardStyle: 9 }).cardStyle, undefined)
  assert.equal(created({ name: 'Unstyled' }).cardStyle, undefined)
})

test('cardStyle lands on the marketplace row as a number, null when unset', () => {
  __resetPlatformStateForTests()
  const styled = seedAgent({ name: 'Styled', cardStyle: 2 })
  const plain = seedAgent({ name: 'Plain' })
  const rows = marketplace(undefined, true).agents
  assert.equal(rows.find((r) => r.id === styled.id)?.cardStyle, 2)
  assert.equal(rows.find((r) => r.id === plain.id)?.cardStyle, null)
})

// ── platformStats: shape and math on a seeded state ─────────────────────────────────

test('platformStats aggregates real state honestly and excludes ci canaries', () => {
  const state = __resetPlatformStateForTests()

  // Two real agents + one ci canary. Only the real two may reach agent-derived numbers.
  const a = seedAgent({ name: 'Alpha', category: 'Research' }) // verified + long description => showcase
  a.onchain = 'registered'
  const b = createAgent({
    name: 'Beta',
    description: 'short', // under the showcase minimum
    category: 'Research',
    capabilities: [],
    permissions: {},
    owner: 'owner@test',
  }) // unverified => not showcase
  const ciReg = registerAgentFromManifest({ name: 'Canary', category: 'Ops', ci: true } as never, 'ci@test')
  assert.ok(!('error' in ciReg))
  const ciAgent = listPlatformAgents().find((x) => x.id === ciReg.agentId)
  assert.ok(ciAgent)
  assert.equal(ciAgent.ci, true)

  a.followers.push('u1@test', 'u2@test')
  b.followers.push('u3@test')
  ciAgent.followers.push('ci-follower@test') // must NOT count

  state.tasks.push(
    mkTask(a.id, 'released', 2.5, 'onchain'),
    mkTask(a.id, 'released', 1.25, 'simulated'),
    mkTask('', 'open', 4),
    mkTask(a.id, 'funded', 3),
  )

  state.instructions.push(
    mkInstruction(a.id, 'executed_onchain', 2, 1, '0xseededtxhash'),
    mkInstruction(a.id, 'executed_simulated', 1.5, 2),
    mkInstruction(a.id, 'rejected', 5),
    mkInstruction(a.id, 'pending_approval', 1),
  )

  addAgentFeedback(a.id, 'r1@test', 7)
  addAgentFeedback(a.id, 'r2@test', 8)
  addAgentFeedback(ciAgent.id, 'r3@test', 2) // ci feedback stays out of the headline

  const s = platformStats()

  assert.deepEqual(s.agents, {
    total: 2,
    showcase: 1,
    kyaVerified: 1,
    onchainRegistered: 1,
    byCategory: [{ category: 'Research', count: 2 }],
  })

  assert.deepEqual(s.tasks, { total: 4, open: 1, released: 2, gmvUsd: 3.75, gmvOnchainUsd: 2.5, onchainSettled: 1 })

  // Executed = executed_onchain + executed_simulated; batch count multiplies the amount.
  // The blended total stays, and the split is published beside it so a reader can tell a
  // settlement that moved money from one that ran without a signer.
  assert.deepEqual(s.settlements, {
    instructionsExecuted: 2, instructionsUsd: 5, withTxHash: 1, onchainUsd: 2, simulatedUsd: 3,
  })

  assert.deepEqual(s.feedback, { totalRatings: 2, avgScore: 7.5, ratedAgents: 1 })

  assert.equal(s.followersTotal, 3)

  // No policy decisions were metered in this seeded state.
  assert.deepEqual(s.guardrail, { checks: 0, allow: 0, warn: 0, deny: 0, protectedNotionalUsd: 0 })

  // Chain counts come straight from the registry, the single source of truth.
  assert.deepEqual(s.chains, {
    total: CHAINS.length,
    live: CHAINS.filter((c) => c.status === 'live').length,
    beta: CHAINS.filter((c) => c.status === 'beta').length,
  })

  // Deployed Arc contract addresses, with their names.
  assert.ok(s.contracts.deployed >= 1)
  assert.equal(s.contracts.deployed, s.contracts.names.length)
  assert.ok(s.contracts.names.includes('identityRegistry'))
  assert.ok(s.contracts.names.includes('usdc'))

  // x402 aggregates from the static settlement log.
  assert.equal(s.x402.rounds, new Set(SETTLEMENTS.map((r) => r.round)).size)
  assert.equal(s.x402.totalUsd, Math.round(SETTLEMENTS.reduce((t, r) => t + r.amountUsd, 0) * 1e6) / 1e6)
  assert.ok(s.x402.totalUsd > 0)

  assert.ok(!Number.isNaN(new Date(s.computedAt).getTime()), 'computedAt must be a valid ISO timestamp')
})

test('platformStats on an empty state: zero counts and null averages, never fake numbers', () => {
  __resetPlatformStateForTests()
  const s = platformStats()
  assert.deepEqual(s.agents, { total: 0, showcase: 0, kyaVerified: 0, onchainRegistered: 0, byCategory: [] })
  assert.deepEqual(s.tasks, { total: 0, open: 0, released: 0, gmvUsd: 0, gmvOnchainUsd: 0, onchainSettled: 0 })
  assert.deepEqual(s.settlements, { instructionsExecuted: 0, instructionsUsd: 0, withTxHash: 0, onchainUsd: 0, simulatedUsd: 0 })
  assert.deepEqual(s.feedback, { totalRatings: 0, avgScore: null, ratedAgents: 0 })
  assert.equal(s.followersTotal, 0)
})

test('platformStats byCategory sorts by count desc and caps at 10', () => {
  __resetPlatformStateForTests()
  for (let i = 0; i < 12; i++) seedAgent({ name: `Solo ${i}`, category: `Category ${String(i).padStart(2, '0')}` })
  seedAgent({ name: 'Dup 1', category: 'Popular' })
  seedAgent({ name: 'Dup 2', category: 'Popular' })
  seedAgent({ name: 'Dup 3', category: 'Popular' })
  const { byCategory } = platformStats().agents
  assert.equal(byCategory.length, 10)
  assert.deepEqual(byCategory[0], { category: 'Popular', count: 3 })
  for (let i = 1; i < byCategory.length; i++) {
    assert.ok(byCategory[i - 1].count >= byCategory[i].count, 'counts must be non-increasing')
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_TRANSITIONS,
  canTransition,
  isTerminal,
  statusForEscrowOutcome,
  normalizePriceUsd,
  normalizeDeadlineHours,
  sanitizeRating,
  deadlineFrom,
  aggregateRating,
  statusLabel,
  buildAgentManifest,
  agentChainIds,
  serviceDescription,
  MAX_TASK_PRICE_USD,
  DEFAULT_DEADLINE_HOURS,
  MAX_DEADLINE_HOURS,
  type TaskStatus,
  type Review,
  type ManifestAgent,
} from './marketplace.js'

// The same state machine + normalization platform.ts will run on real tasks.

// ── state machine ────────────────────────────────────────────────────────────────

test('the happy path is a legal chain of transitions', () => {
  const chain: TaskStatus[] = ['open', 'assigned', 'funded', 'delivered', 'released']
  for (let i = 0; i < chain.length - 1; i++) {
    assert.ok(canTransition(chain[i], chain[i + 1]), `${chain[i]} -> ${chain[i + 1]} should be legal`)
  }
})

test('a funded task can be delivered, disputed, or expiry-refunded', () => {
  assert.ok(canTransition('funded', 'delivered'))
  assert.ok(canTransition('funded', 'disputed'))
  assert.ok(canTransition('funded', 'refunded'))
})

test('a dispute resolves to either release or refund', () => {
  assert.ok(canTransition('disputed', 'released'))
  assert.ok(canTransition('disputed', 'refunded'))
})

test('a delivered task can be disputed straight to a refund (client rejects)', () => {
  assert.ok(canTransition('delivered', 'refunded'))
})

test('terminal statuses allow no further transition', () => {
  for (const s of ['released', 'refunded', 'cancelled'] as TaskStatus[]) {
    assert.ok(isTerminal(s), `${s} should be terminal`)
    assert.equal(TASK_TRANSITIONS[s].length, 0, `${s} should have no outgoing transitions`)
  }
})

test('illegal jumps are rejected (fail closed)', () => {
  assert.equal(canTransition('open', 'released'), false) // cannot pay without funding
  assert.equal(canTransition('funded', 'released'), false) // must deliver (or dispute) first
  assert.equal(canTransition('assigned', 'delivered'), false) // must fund escrow first
  assert.equal(canTransition('released', 'disputed'), false) // cannot dispute a paid task
})

test('an unknown status never transitions anywhere', () => {
  assert.equal(canTransition('bogus' as TaskStatus, 'released'), false)
})

test('escrow outcome maps to the right terminal status', () => {
  assert.equal(statusForEscrowOutcome('complete'), 'released')
  assert.equal(statusForEscrowOutcome('refund'), 'refunded')
})

// ── price normalization ──────────────────────────────────────────────────────────

test('a valid price is passed through', () => {
  assert.equal(normalizePriceUsd(3), 3)
  assert.equal(normalizePriceUsd(0.005), 0.005)
})

test('a price above the cap is clamped, not passed through', () => {
  assert.equal(normalizePriceUsd(1e9), MAX_TASK_PRICE_USD)
})

test('a non-finite or negative price collapses to 0 (an invalid task)', () => {
  assert.equal(normalizePriceUsd(-5), 0)
  assert.equal(normalizePriceUsd(NaN), 0)
  assert.equal(normalizePriceUsd(Infinity), 0)
  assert.equal(normalizePriceUsd('3' as unknown), 0)
})

// ── deadline normalization ───────────────────────────────────────────────────────

test('deadline hours default when unset/invalid and clamp to the max', () => {
  assert.equal(normalizeDeadlineHours(undefined), DEFAULT_DEADLINE_HOURS)
  assert.equal(normalizeDeadlineHours(0), DEFAULT_DEADLINE_HOURS)
  assert.equal(normalizeDeadlineHours(-1), DEFAULT_DEADLINE_HOURS)
  assert.equal(normalizeDeadlineHours(1e9), MAX_DEADLINE_HOURS)
  assert.equal(normalizeDeadlineHours(48), 48)
})

test('deadlineFrom is deterministic and adds the duration', () => {
  const start = '2026-07-19T00:00:00.000Z'
  assert.equal(deadlineFrom(start, 24), '2026-07-20T00:00:00.000Z')
  // deterministic: same inputs, same output
  assert.equal(deadlineFrom(start, 24), deadlineFrom(start, 24))
})

test('deadlineFrom tolerates an unparseable start (no NaN date)', () => {
  const out = deadlineFrom('not-a-date', 1)
  assert.ok(!Number.isNaN(new Date(out).getTime()), 'deadline must be a valid date')
})

// ── ratings ──────────────────────────────────────────────────────────────────────

test('a rating is clamped to an integer in [1,5]', () => {
  assert.equal(sanitizeRating(0), 1)
  assert.equal(sanitizeRating(9), 5)
  assert.equal(sanitizeRating(4.4), 4)
  assert.equal(sanitizeRating(NaN), 1)
})

test('aggregateRating of no reviews is a clean zero, never NaN', () => {
  const r = aggregateRating([])
  assert.equal(r.average, 0)
  assert.equal(r.count, 0)
})

test('aggregateRating averages and counts real reviews', () => {
  const reviews: Review[] = [
    { by: 'a', rating: 5, text: 'great', at: '2026-07-19' },
    { by: 'b', rating: 4, text: 'good', at: '2026-07-19' },
    { by: 'c', rating: 3, text: 'ok', at: '2026-07-19' },
  ]
  const r = aggregateRating(reviews)
  assert.equal(r.count, 3)
  assert.equal(r.average, 4) // (5+4+3)/3
})

test('aggregateRating rounds to one decimal', () => {
  const reviews: Review[] = [
    { by: 'a', rating: 5, text: '', at: '' },
    { by: 'b', rating: 4, text: '', at: '' },
  ]
  assert.equal(aggregateRating(reviews).average, 4.5)
})

// ── display ──────────────────────────────────────────────────────────────────────

test('every status has a human label', () => {
  const all: TaskStatus[] = ['open', 'assigned', 'funded', 'delivered', 'released', 'disputed', 'refunded', 'cancelled']
  for (const s of all) assert.ok(statusLabel(s).length > 0, `${s} needs a label`)
})

// ── manifest (AMP Discover) ──────────────────────────────────────────────────────

const baseAgent: ManifestAgent = {
  id: 'agent_x',
  chainId: 5042002,
  name: 'Lingua',
  description: 'translation worker',
  category: 'Translation',
  capabilities: ['translation'],
  walletAddress: '0x1111111111111111111111111111111111111111',
  kya: 'verified',
  onchain: 'registered',
  onchainAgentId: '849980',
  services: [{ name: 'translation', priceUsd: 2, unit: 'per doc' }],
}

test('a manifest exposes the ERC-8004 CAIP identity when anchored', () => {
  const m = buildAgentManifest(baseAgent, 539)
  assert.equal(m.agent.erc8004, 'eip155:5042002:8004/849980')
  assert.equal(m.agent.reputation, 539)
  assert.equal(m.protocol, 'a-identity/amp')
})

test('an un-anchored agent has a null erc8004 id (never a fake one)', () => {
  const m = buildAgentManifest({ ...baseAgent, onchain: 'queued', onchainAgentId: undefined }, 0)
  assert.equal(m.agent.erc8004, null)
})

test('only a verified agent is hireable in its manifest', () => {
  const verified = buildAgentManifest(baseAgent, 100)
  assert.equal(verified.agent.hireable, true)
  assert.ok(verified.hire, 'verified agent exposes a hire call')
  const unverified = buildAgentManifest({ ...baseAgent, kya: 'unverified' }, 100)
  assert.equal(unverified.agent.hireable, false)
  assert.equal(unverified.hire, null)
})

test('a manifest lists the agent services', () => {
  const m = buildAgentManifest(baseAgent, 100)
  assert.equal(m.services.length, 1)
  assert.equal(m.services[0].name, 'translation')
  assert.equal(m.services[0].priceUsd, 2)
})

// ── what a card may honestly say about an agent ─────────────────────────────────
//
// Both helpers exist to stop a marketplace card claiming more than the record does.
// agentChainIds answers "which networks is this agent actually on", and the only
// acceptable wrong answer is a short one: a chain we merely support, or an id the
// registry has no descriptor for, must never reach a card that would then draw a
// logo for it.

test('an agent claims its identity chain and every chain it has a vault on, once each', () => {
  const ids = agentChainIds({
    chain: 'arc',
    vaultChainCaip2: 'eip155:8453',
    vaults: [{ chainCaip2: 'eip155:42161' }, { chainCaip2: 'eip155:8453' }],
  })
  assert.deepEqual(ids, ['arc', 'base', 'arbitrum'])
  assert.equal(new Set(ids).size, ids.length, 'the same chain twice is one badge, not two')
})

test('a chain the registry does not describe is dropped, never handed to a card', () => {
  // A card draws a logo per id. An id with no descriptor has no logo and no name,
  // so passing it through would render a hole that looks like a broken agent.
  assert.deepEqual(agentChainIds({ chain: 'dogecoin' }), [])
  assert.deepEqual(
    agentChainIds({ chain: 'arc', vaultChainCaip2: 'eip155:999999' }),
    ['arc'],
    'one unknown vault chain must not cost the agent its real identity chain',
  )
})

test('an agent with no chain and no vault claims nothing', () => {
  assert.deepEqual(agentChainIds({}), [])
  assert.deepEqual(agentChainIds({ chain: '', vaults: [] }), [])
})

test('a service without its own copy says so, rather than borrowing someone else\'s', () => {
  assert.equal(serviceDescription({ name: 'Translate a page', description: 'Translates a page into French.' }), 'Translates a page into French.')
  assert.equal(serviceDescription({ name: 'Translate a page', description: '   ' }), null, 'blank is not copy')
  assert.equal(serviceDescription({ name: 'Translate a page', description: '' }), null)
  assert.equal(serviceDescription({ name: 'Translate a page' }), null)
})

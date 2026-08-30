import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
  taskFingerprint,
  openTaskCeiling,
  openTaskComplaint,
  agentQuotaComplaint,
  MAX_TASK_PRICE_USD,
  DEFAULT_DEADLINE_HOURS,
  MAX_DEADLINE_HOURS,
  OPEN_TASK_LIMIT_NEW,
  OPEN_TASK_LIMIT_ESTABLISHED,
  MAX_AGENTS_PER_OWNER,
  type TaskStatus,
  type Review,
  type ManifestAgent,
  type PosterStanding,
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

// ── the spam floor on posting an open task ───────────────────────────────────────
//
// Posting is the one free write on the marketplace: no gas, and no escrow until a bid is
// accepted. So these three bounds are the whole defence, and each block below carries its
// own negative control. Delete the guard a block names from openTaskComplaint and that
// block goes red, which is the only thing that keeps a rule a rule.

const goodDraft = { service: 'Translate a page', description: 'Translate this landing page into French.' }
const stranger: PosterStanding = { open: [], hasVerifiedAgent: false, released: 0 }

/** N distinct open tasks from one poster, each clearing the content bar on its own. */
function otherAsks(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `task_${i}`,
    service: `Service number ${i}`,
    description: `A distinct piece of work, number ${i}.`,
  }))
}

test('a real ask from a new poster clears the spam floor', () => {
  // The cold start this design refuses to break: a stranger with no history, no verified
  // agent and no released task can post, first try, with no gate to clear first.
  assert.equal(openTaskComplaint(goodDraft, stranger), null)
})

test('an ask nobody could bid on is refused, with a reason that names the bound', () => {
  const short = openTaskComplaint({ ...goodDraft, service: 'seo' }, stranger)
  assert.ok(short?.includes('service'), `a 3-character service must be refused, got: ${short}`)

  const bare = openTaskComplaint({ ...goodDraft, description: '' }, stranger)
  assert.ok(bare?.includes('description'), `an empty description is the "on a whim" post, got: ${bare}`)

  // Clearing the length bar by holding one key down is not a description.
  const filler = openTaskComplaint({ ...goodDraft, description: 'a'.repeat(60) }, stranger)
  assert.ok(filler?.includes('distinct'), `one repeated character is not content, got: ${filler}`)

  // Digits and punctuation are not words, in either field.
  assert.ok(openTaskComplaint({ service: '123456', description: goodDraft.description }, stranger))
  assert.ok(openTaskComplaint({ service: goodDraft.service, description: '12345678901234567890' }, stranger))
})

test('the content bar stays low enough for an honest terse ask', () => {
  // The bound must not be so high that a real, short task is refused: that teaches posters
  // to pad, which produces worse copy and costs a script nothing.
  assert.equal(openTaskComplaint({ service: 'Logo design', description: 'Need a simple logo for my app.' }, stranger), null)
})

test('the same ask posted twice is refused, and named as the duplicate it is', () => {
  const already = [{ id: 'task_1', service: goodDraft.service, description: goodDraft.description }]

  const again = openTaskComplaint(goodDraft, { ...stranger, open: already })
  assert.ok(again?.includes('task_1'), `a duplicate must name the task it duplicates, got: ${again}`)

  // Reformatting an ask must not launder it past the check: same words, different case and
  // spacing, is the same ask.
  const restyled = openTaskComplaint(
    { service: '  translate A page ', description: 'Translate  this landing page  into French.' },
    { ...stranger, open: already },
  )
  assert.ok(restyled?.includes('task_1'), `respacing must not defeat the dedup, got: ${restyled}`)

  // The control: a genuinely different ask from the same poster is NOT a duplicate.
  assert.equal(
    openTaskComplaint({ service: 'Translate a page', description: 'Translate this pricing page into German.' }, { ...stranger, open: already }),
    null,
  )
})

test('a fingerprint cannot be forged by hiding the separator inside a field', () => {
  assert.notEqual(taskFingerprint('a', 'b\nc'), taskFingerprint('a\nb', 'c'))
  assert.equal(taskFingerprint(' Translate  A Page ', 'Do it well'), taskFingerprint('translate a page', 'do it well'))
})

test('a stranger may hold a few open tasks at once, not a hundred', () => {
  // One below the ceiling: still fine. This is the control - if the ceiling were off by
  // one, or absent, this pair could not both hold.
  assert.equal(openTaskComplaint(goodDraft, { ...stranger, open: otherAsks(OPEN_TASK_LIMIT_NEW - 1) }), null)

  const full = openTaskComplaint(goodDraft, { ...stranger, open: otherAsks(OPEN_TASK_LIMIT_NEW) })
  assert.ok(full?.includes(String(OPEN_TASK_LIMIT_NEW)), `the refusal must name the limit, got: ${full}`)
  assert.ok(full?.includes('Accept a bid'), `the refusal must say what would clear it, got: ${full}`)
})

test('the ceiling rises only for a poster who did something a spammer cannot fake in bulk', () => {
  // A KYA verification is a wallet-control signature; a released task moved real money
  // through the ERC-8183 escrow. Neither is free, which is the entire point.
  assert.equal(openTaskCeiling({ hasVerifiedAgent: false, released: 0 }), OPEN_TASK_LIMIT_NEW)
  assert.equal(openTaskCeiling({ hasVerifiedAgent: true, released: 0 }), OPEN_TASK_LIMIT_ESTABLISHED)
  assert.equal(openTaskCeiling({ hasVerifiedAgent: false, released: 1 }), OPEN_TASK_LIMIT_ESTABLISHED)
  assert.ok(OPEN_TASK_LIMIT_ESTABLISHED > OPEN_TASK_LIMIT_NEW, 'the ladder has to go up, or it is not a ladder')
})

test('an established poster still has a ceiling, just a higher one', () => {
  // The graduation is a raise, not an exemption. Unbounded posting for anyone who once
  // released a task would be the same hole, one released task away.
  const full = openTaskComplaint(goodDraft, { open: otherAsks(OPEN_TASK_LIMIT_ESTABLISHED), hasVerifiedAgent: true, released: 9 })
  assert.ok(full?.includes(String(OPEN_TASK_LIMIT_ESTABLISHED)), `even a trusted poster is bounded, got: ${full}`)
})

test('one account may register agents up to a stated ceiling', () => {
  assert.equal(agentQuotaComplaint(0), null)
  assert.equal(agentQuotaComplaint(MAX_AGENTS_PER_OWNER - 1), null)
  const full = agentQuotaComplaint(MAX_AGENTS_PER_OWNER)
  assert.ok(full?.includes(String(MAX_AGENTS_PER_OWNER)), `the refusal must name the limit, got: ${full}`)
})

// ── the guards are wired, not merely written ─────────────────────────────────────
//
// Every assertion above is pure, and every one of them would stay green if the call site
// disappeared. These two read the source that writes the row and check it asks.

const srcFile = (rel: string) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')

test('postOpenTask runs the spam floor before it pushes a row', () => {
  const source = srcFile('platform/tasks.ts')
  const from = source.indexOf('export function postOpenTask')
  const to = source.indexOf('export function bidOnTask')
  assert.ok(from >= 0 && to > from, 'postOpenTask must still be in platform/tasks.ts, ahead of bidOnTask')
  const body = source.slice(from, to)
  assert.ok(body.includes('openTaskComplaint('), 'postOpenTask must call openTaskComplaint')
  assert.ok(
    body.indexOf('openTaskComplaint(') < body.indexOf('state.tasks.push'),
    'the check has to run BEFORE the row is pushed, or it is decoration',
  )
})

test('both agent-registration doors run the per-owner quota, not just one', () => {
  // POST /api/agents and POST /api/v1/agents/register write the same row. A guard on one
  // door only moves the spam to the other, so this names both files rather than one path.
  for (const file of ['http/agent-routes.ts', 'http/marketplace-routes.ts']) {
    assert.ok(
      srcFile(file).includes('agentQuotaComplaint('),
      `${file} must run the per-owner agent quota before it creates an agent`,
    )
  }
})

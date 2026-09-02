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
  accountTier,
  agentQuota,
  operatorAccounts,
  batchRegisterComplaint,
  feedbackComplaint,
  MAX_AGENTS_PER_OPERATOR,
  MAX_BATCH_REGISTER,
  MIN_FEEDBACK_COMMENT_CHARS,
  FEEDBACK_REWRITE_COOLDOWN_MS,
  OPERATOR_ACCOUNTS_ENV,
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

// ── account tiers: the ceiling is parametric, and only env can raise it ──────────
//
// The ceiling that is right for a person is wrong for someone running a fleet, and a fleet
// under a personal ceiling does not shrink, it splits across sock-puppet accounts. So the
// ceiling takes a tier. Who is in the operator tier is a PRODUCT DECISION nobody has made,
// which is why the only mechanism here is an env allowlist a human sets by hand.

const noEnv = {} as NodeJS.ProcessEnv
const withOperators = (list: string) => ({ [OPERATOR_ACCOUNTS_ENV]: list }) as NodeJS.ProcessEnv

test('the operator tier raises the same ceiling rather than removing it', () => {
  assert.equal(agentQuota('default'), MAX_AGENTS_PER_OWNER)
  assert.equal(agentQuota('operator'), MAX_AGENTS_PER_OPERATOR)
  assert.ok(MAX_AGENTS_PER_OPERATOR > MAX_AGENTS_PER_OWNER, 'the operator tier has to be a raise')
  // A raise, not an exemption: an operator that fills its fleet is still refused, by name.
  const full = agentQuotaComplaint(MAX_AGENTS_PER_OPERATOR, 'operator')
  assert.ok(full?.includes(String(MAX_AGENTS_PER_OPERATOR)), `the refusal must name the operator limit, got: ${full}`)
  assert.equal(agentQuotaComplaint(MAX_AGENTS_PER_OPERATOR - 1, 'operator'), null)
})

test('a default account is stopped at the ordinary ceiling even when operators exist', () => {
  // The env naming somebody else must not move anyone else's ceiling.
  assert.equal(accountTier('someone@else.test', withOperators('fleet@op.test')), 'default')
  assert.ok(agentQuotaComplaint(MAX_AGENTS_PER_OWNER, 'default')?.includes(String(MAX_AGENTS_PER_OWNER)))
  assert.equal(agentQuotaComplaint(MAX_AGENTS_PER_OWNER, 'operator'), null, 'the allowlisted account is the one that gets room')
})

test('with no allowlist set, nobody is an operator: a clean no-op, not a crash', () => {
  assert.deepEqual(operatorAccounts(noEnv), [])
  assert.deepEqual(operatorAccounts({ [OPERATOR_ACCOUNTS_ENV]: '' } as NodeJS.ProcessEnv), [])
  assert.deepEqual(operatorAccounts({ [OPERATOR_ACCOUNTS_ENV]: ' , ,, ' } as NodeJS.ProcessEnv), [])
  for (const env of [noEnv, { [OPERATOR_ACCOUNTS_ENV]: '' } as NodeJS.ProcessEnv, { [OPERATOR_ACCOUNTS_ENV]: ' , ,, ' } as NodeJS.ProcessEnv]) {
    assert.equal(accountTier('fleet@op.test', env), 'default')
    assert.equal(accountTier(undefined, env), 'default')
    assert.equal(accountTier('', env), 'default')
  }
})

test('only an account the allowlist actually names is an operator', () => {
  const env = withOperators(' Fleet@Op.test , 0xABCDEF ')
  // Case-folded and trimmed on both sides, so a session subject spelled differently still
  // matches the entry a human typed.
  assert.equal(accountTier('fleet@op.test', env), 'operator')
  assert.equal(accountTier('  FLEET@OP.TEST ', env), 'operator')
  assert.equal(accountTier('0xabcdef', env), 'operator')
  // And nothing near it counts: no prefix, suffix, or empty-string match.
  assert.equal(accountTier('fleet@op.test.evil', env), 'default')
  assert.equal(accountTier('leet@op.test', env), 'default')
  assert.equal(accountTier(undefined, env), 'default')
})

test('the tier defaults, so every existing call site keeps the ceiling it had', () => {
  assert.equal(agentQuotaComplaint(0), null)
  assert.equal(agentQuotaComplaint(MAX_AGENTS_PER_OWNER - 1), null)
  assert.ok(agentQuotaComplaint(MAX_AGENTS_PER_OWNER)?.includes(String(MAX_AGENTS_PER_OWNER)))
})

// ── bulk registration: an upper bound that refuses rather than trims ─────────────

test('a batch bigger than the limit is refused whole, and says so', () => {
  const over = batchRegisterComplaint(MAX_BATCH_REGISTER + 1)
  assert.ok(over, 'an oversized batch must be refused')
  assert.ok(over?.includes(String(MAX_BATCH_REGISTER)), `the refusal must name the limit, got: ${over}`)
  // The wording is load-bearing: a caller has to know nothing was written, because the
  // alternative reading (some of it was) is the silent truncation this rule exists to ban.
  assert.match(over ?? '', /Nothing in this request was registered/)
  assert.equal(batchRegisterComplaint(MAX_BATCH_REGISTER), null, 'exactly the limit is allowed')
})

test('an empty or nonsensical batch is refused before anything is written', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.ok(batchRegisterComplaint(bad), `a batch of ${bad} is not a batch`)
  }
  assert.equal(batchRegisterComplaint(1), null)
})

// ── the spam floor on rating an agent ────────────────────────────────────────────

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

test('a score outside 1..10 never becomes a row', () => {
  for (const bad of [0, 11, -3, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
    assert.ok(feedbackComplaint({ score: bad }, {}, NOW), `score ${String(bad)} must be refused`)
  }
  assert.equal(feedbackComplaint({ score: 1 }, {}, NOW), null)
  assert.equal(feedbackComplaint({ score: 10 }, {}, NOW), null)
})

test('a comment too short to say anything is refused, and rating without one still works', () => {
  const short = feedbackComplaint({ score: 8, comment: 'ok' }, {}, NOW)
  assert.ok(short?.includes(String(MIN_FEEDBACK_COMMENT_CHARS)), `the refusal must name the bound, got: ${short}`)
  assert.ok(feedbackComplaint({ score: 8, comment: '1234567890123' }, {}, NOW), 'digits alone are not a comment')
  // A star-only rating is a legitimate thing to leave and the console sends exactly that,
  // so the floor applies to a comment that is GIVEN, never to its absence.
  assert.equal(feedbackComplaint({ score: 8 }, {}, NOW), null)
  assert.equal(feedbackComplaint({ score: 8, comment: '   ' }, {}, NOW), null)
  assert.equal(feedbackComplaint({ score: 8, comment: 'Delivered exactly what was asked' }, {}, NOW), null)
})

test('one rater cannot rewrite the same rating in a loop', () => {
  // feed.ts already replaces a rater's previous row, so the average was never pumpable.
  // What kept growing is the write itself: an activity line per rewrite plus a full state
  // save. The cooldown is what stops that, so it is asserted on the write, not the average.
  const justNow = feedbackComplaint({ score: 9 }, { lastAt: iso(NOW - 1000) }, NOW)
  assert.ok(justNow, 'a rewrite one second later must be refused')
  assert.match(justNow ?? '', /already rated this agent/)
  const halfway = feedbackComplaint({ score: 9 }, { lastAt: iso(NOW - FEEDBACK_REWRITE_COOLDOWN_MS / 2) }, NOW)
  assert.ok(halfway, 'halfway through the cooldown is still inside it')
})

test('a rater whose cooldown has passed may correct their rating', () => {
  assert.equal(feedbackComplaint({ score: 9 }, { lastAt: iso(NOW - FEEDBACK_REWRITE_COOLDOWN_MS) }, NOW), null)
  assert.equal(feedbackComplaint({ score: 9 }, { lastAt: iso(NOW - FEEDBACK_REWRITE_COOLDOWN_MS * 10) }, NOW), null)
  // A first-ever rating has no previous entry, and an unparseable one is not a reason to
  // lock someone out of rating at all.
  assert.equal(feedbackComplaint({ score: 9 }, {}, NOW), null)
  assert.equal(feedbackComplaint({ score: 9 }, { lastAt: 'not a date' }, NOW), null)
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

test('every registration door reads the ceiling at the account tier, so none keeps its own', () => {
  // The point of a parametric ceiling is one rule at two heights. A door that called
  // agentQuotaComplaint without a tier would silently hold an allowlisted operator to a
  // person's ceiling, which is the drift this whole shape exists to prevent.
  for (const file of ['http/agent-routes.ts', 'http/marketplace-routes.ts']) {
    const source = srcFile(file)
    assert.ok(source.includes('accountTier('), `${file} must resolve the account tier`)
    assert.ok(
      source.includes('agentQuotaComplaint(') && /agentQuotaComplaint\([\s\S]{0,200}?,\s*tier\)/.test(source),
      `${file} must pass the tier into the quota rule, not call it bare`,
    )
  }
})

test('the bulk door reuses the single door rules rather than inventing its own', () => {
  const source = srcFile('http/marketplace-routes.ts')
  const from = source.indexOf("'/api/v1/agents/register/batch'")
  assert.ok(from > 0, 'the bulk registration route must still be in marketplace-routes.ts')
  const body = source.slice(from)
  // The size bound, the same per-owner ceiling, and the same row ledger. A second rule at
  // this door would make the batch a way around the first one.
  assert.ok(body.includes('batchRegisterComplaint('), 'the batch must bound its own size')
  assert.ok(body.includes('agentQuotaComplaint('), 'the batch must run the same per-owner quota')
  assert.ok(body.includes('chargeAgentCreate('), 'the batch must charge the same row budget the single doors charge')
  assert.ok(
    body.indexOf('agentQuotaComplaint(') < body.indexOf('registerExternalAgent('),
    'the checks have to run BEFORE the row is written, or they are decoration',
  )
})

test('the single registration doors charge the same row ledger the batch charges', () => {
  // Counting requests is only a limit while one request is one row. If the single doors
  // did not charge the row ledger, the batch would have an allowance all of its own.
  for (const file of ['http/agent-routes.ts', 'http/marketplace-routes.ts']) {
    assert.ok(
      srcFile(file).includes('chargeAgentCreate('),
      `${file} must charge the shared per-account row budget when it registers an agent`,
    )
  }
})

test('the feedback route runs the spam floor before it writes the row', () => {
  const source = srcFile('http/marketplace-routes.ts')
  const from = source.indexOf("req.method === 'POST' && url.pathname === '/api/marketplace/feedback'")
  assert.ok(from > 0, 'the feedback POST must still be in marketplace-routes.ts')
  const body = source.slice(from, source.indexOf("'/api/marketplace/semantic-search'"))
  assert.ok(body.includes('feedbackComplaint('), 'the feedback POST must run the per-rater floor')
  assert.ok(
    body.indexOf('feedbackComplaint(') < body.indexOf('addAgentFeedback('),
    'the floor has to run BEFORE the row is written, or it is decoration',
  )
})

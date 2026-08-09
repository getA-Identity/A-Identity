import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPlatformStateForTests,
  createAgent,
  createInstruction,
  countRecentActions,
  evaluateSpendPreflight,
  sanitizeVelocity,
  spendPreflight,
  updateAgentPermissions,
  type Instruction,
  type Permissions,
  type PlatformAgent,
} from './platform.js'

// Persistence is OFF for this whole process from the first line: these tests seed the
// in-memory state and must never overwrite the real persisted dev state.
__resetPlatformStateForTests()

const OWNER = 'owner@test'

/** Default permissions matching createAgent's defaults, overridable per test. */
function perms(over: Partial<Permissions> = {}): Permissions {
  return {
    dailyCapUsd: 50,
    autoApproveUnderUsd: 1,
    payeeAllowlist: [],
    agentToAgent: true,
    agentToHuman: false,
    frozen: false,
    ...over,
  }
}

const check = (i: {
  permissions?: Permissions
  spentTodayUsd?: number
  recentActions?: number
  amountUsd?: number
  count?: number
  payee?: string
} = {}) =>
  evaluateSpendPreflight({
    permissions: i.permissions ?? perms(),
    spentTodayUsd: i.spentTodayUsd ?? 0,
    recentActions: i.recentActions,
    amountUsd: i.amountUsd ?? 0.5,
    count: i.count,
    payee: i.payee ?? 'agent://helper',
  })

function seedAgent(over: Partial<Permissions> = {}): PlatformAgent {
  return createAgent({
    name: 'Preflight Test Agent',
    description: 'Seeded for spend preflight tests.',
    category: 'Research',
    capabilities: [],
    permissions: over,
    owner: OWNER,
  })
}

let ixSeq = 0
function mkIx(agentId: string, status: Instruction['status'], createdAt: string, count = 1): Instruction {
  ixSeq += 1
  return {
    id: `ix_preflight_${ixSeq}`,
    agentId,
    type: 'payment',
    amountUsd: 0.5,
    count,
    payee: 'agent://helper',
    memo: '',
    status,
    policyNote: 'seeded',
    createdAt,
  }
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

// ── the pure evaluator: happy path ───────────────────────────────────────────────

test('an in-policy spend is ALLOWed and would auto-approve', () => {
  const d = check()
  assert.equal(d.verdict, 'ALLOW')
  assert.equal(d.wouldBeStatus, 'auto_approved')
  assert.deepEqual(d.codes, [])
  assert.equal(d.vaultError, null)
  assert.equal(d.needsHumanApproval, false)
  assert.equal(d.totalUsd, 0.5)
  assert.equal(d.headroom.remainingTodayUsd, 50)
  assert.equal(d.velocity, null)
})

test('the same inputs always produce the same preflight', () => {
  assert.deepEqual(check(), check())
})

// ── caps and ceiling ─────────────────────────────────────────────────────────────

test('an exhausted daily cap pauses the spend and reports the real headroom', () => {
  const d = check({ spentTodayUsd: 45, amountUsd: 10 })
  assert.equal(d.verdict, 'WARN')
  assert.equal(d.wouldBeStatus, 'pending_approval')
  assert.equal(d.codes[0], 'daily_cap_exceeded')
  assert.equal(d.vaultError, 'DailyCapExceeded')
  assert.equal(d.headroom.spentTodayUsd, 45)
  assert.equal(d.headroom.remainingTodayUsd, 5)
  assert.match(d.policyNote, /Would exceed today's cap/)
})

test('above the auto-approve ceiling waits for a human', () => {
  const d = check({ amountUsd: 5 })
  assert.equal(d.verdict, 'WARN')
  assert.deepEqual(d.codes, ['above_auto_approve'])
  assert.equal(d.vaultError, 'AboveAutoApprove')
  assert.equal(d.needsHumanApproval, true)
})

test('every triggered rule is reported, decisive first', () => {
  // Over the cap AND over the ceiling: the cap is decisive (ladder order), the ceiling
  // is still listed so a caller can plan past the first blocker.
  const d = check({ spentTodayUsd: 49, amountUsd: 10 })
  assert.deepEqual(d.codes, ['daily_cap_exceeded', 'above_auto_approve'])
  assert.equal(d.vaultError, 'DailyCapExceeded')
})

test('a batch is priced at amount x count, exactly like the real path', () => {
  const d = check({ amountUsd: 0.5, count: 4 })
  assert.equal(d.totalUsd, 2)
  assert.equal(d.count, 4)
  assert.equal(d.verdict, 'WARN') // 2 > the $1 auto-approve line
  assert.deepEqual(d.codes, ['above_auto_approve'])
})

// ── allowlist, freeze, payee type ────────────────────────────────────────────────

test('a payee off the allowlist pauses; one on it auto-approves', () => {
  const p = perms({ payeeAllowlist: ['agent://helper'] })
  const off = check({ permissions: p, payee: 'agent://stranger' })
  assert.equal(off.verdict, 'WARN')
  assert.deepEqual(off.codes, ['payee_not_allowed'])
  assert.equal(off.vaultError, 'PayeeNotAllowed')
  assert.equal(off.payeeAllowlisted, false)
  const on = check({ permissions: p, payee: 'agent://helper' })
  assert.equal(on.verdict, 'ALLOW')
  assert.equal(on.payeeAllowlisted, true)
})

test('frozen pauses everything and names the vault error', () => {
  const d = check({ permissions: perms({ frozen: true }) })
  assert.equal(d.verdict, 'WARN')
  assert.equal(d.codes[0], 'frozen')
  assert.equal(d.vaultError, 'IsFrozen')
  assert.equal(d.frozen, true)
})

test('a 0x payee is gated by the agent-to-human toggle (server-only rule)', () => {
  const d = check({ payee: '0x000000000000000000000000000000000000dEaD' })
  assert.equal(d.verdict, 'WARN')
  assert.deepEqual(d.codes, ['payee_type_blocked'])
  assert.equal(d.vaultError, null)
  assert.match(d.policyNote, /Agent-to-human/)
})

// ── garbage in ───────────────────────────────────────────────────────────────────

test('NaN, negative and infinite amounts are DENYed with no would-be status', () => {
  for (const amountUsd of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    const d = check({ amountUsd })
    assert.equal(d.verdict, 'DENY')
    assert.equal(d.wouldBeStatus, null)
    assert.deepEqual(d.codes, ['invalid_amount'])
  }
})

// ── D3 velocity in the pure evaluator ────────────────────────────────────────────

const VEL = perms({ velocity: { maxActions: 3, windowMinutes: 10 } })

test('under the velocity limit the spend still auto-approves', () => {
  const d = check({ permissions: VEL, recentActions: 2 })
  assert.equal(d.verdict, 'ALLOW')
  assert.deepEqual(d.velocity, { maxActions: 3, windowMinutes: 10, recentActions: 2, remainingActions: 1 })
})

test('at the velocity limit the spend is DENYed with the typed reason', () => {
  const d = check({ permissions: VEL, recentActions: 3 })
  assert.equal(d.verdict, 'DENY')
  assert.equal(d.wouldBeStatus, 'rejected')
  assert.equal(d.codes[0], 'velocity_exceeded')
  assert.equal(d.velocity?.remainingActions, 0)
  assert.match(d.policyNote, /velocity_exceeded/)
})

test('a batch cannot step around the velocity window', () => {
  const d = check({ permissions: VEL, recentActions: 1, count: 3 })
  assert.equal(d.verdict, 'DENY') // 1 + 3 > 3
  assert.equal(d.codes[0], 'velocity_exceeded')
})

test('the velocity DENY outranks the pauses', () => {
  const d = check({ permissions: perms({ frozen: true, velocity: { maxActions: 1, windowMinutes: 10 } }), recentActions: 1 })
  assert.equal(d.verdict, 'DENY')
  assert.deepEqual(d.codes, ['velocity_exceeded', 'frozen'])
})

test('with no velocity policy, recent activity changes nothing', () => {
  const d = check({ recentActions: 10_000 })
  assert.equal(d.verdict, 'ALLOW')
  assert.equal(d.velocity, null)
})

// ── D3 window counting ───────────────────────────────────────────────────────────

test('the window counts only settled or approved rows for the right agent', () => {
  const rows = [
    mkIx('a', 'auto_approved', minutesAgo(1)),
    mkIx('a', 'approved', minutesAgo(2)),
    mkIx('a', 'executed_onchain', minutesAgo(3)),
    mkIx('a', 'executed_simulated', minutesAgo(4)),
    mkIx('a', 'pending_approval', minutesAgo(1)), // never cleared to move: not counted
    mkIx('a', 'rejected', minutesAgo(1)), // a denied burst must not extend its own lockout
    mkIx('b', 'auto_approved', minutesAgo(1)), // someone else's agent
  ]
  assert.equal(countRecentActions(rows, 'a', 10), 4)
})

test('the window frees itself: old activity ages out', () => {
  const rows = [mkIx('a', 'auto_approved', minutesAgo(11)), mkIx('a', 'auto_approved', minutesAgo(9))]
  assert.equal(countRecentActions(rows, 'a', 10), 1)
  assert.equal(countRecentActions(rows, 'a', 60), 2)
})

test('a batch instruction counts as its full action count', () => {
  const rows = [mkIx('a', 'auto_approved', minutesAgo(1), 5)]
  assert.equal(countRecentActions(rows, 'a', 10), 5)
})

// ── the config sanitizer ─────────────────────────────────────────────────────────

test('a well-formed velocity config is normalized to exactly two fields', () => {
  assert.deepEqual(sanitizeVelocity({ maxActions: 3, windowMinutes: 10, extra: true }), {
    maxActions: 3,
    windowMinutes: 10,
  })
  assert.deepEqual(sanitizeVelocity({ maxActions: 10_000, windowMinutes: 1_440 }), {
    maxActions: 10_000,
    windowMinutes: 1_440,
  })
})

test('null clears; garbage is refused', () => {
  assert.equal(sanitizeVelocity(null), null)
  for (const bad of [
    undefined,
    'fast',
    5,
    [],
    {},
    { maxActions: 3 }, // missing window
    { maxActions: Number.NaN, windowMinutes: 10 },
    { maxActions: 0, windowMinutes: 10 },
    { maxActions: -1, windowMinutes: 10 },
    { maxActions: 2.5, windowMinutes: 10 },
    { maxActions: Number.POSITIVE_INFINITY, windowMinutes: 10 },
    { maxActions: 10_001, windowMinutes: 10 }, // out of bounds
    { maxActions: 3, windowMinutes: 1_441 }, // out of bounds
    { maxActions: '3', windowMinutes: 10 }, // no string coercion
  ]) {
    assert.equal(sanitizeVelocity(bad), undefined, `should refuse ${JSON.stringify(bad)}`)
  }
})

// ── the stateful dry-run: read-only, owner-gated, and honest ─────────────────────

test('spendPreflight mutates nothing and predicts exactly what createInstruction does', () => {
  const state = __resetPlatformStateForTests()
  const agent = seedAgent()
  const activityBefore = agent.activity.length

  const preview = spendPreflight(agent.id, { amountUsd: 0.5, payee: 'agent://helper' }, OWNER)
  assert.ok(!('error' in preview))
  assert.equal(preview.preview, true)
  assert.equal(preview.verdict, 'ALLOW')

  // Read-only by contract: no instruction, no spend commit, no activity, no audit.
  assert.equal(state.instructions.length, 0)
  assert.equal(agent.spentTodayUsd ?? 0, 0)
  assert.equal(agent.activity.length, activityBefore)
  assert.deepEqual(state.audits, {})

  // Parity: the real path lands on the very status and note the preview promised.
  const ix = createInstruction({ agentId: agent.id, type: 'payment', amountUsd: 0.5, payee: 'agent://helper', caller: OWNER })
  assert.ok(!('error' in ix))
  assert.equal(ix.status, preview.wouldBeStatus)
  assert.equal(ix.policyNote, preview.policyNote)
})

test('the dry-run is owner-gated like its neighbors', () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  const stranger = spendPreflight(agent.id, { amountUsd: 0.5, payee: 'agent://helper' }, 'stranger@test')
  assert.deepEqual(stranger, { error: 'Forbidden: not the agent owner' })
  const missing = spendPreflight('agent_none', { amountUsd: 0.5, payee: 'agent://helper' }, OWNER)
  assert.deepEqual(missing, { error: 'Unknown agent' })
})

test('the dry-run sees the same velocity state the real path enforces', () => {
  __resetPlatformStateForTests()
  const agent = seedAgent({ velocity: { maxActions: 1, windowMinutes: 10 } })
  const first = createInstruction({ agentId: agent.id, type: 'payment', amountUsd: 0.5, payee: 'agent://helper', caller: OWNER })
  assert.ok(!('error' in first) && first.status === 'auto_approved')
  const preview = spendPreflight(agent.id, { amountUsd: 0.5, payee: 'agent://helper' }, OWNER)
  assert.ok(!('error' in preview))
  assert.equal(preview.verdict, 'DENY')
  assert.equal(preview.codes[0], 'velocity_exceeded')
})

// ── D3 enforced end to end on the real path ──────────────────────────────────────

test('a burst past the velocity limit is rejected with the typed deny code', () => {
  const state = __resetPlatformStateForTests()
  const agent = seedAgent({ velocity: { maxActions: 2, windowMinutes: 10 } })
  const pay = () =>
    createInstruction({ agentId: agent.id, type: 'payment', amountUsd: 0.5, payee: 'agent://helper', caller: OWNER })

  const one = pay()
  const two = pay()
  assert.ok(!('error' in one) && one.status === 'auto_approved')
  assert.ok(!('error' in two) && two.status === 'auto_approved')

  const three = pay()
  assert.ok(!('error' in three))
  assert.equal(three.status, 'rejected')
  assert.equal(three.denyCode, 'velocity_exceeded')
  // The deny is audited like the rest of the trail: a record with an honest note, and
  // nothing committed against the cap.
  assert.match(three.policyNote, /velocity_exceeded/)
  assert.equal(agent.spentTodayUsd, 1)
  assert.equal(state.instructions.length, 3)

  // Window expiry frees it: age the settled burst out of the window.
  for (const ix of state.instructions) ix.createdAt = minutesAgo(11)
  const four = pay()
  assert.ok(!('error' in four))
  assert.equal(four.status, 'auto_approved')
})

test('without the velocity field, a burst behaves exactly as before', () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()
  for (let i = 0; i < 5; i += 1) {
    const ix = createInstruction({ agentId: agent.id, type: 'payment', amountUsd: 0.5, payee: 'agent://helper', caller: OWNER })
    assert.ok(!('error' in ix))
    assert.equal(ix.status, 'auto_approved')
    assert.equal(ix.denyCode, undefined)
  }
})

// ── the policy update endpoint path ──────────────────────────────────────────────

test('velocity is settable, survives invalid patches, and null clears it', async () => {
  __resetPlatformStateForTests()
  const agent = seedAgent()

  const set = await updateAgentPermissions(agent.id, { velocity: { maxActions: 2, windowMinutes: 10 } }, OWNER)
  assert.ok(!('error' in set))
  assert.deepEqual(agent.permissions.velocity, { maxActions: 2, windowMinutes: 10 })

  // An invalid patch is dropped, leaving the configured breaker in place.
  await updateAgentPermissions(agent.id, { velocity: { maxActions: Number.NaN, windowMinutes: 10 } }, OWNER)
  assert.deepEqual(agent.permissions.velocity, { maxActions: 2, windowMinutes: 10 })
  await updateAgentPermissions(agent.id, { velocity: 'unlimited' as never }, OWNER)
  assert.deepEqual(agent.permissions.velocity, { maxActions: 2, windowMinutes: 10 })

  // An explicit null is the owner clearing the breaker.
  const cleared = await updateAgentPermissions(agent.id, { velocity: null }, OWNER)
  assert.ok(!('error' in cleared))
  assert.equal(agent.permissions.velocity, null)
  const after = createInstruction({ agentId: agent.id, type: 'payment', amountUsd: 0.5, payee: 'agent://helper', caller: OWNER })
  assert.ok(!('error' in after))
  assert.equal(after.status, 'auto_approved')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GuardConfigError,
  assertNoAmbientLiveWrite,
  classifyTool,
  createGuard,
  intentFromPreview,
} from '../src/guard.js'
import { CALLERS, defaultCaller, getCaller, supportedCallers } from '../src/callers.js'
import { DEFAULT_POLICY, DISCLOSURE, INVARIANTS, enforcementNote } from '../src/defaults.js'

/**
 * The bypass suite. Every case is an attempt to reach the venue without a verdict, and the
 * expected result is always the same: NO UNCHECKED LIVE WRITE.
 *
 * Numbering follows docs/robinhood-intent-capture.md so a scenario in the spec maps to a
 * test here. No account, no network, no fabricated market data: the venue is a spy.
 */

const community = getCaller('robinhood-community-cli')
const official = getCaller('robinhood-official-mcp')

const SNAPSHOT = { todayNotionalUsd: 0, positions: [], portfolioValueUsd: 5000, cashAvailableUsd: 5000, marginUsedUsd: 0 }

/** A venue that records what it was asked to do and with which environment. */
function venue() {
  const calls = []
  return {
    calls,
    execute: async ({ tool, args, env }) => {
      calls.push({ tool, args, live: env?.ROBINHOOD_ALLOW_LIVE_WRITE === '1' })
      return { orderId: 'ord_1' }
    },
    /** Writes that actually went live, i.e. the thing we must never allow unchecked. */
    liveWrites: () => calls.filter((c) => c.live),
  }
}

function build(over = {}) {
  const v = over.venue ?? venue()
  const checks = []
  const outcomes = []
  const guard = createGuard({
    caller: over.caller ?? community,
    check: async (input) => {
      checks.push(input)
      // `in` rather than ??, so a test can pass a null/undefined decision deliberately and
      // actually exercise the guard instead of silently getting the ALLOW default.
      return 'decision' in over ? over.decision : { verdict: 'ALLOW', reasons: [], codes: [], auditId: 'aud_1' }
    },
    readSnapshot: async () => over.snapshot ?? SNAPSHOT,
    execute: v.execute,
    preview: over.preview ?? (async ({ args }) => args.preview ?? null),
    confirmHuman: over.confirmHuman,
    recordOutcome: async (id, outcome, ref) => outcomes.push({ id, outcome, ref }),
    env: over.env ?? {},
    options: over.options,
  })
  return { guard, venue: v, checks, outcomes }
}

const ORDER = { kind: 'order', side: 'buy', symbol: 'AAPL', assetClass: 'equity', notionalUsd: 50 }
const buy = (preview = ORDER) => ({ tool: 'robinhood_buy', args: { preview } })

// ── 1. a write without ever asking for a verdict ─────────────────────────────────

test('1: every write-class call is checked before it can execute', async () => {
  const { guard, checks, venue: v } = build()
  await guard.run(buy())
  assert.equal(checks.length, 1, 'the guard must consult the policy')
  assert.equal(v.calls.length, 1)
  assert.equal(v.liveWrites().length, 1, 'an ALLOW may execute')
})

// ── 2. the agent ignores a DENY and calls anyway ──────────────────────────────────

test('2: a DENY never executes, and repeating the call never executes either', async () => {
  const { guard, venue: v, outcomes } = build({
    decision: { verdict: 'DENY', reasons: ['over the cap'], codes: ['PER_ACTION_CAP'], auditId: 'aud_d' },
  })
  for (let i = 0; i < 5; i++) {
    const r = await guard.run(buy())
    assert.equal(r.executed, false)
  }
  assert.equal(v.calls.length, 0, 'the venue was never called')
  assert.equal(v.liveWrites().length, 0)
  assert.deepEqual([...new Set(outcomes.map((o) => o.outcome))], ['blocked'])
})

// ── 3. the agent sets the live-write switch itself ────────────────────────────────

test('3: the guard refuses to run when the live-write switch is already in the environment', () => {
  // If the switch is ambient, this process cannot withhold it, so the veto the user thinks
  // they have does not exist. Refusing loudly beats running while implying protection.
  for (const value of ['1', 'true', 'yes']) {
    assert.throws(
      () => build({ env: { ROBINHOOD_ALLOW_LIVE_WRITE: value } }),
      GuardConfigError,
      `ambient value ${value} must be refused`,
    )
  }
})

test('3b: an unset, empty or explicitly disabled switch is fine', () => {
  for (const env of [{}, { ROBINHOOD_ALLOW_LIVE_WRITE: '' }, { ROBINHOOD_ALLOW_LIVE_WRITE: '0' }]) {
    assert.doesNotThrow(() => build({ env }))
  }
})

test('3c: the switch is granted per command and never leaks into the base environment', async () => {
  const env = {}
  const { guard, venue: v } = build({ env })
  await guard.run(buy())
  assert.equal(v.calls[0].live, true, 'the approved command got the switch')
  assert.equal(env.ROBINHOOD_ALLOW_LIVE_WRITE, undefined, 'the base environment was not mutated')
})

test('3d: a denied command is never handed the switch', async () => {
  const { guard, venue: v } = build({
    decision: { verdict: 'DENY', reasons: ['no'], codes: ['X'], auditId: 'a' },
  })
  await guard.run(buy())
  assert.equal(v.calls.length, 0)
})

// ── 4 and 12. an unknown tool is write-class ──────────────────────────────────────

test('4: a tool the registry has never heard of is treated as a write', () => {
  assert.equal(classifyTool(community, 'robinhood_some_new_thing'), 'write')
  assert.equal(classifyTool(community, 'raw_cli_invocation'), 'write')
})

test('12: an upstream update that adds a write tool cannot open an unguarded path', async () => {
  const { guard, checks, venue: v } = build()
  await guard.run({ tool: 'robinhood_brand_new_write', args: { preview: ORDER } })
  assert.equal(checks.length, 1, 'the unknown tool was still checked')
  assert.equal(v.calls.length, 1)
})

test('reads pass through without a verdict, because the snapshot depends on them', async () => {
  const { guard, checks, venue: v } = build()
  const r = await guard.run({ tool: 'robinhood_positions', args: {} })
  assert.equal(r.guarded, false)
  assert.equal(checks.length, 0)
  assert.equal(v.calls.length, 1)
})

// ── 6. structuring: many small actions instead of one big one ─────────────────────

test('6: each slice is checked, so the daily cap can catch structuring', async () => {
  // The guard cannot itself know the cumulative total; its job is to make sure every slice
  // reaches the policy with the current snapshot, which is what lets the daily cap bite.
  const { guard, checks } = build()
  for (let i = 0; i < 4; i++) await guard.run(buy({ ...ORDER, notionalUsd: 40 }))
  assert.equal(checks.length, 4)
  for (const c of checks) assert.ok(c.snapshot, 'every check carried a snapshot')
})

// ── 8. a falsified snapshot ───────────────────────────────────────────────────────

test('8: an agent-supplied snapshot is discarded and the real one is gathered', async () => {
  const lie = { todayNotionalUsd: 0, positions: [], portfolioValueUsd: 1e9, cashAvailableUsd: 1e9 }
  const { guard, checks } = build()
  await guard.run({ tool: 'robinhood_buy', args: { preview: ORDER, snapshot: lie } })
  assert.equal(checks[0].snapshot.cashAvailableUsd, SNAPSHOT.cashAvailableUsd)
  assert.notEqual(checks[0].snapshot.portfolioValueUsd, 1e9)
})

test('8b: the forged snapshot never reaches the venue either', async () => {
  const { guard, venue: v } = build()
  await guard.run({ tool: 'robinhood_buy', args: { preview: ORDER, snapshot: { cashAvailableUsd: 1e9 } } })
  assert.equal(v.calls[0].args.snapshot, undefined)
})

// ── 9. non-order paths: recurring orders and settings ─────────────────────────────

test('9: a recurring order and a settings toggle are both checked as actions', async () => {
  const { guard, checks } = build()
  await guard.run({
    tool: 'robinhood_recurring_create',
    args: { preview: { kind: 'recurring', side: 'buy', symbol: 'AAPL', notionalUsd: 25, cadence: 'weekly' } },
  })
  await guard.run({
    tool: 'robinhood_settings',
    args: { preview: { kind: 'settings', settingKey: 'stock_lending', settingValue: true, notionalUsd: 0 } },
  })
  assert.deepEqual(checks.map((c) => c.intent.kind), ['recurring', 'settings'])
})

test('9b: the action kind is inferred from the tool when a preview omits it', () => {
  assert.equal(intentFromPreview('robinhood_recurring_create', { notionalUsd: 5 }).kind, 'recurring')
  assert.equal(intentFromPreview('robinhood_transfer', { notionalUsd: 5 }).kind, 'transfer')
  assert.equal(intentFromPreview('robinhood_documents_download', { notionalUsd: 0 }).kind, 'document')
  assert.equal(intentFromPreview('robinhood_cancel', { notionalUsd: 0 }).kind, 'cancel')
  assert.equal(intentFromPreview('place_equity_order', { notionalUsd: 5 }).kind, 'order')
})

// ── 10. cancelling protective cover ───────────────────────────────────────────────

test('10: a protective cancel is passed through as protective, not as a neutral act', async () => {
  const { guard, checks } = build()
  await guard.run({
    tool: 'robinhood_cancel',
    args: { preview: { kind: 'cancel', symbol: 'AAPL', notionalUsd: 0, protective: true } },
  })
  assert.equal(checks[0].intent.protective, true)
})

// ── 11 and the preview rule ───────────────────────────────────────────────────────

test('11: the checked amount comes from the preview, not from the agent prose', async () => {
  // "buy a little AAPL" that renders as 400 shares at $190 must be checked as $76,000.
  const { guard, checks } = build()
  await guard.run({ tool: 'robinhood_buy', args: { preview: { kind: 'order', side: 'buy', symbol: 'AAPL', quantity: 400, limitPrice: 190 } } })
  assert.equal(checks[0].intent.notionalUsd, 76_000)
})

test('an unreadable preview is DENYed, never guessed at', async () => {
  const { guard, venue: v, checks } = build()
  for (const bad of [null, undefined, {}, { kind: 'order' }, 'nonsense']) {
    const r = await guard.run({ tool: 'robinhood_buy', args: { preview: bad } })
    assert.equal(r.executed, false, JSON.stringify(bad))
    assert.equal(r.decision.verdict, 'DENY')
    assert.ok(r.decision.codes.includes('PREVIEW_UNREADABLE'))
  }
  assert.equal(v.calls.length, 0)
  assert.equal(checks.length, 0, 'nothing was even sent for a verdict')
})

test('a negative or non-numeric amount is refused', async () => {
  const { guard } = build()
  for (const n of [-1, NaN, Infinity, 'ten']) {
    const r = await guard.run(buy({ kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: n }))
    assert.equal(r.executed, false, String(n))
  }
})

// ── WARN needs a human, and auto-execute is off ───────────────────────────────────

const WARN = { verdict: 'WARN', reasons: ['above the approval line'], codes: ['HUMAN_APPROVAL'], auditId: 'aud_w' }

test('a WARN does not execute by default', async () => {
  const { guard, venue: v, outcomes } = build({ decision: WARN })
  const r = await guard.run(buy())
  assert.equal(r.executed, false)
  assert.equal(r.awaitingHuman, true)
  assert.equal(v.calls.length, 0)
  assert.equal(outcomes[0].outcome, 'awaiting_human')
})

test('a WARN executes only when a human actually confirms', async () => {
  const { guard, venue: v, outcomes } = build({ decision: WARN, confirmHuman: async () => true })
  const r = await guard.run(buy())
  assert.equal(r.executed, true)
  assert.equal(v.liveWrites().length, 1)
  assert.equal(outcomes[0].outcome, 'executed')
  assert.equal(outcomes[0].ref, 'ord_1', 'the venue reference is recorded as evidence')
})

test('auto-execute is opt-in and applies to WARN only, never to DENY', async () => {
  const warn = build({ decision: WARN, options: { autoExecuteOnWarn: true } })
  assert.equal((await warn.guard.run(buy())).executed, true)

  const deny = build({
    decision: { verdict: 'DENY', reasons: ['no'], codes: ['X'], auditId: 'a' },
    options: { autoExecuteOnWarn: true },
    confirmHuman: async () => true,
  })
  const r = await deny.guard.run(buy())
  assert.equal(r.executed, false, 'auto-execute must never satisfy a DENY')
  assert.equal(deny.venue.calls.length, 0)
})

test('a human confirming does not turn a DENY into an execution', async () => {
  const { guard, venue: v } = build({
    decision: { verdict: 'DENY', reasons: ['no'], codes: ['X'], auditId: 'a' },
    confirmHuman: async () => true,
  })
  assert.equal((await guard.run(buy())).executed, false)
  assert.equal(v.calls.length, 0)
})

// ── a broken policy service is a refusal, not a pass ──────────────────────────────

test('an unreadable verdict fails closed', async () => {
  for (const decision of [{}, { verdict: 'MAYBE' }, { verdict: null }, null]) {
    const { guard, venue: v } = build({ decision })
    const r = await guard.run(buy())
    assert.equal(r.executed, false, JSON.stringify(decision))
    assert.equal(r.decision.verdict, 'DENY')
    assert.equal(v.calls.length, 0)
  }
})

// ── every outcome carries the disclosure ──────────────────────────────────────────

test('every guarded result carries the not-investment-advice disclosure', async () => {
  for (const decision of [
    { verdict: 'ALLOW', auditId: 'a', reasons: [], codes: [] },
    WARN,
    { verdict: 'DENY', reasons: ['no'], codes: ['X'], auditId: 'a' },
  ]) {
    const { guard } = build({ decision })
    const r = await guard.run(buy())
    assert.equal(r.disclosure, DISCLOSURE)
  }
  assert.ok(DISCLOSURE.includes('Not investment advice'))
  assert.ok(DISCLOSURE.includes('never holds your venue credentials'))
})

// ── the invariants and the defaults ───────────────────────────────────────────────

test('the invariants say plainly what cannot be changed', () => {
  assert.equal(INVARIANTS.allowMargin, false)
  assert.equal(INVARIANTS.denyIsFinal, true)
  assert.equal(INVARIANTS.autoExecuteOnWarn, false)
  assert.equal(INVARIANTS.holdsVenueCredentials, false)
  assert.equal(INVARIANTS.acceptsAgentSuppliedSnapshot, false)
  assert.ok(Object.isFrozen(INVARIANTS), 'the invariants must not be mutable at runtime')
})

test('the default policy is safe before the user configures anything', () => {
  assert.equal(DEFAULT_POLICY.trade.allowOptions, false)
  assert.equal(DEFAULT_POLICY.humanApprovalAboveUsd, 100)
  assert.ok(DEFAULT_POLICY.perActionCapUsd <= 100)
  assert.equal(DEFAULT_POLICY.frozen, false)
  assert.ok(Object.isFrozen(DEFAULT_POLICY))
  assert.equal('allowMargin' in DEFAULT_POLICY.trade, false, 'margin is not offered as a setting at all')
})

// ── tool-agnostic by construction ─────────────────────────────────────────────────

test('the official sanctioned MCP is the default caller', () => {
  const d = defaultCaller()
  assert.equal(d.id, 'robinhood-official-mcp')
  assert.equal(d.status, 'supported')
  assert.deepEqual(supportedCallers().map((c) => c.id), ['robinhood-official-mcp'])
})

test('the unofficial caller is opt-in and says why', () => {
  assert.equal(community.status, 'opt-in')
  assert.equal(community.default, false)
  assert.ok(community.notes.includes('NOT affiliated'))
  assert.ok(community.notes.includes('terms may prohibit'))
})

test('the guard works against a caller with no live-write switch', async () => {
  // Tool-agnostic means the official rail must be drivable even though it has no switch.
  const { guard, venue: v, checks } = build({ caller: official })
  const r = await guard.run({ tool: 'place_equity_order', args: { preview: ORDER } })
  assert.equal(checks.length, 1)
  assert.equal(r.executed, true)
  assert.equal(v.calls[0].live, false, 'no switch exists to grant, and none is invented')
})

test('a DENY still blocks on a caller with no switch', async () => {
  const { guard, venue: v } = build({
    caller: official,
    decision: { verdict: 'DENY', reasons: ['no'], codes: ['X'], auditId: 'a' },
  })
  assert.equal((await guard.run({ tool: 'place_equity_order', args: { preview: ORDER } })).executed, false)
  assert.equal(v.calls.length, 0)
})

test('enforcement strength is stated honestly per caller, not claimed uniformly', () => {
  const strong = enforcementNote(community)
  const weak = enforcementNote(official)
  assert.notEqual(strong, weak)
  assert.ok(strong.includes('Process-level'))
  assert.ok(weak.includes('Wrapper-level'))
  assert.ok(
    weak.includes('cannot contain'),
    'the weaker path must admit what it cannot do',
  )
})

test('assertNoAmbientLiveWrite is a no-op for a caller without a switch', () => {
  assert.doesNotThrow(() => assertNoAmbientLiveWrite(official, { ROBINHOOD_ALLOW_LIVE_WRITE: '1' }))
})

test('the registry declares exactly one default and no read/write overlap', () => {
  assert.equal(CALLERS.filter((c) => c.default).length, 1)
  for (const c of CALLERS) {
    assert.equal(c.readTools.filter((t) => c.writeTools.includes(t)).length, 0, c.id)
  }
})

// ── bypass 5: the honest limit ────────────────────────────────────────────────────

test('bypass 5 is documented as a limit, not silently claimed as covered', async () => {
  // An agent with a shell AND the venue credential can reach the API directly, past this
  // skill entirely. Nothing here can stop that, and the docs must say so.
  const { readFileSync } = await import('node:fs')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(
    readme.toLowerCase().includes('cannot contain an agent'),
    'README must state the containment limit plainly',
  )
})

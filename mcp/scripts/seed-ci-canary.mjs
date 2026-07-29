/**
 * Exercise the guardrail engine against a live backend with a CI-flagged agent.
 *
 *   BASE=https://a-identity-backend.onrender.com \
 *   TOKEN=<a verified session token> \
 *   CONFIRM=yes \
 *   node scripts/seed-ci-canary.mjs
 *
 * Why the agent is flagged `ci`, and why that is the whole point: every decision it produces
 * is recorded in full, with real reasons, against a real policy, through the same engine the
 * product uses. But the account snapshot behind it is synthetic, because there is no live
 * brokerage account here. Counting synthetic decisions as usage would inflate a public metric
 * with data nobody could reproduce, which is exactly what the CI exclusion in
 * policy/meter.ts exists to prevent. So this shows up under `ci` in /api/traction and moves
 * none of the headline numbers.
 *
 * If you want the headline numbers to move, that takes a real caller with a real account. The
 * honest state until then is zero.
 *
 * Refuses to run without CONFIRM=yes, because it writes to whichever backend BASE points at.
 */
const BASE = process.env.BASE ?? 'http://localhost:3399'
const TOKEN = process.env.TOKEN
const CONFIRM = process.env.CONFIRM

if (CONFIRM !== 'yes') {
  console.error('Refusing to run without CONFIRM=yes. This writes an agent and decisions to ' + BASE)
  process.exit(1)
}
if (!TOKEN) {
  console.error('TOKEN is required: a verified session token for ' + BASE)
  process.exit(1)
}

const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }
const post = async (path, body) => {
  const res = await fetch(BASE + path, { method: 'POST', headers: H, body: JSON.stringify(body) })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json
}
const get = async (path) => (await fetch(BASE + path)).json()

const before = await get('/api/traction')

const reg = await post('/api/agents/register', {
  manifest: {
    name: 'Guardrail Canary',
    description: 'Exercises the policy engine on a schedule. Activity is excluded from traction.',
    category: 'finance',
    capabilities: ['policy checks'],
    ci: true,
  },
})
const agentId = reg.agentId
console.log(`canary agent: ${agentId} (ci, excluded from traction headlines)`)

await post('/api/agents/action-policy', {
  agentId,
  policy: {
    perActionCapUsd: 250,
    dailyCapUsd: 1000,
    humanApprovalAboveUsd: 200,
    trade: { denySymbols: ['GME'], allowOptions: false, maxConcentrationPct: 40 },
    spend: {
      merchantDeny: ['casino'],
      categoryLimits: { groceries: 120 },
      cardCaps: { card_1: 200 },
      categoryDeny: ['cash_advance', 'quasi_cash', 'gambling'],
    },
  },
})

const snap = (over = {}) => ({
  todayNotionalUsd: 0,
  positions: [{ symbol: 'AAPL', valueUsd: 1200 }],
  portfolioValueUsd: 8000,
  cashAvailableUsd: 6000,
  marginUsedUsd: 0,
  accountType: 'cash',
  cardSpentTodayUsd: { card_1: 0 },
  categorySpentTodayUsd: { groceries: 0 },
  ...over,
})

const check = (surface, intent, snapshot = snap()) =>
  post('/api/agents/action-check', { agentId, surface, intent, snapshot })

/** Every branch of the engine, so a regression anywhere shows up as a changed verdict. */
const cases = [
  ['in-policy equity buy', 'trade', { kind: 'order', side: 'buy', symbol: 'AAPL', assetClass: 'equity', notionalUsd: 80 }, undefined, 'ALLOW'],
  ['denylisted symbol', 'trade', { kind: 'order', side: 'buy', symbol: 'GME', notionalUsd: 60 }, undefined, 'DENY'],
  ['options while off', 'trade', { kind: 'order', side: 'buy', symbol: 'AAPL', assetClass: 'option', notionalUsd: 50 }, undefined, 'DENY'],
  ['over the per-action cap', 'trade', { kind: 'order', side: 'buy', symbol: 'MSFT', notionalUsd: 900 }, undefined, 'DENY'],
  ['at the approval line', 'trade', { kind: 'order', side: 'buy', symbol: 'MSFT', notionalUsd: 220 }, undefined, 'WARN'],
  ['transfer out', 'trade', { kind: 'transfer', notionalUsd: 40 }, undefined, 'WARN'],
  ['card purchase', 'spend', { kind: 'purchase', notionalUsd: 35, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_1' }, undefined, 'ALLOW'],
  ['ATM cash on a card', 'spend', { kind: 'purchase', notionalUsd: 100, merchant: 'ATM', mcc: '6011', cardId: 'card_1' }, undefined, 'DENY'],
  ['per-card ceiling', 'spend', { kind: 'purchase', notionalUsd: 80, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_1' }, snap({ cardSpentTodayUsd: { card_1: 150 } }), 'DENY'],
  ['category ceiling', 'spend', { kind: 'purchase', notionalUsd: 60, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_1' }, snap({ categorySpentTodayUsd: { groceries: 100 } }), 'DENY'],
]

let mismatches = 0
for (const [label, surface, intent, snapshot, expected] of cases) {
  const r = await check(surface, intent, snapshot)
  const got = r.decision.verdict
  const ok = got === expected
  if (!ok) mismatches += 1
  console.log(`  ${ok ? 'ok  ' : 'MISMATCH'} ${label.padEnd(24)} ${got.padEnd(5)} ${JSON.stringify(r.decision.codes)}`)
}

const after = await get('/api/traction')
console.log('\ntraction headlines, before -> after:')
for (const k of ['checks', 'allow', 'warn', 'deny', 'protectedNotionalUsd', 'activeAgents']) {
  const moved = before[k] !== after[k]
  console.log(`  ${k.padEnd(22)} ${before[k]} -> ${after[k]}${moved ? '   <-- MOVED, which it should not have' : ''}`)
}
console.log(`  ci.checks              ${before.ci.checks} -> ${after.ci.checks}`)

const headlineMoved = ['checks', 'allow', 'warn', 'deny', 'protectedNotionalUsd'].some((k) => before[k] !== after[k])
if (headlineMoved) {
  console.error('\nFAIL: canary activity reached a traction headline. The CI exclusion is broken.')
  process.exit(1)
}
if (mismatches > 0) {
  console.error(`\nFAIL: ${mismatches} verdict(s) did not match. Treat the guardrail as unreliable.`)
  process.exit(1)
}
console.log('\nok: every verdict as expected, and no headline moved.')

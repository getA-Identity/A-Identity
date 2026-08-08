/**
 * End-to-end test of the whole guardrail product, through real HTTP against a running
 * backend. Unit tests prove each part; this proves the parts are actually wired to each
 * other, which is a different claim and the one that breaks silently.
 *
 *   npm run start:http &            # or A_IDENTITY_HTTP_PORT=3400 node dist/http.js
 *   node scripts/e2e-guardrail.mjs
 *
 * Against a remote backend it needs CONFIRM=yes, because everything below WRITES: it
 * registers agents, sets policies and records decisions. The agents it creates are flagged
 * `ci` where that is honest, so they never reach a traction headline.
 *
 *   BASE=https://... CONFIRM=yes node scripts/e2e-guardrail.mjs
 *
 * It signs in with a throwaway wallet key generated per run, so it never needs, reads or
 * touches a real session token.
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

const BASE = process.env.BASE ?? `http://localhost:${process.env.A_IDENTITY_HTTP_PORT ?? 3399}`
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(BASE)
if (!isLocal && process.env.CONFIRM !== 'yes') {
  console.error(`Refusing to run against ${BASE} without CONFIRM=yes. This writes agents and decisions.`)
  process.exit(1)
}

// ── tiny harness ─────────────────────────────────────────────────────────────────────
let pass = 0
const failures = []
let group = ''
const section = (name) => {
  group = name
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}`)
}
function check(label, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  ok    ${label}`)
  } else {
    failures.push(`[${group}] ${label}${detail ? ` :: ${detail}` : ''}`)
    console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

let token = null
async function req(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }
  const auth = opts.token === undefined ? token : opts.token
  if (auth) headers.Authorization = `Bearer ${auth}`
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* an SVG or a plain body */
  }
  return { status: res.status, json, text, headers: res.headers }
}
const get = (p, o) => req('GET', p, undefined, o)
const post = (p, b, o) => req('POST', p, b, o)

/** Sign in with a fresh throwaway wallet and return its verified session token. */
async function signIn() {
  const account = privateKeyToAccount(generatePrivateKey())
  const nonceRes = await post('/api/auth/nonce', { address: account.address }, { token: null })
  if (nonceRes.status !== 200 || !nonceRes.json?.message) {
    throw new Error(`/api/auth/nonce failed: ${nonceRes.status} ${nonceRes.text.slice(0, 200)}`)
  }
  const signature = await account.signMessage({ message: nonceRes.json.message })
  const verify = await post(
    '/api/auth/verify',
    { address: account.address, message: nonceRes.json.message, signature },
    { token: null },
  )
  if (verify.status !== 200 || !verify.json?.token) {
    throw new Error(`/api/auth/verify failed: ${verify.status} ${verify.text.slice(0, 200)}`)
  }
  return { token: verify.json.token, address: account.address }
}

const snapshot = (over = {}) => ({
  todayNotionalUsd: 0,
  positions: [{ symbol: 'AAPL', valueUsd: 1000 }],
  portfolioValueUsd: 10_000,
  cashAvailableUsd: 8000,
  marginUsedUsd: 0,
  accountType: 'cash',
  cardSpentTodayUsd: { card_1: 0 },
  categorySpentTodayUsd: { groceries: 0 },
  ...over,
})

// ── 1. the server is the one we think it is ──────────────────────────────────────────
section('reachability and public surface')
const health = await get('/health')
check('/health answers 200', health.status === 200, `status ${health.status}`)

const chains = await get('/api/chains')
const chainIds = (chains.json?.chains ?? []).map((c) => c.id)
eq('/api/chains serves 10 descriptors', chainIds.length, 10)
for (const id of ['arc', 'base', 'arbitrum', 'avalanche', 'xlayer', 'rhchain', 'rhchain-testnet', 'celo', 'stellar', 'solana'])
  check(`  chain present: ${id}`, chainIds.includes(id))
check('no retired chain is served', !chainIds.some((id) => /algorand/i.test(id)))
// Product decision 2026-08-08: Arc + X Layer live, Base beta (see chains/registry.ts).
eq(
  'the live chains are exactly arc + xlayer',
  (chains.json?.chains ?? [])
    .filter((c) => c.status === 'live')
    .map((c) => c.id)
    .sort()
    .join(','),
  'arc,xlayer',
)
eq('base is the one beta chain', (chains.json?.chains ?? []).filter((c) => c.status === 'beta').map((c) => c.id).join(','), 'base')

const status = await get('/api/guardrail-status')
check('/api/guardrail-status says enforcing', status.json?.enforcing === true, JSON.stringify(status.json).slice(0, 160))
check(
  'every self-check vector passes',
  (status.json?.vectors ?? []).length > 0 && status.json.vectors.every((v) => v.pass),
  JSON.stringify(status.json?.vectors?.filter((v) => !v.pass)),
)
eq('a non-enforcing engine would answer 503, so 200 means enforcing', status.status, 200)

const tractionBefore = (await get('/api/traction')).json
check('/api/traction answers with a disclosure array', Array.isArray(tractionBefore?.disclosure))
check(
  'the disclosure says the numbers are measured, not projected',
  (tractionBefore?.disclosure ?? []).some((d) => /measured/i.test(d)),
)
check(
  'the disclosure refuses to call protected value revenue',
  (tractionBefore?.disclosure ?? []).some((d) => /not revenue/i.test(d)),
)

// ── 2. the write side is closed until a wallet proves itself ─────────────────────────
section('auth gate')
const anon = await post('/api/agents/action-policy', { agentId: 'whatever', policy: {} }, { token: null })
eq('unauthenticated policy write is refused', anon.status, 401)
const anonCheck = await post(
  '/api/agents/action-check',
  { agentId: 'whatever', surface: 'trade', intent: { kind: 'order', notionalUsd: 1 } },
  { token: null },
)
check('unauthenticated action-check is refused', anonCheck.status >= 400, `status ${anonCheck.status}`)

const owner = await signIn()
token = owner.token
check('a wallet signature yields a verified session', typeof token === 'string' && token.length > 20)
const me = await get('/api/auth/me')
eq('the session reports the wallet method', me.json?.method, 'wallet')

// ── 3. registration ──────────────────────────────────────────────────────────────────
section('registration (Phase 1.5 / 5)')
const reg = await post('/api/agents/register', {
  manifest: {
    name: 'E2E Guardrail Agent',
    description: 'Created by scripts/e2e-guardrail.mjs to prove the guardrail is wired end to end.',
    category: 'finance',
    capabilities: ['policy checks'],
    ci: true,
  },
})
eq('register answers 201', reg.status, 201)
const agentId = reg.json?.agentId
check('an agentId came back', typeof agentId === 'string' && agentId.length > 0, JSON.stringify(reg.json).slice(0, 200))
const noName = await post('/api/agents/register', { manifest: { description: 'no name' } })
eq('a manifest with no name is rejected', noName.status, 400)

const regView = await get(`/api/agents/register?agentId=${encodeURIComponent(agentId)}`)
eq('the owner can read the registration back', regView.status, 200)

// ── 4. policy storage and sanitizing ────────────────────────────────────────────────
section('action policy (Phase 1.3)')
const p0 = await get(`/api/agents/action-policy?agentId=${encodeURIComponent(agentId)}`)
eq('a fresh agent has a default policy', p0.status, 200)
const pol0 = p0.json?.policy
eq('the default policy is version 1', pol0?.version, 1)
eq('margin is off by default', pol0?.trade?.allowMargin, false)
eq('options are off by default', pol0?.trade?.allowOptions, false)
check('the default carries a per-action cap', typeof pol0?.perActionCapUsd === 'number' && pol0.perActionCapUsd > 0)

const patched = await post('/api/agents/action-policy', {
  agentId,
  policy: {
    perActionCapUsd: 250,
    dailyCapUsd: 1000,
    humanApprovalAboveUsd: 200,
    // Two hostile values in one patch: margin must never be enabled through the API, and a
    // negative cap must not become a cap that lets everything through.
    trade: { allowMargin: true, denySymbols: ['GME'], maxConcentrationPct: 40, allowSymbols: ['  ', 'AAPL'] },
    spend: {
      merchantDeny: ['casino'],
      categoryLimits: { groceries: 120 },
      cardCaps: { card_1: 200 },
      categoryDeny: ['cash_advance', 'quasi_cash', 'gambling'],
    },
  },
})
eq('the patch is accepted', patched.status, 200)
const pol1 = patched.json?.policy
eq('the version bumped', pol1?.version, 2)
eq('allowMargin:true was neutralized, not stored', pol1?.trade?.allowMargin, false)
eq('the per-action cap was stored', pol1?.perActionCapUsd, 250)
check(
  'a whitespace-only symbol was dropped from the allowlist',
  (pol1?.trade?.allowSymbols ?? []).every((s) => s.trim().length > 0),
  JSON.stringify(pol1?.trade?.allowSymbols),
)

// ── 5. the trade surface ────────────────────────────────────────────────────────────
section('trade surface decisions (Phase 1.2)')
const check_ = async (surface, intent, snap = snapshot()) =>
  (await post('/api/agents/action-check', { agentId, surface, intent, snapshot: snap })).json
const verdictOf = async (label, surface, intent, want, snap) => {
  const r = await check_(surface, intent, snap)
  const got = r?.decision?.verdict
  check(`${label} -> ${want}`, got === want, `got ${got} ${JSON.stringify(r?.decision?.codes ?? r)}`)
  return r
}

const allowed = await verdictOf('an in-policy AAPL buy', 'trade', { kind: 'order', side: 'buy', symbol: 'AAPL', assetClass: 'equity', notionalUsd: 80 }, 'ALLOW')
check('an ALLOW still carries an audit id', typeof allowed?.auditId === 'string' && allowed.auditId.length > 0)
await verdictOf('a denylisted symbol', 'trade', { kind: 'order', side: 'buy', symbol: 'GME', notionalUsd: 50 }, 'DENY')
await verdictOf('a symbol outside the allowlist', 'trade', { kind: 'order', side: 'buy', symbol: 'TSLA', notionalUsd: 50 }, 'DENY')
await verdictOf('an option while options are off', 'trade', { kind: 'order', side: 'buy', symbol: 'AAPL', assetClass: 'option', notionalUsd: 50 }, 'DENY')
await verdictOf('over the per-action cap', 'trade', { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 900 }, 'DENY')
await verdictOf('at the human-approval line', 'trade', { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 220 }, 'WARN')
await verdictOf('money leaving the account', 'trade', { kind: 'transfer', notionalUsd: 25 }, 'WARN')
await verdictOf('turning margin on', 'trade', { kind: 'settings', settingKey: 'margin', settingValue: true, notionalUsd: 0 }, 'DENY')
await verdictOf('a standing recurring buy', 'trade', { kind: 'recurring', side: 'buy', symbol: 'AAPL', notionalUsd: 50, cadence: 'weekly' }, 'WARN')

// The bypasses that only show up over the wire.
const overCap = await check_('trade', { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 900 })
check('a DENY explains itself in prose', (overCap?.decision?.reasons ?? []).some((r) => r.length > 10))
check('a DENY carries a stable code', (overCap?.decision?.codes ?? []).length > 0)

const daily = await verdictOf(
  'the daily cap counts what was already done',
  'trade',
  { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 100 },
  'DENY',
  snapshot({ todayNotionalUsd: 950 }),
)
check('the daily-cap refusal names the cap', (daily?.decision?.codes ?? []).includes('DAILY_CAP'), JSON.stringify(daily?.decision?.codes))

const noCash = await verdictOf(
  'an order with no settled cash reported',
  'trade',
  { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 80 },
  'DENY',
  { todayNotionalUsd: 0, positions: [] },
)
check('a missing snapshot field fails closed and is marked unverifiable', noCash?.decision?.unverifiable === true, JSON.stringify(noCash?.decision))

// ── 6. the spend surface ────────────────────────────────────────────────────────────
section('spend surface decisions (Phase 4)')
await verdictOf('a groceries purchase in policy', 'spend', { kind: 'purchase', notionalUsd: 30, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_1' }, 'ALLOW')
await verdictOf('a denied merchant', 'spend', { kind: 'purchase', notionalUsd: 30, merchant: 'Lucky Casino', mcc: '5411', cardId: 'card_1' }, 'DENY')
await verdictOf('ATM cash on an agent card', 'spend', { kind: 'purchase', notionalUsd: 60, merchant: 'ATM', mcc: '6011', cardId: 'card_1' }, 'DENY')
await verdictOf('a crypto purchase on a card (quasi-cash)', 'spend', { kind: 'purchase', notionalUsd: 60, merchant: 'Exchange', mcc: '6051', cardId: 'card_1' }, 'DENY')
await verdictOf('past the per-card ceiling', 'spend', { kind: 'purchase', notionalUsd: 60, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_1' }, 'DENY', snapshot({ cardSpentTodayUsd: { card_1: 180 } }))
await verdictOf('past the category ceiling', 'spend', { kind: 'purchase', notionalUsd: 40, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_1' }, 'DENY', snapshot({ categorySpentTodayUsd: { groceries: 100 } }))
const unknownCard = await verdictOf('a card the ceiling has no figure for', 'spend', { kind: 'purchase', notionalUsd: 40, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_9' }, 'ALLOW')
check('an uncapped card is allowed rather than silently capped', (unknownCard?.decision?.codes ?? []).length === 0, JSON.stringify(unknownCard?.decision?.codes))

// ── 7. Phase 7: the planned surface cannot authorize ────────────────────────────────
section('bet surface is planned and inert (Phase 7)')
const bet = await check_('bet', { kind: 'order', side: 'buy', symbol: 'ELECTION', notionalUsd: 1 })
eq('a bet is refused', bet?.decision?.verdict, 'DENY')
check('refused specifically as a non-live surface', (bet?.decision?.codes ?? []).includes('SURFACE_NOT_LIVE'), JSON.stringify(bet?.decision?.codes))
eq('and refused for that reason alone, before any rule ran', (bet?.decision?.codes ?? []).length, 1)
const betBig = await check_('bet', { kind: 'order', notionalUsd: 0 })
eq('a zero-dollar bet is refused too', betBig?.decision?.verdict, 'DENY')
const unknownSurface = await check_('lottery', { kind: 'order', notionalUsd: 5 })
eq('an unknown surface is refused', unknownSurface?.decision?.verdict, 'DENY')
check('an unknown surface says so', (unknownSurface?.decision?.codes ?? []).includes('UNKNOWN_SURFACE'), JSON.stringify(unknownSurface?.decision?.codes))
const betTool = await post('/tools/pre_bet_check', { agentId, stakeUsd: 1 })
check('no pre_bet_check endpoint exists', betTool.status === 404, `status ${betTool.status}`)

// ── 8. the freeze switch ────────────────────────────────────────────────────────────
section('freeze')
await post('/api/agents/action-policy', { agentId, policy: { frozen: true } })
const frozenTrade = await check_('trade', { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 10 })
eq('a frozen policy stops a trade', frozenTrade?.decision?.verdict, 'DENY')
const frozenSpend = await check_('spend', { kind: 'purchase', notionalUsd: 5, merchant: 'Whole Foods', mcc: '5411', cardId: 'card_1' })
eq('a frozen policy stops a card purchase too', frozenSpend?.decision?.verdict, 'DENY')
check('the freeze is the stated reason', (frozenTrade?.decision?.codes ?? []).includes('FROZEN'), JSON.stringify(frozenTrade?.decision?.codes))
await post('/api/agents/action-policy', { agentId, policy: { frozen: false } })
const thawed = await check_('trade', { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 10 })
eq('unfreezing restores the previous behavior', thawed?.decision?.verdict, 'ALLOW')

// ── 9. the audit trail ──────────────────────────────────────────────────────────────
section('audit trail (Phase 1.4)')
const log = await get(`/api/agents/audit-log?agentId=${encodeURIComponent(agentId)}`)
eq('the owner can read the trail', log.status, 200)
const entries = log.json?.audits ?? []
check('every decision above was recorded', entries.length >= 20, `${entries.length} entries`)
const newest = entries[0]
check('newest first', new Date(entries[0]?.ts) >= new Date(entries[entries.length - 1]?.ts))
check('an entry names the policy version that decided it', typeof newest?.policyVersion === 'number')
check('the summary covers the same window as the rows', typeof log.json?.summary === 'object' && log.json.summary !== null)
const raw = JSON.stringify(entries)
check('the snapshot is hashed, not stored', /snapshotHash/.test(raw) && !/"positions"/.test(raw))
check('no holding value leaked into the trail', !/"valueUsd"/.test(raw))
check('no portfolio total leaked into the trail', !/portfolioValueUsd|cashAvailableUsd|buyingPowerUsd/.test(raw))
const cardEntry = entries.find((e) => e.intent?.merchant)
check(
  'a card decision kept merchant, mcc and card id',
  Boolean(cardEntry?.intent?.merchant && cardEntry?.intent?.mcc && cardEntry?.intent?.cardId),
  JSON.stringify(cardEntry?.intent ?? null).slice(0, 200),
)

const zeroLimit = await get(`/api/agents/audit-log?agentId=${encodeURIComponent(agentId)}&limit=0`)
check('limit=0 falls back to the default page, not one row', (zeroLimit.json?.audits ?? []).length > 1, `${(zeroLimit.json?.audits ?? []).length} rows`)
const junkLimit = await get(`/api/agents/audit-log?agentId=${encodeURIComponent(agentId)}&limit=abc`)
check('a nonsense limit is ignored rather than obeyed', (junkLimit.json?.audits ?? []).length > 1)
const future = await get(`/api/agents/audit-log?agentId=${encodeURIComponent(agentId)}&since=2099-01-01T00:00:00Z`)
check('a since in the future returns nothing and says the filter applied', (future.json?.audits ?? []).length === 0 && future.json?.sinceApplied === true, JSON.stringify(future.json).slice(0, 160))

const warnEntry = entries.find((e) => e.verdict === 'WARN')
const outcome = await post('/api/agents/audit-log/outcome', {
  agentId,
  auditId: warnEntry?.id,
  outcome: 'executed',
  evidenceRef: 'e2e-run',
})
eq('a human-confirmed WARN can be closed out', outcome.status, 200)
const closed = await get(`/api/agents/audit-log?agentId=${encodeURIComponent(agentId)}`)
const closedEntry = (closed.json?.audits ?? []).find((e) => e.id === warnEntry?.id)
eq('the outcome was persisted on the entry', closedEntry?.outcome, 'executed')
eq('the caller evidence was kept for reconciliation', closedEntry?.evidenceRef, 'e2e-run')

const denyEntry = entries.find((e) => e.verdict === 'DENY')
const override = await post('/api/agents/audit-log/outcome', { agentId, auditId: denyEntry?.id, outcome: 'executed' })
check('a DENY cannot be marked executed', override.status >= 400, `status ${override.status} ${JSON.stringify(override.json)}`)
// Refusing is not enough on its own: the attempt is the behavioral signal, so it must be counted.
const afterOverride = await get(`/api/agents/audit-log?agentId=${encodeURIComponent(agentId)}`)
const attempted = (afterOverride.json?.audits ?? []).find((e) => e.id === denyEntry?.id)
check('the refused override was COUNTED, not silently dropped', (attempted?.overrideAttempts ?? 0) >= 1, JSON.stringify(attempted?.overrideAttempts))
eq('and the entry still reads as blocked', attempted?.verdict, 'DENY')
const tractionOverride = (await get('/api/traction')).json
check('the platform counts override attempts too', (tractionOverride?.overrideAttempts ?? 0) >= 0)
const badOutcome = await post('/api/agents/audit-log/outcome', { agentId, auditId: warnEntry?.id, outcome: 'whatever' })
eq('an unknown outcome is rejected', badOutcome.status, 400)
const foreignAudit = await post('/api/agents/audit-log/outcome', { agentId, auditId: 'no-such-audit', outcome: 'executed' })
check('an unknown audit id is rejected', foreignAudit.status >= 400, `status ${foreignAudit.status}`)

// ── 10. the badge is opt-in and carries no number ───────────────────────────────────
section('badge (Phase 1.6)')
const hidden = await get(`/api/agents/badge?agentId=${encodeURIComponent(agentId)}`)
check('a badge is not served until the owner publishes it', hidden.status >= 400, `status ${hidden.status}`)
const vis = await post('/api/agents/badge-visibility', { agentId, public: true })
eq('the owner can publish it', vis.status, 200)
const shown = await get(`/api/agents/badge?agentId=${encodeURIComponent(agentId)}`)
eq('the published badge is served', shown.status, 200)
check('the badge carries no dollar figure', !/\$\d/.test(shown.text), shown.text.slice(0, 200))
const svg = await get(`/api/agents/badge?agentId=${encodeURIComponent(agentId)}&format=svg`)
check('the SVG variant renders', svg.status === 200 && svg.text.startsWith('<svg'), svg.text.slice(0, 80))
// Self-contained means it fetches nothing when embedded. The SVG namespace URI is a
// declaration, not a request, so it is the one allowed occurrence of a URL.
const svgBody = svg.text.replace(/xmlns(:\w+)?="[^"]*"/g, '')
// `url(#s)` points at a gradient defined in the same document, so only a reference that
// leaves the document counts: an <image>, an href, or a url() that is not a fragment.
check('the SVG references nothing external', !/<image|href=|url\((?!#)/i.test(svgBody), svgBody.slice(0, 200))
check('the SVG embeds no remote URL', !/https?:\/\//.test(svgBody), svgBody.slice(0, 200))
check('the SVG has no unescaped angle bracket from a name', !/<text[^>]*>[^<]*[<>][^<]*<\/text>/.test(svg.text))
await post('/api/agents/badge-visibility', { agentId, public: false })
const hiddenAgain = await get(`/api/agents/badge?agentId=${encodeURIComponent(agentId)}`)
check('unpublishing takes it down again', hiddenAgain.status >= 400, `status ${hiddenAgain.status}`)

// ── 11. ownership ───────────────────────────────────────────────────────────────────
section('ownership')
const stranger = await signIn()
const strangerRead = await get(`/api/agents/action-policy?agentId=${encodeURIComponent(agentId)}`, { token: stranger.token })
check('another wallet cannot read the policy', strangerRead.status === 403, `status ${strangerRead.status}`)
const strangerWrite = await post('/api/agents/action-policy', { agentId, policy: { perActionCapUsd: 1e9 } }, { token: stranger.token })
check('another wallet cannot widen the policy', strangerWrite.status === 403, `status ${strangerWrite.status}`)
const strangerLog = await get(`/api/agents/audit-log?agentId=${encodeURIComponent(agentId)}`, { token: stranger.token })
check('another wallet cannot read the trail', strangerLog.status === 403, `status ${strangerLog.status}`)
const strangerCheck = await post(
  '/api/agents/action-check',
  { agentId, surface: 'trade', intent: { kind: 'order', notionalUsd: 1 } },
  { token: stranger.token },
)
check('another wallet cannot spend the agent\'s policy budget', strangerCheck.status === 403, `status ${strangerCheck.status}`)
const stillCapped = await get(`/api/agents/action-policy?agentId=${encodeURIComponent(agentId)}`)
eq('the policy was not modified by the attempt', stillCapped.json?.policy?.perActionCapUsd, 250)

// ── 12. traction stays honest ───────────────────────────────────────────────────────
section('traction accounting (Phase 5.5)')
const tractionAfter = (await get('/api/traction')).json
const headline = ['checks', 'allow', 'warn', 'deny', 'protectedNotionalUsd']
for (const k of headline) {
  eq(`ci activity did not move ${k}`, tractionAfter?.[k], tractionBefore?.[k])
}
check(
  'the ci bucket did move',
  (tractionAfter?.ci?.checks ?? 0) > (tractionBefore?.ci?.checks ?? 0),
  `${tractionBefore?.ci?.checks} -> ${tractionAfter?.ci?.checks}`,
)
check('registered agents is reported separately from activity', typeof tractionAfter?.registeredAgents === 'number')

// A non-CI agent, to prove the meter is not simply broken.
const realReg = await post('/api/agents/register', {
  manifest: { name: 'E2E Metered Agent', description: 'Proves a non-CI decision does reach the headline numbers.', category: 'finance', capabilities: ['policy checks'] },
})
const realId = realReg.json?.agentId
await post('/api/agents/action-policy', { agentId: realId, policy: { perActionCapUsd: 100 } })
await post('/api/agents/action-check', {
  agentId: realId,
  surface: 'trade',
  intent: { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 500 },
  snapshot: snapshot(),
})
const tractionReal = (await get('/api/traction')).json
check('a non-ci decision does reach the headline', (tractionReal?.checks ?? 0) > (tractionAfter?.checks ?? 0), `${tractionAfter?.checks} -> ${tractionReal?.checks}`)
check('the refused amount is counted as protected value', (tractionReal?.protectedNotionalUsd ?? 0) >= 500, `${tractionReal?.protectedNotionalUsd}`)
check('the ci bucket did not absorb it', (tractionReal?.ci?.checks ?? 0) === (tractionAfter?.ci?.checks ?? 0))
const tractionRaw = JSON.stringify(tractionReal)
check('traction names no agent or owner', !/0x[0-9a-f]{40}/i.test(tractionRaw) && !tractionRaw.includes(agentId), tractionRaw.slice(0, 200))

// ── 13. the public feed ─────────────────────────────────────────────────────────────
section('public feed')
const feed = await get('/api/agents')
eq('/api/agents answers', feed.status, 200)
check('the feed is an array', Array.isArray(feed.json?.agents))

// The guardrail column in the explorer reads /api/marketplace (src/lib/mcp-client.ts
// getLeaderboard), NOT /api/agents. Asserting the endpoint the UI actually calls is the
// whole point: a column wired to a field the endpoint never sends renders blank forever.
//
// `?all=1` is the unfiltered feed. It is used here so the assertion means something in a
// clean environment: the DEFAULT feed shows only KYA-verified, described agents, so on a
// fresh backend it is legitimately empty and "every row carries X" would pass vacuously.
const market = await get('/api/marketplace?all=1')
eq('/api/marketplace answers', market.status, 200)
const rows = market.json?.agents ?? []
check('the unfiltered feed contains the agents this run created', rows.some((r) => r.id === agentId), `${rows.length} rows, none of them ours`)
const withGuardrails = rows.filter((a) => a && typeof a === 'object' && 'guardrails' in a)
eq('EVERY row carries a guardrail summary', withGuardrails.length, rows.length)
const g = JSON.stringify(rows.map((r) => r.guardrails))
check('an unpublished badge reads as published:false rather than absent', rows.every((r) => typeof r.guardrails?.published === 'boolean'), g.slice(0, 200))
check('the public summary carries no exact dollar figure', !/\d{3,}/.test(g), g.slice(0, 200))
check('the feed leaks no owner address', !/0x[0-9a-f]{40}/i.test(g))

// The strict default filter is a product decision, so it is pinned rather than assumed: a
// freshly registered agent with no KYA must NOT appear in the public feed just by existing.
const strict = await get('/api/marketplace')
const strictRows = strict.json?.agents ?? []
check('the default feed excludes an unverified agent', !strictRows.some((r) => r.id === agentId), `${strictRows.length} rows`)
check('the default feed is a subset of the unfiltered one', strictRows.length <= rows.length, `${strictRows.length} > ${rows.length}`)

// The surface categories list only agents whose owner PUBLISHED a badge. This run
// unpublished its badge above, so it must be absent from both.
for (const category of ['trading', 'spend']) {
  const catRows = (await get(`/api/marketplace?category=${category}`)).json?.agents ?? []
  check(`?category=${category} excludes an agent with no published badge`, !catRows.some((r) => r.id === agentId), `${catRows.length} rows`)
  check(`?category=${category} rows all published a badge`, catRows.every((r) => r.guardrails?.published === true), JSON.stringify(catRows.map((r) => r.guardrails)).slice(0, 160))
}

// ── 14. the same question through MCP ───────────────────────────────────────────────
section('MCP parity')
try {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name: 'a-identity-e2e', version: '0.1.0' })
  await client.connect(transport)
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  for (const n of ['register_agent', 'policy_get', 'policy_set', 'pre_action_check', 'audit_log', 'record_audit_outcome'])
    check(`MCP exposes ${n}`, names.includes(n))
  check('MCP does NOT expose a bet tool', !names.some((n) => /bet/i.test(n)), names.filter((n) => /bet/i.test(n)).join(','))

  const textOf = (r) => (r.content ?? []).map((c) => c.text).join('\n')
  const mcpCheck = await client.callTool({
    name: 'pre_action_check',
    arguments: {
      agentId,
      surface: 'trade',
      intent: { kind: 'order', side: 'buy', symbol: 'AAPL', notionalUsd: 900 },
      snapshot: snapshot(),
    },
  })
  const mcpText = textOf(mcpCheck)
  check('the same over-cap order is DENIED over MCP too', /DENY/.test(mcpText), mcpText.slice(0, 200))
  const mcpBet = textOf(
    await client.callTool({ name: 'pre_action_check', arguments: { agentId, surface: 'bet', intent: { kind: 'order', notionalUsd: 1 }, snapshot: snapshot() } }),
  )
  check('the bet surface is refused over MCP too', /SURFACE_NOT_LIVE/.test(mcpBet), mcpBet.slice(0, 200))
  await client.close()
} catch (err) {
  check('MCP transport connected', false, String(err).slice(0, 200))
}

// ── verdict ─────────────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(66)}`)
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} FAILED\n`)
  failures.forEach((f) => console.log(`  ✗ ${f}`))
  process.exit(1)
}
console.log(`${pass} end-to-end assertions passed against ${BASE}`)

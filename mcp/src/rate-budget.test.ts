/**
 * Every POST that broadcasts from the shared signer must have a rate budget.
 *
 * rateBudget already limited the two marketplace escrow routes, with the reason written
 * down beside them: they "run a real ERC-8183 escrow lifecycle from the shared signer".
 * Seven other POSTs spend that same wallet the same way and had no budget at all, including
 * the vault deploy, which puts a whole contract on chain, and executeInstruction, which
 * settles real money. The daily cap bounds what an instruction may MOVE; nothing bounded
 * how many broadcasts anyone could trigger, and gas is spent whether or not the value is
 * small.
 *
 * Listing the seven is not the fix, because the eighth is one route away. This reads the
 * route files, finds POST handlers that reach a known on-chain write, and fails if any of
 * them is missing from the budget. A new route that spends the signer goes red on the day
 * it is written rather than on the day the wallet is empty.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { rateBudget, agentCreateVolume, chargeAgentCreate, AGENT_CREATE_VOLUME } from './rate-budget.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))
const ROUTES = join(SRC, 'http')

/**
 * Functions that put a transaction on a chain from OUR wallet.
 *
 * Named rather than pattern-matched on purpose: `...Onchain` would catch reads too, and a
 * write that does not follow the naming would be missed silently. A list that has to be
 * edited when a new write lands is the point, because editing it is what makes someone
 * think about the budget.
 */
const SPENDS_GAS = [
  'anchorAgentOnchain', 'provisionAgentVault', 'verifyKya', 'revokeAgentKya',
  'registerAgentOnchain', 'createJobOnchain', 'rejectJobOnchain', 'claimJobRefundOnchain',
  'executeInstruction', 'hireAgent', 'acceptBid', 'deliverWork', 'releaseEscrow',
  'disputeEscrow', 'grantSessionKey', 'payUsdcOnchain', 'payUsdcBatchOnchain',
]

/** POST routes in a file, each with the source that follows it up to the next route. */
function postRoutes(source: string): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = []
  const re = /req\.method === 'POST' && url\.pathname === '([^']+)'/g
  const hits = [...source.matchAll(re)]
  hits.forEach((m, i) => {
    const start = m.index ?? 0
    const end = i + 1 < hits.length ? hits[i + 1].index ?? source.length : source.length
    out.push({ path: m[1], body: source.slice(start, end) })
  })
  return out
}

test('the scan finds routes at all, or the assertions below are vacuous', () => {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  const total = files.reduce((n, f) => n + postRoutes(readFileSync(join(ROUTES, f), 'utf8')).length, 0)
  assert.ok(total >= 30, `expected the route files to still contain their POST routes, found ${total}`)
})

test('every POST that broadcasts from the shared signer has a rate budget', () => {
  const missing: string[] = []
  for (const file of readdirSync(ROUTES).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    for (const route of postRoutes(readFileSync(join(ROUTES, file), 'utf8'))) {
      const write = SPENDS_GAS.find((fn) => route.body.includes(`${fn}(`))
      if (!write) continue
      if (!rateBudget('POST', route.path)) missing.push(`${route.path}  (calls ${write}, in ${file})`)
    }
  }
  assert.deepEqual(
    missing, [],
    'these POSTs broadcast from the shared signer with no rate budget, so anyone who can ' +
      'reach them can drain it:\n  ' + missing.join('\n  '),
  )
})

test('the vault deploy is limited harder than an ordinary write, because it is a contract', () => {
  const vault = rateBudget('POST', '/api/agents/vault')
  const write = rateBudget('POST', '/api/agents/anchor')
  assert.ok(vault && write)
  assert.ok(vault.max < write.max, `${vault.max} should be tighter than ${write.max}`)
})

test('a GET is never rate budgeted, and an unknown path is not accidentally limited', () => {
  assert.equal(rateBudget('GET', '/api/agents/vault'), null)
  assert.equal(rateBudget('POST', '/api/definitely-not-a-route'), null)
})

// ── free writes: the blind spot this file had ────────────────────────────────────
//
// Everything above asks "does this POST spend the shared signer". A posted task, a bid and
// a registered agent spend nothing, which is exactly why they had no budget at all, and
// exactly why they are the cheapest thing on the server to abuse: each one appends a
// permanent row to the single state document the server rewrites on every save, and an
// open task is additionally a card every visitor to the board renders. Free to the sender,
// permanent to us, is the shape of "someone opens a thousand tasks on a whim".

test('the free writes that create durable rows are budgeted too, not only the ones that spend gas', () => {
  for (const path of ['/api/marketplace/post-task', '/api/marketplace/bid', '/api/agents', '/api/v1/agents/register']) {
    const budget = rateBudget('POST', path)
    assert.ok(budget, `${path} creates a permanent row for free and must still have a rate budget`)
    assert.ok(budget.max > 0 && budget.windowMs > 0, `${path} needs a real budget, not a zero one`)
  }
})

test('budgeting the free writes did not accidentally limit reading them', () => {
  // /api/agents is a POST route and a GET route at the same path. Only the write is bounded.
  assert.equal(rateBudget('GET', '/api/agents'), null)
  assert.equal(rateBudget('GET', '/api/marketplace/open-tasks'), null)
})

test('a burst on one free write cannot lock a caller out of the others', () => {
  const buckets = ['/api/marketplace/post-task', '/api/marketplace/bid', '/api/agents'].map(
    (p) => rateBudget('POST', p)?.bucket,
  )
  assert.equal(
    new Set(buckets).size, buckets.length,
    `posting, bidding and registering need separate buckets, got ${buckets.join(', ')}`,
  )
})

test('the two agent-registration doors share one budget, so neither is a way around the other', () => {
  const viaConsole = rateBudget('POST', '/api/agents')
  const viaApi = rateBudget('POST', '/api/v1/agents/register')
  assert.ok(viaConsole && viaApi)
  assert.equal(
    viaConsole.bucket, viaApi.bucket,
    'both paths write the same agent row; separate buckets would double the real allowance',
  )
})

test('rating an agent is budgeted like the other free writes that create rows', () => {
  // Feedback belonged in this class from the day it was written and was simply left out of
  // it: it writes a durable row AND feeds reputation (agentReputation reads it into the
  // behavior and discipline terms), which makes it the one free write where spam changes
  // what the platform SAYS about somebody.
  const budget = rateBudget('POST', '/api/marketplace/feedback')
  assert.ok(budget, 'POST /api/marketplace/feedback creates a permanent row and must have a rate budget')
  assert.equal(rateBudget('GET', '/api/marketplace/feedback'), null, 'reading ratings is not the write')
})

test('the feedback budget sits between spam and normal use, in its own bucket', () => {
  const feedback = rateBudget('POST', '/api/marketplace/feedback')
  const post = rateBudget('POST', '/api/marketplace/post-task')
  const bid = rateBudget('POST', '/api/marketplace/bid')
  assert.ok(feedback && post && bid)
  // A few ratings a minute is a person working through a shortlist; dozens is not a person.
  assert.ok(feedback.max >= post.max && feedback.max <= bid.max, `${feedback.max} should sit in the free-write class`)
  // Its own bucket, so a burst of ratings cannot lock a caller out of posting or bidding.
  assert.equal(new Set([feedback.bucket, post.bucket, bid.bucket]).size, 3)
})

// ── the bulk door, and why a request count stops being a limit there ─────────────

test('the bulk registration door has a request budget of its own', () => {
  const batch = rateBudget('POST', '/api/v1/agents/register/batch')
  assert.ok(batch, 'the batch door writes rows and must have a request budget')
  const single = rateBudget('POST', '/api/v1/agents/register')
  assert.ok(single)
  // Not the single door's bucket: one request here is many rows, so counting it as one
  // write against agent-create would be wrong in both directions. What actually bounds it
  // is the ROW ledger below, which both doors charge.
  assert.notEqual(batch.bucket, single.bucket)
})

test('agent rows are counted per row, so the batch cannot buy a second allowance', () => {
  // The hole this closes: budget the batch per REQUEST and one POST carrying fifty
  // manifests spends one unit of a budget the single door spends one unit per agent on.
  const tier = 'default'
  const { max } = agentCreateVolume(tier)
  const account = `acct-${Math.random()}`
  for (let i = 1; i <= max; i++) {
    assert.equal(chargeAgentCreate(account, tier).ok, true, `row ${i} of ${max} should fit`)
  }
  const over = chargeAgentCreate(account, tier)
  assert.equal(over.ok, false, 'the row after the budget must be refused')
  assert.equal(over.max, max, 'the refusal has to carry the limit so the caller can be told it')
  assert.ok(over.resetAt > Date.now(), 'and when the window reopens, so the caller can retry honestly')
})

test('an operator account gets more room per minute, and everyone else gets what they had', () => {
  // The default is the number the per-request agent-create bucket has always allowed, so
  // an ordinary account's real allowance is unchanged by any of this.
  assert.equal(agentCreateVolume('default').max, rateBudget('POST', '/api/v1/agents/register')?.max)
  assert.ok(
    AGENT_CREATE_VOLUME.operator.max > AGENT_CREATE_VOLUME.default.max,
    'a fleet that may EXIST has to be able to arrive; otherwise the ceiling raise is theatre',
  )
  // An unknown tier gets the ordinary budget, never the bigger one: a typo in a tier name
  // must fail closed.
  assert.deepEqual(agentCreateVolume('operatorr'), AGENT_CREATE_VOLUME.default)
  assert.deepEqual(agentCreateVolume(''), AGENT_CREATE_VOLUME.default)
})

test('a row budget is per account and per window, not one shared pool forever', () => {
  const tier = 'default'
  const { max, windowMs } = agentCreateVolume(tier)
  const a = `acct-a-${Math.random()}`
  const b = `acct-b-${Math.random()}`
  const t0 = Date.now()
  for (let i = 0; i < max + 1; i++) chargeAgentCreate(a, tier, t0)
  assert.equal(chargeAgentCreate(a, tier, t0).ok, false, 'this account is out of room')
  assert.equal(chargeAgentCreate(b, tier, t0).ok, true, 'another account must not pay for it')
  assert.equal(chargeAgentCreate(a, tier, t0 + windowMs + 1).ok, true, 'and the window reopens')
})

test('a rate limited POST is refused before any route handler runs, so it creates no row', () => {
  // Every budget above is a number in a table. This checks the number is enforced where it
  // has to be: ahead of the dispatch, with a return, so a limited feedback POST cannot
  // reach addAgentFeedback and write the row the limit exists to prevent.
  const http = readFileSync(join(SRC, 'http.ts'), 'utf8')
  const limiter = http.indexOf('rateBudget(req.method')
  const refusal = http.indexOf('sendJson(res, 429', limiter)
  const dispatch = http.indexOf('Routes(ctx)')
  assert.ok(limiter > 0, 'http.ts must still consult rateBudget')
  assert.ok(refusal > limiter, 'and answer 429 when the budget is spent')
  assert.ok(refusal < dispatch, 'the refusal has to come BEFORE the route handlers, or the row is already written')
  assert.match(http.slice(refusal, dispatch), /\breturn\b/, 'and it has to return rather than fall through')
})

test('posting a task is limited harder than bidding on one', () => {
  // A bid answers work someone else already posted, so it is the more legitimately frequent
  // of the two: an agent that serves a category bids on every open task in it. A post is
  // the one that creates the listing everyone else then has to load.
  const post = rateBudget('POST', '/api/marketplace/post-task')
  const bid = rateBudget('POST', '/api/marketplace/bid')
  assert.ok(post && bid)
  assert.ok(post.max < bid.max, `posting (${post.max}) should be tighter than bidding (${bid.max})`)
})

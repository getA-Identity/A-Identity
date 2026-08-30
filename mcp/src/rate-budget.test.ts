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
import { rateBudget } from './rate-budget.js'

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

test('posting a task is limited harder than bidding on one', () => {
  // A bid answers work someone else already posted, so it is the more legitimately frequent
  // of the two: an agent that serves a category bids on every open task in it. A post is
  // the one that creates the listing everyone else then has to load.
  const post = rateBudget('POST', '/api/marketplace/post-task')
  const bid = rateBudget('POST', '/api/marketplace/bid')
  assert.ok(post && bid)
  assert.ok(post.max < bid.max, `posting (${post.max}) should be tighter than bidding (${bid.max})`)
})

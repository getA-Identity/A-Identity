import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Snapshot } from '../chains/near/engine.js'
import { createMarketClient, marketBase, MarketAuthError, redactToken, type FetchFn } from './client.js'
import { CLARIFY_PREFIX, type BriefTarget } from './brief.js'
import { startFakeMarket, type FakeMarket } from './fake-market.js'
import { marketVerdictFromSnapshot, type MarketVerdict, type VerdictResult } from './verdict.js'
import {
  BACKOFF_MAX_MS,
  CLARIFY_GRACE_MS,
  createNearMarketWorker,
  FIRST_POLL_MS,
  POLL_MAX_MS,
  POLL_MIN_MS,
  RENDER_FIRST_POLL_MS,
  startNearMarketWorker,
  type NearMarketWorker,
} from './worker.js'

/**
 * The NEAR AI market worker against a fake marketplace: a real HTTP server on 127.0.0.1 that
 * keeps the documented states and refusals (fake-market.ts). The verdict is stubbed with the
 * SDK's own recorded snapshot, re-labelled for the account asked about, because what is tested
 * here is the lifecycle: start, deliver once, ask once, decline honestly, stop on a revoked
 * token, and never print the token.
 */

/** Compiled to dist/near-market/, so the repository is three levels up. */
const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const merchant = JSON.parse(readFileSync(`${REPO}near/sdk/test/fixtures/snapshot-merchant.testnet.json`, 'utf8')) as Snapshot
const BASE_VERDICT = marketVerdictFromSnapshot(merchant)

/** Built at run time, low entropy on purpose: a test value, not a secret, and no scanner should think otherwise. */
const TOKEN = `aat_${'f00d'.repeat(8)}`
const HOUR = 3_600_000

/** The recorded verdict, re-labelled for whichever account the worker asks about. */
const verdictFor = (t: BriefTarget): MarketVerdict => ({
  ...BASE_VERDICT,
  network: t.network,
  account: t.account,
  caip10: t.caip10,
  decision: { ...BASE_VERDICT.decision, subject: t.account, network: t.network },
})

type Rig = {
  market: FakeMarket
  worker: NearMarketWorker
  logs: string[]
  asked: BriefTarget[]
  clock: { t: number }
  verdict: { next: ((t: BriefTarget) => VerdictResult) | null }
}

async function rig(opts: { fresh?: Rig } = {}): Promise<Rig> {
  const clock = opts.fresh?.clock ?? { t: Date.parse('2026-11-13T10:00:00.000Z') }
  const market = opts.fresh?.market ?? (await startFakeMarket({ token: TOKEN, now: () => clock.t }))
  const logs: string[] = []
  const asked: BriefTarget[] = []
  const verdict: Rig['verdict'] = { next: null }
  const worker = createNearMarketWorker({
    client: createMarketClient({ token: TOKEN, baseUrl: market.baseUrl }),
    log: (line) => logs.push(line),
    now: () => clock.t,
    random: () => 0.5,
    runVerdict: async (t) => {
      asked.push(t)
      return verdict.next ? verdict.next(t) : verdictFor(t)
    },
  })
  return { market, worker, logs, asked, clock, verdict }
}

const calls = (m: FakeMarket, method: string, re: RegExp) => m.requests.filter((r) => r.method === method && re.test(r.path))

test('a fresh hire naming one account is started, checked and delivered once; later polls and a restarted worker submit nothing more', async () => {
  const r = await rig()
  try {
    const id = r.market.hire({ description: 'Before I pay 5 NEAR, check near:testnet:shop-payee.testnet please.' })
    assert.deepEqual(await r.worker.tick(), { kind: 'ok' })
    const s = r.market.state(id)
    assert.equal(s.assignment.status, 'submitted')
    assert.ok(s.assignment.startedAt, 'start was declared before the work')
    assert.equal(s.versions.length, 1)
    assert.deepEqual(r.asked.map((t) => t.caip10), ['near:testnet:shop-payee.testnet'])
    const md = s.versions[0]
    assert.match(md, /^# A-Identity Guard for NEAR: WARN on shop-payee\.testnet \(NEAR testnet\)/)
    assert.ok(md.includes(`cd near && npm run verdict -- shop-payee.testnet --at-block ${BASE_VERDICT.decision.block.height} --json`))
    assert.ok(md.includes('The brief names an amount: 5 NEAR'))
    // The order the lifecycle documents: start, then the state check, then the one submit.
    const order = r.market.requests.map((q) => `${q.method} ${q.path.replace(id, '{id}').replace(/\?.*$/, '')}`)
    const startAt = order.indexOf('POST /v1/assignments/{id}/start')
    const submitAt = order.indexOf('POST /v1/assignments/{id}/submit')
    assert.ok(startAt >= 0 && submitAt > startAt)
    assert.equal(order[submitAt - 1], 'GET /v1/agents/me/assignments', 'the state is read from the API right before the submit')

    r.clock.t += 60_000
    await r.worker.tick()
    const restarted = await rig({ fresh: r })
    await restarted.worker.tick()
    assert.equal(calls(r.market, 'POST', /\/submit$/).length, 1, 'one submit, across polls and a restart')
    assert.equal(r.market.state(id).versions.length, 1)
    assert.deepEqual(restarted.asked, [], 'a delivered round is not checked again')
  } finally {
    await r.market.close()
  }
})

test('an A2A hire takes its account from the opening message\'s parts, and the bid thread of a fresh hire is read once', async () => {
  const r = await rig()
  try {
    const opening = JSON.stringify({ role: 'user', parts: [{ kind: 'text', text: 'Please verify' }, { kind: 'data', data: { account_id: 'merchant-one.near' } }] })
    const a2a = r.market.hire({ description: 'Please verify', a2a: true, openingMessage: opening })
    const viaBid = r.market.hire({ description: 'See what we agreed on the bid.' })
    r.market.bidThread(viaBid, [{ senderSide: 'buyer', body: 'The payee is carol.testnet' }])
    await r.worker.tick()
    assert.equal(r.market.state(a2a).assignment.status, 'accepted', 'an A2A submit is accepted at once')
    assert.match(r.market.state(a2a).versions[0], /CAIP-10: `near:mainnet:merchant-one\.near`/)
    assert.match(r.market.state(viaBid).versions[0], /CAIP-10: `near:testnet:carol\.testnet`/)
    assert.equal(calls(r.market, 'GET', /^\/v1\/bids\//).length, 2, 'each fresh hire reads its bid thread once')
  } finally {
    await r.market.close()
  }
})

test('no single account: one clarifying message, kept to one across polls and a restart; a usable reply is then checked and delivered', async () => {
  const r = await rig()
  try {
    const id = r.market.hire({ description: 'I will pay bob.near from alice.near, is it safe?' })
    await r.worker.tick()
    r.clock.t += 45_000
    await r.worker.tick()
    const restarted = await rig({ fresh: r })
    await restarted.worker.tick()
    const s = r.market.state(id)
    const ours = s.messages.filter((m) => m.side === 'worker')
    assert.equal(ours.length, 1, 'exactly one question')
    assert.ok(ours[0].body.startsWith(CLARIFY_PREFIX))
    assert.match(ours[0].body, /more than one account \(near:mainnet:bob\.near, near:mainnet:alice\.near\)/)
    assert.equal(ours[0].clientRequestId, `a-identity-guard-clarify-${id}`)
    assert.equal(s.assignment.status, 'in_progress')
    assert.equal(s.assignment.startedAt, null, 'not started while the account is unknown: the buyer may still cancel freely')
    assert.equal(calls(r.market, 'POST', /\/submit$/).length, 0)

    r.market.buyerSays(id, 'Sorry: the payee is bob.near')
    r.clock.t += 45_000
    await restarted.worker.tick()
    assert.equal(r.market.state(id).assignment.status, 'submitted')
    assert.deepEqual(restarted.asked.map((t) => t.caip10), ['near:mainnet:bob.near'])
  } finally {
    await r.market.close()
  }
})

test('after the one question: a reply with no account in it is waited on, every reply since is read together, and a reply naming more than one account is declined at once', async () => {
  const r = await rig()
  try {
    // "One sec", then the id and a "thanks" inside one poll: the id is checked, nothing is declined.
    const a = r.market.hire({ description: 'check my payee please' })
    await r.worker.tick()
    r.clock.t += 20_000
    r.market.buyerSays(a, 'one sec, let me find it')
    r.clock.t += 45_000
    await r.worker.tick()
    assert.equal(r.market.state(a).assignment.status, 'in_progress', 'a reply with nothing account-shaped in it is waited on')
    assert.equal(r.market.state(a).assignment.startedAt, null)
    r.clock.t += 40_000
    r.market.buyerSays(a, 'bob.near')
    r.clock.t += 1_000
    r.market.buyerSays(a, 'thanks!')
    r.clock.t += 45_000
    await r.worker.tick()
    assert.equal(r.market.state(a).assignment.status, 'submitted')
    assert.deepEqual(r.asked.map((t) => t.caip10), ['near:mainnet:bob.near'])
    assert.equal(r.market.state(a).messages.filter((m) => m.side === 'worker').length, 1, 'still one question')

    // A reply naming two accounts ends the job at once, before any check ran.
    const b = r.market.hire({ description: 'check my payee please' })
    await r.worker.tick()
    r.clock.t += 20_000
    r.market.buyerSays(b, 'either bob.near or carol.near')
    await r.worker.tick()
    const s = r.market.state(b)
    assert.equal(s.assignment.status, 'cancelled')
    assert.equal(s.assignment.cancelReason, 'rejected')
    assert.match(s.assignment.cancelDetail ?? '', /^Declined before any check ran: nothing was checked and you are refunded in full\./)
    assert.match(s.assignment.cancelDetail ?? '', /the reply names more than one account \(near:mainnet:bob\.near, near:mainnet:carol\.near\)/)
    assert.equal(r.asked.length, 1, 'no verdict was computed for it')
    assert.equal(calls(r.market, 'POST', new RegExp(`/v1/assignments/${b}/submit$`)).length, 0)

    // Replies with no account in them, up to the grace before the deadline: declined then, as no reply.
    const c = r.market.hire({ description: 'check my payee please' })
    await r.worker.tick()
    r.market.buyerSays(c, 'hm, which one do you need?')
    r.clock.t += HOUR - CLARIFY_GRACE_MS
    await r.worker.tick()
    assert.equal(r.market.state(c).assignment.status, 'cancelled')
    assert.match(r.market.state(c).assignment.cancelDetail ?? '', /no reply names one I can read; none arrived before the deadline/)
  } finally {
    await r.market.close()
  }
})

test('a buyer message naming one account and a brief naming another is one question, never a pick; the reply after it decides', async () => {
  const r = await rig()
  try {
    const id = r.market.hire({ description: 'Please check alice.near before I pay it 5 NEAR' })
    r.market.buyerSays(id, 'For context: I already paid bob.near last week')
    await r.worker.tick()
    const ours = r.market.state(id).messages.filter((m) => m.side === 'worker')
    assert.equal(ours.length, 1, 'asked, not picked')
    assert.match(ours[0].body, /more than one account \(near:mainnet:alice\.near, near:mainnet:bob\.near\)/)
    assert.match(ours[0].body, /- near:mainnet:alice\.near: named in the job brief\n- near:mainnet:bob\.near: named in your message/)
    assert.equal(r.asked.length, 0, 'nothing checked yet')
    assert.equal(r.market.state(id).assignment.startedAt, null)

    r.clock.t += 60_000
    r.market.buyerSays(id, 'alice.near is the one to check')
    r.clock.t += 45_000
    await r.worker.tick()
    assert.equal(r.market.state(id).assignment.status, 'submitted')
    assert.deepEqual(r.asked.map((t) => t.caip10), ['near:mainnet:alice.near'])
    assert.ok(r.market.state(id).versions[0].includes('The brief names an amount: 5 NEAR'))

    // A message that names the brief's own account is no disagreement: checked at once.
    const same = r.market.hire({ description: 'check carol.near' })
    r.market.buyerSays(same, 'yes, carol.near, thanks')
    await r.worker.tick()
    assert.equal(r.market.state(same).assignment.status, 'submitted')
    assert.equal(r.market.state(same).messages.filter((m) => m.side === 'worker').length, 0)
  } finally {
    await r.market.close()
  }
})

test('a question the marketplace refuses is not counted as asked: the job is declined at once so the buyer is refunded; a flood of id still asks within 4000 characters', async () => {
  const r = await rig()
  try {
    const flood = r.market.hire({ description: `check ${'a'.repeat(3000)}.near` })
    await r.worker.tick()
    const asked = r.market.state(flood).messages.filter((m) => m.side === 'worker')
    assert.equal(asked.length, 1, 'the question was stored')
    assert.ok(asked[0].body.length <= 4000, `${asked[0].body.length} characters`)
    assert.match(asked[0].body, /longer than 64 characters/)

    const refused = r.market.hire({ description: 'check my payee' })
    r.market.failNext('POST', new RegExp(`/v1/assignments/${refused}/messages$`), 400, { body: { error: 'validation_error', message: 'injected by the test' } })
    await r.worker.tick()
    const s = r.market.state(refused)
    assert.equal(s.assignment.status, 'cancelled')
    assert.equal(s.assignment.cancelReason, 'rejected')
    assert.match(s.assignment.cancelDetail ?? '', /the marketplace refused my question about which account to check \(validation_error\)/)
    assert.ok(!r.logs.some((l) => /counted as asked/.test(l)))
    assert.equal(r.market.state(flood).assignment.status, 'in_progress', 'the other hire still waits for its reply')
  } finally {
    await r.market.close()
  }
})

test('no reply by the grace before the deadline is declined; with too little time left the worker declines without asking', async () => {
  const r = await rig()
  try {
    const id = r.market.hire({ description: 'check alice.near or bob.near' })
    await r.worker.tick()
    r.clock.t += HOUR - CLARIFY_GRACE_MS - 60_000
    await r.worker.tick()
    assert.equal(r.market.state(id).assignment.status, 'in_progress', 'still waiting inside the window')
    r.clock.t += 60_000
    await r.worker.tick()
    assert.equal(r.market.state(id).assignment.status, 'cancelled')
    assert.match(r.market.state(id).assignment.cancelDetail ?? '', /no reply arrived before the deadline/)

    const late = r.market.hire({ description: 'nothing to check here', slaSeconds: 300 })
    await r.worker.tick()
    const s = r.market.state(late)
    assert.equal(s.assignment.status, 'cancelled')
    assert.match(s.assignment.cancelDetail ?? '', /too little time was left before the deadline to ask/)
    assert.equal(s.messages.length, 0, 'no question asked')
  } finally {
    await r.market.close()
  }
})

test('a chain that cannot be read is retried while the deadline allows, then the buyer is told why and the job declined as failed; no verdict is invented', async () => {
  const r = await rig()
  try {
    r.verdict.next = () => ({ code: 'no_verdict', error: 'NEAR testnet could not be read: no endpoint answered block' })
    const id = r.market.hire({ description: 'check bob.testnet' })
    // The first decline's answer is lost: it is sent again as it was, and the buyer is told once.
    r.market.failNext('POST', /\/decline$/, 503)
    for (let i = 0; i < 40 && r.market.state(id).assignment.status === 'in_progress'; i++) {
      await r.worker.tick()
      r.clock.t += 2 * 60_000
    }
    const s = r.market.state(id)
    assert.equal(s.assignment.status, 'cancelled')
    assert.equal(s.assignment.cancelReason, 'failed')
    assert.ok(r.asked.length >= 3, `retried (${r.asked.length} attempts)`)
    assert.equal(s.versions.length, 0, 'nothing delivered')
    const told = s.messages.filter((m) => m.side === 'worker')
    assert.equal(told.length, 1)
    assert.match(told[0].body, /could not run: NEAR testnet could not be read.*No verdict was made up/)
    assert.equal(s.assignment.cancelDetail, told[0].body)
    const declines = calls(r.market, 'POST', /\/decline$/)
    assert.equal(declines.length, 2, 'the lost decline was sent again')
    assert.deepEqual(declines[0].body, declines[1].body, 'with the same reason and detail')
    assert.ok(r.logs.some((l) => /trying again in \d+ s/.test(l)))
  } finally {
    await r.market.close()
  }
})

test('a request for changes naming another account is answered with one new version on that account; the round is not answered twice', async () => {
  const r = await rig()
  try {
    const id = r.market.hire({ description: 'check alice.near' })
    await r.worker.tick()
    r.clock.t += 10 * 60_000
    r.market.requestChanges(id, 'You checked alice.near but I meant bob.near')
    const fresh = await rig({ fresh: r })
    await fresh.worker.tick()
    await fresh.worker.tick()
    const s = r.market.state(id)
    assert.equal(s.assignment.status, 'submitted')
    assert.equal(s.versions.length, 2)
    assert.match(s.versions[1], /CAIP-10: `near:mainnet:bob\.near`/)
    assert.match(s.versions[1], /the account your message names, instead of near:mainnet:alice\.near/)
    assert.deepEqual(fresh.asked.map((t) => t.caip10), ['near:mainnet:bob.near'])
  } finally {
    await r.market.close()
  }
})

test('a submit whose answer was lost goes again with the same Markdown, and a row that changed before the submit gets none', async () => {
  const r = await rig()
  try {
    const id = r.market.hire({ description: 'check dave.testnet' })
    r.market.failNext('POST', /\/submit$/, 503)
    await r.worker.tick()
    assert.equal(r.market.state(id).assignment.status, 'in_progress')
    await r.worker.tick()
    const submits = calls(r.market, 'POST', /\/submit$/)
    assert.equal(submits.length, 2)
    assert.deepEqual(submits[0].body, submits[1].body, 'the very same Markdown')
    assert.equal(r.asked.length, 1, 'the verdict is not computed again for a lost answer')
    assert.equal(r.market.state(id).assignment.status, 'submitted')

    // The state read before the submit gets no answer: the same Markdown waits for the next poll,
    // and the verdict is not computed again.
    const slow = r.market.hire({ description: 'check fay.testnet' })
    r.verdict.next = (t) => {
      r.market.failNext('GET', /^\/v1\/agents\/me\/assignments$/, 503)
      return verdictFor(t)
    }
    await r.worker.tick()
    assert.equal(r.market.state(slow).assignment.status, 'in_progress')
    r.verdict.next = null
    await r.worker.tick()
    assert.equal(r.market.state(slow).assignment.status, 'submitted')
    assert.equal(r.asked.filter((t) => t.account === 'fay.testnet').length, 1)

    // The buyer cancels while the check runs: the state read before the submit sees it.
    const gone = r.market.hire({ description: 'check erin.testnet' })
    r.verdict.next = (t) => {
      r.market.cancel(gone)
      return verdictFor(t)
    }
    await r.worker.tick()
    assert.equal(r.market.state(gone).versions.length, 0)
    assert.ok(r.logs.some((l) => l.includes(`assignment ${gone}: changed before delivery`)))
  } finally {
    await r.market.close()
  }
})

test('a 401, or a 403 on the agent\'s own list, stops the worker with one line; a 403 on one assignment or bid leaves only that one alone; a 5xx or 429 backs off', async () => {
  const r = await rig()
  try {
    r.market.hire({ description: 'check frank.testnet' })
    r.market.revoke()
    assert.deepEqual(await r.worker.tick(), { kind: 'stopped' })
    assert.equal(r.worker.stopped, true)
    const before = r.market.requests.length
    assert.deepEqual(await r.worker.tick(), { kind: 'stopped' })
    assert.equal(r.market.requests.length, before, 'a stopped worker sends nothing')
    assert.equal(r.worker.nextDelayMs({ kind: 'ok' }), null)
    const stops = r.logs.filter((l) => l.startsWith('stopped:'))
    assert.equal(stops.length, 1)
    assert.match(stops[0], /answered 401 to GET \/v1\/agents\/me\/assignments, so the token was revoked or is malformed/)
  } finally {
    await r.market.close()
  }

  const f = await rig()
  try {
    f.market.hire({ description: 'check gina.testnet' })
    f.market.failNext('GET', /^\/v1\/agents\/me\/assignments$/, 403, { body: { error: 'forbidden' } })
    assert.deepEqual(await f.worker.tick(), { kind: 'stopped' })
    assert.match(f.logs.find((l) => l.startsWith('stopped:')) ?? '', /answered 403 to GET \/v1\/agents\/me\/assignments, so the credential does not act as this agent/)
  } finally {
    await f.market.close()
  }

  const h = await rig()
  try {
    // "Valid token, but the resource is not yours": that assignment is left alone, the rest served.
    const foreign = h.market.hire({ description: 'check hal.testnet' })
    const mine = h.market.hire({ description: 'check ida.testnet' })
    const viaBid = h.market.hire({ description: 'check jo.testnet' })
    h.market.failNext('POST', new RegExp(`/v1/assignments/${foreign}/start$`), 403, { body: { error: 'forbidden' } })
    h.market.failNext('GET', /^\/v1\/bids\//, 403, { body: { error: 'forbidden' }, times: 3 })
    assert.deepEqual(await h.worker.tick(), { kind: 'ok' })
    assert.equal(h.worker.stopped, false)
    assert.equal(h.market.state(mine).assignment.status, 'submitted')
    assert.equal(h.market.state(viaBid).assignment.status, 'submitted', 'a bid thread that is not ours to read is read as empty')
    assert.equal(h.market.state(foreign).assignment.status, 'in_progress')
    h.clock.t += 45_000
    assert.deepEqual(await h.worker.tick(), { kind: 'ok' })
    assert.equal(calls(h.market, 'POST', new RegExp(`/v1/assignments/${foreign}/start$`)).length, 1, 'not tried again')
    assert.equal(h.logs.filter((l) => l.includes(`assignment ${foreign}`) && l.includes('403')).length, 1, 'logged once')
    assert.equal(h.logs.filter((l) => l.startsWith('stopped:')).length, 0)
  } finally {
    await h.market.close()
  }

  const g = await rig()
  try {
    g.market.failNext('GET', /^\/v1\/agents\/me\/assignments$/, 503, { times: 2 })
    const first = await g.worker.tick()
    assert.equal(first.kind, 'transient')
    const d1 = g.worker.nextDelayMs(first)!
    const second = await g.worker.tick()
    const d2 = g.worker.nextDelayMs(second)!
    assert.ok(d2 > d1, `the backoff grows (${d1} then ${d2})`)
    g.market.failNext('GET', /^\/v1\/agents\/me\/assignments$/, 429, { retryAfter: 600 })
    const limited = await g.worker.tick()
    assert.ok(g.worker.nextDelayMs(limited)! >= 600_000, 'Retry-After is honoured')
    assert.ok(g.worker.nextDelayMs(limited)! <= BACKOFF_MAX_MS)
    const ok = await g.worker.tick()
    assert.deepEqual(ok, { kind: 'ok' })
    const d = g.worker.nextDelayMs(ok)!
    assert.ok(d >= POLL_MIN_MS && d <= POLL_MAX_MS, `the documented 30-60 s cadence (${d})`)
  } finally {
    await g.market.close()
  }
})

test('the token never reaches a log line, and is never sent anywhere but the marketplace origin', async () => {
  const r = await rig()
  try {
    // An answer that echoes the token back must not carry it into the log.
    r.market.hire({ description: 'check hank.testnet' })
    r.market.failNext('GET', /^\/v1\/agents\/me\/assignments$/, 500, { body: { error: 'internal', message: `bad bearer ${TOKEN}` } })
    await r.worker.tick()
    await r.worker.tick()
    r.market.revoke()
    await r.worker.tick()
    assert.ok(r.logs.length > 0)
    for (const line of r.logs) assert.ok(!line.includes(TOKEN) && !line.includes('f00df00d'), `a log line carries the token: ${line}`)
    assert.ok(r.logs.some((l) => l.includes('aat_[redacted]')))
    assert.ok(r.market.requests.every((q) => q.auth === `Bearer ${TOKEN}`))
  } finally {
    await r.market.close()
  }

  assert.equal(redactToken(`x ${TOKEN} y`, TOKEN), 'x aat_[redacted] y')
  assert.equal(marketBase().origin, 'https://market.near.ai')
  assert.equal(marketBase('https://market.near.ai/v1/anything').origin, 'https://market.near.ai')
  for (const bad of ['https://evil.example', 'http://market.near.ai', 'https://market.near.ai.evil.example', 'http://10.0.0.5:8080']) {
    assert.throws(() => marketBase(bad), /refusing to send the marketplace token/, bad)
  }
  // Redirects are refused rather than followed, and the header goes only to the origin.
  const seen: Array<{ url: string; redirect: string; auth: string | undefined }> = []
  const stub: FetchFn = async (url, init) => {
    seen.push({ url, redirect: init.redirect, auth: init.headers.authorization })
    return { status: 401, headers: { get: () => null }, text: async () => '{"error":"unauthorized"}' }
  }
  const client = createMarketClient({ token: TOKEN, fetch: stub })
  await assert.rejects(client.listAssignments(), MarketAuthError)
  await assert.rejects(client.start('../../evil'), /not a marketplace id/)
  assert.deepEqual(seen, [{ url: 'https://market.near.ai/v1/agents/me/assignments', redirect: 'error', auth: `Bearer ${TOKEN}` }])
})

test('without MARKET_NEAR_AI_TOKEN the worker is off with one line and does nothing else; a malformed token is refused unprinted', async () => {
  const lines: string[] = []
  const timers: number[] = []
  const fetches: string[] = []
  const seams = {
    log: (l: string) => lines.push(l),
    setTimer: (_run: () => void, ms: number) => {
      timers.push(ms)
      return {}
    },
    fetch: (async (url: string) => {
      fetches.push(url)
      throw new Error('no request may be sent')
    }) as unknown as FetchFn,
  }
  assert.equal(startNearMarketWorker({}, seams), null)
  assert.equal(startNearMarketWorker({ MARKET_NEAR_AI_TOKEN: '   ' }, seams), null)
  assert.equal(startNearMarketWorker({ MARKET_NEAR_AI_TOKEN: 'sk-not-a-market-token-1234567890' }, seams), null)
  assert.deepEqual(lines, [
    'off: MARKET_NEAR_AI_TOKEN is not set, so the NEAR AI market worker does not run',
    'off: MARKET_NEAR_AI_TOKEN is not set, so the NEAR AI market worker does not run',
    'off: MARKET_NEAR_AI_TOKEN is set but is not an aat_ agent token (the value is not printed)',
  ])
  assert.deepEqual(timers, [], 'no poll is scheduled')
  assert.deepEqual(fetches, [], 'no request is sent')
})

test('with a token, the first poll is scheduled, runs against the marketplace, and the next one follows on the cadence', async () => {
  const clock = { t: Date.parse('2026-11-13T10:00:00.000Z') }
  const market = await startFakeMarket({ token: TOKEN, now: () => clock.t })
  try {
    const id = market.hire({ description: 'check ivy.testnet' })
    const lines: string[] = []
    const pending: Array<{ run: () => void; ms: number }> = []
    const handle = startNearMarketWorker(
      { MARKET_NEAR_AI_TOKEN: TOKEN },
      {
        baseUrl: market.baseUrl,
        log: (l) => lines.push(l),
        now: () => clock.t,
        random: () => 0,
        runVerdict: async (t) => verdictFor(t),
        setTimer: (run, ms) => {
          pending.push({ run, ms })
          return {}
        },
      },
    )
    assert.ok(handle)
    assert.equal(pending.length, 1)
    assert.equal(pending[0].ms, FIRST_POLL_MS)
    assert.match(lines[0], /^on: polling http:\/\/127\.0\.0\.1:\d+ for this agent's assignments every 30 to 60 s/)
    pending.shift()!.run()
    const queued = () => pending.length
    for (let i = 0; i < 100 && queued() === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(market.state(id).assignment.status, 'submitted')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].ms, POLL_MIN_MS)
    handle.stop()
    pending.shift()!.run()
    assert.equal(market.requests.filter((q) => q.method === 'GET' && q.path.startsWith('/v1/agents/me/assignments')).length, 2, 'a stopped handle polls no more')
    for (const l of lines) assert.ok(!l.includes(TOKEN))

    // On Render the first poll waits past a deploy's overlap with the instance it replaces.
    const later: number[] = []
    const onRender = startNearMarketWorker(
      { MARKET_NEAR_AI_TOKEN: TOKEN, RENDER: 'true' },
      { baseUrl: market.baseUrl, log: (l) => lines.push(l), runVerdict: async (t) => verdictFor(t), setTimer: (_run, ms) => (later.push(ms), {}) },
    )
    assert.ok(onRender)
    assert.deepEqual(later, [RENDER_FIRST_POLL_MS])
    assert.match(lines[lines.length - 1], /the first poll in 120 s; .*one process per token$/)
    onRender.stop()
  } finally {
    await market.close()
  }
})

test('a competition entry is left alone, logged once', async () => {
  const r = await rig()
  try {
    const id = r.market.hire({ description: 'check jay.testnet', jobKind: 'competition', bid: false })
    await r.worker.tick()
    await r.worker.tick()
    const s = r.market.state(id)
    assert.equal(s.assignment.status, 'in_progress')
    assert.equal(s.assignment.startedAt, null)
    assert.equal(r.logs.filter((l) => l.includes('competition entry')).length, 1)
    assert.deepEqual(r.asked, [])
  } finally {
    await r.market.close()
  }
})

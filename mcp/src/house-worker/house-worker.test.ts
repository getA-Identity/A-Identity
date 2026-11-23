/**
 * The house worker, held to what it promises: it delivers only for the agents the operator
 * named, only what the model actually produced, and it says why when it delivers nothing.
 * No test here reaches a model. The SDK call is a function the tests stand in for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import Anthropic from '@anthropic-ai/sdk'
import {
  __resetPlatformStateForTests, createAgent, hireAgent, releaseTask, disputeTask,
  listFundedTasksForAgents, deliverHouseTask, noteHouseTask, claimHouseCall, releaseHouseCall, countHouseCallsSince,
  escrowLocking, HOUSE_CALLS_PER_TASK,
} from '../platform.js'
import type { Task } from '../marketplace.js'
import { houseWorkerConfig, DEFAULT_MODEL, DEFAULT_DAILY_LIMIT, DEFAULT_CLIENT_DAILY_LIMIT, MAX_DAILY_LIMIT } from './config.js'
import { runHouseSkill, houseSkill, MAX_DELIVERABLE_CHARS, type CreateMessage, type WorkOutcome } from './work.js'
import {
  createHouseWorker, startHouseWorker,
  MAX_ATTEMPTS, MAX_TASK_AGE_MS, POLL_MS, BACKOFF_BASE_MS, RETRY_GAP_MS, RENDER_FIRST_POLL_MS, FIRST_POLL_MS,
  LIMIT_NOTE, CLIENT_LIMIT_NOTE, WAIT_NOTE, RETRY_NOTE, gaveUpNote,
} from './worker.js'

// -- fixtures ----------------------------------------------------------------------------------

function seed() {
  const state = __resetPlatformStateForTests()
  const make = (name: string, owner: string) =>
    createAgent({ name, description: 'A worker seeded for a house worker test.', category: 'Translation', capabilities: [], permissions: {}, owner })
  return { state, house: make('House', 'operator@example.test'), other: make('Other', 'someone@example.test') }
}

function fund(tasks: Task[], agentId: string, over: Partial<Task> = {}): Task {
  const at = new Date().toISOString()
  const task: Task = {
    id: `task_${tasks.length + 1}`, client: 'client@example.test', agentId, service: 'translation', priceUsd: 2,
    description: 'Translate "good morning" into Turkish.', status: 'funded', createdAt: at, updatedAt: at, ...over,
  }
  tasks.push(task)
  return task
}

type Created = Awaited<ReturnType<CreateMessage>>
const message = (over: Record<string, unknown> = {}) =>
  ({
    id: 'msg_test', type: 'message', role: 'assistant', model: DEFAULT_MODEL,
    content: [{ type: 'text', text: 'Gunaydin' }], stop_reason: 'end_turn', stop_sequence: null, stop_details: null, ...over,
  }) as unknown as Created

const answers = (m: Created): CreateMessage => async () => m
const throws = (e: unknown): CreateMessage => async () => {
  throw e
}
const apiError = (status: number) => Anthropic.APIError.generate(status, undefined, 'test', new Headers())

const ok = (text = 'Gunaydin'): WorkOutcome => ({ ok: true, text, model: DEFAULT_MODEL })
const silent = () => {}
/** Calls a task was given back after an outage of ours that may still have been billed. */
const outage = (t: Task) => t.workerOutageCalls?.length ?? 0

// -- the switch --------------------------------------------------------------------------------

test('house worker: off when no agent is named, and it says so', () => {
  const c = houseWorkerConfig({ ANTHROPIC_API_KEY: 'k' })
  assert.equal(c.on, false)
  assert.match((c as { reason: string }).reason, /HOUSE_WORKER_AGENT_IDS is not set/)
})

test('house worker: off when the list holds nothing that is an agent id', () => {
  const c = houseWorkerConfig({ HOUSE_WORKER_AGENT_IDS: ' , a b, ../x', ANTHROPIC_API_KEY: 'k' })
  assert.equal(c.on, false)
  assert.match((c as { reason: string }).reason, /no well-formed agent id/)
})

test('house worker: off without a model credential, so a hire waits instead of getting a made-up result', () => {
  const c = houseWorkerConfig({ HOUSE_WORKER_AGENT_IDS: 'agent_abc1' })
  assert.equal(c.on, false)
  assert.match((c as { reason: string }).reason, /no model credential/)
  // A stored profile counts only when the env names it.
  assert.equal(houseWorkerConfig({ HOUSE_WORKER_AGENT_IDS: 'agent_abc1', ANTHROPIC_PROFILE: 'default' }).on, true)
})

test('house worker: on with defaults, counting the entries it left out', () => {
  const c = houseWorkerConfig({ HOUSE_WORKER_AGENT_IDS: 'agent_abc1, agent_abc2, not an id', ANTHROPIC_API_KEY: 'k' })
  assert.equal(c.on, true)
  if (!c.on) return
  assert.deepEqual([...c.agentIds], ['agent_abc1', 'agent_abc2'])
  assert.equal(c.model, DEFAULT_MODEL)
  assert.equal(c.dailyLimit, DEFAULT_DAILY_LIMIT)
  assert.equal(c.clientDailyLimit, DEFAULT_CLIENT_DAILY_LIMIT)
  assert.equal(c.ignored, 1)
})

test('house worker: a malformed model or limit turns it off, and a huge limit is capped', () => {
  const base = { HOUSE_WORKER_AGENT_IDS: 'agent_abc1', ANTHROPIC_API_KEY: 'k' }
  assert.equal(houseWorkerConfig({ ...base, HOUSE_WORKER_MODEL: 'a model; rm' }).on, false)
  assert.equal(houseWorkerConfig({ ...base, HOUSE_WORKER_DAILY_LIMIT: '0' }).on, false)
  assert.equal(houseWorkerConfig({ ...base, HOUSE_WORKER_DAILY_LIMIT: '2.5' }).on, false)
  assert.equal(houseWorkerConfig({ ...base, HOUSE_WORKER_CLIENT_DAILY_LIMIT: 'many' }).on, false)
  const capped = houseWorkerConfig({ ...base, HOUSE_WORKER_DAILY_LIMIT: '999999', HOUSE_WORKER_MODEL: 'claude-sonnet-5-5' })
  assert.equal(capped.on && capped.dailyLimit, MAX_DAILY_LIMIT)
  assert.equal(capped.on && capped.model, 'claude-sonnet-5-5')
  // One client never gets more than the whole day's allowance.
  const tight = houseWorkerConfig({ ...base, HOUSE_WORKER_DAILY_LIMIT: '2', HOUSE_WORKER_CLIENT_DAILY_LIMIT: '9' })
  assert.equal(tight.on && tight.clientDailyLimit, 2)
})

// -- the work ----------------------------------------------------------------------------------

test('house work: a finished answer is the result, asked for with the skill prompt, low effort and the refusal fallback', async () => {
  let sent: Parameters<CreateMessage>[0] | undefined
  let options: Parameters<CreateMessage>[1] | undefined
  const out = await runHouseSkill({ service: 'Translation', request: '  Translate "hi" into Turkish.  ', model: DEFAULT_MODEL }, async (body, opts) => {
    sent = body
    options = opts
    return message({ content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Merhaba ' }] })
  })
  assert.deepEqual(out, { ok: true, text: 'Merhaba', model: DEFAULT_MODEL })
  // The SDK's own retries are off: the worker retries, one counted call at a time.
  assert.equal(options?.maxRetries, 0)
  assert.ok(options && options.timeout > 0)
  assert.equal(sent?.model, DEFAULT_MODEL)
  assert.equal(sent?.system, houseSkill('translation')?.system)
  assert.deepEqual(sent?.messages, [{ role: 'user', content: 'Translate "hi" into Turkish.' }])
  assert.deepEqual(sent?.output_config, { effort: 'low' })
  assert.equal(sent?.fallbacks, 'default')
  assert.deepEqual(sent?.betas, ['server-side-fallback-2026-07-01'])
})

test('house work: a model that would reject the fallback parameter gets a plain request', async () => {
  let sent: Parameters<CreateMessage>[0] | undefined
  await runHouseSkill({ service: 'translation', request: 'x', model: 'claude-haiku-5-5' }, async (body) => {
    sent = body
    return message()
  })
  assert.equal(sent?.fallbacks, undefined)
  assert.equal(sent?.betas, undefined)
})

test('house work: a declined request is not a result, even when it carries text', async () => {
  const out = await runHouseSkill(
    { service: 'translation', request: 'x', model: DEFAULT_MODEL },
    answers(message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } })),
  )
  assert.deepEqual(out, { ok: false, kind: 'job', reason: 'the model declined this request' })
})

test('house work: an answer cut off at the token limit is not a result', async () => {
  const out = await runHouseSkill({ service: 'translation', request: 'x', model: DEFAULT_MODEL }, answers(message({ stop_reason: 'max_tokens' })))
  assert.equal(out.ok, false)
  assert.equal(!out.ok && out.kind, 'job')
})

test('house work: an answer with no text is a failed try, not an empty delivery', async () => {
  const out = await runHouseSkill({ service: 'translation', request: 'x', model: DEFAULT_MODEL }, answers(message({ content: [{ type: 'text', text: '  ' }] })))
  assert.deepEqual(out, { ok: false, kind: 'retry', reason: 'the model returned no text' })
})

test('house work: a result too long for a delivery is refused whole rather than cut', async () => {
  const long = 'a'.repeat(MAX_DELIVERABLE_CHARS + 1)
  const out = await runHouseSkill({ service: 'translation', request: 'x', model: DEFAULT_MODEL }, answers(message({ content: [{ type: 'text', text: long }] })))
  assert.equal(out.ok, false)
  assert.equal(!out.ok && out.kind, 'job')
})

test('house work: an unknown service and an empty job never reach the model', async () => {
  let calls = 0
  const count: CreateMessage = async () => {
    calls++
    return message()
  }
  const noSkill = await runHouseSkill({ service: 'grant-coach', request: 'x', model: DEFAULT_MODEL }, count)
  const noText = await runHouseSkill({ service: 'translation', request: '   ', model: DEFAULT_MODEL }, count)
  assert.equal(!noSkill.ok && noSkill.kind, 'job')
  assert.equal(!noText.ok && noText.kind, 'job')
  assert.equal(calls, 0)
})

test('house work: API failures are sorted by who can fix them', async () => {
  const run = (e: unknown) => runHouseSkill({ service: 'translation', request: 'x', model: DEFAULT_MODEL }, throws(e))
  const kind = async (e: unknown) => {
    const out = await run(e)
    return out.ok ? 'ok' : out.kind
  }
  assert.equal(await kind(apiError(401)), 'operator')
  assert.equal(await kind(apiError(403)), 'operator')
  assert.equal(await kind(apiError(429)), 'operator')
  assert.equal(await kind(apiError(404)), 'operator')
  assert.equal(await kind(apiError(529)), 'operator')
  assert.equal(await kind(new Anthropic.APIConnectionError({ message: 'down' })), 'operator')
  assert.equal(await kind(apiError(400)), 'job')
  // The account cannot be charged: ours to fix, and no task is given up over it.
  assert.equal(await kind(apiError(402)), 'operator')
  // A call that ran out of time is a try of this job, so one slow job cannot hold the queue.
  assert.equal(await kind(new Anthropic.APIConnectionTimeoutError({ message: 'timed out' })), 'retry')
  assert.equal(await kind(apiError(408)), 'retry')
  // No credential could be resolved, or a stored one expired: our side, not the job's.
  assert.equal(await kind(new Anthropic.AnthropicError('the stored token has expired')), 'operator')
  assert.equal(await kind(new Error('boom')), 'retry')
  // Turned away before any model ran, so the call is not billed: the outcome says so, and
  // says it for nothing else.
  const noCall = async (e: unknown) => {
    const out = await run(e)
    return !out.ok && out.noCall === true
  }
  for (const status of [401, 402, 403, 404, 429]) assert.equal(await noCall(apiError(status)), true, String(status))
  assert.equal(await noCall(apiError(529)), false)
  assert.equal(await noCall(new Anthropic.APIConnectionError({ message: 'down' })), false)
  assert.equal(await noCall(new Anthropic.APIConnectionTimeoutError({ message: 'timed out' })), false)
  assert.equal(await noCall(apiError(400)), false)
  // An account that cannot be charged has answered 400 as well, in words about the account.
  // That is ours to fix, so no job is given up over it.
  const broke = await run(Anthropic.APIError.generate(400, undefined, 'Your credit balance is too low to access the API.', new Headers()))
  assert.ok(!broke.ok && broke.kind === 'operator' && broke.noCall === true)
  // The reason is for the client and never carries the error's own text, which can hold a
  // request id. The detail does, and it goes to the server log only.
  const out = await run(Anthropic.APIError.generate(401, undefined, 'secret-looking detail', new Headers()))
  assert.ok(!out.ok && !out.reason.includes('secret-looking'))
  assert.ok(!out.ok && out.detail?.includes('secret-looking'))
})

test('house work: a request whose options are refused is tried once more as a plain request', async () => {
  const sent: Parameters<CreateMessage>[0][] = []
  const picky: CreateMessage = async (body) => {
    sent.push(body)
    if (body.output_config || body.fallbacks) throw apiError(400)
    return message()
  }
  const out = await runHouseSkill({ service: 'translation', request: 'x', model: DEFAULT_MODEL }, picky)
  assert.equal(out.ok, true)
  assert.equal(sent.length, 2)
  assert.deepEqual(Object.keys(sent[1]).sort(), ['max_tokens', 'messages', 'model', 'system'])
  // A request refused both ways is the job's problem, after exactly two calls.
  let calls = 0
  const never: CreateMessage = async () => {
    calls++
    throw apiError(400)
  }
  const refused = await runHouseSkill({ service: 'translation', request: 'x', model: DEFAULT_MODEL }, never)
  assert.equal(!refused.ok && refused.kind, 'job')
  assert.equal(calls, 2)
})

// -- the platform side -------------------------------------------------------------------------

test('house queue: only funded tasks of the named agents, oldest first', () => {
  const { state, house, other } = seed()
  const newer = fund(state.tasks, house.id, { createdAt: '2026-11-22T10:00:00.000Z' })
  const older = fund(state.tasks, house.id, { createdAt: '2026-11-22T09:00:00.000Z' })
  fund(state.tasks, house.id, { status: 'delivered' })
  fund(state.tasks, other.id)
  assert.deepEqual(listFundedTasksForAgents(new Set([house.id])).map((t) => t.id), [older.id, newer.id])
  assert.deepEqual(listFundedTasksForAgents(new Set()), [])
})

test('house delivery: refused for an agent off the list and for an empty result; a real one is marked as ours', () => {
  const { state, house, other } = seed()
  const mine = fund(state.tasks, house.id, { workerNote: 'waiting', workerAttempts: 1 })
  const theirs = fund(state.tasks, other.id)
  const allowed = new Set([house.id])
  assert.match((deliverHouseTask({ taskId: theirs.id, deliverable: 'x', model: 'm', allowedAgentIds: allowed }) as { error: string }).error, /not a house worker/)
  assert.equal(theirs.status, 'funded')
  assert.match((deliverHouseTask({ taskId: mine.id, deliverable: '   ', model: 'm', allowedAgentIds: allowed }) as { error: string }).error, /empty result/)
  assert.equal(mine.status, 'funded')

  const done = deliverHouseTask({ taskId: mine.id, deliverable: ' Gunaydin ', model: DEFAULT_MODEL, allowedAgentIds: allowed })
  assert.ok(!('error' in done))
  assert.equal(mine.status, 'delivered')
  assert.equal(mine.deliverable, 'Gunaydin')
  assert.equal(mine.deliveredBy, 'house')
  assert.equal(mine.deliveryModel, DEFAULT_MODEL)
  assert.ok(mine.deliveredAt)
  assert.equal(mine.workerNote, undefined)
  assert.match(house.activity[house.activity.length - 1].text, /house worker/)
  // Delivered once: a second delivery of the same task is refused by the state machine.
  assert.match((deliverHouseTask({ taskId: mine.id, deliverable: 'again', model: 'm', allowedAgentIds: allowed }) as { error: string }).error, /Cannot deliver/)
})

test('house note: the task stays funded, the count is stored, and the tally counts only our deliveries', () => {
  const { state, house, other } = seed()
  const task = fund(state.tasks, house.id)
  const allowed = new Set([house.id])
  noteHouseTask({ taskId: task.id, note: 'The worker is trying again.', attempts: 2, allowedAgentIds: allowed })
  assert.equal(task.status, 'funded')
  assert.equal(task.workerNote, 'The worker is trying again.')
  assert.equal(task.workerAttempts, 2)
  // A note with no attempt count keeps the stored one.
  noteHouseTask({ taskId: task.id, note: 'Still waiting.', allowedAgentIds: allowed })
  assert.equal(task.workerAttempts, 2)
  assert.match((noteHouseTask({ taskId: fund(state.tasks, other.id).id, note: 'x', allowedAgentIds: allowed }) as { error: string }).error, /not a house worker/)

  deliverHouseTask({ taskId: task.id, deliverable: 'done', model: 'm', allowedAgentIds: allowed })
  assert.match((noteHouseTask({ taskId: task.id, note: 'late', allowedAgentIds: allowed }) as { error: string }).error, /Cannot note/)
})

test('house calls: each one is recorded before it is made, counted per client, and refused for a task that is not waiting', () => {
  const { state, house, other } = seed()
  const allowed = new Set([house.id])
  const mine = fund(state.tasks, house.id, { client: 'a@example.test' })
  const theirs = fund(state.tasks, house.id, { client: 'b@example.test' })
  const since = new Date(Date.now() - 1000).toISOString()
  assert.equal(countHouseCallsSince(since), 0)
  assert.ok(!('error' in claimHouseCall({ taskId: mine.id, allowedAgentIds: allowed })))
  assert.ok(!('error' in claimHouseCall({ taskId: mine.id, allowedAgentIds: allowed })))
  assert.ok(!('error' in claimHouseCall({ taskId: theirs.id, allowedAgentIds: allowed })))
  assert.equal(countHouseCallsSince(since), 3)
  assert.equal(countHouseCallsSince(since, 'a@example.test'), 2)
  assert.equal(countHouseCallsSince(since, 'b@example.test'), 1)
  assert.equal(countHouseCallsSince(new Date(Date.now() + 60_000).toISOString()), 0)
  // Off the list, already settled, still locking, or out of calls: no call is recorded.
  assert.match((claimHouseCall({ taskId: fund(state.tasks, other.id).id, allowedAgentIds: allowed }) as { error: string }).error, /not a house worker/)
  assert.match((claimHouseCall({ taskId: fund(state.tasks, house.id, { status: 'refunded' }).id, allowedAgentIds: allowed }) as { error: string }).error, /Cannot work/)
  assert.match((claimHouseCall({ taskId: fund(state.tasks, house.id, { escrowLockingAt: new Date().toISOString() }).id, allowedAgentIds: allowed }) as { error: string }).error, /still locking/)
  const spent = fund(state.tasks, house.id, { workerCalls: Array.from({ length: HOUSE_CALLS_PER_TASK }, () => '2020-01-01T00:00:00.000Z') })
  assert.match((claimHouseCall({ taskId: spent.id, allowedAgentIds: allowed }) as { error: string }).error, /every model call/)
  assert.equal(countHouseCallsSince(since), 3)
})

test('house calls: one given back after a failure of ours costs the task and its client nothing, and the day only when it may have been billed', () => {
  const { state, house, other } = seed()
  const allowed = new Set([house.id])
  const task = fund(state.tasks, house.id, { client: 'a@example.test' })
  const since = new Date(Date.now() - 1000).toISOString()
  // Turned away before any model ran: the record is removed.
  claimHouseCall({ taskId: task.id, allowedAgentIds: allowed })
  assert.ok(!('error' in releaseHouseCall({ taskId: task.id, billable: false, allowedAgentIds: allowed })))
  assert.deepEqual(task.workerCalls, [])
  assert.equal(outage(task), 0)
  assert.equal(countHouseCallsSince(since), 0)
  // The service broke mid-call: it may have been billed, so the day still counts it.
  claimHouseCall({ taskId: task.id, allowedAgentIds: allowed })
  releaseHouseCall({ taskId: task.id, billable: true, allowedAgentIds: allowed })
  assert.deepEqual(task.workerCalls, [])
  assert.equal(outage(task), 1)
  assert.equal(countHouseCallsSince(since), 1)
  assert.equal(countHouseCallsSince(since, 'a@example.test'), 0)
  // Nothing to give back, or not ours to touch.
  assert.match((releaseHouseCall({ taskId: task.id, billable: false, allowedAgentIds: allowed }) as { error: string }).error, /no recorded call/)
  const foreign = fund(state.tasks, other.id, { workerCalls: ['2020-01-01T00:00:00.000Z'] })
  assert.match((releaseHouseCall({ taskId: foreign.id, billable: false, allowedAgentIds: allowed }) as { error: string }).error, /not a house worker/)
  assert.equal(foreign.workerCalls?.length, 1)
})

test('escrow lock: a hire is marked while its escrow locks, and nothing settles or works it until the lock ends', async () => {
  const { state, house } = seed()
  house.kya = 'verified'
  house.services = [{ name: 'translation', priceUsd: 2, unit: 'per doc' }]
  const client = 'client@example.test'
  // The code before the first await runs at once: the task is in the list, funded and marked.
  const hiring = hireAgent({ agentId: house.id, service: 'translation', priceUsd: 2, description: 'x', client })
  const task = state.tasks[state.tasks.length - 1]
  assert.equal(task.status, 'funded')
  assert.equal(escrowLocking(task), true)
  assert.deepEqual(listFundedTasksForAgents(new Set([house.id])), [], 'the worker does not see it yet')
  // A lock can outlast any clock: however old its mark reads, the task is locking for as long
  // as this process is still running the lock.
  task.escrowLockingAt = new Date(Date.now() - 10 * 60_000).toISOString()
  assert.equal(escrowLocking(task), true)
  assert.deepEqual(listFundedTasksForAgents(new Set([house.id])), [])
  await hiring
  // The lock ended (here with no signer, so nothing was locked on chain): the mark is gone.
  assert.equal(task.escrowLockingAt, undefined)
  assert.equal(listFundedTasksForAgents(new Set([house.id])).length, 1)

  // While a lock is running, neither way of settling goes through. Marked by hand here, so the
  // check does not depend on how long a lock happens to take.
  task.escrowLockingAt = new Date().toISOString()
  assert.match((await disputeTask(task.id, 'x', client) as { error: string }).error, /still locking/)
  assert.equal(task.status, 'funded')
  // An owner can still deliver by hand during a lock. The payment waits for the lock even so.
  task.status = 'delivered'
  assert.match((await releaseTask(task.id, {}, client) as { error: string }).error, /still locking/)
  assert.equal(task.status, 'delivered')
  task.status = 'funded'
  // A mark left behind by a process that ended mid-lock does not hold the task forever.
  task.escrowLockingAt = new Date(Date.now() - 10 * 60_000).toISOString()
  assert.equal(escrowLocking(task), false)
  assert.equal(listFundedTasksForAgents(new Set([house.id])).length, 1)
})

// -- the loop ----------------------------------------------------------------------------------

function worker(house: { id: string }, over: Partial<Parameters<typeof createHouseWorker>[0]> = {}) {
  return createHouseWorker({ agentIds: new Set([house.id]), model: DEFAULT_MODEL, dailyLimit: 50, clientDailyLimit: 50, log: silent, ...over })
}

test('house loop: a hire of a house agent is delivered, and another agent\'s hire is left alone', async () => {
  const { state, house, other } = seed()
  const mine = fund(state.tasks, house.id)
  const theirs = fund(state.tasks, other.id)
  const asked: string[] = []
  const w = worker(house, {
    work: async (input) => {
      asked.push(`${input.service}|${input.request}|${input.model}`)
      return ok()
    },
  })
  const result = await w.tick()
  assert.deepEqual(result, { delivered: 1, backoff: false })
  assert.equal(w.nextDelayMs(result), POLL_MS)
  assert.equal(mine.status, 'delivered')
  assert.equal(mine.deliverable, 'Gunaydin')
  assert.equal(mine.deliveredBy, 'house')
  assert.equal(theirs.status, 'funded')
  assert.deepEqual(asked, [`translation|${mine.description}|${DEFAULT_MODEL}`])
  // Nothing left to do: the next poll calls no model.
  await w.tick()
  assert.equal(asked.length, 1)
})

test('house loop: a job that cannot be done gets a reason once and is not tried again', async () => {
  const { state, house } = seed()
  const task = fund(state.tasks, house.id)
  let calls = 0
  const w = worker(house, {
    work: async () => {
      calls++
      return { ok: false, kind: 'job', reason: 'the model declined this request' }
    },
  })
  await w.tick()
  await w.tick()
  assert.equal(calls, 1)
  assert.equal(task.status, 'funded')
  assert.equal(task.workerNote, gaveUpNote('the model declined this request'))
  assert.equal(task.workerAttempts, MAX_ATTEMPTS)
})

test('house loop: a failed try waits, is counted, and the worker gives up at its limit', async () => {
  const { state, house } = seed()
  const task = fund(state.tasks, house.id)
  let t = Date.now()
  let calls = 0
  const w = worker(house, {
    now: () => t,
    work: async () => {
      calls++
      return { ok: false, kind: 'retry', reason: 'the model returned no text' }
    },
  })
  await w.tick()
  assert.equal(calls, 1)
  assert.equal(task.workerNote, RETRY_NOTE)
  assert.equal(task.workerAttempts, 1)
  // Not due yet: the next poll does not call the model again.
  await w.tick()
  assert.equal(calls, 1)
  t += RETRY_GAP_MS + 1
  await w.tick()
  assert.equal(task.workerAttempts, 2)
  t += RETRY_GAP_MS * 2 + 1
  await w.tick()
  assert.equal(calls, MAX_ATTEMPTS)
  assert.equal(task.workerAttempts, MAX_ATTEMPTS)
  assert.equal(task.workerNote, gaveUpNote('the model returned no text'))
  t += RETRY_GAP_MS * 10
  await w.tick()
  assert.equal(calls, MAX_ATTEMPTS)
  assert.equal(task.status, 'funded')
})

test('house loop: when our side is down the task is not blamed, the client is told, and polls back off', async () => {
  const { state, house } = seed()
  const first = fund(state.tasks, house.id, { createdAt: new Date(Date.now() - 5000).toISOString() })
  const second = fund(state.tasks, house.id)
  let calls = 0
  let down = true
  const w = worker(house, {
    work: async () => {
      calls++
      return down ? { ok: false, kind: 'operator', reason: 'the model credential was rejected' } : ok()
    },
  })
  const r1 = await w.tick()
  assert.deepEqual(r1, { delivered: 0, backoff: true })
  // One call, then it stops: the second task is not thrown at a model that just failed.
  assert.equal(calls, 1)
  assert.equal(first.workerNote, WAIT_NOTE)
  assert.equal(first.workerAttempts, undefined)
  assert.equal(second.workerNote, undefined)
  assert.equal(w.nextDelayMs(r1), BACKOFF_BASE_MS)
  const r2 = await w.tick()
  assert.equal(w.nextDelayMs(r2), BACKOFF_BASE_MS * 2)
  down = false
  const r3 = await w.tick()
  assert.equal(r3.delivered, 2)
  assert.equal(w.nextDelayMs(r3), POLL_MS)
  assert.equal(first.workerNote, undefined)
})

test('house loop: an outage on our side uses up neither the task nor its client, however long it lasts', async () => {
  const { state, house } = seed()
  const task = fund(state.tasks, house.id)
  let outcome: WorkOutcome = { ok: false, kind: 'operator', reason: 'the model account cannot be charged', noCall: true }
  const w = worker(house, { dailyLimit: 4, clientDailyLimit: 2, work: async () => outcome })
  // More failed polls than a task or a client may ever take calls.
  for (let i = 0; i < HOUSE_CALLS_PER_TASK + 3; i++) assert.deepEqual(await w.tick(), { delivered: 0, backoff: true })
  assert.deepEqual(task.workerCalls, [])
  assert.equal(outage(task), 0)
  assert.equal(task.workerNote, WAIT_NOTE)
  assert.equal(task.workerAttempts, undefined)
  // A failure that may have been billed counts against the day and nothing else.
  outcome = { ok: false, kind: 'operator', reason: 'the model service failed (529)' }
  for (let i = 0; i < 3; i++) await w.tick()
  assert.deepEqual(task.workerCalls, [])
  assert.equal(outage(task), 3)
  assert.equal(task.workerAttempts, undefined)
  // The cause is fixed: the same task is delivered, with the one call the day has left.
  outcome = ok()
  assert.equal((await w.tick()).delivered, 1)
  assert.equal(task.status, 'delivered')
  // And the day is then spent, for the next hire, by the calls that may have been billed.
  const next = fund(state.tasks, house.id, { client: 'b@example.test' })
  await w.tick()
  assert.equal(next.workerNote, LIMIT_NOTE)
})

test('house ration: the day is counted in model calls, so a call that comes to nothing still counts', async () => {
  const { state, house } = seed()
  const t0 = Date.now()
  const a = fund(state.tasks, house.id, { createdAt: new Date(t0 - 3000).toISOString() })
  const b = fund(state.tasks, house.id, { createdAt: new Date(t0 - 2000).toISOString() })
  const c = fund(state.tasks, house.id, { createdAt: new Date(t0 - 1000).toISOString() })
  let calls = 0
  const w = worker(house, {
    dailyLimit: 2,
    // Billed, and never a delivery: an answer too long to store.
    work: async () => {
      calls++
      return { ok: false, kind: 'job', reason: 'the result was longer than a delivery can hold' }
    },
  })
  const result = await w.tick()
  assert.equal(result.delivered, 0)
  assert.equal(calls, 2, 'two calls were made and both count, though nothing was delivered')
  assert.equal(a.workerCalls?.length, 1)
  assert.equal(b.workerCalls?.length, 1)
  assert.equal(c.workerCalls, undefined)
  assert.equal(c.workerNote, LIMIT_NOTE)
  assert.equal(c.status, 'funded')
  // The ceiling holds on the next polls too.
  await w.tick()
  assert.equal(calls, 2)
})

test('house ration: one client cannot use up the day for everyone', async () => {
  const { state, house } = seed()
  const t0 = Date.now()
  const first = fund(state.tasks, house.id, { client: 'greedy@example.test', createdAt: new Date(t0 - 3000).toISOString() })
  const second = fund(state.tasks, house.id, { client: 'greedy@example.test', createdAt: new Date(t0 - 2000).toISOString() })
  const fair = fund(state.tasks, house.id, { client: 'fair@example.test', createdAt: new Date(t0 - 1000).toISOString() })
  const w = worker(house, { clientDailyLimit: 1, work: async () => ok() })
  const result = await w.tick()
  assert.equal(result.delivered, 2)
  assert.equal(first.status, 'delivered')
  assert.equal(second.status, 'funded')
  assert.equal(second.workerNote, CLIENT_LIMIT_NOTE)
  assert.equal(second.workerCalls, undefined)
  assert.equal(fair.status, 'delivered')
})

test('house loop: a task cancelled while an earlier one was being worked costs no call', async () => {
  const { state, house } = seed()
  const t0 = Date.now()
  fund(state.tasks, house.id, { createdAt: new Date(t0 - 2000).toISOString() })
  const cancelled = fund(state.tasks, house.id, { createdAt: new Date(t0 - 1000).toISOString() })
  let calls = 0
  const w = worker(house, {
    work: async () => {
      calls++
      cancelled.status = 'refunded' // the client cancels the second while the first is being worked
      return ok()
    },
  })
  await w.tick()
  assert.equal(calls, 1)
  assert.equal(cancelled.workerCalls, undefined)
})

test('house loop: a task that has spent every call it may take is given up once, with a reason', async () => {
  const { state, house } = seed()
  const task = fund(state.tasks, house.id, { workerCalls: Array.from({ length: HOUSE_CALLS_PER_TASK }, () => new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()) })
  let calls = 0
  const w = worker(house, {
    work: async () => {
      calls++
      return ok()
    },
  })
  await w.tick()
  await w.tick()
  assert.equal(calls, 0)
  assert.equal(task.workerAttempts, MAX_ATTEMPTS)
  assert.match(task.workerNote ?? '', /could not do this job/)
})

test('house loop: a hire older than its escrow is left to the client', async () => {
  const { state, house } = seed()
  const stale = fund(state.tasks, house.id, { createdAt: new Date(Date.now() - MAX_TASK_AGE_MS - 60_000).toISOString() })
  let calls = 0
  const w = worker(house, {
    work: async () => {
      calls++
      return ok()
    },
  })
  await w.tick()
  assert.equal(calls, 0)
  assert.equal(stale.status, 'funded')
  assert.equal(stale.workerNote, undefined)
})

test('house loop: one poll at a time, and a result that arrives after stop is not stored', async () => {
  const { state, house } = seed()
  const task = fund(state.tasks, house.id)
  let release: (o: WorkOutcome) => void = () => {}
  let calls = 0
  const w = worker(house, {
    work: () => {
      calls++
      return new Promise<WorkOutcome>((resolve) => {
        release = resolve
      })
    },
  })
  const running = w.tick()
  // A timer firing while the model is still answering starts nothing.
  assert.deepEqual(await w.tick(), { delivered: 0, backoff: false })
  assert.equal(calls, 1)
  w.stop()
  release(ok())
  assert.deepEqual(await running, { delivered: 0, backoff: false })
  assert.equal(task.status, 'funded')
  assert.equal(w.stopped, true)
})

test('house loop: a result for a task the client already refunded is dropped, not forced in', async () => {
  const { state, house } = seed()
  const task = fund(state.tasks, house.id)
  const lines: string[] = []
  const w = worker(house, {
    log: (l) => lines.push(l),
    work: async () => {
      task.status = 'refunded'
      return ok()
    },
  })
  const result = await w.tick()
  assert.equal(result.delivered, 0)
  assert.equal(task.status, 'refunded')
  assert.equal(task.deliverable, undefined)
  assert.ok(lines.some((l) => l.includes('was not stored')))
})

test('house worker start: off writes one line and schedules nothing; on waits past a deploy overlap and stops on request', async () => {
  const { state, house } = seed()
  const lines: string[] = []
  const timers: { run: () => void; ms: number }[] = []
  const setTimer = (run: () => void, ms: number) => {
    timers.push({ run, ms })
    return {}
  }
  assert.equal(startHouseWorker({}, { log: (l) => lines.push(l), setTimer }), null)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^off: /)
  assert.equal(timers.length, 0)

  const env = { HOUSE_WORKER_AGENT_IDS: house.id, ANTHROPIC_API_KEY: 'not-a-real-key' }
  const local = startHouseWorker(env, { log: (l) => lines.push(l), setTimer, work: async () => ok() })
  assert.ok(local)
  assert.equal(timers[0].ms, FIRST_POLL_MS)
  assert.match(lines[1], /^on: delivering hires for 1 worker agent/)
  assert.ok(!lines.join('\n').includes('not-a-real-key'))

  const task = fund(state.tasks, house.id)
  timers[0].run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(task.status, 'delivered')
  assert.equal(timers[1].ms, POLL_MS)
  local.stop()
  const before = timers.length
  timers[1].run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.length, before)

  const hosted = startHouseWorker({ ...env, RENDER: 'true' }, { log: silent, setTimer })
  assert.equal(timers[timers.length - 1].ms, RENDER_FIRST_POLL_MS)
  hosted?.stop()
})

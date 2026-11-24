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
import { runHouseSkill, runHouseSkillOpenAI, houseSkill, MAX_DELIVERABLE_CHARS, OPEN_MAX_TOKENS, type CreateMessage, type PostChat, type WorkOutcome } from './work.js'
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

// -- the other way to reach a model ------------------------------------------------------------
//
// An operator with no Anthropic account can name any service that speaks the OpenAI chat
// completions shape. It is held to the same promises: nothing made up, the same sorting of
// failures, and a key that goes to one host in one header and into no log.

const OPEN_ENV = {
  HOUSE_WORKER_OPENAI_BASE_URL: 'https://models.example.test/v1/',
  HOUSE_WORKER_OPENAI_API_KEY: 'sk-test-not-real',
  HOUSE_WORKER_MODEL: '@cf/meta/llama-3.3-70b-instruct',
}
const openInput = { service: 'translation', request: 'x', model: 'm-1', baseUrl: 'https://models.example.test/v1', apiKey: 'sk-test-not-real' }
const chat = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ model: 'served-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Gunaydin' } }], ...over })

test('house worker: another provider is on only with its URL, key and model, and it is the one used when named', () => {
  const c = houseWorkerConfig({ HOUSE_WORKER_AGENT_IDS: 'agent_abc1', ANTHROPIC_API_KEY: 'k', ...OPEN_ENV })
  assert.ok(c.on)
  assert.deepEqual(c.provider, { kind: 'openai-compatible', baseUrl: 'https://models.example.test/v1', apiKey: 'sk-test-not-real', host: 'models.example.test' })
  assert.equal(c.model, '@cf/meta/llama-3.3-70b-instruct')
  // The Anthropic path is the default and reads as it did.
  const a = houseWorkerConfig({ HOUSE_WORKER_AGENT_IDS: 'agent_abc1', ANTHROPIC_API_KEY: 'k' })
  assert.ok(a.on && a.provider.kind === 'anthropic' && a.model === DEFAULT_MODEL)
  const answer = (over: Record<string, string>) => {
    const r = houseWorkerConfig({ HOUSE_WORKER_AGENT_IDS: 'agent_abc1', ...OPEN_ENV, ...over })
    return r.on ? 'on' : r.reason
  }
  assert.match(answer({ HOUSE_WORKER_OPENAI_API_KEY: '' }), /HOUSE_WORKER_OPENAI_API_KEY is not/)
  assert.match(answer({ HOUSE_WORKER_MODEL: '' }), /HOUSE_WORKER_MODEL is not/)
  assert.match(answer({ HOUSE_WORKER_MODEL: 'has spaces' }), /not a model id/)
  // Job text and the key only ever go to a plain https address.
  for (const url of ['http://models.example.test/v1', 'https://user:pass@models.example.test/v1', 'https://models.example.test/v1?x=1', 'not a url']) {
    assert.match(answer({ HOUSE_WORKER_OPENAI_BASE_URL: url }), /not a plain https URL/, url)
  }
  assert.equal(answer({ HOUSE_WORKER_OPENAI_BASE_URL: 'http://localhost:11434/v1' }), 'on')
})

test('house work, other provider: the job goes out as system and user messages with the key in one header, and a finished answer is the result', async () => {
  const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const post: PostChat = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
    return { status: 200, text: chat() }
  }
  const out = await runHouseSkillOpenAI({ ...openInput, request: '  Translate "good morning" into Turkish.  ' }, post)
  assert.deepEqual(out, { ok: true, text: 'Gunaydin', model: 'served-model' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://models.example.test/v1/chat/completions')
  assert.equal(sent[0].headers.Authorization, 'Bearer sk-test-not-real')
  assert.equal(sent[0].body.model, 'm-1')
  assert.equal(sent[0].body.max_tokens, OPEN_MAX_TOKENS)
  const messages = sent[0].body.messages as { role: string; content: string }[]
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user'])
  assert.equal(messages[0].content, houseSkill('translation')?.system)
  assert.equal(messages[1].content, 'Translate "good morning" into Turkish.')
  assert.ok(!JSON.stringify(sent[0].body).includes('sk-test-not-real'), 'the key is never in the body')
  // An unknown service and an empty job never reach the provider.
  let calls = 0
  const never: PostChat = async () => {
    calls++
    return { status: 200, text: chat() }
  }
  assert.equal((await runHouseSkillOpenAI({ ...openInput, service: 'astrology' }, never)).ok, false)
  assert.equal((await runHouseSkillOpenAI({ ...openInput, request: '   ' }, never)).ok, false)
  assert.equal(calls, 0)
})

test('house work, other provider: a cut-off, declined, empty or oversized answer is never a result', async () => {
  const run = (text: string) => runHouseSkillOpenAI(openInput, async () => ({ status: 200, text }))
  const read = async (text: string) => {
    const o = await run(text)
    return o.ok ? 'ok' : `${o.kind}: ${o.reason}`
  }
  const choice = (finish_reason: string, content: unknown) => chat({ choices: [{ finish_reason, message: { content } }] })
  assert.match(await read(choice('length', 'half an ans')), /^job: the answer did not fit/)
  assert.match(await read(choice('content_filter', 'I cannot')), /^job: the model declined/)
  assert.match(await read(choice('tool_calls', '')), /^retry: the model stopped before finishing/)
  assert.match(await read(choice('stop', '   ')), /^retry: the model returned no text/)
  assert.match(await read(chat({ choices: [] })), /^retry: the model returned no text/)
  assert.match(await read('<html>gateway</html>'), /^retry: the model returned no text/)
  assert.match(await read(choice('stop', 'x'.repeat(MAX_DELIVERABLE_CHARS + 1))), /^job: the result was longer/)
  // Text given as parts is read too, and an answer that names no model keeps the one asked for.
  const parts = await run(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 'Gun' }, { type: 'text', text: 'aydin' }] } }] }))
  assert.deepEqual(parts, { ok: true, text: 'Gunaydin', model: 'm-1' })
})

test('house work, other provider: failures are sorted by who can fix them, and the key never reaches a log line', async () => {
  const answer = (status: number, text = '{"error":{"message":"nope"}}') => runHouseSkillOpenAI(openInput, async () => ({ status, text }))
  const sort = async (status: number, text?: string) => {
    const o = await answer(status, text)
    return o.ok ? 'ok' : `${o.kind}${o.noCall ? ' noCall' : ''}`
  }
  // Turned away before any model ran: ours to fix, and not billed.
  for (const status of [401, 402, 403, 404, 429]) assert.equal(await sort(status), 'operator noCall', String(status))
  assert.equal(await sort(500), 'operator')
  assert.equal(await sort(529), 'operator')
  assert.equal(await sort(408), 'retry')
  assert.equal(await sort(409), 'retry')
  assert.equal(await sort(400), 'job')
  assert.equal(await sort(400, 'Your credit balance is too low.'), 'operator noCall')
  // A refused option is tried once more as a plain request, and only then is it the job's.
  const bodies: Record<string, unknown>[] = []
  const picky: PostChat = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>
    bodies.push(body)
    return 'max_tokens' in body ? { status: 400, text: 'unknown parameter' } : { status: 200, text: chat() }
  }
  assert.equal((await runHouseSkillOpenAI(openInput, picky)).ok, true)
  assert.deepEqual(bodies.map((b) => 'max_tokens' in b), [true, false])
  // No answer at all: out of time is a try of this job, anything else is ours.
  const thrown = async (e: Error) => {
    const o = await runHouseSkillOpenAI(openInput, async () => {
      throw e
    })
    return o.ok ? 'ok' : o.kind
  }
  assert.equal(await thrown(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), 'retry')
  assert.equal(await thrown(new TypeError('fetch failed')), 'operator')
  // What goes to the server log never carries the key, even when the provider echoes it.
  const echoed = await answer(401, 'invalid key sk-test-not-real')
  assert.ok(!echoed.ok && echoed.detail?.includes('[key]') && !echoed.detail.includes('sk-test-not-real'))
  assert.ok(!echoed.ok && !echoed.reason.includes('sk-test'))
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

test('house worker start: with another provider named, a hire is delivered through it and the key stays out of the log', async () => {
  const { state, house } = seed()
  const lines: string[] = []
  const timers: { run: () => void; ms: number }[] = []
  const setTimer = (run: () => void, ms: number) => {
    timers.push({ run, ms })
    return {}
  }
  const asked: string[] = []
  const postChat: PostChat = async (url) => {
    asked.push(url)
    return { status: 200, text: chat() }
  }
  const started = startHouseWorker({ HOUSE_WORKER_AGENT_IDS: house.id, ...OPEN_ENV }, { log: (l) => lines.push(l), setTimer, postChat })
  assert.ok(started)
  assert.match(lines[0], /^on: delivering hires for 1 worker agent\(s\) with @cf\/meta\/llama-3\.3-70b-instruct through models\.example\.test/)
  assert.ok(!lines.join('\n').includes('sk-test-not-real'))
  const task = fund(state.tasks, house.id)
  timers[0].run()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(task.status, 'delivered')
  assert.equal(task.deliverable, 'Gunaydin')
  assert.equal(task.deliveryModel, 'served-model')
  assert.deepEqual(asked, ['https://models.example.test/v1/chat/completions'])
  started.stop()
})

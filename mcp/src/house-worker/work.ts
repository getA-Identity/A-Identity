/**
 * The work itself: one model call per hired task, and an honest account of how it ended.
 *
 * A result is returned only when the model finished normally and wrote text. A declined
 * request, an answer cut off at the token limit, an empty answer and every API failure come
 * back as a failure with a reason, never as text dressed up as a deliverable. The reasons are
 * written for the client who hired, so they name no key, no request id and no stack.
 *
 * The request text is whatever the client typed. It reaches the model as the user turn and
 * nothing else: no tool, no fetch and no file is reachable from here, so the worst a hostile
 * job description can do is get itself a strange answer.
 */
import Anthropic from '@anthropic-ai/sdk'

export type WorkOutcome =
  | { ok: true; text: string; model: string }
  /**
   * job: this job cannot be done, and trying again will not change that.
   * retry: this try produced nothing usable; another may.
   * operator: nothing is wrong with the job. The model, the network or our credential is, so
   * it does not count against the task.
   */
  | { ok: false; kind: 'job' | 'retry' | 'operator'; reason: string; /** For the server log only. */ detail?: string }

/** What a stored deliverable can hold (platform/tasks.ts slices at the same length). */
export const MAX_DELIVERABLE_CHARS = 5000
/**
 * Room for the model to think and write an answer that fits a delivery (5000 characters is
 * well under 2000 tokens). It is also the most one call can cost: the worker's daily ceiling
 * counts calls, so the bill is bounded by that count times this.
 */
export const MAX_TOKENS = 8_000
/** One job is one short request. Past this the call is abandoned and counted as a failed try. */
export const REQUEST_TIMEOUT_MS = 120_000

/** The services a house worker can do, keyed by the service name a hire names. */
export const HOUSE_SKILLS: Readonly<Record<string, { system: string }>> = {
  translation: {
    system:
      "You are a translation worker hired through a marketplace. The message is a client's job: text to translate and the language to translate it into. " +
      'Reply with the translation only, with no preamble and no notes. If no target language is stated, translate into English. ' +
      'If the message is not a translation job, reply with one sentence saying that this worker only translates. Keep the reply under 4500 characters.',
  },
  'data-analysis': {
    system:
      "You are a data analysis worker hired through a marketplace. The message is a client's job: data, or a question about data. " +
      'Reply with a short, structured analysis that uses the numbers given, and say plainly what the data does not show. ' +
      'If no data is given, say what you would need. Keep the reply under 4500 characters.',
  },
  'code-review': {
    system:
      "You are a code review worker hired through a marketplace. The message is a client's job: a diff or a snippet. " +
      'List concrete problems (bugs, edge cases, security) with a short fix for each, most serious first. ' +
      'If you find none, say so in one sentence. Keep the reply under 4500 characters.',
  },
}

export function houseSkill(service: string): { system: string } | null {
  return HOUSE_SKILLS[String(service ?? '').trim().toLowerCase()] ?? null
}

/**
 * Models that accept the server-side refusal fallback. On these a declined request is re-run on
 * the model the API picks for that refusal category, inside the same call. Any other model gets
 * a plain request, because it would reject the parameter.
 */
const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
])
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming
type Created = Anthropic.Beta.Messages.BetaMessage

/**
 * The one SDK call this module makes, as a function, so a test can stand in for it. The SDK's
 * own retries are off: a retried timeout would hold the worker's single queue for minutes, and
 * every retry is another billed call the ceilings would not see. The worker does the retrying,
 * one counted call at a time.
 */
export type CreateMessage = (body: CreateParams, options: { timeout: number; maxRetries: number }) => Promise<Created>
const CALL_OPTIONS = { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 } as const

let shared: Anthropic | null = null
const sdkCreate: CreateMessage = (body, options) => {
  // Built on first use, so importing this module never needs a credential.
  shared ??= new Anthropic()
  return shared.beta.messages.create(body, options)
}

export async function runHouseSkill(
  input: { service: string; request: string; model: string },
  create: CreateMessage = sdkCreate,
): Promise<WorkOutcome> {
  const skill = houseSkill(input.service)
  if (!skill) return { ok: false, kind: 'job', reason: `this worker has no skill for the service "${String(input.service).slice(0, 60)}"` }
  const request = String(input.request ?? '').trim()
  if (!request) return { ok: false, kind: 'job', reason: 'the job has no description to work from' }

  // The plain request every model accepts, and the options added on top where they apply.
  const plain: CreateParams = {
    model: input.model,
    max_tokens: MAX_TOKENS,
    system: skill.system,
    messages: [{ role: 'user', content: request }],
  }
  const body: CreateParams = {
    ...plain,
    // A short, well-defined job: the lowest effort is the right depth, and it is set here
    // because the default differs from model to model.
    output_config: { effort: 'low' },
    ...(FALLBACK_MODELS.has(input.model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  }

  let message: Created
  try {
    message = await create(body, CALL_OPTIONS)
  } catch (e) {
    // A 400 says the request shape was refused, which is about an option and not about the
    // job: a model or an account that does not take the effort or fallback settings. The
    // plain request is tried once before the job is told it cannot be done.
    if (!(e instanceof Anthropic.BadRequestError)) return failure(e)
    try {
      message = await create(plain, CALL_OPTIONS)
    } catch (again) {
      return failure(again)
    }
  }

  // Read why it stopped before reading what it wrote: a declined or cut-off answer can still
  // carry text, and that text is not a result.
  if (message.stop_reason === 'refusal') return { ok: false, kind: 'job', reason: 'the model declined this request' }
  if (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded') {
    return { ok: false, kind: 'job', reason: 'the answer did not fit in one reply' }
  }
  if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') {
    return { ok: false, kind: 'retry', reason: 'the model stopped before finishing' }
  }
  const text = message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()
  if (!text) return { ok: false, kind: 'retry', reason: 'the model returned no text' }
  if (text.length > MAX_DELIVERABLE_CHARS) {
    return { ok: false, kind: 'job', reason: `the result was longer than a delivery can hold (${MAX_DELIVERABLE_CHARS} characters)` }
  }
  return { ok: true, text, model: message.model }
}

/**
 * A failure, sorted by who can do something about it. Most specific class first. The reason is
 * for the client; the detail is the error's own name and message, for the server log, where
 * an operator needs it and no client reads it.
 */
function failure(e: unknown): WorkOutcome {
  const detail = e instanceof Error ? `${e.constructor.name}: ${e.message}`.slice(0, 300) : 'a non-error was thrown'
  const out = (kind: 'job' | 'retry' | 'operator', reason: string): WorkOutcome => ({ ok: false, kind, reason, detail })
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return out('operator', 'the model credential was rejected')
  }
  // The account cannot be charged: ours to fix, and no task should be given up over it.
  if (e instanceof Anthropic.PaymentRequiredError) return out('operator', 'the model account cannot be charged')
  if (e instanceof Anthropic.RateLimitError) return out('operator', 'the model is rate limited')
  if (e instanceof Anthropic.NotFoundError) return out('operator', 'the configured model was not found')
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError || e instanceof Anthropic.ContentTooLargeError) {
    return out('job', 'the model rejected the request')
  }
  // A call that ran out of time is about this job: counted as a try, so one slow job cannot
  // sit at the head of the queue forever. Checked before the connection error it extends.
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.RequestTimeoutError) {
    return out('retry', 'the model took too long to answer')
  }
  if (e instanceof Anthropic.APIConnectionError) return out('operator', 'the model could not be reached')
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : 0
    return status >= 500 || status === 0
      ? out('operator', `the model service failed (${status || 'no status'})`)
      : out('retry', `the model answered with an error (${status})`)
  }
  // Any other SDK error is about our side before a request was sent: no credential could be
  // resolved, or a stored one has expired. Nothing is wrong with the job.
  if (e instanceof Anthropic.AnthropicError) return out('operator', 'the model credential could not be used')
  return out('retry', 'the work failed unexpectedly')
}

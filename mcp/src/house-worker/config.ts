/**
 * The house worker's switch: which worker agents this server delivers for, with which model,
 * and how much it may do in a day. Pure: it reads an env object and decides. Nothing here
 * touches a task or the network.
 *
 * Both halves are required. HOUSE_WORKER_AGENT_IDS names the worker agents the operator runs
 * (platform agent ids, which are public), and a model credential pays for the work. With either
 * one missing the worker is off and says why in one line: no hired task is touched, and nothing
 * that looks like a result is ever written in its place.
 *
 * The model credential is one of two kinds. An Anthropic credential is the default. An operator
 * with no Anthropic account can instead name any service that speaks the OpenAI chat
 * completions shape (HOUSE_WORKER_OPENAI_BASE_URL, HOUSE_WORKER_OPENAI_API_KEY and
 * HOUSE_WORKER_MODEL): when that base URL is set it is the one used. Either way a hired job's
 * text is sent to that provider, and to nobody else.
 */

/** The model a house worker uses when HOUSE_WORKER_MODEL is not set. */
export const DEFAULT_MODEL = 'claude-opus-5-5'
/**
 * Model calls in any 24 hours, unless HOUSE_WORKER_DAILY_LIMIT says otherwise. It counts calls,
 * not deliveries: a call is billed whether or not it ends in a result, and a hire costs the
 * client nothing in this build, so the bill is bounded by this number times the most one call
 * can cost (work.ts caps the answer length).
 */
export const DEFAULT_DAILY_LIMIT = 50
export const MAX_DAILY_LIMIT = 1000
/** Model calls in any 24 hours for one client, unless HOUSE_WORKER_CLIENT_DAILY_LIMIT says
 *  otherwise, so one account cannot use up the day for everyone. */
export const DEFAULT_CLIENT_DAILY_LIMIT = 6

const AGENT_ID = /^[A-Za-z0-9_-]{4,64}$/
const MODEL_ID = /^[A-Za-z0-9._-]{3,80}$/
/** Other providers name models with a namespace, for example `@cf/meta/llama-3.3-70b-instruct`. */
const OPEN_MODEL_ID = /^[A-Za-z0-9@._:/-]{3,120}$/

/** Who does the work. The key of the second kind stays in this object and is never logged. */
export type HouseWorkerProvider =
  | { kind: 'anthropic' }
  | { kind: 'openai-compatible'; baseUrl: string; apiKey: string; host: string }

export type HouseWorkerConfig =
  | { on: false; reason: string }
  | {
      on: true
      agentIds: ReadonlySet<string>
      provider: HouseWorkerProvider
      model: string
      dailyLimit: number
      clientDailyLimit: number
      /** Entries of HOUSE_WORKER_AGENT_IDS that were not agent ids and were left out. */
      ignored: number
    }

const off = (reason: string): HouseWorkerConfig => ({ on: false, reason })

export function houseWorkerConfig(env: NodeJS.ProcessEnv = process.env): HouseWorkerConfig {
  const listed = (env.HOUSE_WORKER_AGENT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (listed.length === 0) return off('HOUSE_WORKER_AGENT_IDS is not set, so this server delivers no hired task')
  const agentIds = new Set(listed.filter((s) => AGENT_ID.test(s)))
  if (agentIds.size === 0) return off('HOUSE_WORKER_AGENT_IDS holds no well-formed agent id, so this server delivers no hired task')

  const model = (env.HOUSE_WORKER_MODEL ?? '').trim()
  let provider: HouseWorkerProvider
  const openBase = (env.HOUSE_WORKER_OPENAI_BASE_URL ?? '').trim()
  if (openBase) {
    // Named on purpose, so it wins over an Anthropic credential that happens to be set too.
    const base = openAiBase(openBase)
    if (!base) return off('HOUSE_WORKER_OPENAI_BASE_URL is set but is not a plain https URL')
    const apiKey = (env.HOUSE_WORKER_OPENAI_API_KEY ?? '').trim()
    if (!apiKey) return off('HOUSE_WORKER_OPENAI_BASE_URL is set but HOUSE_WORKER_OPENAI_API_KEY is not, so hired tasks wait instead of receiving a made-up result')
    // No default here: a model id only means something to the provider it belongs to.
    if (!model) return off('HOUSE_WORKER_OPENAI_BASE_URL is set but HOUSE_WORKER_MODEL is not')
    if (!OPEN_MODEL_ID.test(model)) return off('HOUSE_WORKER_MODEL is set but is not a model id')
    provider = { kind: 'openai-compatible', baseUrl: base.url, apiKey, host: base.host }
  } else {
    // An API key, a bearer token, or a stored profile the operator names on purpose. A profile
    // that merely exists on the machine does not count: the switch is what the env says.
    const hasCredential = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE'].some((k) => (env[k] ?? '').trim())
    if (!hasCredential) {
      return off('no model credential is set (ANTHROPIC_API_KEY, or HOUSE_WORKER_OPENAI_BASE_URL with its key and model), so hired tasks wait for a real worker instead of receiving a made-up result')
    }
    if (model && !MODEL_ID.test(model)) return off('HOUSE_WORKER_MODEL is set but is not a model id')
    provider = { kind: 'anthropic' }
  }

  const whole = (name: string, fallback: number): number | null => {
    const raw = (env[name] ?? '').trim()
    if (!raw) return fallback
    const n = Number(raw)
    return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_DAILY_LIMIT) : null
  }
  const dailyLimit = whole('HOUSE_WORKER_DAILY_LIMIT', DEFAULT_DAILY_LIMIT)
  if (dailyLimit === null) return off('HOUSE_WORKER_DAILY_LIMIT is set but is not a whole number of 1 or more')
  const clientLimit = whole('HOUSE_WORKER_CLIENT_DAILY_LIMIT', DEFAULT_CLIENT_DAILY_LIMIT)
  if (clientLimit === null) return off('HOUSE_WORKER_CLIENT_DAILY_LIMIT is set but is not a whole number of 1 or more')

  return {
    on: true,
    agentIds,
    provider,
    model: model || DEFAULT_MODEL,
    dailyLimit,
    // One client never gets more than the whole day's allowance.
    clientDailyLimit: Math.min(clientLimit, dailyLimit),
    ignored: listed.length - agentIds.size,
  }
}

/**
 * A base URL the worker may send job text to: https, no credentials in it, no query and no
 * fragment. Plain http is accepted for this machine only, so a local model server can be tried.
 * Returned without a trailing slash, with the host for the log line.
 */
function openAiBase(raw: string): { url: string; host: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  if (u.username || u.password || u.search || u.hash) return null
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, host: u.host }
}

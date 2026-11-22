/**
 * The house worker's switch: which worker agents this server delivers for, with which model,
 * and how much it may do in a day. Pure: it reads an env object and decides. Nothing here
 * touches a task or the network.
 *
 * Both halves are required. HOUSE_WORKER_AGENT_IDS names the worker agents the operator runs
 * (platform agent ids, which are public), and a model credential pays for the work. With either
 * one missing the worker is off and says why in one line: no hired task is touched, and nothing
 * that looks like a result is ever written in its place.
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

export type HouseWorkerConfig =
  | { on: false; reason: string }
  | {
      on: true
      agentIds: ReadonlySet<string>
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

  // An API key, a bearer token, or a stored profile the operator names on purpose. A profile
  // that merely exists on the machine does not count: the switch is what the env says.
  const hasCredential = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE'].some((k) => (env[k] ?? '').trim())
  if (!hasCredential) {
    return off('no model credential is set (ANTHROPIC_API_KEY), so hired tasks wait for a real worker instead of receiving a made-up result')
  }

  const model = (env.HOUSE_WORKER_MODEL ?? '').trim()
  if (model && !MODEL_ID.test(model)) return off('HOUSE_WORKER_MODEL is set but is not a model id')

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
    model: model || DEFAULT_MODEL,
    dailyLimit,
    // One client never gets more than the whole day's allowance.
    clientDailyLimit: Math.min(clientLimit, dailyLimit),
    ignored: listed.length - agentIds.size,
  }
}

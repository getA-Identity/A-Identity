/**
 * The house worker: delivers the hires of the worker agents this server operates.
 *
 * A marketplace hire locks an escrow and waits for the hired agent's owner to deliver. For the
 * agents the operator names in HOUSE_WORKER_AGENT_IDS that owner is us, so this loop is the
 * worker: it reads their funded tasks from the platform state, does the work with one model
 * call (./work.ts), and stores the result as a delivery the row marks as ours. It runs inside
 * the HTTP process on purpose. The platform state is one document this process owns, and a
 * second process writing it would overwrite the first.
 *
 * What it never does: deliver for an agent that is not on the list, write a result the model
 * did not produce, touch a task whose escrow is still locking, or decide anything about money.
 * Release and refund stay with the client. A task it cannot do keeps its escrow and gains a
 * note that says why, so the client can cancel for a refund instead of waiting on a silent row.
 *
 * What bounds the bill: every model call is recorded on its task before it is made, and the
 * ceilings count those records, not deliveries. A call that fails, is cut off or is thrown
 * away is billed like any other, so it counts like any other: at most `dailyLimit` calls in
 * any 24 hours, at most `clientDailyLimit` of them for one client, and a fixed few per task.
 *
 * Off, with one log line, unless both the list and a model credential are set (./config.ts).
 */
import { listFundedTasksForAgents, deliverHouseTask, noteHouseTask, claimHouseCall, countHouseCallsSince, HOUSE_CALLS_PER_TASK } from '../platform.js'
import { houseWorkerConfig } from './config.js'
import { runHouseSkill, type WorkOutcome } from './work.js'

/** A hire shows up in the queue within one poll. */
export const POLL_MS = 4_000
export const FIRST_POLL_MS = 3_000
/** On Render a deploy runs the new instance beside the old one until the old one gets SIGTERM.
 *  The first poll waits past that, so two instances never work the same task. */
export const RENDER_FIRST_POLL_MS = 120_000
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 15 * 60_000
/** Tries per task before the worker gives up and says so. */
export const MAX_ATTEMPTS = 3
/** Between two tries of the same task, times the number of tries so far. */
export const RETRY_GAP_MS = 20_000
/** Tasks worked in one poll, so one busy poll cannot hold the loop for minutes. */
export const MAX_PER_TICK = 3
/**
 * An escrow locked at hire expires on chain a day later, so a task older than that is left to
 * its client. It also keeps the worker from answering hires that waited weeks for nobody.
 */
export const MAX_TASK_AGE_MS = 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

// Written for the client who hired. None of them promises what the loop does not do: a task
// that waits past a day is left alone, so nothing here says it will be picked up later.
export const WAIT_NOTE = 'The worker cannot start right now. Nothing has been paid out, and you can cancel for a refund.'
export const LIMIT_NOTE = 'The worker has reached its limit for today, so this job is waiting. You can cancel for a refund and hire again later.'
export const CLIENT_LIMIT_NOTE = 'You have reached the limit of jobs this worker takes from one account in a day, so this one is waiting. You can cancel for a refund and hire again later.'
export const RETRY_NOTE = 'A try did not produce a result. The worker is trying again.'
export const gaveUpNote = (reason: string) => `The worker could not do this job: ${reason}. You can cancel for a refund.`

export type TickResult = { delivered: number; backoff: boolean }

export type WorkerDeps = {
  agentIds: ReadonlySet<string>
  model: string
  /** Model calls in any 24 hours, for everyone. */
  dailyLimit: number
  /** Model calls in any 24 hours, for one client. */
  clientDailyLimit: number
  log: (line: string) => void
  now?: () => number
  work?: (input: { service: string; request: string; model: string }) => Promise<WorkOutcome>
  listFunded?: typeof listFundedTasksForAgents
  deliver?: typeof deliverHouseTask
  note?: typeof noteHouseTask
  claimCall?: typeof claimHouseCall
  callsSince?: typeof countHouseCallsSince
}

export type HouseWorker = {
  tick(): Promise<TickResult>
  nextDelayMs(result: TickResult): number
  stop(): void
  readonly stopped: boolean
}

export function createHouseWorker(deps: WorkerDeps): HouseWorker {
  const { agentIds, model, dailyLimit, clientDailyLimit, log } = deps
  const now = deps.now ?? (() => Date.now())
  const work = deps.work ?? ((input) => runHouseSkill(input))
  const listFunded = deps.listFunded ?? listFundedTasksForAgents
  const deliver = deps.deliver ?? deliverHouseTask
  const note = deps.note ?? noteHouseTask
  const claimCall = deps.claimCall ?? claimHouseCall
  const callsSince = deps.callsSince ?? countHouseCallsSince

  let stopped = false
  let busy = false
  /** Operator failures in a row. Each one doubles the wait before the next poll. */
  let failures = 0
  /** The earliest next try per task. In memory: after a restart a task is simply tried again,
   *  and its stored counts still stop it at the limits. */
  const retryAt = new Map<string, number>()
  const say = (taskId: string, text: string, attempts?: number) =>
    note({ taskId, note: text, ...(attempts === undefined ? {} : { attempts }), allowedAgentIds: agentIds })

  async function tick(): Promise<TickResult> {
    // One poll at a time. A slow model call must not let the next timer start a second pass
    // over the same queue.
    if (stopped || busy) return { delivered: 0, backoff: false }
    busy = true
    let delivered = 0
    let backoff = false
    try {
      let worked = 0
      for (const task of listFunded(agentIds)) {
        if (stopped || worked >= MAX_PER_TICK) break
        // The list was read before the first call of this poll. A task the client cancelled
        // while an earlier one was being worked is no longer waiting, and costs nothing.
        if (task.status !== 'funded') continue
        const created = Date.parse(task.createdAt)
        if (!Number.isFinite(created) || now() - created > MAX_TASK_AGE_MS) continue
        if ((task.workerAttempts ?? 0) >= MAX_ATTEMPTS) continue
        if ((retryAt.get(task.id) ?? 0) > now()) continue
        if ((task.workerCalls?.length ?? 0) >= HOUSE_CALLS_PER_TASK) {
          // Every call it may take is spent without a result, most likely on a service that
          // was down each time. Said once, and the task is left to its client.
          say(task.id, gaveUpNote('it could not be completed'), MAX_ATTEMPTS)
          continue
        }
        const since = new Date(now() - DAY_MS).toISOString()
        if (callsSince(since) >= dailyLimit) {
          say(task.id, LIMIT_NOTE)
          continue
        }
        if (callsSince(since, task.client) >= clientDailyLimit) {
          say(task.id, CLIENT_LIMIT_NOTE)
          continue
        }
        // Recorded before the call, so a call that comes to nothing is still counted.
        if ('error' in claimCall({ taskId: task.id, allowedAgentIds: agentIds })) continue

        worked++
        let outcome: WorkOutcome
        try {
          outcome = await work({ service: task.service, request: task.description, model })
        } catch {
          outcome = { ok: false, kind: 'retry', reason: 'the work failed unexpectedly' }
        }
        // Asked to stop while the model was answering: the instance replacing this one will do
        // the task, and a write from here could land on top of its state.
        if (stopped) break

        const detail = !outcome.ok && outcome.detail ? ` [${outcome.detail}]` : ''
        if (outcome.ok) {
          const stored = deliver({ taskId: task.id, deliverable: outcome.text, model: outcome.model, allowedAgentIds: agentIds })
          retryAt.delete(task.id)
          if ('error' in stored) {
            // The client refunded it, or it was delivered another way, while the model worked.
            log(`${task.id}: the result was not stored (${stored.error})`)
          } else {
            delivered++
            failures = 0
            log(`delivered ${task.id} (${task.service}, ${outcome.text.length} characters, ${outcome.model})`)
          }
        } else if (outcome.kind === 'operator') {
          failures++
          backoff = true
          say(task.id, WAIT_NOTE)
          log(`cannot work right now: ${outcome.reason}${detail}`)
          break
        } else {
          const attempts = outcome.kind === 'job' ? MAX_ATTEMPTS : (task.workerAttempts ?? 0) + 1
          const final = attempts >= MAX_ATTEMPTS
          say(task.id, final ? gaveUpNote(outcome.reason) : RETRY_NOTE, attempts)
          if (final) {
            retryAt.delete(task.id)
            log(`gave up on ${task.id}: ${outcome.reason}${detail}`)
          } else {
            retryAt.set(task.id, now() + RETRY_GAP_MS * attempts)
            log(`${task.id}: try ${attempts} of ${MAX_ATTEMPTS} failed (${outcome.reason})${detail}`)
          }
        }
      }
    } finally {
      busy = false
    }
    return { delivered, backoff }
  }

  return {
    tick,
    nextDelayMs(result) {
      if (!result.backoff) return POLL_MS
      return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
    },
    stop() {
      stopped = true
    },
    get stopped() {
      return stopped
    },
  }
}

// -- the env-gated start -----------------------------------------------------------------------

export type StartSeams = {
  log?: (line: string) => void
  now?: () => number
  work?: WorkerDeps['work']
  setTimer?: (run: () => void, ms: number) => { unref?: () => void }
}

export type HouseWorkerHandle = { stop(): void; worker: HouseWorker }

/**
 * Start the worker if it is configured; otherwise write one line and do nothing. Never throws.
 * Returns how to stop it, or null when it is off.
 */
export function startHouseWorker(env: NodeJS.ProcessEnv = process.env, seams: StartSeams = {}): HouseWorkerHandle | null {
  const log = seams.log ?? ((line: string) => console.error(`[house-worker] ${line}`))
  try {
    const config = houseWorkerConfig(env)
    if (!config.on) {
      log(`off: ${config.reason}`)
      return null
    }
    const worker = createHouseWorker({
      agentIds: config.agentIds,
      model: config.model,
      dailyLimit: config.dailyLimit,
      clientDailyLimit: config.clientDailyLimit,
      log,
      ...(seams.now ? { now: seams.now } : {}),
      ...(seams.work ? { work: seams.work } : {}),
    })
    const setTimer = seams.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
    let halted = false
    const schedule = (ms: number) => {
      if (halted) return
      setTimer(() => {
        if (halted) return
        worker.tick().then(
          (result) => schedule(worker.nextDelayMs(result)),
          () => {
            log('a poll threw; trying again after a pause')
            schedule(BACKOFF_BASE_MS)
          },
        )
      }, ms).unref?.()
    }
    const first = env.RENDER ? RENDER_FIRST_POLL_MS : FIRST_POLL_MS
    schedule(first)
    log(
      `on: delivering hires for ${config.agentIds.size} worker agent(s) with ${config.model}, at most ${config.dailyLimit} model calls a day ` +
        `and ${config.clientDailyLimit} for one client, the first poll in ${Math.round(first / 1000)} s` +
        (config.ignored ? `; ${config.ignored} entry(ies) of HOUSE_WORKER_AGENT_IDS were not agent ids and are ignored` : ''),
    )
    return {
      worker,
      stop() {
        halted = true
        worker.stop()
      },
    }
  } catch {
    log('off: the worker could not start')
    return null
  }
}

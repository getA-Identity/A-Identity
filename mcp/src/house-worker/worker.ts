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
 * did not produce, or decide anything about money. Release and refund stay with the client.
 * A task it cannot do keeps its escrow and gains a note that says why, so the client can
 * cancel for a refund instead of waiting on a silent row.
 *
 * Off, with one log line, unless both the list and a model credential are set (./config.ts).
 */
import { listFundedTasksForAgents, deliverHouseTask, noteHouseTask, countHouseDeliveriesSince } from '../platform.js'
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

export const WAIT_NOTE = 'The worker cannot start right now. The USDC stays locked in escrow, and you can cancel for a refund.'
export const LIMIT_NOTE = 'The worker has reached its limit for today. It picks this job up when the limit resets, or you can cancel for a refund.'
export const RETRY_NOTE = 'The first try did not produce a result. The worker is trying again.'
export const gaveUpNote = (reason: string) => `The worker could not do this job: ${reason}. You can cancel for a refund.`

export type TickResult = { delivered: number; backoff: boolean }

export type WorkerDeps = {
  agentIds: ReadonlySet<string>
  model: string
  dailyLimit: number
  log: (line: string) => void
  now?: () => number
  work?: (input: { service: string; request: string; model: string }) => Promise<WorkOutcome>
  listFunded?: typeof listFundedTasksForAgents
  deliver?: typeof deliverHouseTask
  note?: typeof noteHouseTask
  deliveredSince?: typeof countHouseDeliveriesSince
}

export type HouseWorker = {
  tick(): Promise<TickResult>
  nextDelayMs(result: TickResult): number
  stop(): void
  readonly stopped: boolean
}

export function createHouseWorker(deps: WorkerDeps): HouseWorker {
  const { agentIds, model, dailyLimit, log } = deps
  const now = deps.now ?? (() => Date.now())
  const work = deps.work ?? ((input) => runHouseSkill(input))
  const listFunded = deps.listFunded ?? listFundedTasksForAgents
  const deliver = deps.deliver ?? deliverHouseTask
  const note = deps.note ?? noteHouseTask
  const deliveredSince = deps.deliveredSince ?? countHouseDeliveriesSince

  let stopped = false
  let busy = false
  /** Operator failures in a row. Each one doubles the wait before the next poll. */
  let failures = 0
  /** The earliest next try per task. In memory: after a restart a task is simply tried again,
   *  and its stored attempt count still stops it at the limit. */
  const retryAt = new Map<string, number>()

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
        const created = Date.parse(task.createdAt)
        if (!Number.isFinite(created) || now() - created > MAX_TASK_AGE_MS) continue
        if ((task.workerAttempts ?? 0) >= MAX_ATTEMPTS) continue
        if ((retryAt.get(task.id) ?? 0) > now()) continue
        if (deliveredSince(new Date(now() - DAY_MS).toISOString()) >= dailyLimit) {
          note({ taskId: task.id, note: LIMIT_NOTE, allowedAgentIds: agentIds })
          continue
        }

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
          note({ taskId: task.id, note: WAIT_NOTE, allowedAgentIds: agentIds })
          log(`cannot work right now: ${outcome.reason}${outcome.detail ? ` [${outcome.detail}]` : ''}`)
          break
        } else {
          const attempts = outcome.kind === 'job' ? MAX_ATTEMPTS : (task.workerAttempts ?? 0) + 1
          const final = attempts >= MAX_ATTEMPTS
          note({ taskId: task.id, note: final ? gaveUpNote(outcome.reason) : RETRY_NOTE, attempts, allowedAgentIds: agentIds })
          if (final) {
            retryAt.delete(task.id)
            log(`gave up on ${task.id}: ${outcome.reason}${outcome.detail ? ` [${outcome.detail}]` : ''}`)
          } else {
            retryAt.set(task.id, now() + RETRY_GAP_MS * attempts)
            log(`${task.id}: try ${attempts} of ${MAX_ATTEMPTS} failed (${outcome.reason})${outcome.detail ? ` [${outcome.detail}]` : ''}`)
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
      `on: delivering hires for ${config.agentIds.size} worker agent(s) with ${config.model}, at most ${config.dailyLimit} a day, ` +
        `the first poll in ${Math.round(first / 1000)} s` +
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

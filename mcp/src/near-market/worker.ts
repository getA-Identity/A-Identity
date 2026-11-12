/**
 * The NEAR AI Agent Market worker: A-Identity Guard for NEAR (handle a-identity-guard), listed
 * on https://market.near.ai as a self-hosted agent at 0.50 USD per hire with a 1 hour SLA and
 * no webhook, so it learns of work by polling.
 *
 * The listing's promise: brief it with a NEAR account id (and optionally an amount) and get
 * ALLOW/WARN/DENY with a 0-1000 score, every reason code, the block read, the snapshot sha256 and
 * the exact command that recomputes the verdict. The buyer's money sits in escrow and comes back
 * if nothing is delivered in time, so this worker delivers a real verdict or clearly declines.
 * It never delivers a guess: no account, no verdict; no chain read, no verdict.
 *
 * The lifecycle, as the marketplace documents it (read 2026-11-12:
 * https://market.near.ai/skill/flows/worker-lifecycle.md, https://market.near.ai/skill/flows/messaging.md
 * and https://market.near.ai/skill/reference/agent-api.md), and what this worker does at each step:
 *
 *  1. Poll `GET /v1/agents/me/assignments` ("Poll every 30-60 seconds"): every 30 to 60 s, at a
 *     random point in that window, and on a transport error, a 5xx or a 429 with a growing
 *     backoff (at least any Retry-After), up to 15 minutes. "Each assignment row embeds the job
 *     brief ... and the latest thread message", so one poll holds what is needed to act.
 *  2. Classify each in_progress row statelessly, as the docs do: `deliverableUrl: null` is
 *     first-time work, `deliverableUrl` set with `submittedAt` set is a request-changes rework,
 *     `deliverableUrl` set with `submittedAt: null` is a dispute redo. A competition entry is not a
 *     hire and is left alone.
 *  3. Find the one account to check: the buyer's latest message first (a reply, rework feedback,
 *     or an A2A opening message, whose JSON parts are read), then the brief (title and
 *     description, plus the bid's own thread on a fresh hire: "read your bid's thread ... for
 *     anything agreed before the award"). See brief.ts for the forms. A message that names one
 *     account and a brief that names another is a question, never a pick.
 *  4. No single account: ONE clarifying message (`POST /v1/assignments/{id}/messages`, with a
 *     fixed clientRequestId, so "a retry with the same id answers with the message already
 *     stored instead of storing another"). The question is counted as asked only once the
 *     marketplace stored it; a restarted worker finds it in the thread before it asks. After it,
 *     only what the buyer writes since names the account: every reply since the question is read
 *     together, so "one sec" then the id, or the id then "thanks", is checked. A reply with nothing
 *     account-shaped in it is waited on; one that names more than one account, or one that cannot
 *     be checked, is declined at once (`POST /v1/assignments/{id}/decline`, reason `rejected`:
 *     "the neutral decline before you take on the work"; `failed` once a version was delivered),
 *     and so is the job when no usable reply arrives by 5 minutes before the deadline. The buyer is
 *     refunded in full either way, and the question says so.
 *  5. One account: `POST /v1/assignments/{id}/start` ("as soon as you take an assignment. Until
 *     you do, the buyer may cancel it at any moment"), then the verdict (verdict.ts), then
 *     `POST /v1/assignments/{id}/submit` with `deliverableMarkdown` (deliverable.ts).
 *  6. A chain that cannot be read is retried with a growing wait while the deadline allows,
 *     then the buyer is told why in the thread and the job is declined with reason `failed`.
 *  7. Rework: the same steps for the new round; the new version says what it answers.
 *
 * Never twice. Before every submit the worker reads the assignment's state from the API again
 * and submits only if the row is still in_progress in the same round (same slaDeadlineAt, which
 * the marketplace re-arms on every re-entry, same submittedAt and deliverableUrl). An in-memory
 * set of rounds already answered is the second guard. A submit whose answer was lost is retried
 * with the very same Markdown, which the marketplace treats as a no-op if the first one landed
 * ("Resending the same Markdown with the same file set ... is a no-op"). After a restart the
 * memory is empty, and the API state alone decides: a delivered row is no longer in_progress.
 *
 * One process per token. Two processes polling with the same token could both pass the state
 * check and each submit a version. On Render the instance a deploy replaces is stopped on SIGTERM
 * (http.ts) and a new instance's first poll waits RENDER_FIRST_POLL_MS, past the overlap; anywhere
 * else, run one process with MARKET_NEAR_AI_TOKEN set.
 *
 * The token. Read from MARKET_NEAR_AI_TOKEN, sent only to market.near.ai (client.ts), never
 * logged: every line this worker writes goes through redactToken. A 401 on any route, or a 403 on
 * the agent's own assignment list, means the token was revoked or does not act as this agent: the
 * worker stops, says so in one line, and polls no more. A 403 on one assignment or bid ("the
 * resource is not yours") leaves only that one alone.
 *
 * Env-gated: without MARKET_NEAR_AI_TOKEN it writes one line saying it is off and does nothing
 * else. It never throws into the server: every failure ends the tick it happened in.
 */
import {
  createMarketClient,
  isMarketId,
  isMarketToken,
  isTransient,
  MARKET_ORIGIN,
  MarketAuthError,
  MarketHttpError,
  redactToken,
  type FetchFn,
  type MarketAssignment,
  type MarketAssignmentRow,
  type MarketClient,
  type MarketLatestMessage,
  type MarketThreadMessage,
} from './client.js'
import { a2aText, CLARIFY_PREFIX, clarifyingMessage, disagreement, parseBrief, unclearDeclineDetail, type BriefTarget, type UnclearBrief } from './brief.js'
import { failureDeclineDetail, internalDeclineDetail, renderDeliverable, type DeliverableContext } from './deliverable.js'
import { isVerdict, runMarketVerdict, type VerdictFailure, type VerdictResult } from './verdict.js'

export const POLL_MIN_MS = 30_000
export const POLL_MAX_MS = 60_000
export const FIRST_POLL_MS = 5_000
/** The first poll on Render (RENDER set): past a deploy's overlap, by when the replaced instance got SIGTERM. */
export const RENDER_FIRST_POLL_MS = 120_000
export const BACKOFF_BASE_MS = 60_000
export const BACKOFF_MAX_MS = 15 * 60_000
/** A clarifying question is asked only with at least this much time left. */
export const CLARIFY_MIN_WINDOW_MS = 10 * 60_000
/** Waiting for a reply ends this long before the deadline, with a decline. */
export const CLARIFY_GRACE_MS = 5 * 60_000
/** A failed collection is retried only while this much time would still be left after the wait. */
export const FAIL_MARGIN_MS = 5 * 60_000
export const RETRY_BASE_MS = 60_000
export const RETRY_MAX_MS = 10 * 60_000
/** The deadline assumed for a row whose slaDeadlineAt does not parse: the listing's SLA. */
const DEFAULT_SLA_MS = 60 * 60_000
const PAGE = 100
const MAX_PAGES = 10
/** How far back a thread is searched for our question when the marketplace refused to store it again. */
const THREAD_PAGES = 5
const MEMO_CAP = 5_000

type Round = 'first' | 'rework' | 'redo'

export type TickResult = { kind: 'ok' } | { kind: 'transient'; retryAfterMs: number | null } | { kind: 'stopped' }

export type WorkerDeps = {
  client: MarketClient
  runVerdict: (target: BriefTarget) => Promise<VerdictResult>
  log: (line: string) => void
  now?: () => number
  random?: () => number
}

export type NearMarketWorker = {
  tick(): Promise<TickResult>
  /** When to poll next after a tick, or null once stopped. */
  nextDelayMs(result: TickResult): number | null
  stop(): void
  readonly stopped: boolean
}

/** A Map that forgets its oldest entry past a cap, so a long-lived process stays small. */
class Memo<K, V> extends Map<K, V> {
  override set(key: K, value: V): this {
    super.delete(key)
    super.set(key, value)
    if (this.size > MEMO_CAP) this.delete(this.keys().next().value as K)
    return this
  }
}

const roundOf = (a: MarketAssignment): Round => (!a.deliverableUrl ? 'first' : a.submittedAt ? 'rework' : 'redo')

/** One round of one assignment: the marketplace re-arms slaDeadlineAt on every re-entry to in_progress. */
const roundKey = (a: MarketAssignment): string => `${a.assignmentId}@${a.slaDeadlineAt}`

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function isRow(r: unknown): r is MarketAssignmentRow {
  const row = r as MarketAssignmentRow | null
  return (
    !!row &&
    typeof row === 'object' &&
    !!row.assignment &&
    isMarketId(row.assignment.assignmentId) &&
    typeof row.assignment.status === 'string' &&
    typeof row.assignment.slaDeadlineAt === 'string' &&
    !!row.job &&
    typeof row.job === 'object'
  )
}

const buyerMessage = (lm: MarketLatestMessage | null): MarketLatestMessage | null =>
  lm && lm.senderSide === 'buyer' && lm.origin !== 'platform' && typeof lm.body === 'string' ? lm : null

/** Written by this agent with its own token: the docs' senderAgentId is "Some when the worker-side message was authored by the agent itself". */
const ours = (m: MarketThreadMessage): boolean => typeof m.senderAgentId === 'string' && m.senderAgentId !== ''

const isQuestion = (m: MarketThreadMessage): boolean => ours(m) && m.body.startsWith(CLARIFY_PREFIX)

/** What identifies the thread's newest message, so a thread is read again only when it moved. */
const latestKey = (lm: MarketLatestMessage | null): string => (lm ? JSON.stringify([lm.createdAt, lm.senderSide, lm.origin ?? '', typeof lm.body === 'string' ? lm.body.length : -1]) : '')

/** The CAIP-10 line every deliverable of ours carries, read back after a restart. */
const CAIP10_LINE = /^- CAIP-10: `near:(testnet|mainnet):([a-z0-9._-]{2,64})`$/m

type Plan =
  | { kind: 'ok'; target: BriefTarget; amount: string | null; feedback: DeliverableContext['feedback'] }
  /** No question asked yet: ask it, or decline when too little time is left to. */
  | { kind: 'ask'; parse: UnclearBrief }
  /** Asked; nothing account-shaped in the replies since: wait, and decline at the grace before the deadline. */
  | { kind: 'wait'; replied: boolean }
  /** Asked; the replies since name more than one account, or one that cannot be checked: decline now. */
  | { kind: 'refuse'; parse: UnclearBrief }

/** Has our question been asked on this assignment, and what has the buyer's side written since (oldest first)? */
type ThreadView = { asked: boolean; replies: string[] }

export function createNearMarketWorker(deps: WorkerDeps): NearMarketWorker {
  const { client, runVerdict } = deps
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const log = deps.log

  let stopped = false
  let pollFailures = 0

  // Per round (roundKey): answered, waiting to retry, failed attempts, a deliverable not yet
  // confirmed submitted, a decline not yet confirmed, the failure message already sent. Per
  // assignment: started, asked, the thread as last read, the bid thread's text, the account last
  // delivered, rows logged as skipped, when a row was first seen.
  const done = new Memo<string, true>()
  const waitUntil = new Memo<string, number>()
  const attempts = new Memo<string, number>()
  const pending = new Memo<string, { target: BriefTarget; markdown: string; summary: string }>()
  const owedDecline = new Memo<string, { reason: 'rejected' | 'failed'; detail: string }>()
  const told = new Memo<string, true>()
  const started = new Memo<string, true>()
  const asked = new Memo<string, true>()
  const views = new Memo<string, { latest: string; view: ThreadView }>()
  const bidText = new Memo<string, string>()
  const delivered = new Memo<string, BriefTarget>()
  const skipped = new Memo<string, true>()
  const firstSeen = new Memo<string, number>()

  const deadlineOf = (key: string, a: MarketAssignment): number => {
    const t = Date.parse(a.slaDeadlineAt)
    if (Number.isFinite(t)) return t
    if (!firstSeen.has(key)) firstSeen.set(key, now())
    return (firstSeen.get(key) as number) + DEFAULT_SLA_MS
  }

  function stopOn(e: MarketAuthError): void {
    if (stopped) return
    stopped = true
    const why = e.status === 401 ? 'the token was revoked or is malformed' : 'the credential does not act as this agent'
    log(
      `stopped: market.near.ai answered ${e.status} to ${e.method} ${e.path}, so ${why}. ` +
        'Mint a new aat_ token for a-identity-guard, set MARKET_NEAR_AI_TOKEN and restart; nothing is polled until then.',
    )
  }

  /** Every in_progress row, paged, the malformed ones left out. */
  async function listOpen(): Promise<MarketAssignmentRow[]> {
    const rows: MarketAssignmentRow[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await client.listAssignments({ status: 'in_progress', limit: PAGE, offset: page * PAGE })
      for (const r of batch) if (isRow(r)) rows.push(r)
      if (batch.length < PAGE) break
    }
    return rows
  }

  /** The API's own answer, read again just before a submit: still this in_progress round? */
  async function stillOpen(a: MarketAssignment): Promise<boolean> {
    const fresh = (await listOpen()).find((r) => r.assignment.assignmentId === a.assignmentId)?.assignment
    return (
      !!fresh &&
      fresh.status === 'in_progress' &&
      fresh.slaDeadlineAt === a.slaDeadlineAt &&
      (fresh.submittedAt ?? null) === (a.submittedAt ?? null) &&
      (fresh.deliverableUrl ?? null) === (a.deliverableUrl ?? null)
    )
  }

  /** The whole latest message when the poll cut it ("truncated: true means the thread holds the rest"). */
  async function fullBody(id: string, lm: MarketLatestMessage): Promise<string> {
    if (!lm.truncated) return lm.body
    const [newest] = await client.listMessages(id, { limit: 1 })
    return newest && newest.createdAt === lm.createdAt && typeof newest.body === 'string' ? newest.body : lm.body
  }

  /** The buyer's side of the bid's thread, read once per fresh hire. Empty on a definite refusal. */
  async function bidThread(row: MarketAssignmentRow): Promise<string> {
    const a = row.assignment
    if (!isMarketId(a.bidId)) return ''
    const kept = bidText.get(a.assignmentId)
    if (kept !== undefined) return kept
    try {
      const msgs = await client.listBidMessages(a.bidId)
      const text = msgs.filter((m) => m && m.senderSide === 'buyer' && typeof m.body === 'string').map((m) => `\n${m.body}`).join('')
      bidText.set(a.assignmentId, text)
      return text
    } catch (e) {
      if (e instanceof MarketAuthError) throw e
      // Not ours to read ("the resource is not yours"), or gone: nothing in it to read, ever.
      if (e instanceof MarketHttpError && (e.status === 403 || e.status === 404)) bidText.set(a.assignmentId, '')
      return ''
    }
  }

  /** The account our last delivery checked, from its CAIP-10 line. */
  async function previousTarget(id: string): Promise<BriefTarget | null> {
    const kept = delivered.get(id)
    if (kept) return kept
    try {
      const m = CAIP10_LINE.exec(await client.latestDeliverable(id))
      if (!m) return null
      const parsed = parseBrief(`near:${m[1]}:${m[2]}`)
      return parsed.kind === 'one' ? parsed.target : null
    } catch (e) {
      if (e instanceof MarketHttpError && e.status === 404) return null
      throw e
    }
  }

  /** The thread, newest first, up to `pages` pages. */
  async function thread(id: string, pages: number): Promise<MarketThreadMessage[]> {
    const out: MarketThreadMessage[] = []
    for (let page = 0; page < pages; page++) {
      const batch = await client.listMessages(id, { limit: PAGE, offset: page * PAGE })
      for (const m of batch) if (m && typeof m.body === 'string') out.push(m)
      if (batch.length < PAGE) break
    }
    return out
  }

  /**
   * Our question, and what the buyer's side wrote after it, from the thread. Read once per new
   * newest message, and not at all for an empty thread, which holds no question. A message this
   * agent did not write and the platform did not post is the buyer's side: the buyer, or Axi or an
   * MCP client acting for them (the thread's rows carry no side of their own).
   */
  async function threadView(row: MarketAssignmentRow): Promise<ThreadView> {
    const id = row.assignment.assignmentId
    if (!row.latestMessage && !asked.has(id)) return { asked: false, replies: [] }
    const latest = latestKey(row.latestMessage)
    const kept = views.get(id)
    // Kept while the newest message is the same one, unless we asked since it was read.
    if (kept && kept.latest === latest && (kept.view.asked || !asked.has(id))) return kept.view
    const msgs = await thread(id, 1)
    const q = msgs.findIndex(isQuestion)
    const isAsked = q >= 0 || asked.has(id)
    const since = q >= 0 ? msgs.slice(0, q) : isAsked ? msgs : []
    const replies = since
      .filter((m) => !ours(m) && m.origin !== 'platform')
      .reverse()
      .map((m) => a2aText(m.body))
    if (isAsked) asked.set(id, true)
    const view = { asked: isAsked, replies }
    views.set(id, { latest, view })
    return view
  }

  async function plan(row: MarketAssignmentRow, round: Round): Promise<Plan> {
    const a = row.assignment
    const id = a.assignmentId
    const lm = buyerMessage(row.latestMessage)
    const reply = lm ? parseBrief(a2aText(await fullBody(id, lm))) : null
    const briefText = `${row.job.title ?? ''}\n${row.job.description ?? ''}${round === 'first' ? await bidThread(row) : ''}`
    const brief = parseBrief(briefText)
    const amount = reply?.amount ?? brief.amount
    const ok = (target: BriefTarget, feedback: DeliverableContext['feedback'] = null, amt: string | null = amount): Plan => ({ kind: 'ok', target, amount: amt, feedback })

    if (round !== 'first') {
      // A rework or a redo: what the buyer's newest message names, else what was checked before.
      const before = (await previousTarget(id)) ?? (brief.kind === 'one' ? brief.target : null)
      const at = lm?.createdAt ?? ''
      if (reply?.kind === 'one') {
        const switchedFrom = before && before.caip10 !== reply.target.caip10 ? before.caip10 : null
        return ok(reply.target, { at, switchedFrom, namedOne: true })
      }
      if (reply?.kind === 'unclear' && before && reply.notes.length === 0) {
        // "You checked X, I meant Y": two accounts, one of them the one checked before.
        const fresh = reply.targets.filter((t) => t.caip10 !== before.caip10)
        if (reply.targets.length === 2 && fresh.length === 1) return ok(fresh[0], { at, switchedFrom: before.caip10, namedOne: true })
      }
      if (before) return ok(before, round === 'rework' ? { at, switchedFrom: null, namedOne: false } : null)
      // Nothing delivered before can be found and neither the message nor the brief names one
      // account: from here on, as a first round.
    }

    const view = await threadView(row)
    if (view.asked) {
      // After our one question only what the buyer wrote since names the account. The newest
      // reply wins when it names one on its own (a correction); else every reply since is read
      // together, so "one sec" then the id, or the id then "thanks", still names it.
      if (reply?.kind === 'one') return ok(reply.target)
      const since = parseBrief(view.replies.join('\n'))
      if (since.kind === 'one') return ok(since.target, null, since.amount ?? amount)
      if (since.reason === 'none') return { kind: 'wait', replied: view.replies.length > 0 }
      return { kind: 'refuse', parse: since }
    }
    if (reply?.kind === 'one') {
      if (brief.kind === 'one' && brief.target.caip10 !== reply.target.caip10) return { kind: 'ask', parse: disagreement(brief.target, reply.target, amount) }
      return ok(reply.target)
    }
    if (reply?.kind === 'unclear' && reply.reason !== 'none') return { kind: 'ask', parse: reply }
    if (brief.kind === 'one') return ok(brief.target)
    return { kind: 'ask', parse: brief }
  }

  /** Decline, and keep owing it until the marketplace answers, so a lost answer is retried as it was. */
  async function decline(row: MarketAssignmentRow, key: string, reason: 'rejected' | 'failed', detail: string): Promise<void> {
    const id = row.assignment.assignmentId
    owedDecline.set(key, { reason, detail })
    try {
      await client.decline(id, reason, detail)
      done.set(key, true)
      pending.delete(key)
      owedDecline.delete(key)
      log(`assignment ${id}: declined (${reason}); the buyer is refunded in full`)
    } catch (e) {
      if (e instanceof MarketHttpError && (e.status === 400 || e.status === 403 || e.status === 404)) {
        done.set(key, true)
        owedDecline.delete(key)
        log(`assignment ${id}: the decline was refused (${describe(e)}); left alone`)
        return
      }
      throw e
    }
  }

  /** `rejected` is refused once a version was delivered; `failed` is the decline after one. */
  const declineReason = (round: Round): 'rejected' | 'failed' => (round === 'first' ? 'rejected' : 'failed')

  /** Ask the one question, or decline when too little time is left to wait for the answer. */
  async function ask(row: MarketAssignmentRow, key: string, round: Round, parse: UnclearBrief): Promise<void> {
    const a = row.assignment
    const id = a.assignmentId
    if (deadlineOf(key, a) - now() < CLARIFY_MIN_WINDOW_MS) {
      await decline(row, key, declineReason(round), unclearDeclineDetail({ when: 'no_time', parse }))
      return
    }
    try {
      await client.sendMessage(id, clarifyingMessage(parse), `a-identity-guard-clarify-${id}`)
      asked.set(id, true)
      log(`assignment ${id}: the brief names ${parse.reason === 'none' ? 'no' : parse.reason === 'many' ? 'more than one' : 'no usable'} NEAR account; asked the buyer once`)
    } catch (e) {
      if (!(e instanceof MarketHttpError) || (e.status !== 400 && e.status !== 403 && e.status !== 404)) throw e
      if (e.status !== 400 || e.code === 'invalid_state_transition') {
        done.set(key, true)
        log(`assignment ${id}: no longer takes messages (${describe(e)}); left alone`)
        return
      }
      // A definite refusal. The question counts as asked only if the thread holds it (the same
      // clientRequestId already names it, stored with other text before a lost answer or a
      // restart). Otherwise the buyer cannot be asked, and the job goes back at once rather than
      // running out its hour.
      if ((await thread(id, THREAD_PAGES)).some(isQuestion)) {
        asked.set(id, true)
        log(`assignment ${id}: the clarifying message is already in the thread (${describe(e)})`)
        return
      }
      log(`assignment ${id}: the clarifying message was refused (${describe(e)}); declining so the buyer is refunded`)
      await decline(row, key, declineReason(round), unclearDeclineDetail({ when: 'refused', code: e.code ?? 'HTTP 400' }))
    }
  }

  async function onFailure(row: MarketAssignmentRow, key: string, target: BriefTarget, failure: VerdictFailure): Promise<void> {
    const id = row.assignment.assignmentId
    const n = (attempts.get(key) ?? 0) + 1
    attempts.set(key, n)
    const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (n - 1))
    const retryable = failure.code === 'no_verdict' || failure.code === 'timeout'
    if (retryable && now() + wait <= deadlineOf(key, row.assignment) - FAIL_MARGIN_MS) {
      waitUntil.set(key, now() + wait)
      log(`assignment ${id}: no verdict on ${target.caip10} (attempt ${n}): ${failure.error}; trying again in ${Math.round(wait / 1000)} s`)
      return
    }
    log(`assignment ${id}: no verdict on ${target.caip10} after ${n} attempt(s): ${failure.error}; telling the buyer and declining`)
    const detail = failureDeclineDetail(target, failure, n)
    if (!told.has(key)) {
      told.set(key, true)
      try {
        await client.sendMessage(id, detail, `a-identity-guard-failed-${id}-${Date.parse(row.assignment.slaDeadlineAt) || 0}`)
      } catch (e) {
        if (e instanceof MarketAuthError) throw e
        // The decline below carries the same text to the buyer; a refused message does not stop it.
      }
    }
    await decline(row, key, 'failed', detail)
  }

  /**
   * Submit, after reading the state again. The Markdown is kept until the marketplace gives a
   * definite answer, so a lost one is retried with the very same text and no new collection.
   */
  async function deliver(row: MarketAssignmentRow, key: string, target: BriefTarget, markdown: string, summary: string): Promise<void> {
    const id = row.assignment.assignmentId
    pending.set(key, { target, markdown, summary })
    if (!(await stillOpen(row.assignment))) {
      pending.delete(key)
      log(`assignment ${id}: changed before delivery (no longer this in_progress round), so nothing was submitted`)
      return
    }
    try {
      const after = await client.submit(id, markdown)
      pending.delete(key)
      done.set(key, true)
      delivered.set(id, target)
      log(`assignment ${id}: delivered ${summary} on ${target.caip10}${after && typeof after.status === 'string' ? ` (now ${after.status})` : ''}`)
    } catch (e) {
      if (e instanceof MarketAuthError) throw e
      if (isTransient(e)) {
        log(`assignment ${id}: the submit got no clear answer (${describe(e)}); the same Markdown goes again on the next poll if the round is still open`)
        return
      }
      if (e instanceof MarketHttpError && (e.code === 'invalid_state_transition' || e.status === 403 || e.status === 404)) {
        pending.delete(key)
        done.set(key, true)
        log(`assignment ${id}: the submit was refused as out of state or not ours (${describe(e)}); left alone`)
        return
      }
      if (e instanceof MarketHttpError && e.status >= 400 && e.status < 500) {
        pending.delete(key)
        log(`assignment ${id}: the deliverable was refused (${describe(e)}); declining so the buyer is refunded`)
        await decline(row, key, 'failed', internalDeclineDetail(target, e.code ?? `HTTP ${e.status}`))
        return
      }
      throw e
    }
  }

  async function handleRow(row: MarketAssignmentRow, key: string): Promise<void> {
    const a = row.assignment
    const id = a.assignmentId
    if (a.status !== 'in_progress') return
    if (row.job.jobKind === 'competition') {
      if (!skipped.has(id)) {
        skipped.set(id, true)
        log(`assignment ${id}: a competition entry, not a hire; this worker leaves it alone`)
      }
      return
    }
    if (done.has(key)) return
    const wait = waitUntil.get(key)
    if (wait !== undefined && now() < wait) return

    const owed = owedDecline.get(key)
    if (owed) {
      await decline(row, key, owed.reason, owed.detail)
      return
    }
    const lost = pending.get(key)
    if (lost) {
      await deliver(row, key, lost.target, lost.markdown, lost.summary)
      return
    }

    const round = roundOf(a)
    const p = await plan(row, round)
    if (p.kind === 'ask') {
      await ask(row, key, round, p.parse)
      return
    }
    if (p.kind === 'refuse') {
      await decline(row, key, declineReason(round), unclearDeclineDetail({ when: 'reply', parse: p.parse }))
      return
    }
    if (p.kind === 'wait') {
      if (deadlineOf(key, a) - now() <= CLARIFY_GRACE_MS) await decline(row, key, declineReason(round), unclearDeclineDetail({ when: 'no_reply', replied: p.replied }))
      return
    }

    if (!a.startedAt && !started.has(id)) {
      try {
        await client.start(id)
        started.set(id, true)
        log(`assignment ${id}: started, checking ${p.target.caip10}`)
      } catch (e) {
        if (e instanceof MarketHttpError && (e.status === 400 || e.status === 403 || e.status === 404)) {
          done.set(key, true)
          log(`assignment ${id}: no longer startable, or not ours (${describe(e)}); left alone`)
          return
        }
        throw e
      }
    }

    const result = await runVerdict(p.target)
    if (!isVerdict(result)) {
      await onFailure(row, key, p.target, result)
      return
    }
    attempts.delete(key)
    const markdown = renderDeliverable(result, { amount: p.amount, round, feedback: p.feedback })
    await deliver(row, key, p.target, markdown, `${result.decision.verdict} (score ${result.decision.score}, block #${result.decision.block.height})`)
  }

  return {
    get stopped() {
      return stopped
    },
    stop() {
      stopped = true
    },
    async tick(): Promise<TickResult> {
      if (stopped) return { kind: 'stopped' }
      let rows: MarketAssignmentRow[]
      try {
        rows = await listOpen()
      } catch (e) {
        if (e instanceof MarketAuthError) {
          stopOn(e)
          return { kind: 'stopped' }
        }
        pollFailures += 1
        log(`poll ${pollFailures} in a row failed: ${describe(e)}`)
        return { kind: 'transient', retryAfterMs: e instanceof MarketHttpError ? e.retryAfterMs : null }
      }
      if (pollFailures > 0) log(`polling again after ${pollFailures} failed poll(s)`)
      pollFailures = 0
      rows.sort((x, y) => (Date.parse(x.assignment.slaDeadlineAt) || 0) - (Date.parse(y.assignment.slaDeadlineAt) || 0))
      for (const row of rows) {
        if (stopped) break
        const key = roundKey(row.assignment)
        try {
          await handleRow(row, key)
        } catch (e) {
          if (e instanceof MarketAuthError) {
            stopOn(e)
            break
          }
          if (e instanceof MarketHttpError && e.status === 403) {
            // "Valid token, but the resource is not yours": nothing this worker can do on it.
            done.set(key, true)
            log(`assignment ${row.assignment.assignmentId}: ${describe(e)}, so it is not this agent's to act on; left alone`)
            continue
          }
          log(`assignment ${row.assignment.assignmentId}: ${describe(e)}; tried again on the next poll`)
        }
      }
      return stopped ? { kind: 'stopped' } : { kind: 'ok' }
    },
    nextDelayMs(result: TickResult): number | null {
      if (result.kind === 'stopped' || stopped) return null
      if (result.kind === 'ok') return POLL_MIN_MS + Math.floor(random() * (POLL_MAX_MS - POLL_MIN_MS))
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, pollFailures - 1))
      const jittered = Math.floor(backoff * (0.8 + 0.4 * random()))
      return Math.min(BACKOFF_MAX_MS, Math.max(jittered, result.retryAfterMs ?? 0))
    },
  }
}

// -- the env-gated start -----------------------------------------------------------------------

export type StartSeams = {
  /** Tests only: a loopback fake marketplace. Production always talks to market.near.ai. */
  baseUrl?: string
  fetch?: FetchFn
  log?: (line: string) => void
  now?: () => number
  random?: () => number
  runVerdict?: (target: BriefTarget) => Promise<VerdictResult>
  setTimer?: (run: () => void, ms: number) => { unref?: () => void }
}

export type NearMarketHandle = { stop(): void; worker: NearMarketWorker }

/**
 * Start the worker if MARKET_NEAR_AI_TOKEN is set; otherwise write one line and do nothing.
 * Never throws. Returns how to stop it, or null when it is off.
 */
export function startNearMarketWorker(env: NodeJS.ProcessEnv = process.env, seams: StartSeams = {}): NearMarketHandle | null {
  const raw = seams.log ?? ((line: string) => console.error(`[near-market] ${line}`))
  const token = (env.MARKET_NEAR_AI_TOKEN ?? '').trim()
  const log = (line: string) => raw(redactToken(line, token || undefined))
  try {
    if (!token) {
      log('off: MARKET_NEAR_AI_TOKEN is not set, so the NEAR AI market worker does not run')
      return null
    }
    if (!isMarketToken(token)) {
      log('off: MARKET_NEAR_AI_TOKEN is set but is not an aat_ agent token (the value is not printed)')
      return null
    }
    const client = createMarketClient({ token, ...(seams.baseUrl ? { baseUrl: seams.baseUrl } : {}), ...(seams.fetch ? { fetch: seams.fetch } : {}) })
    const worker = createNearMarketWorker({
      client,
      log,
      runVerdict: seams.runVerdict ?? ((target) => runMarketVerdict(target, { env })),
      ...(seams.now ? { now: seams.now } : {}),
      ...(seams.random ? { random: seams.random } : {}),
    })
    const setTimer = seams.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
    let halted = false
    const schedule = (ms: number) => {
      if (halted || worker.stopped) return
      setTimer(() => {
        if (halted) return
        worker.tick().then(
          (result) => {
            const next = worker.nextDelayMs(result)
            if (next !== null) schedule(next)
          },
          (e) => {
            log(`a poll threw: ${describe(e)}`)
            schedule(BACKOFF_BASE_MS)
          },
        )
      }, ms).unref?.()
    }
    // On Render a deploy runs the new instance beside the old one until the old one gets SIGTERM:
    // the first poll waits past that, so the two never poll at once.
    const first = env.RENDER ? RENDER_FIRST_POLL_MS : FIRST_POLL_MS
    schedule(first)
    log(
      `on: polling ${seams.baseUrl ?? MARKET_ORIGIN} for this agent's assignments every 30 to 60 s, the first poll in ${Math.round(first / 1000)} s; ` +
        'NEAR testnet and mainnet accounts, read only; one process per token',
    )
    return {
      worker,
      stop() {
        halted = true
        worker.stop()
      },
    }
  } catch (e) {
    log(`off: ${describe(e)}`)
    return null
  }
}

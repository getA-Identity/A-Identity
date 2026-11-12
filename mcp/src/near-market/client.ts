/**
 * The NEAR AI Agent Market's worker API (https://market.near.ai), as A-Identity's listed agent
 * (handle a-identity-guard) calls it: the few endpoints the worker loop uses, and nothing else.
 *
 * Every path, field and state name below is the marketplace's own, read on 2026-11-12 from
 * /skill/SKILL.md (marketplace-worker 0.62.0), /skill/flows/worker-lifecycle.md,
 * /skill/flows/messaging.md, /skill/reference/agent-api.md and /openapi.json (tags worker and
 * jobs). The surface used:
 *
 *   GET  /v1/agents/me/assignments            the actionable queue (in_progress by default)
 *   POST /v1/assignments/{id}/start           declare start (idempotent)
 *   GET  /v1/assignments/{id}/messages        the thread, newest first
 *   POST /v1/assignments/{id}/messages        { body, clientRequestId }
 *   POST /v1/assignments/{id}/submit          { deliverableMarkdown }
 *   POST /v1/assignments/{id}/decline         { reason: rejected | failed, detail }
 *   GET  /v1/assignments/{id}/deliverable/raw the latest Markdown we submitted
 *   GET  /v1/bids/{id}/messages               the bid's thread, read once on a fresh hire
 *
 * The token. The agent's aat_ bearer token goes to ONE origin, https://market.near.ai, and to
 * nothing else. The base URL is fixed in production; every request URL is built from a fixed
 * path template with ids that must be UUIDs, and is checked against that origin before the
 * header is attached; redirects are refused rather than followed, since a redirect is the one
 * way a header could be carried to another host. No error this module builds carries the token:
 * errors name the method, the path template and the status, and every free-text message that
 * leaves the module goes through redactToken. Tests may point the client at a loopback address;
 * no other host is accepted.
 */

/** The marketplace origin, the only one the token is ever sent to. */
export const MARKET_ORIGIN = 'https://market.near.ai'

/** The agent's own assignment list: the one route where a 403 says the credential is not an agent's. */
const AGENT_LIST = '/v1/agents/me/assignments'

/** Per request: the worker polls on a 30 to 60 s cadence, so a hung call must not stall it. */
const REQUEST_TIMEOUT_MS = 20_000

/** Ids the marketplace issues are UUIDs (openapi.json: format uuid). Nothing else enters a path. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isMarketId = (s: unknown): s is string => typeof s === 'string' && UUID.test(s)

/**
 * The docs give the shape as `aat_<32 hex chars>`. Accepted a little wider (letters, digits, _ and
 * -, 16 to 128 of them) so a change of length on the marketplace's side is answered by a clean 401
 * from the marketplace rather than by this worker refusing to start.
 */
export const isMarketToken = (s: string): boolean => /^aat_[A-Za-z0-9_-]{16,128}$/.test(s)

/** Replace the token, and anything shaped like one, with a fixed marker. */
export function redactToken(text: string, token?: string): string {
  let out = text
  if (token) out = out.split(token).join('aat_[redacted]')
  return out.replace(/aat_[A-Za-z0-9_-]{4,}/g, 'aat_[redacted]')
}

// -- the shapes we read (openapi.json components) --------------------------------------------

export type MarketAssignment = {
  assignmentId: string
  jobId: string
  status: string
  bidId?: string | null
  slaSeconds?: number
  slaDeadlineAt: string
  startedAt?: string | null
  submittedAt?: string | null
  deliverableUrl?: string | null
  cancelReason?: string | null
}

export type MarketJobBrief = {
  jobId: string
  title: string
  description: string
  tags?: string[]
  jobKind?: string
  status?: string
}

export type MarketLatestMessage = {
  senderSide: string
  origin?: string
  body: string
  truncated?: boolean
  createdAt: string
}

export type MarketAssignmentRow = {
  assignment: MarketAssignment
  job: MarketJobBrief
  latestMessage: MarketLatestMessage | null
}

export type MarketThreadMessage = {
  messageId: string
  senderAccountId?: string
  /** Set when the worker side's agent wrote it with its own aat_ token: that is us. */
  senderAgentId?: string | null
  origin?: string
  body: string
  createdAt: string
}

export type MarketBidMessage = { senderSide: string; body: string; createdAt: string }

// -- errors ----------------------------------------------------------------------------------

/**
 * The credential itself is refused, so the worker stops on it. The docs: "a REST 401 means your
 * token was revoked or is malformed - stop the loop", on any route. A 403 means that only on the
 * agent's own list (openapi.json: "wrong kind of principal for an agent-only route"); on one
 * assignment or bid it is "valid token, but the resource is not yours", a MarketHttpError that
 * leaves only that resource alone.
 */
export class MarketAuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly method: string,
    readonly path: string,
  ) {
    super(`market.near.ai answered ${status} to ${method} ${path}`)
    this.name = 'MarketAuthError'
  }
}

/** Any other non-2xx answer. `code` is the body's `error` field when it has one. */
export class MarketHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly method: string,
    readonly path: string,
    readonly retryAfterMs: number | null,
    detail: string,
  ) {
    super(`market.near.ai answered ${status}${code ? ` ${code}` : ''} to ${method} ${path}${detail ? `: ${detail}` : ''}`)
    this.name = 'MarketHttpError'
  }
  /** The docs: "Treat any 5xx as retryable with backoff"; a 429 asks us to wait. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429
  }
}

/** No answer at all: a transport failure, a timeout, a refused redirect or an unreadable body. */
export class MarketNetworkError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    why: string,
  ) {
    super(`no usable answer from market.near.ai to ${method} ${path}: ${why}`)
    this.name = 'MarketNetworkError'
  }
}

export const isTransient = (e: unknown): boolean => e instanceof MarketNetworkError || (e instanceof MarketHttpError && e.transient)

// -- the client ------------------------------------------------------------------------------

export type MarketClient = {
  listAssignments(opts?: { status?: string; limit?: number; offset?: number }): Promise<MarketAssignmentRow[]>
  start(id: string): Promise<{ startedAt: string }>
  listMessages(id: string, opts?: { limit?: number; offset?: number }): Promise<MarketThreadMessage[]>
  sendMessage(id: string, body: string, clientRequestId: string): Promise<MarketThreadMessage>
  submit(id: string, deliverableMarkdown: string): Promise<MarketAssignment>
  decline(id: string, reason: 'rejected' | 'failed', detail: string): Promise<MarketAssignment>
  latestDeliverable(id: string): Promise<string>
  listBidMessages(bidId: string): Promise<MarketBidMessage[]>
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: 'error'; signal: AbortSignal }) => Promise<{
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export type MarketClientOptions = {
  token: string
  /** Production omits it. A test passes a loopback URL; any other host is refused. */
  baseUrl?: string
  fetch?: FetchFn
  timeoutMs?: number
}

/** The origin requests go to: market.near.ai, or a loopback address in a test. */
export function marketBase(baseUrl: string = MARKET_ORIGIN): URL {
  const u = new URL(baseUrl)
  if (u.origin === MARKET_ORIGIN) return new URL(MARKET_ORIGIN)
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.protocol === 'http:' && loopback) return new URL(u.origin)
  throw new Error(`refusing to send the marketplace token to ${u.origin}: only ${MARKET_ORIGIN} (or a loopback test server) receives it`)
}

const retryAfterMs = (value: string | null): number | null => {
  if (!value) return null
  const s = Number(value)
  if (Number.isFinite(s) && s >= 0) return Math.min(s, 3600) * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, Math.min(at - Date.now(), 3_600_000)) : null
}

const idOf = (id: string, what: string): string => {
  if (!isMarketId(id)) throw new TypeError(`${what} is not a marketplace id (a UUID)`)
  return id
}

export function createMarketClient(opts: MarketClientOptions): MarketClient {
  const token = opts.token
  if (!isMarketToken(token)) throw new TypeError('the marketplace token is not an aat_ agent token')
  const base = marketBase(opts.baseUrl)
  const doFetch: FetchFn = opts.fetch ?? ((url, init) => fetch(url, init))
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS

  /** One call. `template` is the documented path with {id} left in, for errors and logs. */
  async function call(method: 'GET' | 'POST', template: string, path: string, body?: unknown, accept = 'application/json'): Promise<{ status: number; text: string }> {
    const url = new URL(path, base)
    // The header is attached only to a URL on the base origin. Every path here is a template
    // over UUIDs, so this cannot fail today; it is what keeps a future edit from sending the
    // token somewhere else.
    if (url.origin !== base.origin) throw new MarketNetworkError(method, template, 'the URL left the marketplace origin')
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept }
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res: Awaited<ReturnType<FetchFn>>
    let text: string
    try {
      res = await doFetch(url.toString(), {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      text = await res.text()
    } catch (e) {
      const why = e instanceof Error ? (e.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} s` : e.message) : String(e)
      throw new MarketNetworkError(method, template, redactToken(why, token))
    }
    if (res.status === 401 || (res.status === 403 && template === AGENT_LIST)) throw new MarketAuthError(res.status, method, template)
    if (res.status < 200 || res.status >= 300) {
      let code: string | null = null
      let detail = ''
      try {
        const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
        if (typeof parsed.error === 'string') code = parsed.error
        if (typeof parsed.message === 'string') detail = parsed.message
      } catch {
        detail = text.slice(0, 200)
      }
      throw new MarketHttpError(res.status, code, method, template, retryAfterMs(res.headers.get('retry-after')), redactToken(detail, token).slice(0, 300))
    }
    return { status: res.status, text }
  }

  async function json<T>(method: 'GET' | 'POST', template: string, path: string, body?: unknown): Promise<T> {
    const { text } = await call(method, template, path, body)
    try {
      return JSON.parse(text) as T
    } catch {
      throw new MarketNetworkError(method, template, 'the answer is not JSON')
    }
  }

  const page = (o: { limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams()
    if (o.limit !== undefined) q.set('limit', String(o.limit))
    if (o.offset !== undefined) q.set('offset', String(o.offset))
    return q
  }

  return {
    async listAssignments(o = {}) {
      const q = page(o)
      if (o.status) q.set('status', o.status)
      const qs = q.toString()
      const out = await json<{ assignments?: unknown }>('GET', AGENT_LIST, `${AGENT_LIST}${qs ? `?${qs}` : ''}`)
      if (!Array.isArray(out.assignments)) throw new MarketNetworkError('GET', AGENT_LIST, 'the answer has no assignments list')
      return out.assignments as MarketAssignmentRow[]
    },
    async start(id) {
      return json('POST', '/v1/assignments/{id}/start', `/v1/assignments/${idOf(id, 'assignment')}/start`)
    },
    async listMessages(id, o = {}) {
      const qs = page(o).toString()
      const out = await json<{ messages?: unknown }>('GET', '/v1/assignments/{id}/messages', `/v1/assignments/${idOf(id, 'assignment')}/messages${qs ? `?${qs}` : ''}`)
      return Array.isArray(out.messages) ? (out.messages as MarketThreadMessage[]) : []
    },
    async sendMessage(id, body, clientRequestId) {
      return json('POST', '/v1/assignments/{id}/messages', `/v1/assignments/${idOf(id, 'assignment')}/messages`, { body, clientRequestId })
    },
    async submit(id, deliverableMarkdown) {
      return json('POST', '/v1/assignments/{id}/submit', `/v1/assignments/${idOf(id, 'assignment')}/submit`, { deliverableMarkdown })
    },
    async decline(id, reason, detail) {
      return json('POST', '/v1/assignments/{id}/decline', `/v1/assignments/${idOf(id, 'assignment')}/decline`, { reason, detail: detail.slice(0, 1000) })
    },
    async latestDeliverable(id) {
      return (await call('GET', '/v1/assignments/{id}/deliverable/raw', `/v1/assignments/${idOf(id, 'assignment')}/deliverable/raw`, undefined, 'text/markdown')).text
    },
    async listBidMessages(bidId) {
      const out = await json<{ messages?: unknown }>('GET', '/v1/bids/{id}/messages', `/v1/bids/${idOf(bidId, 'bid')}/messages?limit=20`)
      return Array.isArray(out.messages) ? (out.messages as MarketBidMessage[]) : []
    },
  }
}

/**
 * A fake NEAR AI Agent Market for the worker's tests: a real HTTP server on 127.0.0.1 that answers
 * the worker endpoints the way the marketplace documents them, with the states and the refusals
 * the worker has to live with (the marketplace's own docs, read 2026-11-12:
 * https://market.near.ai/skill/flows/worker-lifecycle.md, https://market.near.ai/skill/flows/messaging.md,
 * https://market.near.ai/skill/reference/agent-api.md and https://market.near.ai/openapi.json).
 * Test seam only: nothing in production imports it.
 *
 * What it holds to, because the worker relies on it:
 *  - every route answers 401 {"error":"unauthorized"} without the exact bearer, or once revoked;
 *  - start is idempotent, and refuses a never-started row that is no longer in_progress;
 *  - a message's clientRequestId replays the stored message for the same text and is refused
 *    for other text; threads take writes only while in_progress or submitted;
 *  - submit moves in_progress to submitted (accepted at once for an A2A hire), and resending the
 *    same Markdown while submitted is a no-op;
 *  - decline takes rejected or failed, refuses rejected after a delivery, refunds (cancelled);
 *  - a request-changes re-arms slaDeadlineAt in full and leaves submittedAt set.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export const FAKE_AGENT_ID = '00000000-0000-4000-8000-00000000a9e7'
const BUYER_ACCOUNT = '00000000-0000-4000-8000-0000000b0b0b'
const OWNER_ACCOUNT = '00000000-0000-4000-8000-0000000c0c0c'

type Msg = {
  messageId: string
  assignmentId: string
  senderAccountId: string
  senderAgentId: string | null
  origin: string
  body: string
  createdAt: string
  side: 'buyer' | 'worker'
  clientRequestId?: string
}

export type FakeAssignmentState = {
  assignment: {
    assignmentId: string
    jobId: string
    workerAgentId: string
    status: string
    escrowAmount: string
    escrowToken: string
    slaSeconds: number
    slaDeadlineAt: string
    acceptanceWindowDays: number
    createdAt: string
    updatedAt: string
    bidId: string | null
    startedAt: string | null
    submittedAt: string | null
    deliverableUrl: string | null
    cancelReason: string | null
    cancelDetail: string | null
  }
  job: { jobId: string; title: string; description: string; tags: string[]; jobKind: string; status: string; attachments: unknown[] }
  messages: Msg[]
  versions: string[]
  bidMessages: Array<{ senderSide: 'buyer' | 'bidder'; body: string }>
  a2a: boolean
}

export type FakeRequest = { method: string; path: string; auth: string | undefined; body: unknown }

export type FakeMarket = {
  baseUrl: string
  requests: FakeRequest[]
  hire(h: { description: string; title?: string; slaSeconds?: number; jobKind?: string; a2a?: boolean; bid?: boolean; openingMessage?: string }): string
  buyerSays(id: string, body: string, origin?: string): void
  bidThread(id: string, messages: Array<{ senderSide: 'buyer' | 'bidder'; body: string }>): void
  requestChanges(id: string, body: string): void
  cancel(id: string): void
  state(id: string): FakeAssignmentState
  revoke(): void
  /** The next `times` requests matching method and path answer `status` instead. */
  failNext(method: string, path: RegExp, status: number, opts?: { times?: number; retryAfter?: number; body?: unknown }): void
  close(): Promise<void>
}

export async function startFakeMarket(opts: { token: string; now: () => number }): Promise<FakeMarket> {
  const iso = () => new Date(opts.now()).toISOString()
  const rows = new Map<string, FakeAssignmentState>()
  const requests: FakeRequest[] = []
  const failures: Array<{ method: string; path: RegExp; status: number; times: number; retryAfter?: number; body?: unknown }> = []
  let revoked = false

  const latest = (s: FakeAssignmentState) => {
    const m = s.messages[s.messages.length - 1]
    if (!m) return null
    return { senderSide: m.side, origin: m.origin, body: m.body.slice(0, 4000), truncated: m.body.length > 4000, attachments: [], createdAt: m.createdAt }
  }
  const touch = (s: FakeAssignmentState) => {
    s.assignment.updatedAt = iso()
  }
  const addMessage = (s: FakeAssignmentState, side: 'buyer' | 'worker', body: string, origin = 'direct', clientRequestId?: string): Msg => {
    const m: Msg = {
      messageId: randomUUID(),
      assignmentId: s.assignment.assignmentId,
      senderAccountId: side === 'buyer' ? BUYER_ACCOUNT : OWNER_ACCOUNT,
      senderAgentId: side === 'worker' ? FAKE_AGENT_ID : null,
      origin,
      body,
      createdAt: iso(),
      side,
      ...(clientRequestId ? { clientRequestId } : {}),
    }
    s.messages.push(m)
    touch(s)
    return m
  }
  const publicMsg = (m: Msg) => ({
    messageId: m.messageId,
    assignmentId: m.assignmentId,
    senderAccountId: m.senderAccountId,
    senderAgentId: m.senderAgentId,
    origin: m.origin,
    body: m.body,
    createdAt: m.createdAt,
    attachments: [],
  })

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, auth: req.headers.authorization, body })
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
        res.writeHead(status, { 'content-type': typeof payload === 'string' ? 'text/markdown' : 'application/json', ...headers })
        res.end(text)
      }
      if (revoked || req.headers.authorization !== `Bearer ${opts.token}`) return send(401, { error: 'unauthorized' })
      const fail = failures.find((f) => f.method === req.method && f.path.test(url.pathname) && f.times > 0)
      if (fail) {
        fail.times -= 1
        return send(fail.status, fail.body ?? { error: fail.status >= 500 ? 'internal_error' : 'error', message: 'injected by the test' }, fail.retryAfter !== undefined ? { 'retry-after': String(fail.retryAfter) } : {})
      }

      if (req.method === 'GET' && url.pathname === '/v1/agents/me/assignments') {
        const status = url.searchParams.get('status') ?? 'in_progress'
        const limit = Number(url.searchParams.get('limit') ?? 50)
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const list = [...rows.values()]
          .filter((s) => status === 'all' || s.assignment.status === status)
          .sort((a, b) => b.assignment.createdAt.localeCompare(a.assignment.createdAt))
          .slice(offset, offset + limit)
          .map((s) => ({ assignment: { ...s.assignment }, job: { ...s.job }, latestMessage: latest(s), autoAcceptAt: null }))
        return send(200, { assignments: list })
      }
      const m = /^\/v1\/assignments\/([^/]+)\/(start|messages|submit|decline|deliverable\/raw)$/.exec(url.pathname)
      const bid = /^\/v1\/bids\/([^/]+)\/messages$/.exec(url.pathname)
      if (bid && req.method === 'GET') {
        const s = [...rows.values()].find((r) => r.assignment.bidId === bid[1])
        if (!s) return send(404, { error: 'not_found' })
        const msgs = [...s.bidMessages].reverse().map((x) => ({ messageId: randomUUID(), bidId: bid[1], senderSide: x.senderSide, senderAccountId: BUYER_ACCOUNT, senderAgentId: null, body: x.body, createdAt: iso(), attachments: [] }))
        return send(200, { sendState: 'closed', messages: msgs, total: msgs.length })
      }
      if (!m) return send(404, { error: 'not_found' })
      const s = rows.get(m[1])
      if (!s) return send(404, { error: 'not_found' })
      const a = s.assignment
      const b = (body ?? {}) as Record<string, unknown>
      const action = `${req.method} ${m[2]}`

      if (action === 'POST start') {
        if (a.status !== 'in_progress' && !a.startedAt) return send(400, { error: 'invalid_state_transition', message: `cannot transition from '${a.status}' to 'started'` })
        a.startedAt = a.startedAt ?? iso()
        touch(s)
        return send(200, { startedAt: a.startedAt })
      }
      if (action === 'GET messages') {
        const limit = Number(url.searchParams.get('limit') ?? 10)
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const msgs = [...s.messages].reverse().slice(offset, offset + limit).map(publicMsg)
        return send(200, { messages: msgs, total: s.messages.length, workerActivity: { state: 'idle' }, workerProgress: null })
      }
      if (action === 'POST messages') {
        if (a.status !== 'in_progress' && a.status !== 'submitted') return send(400, { error: 'invalid_state_transition', message: `cannot transition from '${a.status}' to 'message'` })
        const text = typeof b.body === 'string' ? b.body.trim() : ''
        if (text.length < 1 || text.length > 4000) return send(400, { error: 'validation_error', message: 'body must be 1-4000 characters' })
        const crid = typeof b.clientRequestId === 'string' ? b.clientRequestId : undefined
        if (crid !== undefined) {
          const prior = s.messages.find((x) => x.clientRequestId === crid)
          if (prior && prior.body !== b.body) return send(400, { error: 'validation_error', message: 'clientRequestId already names a different message' })
          if (prior) return send(201, publicMsg(prior))
        }
        return send(201, publicMsg(addMessage(s, 'worker', String(b.body), 'direct', crid)))
      }
      if (action === 'POST submit') {
        if (typeof b.deliverableMarkdown !== 'string') return send(422, { error: 'unprocessable' })
        const md = b.deliverableMarkdown
        if (md.length === 0 || Buffer.byteLength(md) > 256 * 1024) return send(400, { error: 'invalid_deliverable', message: 'empty or over 256 KiB' })
        if (a.status === 'submitted') {
          if (s.versions[s.versions.length - 1] !== md) {
            s.versions.push(md)
            a.submittedAt = iso()
          }
          return send(200, { ...a })
        }
        if (a.status !== 'in_progress') return send(400, { error: 'invalid_state_transition', message: `cannot transition from '${a.status}' to 'submitted'` })
        s.versions.push(md)
        a.status = s.a2a ? 'accepted' : 'submitted'
        a.submittedAt = iso()
        a.deliverableUrl = `deliverables/${a.assignmentId}/v${s.versions.length}.md`
        touch(s)
        return send(200, { ...a })
      }
      if (action === 'POST decline') {
        if (b.reason !== 'rejected' && b.reason !== 'failed') return send(400, { error: 'validation_error', message: 'reason is rejected or failed' })
        if (a.status !== 'in_progress') return send(400, { error: 'invalid_state_transition', message: `cannot transition from '${a.status}' to 'cancelled'` })
        if (b.reason === 'rejected' && a.deliverableUrl) return send(400, { error: 'validation_error', message: 'rejected after a delivery' })
        if (typeof b.detail === 'string' && b.detail.length > 1000) return send(400, { error: 'validation_error', message: 'detail over 1000 characters' })
        a.status = 'cancelled'
        a.cancelReason = b.reason
        a.cancelDetail = typeof b.detail === 'string' ? b.detail : null
        touch(s)
        return send(200, { ...a })
      }
      if (action === 'GET deliverable/raw') {
        const last = s.versions[s.versions.length - 1]
        return last === undefined ? send(404, { error: 'not_found' }) : send(200, last)
      }
      return send(404, { error: 'not_found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const need = (id: string) => {
    const s = rows.get(id)
    if (!s) throw new Error(`no assignment ${id}`)
    return s
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    hire(h) {
      const assignmentId = randomUUID()
      const jobId = randomUUID()
      const sla = h.slaSeconds ?? 3600
      const created = iso()
      const s: FakeAssignmentState = {
        assignment: {
          assignmentId,
          jobId,
          workerAgentId: FAKE_AGENT_ID,
          status: 'in_progress',
          escrowAmount: '0.500000000000',
          escrowToken: 'USD',
          slaSeconds: sla,
          slaDeadlineAt: new Date(opts.now() + sla * 1000).toISOString(),
          acceptanceWindowDays: 3,
          createdAt: created,
          updatedAt: created,
          bidId: h.bid === false ? null : randomUUID(),
          startedAt: null,
          submittedAt: null,
          deliverableUrl: null,
          cancelReason: null,
          cancelDetail: null,
        },
        job: { jobId, title: h.title ?? 'Hire A-Identity Guard for NEAR', description: h.description, tags: ['finance'], jobKind: h.jobKind ?? 'instant', status: 'in_progress', attachments: [] },
        messages: [],
        versions: [],
        bidMessages: [],
        a2a: h.a2a === true,
      }
      rows.set(assignmentId, s)
      if (h.openingMessage !== undefined) addMessage(s, 'buyer', h.openingMessage, 'direct')
      return assignmentId
    },
    buyerSays(id, body, origin = 'direct') {
      addMessage(need(id), 'buyer', body, origin)
    },
    bidThread(id, messages) {
      need(id).bidMessages = messages
    },
    requestChanges(id, body) {
      const s = need(id)
      if (s.assignment.status !== 'submitted') throw new Error(`request-changes needs a submitted assignment, not ${s.assignment.status}`)
      s.assignment.status = 'in_progress'
      s.assignment.slaDeadlineAt = new Date(opts.now() + s.assignment.slaSeconds * 1000).toISOString()
      addMessage(s, 'buyer', body, 'direct')
    },
    cancel(id) {
      const s = need(id)
      s.assignment.status = 'cancelled'
      s.assignment.cancelReason = 'buyer_cancelled'
      touch(s)
    },
    state: need,
    revoke() {
      revoked = true
    },
    failNext(method, path, status, o = {}) {
      failures.push({ method, path, status, times: o.times ?? 1, ...(o.retryAfter !== undefined ? { retryAfter: o.retryAfter } : {}), ...(o.body !== undefined ? { body: o.body } : {}) })
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

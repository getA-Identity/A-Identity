import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createVerifyThenPayRoutes, verifyThenPayMcpHooks, type VtpRouteDeps } from './verify-then-pay-routes.js'
import type { RouteCtx } from './shared.js'

/**
 * The three verify-then-pay routes at the HTTP boundary, with the flow itself stubbed (core
 * and receipt have their own tests): which method each path takes, that the payment header
 * reaches the flow under either name, that the 402's PAYMENT-REQUIRED header is sent, and that
 * a body that is not JSON is refused before the flow runs.
 */
type Out = { status?: number; body?: Record<string, unknown>; headers: Record<string, string> }

function fakeRes(): { out: Out; res: never } {
  const out: Out = { headers: {} }
  return {
    out,
    res: {
      setHeader: (k: string, v: string) => {
        out.headers[k] = v
      },
      writeHead(status: number) {
        out.status = status
        return this
      },
      end: (payload?: string) => {
        if (payload) out.body = JSON.parse(payload) as Record<string, unknown>
      },
    } as never,
  }
}

async function call(handler: (ctx: RouteCtx) => Promise<boolean>, method: string, path: string, opts: { body?: string; headers?: Record<string, string> } = {}) {
  const { out, res } = fakeRes()
  const req = Object.assign(Readable.from(opts.body !== undefined ? [Buffer.from(opts.body)] : []), {
    method,
    headers: { host: 'backend.example', 'x-forwarded-proto': 'https', ...(opts.headers ?? {}) },
  })
  const handled = await handler({ req: req as never, res, url: new URL(`http://localhost${path}`), caller: null, callerId: undefined })
  return { handled, ...out }
}

function stubs() {
  const seen: { run: unknown[][]; read: unknown[][]; receipt: unknown[][] } = { run: [], read: [], receipt: [] }
  const deps: VtpRouteDeps = {
    run: (async (...a: unknown[]) => {
      seen.run.push(a)
      return { httpStatus: 402, headers: { 'PAYMENT-REQUIRED': 'Y2hhbGxlbmdl' }, body: { tool: 'verify_then_pay', stage: 'payment_required', executed: false } }
    }) as never,
    read: (async (...a: unknown[]) => {
      seen.read.push(a)
      return { httpStatus: 404, body: { flowId: a[0], flow: null } }
    }) as never,
    receipt: (async (...a: unknown[]) => {
      seen.receipt.push(a)
      return { httpStatus: 202, body: { tool: 'verify_then_pay_receipt', verified: false, retry: true } }
    }) as never,
  }
  return { deps, seen }
}

const FLOW = '0x' + 'ab'.repeat(32)
const TX = '0x' + 'c1'.repeat(32)

test('POST verify-then-pay hands the body and the payment to the flow and sends what it answers, headers included', async () => {
  const { deps, seen } = stubs()
  const h = createVerifyThenPayRoutes(deps)
  const body = { vault: '0x' + 'a1'.repeat(20), payee: '0x' + 'd4'.repeat(20), amount: '250000' }
  const out = await call(h, 'POST', '/api/x402/gateway/verify-then-pay', { body: JSON.stringify(body), headers: { 'payment-signature': 'c2lnbmVk' } })
  assert.deepEqual([out.handled, out.status], [true, 402])
  assert.equal(out.headers['PAYMENT-REQUIRED'], 'Y2hhbGxlbmdl')
  assert.equal(out.headers['Cache-Control'], 'no-store')
  assert.deepEqual(seen.run, [[body, 'c2lnbmVk', { origin: 'https://backend.example' }]])
  assert.equal(out.body?.executed, false)

  // The v1 header name reaches it too, and no body is an empty request, not a crash.
  await call(h, 'POST', '/api/x402/gateway/verify-then-pay', { headers: { 'x-payment': 'djE=' } })
  assert.deepEqual(seen.run[1], [{}, 'djE=', { origin: 'https://backend.example' }])

  const bad = await call(h, 'POST', '/api/x402/gateway/verify-then-pay', { body: '{ not json' })
  assert.equal(bad.status, 400)
  const list = await call(h, 'POST', '/api/x402/gateway/verify-then-pay', { body: '[1,2]' })
  assert.equal(list.status, 400)
  assert.equal(seen.run.length, 2, 'a body that is not a JSON object never reaches the flow')

  const wrong = await call(h, 'GET', '/api/x402/gateway/verify-then-pay')
  assert.equal(wrong.status, 405)
})

test('the flow record is a GET, its receipt a POST, and nothing else under the Gateway prefix is claimed', async () => {
  const { deps, seen } = stubs()
  const h = createVerifyThenPayRoutes(deps)
  const read = await call(h, 'GET', `/api/x402/gateway/flows/${FLOW}`)
  assert.deepEqual([read.status, read.headers['Cache-Control']], [404, 'no-store'])
  assert.deepEqual(seen.read, [[FLOW, { origin: 'https://backend.example' }]])
  assert.equal((await call(h, 'POST', `/api/x402/gateway/flows/${FLOW}`)).status, 405)

  const rec = await call(h, 'POST', `/api/x402/gateway/flows/${FLOW}/receipt`, { body: JSON.stringify({ txHash: TX }) })
  assert.equal(rec.status, 202)
  assert.deepEqual(seen.receipt, [[FLOW, TX, { origin: 'https://backend.example' }]])
  assert.equal((await call(h, 'GET', `/api/x402/gateway/flows/${FLOW}/receipt`)).status, 405)

  // The rail's own paths fall through to its group, and other prefixes are not looked at.
  for (const path of ['/api/x402/gateway/status', '/api/x402/gateway/tools/risk_check', '/api/x402/tools/risk_check', '/api/arc/season']) {
    assert.equal((await call(h, 'GET', path)).handled, false, path)
  }
})

test('over MCP each verify-then-pay call is charged to its route bucket for the caller address, and over the budget it runs nothing', async () => {
  const { deps, seen } = stubs()
  const charged: string[] = []
  let over = false
  const hooks = verifyThenPayMcpHooks({
    ip: '203.0.113.7',
    origin: 'https://backend.example',
    run: deps.run,
    receipt: deps.receipt,
    limited: (key, max, windowMs) => {
      charged.push(`${key} ${max}/${windowMs}`)
      return over
    },
  })
  const input = { vault: '0x' + 'a1'.repeat(20), payee: '0x' + 'd4'.repeat(20), amount: '250000', payment: 'c2lnbmVk' }
  assert.equal(((await hooks.run(input)) as { stage: string }).stage, 'payment_required')
  assert.deepEqual(seen.run, [[input, 'c2lnbmVk', { origin: 'https://backend.example' }]])
  await hooks.receipt({ flowId: FLOW, txHash: TX })
  assert.deepEqual(seen.receipt, [[FLOW, TX, { origin: 'https://backend.example' }]])
  assert.deepEqual(charged, ['203.0.113.7:vtp 30/60000', '203.0.113.7:vtp-receipt 30/60000'], 'the routes own buckets, keyed by the caller address')

  over = true
  const run = (await hooks.run(input)) as { stage: string; code: string; charged: boolean; executed: boolean; next: string }
  assert.deepEqual([run.stage, run.code, run.charged, run.executed], ['refused', 'RATE_LIMITED', false, false])
  assert.match(run.next, /Nothing was read and nothing was charged/)
  const rec = (await hooks.receipt({ flowId: FLOW, txHash: TX })) as { code: string; retry: boolean; verified: boolean; flowId: string }
  assert.deepEqual([rec.code, rec.retry, rec.verified, rec.flowId], ['RATE_LIMITED', true, false, FLOW])
  assert.deepEqual([seen.run.length, seen.receipt.length], [1, 1], 'over the budget nothing ran')
})

test('the real limiter bounds a burst of tool calls from one address the way it bounds a burst of POSTs', async () => {
  const { deps, seen } = stubs()
  const hooks = verifyThenPayMcpHooks({ ip: `burst-test-${process.pid}`, origin: 'https://backend.example', run: deps.run, receipt: deps.receipt })
  // A JSON-RPC batch runs its messages at once; thirty-five of them meet a bucket of thirty.
  const out = await Promise.all(Array.from({ length: 35 }, () => hooks.run({ vault: 'x', payee: 'y', amount: '1' })))
  assert.equal(seen.run.length, 30)
  assert.equal(out.filter((o) => (o as { code?: string }).code === 'RATE_LIMITED').length, 5)
})

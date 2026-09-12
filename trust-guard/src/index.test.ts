import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TrustGuard, guard, TrustDenyError, PaymentRequiredError } from './index.js'

/** Build a fake fetch that returns `status` + `body`, recording the last request. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(body == null ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fn, calls }
}

test('riskCheck posts to /tools/risk_check with the agent + txContext', async () => {
  const { fn, calls } = fakeFetch(200, { tool: 'risk_check', agentId: '849980', decision: 'ALLOW', risk: 'low', reasons: [] })
  const g = new TrustGuard({ fetch: fn, baseUrl: 'https://oracle.test/' })
  await g.riskCheck('849980', { amountUsd: 500, kind: 'payment' })
  assert.equal(calls[0].url, 'https://oracle.test/tools/risk_check')
  assert.deepEqual(JSON.parse(String(calls[0].init!.body)), { agentId: '849980', txContext: { amountUsd: 500, kind: 'payment' } })
})

test('guard() throws TrustDenyError on a DENY verdict', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'bad', decision: 'DENY', risk: 'high', reasons: ['KYA revoked'] })
  const g = new TrustGuard({ fetch: fn })
  await assert.rejects(() => g.guard('bad'), (e: unknown) => {
    assert.ok(e instanceof TrustDenyError)
    assert.equal(e.verdict.decision, 'DENY')
    assert.deepEqual(e.verdict.reasons, ['KYA revoked'])
    return true
  })
})

test('guard() returns the verdict on ALLOW (no throw)', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'ok', decision: 'ALLOW', risk: 'low', reasons: [] })
  const g = new TrustGuard({ fetch: fn })
  const v = await g.guard('ok')
  assert.equal(v.decision, 'ALLOW')
})

test('guard({ denyOn: [DENY, WARN] }) also blocks a WARN', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'meh', decision: 'WARN', risk: 'medium', reasons: ['thin tenure'] })
  const g = new TrustGuard({ fetch: fn })
  await assert.rejects(() => g.guard('meh', { denyOn: ['DENY', 'WARN'] }), TrustDenyError)
  // ...but the default (DENY only) lets a WARN through.
  assert.equal((await g.guard('meh')).decision, 'WARN')
})

test('a 402 with no payer handler throws PaymentRequiredError', async () => {
  const { fn } = fakeFetch(402, { x402Version: 2, error: 'Payment required' })
  const g = new TrustGuard({ fetch: fn })
  await assert.rejects(() => g.riskCheck('849980'), PaymentRequiredError)
})

test('a 402 is retried with headers from onPaymentRequired, then succeeds', async () => {
  let hit = 0
  const fn = async (_url: string, init?: RequestInit) => {
    hit++
    if (hit === 1) return new Response(JSON.stringify({ error: 'Payment required' }), { status: 402 })
    // second call must carry the payment header the payer returned
    const paid = (init?.headers as Record<string, string>)?.['X-PAYMENT']
    assert.equal(paid, 'signed-voucher')
    return new Response(JSON.stringify({ tool: 'risk_check', agentId: 'x', decision: 'ALLOW', risk: 'low', reasons: [] }), { status: 200 })
  }
  const g = new TrustGuard({ fetch: fn, onPaymentRequired: async () => ({ 'X-PAYMENT': 'signed-voucher' }) })
  const v = await g.riskCheck('x')
  assert.equal(v.decision, 'ALLOW')
  assert.equal(hit, 2)
})

test('the algorand rail calls the site origin and its tool path', async () => {
  const { fn, calls } = fakeFetch(200, { tool: 'risk_check', agentId: '#1', decision: 'WARN', risk: 'medium', reasons: [] })
  const g = new TrustGuard({ rail: 'algorand', fetch: fn })
  await g.riskCheck('#1')
  assert.equal(calls[0].url, 'https://a-identity.xyz/api/x402/algorand/tools/risk_check')
})

test('batchAudit posts the shortlist on Algorand and refuses on the X Layer rail', async () => {
  const { fn, calls } = fakeFetch(200, { tool: 'agent_batch_audit', count: 2, summary: { ALLOW: 1, WARN: 0, DENY: 1 }, results: [] })
  const g = new TrustGuard({ rail: 'algorand', fetch: fn })
  const audit = await g.batchAudit(['#1', '#2'], { amountUsd: 10 })
  assert.equal(audit.summary.DENY, 1)
  assert.equal(calls[0].url, 'https://a-identity.xyz/api/x402/algorand/tools/agent_batch_audit')
  assert.deepEqual(JSON.parse(String(calls[0].init!.body)), { agentIds: ['#1', '#2'], txContext: { amountUsd: 10 } })
  await assert.rejects(() => new TrustGuard({ fetch: fn }).batchAudit(['#1']), /Algorand rail only/)
})

test('a v2 challenge carried only in the PAYMENT-REQUIRED header reaches the payer', async () => {
  const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', amount: '1000' }] }
  let seen: unknown = null
  const fn = async () =>
    new Response('', { status: 402, headers: { 'payment-required': Buffer.from(JSON.stringify(challenge)).toString('base64') } })
  const g = new TrustGuard({ fetch: fn, onPaymentRequired: async (c) => { seen = c; return null } })
  await assert.rejects(() => g.riskCheck('x'), PaymentRequiredError)
  assert.deepEqual(seen, challenge)
})

test('the one-shot guard() helper works against a default client', async () => {
  const { fn } = fakeFetch(200, { tool: 'risk_check', agentId: 'z', decision: 'DENY', risk: 'high', reasons: ['sybil'] })
  await assert.rejects(() => guard('z', { fetch: fn }), TrustDenyError)
})

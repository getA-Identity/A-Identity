import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { recoverTypedDataAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  CELO_PUBLIC_ORIGIN,
  CELO_TOOLS,
  CELO_TOOL_PRICES_USD,
  celoX402Status,
  celoPaywallGate,
  celoChallenge,
  celoChallengeResponse,
  celoFacilitatorRequirements,
  celoPaymentHeader,
  celoPaymentRequired,
  celoToolRequirements,
  celoToolUrl,
  celoServeTool,
  celoScopedAgentId,
  celoProof,
  celoIdentitySummary,
  celoPauseResponse,
  celoSettlementPause,
  celoStatusReport,
  _setCeloSettlementPauseForTests,
  type CeloServeDeps,
  type CeloToolName,
  type CeloX402Status,
} from './celo-x402.js'
import { applyCeloToolCors, CELO_TOOL_CORS, handleCeloRoutes } from './http/celo-routes.js'
import type { RouteCtx } from './http/shared.js'
import { getChainById, requireChain } from './chains/index.js'
import { FORMER_CELO_PAYTO, RETIRED_COMPROMISED, retiredAddresses } from './chains/retired.js'
import { OUR_KEY_PUBLIC_ADDRESSES } from './arc-owner-vault.js'
import type { CeloSettlementRecord } from './storage.js'

/**
 * The Celo rail's honesty contract, pinned:
 *  - fail-closed configuration (no env -> 501, never a free serve),
 *  - the challenge quotes exactly what the registry knows (asset, network, 6-dec units),
 *  - facilitator failures are 502s that neither serve nor resubmit,
 *  - every settled call is recorded for /api/celo/proof,
 *  - prices are byte-identical to the OKX trust suite,
 *  - the registry descriptors assert only what was verified on-chain (and no
 *    ValidationRegistry, because none exists on Celo).
 */

// ── fixtures ──────────────────────────────────────────────────────────────────────

const PAY_TO = '0x' + 'ab'.repeat(20)
const BUYER = '0x' + 'cd'.repeat(20)
const CONFIGURED_ENV = { CELO_PAYTO: PAY_TO, CELO_X402_API_KEY: 'x402_live_testkey' } as NodeJS.ProcessEnv
const SIGNATURE = '0x' + '11'.repeat(65)
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64')
const unb64 = (v: string) => JSON.parse(Buffer.from(v, 'base64').toString('utf8')) as Record<string, any>

/** A PaymentRequired object as the 402 BODY carries it for one release (celoChallenge): each
 *  accepts entry also names its price under the x402 v1 name, equal to amount. */
const withV1Price = (required: Record<string, any>) => ({
  ...required,
  accepts: (required.accepts as Record<string, unknown>[]).map((entry) => ({ ...entry, maxAmountRequired: entry.amount })),
})

const authorizationFor = (status: CeloX402Status, value: string) => ({
  from: BUYER,
  to: status.payTo,
  value,
  validAfter: '0',
  validBefore: '99999999999',
  nonce: '0x' + '22'.repeat(32),
})

/** The earlier flat payment shape this rail asked for until 2026-11-18, still accepted. */
function paymentHeader(status: CeloX402Status, value = '1000'): string {
  return b64({
    x402Version: 2,
    scheme: 'exact',
    network: status.network,
    payload: { signature: SIGNATURE, authorization: authorizationFor(status, value) },
  })
}

/** The same authorization as an x402 v2 PaymentPayload: the offer it pays under `accepted`. */
function v2PaymentHeader(status: CeloX402Status, tool: CeloToolName = 'verify_agent', patch: Record<string, unknown> = {}, top: Record<string, unknown> = {}): string {
  const accepted = { ...celoToolRequirements(tool, status), ...patch }
  return b64({
    x402Version: 2,
    resource: { url: celoToolUrl(tool), description: 'x', mimeType: 'application/json' },
    accepted,
    payload: { signature: SIGNATURE, authorization: authorizationFor(status, String(accepted.amount)) },
    ...top,
  })
}

type FakeResponse = { status: number; json: () => Promise<unknown> }
const jsonRes = (status: number, body: unknown): FakeResponse => ({ status, json: async () => body })

/** A scripted facilitator: answers /verify and /settle from the given results and logs
 *  every call (url, settle headers and the JSON body) so tests can assert exact call counts
 *  and exactly what crossed the facilitator boundary. */
function fakeFacilitator(opts: {
  verify?: FakeResponse | 'throw'
  settle?: FakeResponse | 'throw'
}): { fetchImpl: typeof fetch; calls: string[]; settleHeaders: Record<string, string>[]; bodies: string[] } {
  const calls: string[] = []
  const settleHeaders: Record<string, string>[] = []
  const bodies: string[] = []
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const u = String(url)
    calls.push(u)
    bodies.push(String(init?.body ?? ''))
    if (u.endsWith('/verify')) {
      if (opts.verify === 'throw') throw new Error('facilitator unreachable')
      return opts.verify ?? jsonRes(200, { isValid: true })
    }
    if (u.endsWith('/settle')) {
      settleHeaders.push(init?.headers ?? {})
      if (opts.settle === 'throw') throw new Error('facilitator unreachable')
      return opts.settle ?? jsonRes(200, { settled: true })
    }
    throw new Error(`unexpected facilitator url: ${u}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls, settleHeaders, bodies }
}

/** The headers a request has behind the Vercel rewrite: the backend host, with the site's forwarded. */
const VIA_SITE = { host: 'a-identity-backend.onrender.com', 'x-forwarded-host': 'a-identity.xyz', 'x-forwarded-proto': 'https' }

type RouteAnswer = { handled: boolean; status?: number; headers: Record<string, string>; body?: Record<string, any> }

/** One request through handleCeloRoutes, the route group a buyer codes against, with a real
 *  readable body so readBody runs as it does on the wire. */
async function route(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string; env?: NodeJS.ProcessEnv; serve?: CeloServeDeps } = {},
): Promise<RouteAnswer> {
  const out: RouteAnswer = { handled: false, headers: {} }
  const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const req = Object.assign(Readable.from(opts.body === undefined ? [] : [Buffer.from(opts.body)]), { method, headers })
  const res = {
    setHeader: (k: string, v: unknown) => void (out.headers[k.toLowerCase()] = String(v)),
    writeHead(status: number, h?: Record<string, unknown>) {
      out.status = status
      for (const [k, v] of Object.entries(h ?? {})) out.headers[k.toLowerCase()] = String(v)
      return this
    },
    end: (payload?: string) => {
      if (payload) out.body = JSON.parse(payload) as Record<string, any>
    },
  }
  const ctx: RouteCtx = { req: req as never, res: res as never, url: new URL(`http://localhost${path}`), caller: null, callerId: undefined }
  out.handled = await handleCeloRoutes(ctx, { env: opts.env ?? CONFIGURED_ENV, serve: opts.serve })
  return out
}

// ── prices ────────────────────────────────────────────────────────────────────────

test('the four Celo tools carry exactly the trust-suite prices', () => {
  assert.deepEqual([...CELO_TOOLS], ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport'])
  // The same numbers asp/payment.ts PRICES charges on OKX - one product, two rails.
  assert.deepEqual(CELO_TOOL_PRICES_USD, {
    verify_agent: 0.001,
    reputation_score: 0.002,
    risk_check: 0.005,
    agent_passport: 0.01,
  })
})

// ── fail-closed configuration ─────────────────────────────────────────────────────

test('celoX402Status fails closed with no env: not configured, with the exact missing vars named', () => {
  const s = celoX402Status({} as NodeJS.ProcessEnv)
  assert.equal(s.configured, false)
  assert.equal(s.payTo, null)
  assert.ok(s.reason?.includes('CELO_PAYTO'))
  assert.ok(s.reason?.includes('CELO_X402_API_KEY'))
  // The network still resolves (to mainnet) so the error message can say where it WOULD settle.
  assert.equal(s.network, getChainById('celo')?.caip2)
})

test('celoPaywallGate turns an unconfigured status into a 501, never a free pass', () => {
  const gate = celoPaywallGate(celoX402Status({} as NodeJS.ProcessEnv))
  assert.equal(gate.ok, false)
  if (!gate.ok) {
    assert.equal(gate.httpStatus, 501)
    assert.equal(gate.body.error, 'celo x402 not configured')
    assert.ok(gate.body.reason)
  }
  assert.deepEqual(celoPaywallGate({ configured: true } as CeloX402Status), { ok: true })
})

test('a configured env resolves mainnet from the registry with the mainnet facilitator by default', () => {
  const s = celoX402Status(CONFIGURED_ENV)
  assert.equal(s.configured, true)
  assert.equal(s.payTo, PAY_TO)
  assert.equal(s.chain, 'celo')
  assert.equal(s.network, getChainById('celo')?.caip2)
  assert.equal(s.facilitator, 'https://api.x402.celo.org')
  assert.equal(s.reason, undefined)
})

test('CELO_X402_NETWORK switches to Celo Sepolia and the facilitator default follows the testnet', () => {
  const sepolia = getChainById('celo-sepolia')
  assert.ok(sepolia)
  const s = celoX402Status({ ...CONFIGURED_ENV, CELO_X402_NETWORK: sepolia.caip2 })
  assert.equal(s.configured, true)
  assert.equal(s.chain, 'celo-sepolia')
  assert.equal(s.network, sepolia.caip2)
  // A testnet network must never default to the mainnet facilitator (it could not settle there).
  assert.equal(s.facilitator, 'https://api.x402.sepolia.celo.org')
  // An explicit override wins on either network.
  const o = celoX402Status({ ...CONFIGURED_ENV, CELO_X402_FACILITATOR: 'https://example.test' })
  assert.equal(o.facilitator, 'https://example.test')
})

test('an unknown CELO_X402_NETWORK fails closed instead of guessing a chain', () => {
  const s = celoX402Status({ ...CONFIGURED_ENV, CELO_X402_NETWORK: 'eip155:1' })
  assert.equal(s.configured, false)
  assert.equal(s.chain, null)
  assert.ok(s.reason?.includes('eip155:1'))
})

// ── the 402 challenge ─────────────────────────────────────────────────────────────

test('the 402 challenge quotes the registry asset, payTo, network and exact 6-dec price units', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const celo = getChainById('celo')
  assert.ok(celo)

  const challenge = celoChallenge('verify_agent', status)
  assert.equal(challenge.x402Version, 2)
  assert.equal(challenge.error, 'payment required')
  assert.equal(challenge.accepts.length, 1)
  const req = celoPaymentRequired('verify_agent', status).accepts[0]
  // An x402 v2 accepts entry carries exactly the fields the v2 spec defines, and no v1 name:
  // no maxAmountRequired, and no per-entry resource, description or mimeType.
  assert.deepEqual(Object.keys(req), ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'])
  // For one release the BODY's entry also names the price under the v1 name, equal to amount: a
  // /check/celo tab loaded before the v2 change reads it there. The header stays the pure v2 object.
  assert.deepEqual(challenge.accepts[0], { ...req, maxAmountRequired: req.amount })
  assert.equal(req.scheme, 'exact')
  assert.equal(req.network, celo.caip2)
  assert.equal(req.asset, celo.contracts.usdc)
  assert.equal(req.payTo, PAY_TO)
  assert.equal(req.amount, '1000') // $0.001 at the registry's 6 USDC decimals, in atomic units
  assert.equal(req.maxTimeoutSeconds, 600)
  // The EIP-712 domain a buyer signs with (read live from the USDC contract).
  assert.deepEqual(req.extra, { name: 'USDC', version: '2' })
  // v2 hoists the resource into one object, and its url is ABSOLUTE: the site's own origin when
  // the caller names none, the origin the request reached when the route passes one.
  assert.deepEqual(challenge.resource, {
    url: 'https://a-identity.xyz/api/celo/tools/verify_agent',
    description: 'Verify an AI agent: ERC-8004 identity + KYA status + endpoint liveness. Settled in USDC on Celo via the Celo x402 facilitator.',
    mimeType: 'application/json',
  })
  assert.equal(CELO_PUBLIC_ORIGIN, 'https://a-identity.xyz')
  assert.equal(celoToolUrl('risk_check', 'https://a-identity-backend.onrender.com'), 'https://a-identity-backend.onrender.com/api/celo/tools/risk_check')
  assert.equal(celoToolUrl('risk_check', 'http://localhost:3399'), 'http://localhost:3399/api/celo/tools/risk_check')
  for (const junk of ['', 'not a url', 'javascript:alert(1)', 'ftp://a-identity.xyz']) {
    assert.equal(celoToolUrl('risk_check', junk), 'https://a-identity.xyz/api/celo/tools/risk_check', `origin ${JSON.stringify(junk)}`)
  }
  // The tool card rides along so a probing client sees the calling contract pre-payment.
  assert.equal(challenge.tool.name, 'verify_agent')
  assert.equal(challenge.tool.priceUsd, 0.001)
  assert.match(challenge.tool.payment, /header PAYMENT-SIGNATURE/)
  assert.match(challenge.tool.payment, /X-PAYMENT is still accepted/)

  // Every price converts at 6 decimals, per tool.
  assert.equal(celoToolRequirements('reputation_score', status).amount, '2000')
  assert.equal(celoToolRequirements('risk_check', status).amount, '5000')
  assert.equal(celoToolRequirements('agent_passport', status).amount, '10000')

  // The facilitator leg did not move: the requirements it verifies against are field for field,
  // in order, the v1 object this rail always sent it (slug network, maxAmountRequired, relative resource).
  const v1 = celoFacilitatorRequirements('verify_agent', status)
  assert.equal(JSON.stringify(v1), JSON.stringify({
    scheme: 'exact',
    network: 'celo',
    asset: celo.contracts.usdc,
    payTo: PAY_TO,
    maxAmountRequired: '1000',
    resource: '/api/celo/tools/verify_agent',
    description: 'Verify an AI agent: ERC-8004 identity + KYA status + endpoint liveness. Settled in USDC on Celo via the Celo x402 facilitator.',
    mimeType: 'application/json',
    maxTimeoutSeconds: 600,
    extra: { name: 'USDC', version: '2' },
  }))

  // The header carries the PaymentRequired object alone; the body is that object plus the tool card
  // (and, for one release, the v1 price name in each entry).
  const sent = celoChallengeResponse('verify_agent', status, { origin: 'https://a-identity.xyz' })
  assert.equal(sent.httpStatus, 402)
  const fromHeader = unb64(sent.headers['PAYMENT-REQUIRED'])
  assert.deepEqual(fromHeader, celoPaymentRequired('verify_agent', status, { origin: 'https://a-identity.xyz' }))
  assert.deepEqual(Object.keys(fromHeader), ['x402Version', 'error', 'resource', 'accepts'])
  assert.deepEqual(Object.keys(fromHeader.accepts[0]), Object.keys(req), 'the header entry has no v1 name')
  const { tool: card, ...rest } = sent.body
  assert.deepEqual(rest, withV1Price(fromHeader))
  assert.equal(card.name, 'verify_agent')

  // The oracle is the reference implementation, not our reading of the spec: @x402/core decodes the
  // header, its v2 schema accepts it, and its HTTP client reads the challenge from the header.
  const { decodePaymentRequiredHeader } = await import('@x402/core/http')
  const { parsePaymentRequired } = await import('@x402/core/schemas')
  const { x402HTTPClient } = await import('@x402/core/client')
  const decoded = decodePaymentRequiredHeader(sent.headers['PAYMENT-REQUIRED'])
  const parsed = parsePaymentRequired(decoded)
  assert.ok(parsed.success, `the reference schema rejects the challenge: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`)
  assert.equal(parsed.data.x402Version, 2)
  const read = (x402HTTPClient.prototype as unknown as {
    getPaymentRequiredResponse: (g: (k: string) => string | undefined, b: unknown) => { x402Version: number; accepts: { amount: string }[] }
  }).getPaymentRequiredResponse.call({}, (k) => (k.toUpperCase() === 'PAYMENT-REQUIRED' ? sent.headers['PAYMENT-REQUIRED'] : undefined), sent.body)
  assert.equal(read.x402Version, 2)
  assert.equal(read.accepts[0].amount, '1000')

  // Over the route: no payment means the 402, on GET and on POST, whatever the body. A probe that
  // sends nothing, malformed JSON or no agentId learns the price; it used to get 400 "agentId required".
  const fac = fakeFacilitator({})
  const serve = { fetchImpl: fac.fetchImpl, persist: async () => {}, handlers: { risk_check: async () => ({}) } }
  for (const probe of [
    { method: 'GET', body: undefined },
    { method: 'POST', body: undefined },
    { method: 'POST', body: '' },
    { method: 'POST', body: '{}' },
    { method: 'POST', body: '{"agentId":""}' },
    { method: 'POST', body: 'not json' },
    { method: 'POST', body: '{"agentId":"#9759"}' },
  ]) {
    const r = await route(probe.method, '/api/celo/tools/risk_check', { headers: { ...VIA_SITE, 'content-type': 'application/json' }, body: probe.body, serve })
    const label = `${probe.method} ${JSON.stringify(probe.body ?? null)}`
    assert.equal(r.handled, true, label)
    assert.equal(r.status, 402, label)
    assert.ok(r.headers['payment-required'], `${label} carries PAYMENT-REQUIRED`)
    const pr = unb64(r.headers['payment-required'])
    assert.equal(pr.x402Version, 2, label)
    assert.equal(pr.resource.url, 'https://a-identity.xyz/api/celo/tools/risk_check', `${label}: the absolute URL the request reached, through the site`)
    assert.equal(pr.accepts[0].amount, '5000', label)
    assert.equal(pr.accepts[0].maxAmountRequired, undefined, `${label}: the header entry is pure v2`)
    assert.deepEqual(r.body, { ...withV1Price(pr), tool: r.body!.tool }, `${label}: the body is the same PaymentRequired object (with the transitional v1 price name) plus the tool card`)
  }
  // Straight to the backend host, the URL names that host.
  const direct = await route('GET', '/api/celo/tools/risk_check', { headers: { host: 'a-identity-backend.onrender.com', 'x-forwarded-proto': 'https' } })
  assert.equal(unb64(direct.headers['payment-required']).resource.url, 'https://a-identity-backend.onrender.com/api/celo/tools/risk_check')
  // A GET only quotes: a payment sent on one is refused unused, and the 402 says how to send it.
  const paidGet = await route('GET', '/api/celo/tools/risk_check', { headers: { 'payment-signature': v2PaymentHeader(status, 'risk_check') }, serve })
  assert.equal(paidGet.status, 402)
  assert.match(paidGet.body!.verifyError, /a GET only quotes the price/)
  assert.equal(unb64(paidGet.headers['payment-required']).error, paidGet.body!.verifyError)
  assert.deepEqual(fac.calls, [], 'no probe reached the facilitator')
  // Not a price: unconfigured, unknown tool and paused rails carry no PAYMENT-REQUIRED.
  const off = await route('POST', '/api/celo/tools/risk_check', { env: {} as NodeJS.ProcessEnv })
  assert.equal(off.status, 501)
  assert.equal(off.headers['payment-required'], undefined)
  const unknown = await route('GET', '/api/celo/tools/nope')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.headers['payment-required'], undefined)

  // CORS: the Celo paid tool routes, and their preflight, answer any origin with no credentials,
  // allow the payment headers and expose the challenge and receipt; every other path keeps the
  // allowlist http.ts sets (this stands in for it: an echoed origin with credentials).
  const corsFor = (path: string) => {
    const h: Record<string, string> = {
      'access-control-allow-origin': 'https://a-identity.xyz',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'Content-Type, Authorization, X-Payment, X-Payment-Nonce, X-Payment-Payer, X-Payment-Sig, PAYMENT-SIGNATURE, mcp-session-id, mcp-protocol-version, X-Client-Name, X-Client-Version',
      'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE',
    }
    const applied = applyCeloToolCors(path, {
      setHeader: (k: string, v: unknown) => { h[k.toLowerCase()] = String(v); return undefined as never },
      removeHeader: (k: string) => { delete h[k.toLowerCase()] },
    })
    return { applied, h }
  }
  // What a browser checks before a stock client's paid retry leaves it: every request header that
  // is not CORS-safelisted must be named in Access-Control-Allow-Headers, or the preflight fails and
  // the POST is never sent. That retry carries the buyer's Content-Type (application/json is not
  // safelisted), the payment header @x402/core names for the payload's version, and
  // Access-Control-Expose-Headers, which @x402/fetch (read at 2.18.0 and 2.29.0) and @x402/axios set
  // on it as a REQUEST header. The headers are built here the way @x402/fetch builds them.
  const { x402Client } = await import('@x402/core/client')
  const encoder = new x402HTTPClient(new x402Client())
  const paidRetries = [2, 1].map((x402Version) => {
    const h = new Headers({ 'Content-Type': 'application/json' })
    for (const [name, value] of Object.entries(encoder.encodePaymentSignatureHeader({ x402Version } as never))) h.set(name, value)
    h.set('Access-Control-Expose-Headers', 'PAYMENT-RESPONSE,X-PAYMENT-RESPONSE')
    return h
  })
  assert.deepEqual(paidRetries.map((h) => [...h.keys()]), [
    ['access-control-expose-headers', 'content-type', 'payment-signature'],
    ['access-control-expose-headers', 'content-type', 'x-payment'],
  ], 'the request headers of a stock paid retry, v2 and v1')
  /** The request headers a preflight answer with this Access-Control-Allow-Headers does not allow. */
  const blockedByPreflight = (allowHeaders: string, request: Headers) => {
    const allowed = new Set(allowHeaders.split(',').map((s) => s.trim().toLowerCase()))
    return [...request.keys()].filter((name) => !allowed.has(name))
  }
  for (const tool of CELO_TOOLS) {
    const { applied, h } = corsFor(`/api/celo/tools/${tool}`)
    assert.equal(applied, true, tool)
    assert.equal(h['access-control-allow-origin'], '*', tool)
    assert.equal(h['access-control-allow-credentials'], undefined, `${tool}: '*' never goes with credentials`)
    assert.equal(h['access-control-allow-headers'], 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers', tool)
    assert.equal(h['access-control-expose-headers'], 'PAYMENT-REQUIRED, PAYMENT-RESPONSE', tool)
    for (const request of paidRetries) {
      assert.deepEqual(blockedByPreflight(h['access-control-allow-headers'], request), [], `${tool}: the preflight allows every header of a stock paid retry`)
    }
    // The two payment headers these routes send are both readable cross-origin.
    const exposed = h['access-control-expose-headers'].split(',').map((s) => s.trim())
    for (const name of ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE']) assert.ok(exposed.includes(name), `${tool} exposes ${name}`)
  }
  assert.deepEqual(CELO_TOOL_CORS, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, PAYMENT-SIGNATURE, X-PAYMENT, Access-Control-Expose-Headers',
    'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
  })
  for (const other of ['/api/celo/status', '/api/celo/proof', '/api/celo/tools/', '/api/celo/tools/risk_check/x', '/api/x402/tools/risk_check', '/api/x402/gateway/tools/risk_check', '/api/agents', '/mcp', '/']) {
    const { applied, h } = corsFor(other)
    assert.equal(applied, false, other)
    assert.equal(h['access-control-allow-origin'], 'https://a-identity.xyz', `${other} keeps the allowlist`)
    assert.equal(h['access-control-allow-credentials'], 'true', other)
  }
  // http.ts boots a server on import, so its wiring is read as text: the override runs after the
  // global headers and before the OPTIONS answer, so the preflight gets it too, on the raw path.
  const http = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8')
  const globalOrigin = http.indexOf("res.setHeader('Access-Control-Allow-Origin', corsOrigin)")
  const override = http.indexOf("applyCeloToolCors((req.url ?? '/').split('?')[0], res)")
  const preflight = http.indexOf("if (req.method === 'OPTIONS')")
  assert.ok(globalOrigin > 0 && override > globalOrigin && preflight > override, 'the Celo CORS override sits between the global headers and the preflight answer')
})

// ── verify -> settle -> serve -> record ──────────────────────────────────────────────

test('a settled facilitator flow serves the tool and durably records the settlement', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({
    verify: jsonRes(200, { isValid: true }),
    settle: jsonRes(200, { settled: true, credits: 7 }),
  })
  const persisted: CeloSettlementRecord[] = []
  const out = await celoServeTool('verify_agent', { agentId: '#1' }, paymentHeader(status), status, {
    fetchImpl: fac.fetchImpl,
    persist: async (r) => { persisted.push(r) },
    handlers: { verify_agent: async (i) => ({ served: i.agentId }) },
    env: CONFIGURED_ENV,
    now: () => new Date('2026-08-09T00:00:00.000Z'),
  })
  assert.equal(out.httpStatus, 200)
  const body = out.body as { paid: boolean; settlement: { facilitatorCredits: number; payer: string }; result: { served: string; _meta: Record<string, string> } }
  assert.equal(body.paid, true)
  // A bare id on this rail is Celo's: the tool is asked about the rail chain's CAIP-10 id, never
  // about whichever chain's #1 the shared resolver would match first.
  assert.equal(body.result.served, `${status.network}:8004/1`)
  // The labels name the chain that was read and the one the payment settled on. Neither is the
  // X Layer line the ASP meta carries.
  assert.equal(body.result._meta.network, `Celo (${status.network})`)
  assert.equal(body.result._meta.homeRegistryNetwork, `Celo mainnet (${status.network})`)
  assert.ok(body.result._meta.scope.includes(`resolved against Celo mainnet (${status.network})`))
  assert.doesNotMatch(JSON.stringify(body.result._meta), /X Layer|eip155:196/)
  assert.equal(body.settlement.facilitatorCredits, 7)
  assert.equal(body.settlement.payer, BUYER)
  // The durable record is exactly what /api/celo/proof aggregates.
  assert.deepEqual(persisted, [{
    ts: '2026-08-09T00:00:00.000Z',
    tool: 'verify_agent',
    amountUsd: 0.001,
    payer: BUYER,
    network: status.network,
    facilitatorCredits: 7,
  }])
  // The settle call authenticated with OUR facilitator key.
  assert.equal(fac.settleHeaders[0]['X-API-Key'], 'x402_live_testkey')
  // This settle answer named no hash. A v2 receipt with an empty `transaction` would say no
  // transaction was broadcast, which a settled EIP-3009 payment never is, so there is none: the
  // body's settlement says it settled and who confirmed it.
  assert.equal(out.headers?.['PAYMENT-RESPONSE'], undefined, 'no receipt that contradicts the settlement')
  const { settlement } = out.body as { settlement: { settled: boolean; confirmedBy: string; tx?: string } }
  assert.equal(settlement.settled, true)
  assert.equal(settlement.confirmedBy, 'facilitator')
  assert.equal(settlement.tx, undefined)
  // With the hash, the receipt rides in PAYMENT-RESPONSE, readable by the reference decoder; a
  // "hash" that is not 32 bytes of hex is no hash, and gets no receipt either.
  const { decodePaymentResponseHeader } = await import('@x402/core/http')
  const withTx = async (transaction: string) =>
    (await celoServeTool('verify_agent', { agentId: '#1' }, paymentHeader(status), status, {
      fetchImpl: fakeFacilitator({ settle: jsonRes(200, { success: true, transaction }) }).fetchImpl,
      persist: async () => {},
      handlers: { verify_agent: async () => ({}) },
      env: CONFIGURED_ENV,
    })).headers?.['PAYMENT-RESPONSE']
  const hashed = await withTx('0x' + 'ef'.repeat(32))
  assert.ok(hashed)
  assert.deepEqual(decodePaymentResponseHeader(hashed), {
    success: true,
    transaction: '0x' + 'ef'.repeat(32),
    network: status.network,
    payer: BUYER,
    amount: '1000',
  })
  assert.equal(await withTx('0x'), undefined)
  assert.equal(await withTx('0x' + 'ef'.repeat(31)), undefined)

  // The facilitator leg is exactly what it was: the earlier flat payment and an x402 v2 payment
  // carrying the same signature cross the boundary as the same bytes, the v1 body with the slug.
  const bodiesFor = async (header: string) => {
    const f = fakeFacilitator({ settle: jsonRes(200, { success: true, transaction: '0x' + 'ef'.repeat(32) }) })
    const r = await celoServeTool('verify_agent', { agentId: '#1' }, header, status, { fetchImpl: f.fetchImpl, persist: async () => {}, handlers: { verify_agent: async () => ({}) }, env: CONFIGURED_ENV })
    assert.equal(r.httpStatus, 200)
    return f.bodies
  }
  const flat = await bodiesFor(paymentHeader(status))
  const v2 = await bodiesFor(v2PaymentHeader(status))
  assert.deepEqual(v2, flat, 'a v2 payment reaches /verify and /settle as the same bytes as the earlier shape')
  assert.equal(flat.length, 2)
  assert.equal(flat[0], flat[1], '/verify and /settle get the same body')
  assert.equal(flat[0], JSON.stringify({
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: 'exact', network: 'celo', payload: { signature: SIGNATURE, authorization: authorizationFor(status, '1000') } },
    paymentRequirements: celoFacilitatorRequirements('verify_agent', status),
  }))

  // Through the route, under either header name and in either shape, a paid POST settles once and
  // answers 200 with PAYMENT-RESPONSE naming the transaction.
  const TX = '0x' + 'ef'.repeat(32)
  for (const [name, header] of [
    ['PAYMENT-SIGNATURE', v2PaymentHeader(status)],
    ['X-PAYMENT', paymentHeader(status)],
    ['X-PAYMENT', v2PaymentHeader(status)],
    ['PAYMENT-SIGNATURE', paymentHeader(status)],
  ] as const) {
    const f = fakeFacilitator({ settle: jsonRes(200, { success: true, transaction: TX }) })
    const r = await route('POST', '/api/celo/tools/verify_agent', {
      headers: { [name]: header, 'content-type': 'application/json', ...VIA_SITE },
      body: '{"agentId":"#1"}',
      serve: { fetchImpl: f.fetchImpl, persist: async () => {}, handlers: { verify_agent: async () => ({ ok: true }) } },
    })
    assert.equal(r.status, 200, name)
    assert.equal(r.body!.paid, true, name)
    assert.deepEqual(f.calls.map((u) => u.slice(u.lastIndexOf('/'))), ['/verify', '/settle'], name)
    assert.deepEqual(unb64(r.headers['payment-response']), { success: true, transaction: TX, network: status.network, payer: BUYER, amount: '1000' }, name)
    assert.equal(r.headers['payment-required'], undefined, `${name}: a paid answer is not a price`)
  }

  // A stock x402 v2 client pays it: @x402/core's HTTP client reads our 402 from PAYMENT-REQUIRED,
  // @x402/evm signs the EIP-3009 authorization, and the PAYMENT-SIGNATURE it builds settles. The
  // signature recovers to the buyer against the domain the facilitator is handed.
  const { x402Client, x402HTTPClient } = await import('@x402/core/client')
  const { registerExactEvmScheme } = await import('@x402/evm/exact/client')
  const buyer = privateKeyToAccount(generatePrivateKey())
  const stock = new x402HTTPClient(registerExactEvmScheme(new x402Client(), { signer: buyer }))
  const quote = await route('POST', '/api/celo/tools/risk_check', { headers: { ...VIA_SITE, 'content-type': 'application/json' }, body: '{"agentId":"#9759"}' })
  assert.equal(quote.status, 402)
  const required = stock.getPaymentRequiredResponse((k) => quote.headers[k.toLowerCase()], quote.body)
  const signed = await stock.createPaymentPayload(required)
  const stockHeaders = stock.encodePaymentSignatureHeader(signed) as Record<string, string>
  assert.deepEqual(Object.keys(stockHeaders), ['PAYMENT-SIGNATURE'])
  const sf = fakeFacilitator({ settle: jsonRes(200, { success: true, transaction: TX }) })
  const paid = await route('POST', '/api/celo/tools/risk_check', {
    headers: { ...stockHeaders, ...VIA_SITE, 'content-type': 'application/json' },
    body: '{"agentId":"#9759"}',
    serve: { fetchImpl: sf.fetchImpl, persist: async () => {}, handlers: { risk_check: async () => ({ decision: 'WARN' }) } },
  })
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  const sent = JSON.parse(sf.bodies[0]) as { paymentPayload: { x402Version: number; scheme: string; network: string; payload: { signature: `0x${string}`; authorization: Record<string, string> } }; paymentRequirements: Record<string, any> }
  assert.deepEqual(sent.paymentPayload, { x402Version: 1, scheme: 'exact', network: 'celo', payload: (signed as { payload: unknown }).payload })
  assert.deepEqual(sent.paymentRequirements, celoFacilitatorRequirements('risk_check', status))
  const auth = sent.paymentPayload.payload.authorization
  const signer = await recoverTypedDataAddress({
    domain: { name: sent.paymentRequirements.extra.name, version: sent.paymentRequirements.extra.version, chainId: requireChain(status.network).evmChainId as number, verifyingContract: sent.paymentRequirements.asset as `0x${string}` },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: { from: auth.from as `0x${string}`, to: auth.to as `0x${string}`, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as `0x${string}` },
    signature: sent.paymentPayload.payload.signature,
  })
  assert.equal(signer, buyer.address)
  assert.equal(auth.to.toLowerCase(), PAY_TO)
  assert.equal(auth.value, '5000')
  const settled = stock.getPaymentSettleResponse((k) => paid.headers[k.toLowerCase()])
  assert.equal(settled.success, true)
  assert.equal(settled.transaction, TX)

  // Every other form reaches the tool as sent, and the label names the chain that id names, or the
  // chain of the identity the tool returned, or says that the answer does not name one.
  assert.equal(celoScopedAgentId(' 09759 ', requireChain(status.network)), `${status.network}:8004/9759`)
  const arcMainnet = getChainById('arc-mainnet')
  assert.ok(arcMainnet)
  for (const c of [
    { agentId: `${arcMainnet.caip2}:8004/1`, identity: null, label: `Arc Mainnet (${arcMainnet.caip2})` },
    { agentId: 'eip155:1:8004/1', identity: null, label: 'eip155:1, a chain our registry does not know, so no registry was read for it' },
    { agentId: BUYER, identity: { chain: 'arc-mainnet' }, label: `Arc Mainnet (${arcMainnet.caip2})` },
    { agentId: BUYER, identity: null, label: 'every registry our resolver reads (this answer does not name the one that matched)' },
  ]) {
    const again = await celoServeTool('verify_agent', { agentId: c.agentId }, paymentHeader(status), status, {
      fetchImpl: fakeFacilitator({}).fetchImpl,
      persist: async () => {},
      handlers: { verify_agent: async (i) => ({ served: i.agentId, identity: c.identity }) },
      env: CONFIGURED_ENV,
    })
    const result = (again.body as { result: { served: string; _meta: Record<string, string> } }).result
    assert.equal(result.served, c.agentId, `${c.agentId} is passed as sent`)
    assert.equal(result._meta.homeRegistryNetwork, c.label, c.agentId)
  }
})

test('a facilitator outage is a 502 that neither serves the tool nor records anything', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({ verify: 'throw' })
  const persisted: CeloSettlementRecord[] = []
  let handlerRan = false
  const out = await celoServeTool('risk_check', { agentId: '#1' }, paymentHeader(status), status, {
    fetchImpl: fac.fetchImpl,
    persist: async (r) => { persisted.push(r) },
    handlers: { risk_check: async () => { handlerRan = true; return {} } },
    env: CONFIGURED_ENV,
  })
  assert.equal(out.httpStatus, 502)
  assert.equal((out.body as { error: string }).error, 'celo facilitator verify failed')
  assert.equal(handlerRan, false, 'a failed payment must never serve the tool')
  assert.deepEqual(persisted, [])
})

test('an invalid payment re-challenges with 402 and the facilitator reason, and records nothing', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({ verify: jsonRes(200, { isValid: false, invalidReason: 'authorization expired' }) })
  const persisted: CeloSettlementRecord[] = []
  const out = await celoServeTool('agent_passport', { agentId: '#1' }, paymentHeader(status), status, {
    fetchImpl: fac.fetchImpl,
    persist: async (r) => { persisted.push(r) },
    handlers: { agent_passport: async () => ({}) },
    env: CONFIGURED_ENV,
  })
  assert.equal(out.httpStatus, 402)
  const body = out.body as { verifyError: string; accepts: unknown[]; error: string }
  assert.ok(body.verifyError.includes('authorization expired'))
  assert.equal(body.accepts.length, 1, 'the 402 must carry a fresh challenge so the client can pay correctly')
  // The fresh challenge travels in PAYMENT-REQUIRED too, with the facilitator's reason as its error,
  // the way a reference x402 server answers a payment that failed verification.
  assert.equal(body.error, 'authorization expired')
  assert.equal(unb64(out.headers!['PAYMENT-REQUIRED']).error, 'authorization expired')
  assert.equal(out.headers!['PAYMENT-RESPONSE'], undefined, 'nothing settled, so there is no receipt')
  assert.deepEqual(persisted, [])
  assert.equal(fac.calls.length, 1, 'an invalid payment must never reach /settle')

  // The live facilitator refuses with HTTP 400 and a verdict (read 2026-11-18). That is still the
  // buyer's payment to fix, so a 402 with the reason; a 400 without a refusal verdict, a 5xx, or a
  // contradictory answer stays a facilitator failure (502), and none of them reaches /settle.
  const recorded: CeloSettlementRecord[] = []
  for (const [answer, want] of [
    [jsonRes(400, { isValid: false, invalidReason: 'insufficient_funds' }), 402],
    [jsonRes(400, { isValid: false, invalidReason: 'recipient_mismatch' }), 402],
    [jsonRes(400, { error: 'bad request' }), 502],
    [jsonRes(400, { isValid: true }), 502],
    [jsonRes(500, { isValid: false, invalidReason: 'insufficient_funds' }), 502],
  ] as const) {
    const f = fakeFacilitator({ verify: answer })
    const r = await celoServeTool('agent_passport', { agentId: '#1' }, v2PaymentHeader(status, 'agent_passport'), status, {
      fetchImpl: f.fetchImpl,
      persist: async (rec) => { recorded.push(rec) },
      handlers: { agent_passport: async () => ({}) },
      env: CONFIGURED_ENV,
    })
    const said = JSON.stringify(await answer.json())
    assert.equal(r.httpStatus, want, said)
    if (want === 402) {
      assert.equal((r.body as { verifyError: string }).verifyError, (await answer.json() as { invalidReason: string }).invalidReason, said)
      assert.ok(r.headers?.['PAYMENT-REQUIRED'], said)
    } else {
      assert.equal((r.body as { error: string }).error, 'celo facilitator verify failed', said)
    }
    assert.deepEqual(f.calls.map((u) => u.slice(u.lastIndexOf('/'))), ['/verify'], `${said}: never settled`)
  }
  assert.deepEqual(recorded, [])
})

test('a settle refusal is a 502 with no resubmission: exactly one verify and one settle call', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({
    verify: jsonRes(200, { isValid: true }),
    settle: jsonRes(500, { error: 'settlement rejected' }),
  })
  const persisted: CeloSettlementRecord[] = []
  let handlerRan = false
  const out = await celoServeTool('reputation_score', { agentId: '#1' }, paymentHeader(status), status, {
    fetchImpl: fac.fetchImpl,
    persist: async (r) => { persisted.push(r) },
    handlers: { reputation_score: async () => { handlerRan = true; return {} } },
    env: CONFIGURED_ENV,
    // The chain is not read in this test: what a read adds is pinned further down.
    authorizationUsed: async () => null,
  })
  assert.equal(out.httpStatus, 502)
  assert.ok((out.body as { reason: string }).reason.includes('settlement rejected'))
  assert.equal(handlerRan, false)
  assert.deepEqual(persisted, [])
  // Ambiguous-or-failed settle is NEVER retried from our side (a resubmit could double-settle).
  assert.deepEqual(fac.calls.map((u) => u.slice(u.lastIndexOf('/'))), ['/verify', '/settle'])
})

test('a malformed payment header re-challenges with 402 before any facilitator call', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({})
  const out = await celoServeTool('verify_agent', { agentId: '#1' }, '%%%not-a-payload%%%', status, {
    fetchImpl: fac.fetchImpl,
    persist: async () => {},
    handlers: { verify_agent: async () => ({}) },
    env: CONFIGURED_ENV,
  })
  assert.equal(out.httpStatus, 402)
  assert.ok((out.body as { verifyError: string }).verifyError.includes('malformed payment header (PAYMENT-SIGNATURE or X-PAYMENT)'))
  // A refusal is a fresh v2 challenge in both transports, naming why in `error`.
  const refused = unb64(out.headers!['PAYMENT-REQUIRED'])
  assert.equal(refused.x402Version, 2)
  assert.equal(refused.error, (out.body as { verifyError: string }).verifyError)
  assert.deepEqual(fac.calls, [], 'garbage input must not consume a facilitator round-trip')

  // The payment is read from PAYMENT-SIGNATURE, the v2 name, and still from X-PAYMENT; the v2 name
  // wins when both are sent, and a blank one is no payment.
  assert.equal(celoPaymentHeader({ 'payment-signature': ' abc ' }), 'abc')
  assert.equal(celoPaymentHeader({ 'x-payment': 'def' }), 'def')
  assert.equal(celoPaymentHeader({ 'payment-signature': 'abc', 'x-payment': 'def' }), 'abc')
  assert.equal(celoPaymentHeader({ 'payment-signature': '  ', 'x-payment': 'def' }), 'def')
  assert.equal(celoPaymentHeader({ 'payment-signature': ['xyz', 'other'] }), 'xyz')
  assert.equal(celoPaymentHeader({}), '')

  // A payment with a body that cannot be answered is 400 and is never verified or settled: an
  // invalid request is never charged, under either header name.
  const serve = { fetchImpl: fac.fetchImpl, persist: async () => { throw new Error('nothing may be recorded') }, handlers: { verify_agent: async () => ({}) } }
  for (const name of ['PAYMENT-SIGNATURE', 'X-PAYMENT']) {
    for (const body of [undefined, '', '{}', '{"agentId":"  "}', '{"agentId":42}', 'not json']) {
      const r = await route('POST', '/api/celo/tools/verify_agent', { headers: { [name]: v2PaymentHeader(status), 'content-type': 'application/json' }, body, serve })
      const label = `${name} with body ${JSON.stringify(body ?? null)}`
      assert.equal(r.status, 400, label)
      assert.equal(r.body!.charged, false, label)
      assert.match(r.body!.note, /before the payment was verified or settled, so nothing was charged/, label)
      assert.equal(r.headers['payment-required'], undefined, `${label}: a 400 is not a price`)
    }
  }
  assert.deepEqual(fac.calls, [], 'no invalid request reached the facilitator')

  // A v2 payment names the offer it signed for under `accepted`, and an offer that is not this
  // resource's is refused by field, before the facilitator is asked anything.
  for (const [patch, field] of [
    [{ scheme: 'upto' }, 'scheme'],
    [{ network: 'eip155:8453' }, 'network'],
    [{ amount: '1' }, 'amount'],
    [{ asset: '0x' + '99'.repeat(20) }, 'asset'],
    [{ payTo: '0x' + '98'.repeat(20) }, 'payTo'],
    [{ maxTimeoutSeconds: 86_400 }, 'maxTimeoutSeconds'],
  ] as const) {
    const r = await celoServeTool('verify_agent', { agentId: '#1' }, v2PaymentHeader(status, 'verify_agent', patch), status, { fetchImpl: fac.fetchImpl, env: CONFIGURED_ENV })
    assert.equal(r.httpStatus, 402, field)
    assert.match((r.body as { verifyError: string }).verifyError, new RegExp(`^accepted\\.${field} is `), field)
    assert.ok(r.headers?.['PAYMENT-REQUIRED'], field)
  }
  for (const [top, why] of [
    [{ x402Version: 1 }, /is x402 v2, and this one says x402Version 1/],
    [{ accepted: null }, /accepted must be the accepts entry/],
    [{ accepted: [] }, /accepted must be the accepts entry/],
  ] as const) {
    const r = await celoServeTool('verify_agent', { agentId: '#1' }, v2PaymentHeader(status, 'verify_agent', {}, top), status, { fetchImpl: fac.fetchImpl, env: CONFIGURED_ENV })
    assert.equal(r.httpStatus, 402)
    assert.match((r.body as { verifyError: string }).verifyError, why)
  }
  // Addresses are compared in any case, the way a checksumming client sends them.
  const checksummed = await celoServeTool('verify_agent', { agentId: '#1' }, v2PaymentHeader(status, 'verify_agent', { payTo: PAY_TO.toUpperCase().replace('0X', '0x') }), status, {
    fetchImpl: fakeFacilitator({}).fetchImpl,
    persist: async () => {},
    handlers: { verify_agent: async () => ({}) },
    env: CONFIGURED_ENV,
  })
  assert.equal(checksummed.httpStatus, 200)
  // An offer copied from the 402 body, the transitional v1 price name included, is the same offer.
  const fromBody = await celoServeTool('verify_agent', { agentId: '#1' }, v2PaymentHeader(status, 'verify_agent', celoChallenge('verify_agent', status).accepts[0]), status, {
    fetchImpl: fakeFacilitator({}).fetchImpl,
    persist: async () => {},
    handlers: { verify_agent: async () => ({}) },
    env: CONFIGURED_ENV,
  })
  assert.equal(fromBody.httpStatus, 200)
  assert.deepEqual(fac.calls, [], 'a mismatched offer never reached the facilitator')
})

test('a handler failure after settlement is a 500 that still records the settlement', async () => {
  // The money moved; pretending otherwise would make the proof log lie. The buyer gets
  // the settlement receipt and an honest error instead of a silent free retry.
  const status = celoX402Status(CONFIGURED_ENV)
  const TX = '0x' + 'cb'.repeat(32)
  const fac = fakeFacilitator({
    verify: jsonRes(200, { isValid: true }),
    settle: jsonRes(200, { settled: true, credits: 1, transaction: TX }),
  })
  const persisted: CeloSettlementRecord[] = []
  const out = await celoServeTool('verify_agent', { agentId: '#1' }, paymentHeader(status), status, {
    fetchImpl: fac.fetchImpl,
    persist: async (r) => { persisted.push(r) },
    handlers: { verify_agent: async () => { throw new Error('boom') } },
    env: CONFIGURED_ENV,
  })
  assert.equal(out.httpStatus, 500)
  const body = out.body as { error: string; settlement: { settled: boolean } }
  assert.equal(body.error, 'tool execution failed after settlement')
  assert.equal(body.settlement.settled, true)
  assert.equal(persisted.length, 1, 'the settlement happened and must be on the record')
  // The payment settled, so the receipt header says so even though the tool failed, with its hash.
  assert.deepEqual(unb64(out.headers!['PAYMENT-RESPONSE']), { success: true, transaction: TX, network: status.network, payer: BUYER, amount: '1000' })
})

// ── the proof document ────────────────────────────────────────────────────────────

test('celoProof aggregates the injected store honestly, zeros included', async () => {
  const empty = await celoProof({} as NodeJS.ProcessEnv, async () => [])
  assert.equal(empty.configured, false)
  // Settlements recorded before the 2026-11-11 switch stay attributed to the address they were paid to,
  // and the note says it is retired and not A-Identity's.
  assert.deepEqual(empty.previousPayTo.map((p) => [p.address, p.until]), [[FORMER_CELO_PAYTO.address, '2026-11-11T01:04:32Z']])
  assert.match(empty.previousPayTo[0].note ?? '', /retired that day: someone else holds its key and it is not A-Identity's\. Do not pay it\./)
  assert.equal(empty.totalSettlements, 0)
  assert.equal(empty.totalUsd, 0)
  assert.deepEqual(empty.byTool, {})
  assert.deepEqual(empty.recent, [])

  const records: CeloSettlementRecord[] = [
    { ts: '2026-08-09T00:00:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220' },
    { ts: '2026-08-09T00:01:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220' },
    { ts: '2026-08-09T00:02:00Z', tool: 'agent_passport', amountUsd: 0.01, network: 'eip155:42220', facilitatorCredits: 3 },
  ]
  const proof = await celoProof(CONFIGURED_ENV, async () => records)
  assert.equal(proof.totalSettlements, 3)
  assert.equal(proof.totalUsd, 0.012)
  assert.deepEqual(proof.byTool, {
    verify_agent: { count: 2, usd: 0.002 },
    agent_passport: { count: 1, usd: 0.01 },
  })
  // recent is newest-first and capped at 50.
  assert.equal(proof.recent[0].tool, 'agent_passport')
  assert.equal(proof.recent.length, 3)
})

test('a retired address is never ours on the Celo rail: dropped from the env list, published apart, and its payments never external', async () => {
  const listed = RETIRED_COMPROMISED.map((r) => r.checksum).join(',')
  const records: CeloSettlementRecord[] = [
    { ts: '2026-08-09T00:00:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220', payer: RETIRED_COMPROMISED[0].checksum },
    { ts: '2026-08-09T00:01:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220', payer: RETIRED_COMPROMISED[1].address },
    { ts: '2026-08-09T00:02:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220', payer: '0x8c8d9cd12d8896a40cf2115ee731258bb4983349' },
    { ts: '2026-08-09T00:03:00Z', tool: 'agent_passport', amountUsd: 0.01, network: 'eip155:42220', payer: '0x' + '42'.repeat(20) },
  ]
  // Before: the env listed the retired addresses as ours. After: it does not.
  const before = await celoProof({ ...CONFIGURED_ENV, CELO_INTERNAL_PAYERS: listed } as NodeJS.ProcessEnv, async () => records)
  const after = await celoProof(CONFIGURED_ENV, async () => records)
  const numbers = (p: typeof after) => ({ total: p.totalSettlements, usd: p.totalUsd, internal: p.internalSettlements, internalUsd: p.internalUsd, external: p.externalSettlements, externalUsd: p.externalUsd })
  assert.deepEqual(numbers(after), numbers(before), 'no published number moves')
  assert.deepEqual(numbers(after), { total: 4, usd: 0.013, internal: 3, internalUsd: 0.003, external: 1, externalUsd: 0.01 })
  assert.deepEqual(after.internalPayers, before.internalPayers)
  assert.ok(!after.internalPayers.some((a) => retiredAddresses().includes(a)), 'not ours')
  assert.deepEqual(after.retiredPayers.map((r) => r.address), retiredAddresses())
  assert.deepEqual(after.recent.map((r) => r.internal), [false, true, true, true])
})

test('a retired Celo pay-to fails closed as not configured, in any case, and is never named as the pay-to', () => {
  for (const r of RETIRED_COMPROMISED) {
    for (const spelled of [r.checksum, r.address]) {
      const status = celoX402Status({ ...CONFIGURED_ENV, CELO_PAYTO: spelled } as NodeJS.ProcessEnv)
      assert.equal(status.configured, false)
      assert.equal(status.payTo, null)
      assert.match(status.reason ?? '', new RegExp(`CELO_PAYTO names ${r.label}`))
      const gate = celoPaywallGate(status)
      assert.ok(!gate.ok && gate.httpStatus === 501)
    }
  }
})

// ── registry invariants for the Celo pair ─────────────────────────────────────────

test('the celo descriptor asserts exactly what was verified on-chain, and no unwired ValidationRegistry', () => {
  const celo = getChainById('celo')
  assert.ok(celo)
  assert.equal(celo.status, 'live')
  assert.equal(celo.testnet, false)
  assert.equal(celo.caip2, 'eip155:42220')
  assert.equal(celo.usdcDecimals, 6)
  // Verified 2026-08-09 (eth_getCode + real ownerOf / getClients / getSummary reads).
  assert.equal(celo.contracts.identityRegistry, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
  assert.equal(celo.contracts.reputationRegistry, '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63')
  assert.equal(celo.contracts.usdc, '0xcebA9300f2b948710d2653dD7B07f33A8B32118C')
  // The IdentityRegistry is the SAME CREATE2 address as X Layer's entry.
  assert.equal(celo.contracts.identityRegistry.toLowerCase(), getChainById('xlayer')?.contracts.identityRegistry?.toLowerCase())
  // A ValidationRegistry proxy is deployed on Celo but not wired: asserting it here would
  // advertise KYA anchoring nothing performs, and the note must say it is not wired.
  assert.equal(celo.contracts.validationRegistry, undefined)
  assert.ok(celo.identity.note?.includes('not wired'))
  // cUSD is rebranded USDm; the descriptor uses the current name.
  assert.ok(celo.stablecoins.includes('USDm'))
  assert.equal(celo.stablecoins.includes('cUSD'), false)
  assert.equal(celo.payment.x402, true)
})

test('celo-sepolia mirrors the testnet shape: Arc\'s registry pair, testnet USDC, no ValidationRegistry', () => {
  const sepolia = getChainById('celo-sepolia')
  assert.ok(sepolia)
  assert.equal(sepolia.status, 'beta')
  assert.equal(sepolia.testnet, true)
  assert.equal(sepolia.caip2, 'eip155:11142220')
  assert.equal(sepolia.evmChainId, 11142220)
  assert.equal(sepolia.usdcDecimals, 6)
  // The SAME ERC-8004 pair the Arc descriptor carries (verified: same EIP-1967
  // implementations as Celo mainnet's pair).
  const arc = requireChain('eip155:5042002')
  assert.equal(sepolia.contracts.identityRegistry, arc.contracts.identityRegistry)
  assert.equal(sepolia.contracts.reputationRegistry, arc.contracts.reputationRegistry)
  assert.equal(sepolia.contracts.usdc, '0x01C5C0122039549AD1493B8220cABEdD739BC44E')
  assert.equal(sepolia.contracts.validationRegistry, undefined)
  assert.equal(sepolia.faucet, 'https://faucet.celo.org/celo-sepolia')
  assert.equal(sepolia.explorer, 'https://celo-sepolia.blockscout.com')
  assert.equal(sepolia.rpcUrls[0], 'https://forno.celo-sepolia.celo-testnet.org')
  assert.equal(sepolia.payment.x402, true)
})

// ── the Celo-side identity read (celoIdentitySummary) ─────────────────────────────
// Why this exists at all: the same numeric id means a different agent on every chain, and
// the trust body a paid call returns used to answer a bare id from whichever chain the
// shared resolver matched first (celoScopedAgentId now scopes it to Celo). Without a
// Celo-side read, a Celo buyer asking about a Celo agent id could pay a Celo rail for an
// answer that never touched Celo. These pin that the read is real, scoped, and degrades
// honestly instead of throwing into a paid call.

/** A configured mainnet status, the same shape celoServeTool resolves. */
function celoStatus(): CeloX402Status {
  return celoX402Status(CONFIGURED_ENV)
}

test('a Celo identity read refuses a non-numeric agent id instead of guessing, and never touches the RPC', async () => {
  let calls = 0
  const out = await celoIdentitySummary('alice.eth', celoStatus(), {
    readContract: async () => { calls++; return '0x' },
  })
  assert.equal(out.read, false)
  assert.equal(calls, 0)
  assert.match(out.read === false ? out.reason : '', /numeric ERC-8004 agent id/)
  // Another chain's CAIP id names that chain's token: Celo's token of the same number is another
  // agent, so it is not read under that id either.
  const arcMainnet = getChainById('arc-mainnet')
  assert.ok(arcMainnet)
  const other = await celoIdentitySummary(`${arcMainnet.caip2}:8004/9759`, celoStatus(), {
    readContract: async () => { calls++; return '0x' },
  })
  assert.equal(other.read, false)
  assert.equal(calls, 0)
  assert.ok((other.read === false ? other.reason : '').includes(`names a token on ${arcMainnet.caip2}, not on Celo (eip155:42220)`))
})

test('a Celo identity read returns the owner, the CAIP id and a Celoscan NFT link for a minted agent', async () => {
  const owner = '0x' + '9a'.repeat(20)
  const seen: string[] = []
  const out = await celoIdentitySummary('#9759', celoStatus(), {
    readContract: async (fn) => {
      seen.push(fn)
      return fn === 'ownerOf' ? owner : 'https://a-identity.xyz/.well-known/agent-card.json'
    },
  })
  assert.equal(out.read, true)
  if (out.read !== true) return
  assert.equal(out.owner, owner)
  assert.equal(out.network, 'eip155:42220')
  assert.equal(out.agentId, 'eip155:42220:8004/9759')
  assert.equal(out.registry, '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
  assert.equal(out.explorer, 'https://celoscan.io/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/9759')
  assert.equal(out.tokenURI, 'https://a-identity.xyz/.well-known/agent-card.json')
  assert.equal(out.tokenUriTruncated, false)
  assert.deepEqual(seen, ['ownerOf', 'tokenURI'])
})

test('a multi-kilobyte inline tokenURI is truncated and says so, instead of shipping base64 into every receipt', async () => {
  // Several live Celo agents pin the whole agent.json as a data: URI (id #1 does).
  const huge = 'data:application/json;base64,' + 'A'.repeat(5000)
  const out = await celoIdentitySummary('#1', celoStatus(), {
    readContract: async (fn) => (fn === 'ownerOf' ? '0x' + '11'.repeat(20) : huge),
  })
  assert.equal(out.read, true)
  if (out.read !== true) return
  assert.equal(out.tokenUriTruncated, true)
  assert.ok(out.tokenURI && out.tokenURI.length < 250)
  assert.ok(out.tokenURI!.startsWith('data:application/json;base64,'))
})

test('an unminted agent id reads as a named absence, not a raw revert string', async () => {
  const out = await celoIdentitySummary('#999999', celoStatus(), {
    readContract: async () => { throw new Error('The contract function "ownerOf" reverted.') },
  })
  assert.equal(out.read, false)
  if (out.read !== false) return
  assert.match(out.reason, /no agent #999999 in the Celo identity registry/)
  assert.match(out.reason, /0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/)
})

test('a tokenURI failure alone still returns the owner: the softer fact degrades, the hard one survives', async () => {
  const out = await celoIdentitySummary('eip155:42220:8004/42', celoStatus(), {
    readContract: async (fn) => {
      if (fn === 'tokenURI') throw new Error('execution reverted')
      return '0x' + '22'.repeat(20)
    },
  })
  assert.equal(out.read, true)
  if (out.read !== true) return
  assert.equal(out.owner, '0x' + '22'.repeat(20))
  assert.equal(out.tokenURI, null)
  assert.equal(out.tokenUriTruncated, false)
  assert.equal(out.agentId, 'eip155:42220:8004/42')
})

// ── the sybil-review deal: our own traffic is labeled, never filtered ─────────────

const OWN_BUYER = '0x8c8d9cd12d8896a40cf2115ee731258bb4983349'

test('celoProof splits our own buyer wallet out as internal instead of letting it read as demand', async () => {
  const records: CeloSettlementRecord[] = [
    { ts: '2026-08-09T00:00:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220', payer: OWN_BUYER },
    // Same wallet, checksummed the way a client might send it: the match is case-blind.
    { ts: '2026-08-09T00:01:00Z', tool: 'agent_passport', amountUsd: 0.01, network: 'eip155:42220', payer: OWN_BUYER.toUpperCase().replace('0X', '0x') },
    { ts: '2026-08-09T00:02:00Z', tool: 'risk_check', amountUsd: 0.005, network: 'eip155:42220', payer: '0x' + '99'.repeat(20) },
    // No payer recorded at all is NOT ours to claim: it stays external.
    { ts: '2026-08-09T00:03:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220' },
  ]
  const proof = await celoProof(CONFIGURED_ENV, async () => records)

  // Nothing is dropped: the totals still cover every settlement, because the money moved.
  assert.equal(proof.totalSettlements, 4)
  assert.equal(proof.totalUsd, 0.017)
  assert.equal(proof.internalSettlements, 2)
  assert.equal(proof.internalUsd, 0.011)
  assert.equal(proof.externalSettlements, 2)
  assert.equal(proof.externalUsd, 0.006)
  assert.equal(proof.internalSettlements + proof.externalSettlements, proof.totalSettlements)
  assert.ok(proof.internalPayers.includes(OWN_BUYER))
  // The buyer key replaced on 2026-11-17 is listed too, before it paid anything, and every entry is lowercase:
  // payers are compared lowercased, so a checksummed hardcoded entry would never match one.
  assert.ok(proof.internalPayers.includes(OUR_KEY_PUBLIC_ADDRESSES.CELO_BUYER_KEY!.toLowerCase()))
  for (const p of proof.internalPayers) assert.equal(p, p.toLowerCase(), p)

  // Every recent row carries the flag, so the page can badge it without guessing.
  assert.deepEqual(proof.recent.map((r) => r.internal), [false, false, true, true])
  // The outside rows come on their own as well, newest first, none of them internal.
  assert.deepEqual(proof.recentExternal.map((r) => r.internal), [false, false])
  assert.deepEqual(proof.recentExternal.map((r) => r.tx), proof.recent.filter((r) => !r.internal).map((r) => r.tx))

  // The co-founder's wallet and the founder's wallet that holds our facilitator account (listed
  // 2026-11-17) are ours too, in any spelling: a check either pays is never external demand.
  for (const payer of ['0x9Ec344BaDF764ecC38518D48991961254584f8CC', '0xe3130cA9061FC911b7F05e66D76fF44761fEFb7E']) {
    const one = await celoProof(CONFIGURED_ENV, async () => [{ ts: '2026-11-17T00:00:00Z', tool: 'risk_check', amountUsd: 0.005, network: 'eip155:42220', payer }])
    assert.equal(one.internalSettlements, 1, payer)
    assert.equal(one.externalSettlements, 0, payer)
    assert.ok(one.internalPayers.includes(payer.toLowerCase()), payer)
  }
})

test('CELO_INTERNAL_PAYERS adds a wallet without a deploy, and ignores anything that is not an address', async () => {
  const extra = '0x' + 'ab'.repeat(20)
  const records: CeloSettlementRecord[] = [
    { ts: '2026-08-09T00:00:00Z', tool: 'verify_agent', amountUsd: 0.001, network: 'eip155:42220', payer: extra },
  ]
  const off = await celoProof(CONFIGURED_ENV, async () => records)
  assert.equal(off.internalSettlements, 0)

  const on = await celoProof(
    { ...CONFIGURED_ENV, CELO_INTERNAL_PAYERS: ` ${extra.toUpperCase().replace('0X', '0x')} , not-an-address ,0xdead` },
    async () => records,
  )
  assert.equal(on.internalSettlements, 1)
  // The junk entries never enter the set: only the hardcoded wallets and the valid extra, which
  // adds to them and removes none.
  assert.equal(on.internalPayers.length, off.internalPayers.length + 1)
  assert.ok(off.internalPayers.every((a) => on.internalPayers.includes(a)))
  assert.ok(on.internalPayers.includes(extra))
})

test('a settle timeout tells the buyer the money may have moved, because the facilitator broadcasts before it answers', async () => {
  // The real failure this wording exists for: on a 620-call sweep, ~16% of settles
  // tripped the old 8s cap and the buyer's USDC left the wallet for every one of them.
  // "settle failed" alone would have sent the buyer looking for a refund that is not
  // owed; the honest answer is "check the explorer before you retry".
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({ settle: 'throw' })
  const persisted: CeloSettlementRecord[] = []
  let handlerRan = false
  const out = await celoServeTool('verify_agent', { agentId: '#9759' }, paymentHeader(status), status, {
    fetchImpl: fac.fetchImpl,
    persist: async (r) => { persisted.push(r) },
    handlers: { verify_agent: async () => { handlerRan = true; return {} } },
    env: CONFIGURED_ENV,
    // With the chain unreadable, the maybe is all that can honestly be said.
    authorizationUsed: async () => null,
  })
  assert.equal(out.httpStatus, 502)
  const body = out.body as { error: string; note: string }
  assert.equal(body.error, 'celo facilitator settle failed')
  assert.match(body.note, /money may have moved/)
  assert.match(body.note, /NOT resubmitted/)
  assert.match(body.note, /explorer/)
  // Exactly one settle attempt: a retry here is how a buyer gets charged twice.
  assert.equal(fac.calls.filter((u) => u.endsWith('/settle')).length, 1)
  assert.equal(handlerRan, false)
  assert.deepEqual(persisted, [], 'nothing may be recorded as settled when we do not know that it was')
  // No v2 receipt either way: success would claim a settlement nobody saw, and a failure receipt
  // would tell a stock client to pay again while this payment may still land.
  assert.equal(out.headers?.['PAYMENT-RESPONSE'], undefined)
  assert.equal(out.headers?.['PAYMENT-REQUIRED'], undefined, 'and no fresh price: retrying is a decision for after the explorer check')
})

// ── what a failed settle leaves open, settled by the chain ────────────────────────

const T0 = new Date('2026-11-11T00:00:00.000Z')
/** The live answer of 2026-11-11, word for word, when the first outside buyer of /check/celo signed. */
const OUT_OF_FUNDS = jsonRes(402, {
  success: false,
  transaction: '',
  network: 'celo',
  payer: BUYER,
  error: 'insufficient_credits',
  errorMessage: 'Out of mainnet settlement funds (this settlement costs 1405 micro-USD). Top up at x402.celo.org.',
})

test('an empty settlement balance at the facilitator pauses the rail: 503, nothing charged, and the challenge waits too', async () => {
  // The facilitator refused to broadcast for us, the chain says the nonce is unspent, so the
  // buyer is told nothing was charged, and nobody else is asked to sign until a top-up.
  _setCeloSettlementPauseForTests(null)
  try {
    const status = celoX402Status(CONFIGURED_ENV)
    const fac = fakeFacilitator({ settle: OUT_OF_FUNDS })
    const persisted: CeloSettlementRecord[] = []
    let handlerRan = false
    const deps = {
      fetchImpl: fac.fetchImpl,
      persist: async (r: CeloSettlementRecord) => { persisted.push(r) },
      handlers: { risk_check: async () => { handlerRan = true; return {} } },
      env: CONFIGURED_ENV,
      now: () => T0,
      authorizationUsed: async () => false,
    }
    const out = await celoServeTool('risk_check', { agentId: '#9759' }, paymentHeader(status), status, deps)
    assert.equal(out.httpStatus, 503)
    const body = out.body as { error: string; reason: string; charged: unknown; note: string; since: string; until: string }
    assert.equal(body.error, 'celo settlement paused')
    assert.match(body.reason, /settlement funds/)
    assert.equal(body.charged, false)
    assert.match(body.note, /nothing was charged/)
    assert.match(body.note, /x402\.celo\.org/)
    assert.equal(body.since, T0.toISOString())
    assert.equal(body.until, new Date(T0.getTime() + 15 * 60_000).toISOString())
    assert.equal(handlerRan, false)
    assert.deepEqual(persisted, [])

    // During the pause: the status says so, the challenge is refused, and a paid call is not even attempted.
    const later = new Date(T0.getTime() + 60_000)
    const report = celoStatusReport(CONFIGURED_ENV, later) as { settlement: { paused: boolean; until?: string } }
    assert.equal(report.settlement.paused, true)
    assert.equal(report.settlement.until, body.until)
    assert.equal(celoPauseResponse(later)?.httpStatus, 503)
    const callsBefore = fac.calls.length
    const again = await celoServeTool('risk_check', { agentId: '#9759' }, paymentHeader(status), status, { ...deps, now: () => later })
    assert.equal(again.httpStatus, 503)
    assert.equal(fac.calls.length, callsBefore, 'a paused rail does not call the facilitator')

    // After it: the pause has expired on its own, and the next attempt is a real one.
    const after = new Date(T0.getTime() + 16 * 60_000)
    assert.equal(celoPauseResponse(after), null)
    assert.deepEqual(celoSettlementPause(after), { paused: false })
    const retry = await celoServeTool('risk_check', { agentId: '#9759' }, paymentHeader(status), status, { ...deps, now: () => after })
    assert.equal(retry.httpStatus, 503, 'still out of funds: the attempt re-arms the pause')
    assert.equal(fac.calls.length, callsBefore + 2, 'the retry went to the facilitator (verify, settle)')

    // Over the route, a live pause still comes before the 402: no price is quoted, with or without
    // a payment, so nobody signs for a settlement the facilitator will refuse.
    _setCeloSettlementPauseForTests({ since: new Date(), reason: 'Out of mainnet settlement funds' })
    const callsNow = fac.calls.length
    for (const r of [
      await route('GET', '/api/celo/tools/risk_check'),
      await route('POST', '/api/celo/tools/risk_check', { body: '{}' }),
      await route('POST', '/api/celo/tools/risk_check', { headers: { 'payment-signature': v2PaymentHeader(status, 'risk_check') }, body: '{"agentId":"#9759"}', serve: deps }),
    ]) {
      assert.equal(r.status, 503)
      assert.equal(r.body!.error, 'celo settlement paused')
      assert.equal(r.headers['payment-required'], undefined, 'a paused rail quotes no price')
    }
    assert.equal(fac.calls.length, callsNow, 'and asks the facilitator nothing')
  } finally {
    _setCeloSettlementPauseForTests(null)
  }
})

test('a settle the facilitator did not confirm but the chain did is served and recorded from the read-back', async () => {
  // The case the old 8s cap produced ~16% of the time: the transfer lands, the answer does
  // not arrive. The buyer paid, so the buyer is served, the proof log says so, and the
  // facilitator's own record supplies the hash.
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({ settle: 'throw' })
  const persisted: CeloSettlementRecord[] = []
  let handlerRan = 0
  const TX = '0x' + 'ee'.repeat(32)
  const asked: string[] = []
  const out = await celoServeTool('verify_agent', { agentId: '#9759' }, paymentHeader(status), status, {
    fetchImpl: fac.fetchImpl,
    persist: async (r) => { persisted.push(r) },
    handlers: { verify_agent: async () => { handlerRan++; return { ok: true } } },
    env: CONFIGURED_ENV,
    now: () => T0,
    authorizationUsed: async (payer, nonce) => { asked.push(`${payer}:${nonce}`); return true },
    settleStatus: async () => ({ status: 'consumed', tx: TX }),
  })
  assert.equal(out.httpStatus, 200)
  const body = out.body as { paid: boolean; settlement: { tx?: string; confirmedBy: string; facilitatorAnswer?: string; note?: string; settledAt: string } }
  assert.equal(body.paid, true)
  assert.equal(body.settlement.confirmedBy, 'read-back')
  assert.equal(body.settlement.tx, TX)
  assert.equal(body.settlement.settledAt, T0.toISOString())
  assert.match(body.settlement.facilitatorAnswer ?? '', /facilitator unreachable/)
  assert.match(body.settlement.note ?? '', /spent on-chain/)
  assert.equal(handlerRan, 1)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].tx, TX)
  assert.equal(persisted[0].payer, BUYER)
  assert.deepEqual(asked, [`${BUYER}:0x${'22'.repeat(32)}`], 'the read is for the buyer and the nonce that was signed')
  // Still exactly one settle attempt: the chain, not a resubmission, is what confirmed it.
  assert.equal(fac.calls.filter((u) => u.endsWith('/settle')).length, 1)
  // The receipt header names the hash the facilitator's own record supplied.
  assert.deepEqual(unb64(out.headers!['PAYMENT-RESPONSE']), { success: true, transaction: TX, network: status.network, payer: BUYER, amount: '1000' })

  // When that record names no hash, or does not answer, the payment is still served and recorded
  // from the read-back, and no receipt is sent: an empty `transaction` would say that nothing was
  // broadcast, about a transfer the chain shows spent. The body says who confirmed it.
  for (const record of [{ status: 'consumed', tx: null }, null]) {
    const kept: CeloSettlementRecord[] = []
    const unnamed = await celoServeTool('verify_agent', { agentId: '#9759' }, paymentHeader(status), status, {
      fetchImpl: fakeFacilitator({ settle: 'throw' }).fetchImpl,
      persist: async (r) => { kept.push(r) },
      handlers: { verify_agent: async () => ({ ok: true }) },
      env: CONFIGURED_ENV,
      now: () => T0,
      authorizationUsed: async () => true,
      settleStatus: async () => record,
    })
    const label = JSON.stringify(record)
    assert.equal(unnamed.httpStatus, 200, label)
    const served = unnamed.body as { paid: boolean; settlement: { settled: boolean; confirmedBy: string; tx?: string } }
    assert.equal(served.paid, true, label)
    assert.equal(served.settlement.confirmedBy, 'read-back', label)
    assert.equal(served.settlement.tx, undefined, label)
    assert.equal(kept.length, 1, `${label}: recorded`)
    assert.equal(unnamed.headers?.['PAYMENT-RESPONSE'], undefined, `${label}: no receipt without the hash`)
  }
})

test('a settle failure with the authorization unspent says nothing was charged; an unreadable chain keeps the honest maybe', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const run = async (settle: FakeResponse | 'throw', used: boolean | null) => {
    const fac = fakeFacilitator({ settle })
    const persisted: CeloSettlementRecord[] = []
    const out = await celoServeTool('risk_check', { agentId: '#1' }, paymentHeader(status), status, {
      fetchImpl: fac.fetchImpl,
      persist: async (r) => { persisted.push(r) },
      handlers: { risk_check: async () => ({}) },
      env: CONFIGURED_ENV,
      authorizationUsed: async () => used,
    })
    assert.deepEqual(persisted, [])
    assert.deepEqual(fac.calls.map((u) => u.slice(u.lastIndexOf('/'))), ['/verify', '/settle'], 'settled once, never resubmitted')
    return { status: out.httpStatus, body: out.body as { error: string; reason: string; charged: unknown; note: string }, headers: out.headers ?? {} }
  }
  const refusedUnspent = await run(jsonRes(500, { error: 'settlement rejected' }), false)
  assert.equal(refusedUnspent.status, 502)
  assert.equal(refusedUnspent.body.charged, false)
  assert.match(refusedUnspent.body.note, /unspent on-chain, so nothing was charged/)
  const timedOutUnspent = await run('throw', false)
  assert.equal(timedOutUnspent.status, 502)
  assert.equal(timedOutUnspent.body.charged, false)
  assert.doesNotMatch(timedOutUnspent.body.note, /may have moved/, 'the chain said the nonce is unspent, so the money did not move')
  const timedOutUnknown = await run('throw', null)
  assert.equal(timedOutUnknown.body.charged, 'unknown')
  assert.match(timedOutUnknown.body.note, /may have moved/)
  const refusedUnknown = await run(jsonRes(500, { error: 'settlement rejected' }), null)
  assert.equal(refusedUnknown.body.charged, 'unknown')
  assert.match(refusedUnknown.body.note, /could not be read/)

  // A settlement refused outright (a verdict, success false, no transaction broadcast or pending)
  // while the chain shows the nonce unspent is the x402 v2 "Payment Failed": a 402 whose
  // PAYMENT-RESPONSE says success false with the error code, and a fresh PAYMENT-REQUIRED. The
  // body still says nothing was charged, and the reference client reads it as a failed settlement.
  const { decodePaymentResponseHeader } = await import('@x402/core/http')
  const { x402Client, x402HTTPClient } = await import('@x402/core/client')
  const reference = new x402HTTPClient(new x402Client())
  const EXPIRED = { success: false, transaction: '', network: 'celo', payer: BUYER, error: 'invalid_exact_evm_payload_authorization_valid_before', errorMessage: 'the authorization expired before it was settled' }
  for (const [answer, errorReason] of [
    [jsonRes(400, EXPIRED), 'invalid_exact_evm_payload_authorization_valid_before'],
    [jsonRes(200, { success: false, errorReason: 'insufficient_funds', transaction: '' }), 'insufficient_funds'],
    [jsonRes(422, { success: false, error: 'Settlement failed: see logs' }), 'unexpected_settle_error'],
  ] as const) {
    const label = JSON.stringify(await answer.json())
    const failed = await run(answer, false)
    assert.equal(failed.status, 402, label)
    assert.equal(failed.body.error, 'celo facilitator settle failed', label)
    assert.equal(failed.body.charged, false, label)
    assert.match(failed.body.note, /unspent on-chain, so nothing was charged/, label)
    const receipt = decodePaymentResponseHeader(failed.headers['PAYMENT-RESPONSE'])
    assert.deepEqual(receipt, { success: false, errorReason, transaction: '', network: status.network, payer: BUYER }, label)
    const again = unb64(failed.headers['PAYMENT-REQUIRED'])
    assert.equal(again.x402Version, 2, label)
    assert.deepEqual(again.accepts, [celoToolRequirements('risk_check', status)], `${label}: the same offer, to pay again with a fresh authorization`)
    assert.match(again.error, new RegExp(`^settlement failed \\(${errorReason}\\)`), label)
    const parsed = reference.parsePaymentResult({ status: failed.status, getHeader: (k) => failed.headers[k.toUpperCase()], body: failed.body })
    assert.equal(parsed.paymentStatus, 'settle_failed', label)
  }
  assert.match((await run(jsonRes(400, EXPIRED), false)).body.reason, /expired before it was settled/, 'the facilitator sentence stays in the body')
  // Not a verdict that nothing was broadcast, or the chain could not be read: the 502s above, with
  // no receipt and no fresh price. A pending settlement is non-terminal (the spec: it "may still
  // confirm on chain"), so an unspent nonce does not make it a payment that never happened, and
  // neither does it make one of a transfer the facilitator names as broadcast.
  const PENDING_TX = '0x' + 'aa'.repeat(32)
  for (const [answer, used, charged] of [
    [jsonRes(400, EXPIRED), null, 'unknown'],
    [jsonRes(200, { success: false, errorReason: 'settlement_pending', transaction: PENDING_TX }), false, 'unknown'],
    [jsonRes(400, { success: false, error: 'invalid_transaction_state', transaction: PENDING_TX }), false, 'unknown'],
    [jsonRes(503, { success: false, error: 'unexpected_settle_error' }), false, false],
    [jsonRes(400, { error: 'bad request' }), false, false],
  ] as const) {
    const label = `${JSON.stringify(await answer.json())} with the nonce ${String(used)}`
    const r = await run(answer, used)
    assert.equal(r.status, 502, label)
    assert.equal(r.body.charged, charged, label)
    assert.equal(r.headers['PAYMENT-RESPONSE'], undefined, label)
    assert.equal(r.headers['PAYMENT-REQUIRED'], undefined, label)
  }
  const pendingAnswer = await run(jsonRes(200, { success: false, errorReason: 'settlement_pending', transaction: PENDING_TX }), false)
  assert.match(pendingAnswer.body.note, /PENDING and the money may still move/)
  assert.doesNotMatch(pendingAnswer.body.note, /nothing was charged/)
  assert.equal((pendingAnswer.body as { tx?: string }).tx, PENDING_TX, 'the hash to look up on the explorer')
  // A refusal that names a transaction and is not pending (invalid_transaction_state with a hash, a
  // 5xx that carries one) leaves the same open question: the named transfer may still land after the
  // nonce reads unspent, or while the chain cannot be read. Its body says the money is unknown, names
  // the hash, and sends the buyer to that transaction before paying again; never "nothing was charged".
  const NAMED_TX = '0x' + 'bb'.repeat(32)
  for (const [answer, used] of [
    [jsonRes(400, { success: false, error: 'invalid_transaction_state', transaction: NAMED_TX }), false],
    [jsonRes(200, { success: false, errorReason: 'invalid_transaction_state', transaction: NAMED_TX }), false],
    [jsonRes(500, { success: false, error: 'unexpected_settle_error', transaction: NAMED_TX }), false],
    [jsonRes(400, { success: false, error: 'invalid_transaction_state', transaction: NAMED_TX }), null],
  ] as const) {
    const label = `${JSON.stringify(await answer.json())} with the nonce ${String(used)}`
    const named = await run(answer, used)
    assert.equal(named.status, 502, label)
    assert.equal(named.body.error, 'celo facilitator settle failed', label)
    assert.equal(named.body.charged, 'unknown', label)
    assert.equal((named.body as { tx?: string }).tx, NAMED_TX, `${label}: the hash to look up on the explorer`)
    assert.match(named.body.note, /^settlement is UNCONFIRMED and the money may still move/, label)
    assert.ok(named.body.note.includes(`named transaction ${NAMED_TX}`), `${label}: the note names the transaction`)
    assert.match(named.body.note, /Check that transaction on the explorer before paying again/, label)
    assert.doesNotMatch(named.body.note, /nothing was charged/, label)
    assert.equal(named.headers['PAYMENT-RESPONSE'], undefined, `${label}: no receipt`)
    assert.equal(named.headers['PAYMENT-REQUIRED'], undefined, `${label}: and no fresh price`)
  }
  assert.equal((await run(jsonRes(400, { success: false, error: 'invalid_transaction_state', transaction: NAMED_TX }), false)).body.reason, 'invalid_transaction_state', "the facilitator's error stays in the body as the reason")

  // Over the route, the 402 and both its headers reach the wire.
  const onWire = await route('POST', '/api/celo/tools/risk_check', {
    headers: { 'payment-signature': v2PaymentHeader(status, 'risk_check'), 'content-type': 'application/json', ...VIA_SITE },
    body: '{"agentId":"#9759"}',
    serve: {
      fetchImpl: fakeFacilitator({ settle: jsonRes(400, EXPIRED) }).fetchImpl,
      persist: async () => { throw new Error('nothing may be recorded') },
      handlers: { risk_check: async () => { throw new Error('nothing may be served') } },
      authorizationUsed: async () => false,
    },
  })
  assert.equal(onWire.status, 402)
  assert.equal(onWire.body!.charged, false)
  assert.equal(unb64(onWire.headers['payment-response']).success, false)
  assert.equal(unb64(onWire.headers['payment-required']).resource.url, 'https://a-identity.xyz/api/celo/tools/risk_check')
})

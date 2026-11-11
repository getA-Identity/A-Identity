import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { recoverTypedDataAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getChainById } from './chains/registry.js'
import { celoChallenge, celoServeTool, celoStatusReport, type CeloServeDeps, type CeloX402Status } from './celo-x402.js'

/** What the server writes to its settlement log, as its persist hook receives it. */
type CeloSettlementRecord = Parameters<NonNullable<CeloServeDeps['persist']>>[0]

/**
 * The Celo pay-check page's rules, run from src/ as they ship (/check/celo sells one
 * risk_check on Celo mainnet to the visitor's own wallet, in real USDC).
 *
 * src/lib/celo/x402pay.ts has no runtime imports, so Node's type stripping loads it straight
 * from the repository, the same way frontend-arc-vault.test.ts loads the vault's send path.
 * What it RETURNS, and what a fake wallet is asked to sign, is the guard: the 402 it reads
 * is the one this server builds, the header it writes is decoded by this server's own paid
 * path, and the signature inside recovers to the buyer against the facilitator's typed data.
 * A source search cannot tell that a quote on another network signs nothing, or that a
 * declined signature sends nothing; this watches both happen.
 */

/** Compiled to dist/, so the repository root is two levels up. */
const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repo = (rel: string) => readFileSync(fileURLToPath(repoUrl(rel)), 'utf8')

type Terms = {
  tool: string
  network: string
  chainId: number
  asset: string
  payTo: string
  amount: bigint
  amountUsd: number
  validSeconds: number
  domain: { name: string; version: string }
}
type RailStatus = {
  network: string
  chain: string
  payTo: string
  facilitator: string
  usdc: string
  explorer: string | null
  prices: Record<string, number>
  pause: { since: string; until: string; reason: string } | null
}
type Stop = { kind: string; text?: string; reason?: string; tx?: string | null; payTo?: string; status?: number; wallet?: string }
type Answer = { decision: string | null; risk: string | null; reasons: string[]; agentId: string; tx: string | null; payer: string | null; raw: Record<string, unknown> }
type End = { kind: 'paid'; answer: Answer } | { kind: 'stopped'; stop: Stop }
type Auth = Record<string, string>
type TypedData = { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Auth }
type Wallet = { name: string; from: string; request: (method: string, params: unknown[]) => Promise<unknown> }
type Pay = {
  CHECK_TOOL: string
  PayRefusal: new (m: string) => Error
  readStatus: (body: unknown) => RailStatus | null
  readTerms: (a: { tool: string; status: RailStatus; expectedNetwork: string; httpStatus: number; body: unknown }) => Terms
  usdcUnits: (usd: number) => bigint
  formatUsdc: (units: bigint) => string
  balanceOfCall: (asset: string, holder: string) => { to: string; data: string }
  unitsFromHex: (v: unknown) => bigint | null
  fundsProblem: (balance: bigint, need: bigint) => string | null
  nonceHex: (b: Uint8Array) => string
  authorizationFor: (t: Terms, from: string, nonce: string, now: number) => Auth
  typedDataFor: (t: Terms, a: Auth) => TypedData
  paymentHeader: (t: Terms, a: Auth, signature: string) => string
  readAnswer: (status: number, body: unknown, payTo: string) => End
  stopText: (s: Stop) => string
  moneyMayBeOut: (s: Stop) => boolean
  normalizeAgentId: (raw: string) => string
  purchase: (a: {
    tool: string
    agentId: string
    status: RailStatus
    expectedNetwork: string
    wallet: Wallet
    quote: () => Promise<{ status: number; body: unknown }>
    post: (header: string, body: string) => Promise<{ status: number; body: unknown }>
    randomBytes: () => Uint8Array
    now: () => number
    step: (s: string) => void
    alive: () => boolean
  }) => Promise<End | null>
}

const pay = async () => (await import(repoUrl('src/lib/celo/x402pay.ts').href)) as Pay

// ---- the rail as the server describes it, built from the registry and the server's own code ----

const found = getChainById('celo')
assert.ok(found, 'the registry has no celo descriptor')
/** Bound after the assertion, so the closures below see a descriptor and not a maybe. */
const celo = found
const usdcContract = celo.contracts.usdc
assert.ok(usdcContract, 'the celo descriptor names no USDC contract')
const USDC = usdcContract
const seller = privateKeyToAccount(generatePrivateKey())
const buyer = privateKeyToAccount(generatePrivateKey())
const FACILITATOR = 'https://facilitator.test'
const TOOL = 'risk_check' as const
const SETTLE_TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`

const serverStatus: CeloX402Status = { configured: true, network: celo.caip2, chain: celo.id, payTo: seller.address.toLowerCase(), facilitator: FACILITATOR }

/** GET /api/celo/status as the page sees it: the server's report, with the rail configured for this test. */
const statusBody = () => ({
  ...(celoStatusReport({} as NodeJS.ProcessEnv) as Record<string, unknown>),
  configured: true,
  network: celo.caip2,
  chain: celo.id,
  payTo: seller.address.toLowerCase(),
  facilitator: FACILITATOR,
})

const railStatus = async () => {
  const s = (await pay()).readStatus(statusBody())
  assert.ok(s, 'the page could not read the status the server publishes')
  return s
}

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const hex = (s: string) => s as `0x${string}`
const messageOf = (m: Auth) => ({
  from: hex(m.from),
  to: hex(m.to),
  value: BigInt(m.value),
  validAfter: BigInt(m.validAfter),
  validBefore: BigInt(m.validBefore),
  nonce: hex(m.nonce),
})

/** A wallet that answers like an extension does: a USDC balance over eth_call, a real signature over the typed data it is handed. */
function fakeWallet(opts: { balance?: bigint; sign?: 'ok' | 'decline' | 'garbage' } = {}) {
  const calls: { method: string; params: unknown[] }[] = []
  const request = async (method: string, params: unknown[]) => {
    calls.push({ method, params })
    if (method === 'eth_call') return '0x' + (opts.balance ?? 10_000_000n).toString(16).padStart(64, '0')
    if (method === 'eth_signTypedData_v4') {
      if (opts.sign === 'decline') throw Object.assign(new Error('User rejected the request.'), { code: 4001 })
      if (opts.sign === 'garbage') return '0x1234'
      const [from, json] = params as [string, string]
      assert.equal(from, buyer.address, 'the wallet is asked to sign for the connected account')
      const td = JSON.parse(json) as TypedData
      return buyer.signTypedData({
        domain: { name: td.domain.name, version: td.domain.version, chainId: td.domain.chainId, verifyingContract: hex(td.domain.verifyingContract) },
        types: TYPES,
        primaryType: 'TransferWithAuthorization',
        message: messageOf(td.message),
      })
    }
    throw new Error(`unexpected wallet call ${method}`)
  }
  return { wallet: { name: 'Fake wallet', from: buyer.address, request } as Wallet, calls }
}

/** The facilitator, as far as the server talks to it: /verify recovers the signer, /settle returns a hash. */
function fakeFacilitator() {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    const path = u.slice(FACILITATOR.length)
    calls.push({ path, body })
    if (path === '/verify') {
      const payload = (body.paymentPayload as { payload: { signature: string; authorization: Auth } }).payload
      const req = body.paymentRequirements as { asset: string; payTo: string; maxAmountRequired: string; extra: { name: string; version: string } }
      const signer = await recoverTypedDataAddress({
        domain: { name: req.extra.name, version: req.extra.version, chainId: celo.evmChainId as number, verifyingContract: hex(req.asset) },
        types: TYPES,
        primaryType: 'TransferWithAuthorization',
        message: messageOf(payload.authorization),
        signature: hex(payload.signature),
      })
      const ok =
        signer.toLowerCase() === buyer.address.toLowerCase() &&
        payload.authorization.to.toLowerCase() === req.payTo.toLowerCase() &&
        payload.authorization.value === req.maxAmountRequired
      return new Response(JSON.stringify(ok ? { isValid: true } : { isValid: false, invalidReason: 'signature does not recover to the payer' }), { status: 200 })
    }
    if (path === '/settle') return new Response(JSON.stringify({ success: true, transaction: SETTLE_TX, payer: buyer.address, network: celo.id }), { status: 200 })
    throw new Error(`unexpected facilitator call ${u}`)
  }) as typeof fetch
  return { fetchImpl, calls }
}

const serve = async (header: string, body: string, facilitator = fakeFacilitator(), persisted: CeloSettlementRecord[] = []) => {
  const input = JSON.parse(body) as { agentId: string }
  const out = await celoServeTool(TOOL, { agentId: input.agentId }, header, serverStatus, {
    fetchImpl: facilitator.fetchImpl,
    persist: async (rec) => void persisted.push(rec),
    env: { CELO_X402_API_KEY: 'test-key' } as NodeJS.ProcessEnv,
    now: () => new Date('2026-11-11T00:00:00.000Z'),
    handlers: { [TOOL]: async (i) => ({ tool: TOOL, agentId: i.agentId, decision: 'WARN', risk: 'medium', reasons: ['no record for this id'] }) },
  })
  return { status: out.httpStatus, body: out.body }
}

const quote = () => ({ status: 402, body: celoChallenge(TOOL, serverStatus) })
const bytes32 = () => new Uint8Array(randomBytes(32))
const NOW = 1_800_000_000

// ---- the status and the terms ----

test('the page reads the rail status the server publishes, and refuses one that is not configured', async () => {
  const p = await pay()
  const s = p.readStatus(statusBody())
  assert.ok(s)
  assert.equal(s.network, celo.caip2)
  assert.equal(s.usdc.toLowerCase(), USDC.toLowerCase())
  assert.equal(s.payTo, seller.address.toLowerCase())
  assert.equal(s.prices[TOOL], (celoChallenge(TOOL, serverStatus).tool as { priceUsd: number }).priceUsd)
  assert.equal(p.readStatus({ ...statusBody(), configured: false }), null, 'an unconfigured rail is nothing to pay')
  assert.equal(p.readStatus({ ...statusBody(), chains: {} }), null, 'a status that names no USDC is nothing to check a quote against')
  assert.equal(p.readStatus(null), null)
})

test("the terms come from the server's own 402 and are held against the registry", async () => {
  const p = await pay()
  const status = await railStatus()
  const terms = p.readTerms({ tool: TOOL, status, expectedNetwork: celo.caip2, httpStatus: 402, body: celoChallenge(TOOL, serverStatus) })
  assert.equal(terms.network, celo.caip2)
  assert.equal(terms.chainId, celo.evmChainId)
  assert.equal(terms.asset.toLowerCase(), USDC.toLowerCase())
  assert.equal(terms.payTo.toLowerCase(), seller.address.toLowerCase())
  assert.equal(terms.amount, p.usdcUnits(status.prices[TOOL]))
  assert.equal(terms.validSeconds, 600)
  assert.deepEqual(terms.domain, { name: 'USDC', version: '2' })
})

test('terms on another network, token, payee, price or scheme are refused, and so is a quote that is not a 402', async () => {
  const p = await pay()
  const status = await railStatus()
  const base = celoChallenge(TOOL, serverStatus)
  const other = privateKeyToAccount(generatePrivateKey()).address
  const mutate = (patch: Record<string, unknown>) => ({ ...base, accepts: [{ ...base.accepts[0], ...patch }] })
  const refusal = (body: unknown, httpStatus = 402) => {
    try {
      p.readTerms({ tool: TOOL, status, expectedNetwork: celo.caip2, httpStatus, body })
    } catch (e) {
      assert.ok(e instanceof p.PayRefusal, 'a bad quote is a PayRefusal, with a sentence for the person')
      return (e as Error).message
    }
    assert.fail('the quote was accepted')
  }
  assert.match(refusal(mutate({ network: 'eip155:1' })), /network/)
  assert.match(refusal(mutate({ asset: other })), /token/)
  assert.match(refusal(mutate({ payTo: other })), /pays/)
  assert.match(refusal(mutate({ maxAmountRequired: String(BigInt(base.accepts[0].maxAmountRequired) + 1n) })), /published price/)
  assert.match(refusal(mutate({ scheme: 'upto' })), /scheme/)
  assert.match(refusal(mutate({ extra: undefined })), /domain/)
  assert.match(refusal({ error: 'nope' }, 200), /did not quote a price/)
  assert.match(refusal({ error: 'celo x402 not configured' }, 501), /not configured/)
  // A rail that reports another network than the registry's Celo is refused even with a matching quote.
  assert.match(
    (() => {
      try {
        p.readTerms({ tool: TOOL, status: { ...status, network: 'eip155:1' }, expectedNetwork: celo.caip2, httpStatus: 402, body: base })
      } catch (e) {
        return (e as Error).message
      }
      return ''
    })(),
    /rail reports network/,
  )
})

// ---- the USDC read ----

test('the balance read is ERC-20 balanceOf for the buyer, and its answer is read as base units', async () => {
  const p = await pay()
  const call = p.balanceOfCall(USDC, buyer.address)
  assert.equal(call.to, USDC)
  assert.equal(call.data, '0x70a08231' + buyer.address.toLowerCase().slice(2).padStart(64, '0'))
  assert.equal(p.unitsFromHex('0x' + (5000n).toString(16).padStart(64, '0')), 5000n)
  assert.equal(p.unitsFromHex('0x'), 0n)
  assert.equal(p.unitsFromHex('not hex'), null)
  assert.equal(p.fundsProblem(5000n, 5000n), null)
  assert.match(p.fundsProblem(4999n, 5000n) ?? '', /holds 0\.004999 USDC on Celo; this check costs 0\.005 USDC/)
  assert.match(p.fundsProblem(0n, 5000n) ?? '', /holds no USDC/)
  assert.equal(p.formatUsdc(1_000_000n), '1.00')
  assert.equal(p.formatUsdc(5000n), '0.005')
})

test('a wallet short of USDC is refused before it is asked to sign, and nothing is posted', async () => {
  const p = await pay()
  const { wallet, calls } = fakeWallet({ balance: 10n })
  const posted: string[] = []
  const end = await p.purchase({
    tool: TOOL,
    agentId: '#9759',
    status: await railStatus(),
    expectedNetwork: celo.caip2,
    wallet,
    quote: async () => quote(),
    post: async (h) => {
      posted.push(h)
      return { status: 500, body: {} }
    },
    randomBytes: bytes32,
    now: () => NOW,
    step: () => {},
    alive: () => true,
  })
  assert.ok(end && end.kind === 'stopped')
  assert.equal(end.stop.kind, 'refusal')
  assert.match(end.stop.text ?? '', /holds 0\.00001 USDC/)
  assert.deepEqual(
    calls.map((c) => c.method),
    ['eth_call'],
    'the wallet was asked for its balance and nothing else',
  )
  assert.equal(posted.length, 0)
})

// ---- what the wallet signs ----

test('what the wallet signs is the EIP-3009 authorization the facilitator verifies: the token domain, exact amount, ten minutes, a fresh nonce', async () => {
  const p = await pay()
  const status = await railStatus()
  const terms = p.readTerms({ tool: TOOL, status, expectedNetwork: celo.caip2, httpStatus: 402, body: celoChallenge(TOOL, serverStatus) })
  const nonce = p.nonceHex(bytes32())
  assert.match(nonce, /^0x[0-9a-f]{64}$/)
  assert.throws(() => p.nonceHex(new Uint8Array(16)), /32 bytes/)
  const auth = p.authorizationFor(terms, buyer.address, nonce, NOW)
  assert.deepEqual(auth, { from: buyer.address, to: terms.payTo, value: terms.amount.toString(), validAfter: '0', validBefore: String(NOW + 600), nonce })
  const td = p.typedDataFor(terms, auth)
  assert.equal(td.primaryType, 'TransferWithAuthorization')
  assert.deepEqual(td.domain, { name: 'USDC', version: '2', chainId: celo.evmChainId, verifyingContract: terms.asset })
  assert.deepEqual(td.types.TransferWithAuthorization, TYPES.TransferWithAuthorization)
  assert.ok(td.types.EIP712Domain, 'eth_signTypedData_v4 wants the domain type spelled out')
  assert.deepEqual(td.message, auth)

  const signature = await buyer.signTypedData({ domain: { ...td.domain, verifyingContract: hex(td.domain.verifyingContract) }, types: TYPES, primaryType: 'TransferWithAuthorization', message: messageOf(auth) })
  const header = p.paymentHeader(terms, auth, signature)
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { x402Version: number; scheme: string; network: string; payload: { signature: string; authorization: Auth } }
  assert.equal(decoded.x402Version, 2)
  assert.equal(decoded.scheme, 'exact')
  assert.equal(decoded.network, celo.caip2)
  assert.equal(decoded.payload.signature, signature)
  assert.deepEqual(decoded.payload.authorization, auth)
  // The facilitator's view: the same typed data, built from the server's requirements, recovers the buyer.
  const signer = await recoverTypedDataAddress({
    domain: { name: 'USDC', version: '2', chainId: celo.evmChainId as number, verifyingContract: hex(USDC) },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: messageOf(decoded.payload.authorization),
    signature: hex(signature),
  })
  assert.equal(signer.toLowerCase(), buyer.address.toLowerCase())
})

test("the real server's paid path accepts the header the page builds, settles once and serves the verdict", async () => {
  const p = await pay()
  const { wallet, calls } = fakeWallet()
  const facilitator = fakeFacilitator()
  const persisted: CeloSettlementRecord[] = []
  const steps: string[] = []
  const end = await p.purchase({
    tool: TOOL,
    agentId: '#9759',
    status: await railStatus(),
    expectedNetwork: celo.caip2,
    wallet,
    quote: async () => quote(),
    post: (header, body) => serve(header, body, facilitator, persisted),
    randomBytes: bytes32,
    now: () => NOW,
    step: (s) => steps.push(s),
    alive: () => true,
  })
  assert.deepEqual(steps, ['quoting', 'checking', 'signing', 'confirming'])
  assert.deepEqual(
    calls.map((c) => c.method),
    ['eth_call', 'eth_signTypedData_v4'],
  )
  assert.ok(end && end.kind === 'paid', `expected a paid answer, got ${JSON.stringify(end)}`)
  assert.equal(end.answer.decision, 'WARN')
  assert.deepEqual(end.answer.reasons, ['no record for this id'])
  assert.equal(end.answer.agentId, '#9759')
  assert.equal(end.answer.tx, SETTLE_TX)
  assert.equal(end.answer.payer, buyer.address.toLowerCase())
  assert.deepEqual(
    facilitator.calls.map((c) => c.path),
    ['/verify', '/settle'],
    'verified, then settled exactly once',
  )
  const verifyBody = facilitator.calls[0].body as { x402Version: number; paymentPayload: { network: string }; paymentRequirements: { network: string; payTo: string } }
  assert.equal(verifyBody.x402Version, 1, 'the server speaks the facilitator v1 shape at its boundary')
  assert.equal(verifyBody.paymentPayload.network, celo.id)
  assert.equal(verifyBody.paymentRequirements.payTo, seller.address.toLowerCase())
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].payer, buyer.address.toLowerCase())
  assert.equal(persisted[0].tx, SETTLE_TX)
})

test('a declined signature sends nothing, and a wallet that returns no usable signature is reported as the wallet failing', async () => {
  const p = await pay()
  for (const [sign, kind] of [
    ['decline', 'cancelled'],
    ['garbage', 'wallet'],
  ] as const) {
    const { wallet } = fakeWallet({ sign })
    const posted: string[] = []
    const end = await p.purchase({
      tool: TOOL,
      agentId: '#9759',
      status: await railStatus(),
      expectedNetwork: celo.caip2,
      wallet,
      quote: async () => quote(),
      post: async (h) => {
        posted.push(h)
        return { status: 500, body: {} }
      },
      randomBytes: bytes32,
      now: () => NOW,
      step: () => {},
      alive: () => true,
    })
    assert.ok(end && end.kind === 'stopped')
    assert.equal(end.stop.kind, kind)
    assert.equal(posted.length, 0, `${sign}: nothing left the page`)
  }
})

test('leaving before the payment is sent drops the signature: nothing is posted and nothing is reported', async () => {
  const p = await pay()
  const { wallet } = fakeWallet()
  const posted: string[] = []
  let alive = true
  const end = await p.purchase({
    tool: TOOL,
    agentId: '#9759',
    status: await railStatus(),
    expectedNetwork: celo.caip2,
    wallet,
    quote: async () => quote(),
    post: async (h) => {
      posted.push(h)
      return { status: 500, body: {} }
    },
    randomBytes: bytes32,
    now: () => NOW,
    step: (s) => {
      // The person cancels while the wallet is open; the signature then arrives anyway.
      if (s === 'signing') alive = false
    },
    alive: () => alive,
  })
  assert.equal(end, null)
  assert.equal(posted.length, 0)
})

// ---- the endings ----

test('every ending says what happened to the money, and only the true ones say nothing was charged', async () => {
  const p = await pay()
  const payTo = seller.address.toLowerCase()
  const challenge = celoChallenge(TOOL, serverStatus, 'nonce already used')
  const cases: { status: number; body: unknown; kind: string; charged: 'no' | 'maybe' | 'yes' }[] = [
    { status: 400, body: { error: 'agentId required' }, kind: 'refusal', charged: 'no' },
    { status: 402, body: challenge, kind: 'refused', charged: 'no' },
    { status: 501, body: { error: 'celo x402 not configured' }, kind: 'unavailable', charged: 'no' },
    { status: 502, body: { error: 'celo facilitator verify failed', reason: 'facilitator answered 503' }, kind: 'unavailable', charged: 'no' },
    { status: 502, body: { error: 'celo facilitator settle failed', reason: 'timeout', charged: 'unknown' }, kind: 'ambiguous', charged: 'maybe' },
    { status: 502, body: { error: 'celo facilitator settle failed', reason: 'settlement rejected', charged: false }, kind: 'settle_failed', charged: 'no' },
    {
      status: 503,
      body: {
        error: 'celo settlement paused',
        reason: 'Out of mainnet settlement funds (this settlement costs 1405 micro-USD). Top up at x402.celo.org.',
        since: '2026-11-11T00:00:00.000Z',
        until: '2026-11-11T00:15:00.000Z',
        charged: false,
      },
      kind: 'paused',
      charged: 'no',
    },
    { status: 500, body: { error: 'tool execution failed after settlement', settlement: { settled: true, tx: SETTLE_TX } }, kind: 'paid_unreadable', charged: 'yes' },
    { status: 418, body: {}, kind: 'unexpected', charged: 'maybe' },
  ]
  for (const c of cases) {
    const end = p.readAnswer(c.status, c.body, payTo)
    assert.ok(end.kind === 'stopped', `${c.status} is not an answer`)
    assert.equal(end.stop.kind, c.kind, `HTTP ${c.status}`)
    const text = p.stopText(end.stop)
    if (c.charged === 'no') assert.match(text, /Nothing was charged\.$/, `HTTP ${c.status}: ${text}`)
    else assert.doesNotMatch(text, /Nothing was charged/, `HTTP ${c.status}: ${text}`)
    assert.equal(p.moneyMayBeOut(end.stop), c.charged !== 'no', `HTTP ${c.status}`)
  }
  assert.match(p.stopText(p.readAnswer(402, challenge, payTo).kind === 'stopped' ? (p.readAnswer(402, challenge, payTo) as { stop: Stop }).stop : { kind: 'cancelled' }), /nonce already used/)
  assert.match(p.stopText({ kind: 'cancelled' }), /^Payment cancelled\. Nothing was charged\.$/)
  // A paid answer with no verdict in it is still a paid answer, not a stop.
  const odd = p.readAnswer(200, { paid: true, tool: TOOL, settlement: { tx: SETTLE_TX }, result: { decision: 'MAYBE' } }, payTo)
  assert.ok(odd.kind === 'paid')
  assert.equal(odd.answer.decision, null)
  assert.equal(odd.answer.tx, SETTLE_TX)
})

test('an agent id is normalized the way the Celo registry read wants it', async () => {
  const p = await pay()
  assert.equal(p.normalizeAgentId('9759'), '#9759')
  assert.equal(p.normalizeAgentId(' #9759 '), '#9759')
  assert.equal(p.normalizeAgentId(`${celo.caip2}:8004/9759`), `${celo.caip2}:8004/9759`)
  assert.equal(p.normalizeAgentId(''), '')
})

// ---- the page is reachable ----

test('the Celo pay check is routed, in the sitemap, smoked and published for agents', () => {
  assert.match(repo('src/App.tsx'), /path="\/check\/celo"/)
  assert.match(repo('scripts/gen-sitemap.mjs'), /'\/check\/celo'/)
  assert.match(repo('scripts/smoke.mjs'), /'\/check\/celo'/)
  assert.match(repo('public/llms.txt'), /https:\/\/a-identity\.xyz\/check\/celo/)
  assert.match(repo('docs/chains/celo.mdx'), /\/check\/celo/)
  const page = repo('src/routes/CeloCheck.tsx')
  assert.match(page, /CHAIN_BY_ID\.celo/, 'the page takes Celo from the generated registry, not from a typed id')
  assert.doesNotMatch(page, /0x[0-9a-fA-F]{40}/, 'no address is typed into the page')
  const lib = repo('src/lib/celo/x402pay.ts')
  assert.doesNotMatch(lib, /^import (?!type )/m, 'the pay module has no runtime imports, so this suite can load it')
  assert.doesNotMatch(lib, /0x[0-9a-fA-F]{40}/, 'no address is typed into the pay module')
})

test('a paused rail is refused before the wallet is asked anything', async () => {
  // The rail pauses itself after the facilitator refuses to settle for us (an empty
  // settlement balance, 2026-11-11). The page reads that from the status and stops at
  // the door: no quote, no wallet, no signature for nothing.
  const p = await pay()
  const paused = p.readStatus({
    ...statusBody(),
    settlement: { paused: true, since: '2026-11-11T00:00:00.000Z', until: '2026-11-11T00:15:00.000Z', reason: 'Out of mainnet settlement funds' },
  })
  assert.ok(paused && paused.pause, 'the status carries the pause')
  assert.equal(paused.pause.until, '2026-11-11T00:15:00.000Z')
  const open = p.readStatus({ ...statusBody(), settlement: { paused: false } })
  assert.equal(open?.pause, null)

  const { wallet, calls } = fakeWallet()
  let quoted = 0
  const end = await p.purchase({
    tool: TOOL,
    agentId: '#9759',
    status: paused,
    expectedNetwork: celo.caip2,
    wallet,
    quote: async () => {
      quoted++
      return quote()
    },
    post: async () => ({ status: 500, body: {} }),
    randomBytes: bytes32,
    now: () => NOW,
    step: () => {},
    alive: () => true,
  })
  assert.ok(end && end.kind === 'stopped')
  assert.equal(end.stop.kind, 'paused')
  assert.match(p.stopText(end.stop), /paused/)
  assert.match(p.stopText(end.stop), /Nothing was charged\.$/)
  assert.equal(quoted, 0)
  assert.deepEqual(calls, [])
})

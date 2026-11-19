import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { recoverTypedDataAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getChainById } from './chains/registry.js'
import {
  celoChallenge,
  celoFacilitatorRequirements,
  celoPaymentRequired,
  celoServeTool,
  celoStatusReport,
  type CeloServeDeps,
  type CeloX402Status,
} from './celo-x402.js'

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
  accepted: Record<string, unknown> | null
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
type Answer = { decision: string | null; risk: string | null; reasons: string[]; agentId: string; tx: string | null; payer: string | null; resolvedOn: string | null; raw: Record<string, unknown> }
type End = { kind: 'paid'; answer: Answer } | { kind: 'stopped'; stop: Stop }
type Auth = Record<string, string>
type TypedData = { domain: { name: string; version: string; chainId: number; verifyingContract: string }; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Auth }
type Wallet = { name: string; from: string; request: (method: string, params: unknown[]) => Promise<unknown> }
type Pay = {
  CHECK_TOOL: string
  PAYMENT_HEADER: string
  LEGACY_PAYMENT_HEADER: string
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
  paymentHeaderName: (t: Terms) => string
  readAnswer: (status: number, body: unknown, payTo: string) => End
  stopText: (s: Stop) => string
  moneyMayBeOut: (s: Stop) => boolean
  normalizeAgentId: (raw: string, network: string) => string
  purchase: (a: {
    tool: string
    agentId: string
    status: RailStatus
    expectedNetwork: string
    wallet: Wallet
    quote: () => Promise<{ status: number; body: unknown }>
    post: (header: string, body: string, name: string) => Promise<{ status: number; body: unknown }>
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
  return { status: out.httpStatus, body: out.body, headers: out.headers ?? {} }
}

const quote = () => ({ status: 402, body: celoChallenge(TOOL, serverStatus) })

/**
 * The 402 the rail answered with before the x402 v2 change (until 2026-11-18), which the new page
 * meets while a deploy has the site live and the backend not yet: the price only under
 * maxAmountRequired, with the v1 fields in the entry. That entry is the facilitator leg's, which
 * still has that shape, with the CAIP-2 network the public 402 has always named.
 */
const legacyChallenge = () => ({
  x402Version: 2,
  error: 'payment required',
  accepts: [{ ...celoFacilitatorRequirements(TOOL, serverStatus), network: celo.caip2 }],
  tool: celoChallenge(TOOL, serverStatus).tool,
})
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
  // The offer itself is kept as quoted, less the transitional v1 price name the body carries for one
  // release: the payment sends back as `accepted` exactly the entry PAYMENT-REQUIRED carries.
  assert.deepEqual(terms.accepted, celoPaymentRequired(TOOL, serverStatus).accepts[0])
  assert.equal(celoChallenge(TOOL, serverStatus).accepts[0].maxAmountRequired, celoChallenge(TOOL, serverStatus).accepts[0].amount, 'what a page loaded before the change reads')

  // While a deploy has this page live and the backend from before x402 v2 still answering, the quote
  // names the price only as maxAmountRequired. It is read there, held to the same registry, rail and
  // price, and marked as that rail's (no `accepted`), so the payment goes the way that rail reads it.
  const legacy = p.readTerms({ tool: TOOL, status, expectedNetwork: celo.caip2, httpStatus: 402, body: legacyChallenge() })
  assert.equal(legacy.amount, terms.amount)
  assert.equal(legacy.payTo, terms.payTo)
  assert.equal(legacy.asset, terms.asset)
  assert.equal(legacy.validSeconds, terms.validSeconds)
  assert.deepEqual(legacy.domain, terms.domain)
  assert.equal(legacy.accepted, null)
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
  assert.match(refusal(mutate({ amount: String(BigInt(base.accepts[0].amount) + 1n) })), /published price/)
  // The page reads the x402 v2 `amount`, and the v1 maxAmountRequired only when `amount` is absent
  // (a rail from before the change). Neither, or an `amount` that is no number, is no quote; two
  // names that disagree are no quote; and a price named the v1 way is held to the published one.
  const off = String(BigInt(base.accepts[0].amount) + 1n)
  assert.match(refusal(mutate({ amount: undefined, maxAmountRequired: undefined })), /names no amount/)
  assert.match(refusal(mutate({ amount: 'five' })), /names no amount/)
  assert.match(refusal(mutate({ maxAmountRequired: off })), /two different amounts/)
  assert.match(refusal(mutate({ amount: undefined, maxAmountRequired: off })), /published price/)
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
  // What the page sends to this rail is an x402 v2 PaymentPayload, in the PAYMENT-SIGNATURE header:
  // the offer it pays under `accepted`, as PAYMENT-REQUIRED quotes it, and the credential under
  // `payload`. Nothing else, and nothing of the earlier flat shape (that is for the rail from before
  // x402 v2 only, below).
  assert.equal(p.PAYMENT_HEADER, 'PAYMENT-SIGNATURE')
  assert.equal(p.paymentHeaderName(terms), 'PAYMENT-SIGNATURE')
  const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { x402Version: number; accepted: Record<string, unknown>; payload: { signature: string; authorization: Auth } }
  assert.deepEqual(Object.keys(decoded), ['x402Version', 'accepted', 'payload'])
  assert.equal(decoded.x402Version, 2)
  assert.deepEqual(decoded.accepted, celoPaymentRequired(TOOL, serverStatus).accepts[0])
  assert.equal(decoded.accepted.scheme, 'exact')
  assert.equal(decoded.accepted.network, celo.caip2)
  assert.equal(decoded.payload.signature, signature)
  assert.deepEqual(decoded.payload.authorization, auth)
  // The reference v2 schema reads it as a PaymentPayload.
  const { parsePaymentPayload } = await import('@x402/core/schemas')
  const parsed = parsePaymentPayload(decoded)
  assert.ok(parsed.success, `the reference schema rejects the page's payment: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`)
  // The facilitator's view: the same typed data, built from the server's requirements, recovers the buyer.
  const signer = await recoverTypedDataAddress({
    domain: { name: 'USDC', version: '2', chainId: celo.evmChainId as number, verifyingContract: hex(USDC) },
    types: TYPES,
    primaryType: 'TransferWithAuthorization',
    message: messageOf(decoded.payload.authorization),
    signature: hex(signature),
  })
  assert.equal(signer.toLowerCase(), buyer.address.toLowerCase())

  // Quoted by the rail from before x402 v2 (a deploy in progress), the wallet signs the very same
  // authorization, and only the envelope changes: X-PAYMENT, in the earlier flat shape, the one
  // header and shape that rail reads (and that this rail still reads).
  const legacy = p.readTerms({ tool: TOOL, status, expectedNetwork: celo.caip2, httpStatus: 402, body: legacyChallenge() })
  const legacyAuth = p.authorizationFor(legacy, buyer.address, nonce, NOW)
  assert.deepEqual(legacyAuth, auth)
  assert.deepEqual(p.typedDataFor(legacy, legacyAuth), td)
  assert.equal(p.LEGACY_PAYMENT_HEADER, 'X-PAYMENT')
  assert.equal(p.paymentHeaderName(legacy), 'X-PAYMENT')
  assert.deepEqual(JSON.parse(Buffer.from(p.paymentHeader(legacy, legacyAuth, signature), 'base64').toString('utf8')), {
    x402Version: 2,
    scheme: 'exact',
    network: celo.caip2,
    payload: { signature, authorization: auth },
  })
})

test("the real server's paid path accepts the header the page builds, settles once and serves the verdict", async () => {
  const p = await pay()
  const { wallet, calls } = fakeWallet()
  const facilitator = fakeFacilitator()
  const persisted: CeloSettlementRecord[] = []
  const steps: string[] = []
  const names: string[] = []
  let receipt = ''
  const end = await p.purchase({
    tool: TOOL,
    // What the page sends for a typed "#9759": Celo's token, by its CAIP-10 id.
    agentId: p.normalizeAgentId('#9759', celo.caip2),
    status: await railStatus(),
    expectedNetwork: celo.caip2,
    wallet,
    quote: async () => quote(),
    post: async (header, body, name) => {
      names.push(name)
      const out = await serve(header, body, facilitator, persisted)
      receipt = out.headers['PAYMENT-RESPONSE'] ?? ''
      return out
    },
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
  assert.equal(end.answer.agentId, `${celo.caip2}:8004/9759`, 'the tool was asked about Celo #9759, not another chain\'s token of that number')
  // The answer names the chain its identity and reputation were resolved against: Celo, not the X Layer line of the ASP meta.
  assert.ok(end.answer.resolvedOn?.includes(`(${celo.caip2})`), `resolved on: ${end.answer.resolvedOn}`)
  assert.doesNotMatch(end.answer.resolvedOn ?? '', /X Layer/)
  assert.equal(end.answer.tx, SETTLE_TX)
  assert.equal(end.answer.payer, buyer.address.toLowerCase())
  assert.deepEqual(
    facilitator.calls.map((c) => c.path),
    ['/verify', '/settle'],
    'verified, then settled exactly once',
  )
  const verifyBody = facilitator.calls[0].body as { x402Version: number; paymentPayload: Record<string, unknown> & { network: string }; paymentRequirements: { network: string; payTo: string } }
  assert.equal(verifyBody.x402Version, 1, 'the server speaks the facilitator v1 shape at its boundary')
  assert.equal(verifyBody.paymentPayload.network, celo.id)
  // The page's v2 payload reaches the facilitator as the v1 payload it has always accepted: no
  // `accepted`, the scheme at the top, the slug network.
  assert.deepEqual(Object.keys(verifyBody.paymentPayload), ['x402Version', 'scheme', 'network', 'payload'])
  assert.equal(verifyBody.paymentPayload.scheme, 'exact')
  assert.equal(verifyBody.paymentRequirements.payTo, seller.address.toLowerCase())
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].payer, buyer.address.toLowerCase())
  assert.equal(persisted[0].tx, SETTLE_TX)
  // And the 200 carries the v2 receipt the page could read without the body.
  const r = JSON.parse(Buffer.from(receipt, 'base64').toString('utf8')) as Record<string, unknown>
  assert.deepEqual(r, { success: true, transaction: SETTLE_TX, network: celo.caip2, payer: buyer.address.toLowerCase(), amount: '5000' })
  assert.deepEqual(names, ['PAYMENT-SIGNATURE'], 'the payment went out under the v2 header name')

  // Quoted in the shape of the rail from before x402 v2, the page sends X-PAYMENT in the flat shape,
  // and this server, which still reads both, settles it the same way: once, the same facilitator body.
  const legacyFacilitator = fakeFacilitator()
  const legacyNames: string[] = []
  const legacyEnd = await p.purchase({
    tool: TOOL,
    agentId: p.normalizeAgentId('#9759', celo.caip2),
    status: await railStatus(),
    expectedNetwork: celo.caip2,
    wallet: fakeWallet().wallet,
    quote: async () => ({ status: 402, body: legacyChallenge() }),
    post: async (header, body, name) => {
      legacyNames.push(name)
      return serve(header, body, legacyFacilitator)
    },
    randomBytes: bytes32,
    now: () => NOW,
    step: () => {},
    alive: () => true,
  })
  assert.ok(legacyEnd && legacyEnd.kind === 'paid', `expected a paid answer, got ${JSON.stringify(legacyEnd)}`)
  assert.equal(legacyEnd.answer.tx, SETTLE_TX)
  assert.deepEqual(legacyNames, ['X-PAYMENT'])
  assert.deepEqual(legacyFacilitator.calls.map((c) => c.path), ['/verify', '/settle'])
  assert.deepEqual(Object.keys(legacyFacilitator.calls[0].body.paymentPayload as Record<string, unknown>), ['x402Version', 'scheme', 'network', 'payload'])
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
  // A settlement the facilitator refused outright, with the authorization unspent on-chain, is the
  // x402 v2 "Payment Failed" 402, here as the real server answers it: the page tells it from a
  // payment that did not verify, gives the facilitator's reason and says nothing was charged.
  const flatPayment = Buffer.from(JSON.stringify({
    x402Version: 2,
    scheme: 'exact',
    network: celo.caip2,
    payload: { signature: '0x' + '11'.repeat(65), authorization: { from: buyer.address, to: payTo, value: '5000', validAfter: '0', validBefore: String(NOW + 600), nonce: '0x' + '22'.repeat(32) } },
  })).toString('base64')
  /** The real server's answer when the facilitator settles with `answer` and the chain reads the nonce unspent. */
  const settleAnswered = (httpStatus: number, answer: Record<string, unknown>) =>
    celoServeTool(TOOL, { agentId: '#9759' }, flatPayment, serverStatus, {
      fetchImpl: (async (url: string | URL | Request) =>
        String(url).endsWith('/verify')
          ? new Response(JSON.stringify({ isValid: true }), { status: 200 })
          : new Response(JSON.stringify(answer), { status: httpStatus })) as typeof fetch,
      authorizationUsed: async () => false,
      persist: async () => {
        throw new Error('nothing may be recorded')
      },
      env: { CELO_X402_API_KEY: 'test-key' } as NodeJS.ProcessEnv,
    })
  const settleRefused = await settleAnswered(400, { success: false, transaction: '', error: 'insufficient_funds', errorMessage: 'the payer holds too little USDC' })
  assert.equal(settleRefused.httpStatus, 402)
  assert.ok(settleRefused.headers?.['PAYMENT-RESPONSE'], 'with the v2 failure receipt')
  // A refusal that names a transaction, and a pending settlement, while the nonce still reads unspent:
  // the named transfer may still land, so the server answers the 502 with no receipt, the money
  // unknown and the hash, and the page reads it as a payment that might have been charged.
  const NAMED_TX = '0x' + 'cd'.repeat(32)
  const settleUnconfirmed = await settleAnswered(400, { success: false, error: 'invalid_transaction_state', transaction: NAMED_TX })
  const settlePending = await settleAnswered(200, { success: false, errorReason: 'settlement_pending', transaction: NAMED_TX })
  for (const named of [settleUnconfirmed, settlePending]) {
    assert.equal(named.httpStatus, 502)
    assert.equal((named.body as { charged?: unknown }).charged, 'unknown')
    assert.equal((named.body as { tx?: unknown }).tx, NAMED_TX)
    assert.equal(named.headers?.['PAYMENT-RESPONSE'], undefined, 'no receipt for a transfer that may still land')
  }
  const cases: { status: number; body: unknown; kind: string; charged: 'no' | 'maybe' | 'yes' }[] = [
    { status: 400, body: { error: 'agentId required' }, kind: 'refusal', charged: 'no' },
    { status: 402, body: challenge, kind: 'refused', charged: 'no' },
    { status: settleRefused.httpStatus, body: settleRefused.body, kind: 'settle_failed', charged: 'no' },
    { status: settleUnconfirmed.httpStatus, body: settleUnconfirmed.body, kind: 'unconfirmed', charged: 'maybe' },
    { status: settlePending.httpStatus, body: settlePending.body, kind: 'unconfirmed', charged: 'maybe' },
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
  const refusedEnd = p.readAnswer(settleRefused.httpStatus, settleRefused.body, payTo)
  assert.ok(refusedEnd.kind === 'stopped')
  assert.match(p.stopText(refusedEnd.stop), /^The facilitator did not complete the payment: the payer holds too little USDC\. .*Nothing was charged\.$/)
  // The named transaction is what the page sends the buyer to, in the sentence and as the stop's tx.
  const unconfirmedEnd = p.readAnswer(settleUnconfirmed.httpStatus, settleUnconfirmed.body, payTo)
  assert.ok(unconfirmedEnd.kind === 'stopped')
  assert.deepEqual(unconfirmedEnd.stop, { kind: 'unconfirmed', tx: NAMED_TX })
  const unconfirmedText = p.stopText(unconfirmedEnd.stop)
  assert.match(unconfirmedText, /^Your payment might have been charged: /)
  assert.ok(unconfirmedText.includes(`named transaction ${NAMED_TX}`), unconfirmedText)
  assert.match(unconfirmedText, /Check this transaction on the explorer before paying again\.$/)
  // A body that names a transaction is a maybe whatever else it says; a hash that is not one is not
  // linked, and that maybe points at the payee instead.
  const contradictory = p.readAnswer(502, { error: 'celo facilitator settle failed', reason: 'x', charged: false, tx: NAMED_TX }, payTo)
  assert.ok(contradictory.kind === 'stopped')
  assert.deepEqual(contradictory.stop, { kind: 'unconfirmed', tx: NAMED_TX })
  const malformed = p.readAnswer(502, { error: 'celo facilitator settle failed', reason: 'x', charged: 'unknown', tx: '0x1234' }, payTo)
  assert.ok(malformed.kind === 'stopped')
  assert.deepEqual(malformed.stop, { kind: 'ambiguous', payTo })
  assert.match(p.stopText({ kind: 'cancelled' }), /^Payment cancelled\. Nothing was charged\.$/)
  // No wallet in the browser ends in a sentence that says what to do, not a spinner, and nothing moved.
  assert.match(p.stopText({ kind: 'no_wallet' }), /^No EVM wallet was found in this browser\. .*Nothing was charged\.$/)
  assert.equal(p.moneyMayBeOut({ kind: 'no_wallet' }), false)
  // A paid answer with no verdict in it is still a paid answer, not a stop.
  const odd = p.readAnswer(200, { paid: true, tool: TOOL, settlement: { tx: SETTLE_TX }, result: { decision: 'MAYBE' } }, payTo)
  assert.ok(odd.kind === 'paid')
  assert.equal(odd.answer.decision, null)
  assert.equal(odd.answer.tx, SETTLE_TX)
  assert.equal(odd.answer.resolvedOn, null, 'an answer that names no chain is not given one')
})

test('an agent id is normalized the way the Celo registry read wants it', async () => {
  const p = await pay()
  // A bare token id is Celo's on this page. Sent bare, the shared resolver would answer it with the
  // first chain in registry order that has that number: "#9759" was Arc Mainnet's token, someone else's agent.
  const ours = `${celo.caip2}:8004/9759`
  assert.equal(p.normalizeAgentId('9759', celo.caip2), ours)
  assert.equal(p.normalizeAgentId(' #9759 ', celo.caip2), ours)
  assert.equal(p.normalizeAgentId('#09759', celo.caip2), ours)
  // Every other form passes as typed: a CAIP id names its own chain, even another chain's, and an address is an address.
  assert.equal(p.normalizeAgentId(ours, celo.caip2), ours)
  const arcMainnet = getChainById('arc-mainnet')
  assert.ok(arcMainnet)
  assert.equal(p.normalizeAgentId(` ${arcMainnet.caip2}:8004/9759 `, celo.caip2), `${arcMainnet.caip2}:8004/9759`)
  assert.equal(p.normalizeAgentId(buyer.address, celo.caip2), buyer.address)
  assert.equal(p.normalizeAgentId('# 9759', celo.caip2), '# 9759')
  assert.equal(p.normalizeAgentId('', celo.caip2), '')
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
  // prepare() opens the wallet picker whenever no wallet is chosen yet (several installed and none
  // remembered, or WalletConnect alone); unmounted, that visitor waited at "Pick a wallet..." forever.
  assert.match(page, /\{payer\.picker\}/, 'the wallet picker is mounted')
  assert.match(page, /normalizeAgentId\(raw, CELO\.caip2\)/, 'what the page sends is scoped to Celo')
  // The payment goes out under the header name purchase() hands the post (the v2 name, or X-PAYMENT
  // only for a quote from the rail before x402 v2), and both calls to the tool route send no cookie:
  // that route answers any origin with '*', which a browser refuses to pair with credentials.
  assert.match(page, /post: async \(header, body, name\) => \{[\s\S]*?\[name\]: header/, 'the page sends the payment under the name purchase() gives it')
  assert.doesNotMatch(page, /'X-PAYMENT'/, 'and never picks a header name itself')
  assert.equal((page.match(/apiFetch\(toolPath\(TOOL\),[\s\S]*?credentials: 'omit'/g) ?? []).length, 2, 'the quote and the paid call omit credentials')
  assert.match(page, /stop\.kind === 'unconfirmed' && \([\s\S]*?txUrl\(EXPLORER, stop\.tx\)/, 'the unconfirmed ending links the transaction it names')
  // Only a refusal made before anything is broadcast is the 402 with a failure receipt. Every copy that
  // tells an agent how the rail answers says so, and names the 502 for the rest.
  const flat = (s: string) => s.replace(/\n\s*(?:\*\s*)?/g, ' ').replace(/\s+/g, ' ')
  for (const rel of ['src/routes/CeloCheck.tsx', 'public/llms.txt', 'mcp/scripts/celo-x402-buyer.mjs']) {
    const said = flat(repo(rel))
    assert.match(said, /refuses before broadcasting anything \(HTTP 200 or 4xx, success false, no transaction named\)/, rel)
    assert.match(said, /a refusal that names a transaction or a refusal (?:we|the server) could not check on-chain is a 502 with no PAYMENT-RESPONSE/, rel)
    assert.doesNotMatch(said, /refuses while (?:your|the) authorization stays unspent on-chain is a 402/, rel)
  }
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import algosdk from 'algosdk'
import type { AlgorandSettlementRecord } from '../storage.js'
import {
  ALGORAND_PRICES_USD,
  ALGORAND_TOOLS,
  algorandCaip2Of,
  algorandRailChallenge,
  algorandRailPaywallGate,
  algorandRailPriceUsd,
  algorandRailResource,
  algorandRailServeTool,
  algorandRailStatus,
  algorandReceiptsFor,
  algorandResourceOrigin,
  facilitatorNetworkFor,
  DEFAULT_FACILITATOR,
  DEFAULT_RESOURCE_ORIGIN,
  RAIL_BASE_PRICES_USD,
  RAIL_TOOLS,
  type AlgorandRailHandlers,
  type AlgorandToolName,
} from './rail.js'

const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k'
const TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe'
const TESTNET_FULL = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
const PAY_TO = 'ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA'
const TESTNET_ENV = { X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: PAY_TO }

test('with no env the rail is unconfigured and says why', () => {
  const s = algorandRailStatus({})
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /X402_ALGORAND_NETWORKS/)
  assert.equal(s.facilitator, DEFAULT_FACILITATOR)
  const gate = algorandRailPaywallGate(s)
  assert.equal(gate.ok, false)
  if (!gate.ok) assert.equal(gate.httpStatus, 501)
})

test('a malformed payTo is treated as unset, never received into', () => {
  const s = algorandRailStatus({ X402_ALGORAND_NETWORKS: TESTNET, X402_ALGORAND_PAYTO: 'not-an-address' })
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /payTo/)
})

test('a configured testnet status carries the registry token and both network spellings', () => {
  const s = algorandRailStatus(TESTNET_ENV)
  assert.equal(s.configured, true)
  assert.equal(s.network, TESTNET)
  assert.equal(s.chain, 'algorand-testnet')
  assert.equal(s.token?.address, '10458941')
  assert.equal(s.token?.decimals, 6)
  assert.equal(s.payTo, PAY_TO)
  assert.equal(s.facilitatorNetwork, TESTNET_FULL)
})

test('a network the rail is not configured to sell on is refused, not redirected', () => {
  const s = algorandRailStatus(TESTNET_ENV, MAINNET)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /not configured to sell/)
})

test('the CAIP-2 map round-trips both spellings and registry slugs', () => {
  assert.equal(facilitatorNetworkFor(MAINNET), 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=')
  assert.equal(algorandCaip2Of('algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='), MAINNET)
  assert.equal(algorandCaip2Of(MAINNET), MAINNET)
  assert.equal(algorandCaip2Of('algorand-testnet'), TESTNET)
  assert.equal(algorandCaip2Of('stellar:pubnet'), null)
})

test('the challenge is a 402 with an x402 v2 accepts entry priced in base units', () => {
  const s = algorandRailStatus(TESTNET_ENV)
  const c = algorandRailChallenge('verify_agent', s)
  assert.equal(c.httpStatus, 402)
  assert.equal(c.body.x402Version, 2)
  const accepts = (c.body.accepts as Record<string, unknown>[])[0]
  assert.equal(accepts.scheme, 'exact')
  assert.equal(accepts.network, TESTNET_FULL)
  assert.equal(accepts.asset, '10458941')
  assert.equal(accepts.payTo, PAY_TO)
  const expected = String(Math.round(ALGORAND_PRICES_USD.verify_agent * 1e6))
  assert.equal(accepts.amount, expected)
  assert.equal(accepts.maxAmountRequired, expected)
})

test('the optional tag rides the accepts extra and is absent when unset', () => {
  const withTag = algorandRailStatus({ ...TESTNET_ENV, X402_ALGORAND_TAG: 'x402-global-challenge' })
  const c = algorandRailChallenge('risk_check', withTag)
  const extra = ((c.body.accepts as Record<string, unknown>[])[0].extra ?? {}) as Record<string, unknown>
  assert.equal(extra.tag, 'x402-global-challenge')
  const c2 = algorandRailChallenge('risk_check', algorandRailStatus(TESTNET_ENV))
  const extra2 = ((c2.body.accepts as Record<string, unknown>[])[0].extra ?? {}) as Record<string, unknown>
  assert.equal(extra2.tag, undefined)
})

test('every 402 declares a Bazaar discovery extension that passes the validation the facilitator runs', async () => {
  // The facilitator compiles `schema` with Ajv's 2020 draft (strict off) and drops the
  // declaration silently when `info` fails it, so this runs that exact check instead of
  // eyeballing the shape. The negative case proves the validator is not vacuous.
  const mod = (await import('ajv/dist/2020.js' as string)) as { default?: unknown }
  const AjvCtor = ((mod.default as { default?: unknown })?.default ?? mod.default ?? mod) as new (opts: object) => {
    compile: (schema: unknown) => ((data: unknown) => boolean) & { errors?: unknown }
  }
  const s = algorandRailStatus(TESTNET_ENV)
  for (const tool of ALGORAND_TOOLS) {
    const c = algorandRailChallenge(tool, s)
    const bazaar = (c.body.extensions as { bazaar?: { info: { input: Record<string, unknown> }; schema: unknown } })?.bazaar
    assert.ok(bazaar?.info && bazaar.schema, `${tool} declares no bazaar extension`)
    const validate = new AjvCtor({ strict: false, allErrors: true }).compile(bazaar.schema)
    assert.ok(validate(bazaar.info), `${tool}: ${JSON.stringify(validate.errors)}`)
    assert.equal(bazaar.info.input.method, 'POST')
    assert.equal(bazaar.info.input.bodyType, 'json')
    const withoutInput = { ...bazaar.info, input: { ...bazaar.info.input, body: {} } }
    assert.equal(validate(withoutInput), false, `${tool}: a body without its agent input must not validate`)
  }
})

test('resources are named under the site origin by default, and a malformed override is ignored', () => {
  assert.equal(algorandRailResource('verify_agent', {}), 'https://a-identity.xyz/api/x402/algorand/tools/verify_agent')
  assert.equal(
    algorandRailResource('risk_check', { X402_ALGORAND_RESOURCE_ORIGIN: 'https://api.example.com/' }),
    'https://api.example.com/api/x402/algorand/tools/risk_check',
  )
  for (const bad of ['http://a-identity.xyz', 'not a url', 'https://a-identity.xyz/sub', 'https://a-identity.xyz/?q=1']) {
    assert.equal(algorandResourceOrigin({ X402_ALGORAND_RESOURCE_ORIGIN: bad }), DEFAULT_RESOURCE_ORIGIN, bad)
  }
  const c = algorandRailChallenge('agent_passport', algorandRailStatus(TESTNET_ENV), {})
  assert.equal((c.body.resource as { url: string }).url, 'https://a-identity.xyz/api/x402/algorand/tools/agent_passport')
})

test('each catalog description names what the caller gets back, not just the topic', () => {
  const s = algorandRailStatus(TESTNET_ENV)
  const names: Record<AlgorandToolName, RegExp> = {
    verify_agent: /KYA/,
    reputation_score: /0-1000/,
    risk_check: /ALLOW \/ WARN \/ DENY/,
    agent_passport: /passport/,
    agent_batch_audit: /per agent/,
  }
  for (const tool of ALGORAND_TOOLS) {
    const description = (algorandRailChallenge(tool, s).body.resource as { description: string }).description
    assert.ok(description.length >= 80, `${tool}: "${description}" is too thin for a catalog listing`)
    assert.match(description, names[tool])
    assert.match(description, /agentId/, `${tool}: the listing must say what to send`)
  }
})

test('an unconfigured challenge is a 501, never a free 402 menu', () => {
  const c = algorandRailChallenge('verify_agent', algorandRailStatus({}))
  assert.equal(c.httpStatus, 501)
})

test('Algorand sells at its own list, ten times the shared base list, which stays untouched for the other rails', () => {
  for (const tool of RAIL_TOOLS) {
    const p = algorandRailPriceUsd(tool)
    assert.equal(p.totalUsd, p.baseUsd, `${tool}: no settlement fee is invented on this rail`)
    assert.equal(p.baseUsd, ALGORAND_PRICES_USD[tool])
    assert.equal(Math.round(ALGORAND_PRICES_USD[tool] * 1e6), Math.round(RAIL_BASE_PRICES_USD[tool] * 10 * 1e6), tool)
  }
  // The X Layer ASP, the EIP-3009 rails, Stellar and Gateway still charge this list, and the
  // OKX listings are registered against it: raising Algorand must not move it.
  assert.deepEqual(RAIL_BASE_PRICES_USD, { verify_agent: 0.001, reputation_score: 0.002, risk_check: 0.005, agent_passport: 0.01 })
})

test('the batch audit is priced per agent, quoted by count, and capped at fifty agents', () => {
  assert.equal(algorandRailPriceUsd('agent_batch_audit', 10).totalUsd, 0.4)
  assert.equal(algorandRailPriceUsd('agent_batch_audit', 50).totalUsd, 2)
  assert.equal(algorandRailPriceUsd('agent_batch_audit', 60).count, 50)
  assert.equal(algorandRailPriceUsd('agent_batch_audit', 0).totalUsd, 0.04)
  assert.equal(algorandRailPriceUsd('agent_batch_audit', Number.NaN).count, 1)
  const s = algorandRailStatus(TESTNET_ENV)
  const quoted = algorandRailChallenge('agent_batch_audit', s, {}, { count: 25 })
  assert.equal((quoted.body.accepts as Record<string, unknown>[])[0].amount, '1000000')
  assert.equal((quoted.body.pricing as { count: number }).count, 25)
  const defaulted = algorandRailChallenge('agent_batch_audit', s, {})
  assert.equal((defaulted.body.accepts as Record<string, unknown>[])[0].amount, '400000')
  assert.equal(algorandRailChallenge('risk_check', s).body.pricing, undefined, 'single tools carry no batch pricing block')
})

test('receipts list only the settled checks one payer made, newest first', () => {
  const row = (payer: string, ts: string, outcome: 'settled' | 'ambiguous', tool = 'risk_check') =>
    ({ ts, outcome, tool, payer, amountUsd: 0.05, network: MAINNET, tx: `TX-${ts}` }) as unknown as AlgorandSettlementRecord
  const rows = [row(PAY_TO, '1', 'settled'), row('OTHER', '2', 'settled'), row(PAY_TO, '3', 'ambiguous'), row(PAY_TO, '4', 'settled', 'verify_agent')]
  const receipts = algorandReceiptsFor(rows, PAY_TO)
  assert.deepEqual(receipts.map((r) => r.ts), ['4', '1'])
  assert.equal(receipts[0].tool, 'verify_agent')
  assert.equal(algorandReceiptsFor(rows, PAY_TO, 1).length, 1)
  assert.equal(algorandReceiptsFor(rows, 'NOBODY').length, 0)
})

// ── the paid path: the answer is produced before settlement ──────────────────────────

const buyer = algosdk.generateAccount()
const feePayer = algosdk.generateAccount()

function signedPayment(amount: bigint) {
  const params: algosdk.SuggestedParams = {
    fee: 0, flatFee: true, firstValid: 1000, lastValid: 2000, minFee: 1000,
    genesisHash: new Uint8Array(Buffer.from(TESTNET_FULL.slice('algorand:'.length), 'base64')),
    genesisID: 'testnet-v1.0',
  }
  const pay = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: buyer.addr, receiver: PAY_TO, assetIndex: 10458941n, amount, suggestedParams: { ...params, fee: 0 },
  })
  const fee = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: feePayer.addr, receiver: feePayer.addr, amount: 0, suggestedParams: { ...params, fee: 2000 },
  })
  const [f, p] = algosdk.assignGroupID([fee, pay])
  const payload = {
    x402Version: 2, scheme: 'exact', network: TESTNET_FULL,
    payload: {
      paymentGroup: [Buffer.from(algosdk.encodeUnsignedTransaction(f)).toString('base64'), Buffer.from(p.signTxn(buyer.sk)).toString('base64')],
      paymentIndex: 1,
    },
  }
  return { header: Buffer.from(JSON.stringify(payload)).toString('base64'), txId: p.txID() }
}

function paidNet(txId: string, amount: number, order: string[]) {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/verify')) { order.push('verify'); return new Response(JSON.stringify({ isValid: true }), { status: 200 }) }
    if (url.endsWith('/settle')) { order.push('settle'); return new Response(JSON.stringify({ success: true, transaction: txId }), { status: 200 }) }
    if (url.includes('/v2/transactions/')) {
      return new Response(JSON.stringify({
        transaction: {
          id: txId, sender: buyer.addr.toString(), 'tx-type': 'axfer', 'confirmed-round': 777,
          'asset-transfer-transaction': { 'asset-id': 10458941, amount, receiver: PAY_TO },
        },
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return fetcher
}

function handlersWith(overrides: Partial<AlgorandRailHandlers>, order: string[]): AlgorandRailHandlers {
  const unexpected = async () => { throw new Error('unexpected tool') }
  return {
    verify_agent: unexpected, reputation_score: unexpected, risk_check: unexpected, agent_passport: unexpected, agent_batch_audit: unexpected,
    ...Object.fromEntries(Object.entries(overrides).map(([k, fn]) => [k, async (i: never) => { order.push('tool'); return fn!(i) }])),
  } as AlgorandRailHandlers
}

test('a paid call produces its answer after verify and before settle, and releases it with the receipt', async () => {
  const order: string[] = []
  const { header, txId } = signedPayment(10_000n)
  const persisted: AlgorandSettlementRecord[] = []
  const out = await algorandRailServeTool('verify_agent', { agentId: '#0' }, header, algorandRailStatus(TESTNET_ENV), {
    env: {}, fetcher: paidNet(txId, 10_000, order), sleep: async () => {}, attempts: 1,
    persist: async (rec) => { persisted.push(rec) },
    loadResult: async () => ({ ok: true, rows: [] }),
    handlers: handlersWith({ verify_agent: async () => ({ tool: 'verify_agent', verified: true }) }, order),
  })
  assert.equal(out.httpStatus, 200, JSON.stringify(out.body))
  const body = out.body as { verified: boolean; settlement: { success: boolean; transaction: string } }
  assert.equal(body.verified, true)
  assert.equal(body.settlement.success, true)
  assert.equal(body.settlement.transaction, txId)
  assert.deepEqual(order, ['verify', 'tool', 'settle'])
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].baseUsd, ALGORAND_PRICES_USD.verify_agent)
})

test('a tool that cannot answer returns 503 and the facilitator is never asked to settle', async () => {
  const order: string[] = []
  const { header, txId } = signedPayment(400_000n)
  const persisted: AlgorandSettlementRecord[] = []
  const agentIds = Array.from({ length: 10 }, (_, i) => `#${i}`)
  const out = await algorandRailServeTool('agent_batch_audit', { agentId: '', agentIds }, header, algorandRailStatus(TESTNET_ENV), {
    env: {}, fetcher: paidNet(txId, 400_000, order), sleep: async () => {}, attempts: 1,
    persist: async (rec) => { persisted.push(rec) },
    loadResult: async () => ({ ok: true, rows: [] }),
    handlers: handlersWith({ agent_batch_audit: async () => { throw new Error('the audit did not finish inside 14000 ms') } }, order),
  })
  assert.equal(out.httpStatus, 503, JSON.stringify(out.body))
  assert.match(JSON.stringify(out.body), /nothing was settled/)
  assert.deepEqual(order, ['verify', 'tool'])
  assert.equal(persisted.length, 0)

  // Paying for fewer agents than the call lists is refused with a fresh quote before any work.
  const short = signedPayment(40_000n)
  const shortOrder: string[] = []
  const refused = await algorandRailServeTool('agent_batch_audit', { agentId: '', agentIds }, short.header, algorandRailStatus(TESTNET_ENV), {
    env: {}, fetcher: paidNet(short.txId, 40_000, shortOrder), sleep: async () => {}, attempts: 1,
    persist: async () => {}, loadResult: async () => ({ ok: true, rows: [] }),
    handlers: handlersWith({ agent_batch_audit: async () => ({ tool: 'agent_batch_audit' }) }, shortOrder),
  })
  assert.equal(refused.httpStatus, 402)
  assert.equal(((refused.body as { accepts: { amount: string }[] }).accepts[0]).amount, '400000')
  assert.deepEqual(shortOrder, [])
})

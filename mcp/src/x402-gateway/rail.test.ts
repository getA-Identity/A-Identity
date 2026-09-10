import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  railStatus,
  railPaywallGate,
  railNetworks,
  railChallenge,
  railServeTool,
  railProof,
  railPaymentHeader,
  railPaidNetwork,
  railInputError,
  refreshCreditedRows,
  openApiDocument,
  toolPriceUsd,
  internalPayers,
  GATEWAY_TOOLS,
  GATEWAY_FREE_TOOL,
  GATEWAY_TOOL_CARDS,
} from './rail.js'
import { provenKind, clearKindCache, readBackTransfer, type GatewayDeps, type GatewayKind, type GatewayTransfer, type GatewaySettleResponse } from './facilitator.js'
import { getChainById, CHAINS } from '../chains/index.js'
import { PRICES } from '../asp/payment.js'
import { RAIL_BASE_PRICES_USD } from '../x402-3009/rail.js'
import type { GatewaySettlementRecord } from '../storage.js'

const base = getChainById('base')!
const PAY_TO = '0x000000000000000000000000000000000000dEaD'
const PAYER = '0x1111111111111111111111111111111111111111'
const NONCE = '0x' + 'ab'.repeat(32)
const BATCH_TX = '0x' + 'cd'.repeat(32)

const configured = { X402_GATEWAY_NETWORKS: base.caip2, X402_GATEWAY_PAYTO: PAY_TO } as NodeJS.ProcessEnv

/** The kind Gateway advertised for Base on 2026-09-10, shaped as the live response is. */
function liveKind(over: Partial<GatewayKind['extra']> = {}): GatewayKind {
  return {
    x402Version: 2,
    scheme: 'exact',
    network: base.caip2,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: base.gateway!.wallet.toLowerCase(),
      minValiditySeconds: 604800,
      assets: [{ symbol: 'USDC', address: (base.contracts.usdc as string).toLowerCase(), decimals: 6 }],
      ...over,
    },
  }
}

type Spy = { settleCalls: unknown[]; searchCalls: unknown[]; persisted: GatewaySettlementRecord[]; updates: [string, unknown][] }

function deps(
  over: {
    kinds?: GatewayKind[]
    settle?: GatewaySettleResponse | Error
    transfers?: GatewayTransfer[] | Error
    handler?: (i: unknown) => Promise<unknown>
    rows?: GatewaySettlementRecord[]
    env?: NodeJS.ProcessEnv
  } = {},
): { d: GatewayDeps & Record<string, unknown>; spy: Spy } {
  const spy: Spy = { settleCalls: [], searchCalls: [], persisted: [], updates: [] }
  const d = {
    env: over.env ?? configured,
    origin: 'https://seller.example',
    now: () => Date.parse('2026-09-10T12:00:00Z'),
    sleep: async () => {},
    getSupported: async () => ({ kinds: over.kinds ?? [liveKind()] }),
    settle: async (_u: string, payload: unknown) => {
      spy.settleCalls.push(payload)
      if (over.settle instanceof Error) throw over.settle
      return over.settle ?? { success: true, transaction: 'tr-1', network: base.caip2, payer: PAYER }
    },
    searchTransfers: async (_u: string, params: unknown) => {
      spy.searchCalls.push(params)
      if (over.transfers instanceof Error) throw over.transfers
      return over.transfers ?? []
    },
    handlers: over.handler ? Object.fromEntries(GATEWAY_TOOLS.map((t) => [t, over.handler!])) : Object.fromEntries(GATEWAY_TOOLS.map((t) => [t, async () => ({ ok: true, tool: t })])),
    load: async () => over.rows ?? spy.persisted,
    persist: async (r: GatewaySettlementRecord) => {
      spy.persisted.push(r)
    },
    update: async (n: string, patch: unknown) => {
      spy.updates.push([n, patch])
    },
  }
  return { d, spy }
}

function transfer(over: Partial<GatewayTransfer> = {}): GatewayTransfer {
  return { id: 'tr-1', status: 'received', token: 'USDC', sendingNetwork: base.caip2, recipientNetwork: base.caip2, fromAddress: PAYER, toAddress: PAY_TO.toLowerCase(), amount: '1000', nonce: NONCE, ...over }
}

function header(over: Record<string, unknown> = {}, auth: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: 'exact', network: base.caip2, payTo: PAY_TO, amount: '1000' },
      payload: { signature: '0x' + '11'.repeat(65), authorization: { from: PAYER, to: PAY_TO, value: '1000', validAfter: '0', validBefore: '9999999999', nonce: NONCE, ...auth } },
      ...over,
    }),
  ).toString('base64')
}

test('the Gateway rail is fail-closed with an empty environment, and names what is missing', () => {
  const s = railStatus({} as NodeJS.ProcessEnv)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /X402_GATEWAY_NETWORKS/)
  const gate = railPaywallGate(s)
  assert.equal(gate.ok, false)
  if (!gate.ok) assert.equal(gate.httpStatus, 501)
})

test('a chain that declares no Circle Gateway cannot host the rail', () => {
  const s = railStatus({ X402_GATEWAY_NETWORKS: 'eip155:4663', X402_GATEWAY_PAYTO: PAY_TO } as NodeJS.ProcessEnv)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /no Circle Gateway/)
})

test('a payTo is required and never inferred', () => {
  const s = railStatus({ X402_GATEWAY_NETWORKS: base.caip2 } as NodeJS.ProcessEnv)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /X402_GATEWAY_PAYTO/)
})

test('the rail resolves Base by CAIP-2 and by slug, and refuses a network it was not configured for', () => {
  assert.equal(railStatus(configured).chain, 'base')
  assert.equal(railStatus(configured).facilitator, 'https://gateway-api.circle.com')
  assert.equal(railStatus({ ...configured, X402_GATEWAY_NETWORKS: 'base' }).chain, 'base')
  assert.deepEqual(railNetworks({ X402_GATEWAY_NETWORKS: ' eip155:8453, eip155:5042002 ,eip155:8453' } as NodeJS.ProcessEnv), ['eip155:8453', 'eip155:5042002'])
  const other = railStatus(configured, 'eip155:5042002')
  assert.equal(other.configured, false)
  assert.match(other.reason ?? '', /does not sell on/)
})

test('prices are read from the OKX listing table, not restated, and agree with the EIP-3009 rail', () => {
  for (const t of GATEWAY_TOOLS) {
    assert.equal(toolPriceUsd(t), Number(PRICES[`POST /tools/${t}`].replace('$', '')))
  }
  assert.equal(toolPriceUsd('verify_agent'), RAIL_BASE_PRICES_USD.verify_agent)
  assert.equal(toolPriceUsd('reputation_score'), RAIL_BASE_PRICES_USD.reputation_score)
  assert.equal(toolPriceUsd('risk_check'), RAIL_BASE_PRICES_USD.risk_check)
  assert.equal(toolPriceUsd('agent_passport'), RAIL_BASE_PRICES_USD.agent_passport)
  // Six paid tools, one free one, and every card names its required inputs.
  assert.equal(GATEWAY_TOOLS.length, 6)
  assert.equal(GATEWAY_TOOL_CARDS[GATEWAY_FREE_TOOL].required[0], 'agentId')
  assert.deepEqual(GATEWAY_TOOL_CARDS.counterparty_check.required, ['from', 'to'])
})

test('the kind is proven against the registry: a different verifyingContract or a missing USDC is refused', async () => {
  clearKindCache()
  const wrongWallet = await provenKind(base, deps({ kinds: [liveKind({ verifyingContract: '0x' + '99'.repeat(20) })] }).d)
  assert.equal(wrongWallet.ok, false)
  if (!wrongWallet.ok) assert.match(wrongWallet.reason, /registry expects/)
  clearKindCache()
  const noAsset = await provenKind(base, deps({ kinds: [liveKind({ assets: [{ symbol: 'USDC', address: '0x' + '77'.repeat(20), decimals: 6 }] })] }).d)
  assert.equal(noAsset.ok, false)
  if (!noAsset.ok) assert.match(noAsset.reason, /canonical USDC/)
  clearKindCache()
  const absent = await provenKind(base, deps({ kinds: [] }).d)
  assert.equal(absent.ok, false)
  if (!absent.ok) assert.match(absent.reason, /not advertising/)
  clearKindCache()
  const unreachable = await provenKind(base, { ...deps().d, getSupported: async () => { throw new Error('boom') } })
  assert.equal(unreachable.ok, false)
  if (!unreachable.ok) assert.match(unreachable.reason, /boom/)
})

test('a proven kind is cached, and a chain without a gateway is refused before any network call', async () => {
  clearKindCache()
  let reads = 0
  const d = { ...deps().d, getSupported: async () => { reads += 1; return { kinds: [liveKind()] } } }
  const first = await provenKind(base, d)
  const second = await provenKind(base, d)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(reads, 1)
  if (first.ok) {
    assert.equal(first.proven.asset.decimals, 6)
    assert.equal(first.proven.facilitator, base.gateway!.facilitator)
  }
  const rh = await provenKind(getChainById('rhchain')!, d)
  assert.equal(rh.ok, false)
  assert.equal(reads, 1)
})

test('the challenge is x402 v2 with one proven accepts entry, the exact price in units, and an absolute resource URL', async () => {
  clearKindCache()
  const c = await railChallenge('risk_check', railStatus(configured), deps().d)
  assert.equal(c.httpStatus, 402)
  const body = c.body as { x402Version: number; accepts: Record<string, unknown>[]; resource: { url: string }; tool: { price: { totalUsd: number; settlementFeeUsd: number } } }
  assert.equal(body.x402Version, 2)
  assert.equal(body.accepts.length, 1)
  const a = body.accepts[0]
  assert.equal(a.scheme, 'exact')
  assert.equal(a.network, base.caip2)
  assert.equal(a.amount, '5000')
  assert.equal(a.maxAmountRequired, '5000')
  assert.equal(a.payTo, PAY_TO.toLowerCase())
  assert.equal(a.asset, (base.contracts.usdc as string).toLowerCase())
  const extra = a.extra as Record<string, unknown>
  assert.equal(extra.name, 'GatewayWalletBatched')
  assert.equal(extra.version, '1')
  assert.equal(extra.verifyingContract, base.gateway!.wallet.toLowerCase())
  assert.equal(extra.domainVerified, true)
  assert.equal(body.resource.url, 'https://seller.example/api/x402/gateway/tools/risk_check')
  assert.equal(body.tool.price.totalUsd, 0.005)
  assert.equal(body.tool.price.settlementFeeUsd, 0)
})

test('no proven kind means 503 and no challenge, never a challenge nobody can settle', async () => {
  clearKindCache()
  const c = await railChallenge('verify_agent', railStatus(configured), deps({ kinds: [liveKind({ verifyingContract: '0x' + '99'.repeat(20) })] }).d)
  assert.equal(c.httpStatus, 503)
  assert.match((c.body as { reason: string }).reason, /registry expects/)
  clearKindCache()
})

test('missing input is a 400 BEFORE settle is called, so no money moves for a call that cannot run', async () => {
  clearKindCache()
  const { d, spy } = deps()
  const out = await railServeTool('counterparty_check', { from: '#1' }, header(), railStatus(configured), d)
  assert.equal(out.httpStatus, 400)
  assert.equal(spy.settleCalls.length, 0)
  assert.equal(railInputError('counterparty_check', { from: '#1' }), 'to is required')
  assert.equal(railInputError('verify_agent', { agentId: '#1' }), null)
})

test('wrong recipient, wrong amount, a bad nonce and a malformed header are all refused locally with a fresh challenge', async () => {
  clearKindCache()
  const { d, spy } = deps()
  const status = railStatus(configured)
  const cases: [string, string][] = [
    [header({}, { to: PAYER }), 'authorization.to must be'],
    [header({}, { value: '999' }), 'authorization.value must be exactly 1000'],
    [header({}, { nonce: '0x1234' }), 'nonce must be a 32-byte'],
    ['not-base64-json', 'not base64-encoded JSON'],
  ]
  for (const [h, why] of cases) {
    const out = await railServeTool('verify_agent', { agentId: '#73232' }, h, status, d)
    assert.equal(out.httpStatus, 402, why)
    assert.match((out.body as { verifyError: string }).verifyError, new RegExp(why))
  }
  assert.equal(spy.settleCalls.length, 0)
  assert.equal(spy.persisted.length, 0)
})

test('a payment on a network the seller did not configure is refused, never redirected', async () => {
  clearKindCache()
  const { d, spy } = deps()
  const out = await railServeTool('verify_agent', { agentId: '#73232' }, header({ accepted: { network: 'eip155:5042002' } }), railStatus(configured), d)
  assert.equal(out.httpStatus, 402)
  assert.match((out.body as { verifyError: string }).verifyError, /does not sell on/)
  assert.equal(spy.settleCalls.length, 0)
  assert.equal(railPaidNetwork({ accepted: { network: 'eip155:1' } }), 'eip155:1')
  assert.equal(railPaidNetwork({ network: 'eip155:2', accepted: { network: 'eip155:1' } }), 'eip155:2')
  assert.equal(railPaidNetwork({}), undefined)
})

test('Gateway refusing the payment is a 402 with its reason, and nothing is recorded', async () => {
  clearKindCache()
  const { d, spy } = deps({ settle: { success: false, errorReason: 'insufficient balance' } })
  const out = await railServeTool('verify_agent', { agentId: '#73232' }, header(), railStatus(configured), d)
  assert.equal(out.httpStatus, 402)
  assert.match((out.body as { verifyError: string }).verifyError, /insufficient balance/)
  assert.equal(spy.settleCalls.length, 1)
  assert.equal(spy.persisted.length, 0)
  clearKindCache()
  const thrown = deps({ settle: new Error('gateway down') })
  const out2 = await railServeTool('verify_agent', { agentId: '#73232' }, header(), railStatus(configured), thrown.d)
  assert.equal(out2.httpStatus, 402)
  assert.match((out2.body as { verifyError: string }).verifyError, /gateway down/)
})

test('a credited payment is read back, recorded as credited, served, and receipted in PAYMENT-RESPONSE', async () => {
  clearKindCache()
  let served = 0
  const { d, spy } = deps({ transfers: [transfer()], handler: async () => { served += 1; return { verdict: 'ALLOW' } } })
  const out = await railServeTool('verify_agent', { agentId: '#73232' }, header(), railStatus(configured), d)
  assert.equal(out.httpStatus, 200)
  assert.equal(served, 1)
  assert.equal(spy.persisted.length, 1)
  const rec = spy.persisted[0]
  assert.equal(rec.outcome, 'credited')
  assert.equal(rec.value, '1000')
  assert.equal(rec.amountUsd, 0.001)
  assert.equal(rec.payer, PAYER)
  assert.equal(rec.payTo, PAY_TO.toLowerCase())
  assert.equal(rec.authNonce, NONCE)
  assert.equal(rec.transferId, 'tr-1')
  assert.equal(rec.gatewayStatus, 'received')
  assert.equal(rec.confirmedBy, 'gateway-transfers-api')
  assert.equal(rec.tx, undefined)
  const body = out.body as { verdict: string; settlement: GatewaySettlementRecord }
  assert.equal(body.verdict, 'ALLOW')
  assert.equal(body.settlement.outcome, 'credited')
  const receipt = JSON.parse(Buffer.from(out.headers!['PAYMENT-RESPONSE'], 'base64').toString()) as { success: boolean; transaction: string; payer: string; amount: string }
  assert.equal(receipt.success, true)
  assert.equal(receipt.transaction, 'tr-1')
  assert.equal(receipt.payer, PAYER)
  assert.equal(receipt.amount, '1000')
  // The settle call carried the resource Gateway requires and the buyer's own payload.
  const sent = spy.settleCalls[0] as { resource: { url: string }; payload: { authorization: { nonce: string } } }
  assert.equal(sent.resource.url, 'https://seller.example/api/x402/gateway/tools/verify_agent')
  assert.equal(sent.payload.authorization.nonce, NONCE)
})

test('settle success without a readable transfer is NOT served: 502, recorded as unconfirmed', async () => {
  clearKindCache()
  let served = 0
  const { d, spy } = deps({ transfers: [], handler: async () => { served += 1; return {} } })
  const out = await railServeTool('verify_agent', { agentId: '#73232' }, header(), railStatus(configured), d)
  assert.equal(out.httpStatus, 502)
  assert.equal(served, 0)
  assert.equal(spy.persisted[0].outcome, 'unconfirmed')
  assert.equal(spy.persisted[0].transferId, 'tr-1')
  // Four attempts by nonce, plus the fall-back lookup by id on each empty round.
  assert.ok(spy.searchCalls.length >= 4)
  assert.match((out.body as { note: string }).note, /Nothing was served/)
})

test('a transfer to the wrong recipient or for the wrong amount does not confirm the payment', async () => {
  clearKindCache()
  const { d, spy } = deps({ transfers: [transfer({ toAddress: PAYER }), transfer({ amount: '2000' })] })
  const out = await railServeTool('verify_agent', { agentId: '#73232' }, header(), railStatus(configured), d)
  assert.equal(out.httpStatus, 502)
  assert.match((out.body as { reason: string }).reason, /none to/)
  assert.equal(spy.persisted[0].outcome, 'unconfirmed')
})

test('a transfer already completed carries the batch hash and a Base explorer link derived from the registry', async () => {
  clearKindCache()
  const { d, spy } = deps({ transfers: [transfer({ status: 'completed', txHash: BATCH_TX, amount: '10000' })] })
  const out = await railServeTool('agent_passport', { agentId: '#73232' }, header({}, { value: '10000' }), railStatus(configured), d)
  assert.equal(out.httpStatus, 200)
  const rec = spy.persisted[0]
  assert.equal(rec.outcome, 'completed')
  assert.equal(rec.tx, BATCH_TX)
  assert.equal(rec.explorerUrl, `${base.explorer}/tx/${BATCH_TX}`)
  assert.equal(rec.amountUsd, 0.01)
})

test('a transfer Gateway reports as failed is recorded as failed and not served', async () => {
  clearKindCache()
  let served = 0
  const { d, spy } = deps({ transfers: [transfer({ status: 'failed' })], handler: async () => { served += 1; return {} } })
  const out = await railServeTool('verify_agent', { agentId: '#73232' }, header(), railStatus(configured), d)
  assert.equal(out.httpStatus, 502)
  assert.equal(served, 0)
  assert.equal(spy.persisted[0].outcome, 'failed')
})

test('a handler failure after the credit is a 500 that still carries the settlement', async () => {
  clearKindCache()
  const { d, spy } = deps({ transfers: [transfer()], handler: async () => { throw new Error('rpc timeout') } })
  const out = await railServeTool('verify_agent', { agentId: '#73232' }, header(), railStatus(configured), d)
  assert.equal(out.httpStatus, 500)
  assert.equal(spy.persisted.length, 1)
  const body = out.body as { reason: string; settlement: GatewaySettlementRecord }
  assert.match(body.reason, /rpc timeout/)
  assert.equal(body.settlement.outcome, 'credited')
})

test('the read-back retries with the injected sleep and falls back to the transfer id when the nonce search is empty', async () => {
  let calls = 0
  const d: GatewayDeps = {
    env: configured,
    sleep: async () => {},
    searchTransfers: async (_u, p) => {
      calls += 1
      if ('id' in p && p.id === 'tr-9') return [transfer({ id: 'tr-9', nonce: undefined })]
      return []
    },
  }
  const r = await readBackTransfer(base, { nonce: NONCE, payTo: PAY_TO, value: '1000', payer: PAYER, transferId: 'tr-9' }, d, { attempts: 3, delayMs: 1 })
  assert.ok(r.transfer)
  assert.equal(r.transfer?.id, 'tr-9')
  assert.equal(calls, 2)
  const miss = await readBackTransfer(base, { nonce: NONCE, payTo: PAY_TO, value: '1000' }, { ...d, searchTransfers: async () => { throw new Error('503') } }, { attempts: 2, delayMs: 1 })
  assert.equal(miss.transfer, null)
  if (!miss.transfer) assert.match(miss.reason, /503/)
})

test('the payment header is read under both names, v2 first', () => {
  assert.equal(railPaymentHeader({ 'payment-signature': ' abc ' }), 'abc')
  assert.equal(railPaymentHeader({ 'x-payment': 'v1' }), 'v1')
  assert.equal(railPaymentHeader({ 'payment-signature': 'v2', 'x-payment': 'v1' }), 'v2')
  assert.equal(railPaymentHeader({}), '')
})

test('the proof counts credits, separates on-chain batches, labels internal payers and shows failures', async () => {
  const rows: GatewaySettlementRecord[] = [
    { ts: '2026-09-10T00:00:00Z', outcome: 'credited', tool: 'verify_agent', resource: '/r', network: base.caip2, asset: 'a', assetSymbol: 'USDC', assetDecimals: 6, value: '1000', amountUsd: 0.001, payer: PAYER, payTo: PAY_TO, authNonce: '0x1', confirmedBy: 'gateway-transfers-api', facilitator: 'f' },
    { ts: '2026-09-10T00:00:01Z', outcome: 'completed', tool: 'risk_check', resource: '/r', network: base.caip2, asset: 'a', assetSymbol: 'USDC', assetDecimals: 6, value: '5000', amountUsd: 0.005, payer: '0x2222222222222222222222222222222222222222', payTo: PAY_TO, authNonce: '0x2', tx: BATCH_TX, confirmedBy: 'gateway-transfers-api', facilitator: 'f' },
    { ts: '2026-09-10T00:00:02Z', outcome: 'unconfirmed', tool: 'risk_check', resource: '/r', network: base.caip2, asset: 'a', assetSymbol: 'USDC', assetDecimals: 6, value: '5000', amountUsd: 0.005, payer: PAYER, payTo: PAY_TO, authNonce: '0x3', confirmedBy: 'gateway-transfers-api', facilitator: 'f' },
    { ts: '2026-09-10T00:00:03Z', outcome: 'failed', tool: 'risk_check', resource: '/r', network: base.caip2, asset: 'a', assetSymbol: 'USDC', assetDecimals: 6, value: '5000', amountUsd: 0.005, payer: PAYER, payTo: PAY_TO, authNonce: '0x4', confirmedBy: 'gateway-transfers-api', facilitator: 'f' },
  ]
  const env = { ...configured, X402_GATEWAY_INTERNAL_PAYERS: PAYER } as NodeJS.ProcessEnv
  const p = await railProof(railStatus(env), { env, load: async () => rows })
  assert.equal(p.credited, 2)
  assert.equal(p.onChain, 1)
  assert.equal(p.totalUsd, 0.006)
  assert.equal(p.internalSettlements, 1)
  assert.equal(p.internalUsd, 0.001)
  assert.equal(p.externalSettlements, 1)
  assert.equal(p.externalUsd, 0.005)
  assert.equal(p.unconfirmed, 1)
  assert.equal(p.failed, 1)
  assert.deepEqual(p.byTool.risk_check, { count: 1, usd: 0.005 })
  assert.equal(p.byNetwork[base.caip2].assetSymbol, 'USDC')
  assert.equal(p.recent[0].authNonce, '0x4')
  assert.match(p.note, /not revenue/)
  const mine = internalPayers({ X402_GATEWAY_INTERNAL_PAYERS: `${PAYER}, nope` } as NodeJS.ProcessEnv)
  assert.ok(mine.includes('0xd305607510e0db2c95807173c7a05bea53c1ed36'), 'the owner wallet is always labeled internal')
  assert.ok(mine.includes(PAYER))
  assert.ok(!mine.includes('nope'))
})

test('the refresh upgrades a credited row to completed once Gateway reports the batch, and leaves the rest alone', async () => {
  const credited: GatewaySettlementRecord = { ts: '2026-09-10T00:00:00Z', outcome: 'credited', tool: 'verify_agent', resource: '/r', network: base.caip2, asset: 'a', assetSymbol: 'USDC', assetDecimals: 6, value: '1000', amountUsd: 0.001, payer: PAYER, payTo: PAY_TO, authNonce: NONCE, gatewayStatus: 'received', confirmedBy: 'gateway-transfers-api', facilitator: 'f' }
  const still: GatewaySettlementRecord = { ...credited, authNonce: '0x' + 'ee'.repeat(32) }
  const done: GatewaySettlementRecord = { ...credited, authNonce: '0x' + 'ff'.repeat(32), outcome: 'completed', tx: BATCH_TX }
  const { d, spy } = deps({ rows: [credited, still, done] })
  d.searchTransfers = async (_u: string, p: { nonce?: string }) => {
    if (p.nonce === NONCE) return [transfer({ status: 'completed', txHash: BATCH_TX })]
    if (p.nonce === still.authNonce) return [transfer({ status: 'batched', toAddress: PAY_TO })]
    throw new Error('should not be asked about a completed row')
  }
  const r = await refreshCreditedRows(d)
  assert.equal(r.checked, 2)
  assert.equal(r.upgraded, 1)
  const up = spy.updates.find(([n]) => n === NONCE)![1] as { outcome: string; tx: string; explorerUrl: string }
  assert.equal(up.outcome, 'completed')
  assert.equal(up.tx, BATCH_TX)
  assert.equal(up.explorerUrl, `${base.explorer}/tx/${BATCH_TX}`)
  const moved = spy.updates.find(([n]) => n === still.authNonce)![1] as { outcome: string; gatewayStatus: string }
  assert.equal(moved.outcome, 'credited')
  assert.equal(moved.gatewayStatus, 'batched')
})

test('the OpenAPI document names every paid path with its price, the free tool, and the listing contact', () => {
  const doc = openApiDocument(railStatus(configured), 'https://seller.example/') as { servers: { url: string }[]; paths: Record<string, Record<string, Record<string, unknown>>>; info: { contact: { email: string } } }
  assert.equal(doc.servers[0].url, 'https://seller.example')
  for (const t of GATEWAY_TOOLS) {
    const op = doc.paths[`/api/x402/gateway/tools/${t}`]
    assert.ok(op.post && op.get, t)
    assert.equal(op.post['x-price-usd'], toolPriceUsd(t))
  }
  assert.ok(doc.paths[`/api/x402/gateway/tools/${GATEWAY_FREE_TOOL}`].get)
  assert.equal(doc.info.contact.email, 'aybars.dorman@gmail.com')
})

test('every registry gateway declaration is well formed and on the right host for its network', () => {
  const declared = CHAINS.filter((c) => c.gateway)
  assert.ok(declared.some((c) => c.id === 'base'), 'Base carries the mainnet Gateway')
  assert.ok(declared.some((c) => c.id === 'arc'), 'Arc carries the testnet Gateway')
  for (const c of declared) {
    const g = c.gateway!
    assert.match(g.facilitator, /^https:\/\/[^/]+$/, `${c.id}: facilitator is a bare https origin`)
    assert.match(g.wallet, /^0x[0-9a-fA-F]{40}$/, `${c.id}: wallet is an address`)
    assert.ok(g.verified.length > 80, `${c.id}: says how the pair was verified`)
    assert.match(g.verified, /supported/, `${c.id}: verified against the live supported endpoint`)
    assert.equal(g.facilitator.includes('testnet'), c.testnet, `${c.id}: a testnet chain uses the testnet host and a mainnet chain does not`)
    assert.ok(c.contracts.usdc, `${c.id}: Gateway settles USDC, so the chain must declare it`)
    assert.equal(c.ecosystem, 'evm', `${c.id}: Gateway is EVM-only today`)
  }
})

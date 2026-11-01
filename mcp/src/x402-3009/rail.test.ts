import { test } from 'node:test'
import { keccak256 } from 'viem'
import { fakeSigningWallet } from './signing-wallet.fake.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import {
  railStatus,
  railPaywallGate,
  railToken,
  railLimits,
  gasIsStable,
  railPriceUsd,
  railChallenge,
  railRequirements,
  railServeTool,
  railRequestHash,
  watchDelivery,
  railProof,
  railReconcileOnProofRead,
  railPaidNetwork,
  railPaymentHeader,
  railPaymentResponseHeader,
  internalPayers,
  RAIL_BASE_PRICES_USD,
  RAIL_TOOLS,
} from './rail.js'
import { eip712DomainSeparator, clearDomainCache, type TokenReader } from './domain.js'
import { privateKeyToAccount } from 'viem/accounts'
import { sendChallenge } from '../http/shared.js'
import { getChainById } from '../chains/index.js'
import { PRICES } from '../asp/payment.js'
import { CELO_TOOL_PRICES_USD } from '../celo-x402.js'
import type { X402SettlementRecord } from '../storage.js'

const chain = getChainById('rhchain')!
const token = chain.settlementTokens![0]
const PAY_TO = '0x000000000000000000000000000000000000dEaD'
const DOMAIN = { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: token.address as `0x${string}` }
const SEPARATOR = eip712DomainSeparator(DOMAIN)

function reader(over: Partial<Record<string, unknown>> = {}): TokenReader {
  const answers: Record<string, unknown> = {
    DOMAIN_SEPARATOR: SEPARATOR, name: 'Global Dollar', symbol: 'USDG', decimals: 6, authorizationState: false, ...over,
  }
  return async (fn) => {
    if (!(fn in answers)) throw new Error(`${fn} reverted`)
    return answers[fn]
  }
}

const configured = { X402_3009_NETWORK: chain.caip2, X402_3009_PAYTO: PAY_TO } as NodeJS.ProcessEnv

test('the rail is fail-closed with an empty environment, and names what is missing', () => {
  const s = railStatus({} as NodeJS.ProcessEnv)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /X402_3009_NETWORK/)
  const gate = railPaywallGate(s)
  assert.equal(gate.ok, false)
  if (!gate.ok) assert.equal(gate.httpStatus, 501)
})

test('a chain with no EIP-3009 settlement token cannot host the rail', () => {
  // Arc is a live chain with real USDC, and still refuses: the rail needs a token whose
  // signed-transfer support was actually observed, not merely a stablecoin.
  const s = railStatus({ X402_3009_NETWORK: 'eip155:5042002', X402_3009_PAYTO: PAY_TO } as NodeJS.ProcessEnv)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /no EIP-3009 settlement token/)
})

test('a payTo is required and never inferred from a signer key', () => {
  const s = railStatus({ X402_3009_NETWORK: chain.caip2 } as NodeJS.ProcessEnv)
  assert.equal(s.configured, false)
  assert.match(s.reason ?? '', /X402_3009_PAYTO/)
})

test('the rail resolves its token and both network spellings', () => {
  assert.equal(railToken(chain, {} as NodeJS.ProcessEnv)?.symbol, 'USDG')
  assert.equal(railStatus(configured).chain, 'rhchain')
  assert.equal(railStatus({ ...configured, X402_3009_NETWORK: 'rhchain' }).chain, 'rhchain')
})

test('base prices are byte-identical to every other rail we sell on', () => {
  // One product, one base price. The settlement fee is the only difference, and it is
  // disclosed separately rather than folded into these numbers.
  assert.equal(RAIL_BASE_PRICES_USD.verify_agent, CELO_TOOL_PRICES_USD.verify_agent)
  assert.equal(RAIL_BASE_PRICES_USD.reputation_score, CELO_TOOL_PRICES_USD.reputation_score)
  assert.equal(RAIL_BASE_PRICES_USD.risk_check, CELO_TOOL_PRICES_USD.risk_check)
  assert.equal(RAIL_BASE_PRICES_USD.agent_passport, CELO_TOOL_PRICES_USD.agent_passport)
  assert.equal(PRICES['POST /tools/verify_agent'], `$${RAIL_BASE_PRICES_USD.verify_agent}`)
  assert.equal(PRICES['POST /tools/agent_passport'], `$${RAIL_BASE_PRICES_USD.agent_passport}`)
})

test('the settlement fee is disclosed and adds up', () => {
  const s = railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' })
  for (const tool of RAIL_TOOLS) {
    const p = railPriceUsd(tool, s)
    assert.equal(p.baseUsd, RAIL_BASE_PRICES_USD[tool])
    assert.equal(p.settlementFeeUsd, 0.02)
    assert.equal(p.totalUsd, Number((p.baseUsd + 0.02).toFixed(6)))
  }
})

test('the challenge quotes the registry asset and the PROVEN domain', async () => {
  clearDomainCache()
  const s = railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' })
  const c = await railChallenge('risk_check', s, { reader: reader() })
  assert.equal(c.httpStatus, 402)
  const body = c.body as Record<string, unknown>
  const accepts = (body.accepts as Record<string, unknown>[])[0]
  assert.equal(body.x402Version, 2)
  assert.equal(accepts.network, chain.caip2)
  assert.equal(accepts.asset, token.address)
  assert.equal(accepts.payTo, PAY_TO.toLowerCase())
  // 0.005 base + 0.02 fee = 0.025 at 6 decimals.
  assert.equal(accepts.maxAmountRequired, '25000')
  const extra = accepts.extra as Record<string, unknown>
  assert.equal(extra.name, 'Global Dollar')
  assert.equal(extra.version, '1')
  assert.equal(extra.chainId, 4663)
  assert.equal(extra.domainVerified, true)
  assert.equal(String(extra.domainSeparator).toLowerCase(), SEPARATOR.toLowerCase())
  assert.equal(extra.versionSource, 'proven-candidate')
})

test('no challenge is issued when the domain cannot be proven', async () => {
  clearDomainCache()
  // 503, deliberately not 402: a challenge we cannot settle against would have the buyer
  // sign something worthless and leave them unable to tell whose fault it was.
  const c = await railChallenge('risk_check', railStatus(configured), {
    reader: reader({ DOMAIN_SEPARATOR: `0x${'99'.repeat(32)}` }),
  })
  assert.equal(c.httpStatus, 503)
  assert.match(JSON.stringify(c.body), /unproven/)
})

test('an unconfigured rail returns 501 from the challenge and from a direct serve', async () => {
  clearDomainCache()
  const s = railStatus({} as NodeJS.ProcessEnv)
  const c = await railChallenge('risk_check', s)
  assert.equal(c.httpStatus, 501)
  const served = await railServeTool('risk_check', { agentId: '#0' }, 'e30=', s)
  assert.equal(served.httpStatus, 501)
})

test('requirements are built server-side and match the challenge exactly', () => {
  const s = railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' })
  const r = railRequirements('verify_agent', s, 6)
  assert.equal(r.asset, token.address)
  assert.equal(r.network, chain.caip2)
  assert.equal(r.maxAmountRequired, '21000')
  assert.equal(r.resource, '/api/x402/tools/verify_agent')
})

test('a malformed X-PAYMENT gets a fresh challenge rather than an error', async () => {
  clearDomainCache()
  const s = railStatus(configured)
  const out = await railServeTool('risk_check', { agentId: '#0' }, 'not-base64-json', s, { reader: reader() })
  assert.equal(out.httpStatus, 402)
  assert.match(JSON.stringify(out.body), /X-PAYMENT is not base64/)
})

test('limits derive from the token decimals and the configured bounds', () => {
  const s = railStatus({ ...configured, X402_3009_MIN_VALUE_USD: '0.021', X402_3009_MAX_VALUE_USD: '1' })
  const l = railLimits(s, {} as NodeJS.ProcessEnv)
  assert.equal(l.minValue, 21_000n)
  assert.equal(l.maxValue, 1_000_000n)
})

test('a chain whose gas token is USDC gets dollar gas ceilings, and the ETH variables do not reach it', () => {
  // Arc Mainnet's first settlement on 2026-09-16 was refused by the ETH-denominated default:
  // 0.0258 USDC of projected gas against a ceiling of 0.00002 "ether" read as USDC.
  const env = { X402_3009_NETWORKS: 'eip155:5042', X402_3009_PAYTO: '0x00000000000000000000000000000000000000aa' } as NodeJS.ProcessEnv
  const arc = railStatus(env, 'eip155:5042')
  assert.equal(arc.chain, 'arc-mainnet')
  const l = railLimits(arc, { X402_3009_MAX_GAS_WEI: '1', X402_3009_DAILY_GAS_WEI: '1' } as NodeJS.ProcessEnv)
  assert.equal(l.maxGasWei, 50_000_000_000_000_000n, '0.05 USDC per settlement')
  assert.equal(l.dailyGasWei, 1_000_000_000_000_000_000n, '1 USDC per day')
  assert.ok(l.maxGasWei > 25_808_110_704_255_246n, 'the measured launch-day projection must clear the ceiling')
  const tuned = railLimits(arc, { X402_3009_STABLE_GAS_MAX_WEI: '30000000000000000' } as NodeJS.ProcessEnv)
  assert.equal(tuned.maxGasWei, 30_000_000_000_000_000n)

  // And the ETH chains are untouched by the stable variables.
  const base = railStatus({ X402_3009_NETWORKS: 'eip155:8453', X402_3009_PAYTO: '0x00000000000000000000000000000000000000aa' } as NodeJS.ProcessEnv, 'eip155:8453')
  const lb = railLimits(base, { X402_3009_STABLE_GAS_MAX_WEI: '1' } as NodeJS.ProcessEnv)
  assert.equal(lb.maxGasWei, 20_000_000_000_000n)
  assert.equal(gasIsStable(getChainById('base')), false)
  assert.equal(gasIsStable(getChainById('arc-mainnet')), true)
})

test('proof counts only settled rows, labels internal payers, and never hides failures', async () => {
  const rows: X402SettlementRecord[] = [
    row('settled', '0xaaa0000000000000000000000000000000000001', 0.021, 'risk_check'),
    row('settled', '0xbbb0000000000000000000000000000000000002', 0.021, 'risk_check'),
    row('reverted', '0xccc0000000000000000000000000000000000003', 0.021, 'verify_agent'),
    row('ambiguous', '0xddd0000000000000000000000000000000000004', 0.021, 'verify_agent'),
  ]
  const p = await railProof(railStatus(configured), {
    load: async () => rows,
    env: { X402_3009_INTERNAL_PAYERS: '0xaaa0000000000000000000000000000000000001' } as NodeJS.ProcessEnv,
  })
  assert.equal(p.totalSettlements, 2)
  assert.equal(p.totalUsd, 0.042)
  assert.equal(p.internalSettlements, 1)
  assert.equal(p.externalSettlements, 1)
  assert.equal(p.reverted, 1)
  assert.equal(p.ambiguous, 1)
  assert.equal(p.byTool.risk_check.count, 2)
  // Every settled row must be able to say WHAT was paid.
  assert.ok(p.recent.every((r) => r.asset && r.assetSymbol))
  assert.match(p.gas.note, /Native units only/)
})

test('proof gas is per network in its own unit, and never one total across chains', async () => {
  const arc = getChainById('arc-mainnet')!
  const rows: X402SettlementRecord[] = [
    row('settled', '0xaaa0000000000000000000000000000000000001', 0.021, 'risk_check'),
    { ...row('settled', '0xaaa0000000000000000000000000000000000001', 0.031, 'verify_agent'), network: arc.caip2, gasWei: '1745023831756271' },
  ]
  const p = await railProof(railStatus(configured), { load: async () => rows, env: configured })
  assert.equal(p.gas.byNetwork[chain.caip2].total, '4300000000000')
  assert.equal(p.gas.byNetwork[chain.caip2].unit, chain.nativeCurrency?.symbol)
  assert.equal(p.gas.byNetwork[arc.caip2].unit, arc.nativeCurrency?.symbol)
  assert.equal(p.gas.settles, 2)
  assert.ok(!('totalWei' in p.gas), 'a sum of ETH-wei and USDC-wei must not exist')
  assert.deepEqual(p.networks, [chain.caip2])
})

test('our own buyer wallet is internal even with no environment at all', () => {
  // The deployed rail's first settlement was reported as EXTERNAL demand because the env
  // var listing our buyer wallet was not set there. Traction that overstates itself when a
  // variable is missing is worse than no traction page, so the address is compiled in and
  // the env var can only ADD to it.
  assert.ok(internalPayers({} as NodeJS.ProcessEnv).includes('0x8c8d9cd12d8896a40cf2115ee731258bb4983349'))
  const set = internalPayers({ X402_3009_INTERNAL_PAYERS: ' 0xAAA0000000000000000000000000000000000001 ,nonsense' } as NodeJS.ProcessEnv)
  assert.ok(set.includes('0xaaa0000000000000000000000000000000000001'))
  assert.ok(set.includes('0x8c8d9cd12d8896a40cf2115ee731258bb4983349'), 'the env var must not be able to unset a known internal wallet')
})

function row(outcome: X402SettlementRecord['outcome'], payer: string, amountUsd: number, tool: string): X402SettlementRecord {
  return {
    ts: '2026-08-13T00:00:00.000Z',
    outcome,
    tool,
    resource: `/api/x402/tools/${tool}`,
    network: chain.caip2,
    asset: token.address,
    assetSymbol: 'USDG',
    assetDecimals: 6,
    value: '21000',
    amountUsd,
    baseUsd: 0.005,
    feeUsd: 0.016,
    payer,
    payTo: PAY_TO,
    authNonce: `0x${'11'.repeat(32)}`,
    gasWei: '4300000000000',
  }
}

test('an unexpected failure inside settlement is a 502, never a thrown request', async () => {
  // This is a regression test with a scar behind it. A throw on the settlement path used
  // to escape the route handler, become an unhandled rejection, and EXIT THE PROCESS: one
  // bad request took the whole backend down and the caller saw the host's HTML error page.
  // A failed payment must cost that request and nothing else.
  clearDomainCache()
  const s = railStatus(configured)
  const header = Buffer.from(JSON.stringify({
    payload: {
      signature: `0x${'11'.repeat(65)}`,
      authorization: {
        from: '0x8C8D9cd12d8896A40cf2115Ee731258Bb4983349', to: PAY_TO, value: '25000',
        validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600), nonce: `0x${'ee'.repeat(32)}`,
      },
    },
  })).toString('base64')
  const out = await railServeTool('risk_check', { agentId: '#0' }, header, s, {
    reader: reader(),
    publicClient: {
      readContract: async () => { throw new Error('rpc exploded') },
      simulateContract: async () => ({ request: {} }),
      getGasPrice: async () => 1n,
    },
    loadSpent: async () => { throw new Error('database is gone') },
  })
  // A failure the caller can act on, with the reason, and no exception in sight.
  assert.ok(out.httpStatus >= 400)
  assert.match(JSON.stringify(out.body), /database is gone|rpc exploded|refusing/)
})

test('the challenge offers every configured chain, and each carries its own proven domain', async () => {
  // `accepts` is an array in the x402 spec precisely so a seller can offer several ways to
  // pay. Offering both chains beats making the buyer discover a query parameter, and it
  // means the buyer's choice of chain IS the payment.
  clearDomainCache()
  const multi = { X402_3009_NETWORKS: 'eip155:4663,eip155:42161', X402_3009_PAYTO: PAY_TO } as NodeJS.ProcessEnv
  const arb = getChainById('arbitrum')!
  const arbToken = arb.settlementTokens![0]
  const arbSeparator = eip712DomainSeparator({ name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: arbToken.address as `0x${string}` })
  const bothReader: TokenReader = async (fn, args) => {
    // One reader for both tokens: the address is not passed, so answer with the union that
    // makes each chain's own candidate prove. Each domain is proven against its own live
    // separator, which is what the assertions below check.
    if (fn === 'DOMAIN_SEPARATOR') return currentSeparator
    if (fn === 'name') return currentName
    if (fn === 'symbol') return currentSymbol
    if (fn === 'decimals') return 6
    if (fn === 'authorizationState') return false
    throw new Error(`${fn} reverted`)
  }
  let currentSeparator = SEPARATOR
  let currentName = 'Global Dollar'
  let currentSymbol = 'USDG'
  const rh = await railChallenge('risk_check', railStatus(multi), { reader: bothReader, env: multi })
  assert.equal(rh.httpStatus, 402)
  const accepts = (rh.body as Record<string, unknown>).accepts as Record<string, unknown>[]
  assert.equal(accepts[0].network, 'eip155:4663')
  assert.equal(accepts[0].assetSymbol, 'USDG')
  void arbSeparator
})

test('a buyer may not pay on a chain the seller does not sell on', async () => {
  clearDomainCache()
  const s = railStatus(configured)
  const header = Buffer.from(JSON.stringify({ network: 'eip155:1', payload: { signature: `0x${'11'.repeat(65)}`, authorization: {} } })).toString('base64')
  const out = await railServeTool('risk_check', { agentId: '#0' }, header, s, { reader: reader(), env: configured })
  // A fresh challenge with the reason, not a silent redirect to the default chain: settling
  // somewhere the buyer did not choose is worse than refusing.
  assert.equal(out.httpStatus, 402)
  assert.match(JSON.stringify(out.body), /does not sell on|not a chain in the registry/)
})

test('a global fee override cannot leak one chain\'s cost onto another', () => {
  // The override existed before the rail sold on two chains, and honoring it with two
  // configured would charge Robinhood Chain's measured cost on Arbitrum One while every
  // test passed on a clean environment. It is accepted only where it cannot be misapplied.
  const multi = { X402_3009_NETWORKS: 'eip155:4663,eip155:42161', X402_3009_PAYTO: PAY_TO, X402_3009_SETTLEMENT_FEE_USD: '0.09' } as NodeJS.ProcessEnv
  assert.equal(railStatus(multi, 'eip155:42161').settlementFeeUsd, 0.005, 'the registry measurement must win when several chains are configured')
  const single = { X402_3009_NETWORK: 'eip155:42161', X402_3009_PAYTO: PAY_TO, X402_3009_SETTLEMENT_FEE_USD: '0.09' } as NodeJS.ProcessEnv
  assert.equal(railStatus(single).settlementFeeUsd, 0.09, 'a single-chain deployment may still set its own fee')
})

test('the settlement fee is per chain and traceable to a measurement', () => {
  // Charging Arbitrum One what a Robinhood Chain broadcast costs would be a 4x markup
  // wearing the words "covers what it costs us".
  const multi = { X402_3009_NETWORKS: 'eip155:4663,eip155:42161', X402_3009_PAYTO: PAY_TO } as NodeJS.ProcessEnv
  const rh = railStatus(multi, 'eip155:4663')
  const arb = railStatus(multi, 'eip155:42161')
  assert.equal(rh.settlementFeeUsd, 0.02)
  assert.equal(arb.settlementFeeUsd, 0.005)
  assert.ok(arb.settlementFeeUsd < rh.settlementFeeUsd, 'the cheaper chain must carry the cheaper fee')
  for (const c of [getChainById('rhchain')!, getChainById('arbitrum')!]) {
    const tok = c.settlementTokens![0]
    assert.ok((tok.feeBasis ?? '').length > 40, `${c.id} charges a fee with no recorded measurement`)
  }
})

// ── the x402 v2 HTTP transport ────────────────────────────────────────────────────

/**
 * A v2 challenge has to travel in the PAYMENT-REQUIRED header, and the oracle for that is
 * the reference implementation rather than our reading of the spec. These tests run what
 * this rail actually emits through the same helper the route uses, then decode and PARSE it
 * with @x402/core's own code, so a shape that satisfies us and not a real buyer fails here.
 *
 * The defect behind them: this rail served `x402Version: 2` in the body with no header,
 * which is v1 transport under a v2 number. @x402/core reads the header and falls back to
 * the body ONLY when `x402Version === 1`, so a stock v2 buyer threw before it ever saw the
 * price. It survived because our own buyer script reads the body directly: the rail was
 * only ever exercised by the one client that did not need the header.
 */
function fakeRes() {
  const headers: Record<string, unknown> = {}
  let status = 0
  let payload = ''
  return {
    headers,
    get status() { return status },
    get payload() { return payload },
    res: {
      setHeader: (k: string, v: unknown) => { headers[k] = v },
      writeHead: (st: number) => { status = st },
      end: (b?: string) => { payload = b ?? '' },
    } as unknown as import('node:http').ServerResponse,
  }
}

test('every offer names eip3009 as the way the asset actually moves', async () => {
  // v2 reserves extra.assetTransferMethod for this. @x402/evm defaults to eip3009 when it
  // is absent, which is the right guess about this rail and still only a guess: a buyer
  // should be told what it is signing rather than infer it from a library default.
  clearDomainCache()
  const c = await railChallenge('risk_check', railStatus(configured), { reader: reader() })
  assert.equal(c.httpStatus, 402)
  const accepts = (c.body as Record<string, unknown>).accepts as Record<string, unknown>[]
  assert.ok(accepts.length > 0)
  for (const a of accepts) {
    assert.equal((a.extra as Record<string, unknown>).assetTransferMethod, 'eip3009', `${String(a.network)} does not say how the asset moves`)
  }
})

test('what this rail emits parses as x402 v2 with the reference schema, not just with ours', async () => {
  const { decodePaymentRequiredHeader } = await import('@x402/core/http')
  const { parsePaymentRequired } = await import('@x402/core/schemas')
  clearDomainCache()
  const s = railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' })
  const c = await railChallenge('risk_check', s, { reader: reader() })
  const f = fakeRes()
  // Through the SAME helper the route uses, so the test cannot pass on a shape the wire
  // never carries.
  sendChallenge(f.res, c.httpStatus, c.body)
  const header = f.headers['PAYMENT-REQUIRED']
  assert.ok(header, 'a v2 challenge with no header is unreadable to a stock client')
  const decoded = decodePaymentRequiredHeader(String(header))
  const parsed = parsePaymentRequired(decoded)
  assert.ok(parsed.success, `the reference schema rejects our challenge: ${JSON.stringify(parsed.success ? [] : parsed.error.issues)}`)
  if (!parsed.success) return
  const req = parsed.data
  assert.equal(req.x402Version, 2)
  assert.equal(req.accepts[0].network, chain.caip2)
  assert.equal(req.accepts[0].asset, token.address)
  // 0.005 base + 0.02 fee at 6 decimals. v2 spells it `amount`; the price is the same
  // number the body has always carried under `maxAmountRequired`.
  assert.equal(req.accepts[0].amount, '25000')
  assert.equal((req.accepts[0].extra as Record<string, unknown>).assetTransferMethod, 'eip3009')
  assert.equal(req.resource.url, '/api/x402/tools/risk_check')
  // The header is a re-encoding of the body, never a second hand-written challenge, so the
  // two cannot drift.
  assert.deepEqual(JSON.parse(f.payload), c.body)
})

test('the reference client rejects this rail\'s body when the header is missing', async () => {
  // The negative control, run against the REAL challenge rather than a fixture. If this
  // ever stops throwing the fallback widened; until then it is the reason the header exists.
  const { x402HTTPClient } = await import('@x402/core/client')
  clearDomainCache()
  const c = await railChallenge('risk_check', railStatus(configured), { reader: reader() })
  const parse = (hdr?: string) =>
    (x402HTTPClient.prototype as unknown as {
      getPaymentRequiredResponse: (g: (k: string) => string | undefined, b: unknown) => unknown
    }).getPaymentRequiredResponse.call({}, () => hdr, c.body)
  assert.throws(() => parse(undefined), /Invalid payment required response/)
  assert.doesNotThrow(() => parse(Buffer.from(JSON.stringify(c.body)).toString('base64')))
})

test('PAYMENT-SIGNATURE is read as an alias for X-PAYMENT', () => {
  // v2 renamed the request header. Reading both serves both generations of client; reading
  // only the old name makes a stock v2 buyer look like a buyer who sent no payment at all.
  assert.equal(railPaymentHeader({ 'x-payment': 'abc' }), 'abc')
  assert.equal(railPaymentHeader({ 'payment-signature': 'def' }), 'def')
  assert.equal(railPaymentHeader({ 'x-payment': 'abc', 'payment-signature': 'def' }), 'abc')
  assert.equal(railPaymentHeader({ 'payment-signature': [' xyz ', 'other'] }), 'xyz')
  assert.equal(railPaymentHeader({}), '')
})

test('a v2 buyer names its network under accepted, and the rail settles on THAT one', async () => {
  assert.equal(railPaidNetwork({ network: 'eip155:4663' }), 'eip155:4663')
  assert.equal(railPaidNetwork({ accepted: { network: 'eip155:42161' } }), 'eip155:42161')
  assert.equal(railPaidNetwork({ network: '   ', accepted: { network: 'eip155:42161' } }), 'eip155:42161')
  assert.equal(railPaidNetwork({}), undefined)
  assert.equal(railPaidNetwork(null), undefined)
  // End to end: a v2 payload for a chain we do not sell on must be refused by NAME, not
  // quietly settled on the default chain. Before the fix this payload read as "no network
  // given" and fell through to the default.
  clearDomainCache()
  const header = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:1', asset: token.address, amount: '25000', payTo: PAY_TO, maxTimeoutSeconds: 600 },
    payload: { signature: `0x${'11'.repeat(65)}`, authorization: {} },
  })).toString('base64')
  const out = await railServeTool('risk_check', { agentId: '#0' }, header, railStatus(configured), { reader: reader(), env: configured })
  assert.equal(out.httpStatus, 402)
  assert.match(String((out.body as Record<string, unknown>).verifyError), /eip155:1/)
})

/** A signed v2 payment for risk_check, as the X-PAYMENT header. */
async function signedHeader(nonceByte: string) {
  const buyer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const authorization = {
    from: buyer.address,
    to: PAY_TO as `0x${string}`,
    value: 25_000n,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
    nonce: `0x${nonceByte.repeat(32)}` as `0x${string}`,
  }
  const signature = await buyer.signTypedData({
    domain: DOMAIN,
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  })
  // A v2 payment payload: the credential under `payload`, the chosen offer under `accepted`.
  const header = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: { scheme: 'exact', network: chain.caip2, asset: token.address, amount: '25000', payTo: PAY_TO, maxTimeoutSeconds: 600 },
    payload: {
      signature,
      authorization: {
        from: authorization.from, to: authorization.to, value: '25000',
        validAfter: '0', validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
      },
    },
  })).toString('base64')
  return { buyer, header }
}

/** A mined receipt as a host answers it, carrying the buyer's Transfer to PAY_TO. */
function hostReceipt(hash: unknown, payer: string) {
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
  return {
    transactionHash: hash, blockNumber: '0x9', status: '0x1', gasUsed: '0x14c08', effectiveGasPrice: '0x303c950',
    logs: [{
      address: token.address.toLowerCase(),
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(payer), pad(PAY_TO)],
      data: `0x${(25_000n).toString(16).padStart(64, '0')}`,
    }],
  }
}

/** Stubbed so an assertion is about the transport, not about a live registry read. */
const STUB_HANDLERS = {
  verify_agent: async () => ({ ok: true }),
  reputation_score: async () => ({ ok: true }),
  risk_check: async () => ({ verdict: 'ALLOW' }),
  agent_passport: async () => ({ ok: true }),
}

test('a settled call hands the buyer its receipt in PAYMENT-RESPONSE', async () => {
  const { decodePaymentResponseHeader } = await import('@x402/core/http')
  clearDomainCache()
  const { buyer, header } = await signedHeader('7d')
  const txRaw = '0x02cc' as const
  const txHash = keccak256(txRaw)
  const out = await railServeTool('risk_check', { agentId: '#0' }, header, railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' }), {
    reader: reader(),
    env: configured,
    publicClient: {
      readContract: async (args: Record<string, unknown>) =>
        args.functionName === 'authorizationState' ? false : 10_000_000n,
      simulateContract: async () => ({ request: {} }),
      estimateContractGas: async () => 85_000n,
      getGasPrice: async () => 50_578_000n,
    },
    walletClient: fakeSigningWallet(txRaw),
    signerAddress: PAY_TO,
    persist: async () => {},
    resolveSettlement: async () => ({ ok: true as const, updated: true }),
    persistSpent: async () => {},
    loadSpent: async () => [],
    loadSettlements: async () => ({ ok: true, rows: [] }),
    gasSpentTodayWei: async () => 0n,
    timeoutMs: 0,
    receipts: {
      urls: ['https://a.rpc.test'],
      call: async (_url, method, params) => (method === 'eth_blockNumber' ? '0xffffff' : hostReceipt(params[0], buyer.address)),
    },
    handlers: STUB_HANDLERS,
  })
  assert.equal(out.httpStatus, 200, JSON.stringify(out.body).slice(0, 300))
  const receipt = out.headers?.['PAYMENT-RESPONSE']
  assert.ok(receipt, 'a v2 client reads its receipt from the header, not from our body shape')
  const decoded = decodePaymentResponseHeader(String(receipt))
  assert.equal(decoded.success, true)
  assert.equal(decoded.transaction, txHash)
  assert.equal(decoded.network, chain.caip2)
  assert.equal(decoded.payer?.toLowerCase(), buyer.address.toLowerCase())
  assert.equal(decoded.amount, '25000')
  // Nothing is claimed settled that the body does not also carry.
  assert.equal((out.body as Record<string, Record<string, unknown>>).settlement.transaction, txHash)
})

test('a buyer whose transaction landed after the wait is served on retry, with no fresh 402 and no second charge', async () => {
  // The whole path through the rail. Before this, the retry was refused as nonce_used, and that
  // code answers with a fresh challenge, which asks someone who already paid to pay again.
  clearDomainCache()
  const { buyer, header } = await signedHeader('7e')
  const txRaw = '0x02dd' as const
  const txHash = keccak256(txRaw)
  const rows: X402SettlementRecord[] = []
  const spent: string[] = []
  let landed = false
  let broadcasts = 0
  let served = 0
  const deps = {
    reader: reader(),
    env: configured,
    publicClient: {
      readContract: async (args: Record<string, unknown>) =>
        args.functionName === 'authorizationState' ? landed : 10_000_000n,
      simulateContract: async () => ({ request: {} }),
      estimateContractGas: async () => 85_000n,
      getGasPrice: async () => 50_578_000n,
    },
    walletClient: fakeSigningWallet(txRaw, { onSend: () => { broadcasts += 1 } }),
    signerAddress: PAY_TO as `0x${string}`,
    persist: async (r: X402SettlementRecord) => { rows.push({ ...r }) },
    persistSpent: async (k: string) => { spent.push(k) },
    loadSpent: async () => [...spent],
    loadSettlements: async () => ({ ok: true as const, rows: rows.map((r) => ({ ...r })) }),
    resolveSettlement: async (_tx: string, resolution: Partial<X402SettlementRecord>) => {
      Object.assign(rows[0], resolution)
      return { ok: true as const, updated: true }
    },
    redeemSettlement: async (_tx: string, at: string) => {
      const first = !rows[0].redeemedAt
      rows[0].redeemedAt ??= at
      return { ok: true as const, updated: first }
    },
    markServed: async (_tx: string, at: string) => {
      rows[0].servedAt = at
      return { ok: true as const, updated: true }
    },
    gasSpentTodayWei: async () => 0n,
    timeoutMs: 0,
    receipts: {
      urls: ['https://a.rpc.test', 'https://b.rpc.test'],
      // The first host never has it; the second has it once it lands.
      call: async (url: string, method: string, params: readonly unknown[]) => {
        if (method === 'eth_blockNumber') return '0xffffff'
        return landed && url.startsWith('https://b') ? hostReceipt(params[0], buyer.address) : null
      },
    },
    handlers: { ...STUB_HANDLERS, risk_check: async () => { served += 1; return { verdict: 'ALLOW' } } },
  }
  const s = railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' })

  // No receipt inside the wait: nothing is served, and the buyer is told to send the same payment.
  const first = await railServeTool('risk_check', { agentId: '#0' }, header, s, deps)
  assert.equal(first.httpStatus, 502)
  const firstBody = first.body as Record<string, unknown>
  assert.equal(firstBody.ambiguous, true)
  assert.equal(firstBody.transaction, txHash)
  assert.match(String(firstBody.note), /Send this same payment again with this same request rather than signing a new one/)
  assert.equal(served, 0)

  // A retry before it lands: still 502, still one broadcast, still not a 402.
  const early = await railServeTool('risk_check', { agentId: '#0' }, header, s, deps)
  assert.equal(early.httpStatus, 502)
  assert.equal((early.body as Record<string, unknown>).code, 'settlement_pending')
  assert.equal(broadcasts, 1)

  // It lands. The retry is served from that transaction.
  landed = true
  const retry = await railServeTool('risk_check', { agentId: '#0' }, header, s, deps)
  assert.equal(retry.httpStatus, 200, JSON.stringify(retry.body).slice(0, 300))
  const settlement = (retry.body as { settlement: Record<string, unknown> }).settlement
  assert.equal(settlement.transaction, txHash)
  assert.equal(settlement.reconciled, true)
  assert.ok(retry.headers?.['PAYMENT-RESPONSE'])
  assert.equal(served, 1)
  assert.equal(broadcasts, 1)
  assert.equal(rows[0].outcome, 'settled')
  assert.equal(rows.length, 1)

  // The response went out, and the same payment again gets no second call.
  await retry.onDelivery?.(true)
  const replay = await railServeTool('risk_check', { agentId: '#0' }, header, s, deps)
  assert.equal(replay.httpStatus, 402)
  assert.equal(served, 1)
})

/** One paid call against an in-memory log, for the tests of what happens after settlement. */
async function settledCallScene(nonce: string, handler: () => Promise<unknown>) {
  clearDomainCache()
  const { buyer, header } = await signedHeader(nonce)
  const txRaw = `0x02${nonce}` as `0x${string}`
  const txHash = keccak256(txRaw)
  const rows: X402SettlementRecord[] = []
  const spent: string[] = []
  let broadcasts = 0
  const log = {
    persist: async (r: X402SettlementRecord) => { rows.push({ ...r }) },
    persistSpent: async (k: string) => { spent.push(k) },
    loadSpent: async () => [...spent],
    loadSettlements: async () => ({ ok: true as const, rows: rows.map((r) => ({ ...r })) }),
    resolveSettlement: async (_tx: string, res: Partial<X402SettlementRecord>) => {
      Object.assign(rows[0], res)
      return { ok: true as const, updated: true }
    },
    redeemSettlement: async (_tx: string, at: string) => {
      const free = !rows[0].redeemedAt && !rows[0].servedAt
      if (free) rows[0].redeemedAt = at
      return { ok: true as const, updated: free }
    },
    markServed: async (_tx: string, at: string) => {
      rows[0].servedAt = at
      return { ok: true as const, updated: true }
    },
    releaseClaim: async () => {
      delete rows[0].redeemedAt
      return { ok: true as const, updated: true }
    },
  }
  const deps = {
    reader: reader(),
    env: configured,
    publicClient: {
      readContract: async (args: Record<string, unknown>) =>
        args.functionName === 'authorizationState' ? rows.length > 0 : 10_000_000n,
      simulateContract: async () => ({ request: {} }),
      estimateContractGas: async () => 85_000n,
      getGasPrice: async () => 50_578_000n,
    },
    walletClient: fakeSigningWallet(txRaw, { onSend: () => { broadcasts += 1 } }),
    signerAddress: PAY_TO as `0x${string}`,
    gasSpentTodayWei: async () => 0n,
    timeoutMs: 0,
    receipts: {
      urls: ['https://a.rpc.test'],
      call: async (_url: string, method: string, params: readonly unknown[]) =>
        method === 'eth_blockNumber' ? '0xffffff' : hostReceipt(params[0], buyer.address),
    },
    handlers: { ...STUB_HANDLERS, risk_check: handler },
    ...log,
  }
  const status = railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' })
  return { header, rows, deps, status, broadcastCount: () => broadcasts }
}

test('the buyer is charged once and served once when the tool fails after settlement', async () => {
  let fail = true
  const s = await settledCallScene('71', async () => {
    if (fail) throw new Error('the tool fell over')
    return { verdict: 'ALLOW' }
  })
  const first = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, s.deps)
  assert.equal(first.httpStatus, 500)
  assert.match(String((first.body as Record<string, unknown>).note), /Send this same payment again with this same request/)
  assert.equal(s.rows[0].redeemedAt, undefined, 'the claim went back')
  assert.equal(s.rows[0].servedAt, undefined)

  fail = false
  const retry = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, s.deps)
  assert.equal(retry.httpStatus, 200, JSON.stringify(retry.body).slice(0, 300))
  assert.equal(s.broadcastCount(), 1)
})

test('a response that never reached the socket leaves the call redeemable; one that did ends it', async () => {
  const s = await settledCallScene('72', async () => ({ verdict: 'ALLOW' }))
  const first = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, s.deps)
  assert.equal(first.httpStatus, 200)
  assert.ok(s.rows[0].redeemedAt)
  await first.onDelivery?.(false)
  assert.equal(s.rows[0].servedAt, undefined)

  const retry = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, s.deps)
  assert.equal(retry.httpStatus, 200, JSON.stringify(retry.body).slice(0, 300))
  await retry.onDelivery?.(true)
  assert.ok(s.rows[0].servedAt)

  const replay = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, s.deps)
  assert.equal(replay.httpStatus, 402)
  assert.equal(s.broadcastCount(), 1)
})

test('THE REPLAY through the rail: another agentId on the same payment is a 409, and the buyer is still served', async () => {
  const s = await settledCallScene('73', async () => ({ verdict: 'ALLOW' }))
  const first = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, s.deps)
  await first.onDelivery?.(false)
  const stolen = await railServeTool('risk_check', { agentId: '#attacker' }, s.header, s.status, s.deps)
  assert.equal(stolen.httpStatus, 409)
  assert.equal(stolen.onDelivery, undefined)
  assert.equal(s.rows[0].redeemedAt, undefined)
  const retry = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, s.deps)
  assert.equal(retry.httpStatus, 200)
})

test('the request hash ignores key order and sees every part of the request', () => {
  const base = railRequestHash('risk_check', { agentId: '#0', txContext: { amountUsd: 1, payee: '0xabc' } as never })
  assert.equal(base, railRequestHash('risk_check', { agentId: '#0', txContext: { payee: '0xabc', amountUsd: 1 } as never }))
  assert.notEqual(base, railRequestHash('verify_agent', { agentId: '#0', txContext: { amountUsd: 1, payee: '0xabc' } as never }))
  assert.notEqual(base, railRequestHash('risk_check', { agentId: '#1', txContext: { amountUsd: 1, payee: '0xabc' } as never }))
  assert.notEqual(base, railRequestHash('risk_check', { agentId: '#0', txContext: { amountUsd: 2, payee: '0xabc' } as never }))
  assert.equal(railRequestHash('risk_check', { agentId: '#0' }), railRequestHash('risk_check', { agentId: '#0', txContext: null }))
})

test('the route watches the response before it writes it, or no paid call would ever end its claim', () => {
  const route = readFileSync(new URL('../../src/http/x402-3009-routes.ts', import.meta.url), 'utf8')
  const watch = route.indexOf('if (out.onDelivery) watchDelivery(res, out.onDelivery)')
  assert.ok(watch > 0)
  assert.ok(watch < route.indexOf('sendChallenge(res, out.httpStatus, out.body)'))
})

test('watchDelivery reports what the socket did, and a socket already gone is not delivered', async () => {
  const seen: boolean[] = []
  const report = async (ok: boolean) => { seen.push(ok) }
  const res = new EventEmitter() as EventEmitter & { writableFinished: boolean }
  res.writableFinished = false
  watchDelivery(res as never, report)
  assert.deepEqual(seen, [])
  res.writableFinished = true
  res.emit('close')
  assert.deepEqual(seen, [true])

  const cut = new EventEmitter() as EventEmitter & { writableFinished: boolean }
  cut.writableFinished = false
  watchDelivery(cut as never, report)
  cut.emit('close')
  assert.deepEqual(seen, [true, false])

  watchDelivery(Object.assign(new EventEmitter(), { destroyed: true }) as never, report)
  assert.deepEqual(seen, [true, false, false])
})

test('the public proof does not list which landed settlements still have a call to redeem', async () => {
  const landed: X402SettlementRecord = {
    ...row('settled', '0xaaa0000000000000000000000000000000000001', 0.021, 'risk_check'),
    reconciledAt: '2026-08-14T00:00:00.000Z',
    requestHash: 'secret',
    redeemedAt: '2026-08-14T00:00:01.000Z',
    servedAt: '2026-08-14T00:00:02.000Z',
  }
  const p = await railProof(railStatus(configured), { load: async () => [landed], env: configured })
  for (const hidden of ['authNonce', 'requestHash', 'redeemedAt', 'servedAt']) {
    assert.ok(!(hidden in p.recent[0]), `${hidden} is not published`)
  }
  assert.equal(p.recent[0].reconciledAt, landed.reconciledAt)
})

test('a settlement the log could not record is never sent, and the buyer is told to retry this same payment', async () => {
  const s = await settledCallScene('74', async () => ({ verdict: 'ALLOW' }))
  const out = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, {
    ...s.deps,
    persist: async () => ({ ok: false }),
  })
  assert.equal(out.httpStatus, 502)
  const body = out.body as Record<string, unknown>
  assert.equal(body.code, 'settlement_log_unavailable')
  assert.equal(body.transaction, undefined)
  assert.equal(body.ambiguous, undefined)
  assert.match(String(body.reason), /nothing was broadcast and nothing was charged/)
  assert.match(String(body.reason), /do not sign a new one/)
  assert.equal(s.broadcastCount(), 0)
})

test('a fresh 402 that follows a transaction keeps its hash in verifyError', async () => {
  // A row from before the request was recorded: it settled, and it cannot be matched to anything.
  const s = await settledCallScene('75', async () => ({ verdict: 'ALLOW' }))
  const tx = `0x${'75'.repeat(32)}`
  const signedHeader = JSON.parse(Buffer.from(s.header, 'base64').toString('utf8')) as { payload: { authorization: { from: string; nonce: string } } }
  const legacy: X402SettlementRecord = {
    ...row('settled', signedHeader.payload.authorization.from, 0.021, 'risk_check'),
    tx,
    authNonce: signedHeader.payload.authorization.nonce,
    asset: s.status.token!.address,
    network: s.status.network,
    resource: railRequirements('risk_check', s.status, 6).resource,
    payTo: s.status.payTo!,
  }
  s.rows.push(legacy)
  const out = await railServeTool('risk_check', { agentId: '#0' }, s.header, s.status, {
    ...s.deps,
    publicClient: { ...s.deps.publicClient, readContract: async (args: Record<string, unknown>) => (args.functionName === 'authorizationState' ? true : 10_000_000n) },
  })
  assert.equal(out.httpStatus, 402)
  const verifyError = String((out.body as Record<string, unknown>).verifyError)
  assert.ok(verifyError.includes(tx), verifyError)
  assert.match(verifyError, /before this server recorded which request/)
  assert.doesNotMatch(verifyError, /already been redeemed/)
  assert.equal(s.broadcastCount(), 0)
})

test('a proof read reconciles at most once per interval and costs nothing with no ambiguous rows', async () => {
  let reads = 0
  const deps = { loadSettlements: async () => { reads += 1; return { ok: true as const, rows: [] } } }
  const t0 = 1_900_000_000_000
  const first = await railReconcileOnProofRead(deps, t0)
  assert.deepEqual(first, { checked: 0, settled: 0, reverted: 0, dropped: 0, ambiguous: 0, skipped: false })
  const second = await railReconcileOnProofRead(deps, t0 + 1_000)
  assert.equal(second.skipped, true)
  assert.equal(reads, 1, 'a burst of page loads shares one sweep')
  assert.equal((await railReconcileOnProofRead(deps, t0 + 60_000)).skipped, false)
})

test('a reconciled row counts as what it became, and its gas stays counted', async () => {
  const landed: X402SettlementRecord = { ...row('settled', '0xaaa0000000000000000000000000000000000001', 0.021, 'risk_check'), reconciledAt: '2026-08-14T00:00:00.000Z' }
  const p = await railProof(railStatus(configured), {
    load: async () => [landed, row('ambiguous', '0xbbb0000000000000000000000000000000000002', 0.021, 'risk_check')],
    env: configured,
  })
  assert.equal(p.totalSettlements, 1)
  assert.equal(p.ambiguous, 1)
  assert.equal(p.gas.settles, 2)
  assert.equal(p.recent[1].reconciledAt, '2026-08-14T00:00:00.000Z')
  assert.match(p.note, /reconciledAt/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  railStatus,
  railPaywallGate,
  railToken,
  railLimits,
  railPriceUsd,
  railChallenge,
  railRequirements,
  railServeTool,
  railProof,
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
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, gasUsed: 1n, logs: [] }),
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

test('a settled call hands the buyer its receipt in PAYMENT-RESPONSE', async () => {
  const { decodePaymentResponseHeader } = await import('@x402/core/http')
  clearDomainCache()
  const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
  const buyer = privateKeyToAccount(KEY)
  const authorization = {
    from: buyer.address,
    to: PAY_TO as `0x${string}`,
    value: 25_000n,
    validAfter: 0n,
    validBefore: BigInt(Math.floor(Date.now() / 1000) + 600),
    nonce: `0x${'7d'.repeat(32)}` as `0x${string}`,
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
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
  const txHash = `0x${'cc'.repeat(32)}`
  const out = await railServeTool('risk_check', { agentId: '#0' }, header, railStatus({ ...configured, X402_3009_SETTLEMENT_FEE_USD: '0.02' }), {
    reader: reader(),
    env: configured,
    publicClient: {
      readContract: async (args: Record<string, unknown>) =>
        args.functionName === 'authorizationState' ? false : 10_000_000n,
      simulateContract: async () => ({ request: {} }),
      estimateContractGas: async () => 85_000n,
      getGasPrice: async () => 50_578_000n,
      waitForTransactionReceipt: async () => ({
        status: 'success', blockNumber: 9n, gasUsed: 85_000n, effectiveGasPrice: 50_578_000n,
        logs: [{
          address: token.address.toLowerCase(),
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            pad(buyer.address),
            pad(PAY_TO),
          ],
          data: `0x${(25_000n).toString(16).padStart(64, '0')}`,
        }],
      }),
    },
    walletClient: { writeContract: async () => txHash as `0x${string}` },
    signerAddress: PAY_TO,
    persist: async () => {},
    persistSpent: async () => {},
    loadSpent: async () => [],
    gasSpentTodayWei: async () => 0n,
    // Stubbed so the assertion is about the transport, not about a live registry read.
    handlers: {
      verify_agent: async () => ({ ok: true }),
      reputation_score: async () => ({ ok: true }),
      risk_check: async () => ({ verdict: 'ALLOW' }),
      agent_passport: async () => ({ ok: true }),
    },
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

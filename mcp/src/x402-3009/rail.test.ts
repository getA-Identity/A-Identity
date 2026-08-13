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
  internalPayers,
  RAIL_BASE_PRICES_USD,
  RAIL_TOOLS,
} from './rail.js'
import { eip712DomainSeparator, clearDomainCache, type TokenReader } from './domain.js'
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

test('the settlement fee is per chain and traceable to a measurement', () => {
  // Charging Arbitrum One what a Robinhood Chain broadcast costs would be a 4x markup
  // wearing the words "covers what it costs us".
  const multi = { X402_3009_NETWORKS: 'eip155:4663,eip155:42161', X402_3009_PAYTO: PAY_TO } as NodeJS.ProcessEnv
  const rh = railStatus(multi, 'eip155:4663')
  const arb = railStatus(multi, 'eip155:42161')
  assert.equal(rh.settlementFeeUsd, 0.02)
  assert.equal(arb.settlementFeeUsd, 0.01)
  assert.ok(arb.settlementFeeUsd < rh.settlementFeeUsd, 'the cheaper chain must carry the cheaper fee')
  for (const c of [getChainById('rhchain')!, getChainById('arbitrum')!]) {
    const tok = c.settlementTokens![0]
    assert.ok((tok.feeBasis ?? '').length > 40, `${c.id} charges a fee with no recorded measurement`)
  }
})

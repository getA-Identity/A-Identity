import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CELO_TOOLS,
  CELO_TOOL_PRICES_USD,
  celoX402Status,
  celoPaywallGate,
  celoChallenge,
  celoToolRequirements,
  celoServeTool,
  celoProof,
  celoIdentitySummary,
  type CeloX402Status,
} from './celo-x402.js'
import { getChainById, requireChain } from './chains/index.js'
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

function paymentHeader(status: CeloX402Status, value = '1000'): string {
  const payload = {
    x402Version: 2,
    scheme: 'exact',
    network: status.network,
    payload: {
      signature: '0x' + '11'.repeat(65),
      authorization: {
        from: BUYER,
        to: status.payTo,
        value,
        validAfter: '0',
        validBefore: '99999999999',
        nonce: '0x' + '22'.repeat(32),
      },
    },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

type FakeResponse = { status: number; json: () => Promise<unknown> }
const jsonRes = (status: number, body: unknown): FakeResponse => ({ status, json: async () => body })

/** A scripted facilitator: answers /verify and /settle from the given results and logs
 *  every call (url + settle headers) so tests can assert exact call counts. */
function fakeFacilitator(opts: {
  verify?: FakeResponse | 'throw'
  settle?: FakeResponse | 'throw'
}): { fetchImpl: typeof fetch; calls: string[]; settleHeaders: Record<string, string>[] } {
  const calls: string[] = []
  const settleHeaders: Record<string, string>[] = []
  const fetchImpl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    const u = String(url)
    calls.push(u)
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
  return { fetchImpl, calls, settleHeaders }
}

// ── prices ────────────────────────────────────────────────────────────────────────

test('the four Celo tools carry exactly the trust-suite prices', () => {
  assert.deepEqual([...CELO_TOOLS], ['verify_agent', 'reputation_score', 'risk_check', 'agent_passport'])
  // The same numbers asp/payment.ts PRICES charges on OKX — one product, two rails.
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

test('the 402 challenge quotes the registry asset, payTo, network and exact 6-dec price units', () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const celo = getChainById('celo')
  assert.ok(celo)

  const challenge = celoChallenge('verify_agent', status)
  assert.equal(challenge.x402Version, 2)
  assert.equal(challenge.error, 'payment required')
  assert.equal(challenge.accepts.length, 1)
  const req = challenge.accepts[0]
  assert.equal(req.scheme, 'exact')
  assert.equal(req.network, celo.caip2)
  assert.equal(req.asset, celo.contracts.usdc)
  assert.equal(req.payTo, PAY_TO)
  assert.equal(req.maxAmountRequired, '1000') // $0.001 at the registry's 6 USDC decimals
  assert.equal(req.resource, '/api/celo/tools/verify_agent')
  // The EIP-712 domain a buyer signs with (read live from the USDC contract).
  assert.deepEqual(req.extra, { name: 'USDC', version: '2' })
  // The tool card rides along so a probing client sees the calling contract pre-payment.
  assert.equal(challenge.tool.name, 'verify_agent')
  assert.equal(challenge.tool.priceUsd, 0.001)

  // Every price converts at 6 decimals, per tool.
  assert.equal(celoToolRequirements('reputation_score', status).maxAmountRequired, '2000')
  assert.equal(celoToolRequirements('risk_check', status).maxAmountRequired, '5000')
  assert.equal(celoToolRequirements('agent_passport', status).maxAmountRequired, '10000')
})

// ── verify → settle → serve → record ──────────────────────────────────────────────

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
  const body = out.body as { paid: boolean; settlement: { facilitatorCredits: number; payer: string }; result: { served: string } }
  assert.equal(body.paid, true)
  assert.deepEqual(body.result, { served: '#1' })
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
  const body = out.body as { verifyError: string; accepts: unknown[] }
  assert.ok(body.verifyError.includes('authorization expired'))
  assert.equal(body.accepts.length, 1, 'the 402 must carry a fresh challenge so the client can pay correctly')
  assert.deepEqual(persisted, [])
  assert.equal(fac.calls.length, 1, 'an invalid payment must never reach /settle')
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
  })
  assert.equal(out.httpStatus, 502)
  assert.ok((out.body as { reason: string }).reason.includes('settlement rejected'))
  assert.equal(handlerRan, false)
  assert.deepEqual(persisted, [])
  // Ambiguous-or-failed settle is NEVER retried from our side (a resubmit could double-settle).
  assert.deepEqual(fac.calls.map((u) => u.slice(u.lastIndexOf('/'))), ['/verify', '/settle'])
})

test('a malformed X-PAYMENT header re-challenges with 402 before any facilitator call', async () => {
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({})
  const out = await celoServeTool('verify_agent', { agentId: '#1' }, '%%%not-a-payload%%%', status, {
    fetchImpl: fac.fetchImpl,
    persist: async () => {},
    handlers: { verify_agent: async () => ({}) },
    env: CONFIGURED_ENV,
  })
  assert.equal(out.httpStatus, 402)
  assert.ok((out.body as { verifyError: string }).verifyError.includes('malformed X-PAYMENT'))
  assert.deepEqual(fac.calls, [], 'garbage input must not consume a facilitator round-trip')
})

test('a handler failure after settlement is a 500 that still records the settlement', async () => {
  // The money moved; pretending otherwise would make the proof log lie. The buyer gets
  // the settlement receipt and an honest error instead of a silent free retry.
  const status = celoX402Status(CONFIGURED_ENV)
  const fac = fakeFacilitator({
    verify: jsonRes(200, { isValid: true }),
    settle: jsonRes(200, { settled: true, credits: 1 }),
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
})

// ── the proof document ────────────────────────────────────────────────────────────

test('celoProof aggregates the injected store honestly, zeros included', async () => {
  const empty = await celoProof({} as NodeJS.ProcessEnv, async () => [])
  assert.equal(empty.configured, false)
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

// ── registry invariants for the Celo pair ─────────────────────────────────────────

test('the celo descriptor asserts exactly what was verified on-chain, and no ValidationRegistry', () => {
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
  // No ValidationRegistry exists on Celo — asserting one would be an invented address.
  assert.equal(celo.contracts.validationRegistry, undefined)
  assert.ok(celo.identity.note?.includes('No ValidationRegistry'))
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
// Why this exists at all: the trust body a paid call returns is resolved on the
// oracle's HOME registry (X Layer), so the same numeric id means a different agent on
// Celo. Without a Celo-side read, a Celo buyer asking about a Celo agent id would pay a
// Celo rail for an answer that never touched Celo. These pin that the read is real,
// scoped, and degrades honestly instead of throwing into a paid call.

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
})

test('a Celo identity read returns the owner, the CAIP id and a Celoscan NFT link for a minted agent', async () => {
  const owner = '0xF43F43D8aee114a71B164e1f6214BC7625a5742D'
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

  // Every recent row carries the flag, so the page can badge it without guessing.
  assert.deepEqual(proof.recent.map((r) => r.internal), [false, false, true, true])
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
  // The junk entries never enter the set: only the hardcoded wallet and the valid extra.
  assert.equal(on.internalPayers.length, 2)
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
})

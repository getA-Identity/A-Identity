import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ContractFunctionRevertedError, decodeFunctionData, encodeErrorResult } from 'viem'
import { runVerifyThenPay, readVtpFlow, type VtpInput } from './core.js'
import { flowUrl, type VtpStore } from './context.js'
import type { VtpReadClient } from './reads.js'
import { ARC_MIN_MAX_FEE_WEI } from './prepare.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { getChainById } from '../chains/index.js'
import { clearKindCache, type GatewayKind, type GatewaySettleResponse, type GatewayTransfer } from '../x402-gateway/index.js'
import type { GatewaySettlementRecord, VtpFlowRecord } from '../storage.js'

/**
 * The hosted stage machine, end to end, with every outside party faked: Arc Mainnet's reads,
 * Circle Gateway's supported kinds, settle and transfers, the risk_check scorer and the flow
 * log. The rail itself is the real one (railChallenge and railServeTool), so the check is
 * bought here exactly as the plain risk_check route sells it.
 *
 * The two properties every case below leans on: nothing reaches the rail before the free
 * checks pass, and nothing the answer says is ever executed: executed is false every time.
 */
const arc = getChainById('arc-mainnet')!
const base = getChainById('base')!
const USDC = (arc.contracts.usdc as string).toLowerCase()
const REGISTRY = (arc.contracts.identityRegistry as string).toLowerCase()
const VAULT = '0x' + 'a1'.repeat(20)
const OWNER = '0x' + 'b2'.repeat(20)
const OPERATOR = '0x' + 'c3'.repeat(20)
const PAYEE = '0x' + 'd4'.repeat(20)
const PAY_TO = '0x000000000000000000000000000000000000dead'
const NONCE = '0x' + 'ab'.repeat(32)
const ORIGIN = 'https://backend.example'
const NOW = Date.parse('2026-11-01T10:00:00Z')
const BLOCK_TS = BigInt(Math.floor(NOW / 1000))
const ENV = { X402_GATEWAY_NETWORKS: `${arc.caip2},${base.caip2}`, X402_GATEWAY_PAYTO: PAY_TO } as NodeJS.ProcessEnv

beforeEach(() => clearKindCache())

function kind(chain: typeof arc): GatewayKind {
  return {
    x402Version: 2,
    scheme: 'exact',
    network: chain.caip2,
    extra: {
      name: 'GatewayWalletBatched',
      version: '1',
      verifyingContract: chain.gateway!.wallet.toLowerCase(),
      assets: [{ symbol: 'USDC', address: (chain.contracts.usdc as string).toLowerCase(), decimals: 6 }],
    },
  }
}

// ── Arc Mainnet, faked ────────────────────────────────────────────────────────────

type Chain = {
  code: string
  usdc: string
  owner: string
  operator: string
  frozen: boolean
  sessionKeyExpiry: bigint
  allowlistEnabled: boolean
  allowed: boolean
  autoApproveMax: bigint
  dailyCap: bigint
  spentToday: bigint
  balance: bigint
  gasPrice: bigint
  operatorGas: bigint
  operatorCode: string
  agentsHeld: bigint
  ownerOf: Record<string, string>
  /** pay() / ownerPay() simulation: the contract error to revert with, if any. */
  revertPay?: string
  revertOwnerPay?: string
  gas: bigint
  /** What successive getBlock reads answer (the last repeats): the preflight's, then the one
   *  after the verdict. An Error is a read that failed. */
  blocks: (bigint | Error)[]
  /** Reads that fail with a network error, by function name. */
  down: string[]
}

function healthy(over: Partial<Chain> = {}): Chain {
  return {
    code: '0x6080',
    usdc: USDC,
    owner: OWNER,
    operator: OPERATOR,
    frozen: false,
    sessionKeyExpiry: BLOCK_TS + 14n * 86_400n,
    allowlistEnabled: false,
    allowed: false,
    autoApproveMax: 250_000n,
    dailyCap: 1_000_000n,
    spentToday: 0n,
    balance: 500_000n,
    gasPrice: 20_001_000_000n,
    operatorGas: 10n ** 17n,
    operatorCode: '0x',
    agentsHeld: 1n,
    ownerOf: {},
    gas: 116_370n,
    blocks: [29_000_000n, 29_000_007n],
    down: [],
    ...over,
  }
}

const revert = (functionName: string, errorName: string) =>
  new ContractFunctionRevertedError({ abi: AgentSpendPolicyAbi, data: encodeErrorResult({ abi: AgentSpendPolicyAbi, errorName: errorName as never }), functionName })
const plainRevert = (functionName: string) => new ContractFunctionRevertedError({ abi: AgentSpendPolicyAbi, functionName, message: 'execution reverted' })

function fakeChain(state: Chain): { client: VtpReadClient; calls: string[] } {
  const calls: string[] = []
  const fail = (name: string) => {
    if (state.down.includes(name)) throw new Error(`fetch failed (${name})`)
  }
  let blockReads = 0
  const client: VtpReadClient = {
    getBlock: async () => {
      calls.push('getBlock')
      fail('block')
      const answer = state.blocks[Math.min(blockReads++, state.blocks.length - 1)]
      if (answer instanceof Error) throw answer
      return { number: answer, timestamp: BLOCK_TS }
    },
    getGasPrice: async () => {
      calls.push('getGasPrice')
      fail('gasPrice')
      return state.gasPrice
    },
    getBalance: async ({ address }) => {
      calls.push('getBalance')
      fail('operatorGas')
      return address.toLowerCase() === state.operator ? state.operatorGas : 0n
    },
    getCode: async ({ address }) => {
      calls.push('getCode')
      if (address.toLowerCase() === VAULT) {
        fail('code')
        return state.code as `0x${string}`
      }
      fail('operatorCode')
      return state.operatorCode as `0x${string}`
    },
    readContract: async ({ address, functionName, args }) => {
      calls.push(functionName)
      fail(functionName)
      if (address.toLowerCase() === REGISTRY) {
        if (functionName === 'balanceOf') return state.agentsHeld
        const owner = state.ownerOf[String(args?.[0])]
        if (!owner) throw plainRevert('ownerOf')
        return owner
      }
      const getters: Record<string, unknown> = {
        usdc: state.usdc,
        owner: state.owner,
        operator: state.operator,
        frozen: state.frozen,
        sessionKeyExpiry: state.sessionKeyExpiry,
        allowlistEnabled: state.allowlistEnabled,
        allowed: state.allowed,
        autoApproveMax: state.autoApproveMax,
        dailyCap: state.dailyCap,
        spentToday: state.spentToday,
        balance: state.balance,
      }
      if (!(functionName in getters)) throw plainRevert(functionName)
      return getters[functionName]
    },
    simulateContract: async ({ functionName }) => {
      calls.push(`simulate:${functionName}`)
      fail('simulate')
      const err = functionName === 'pay' ? state.revertPay : state.revertOwnerPay
      if (err) throw revert(functionName, err)
      return { result: undefined }
    },
    estimateContractGas: async ({ functionName }) => {
      calls.push(`estimate:${functionName}`)
      return state.gas
    },
  }
  return { client, calls }
}

// ── Circle Gateway and the scorer, faked; the rail is the real one ─────────────────

type Scored = (input: { agentId?: string; txContext?: unknown }) => unknown

function verdict(decision: 'ALLOW' | 'WARN' | 'DENY', signals: Record<string, unknown> = {}): Scored {
  return (input) => ({
    tool: 'risk_check',
    _meta: {},
    agentId: input.agentId,
    decision,
    risk: decision === 'ALLOW' ? 'low' : decision === 'WARN' ? 'medium' : 'high',
    reasons: decision === 'ALLOW' ? ['Verified on-chain identity, attested KYA, and strong reputation'] : decision === 'WARN' ? ['Moderate reputation (320); proceed with caution'] : ['Reputation 60 is below the safe threshold (200)'],
    signals: {
      onchainVerified: true,
      kyaVerified: decision === 'ALLOW',
      reputationScore: decision === 'ALLOW' ? 720 : decision === 'WARN' ? 320 : 60,
      tenureDays: decision === 'ALLOW' ? 40 : 0,
      revoked: false,
      sybil: 'none',
      txContext: input.txContext,
      ...signals,
    },
    checkedAt: new Date(NOW).toISOString(),
  })
}

function gateway(over: { scored?: Scored | Error; settle?: GatewaySettleResponse; transfers?: GatewayTransfer[]; supported?: Error } = {}) {
  const spy = { settles: 0, scored: [] as { agentId?: string; txContext?: unknown }[], persisted: [] as GatewaySettlementRecord[] }
  const rail = {
    now: () => NOW,
    sleep: async () => {},
    getSupported: async () => {
      if (over.supported) throw over.supported
      return { kinds: [kind(arc), kind(base)] }
    },
    settle: async () => {
      spy.settles += 1
      return over.settle ?? { success: true, transaction: 'tr-1', network: arc.caip2, payer: OPERATOR }
    },
    searchTransfers: async () =>
      over.transfers ?? [{ id: 'tr-1', status: 'received', fromAddress: OPERATOR, toAddress: PAY_TO, amount: '5000', nonce: NONCE }],
    handlers: {
      risk_check: async (input: { agentId?: string; txContext?: unknown }) => {
        spy.scored.push(input)
        if (over.scored instanceof Error) throw over.scored
        return (over.scored ?? verdict('ALLOW'))(input)
      },
    },
    persist: async (r: GatewaySettlementRecord) => {
      spy.persisted.push(r)
    },
    load: async () => spy.persisted,
    update: async () => {},
  }
  return { rail, spy }
}

// ── the flow log, in memory ───────────────────────────────────────────────────────

function memStore(seed: VtpFlowRecord[] = [], over: Partial<VtpStore> = {}) {
  const rows = new Map(seed.map((r) => [r.flowId, r]))
  const inserted: VtpFlowRecord[] = []
  const store: VtpStore = {
    load: async (id) => ({ ok: true, row: rows.get(id.toLowerCase()) ?? null }),
    insert: async (rec) => {
      inserted.push(rec)
      if (rows.has(rec.flowId)) return { ok: true, inserted: false }
      rows.set(rec.flowId, rec)
      return { ok: true, inserted: true }
    },
    update: async () => ({ ok: true, updated: false, row: null }),
    findByTx: async () => ({ ok: true, flowId: null }),
    openFlows: async () => ({ ok: true, rows: [] }),
    ...over,
  }
  return { store, rows, inserted }
}

function header(over: Record<string, unknown> = {}, auth: Record<string, unknown> = {}): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: { scheme: 'exact', network: arc.caip2, payTo: PAY_TO, amount: '5000', asset: USDC },
      payload: { signature: '0x' + '11'.repeat(65), authorization: { from: OPERATOR, to: PAY_TO, value: '5000', validAfter: '0', validBefore: '9999999999', nonce: NONCE, ...auth } },
      ...over,
    }),
  ).toString('base64')
}

const request = (over: Partial<VtpInput> = {}): VtpInput => ({ vault: VAULT, payee: PAYEE, amount: '250000', ...over })

function setup(o: { chain?: Partial<Chain>; gw?: Parameters<typeof gateway>[0]; seed?: VtpFlowRecord[]; store?: Partial<VtpStore>; env?: NodeJS.ProcessEnv } = {}) {
  // The proven Gateway kind is cached per process; every scenario proves its own.
  clearKindCache()
  const c = fakeChain(healthy(o.chain))
  const g = gateway(o.gw)
  const s = memStore(o.seed, o.store)
  // The settle lands in the chain's call log too, so a test can see what was read after it.
  const settle = g.rail.settle
  g.rail.settle = async () => {
    c.calls.push('settle')
    return settle()
  }
  const deps = { env: o.env ?? ENV, origin: ORIGIN, rail: g.rail, client: c.client, store: s.store, now: () => NOW }
  return { c, g, s, deps }
}

// ── the tests ─────────────────────────────────────────────────────────────────────

test('refusals before the check never reach the rail, even with a valid payment attached', async () => {
  const cases: { what: string; status: number; code: string; input?: Partial<VtpInput>; chain?: Partial<Chain> }[] = [
    { what: 'vault is not an address', status: 400, code: 'INVALID_INPUT', input: { vault: 'vault.eth' } },
    { what: 'amount is a decimal', status: 400, code: 'INVALID_INPUT', input: { amount: '0.25' } },
    { what: 'amount is zero', status: 400, code: 'INVALID_INPUT', input: { amount: '0' } },
    { what: 'amount is a number, not base units as a string', status: 400, code: 'INVALID_INPUT', input: { amount: 250000 as unknown as string } },
    { what: 'payOnWarn is not a boolean', status: 400, code: 'INVALID_INPUT', input: { payOnWarn: 'yes' } },
    { what: 'payeeAgentId on another chain', status: 400, code: 'INVALID_INPUT', input: { payeeAgentId: `${base.caip2}:8004/7` } },
    { what: 'the asset is not USDC', status: 422, code: 'WRONG_ASSET', input: { asset: '0x' + '36'.repeat(20) } },
    { what: 'the payee is the vault', status: 422, code: 'InvalidPayee', input: { payee: VAULT } },
    { what: 'the payee is the zero address', status: 422, code: 'ZeroAddress', input: { payee: '0x' + '00'.repeat(20) } },
    { what: 'no contract at the vault', status: 422, code: 'NOT_A_VAULT', chain: { code: '0x' } },
    { what: "the vault's usdc() is a lookalike", status: 422, code: 'VAULT_TOKEN_MISMATCH', chain: { usdc: '0x' + '36'.repeat(19) + '01' } },
    { what: 'the payee holds no agent on Arc Mainnet', status: 422, code: 'PAYEE_UNREGISTERED', chain: { agentsHeld: 0n } },
    { what: 'the registry did not answer', status: 503, code: 'REGISTRY_UNREADABLE', chain: { down: ['balanceOf'] } },
    { what: 'a vault getter did not answer', status: 503, code: 'VaultUnreadable', chain: { down: ['dailyCap'] } },
    { what: 'the vault has no operator', status: 422, code: 'NotOperator', chain: { operator: '0x' + '00'.repeat(20) } },
    { what: 'the vault is frozen', status: 422, code: 'IsFrozen', chain: { frozen: true } },
    { what: 'the session key expires inside the margin, by block time', status: 422, code: 'SessionKeyExpired', chain: { sessionKeyExpiry: BLOCK_TS + 30n } },
    { what: 'the payee is not on the allowlist', status: 422, code: 'PayeeNotAllowed', chain: { allowlistEnabled: true, allowed: false } },
    { what: 'the amount is above the auto-approve ceiling', status: 422, code: 'AboveAutoApprove', input: { amount: '250001' } },
    { what: 'the daily cap would be passed', status: 422, code: 'DailyCapExceeded', chain: { spentToday: 800_000n } },
    { what: 'the vault holds less than the amount', status: 422, code: 'InsufficientVaultBalance', chain: { balance: 10_000n } },
    { what: 'gas is priced above the cap', status: 422, code: 'GasPriceAboveCap', chain: { gasPrice: 250n * 1_000_000_000n } },
    { what: 'the simulation reverts', status: 422, code: 'TransferFailed', chain: { revertPay: 'TransferFailed' } },
    { what: 'the simulation could not run', status: 503, code: 'VaultUnreadable', chain: { down: ['simulate'] } },
    { what: 'the operator cannot pay the gas', status: 422, code: 'InsufficientGas', chain: { operatorGas: 1_000n } },
  ]
  for (const k of cases) {
    const { g, s, deps } = setup({ chain: k.chain })
    const out = await runVerifyThenPay(request(k.input), header(), deps)
    assert.equal(out.httpStatus, k.status, `${k.what}: ${JSON.stringify(out.body.reason)}`)
    assert.equal(out.body.stage, 'refused', k.what)
    assert.equal(out.body.code, k.code, k.what)
    assert.equal(out.body.charged, false, k.what)
    assert.equal(out.body.executed, false, k.what)
    assert.equal(g.spy.settles, 0, `${k.what}: the rail settled`)
    assert.equal(g.spy.scored.length, 0, `${k.what}: the scorer ran`)
    assert.equal(s.inserted.length, 0, `${k.what}: a flow was written`)
  }
})

test('a refusal on input is decided before a single chain read', async () => {
  for (const input of [{ asset: '0x' + '36'.repeat(20) }, { amount: 'lots' }, { payee: VAULT }]) {
    const { c, deps } = setup()
    const out = await runVerifyThenPay(request(input), undefined, deps)
    assert.equal(out.body.stage, 'refused')
    assert.deepEqual(c.calls, [], `read the chain for ${JSON.stringify(input)}`)
  }
  // And unless the rail sells on Arc Mainnet there is nothing to buy, so nothing is read either.
  const { c, deps } = setup({ env: { X402_GATEWAY_NETWORKS: base.caip2, X402_GATEWAY_PAYTO: PAY_TO } as NodeJS.ProcessEnv })
  const out = await runVerifyThenPay(request(), undefined, deps)
  assert.equal(out.httpStatus, 501)
  assert.equal(out.body.stage, 'unavailable')
  assert.deepEqual(c.calls, [])
})

test('without a payment, the free checks run and the challenge carries the Arc Mainnet offer only', async () => {
  const { g, s, deps } = setup()
  const out = await runVerifyThenPay(request(), undefined, deps)
  assert.equal(out.httpStatus, 402)
  assert.equal(out.body.stage, 'payment_required')
  assert.equal(out.body.charged, false)
  const accepts = out.body.challenge?.accepts as { network: string; amount: string; payTo: string; extra: { name: string } }[]
  // The rail sells on Base too; this flow's challenge does not offer it.
  assert.deepEqual(accepts.map((a) => a.network), [arc.caip2])
  assert.equal(accepts[0].amount, '5000')
  assert.equal(accepts[0].extra.name, 'GatewayWalletBatched')
  assert.deepEqual(out.body.price, { usd: 0.005, units: '5000' })
  // The v2 transport: the same challenge in PAYMENT-REQUIRED, which a stock x402 client reads first.
  const fromHeader = JSON.parse(Buffer.from(out.headers?.['PAYMENT-REQUIRED'] ?? '', 'base64').toString('utf8'))
  assert.deepEqual(fromHeader, out.body.challenge)
  assert.equal(out.body.checks?.asset.ok, true)
  assert.equal(out.body.checks?.payee.ok, true)
  assert.equal(out.body.checks?.vault.ok, true)
  assert.deepEqual(out.body.checks?.vault.simulation, { ok: true, gas: '116370' })
  assert.equal(g.spy.settles, 0)
  assert.equal(s.inserted.length, 0)
})

test('a payment that names another network, in either place, is refused before it is settled', async () => {
  for (const over of [{ accepted: { scheme: 'exact', network: base.caip2, payTo: PAY_TO, amount: '5000' } }, { network: base.caip2 }]) {
    const { g, s, deps } = setup()
    const out = await runVerifyThenPay(request(), header(over), deps)
    assert.equal(out.httpStatus, 422)
    assert.equal(out.body.code, 'PAYMENT_WRONG_NETWORK')
    assert.equal(g.spy.settles, 0)
    assert.equal(s.inserted.length, 0)
  }
})

test('a nonce that already opened a flow is refused before settling, and an unreadable flow log refuses too', async () => {
  const { g, deps } = setup({ seed: [{ flowId: NONCE } as VtpFlowRecord] })
  const out = await runVerifyThenPay(request(), header(), deps)
  assert.equal(out.httpStatus, 409)
  assert.equal(out.body.code, 'NONCE_ALREADY_USED')
  assert.equal(g.spy.settles, 0)

  const down = setup({ store: { load: async () => ({ ok: false, reason: 'postgres unreachable' }) } })
  const out2 = await runVerifyThenPay(request(), header(), down.deps)
  assert.equal(out2.httpStatus, 503)
  assert.equal(out2.body.code, 'FLOW_STORE_UNREADABLE')
  assert.equal(down.g.spy.settles, 0)
})

test('a settle with no usable answer is charged:null with its own code, and writes no flow', async () => {
  const stalled = setup({ gw: { settle: { success: false, unknown: true, errorReason: 'Gateway settle did not answer within 8000 ms' } } })
  const r = await runVerifyThenPay(request(), header(), stalled.deps)
  assert.equal(r.httpStatus, 502)
  assert.equal(r.body.stage, 'check_failed')
  assert.equal(r.body.charged, null, 'the authorization may have reached Gateway: unknown, not false')
  assert.equal(r.body.code, 'SETTLEMENT_UNKNOWN')
  assert.equal(r.body.challenge, undefined, 'nothing invites a second signature')
  assert.equal(r.body.prepared, null)
  assert.match(r.body.next, /proof/)
  assert.equal(stalled.s.inserted.length, 0)
  assert.equal(stalled.g.spy.scored.length, 0)
  assert.equal(stalled.g.spy.persisted[0].outcome, 'unconfirmed')

  // Gateway's own no stays false, with no such code.
  const refusedPay = setup({ gw: { settle: { success: false, errorReason: 'insufficient_balance' } } })
  const no = await runVerifyThenPay(request(), header(), refusedPay.deps)
  assert.equal(no.body.charged, false)
  assert.equal(no.body.code, undefined)
})

test('the verdict view names who it is about and the context it was scored in', async () => {
  const { deps } = setup()
  const r = await runVerifyThenPay(request(), header(), deps)
  assert.equal(r.body.stage, 'prepared')
  assert.equal(r.body.verdict?.agentId, PAYEE)
  assert.deepEqual(r.body.verdict?.txContext, { payee: PAYEE, amountUsd: 0.25 })
})

test('402, 502 and 503 from the rail write no flow; a 500 after settlement writes verdict_unavailable', async () => {
  const refusedPay = setup({ gw: { settle: { success: false, errorReason: 'insufficient_balance' } } })
  const r402 = await runVerifyThenPay(request(), header(), refusedPay.deps)
  assert.equal(r402.httpStatus, 402)
  assert.equal(r402.body.stage, 'check_failed')
  assert.equal(r402.body.charged, false)
  assert.deepEqual((r402.body.challenge?.accepts as { network: string }[]).map((a) => a.network), [arc.caip2])
  assert.match(r402.body.reason ?? '', /insufficient_balance/)
  assert.equal(refusedPay.s.inserted.length, 0)

  const unconfirmed = setup({ gw: { transfers: [] } })
  const r502 = await runVerifyThenPay(request(), header(), unconfirmed.deps)
  assert.equal(r502.httpStatus, 502)
  assert.equal(r502.body.stage, 'check_failed')
  assert.equal(r502.body.charged, null, 'Gateway said success and nothing could be read back: unknown, not false')
  assert.equal(unconfirmed.s.inserted.length, 0)
  assert.equal(unconfirmed.g.spy.scored.length, 0)

  const unproven = setup({ gw: { supported: new Error('Gateway supported 500') } })
  const r503 = await runVerifyThenPay(request(), header(), unproven.deps)
  assert.equal(r503.httpStatus, 503)
  assert.equal(r503.body.stage, 'check_failed')
  assert.equal(unproven.s.inserted.length, 0)

  const broken = setup({ gw: { scored: new Error('scorer exploded') } })
  const r500 = await runVerifyThenPay(request(), header(), broken.deps)
  assert.equal(r500.httpStatus, 500)
  assert.equal(r500.body.stage, 'check_failed')
  assert.equal(r500.body.charged, true)
  assert.equal(broken.s.inserted.length, 1)
  const rec = broken.s.inserted[0]
  assert.deepEqual([rec.outcome, rec.detail, rec.verdict, rec.prepared], ['blocked', 'verdict_unavailable', null, null])
  assert.equal(rec.flowId, NONCE)
  assert.equal(r500.body.record?.recorded, true)
  assert.ok(r500.body.next.includes(`recorded at ${flowUrl(NONCE, ORIGIN)}`))

  // The same failure with a flow log that refuses the write says so, and links nothing.
  const lost = setup({ gw: { scored: new Error('scorer exploded') }, store: { insert: async () => ({ ok: false, reason: 'disk full' }) } })
  const r500b = await runVerifyThenPay(request(), header(), lost.deps)
  assert.equal(r500b.httpStatus, 500)
  assert.deepEqual([r500b.body.record?.recorded, r500b.body.record?.url, r500b.body.flowId], [false, null, null])
  assert.match(r500b.body.next, /not recorded as a flow: the flow log refused the write \(disk full\)/)
})

test('ALLOW prepares exactly pay(payee, amount) for the operator, asks risk_check about the payee address, and executes nothing', async () => {
  const { g, s, deps } = setup()
  const out = await runVerifyThenPay(request(), header(), deps)
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.stage, 'prepared')
  assert.equal(out.body.executed, false)
  assert.equal(out.body.charged, true)
  assert.equal(out.body.flowId, NONCE)

  // The scorer was asked about the payee ADDRESS, with the amount as a finite JSON number.
  assert.equal(g.spy.scored.length, 1)
  assert.deepEqual(g.spy.scored[0], { agentId: PAYEE, txContext: { amountUsd: 0.25, payee: PAYEE } })
  assert.equal(g.spy.settles, 1)
  assert.equal(g.spy.persisted[0].tool, 'risk_check')
  assert.equal(g.spy.persisted[0].resource, '/api/x402/gateway/tools/risk_check')
  assert.equal(g.spy.persisted[0].network, arc.caip2)

  const p = out.body.prepared!
  assert.equal(p.chainId, arc.evmChainId)
  assert.equal(p.from, OPERATOR)
  assert.equal(p.to, VAULT)
  assert.equal(p.value, '0')
  const call = decodeFunctionData({ abi: AgentSpendPolicyAbi, data: p.data as `0x${string}` })
  assert.equal(call.functionName, 'pay')
  assert.deepEqual(call.args?.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [PAYEE, 250_000n])
  assert.ok(BigInt(p.fees.maxFeePerGas) >= ARC_MIN_MAX_FEE_WEI)
  assert.deepEqual(p.simulation, { ok: true })
  assert.equal(out.body.ownerHandoff, null)

  assert.deepEqual(out.body.check, {
    network: arc.caip2,
    authNonce: NONCE,
    transferId: 'tr-1',
    gatewayOutcome: 'credited',
    payer: OPERATOR,
    amountUnits: '5000',
    resource: '/api/x402/gateway/tools/risk_check',
    checkedAt: new Date(NOW).toISOString(),
  })
  assert.equal(out.body.verdict?.decision, 'ALLOW')
  assert.equal(out.body.record?.url, flowUrl(NONCE, ORIGIN))

  const rec = s.inserted[0]
  assert.deepEqual([rec.outcome, rec.detail, rec.payOnWarn], ['pending', 'agent_will_pay', false])
  assert.deepEqual([rec.vault, rec.owner, rec.operator, rec.payee, rec.amount, rec.amountUsd], [VAULT, OWNER, OPERATOR, PAYEE, '250000', 0.25])
  assert.equal(rec.check.checkedAtBlock, '29000000')
  assert.equal(rec.check.verdictBlock, '29000007')
  assert.equal(rec.prepared?.data, p.data)
  assert.equal(rec.payment, undefined, 'nothing is executed until a receipt is read')
})

test('DENY records a public refusal and prepares nothing to sign', async () => {
  const { s, deps } = setup({ gw: { scored: verdict('DENY') } })
  const out = await runVerifyThenPay(request(), header(), deps)
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.stage, 'deny')
  assert.equal(out.body.executed, false)
  assert.equal(out.body.prepared, null)
  assert.equal(out.body.ownerHandoff, null)
  assert.equal(out.body.verdict?.effective, 'DENY')
  assert.deepEqual([s.inserted[0].outcome, s.inserted[0].detail, s.inserted[0].prepared], ['blocked', 'deny', null])
  assert.match(out.body.next, /do not pay/)

  // The record is public by flowId.
  const read = await readVtpFlow(NONCE.toUpperCase().replace('0X', '0x'), { store: s.store, origin: ORIGIN })
  assert.equal(read.httpStatus, 200)
  assert.equal(read.body.flow?.detail, 'deny')
  assert.equal(read.body.url, flowUrl(NONCE, ORIGIN))
  assert.equal((await readVtpFlow('0x' + 'ee'.repeat(32), { store: s.store })).httpStatus, 404)
  assert.equal((await readVtpFlow('nope', { store: s.store })).httpStatus, 400)
})

test('WARN hands the payment to the owner by default, and prepares pay() only with an explicit payOnWarn', async () => {
  const handoff = setup({ gw: { scored: verdict('WARN') } })
  const out = await runVerifyThenPay(request(), header(), handoff.deps)
  assert.equal(out.body.stage, 'awaiting_human')
  assert.equal(out.body.prepared, null, 'the operator is handed nothing to send')
  const own = out.body.ownerHandoff!
  assert.equal(own.auditOutcome, 'awaiting_human')
  assert.equal(own.owner, OWNER)
  assert.equal(own.ownerPay.from, OWNER)
  assert.equal(own.ownerPay.function, 'ownerPay(address,uint256)')
  const call = decodeFunctionData({ abi: AgentSpendPolicyAbi, data: own.ownerPay.data as `0x${string}` })
  assert.equal(call.functionName, 'ownerPay')
  assert.deepEqual(call.args?.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [PAYEE, 250_000n])
  assert.deepEqual([handoff.s.inserted[0].outcome, handoff.s.inserted[0].detail], ['awaiting_human', 'warn_handoff'])
  assert.ok(handoff.c.calls.includes('simulate:ownerPay'))

  const optIn = setup({ gw: { scored: verdict('WARN') } })
  const paid = await runVerifyThenPay(request({ payOnWarn: true }), header(), optIn.deps)
  assert.equal(paid.body.stage, 'prepared')
  assert.equal(paid.body.prepared?.from, OPERATOR)
  assert.equal(paid.body.ownerHandoff, null)
  assert.deepEqual([optIn.s.inserted[0].outcome, optIn.s.inserted[0].payOnWarn], ['pending', true])
})

test('a paid answer with a NaN reputation is not paid on: blocked, recorded, and named', async () => {
  const { s, deps } = setup({ gw: { scored: verdict('ALLOW', { reputationScore: Number.NaN }) } })
  const out = await runVerifyThenPay(request(), header(), deps)
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.stage, 'verdict_unusable')
  assert.equal(out.body.code, 'REPUTATION_NOT_FINITE')
  assert.equal(out.body.prepared, null)
  assert.equal(out.body.verdict?.decision, 'ALLOW')
  assert.equal(out.body.verdict?.effective, 'DENY')
  assert.equal(out.body.verdict?.overriddenBecause, 'REPUTATION_NOT_FINITE')
  assert.deepEqual([s.inserted[0].outcome, s.inserted[0].detail], ['blocked', 'verdict_unusable'])
})

test('a simulation that fails after the verdict is reported, and a flow log that refuses the write is reported and leaves nothing to send', async () => {
  // The check took seconds and the vault moved: the verdict stands, the call is flagged.
  let calls = 0
  const moved = setup()
  const realSim = moved.c.client.simulateContract
  moved.c.client.simulateContract = async (a) => {
    calls += 1
    if (calls > 1) throw revert('pay', 'DailyCapExceeded')
    return realSim(a)
  }
  const out = await runVerifyThenPay(request(), header(), moved.deps)
  assert.equal(out.body.stage, 'prepared')
  assert.deepEqual(out.body.prepared?.simulation, { ok: false, error: 'DailyCapExceeded' })
  assert.match(out.body.next, /do not send it/)

  // An ALLOW the flow log refused to hold hands back no pay(): no receipt could ever close it.
  const full = setup({ store: { insert: async () => ({ ok: false, reason: 'disk full' }) } })
  const out2 = await runVerifyThenPay(request(), header(), full.deps)
  assert.equal(out2.httpStatus, 500)
  assert.deepEqual([out2.body.stage, out2.body.code, out2.body.flowId, out2.body.prepared, out2.body.ownerHandoff], ['check_failed', 'FLOW_NOT_RECORDED', null, null, null])
  assert.deepEqual([out2.body.record?.recorded, out2.body.record?.url, out2.body.record?.reason], [false, null, 'the flow log refused the write (disk full)'])
  assert.equal(out2.body.verdict?.effective, 'ALLOW', 'the verdict that was paid for is still reported')
  assert.match(out2.body.next, /could never be tied to this check/)
})

test('the block the verdict came back in is recorded, never below the preflight block, and without it nothing is handed back to send', async () => {
  // The preflight reads block 29000000 before the check is bought; the verdict comes back in
  // 29000007, and that is the block a payment has to land after.
  const ok = setup()
  const out = await runVerifyThenPay(request(), header(), ok.deps)
  assert.equal(out.body.stage, 'prepared')
  assert.deepEqual([ok.s.inserted[0].check.checkedAtBlock, ok.s.inserted[0].check.verdictBlock], ['29000000', '29000007'])
  assert.ok(ok.c.calls.lastIndexOf('getBlock') > ok.c.calls.indexOf('settle'), 'the verdict block is read after the check was bought')

  // A host that lags answers a lower block after the verdict: the preflight's stands.
  const lag = setup({ chain: { blocks: [29_000_000n, 28_999_990n] } })
  await runVerifyThenPay(request(), header(), lag.deps)
  assert.equal(lag.s.inserted[0].check.verdictBlock, '29000000')

  // No answer after the verdict: the verdict is reported and recorded, and nothing is prepared,
  // because no payment could be shown to come after this check.
  for (const decision of ['ALLOW', 'WARN'] as const) {
    const dark = setup({ chain: { blocks: [29_000_000n, new Error('fetch failed')] }, gw: { scored: verdict(decision) } })
    const o = await runVerifyThenPay(request(), header(), dark.deps)
    assert.equal(o.httpStatus, 503, decision)
    assert.deepEqual([o.body.stage, o.body.code, o.body.charged, o.body.executed], ['check_failed', 'VERDICT_BLOCK_UNREADABLE', true, false], decision)
    assert.equal(o.body.prepared, null, decision)
    assert.equal(o.body.ownerHandoff, null, decision)
    assert.equal(o.body.verdict?.effective, decision)
    assert.match(o.body.next, /do not pay on this flow/)
    const rec = dark.s.inserted[0]
    assert.deepEqual([rec.outcome, rec.detail, rec.check.verdictBlock, rec.prepared], ['blocked', 'verdict_block_unreadable', null, null], decision)
    assert.deepEqual(dark.c.calls.filter((x) => x.startsWith('simulate:')), ['simulate:pay'], 'only the preflight simulated; nothing after the verdict')
  }

  // A DENY needs no block to refuse on: it is still a DENY, and recorded.
  const deny = setup({ chain: { blocks: [29_000_000n, new Error('fetch failed')] }, gw: { scored: verdict('DENY') } })
  const d = await runVerifyThenPay(request(), header(), deny.deps)
  assert.deepEqual([d.httpStatus, d.body.stage], [200, 'deny'])
  assert.deepEqual([deny.s.inserted[0].detail, deny.s.inserted[0].check.verdictBlock], ['deny', null])
})

test('a DENY or an unusable answer whose record was not written says the refusal is not public, and links no record', async () => {
  for (const [scored, stage] of [
    [verdict('DENY'), 'deny'],
    [verdict('ALLOW', { reputationScore: Number.NaN }), 'verdict_unusable'],
  ] as const) {
    const full = setup({ gw: { scored }, store: { insert: async () => ({ ok: false, reason: 'disk full' }) } })
    const out = await runVerifyThenPay(request(), header(), full.deps)
    assert.equal(out.httpStatus, 500, stage)
    assert.equal(out.body.stage, stage)
    assert.deepEqual([out.body.record?.recorded, out.body.record?.url, out.body.flowId, out.body.prepared], [false, null, null, null], stage)
    assert.match(out.body.next, /do not pay/)
    assert.match(out.body.next, /The refusal is not public: the flow log refused the write \(disk full\)/)
    assert.ok(!JSON.stringify(out.body).includes('/api/x402/gateway/flows/'), `${stage}: no link to a record that does not exist`)
  }
})

test("an answer whose nonce another request already recorded hands back nothing to send, and never that flow's link", async () => {
  // Both requests passed the nonce check before either wrote; the other one's row is there,
  // and may name another payee.
  for (const decision of ['ALLOW', 'WARN', 'DENY'] as const) {
    const raced = setup({ gw: { scored: verdict(decision) }, store: { insert: async () => ({ ok: true, inserted: false }) } })
    const out = await runVerifyThenPay(request(), header(), raced.deps)
    assert.equal(out.httpStatus, 409, decision)
    assert.equal(out.body.stage, decision === 'DENY' ? 'deny' : 'check_failed', decision)
    if (decision !== 'DENY') assert.equal(out.body.code, 'FLOW_NOT_RECORDED')
    assert.deepEqual([out.body.prepared, out.body.ownerHandoff, out.body.flowId, out.body.record?.url, out.body.record?.recorded], [null, null, null, null, false], decision)
    assert.match(out.body.record?.reason ?? '', /already written by another request/)
    assert.ok(!JSON.stringify(out.body).includes('/api/x402/gateway/flows/'), `${decision}: no link to the other request's flow`)
  }
})

import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContractFunctionRevertedError, decodeFunctionData, encodeErrorResult } from 'viem'
import { runVerifyThenPay, readVtpFlow, readVtpVaultFlows, VAULT_FLOWS_LIMIT, VAULT_FLOWS_OTHERS_CAP, type VtpInput } from './core.js'
import { flowUrl, storageVtpStore, type VtpStore } from './context.js'
import { fakeVtpPool } from './fake-pg.js'
import { recordVtpReceipt } from './receipt.js'
import { toSeasonFlow } from './season.js'
import type { VtpReadClient } from './reads.js'
import { ARC_MIN_MAX_FEE_WEI } from './prepare.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { getChainById } from '../chains/index.js'
import { clearKindCache, railProof, railStatus, type GatewayKind, type GatewaySettleResponse, type GatewayTransfer } from '../x402-gateway/index.js'
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
  /** Every reservation asked for. */
  const inserted: VtpFlowRecord[] = []
  /** Every row as a compare-and-set left it: what the flow finally recorded. */
  const closed: VtpFlowRecord[] = []
  const store: VtpStore = {
    load: async (id) => ({ ok: true, row: rows.get(id.toLowerCase()) ?? null }),
    insert: async (rec) => {
      inserted.push(rec)
      if (rows.has(rec.flowId)) return { ok: true, inserted: false }
      rows.set(rec.flowId, rec)
      return { ok: true, inserted: true }
    },
    update: async (id, patch, from) => {
      const cur = rows.get(id.toLowerCase())
      if (!cur) return { ok: true, updated: false, row: null }
      if (!from.includes(cur.outcome)) return { ok: true, updated: false, row: cur }
      const next = { ...cur, ...patch }
      rows.set(id.toLowerCase(), next)
      closed.push(next)
      return { ok: true, updated: true, row: next }
    },
    findByTx: async () => ({ ok: true, flowId: null }),
    openFlows: async () => ({ ok: true, rows: [] }),
    ...over,
  }
  return { store, rows, inserted, closed }
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
    { what: 'a named agent the registry does not have', status: 422, code: 'PAYEE_AGENT_MISMATCH', input: { payeeAgentId: '#7' } },
    { what: 'a named agent the payee does not own', status: 422, code: 'PAYEE_AGENT_MISMATCH', input: { payeeAgentId: '#7' }, chain: { ownerOf: { '7': OWNER } } },
    { what: 'the registry did not answer', status: 503, code: 'REGISTRY_UNREADABLE', chain: { down: ['balanceOf'] } },
    { what: 'a vault getter did not answer', status: 503, code: 'VaultUnreadable', chain: { down: ['dailyCap'] } },
    { what: 'the vault has no operator', status: 422, code: 'NotOperator', chain: { operator: '0x' + '00'.repeat(20) } },
    { what: 'the vault is frozen', status: 422, code: 'IsFrozen', chain: { frozen: true } },
    { what: 'the session key expires inside the margin, by block time', status: 422, code: 'SessionKeyExpired', chain: { sessionKeyExpiry: BLOCK_TS + 30n } },
    // Off the allowlist and above the ceiling are refusals only where there is no human to hand them to.
    { what: 'the payee is not on the allowlist, on a vault with one key', status: 422, code: 'PayeeNotAllowed', chain: { allowlistEnabled: true, allowed: false, owner: OPERATOR } },
    { what: 'the amount is above the auto-approve ceiling, on a vault with one key', status: 422, code: 'AboveAutoApprove', input: { amount: '250001' }, chain: { owner: OPERATOR } },
    { what: 'the daily cap would be passed', status: 422, code: 'DailyCapExceeded', chain: { spentToday: 800_000n } },
    { what: 'the vault holds less than the amount', status: 422, code: 'InsufficientVaultBalance', chain: { balance: 10_000n } },
    { what: 'gas is priced above the cap', status: 422, code: 'GasPriceAboveCap', chain: { gasPrice: 250n * 1_000_000_000n } },
    { what: 'the simulation reverts', status: 422, code: 'TransferFailed', chain: { revertPay: 'TransferFailed' } },
    { what: 'the simulation could not run', status: 503, code: 'VaultUnreadable', chain: { down: ['simulate'] } },
    { what: 'the operator cannot pay the gas', status: 422, code: 'InsufficientGas', chain: { operatorGas: 1_000n } },
    // One wei short of the limit prepared.fees.gas would carry, 74,115 + 25,000 at the 41.002 gwei fee, so
    // an operator who could afford only the old 20% limit is refused here rather than out of gas later.
    { what: 'the operator holds one wei under the prepared limit', status: 422, code: 'InsufficientGas', chain: { gas: 74_115n, operatorGas: 99_115n * 41_002_000_000n - 1n } },
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

test('a payee that holds no agent is not refused: the free checks pass, say so, and the check is on offer', async () => {
  const { g, s, deps } = setup({ chain: { agentsHeld: 0n } })
  const out = await runVerifyThenPay(request(), undefined, deps)
  assert.equal(out.httpStatus, 402)
  assert.equal(out.body.stage, 'payment_required')
  assert.equal(out.body.checks?.payee.ok, true)
  assert.equal(out.body.checks?.payee.agentsHeld, 0)
  assert.equal(out.body.checks?.payee.code, undefined)
  assert.match(out.body.next, /holds no ERC-8004 agent/)
  assert.match(out.body.next, /not a refusal/)
  assert.equal(g.spy.settles, 0)
  assert.equal(s.inserted.length, 0)
  // A payee that holds one is not told any of that.
  const held = await runVerifyThenPay(request(), undefined, setup().deps)
  assert.doesNotMatch(held.body.next, /holds no ERC-8004 agent/)
})

test('a payee that holds no agent buys the check, gets WARN, and reaches the owner; the flow record says only what is true', async () => {
  const scored = verdict('WARN', { onPlatform: false, onchainVerified: false, reputationScore: 0 })
  const { g, s, deps } = setup({ chain: { agentsHeld: 0n }, gw: { scored } })
  const out = await runVerifyThenPay(request(), header(), deps)
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.stage, 'awaiting_human')
  assert.equal(out.body.charged, true)
  assert.equal(g.spy.settles, 1)
  assert.equal(out.body.prepared, null, 'no automatic payment')
  assert.equal(out.body.ownerHandoff?.ownerPay.function, 'ownerPay(address,uint256)')
  assert.deepEqual(out.body.verdict?.signals, { onPlatform: false, onchainVerified: false, revoked: false, sybil: 'none' })
  const row = s.rows.get(NONCE)
  assert.equal(row?.outcome, 'awaiting_human')
  assert.equal(row?.detail, 'warn_handoff')
  assert.equal(row?.payeeAgentId, null, 'nobody named an agent, so the record names none')
  assert.equal(row?.verdict?.decision, 'WARN')
})

test('payOnWarn on a payee that holds no agent is the caller\'s own choice, and the answer says so', async () => {
  const scored = verdict('WARN', { onPlatform: false, onchainVerified: false, reputationScore: 0 })
  const { deps } = setup({ chain: { agentsHeld: 0n }, gw: { scored } })
  const out = await runVerifyThenPay(request({ payOnWarn: true }), header(), deps)
  assert.equal(out.body.stage, 'prepared')
  assert.equal(out.body.prepared?.function, 'pay(address,uint256)')
  assert.match(out.body.next, /your own decision/)
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

test('a settle with no usable answer is charged:null with its own code, and opens no flow', async () => {
  const stalled = setup({ gw: { settle: { success: false, unknown: true, errorReason: 'Gateway settle did not answer within 8000 ms' } } })
  const r = await runVerifyThenPay(request(), header(), stalled.deps)
  assert.equal(r.httpStatus, 502)
  assert.equal(r.body.stage, 'check_failed')
  assert.equal(r.body.charged, null, 'the authorization may have reached Gateway: unknown, not false')
  assert.equal(r.body.code, 'SETTLEMENT_UNKNOWN')
  assert.equal(r.body.challenge, undefined, 'nothing invites a second signature')
  assert.equal(r.body.prepared, null)
  assert.match(r.body.next, /proof/)
  // The reservation was taken before the settle, and it closes as nothing a reader can open.
  assert.deepEqual([stalled.s.closed[0].outcome, stalled.s.closed[0].detail], ['abandoned', 'rail_failed'])
  assert.equal((await readVtpFlow(NONCE, { store: stalled.s.store })).httpStatus, 404)
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

test('402, 502 and 503 from the rail open no flow and abandon the reservation; a 500 after settlement closes it as verdict_unavailable', async () => {
  const refusedPay = setup({ gw: { settle: { success: false, errorReason: 'insufficient_balance' } } })
  const r402 = await runVerifyThenPay(request(), header(), refusedPay.deps)
  assert.equal(r402.httpStatus, 402)
  assert.equal(r402.body.stage, 'check_failed')
  assert.equal(r402.body.charged, false)
  assert.deepEqual((r402.body.challenge?.accepts as { network: string }[]).map((a) => a.network), [arc.caip2])
  assert.match(r402.body.reason ?? '', /insufficient_balance/)
  assert.match(r402.body.next, /trying again takes a new authorization/)
  assert.deepEqual([refusedPay.s.closed[0].outcome, refusedPay.s.closed[0].detail], ['abandoned', 'rail_failed'])
  // An abandoned reservation is no flow to a reader, and the nonce still had its one attempt.
  assert.equal((await readVtpFlow(NONCE, { store: refusedPay.s.store })).httpStatus, 404)
  assert.deepEqual(toSeasonFlow(refusedPay.s.closed[0]), [])
  const retried = await runVerifyThenPay(request(), header(), refusedPay.deps)
  assert.deepEqual([retried.httpStatus, retried.body.code, refusedPay.g.spy.settles], [409, 'NONCE_ALREADY_USED', 1])

  const unconfirmed = setup({ gw: { transfers: [] } })
  const r502 = await runVerifyThenPay(request(), header(), unconfirmed.deps)
  assert.equal(r502.httpStatus, 502)
  assert.equal(r502.body.stage, 'check_failed')
  assert.equal(r502.body.charged, null, 'Gateway said success and nothing could be read back: unknown, not false')
  assert.deepEqual([unconfirmed.s.closed[0].outcome, unconfirmed.s.closed[0].detail], ['abandoned', 'rail_failed'])
  assert.equal(unconfirmed.g.spy.scored.length, 0)

  const unproven = setup({ gw: { supported: new Error('Gateway supported 500') } })
  const r503 = await runVerifyThenPay(request(), header(), unproven.deps)
  assert.equal(r503.httpStatus, 503)
  assert.equal(r503.body.stage, 'check_failed')
  assert.deepEqual([unproven.s.closed[0].outcome, unproven.s.closed[0].detail], ['abandoned', 'rail_failed'])

  const broken = setup({ gw: { scored: new Error('scorer exploded') } })
  const r500 = await runVerifyThenPay(request(), header(), broken.deps)
  assert.equal(r500.httpStatus, 500)
  assert.equal(r500.body.stage, 'check_failed')
  assert.equal(r500.body.charged, true)
  assert.equal(broken.s.closed.length, 1)
  const rec = broken.s.closed[0]
  assert.deepEqual([rec.outcome, rec.detail, rec.verdict, rec.prepared], ['blocked', 'verdict_unavailable', null, null])
  assert.equal(rec.flowId, NONCE)
  assert.equal(r500.body.record?.recorded, true)
  assert.ok(r500.body.next.includes(`recorded at ${flowUrl(NONCE, ORIGIN)}`))

  // The same failure with a flow log that refuses the write says so, and links nothing.
  const lost = setup({ gw: { scored: new Error('scorer exploded') }, store: { update: async () => ({ ok: false, reason: 'disk full' }) } })
  const r500b = await runVerifyThenPay(request(), header(), lost.deps)
  assert.equal(r500b.httpStatus, 500)
  assert.deepEqual([r500b.body.record?.recorded, r500b.body.record?.url, r500b.body.flowId], [false, null, null])
  assert.match(r500b.body.next, /not recorded as a flow: the flow log refused the write/)
  assert.doesNotMatch(r500b.body.next, /disk full/, "the log's own words stay on the server")
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

  const rec = s.closed[0]
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
  assert.deepEqual([s.closed[0].outcome, s.closed[0].detail, s.closed[0].prepared], ['blocked', 'deny', null])
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
  assert.deepEqual([handoff.s.closed[0].outcome, handoff.s.closed[0].detail], ['awaiting_human', 'warn_handoff'])
  assert.ok(handoff.c.calls.includes('simulate:ownerPay'))

  const optIn = setup({ gw: { scored: verdict('WARN') } })
  const paid = await runVerifyThenPay(request({ payOnWarn: true }), header(), optIn.deps)
  assert.equal(paid.body.stage, 'prepared')
  assert.equal(paid.body.prepared?.from, OPERATOR)
  assert.equal(paid.body.ownerHandoff, null)
  assert.deepEqual([optIn.s.closed[0].outcome, optIn.s.closed[0].payOnWarn], ['pending', true])
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
  assert.deepEqual([s.closed[0].outcome, s.closed[0].detail], ['blocked', 'verdict_unusable'])
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
  const full = setup({ store: { update: async () => ({ ok: false, reason: 'disk full' }) } })
  const out2 = await runVerifyThenPay(request(), header(), full.deps)
  assert.equal(out2.httpStatus, 500)
  assert.deepEqual([out2.body.stage, out2.body.code, out2.body.flowId, out2.body.prepared, out2.body.ownerHandoff], ['check_failed', 'FLOW_NOT_RECORDED', null, null, null])
  assert.deepEqual([out2.body.record?.recorded, out2.body.record?.url, out2.body.record?.reason], [false, null, 'the flow log refused the write'])
  assert.equal(out2.body.verdict?.effective, 'ALLOW', 'the verdict that was paid for is still reported')
  assert.match(out2.body.next, /could never be tied to this check/)
})

test('the block the verdict came back in is recorded, never below the preflight block, and without it nothing is handed back to send', async () => {
  // The preflight reads block 29000000 before the check is bought; the verdict comes back in
  // 29000007, and that is the block a payment has to land after.
  const ok = setup()
  const out = await runVerifyThenPay(request(), header(), ok.deps)
  assert.equal(out.body.stage, 'prepared')
  assert.deepEqual([ok.s.closed[0].check.checkedAtBlock, ok.s.closed[0].check.verdictBlock], ['29000000', '29000007'])
  assert.ok(ok.c.calls.lastIndexOf('getBlock') > ok.c.calls.indexOf('settle'), 'the verdict block is read after the check was bought')

  // A host that lags answers a lower block after the verdict: the preflight's stands.
  const lag = setup({ chain: { blocks: [29_000_000n, 28_999_990n] } })
  await runVerifyThenPay(request(), header(), lag.deps)
  assert.equal(lag.s.closed[0].check.verdictBlock, '29000000')

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
    const rec = dark.s.closed[0]
    assert.deepEqual([rec.outcome, rec.detail, rec.check.verdictBlock, rec.prepared], ['blocked', 'verdict_block_unreadable', null, null], decision)
    assert.deepEqual(dark.c.calls.filter((x) => x.startsWith('simulate:')), ['simulate:pay'], 'only the preflight simulated; nothing after the verdict')
  }

  // A DENY needs no block to refuse on: it is still a DENY, and recorded.
  const deny = setup({ chain: { blocks: [29_000_000n, new Error('fetch failed')] }, gw: { scored: verdict('DENY') } })
  const d = await runVerifyThenPay(request(), header(), deny.deps)
  assert.deepEqual([d.httpStatus, d.body.stage], [200, 'deny'])
  assert.deepEqual([deny.s.closed[0].detail, deny.s.closed[0].check.verdictBlock], ['deny', null])
})

test('a DENY or an unusable answer whose record was not written says the refusal is not public, and links no record', async () => {
  for (const [scored, stage] of [
    [verdict('DENY'), 'deny'],
    [verdict('ALLOW', { reputationScore: Number.NaN }), 'verdict_unusable'],
  ] as const) {
    const full = setup({ gw: { scored }, store: { update: async () => ({ ok: false, reason: 'disk full' }) } })
    const out = await runVerifyThenPay(request(), header(), full.deps)
    assert.equal(out.httpStatus, 500, stage)
    assert.equal(out.body.stage, stage)
    assert.deepEqual([out.body.record?.recorded, out.body.record?.url, out.body.flowId, out.body.prepared], [false, null, null, null], stage)
    assert.match(out.body.next, /do not pay/)
    assert.match(out.body.next, /The refusal is not public: the flow log refused the write/)
    assert.doesNotMatch(out.body.next, /disk full/)
    assert.ok(!JSON.stringify(out.body).includes('/api/x402/gateway/flows/'), `${stage}: no link to a record that does not exist`)
  }
})

test('a flow close that fails once is tried again, so the buyer keeps the check they paid for', async () => {
  let tries = 0
  const rows = new Map<string, VtpFlowRecord>()
  const once = setup({ store: {
    insert: async (rec) => { rows.set(rec.flowId, rec); return { ok: true, inserted: true } },
    update: async (id, patch) => {
      tries += 1
      if (tries === 1) return { ok: false, reason: 'connection reset' }
      const next = { ...rows.get(id.toLowerCase())!, ...patch } as VtpFlowRecord
      rows.set(id.toLowerCase(), next)
      return { ok: true, updated: true, row: next }
    },
  } })
  const out = await runVerifyThenPay(request(), header(), once.deps)
  assert.equal(tries, 2)
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.stage, 'prepared')
  assert.equal(out.body.record?.recorded, true)
  assert.ok(out.body.prepared)
})

test('a flow close that committed with its answer lost counts as recorded, and a stranger\'s close does not', async () => {
  const rows = new Map<string, VtpFlowRecord>()
  const insert: VtpStore['insert'] = async (rec) => { rows.set(rec.flowId, rec); return { ok: true, inserted: true } }
  const mine = setup({ store: { insert, update: async (id, patch) => {
    const cur = rows.get(id.toLowerCase())!
    if (cur.outcome !== 'opening') return { ok: true, updated: false, row: cur }
    rows.set(id.toLowerCase(), { ...cur, ...patch } as VtpFlowRecord)
    return { ok: false, reason: 'connection lost after the commit' }
  } } })
  const out = await runVerifyThenPay(request(), header(), mine.deps)
  assert.equal(out.body.stage, 'prepared')
  assert.equal(out.body.record?.recorded, true)

  // The row moved, but not to this answer's record, so this answer is not on record.
  rows.clear()
  let tries = 0
  const other = setup({ store: { insert, update: async (id) => {
    tries += 1
    if (tries === 1) return { ok: false, reason: 'connection lost' }
    return { ok: true, updated: false, row: { ...rows.get(id.toLowerCase())!, outcome: 'abandoned' } as VtpFlowRecord }
  } } })
  const raced = await runVerifyThenPay(request(), header(), other.deps)
  assert.equal(raced.httpStatus, 409)
  assert.equal(raced.body.code, 'FLOW_NOT_RECORDED')
})

test('a transaction conflict is not tried again, because it is no database error', async () => {
  let tries = 0
  const conflict = setup({ store: { update: async () => {
    tries += 1
    return { ok: false, reason: 'that transaction is already linked to another flow', conflict: 'tx_linked' }
  } } })
  const out = await runVerifyThenPay(request(), header(), conflict.deps)
  assert.equal(tries, 1)
  assert.equal(out.body.code, 'FLOW_NOT_RECORDED')
})

test('an answer whose reservation was no longer open hands back nothing to send, and links no record', async () => {
  for (const decision of ['ALLOW', 'WARN', 'DENY'] as const) {
    const raced = setup({ gw: { scored: verdict(decision) }, store: { update: async () => ({ ok: true, updated: false, row: null }) } })
    const out = await runVerifyThenPay(request(), header(), raced.deps)
    assert.equal(out.httpStatus, 409, decision)
    assert.equal(out.body.stage, decision === 'DENY' ? 'deny' : 'check_failed', decision)
    if (decision !== 'DENY') assert.equal(out.body.code, 'FLOW_NOT_RECORDED')
    assert.deepEqual([out.body.prepared, out.body.ownerHandoff, out.body.flowId, out.body.record?.url, out.body.record?.recorded], [null, null, null, null, false], decision)
    assert.match(out.body.record?.reason ?? '', /no longer open/)
    assert.ok(!JSON.stringify(out.body).includes('/api/x402/gateway/flows/'), `${decision}: no link to a record this answer is not`)
  }
})

// ── one signed payment, one flow ──────────────────────────────────────────────────

test('two concurrent requests with one signed payment reach Gateway once, on every flow log', async () => {
  const backends: [string, () => VtpStore][] = [
    ['file', () => storageVtpStore({ file: join(mkdtempSync(join(tmpdir(), 'vtp-race-')), 'vtp-flows.json'), getPool: async () => null })],
    [
      'postgres',
      () => {
        const pool = fakeVtpPool()
        return storageVtpStore({ getPool: async () => pool })
      },
    ],
  ]
  for (const [what, make] of backends) {
    const store = make()
    const { g, deps } = setup()
    const racing = { ...deps, store }
    const [a, b] = await Promise.all([runVerifyThenPay(request(), header(), racing), runVerifyThenPay(request(), header(), racing)])
    assert.equal(g.spy.settles, 1, `${what}: Gateway was asked ${g.spy.settles} times`)
    assert.equal(g.spy.scored.length, 1, what)
    const answers = [a, b].sort((x, y) => x.httpStatus - y.httpStatus)
    assert.deepEqual(answers.map((o) => o.httpStatus), [200, 409], what)
    assert.equal(answers[0].body.stage, 'prepared', what)
    assert.deepEqual([answers[1].body.code, answers[1].body.charged, answers[1].body.prepared], ['NONCE_ALREADY_USED', false, null], what)
    const row = await store.load(NONCE)
    assert.equal(row.ok && row.row?.outcome, 'pending', what)
    assert.equal(row.ok && row.row?.check.transferId, 'tr-1', what)
  }
})

test('a used nonce says this request charged nothing, and sends the caller to the first one before it signs again', async () => {
  const said = (next: string, reason: string | undefined) => {
    assert.match(next, /This request charged nothing/)
    assert.match(next, /may have been charged and may hold a verdict, or may still be running/)
    assert.ok(next.includes(`GET /api/x402/gateway/flows/${NONCE.toLowerCase()}`), next)
    assert.match(next, /GET \/api\/x402\/gateway\/proof/)
    assert.match(next, /a flow there that names this vault, payee and amount is your answer, so do not sign again/)
    assert.match(next, /One that names others does not answer this request, so sign a new authorization for it/)
    assert.doesNotMatch(next, /a flow there is your answer/)
    assert.match(next, /If neither shows this nonce by then, or the proof log says it failed, sign a new authorization/)
    assert.doesNotMatch(next, /no check was bought/)
    assert.doesNotMatch(reason ?? '', /sign a new authorization/i)
  }
  // The first request settled and holds a verdict, and its answer was lost on the way back.
  const lostAnswer = setup({ gw: { scored: verdict('WARN') } })
  const first = await runVerifyThenPay(request(), header(), lostAnswer.deps)
  assert.equal(first.body.stage, 'awaiting_human')
  const again = await runVerifyThenPay(request(), header(), lostAnswer.deps)
  assert.deepEqual([again.httpStatus, again.body.stage, again.body.code, again.body.charged, lostAnswer.g.spy.settles], [409, 'refused', 'NONCE_ALREADY_USED', false, 1])
  said(again.body.next, again.body.reason)
  // The read it points to has the verdict and the owner's link, so nothing has to be bought twice.
  const read = await readVtpFlow(NONCE, { store: lostAnswer.s.store })
  assert.deepEqual([read.httpStatus, read.body.flow?.outcome, read.body.flow?.verdict?.effective], [200, 'awaiting_human', 'WARN'])

  // A first request still running: its row is a reservation, no reader can see it, and the words have to cover that.
  let letItFinish = () => {}
  const gate = new Promise<void>((r) => (letItFinish = r))
  const running = setup()
  const settle = running.g.rail.settle
  running.g.rail.settle = async () => {
    await gate
    return settle()
  }
  const slow = runVerifyThenPay(request(), header(), running.deps)
  while (!running.s.inserted.length) await new Promise((r) => setTimeout(r, 1))
  const meanwhile = await runVerifyThenPay(request(), header(), running.deps)
  assert.equal(meanwhile.body.code, 'NONCE_ALREADY_USED')
  said(meanwhile.body.next, meanwhile.body.reason)
  assert.equal((await readVtpFlow(NONCE, { store: running.s.store })).httpStatus, 404, 'a read says nothing yet, so reading once is not the end of it')
  letItFinish()
  await slow

  // Passed the read and lost the insert: the same answer from the second place it is given.
  const lost = setup({ store: { insert: async () => ({ ok: true, inserted: false }) } })
  const raced = await runVerifyThenPay(request(), header(), lost.deps)
  assert.equal(raced.body.code, 'NONCE_ALREADY_USED')
  said(raced.body.next, raced.body.reason)

  // After the server said it does not know whether this settled, the same header does not contradict that.
  const stalled = setup({ gw: { settle: { success: false, unknown: true, errorReason: 'Gateway settle did not answer within 8000 ms' } } })
  const unknown = await runVerifyThenPay(request(), header(), stalled.deps)
  assert.equal(unknown.body.code, 'SETTLEMENT_UNKNOWN')
  const resent = await runVerifyThenPay(request(), header(), stalled.deps)
  assert.equal(resent.body.code, 'NONCE_ALREADY_USED')
  said(resent.body.next, resent.body.reason)
})

test('a signature sent again for another vault, payee or amount is told that the flow under it does not answer this request', async () => {
  const { g, s, deps } = setup()
  const first = await runVerifyThenPay(request(), header(), deps)
  assert.equal(first.body.stage, 'prepared')
  const other = '0x' + 'e5'.repeat(20)
  for (const [what, over] of [
    ['payee', { payee: other }],
    ['amount', { amount: '100000' }],
    ['vault', { vault: other }],
    ['payee and amount', { payee: other, amount: '100000' }],
  ] as [string, Partial<VtpInput>][]) {
    const again = await runVerifyThenPay(request(over), header(), deps)
    assert.deepEqual([again.httpStatus, again.body.stage, again.body.code, again.body.charged, again.body.prepared, again.body.flowId], [409, 'refused', 'NONCE_ALREADY_USED', false, null, null], what)
    assert.match(again.body.next, /named another vault, payee or amount/, what)
    assert.match(again.body.next, /does not answer this request/, what)
    assert.match(again.body.next, /sign a new authorization for this request: a new authorization costs another 0\.005 USDC/, what)
    assert.doesNotMatch(again.body.next, /is your answer|do not sign again/, what)
  }
  assert.equal(g.spy.settles, 1, 'nothing was bought for any of them')
  assert.equal(s.rows.get(NONCE)?.payee, PAYEE, 'and the first flow is as it was')

  // The same request is the same request, whatever case its addresses were typed in, so it is not told to pay again.
  const typed = await runVerifyThenPay(request({ payee: '0x' + 'D4'.repeat(20), vault: '0x' + 'A1'.repeat(20) }), header(), deps)
  assert.equal(typed.body.code, 'NONCE_ALREADY_USED')
  assert.match(typed.body.next, /a flow there that names this vault, payee and amount is your answer/)
  assert.doesNotMatch(typed.body.next, /named another vault, payee or amount/)

  // The race has no row to compare, so its words have to hold for another payee too.
  const lost = setup({ store: { insert: async () => ({ ok: true, inserted: false }) } })
  const raced = await runVerifyThenPay(request({ payee: other }), header(), lost.deps)
  assert.equal(raced.body.code, 'NONCE_ALREADY_USED')
  assert.match(raced.body.next, /One that names others does not answer this request/)
  assert.equal(lost.g.spy.settles, 0)
})

test("the guide's table says what a used nonce and an unconfirmed settlement answer", () => {
  const guide = readFileSync(new URL('../../../docs/chains/arc-integration.mdx', import.meta.url), 'utf8').split('\n')
  const row = (start: string) => {
    const rows = guide.filter((l) => l.startsWith(start))
    assert.equal(rows.length, 1, start)
    return rows[0]
  }
  const used = row('| `409` | `refused` |')
  assert.match(used, /A flow there that names this vault, payee and amount is your answer, so do not sign again/)
  assert.match(used, /One that names others does not answer this request/)
  assert.match(used, /which lists only the newest 50 rows/)
  assert.match(used, /`credited`, `completed` or `unconfirmed` and the flow still answers `404`, treat this nonce as giving no flow/)
  assert.match(used, /a new authorization costs another 0\.005 USDC/)
  assert.match(used, /may still settle until it expires/)
  const unknown = row('| `409`, `500`, `502`, `503` | `check_failed`, `unavailable` |')
  assert.match(unknown, /which lists only the newest 50 rows/)
  assert.match(unknown, /If it reads `unconfirmed`, treat this nonce as giving no flow/)
})

test('a used nonce the proof shows and no flow came of has a way forward, and the proof is not taken for complete', async () => {
  const noFlow = /[Tt]reat this nonce as giving no flow: a new authorization costs another 0\.005 USDC/
  // The first request settled, its flow could not be closed, and its answer was lost.
  const closeFails = setup({ store: { update: async () => ({ ok: false, reason: 'db down' }) } })
  const first = await runVerifyThenPay(request(), header(), closeFails.deps)
  assert.equal(first.body.code, 'FLOW_NOT_RECORDED')
  const again = await runVerifyThenPay(request(), header(), closeFails.deps)
  assert.equal(again.body.code, 'NONCE_ALREADY_USED')
  assert.equal((await readVtpFlow(NONCE, { store: closeFails.s.store })).httpStatus, 404, 'the flow reads as nothing, and nothing will change that')
  const shown = await railProof(railStatus(ENV, arc.caip2), { env: ENV, load: async () => closeFails.g.spy.persisted })
  assert.deepEqual(shown.recent.map((r) => [r.authNonce, r.outcome]), [[NONCE, 'credited']], 'and the proof shows it settled')
  // Those two facts are the case the answer has to name: neither "neither shows it" nor "it failed".
  assert.match(again.body.next, /If the proof log reads credited, completed or unconfirmed and the flow still answers 404/)
  assert.match(again.body.next, noFlow)
  assert.match(again.body.next, /one that reads unconfirmed may still settle until it expires/)
  assert.doesNotMatch(again.body.next, /no flow will come/, 'a very slow first request could still close its flow, so the words do not promise that')

  // The proof has no look-up, so a settled nonce older than its newest rows reads as absent, and the answer says so.
  const later = Array.from({ length: 50 }, (_, i) => ({ ...closeFails.g.spy.persisted[0], authNonce: '0x' + String(i).padStart(64, '0') }))
  const crowded = await railProof(railStatus(ENV, arc.caip2), { env: ENV, load: async () => [...closeFails.g.spy.persisted, ...later] })
  assert.equal(crowded.recent.length, 50)
  assert.equal(crowded.recent.filter((r) => r.authNonce === NONCE).length, 0)
  assert.equal(crowded.credited, 51)
  assert.match(again.body.next, /GET \/api\/x402\/gateway\/proof, which lists only the newest 50 rows/)

  // A settle that got no usable answer ends at unconfirmed, and its own answer already says what to do with that.
  const stalled = setup({ gw: { settle: { success: false, unknown: true, errorReason: 'Gateway settle did not answer within 8000 ms' } } })
  const unknown = await runVerifyThenPay(request(), header(), stalled.deps)
  assert.equal(unknown.body.code, 'SETTLEMENT_UNKNOWN')
  assert.equal(stalled.g.spy.persisted[0].outcome, 'unconfirmed')
  assert.match(unknown.body.next, /GET \/api\/x402\/gateway\/proof, which lists only the newest 50 rows, before signing another/)
  assert.match(unknown.body.next, /If it reads unconfirmed, treat this nonce as giving no flow: a new authorization costs another 0\.005 USDC/)
  assert.match(unknown.body.next, /this one may still settle until it expires/)

  // So does a success whose transfer could not be read back.
  const unread = setup({ gw: { transfers: [] } })
  const r502 = await runVerifyThenPay(request(), header(), unread.deps)
  assert.deepEqual([r502.httpStatus, r502.body.charged, unread.g.spy.persisted[0].outcome], [502, null, 'unconfirmed'])
  assert.match(r502.body.next, noFlow)
  assert.match(r502.body.next, /this one may still settle until it expires/)
})

test('the reservation goes in before the rail is asked, and to a reader it is nothing yet', async () => {
  const { g, s, deps } = setup()
  const seen: unknown[] = []
  const settle = g.rail.settle
  g.rail.settle = async () => {
    const row = s.rows.get(NONCE)!
    assert.deepEqual([row.outcome, row.detail, row.verdict, row.prepared, row.check.gatewayOutcome, row.check.verdictBlock], ['opening', 'opening', null, null, 'none', null])
    assert.deepEqual(toSeasonFlow(row), [], 'the season counts nothing')
    const read = await readVtpFlow(NONCE, { store: s.store, origin: ORIGIN })
    seen.push([read.httpStatus, read.body.flow, read.body.error])
    const asked: string[] = []
    const posted = await recordVtpReceipt(NONCE, '0x' + 'c1'.repeat(32), {
      store: s.store,
      receipts: {
        urls: arc.rpcUrls,
        call: async (_url, method) => {
          asked.push(method)
          return null
        },
      },
    })
    seen.push([posted.httpStatus, posted.body.code, asked])
    return settle()
  }
  const out = await runVerifyThenPay(request(), header(), deps)
  assert.equal(out.httpStatus, 200)
  assert.deepEqual(seen, [
    [404, null, 'no flow with this id'],
    [404, 'UNKNOWN_FLOW', []],
  ])
  assert.equal(s.inserted.length, 1)
  assert.deepEqual([s.closed.length, s.closed[0].outcome], [1, 'pending'])
  // Closed, it is the record the answer linked.
  assert.equal((await readVtpFlow(NONCE, { store: s.store, origin: ORIGIN })).httpStatus, 200)
})

test('a flow log that refuses the reservation refuses the request, and nothing is bought', async () => {
  const full = setup({ store: { insert: async () => ({ ok: false, reason: 'disk full' }) } })
  const a = await runVerifyThenPay(request(), header(), full.deps)
  assert.deepEqual([a.httpStatus, a.body.stage, a.body.code, a.body.charged], [503, 'refused', 'FLOW_STORE_UNREADABLE', false])
  assert.match(a.body.reason ?? '', /^the flow log refused the write/)
  assert.doesNotMatch(a.body.reason ?? '', /disk full/, "the log's own words stay on the server")
  assert.equal(full.g.spy.settles, 0)

  // Passed the read and lost the insert: the row appeared between the two.
  const lost = setup({ store: { insert: async () => ({ ok: true, inserted: false }) } })
  const b = await runVerifyThenPay(request(), header(), lost.deps)
  assert.deepEqual([b.httpStatus, b.body.stage, b.body.code, b.body.charged], [409, 'refused', 'NONCE_ALREADY_USED', false])
  assert.equal(lost.g.spy.settles, 0)

  // No payment yet means nothing to reserve.
  const free = setup()
  assert.equal((await runVerifyThenPay(request(), undefined, free.deps)).httpStatus, 402)
  assert.equal(free.s.inserted.length, 0)
})

test('a DENY through the Postgres-shaped log closes its reservation as a public refusal the season counts', async () => {
  const pool = fakeVtpPool()
  const store = storageVtpStore({ getPool: async () => pool })
  const { deps } = setup({ gw: { scored: verdict('DENY') } })
  const out = await runVerifyThenPay(request(), header(), { ...deps, store })
  assert.deepEqual([out.httpStatus, out.body.stage, out.body.record?.recorded], [200, 'deny', true])
  const read = await readVtpFlow(NONCE, { store, origin: ORIGIN })
  assert.deepEqual([read.httpStatus, read.body.flow?.outcome, read.body.flow?.detail, read.body.flow?.verdict?.decision], [200, 'blocked', 'deny', 'DENY'])
  const [season] = toSeasonFlow(read.body.flow!)
  assert.equal(season.outcome, 'refused')
  assert.equal(season.evidenceUrl, flowUrl(NONCE))
  // A refusal has no payment to come, so a receipt posted to it changes nothing.
  const late = await recordVtpReceipt(NONCE, '0x' + 'c1'.repeat(32), { store })
  assert.deepEqual([late.httpStatus, late.body.code], [409, 'FLOW_ENDED'])
})

// ── a row costs a request something ───────────────────────────────────────────────

test('a request the rail would refuse on its face writes no row: no signature, wrong recipient, wrong price', async () => {
  const forged = '0x' + '11'.repeat(65)
  const auth = { from: OPERATOR, to: PAY_TO, value: '5000', validAfter: '0', validBefore: '9999999999', nonce: NONCE }
  for (const [what, payload] of [
    ['no signature', { authorization: auth }],
    ['a signature that is not one', { signature: 'not hex', authorization: auth }],
    ['a short signature', { signature: '0x' + '11'.repeat(20), authorization: auth }],
    ['pays somebody else', { signature: forged, authorization: { ...auth, to: '0x' + '66'.repeat(20) } }],
    ['the wrong price', { signature: forged, authorization: { ...auth, value: '1' } }],
    ['no value', { signature: forged, authorization: { ...auth, value: undefined } }],
    ['a nonce that is not 32 bytes', { signature: forged, authorization: { ...auth, nonce: '0x12' } }],
    ['no payer', { signature: forged, authorization: { ...auth, from: 'nobody' } }],
  ] as [string, unknown][]) {
    const t = setup()
    const out = await runVerifyThenPay(request(), Buffer.from(JSON.stringify({ x402Version: 2, payload })).toString('base64'), t.deps)
    assert.equal(out.httpStatus, 402, what)
    assert.equal(out.body.stage, 'payment_required', what)
    assert.equal(t.s.inserted.length, 0, `${what}: no row`)
    assert.equal(t.g.spy.settles, 0, `${what}: nothing settled`)
  }
})

test('a refused attempt that reaches the rail is abandoned, and old ones are pruned on the way', async () => {
  const pruned: string[] = []
  const t = setup({
    gw: { settle: { success: false, errorReason: 'insufficient_balance' } },
    store: { prune: async (olderThan) => { pruned.push(olderThan) } },
  })
  const out = await runVerifyThenPay(request(), header(), t.deps)
  assert.equal(out.body.stage, 'check_failed')
  assert.equal(t.s.closed[0].outcome, 'abandoned')
  assert.deepEqual(pruned, [new Date(NOW - 7 * 86_400_000).toISOString()])
})

// ── a WARN with no human to hand it to ────────────────────────────────────────────

test('a WARN on a vault whose owner and operator are one key blocks the flow and records no approval', async () => {
  const same = setup({ chain: { owner: OPERATOR }, gw: { scored: verdict('WARN') } })
  const out = await runVerifyThenPay(request(), header(), same.deps)
  assert.deepEqual([out.httpStatus, out.body.stage, out.body.prepared, out.body.ownerHandoff, out.body.charged], [200, 'warn_no_human_gate', null, null, true])
  assert.equal(out.body.checks?.vault.ownerIsOperator, true)
  const rec = same.s.closed[0]
  assert.deepEqual([rec.outcome, rec.detail, rec.prepared], ['blocked', 'warn_no_human_gate', null])
  assert.match(out.body.next, /do not pay/)
  assert.match(out.body.next, /no approval was recorded/)
  assert.ok(!same.c.calls.includes('simulate:ownerPay'), 'no owner call was even built')
  assert.deepEqual(toSeasonFlow(rec), [], 'neither a payment nor a refusal for the season')

  // The same fact in the free preflight, before anything is bought.
  const free = await runVerifyThenPay(request(), undefined, setup({ chain: { owner: OPERATOR } }).deps)
  assert.equal(free.body.checks?.vault.ownerIsOperator, true)

  // Two keys is the normal hand-off, and says so.
  const two = await runVerifyThenPay(request(), header(), setup({ gw: { scored: verdict('WARN') } }).deps)
  assert.deepEqual([two.body.stage, two.body.checks?.vault.ownerIsOperator], ['awaiting_human', false])

  // payOnWarn is the agent's own decision and claims no human, so it stays the agent's call;
  // and an ALLOW needs no hand-off at all.
  const optIn = await runVerifyThenPay(request({ payOnWarn: true }), header(), setup({ chain: { owner: OPERATOR }, gw: { scored: verdict('WARN') } }).deps)
  assert.deepEqual([optIn.body.stage, optIn.body.prepared?.function], ['prepared', 'pay(address,uint256)'])
  const allow = await runVerifyThenPay(request(), header(), setup({ chain: { owner: OPERATOR } }).deps)
  assert.equal(allow.body.stage, 'prepared')
})

test('with payOnWarn, a WARN carrying a DENY-level signal prepares nothing', async () => {
  const cases: Record<string, unknown>[] = [{ revoked: true }, { sybil: 'high' }, { onchainVerified: false }, { reputationScore: 60 }]
  for (const signals of cases) {
    const { s, deps } = setup({ gw: { scored: verdict('WARN', signals) } })
    const out = await runVerifyThenPay(request({ payOnWarn: true }), header(), deps)
    assert.deepEqual([out.body.stage, out.body.code, out.body.prepared, out.body.ownerHandoff], ['verdict_unusable', 'SIGNALS_INCONSISTENT', null, null], JSON.stringify(signals))
    assert.deepEqual([s.closed[0].outcome, s.closed[0].detail], ['blocked', 'verdict_unusable'])
    assert.equal(out.body.verdict?.effective, 'DENY')
  }
})

// ── how to send what was prepared ─────────────────────────────────────────────────

test('the instruction names the prepared fee, its floor and the gas limit, not the floor as a target', async () => {
  // Gas at 20.001 gwei: a 20 gwei fee is under the base fee, so "at least 20 gwei" was a trap.
  const ok = setup()
  const out = await runVerifyThenPay(request(), header(), ok.deps)
  const p = out.body.prepared!
  assert.ok(BigInt(p.fees.maxFeePerGas) > 20_001_000_000n)
  assert.ok(out.body.next.includes(`maxFeePerGas prepared.fees.maxFeePerGas (${p.fees.maxFeePerGas} wei)`), out.body.next)
  assert.ok(out.body.next.includes(`never below prepared.fees.floorWei (${p.fees.floorWei} wei)`), out.body.next)
  assert.ok(out.body.next.includes(`gas limit prepared.fees.gas (${p.fees.gas})`), out.body.next)
  assert.doesNotMatch(out.body.next, /at least/)

  const warn = setup({ gw: { scored: verdict('WARN') } })
  const w = await runVerifyThenPay(request(), header(), warn.deps)
  const o = w.body.ownerHandoff!.ownerPay
  assert.ok(w.body.next.includes(`maxFeePerGas ownerHandoff.ownerPay.fees.maxFeePerGas (${o.fees.maxFeePerGas} wei)`), w.body.next)
  assert.ok(w.body.next.includes(`gas limit ownerHandoff.ownerPay.fees.gas (${o.fees.gas})`), w.body.next)
  // Sending it costs the agent room on the vault, and the owner is told before signing.
  assert.match(w.body.next, /counts toward the agent's day on the vault: if it uses up today's room, the agent cannot pay until 00:00 UTC unless the owner raises the cap/)

  // An ownerPay that could not be simulated has no limit to name, and is not offered as ready to send.
  const cannot = setup({ chain: { revertOwnerPay: 'TransferFailed' }, gw: { scored: verdict('WARN') } })
  const c = await runVerifyThenPay(request(), header(), cannot.deps)
  assert.equal(c.body.ownerHandoff?.ownerPay.fees.gas, null)
  assert.match(c.body.next, /do not send ownerHandoff\.ownerPay/)
})

// ── what the answers tell an agent to do next ─────────────────────────────────────

test('the 402 does not promise an owner hand-off that a vault with one key cannot give', async () => {
  const oneKey = await runVerifyThenPay(request(), undefined, setup({ chain: { agentsHeld: 0n, owner: OPERATOR } }).deps)
  assert.equal(oneKey.body.stage, 'payment_required')
  assert.match(oneKey.body.next, /owner and the operator are one key/)
  assert.match(oneKey.body.next, /stops with nothing prepared/)
  assert.doesNotMatch(oneKey.body.next, /hands the payment to the owner/)
  const twoKeys = await runVerifyThenPay(request(), undefined, setup({ chain: { agentsHeld: 0n } }).deps)
  assert.match(twoKeys.body.next, /hands the payment to the owner/)
  assert.doesNotMatch(twoKeys.body.next, /one key/)
})

test('a WARN with no human gate does not point the agent at payOnWarn for a payee we know nothing about', async () => {
  const unknown = setup({ chain: { owner: OPERATOR }, gw: { scored: verdict('WARN', { onPlatform: false, onchainVerified: false, reputationScore: 0 }) } })
  const out = await runVerifyThenPay(request(), header(), unknown.deps)
  assert.equal(out.body.stage, 'warn_no_human_gate')
  assert.doesNotMatch(out.body.next, /payOnWarn/)
  assert.match(out.body.next, /owner cannot be changed/)
  assert.match(out.body.next, /with setOperator/)
  // A WARN on an agent we hold a record of keeps the option: its reasons are about something we know.
  const known = setup({ chain: { owner: OPERATOR }, gw: { scored: verdict('WARN', { onPlatform: true }) } })
  assert.match((await runVerifyThenPay(request(), header(), known.deps)).body.next, /payOnWarn/)
  // The free refusal on such a vault has no verdict at all, so it does not point there either, whoever the payee is.
  for (const agentsHeld of [0n, 1n]) {
    const above = await runVerifyThenPay(request({ amount: '250001' }), undefined, setup({ chain: { owner: OPERATOR, agentsHeld } }).deps)
    assert.equal(above.body.code, 'AboveAutoApprove')
    assert.doesNotMatch(above.body.next, /payOnWarn/, String(agentsHeld))
  }
})

test('the way to a hand-off on a vault with one key is one the contract has', async () => {
  // The words below are about this contract, so they are held to it: no call sets a new owner, and setOperator is there.
  const sol = readFileSync(new URL('../../contracts/AgentSpendPolicy.sol', import.meta.url), 'utf8')
  assert.match(sol, /address public immutable owner;/)
  assert.doesNotMatch(sol, /function (?:setOwner|transferOwnership|changeOwner)\b/)
  assert.match(sol, /function setOperator\(address _operator\) external onlyOwner/)

  const oneKey = { owner: OPERATOR }
  const answers = [
    (await runVerifyThenPay(request({ amount: '250001' }), undefined, setup({ chain: oneKey }).deps)).body.next,
    (await runVerifyThenPay(request(), undefined, setup({ chain: { ...oneKey, agentsHeld: 0n } }).deps)).body.next,
    (await runVerifyThenPay(request(), header(), setup({ chain: oneKey, gw: { scored: verdict('WARN') } }).deps)).body.next,
  ]
  for (const next of answers) {
    assert.doesNotMatch(next, /owner key the agent does not hold/, next)
    assert.match(next, /A vault's owner cannot be changed/, next)
    assert.match(next, /give your agent a new key of its own with setOperator, and keep this key from it/, next)
    // A key the agent has held is not made safe by a new operator, and the answer does not pretend it is.
    assert.match(next, /if its process or logs have held it, deploy a new vault/, next)
  }
})

test('what the 402 says a WARN will do follows payOnWarn, so it agrees with what the paid answer does', async () => {
  const warned = { gw: { scored: verdict('WARN', { onPlatform: true }) } }
  const both = async (o: { chain: Partial<Chain>; payOnWarn: boolean }) => {
    const input = { payOnWarn: o.payOnWarn }
    const asked = await runVerifyThenPay(request(input), undefined, setup({ chain: o.chain }).deps)
    const paid = await runVerifyThenPay(request(input), header(), setup({ chain: o.chain, ...warned }).deps)
    return { next: asked.body.next, stage: paid.body.stage }
  }

  // One key.
  const oneKey = await both({ chain: { owner: OPERATOR }, payOnWarn: true })
  assert.equal(oneKey.stage, 'prepared')
  assert.match(oneKey.next, /You set payOnWarn, so a WARN prepares pay\(\) as the agent's own decision/)
  assert.doesNotMatch(oneKey.next, /stops with nothing prepared/)
  const oneKeyNot = await both({ chain: { owner: OPERATOR }, payOnWarn: false })
  assert.equal(oneKeyNot.stage, 'warn_no_human_gate')
  assert.match(oneKeyNot.next, /stops with nothing prepared/)
  assert.doesNotMatch(oneKeyNot.next, /prepares pay\(\)/)

  // Two keys, and a payee with no agent, which is where the 402 says what a WARN will do.
  const twoKeys = await both({ chain: { agentsHeld: 0n }, payOnWarn: true })
  assert.equal(twoKeys.stage, 'prepared')
  assert.match(twoKeys.next, /You set payOnWarn, so a WARN prepares pay\(\) for the operator key/)
  assert.doesNotMatch(twoKeys.next, /hands the payment to the owner|offers the owner/)
  const twoKeysNot = await both({ chain: { agentsHeld: 0n }, payOnWarn: false })
  assert.equal(twoKeysNot.stage, 'awaiting_human')
  assert.match(twoKeysNot.next, /A WARN hands the payment to the owner/)

  // And a payment only the owner can make: payOnWarn cannot change that, and the 402 says so either way.
  const ownerOnly = await both({ chain: { allowlistEnabled: true, allowed: false }, payOnWarn: true })
  assert.equal(ownerOnly.stage, 'awaiting_human')
  assert.match(ownerOnly.next, /payOnWarn cannot make the operator pay it/)
})

test('a refusal of the ceiling or the allowlist says one key only on a vault that has one', async () => {
  // The getters passed and the simulation reverted: the vault's limits moved between the two reads, or two hosts disagreed.
  for (const code of ['AboveAutoApprove', 'PayeeNotAllowed']) {
    const out = await runVerifyThenPay(request(), undefined, setup({ chain: { revertPay: code } }).deps)
    assert.deepEqual([out.httpStatus, out.body.code, out.body.checks?.vault.ownerIsOperator], [422, code, false], code)
    assert.doesNotMatch(out.body.next, /one key/, code)
    assert.doesNotMatch(out.body.next, /setOperator|new vault/, code)
    assert.match(out.body.next, /^Nothing was charged and no check was bought: pay\(\) from the operator reverts/, code)
  }
  const oneKey = await runVerifyThenPay(request({ amount: '250001' }), undefined, setup({ chain: { owner: OPERATOR } }).deps)
  assert.match(oneKey.body.next, /owner and operator are one key/)
})

test('a payment to the operator key is not said to be one the vault page offers, before or after the check', async () => {
  const toOperator = { payee: OPERATOR }
  const saysNo = /The vault page does not offer a payment to the vault's operator key 0x[0-9a-f]{40}, so the owner sends ownerPay from their own key/
  const cases: [string, Partial<VtpInput>, Partial<Chain>][] = [
    ['above the ceiling', { ...toOperator, amount: '250001' }, {}],
    ['a payee with no agent', toOperator, { agentsHeld: 0n }],
  ]
  for (const [what, input, chain] of cases) {
    const asked = await runVerifyThenPay(request(input), undefined, setup({ chain }).deps)
    assert.equal(asked.httpStatus, 402, what)
    assert.match(asked.body.next, saysNo, what)
    assert.doesNotMatch(asked.body.next, /offers the owner/, what)
    const paid = await runVerifyThenPay(request(input), header(), setup({ chain, gw: { scored: verdict('WARN') } }).deps)
    assert.equal(paid.body.stage, 'awaiting_human', what)
    assert.equal(paid.body.ownerHandoff?.approvalUrl, null, what)
    assert.match(paid.body.next, /the payee is the vault's own operator key/, what)
  }
  // To anyone else the line about who pays for the check still stands.
  assert.match((await runVerifyThenPay(request({ amount: '250001' }), undefined, setup().deps)).body.next, /offers the owner this approval only if the check is paid from/)
  assert.match((await runVerifyThenPay(request(), undefined, setup({ chain: { agentsHeld: 0n } }).deps)).body.next, /offers the owner that approval only if the check is paid from/)
})

test('a hand-off whose simulation failed tells the owner not to send it', async () => {
  const moved = setup({ chain: { revertOwnerPay: 'TransferFailed' }, gw: { scored: verdict('WARN') } })
  const out = await runVerifyThenPay(request(), header(), moved.deps)
  assert.equal(out.body.stage, 'awaiting_human')
  assert.deepEqual(out.body.ownerHandoff?.ownerPay.simulation, { ok: false, error: 'TransferFailed' })
  assert.match(out.body.next, /do not send ownerHandoff\.ownerPay/)
  assert.doesNotMatch(out.body.next, /can settle it/)
})

test('on a vault with one key, a payment above the ceiling stays a refusal that promises no hand-off, because nothing there can give one', async () => {
  const above = await runVerifyThenPay(request({ amount: '250001' }), undefined, setup({ chain: { owner: OPERATOR } }).deps)
  assert.equal(above.body.code, 'AboveAutoApprove')
  assert.match(above.body.next, /no verdict on this payee/)
  assert.match(above.body.next, /no person to hand this to/)
  assert.match(above.body.next, /ALLOW prepares pay\(\) and WARN stops with the check paid/)
  assert.match(above.body.next, /owner cannot be changed/)
  // The key that asked is the owner, so "only the owner can pay it" would point it past its own ceiling.
  assert.doesNotMatch(above.body.next, /ownerPay|only the owner/)
  assert.doesNotMatch(above.body.reason ?? '', /ownerPay|only the owner/)
  // A caller who already set payOnWarn is told what it will do. One who did not is not pointed at it.
  const set = await runVerifyThenPay(request({ amount: '250001', payOnWarn: true }), undefined, setup({ chain: { owner: OPERATOR } }).deps)
  assert.equal(set.body.code, 'AboveAutoApprove')
  assert.match(set.body.next, /WARN prepares pay\(\) as the agent's own decision, because you set payOnWarn/)
  assert.doesNotMatch(set.body.next, /stops with the check paid/)
  const offList = await runVerifyThenPay(request(), undefined, setup({ chain: { owner: OPERATOR, allowlistEnabled: true } }).deps)
  assert.equal(offList.body.code, 'PayeeNotAllowed')
  assert.doesNotMatch(offList.body.next, /ownerPay|only the owner|payOnWarn/)
  // Where there is a person, the words that send it to them stay.
  const twoKeys = await runVerifyThenPay(request({ amount: '250001' }), undefined, setup().deps)
  assert.match(twoKeys.body.checks?.vault.ownerOnly?.reason ?? '', /only the owner can pay it \(ownerPay\)/)
  assert.doesNotMatch(above.body.next, /To get a verdict and a hand-off/)
  // Any other refusal keeps its plain answer.
  const frozen = await runVerifyThenPay(request(), undefined, setup({ chain: { frozen: true } }).deps)
  assert.equal(frozen.body.code, 'IsFrozen')
  assert.doesNotMatch(frozen.body.next, /ownerPay/)
})

// ── a payment only the owner can make ─────────────────────────────────────────────

const OFF_ALLOWLIST: Partial<Chain> = { allowlistEnabled: true, allowed: false }
const ABOVE: Partial<VtpInput> = { amount: '250001' }

for (const [label, input, chain, code] of [
  ['above the ceiling', ABOVE, {}, 'AboveAutoApprove'],
  ['off the allowlist', {}, OFF_ALLOWLIST, 'PayeeNotAllowed'],
] as [string, Partial<VtpInput>, Partial<Chain>, string][]) {
  test(`${label}: the 402 says up front that it will charge for the check and that only the owner can settle it`, async () => {
    const { g, s, c, deps } = setup({ chain })
    const out = await runVerifyThenPay(request(input), undefined, deps)
    assert.equal(out.httpStatus, 402)
    assert.equal(out.body.stage, 'payment_required')
    assert.equal(out.body.charged, false)
    assert.equal(out.body.checks?.vault.ownerOnly?.code, code)
    assert.match(out.body.next, /only the owner can settle it/)
    assert.match(out.body.next, /still charges 0\.005 USDC/)
    assert.match(out.body.next, /payOnWarn cannot make the operator pay it/)
    assert.match(out.body.next, /DENY stops it/)
    assert.equal(g.spy.settles, 0, 'nothing is bought for the 402')
    assert.equal(s.inserted.length, 0)
    // What is simulated is what the payment would be: the owner's call, not the operator's.
    assert.ok(c.calls.includes('simulate:ownerPay'))
    assert.ok(!c.calls.includes('simulate:pay'))
  })

  for (const decision of ['ALLOW', 'WARN'] as const) {
    test(`${label}: a usable ${decision} buys the check and hands ownerPay to the owner`, async () => {
      const { g, s, deps } = setup({ chain, gw: { scored: verdict(decision) } })
      const out = await runVerifyThenPay(request(input), header(), deps)
      assert.equal(out.httpStatus, 200)
      assert.equal(out.body.stage, 'awaiting_human')
      assert.equal(out.body.charged, true)
      assert.equal(g.spy.settles, 1)
      assert.equal(out.body.prepared, null)
      const h = out.body.ownerHandoff!
      assert.equal(h.ownerPay.function, 'ownerPay(address,uint256)')
      assert.equal(h.ownerPay.from, OWNER)
      assert.equal(h.ownerOnly, code)
      assert.match(out.body.next, /only the owner can settle it/)
      const row = s.rows.get(NONCE)!
      assert.deepEqual([row.outcome, row.detail, row.ownerOnly], ['awaiting_human', 'owner_only_handoff', code])
      assert.equal(row.prepared?.function, 'ownerPay(address,uint256)')
      // Nothing a season report counts until the chain proves a payment.
      assert.deepEqual(toSeasonFlow(row), [])
    })
  }

  test(`${label}: payOnWarn cannot make the operator pay what the vault would refuse`, async () => {
    const { s, deps } = setup({ chain, gw: { scored: verdict('WARN') } })
    const out = await runVerifyThenPay(request({ ...input, payOnWarn: true }), header(), deps)
    assert.equal(out.body.stage, 'awaiting_human')
    assert.equal(out.body.prepared, null)
    assert.equal(out.body.ownerHandoff?.ownerPay.function, 'ownerPay(address,uint256)')
    assert.equal(s.rows.get(NONCE)?.payOnWarn, true, 'the record says what was asked')
  })

  test(`${label}: DENY refuses as usual, with nothing prepared`, async () => {
    const { s, deps } = setup({ chain, gw: { scored: verdict('DENY') } })
    const out = await runVerifyThenPay(request(input), header(), deps)
    assert.deepEqual([out.body.stage, out.body.prepared, out.body.ownerHandoff, out.body.charged], ['deny', null, null, true])
    const row = s.rows.get(NONCE)!
    assert.deepEqual([row.outcome, row.detail, row.prepared], ['blocked', 'deny', null])
    assert.equal(row.ownerOnly, undefined)
    // A DENY is the same refused flow the report already counts, by the same rule.
    assert.equal(toSeasonFlow(row)[0]?.outcome, 'refused')
  })

  test(`${label}: on a vault whose owner is its operator nothing changes, because there is no human`, async () => {
    const { g, s, deps } = setup({ chain: { ...chain, owner: OPERATOR } })
    const out = await runVerifyThenPay(request(input), header(), deps)
    assert.deepEqual([out.httpStatus, out.body.stage, out.body.code, out.body.charged], [422, 'refused', code, false])
    assert.equal(out.body.checks?.vault.ownerOnly, null)
    assert.equal(g.spy.settles, 0)
    assert.equal(s.inserted.length, 0)
  })
}

test('the other refusals stay refusals on a payment only the owner can make', async () => {
  for (const [what, chain, code] of [
    ['frozen', { frozen: true }, 'IsFrozen'],
    ['expired', { sessionKeyExpiry: BLOCK_TS + 30n }, 'SessionKeyExpired'],
    ['no operator', { operator: '0x' + '00'.repeat(20) }, 'NotOperator'],
    ['no balance', { balance: 10_000n }, 'InsufficientVaultBalance'],
    ['fee above the cap', { gasPrice: 250n * 1_000_000_000n }, 'GasPriceAboveCap'],
    ['ownerPay would revert', { revertOwnerPay: 'TransferFailed' }, 'TransferFailed'],
  ] as [string, Partial<Chain>, string][]) {
    const { g, deps } = setup({ chain })
    const out = await runVerifyThenPay(request(ABOVE), header(), deps)
    assert.deepEqual([out.httpStatus, out.body.stage, out.body.code], [422, 'refused', code], what)
    assert.equal(g.spy.settles, 0, what)
  }
})

test('a real invoice on a default vault reaches the hand-off: above the ceiling and past the cap, because ownerPay has no cap check', async () => {
  // 5 USDC on a vault with a 0.25 ceiling and a 1 USDC cap. The contract reverts on the ceiling first.
  const { deps, s } = setup({ chain: { balance: 10_000_000n }, gw: { scored: verdict('WARN') } })
  const out = await runVerifyThenPay(request({ amount: '5000000' }), header(), deps)
  assert.equal(out.body.stage, 'awaiting_human')
  assert.equal(s.rows.get(NONCE)?.ownerOnly, 'AboveAutoApprove')
  // A cap alone, inside the ceiling and on the allowlist, stays a refusal: that is the agent's limit doing its job.
  const capped = await runVerifyThenPay(request(), header(), setup({ chain: { spentToday: 800_000n } }).deps)
  assert.deepEqual([capped.httpStatus, capped.body.code], [422, 'DailyCapExceeded'])
})

test('a payment only the owner can make does not ask whether the operator can pay gas it will not spend', async () => {
  const { deps } = setup({ chain: { operatorGas: 1n }, gw: { scored: verdict('WARN') } })
  const out = await runVerifyThenPay(request(ABOVE), header(), deps)
  assert.equal(out.body.stage, 'awaiting_human')
})

test('an owner-only hand-off that a receipt closes counts as the paid flow the report already knows, under the same rule', async () => {
  const { deps, s } = setup({ gw: { scored: verdict('ALLOW') } })
  await runVerifyThenPay(request(ABOVE), header(), deps)
  const row = s.rows.get(NONCE)!
  const paid: VtpFlowRecord = {
    ...row,
    outcome: 'executed',
    detail: 'owner_paid',
    payment: { txHash: '0x' + '77'.repeat(32), blockNumber: '29000010', minedAt: '2026-11-01T10:05:00.000Z', status: 'success', byOwner: true, from: OWNER, to: VAULT, gasUsed: '90000', effectiveGasPrice: '21000000000', costUsdc: '0.00189', readBackAt: '2026-11-01T10:05:01.000Z', readBackFrom: 'rpc', explorerUrl: 'https://x/tx' },
  }
  const [flow] = toSeasonFlow(paid)
  assert.equal(flow?.outcome, 'paid')
  assert.equal(flow?.txHash, paid.payment?.txHash)
})

// ── the approval link ─────────────────────────────────────────────────────────────

test('a hand-off carries the approval link: the vault page at the site, with the vault and the flow, whatever Host the request came on', async () => {
  const { deps } = setup({ gw: { scored: verdict('WARN') } })
  // deps.origin is what requestOrigin builds from Host and X-Forwarded-Host, so a caller chooses it.
  const out = await runVerifyThenPay(request(), header(), { ...deps, origin: 'https://evil.example' })
  const url = new URL(String(out.body.ownerHandoff!.approvalUrl))
  assert.equal(url.origin, 'https://a-identity.xyz')
  assert.equal(url.pathname, '/app/vault/arc')
  assert.deepEqual(Object.fromEntries(url.searchParams), { network: arc.caip2, contract: VAULT, flow: NONCE })
  assert.ok(out.body.next.includes(String(out.body.ownerHandoff!.approvalUrl)), 'the agent is told to send it')
  assert.doesNotMatch(out.body.next, /evil\.example.*app\/vault/)
})

const SOMEONE = '0x' + '99'.repeat(20)

async function handedOffRow(): Promise<VtpFlowRecord> {
  const { s, deps } = setup({ gw: { scored: verdict('WARN') } })
  await runVerifyThenPay(request(), header(), deps)
  return s.rows.get(NONCE)!
}

test('a check another key paid for gets no approval link, because the vault page would refuse it, and the answer says what to do instead', async () => {
  const { s, deps } = setup({
    gw: {
      scored: verdict('WARN'),
      settle: { success: true, transaction: 'tr-1', network: arc.caip2, payer: SOMEONE },
      transfers: [{ id: 'tr-1', status: 'received', fromAddress: SOMEONE, toAddress: PAY_TO, amount: '5000', nonce: NONCE }],
    },
  })
  const out = await runVerifyThenPay(request(), header({}, { from: SOMEONE }), deps)
  assert.equal(out.body.stage, 'awaiting_human')
  assert.equal(out.body.ownerHandoff?.approvalUrl, null)
  assert.doesNotMatch(out.body.next, /app\/vault\/arc/)
  assert.match(out.body.next, /no link for the vault page/)
  assert.match(out.body.next, /not by the vault's operator key/)
  assert.match(out.body.next, /sending ownerHandoff\.ownerPay from the owner key/)
  assert.equal(s.rows.get(NONCE)?.check.payer.toLowerCase(), SOMEONE)
  const read = await readVtpFlow(NONCE, { store: deps.store })
  assert.equal(read.body.approvalUrl, null, 'and reading the flow does not hand one out either')
})

test('a payment to the operator key itself gets no approval link, for the same reason', async () => {
  const { deps } = setup({ gw: { scored: verdict('WARN', { txContext: { payee: OPERATOR, amountUsd: 0.25 }, agentId: OPERATOR }) } })
  const out = await runVerifyThenPay(request({ payee: OPERATOR }), header(), deps)
  assert.equal(out.body.stage, 'awaiting_human')
  assert.equal(out.body.ownerHandoff?.approvalUrl, null)
  assert.match(out.body.next, /the payee is the vault's own operator key/)
  assert.equal((await readVtpFlow(NONCE, { store: deps.store })).body.approvalUrl, null)
})

for (const [label, input, chain] of [
  ['above the ceiling', ABOVE, {}],
  ['off the allowlist', {}, OFF_ALLOWLIST],
] as [string, Partial<VtpInput>, Partial<Chain>][]) {
  test(`${label}: the 402 names the key the vault page wants the check paid from, before anything is signed`, async () => {
    const out = await runVerifyThenPay(request(input), undefined, setup({ chain }).deps)
    assert.equal(out.httpStatus, 402)
    assert.ok(out.body.next.includes(`operator key ${OPERATOR}`), out.body.next)
    assert.match(out.body.next, /offers the owner this approval only if the check is paid from/)
  })
}

test('reading an old row with no check on it gets no approval link, and does not throw on a public route', async () => {
  const { store } = memStore([{ ...(await handedOffRow()), check: undefined } as unknown as VtpFlowRecord])
  const out = await readVtpFlow(NONCE, { store })
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.approvalUrl, null)
})

test('reading a flow names its approval link only while it waits for the owner', async () => {
  const { deps } = setup({ gw: { scored: verdict('WARN') } })
  await runVerifyThenPay(request(), header(), deps)
  const waiting = await readVtpFlow(NONCE, { store: deps.store, origin: 'https://evil.example' })
  assert.match(String(waiting.body.approvalUrl), /^https:\/\/a-identity\.xyz\/app\/vault\/arc\?/)
  await deps.store.update(NONCE, { outcome: 'executed', detail: 'owner_paid' }, ['awaiting_human'])
  assert.equal((await readVtpFlow(NONCE, { store: deps.store })).body.approvalUrl, null)
})

// ── the list by vault ─────────────────────────────────────────────────────────────

function waitingRow(id: string, over: Partial<VtpFlowRecord> = {}): VtpFlowRecord {
  return {
    v: 1,
    flowId: id,
    network: arc.caip2,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    vault: VAULT,
    owner: OWNER,
    operator: OPERATOR,
    payee: PAYEE,
    payeeAgentId: null,
    asset: USDC,
    amount: '250000',
    amountUsd: 0.25,
    check: { authNonce: id, transferId: 'tr', gatewayOutcome: 'credited', payer: OPERATOR, value: '5000', tool: 'risk_check', checkedAt: '2026-11-01T10:00:00.000Z', checkedAtBlock: '90', verdictBlock: '100' },
    verdict: { decision: 'WARN', effective: 'WARN', risk: 'medium', reasons: ['we do not know this payee'], reputationScore: 60, agentId: PAYEE, checkedAt: '2026-11-01T10:00:00.000Z' },
    payOnWarn: false,
    prepared: null,
    outcome: 'awaiting_human',
    detail: 'warn_handoff',
    ...over,
  }
}

const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const STRANGER = '0x' + '99'.repeat(20)
const strangers = (n: number, from = 1000) =>
  Array.from({ length: n }, (_, i) => {
    const f = id(from + i)
    return waitingRow(f, { check: { ...waitingRow(f).check, payer: STRANGER }, createdAt: '2026-11-02T10:00:00.000Z' })
  })

for (const [name, make] of [
  ['the file store', (rows: VtpFlowRecord[]) => {
    const file = join(mkdtempSync(join(tmpdir(), 'vtp-list-')), 'flows.json')
    const store = storageVtpStore({ file, getPool: async () => null })
    return { store, ready: Promise.all(rows.map((r) => store.insert(r))) }
  }],
  ['Postgres', (rows: VtpFlowRecord[]) => {
    const pool = fakeVtpPool()
    const store = storageVtpStore({ getPool: async () => pool })
    return { store, ready: Promise.all(rows.map((r) => store.insert(r))) }
  }],
] as [string, (rows: VtpFlowRecord[]) => { store: VtpStore; ready: Promise<unknown> }][]) {
  test(`${name}: a stranger's check names the vault and is not listed as a request, only counted, and a flood of them crowds out nothing`, async () => {
    const mine = waitingRow(id(1), { createdAt: '2026-11-01T09:00:00.000Z' })
    const { store, ready } = make([mine, ...strangers(VAULT_FLOWS_OTHERS_CAP + 5)])
    await ready
    const out = await readVtpVaultFlows(VAULT, { store })
    assert.equal(out.httpStatus, 200)
    assert.deepEqual(out.body.waiting.map((f) => f.flowId), [mine.flowId], 'older than every stranger, and still listed')
    assert.deepEqual(out.body.notFromOperator, { count: VAULT_FLOWS_OTHERS_CAP, capped: true })
    assert.ok(!JSON.stringify(out.body.waiting).includes(STRANGER), "nothing of the stranger's is in the list")
  })

  test(`${name}: the list is newest first, bounded, says when it was cut, and holds only what waits on this vault`, async () => {
    const many = Array.from({ length: VAULT_FLOWS_LIMIT + 3 }, (_, i) => waitingRow(id(i + 1), { createdAt: new Date(Date.parse('2026-11-01T00:00:00Z') + i * 1000).toISOString() }))
    const other = waitingRow(id(500), { vault: '0x' + 'ee'.repeat(20) })
    const paid = waitingRow(id(501), { outcome: 'executed', detail: 'owner_paid' })
    const denied = waitingRow(id(502), { outcome: 'blocked', detail: 'deny' })
    const opening = waitingRow(id(503), { outcome: 'opening', detail: 'opening' })
    const { store, ready } = make([...many, other, paid, denied, opening])
    await ready
    const out = await readVtpVaultFlows(VAULT.toUpperCase().replace('0X', '0x'), { store })
    assert.equal(out.body.waiting.length, VAULT_FLOWS_LIMIT)
    assert.equal(out.body.truncated, true)
    assert.equal(out.body.waiting[0].flowId, many[many.length - 1].flowId)
    assert.ok(out.body.waiting.every((f) => f.outcome === 'awaiting_human' && f.vault === VAULT))
    assert.deepEqual(out.body.notFromOperator, { count: 0, capped: false })
  })
}

test('the list refuses a vault that is not an address, and a log it cannot read is an error and never an empty list', async () => {
  const bad = await readVtpVaultFlows('vault.eth', { store: memStore().store })
  assert.equal(bad.httpStatus, 400)
  const none = await readVtpVaultFlows(null, { store: memStore().store })
  assert.equal(none.httpStatus, 400)
  const down = await readVtpVaultFlows(VAULT, { store: memStore([], { waiting: async () => ({ ok: false, reason: 'db down' }) }).store })
  assert.equal(down.httpStatus, 503)
  assert.match(String(down.body.error), /could not be read/)
})

test("a flow log that fails says fixed words to a caller with no key, and the database's own go to the server's log", async () => {
  const secret = 'password authentication failed for user "a_identity_prod" at dpg-abc123.oregon-postgres.render.com'
  const logged: unknown[][] = []
  const real = console.error
  console.error = (...args: unknown[]) => void logged.push(args)
  try {
    const list = await readVtpVaultFlows(VAULT, { store: memStore([], { waiting: async () => ({ ok: false, reason: secret }) }).store })
    assert.equal(list.httpStatus, 503)
    assert.equal(list.body.error, 'the flow log could not be read')
    const one = await readVtpFlow(NONCE, { store: memStore([], { load: async () => ({ ok: false, reason: secret }) }).store })
    assert.equal(one.httpStatus, 503)
    assert.equal(one.body.error, 'the flow log could not be read')
    for (const out of [list.body, one.body]) assert.doesNotMatch(JSON.stringify(out), /a_identity_prod|render\.com/)
    assert.equal(logged.length, 2)
    assert.ok(logged.every((l) => String(l[0]).includes(secret)), 'whoever runs the server still sees why')
  } finally {
    console.error = real
  }
})

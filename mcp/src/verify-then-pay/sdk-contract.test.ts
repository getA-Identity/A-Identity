import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, type Hex } from 'viem'
import { runVerifyThenPay, type VtpInput } from './core.js'
import type { VtpStore } from './context.js'
import type { VtpReadClient } from './reads.js'
import { AgentSpendPolicyAbi } from '../contracts/AgentSpendPolicy.js'
import { getChainById } from '../chains/index.js'
import { clearKindCache, type GatewayKind, type GatewaySettleResponse, type GatewayTransfer } from '../x402-gateway/index.js'
import type { GatewaySettlementRecord, VtpFlowRecord } from '../storage.js'

/**
 * The hosted route's real answers, fed to the built SDK. trust-guard's own tests fake the route
 * by hand and the hosted tests never run the client, so a shape that drifted on one side would
 * pass both suites: this is what ties them together. runVerifyThenPay and the rail are the real
 * ones, and so is verifyThenPay with Circle's real signing scheme. Faked: Arc Mainnet's reads on
 * both sides, Gateway's settle and transfers, the scorer, the flow log and the receipt route.
 *
 * It needs trust-guard built (scripts/prepare-trust-guard.mjs, part of npm test).
 */
const arc = getChainById('arc-mainnet')!
const USDC = (arc.contracts.usdc as string).toLowerCase()
const REGISTRY = (arc.contracts.identityRegistry as string).toLowerCase()
const FACILITATOR = arc.gateway!.facilitator
const VAULT = '0x' + 'a1'.repeat(20)
const OWNER = '0x' + 'b2'.repeat(20)
const OPERATOR = '0x' + 'c3'.repeat(20)
const PAYEE = '0x' + 'd4'.repeat(20)
const PAY_TO = '0x' + 'f6'.repeat(20)
const OTHER = '0x' + '66'.repeat(20)
const TX = '0x' + '77'.repeat(32)
const ORIGIN = 'https://backend.example'
const AMOUNT = 250_000n
const NOW = Date.parse('2026-11-01T10:00:00Z')
const BLOCK_TS = BigInt(Math.floor(NOW / 1000))
const ENV = { X402_GATEWAY_NETWORKS: arc.caip2, X402_GATEWAY_PAYTO: PAY_TO } as NodeJS.ProcessEnv

// The path is computed so that mcp's own compile does not reach into another package's build.
type Sdk = {
  verifyThenPay(o: Record<string, unknown>): Promise<{ outcome: string; flowId: string; verdict: { agentId: string; decision: string }; check: { amountUnits: string }; ownerPay?: { from: string; function: string; data: string }; record: { recorded: boolean; url: string } }>
}
const sdk = (await import(new URL('../../../trust-guard/dist/arc.js', import.meta.url).href)) as Sdk

beforeEach(() => clearKindCache())

const REGISTRY_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const
const TRANSFER = { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] } as const
const encodeResult = encodeFunctionResult as unknown as (a: { abi: unknown; functionName: string; result: unknown }) => Hex
const decodeCall = decodeFunctionData as unknown as (a: { abi: unknown; data: Hex }) => { functionName: string }
const encodeTopics = encodeEventTopics as unknown as (a: { abi: unknown; eventName: string; args: Record<string, unknown> }) => Hex[]

const payData = encodeFunctionData({ abi: AgentSpendPolicyAbi, functionName: 'pay', args: [PAYEE as Hex, AMOUNT] } as never)

type Vault = { frozen: boolean; ownerIsOperator?: boolean }

const getters = (v: Vault): Record<string, unknown> => ({
  usdc: USDC,
  owner: v.ownerIsOperator ? OPERATOR : OWNER,
  operator: OPERATOR,
  frozen: v.frozen,
  sessionKeyExpiry: BLOCK_TS + 14n * 86_400n,
  allowlistEnabled: false,
  allowed: false,
  autoApproveMax: 500_000n,
  dailyCap: 1_000_000n,
  spentToday: 0n,
  balance: 1_000_000n,
})

/** The server's view of Arc Mainnet. */
function serverChain(v: Vault): VtpReadClient {
  return {
    getBlock: async () => ({ number: 29_000_000n, timestamp: BLOCK_TS }),
    getGasPrice: async () => 20_001_000_000n,
    getBalance: async () => 10n ** 17n,
    getCode: async ({ address }) => (address.toLowerCase() === VAULT ? '0x6080' : '0x'),
    readContract: async ({ address, functionName }) => {
      if (address.toLowerCase() === REGISTRY) return functionName === 'balanceOf' ? 1n : PAYEE
      return getters(v)[functionName]
    },
    simulateContract: async () => ({ result: undefined }),
    estimateContractGas: async () => 116_370n,
  }
}

/** The client's view of Arc Mainnet: the same facts, through the SDK's reader interface. */
function clientChain(ownerIsOperator = false) {
  const v: Vault = { frozen: false, ownerIsOperator }
  return {
    code: async (a: string) => (a.toLowerCase() === OPERATOR ? '0x' : '0x6001'),
    latestBlock: async () => ({ number: 29_000_001n, timestamp: BLOCK_TS }),
    gasPrice: async () => 20_001_000_000n,
    nativeBalance: async () => 10n ** 17n,
    estimateGas: async () => 100_000n,
    call: async ({ to, data }: { to: string; data: Hex }) => {
      if (to.toLowerCase() === REGISTRY) {
        const name = decodeCall({ abi: REGISTRY_ABI, data }).functionName
        return encodeResult({ abi: REGISTRY_ABI, functionName: name, result: name === 'balanceOf' ? 1n : PAYEE })
      }
      const name = decodeCall({ abi: AgentSpendPolicyAbi, data }).functionName
      if (name === 'pay') return '0x'
      return encodeResult({ abi: AgentSpendPolicyAbi, functionName: name, result: getters(v)[name] })
    },
    transaction: async () => ({ from: OPERATOR, to: VAULT, input: payData, maxFeePerGas: 41n * 10n ** 9n }),
    receipt: async (hash: string) => ({
      transactionHash: hash,
      status: 'success',
      blockNumber: 29_000_010n,
      from: OPERATOR,
      to: VAULT,
      gasUsed: 91_000n,
      effectiveGasPrice: 21n * 10n ** 9n,
      logs: [
        { address: USDC, topics: encodeTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: VAULT, to: PAYEE } }), data: encodeAbiParameters([{ type: 'uint256' }], [AMOUNT]) },
        { address: VAULT, topics: encodeTopics({ abi: AgentSpendPolicyAbi, eventName: 'Paid', args: { to: PAYEE, dayIndex: 20_000n } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [AMOUNT, false]) },
      ],
      source: 'rpc.fake',
    }),
  }
}

const kind: GatewayKind = {
  x402Version: 2,
  scheme: 'exact',
  network: arc.caip2,
  extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: arc.gateway!.wallet.toLowerCase(), assets: [{ symbol: 'USDC', address: USDC, decimals: 6 }] },
}

type Scored = (input: { agentId?: string; txContext?: unknown }) => unknown

function scored(decision: 'ALLOW' | 'WARN' | 'DENY', over: { reputationScore?: unknown; agentId?: string } = {}): Scored {
  return (input) => ({
    tool: 'risk_check',
    _meta: {},
    agentId: over.agentId ?? input.agentId,
    decision,
    risk: decision === 'ALLOW' ? 'low' : decision === 'WARN' ? 'medium' : 'high',
    reasons: [`reason for ${decision}`],
    signals: {
      onchainVerified: true,
      kyaVerified: decision === 'ALLOW',
      reputationScore: 'reputationScore' in over ? over.reputationScore : decision === 'ALLOW' ? 720 : decision === 'WARN' ? 470 : 60,
      tenureDays: decision === 'ALLOW' ? 40 : 0,
      revoked: false,
      sybil: 'none',
      txContext: input.txContext,
    },
    checkedAt: new Date(NOW).toISOString(),
  })
}

type Setup = { score?: Scored; settle?: GatewaySettleResponse; transfers?: 'none'; insertFails?: boolean; closeFails?: boolean; serverFrozen?: boolean; payOnWarn?: boolean; ownerIsOperator?: boolean }

function harness(o: Setup = {}) {
  const rows = new Map<string, VtpFlowRecord>()
  const store: VtpStore = {
    load: async (id) => ({ ok: true, row: rows.get(id.toLowerCase()) ?? null }),
    insert: async (rec) => {
      if (o.insertFails) return { ok: false, reason: 'db down' }
      if (rows.has(rec.flowId)) return { ok: true, inserted: false }
      rows.set(rec.flowId, rec)
      return { ok: true, inserted: true }
    },
    // The real store's compare-and-set: the reservation closes only from an outcome it names.
    update: async (id, patch, from) => {
      if (o.closeFails) return { ok: false, reason: 'db down' }
      const cur = rows.get(id.toLowerCase())
      if (!cur) return { ok: true, updated: false, row: null }
      if (!from.includes(cur.outcome)) return { ok: true, updated: false, row: cur }
      const next = { ...cur, ...patch }
      rows.set(id.toLowerCase(), next)
      return { ok: true, updated: true, row: next }
    },
    findByTx: async () => ({ ok: true, flowId: null }),
    openFlows: async () => ({ ok: true, rows: [] }),
  }
  const deps = {
    env: ENV,
    origin: ORIGIN,
    client: serverChain({ frozen: o.serverFrozen ?? false, ownerIsOperator: o.ownerIsOperator }),
    store,
    now: () => NOW,
    rail: {
      now: () => NOW,
      sleep: async () => {},
      getSupported: async () => ({ kinds: [kind] }),
      settle: async () => o.settle ?? { success: true, transaction: 'tr-1', network: arc.caip2, payer: OPERATOR },
      searchTransfers: async (_u: string, p: { nonce?: string }): Promise<GatewayTransfer[]> => (o.transfers === 'none' ? [] : [{ id: 'tr-1', status: 'received', fromAddress: OPERATOR, toAddress: PAY_TO, amount: '5000', nonce: p.nonce }]),
      handlers: { risk_check: async (input: { agentId?: string; txContext?: unknown }) => (o.score ?? scored('ALLOW'))(input) },
      persist: async (_r: GatewaySettlementRecord) => {},
      load: async () => [],
      update: async () => {},
    },
  }
  const fetchFake = async (url: string, init?: RequestInit): Promise<Response> => {
    const json = (status: number, body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers })
    if (url === `${FACILITATOR}/v1/x402/supported`) return json(200, { kinds: [kind] })
    if (url === `${FACILITATOR}/v1/balances`) return json(200, { balances: [{ balance: '1.000000' }] })
    if (url === `${ORIGIN}/api/x402/gateway/verify-then-pay`) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      const r = await runVerifyThenPay(JSON.parse(String(init?.body)) as VtpInput, headers['PAYMENT-SIGNATURE'] ?? null, deps as never)
      return json(r.httpStatus, r.body, r.headers)
    }
    if (url.endsWith('/receipt')) return json(200, { verified: true, outcome: 'executed', detail: 'agent_paid' })
    throw new Error(`no fake for ${url}`)
  }
  const sent: Record<string, unknown>[] = []
  const signed: unknown[] = []
  const signer = {
    address: OPERATOR,
    signTypedData: async (r: unknown) => {
      signed.push(r)
      return `0x${'ab'.repeat(65)}`
    },
    sendTransaction: async (tx: Record<string, unknown>) => {
      sent.push(tx)
      return TX
    },
  }
  const run = () =>
    sdk.verifyThenPay({
      vault: VAULT,
      payee: PAYEE,
      amountUnits: AMOUNT,
      signer,
      baseUrl: ORIGIN,
      fetch: fetchFake,
      chain: clientChain(o.ownerIsOperator),
      clock: { now: () => 0, sleep: async () => {} },
      ...(o.payOnWarn ? { payOnWarn: true } : {}),
    })
  return { run, sent, signed, rows }
}

async function thrown(p: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await p
  } catch (e) {
    return e as Error & Record<string, unknown>
  }
  throw new Error('expected it to throw, and it resolved')
}

test('the real ALLOW answer is paid once, with what the client encoded, and reads as about this payee', async () => {
  const h = harness()
  const out = await h.run()
  assert.equal(out.outcome, 'executed')
  assert.equal(h.signed.length, 1)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].data, payData)
  assert.equal(out.verdict.agentId, PAYEE)
  assert.equal(out.check.amountUnits, '5000')
  assert.equal(out.record.recorded, true)
  assert.equal(h.rows.size, 1)
})

test('the real DENY answer throws, sends nothing, and links the record at our own base URL', async () => {
  const h = harness({ score: scored('DENY') })
  const e = await thrown(h.run())
  assert.equal(e.name, 'TrustDenyError')
  assert.equal(h.sent.length, 0)
  const context = e.context as { flowId: string; recordUrl: string }
  assert.equal(context.recordUrl, `${ORIGIN}/api/x402/gateway/flows/${context.flowId}`)
  assert.equal(h.rows.get(context.flowId)?.outcome, 'blocked')
})

test('the real WARN answer pays nothing and hands the owner the call the client encoded', async () => {
  const h = harness({ score: scored('WARN') })
  const out = await h.run()
  assert.equal(out.outcome, 'awaiting_human')
  assert.equal(h.sent.length, 0)
  assert.equal(out.ownerPay?.from, OWNER)
  assert.equal(out.ownerPay?.function, 'ownerPay(address,uint256)')
})

test('the real WARN answer with payOnWarn pays once', async () => {
  const h = harness({ score: scored('WARN'), payOnWarn: true })
  const out = await h.run()
  assert.equal(out.outcome, 'executed')
  assert.equal(h.sent.length, 1)
})

for (const [label, score, code] of [
  ['an ALLOW below 500', scored('ALLOW', { reputationScore: 60 }), 'SIGNALS_INCONSISTENT'],
  ['a null reputation', scored('ALLOW', { reputationScore: null }), 'REPUTATION_NOT_FINITE'],
  ['a verdict about another agent', scored('ALLOW', { agentId: OTHER }), 'CONTEXT_MISMATCH'],
] as const) {
  test(`the server's refusal of ${label} comes out as UnusableVerdictError ${code}, and nothing is sent`, async () => {
    const h = harness({ score })
    const e = await thrown(h.run())
    assert.equal(e.name, 'UnusableVerdictError')
    assert.equal(e.code, code)
    assert.equal(h.sent.length, 0)
  })
}

for (const [label, o, serverCode] of [
  ['a settle with no usable answer', { settle: { success: false, unknown: true, errorReason: 'Gateway settle did not answer within 8000 ms' } }, 'SETTLEMENT_UNKNOWN'],
  ['a transfer that could not be read back', { transfers: 'none' }, undefined],
] as [string, Setup, string | undefined][]) {
  test(`${label} comes out as UNCONFIRMED with paid null, and nothing is sent`, async () => {
    const h = harness(o)
    const e = await thrown(h.run())
    assert.equal(e.name, 'GatewayCheckError')
    assert.equal(e.code, 'UNCONFIRMED')
    assert.equal(e.paid, null)
    assert.equal(e.serverCode, serverCode)
    assert.equal(h.sent.length, 0)
  })
}

test("Gateway's own refusal comes out as REFUSED with paid false", async () => {
  const h = harness({ settle: { success: false, errorReason: 'insufficient_balance' } })
  const e = await thrown(h.run())
  assert.equal(e.name, 'GatewayCheckError')
  assert.equal(e.code, 'REFUSED')
  assert.equal(e.paid, false)
  assert.equal(h.sent.length, 0)
})

test('a WARN on a vault whose owner and operator are one key is NO_HUMAN_GATE: paid, with its record and the fix', async () => {
  const h = harness({ score: scored('WARN'), ownerIsOperator: true })
  const e = await thrown(h.run())
  assert.equal(e.name, 'GatewayCheckError')
  assert.equal(e.code, 'NO_HUMAN_GATE')
  assert.equal(e.paid, true)
  assert.equal(e.serverCode, 'warn_no_human_gate')
  assert.ok(String(e.recordUrl).startsWith(`${ORIGIN}/api/x402/gateway/flows/`), 'the record the server wrote')
  assert.match(e.message, /owner key the agent does not hold/)
  assert.doesNotMatch(e.message, /unknown stage/)
  assert.equal(h.sent.length, 0, 'nothing is sent')
})

test('a flow the server could not close comes out as FLOW_NOT_RECORDED with paid true, and nothing is sent', async () => {
  const h = harness({ closeFails: true })
  const e = await thrown(h.run())
  assert.equal(e.name, 'GatewayCheckError')
  assert.equal(e.code, 'FLOW_NOT_RECORDED')
  assert.equal(e.paid, true)
  assert.equal(h.sent.length, 0)
})

test('a reservation the server could not take refuses before anything is bought', async () => {
  const h = harness({ insertFails: true })
  const e = await thrown(h.run())
  assert.equal(e.name, 'GatewayCheckError')
  assert.notEqual(e.paid, true, 'the store failed before the settle, so nothing was charged')
  assert.equal(h.sent.length, 0)
})

test("a refusal only the server's preflight sees comes out under the vault's own error, with nothing signed", async () => {
  const h = harness({ serverFrozen: true })
  const e = await thrown(h.run())
  assert.equal(e.name, 'VaultPolicyError')
  assert.equal(e.code, 'IsFrozen')
  assert.equal(h.signed.length, 0)
  assert.equal(h.sent.length, 0)
})

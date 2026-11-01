/**
 * A preload for arc-vtp-runner.test.ts (`node --import`), never imported by anything else. It
 * replaces global fetch, so the spawned runner reaches no network at all: every RPC, the hosted
 * route and Circle Gateway answer from here, a URL nobody planned for is an error, and every
 * request is written down for the test to read. What it answers is the shape the real parties
 * answer in; verify-then-pay/sdk-contract.test.ts is what ties those shapes to the real route.
 */
import { appendFileSync } from 'node:fs'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, parseTransaction, type Hex } from 'viem'
import { getChainById } from './chains/index.js'
import { AgentSpendPolicyAbi } from './contracts/AgentSpendPolicy.js'

export type FakeScenario = {
  record: string
  operator: string
  baseUrl: string
  /** Gateway's answer for the operator's balance. */
  gatewayBalance?: string
  /** What the free 402 quotes, in base units. */
  price?: string
  /** From this free call on, the 402 quotes this instead: a server changing its mind mid-run. */
  priceLater?: { fromCall: number; price: string }
  /** What the paid check answers for the deny payee. Default DENY. */
  denyAnswer?: 'DENY' | 'ALLOW'
  /** What the receipt route answers. Default verified and executed. */
  receipt?: Record<string, unknown>
  proofRows?: Record<string, unknown>[]
  proofStatus?: number
}

const scenario = JSON.parse(process.env.ARC_VTP_FAKE ?? '{}') as FakeScenario
const arc = getChainById('arc-mainnet')!
const facilitator = arc.gateway!.facilitator
const USDC = (arc.contracts.usdc as string).toLowerCase()
const REGISTRY = (arc.contracts.identityRegistry as string).toLowerCase()
const OWNER = '0x' + 'b2'.repeat(20)
const PAY_TO = '0x' + 'f6'.repeat(20)
const MERIDIAN = '0x4e26ae66840134ac5979c56ba2509f3956b93431'
const OPERATING = '0xd305607510e0db2c95807173c7a05bea53c1ed36'
const FAR = 4_000_000_000n
const GAS_PRICE = 21_000_000_000n

const note = (entry: Record<string, unknown>) => appendFileSync(scenario.record, `${JSON.stringify(entry)}\n`)
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const hex = (n: bigint | number) => `0x${n.toString(16)}`

const REGISTRY_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const
const PAID_ABI = AgentSpendPolicyAbi as never
const TRANSFER = { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] } as const

const encodeResult = encodeFunctionResult as unknown as (a: { abi: unknown; functionName: string; result: unknown }) => Hex
const decodeCall = decodeFunctionData as unknown as (a: { abi: unknown; data: Hex }) => { functionName: string; args?: readonly unknown[] }
const encodeCall = encodeFunctionData as unknown as (a: { abi: unknown; functionName: string; args: readonly unknown[] }) => Hex
const encodeTopics = encodeEventTopics as unknown as (a: { abi: unknown; eventName: string; args: Record<string, unknown> }) => Hex[]

function ethCall(to: string, data: Hex): Hex {
  if (to.toLowerCase() === REGISTRY) {
    const d = decodeCall({ abi: REGISTRY_ABI, data })
    if (d.functionName === 'balanceOf') return encodeResult({ abi: REGISTRY_ABI, functionName: 'balanceOf', result: 1n })
    return encodeResult({ abi: REGISTRY_ABI, functionName: 'ownerOf', result: d.args?.[0] === 4306n ? MERIDIAN : OPERATING })
  }
  const d = decodeCall({ abi: AgentSpendPolicyAbi, data })
  if (d.functionName === 'pay') return '0x'
  const getters: Record<string, unknown> = {
    usdc: USDC,
    owner: OWNER,
    operator: scenario.operator,
    frozen: false,
    sessionKeyExpiry: FAR,
    allowlistEnabled: false,
    allowed: false,
    autoApproveMax: 250_000n,
    dailyCap: 1_000_000n,
    spentToday: 0n,
    balance: 1_000_000n,
  }
  if (!(d.functionName in getters)) throw new Error(`the fake vault has no ${d.functionName}`)
  return encodeResult({ abi: AgentSpendPolicyAbi, functionName: d.functionName, result: getters[d.functionName] })
}

/** What a node answers for a method it does not have: viem tries eth_fillTransaction first. */
const METHOD_NOT_FOUND = Symbol('method not found')

const sent = new Map<string, { to: string; data: Hex; maxFeePerGas: bigint }>()

function receiptOf(hash: string) {
  const tx = sent.get(hash)
  if (!tx) return null
  const d = decodeCall({ abi: AgentSpendPolicyAbi, data: tx.data })
  const [to, amount] = d.args as [string, bigint]
  return {
    transactionHash: hash,
    status: '0x1',
    blockNumber: hex(17),
    from: scenario.operator,
    to: tx.to,
    gasUsed: hex(90_000),
    effectiveGasPrice: hex(GAS_PRICE),
    logs: [
      { address: USDC, topics: encodeEventTopics({ abi: [TRANSFER], eventName: 'Transfer', args: { from: tx.to as Hex, to: to as Hex } }), data: encodeAbiParameters([{ type: 'uint256' }], [amount]) },
      { address: tx.to, topics: encodeTopics({ abi: PAID_ABI, eventName: 'Paid', args: { to, dayIndex: 20_000n } }), data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [amount, false]) },
    ],
  }
}

function rpc(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return hex(arc.evmChainId as number)
    case 'eth_call': {
      const q = params[0] as { to: string; data: Hex }
      return ethCall(q.to, q.data)
    }
    case 'eth_getCode':
      return String(params[0]).toLowerCase() === scenario.operator ? '0x' : '0x6001'
    case 'eth_gasPrice':
      return hex(GAS_PRICE)
    case 'eth_getBalance':
      return hex(10n ** 18n)
    case 'eth_estimateGas':
      return hex(100_000)
    case 'eth_getTransactionCount':
      return '0x1'
    case 'eth_maxPriorityFeePerGas':
      return hex(1_000_000_000)
    case 'eth_getBlockByNumber':
      return { number: hex(16), timestamp: hex(1_800_000_000), hash: `0x${'11'.repeat(32)}`, baseFeePerGas: hex(GAS_PRICE) }
    case 'eth_sendRawTransaction': {
      const raw = params[0] as Hex
      const tx = parseTransaction(raw)
      const hash = keccak256(raw)
      sent.set(hash, { to: String(tx.to).toLowerCase(), data: tx.data as Hex, maxFeePerGas: tx.maxFeePerGas ?? 0n })
      note({ kind: 'raw_tx', hash, to: tx.to, data: tx.data })
      return hash
    }
    case 'eth_getTransactionByHash': {
      const tx = sent.get(String(params[0]))
      return tx ? { hash: params[0], from: scenario.operator, to: tx.to, input: tx.data, maxFeePerGas: hex(tx.maxFeePerGas) } : null
    }
    case 'eth_getTransactionReceipt':
      return receiptOf(String(params[0]))
    default:
      return METHOD_NOT_FOUND
  }
}

let freeCalls = 0

function offer(): Record<string, unknown> {
  freeCalls += 1
  const later = scenario.priceLater
  const amount = later && freeCalls >= later.fromCall ? later.price : (scenario.price ?? '5000')
  return {
    scheme: 'exact',
    network: arc.caip2,
    asset: USDC,
    amount,
    maxAmountRequired: amount,
    payTo: PAY_TO,
    maxTimeoutSeconds: 3600,
    resource: `${scenario.baseUrl}/api/x402/gateway/tools/risk_check`,
    extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: arc.gateway!.wallet.toLowerCase(), minValiditySeconds: 604800 },
  }
}

function paidAnswer(req: { vault: string; payee: string; amount: string }, signature: string): Response {
  const sent = JSON.parse(Buffer.from(signature, 'base64').toString('utf8')) as { payload: { authorization: { nonce: string; from: string } } }
  const nonce = sent.payload.authorization.nonce.toLowerCase()
  const isDenyPayee = req.payee === OPERATING
  const decision = isDenyPayee ? (scenario.denyAnswer ?? 'DENY') : 'ALLOW'
  const common = {
    tool: 'verify_then_pay',
    network: arc.caip2,
    executed: false,
    charged: true,
    flowId: nonce,
    checks: null,
    check: { network: arc.caip2, authNonce: nonce, transferId: 'transfer-1', gatewayOutcome: 'credited', payer: sent.payload.authorization.from.toLowerCase(), amountUnits: '5000', resource: '/api/x402/gateway/tools/risk_check', checkedAt: '2026-11-01T10:00:00.000Z' },
    verdict: { decision, effective: decision, risk: decision === 'DENY' ? 'high' : 'low', reasons: [`reason for ${decision}`], reputationScore: decision === 'DENY' ? 60 : 545, agentId: req.payee, txContext: { payee: req.payee, amountUsd: Number(req.amount) / 10 ** arc.usdcDecimals } },
    ownerHandoff: null,
    next: 'next',
  }
  const url = `${scenario.baseUrl}/api/x402/gateway/flows/${nonce}`
  if (decision === 'DENY') return json(200, { ...common, stage: 'deny', prepared: null, record: { url, outcome: 'blocked', detail: 'deny', recorded: true } })
  return json(200, {
    ...common,
    stage: 'prepared',
    prepared: {
      chainId: arc.evmChainId,
      from: scenario.operator,
      to: req.vault,
      value: '0',
      data: encodeCall({ abi: AgentSpendPolicyAbi, functionName: 'pay', args: [req.payee, BigInt(req.amount)] }),
      function: 'pay(address,uint256)',
      args: [req.payee, req.amount],
      fees: { maxFeePerGas: (2n * GAS_PRICE + 1_000_000_000n).toString(), maxPriorityFeePerGas: '1000000000', gas: '120000' },
      simulation: { ok: true },
    },
    record: { url, outcome: 'pending', detail: 'agent_will_pay', recorded: true },
  })
}

function api(url: URL, method: string, headers: Headers, body: unknown): Response {
  const path = url.pathname
  if (path === '/api/x402/gateway/verify-then-pay') {
    const signature = headers.get('payment-signature')
    if (signature) return paidAnswer(body as { vault: string; payee: string; amount: string }, signature)
    const challenge = { x402Version: 2, error: 'payment required', accepts: [offer()] }
    return json(402, { tool: 'verify_then_pay', stage: 'payment_required', charged: false, challenge }, { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') })
  }
  if (path === '/api/x402/gateway/tools/trust_preview') {
    const denied = (body as { agentId: string }).agentId === OPERATING
    return json(200, { verified: true, kya_status: denied ? 'unknown' : 'verified', scoreBand: denied ? 'very-low' : 'medium', flags: { revoked: false, sybilSuspected: false } })
  }
  if (path === '/api/reputation') {
    if (url.searchParams.get('id') === OPERATING) return json(404, { error: 'not found' })
    return json(200, { reputation: { score: 545, breakdown: { tenure: 50 }, sybil: { level: 'none' } } })
  }
  if (path === '/api/x402/gateway/proof') return json(scenario.proofStatus ?? 200, { recent: scenario.proofRows ?? [] })
  if (path.endsWith('/receipt')) return json(200, scenario.receipt ?? { verified: true, outcome: 'executed', detail: 'agent_paid' })
  throw new Error(`the fake API has no ${method} ${path}`)
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(href)
  const method = init?.method ?? 'GET'
  const headers = new Headers(init?.headers)
  const raw = typeof init?.body === 'string' ? init.body : null
  const body: unknown = raw ? JSON.parse(raw) : null
  note({ kind: 'http', href, method, paid: headers.has('payment-signature'), body })
  if (href.startsWith(facilitator)) {
    if (url.pathname === '/v1/x402/supported') return json(200, { kinds: [{ network: arc.caip2, scheme: 'exact', extra: { verifyingContract: arc.gateway!.wallet, assets: [{ address: USDC, decimals: arc.usdcDecimals }] } }] })
    if (url.pathname === '/v1/balances') return json(200, { balances: [{ balance: scenario.gatewayBalance ?? '1.000000' }] })
    throw new Error(`the fake Gateway has no ${url.pathname}`)
  }
  if (href.startsWith(scenario.baseUrl)) return api(url, method, headers, body)
  if (arc.rpcUrls.includes(url.href) || arc.rpcUrls.includes(href) || arc.rpcUrls.some((u) => new URL(u).host === url.host)) {
    const q = body as { id: number; method: string; params: unknown[] }
    const result = rpc(q.method, q.params)
    if (result === METHOD_NOT_FOUND) return json(200, { jsonrpc: '2.0', id: q.id, error: { code: -32601, message: `the method ${q.method} does not exist` } })
    return json(200, { jsonrpc: '2.0', id: q.id, result })
  }
  note({ kind: 'unplanned', href })
  throw new Error(`no network in this test: ${href}`)
}) as typeof fetch

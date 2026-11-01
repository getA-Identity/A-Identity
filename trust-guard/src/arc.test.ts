import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createWalletClient, custom, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionData, encodeFunctionResult, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { TrustDenyError, TrustGuard, type FetchLike } from './index.js'
import {
  ARC_MAINNET,
  ArcAssetError,
  ArcCallRevert,
  ArcRpcUnreachableError,
  GatewayCheckError,
  PayeeNotRegisteredError,
  UnusableVerdictError,
  VaultPaymentError,
  VaultPolicyError,
  arcChainReader,
  arcGatewayPayer,
  arcViemChain,
  fromViemWallet,
  preflightVault,
  recordFlowReceipt,
  usdcUnits,
  verifyThenPay,
  type Address,
  type ArcChainReader,
  type ArcClock,
  type ArcPreparedTx,
  type ArcReceipt,
  type ArcTransaction,
  type Hex,
  type TypedDataRequest,
  type VerifyThenPayOptions,
} from './arc.js'
import { ARC_VAULT_ABI } from './arc-mainnet.generated.js'

/**
 * verifyThenPay with every outside party faked: Arc Mainnet's reads, the A-Identity route,
 * Circle Gateway, and both signers as spies. No network. The signing is real: Circle's own
 * BatchEvmScheme runs against the spy, so what is asserted is what would be sent.
 *
 * The fake route answers in the exact shapes mcp/src/verify-then-pay/core.ts answers in.
 */

const GWEI = 1_000_000_000n
const USDC = ARC_MAINNET.usdc.toLowerCase() as Address
const REGISTRY = ARC_MAINNET.identityRegistry.toLowerCase() as Address
const GATEWAY = ARC_MAINNET.gatewayFacilitator
const VAULT = `0x${'a1'.repeat(20)}` as Address
const OWNER = `0x${'b2'.repeat(20)}` as Address
const OPERATOR = `0x${'c3'.repeat(20)}` as Address
const PAYEE = `0x${'d4'.repeat(20)}` as Address
const SEPARATE_PAYER = `0x${'e5'.repeat(20)}` as Address
const PAY_TO = `0x${'f6'.repeat(20)}` as Address
const TX_HASH = `0x${'77'.repeat(32)}` as Hex
const BASE = 'https://api.example'
const AMOUNT = 250_000n
const BLOCK_TS = 1_800_000_000n
const FAR = 2_000_000_000n

const REGISTRY_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const
const TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const
const VAULT_ABI = ARC_VAULT_ABI as never
// The ABIs here are data and the calls are by name, so viem's literal types get in the way.
const encodeError = encodeErrorResult as unknown as (a: { abi: unknown; errorName: string }) => Hex
const encodeResult = encodeFunctionResult as unknown as (a: { abi: unknown; functionName: string; result: unknown }) => Hex
const encodeCall = encodeFunctionData as unknown as (a: { abi: unknown; functionName: string; args: readonly unknown[] }) => Hex
const encodeTopics = encodeEventTopics as unknown as (a: { abi: unknown; eventName: string; args: Record<string, unknown> }) => Hex[]

// ── Arc Mainnet, faked ────────────────────────────────────────────────────────────

type World = {
  code: Hex
  operatorCode: Hex
  usdc: Address
  owner: Address
  operator: Address
  frozen: boolean
  sessionKeyExpiry: bigint | 'reverts'
  allowlistEnabled: boolean
  allowed: boolean
  autoApproveMax: bigint
  dailyCap: bigint
  spentToday: bigint
  balance: bigint
  gasPrice: bigint
  operatorGas: bigint
  agentsHeld: bigint | 'unreadable'
  agentOwner: Address | 'reverts' | 'unreadable'
  simRevert: string | null
}

const world = (over: Partial<World> = {}): World => ({
  code: '0x6001',
  operatorCode: '0x',
  usdc: USDC,
  owner: OWNER,
  operator: OPERATOR,
  frozen: false,
  sessionKeyExpiry: FAR,
  allowlistEnabled: false,
  allowed: false,
  autoApproveMax: 500_000n,
  dailyCap: 1_000_000n,
  spentToday: 0n,
  balance: 1_000_000n,
  gasPrice: 20n * GWEI,
  operatorGas: 10n ** 18n,
  agentsHeld: 1n,
  agentOwner: PAYEE,
  simRevert: null,
  ...over,
})

function receiptFor(hash: Hex, over: Partial<ArcReceipt> = {}): ArcReceipt {
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }], [AMOUNT, false])
  const paidTopics = encodeTopics({ abi: VAULT_ABI, eventName: 'Paid', args: { to: PAYEE, dayIndex: 20_000n } })
  const moved = encodeEventTopics({ abi: [TRANSFER_EVENT], eventName: 'Transfer', args: { from: VAULT, to: PAYEE } }) as Hex[]
  return {
    transactionHash: hash,
    status: 'success',
    blockNumber: 1234n,
    from: OPERATOR,
    to: VAULT,
    gasUsed: 91_000n,
    effectiveGasPrice: 41n * GWEI,
    logs: [
      // Arc's own native-balance log of the same payment: 18 decimals, from a system address.
      { address: `0x${'ee'.repeat(20)}`, topics: moved, data: encodeAbiParameters([{ type: 'uint256' }], [AMOUNT * 10n ** 12n]) },
      { address: USDC, topics: moved, data: encodeAbiParameters([{ type: 'uint256' }], [AMOUNT]) },
      { address: VAULT, topics: paidTopics, data },
    ],
    source: 'rpc.example',
    ...over,
  }
}

type FakeChain = ArcChainReader & { w: World; log: string[]; receipts: number; txReads: number }

function fakeChain(
  w: World,
  over: { receipt?: (h: Hex, n: number) => ArcReceipt | null; transaction?: (h: Hex, n: number) => ArcTransaction | null; afterCheck?: () => void } = {},
): FakeChain {
  const log: string[] = []
  const answer = (data: Hex, abi: unknown, functionName: string, value: unknown): Hex => encodeResult({ abi, functionName, result: value })
  const c: FakeChain = {
    w,
    log,
    receipts: 0,
    txReads: 0,
    code: async (a) => (a === OPERATOR || a === w.operator ? w.operatorCode : w.code),
    latestBlock: async () => ({ number: 1000n, timestamp: BLOCK_TS }),
    gasPrice: async () => w.gasPrice,
    nativeBalance: async () => w.operatorGas,
    estimateGas: async () => {
      if (w.simRevert) throw new ArcCallRevert('execution reverted', encodeError({ abi: VAULT_ABI, errorName: w.simRevert }))
      return 100_000n
    },
    call: async ({ to, data, from }) => {
      log.push(`call:${from ? 'from' : 'view'}`)
      if (to === REGISTRY) {
        const d = decodeFunctionData({ abi: REGISTRY_ABI, data })
        if (d.functionName === 'balanceOf') {
          if (w.agentsHeld === 'unreadable') throw new ArcRpcUnreachableError('no host')
          return answer(data, REGISTRY_ABI, 'balanceOf', w.agentsHeld)
        }
        if (w.agentOwner === 'reverts') throw new ArcCallRevert('execution reverted')
        if (w.agentOwner === 'unreadable') throw new ArcRpcUnreachableError('no host')
        return answer(data, REGISTRY_ABI, 'ownerOf', w.agentOwner)
      }
      const d = decodeFunctionData({ abi: VAULT_ABI, data }) as { functionName: string }
      if (d.functionName === 'pay') {
        if (w.simRevert) throw new ArcCallRevert('execution reverted', encodeError({ abi: VAULT_ABI, errorName: w.simRevert }))
        return '0x'
      }
      if (d.functionName === 'sessionKeyExpiry' && w.sessionKeyExpiry === 'reverts') throw new ArcCallRevert('execution reverted')
      const value = d.functionName === 'allowed' ? w.allowed : (w as unknown as Record<string, unknown>)[d.functionName]
      return answer(data, VAULT_ABI, d.functionName, value)
    },
    transaction: async (h) => {
      c.txReads += 1
      return over.transaction ? over.transaction(h, c.txReads) : { from: OPERATOR, to: VAULT, input: payData(), maxFeePerGas: 41n * GWEI }
    },
    receipt: async (h) => {
      c.receipts += 1
      return over.receipt ? over.receipt(h, c.receipts) : receiptFor(h)
    },
  }
  return c
}

const payData = (payee: Address = PAYEE, amount: bigint = AMOUNT): Hex => encodeCall({ abi: VAULT_ABI, functionName: 'pay', args: [payee, amount] })
const ownerPayData = (payee: Address = PAYEE, amount: bigint = AMOUNT): Hex => encodeCall({ abi: VAULT_ABI, functionName: 'ownerPay', args: [payee, amount] })

// ── the signers ───────────────────────────────────────────────────────────────────

type SpySigner = {
  address: Address
  sent: ArcPreparedTx[]
  signed: TypedDataRequest[]
  sendTransaction(tx: ArcPreparedTx): Promise<Hex>
  signTypedData(r: TypedDataRequest): Promise<Hex>
}

function spySigner(address: Address = OPERATOR): SpySigner {
  const s: SpySigner = {
    address,
    sent: [],
    signed: [],
    sendTransaction: async (tx) => {
      s.sent.push(tx)
      return TX_HASH
    },
    signTypedData: async (r) => {
      s.signed.push(r)
      return `0x${'ab'.repeat(65)}`
    },
  }
  return s
}

// ── the route and Gateway, faked ──────────────────────────────────────────────────

const OFFER = {
  scheme: 'exact',
  network: ARC_MAINNET.caip2,
  asset: USDC,
  amount: '5000',
  maxAmountRequired: '5000',
  payTo: PAY_TO,
  maxTimeoutSeconds: 3600,
  resource: `${BASE}/api/x402/gateway/tools/risk_check`,
  extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: ARC_MAINNET.gatewayWallet.toLowerCase(), minValiditySeconds: 604800 },
}

type Paid = { nonce: string; from: string; payload: Record<string, unknown> }
type Reply = { status: number; body: unknown; headers?: Record<string, string> }

function checkRef(p: Paid, over: Record<string, unknown> = {}) {
  return { network: ARC_MAINNET.caip2, authNonce: p.nonce, transferId: 'transfer-1', gatewayOutcome: 'credited', payer: p.from, amountUnits: '5000', resource: '/api/x402/gateway/tools/risk_check', checkedAt: '2026-11-01T10:00:00.000Z', ...over }
}

const verdictView = (decision: string, over: Record<string, unknown> = {}) => ({ decision, effective: decision, risk: decision === 'ALLOW' ? 'low' : 'high', reasons: [`reason for ${decision}`], reputationScore: decision === 'ALLOW' ? 545 : 470, ...over })

function preparedCall(over: Record<string, unknown> = {}) {
  return {
    chainId: ARC_MAINNET.chainId,
    from: OPERATOR,
    to: VAULT,
    value: '0',
    data: payData(),
    function: 'pay(address,uint256)',
    args: [PAYEE, AMOUNT.toString()],
    fees: { maxFeePerGas: (41n * GWEI).toString(), maxPriorityFeePerGas: GWEI.toString(), floorWei: (20n * GWEI).toString(), capWei: (200n * GWEI).toString(), clamped: false, gas: '120000', maxCostUsdc: '0.00492' },
    simulation: { ok: true },
    ...over,
  }
}

function ownerPayCall(over: Record<string, unknown> = {}) {
  return { ...preparedCall(), from: OWNER, data: ownerPayData(), function: 'ownerPay(address,uint256)', ...over }
}

function answerBody(p: Paid, stage: string, over: Record<string, unknown> = {}) {
  return {
    tool: 'verify_then_pay',
    network: ARC_MAINNET.caip2,
    stage,
    executed: false,
    charged: true,
    flowId: p.nonce,
    checks: null,
    check: checkRef(p),
    verdict: null,
    prepared: null,
    ownerHandoff: null,
    record: { url: `https://elsewhere.example/flows/${p.nonce}`, outcome: 'pending', detail: 'agent_will_pay', recorded: true },
    next: 'next',
    ...over,
  }
}

const allow = (p: Paid, over: Record<string, unknown> = {}): Reply => ({ status: 200, body: answerBody(p, 'prepared', { verdict: verdictView('ALLOW'), prepared: preparedCall(), ...over }) })
const deny = (p: Paid, over: Record<string, unknown> = {}): Reply => ({ status: 200, body: answerBody(p, 'deny', { verdict: verdictView('DENY', { reputationScore: 60 }), record: { url: 'x', outcome: 'blocked', detail: 'deny', recorded: true }, ...over }) })
const warn = (p: Paid, over: Record<string, unknown> = {}): Reply => ({
  status: 200,
  body: answerBody(p, 'awaiting_human', { verdict: verdictView('WARN'), ownerHandoff: { auditOutcome: 'awaiting_human', owner: OWNER, ownerPay: ownerPayCall() }, record: { url: 'x', outcome: 'awaiting_human', detail: 'warn_handoff', recorded: true }, ...over }),
})

const challengeBody = (offer: Record<string, unknown> = OFFER) => ({ x402Version: 2, error: 'payment required', accepts: [offer] })

type Api = FetchLike & { calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[]; vtp(): number; receipts(): number; gateway(): number }

function fakeApi(o: {
  paid?: (p: Paid) => Reply | Promise<Reply>
  first?: () => Reply
  offer?: Record<string, unknown>
  supported?: () => Reply
  balance?: string
  receipt?: (n: number) => Reply
} = {}): Api {
  const calls: Api['calls'] = []
  let receipts = 0
  const f = (async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ method: init?.method ?? 'GET', url, headers, body })
    const send = (r: Reply) => new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status, headers: r.headers })
    if (url === `${GATEWAY}/v1/x402/supported`) {
      return send(o.supported ? o.supported() : { status: 200, body: { kinds: [{ network: ARC_MAINNET.caip2, scheme: 'exact', extra: { verifyingContract: ARC_MAINNET.gatewayWallet, assets: [{ address: USDC, decimals: 6 }] } }] } })
    }
    if (url === `${GATEWAY}/v1/balances`) return send({ status: 200, body: { balances: [{ balance: o.balance ?? '1.000000' }] } })
    if (url.endsWith('/receipt')) {
      receipts += 1
      return send(o.receipt ? o.receipt(receipts) : { status: 200, body: { tool: 'verify_then_pay_receipt', verified: true, outcome: 'executed', detail: 'agent_paid', next: 'done' } })
    }
    if (url === `${BASE}/api/x402/gateway/verify-then-pay`) {
      const sig = headers['payment-signature']
      if (!sig) {
        if (o.first) return send(o.first())
        const challenge = challengeBody(o.offer ?? OFFER)
        return send({ status: 402, body: { tool: 'verify_then_pay', stage: 'payment_required', charged: false, challenge }, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challenge)).toString('base64') } })
      }
      const payload = JSON.parse(Buffer.from(sig, 'base64').toString('utf8'))
      const auth = payload.payload.authorization
      return send(await (o.paid ?? allow)({ nonce: auth.nonce.toLowerCase(), from: auth.from.toLowerCase(), payload }))
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as Api
  f.calls = calls
  f.vtp = () => calls.filter((c) => c.url.endsWith('/verify-then-pay')).length
  f.receipts = () => calls.filter((c) => c.url.endsWith('/receipt')).length
  f.gateway = () => calls.filter((c) => c.url.startsWith(GATEWAY)).length
  return f
}

function fakeClock(): ArcClock & { t: number } {
  const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) }
  return c
}

function options(api: Api, chain: ArcChainReader, signer: SpySigner, over: Partial<VerifyThenPayOptions> = {}): VerifyThenPayOptions {
  return { vault: VAULT, payee: PAYEE, amountUnits: AMOUNT, signer, baseUrl: BASE, fetch: api, chain, clock: fakeClock(), ...over }
}

function setup(apiOver: Parameters<typeof fakeApi>[0] = {}, w: Partial<World> = {}, chainOver: Parameters<typeof fakeChain>[1] = {}) {
  const api = fakeApi(apiOver)
  const chain = fakeChain(world(w), chainOver)
  const signer = spySigner()
  return { api, chain, signer, opts: options(api, chain, signer) }
}

async function refused<E extends Error>(p: Promise<unknown>, type: new (...args: never[]) => E): Promise<E> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof type, `expected ${type.name}, got ${(e as Error).name}: ${(e as Error).message}`)
    return e
  }
  throw new Error(`expected ${type.name}, and it resolved`)
}

// ── 1. DENY ───────────────────────────────────────────────────────────────────────

test('DENY never calls the operator, signs once, and names the flow', async () => {
  const { api, signer, opts } = setup({ paid: deny })
  const e = await refused(verifyThenPay(opts), TrustDenyError)
  assert.equal(signer.sent.length, 0, 'the operator is never called')
  assert.equal(signer.signed.length, 1, 'the check is signed exactly once')
  assert.equal(api.vtp(), 2, 'the 402, then the paid POST')
  assert.equal(api.receipts(), 0)
  assert.equal(e.verdict.decision, 'DENY')
  assert.equal(e.verdict.agentId, PAYEE)
  assert.match(e.context?.flowId ?? '', /^0x[0-9a-f]{64}$/)
  assert.equal(e.context?.check?.network, ARC_MAINNET.caip2)
  assert.equal(e.context?.recordUrl, `${BASE}/api/x402/gateway/flows/${e.context?.flowId}`, "at our base URL, never the server's word")
})

test('a separate payer pays for the DENY and the operator signs nothing at all', async () => {
  const { signer, opts } = setup({ paid: deny })
  const payer = spySigner(SEPARATE_PAYER)
  await refused(verifyThenPay({ ...opts, payer }), TrustDenyError)
  assert.equal(payer.signed.length, 1)
  assert.equal(signer.signed.length, 0)
  assert.equal(signer.sent.length, 0)
})

test('a DENY the server could not record throws DENY all the same, with no record link', async () => {
  const { signer, opts } = setup({ paid: (p) => ({ status: 500, body: (deny(p, { flowId: null, record: { url: null, outcome: 'blocked', detail: 'deny', recorded: false, reason: 'db down' } }) as { body: object }).body }) })
  const e = await refused(verifyThenPay(opts), TrustDenyError)
  assert.equal(e.context?.recordUrl, undefined)
  assert.equal(signer.sent.length, 0)
})

test('DENY wins over a stage that says prepared', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { verdict: verdictView('DENY') }) })
  await refused(verifyThenPay(opts), TrustDenyError)
  assert.equal(signer.sent.length, 0)
})

// ── 2. ALLOW ──────────────────────────────────────────────────────────────────────

test('ALLOW pays once for the exact amount, and reads the receipt back', async () => {
  const { api, chain, signer, opts } = setup()
  const out = await verifyThenPay(opts)
  assert.equal(out.outcome, 'executed')
  assert.equal(signer.sent.length, 1, 'exactly one transaction')
  const tx = signer.sent[0]
  const d = decodeFunctionData({ abi: VAULT_ABI, data: tx.data }) as { functionName: string; args: [string, bigint] }
  assert.equal(d.functionName, 'pay')
  assert.equal(d.args[0].toLowerCase(), PAYEE)
  assert.equal(d.args[1], AMOUNT)
  assert.equal(tx.chainId, ARC_MAINNET.chainId)
  assert.equal(tx.value, 0n)
  assert.equal(tx.to, VAULT)
  assert.equal(tx.from, OPERATOR)
  assert.ok(tx.maxFeePerGas >= ARC_MAINNET.minMaxFeePerGasWei)
  assert.ok(chain.receipts >= 1)
  if (out.outcome !== 'executed') return
  assert.equal(out.payment.txHash, TX_HASH)
  assert.equal(out.payment.amountUnits, AMOUNT)
  assert.equal(out.payment.blockNumber, 1234n)
  assert.equal(out.payment.readBackFrom, 'rpc.example')
  assert.equal(out.payment.transactionReadBack, true)
  assert.equal(out.payment.explorerUrl, `${ARC_MAINNET.explorer}/tx/${TX_HASH}`)
  assert.equal(out.verdict.decision, 'ALLOW')
  assert.equal(out.record.recorded, true)
  assert.equal(out.record.url, `${BASE}/api/x402/gateway/flows/${out.flowId}`)
  assert.equal(api.receipts(), 1)
  const posted = api.calls.find((c) => c.url.endsWith('/receipt'))
  assert.deepEqual(posted?.body, { txHash: TX_HASH })
})

test('the check is bought with the payee address and the offer, signed for the Gateway domain', async () => {
  const { api, signer, opts } = setup()
  await verifyThenPay({ ...opts, payeeAgentId: `${ARC_MAINNET.caip2}:8004/7` })
  const [first, paid] = api.calls.filter((c) => c.url.endsWith('/verify-then-pay'))
  assert.equal(first.headers['payment-signature'], undefined)
  assert.deepEqual(first.body, paid.body, 'the same request, with the payment added')
  assert.deepEqual(first.body, { vault: VAULT, payee: PAYEE, amount: '250000', payeeAgentId: `${ARC_MAINNET.caip2}:8004/7`, payOnWarn: false })
  const sent = JSON.parse(Buffer.from(paid.headers['payment-signature'], 'base64').toString('utf8'))
  assert.equal(sent.x402Version, 2)
  assert.equal(sent.accepted.network, ARC_MAINNET.caip2)
  assert.equal(sent.payload.authorization.from, OPERATOR)
  assert.equal(sent.payload.authorization.value, '5000')
  const typed = signer.signed[0]
  assert.equal(typed.domain.name, 'GatewayWalletBatched')
  assert.equal(typed.domain.version, '1')
  assert.equal(typed.domain.chainId, ARC_MAINNET.chainId)
  assert.equal(typed.domain.verifyingContract.toLowerCase(), ARC_MAINNET.gatewayWallet.toLowerCase())
})

test('polling a receipt many times never sends again', async () => {
  const { signer, chain, opts } = setup({}, {}, { receipt: (h, n) => (n < 4 ? null : receiptFor(h)) })
  const out = await verifyThenPay(opts)
  assert.equal(out.outcome, 'executed')
  assert.equal(chain.receipts, 4)
  assert.equal(signer.sent.length, 1)
})

// ── 3. the wrong token ────────────────────────────────────────────────────────────

test('a wrong asset refuses before any fetch and any signature', async () => {
  const { api, chain, signer, opts } = setup()
  const lookalike = `0x${'99'.repeat(20)}` as Address
  const e = await refused(verifyThenPay({ ...opts, asset: lookalike }), ArcAssetError)
  assert.equal(e.code, 'WRONG_ASSET')
  assert.equal(e.got, lookalike)
  assert.equal(api.calls.length, 0)
  assert.equal(chain.log.length, 0, 'not even a chain read')
  assert.equal(signer.signed.length, 0)
  assert.equal(signer.sent.length, 0)
})

test("the right asset given explicitly, in any case, is accepted and sent as given", async () => {
  const { opts } = setup()
  const out = await verifyThenPay({ ...opts, asset: ARC_MAINNET.usdc })
  assert.equal(out.outcome, 'executed')
})

test('a vault holding a lookalike token refuses before any fetch', async () => {
  const lookalike = `0x${'99'.repeat(20)}` as Address
  const { api, signer, opts } = setup({}, { usdc: lookalike })
  const e = await refused(verifyThenPay(opts), ArcAssetError)
  assert.equal(e.code, 'VAULT_TOKEN_MISMATCH')
  assert.equal(api.calls.length, 0)
  assert.equal(signer.signed.length, 0)
})

// ── 4. a reputation that is not a number ──────────────────────────────────────────

for (const [label, value] of [
  ['null', null],
  ['missing', undefined],
  ['the string "NaN"', 'NaN'],
  ['above the scale', 1001],
  ['below the scale', -1],
] as const) {
  test(`an ALLOW whose reputation is ${label} refuses and never calls the operator`, async () => {
    const { signer, opts } = setup({ paid: (p) => allow(p, { verdict: verdictView('ALLOW', { reputationScore: value }) }) })
    const e = await refused(verifyThenPay(opts), UnusableVerdictError)
    assert.equal(e.code, 'REPUTATION_NOT_FINITE')
    assert.equal(signer.sent.length, 0)
    assert.equal(signer.signed.length, 1)
  })
}

test("the server's own verdict_unusable refuses under the code it names", async () => {
  const { signer, opts } = setup({ paid: (p) => ({ status: 200, body: answerBody(p, 'verdict_unusable', { code: 'REPUTATION_NOT_FINITE', reason: 'the reputation is null', verdict: { decision: 'ALLOW', effective: 'DENY', reputationScore: null, reasons: [], risk: null, overriddenBecause: 'REPUTATION_NOT_FINITE' } }) }) })
  const e = await refused(verifyThenPay(opts), UnusableVerdictError)
  assert.equal(e.code, 'REPUTATION_NOT_FINITE')
  assert.equal(signer.sent.length, 0)
})

for (const decision of ['MAYBE', null, undefined, 'allow', 1]) {
  test(`a decision of ${JSON.stringify(decision)} is never ALLOW`, async () => {
    const { signer, opts } = setup({ paid: (p) => allow(p, { verdict: verdictView('ALLOW', { decision, effective: decision }) }) })
    const e = await refused(verifyThenPay(opts), UnusableVerdictError)
    assert.equal(e.code, 'DECISION_UNKNOWN')
    assert.equal(signer.sent.length, 0)
  })
}

test('a decision that its effective decision overrides is never ALLOW', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { verdict: verdictView('ALLOW', { effective: 'DENY' }) }) })
  await refused(verifyThenPay(opts), UnusableVerdictError)
  assert.equal(signer.sent.length, 0)
})

test('a missing verdict is never ALLOW', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { verdict: null }) })
  await refused(verifyThenPay(opts), UnusableVerdictError)
  assert.equal(signer.sent.length, 0)
})

// ── 5. Gateway failures ───────────────────────────────────────────────────────────

const failed = (p: Paid, status: number, body: Record<string, unknown>): Reply => ({ status, body: answerBody(p, 'check_failed', { check: null, record: null, flowId: null, ...body }) })

for (const [label, reply, code, paid] of [
  ['402 after paying', (p: Paid) => failed(p, 402, { charged: false, reason: 'Gateway refused the payment' }), 'REFUSED', false],
  ['502 settlement unconfirmed', (p: Paid) => failed(p, 502, { charged: null, reason: 'settlement unconfirmed' }), 'UNCONFIRMED', null],
  ['502 settlement failed', (p: Paid) => failed(p, 502, { charged: false, reason: 'settlement failed' }), 'REFUSED', false],
  ['503 kind unproven', (p: Paid) => failed(p, 503, { charged: false, reason: 'Gateway kind unproven' }), 'REFUSED', false],
  ['500 after settlement', (p: Paid) => failed(p, 500, { charged: true, reason: 'the tool failed' }), 'TOOL_FAILED_AFTER_SETTLEMENT', true],
  ['the flow not recorded', (p: Paid) => failed(p, 409, { charged: true, code: 'FLOW_NOT_RECORDED', reason: 'db down' }), 'FLOW_NOT_RECORDED', true],
  ['the verdict block unreadable', (p: Paid) => failed(p, 503, { charged: true, code: 'VERDICT_BLOCK_UNREADABLE', reason: 'no block' }), 'VERDICT_BLOCK_UNREADABLE', true],
  ['the rail gone', (p: Paid) => ({ status: 503, body: answerBody(p, 'unavailable', { charged: false, check: null }) }), 'REFUSED', false],
  ['an HTML 504 from a proxy', () => ({ status: 504, body: '<html>Gateway Timeout</html>' }), 'NETWORK', null],
] as const) {
  test(`${label} refuses with the right paid flag and never calls the operator`, async () => {
    const { signer, opts } = setup({ paid: reply as (p: Paid) => Reply })
    const e = await refused(verifyThenPay(opts), GatewayCheckError)
    assert.equal(e.code, code)
    assert.equal(e.paid, paid)
    assert.equal(signer.sent.length, 0)
    assert.match(e.authNonce ?? '', /^0x[0-9a-f]{64}$/)
  })
}

test('a fetch that throws on the paid POST leaves paid unknown and never calls the operator', async () => {
  const { signer, opts } = setup({
    paid: () => {
      throw new Error('socket hang up')
    },
  })
  const e = await refused(verifyThenPay(opts), GatewayCheckError)
  assert.equal(e.code, 'NETWORK')
  assert.equal(e.paid, null)
  assert.equal(signer.sent.length, 0)
})

test('a paid POST that never answers is cut off at the deadline, with paid unknown', async () => {
  const { signer, opts } = setup({ paid: () => new Promise<Reply>(() => undefined) })
  const e = await refused(verifyThenPay({ ...opts, requestTimeoutMs: 20 }), GatewayCheckError)
  assert.equal(e.code, 'NETWORK')
  assert.equal(e.paid, null)
  assert.equal(signer.sent.length, 0)
})

test('a fetch that throws on the first POST refuses with nothing signed', async () => {
  const { signer, opts } = setup({
    first: () => {
      throw new Error('dns')
    },
  })
  const e = await refused(verifyThenPay(opts), GatewayCheckError)
  assert.equal(e.code, 'NETWORK')
  assert.equal(e.paid, false)
  assert.equal(signer.signed.length, 0)
})

test('the server refusing the free checks raises the same error a local refusal would', async () => {
  const cases: [string, new (...a: never[]) => Error, string][] = [
    ['AboveAutoApprove', VaultPolicyError, 'AboveAutoApprove'],
    ['InsufficientGas', VaultPolicyError, 'InsufficientGas'],
    ['PAYEE_UNREGISTERED', PayeeNotRegisteredError, 'PAYEE_UNREGISTERED'],
    ['VAULT_TOKEN_MISMATCH', ArcAssetError, 'VAULT_TOKEN_MISMATCH'],
    ['RATE_LIMITED', GatewayCheckError, 'REFUSED'],
  ]
  for (const [code, type, want] of cases) {
    const { signer, opts } = setup({ first: () => ({ status: 422, body: { stage: 'refused', code, reason: 'no', charged: false, checks: null } }) })
    const e = (await refused(verifyThenPay(opts), type)) as Error & { code: string }
    assert.equal(e.code, want)
    assert.equal(signer.signed.length, 0, code)
  }
})

test('an unpaid request answered with anything but the 402 signs nothing', async () => {
  const { signer, opts } = setup({ first: () => ({ status: 200, body: { stage: 'prepared', prepared: preparedCall() } }) })
  const e = await refused(verifyThenPay(opts), GatewayCheckError)
  assert.equal(e.code, 'REFUSED')
  assert.equal(signer.signed.length, 0)
  assert.equal(signer.sent.length, 0)
})

test('a rail that cannot sell on Arc Mainnet signs nothing', async () => {
  const { signer, opts } = setup({ first: () => ({ status: 501, body: { stage: 'unavailable', reason: 'not configured', charged: false } }) })
  const e = await refused(verifyThenPay(opts), GatewayCheckError)
  assert.equal(e.code, 'NO_ARC_OFFER')
  assert.equal(signer.signed.length, 0)
})

// ── 6. WARN ───────────────────────────────────────────────────────────────────────

test('WARN hands off to the owner by default, with ownerPay built from the inputs', async () => {
  const { api, signer, opts } = setup({ paid: warn })
  const out = await verifyThenPay(opts)
  assert.equal(out.outcome, 'awaiting_human')
  assert.equal(signer.sent.length, 0, 'the operator is never called')
  assert.equal(api.receipts(), 0, 'nothing was sent, so there is no receipt to post')
  if (out.outcome !== 'awaiting_human') return
  assert.equal(out.ownerPay.to, VAULT)
  assert.equal(out.ownerPay.from, OWNER)
  assert.equal(out.ownerPay.data, ownerPayData())
  assert.deepEqual(out.ownerPay.args, [PAYEE, AMOUNT.toString()])
  assert.equal(out.ownerPay.chainId, ARC_MAINNET.chainId)
  assert.ok(BigInt(out.ownerPay.maxFeePerGas) >= ARC_MAINNET.minMaxFeePerGasWei)
  assert.deepEqual(out.ownerPay.simulation, { ok: true })
  assert.equal(out.verdict.decision, 'WARN')
  assert.equal(out.record.recorded, true)
  assert.equal(out.record.outcome, 'awaiting_human')
})

test('a tampered ownerPay is not handed on', async () => {
  const other = `0x${'66'.repeat(20)}` as Address
  const { opts } = setup({ paid: (p) => warn(p, { ownerHandoff: { owner: OWNER, ownerPay: ownerPayCall({ data: ownerPayData(other) }) } }) })
  const e = await refused(verifyThenPay(opts), VaultPaymentError)
  assert.equal(e.code, 'PREPARED_MISMATCH')
})

test('WARN with payOnWarn pays once and sends the opt-in', async () => {
  const { api, signer, opts } = setup({ paid: (p) => allow(p, { verdict: verdictView('WARN') }) })
  const out = await verifyThenPay({ ...opts, payOnWarn: true })
  assert.equal(out.outcome, 'executed')
  assert.equal(signer.sent.length, 1)
  assert.equal(out.verdict.decision, 'WARN')
  assert.equal((api.calls[0].body as { payOnWarn: boolean }).payOnWarn, true)
})

test('a WARN the server prepared without the opt-in is not paid', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { verdict: verdictView('WARN') }) })
  const e = await refused(verifyThenPay(opts), UnusableVerdictError)
  assert.equal(e.code, 'STAGE_MISMATCH')
  assert.equal(signer.sent.length, 0)
})

// ── 7. the payee ──────────────────────────────────────────────────────────────────

for (const [label, w, agentId, code] of [
  ['a payee holding no agent', { agentsHeld: 0n }, undefined, 'PAYEE_UNREGISTERED'],
  ['a registry that does not answer', { agentsHeld: 'unreadable' }, undefined, 'REGISTRY_UNREADABLE'],
  ['an agent owned by someone else', { agentOwner: OWNER }, '#7', 'PAYEE_AGENT_MISMATCH'],
  ['an agent that does not exist', { agentOwner: 'reverts' }, '#7', 'PAYEE_UNREGISTERED'],
  ['an ownerOf that does not answer', { agentOwner: 'unreadable' }, '#7', 'REGISTRY_UNREADABLE'],
  ['an agent on another chain', {}, 'eip155:1:8004/7', 'PAYEE_AGENT_MISMATCH'],
] as const) {
  test(`${label} refuses before any fetch`, async () => {
    const { api, signer, opts } = setup({}, w as Partial<World>)
    const e = await refused(verifyThenPay({ ...opts, ...(agentId ? { payeeAgentId: agentId } : {}) }), PayeeNotRegisteredError)
    assert.equal(e.code, code)
    assert.equal(e.payee, PAYEE)
    assert.equal(api.calls.length, 0)
    assert.equal(signer.signed.length, 0)
  })
}

// ── 8. the vault's policy ─────────────────────────────────────────────────────────

for (const [label, w, code] of [
  ['the vault frozen', { frozen: true }, 'IsFrozen'],
  ['the key expired by block time', { sessionKeyExpiry: BLOCK_TS - 1n }, 'SessionKeyExpired'],
  ['the key about to expire', { sessionKeyExpiry: BLOCK_TS + 30n }, 'SessionKeyExpired'],
  ['the payee off the allowlist', { allowlistEnabled: true, allowed: false }, 'PayeeNotAllowed'],
  ['the amount above the ceiling', { autoApproveMax: AMOUNT - 1n }, 'AboveAutoApprove'],
  ['the daily cap spent', { dailyCap: 1_000_000n, spentToday: 800_000n }, 'DailyCapExceeded'],
  ['too little in the vault', { balance: AMOUNT - 1n }, 'InsufficientVaultBalance'],
  ['the signer not the operator', { operator: OWNER }, 'NotOperator'],
  ['no operator at all', { operator: `0x${'00'.repeat(20)}` }, 'NotOperator'],
  ['too little gas, compared in wei', { operatorGas: 120_000n * 41n * GWEI - 1n }, 'InsufficientGas'],
  ['no contract at the vault', { code: '0x' }, 'NOT_A_VAULT'],
  ['a simulation that reverts', { simRevert: 'AboveAutoApprove' }, 'AboveAutoApprove'],
] as const) {
  test(`${label} refuses before the check is bought`, async () => {
    const { api, signer, opts } = setup({}, w as Partial<World>)
    const e = await refused(verifyThenPay(opts), VaultPolicyError)
    assert.equal(e.code, code)
    assert.equal(e.stage, 'preflight')
    assert.equal(api.calls.length, 0, 'no fetch at all: the free preflight saves the fee')
    assert.equal(signer.signed.length, 0)
    assert.equal(signer.sent.length, 0)
  })
}

test('a vault built before the session-key getter reads as no time bound', async () => {
  const { opts } = setup({}, { sessionKeyExpiry: 'reverts' })
  assert.equal((await verifyThenPay(opts)).outcome, 'executed')
})

test('a contract operator is not asked to hold its own gas', async () => {
  const { opts } = setup({}, { operatorCode: '0x6001', operatorGas: 0n }, { transaction: () => ({ from: `0x${'99'.repeat(20)}`, to: `0x${'98'.repeat(20)}`, input: '0xdeadbeef', maxFeePerGas: null }) })
  const out = await verifyThenPay({ ...opts, payer: spySigner(SEPARATE_PAYER) })
  assert.equal(out.outcome, 'executed', "its transaction is its relayer's, so only the logs can prove it")
})

test('a block the chain did not answer for refuses as unreadable, not as a pass', async () => {
  const { api, opts, chain } = setup()
  chain.latestBlock = async () => {
    throw new ArcRpcUnreachableError('no host')
  }
  const e = await refused(verifyThenPay(opts), VaultPolicyError)
  assert.equal(e.code, 'VaultUnreadable')
  assert.equal(api.calls.length, 0)
})

test('preflightVault runs the free checks alone and signs nothing', async () => {
  const { chain } = setup()
  const p = await preflightVault({ vault: VAULT, payee: PAYEE, amountUnits: AMOUNT, operator: OPERATOR, chain })
  assert.equal(p.owner, OWNER)
  assert.equal(p.operator, OPERATOR)
  assert.equal(p.balance, 1_000_000n)
  assert.equal(p.agentsHeld, 1)
  assert.equal(p.gasLimit, 120_000n)
  await assert.rejects(preflightVault({ vault: VAULT, payee: VAULT, amountUnits: AMOUNT, operator: OPERATOR, chain }), (e: Error) => e instanceof VaultPolicyError && e.code === 'InvalidPayee')
  await assert.rejects(preflightVault({ vault: VAULT, payee: `0x${'00'.repeat(20)}`, amountUnits: AMOUNT, operator: OPERATOR, chain }), (e: Error) => e instanceof VaultPolicyError && e.code === 'ZeroAddress')
})

// ── 9. after the check ────────────────────────────────────────────────────────────

test('a vault that moved while the check ran refuses with the check named, and sends nothing', async () => {
  const { chain, signer, opts } = setup({
    paid: (p) => {
      chain.w.simRevert = 'DailyCapExceeded'
      return allow(p)
    },
  })
  const e = await refused(verifyThenPay(opts), VaultPolicyError)
  assert.equal(e.code, 'DailyCapExceeded')
  assert.equal(e.stage, 'simulation')
  assert.match(e.flowId ?? '', /^0x[0-9a-f]{64}$/)
  assert.ok(e.recordUrl)
  assert.equal(signer.sent.length, 0)
})

test("a prepared call whose own simulation failed is not sent", async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { prepared: preparedCall({ simulation: { ok: false, error: 'IsFrozen' } }) }) })
  const e = await refused(verifyThenPay(opts), VaultPolicyError)
  assert.equal(e.code, 'IsFrozen')
  assert.equal(e.stage, 'simulation')
  assert.equal(signer.sent.length, 0)
})

test('a prepared call with no simulation is not sent', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { prepared: preparedCall({ simulation: undefined }) }) })
  const e = await refused(verifyThenPay(opts), VaultPolicyError)
  assert.equal(e.code, 'SimulationReverted')
  assert.equal(signer.sent.length, 0)
})

for (const stage of ['refused', 'payment_required', 'unavailable', 'something_new']) {
  test(`a paid answer at stage ${stage} is not paid on`, async () => {
    const { signer, opts } = setup({ paid: (p) => ({ status: 200, body: answerBody(p, stage, { verdict: verdictView('ALLOW'), prepared: preparedCall() }) }) })
    await assert.rejects(verifyThenPay(opts))
    assert.equal(signer.sent.length, 0)
  })
}

// ── the server's calldata is never executed ───────────────────────────────────────

const ATTACKER = `0x${'66'.repeat(20)}` as Address

for (const [label, over] of [
  ['calldata that pays someone else', { data: payData(ATTACKER) }],
  ['calldata for another amount', { data: payData(PAYEE, AMOUNT + 1n) }],
  ['arguments naming someone else', { args: [ATTACKER, AMOUNT.toString()] }],
  ['another vault', { to: ATTACKER }],
  ['another sender', { from: ATTACKER }],
  ['another chain', { chainId: 1 }],
  ['another function', { function: 'ownerPay(address,uint256)' }],
  ['a value', { value: '1' }],
  ['a fee that is not a number', { fees: { maxFeePerGas: 'lots' } }],
] as const) {
  test(`a server that prepares ${label} is refused before signing`, async () => {
    const { signer, opts } = setup({ paid: (p) => allow(p, { prepared: preparedCall(over) }) })
    const e = await refused(verifyThenPay(opts), VaultPaymentError)
    assert.equal(e.code, 'PREPARED_MISMATCH')
    assert.equal(e.txHash, undefined)
    assert.equal(signer.sent.length, 0)
  })
}

test('calldata that differs only in hex case is the same bytes', async () => {
  const { opts } = setup({ paid: (p) => allow(p, { prepared: preparedCall({ data: payData().toUpperCase().replace('0X', '0x') }) }) })
  assert.equal((await verifyThenPay(opts)).outcome, 'executed')
})

test('what is sent is the encoding of your inputs, not the bytes the server returned', async () => {
  const { signer, opts } = setup()
  await verifyThenPay(opts)
  assert.equal(signer.sent[0].data, payData())
})

// ── 10. fees ──────────────────────────────────────────────────────────────────────

for (const [label, gasPrice, want] of [
  ['the prepared 41 gwei at a 5 gwei price', 5n * GWEI, 41n * GWEI],
  ['2x plus the tip at a 50 gwei price', 50n * GWEI, 101n * GWEI],
  ['clamped to the cap at a 150 gwei price', 150n * GWEI, 200n * GWEI],
] as const) {
  test(`the fee is ${label}, and never below what the server prepared`, async () => {
    const { signer, opts } = setup({}, { gasPrice })
    await verifyThenPay(opts)
    assert.equal(signer.sent[0].maxFeePerGas, want)
    assert.equal(signer.sent[0].maxPriorityFeePerGas, GWEI)
  })
}

test('the floor holds on its own when the gas price and the prepared fee are both below it', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { prepared: preparedCall({ fees: { maxFeePerGas: GWEI.toString() } }) }) }, { gasPrice: GWEI })
  await verifyThenPay(opts)
  assert.equal(signer.sent[0].maxFeePerGas, 20n * GWEI)
})

test('a gas price above the cap refuses before the check is bought', async () => {
  const { api, signer, opts } = setup({}, { gasPrice: 250n * GWEI })
  const e = await refused(verifyThenPay(opts), VaultPolicyError)
  assert.equal(e.code, 'GasPriceAboveCap')
  assert.equal(api.calls.length, 0)
  assert.equal(signer.sent.length, 0)
})

test('a prepared fee above the cap is refused: a server cannot price the payment past it', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { prepared: preparedCall({ fees: { maxFeePerGas: (10_000n * GWEI).toString() } }) }) })
  const e = await refused(verifyThenPay(opts), VaultPolicyError)
  assert.equal(e.code, 'GasPriceAboveCap')
  assert.equal(signer.sent.length, 0)
})

test('a cap below the floor is a mistake and refuses up front', async () => {
  const { api, opts } = setup()
  await assert.rejects(verifyThenPay({ ...opts, maxFeePerGasCapWei: GWEI }), RangeError)
  assert.equal(api.calls.length, 0)
})

// ── 11. receipts, on every RPC ────────────────────────────────────────────────────

const RPC_A = 'https://a.rpc.example/secret-path?key=1'
const RPC_B = 'https://b.rpc.example'

function rawReceipt(hash: string, over: Record<string, unknown> = {}) {
  return { transactionHash: hash, status: '0x1', blockNumber: '0x4d2', from: OPERATOR, to: VAULT, gasUsed: '0x10', effectiveGasPrice: '0x20', logs: [], ...over }
}

function rpcFetch(handlers: Record<string, (method: string, params: unknown[]) => unknown>): FetchLike & { asked: string[] } {
  const asked: string[] = []
  const f = (async (url: string, init?: RequestInit) => {
    asked.push(url)
    const { method, params } = JSON.parse(String(init?.body))
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected ${url}`)
    const result = handler(method, params)
    if (result instanceof Response) return result
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 })
  }) as FetchLike & { asked: string[] }
  f.asked = asked
  return f
}

test('a receipt found on the second RPC when the first answers null', async () => {
  const f = rpcFetch({ [RPC_A]: () => null, [RPC_B]: (_m, p) => rawReceipt(String(p[0])) })
  const r = await arcChainReader([RPC_A, RPC_B], { fetch: f }).receipt(TX_HASH)
  assert.equal(r?.status, 'success')
  assert.equal(r?.blockNumber, 1234n)
  assert.equal(r?.source, 'b.rpc.example', 'a host name, never a path or a key')
  assert.deepEqual(f.asked, [RPC_A, RPC_B])
})

test('verifyThenPay finds that receipt end to end through the real reader', async () => {
  const rawLogs = receiptFor(TX_HASH).logs
  const base = fakeChain(world())
  const rpc = rpcFetch({
    [RPC_A]: () => null,
    [RPC_B]: (m, p) => (m === 'eth_getTransactionReceipt' ? rawReceipt(String(p[0]), { logs: rawLogs }) : null),
  })
  const reader = arcChainReader([RPC_A, RPC_B], { fetch: rpc })
  const signer = spySigner()
  const out = await verifyThenPay(options(fakeApi(), { ...base, receipt: reader.receipt, transaction: reader.transaction }, signer))
  assert.equal(out.outcome, 'executed')
  if (out.outcome === 'executed') {
    assert.equal(out.payment.readBackFrom, 'b.rpc.example')
    assert.equal(out.payment.transactionReadBack, false, 'no RPC returned the transaction, and the report says so')
  }
  assert.equal(signer.sent.length, 1)
})

test('a host answering about another transaction, or with garbage, is that host failing', async () => {
  const other = `0x${'88'.repeat(32)}`
  for (const bad of [rawReceipt(other), { hello: 1 }, rawReceipt(TX_HASH, { status: undefined }), rawReceipt(TX_HASH, { logs: undefined })]) {
    const f = rpcFetch({ [RPC_A]: () => bad, [RPC_B]: (_m, p) => rawReceipt(String(p[0])) })
    const r = await arcChainReader([RPC_A, RPC_B], { fetch: f }).receipt(TX_HASH)
    assert.equal(r?.source, 'b.rpc.example')
  }
})

test('every host null is null; no host answering throws, and the two are never read as each other', async () => {
  const none = rpcFetch({ [RPC_A]: () => null, [RPC_B]: () => null })
  assert.equal(await arcChainReader([RPC_A, RPC_B], { fetch: none }).receipt(TX_HASH), null)
  const down = rpcFetch({ [RPC_A]: () => new Response('nope', { status: 503 }), [RPC_B]: () => new Response('nope', { status: 500 }) })
  await assert.rejects(arcChainReader([RPC_A, RPC_B], { fetch: down }).receipt(TX_HASH), ArcRpcUnreachableError)
  const mixed = rpcFetch({ [RPC_A]: () => new Response('nope', { status: 503 }), [RPC_B]: () => null })
  assert.equal(await arcChainReader([RPC_A, RPC_B], { fetch: mixed }).receipt(TX_HASH), null)
})

test('a stalled host costs its deadline and the next host is asked', async () => {
  const f = (async (url: string, init?: RequestInit) => {
    if (url === RPC_A) return new Promise<Response>(() => undefined)
    return new Response(JSON.stringify({ result: rawReceipt(JSON.parse(String(init?.body)).params[0]) }))
  }) as FetchLike
  const r = await arcChainReader([RPC_A, RPC_B], { fetch: f, perCallTimeoutMs: 10 }).receipt(TX_HASH)
  assert.equal(r?.source, 'b.rpc.example')
})

test('a revert is an answer: it stops the walk and is kept apart from a host that failed', async () => {
  const revert = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0xabcd' } }))
  const f = rpcFetch({ [RPC_A]: revert, [RPC_B]: () => '0x' })
  await assert.rejects(arcChainReader([RPC_A, RPC_B], { fetch: f }).call({ to: VAULT, data: '0x12' }), (e: Error) => e instanceof ArcCallRevert && e.data === '0xabcd')
  assert.deepEqual(f.asked, [RPC_A])
  const failing = rpcFetch({ [RPC_A]: () => new Response(JSON.stringify({ error: { code: -32000, message: 'overloaded' } })), [RPC_B]: () => '0x01' })
  assert.equal(await arcChainReader([RPC_A, RPC_B], { fetch: failing }).call({ to: VAULT, data: '0x12' }), '0x01')
})

test('the default reader starts from the registry hosts in the registry order', async () => {
  const asked: string[] = []
  const f = (async (url: string) => {
    asked.push(url)
    return new Response(JSON.stringify({ result: null }))
  }) as FetchLike
  await arcChainReader(undefined, { fetch: f }).receipt(TX_HASH)
  assert.deepEqual(asked, [...ARC_MAINNET.rpcUrls])
})

test('every RPC null until the timeout is UNCONFIRMED, with the hash, and nothing is resent', async () => {
  const { signer, opts } = setup({}, {}, { receipt: () => null })
  const e = await refused(verifyThenPay({ ...opts, receiptTimeoutMs: 6000 }), VaultPaymentError)
  assert.equal(e.code, 'UNCONFIRMED')
  assert.equal(e.txHash, TX_HASH)
  assert.equal(signer.sent.length, 1)
})

test('no RPC knowing the transaction after the window is DROPPED, with the hash, and nothing is resent', async () => {
  const { signer, opts } = setup({}, {}, { receipt: () => null, transaction: () => null })
  const e = await refused(verifyThenPay(opts), VaultPaymentError)
  assert.equal(e.code, 'DROPPED')
  assert.equal(e.txHash, TX_HASH)
  assert.equal(signer.sent.length, 1)
})

test('RPCs that do not answer at all are never called DROPPED', async () => {
  const { opts, chain } = setup()
  const down = async () => {
    throw new ArcRpcUnreachableError('no host')
  }
  chain.receipt = down
  chain.transaction = down
  const e = await refused(verifyThenPay({ ...opts, receiptTimeoutMs: 20_000 }), VaultPaymentError)
  assert.equal(e.code, 'UNCONFIRMED')
})

test('a reverted receipt is REVERTED with the hash, and the revert is posted to the record', async () => {
  const { api, signer, opts } = setup({ receipt: () => ({ status: 200, body: { verified: true, outcome: 'blocked', detail: 'reverted_onchain' } }) }, {}, { receipt: (h) => receiptFor(h, { status: 'reverted', logs: [] }) })
  const e = await refused(verifyThenPay(opts), VaultPaymentError)
  assert.equal(e.code, 'REVERTED')
  assert.equal(e.txHash, TX_HASH)
  assert.equal(e.record?.recorded, true)
  assert.equal(e.record?.outcome, 'blocked')
  assert.equal(api.receipts(), 1)
  assert.equal(signer.sent.length, 1)
})

for (const [label, logs] of [
  ['no logs at all', []],
  ['only the native-balance log', receiptFor(TX_HASH).logs.slice(0, 1)],
  ['the Paid event without USDC moving', receiptFor(TX_HASH).logs.slice(2)],
  ['USDC moving without the Paid event', receiptFor(TX_HASH).logs.slice(0, 2)],
] as const) {
  test(`a success with ${label} is LOGS_MISMATCH, and is not recorded as paid`, async () => {
    const { api, opts } = setup({}, {}, { receipt: (h) => receiptFor(h, { logs }) })
    const e = await refused(verifyThenPay(opts), VaultPaymentError)
    assert.equal(e.code, 'LOGS_MISMATCH')
    assert.equal(e.txHash, TX_HASH)
    assert.equal(api.receipts(), 0)
  })
}

// ── 12. what the signer actually did ──────────────────────────────────────────────

for (const [label, tx] of [
  ['another target', { from: OPERATOR, to: ATTACKER, input: payData(), maxFeePerGas: 41n * GWEI }],
  ['other calldata', { from: OPERATOR, to: VAULT, input: payData(ATTACKER), maxFeePerGas: 41n * GWEI }],
  ['another sender', { from: ATTACKER, to: VAULT, input: payData(), maxFeePerGas: 41n * GWEI }],
] as const) {
  test(`a signer that sent ${label} is TX_MISMATCH, with the hash`, async () => {
    const { api, signer, opts } = setup({}, {}, { transaction: () => tx as ArcTransaction })
    const e = await refused(verifyThenPay(opts), VaultPaymentError)
    assert.equal(e.code, 'TX_MISMATCH')
    assert.equal(e.txHash, TX_HASH)
    assert.equal(signer.sent.length, 1)
    assert.equal(api.receipts(), 0)
  })
}

test('with no transaction readable, a receipt from elsewhere is still compared', async () => {
  const { opts } = setup({}, {}, { transaction: () => null, receipt: (h) => receiptFor(h, { to: ATTACKER }) })
  const e = await refused(verifyThenPay(opts), VaultPaymentError)
  assert.equal(e.code, 'TX_MISMATCH')
})

test('a wallet that priced under the floor is UNDERPRICED at once, not waited on', async () => {
  const { chain, opts } = setup({}, {}, { receipt: () => null, transaction: () => ({ from: OPERATOR, to: VAULT, input: payData(), maxFeePerGas: 19n * GWEI }) })
  const e = await refused(verifyThenPay(opts), VaultPaymentError)
  assert.equal(e.code, 'UNDERPRICED')
  assert.equal(e.txHash, TX_HASH)
  assert.equal(chain.receipts, 1)
})

test('a sendTransaction that throws is BROADCAST_FAILED, once, with no hash', async () => {
  const { opts, signer } = setup()
  let tries = 0
  signer.sendTransaction = async () => {
    tries += 1
    throw new Error('nonce too low')
  }
  const e = await refused(verifyThenPay(opts), VaultPaymentError)
  assert.equal(e.code, 'BROADCAST_FAILED')
  assert.equal(e.txHash, undefined)
  assert.equal(tries, 1)
})

test('a signer that returns no hash is BROADCAST_FAILED', async () => {
  const { opts, signer } = setup()
  signer.sendTransaction = async () => 'not-a-hash' as Hex
  const e = await refused(verifyThenPay(opts), VaultPaymentError)
  assert.equal(e.code, 'BROADCAST_FAILED')
})

// ── 13. decimals ──────────────────────────────────────────────────────────────────

test('usdcUnits is string math', () => {
  assert.equal(usdcUnits('0.25'), 250000n)
  assert.equal(usdcUnits('0.000001'), 1n)
  assert.equal(usdcUnits('1'), 1000000n)
  assert.equal(usdcUnits('0.1'), 100000n, 'a float would not survive this')
  assert.equal(usdcUnits('123456789012345678.5'), 123456789012345678500000n, 'nor this')
  assert.equal(usdcUnits('0'), 0n)
  for (const bad of ['0.0000001', '-1', '1e3', '', '.5', '1.', ' 1', '1 ', '0x10', 'NaN', '1,5', '+1']) {
    assert.throws(() => usdcUnits(bad), RangeError, bad)
  }
  assert.throws(() => usdcUnits(0.25 as unknown as string), TypeError)
})

test('an amount that is not a positive bigint refuses before anything', async () => {
  const { api, chain, opts } = setup()
  await assert.rejects(verifyThenPay({ ...opts, amountUnits: 0.25 as unknown as bigint }), TypeError)
  await assert.rejects(verifyThenPay({ ...opts, amountUnits: 0n }), RangeError)
  await assert.rejects(verifyThenPay({ ...opts, amountUnits: -1n }), RangeError)
  assert.equal(api.calls.length, 0)
  assert.equal(chain.log.length, 0)
})

test('addresses that are not addresses refuse before anything', async () => {
  const { api, opts } = setup()
  await assert.rejects(verifyThenPay({ ...opts, payee: 'eip155:1:8004/7' as Address }), TypeError)
  await assert.rejects(verifyThenPay({ ...opts, vault: '0x12' as Address }), TypeError)
  assert.equal(api.calls.length, 0)
})

test('the payees the vault itself refuses are refused before anything', async () => {
  const { api, opts } = setup()
  for (const [payee, code] of [
    [VAULT, 'InvalidPayee'],
    [USDC, 'InvalidPayee'],
    [`0x${'00'.repeat(20)}`, 'ZeroAddress'],
  ] as const) {
    const e = await refused(verifyThenPay({ ...opts, payee: payee as Address }), VaultPolicyError)
    assert.equal(e.code, code)
  }
  assert.equal(api.calls.length, 0)
})

// ── 14. the settlement echo ───────────────────────────────────────────────────────

for (const [label, check] of [
  ['another payer', { payer: ATTACKER }],
  ['another nonce', { authNonce: `0x${'12'.repeat(32)}` }],
  ['another network', { network: 'eip155:1' }],
  ['an unconfirmed settlement', { gatewayOutcome: 'unconfirmed' }],
  ['another price', { amountUnits: '1' }],
  ['another tool', { resource: '/api/x402/gateway/tools/verify_agent' }],
] as const) {
  test(`a settlement echoing ${label} is SETTLEMENT_MISMATCH and never ALLOW`, async () => {
    const { signer, opts } = setup({ paid: (p) => allow(p, { check: checkRef(p, check) }) })
    const e = await refused(verifyThenPay(opts), UnusableVerdictError)
    assert.equal(e.code, 'SETTLEMENT_MISMATCH')
    assert.equal(signer.sent.length, 0)
  })
}

test('an answer with no check, or naming another flow, is SETTLEMENT_MISMATCH', async () => {
  for (const over of [{ check: null }, { flowId: `0x${'12'.repeat(32)}` }]) {
    const { signer, opts } = setup({ paid: (p) => allow(p, over) })
    const e = await refused(verifyThenPay(opts), UnusableVerdictError)
    assert.equal(e.code, 'SETTLEMENT_MISMATCH')
    assert.equal(signer.sent.length, 0)
  }
})

test('a prepared call whose flow was not recorded is not paid on: no receipt could ever close it', async () => {
  const { signer, opts } = setup({ paid: (p) => allow(p, { record: { url: null, recorded: false, reason: 'db down' } }) })
  const e = await refused(verifyThenPay(opts), GatewayCheckError)
  assert.equal(e.code, 'FLOW_NOT_RECORDED')
  assert.equal(e.paid, true)
  assert.equal(signer.sent.length, 0)
})

// ── 15. the offer ─────────────────────────────────────────────────────────────────

for (const [label, offer, code] of [
  ['another verifyingContract', { ...OFFER, extra: { ...OFFER.extra, verifyingContract: ATTACKER } }, 'OFFER_MISMATCH'],
  ['another domain version', { ...OFFER, extra: { ...OFFER.extra, version: '2' } }, 'OFFER_MISMATCH'],
  ['another domain name', { ...OFFER, extra: { ...OFFER.extra, name: 'USD Coin' } }, 'OFFER_MISMATCH'],
  ['another scheme', { ...OFFER, scheme: 'upto' }, 'OFFER_MISMATCH'],
  ['the wrong asset', { ...OFFER, asset: ATTACKER }, 'OFFER_MISMATCH'],
  ['a price above the cap', { ...OFFER, amount: '5001' }, 'PRICE_ABOVE_CAP'],
  ['an amount that is not a number', { ...OFFER, amount: '1e9' }, 'OFFER_MISMATCH'],
  ['a payTo that is the payer', { ...OFFER, payTo: OPERATOR }, 'OFFER_MISMATCH'],
  ['no payTo', { ...OFFER, payTo: undefined }, 'OFFER_MISMATCH'],
  ['another network only', { ...OFFER, network: 'eip155:1' }, 'NO_ARC_OFFER'],
] as const) {
  test(`an offer with ${label} refuses before signing`, async () => {
    const { signer, opts } = setup({ offer: offer as Record<string, unknown> })
    const e = await refused(verifyThenPay(opts), GatewayCheckError)
    assert.equal(e.code, code)
    assert.equal(e.paid, false)
    assert.equal(signer.signed.length, 0)
    assert.equal(signer.sent.length, 0)
  })
}

test('the price cap is the caller to set', async () => {
  const { signer, opts } = setup({ offer: { ...OFFER, amount: '4000' } })
  const e = await refused(verifyThenPay({ ...opts, maxCheckUnits: 3999n }), GatewayCheckError)
  assert.equal(e.code, 'PRICE_ABOVE_CAP')
  assert.equal(signer.signed.length, 0)
})

test('a 402 whose header and body disagree refuses before signing', async () => {
  const { signer, opts } = setup({
    first: () => ({
      status: 402,
      body: { stage: 'payment_required', challenge: challengeBody() },
      headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(challengeBody({ ...OFFER, payTo: ATTACKER }))).toString('base64') },
    }),
  })
  const e = await refused(verifyThenPay(opts), GatewayCheckError)
  assert.equal(e.code, 'OFFER_MISMATCH')
  assert.equal(signer.signed.length, 0)
})

for (const [label, supported] of [
  ['down', () => ({ status: 503, body: {} })],
  ['not advertising Arc Mainnet', () => ({ status: 200, body: { kinds: [] } })],
  ['naming another wallet', () => ({ status: 200, body: { kinds: [{ network: ARC_MAINNET.caip2, scheme: 'exact', extra: { verifyingContract: ATTACKER, assets: [{ address: USDC }] } }] } })],
  ['not settling USDC', () => ({ status: 200, body: { kinds: [{ network: ARC_MAINNET.caip2, scheme: 'exact', extra: { verifyingContract: ARC_MAINNET.gatewayWallet, assets: [] } }] } })],
] as const) {
  test(`Gateway ${label} is DOMAIN_UNPROVEN, before signing`, async () => {
    const { signer, opts } = setup({ supported })
    const e = await refused(verifyThenPay(opts), GatewayCheckError)
    assert.equal(e.code, 'DOMAIN_UNPROVEN')
    assert.equal(signer.signed.length, 0)
  })
}

test('proveDomain false skips that one read and nothing else', async () => {
  const { api, signer, opts } = setup({ supported: () => ({ status: 503, body: {} }) })
  await verifyThenPay({ ...opts, proveDomain: false })
  assert.equal(signer.sent.length, 1)
  assert.ok(!api.calls.some((c) => c.url.endsWith('/v1/x402/supported')))
})

test('a Gateway balance too small to pay refuses before signing', async () => {
  const { signer, opts } = setup({ balance: '0.004999' })
  const e = await refused(verifyThenPay(opts), GatewayCheckError)
  assert.equal(e.code, 'INSUFFICIENT_GATEWAY_BALANCE')
  assert.equal(e.paid, false)
  assert.equal(signer.signed.length, 0)
})

test('the payer is the one whose balance is read and whose key signs', async () => {
  const { api, signer, opts } = setup()
  const payer = spySigner(SEPARATE_PAYER)
  await verifyThenPay({ ...opts, payer })
  const asked = api.calls.find((c) => c.url.endsWith('/v1/balances'))?.body as { sources: { domain: number; depositor: string }[] }
  assert.deepEqual(asked.sources, [{ domain: ARC_MAINNET.gatewayDomain, depositor: SEPARATE_PAYER }])
  assert.equal(payer.signed.length, 1)
  assert.equal(signer.signed.length, 0)
  assert.equal(signer.sent.length, 1)
})

test('an operator that cannot sign typed data needs a payer, and says so up front', async () => {
  const { api, chain } = setup()
  const operatorOnly = { address: OPERATOR, sendTransaction: async () => TX_HASH }
  await assert.rejects(verifyThenPay({ vault: VAULT, payee: PAYEE, amountUnits: AMOUNT, signer: operatorOnly, fetch: api, chain }), TypeError)
  assert.equal(api.calls.length, 0)
})

// ── 16. the record ────────────────────────────────────────────────────────────────

test('a record POST that fails leaves the payment executed, recorded false, and sends nothing again', async () => {
  const { api, signer, opts } = setup({
    receipt: () => {
      throw new Error('socket hang up')
    },
  })
  const out = await verifyThenPay(opts)
  assert.equal(out.outcome, 'executed')
  assert.equal(out.record.recorded, false)
  assert.match(out.record.reason ?? '', /socket hang up/)
  assert.equal(signer.sent.length, 1)
  assert.equal(api.receipts(), 3, 'the same hash, a bounded number of times')
})

test('a server that says retry gets the same hash again, and a later success counts', async () => {
  const { api, signer, opts } = setup({ receipt: (n) => (n === 1 ? { status: 202, body: { verified: false, code: 'RECEIPT_PENDING', retry: true, reason: 'not yet' } } : { status: 200, body: { verified: true, outcome: 'executed', detail: 'agent_paid' } }) })
  const out = await verifyThenPay(opts)
  assert.equal(out.record.recorded, true)
  assert.equal(api.receipts(), 2)
  const hashes = api.calls.filter((c) => c.url.endsWith('/receipt')).map((c) => (c.body as { txHash: string }).txHash)
  assert.deepEqual(hashes, [TX_HASH, TX_HASH])
  assert.equal(signer.sent.length, 1)
})

test('a server that refuses the receipt is reported as is, once, and names the flow it answers', async () => {
  const later = `0x${'34'.repeat(32)}`
  const { api, opts } = setup({ receipt: () => ({ status: 409, body: { verified: false, code: 'TX_ANSWERS_LATER_CHECK', answersFlow: later, reason: 'a later check', outcome: 'pending', detail: 'agent_will_pay' } }) })
  const out = await verifyThenPay(opts)
  assert.equal(out.outcome, 'executed', 'the money moved, whatever the record says')
  assert.equal(out.record.recorded, false)
  assert.equal(out.record.code, 'TX_ANSWERS_LATER_CHECK')
  assert.equal(out.record.answersFlow, later)
  assert.equal(api.receipts(), 1)
})

test('recordFlowReceipt closes an owner hand-off, and checks its inputs', async () => {
  const api = fakeApi({ receipt: () => ({ status: 200, body: { verified: true, outcome: 'executed', detail: 'owner_paid' } }) })
  const flowId = `0x${'ab'.repeat(32)}`
  const r = await recordFlowReceipt({ flowId, txHash: TX_HASH, baseUrl: `${BASE}/`, fetch: api, clock: fakeClock() })
  assert.deepEqual(r, { url: `${BASE}/api/x402/gateway/flows/${flowId}`, recorded: true, outcome: 'executed', detail: 'owner_paid' })
  await assert.rejects(recordFlowReceipt({ flowId: 'nope', txHash: TX_HASH, fetch: api }), TypeError)
  await assert.rejects(recordFlowReceipt({ flowId, txHash: 'nope', fetch: api }), TypeError)
})

// ── one flow per vault at a time ──────────────────────────────────────────────────

test('two calls on one vault run one after the other, and a failure does not jam the queue', async () => {
  const order: string[] = []
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  const slow = setup({
    paid: async (p) => {
      order.push('first check')
      await gate
      order.push('first check done')
      return deny(p)
    },
  })
  const fast = setup({
    paid: (p) => {
      order.push('second check')
      return allow(p)
    },
  })
  const a = verifyThenPay(slow.opts)
  const b = verifyThenPay(fast.opts)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(order, ['first check'])
  release()
  await refused(a, TrustDenyError)
  assert.equal((await b).outcome, 'executed')
  assert.deepEqual(order, ['first check', 'first check done', 'second check'])
})

// ── viem, for real, against a fake transport ──────────────────────────────────────

test('fromViemWallet signs a real EIP-1559 transaction for Arc Mainnet with every field intact', async () => {
  // A throwaway key that holds nothing anywhere. No transport here reaches a network.
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  let raw: Hex | null = null
  const wallet = createWalletClient({
    account,
    chain: arcViemChain,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'eth_chainId') return `0x${ARC_MAINNET.chainId.toString(16)}`
        if (method === 'eth_getTransactionCount') return '0x7'
        if (method === 'eth_sendRawTransaction') {
          raw = (params as Hex[])[0]
          return TX_HASH
        }
        throw new Error(`unexpected ${method}`)
      },
    }),
  })
  const signer = fromViemWallet(wallet as never)
  assert.equal(signer.address, account.address)
  const hash = await signer.sendTransaction({ chainId: ARC_MAINNET.chainId, from: account.address, to: VAULT, data: payData(), value: 0n, gas: 120_000n, maxFeePerGas: 41n * GWEI, maxPriorityFeePerGas: GWEI })
  assert.equal(hash, TX_HASH)
  const t = parseTransaction(raw as unknown as Hex)
  assert.equal(t.type, 'eip1559')
  assert.equal(t.chainId, ARC_MAINNET.chainId)
  assert.equal(t.to?.toLowerCase(), VAULT)
  assert.equal(t.data, payData())
  assert.equal(t.gas, 120_000n)
  assert.equal(t.maxFeePerGas, 41n * GWEI)
  assert.equal(t.maxPriorityFeePerGas, GWEI)
  assert.equal(t.nonce, 7)

  const typed = await signer.signTypedData({
    domain: { name: 'GatewayWalletBatched', version: '1', chainId: ARC_MAINNET.chainId, verifyingContract: ARC_MAINNET.gatewayWallet as Address },
    types: { Thing: [{ name: 'a', type: 'uint256' }] },
    primaryType: 'Thing',
    message: { a: 1n },
  })
  assert.match(typed, /^0x[0-9a-f]{130}$/)
})

test('fromViemWallet refuses a wallet on any other chain, or on none', () => {
  const stub = { account: { address: OPERATOR }, sendTransaction: async () => TX_HASH, signTypedData: async () => TX_HASH } as never as Parameters<typeof fromViemWallet>[0]
  assert.throws(() => fromViemWallet({ ...stub, chain: { id: 1 } }), TypeError)
  assert.throws(() => fromViemWallet({ ...stub, chain: null }), TypeError)
  assert.throws(() => fromViemWallet({ ...stub, account: undefined, chain: arcViemChain }), TypeError)
})

// ── packaging ─────────────────────────────────────────────────────────────────────

test('no peer dependency is loaded at import time: the core and arc entry points import neither', () => {
  for (const file of ['./index.js', './arc.js', './arc-reader.js']) {
    const js = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(js, /^import [^(]*from ['"](viem|@circle-fin)/m, file)
  }
})

// ── the plain rail ────────────────────────────────────────────────────────────────

test("TrustGuard's arc rail calls the Gateway tool path on the default base URL", async () => {
  const asked: string[] = []
  const f = (async (url: string) => {
    asked.push(url)
    return new Response(JSON.stringify({ tool: 'risk_check', agentId: PAYEE, decision: 'ALLOW', risk: 'low', reasons: ['ok'] }), { status: 200 })
  }) as FetchLike
  const oracle = new TrustGuard({ rail: 'arc', fetch: f })
  assert.equal(oracle.baseUrl, 'https://a-identity.xyz')
  await oracle.guard(PAYEE)
  assert.deepEqual(asked, ['https://a-identity.xyz/api/x402/gateway/tools/risk_check'])
})

test('arcGatewayPayer pays the Arc offer out of a many-chain challenge and retries once', async () => {
  const payer = spySigner(SEPARATE_PAYER)
  const baseOffer = { ...OFFER, network: 'eip155:8453', asset: `0x${'12'.repeat(20)}` }
  const seen: Record<string, string>[] = []
  const f = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/x402/supported')) return new Response(JSON.stringify({ kinds: [{ network: ARC_MAINNET.caip2, scheme: 'exact', extra: { verifyingContract: ARC_MAINNET.gatewayWallet, assets: [{ address: USDC }] } }] }))
    const headers = (init?.headers ?? {}) as Record<string, string>
    seen.push(headers)
    if (!headers['PAYMENT-SIGNATURE']) return new Response(JSON.stringify({ x402Version: 2, accepts: [baseOffer, OFFER] }), { status: 402 })
    return new Response(JSON.stringify({ tool: 'risk_check', agentId: PAYEE, decision: 'DENY', risk: 'high', reasons: ['off-platform'] }), { status: 200 })
  }) as FetchLike
  const oracle = new TrustGuard({ rail: 'arc', baseUrl: BASE, fetch: f, onPaymentRequired: arcGatewayPayer(payer, { fetch: f }) })
  const e = await refused(oracle.guard(PAYEE), TrustDenyError)
  assert.equal(e.context, undefined, 'a plain guard() carries no flow')
  assert.equal(seen.length, 2)
  const sent = JSON.parse(Buffer.from(seen[1]['PAYMENT-SIGNATURE'], 'base64').toString('utf8'))
  assert.equal(sent.accepted.network, ARC_MAINNET.caip2)
  assert.equal(payer.signed.length, 1)
})

test('arcGatewayPayer refuses a price above its cap before signing', async () => {
  const payer = spySigner(SEPARATE_PAYER)
  const pay = arcGatewayPayer(payer, { maxUnitsPerCall: 4999n, proveDomain: false })
  await assert.rejects(pay({ accepts: [OFFER] }, { resource: 'r', body: {} }), (e: Error) => e instanceof GatewayCheckError && e.code === 'PRICE_ABOVE_CAP')
  assert.equal(payer.signed.length, 0)
})

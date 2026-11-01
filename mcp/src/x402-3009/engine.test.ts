import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWalletClient, custom, decodeFunctionData, defineChain, keccak256, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { fakeSigningWallet } from './signing-wallet.fake.js'
import {
  paymentKey,
  parseAuthorizationPayload,
  reconcileAmbiguousSettlements,
  reconcileSettlementRow,
  markSettlementServed,
  releaseSettlementClaim,
  verifyPayment,
  settlePayment,
  FIRST_ATTEMPT_CEILING_MS,
  REDEEM_WINDOW_MS,
  type Limits,
} from './engine.js'
import { eip712DomainSeparator, clearDomainCache, type TokenReader } from './domain.js'
import { EIP3009_ABI, SignerBusyError, __resetSendStateForTests, getChainById, sendCallSigned, type EveryRpcOptions } from '../chains/index.js'
import {
  flushStateDurably,
  gasSpentOnDay,
  loadX402SettlementsResult,
  patchX402Rows,
  markX402SettlementServed,
  persistX402Settlement,
  redeemX402Settlement,
  releaseX402SettlementClaim,
  resolveX402Settlement,
  GAS_BUDGET_UNKNOWN,
  type X402SettlementRecord,
} from '../storage.js'

/**
 * The engine decides whether real money moves, so the cases that matter most here are
 * the refusals: an unsettled receipt must never be recorded as revenue, and a payment
 * that would revert must never reach a broadcast.
 *
 * Everything runs offline. The signing key is a fixed test key, and the token reads are
 * injected, so these assertions are deterministic rather than dependent on a live chain.
 */
const chain = getChainById('rhchain')!
const token = chain.settlementTokens![0]
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const buyer = privateKeyToAccount(KEY)
const PAY_TO = '0x000000000000000000000000000000000000dEaD' as const

const DOMAIN = { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: token.address as `0x${string}` }
const SEPARATOR = eip712DomainSeparator(DOMAIN)

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

const ANY_CALL = { address: token.address as `0x${string}`, abi: EIP3009_ABI, functionName: 'balanceOf', args: [PAY_TO] as const }

const NOW = new Date('2026-08-13T12:00:00.000Z')
const nowSec = Math.floor(NOW.getTime() / 1000)
/** What a claim taken at NOW holds on its row: the fixtures' clock does not move. */
const CLAIM = NOW.toISOString()

function tokenReader(over: Partial<Record<string, unknown>> = {}): TokenReader {
  const answers: Record<string, unknown> = {
    DOMAIN_SEPARATOR: SEPARATOR, name: 'Global Dollar', symbol: 'USDG', decimals: 6, authorizationState: false, ...over,
  }
  return async (fn) => {
    if (!(fn in answers)) throw new Error(`${fn} reverted`)
    return answers[fn]
  }
}

/** A public client stub. Reads answer from `state`; writes are counted, never real. */
function publicClient(state: {
  authorizationState?: boolean
  balance?: bigint
  simulateThrows?: string
  gasPrice?: bigint
  gasEstimate?: bigint
  receipt?: { status: string; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice?: bigint; logs: unknown[] }
  receiptThrows?: string
  calls?: { simulate: number }
}) {
  state.calls ??= { simulate: 0 }
  return {
    readContract: async (args: Record<string, unknown>) => {
      if (args.functionName === 'authorizationState') return state.authorizationState ?? false
      if (args.functionName === 'balanceOf') return state.balance ?? 10_000_000n
      throw new Error(`unexpected read ${String(args.functionName)}`)
    },
    simulateContract: async () => {
      state.calls!.simulate += 1
      if (state.simulateThrows) throw new Error(state.simulateThrows)
      return { request: {} }
    },
    estimateContractGas: async () => state.gasEstimate ?? 85_000n,
    getGasPrice: async () => state.gasPrice ?? 50_578_000n,
    // Not part of the client's interface: deps() below builds the fake RPC hosts from it.
    _state: state,
  }
}

type FakeReceipt = NonNullable<Parameters<typeof publicClient>[0]['receipt']>

/** A receipt in the JSON-RPC shape a host answers with. */
function rawReceipt(hash: unknown, r: FakeReceipt) {
  return {
    transactionHash: hash,
    blockHash: `0x${'bb'.repeat(32)}`,
    blockNumber: `0x${r.blockNumber.toString(16)}`,
    status: r.status === 'success' ? '0x1' : '0x0',
    gasUsed: `0x${r.gasUsed.toString(16)}`,
    ...(r.effectiveGasPrice !== undefined ? { effectiveGasPrice: `0x${r.effectiveGasPrice.toString(16)}` } : {}),
    logs: r.logs,
  }
}

const HOST_A = 'https://a.rpc.test'
const HOST_B = 'https://b.rpc.test'
const HOST_C = 'https://c.rpc.test'
/** Far past any block a fixture mines in, so a receipt is always deep enough. */
const HEAD = '0xffffff'

/**
 * Fake RPC hosts. Each url answers from `hosts` at call time, so a test can have a receipt
 * appear between two calls: a FakeReceipt is that host holding it, null is the host answering
 * null, and an Error is the host failing. `asked` lists the receipt reads in order.
 */
function fakeHosts(hosts: Record<string, FakeReceipt | null | Error>) {
  const asked: string[] = []
  const receipts: EveryRpcOptions = {
    urls: Object.keys(hosts),
    pollMs: 1,
    sleep: async () => {},
    call: async (url, method, params) => {
      if (method === 'eth_blockNumber') return HEAD
      asked.push(url)
      const held = hosts[url]
      if (held instanceof Error) throw held
      return held ? rawReceipt(params[0], held) : null
    },
  }
  return { receipts, asked }
}

/** A Transfer log in the shape viem's parseEventLogs decodes. */
function transferLog(from: string, to: string, value: bigint) {
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
  return {
    address: token.address.toLowerCase(),
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      pad(from),
      pad(to),
    ],
    data: `0x${value.toString(16).padStart(64, '0')}`,
  }
}

const LIMITS: Limits = {
  minValue: 1_000n,
  maxValue: 1_000_000n,
  expiryHeadroomSec: 60,
  maxGasWei: 20_000_000_000_000n,
  dailyGasWei: 500_000_000_000_000n,
}

const REQUIREMENTS = {
  scheme: 'exact' as const,
  network: chain.caip2,
  asset: token.address as `0x${string}`,
  payTo: PAY_TO,
  maxAmountRequired: '21000',
  resource: '/api/x402/tools/risk_check',
}

async function signed(over: Partial<{ to: string; value: bigint; validAfter: bigint; validBefore: bigint; nonce: `0x${string}` }> = {}) {
  const authorization = {
    from: buyer.address,
    to: (over.to ?? PAY_TO) as `0x${string}`,
    value: over.value ?? 21_000n,
    validAfter: over.validAfter ?? 0n,
    validBefore: over.validBefore ?? BigInt(nowSec + 600),
    nonce: over.nonce ?? (`0x${'ab'.repeat(32)}` as `0x${string}`),
  }
  const signature = await buyer.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: 'TransferWithAuthorization', message: authorization,
  })
  return {
    payload: {
      x402Version: 2, scheme: 'exact', network: chain.caip2,
      payload: {
        signature,
        authorization: {
          from: authorization.from, to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    },
    authorization,
  }
}

function deps(over: Record<string, unknown> = {}) {
  const state = (over.publicClient as { _state?: Parameters<typeof publicClient>[0] } | undefined)?._state
  const held: FakeReceipt | null | Error = state?.receiptThrows
    ? new Error(state.receiptThrows)
    : (state?.receipt ?? { status: 'success', blockNumber: 1n, gasUsed: 85_000n, logs: [] })
  return {
    reader: tokenReader(),
    now: () => NOW,
    loadSpent: async () => [] as string[],
    loadSettlements: async () => ({ ok: true as const, rows: [] as X402SettlementRecord[] }),
    env: {} as NodeJS.ProcessEnv,
    timeoutMs: 0,
    receipts: fakeHosts({ [HOST_A]: held }).receipts,
    ...over,
  }
}

test('the payment key is chain-qualified and cannot be confused with a tx hash', () => {
  const k = paymentKey('eip155:4663', token.address, buyer.address, `0x${'ab'.repeat(32)}`)
  assert.match(k, /^eip155:4663\/erc20:0x[0-9a-f]{40}\/3009\/0x[0-9a-f]{40}\/0x[0-9a-f]{64}$/)
  // The Arc rail writes 66-character 0x tx hashes into the same table; the two key
  // spaces must not overlap.
  assert.notEqual(k.length, 66)
  assert.ok(!k.startsWith('0x'))
})

test('a malformed payload is refused without throwing', () => {
  assert.equal(parseAuthorizationPayload(null).ok, false)
  assert.equal(parseAuthorizationPayload({ payload: { signature: '0x12' } }).ok, false)
  assert.equal(parseAuthorizationPayload({ payload: { authorization: {}, signature: `0x${'11'.repeat(65)}` } }).ok, false)
})

test('a genuine authorization verifies with no network', async () => {
  clearDomainCache()
  const { payload } = await signed()
  const r = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({}) }),
  })
  assert.equal(r.isValid, true)
  if (r.isValid) assert.equal(r.payer.toLowerCase(), buyer.address.toLowerCase())
})

test('every refusal reports its own code', async () => {
  clearDomainCache()
  const cases: { name: string; code: string; build: () => Promise<{ payload: unknown }>; state?: Record<string, unknown>; requirements?: typeof REQUIREMENTS }[] = [
    { name: 'wrong recipient', code: 'wrong_recipient', build: () => signed({ to: '0x00000000000000000000000000000000000000ff' }) },
    { name: 'wrong amount', code: 'wrong_amount', build: () => signed({ value: 22_000n }) },
    { name: 'not yet valid', code: 'not_yet_valid', build: () => signed({ validAfter: BigInt(nowSec + 300) }) },
    { name: 'expired', code: 'expired', build: () => signed({ validBefore: BigInt(nowSec - 5) }) },
    { name: 'expiring inside the mining window', code: 'expiring_too_soon', build: () => signed({ validBefore: BigInt(nowSec + 10) }) },
  ]
  for (const c of cases) {
    const { payload } = await c.build()
    const r = await verifyPayment({
      chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
      deps: deps({ publicClient: publicClient(c.state ?? {}) }),
    })
    assert.equal(r.isValid, false, c.name)
    if (!r.isValid) assert.equal(r.code, c.code, c.name)
  }
})

test('a payment for a lookalike USDG is refused as unsupported_asset, however well it is signed', async () => {
  // Robinhood Chain's explorer lists hundreds of tokens named "Global Dollar" with the symbol
  // USDG. A challenge that names one of them must not settle here, and the refusal has to come
  // from the address, before any signature or chain read, because a lookalike can carry the
  // real name, version and a working domain of its own.
  clearDomainCache()
  const LOOKALIKE = '0x1111111111111111111111111111111111111111' as `0x${string}`
  const { payload } = await signed()
  let reads = 0
  const r = await verifyPayment({
    chain, token, requirements: { ...REQUIREMENTS, asset: LOOKALIKE }, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({}), reader: (...a: Parameters<TokenReader>) => { reads++; return tokenReader()(...a) } }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) {
    assert.equal(r.code, 'unsupported_asset')
    assert.match(r.invalidReason, new RegExp(token.address))
  }
  assert.equal(reads, 0, 'refused on the address alone, with no token read')
})

/** A contract wallet: the payer is a contract address, and the signature over the
 *  authorization is made by a key that does NOT recover to it. Only an ERC-1271
 *  `isValidSignature` call can accept this, which is the whole point. */
const CONTRACT_WALLET = '0x00000000000000000000000000000000c0117ac7' as `0x${string}`

async function signedByContractWallet() {
  const authorization = {
    from: CONTRACT_WALLET,
    to: PAY_TO as `0x${string}`,
    value: 21_000n,
    validAfter: 0n,
    validBefore: BigInt(nowSec + 600),
    nonce: `0x${'cd'.repeat(32)}` as `0x${string}`,
  }
  // Signed by the buyer EOA, on behalf of the contract. Recover-and-compare cannot accept
  // this, because it recovers the buyer and the payer is the contract.
  const signature = await buyer.signTypedData({
    domain: DOMAIN, types: TYPES, primaryType: 'TransferWithAuthorization', message: authorization,
  })
  return {
    payload: {
      x402Version: 2, scheme: 'exact', network: chain.caip2,
      payload: {
        signature,
        authorization: {
          from: authorization.from, to: authorization.to,
          value: authorization.value.toString(),
          validAfter: authorization.validAfter.toString(),
          validBefore: authorization.validBefore.toString(),
          nonce: authorization.nonce,
        },
      },
    },
  }
}

/**
 * A client that can make calls, unlike the stub above, plus an ERC-1271 answer.
 *
 * `getChainId` is what hasPublicActions probes for: the plain stub does not have it, which
 * is exactly why every other test in this file still goes down the recover-only path and
 * why none of them noticed that contract wallets were being refused.
 */
function contractWalletClient(accepts: boolean) {
  const base = publicClient({})
  return {
    ...base,
    getChainId: async () => 4663,
    getCode: async () => '0x60006000' as `0x${string}`,
    // viem does not call isValidSignature directly. It deploys the ERC-6492 universal
    // validator through an eth_call and reads a BOOL back, which is why the answer here is
    // an abi-encoded true/false rather than the 0x1626ba7e magic value the account returns
    // one layer further in.
    call: async () => ({
      data: (accepts
        ? `0x${'0'.repeat(63)}1`
        : `0x${'0'.repeat(64)}`) as `0x${string}`,
    }),
  }
}

/**
 * The claim this file makes about contract wallets, held in place.
 *
 * verifyPayment used to call viem's TOP-LEVEL `verifyTypedData` and pass `publicClient`
 * into it, with a comment saying that was how an EIP-1271 contract wallet verified too.
 * That function destructures exactly { address, domain, message, primaryType, signature,
 * types } and does a plain recover-and-compare; the extra property was dropped on the
 * floor, and the `as never` cast on the call is what stopped the compiler objecting. So
 * every smart-contract wallet was refused with `bad_signature` while the code documented
 * support for it.
 */
test('a contract wallet verifies through ERC-1271 when the client can make calls', async () => {
  clearDomainCache()
  const { payload } = await signedByContractWallet()
  const r = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: contractWalletClient(true) }),
  })
  assert.equal(r.isValid, true, r.isValid ? '' : `refused: ${r.code} ${r.invalidReason}`)
  if (r.isValid) assert.equal(r.payer.toLowerCase(), CONTRACT_WALLET.toLowerCase())
})

test('a contract wallet that rejects the signature is still refused', async () => {
  clearDomainCache()
  const { payload } = await signedByContractWallet()
  const r = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: contractWalletClient(false) }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) assert.equal(r.code, 'bad_signature')
})

test('without a call-capable client an EOA still verifies, so the fallback is not a regression', async () => {
  clearDomainCache()
  const { payload } = await signed()
  const r = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({}) }),
  })
  assert.equal(r.isValid, true)
})

test('a value outside the rail limits is refused', async () => {
  clearDomainCache()
  const { payload } = await signed({ value: 21_000n })
  const below = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: { ...LIMITS, minValue: 30_000n },
    deps: deps({ publicClient: publicClient({}) }),
  })
  assert.equal(below.isValid, false)
  if (!below.isValid) assert.equal(below.code, 'below_minimum')

  const above = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: { ...LIMITS, maxValue: 1_000n },
    deps: deps({ publicClient: publicClient({}) }),
  })
  assert.equal(above.isValid, false)
  if (!above.isValid) assert.equal(above.code, 'above_maximum')
})

test('a used nonce, a redeemed key and a poor payer are each refused', async () => {
  clearDomainCache()
  const { payload, authorization } = await signed()
  const used = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({ authorizationState: true }) }),
  })
  assert.equal(used.isValid, false)
  if (!used.isValid) assert.equal(used.code, 'nonce_used')

  const key = paymentKey(chain.caip2, token.address, authorization.from, authorization.nonce)
  const redeemed = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({}), loadSpent: async () => [key] }),
  })
  assert.equal(redeemed.isValid, false)
  if (!redeemed.isValid) assert.equal(redeemed.code, 'already_redeemed')

  const poor = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({ balance: 5n }) }),
  })
  assert.equal(poor.isValid, false)
  if (!poor.isValid) assert.equal(poor.code, 'insufficient_funds')
})

test('a signature over a different domain does not verify', async () => {
  clearDomainCache()
  const wrongDomain = { ...DOMAIN, version: '2' }
  const authorization = {
    from: buyer.address, to: PAY_TO, value: 21_000n,
    validAfter: 0n, validBefore: BigInt(nowSec + 600), nonce: `0x${'cd'.repeat(32)}` as `0x${string}`,
  }
  const signature = await buyer.signTypedData({
    domain: wrongDomain, types: TYPES, primaryType: 'TransferWithAuthorization', message: authorization,
  })
  const payload = {
    payload: {
      signature,
      authorization: {
        from: authorization.from, to: authorization.to, value: '21000',
        validAfter: '0', validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
      },
    },
  }
  const r = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({}) }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) assert.equal(r.code, 'bad_signature')
})

test('an unprovable domain refuses before any chain read', async () => {
  clearDomainCache()
  const { payload } = await signed()
  const r = await verifyPayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ reader: tokenReader({ DOMAIN_SEPARATOR: `0x${'99'.repeat(32)}` }), publicClient: publicClient({}) }),
  })
  assert.equal(r.isValid, false)
  if (!r.isValid) assert.equal(r.code, 'domain_unproven')
})

test('a reverted receipt is recorded as reverted and NEVER as settled', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'01'.repeat(32)}` })
  const log = memoryLog()
  let spentWrites = 0
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({ receipt: { status: 'reverted', blockNumber: 7n, gasUsed: 85_000n, logs: [] } }),
      walletClient: fakeSigningWallet('0x02aa'),
      signerAddress: PAY_TO,
      ...log,
      persistSpent: async () => { spentWrites += 1 },
      gasSpentTodayWei: async () => 0n,
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'receipt_reverted')
  assert.equal(log.rows.length, 1)
  assert.equal(log.rows[0].outcome, 'reverted')
  assert.ok(log.rows.every((x) => x.outcome !== 'settled'))
  // A failed settlement must not consume the buyer's authorization on our side.
  assert.equal(spentWrites, 0)
})

test('a successful receipt with no matching Transfer log is not a settlement', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'02'.repeat(32)}` })
  const log = memoryLog()
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({ receipt: { status: 'success', blockNumber: 8n, gasUsed: 85_000n, logs: [] } }),
      walletClient: fakeSigningWallet('0x02bb'),
      signerAddress: PAY_TO,
      ...log,
      persistSpent: async () => {},
      gasSpentTodayWei: async () => 0n,
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'no_transfer_log')
  assert.equal(log.rows[0].outcome, 'reverted')
})

test('a receipt with a matching Transfer log settles and records the asset', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'03'.repeat(32)}` })
  const log = memoryLog()
  const spent: string[] = []
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({
        receipt: {
          status: 'success', blockNumber: 9n, gasUsed: 85_000n, effectiveGasPrice: 50_578_000n,
          logs: [transferLog(buyer.address, PAY_TO, 21_000n)],
        },
      }),
      walletClient: fakeSigningWallet('0x02cc'),
      signerAddress: PAY_TO,
      ...log,
      persistSpent: async (k: string) => { spent.push(k) },
      gasSpentTodayWei: async () => 0n,
      meta: { tool: 'risk_check', baseUsd: 0.005, feeUsd: 0.016 },
    }),
  })
  assert.equal(r.success, true)
  if (r.success) {
    assert.equal(r.value, '21000')
    assert.equal(r.assetSymbol, 'USDG')
    assert.equal(r.blockNumber, '9')
    assert.ok(r.explorerUrl.includes(r.transaction))
  }
  assert.equal(log.rows[0].outcome, 'settled')
  assert.equal(log.rows[0].asset, token.address)
  assert.equal(log.rows[0].assetDecimals, 6)
  assert.equal(log.rows[0].amountUsd, 0.021)
  assert.equal(spent.length, 1)
})

test('a simulation revert costs zero broadcasts', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'04'.repeat(32)}` })
  let broadcasts = 0
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({ simulateThrows: 'FiatToken: authorization is used' }),
      walletClient: fakeSigningWallet('0x02dd', { onSend: () => { broadcasts += 1 } }),
      signerAddress: PAY_TO,
      persist: async () => {},
      persistSpent: async () => {},
      gasSpentTodayWei: async () => 0n,
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'simulation_reverted')
  assert.equal(broadcasts, 0)
})

test('the gas ceiling and the daily budget each refuse before broadcasting', async () => {
  clearDomainCache()
  let broadcasts = 0
  const wallet = fakeSigningWallet('0x02ee', { onSend: () => { broadcasts += 1 } })

  const { payload } = await signed({ nonce: `0x${'05'.repeat(32)}` })
  const ceiling = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: { ...LIMITS, maxGasWei: 1n },
    deps: deps({ publicClient: publicClient({}), walletClient: wallet, signerAddress: PAY_TO, persist: async () => {}, persistSpent: async () => {}, gasSpentTodayWei: async () => 0n }),
  })
  assert.equal(ceiling.success, false)
  if (!ceiling.success) assert.equal(ceiling.code, 'gas_ceiling')

  const budget = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({}), walletClient: wallet, signerAddress: PAY_TO, persist: async () => {}, persistSpent: async () => {}, gasSpentTodayWei: async () => LIMITS.dailyGasWei }),
  })
  assert.equal(budget.success, false)
  if (!budget.success) assert.equal(budget.code, 'gas_budget_exhausted')
  assert.equal(broadcasts, 0)
})

test('a receipt timeout is ambiguous, keeps the hash, and does not mark the key spent', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'06'.repeat(32)}` })
  const log = memoryLog()
  let spentWrites = 0
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({ receiptThrows: 'timed out' }),
      walletClient: fakeSigningWallet('0x02ff'),
      signerAddress: PAY_TO,
      ...log,
      persistSpent: async () => { spentWrites += 1 },
      gasSpentTodayWei: async () => 0n,
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'receipt_timeout')
    assert.equal(r.ambiguous, true)
    assert.ok(r.transaction)
  }
  assert.equal(log.rows[0].outcome, 'ambiguous')
  assert.ok(log.rows[0].authNonce)
  assert.equal(spentWrites, 0)
})

// ── the receipt is read from every RPC ───────────────────────────────────────────────
//
// viem's fallback rolls over only when a request fails, and a host with no receipt answers
// null, which is a successful answer. So the first case below is the one the fallback client
// could not do: the first host says null, the second holds the receipt, and it settles.

const SETTLED_RECEIPT = (value = 21_000n): FakeReceipt => ({
  status: 'success', blockNumber: 9n, gasUsed: 85_000n, effectiveGasPrice: 50_578_000n,
  logs: [transferLog(buyer.address, PAY_TO, value)],
})

/** The settlement log and its two conditional updates, in memory, with the storage rules. */
function memoryLog() {
  const rows: X402SettlementRecord[] = []
  return {
    rows,
    persist: async (rec: X402SettlementRecord) => { rows.push({ ...rec }) },
    loadSettlements: async () => ({ ok: true as const, rows: rows.map((r) => ({ ...r })) }),
    resolveSettlement: async (tx: string, resolution: Partial<X402SettlementRecord>) => ({
      ok: true as const,
      updated: patchX402Rows(rows, tx.toLowerCase(), resolution, (r) => r.outcome === 'ambiguous'),
    }),
    redeemSettlement: async (tx: string, at: string, opts: { staleBefore: string; servedAt?: string }) => ({
      ok: true as const,
      updated: patchX402Rows(
        rows,
        tx.toLowerCase(),
        { redeemedAt: at, ...(opts.servedAt ? { servedAt: opts.servedAt } : {}) },
        (r) => r.outcome === 'settled' && !r.servedAt && (!r.redeemedAt || r.redeemedAt < opts.staleBefore),
      ),
    }),
    markServed: async (tx: string, at: string, claimedAt: string) => ({
      ok: true as const,
      updated: patchX402Rows(rows, tx.toLowerCase(), { servedAt: at }, (r) => r.outcome === 'settled' && !r.servedAt && r.redeemedAt === claimedAt),
    }),
    releaseClaim: async (tx: string, claimedAt: string) => {
      let updated = false
      for (const r of rows) {
        if (r.tx?.toLowerCase() === tx.toLowerCase() && !r.servedAt && r.redeemedAt === claimedAt) {
          delete r.redeemedAt
          updated = true
        }
      }
      return { ok: true as const, updated }
    },
  }
}

/** One buyer's payment against fake hosts and an in-memory log. The chain's own answer to
 *  authorizationState, the hosts and the log are all open for a test to change between calls. */
async function paymentScene(nonceByte: string, hosts: Record<string, FakeReceipt | null | Error>, over: { validBefore?: bigint } = {}) {
  clearDomainCache()
  __resetSendStateForTests()
  const { payload, authorization } = await signed({ nonce: `0x${nonceByte.repeat(32)}` as `0x${string}`, ...over })
  const log = memoryLog()
  const fake = fakeHosts(hosts)
  const chainState = { authorizationState: false }
  const spent: string[] = []
  const counters = { broadcasts: 0 }
  const raw = `0x02${nonceByte}` as `0x${string}`
  const hash = keccak256(raw)
  const engineDeps = (over2: Record<string, unknown> = {}) =>
    deps({
      publicClient: publicClient(chainState),
      walletClient: fakeSigningWallet(raw, { onSend: () => { counters.broadcasts += 1 } }),
      signerAddress: PAY_TO,
      receipts: fake.receipts,
      gasSpentTodayWei: async () => 0n,
      loadSpent: async () => [...spent],
      persistSpent: async (k: string) => { spent.push(k) },
      meta: { tool: 'risk_check', baseUsd: 0.005, feeUsd: 0.016 },
      requestHash: 'the buyer request',
      ...log,
      ...over2,
    })
  const settle = (over2: Record<string, unknown> = {}, requirements = REQUIREMENTS, body: unknown = payload) =>
    settlePayment({ chain, token, requirements, payload: body, limits: LIMITS, deps: engineDeps(over2) })
  return { payload, authorization, log, fake, chainState, spent, counters, hash, hosts, settle, engineDeps }
}

test('a null from the first host and a receipt from the second settles', async () => {
  const s = await paymentScene('20', { [HOST_A]: null, [HOST_B]: SETTLED_RECEIPT(), [HOST_C]: null })
  const r = await s.settle()
  assert.equal(r.success, true, JSON.stringify(r))
  assert.deepEqual(s.fake.asked, [HOST_A, HOST_B], 'the second host is asked because the first said null, and the first answer wins')
  assert.equal(s.log.rows[0].outcome, 'settled')
  assert.equal(s.spent.length, 1)
})

test('no receipt on any host is ambiguous only after every host was asked, and a failing host is not a null', async () => {
  const s = await paymentScene('21', { [HOST_A]: null, [HOST_B]: new Error('HTTP 503'), [HOST_C]: null })
  const r = await s.settle()
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'receipt_timeout')
    assert.equal(r.ambiguous, true)
    assert.equal(r.transaction, s.hash)
    assert.match(r.errorReason, /2 answered null, 1 did not answer/)
    assert.doesNotMatch(r.errorReason, /rpc\.test/, 'a host URL can carry a provider key and never reaches a buyer')
  }
  assert.deepEqual(s.fake.asked, [HOST_A, HOST_B, HOST_C])
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
  assert.equal(s.spent.length, 0)
})

test('a receipt not yet deep enough for the chain is ambiguous, not settled', async () => {
  assert.ok(chain.confirmations > 1, 'this case needs a chain that asks for depth')
  const s = await paymentScene('22', { [HOST_A]: SETTLED_RECEIPT() })
  const shallow: EveryRpcOptions = {
    ...s.fake.receipts,
    call: async (url, method, params) =>
      method === 'eth_blockNumber' ? '0x9' : rawReceipt(params[0], SETTLED_RECEIPT()),
  }
  const r = await s.settle({ receipts: shallow })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'receipt_timeout')
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
})

// ── a broadcast that outlives its wait ───────────────────────────────────────────────

test('ambiguous, then the transaction lands: the retry is served, and not charged again', async () => {
  const s = await paymentScene('23', { [HOST_A]: null, [HOST_B]: null })
  const first = await s.settle()
  assert.equal(first.success, false)
  assert.equal(s.counters.broadcasts, 1)

  // It lands, and the token now reports the nonce as used. Only the second host has the receipt.
  s.chainState.authorizationState = true
  s.hosts[HOST_B] = SETTLED_RECEIPT()
  const retry = await s.settle()
  assert.equal(retry.success, true, JSON.stringify(retry))
  if (retry.success) {
    assert.equal(retry.transaction, s.hash, 'the answer is the transaction that already landed')
    assert.equal(retry.reconciled, true)
    assert.equal(retry.blockNumber, '9')
    assert.equal(retry.gasWei, (85_000n * 50_578_000n).toString())
    assert.ok(retry.explorerUrl.includes(s.hash))
  }
  assert.equal(s.counters.broadcasts, 1, 'a retry after landing broadcasts nothing')

  // One row, resolved in place: the gas stays on the day it was spent and nothing counts twice.
  assert.equal(s.log.rows.length, 1)
  const row = s.log.rows[0]
  assert.equal(row.outcome, 'settled')
  assert.equal(row.ts, NOW.toISOString())
  assert.equal(row.reconciledAt, NOW.toISOString())
  assert.equal(row.gasWei, (85_000n * 50_578_000n).toString())
  assert.deepEqual(s.spent, [paymentKey(chain.caip2, token.address, buyer.address, s.authorization.nonce)])

  // The payment bought one call. Once served, sending it again is the replay it always was.
  assert.equal(await markSettlementServed(s.hash, CLAIM, s.engineDeps()), true)
  const replay = await s.settle()
  assert.equal(replay.success, false)
  if (!replay.success) assert.equal(replay.code, 'already_redeemed')
})

test('the one call is redeemed once even when the replay key cannot be written', async () => {
  const s = await paymentScene('24', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const persistSpent = async () => { throw new Error('database is gone') }
  const retry = await s.settle({ persistSpent })
  assert.equal(retry.success, true)
  if (retry.success) assert.match(retry.replayKeyWarning ?? '', /authorizationState/)
  assert.ok(s.log.rows[0].redeemedAt)
  await markSettlementServed(s.hash, CLAIM, s.engineDeps())
  const replay = await s.settle({ persistSpent })
  assert.equal(replay.success, false)
  if (!replay.success) assert.equal(replay.code, 'already_redeemed')
})

test('a retry before the transaction lands broadcasts nothing and says to send the same payment', async () => {
  const s = await paymentScene('25', { [HOST_A]: null })
  await s.settle()
  const retry = await s.settle()
  assert.equal(retry.success, false)
  if (!retry.success) {
    assert.equal(retry.code, 'settlement_pending')
    assert.equal(retry.ambiguous, true)
    assert.equal(retry.transaction, s.hash)
    assert.match(retry.errorReason, /rather than signing a new one/)
  }
  assert.equal(s.counters.broadcasts, 1, 'the second broadcast could only revert at our cost')
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
  assert.equal(s.spent.length, 0)
})

test('ambiguous, then reverted: the row is reverted, never settled, and the authorization is free to try again', async () => {
  const s = await paymentScene('26', { [HOST_A]: null })
  await s.settle()
  s.hosts[HOST_A] = { status: 'reverted', blockNumber: 9n, gasUsed: 40_000n, effectiveGasPrice: 2n, logs: [] }
  const retry = await s.settle()
  // Nothing moved, the nonce is still unused, and the buyer's signature is still good.
  assert.equal(s.counters.broadcasts, 2, 'a revert frees the authorization for a fresh broadcast')
  assert.equal(s.log.rows[0].outcome, 'reverted')
  assert.equal(s.log.rows[0].gasWei, '80000', 'the gas the revert burned reaches the ledger')
  assert.ok(s.log.rows[0].reconciledAt)
  assert.ok(s.log.rows.every((r) => r.outcome !== 'settled'))
  // The second broadcast has the same hash in this fixture and the host still holds the revert.
  assert.equal(retry.success, false)
  if (!retry.success) assert.equal(retry.code, 'receipt_reverted')
})

test('a mined transaction with no matching Transfer log reconciles to reverted, not settled', async () => {
  const s = await paymentScene('27', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = { status: 'success', blockNumber: 9n, gasUsed: 85_000n, logs: [transferLog(buyer.address, PAY_TO, 20_999n)] }
  const retry = await s.settle()
  assert.equal(retry.success, false)
  if (!retry.success) assert.equal(retry.code, 'nonce_used')
  assert.equal(s.log.rows[0].outcome, 'reverted')
  assert.equal(s.spent.length, 0)
})

test('a used nonce with a forged signature finds nothing, whoever it names', async () => {
  // The proof page lists every payer and nonce. Those two must not be enough to claim a call.
  const s = await paymentScene('28', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const other = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')
  const forged = await other.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'TransferWithAuthorization', message: s.authorization })
  const body = { ...s.payload, payload: { ...s.payload.payload, signature: forged } }
  const stolen = await s.settle({}, REQUIREMENTS, body)
  assert.equal(stolen.success, false)
  if (!stolen.success) assert.equal(stolen.code, 'nonce_used')
  assert.equal(s.log.rows[0].outcome, 'ambiguous', 'a forged retry reads nothing and changes nothing')
  assert.equal(s.spent.length, 0)
  // The real buyer's retry still works afterwards.
  assert.equal((await s.settle()).success, true)
})

test('a settlement paid for one resource does not serve another at the same price', async () => {
  const s = await paymentScene('29', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const r = await s.settle({}, { ...REQUIREMENTS, resource: '/api/x402/tools/verify_agent' })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'already_redeemed')
  assert.equal(s.log.rows[0].redeemedAt, undefined, 'the call stays available for what was paid for')
  assert.equal((await s.settle()).success, true)
})

test('an authorization that expired while the buyer waited is still served once it landed', async () => {
  // The buyer's clock does not stop for our receipt. Refusing this as expired would ask someone
  // who already paid to pay again.
  const s = await paymentScene('2a', { [HOST_A]: null }, { validBefore: BigInt(nowSec + 600) })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const later = new Date(NOW.getTime() + 3_600_000)
  const r = await s.settle({ now: () => later })
  assert.equal(r.success, true, JSON.stringify(r))
})

test('an expired authorization with no broadcast of ours stays refused as expired', async () => {
  const s = await paymentScene('2b', { [HOST_A]: null }, { validBefore: BigInt(nowSec - 5) })
  const r = await s.settle()
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'expired')
  assert.equal(s.counters.broadcasts, 0)
})

test('a dropped broadcast does not hold the buyer past the deadline: expired, nonce unused, no receipt', async () => {
  // Telling this buyer to keep retrying would never end: the transaction is gone, and the token
  // refuses the authorization now. No money moved, so a fresh challenge is the true answer.
  const s = await paymentScene('2e', { [HOST_A]: null })
  await s.settle()
  const later = new Date(NOW.getTime() + 3_600_000)
  const r = await s.settle({ now: () => later })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'expired')
  assert.equal(s.counters.broadcasts, 1)
  assert.equal(s.log.rows[0].outcome, 'ambiguous', 'no receipt resolved it, and the row says so')

  // Past the deadline with the nonce USED and no host holding the receipt, the money did move
  // and only the hosts are behind, so the buyer is still told not to sign a new one.
  s.chainState.authorizationState = true
  const used = await s.settle({ now: () => later })
  assert.equal(used.success, false)
  if (!used.success) assert.equal(used.code, 'settlement_pending')
})

test('a settlement log that cannot be read refuses before any broadcast', async () => {
  const s = await paymentScene('2c', { [HOST_A]: SETTLED_RECEIPT() })
  const r = await s.settle({ loadSettlements: async () => ({ ok: false as const, reason: 'ECONNREFUSED' }) })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'rpc_error')
    assert.doesNotMatch(r.errorReason, /ECONNREFUSED/, 'the buyer is not told about our database')
  }
  assert.equal(s.counters.broadcasts, 0)
})

test('a resolution that cannot be written keeps the row ambiguous, and the next retry can finish it', async () => {
  const s = await paymentScene('2d', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const r = await s.settle({ resolveSettlement: async () => ({ ok: false as const, reason: 'database is gone' }) })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'settlement_pending')
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
  assert.equal((await s.settle()).success, true)
})

// ── a retry is served to the request that paid, and nobody else ──────────────────────
//
// transferWithAuthorization puts every field and the signature in public calldata, so a genuine
// signature proves nothing about who is presenting it. These replay the buyer's real payload.

test('THE REPLAY: the public calldata with a different request gets nothing, and the buyer keeps the call', async () => {
  const s = await paymentScene('40', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  // Rebuilt from the transaction input: the same authorization and the same signature.
  const stolen = await s.settle({ requestHash: 'the attacker agent id' })
  assert.equal(stolen.success, false)
  if (!stolen.success) {
    assert.equal(stolen.code, 'request_mismatch')
    assert.match(stolen.errorReason, /do not sign a new one/)
  }
  assert.equal(s.log.rows[0].redeemedAt, undefined, 'the claim is untouched')
  assert.equal(s.spent.length, 0, 'and so is the replay key')
  const buyers = await s.settle()
  assert.equal(buyers.success, true, JSON.stringify(buyers))
  assert.equal(s.counters.broadcasts, 1)
})

test('a bare /settle cannot burn the call a paid tool request is owed', async () => {
  const s = await paymentScene('41', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const burn = await s.settle({ requestHash: undefined, meta: undefined })
  assert.equal(burn.success, false)
  if (!burn.success) assert.equal(burn.code, 'request_mismatch')
  assert.equal(s.log.rows[0].redeemedAt, undefined)
  assert.equal((await s.settle()).success, true)
})

test('a row from before the request hash cannot be claimed by anyone', async () => {
  // Production has ambiguous rows with no request on them. A sweep can resolve them, and nothing
  // about a retry then shows it came from the buyer.
  const s = await paymentScene('42', { [HOST_A]: SETTLED_RECEIPT() })
  await s.log.persist({ ...baseRow(), outcome: 'settled', reconciledAt: NOW.toISOString(), tx: s.hash, authNonce: s.authorization.nonce })
  s.chainState.authorizationState = true
  const r = await s.settle()
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'already_redeemed')
  assert.equal(s.log.rows[0].redeemedAt, undefined)
})

test('a settlement can be redeemed only inside its window, and the refusal names the transaction', async () => {
  const s = await paymentScene('43', { [HOST_A]: null })
  await s.settle()
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const late = new Date(NOW.getTime() + REDEEM_WINDOW_MS + 1_000)
  const r = await s.settle({ now: () => late })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'already_redeemed')
    assert.equal(r.transaction, s.hash)
    assert.match(r.errorReason, /window to redeem/)
  }
  const inside = new Date(NOW.getTime() + REDEEM_WINDOW_MS - 1_000)
  assert.equal((await s.settle({ now: () => inside })).success, true)
})

// ── a settlement stays owed until its response was written ───────────────────────────

test('a first-attempt settlement whose tool or socket failed is served on retry, with no second charge', async () => {
  const s = await paymentScene('44', { [HOST_A]: SETTLED_RECEIPT() })
  const first = await s.settle()
  assert.equal(first.success, true)
  if (!first.success) return
  assert.ok(s.log.rows[0].redeemedAt, 'the first attempt holds the claim')
  assert.equal(s.log.rows[0].servedAt, undefined, 'and has served nothing yet')
  s.chainState.authorizationState = true
  const during = await s.settle()
  assert.equal(during.success, false)
  if (!during.success) assert.equal(during.code, 'in_flight', 'not already_redeemed, which would ask the buyer to pay again')

  assert.equal(await releaseSettlementClaim(s.hash, first.settledAt, s.engineDeps()), true)
  const retry = await s.settle()
  assert.equal(retry.success, true, JSON.stringify(retry))
  if (retry.success) {
    assert.equal(retry.transaction, s.hash)
    assert.equal(retry.reconciled, true)
  }
  assert.equal(s.counters.broadcasts, 1)
  assert.equal(await markSettlementServed(s.hash, CLAIM, s.engineDeps()), true)
  const replay = await s.settle()
  assert.equal(replay.success, false)
  if (!replay.success) assert.equal(replay.code, 'already_redeemed')
})

test('a claim left by a process that died goes stale, and a release of an old claim frees nothing newer', async () => {
  const s = await paymentScene('45', { [HOST_A]: SETTLED_RECEIPT() })
  const first = await s.settle()
  assert.equal(first.success, true)
  s.chainState.authorizationState = true
  const later = new Date(NOW.getTime() + 300_000)
  const retry = await s.settle({ now: () => later })
  assert.equal(retry.success, true, JSON.stringify(retry))
  if (first.success) assert.equal(await releaseSettlementClaim(s.hash, first.settledAt, s.engineDeps()), false)
  assert.equal(s.log.rows[0].redeemedAt, later.toISOString())
})

test('a bare /settle answer is its service: the row is spent at once and names the tx when asked again', async () => {
  const s = await paymentScene('46', { [HOST_A]: SETTLED_RECEIPT() })
  const bare = { requestHash: undefined, meta: undefined }
  assert.equal((await s.settle(bare)).success, true)
  assert.ok(s.log.rows[0].servedAt)
  s.chainState.authorizationState = true
  const again = await s.settle(bare)
  assert.equal(again.success, false)
  if (!again.success) {
    assert.equal(again.code, 'already_redeemed')
    assert.equal(again.transaction, s.hash)
  }
})

test('a reconciled bare /settle is answered once', async () => {
  const s = await paymentScene('47', { [HOST_A]: null })
  const bare = { requestHash: undefined, meta: undefined }
  await s.settle(bare)
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const answered = await s.settle(bare)
  assert.equal(answered.success, true, JSON.stringify(answered))
  assert.ok(s.log.rows[0].servedAt)
  const again = await s.settle(bare)
  assert.equal(again.success, false)
  if (!again.success) assert.equal(again.code, 'already_redeemed')
})

// ── the broadcast is on the record before any wait ───────────────────────────────────

test('the ambiguous row exists before the wait starts, so a restart inside the wait loses nothing', async () => {
  const s = await paymentScene('48', { [HOST_A]: null })
  const seenDuringWait: X402SettlementRecord[][] = []
  const watched: EveryRpcOptions = {
    ...s.fake.receipts,
    call: async (url, method, params) => {
      seenDuringWait.push(s.log.rows.map((r) => ({ ...r })))
      return (s.fake.receipts.call as (u: string, m: string, p: readonly unknown[]) => Promise<unknown>)(url, method, params)
    },
  }
  await s.settle({ receipts: watched })
  assert.equal(seenDuringWait[0].length, 1, 'the row was there on the first receipt read')
  assert.equal(seenDuringWait[0][0].outcome, 'ambiguous')
  assert.equal(seenDuringWait[0][0].tx, s.hash)
  assert.equal(seenDuringWait[0][0].requestHash, 'the buyer request')

  // The process that sent it is gone, so nothing is in memory. A retry still finds the row.
  const restarted = await s.settle()
  assert.equal(restarted.success, false)
  if (!restarted.success) assert.equal(restarted.code, 'settlement_pending')
  assert.equal(s.counters.broadcasts, 1, 'a pending transaction is not sent twice')
})

test('a row that cannot be written means nothing is broadcast, and the buyer is told so', async () => {
  for (const persist of [
    async () => { throw new Error('database is gone') },
    async () => ({ ok: false }),
  ]) {
    const s = await paymentScene(persist.toString().includes('throw') ? '49' : '4a', { [HOST_A]: null })
    const r = await s.settle({ persist })
    assert.equal(r.success, false)
    if (!r.success) {
      assert.equal(r.code, 'settlement_log_unavailable')
      assert.equal(r.transaction, undefined, 'there is no transaction to name, because none was sent')
      assert.equal(r.ambiguous, undefined)
      assert.match(r.errorReason, /nothing was broadcast and nothing was charged/)
      assert.doesNotMatch(r.errorReason, /database is gone/)
    }
    assert.equal(s.counters.broadcasts, 0, 'no row, no send')
    assert.deepEqual(s.spent, [])
  }
})

test('the row is in the log before the send, with the hash and the nonce it was signed with', async () => {
  const s = await paymentScene('4b', { [HOST_A]: SETTLED_RECEIPT() })
  let atSend: X402SettlementRecord[] = []
  const r = await s.settle({
    walletClient: fakeSigningWallet('0x024b', { nonce: 41, onSend: () => { atSend = s.log.rows.map((x) => ({ ...x })) } }),
  })
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(atSend.length, 1, 'the row exists when the send runs')
  assert.equal(atSend[0].outcome, 'ambiguous')
  assert.equal(atSend[0].tx, s.hash)
  assert.equal(atSend[0].signerNonce, 41)
  assert.equal(atSend[0].signer, PAY_TO)
  assert.equal(atSend[0].authNonce, s.authorization.nonce)
  assert.equal(s.log.rows.length, 1)
  assert.equal(s.log.rows[0].outcome, 'settled')
})

test('a lost send answer is ambiguous under its hash, and the retry is served once with no second send', async () => {
  const s = await paymentScene('4d', { [HOST_A]: null })
  // A host took it and the connection dropped; the fallback's next host then says "nonce too low".
  const lost = fakeSigningWallet('0x024d', { onSend: () => { s.counters.broadcasts += 1; throw new Error('nonce too low') } })
  const r = await s.settle({ walletClient: lost })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'receipt_timeout')
    assert.equal(r.ambiguous, true)
    assert.equal(r.transaction, s.hash)
    assert.notEqual(r.code, 'broadcast_failed')
  }
  assert.equal(s.log.rows.length, 1)
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
  assert.equal(s.log.rows[0].tx, s.hash)

  // It lands. The retry is refused as a used nonce before anything else, and answers from the row.
  s.chainState.authorizationState = true
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const retry = await s.settle({ walletClient: lost })
  assert.equal(retry.success, true, JSON.stringify(retry))
  if (retry.success) {
    assert.equal(retry.transaction, s.hash)
    assert.equal(retry.reconciled, true)
  }
  assert.equal(s.counters.broadcasts, 1, 'the retry sent nothing')
  assert.equal(await markSettlementServed(s.hash, CLAIM, s.engineDeps()), true)
  const replay = await s.settle({ walletClient: lost })
  assert.equal(replay.success, false)
  if (!replay.success) assert.equal(replay.code, 'already_redeemed')
  assert.equal(s.counters.broadcasts, 1)
  assert.equal(s.log.rows.length, 1)
})

test('a send the node clearly refused closes the row and leaves the authorization free', async () => {
  const s = await paymentScene('4e', { [HOST_A]: null })
  const refused = fakeSigningWallet('0x024e', { onSend: () => { throw new Error('insufficient funds for gas * price + value') } })
  const r = await s.settle({ walletClient: refused })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'broadcast_failed')
    assert.equal(r.ambiguous, undefined)
    assert.equal(r.transaction, undefined)
  }
  assert.equal(s.log.rows[0].outcome, 'dropped')
  assert.equal(s.log.rows[0].gasWei, undefined)
  // The same authorization can be sent again, and this time it settles.
  s.hosts[HOST_A] = SETTLED_RECEIPT()
  const again = await s.settle()
  assert.equal(again.success, true, JSON.stringify(again))
  assert.equal(s.counters.broadcasts, 1)
  assert.equal(s.log.rows.at(-1)?.outcome, 'settled')
})

test('"underpriced" while another host has the hash is ambiguous, not a refusal', async () => {
  const s = await paymentScene('4f', { [HOST_A]: null, [HOST_B]: null })
  const answer = s.fake.receipts.call!
  const receipts: EveryRpcOptions = {
    ...s.fake.receipts,
    call: async (url, method, params, ms) => {
      if (method === 'eth_getTransactionByHash' && url === HOST_A) {
        return { hash: params[0], from: buyer.address, input: '0x', to: PAY_TO, nonce: '0x1', blockHash: null, blockNumber: null, transactionIndex: null, value: '0x0', gas: '0x1', v: '0x1b', r: '0x1', s: '0x1', type: '0x0', gasPrice: '0x1' }
      }
      return answer(url, method, params, ms)
    },
  }
  const r = await s.settle({
    receipts,
    walletClient: fakeSigningWallet('0x024f', { onSend: () => { throw new Error('transaction underpriced') } }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'receipt_timeout')
    assert.equal(r.ambiguous, true)
    assert.equal(r.transaction, s.hash)
  }
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
})

test('a row whose nonce another transaction used and that no host has is dropped, and the retry sends again', async () => {
  const s = await paymentScene('50', { [HOST_A]: null })
  // A host took a different transaction at this nonce: this one can never land.
  await s.settle({ walletClient: fakeSigningWallet('0x0250', { nonce: 7, onSend: () => { throw new Error('nonce too low') } }) })
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
  const answer = s.fake.receipts.call!
  const counted = (count: string): EveryRpcOptions => ({
    ...s.fake.receipts,
    call: async (url, method, params, ms) => (method === 'eth_getTransactionCount' ? count : answer(url, method, params, ms)),
  })

  // The nonce is not passed yet: it may still land, so nothing moves.
  const early = await s.settle({ receipts: counted('0x7') })
  assert.equal(early.success, false)
  if (!early.success) assert.equal(early.code, 'settlement_pending')
  assert.equal(s.log.rows[0].outcome, 'ambiguous')

  // The token says the authorization is used: it did land somewhere, whatever the hosts say.
  s.chainState.authorizationState = true
  const used = await s.settle({ receipts: counted('0x8') })
  assert.equal(used.success, false)
  assert.equal(s.log.rows[0].outcome, 'ambiguous', 'the token outranks a host that has no record')
  s.chainState.authorizationState = false

  // Passed, no host has it, and the token says unused: it is closed and the same authorization goes out.
  s.hosts[HOST_A] = null
  const raw = '0x0251' as const
  const second = await s.settle({
    receipts: {
      ...counted('0x8'),
      call: async (url: string, method: string, params: readonly unknown[], ms: number) => {
        if (method === 'eth_getTransactionCount') return '0x8'
        if (method === 'eth_getTransactionReceipt' && params[0] === keccak256(raw)) return rawReceipt(params[0], SETTLED_RECEIPT())
        return answer(url, method, params, ms)
      },
    },
    walletClient: fakeSigningWallet(raw, { nonce: 8 }),
  })
  assert.equal(second.success, true, JSON.stringify(second))
  assert.equal(s.log.rows[0].outcome, 'dropped')
  assert.equal(s.log.rows[1].outcome, 'settled')
  assert.equal(s.log.rows[1].signerNonce, 8)
})

test('a host that will not answer keeps the row ambiguous, however passed the nonce looks', async () => {
  const s = await paymentScene('52', { [HOST_A]: null, [HOST_B]: null })
  await s.settle({ walletClient: fakeSigningWallet('0x0252', { nonce: 7, onSend: () => { throw new Error('nonce too low') } }) })
  const answer = s.fake.receipts.call!
  const out = await reconcileSettlementRow(chain, s.log.rows[0], s.engineDeps({
    receipts: {
      ...s.fake.receipts,
      call: async (url: string, method: string, params: readonly unknown[], ms: number) => {
        if (method === 'eth_getTransactionCount') return '0x8'
        if (url === HOST_B && method === 'eth_getTransactionByHash') throw new Error('HTTP 429')
        return answer(url, method, params, ms)
      },
    },
  }) as never)
  assert.equal(out.outcome, 'ambiguous')
  assert.equal(s.log.rows[0].outcome, 'ambiguous')
})

test('concurrent settlements take turns at the signer and never reuse a nonce', async () => {
  // One real signer: the pending count moves only once a send has been taken, the way a node's does.
  const signer = privateKeyToAccount('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba')
  let pending = 3
  const sentNonces: number[] = []
  const order: string[] = []
  const wallet = {
    account: signer,
    prepareTransactionRequest: async (req: Record<string, unknown>) => {
      order.push('prepare')
      await new Promise((r) => setTimeout(r, 2))
      return { ...req, nonce: pending }
    },
    signTransaction: async (req: Record<string, unknown>) => `0x02${(req.nonce as number).toString(16).padStart(2, '0')}` as `0x${string}`,
    sendRawTransaction: async (req: { serializedTransaction: `0x${string}` }) => {
      order.push('send')
      await new Promise((r) => setTimeout(r, 2))
      sentNonces.push(Number.parseInt(req.serializedTransaction.slice(4), 16))
      pending += 1
      return keccak256(req.serializedTransaction)
    },
  }
  const scenes = await Promise.all(['60', '61', '62', '63'].map((b) => paymentScene(b, { [HOST_A]: SETTLED_RECEIPT() })))
  const results = await Promise.all(scenes.map((s) => s.settle({ walletClient: wallet, signerAddress: signer.address })))
  for (const r of results) assert.equal(r.success, true, JSON.stringify(r))
  assert.deepEqual([...sentNonces].sort((a, b) => a - b), [3, 4, 5, 6])
  assert.deepEqual(order, ['prepare', 'send', 'prepare', 'send', 'prepare', 'send', 'prepare', 'send'], 'one at a time')
})

test('a host whose pending count lags still does not make the next settlement reuse a nonce', async () => {
  const signer = privateKeyToAccount('0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e')
  const seen: number[] = []
  const wallet = {
    account: signer,
    // Answers from the latest block: this count does not see what was just accepted.
    prepareTransactionRequest: async (req: Record<string, unknown>) => ({ ...req, nonce: 9 }),
    signTransaction: async (req: Record<string, unknown>) => {
      seen.push(req.nonce as number)
      return `0x02${(req.nonce as number).toString(16).padStart(2, '0')}` as `0x${string}`
    },
    sendRawTransaction: async () => `0x${'00'.repeat(32)}` as `0x${string}`,
  }
  const scenes = [await paymentScene('64', { [HOST_A]: SETTLED_RECEIPT() }), await paymentScene('65', { [HOST_A]: SETTLED_RECEIPT() })]
  for (const s of scenes) assert.equal((await s.settle({ walletClient: wallet, signerAddress: signer.address })).success, true)
  assert.deepEqual(seen, [9, 10])
})

test('a send that threw leaves no floor, so a transaction no node took cannot stall the next one', async () => {
  const signer = privateKeyToAccount('0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356')
  const seen: number[] = []
  let throws = true
  const wallet = {
    account: signer,
    prepareTransactionRequest: async (req: Record<string, unknown>) => ({ ...req, nonce: 5 }),
    signTransaction: async (req: Record<string, unknown>) => {
      seen.push(req.nonce as number)
      return `0x02${seen.length.toString(16).padStart(2, '0')}` as `0x${string}`
    },
    sendRawTransaction: async () => {
      if (throws) throw new Error('fetch failed')
      return `0x${'00'.repeat(32)}` as `0x${string}`
    },
  }
  const first = await paymentScene('66', { [HOST_A]: null })
  const second = await paymentScene('67', { [HOST_A]: SETTLED_RECEIPT() })
  const lost = await first.settle({ walletClient: wallet, signerAddress: signer.address })
  assert.equal(lost.success, false)
  if (!lost.success) assert.equal(lost.code, 'receipt_timeout')
  throws = false
  assert.equal((await second.settle({ walletClient: wallet, signerAddress: signer.address })).success, true)
  assert.deepEqual(seen, [5, 5])
})

test('what a buyer reads of a node refusal is the node\'s words, never the request or the RPC URL', async () => {
  const s = await paymentScene('6f', { [HOST_A]: null })
  const viemShaped = Object.assign(new Error('Missing or invalid parameters.\n\nURL: https://rpc.test/secret-key\nRequest body: {"params":["0x02"]}\n\nDetails: transaction underpriced'), {
    details: 'transaction underpriced',
    shortMessage: 'Missing or invalid parameters.',
  })
  const refused = await s.settle({ walletClient: fakeSigningWallet('0x026f', { onSend: () => { throw viemShaped } }) })
  assert.equal(refused.success, false)
  if (!refused.success) {
    assert.equal(refused.code, 'broadcast_failed')
    assert.match(refused.errorReason, /transaction underpriced/)
    assert.doesNotMatch(refused.errorReason, /secret-key|Request body/)
  }
  const s2 = await paymentScene('70', { [HOST_A]: null })
  const prep = await s2.settle({ walletClient: fakeSigningWallet('0x0270', { onPrepare: () => { throw viemShaped } }) })
  assert.equal(prep.success, false)
  if (!prep.success) {
    assert.equal(prep.code, 'broadcast_failed')
    assert.doesNotMatch(prep.errorReason, /secret-key|Request body/)
  }
  assert.deepEqual(s2.log.rows, [], 'a failed prepare signed nothing and wrote nothing')
})

test('a signer stuck past the wait refuses the next settlement cleanly, and nothing goes out for it', async () => {
  const s = await paymentScene('68', { [HOST_A]: SETTLED_RECEIPT() })
  let gate!: () => void
  const stuck = new Promise<void>((r) => { gate = r })
  const account = privateKeyToAccount('0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97')
  const slow = sendCallSigned(chain, { client: fakeSigningWallet('0x0268', { onPrepare: () => stuck }), account }, ANY_CALL)
  const refused = await sendCallSigned(chain, { client: fakeSigningWallet('0x0269', { onSend: () => { s.counters.broadcasts += 1 } }), account }, ANY_CALL, { queueWaitMs: 1 }).catch((e) => e)
  assert.ok(refused instanceof SignerBusyError)
  gate()
  assert.equal((await slow).status, 'sent')
  assert.equal(s.counters.broadcasts, 0)
})

test('a real signer through a real viem client: fees, gas and the pending nonce are what writeContract would use', async () => {
  const signer = privateKeyToAccount('0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6')
  const asked: { method: string; params: unknown[] }[] = []
  const sent: `0x${string}`[] = []
  const answers: Record<string, unknown> = {
    eth_chainId: `0x${chain.evmChainId!.toString(16)}`,
    eth_getTransactionCount: '0x2a',
    eth_estimateGas: '0x14c08',
    eth_gasPrice: '0x4a817c800',
    eth_maxPriorityFeePerGas: '0x3b9aca00',
    eth_getBlockByNumber: { baseFeePerGas: '0x4a817c800', number: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x1', transactions: [] },
  }
  const wallet = createWalletClient({
    account: signer,
    chain: defineChain({ id: chain.evmChainId!, name: 'test', nativeCurrency: chain.nativeCurrency, rpcUrls: { default: { http: [] } } }),
    transport: custom({
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        asked.push({ method, params })
        if (method === 'eth_sendRawTransaction') {
          sent.push(params[0] as `0x${string}`)
          return keccak256(params[0] as `0x${string}`)
        }
        if (method in answers) return answers[method]
        throw new Error(`no answer for ${method}`)
      },
    }),
  })
  const s = await paymentScene('69', { [HOST_A]: SETTLED_RECEIPT() })
  const r = await s.settle({ walletClient: wallet, signerAddress: signer.address })
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(sent.length, 1)
  const tx = parseTransaction(sent[0])
  assert.equal(tx.chainId, chain.evmChainId)
  assert.equal(tx.nonce, 42)
  assert.equal(tx.to?.toLowerCase(), token.address.toLowerCase())
  assert.equal(tx.gas, 0x14c08n)
  // viem's default: 1.2 x base fee + tip. A fee this path left out would not reach the signature.
  assert.equal(tx.maxPriorityFeePerGas, 0x3b9aca00n)
  assert.equal(tx.maxFeePerGas, (0x4a817c800n * 12n) / 10n + 0x3b9aca00n)
  assert.equal(decodeFunctionData({ abi: EIP3009_ABI, data: tx.data! }).functionName, 'transferWithAuthorization')
  assert.equal(asked.find((a) => a.method === 'eth_getTransactionCount')?.params[1], 'pending')
  if (r.success) assert.equal(r.transaction, keccak256(sent[0]))
  assert.equal(s.log.rows[0].signerNonce, 42)
})

test('a settled write with no row at all under the hash is written whole, and only then', async () => {
  const s = await paymentScene('6a', { [HOST_A]: SETTLED_RECEIPT() })
  let inserts = 0
  // The row vanished between the send and the receipt: nothing to update, and nothing there to double.
  const r = await s.settle({
    persist: async (rec: X402SettlementRecord) => {
      inserts += 1
      if (rec.outcome !== 'ambiguous') await s.log.persist(rec)
    },
  })
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(inserts, 2)
  assert.equal(s.log.rows.length, 1)
  assert.equal(s.log.rows[0].outcome, 'settled')
  assert.equal(s.log.rows[0].gasUsed, '85000')
  assert.ok(s.log.rows[0].redeemedAt)
})

test('finish updates by tx: a row already resolved by a sweep gets no second row beside it', async () => {
  const s = await paymentScene('6b', { [HOST_A]: SETTLED_RECEIPT() })
  let persists = 0
  const r = await s.settle({
    persist: async (rec: X402SettlementRecord) => { persists += 1; await s.log.persist(rec) },
    resolveSettlement: async (tx: string, res: Partial<X402SettlementRecord>) => {
      // A proof read got there first, so this write moves nothing.
      s.log.rows[0].outcome = 'settled'
      s.log.rows[0].reconciledAt = NOW.toISOString()
      void tx
      void res
      return { ok: true as const, updated: false }
    },
  })
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(persists, 1, 'one insert: the row from before the send')
  assert.equal(s.log.rows.length, 1)
})

test('a proof read that resolved the row during the wait does not lose the first attempt its claim', async () => {
  const s = await paymentScene('4c', { [HOST_A]: SETTLED_RECEIPT() })
  const r = await s.settle({
    resolveSettlement: async (tx: string, res: Partial<X402SettlementRecord>) => {
      // The sweep got there first, so this write finds no ambiguous row.
      await s.log.resolveSettlement(tx, { outcome: 'settled', reconciledAt: NOW.toISOString(), blockNumber: res.blockNumber })
      return s.log.resolveSettlement(tx, res)
    },
  })
  assert.equal(r.success, true, JSON.stringify(r))
  assert.equal(s.log.rows.length, 1, 'the row is not written twice')
  assert.ok(s.log.rows[0].redeemedAt)
  assert.equal(s.spent.length, 1)
})

test('the first attempt ends well inside the proxy budget, and a late receipt is a retry away', async () => {
  // vercel.json cuts /api at about 30 seconds. A wait past that serves into a dead socket.
  assert.ok(FIRST_ATTEMPT_CEILING_MS <= 20_000)
  const s = await paymentScene('4d', { [HOST_A]: null })
  let clock = 0
  const slept: number[] = []
  const r = await s.settle({
    timeoutMs: undefined,
    receipts: {
      ...s.fake.receipts,
      now: () => clock,
      sleep: async (ms: number) => { slept.push(ms); clock += ms },
    },
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'receipt_timeout')
  assert.ok(clock > 0, 'it did wait')
  assert.ok(clock <= FIRST_ATTEMPT_CEILING_MS, `the wait took ${clock} ms`)
})

// ── the proof read's sweep ───────────────────────────────────────────────────────────

test('the sweep resolves ambiguous rows, and a settled one still waits for the buyer', async () => {
  const s = await paymentScene('30', { [HOST_A]: null, [HOST_B]: null })
  await s.settle()
  s.chainState.authorizationState = true

  // Nothing yet: it reads, and the row stays as it was.
  assert.deepEqual(await reconcileAmbiguousSettlements(s.engineDeps()), { checked: 1, settled: 0, reverted: 0, dropped: 0, ambiguous: 1 })
  assert.equal(s.log.rows[0].outcome, 'ambiguous')

  s.hosts[HOST_B] = SETTLED_RECEIPT()
  assert.deepEqual(await reconcileAmbiguousSettlements(s.engineDeps()), { checked: 1, settled: 1, reverted: 0, dropped: 0, ambiguous: 0 })
  assert.equal(s.log.rows[0].outcome, 'settled')
  assert.equal(s.spent.length, 0, 'a page load must not use up the call the buyer paid for')
  assert.equal(s.log.rows[0].redeemedAt, undefined)

  // Nothing left to read.
  assert.deepEqual(await reconcileAmbiguousSettlements(s.engineDeps()), { checked: 0, settled: 0, reverted: 0, dropped: 0, ambiguous: 0 })

  const retry = await s.settle()
  assert.equal(retry.success, true, JSON.stringify(retry))
  assert.equal(s.counters.broadcasts, 1)
  assert.equal(s.spent.length, 1)
})

test('the sweep is bounded, takes the newest rows, and an unreadable log costs it nothing', async () => {
  const s = await paymentScene('31', { [HOST_A]: null })
  for (let i = 0; i < 4; i++) {
    await s.log.persist({ ...baseRow(), outcome: 'ambiguous', tx: `0x${String(i).repeat(64)}` })
  }
  await reconcileAmbiguousSettlements(s.engineDeps(), 2)
  assert.equal(s.fake.asked.length, 2)
  assert.deepEqual(
    await reconcileAmbiguousSettlements(s.engineDeps({ loadSettlements: async () => ({ ok: false as const, reason: 'no' }) })),
    { checked: 0, settled: 0, reverted: 0, dropped: 0, ambiguous: 0 },
  )
})

test('a row on a chain this build has no EVM adapter for stays ambiguous', async () => {
  const s = await paymentScene('32', { [HOST_A]: SETTLED_RECEIPT() })
  await s.log.persist({ ...baseRow(), network: 'eip155:999999999', outcome: 'ambiguous', tx: `0x${'9'.repeat(64)}` })
  assert.deepEqual(await reconcileAmbiguousSettlements(s.engineDeps()), { checked: 1, settled: 0, reverted: 0, dropped: 0, ambiguous: 1 })
  assert.deepEqual(s.fake.asked, [])
})

test('a malformed row cannot throw out of a reconcile', async () => {
  const s = await paymentScene('33', { [HOST_A]: SETTLED_RECEIPT() })
  const out = await reconcileSettlementRow(chain, { ...baseRow(), outcome: 'ambiguous', tx: `0x${'9'.repeat(64)}`, value: 'not-a-number' }, s.engineDeps())
  assert.equal(out.outcome, 'ambiguous')
  const noHash = await reconcileSettlementRow(chain, { ...baseRow(), outcome: 'ambiguous' }, s.engineDeps())
  assert.equal(noHash.outcome, 'ambiguous')
})

function baseRow(): X402SettlementRecord {
  return {
    ts: NOW.toISOString(), outcome: 'ambiguous', tool: 'risk_check', resource: REQUIREMENTS.resource, network: chain.caip2,
    asset: token.address, assetSymbol: 'USDG', assetDecimals: 6, value: '21000', amountUsd: 0.021, baseUsd: 0.005, feeUsd: 0.016,
    payer: buyer.address, payTo: PAY_TO, authNonce: `0x${'99'.repeat(32)}`,
  }
}

// ── the settled row outlives a failed replay key ─────────────────────────────────────

test('persistSpent throwing after the transaction mined keeps the settled row and reports the failure', async () => {
  const s = await paymentScene('34', { [HOST_A]: SETTLED_RECEIPT() })
  const r = await s.settle({ persistSpent: async () => { throw new Error('database is gone') } })
  assert.equal(r.success, true, 'the money moved: this call is settled whatever the replay key does')
  if (r.success) {
    assert.match(r.replayKeyWarning ?? '', /could not be written/)
    assert.doesNotMatch(r.replayKeyWarning ?? '', /database is gone/)
  }
  assert.equal(s.log.rows.length, 1)
  assert.equal(s.log.rows[0].outcome, 'settled')

  // Replay stays blocked by the token, and a call that was served is not owed a second one.
  s.chainState.authorizationState = true
  await markSettlementServed(s.hash, CLAIM, s.engineDeps())
  const replay = await s.settle()
  assert.equal(replay.success, false)
  if (!replay.success) assert.equal(replay.code, 'already_redeemed')
  assert.equal(s.counters.broadcasts, 1)
})

test('a bare /settle that loses the race with a proof read cannot be answered as a success twice', async () => {
  const s = await paymentScene('6c', { [HOST_A]: SETTLED_RECEIPT() })
  const claims: { servedAt?: string }[] = []
  const r = await s.settle({
    requestHash: undefined,
    meta: undefined,
    resolveSettlement: async (tx: string, res: Partial<X402SettlementRecord>) => {
      if (res.outcome === 'dropped') return { ok: true as const, updated: false }
      // A public proof read resolved the row while this call waited.
      const moved = patchX402Rows(s.log.rows, tx.toLowerCase(), { outcome: 'settled', reconciledAt: NOW.toISOString(), blockNumber: '9' }, (x) => x.outcome === 'ambiguous')
      assert.equal(moved, true)
      return { ok: true as const, updated: false }
    },
    redeemSettlement: async (tx: string, at: string, opts: { staleBefore: string; servedAt?: string }) => {
      claims.push({ servedAt: opts.servedAt })
      return s.log.redeemSettlement(tx, at, opts)
    },
  })
  assert.equal(r.success, true, JSON.stringify(r))
  assert.deepEqual(claims, [{ servedAt: NOW.toISOString() }], 'the claim says served: a bare /settle has nothing else to serve')
  assert.equal(s.log.rows[0].servedAt, NOW.toISOString())

  // Anyone re-presenting the public calldata, past the lease: the answer was given, and the row says so.
  s.chainState.authorizationState = true
  const again = await s.settle({
    requestHash: undefined,
    meta: undefined,
    now: () => new Date(NOW.getTime() + 121_000),
  })
  assert.equal(again.success, false)
  if (!again.success) assert.equal(again.code, 'already_redeemed')
})

test('a claim that has expired cannot end the newer claim that replaced it', async () => {
  const s = await paymentScene('6d', { [HOST_A]: SETTLED_RECEIPT() })
  const r = await s.settle()
  assert.equal(r.success, true)
  // The first attempt's tool outlives the lease, and a retry takes the call.
  const later = new Date(NOW.getTime() + 121_000)
  s.chainState.authorizationState = true
  const retry = await s.settle({ now: () => later })
  assert.equal(retry.success, true, JSON.stringify(retry))
  const newClaim = s.log.rows[0].redeemedAt!
  assert.equal(newClaim, later.toISOString())

  // The slow first attempt finally writes its response. It holds no claim any more.
  assert.equal(await markSettlementServed(s.hash, CLAIM, s.engineDeps()), false)
  assert.equal(s.log.rows[0].servedAt, undefined, 'the newer attempt can still give the call back')
  assert.equal(await markSettlementServed(s.hash, newClaim, s.engineDeps()), true)
  assert.ok(s.log.rows[0].servedAt)
})

test('a row from before the request was recorded gets an honest answer that names its transaction', async () => {
  const s = await paymentScene('6e', { [HOST_A]: SETTLED_RECEIPT() })
  const tx = `0x${'6e'.repeat(32)}`
  await s.log.persist({ ...baseRow(), outcome: 'ambiguous', tx, authNonce: s.authorization.nonce })
  assert.equal(s.log.rows[0].requestHash, undefined)
  s.chainState.authorizationState = true
  const r = await s.settle()
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'already_redeemed')
    assert.equal(r.transaction, tx)
    assert.ok(r.errorReason.includes(tx))
    assert.match(r.errorReason, /before this server recorded which request/)
    assert.match(r.errorReason, /whether its call was served is not on record/)
    assert.doesNotMatch(r.errorReason, /already been redeemed/)
  }
  assert.equal(s.counters.broadcasts, 0)
})

test('with a working replay key, the settled row is still written first', async () => {
  const s = await paymentScene('35', { [HOST_A]: SETTLED_RECEIPT() })
  const order: string[] = []
  const r = await s.settle({
    persist: async (rec: X402SettlementRecord) => { order.push(`row:${rec.outcome}`) },
    resolveSettlement: async (_tx: string, res: Partial<X402SettlementRecord>) => {
      order.push(`row:${res.outcome}`)
      return { ok: true as const, updated: true }
    },
    persistSpent: async () => { order.push('spent') },
  })
  assert.equal(r.success, true)
  assert.deepEqual(order, ['row:ambiguous', 'row:settled', 'spent'])
})

// ── the two conditional updates on the log ───────────────────────────────────────────

function fakePool(rowCount: number) {
  const queries: { sql: string; params?: unknown[] }[] = []
  return {
    queries,
    getPool: async () => ({
      query: async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params })
        return { rowCount }
      },
    }),
  }
}

test('(producer) a resolution only ever touches a row still ambiguous, keyed by the lower-cased hash', async () => {
  const pool = fakePool(1)
  const tx = `0x${'AB'.repeat(32)}`
  const out = await resolveX402Settlement(tx, { outcome: 'settled', reconciledAt: NOW.toISOString() }, pool.getPool)
  assert.deepEqual(out, { ok: true, updated: true })
  const update = pool.queries.find((q) => q.sql.startsWith('UPDATE'))!
  assert.match(update.sql, /lower\(data->>'tx'\) = \$1/)
  assert.match(update.sql, /data->>'outcome' = 'ambiguous'/)
  assert.equal(update.params?.[0], tx.toLowerCase())
  assert.deepEqual(await resolveX402Settlement(tx, { outcome: 'settled', reconciledAt: 'x' }, fakePool(0).getPool), { ok: true, updated: false })
})

test('(producer) a redemption is a claim on one unserved row, and a dead database is not a claim', async () => {
  const pool = fakePool(1)
  assert.deepEqual(await redeemX402Settlement(`0x${'ab'.repeat(32)}`, 'now', { staleBefore: 'then' }, pool.getPool), { ok: true, updated: true })
  const update = pool.queries.find((q) => q.sql.startsWith('UPDATE'))!
  assert.match(update.sql, /data->>'outcome' = 'settled'/)
  assert.match(update.sql, /NOT data \? 'servedAt'/)
  assert.match(update.sql, /NOT data \? 'redeemedAt' OR data->>'redeemedAt' < \$3/)
  assert.equal(update.params?.[2], 'then')
  const dead = await redeemX402Settlement(`0x${'ab'.repeat(32)}`, 'now', { staleBefore: 'then' }, async () => { throw new Error('ECONNREFUSED') })
  assert.equal(dead.ok, false)
})

test('(producer) a release frees only its own claim on an unserved row, and serving ends the claim', async () => {
  const pool = fakePool(1)
  assert.deepEqual(await releaseX402SettlementClaim(`0x${'AB'.repeat(32)}`, 'claimed', pool.getPool), { ok: true, updated: true })
  const release = pool.queries.find((q) => q.sql.startsWith('UPDATE'))!
  assert.match(release.sql, /data - 'redeemedAt'/)
  assert.match(release.sql, /NOT data \? 'servedAt'/)
  assert.match(release.sql, /data->>'redeemedAt' = \$2/)
  assert.deepEqual(release.params, [`0x${'ab'.repeat(32)}`, 'claimed'])
  const served = fakePool(1)
  assert.deepEqual(await markX402SettlementServed(`0x${'ab'.repeat(32)}`, 'now', 'claimed', served.getPool), { ok: true, updated: true })
  const mark = served.queries.find((q) => q.sql.startsWith('UPDATE'))!
  assert.match(mark.sql, /NOT data \? 'servedAt'/)
  assert.match(mark.sql, /data->>'redeemedAt' = \$3/, 'only the claim that served it can end it')
  assert.equal(mark.params?.[2], 'claimed')
})

test('(producer) a trim that fails after the INSERT is not a failed write', async () => {
  const queries: string[] = []
  const out = await persistX402Settlement(baseRow(), async () => ({
    query: async (sql: string) => {
      queries.push(sql)
      if (sql.startsWith('DELETE')) throw new Error('lock timeout')
      return { rowCount: 1 }
    },
  }))
  assert.deepEqual(out, { ok: true }, 'the row is there, so the engine must not write it twice')
  assert.ok(queries.some((q) => q.startsWith('INSERT')))
  // An INSERT that fails is still reported.
  const failed = await persistX402Settlement(baseRow(), async () => ({
    query: async (sql: string) => {
      if (sql.startsWith('INSERT')) throw new Error('disk full')
      return { rowCount: 0 }
    },
  }))
  assert.equal(failed.ok, false)
})

test('(producer) the durable save writes this snapshot, reports a failure, and an earlier failure cannot read as success', async () => {
  const written: string[] = []
  const pool = (fail: boolean) => async () => ({
    query: async (sql: string, params?: unknown[]) => {
      if (fail) throw new Error('connection reset')
      assert.match(sql, /INSERT INTO app_state/)
      written.push(String(params?.[1]))
      return { rowCount: 1 }
    },
  })
  assert.deepEqual(await flushStateDurably({ a: 1 }, pool(false)), { ok: true })
  assert.deepEqual(written, ['{"a":1}'])
  const failed = await flushStateDurably({ a: 2 }, pool(true))
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.match(failed.reason, /connection reset/)
  // A stalled database is a failed save, not a payment waiting forever.
  const stalled = await flushStateDurably({ a: 3 }, async () => new Promise<never>(() => {}), 1)
  assert.equal(stalled.ok, false)
})

test('(producer) a settlement write that fails is reported, so nothing promises a read-back of it', async () => {
  const out = await persistX402Settlement(baseRow(), async () => { throw new Error('ECONNREFUSED') })
  assert.equal(out.ok, false)
  const written = await persistX402Settlement(baseRow(), fakePool(1).getPool)
  assert.deepEqual(written, { ok: true })
})

test('the file log follows the same rule: a settled row cannot be rewritten', () => {
  const tx = `0x${'ab'.repeat(32)}`
  const settled: X402SettlementRecord = { ...baseRow(), outcome: 'settled', tx }
  const ambiguous: X402SettlementRecord = { ...baseRow(), outcome: 'ambiguous', tx: tx.toUpperCase().replace('0X', '0x') }
  const rows = [settled, ambiguous]
  assert.equal(patchX402Rows(rows, tx, { outcome: 'reverted' }, (r) => r.outcome === 'ambiguous'), true)
  assert.equal(settled.outcome, 'settled')
  assert.equal(ambiguous.outcome, 'reverted')
  assert.equal(patchX402Rows(rows, tx, { outcome: 'settled' }, (r) => r.outcome === 'ambiguous'), false)
})

test('settling with no signer is a clean labeled refusal, not a crash', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'07'.repeat(32)}` })
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({ publicClient: publicClient({}), persist: async () => {}, persistSpent: async () => {}, gasSpentTodayWei: async () => 0n }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'no_signer')
})

// ── the gas ledger the daily budget is computed from ─────────────────────────────────
//
// The EVM twin of the F-05 tests in x402-stellar/settle.test.ts, and it is here for the
// reason that finding gave: `gasSpentOnDay` used to read an unreachable database as
// "nothing spent today", which turned the daily gas ceiling off completely. The Stellar
// side was fixed first and got a negative control; this side was fixed with none, so the
// exact regression the control exists to catch was undefended here.
//
// Note the split, which is the lesson from F-05: the injected-loader tests prove the
// CONSUMER handles an `ok: false`, and prove nothing about whether anything emits one.
// The producer tests call the real loader with a failing pool, so the classification under
// test is the one that runs in production.

test('an unreadable gas ledger spends the daily budget, it does not zero it', async () => {
  const unreadable = async () => ({ ok: false as const, reason: 'ECONNREFUSED 10.0.0.1:5432' })
  assert.equal(
    await gasSpentOnDay('2026-08-25', unreadable),
    GAS_BUDGET_UNKNOWN,
    'a ledger we cannot read must report the budget as spent. Returning 0 here is what let ' +
      'an unreachable database turn the daily gas ceiling off entirely.',
  )
})

test('a gas ledger loader that throws is still "we cannot read it"', async () => {
  const boom = async () => { throw new Error('socket hang up') }
  assert.equal(await gasSpentOnDay('2026-08-25', boom), GAS_BUDGET_UNKNOWN)
})

test('an empty gas ledger is genuinely zero, and is not confused with an unreadable one', async () => {
  assert.equal(await gasSpentOnDay('2026-08-25', async () => ({ ok: true as const, rows: [] })), 0n)
})

test('gas is summed for this day only, and one malformed row does not break the guard', async () => {
  const rows = [
    { ts: '2026-08-25T01:00:00Z', gasWei: '100' },
    { ts: '2026-08-25T23:00:00Z', gasWei: '250' },
    { ts: '2026-08-24T23:59:59Z', gasWei: '8888' },
    { ts: '2026-08-25T03:00:00Z', gasWei: 'not-a-number' },
  ] as unknown as X402SettlementRecord[]
  assert.equal(await gasSpentOnDay('2026-08-25', async () => ({ ok: true as const, rows })), 350n)
})

test('the daily gas ledger is per network, because wei of ether and wei of USDC are not one unit', async () => {
  const rows = [
    { ts: '2026-09-16T01:00:00Z', network: 'eip155:8453', gasWei: '600000000000' },
    { ts: '2026-09-16T02:00:00Z', network: 'eip155:5042', gasWei: '25808110704255246' },
    { ts: '2026-09-16T03:00:00Z', network: 'eip155:8453', gasWei: '400000000000' },
  ] as unknown as X402SettlementRecord[]
  const load = async () => ({ ok: true as const, rows })
  assert.equal(await gasSpentOnDay('2026-09-16', load, 'eip155:8453'), 1_000_000_000_000n)
  assert.equal(await gasSpentOnDay('2026-09-16', load, 'eip155:5042'), 25_808_110_704_255_246n)
  // No network keeps the old total, which is only a measure of activity.
  assert.equal(await gasSpentOnDay('2026-09-16', load), 25_809_110_704_255_246n)
})

test('(producer) a database that will not answer is reported unreadable, not empty', async () => {
  const boom = async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })
  }
  const r = await loadX402SettlementsResult(boom)
  assert.equal(r.ok, false, 'an unreachable database must not read as an empty gas ledger')
  if (!r.ok) assert.match(r.reason, /ECONNREFUSED/)
})

test('(producer) an unreadable ledger makes the real gas guard report the budget spent', async () => {
  const boom = async () => { throw new Error('connect ETIMEDOUT') }
  assert.equal(await gasSpentOnDay('2026-08-25', () => loadX402SettlementsResult(boom)), GAS_BUDGET_UNKNOWN)
})

test('(producer) no configured database is empty, not unreadable', async () => {
  // A first run with no DATABASE_URL and no settlements file is genuinely zero spend.
  // Conflating that with a read failure would fail closed forever on a fresh deploy.
  const r = await loadX402SettlementsResult(async () => null)
  assert.equal(r.ok, true, 'an unconfigured database with no file is a first run, not a failure')
})

test('an unreadable gas ledger refuses the settlement and broadcasts nothing', async () => {
  // The end-to-end statement the ceiling actually depends on. The refusal carries its own
  // reason rather than rendering the sentinel as a spent figure, so an operator can tell a
  // database outage from a budget that is genuinely gone.
  clearDomainCache()
  let broadcasts = 0
  const { payload } = await signed({ nonce: `0x${'0a'.repeat(32)}` })
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({}),
      walletClient: fakeSigningWallet('0x02ff', { onSend: () => { broadcasts += 1 } }),
      signerAddress: PAY_TO,
      persist: async () => {},
      persistSpent: async () => {},
      gasSpentTodayWei: async () => GAS_BUDGET_UNKNOWN,
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) {
    assert.equal(r.code, 'gas_budget_exhausted')
    assert.match(r.errorReason ?? '', /could not be read/, 'an outage must not read as a spent budget')
  }
  assert.equal(broadcasts, 0, 'nothing may be broadcast against a ceiling we cannot measure')
})

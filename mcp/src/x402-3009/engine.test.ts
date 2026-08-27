import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import { paymentKey, parseAuthorizationPayload, verifyPayment, settlePayment, type Limits } from './engine.js'
import { eip712DomainSeparator, clearDomainCache, type TokenReader } from './domain.js'
import { getChainById } from '../chains/index.js'
import { gasSpentOnDay, loadX402SettlementsResult, GAS_BUDGET_UNKNOWN, type X402SettlementRecord } from '../storage.js'

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

const NOW = new Date('2026-08-13T12:00:00.000Z')
const nowSec = Math.floor(NOW.getTime() / 1000)

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
    waitForTransactionReceipt: async () => {
      if (state.receiptThrows) throw new Error(state.receiptThrows)
      return state.receipt ?? { status: 'success', blockNumber: 1n, gasUsed: 85_000n, logs: [] }
    },
  }
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
  return {
    reader: tokenReader(),
    now: () => NOW,
    loadSpent: async () => [] as string[],
    env: {} as NodeJS.ProcessEnv,
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
  const recorded: X402SettlementRecord[] = []
  let spentWrites = 0
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({ receipt: { status: 'reverted', blockNumber: 7n, gasUsed: 85_000n, logs: [] } }),
      walletClient: { writeContract: async () => `0x${'aa'.repeat(32)}` },
      signerAddress: PAY_TO,
      persist: async (rec: X402SettlementRecord) => { recorded.push(rec) },
      persistSpent: async () => { spentWrites += 1 },
      gasSpentTodayWei: async () => 0n,
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'receipt_reverted')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].outcome, 'reverted')
  assert.ok(recorded.every((x) => x.outcome !== 'settled'))
  // A failed settlement must not consume the buyer's authorization on our side.
  assert.equal(spentWrites, 0)
})

test('a successful receipt with no matching Transfer log is not a settlement', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'02'.repeat(32)}` })
  const recorded: X402SettlementRecord[] = []
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({ receipt: { status: 'success', blockNumber: 8n, gasUsed: 85_000n, logs: [] } }),
      walletClient: { writeContract: async () => `0x${'bb'.repeat(32)}` },
      signerAddress: PAY_TO,
      persist: async (rec: X402SettlementRecord) => { recorded.push(rec) },
      persistSpent: async () => {},
      gasSpentTodayWei: async () => 0n,
    }),
  })
  assert.equal(r.success, false)
  if (!r.success) assert.equal(r.code, 'no_transfer_log')
  assert.equal(recorded[0].outcome, 'reverted')
})

test('a receipt with a matching Transfer log settles and records the asset', async () => {
  clearDomainCache()
  const { payload } = await signed({ nonce: `0x${'03'.repeat(32)}` })
  const recorded: X402SettlementRecord[] = []
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
      walletClient: { writeContract: async () => `0x${'cc'.repeat(32)}` },
      signerAddress: PAY_TO,
      persist: async (rec: X402SettlementRecord) => { recorded.push(rec) },
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
  assert.equal(recorded[0].outcome, 'settled')
  assert.equal(recorded[0].asset, token.address)
  assert.equal(recorded[0].assetDecimals, 6)
  assert.equal(recorded[0].amountUsd, 0.021)
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
      walletClient: { writeContract: async () => { broadcasts += 1; return `0x${'dd'.repeat(32)}` } },
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
  const wallet = { writeContract: async () => { broadcasts += 1; return `0x${'ee'.repeat(32)}` } }

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
  const recorded: X402SettlementRecord[] = []
  let spentWrites = 0
  const r = await settlePayment({
    chain, token, requirements: REQUIREMENTS, payload, limits: LIMITS,
    deps: deps({
      publicClient: publicClient({ receiptThrows: 'timed out' }),
      walletClient: { writeContract: async () => `0x${'ff'.repeat(32)}` },
      signerAddress: PAY_TO,
      persist: async (rec: X402SettlementRecord) => { recorded.push(rec) },
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
  assert.equal(recorded[0].outcome, 'ambiguous')
  assert.ok(recorded[0].authNonce)
  assert.equal(spentWrites, 0)
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
      walletClient: { writeContract: async () => { broadcasts += 1; return `0x${'ff'.repeat(32)}` } },
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

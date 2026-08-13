import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import { supported, verify, settle, resolveNetwork, facilitatorChains } from './facilitator.js'
import { railStatus } from './rail.js'
import { eip712DomainSeparator, clearDomainCache, type TokenReader } from './domain.js'
import { getChainById } from '../chains/index.js'

const chain = getChainById('rhchain')!
const token = chain.settlementTokens![0]
const PAY_TO = '0x000000000000000000000000000000000000dEaD'
const OTHER_PAYTO = '0x1111111111111111111111111111111111111111'
const DOMAIN = { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: token.address as `0x${string}` }
const SEPARATOR = eip712DomainSeparator(DOMAIN)
const buyer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
} as const

const NOW = new Date('2026-08-13T12:00:00.000Z')
const env = { X402_3009_NETWORK: chain.caip2, X402_3009_PAYTO: PAY_TO } as NodeJS.ProcessEnv

function reader(over: Partial<Record<string, unknown>> = {}): TokenReader {
  const answers: Record<string, unknown> = {
    DOMAIN_SEPARATOR: SEPARATOR, name: 'Global Dollar', symbol: 'USDG', decimals: 6, authorizationState: false, ...over,
  }
  return async (fn) => {
    if (!(fn in answers)) throw new Error(`${fn} reverted`)
    return answers[fn]
  }
}

function publicClient(writes: { count: number }) {
  return {
    readContract: async (args: Record<string, unknown>) =>
      args.functionName === 'authorizationState' ? false : 10_000_000n,
    simulateContract: async () => ({ request: {} }),
    estimateContractGas: async () => 85_000n,
    getGasPrice: async () => 50_578_000n,
    waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n, gasUsed: 85_000n, logs: [] }),
    _writes: writes,
  }
}

async function body(payTo = PAY_TO) {
  const authorization = {
    from: buyer.address, to: payTo as `0x${string}`, value: 25_000n,
    validAfter: 0n, validBefore: BigInt(Math.floor(NOW.getTime() / 1000) + 600),
    nonce: `0x${'ab'.repeat(32)}` as `0x${string}`,
  }
  const signature = await buyer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'TransferWithAuthorization', message: authorization })
  return {
    x402Version: 2,
    paymentRequirements: {
      scheme: 'exact', network: chain.caip2, asset: token.address, payTo,
      maxAmountRequired: '25000', resource: '/api/facilitator/settle',
    },
    paymentPayload: {
      x402Version: 2, scheme: 'exact', network: chain.caip2,
      payload: {
        signature,
        authorization: {
          from: authorization.from, to: authorization.to, value: '25000',
          validAfter: '0', validBefore: authorization.validBefore.toString(), nonce: authorization.nonce,
        },
      },
    },
  }
}

test('both x402 network spellings resolve, and an unknown one does not', () => {
  assert.equal(resolveNetwork('eip155:4663')?.id, 'rhchain')
  assert.equal(resolveNetwork('rhchain')?.id, 'rhchain')
  assert.equal(resolveNetwork('robinhood'), null)
  assert.equal(resolveNetwork(''), null)
})

test('the facilitator serves exactly the chains that declare an EIP-3009 token', () => {
  const ids = facilitatorChains({} as NodeJS.ProcessEnv).map((c) => c.id).sort()
  assert.deepEqual(ids, ['rhchain', 'rhchain-testnet'])
})

test('/supported publishes both wire versions with the proven domain', async () => {
  clearDomainCache()
  const out = await supported(railStatus(env), { reader: reader(), env })
  assert.equal(out.httpStatus, 200)
  const kinds = out.body.kinds as Record<string, unknown>[]
  const v2 = kinds.find((k) => k.x402Version === 2 && k.network === chain.caip2)
  const v1 = kinds.find((k) => k.x402Version === 1 && k.network === 'rhchain')
  assert.ok(v2, 'a v2 CAIP-2 kind must be published')
  assert.ok(v1, 'a v1 slug kind must be published for older clients')
  const extra = v2!.extra as Record<string, unknown>
  assert.equal(extra.domainVerified, true)
  assert.equal(String(extra.domainSeparator).toLowerCase(), SEPARATOR.toLowerCase())
  assert.equal((out.body.facilitator as Record<string, unknown>).selfHosted, true)
})

test('a chain whose domain cannot be proven is reported unavailable, never advertised', async () => {
  clearDomainCache()
  const out = await supported(railStatus(env), { reader: reader({ DOMAIN_SEPARATOR: `0x${'99'.repeat(32)}` }), env })
  assert.deepEqual(out.body.kinds, [])
  const unavailable = out.body.unavailable as { network: string; reason: string }[]
  assert.ok(unavailable.length >= 1)
  assert.match(unavailable[0].reason, /DOMAIN_SEPARATOR/)
})

test('/verify answers the documented shape and performs no writes', async () => {
  clearDomainCache()
  const writes = { count: 0 }
  const out = await verify(await body(), { reader: reader(), publicClient: publicClient(writes), now: () => NOW, loadSpent: async () => [], env })
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.isValid, true)
  assert.equal(String(out.body.payer).toLowerCase(), buyer.address.toLowerCase())
  assert.equal(writes.count, 0)
})

test('/verify reports an invalid payment without throwing', async () => {
  clearDomainCache()
  const b = await body()
  ;(b.paymentPayload.payload as Record<string, unknown>).signature = `0x${'11'.repeat(65)}`
  const out = await verify(b, { reader: reader(), publicClient: publicClient({ count: 0 }), now: () => NOW, loadSpent: async () => [], env })
  assert.equal(out.httpStatus, 200)
  assert.equal(out.body.isValid, false)
  assert.equal(out.body.code, 'bad_signature')
})

test('/verify rejects a body that names an unknown network', async () => {
  const out = await verify({ paymentRequirements: { network: 'nope', asset: token.address, payTo: PAY_TO }, paymentPayload: {} }, { env })
  assert.equal(out.httpStatus, 400)
  assert.equal(out.body.code, 'unsupported_network')
})

test('/settle refuses an off-allowlist payTo with zero broadcasts', async () => {
  clearDomainCache()
  let broadcasts = 0
  const out = await settle(await body(OTHER_PAYTO), {
    reader: reader(),
    publicClient: publicClient({ count: 0 }),
    walletClient: { writeContract: async () => { broadcasts += 1; return `0x${'aa'.repeat(32)}` } },
    now: () => NOW, loadSpent: async () => [], env,
  })
  assert.equal(out.httpStatus, 403)
  assert.equal(out.body.code, 'payto_not_allowlisted')
  assert.equal(broadcasts, 0)
  // The refusal must say where the open door is, so the endpoint stays useful.
  assert.match(String(out.body.note), /\/verify/)
})

test('/settle accepts an allowlisted third-party payTo when it is configured', async () => {
  clearDomainCache()
  const withAllow = { ...env, X402_3009_ALLOWED_PAYTO: OTHER_PAYTO } as NodeJS.ProcessEnv
  const out = await settle(await body(OTHER_PAYTO), {
    reader: reader(),
    publicClient: publicClient({ count: 0 }),
    walletClient: { writeContract: async () => `0x${'bb'.repeat(32)}` },
    signerAddress: PAY_TO as `0x${string}`,
    now: () => NOW, loadSpent: async () => [], persist: async () => {}, persistSpent: async () => {},
    gasSpentTodayWei: async () => 0n,
    env: withAllow,
  })
  // The receipt in this stub carries no Transfer log, so it must NOT report success.
  // What matters here is that the allowlist let it through to the engine at all.
  assert.notEqual(out.httpStatus, 403)
  assert.equal(out.body.success, false)
  assert.equal(out.body.code, 'no_transfer_log')
})

test('/settle is 501 when the rail is unconfigured', async () => {
  const out = await settle(await body(), { env: {} as NodeJS.ProcessEnv })
  assert.equal(out.httpStatus, 501)
  assert.equal(out.body.success, false)
})

test('an exhausted daily gas budget answers 503 and broadcasts nothing', async () => {
  clearDomainCache()
  let broadcasts = 0
  const out = await settle(await body(), {
    reader: reader(),
    publicClient: publicClient({ count: 0 }),
    walletClient: { writeContract: async () => { broadcasts += 1; return `0x${'cc'.repeat(32)}` } },
    signerAddress: PAY_TO as `0x${string}`,
    now: () => NOW, loadSpent: async () => [], persist: async () => {}, persistSpent: async () => {},
    gasSpentTodayWei: async () => 500_000_000_000_000n,
    env,
  })
  assert.equal(out.httpStatus, 503)
  assert.equal(out.body.code, 'gas_budget_exhausted')
  assert.equal(broadcasts, 0)
})

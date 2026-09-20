/**
 * The Soroswap read path, tested against a STUBBED simulator rather than the network.
 *
 * The live proof that the encoding is right lives in the registry's `verified` note: the
 * router answered router_get_amounts_out(10000000, [USDC, XLM]) with ["10000000","94345893"]
 * on 2026-09-20, and the same call through this module returned the same number. What these
 * tests own instead is every way the call can go wrong, because those are the paths a live
 * check never exercises: a chain with no router, a pair with no pool, an answer that is not
 * an amounts array. Each one must read as a labeled unavailable rather than as a throw.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { nativeToScVal, rpc } from '@stellar/stellar-sdk'

import { getChainById } from './chains/registry.js'
import { AMOUNTS_OUT, SOROSWAP_CAVEATS, TESTNET_CAVEAT, soroswapQuote, soroswapRouter } from './soroswap.js'
import type { SoroswapDeps } from './soroswap.js'

const TESTNET = getChainById('stellar-testnet')!
const PUBNET = getChainById('stellar')!
const USDC = TESTNET.settlementTokens![0].address
const XLM = TESTNET.contracts!.nativeSac!

/** A simulator that answers each method from a table, so a test says what the chain said. */
function stub(answers: Record<string, unknown>): SoroswapDeps {
  return {
    now: () => new Date('2026-09-20T00:00:00.000Z'),
    server: () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      simulateTransaction: async (tx: any) => {
        const fn: string = tx.operations[0].func.invokeContract().functionName().toString()
        const a = answers[fn]
        if (a === undefined) return { error: `no stub for ${fn}` } as unknown as rpc.Api.SimulateTransactionResponse
        if (a instanceof Error) return { error: a.message } as unknown as rpc.Api.SimulateTransactionResponse
        return { result: { retval: nativeToScVal(a) } } as unknown as rpc.Api.SimulateTransactionResponse
      },
    }),
  }
}

const HAPPY = () =>
  stub({
    [AMOUNTS_OUT]: [nativeToScVal(10000000n, { type: 'i128' }), nativeToScVal(94345893n, { type: 'i128' })],
    get_factory: nativeToScVal(TESTNET.contracts!.soroswap ? 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY' : '', { type: 'address' }),
    router_pair_for: nativeToScVal('CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS', { type: 'address' }),
  })

test('the router is read from the registry, and a chain without one says so', () => {
  assert.equal(soroswapRouter(TESTNET), 'CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD')
  // Pubnet records no Soroswap router on purpose: nothing here has been exercised with
  // real money, and a router in the registry is a claim that it has.
  assert.equal(soroswapRouter(PUBNET), null)
})

test('a chain with no router is unavailable, not an exception', async () => {
  const q = await soroswapQuote({ chain: PUBNET, sellAsset: USDC, buyAsset: XLM, sellAmount: '1', deps: HAPPY() })
  assert.equal(q.available, false)
  if (!q.available) assert.match(q.reason, /records no Soroswap router/)
})

test('a quote carries the last leg, and is labeled live AND a quote', async () => {
  const q = await soroswapQuote({ chain: TESTNET, sellAsset: USDC, buyAsset: XLM, sellAmount: '10000000', deps: HAPPY() })
  assert.equal(q.available, true)
  if (!q.available) return
  assert.equal(q.status, 'live')
  assert.equal(q.kind, 'quote')
  assert.equal(q.buy.amount, '94345893')
  assert.equal(q.sell.amount, '10000000')
  assert.equal(q.network, 'stellar:testnet')
  // Derived out of the router in the same call, never stored beside it.
  assert.equal(q.factory, 'CDP3HMUH6SMS3S7NPGNDJLULCOXXEPSHY4JKUKMBNQMATHDHWXRRJTBY')
  assert.equal(q.pair, 'CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS')
  assert.equal(q.readAt, '2026-09-20T00:00:00.000Z')
})

test('a testnet quote always says the pool price is not a market price', async () => {
  const q = await soroswapQuote({ chain: TESTNET, sellAsset: USDC, buyAsset: XLM, sellAmount: '10000000', deps: HAPPY() })
  assert.equal(q.available, true)
  if (!q.available) return
  for (const c of SOROSWAP_CAVEATS) assert.ok(q.caveats.includes(c), `lost the caveat: ${c}`)
  assert.ok(q.caveats.includes(TESTNET_CAVEAT), 'a testnet quote must carry the testnet caveat')
})

test('a mainnet-shaped chain drops the testnet caveat and keeps the rest', async () => {
  const asPubnet = { ...TESTNET, caip2: 'stellar:pubnet' }
  const q = await soroswapQuote({ chain: asPubnet, sellAsset: USDC, buyAsset: XLM, sellAmount: '10000000', deps: HAPPY() })
  assert.equal(q.available, true)
  if (!q.available) return
  assert.equal(q.caveats.includes(TESTNET_CAVEAT), false)
  assert.equal(q.caveats.length, SOROSWAP_CAVEATS.length)
})

test('inputs that cannot be a swap are refused before the network is touched', async () => {
  const never: SoroswapDeps = {
    server: () => ({
      simulateTransaction: async () => {
        throw new Error('the network must not be reached for an input we can refuse ourselves')
      },
    }),
  }
  const bad: [string, string, string, RegExp][] = [
    ['GBMRWLL7FTWNQZFVWXTC3PCHHU4LJASDGWADDU4UXYCK2WF6SEJAN6TI', XLM, '1', /must both be Soroban contract ids/],
    [USDC, 'not-an-address', '1', /must both be Soroban contract ids/],
    [USDC, USDC, '1', /same contract/],
    [USDC, XLM, '1.5', /not an integer/],
    [USDC, XLM, '0', /above zero/],
    [USDC, XLM, '-1', /above zero/],
  ]
  for (const [sellAsset, buyAsset, sellAmount, re] of bad) {
    const q = await soroswapQuote({ chain: TESTNET, sellAsset, buyAsset, sellAmount, deps: never })
    assert.equal(q.available, false, `${sellAsset} -> ${buyAsset} @ ${sellAmount} must be refused`)
    if (!q.available) assert.match(q.reason, re)
  }
})

test('a pair with no pool is unavailable in the router own words, not a crash', async () => {
  const noPool = stub({ [AMOUNTS_OUT]: new Error('HostError: Error(Contract, #2)') })
  const q = await soroswapQuote({ chain: TESTNET, sellAsset: USDC, buyAsset: XLM, sellAmount: '10000000', deps: noPool })
  assert.equal(q.available, false)
  if (!q.available) {
    assert.match(q.reason, /could not quote this pair/)
    assert.match(q.reason, /Error\(Contract, #2\)/)
  }
})

test('an answer that is not a two-leg amounts array is refused rather than read as zero', async () => {
  for (const wrong of [[], [nativeToScVal(1n, { type: 'i128' })], 'nope']) {
    const q = await soroswapQuote({
      chain: TESTNET,
      sellAsset: USDC,
      buyAsset: XLM,
      sellAmount: '10000000',
      deps: stub({ [AMOUNTS_OUT]: wrong }),
    })
    assert.equal(q.available, false, `${JSON.stringify(wrong)} must not parse as a quote`)
    if (!q.available) assert.match(q.reason, /two-leg amounts array/)
  }
})

test('a derived id that cannot be read is null, and does not lose the quote', async () => {
  // get_factory and router_pair_for are conveniences. Losing one must not lose the price.
  const partial = stub({
    [AMOUNTS_OUT]: [nativeToScVal(10000000n, { type: 'i128' }), nativeToScVal(94345893n, { type: 'i128' })],
  })
  const q = await soroswapQuote({ chain: TESTNET, sellAsset: USDC, buyAsset: XLM, sellAmount: '10000000', deps: partial })
  assert.equal(q.available, true)
  if (!q.available) return
  assert.equal(q.buy.amount, '94345893')
  assert.equal(q.factory, null)
  assert.equal(q.pair, null)
})

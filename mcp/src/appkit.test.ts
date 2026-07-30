import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appKitCapabilities, quoteArcSwap, runArcSwapDemo, ARC_CHAIN } from './appkit.js'
import { ARC_CHAIN as ARC } from './chains/registry.js'

/**
 * These assert the two things the App Kit integration actually promises: that the Arc
 * capability strip is read from the SDK rather than typed by us, and that the write path
 * refuses to pretend when there is no signer.
 */

test('appKitCapabilities reports Arc Testnet with all four capabilities', async () => {
  const caps = await appKitCapabilities()
  assert.equal(caps.chain, ARC_CHAIN)
  assert.equal(caps.chainId, ARC.evmChainId)
  const names = caps.capabilities.map((c) => c.name)
  for (const n of ['Send', 'Bridge', 'Swap', 'Unified Balance']) assert.ok(names.includes(n), `missing ${n}`)
  assert.ok(caps.capabilities.every((c) => c.supported), 'every Arc capability should be supported')
})

test('Arc is the only testnet App Kit can swap on', async () => {
  const caps = await appKitCapabilities()
  // The whole reason the swap panel exists. If Circle ever adds another testnet this
  // fails loudly rather than leaving a stale claim on the landing page.
  assert.deepEqual(caps.swapTestnetsSupported, [ARC_CHAIN])
})

test('App Kit exposes a real EURC address on Arc', async () => {
  const caps = await appKitCapabilities()
  assert.match(caps.tokens.eurc ?? '', /^0x[0-9a-fA-F]{40}$/)
  assert.match(caps.tokens.usdc ?? '', /^0x[0-9a-fA-F]{40}$/)
  assert.notEqual(caps.tokens.eurc, caps.tokens.usdc)
})

test('swap refuses to execute without a signer key, and says why', async () => {
  const r = await runArcSwapDemo({ amountUsd: 1 }, {})
  assert.equal(r.executed, false)
  assert.equal(r.tokenIn, 'USDC')
  assert.equal(r.tokenOut, 'EURC')
  assert.match(r.reason ?? '', /ARC_SIGNER_KEY/)
})

test('swap clamps a nonsense amount rather than sending it on', async () => {
  const r = await runArcSwapDemo({ amountUsd: -5 }, {})
  assert.ok(r.amountUsd > 0)
})

test('quoteArcSwap answers without a key and never throws', async () => {
  const q = await quoteArcSwap({ amountUsd: 1 })
  assert.equal(q.tokenIn, 'USDC')
  assert.equal(q.tokenOut, 'EURC')
  // The rate service may be unreachable from CI; either way the shape is stable.
  assert.equal(typeof q.ok, 'boolean')
})

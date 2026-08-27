import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ARC_CHAIN } from './registry.js'
import { ARC_TESTNET } from '../arc.js'
import { ARC_RPC, ARC_EXPLORER, ARC_RPCS, CONTRACTS } from '../arc-contracts.js'

// After routing Arc through the generic adapter, these guard that the legacy Arc
// config (arc.ts, arc-contracts.ts) still agrees EXACTLY with the registry descriptor -
// so the rebind changed no on-chain behavior and the two config sources can't drift.

test('arc.ts ARC_TESTNET agrees with the registry descriptor', () => {
  assert.equal(ARC_TESTNET.id, ARC_CHAIN.evmChainId)
  assert.equal(ARC_TESTNET.caip2, ARC_CHAIN.caip2)
  assert.equal(ARC_TESTNET.explorer, ARC_CHAIN.explorer)
  assert.equal(ARC_TESTNET.rpc.primary, ARC_CHAIN.rpcUrls[0])
  assert.equal(ARC_TESTNET.erc20Decimals, ARC_CHAIN.usdcDecimals)
  assert.equal(ARC_TESTNET.nativeDecimals, ARC_CHAIN.nativeCurrency.decimals)
  assert.equal(ARC_TESTNET.nativeCurrency.symbol, ARC_CHAIN.nativeCurrency.symbol)
})

test('arc-contracts.ts config still matches the registry exactly', () => {
  assert.equal(ARC_RPC, ARC_CHAIN.rpcUrls[0])
  assert.equal(ARC_EXPLORER, ARC_CHAIN.explorer)
  assert.equal(ARC_RPCS[0], ARC_CHAIN.rpcUrls[0])
  assert.equal(ARC_RPCS.length, 4)
})

test('arc-contracts.ts CONTRACTS still exposes the exact live addresses', () => {
  assert.equal(CONTRACTS.identityRegistry, ARC_CHAIN.contracts.identityRegistry)
  assert.equal(CONTRACTS.reputationRegistry, ARC_CHAIN.contracts.reputationRegistry)
  assert.equal(CONTRACTS.validationRegistry, ARC_CHAIN.contracts.validationRegistry)
  assert.equal(CONTRACTS.agenticCommerce, ARC_CHAIN.contracts.agenticCommerce)
  assert.equal(CONTRACTS.usdc, ARC_CHAIN.contracts.usdc)
  // pin the literal USDC address so a bad registry edit can't silently repoint payments
  assert.equal(CONTRACTS.usdc, '0x3600000000000000000000000000000000000000')
})

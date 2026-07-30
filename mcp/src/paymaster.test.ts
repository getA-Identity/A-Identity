import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodePaymasterData, paymasterStatus, CIRCLE_PAYMASTER, PAYMASTER_GAS } from './paymaster.js'
import { ARC_CHAIN } from './chains/registry.js'

/**
 * The point of these is to keep an honest claim honest. If Circle ever deploys the
 * paymaster to Arc, or Arc ever stops denominating gas in USDC, the story on the page
 * has to change, and one of these fails first.
 */

test('Arc denominates gas in USDC, which is why a token paymaster is redundant there', async () => {
  const s = await paymasterStatus()
  assert.equal(s.evmChainId, ARC_CHAIN.evmChainId)
  assert.match(s.gasPaidIn, /USDC/)
  assert.equal(s.paymasterRelevant, false)
})

test('the published Arc paymaster address is probed, not trusted', async () => {
  const s = await paymasterStatus()
  // null means the RPC was unreachable in this environment; false means we checked and
  // there is no contract. Either way we must never report a deployment we did not see.
  assert.ok(s.paymasterDeployed === false || s.paymasterDeployed === null)
  assert.equal(s.address, CIRCLE_PAYMASTER.v08)
})

test('paymasterData packs version, token, amount and signature', () => {
  const d = encodePaymasterData({
    usdc: '0x3600000000000000000000000000000000000000',
    permitAmount: 10_000_000n,
    permitSignature: '0xdeadbeef',
  })
  assert.ok(d.startsWith('0x00'), 'first byte is the mode selector')
  assert.ok(d.slice(4, 44).includes('3600000000'), 'token address follows the selector')
  // 1 byte selector + 20 byte token + 32 byte amount = 53 bytes, then the signature.
  assert.equal(d.length, 2 + 2 + 40 + 64 + 8)
})

test('paymasterData refuses malformed input rather than encoding nonsense', () => {
  assert.throws(() => encodePaymasterData({ usdc: '0xnope' as `0x${string}`, permitAmount: 1n, permitSignature: '0x1' }))
  assert.throws(() =>
    encodePaymasterData({ usdc: '0x3600000000000000000000000000000000000000', permitAmount: 0n, permitSignature: '0x1' }),
  )
})

test('the quickstart gas limits are carried, not guessed at the call site', () => {
  assert.equal(PAYMASTER_GAS.paymasterVerificationGasLimit, 200_000n)
  assert.equal(PAYMASTER_GAS.paymasterPostOpGasLimit, 15_000n)
})

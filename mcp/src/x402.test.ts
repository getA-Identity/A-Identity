/**
 * Unit tests for the x402 payer-binding + nonce lifecycle - pure, offline, no chain.
 *
 * These cover the fix for the payment-not-bound-to-payer gap: a redemption must carry a
 * signature the actual paying wallet produced over the (nonce, payer) challenge. A
 * front-runner who only scraped the tx hash off the public chain cannot forge it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import {
  x402BindingMessage,
  verifyPayerBinding,
  issueX402Nonce,
  x402NonceValid,
  consumeX402Nonce,
} from './x402.js'

// Two independent accounts: the real payer, and a would-be front-runner.
const payerKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const attackerKey = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
const payer = privateKeyToAccount(payerKey)
const attacker = privateKeyToAccount(attackerKey)

test('x402BindingMessage is deterministic and lower-cases the payer', () => {
  const a = x402BindingMessage('deadbeef', payer.address)
  const b = x402BindingMessage('deadbeef', payer.address.toUpperCase())
  assert.equal(a, b)
  assert.match(a, /Nonce: deadbeef/)
  assert.match(a, new RegExp(`Payer: ${payer.address.toLowerCase()}`))
})

test('verifyPayerBinding: the paying wallet\'s signature is accepted', async () => {
  const nonce = 'a'.repeat(32)
  const signature = await payer.signMessage({ message: x402BindingMessage(nonce, payer.address) })
  assert.equal(await verifyPayerBinding(nonce, payer.address, signature), true)
})

test('verifyPayerBinding: a front-runner\'s signature for the payer address is rejected', async () => {
  const nonce = 'b'.repeat(32)
  // Attacker signs the same message but claims to be `payer` - signature won't recover to payer.
  const forged = await attacker.signMessage({ message: x402BindingMessage(nonce, payer.address) })
  assert.equal(await verifyPayerBinding(nonce, payer.address, forged), false)
})

test('verifyPayerBinding: a signature over a different nonce is rejected', async () => {
  const signed = await payer.signMessage({ message: x402BindingMessage('nonce-one', payer.address) })
  assert.equal(await verifyPayerBinding('nonce-two', payer.address, signed), false)
})

test('verifyPayerBinding: malformed payer / signature are rejected, not thrown', async () => {
  assert.equal(await verifyPayerBinding('n', 'not-an-address', '0xabc'), false)
  assert.equal(await verifyPayerBinding('n', payer.address, 'not-hex'), false)
})

test('nonce lifecycle: issue -> valid -> consume -> invalid', () => {
  const nonce = issueX402Nonce()
  assert.equal(x402NonceValid(nonce), true)
  assert.equal(x402NonceValid(nonce, '/some/other/resource'), false) // bound to its resource
  consumeX402Nonce(nonce)
  assert.equal(x402NonceValid(nonce), false) // single-use
  assert.equal(x402NonceValid(undefined), false)
})

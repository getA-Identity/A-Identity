import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readValidationOn, supportsValidation, validationChains } from './validation-registry.js'
import { CHAINS, ARC_CHAIN } from './chains/index.js'

/**
 * The one thing this module exists to keep true: a chain that cannot anchor an attestation
 * must never answer with a count.
 *
 * Only the refusal paths are exercised here, and deliberately: they are the ones that are
 * pure. A real read needs an RPC, and a unit test that dials one is a unit test that fails
 * on a plane.
 */

test('validationChains is derived from the registry, not from a list', () => {
  const derived = validationChains().map((c) => c.id).sort()
  const expected = CHAINS.filter((c) => c.ecosystem === 'evm' && c.contracts.validationRegistry).map((c) => c.id).sort()
  assert.deepEqual(derived, expected)
  assert.ok(derived.includes(ARC_CHAIN.id), 'Arc carries a ValidationRegistry and must be readable')
  assert.ok(derived.length >= 2, 'KYA anchoring is no longer single-chain; at least two chains carry a registry')
})

test('supportsValidation separates "carries a registry" from "is a chain we know"', () => {
  assert.equal(supportsValidation(ARC_CHAIN.id), true)
  assert.equal(supportsValidation('not-a-chain'), false)
  const without = CHAINS.find((c) => c.ecosystem === 'evm' && !c.contracts.validationRegistry)
  assert.ok(without, 'expected at least one registry chain with no ValidationRegistry')
  assert.equal(supportsValidation(without!.id), false)
})

test('a chain with no ValidationRegistry returns supported:false, never kyaCount:0', async () => {
  const without = CHAINS.find((c) => c.ecosystem === 'evm' && !c.contracts.validationRegistry)!
  const r = await readValidationOn(without.id, 7n)
  assert.equal(r.supported, false)
  assert.equal('kyaCount' in r, false, 'reporting zero would claim we looked and found nothing')
  assert.equal('validations' in r, false)
  if (r.supported) return
  assert.match(r.reason, /not the same as/i, 'the reason must say what the absence does NOT mean')
  assert.equal(r.agentId, '7')
  assert.equal(r.chain, without.id)
})

test('an unknown chain is refused by name rather than defaulted to Arc', async () => {
  // Defaulting would read the RIGHT number off the WRONG chain: the same ERC-8004 token id
  // belongs to a different agent elsewhere, so a silent fallback is a wrong answer that
  // looks right.
  const r = await readValidationOn('not-a-chain', 1n)
  assert.equal(r.supported, false)
  if (r.supported) return
  assert.match(r.reason, /not in the chain registry/i)
  assert.equal(r.chain, 'not-a-chain')
})

test('a non-EVM chain is refused before any client is built', async () => {
  const nonEvm = CHAINS.find((c) => c.ecosystem !== 'evm')
  assert.ok(nonEvm, 'expected a non-EVM chain in the registry')
  const r = await readValidationOn(nonEvm!.id, 1n)
  assert.equal(r.supported, false)
  if (r.supported) return
  assert.match(r.reason, /EVM-only/i)
})

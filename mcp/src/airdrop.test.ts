/**
 * Unit tests for the Merkle airdrop tree/proof - pure, offline, deterministic.
 * Verifies the backend computes the same root/proofs the contract checks against.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAirdrop, verifyProof, toUsdcUnits, type AirdropEntry } from './airdrop.js'

const A = '0x1111111111111111111111111111111111111111' as const
const B = '0x2222222222222222222222222222222222222222' as const
const C = '0x3333333333333333333333333333333333333333' as const
const D = '0x4444444444444444444444444444444444444444' as const
const E = '0x5555555555555555555555555555555555555555' as const

const five: AirdropEntry[] = [
  { account: A, amountUsd: 1 },
  { account: B, amountUsd: 2.5 },
  { account: C, amountUsd: 0.01 },
  { account: D, amountUsd: 100 },
  { account: E, amountUsd: 3.33 },
]

test('toUsdcUnits: 6-decimal conversion', () => {
  assert.equal(toUsdcUnits(1), 1_000_000n)
  assert.equal(toUsdcUnits(0.01), 10_000n)
  assert.equal(toUsdcUnits(2.5), 2_500_000n)
})

test('root is deterministic for the same input', () => {
  assert.equal(buildAirdrop(five).root, buildAirdrop(five).root)
})

test('root is a 32-byte hex', () => {
  assert.match(buildAirdrop(five).root, /^0x[0-9a-f]{64}$/)
})

test('every recipient proof verifies against the root (odd count)', () => {
  const { root, recipients } = buildAirdrop(five) // 5 = odd -> exercises node promotion
  for (const r of recipients) {
    assert.equal(verifyProof(r.index, r.account, r.amount, r.proof, root), true, `index ${r.index}`)
  }
})

test('every recipient proof verifies against the root (even count)', () => {
  const { root, recipients } = buildAirdrop(five.slice(0, 4))
  for (const r of recipients) {
    assert.equal(verifyProof(r.index, r.account, r.amount, r.proof, root), true)
  }
})

test('single recipient: root equals the leaf, empty proof verifies', () => {
  const { root, recipients } = buildAirdrop([{ account: A, amountUsd: 5 }])
  assert.equal(recipients.length, 1)
  assert.equal(recipients[0].proof.length, 0)
  assert.equal(verifyProof(0, A, toUsdcUnits(5), [], root), true)
})

test('a tampered amount fails verification', () => {
  const { root, recipients } = buildAirdrop(five)
  const r = recipients[1]
  assert.equal(verifyProof(r.index, r.account, r.amount + 1n, r.proof, root), false)
})

test('a wrong account fails verification', () => {
  const { root, recipients } = buildAirdrop(five)
  const r = recipients[2]
  assert.equal(verifyProof(r.index, A, r.amount, r.proof, root), false)
})

test('total equals the sum of allocations', () => {
  const built = buildAirdrop(five)
  assert.equal(built.totalUnits, toUsdcUnits(1) + toUsdcUnits(2.5) + toUsdcUnits(0.01) + toUsdcUnits(100) + toUsdcUnits(3.33))
  assert.equal(built.totalUsd, 106.84)
})

test('changing one allocation changes the root', () => {
  const a = buildAirdrop(five).root
  const bumped = [...five]
  bumped[0] = { account: A, amountUsd: 1.01 }
  assert.notEqual(a, buildAirdrop(bumped).root)
})

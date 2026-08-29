import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ATTESTATIONS, getReputationAttestation, type ReputationAttestation } from './attestations.js'

const row = (over: Partial<ReputationAttestation>): ReputationAttestation => ({
  tokenId: '849980', score: 541, score100: 54, tag: 'a-identity:reputation:v1',
  chain: 'arc', registry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  validator: '0xValidator', txHash: '0xhash', txUrl: 'https://x/tx/0xhash',
  feedbackHash: '0xfeed', attestedAt: '2026-07-22T00:00:00.000Z', ...over,
})

// The shipped store carries the real Meridian anchor; this case must run FIRST, before the
// isolation cleanup below wipes it. Every later case sets up its own rows on a clean store.
test('the shipped store carries the real Meridian on-chain anchor', () => {
  const m = getReputationAttestation('849980')
  assert.ok(m, 'expected a published attestation for Meridian #849980')
  assert.match(m!.txHash, /^0x[0-9a-fA-F]{64}$/)
  assert.equal(m!.registry, '0x8004B663056A597Dffe9eCcC1965A193B7388713')
})

// Keep the shared store clean between the isolated cases below.
afterEach(() => { ATTESTATIONS.length = 0 })

test('empty store returns null', () => {
  ATTESTATIONS.length = 0
  assert.equal(getReputationAttestation('849980'), null)
})

test('null / undefined / empty input returns null', () => {
  ATTESTATIONS.push(row({}))
  assert.equal(getReputationAttestation(null), null)
  assert.equal(getReputationAttestation(undefined), null)
  assert.equal(getReputationAttestation(''), null)
})

test('matches by token id as string, bigint, and with a # prefix', () => {
  ATTESTATIONS.push(row({}))
  assert.equal(getReputationAttestation('849980')?.txHash, '0xhash')
  assert.equal(getReputationAttestation(849980n)?.txHash, '0xhash')
  assert.equal(getReputationAttestation('#849980')?.txHash, '0xhash')
})

test('no match for a different agent', () => {
  ATTESTATIONS.push(row({}))
  assert.equal(getReputationAttestation('111111'), null)
})

test('returns the latest attestation by attestedAt', () => {
  ATTESTATIONS.push(row({ txHash: '0xold', attestedAt: '2026-07-20T00:00:00.000Z' }))
  ATTESTATIONS.push(row({ txHash: '0xnew', attestedAt: '2026-07-22T12:00:00.000Z' }))
  ATTESTATIONS.push(row({ txHash: '0xmid', attestedAt: '2026-07-21T00:00:00.000Z' }))
  assert.equal(getReputationAttestation('849980')?.txHash, '0xnew')
})

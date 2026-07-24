/**
 * Unit tests for the ASP agent-id resolution helpers — pure, offline, deterministic.
 * These parse the `agentId` a caller passes into the four paid tools.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asTokenId, isAddress, sameOperator, scoreBand } from './tools.js'
import type { PlatformAgent } from '../platform.js'

// A minimal agent for the counterparty_check same-operator relationship signal.
const agent = (over: Partial<PlatformAgent>): PlatformAgent => ({ id: 'a', owner: undefined, walletAddress: null, ...over } as PlatformAgent)

test('asTokenId: plain number', () => {
  assert.equal(asTokenId('849980'), 849980n)
})

test('asTokenId: hash-prefixed token id', () => {
  assert.equal(asTokenId('#849980'), 849980n)
})

test('asTokenId: whitespace tolerated', () => {
  assert.equal(asTokenId('  #6271  '), 6271n)
})

test('asTokenId: non-numeric -> null', () => {
  assert.equal(asTokenId('meridian'), null)
  assert.equal(asTokenId('0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6'), null)
  assert.equal(asTokenId('#12ab'), null)
  assert.equal(asTokenId(''), null)
})

test('isAddress: valid 20-byte hex address', () => {
  assert.equal(isAddress('0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6'), true)
  assert.equal(isAddress('0x6A5F1b8e56A19D456b799C2fA00E513244F58Ce6'), true) // mixed case ok
})

test('isAddress: rejects non-addresses', () => {
  assert.equal(isAddress('0x123'), false) // too short
  assert.equal(isAddress('6a5f1b8e56a19d456b799c2fa00e513244f58ce6'), false) // no 0x
  assert.equal(isAddress('#849980'), false)
  assert.equal(isAddress('0xZZZZ1b8e56a19d456b799c2fa00e513244f58ce6'), false) // non-hex
})

test('sameOperator: same owner (case-insensitive) on distinct agents => true', () => {
  assert.equal(sameOperator(agent({ id: 'a', owner: '0xABC' }), agent({ id: 'b', owner: '0xabc' })), true)
})

test('sameOperator: shared settlement wallet => true', () => {
  assert.equal(sameOperator(agent({ id: 'a', walletAddress: '0xWALLET' }), agent({ id: 'b', walletAddress: '0xwallet' })), true)
})

test('sameOperator: different owners => false', () => {
  assert.equal(sameOperator(agent({ id: 'a', owner: '0xAAA' }), agent({ id: 'b', owner: '0xBBB' })), false)
})

test('sameOperator: the same agent id is not a self-deal counterparty', () => {
  assert.equal(sameOperator(agent({ id: 'a', owner: '0xABC' }), agent({ id: 'a', owner: '0xABC' })), false)
})

test('sameOperator: missing owner/wallet on either side => false (no false positive)', () => {
  assert.equal(sameOperator(agent({ id: 'a' }), agent({ id: 'b' })), false)
  assert.equal(sameOperator(null, agent({ id: 'b', owner: '0xABC' })), false)
})

test('scoreBand: bands align with the risk thresholds (DENY < 200, WARN 200-500)', () => {
  assert.equal(scoreBand(0), 'very-low')
  assert.equal(scoreBand(199), 'very-low')
  assert.equal(scoreBand(200), 'low')
  assert.equal(scoreBand(499), 'low')
  assert.equal(scoreBand(500), 'medium')
  assert.equal(scoreBand(699), 'medium')
  assert.equal(scoreBand(700), 'high')
  assert.equal(scoreBand(1000), 'high')
})

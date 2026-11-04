/**
 * Unit tests for the ASP agent-id resolution helpers - pure, offline, deterministic.
 * These parse the `agentId` a caller passes into the four paid tools.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { asTokenId, isAddress, onPlatformSignal, sameOperator, scoreBand, livenessTarget, selfLookupCandidates } from './tools.js'
import { recordAtAddress, type PlatformAgent } from '../platform.js'

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

test('livenessTarget: bare domain becomes https://<domain>/', () => {
  assert.equal(livenessTarget('agent.example.com', null), 'https://agent.example.com/')
})

test('livenessTarget: an http(s) domain value is used as-is', () => {
  assert.equal(livenessTarget('https://agent.example.com/api', null), 'https://agent.example.com/api')
})

test('livenessTarget: falls back to the registration URI when no domain', () => {
  assert.equal(livenessTarget('', 'https://cdn.example.com/agent.json'), 'https://cdn.example.com/agent.json')
  assert.equal(livenessTarget(null, 'https://cdn.example.com/agent.json'), 'https://cdn.example.com/agent.json')
})

test('livenessTarget: SSRF-unsafe targets yield null (never probed)', () => {
  assert.equal(livenessTarget('localhost', null), null)
  assert.equal(livenessTarget('192.168.1.10', null), null)
  assert.equal(livenessTarget('169.254.169.254', null), null)
  assert.equal(livenessTarget(null, 'ipfs://Qm123'), null)
  assert.equal(livenessTarget(null, 'http://127.0.0.1/x'), null)
})

test('livenessTarget: unsafe domain still falls back to a safe registration URI', () => {
  assert.equal(livenessTarget('localhost', 'https://cdn.example.com/agent.json'), 'https://cdn.example.com/agent.json')
})

test('livenessTarget: nothing registered yields null', () => {
  assert.equal(livenessTarget(null, null), null)
  assert.equal(livenessTarget('', ''), null)
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

test('selfLookupCandidates: wallet first, then owner, then identity owner, then the query; lowercased, de-duplicated', () => {
  const out = selfLookupCandidates(
    agent({ walletAddress: '0x6A5F1b8e56A19D456b799C2fA00E513244F58Ce6', owner: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    { owner: '0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6' },
    '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  )
  assert.deepEqual(out, [
    '0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6',
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ])
})

test('selfLookupCandidates: non-addresses (ids, usernames, CAIP ids) are dropped, so an empty list means no lookup', () => {
  assert.deepEqual(selfLookupCandidates(agent({ owner: 'user_42', walletAddress: null }), null, '#6271'), [])
  assert.deepEqual(selfLookupCandidates(null, null, 'eip155:42220:0x6a5f1b8e56a19d456b799c2fa00e513244f58ce6'), [])
})

type Row = Parameters<typeof onPlatformSignal>[1][number]
const row = (over: Partial<Row>): Row => ({ onchainAgentId: undefined, chain: 'arc', walletAddress: null, kya: 'unverified', ...over } as Row)
const W = '0x' + 'a1'.repeat(20)
const W2 = '0x' + 'a2'.repeat(20)

test('onPlatformSignal: true with a record, false only when we could look and hold none', () => {
  const roster = [row({ onchainAgentId: '7' }), row({})]
  const address = '0x' + 'd4'.repeat(20)
  assert.equal(onPlatformSignal({ id: 'a' }, roster, address, null), true)
  assert.equal(onPlatformSignal(null, roster, address, null), false)
  assert.equal(onPlatformSignal(null, roster, 'eip155:1:8004/9', { tokenId: 9, chain: 'arc' }), false, 'an identity no platform agent is anchored on')
  // A roster this process cannot see is not a finding, so the scorer stays strict.
  assert.equal(onPlatformSignal(null, [], address, null), undefined)
  assert.equal(onPlatformSignal(null, roster, address, null, false), undefined, 'a refresh that failed is the same as a roster we cannot see')
})

test('onPlatformSignal: a CAIP id that resolves to an agent we hold a record of is not "no record"', () => {
  const roster = [row({ onchainAgentId: '7' })]
  assert.equal(onPlatformSignal(null, roster, 'eip155:1:8004/7', { tokenId: 7, chain: 'arc' }), undefined)
  // The same number on another chain is another agent.
  assert.equal(onPlatformSignal(null, roster, 'eip155:1:8004/7', { tokenId: 7, chain: 'base' }), false)
  // An address names a wallet: recordAtAddress has read it, so no record there is a finding.
  assert.equal(onPlatformSignal(null, roster, '0x' + 'd4'.repeat(20), { tokenId: 7, chain: 'arc' }), false)
})

test('onPlatformSignal: an id that resolved to nothing was never looked up, so it stays strict', () => {
  const roster = [row({ walletAddress: W, kya: 'revoked', kyaProof: { address: W, at: 'x', method: 'wallet-signature' } })]
  for (const query of ['totally-made-up-id', `eip155:5042:${W}`, W.replace('0x', '0X'), 'eip155:5042002:8004/7']) {
    assert.equal(onPlatformSignal(null, roster, query, null), undefined, query)
  }
  // A partial identity carries no usable id, so it answers nothing about a record either.
  assert.equal(onPlatformSignal(null, [row({ onchainAgentId: '7' })], 'eip155:1:8004/7', { tokenId: 7, chain: 'arc', partial: true }), undefined)
})

test('onPlatformSignal: a mainnet token owned by an address a record proved stays strict, whichever chain the record is anchored on', () => {
  const meridian = row({ onchainAgentId: '849980', walletAddress: W, kya: 'verified' })
  assert.equal(onPlatformSignal(null, [meridian], 'eip155:5042:8004/4306', { tokenId: 4306, chain: 'arc-mainnet', owner: W }), undefined, 'mainnet token, testnet anchor')
  const simon = row({ walletAddress: W, kya: 'verified' })
  assert.equal(onPlatformSignal(null, [simon], 'eip155:5042:8004/104498', { tokenId: 104498, chain: 'arc-mainnet', owner: W.toUpperCase().replace('0X', '0x') }), undefined, 'no anchor at all, and the case of the owner does not matter')
  // A record that only names that wallet proves nothing, so it cannot turn a stranger's token strict.
  const claim = row({ walletAddress: W, kya: 'unverified' })
  assert.equal(onPlatformSignal(null, [claim], 'eip155:5042:8004/4306', { tokenId: 4306, chain: 'arc-mainnet', owner: W }), false)
})

test('recordAtAddress: a record counts at an address only once it proved control of it', () => {
  const proof = (address: string) => ({ address, at: 'x', method: 'wallet-signature' as const })
  // Named without proof: not this payee's record, and it is returned so the reasons can say so.
  const claim = { id: 'fake', walletAddress: W, kya: 'unverified' } as PlatformAgent
  assert.deepEqual(recordAtAddress([claim], W), { record: null, currentWallet: false, claim })
  // Revoked by its owner with no proof ever made: a free way to smear someone else's wallet.
  const smear = { id: 'smear', walletAddress: W, kya: 'revoked' } as PlatformAgent
  assert.equal(recordAtAddress([smear], W).record, null)
  const unclaimed = { id: 'imported', walletAddress: W, kya: 'unclaimed' } as PlatformAgent
  assert.equal(recordAtAddress([unclaimed], W).record, null)

  const real = { id: 'real', walletAddress: W, kya: 'verified' } as PlatformAgent
  assert.deepEqual(recordAtAddress([claim, real], W.toUpperCase().replace('0X', '0x')), { record: real, currentWallet: true, claim: null }, 'a claim listed first does not shadow the proven record')
  const revoked = { id: 'bad', walletAddress: W, kya: 'revoked', kyaProof: proof(W) } as PlatformAgent
  assert.equal(recordAtAddress([real, revoked], W).record, revoked, 'a clean twin does not shadow a revoked record')
})

test('recordAtAddress: the wallet a proven record moved off still reads as that record, and a stranger cannot make that happen', () => {
  const proof = (address: string) => ({ address, at: 'x', method: 'wallet-signature' as const })
  // Revoked, then moved: the proof stays on the record.
  const revoked = { id: 'bad', walletAddress: W2, kya: 'revoked', kyaProof: proof(W) } as PlatformAgent
  assert.deepEqual(recordAtAddress([revoked], W), { record: revoked, currentWallet: false, claim: null })
  assert.deepEqual(recordAtAddress([revoked], W2), { record: revoked, currentWallet: true, claim: null }, 'revoked after a proof, so its new wallet reads as it too')
  // Verified, moved, then revoked: assignWallet drops the proof and keeps the address.
  const moved = { id: 'moved', walletAddress: W2, kya: 'revoked', formerProvenWallets: [W] } as PlatformAgent
  assert.equal(recordAtAddress([moved], W).record, moved)
  // A claimed token's signer.
  const claimed = { id: 'claimed', walletAddress: W2, kya: 'verified', claimProof: { address: W, at: 'x', method: 'wallet-signature', tokenId: '1', chain: 'arc' } } as PlatformAgent
  assert.deepEqual(recordAtAddress([claimed], W), { record: claimed, currentWallet: false, claim: null })
  // Written by anyone: importing a vendor's token, or recording its wallet, is not a proof.
  const imported = { id: 'imported', walletAddress: null, kya: 'unclaimed', importedFrom: { chain: 'arc', tokenId: '1', registry: '0x', owner: W, at: 'x' } } as PlatformAgent
  assert.equal(recordAtAddress([imported], W).record, null)
})

test('the ASP process re-reads the roster before it scores', () => {
  // A roster frozen at boot would read a new agent as no record, which now fails toward paying.
  assert.match(readFileSync(new URL('../../src/asp-gateway.ts', import.meta.url), 'utf8'), /\n\s+refreshRosterBeforeScoring\(\)\n/)
})

/**
 * Self Agent ID reads: the pure helpers and every refusal path, offline. The live read is
 * exercised by hand against Celo (see the registry comment); nothing here touches an RPC.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentKeyFor, humanRef, humanProofChains, supportsHumanProof, readHumanProofOn, readHumanProofFor, sameHumanOn } from './self-agent-id.js'
import { CHAINS } from './chains/index.js'

const ADDR = '0x6A5F1b8e56A19D456b799C2fA00E513244F58Ce6'

test('agentKeyFor: a bytes32 left-padded, lowercased agent address, as the registry keys it', () => {
  assert.equal(agentKeyFor(ADDR), '0x0000000000000000000000006a5f1b8e56a19d456b799c2fa00e513244f58ce6')
  assert.equal(agentKeyFor(ADDR).length, 66)
  assert.throws(() => agentKeyFor('#6271'), /not an EVM address/)
})

test('humanRef: stable, prefixed, and not the nullifier itself', () => {
  const n = 123456789012345678901234567890n
  assert.equal(humanRef(n), humanRef(n))
  assert.match(humanRef(n), /^self:[0-9a-f]{16}$/)
  assert.notEqual(humanRef(n), humanRef(n + 1n))
  assert.ok(!humanRef(n).includes(n.toString(16)), 'the raw nullifier must not leak through the ref')
})

test('every chain that names a Self registry is an EVM chain, and Celo is among them', () => {
  const chains = humanProofChains()
  assert.ok(chains.length >= 1)
  for (const c of chains) {
    assert.equal(c.ecosystem, 'evm', `${c.id} names a Self registry but is not EVM`)
    assert.match(c.contracts.selfAgentRegistry ?? '', /^0x[0-9a-fA-F]{40}$/)
  }
  assert.ok(chains.some((c) => c.id === 'celo'))
  assert.equal(supportsHumanProof('celo'), true)
})

test('chains without a registry refuse before any network call, each with its own reason', async () => {
  assert.equal(supportsHumanProof('arc'), false)
  assert.equal(supportsHumanProof('stellar'), false)
  assert.equal(supportsHumanProof('nope'), false)
  const arc = await readHumanProofOn('arc', ADDR)
  assert.equal(arc.supported, false)
  if (!arc.supported) assert.match(arc.reason, /carries no Self Agent ID registry/)
  const stellar = await readHumanProofOn('stellar', ADDR)
  assert.equal(stellar.supported, false)
  if (!stellar.supported) assert.match(stellar.reason, /EVM registry/)
  const unknown = await readHumanProofOn('nope', ADDR)
  assert.equal(unknown.supported, false)
  if (!unknown.supported) assert.match(unknown.reason, /not in the chain registry/)
})

test('a non-address query on a supported chain is an error, not a network call and not "unregistered"', async () => {
  const r = await readHumanProofOn('celo', '#6271')
  assert.equal(r.supported, true)
  assert.ok(r.supported && 'error' in r && /not an EVM address/.test(r.error))
})

test('readHumanProofFor: no EVM address means unsupported with a reason, never a fabricated miss', async () => {
  const r = await readHumanProofFor('celo', ['#6271', 'stellar:pubnet:G...'])
  assert.equal(r.supported, false)
  if (!r.supported) assert.match(r.reason, /No EVM address/)
})

test('sameHumanOn: null on a chain that cannot answer, never a guessed false', async () => {
  assert.equal(await sameHumanOn('arc', 1n, 2n), null)
  assert.equal(await sameHumanOn('stellar', 1n, 2n), null)
  // The registry field is opt-in per chain: nothing outside the descriptor decides support.
  assert.equal(CHAINS.filter((c) => c.contracts.selfAgentRegistry).length, humanProofChains().length)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS } from '../chains/index.js'
import {
  vaultChainFor, isEvmVault, toRaw, fromRaw, fromCallOutcome, allowlistEntriesFor,
} from './vault-adapter.js'
import type { PlatformAgent } from './core.js'

/**
 * The dispatcher exists because an AgentSpendPolicy is deployed on two ecosystems that
 * disagree about two things: how many decimals an amount has, and what a write returns.
 * Both disagreements are money-shaped, so both are pinned here rather than left to the
 * one caller to get right.
 */
const agent = (over: Partial<PlatformAgent> = {}) => ({ id: 'a', ...over }) as PlatformAgent
const arc = CHAINS.find((c) => c.id === 'arc')!
const stellar = CHAINS.find((c) => c.id === 'stellar')!

test('a row written before the field existed is Arc, because no other vault could have existed', () => {
  // provisionAgentVault bound the Arc adapter unconditionally, so this is an observation
  // rather than a default. migrateAgentVaults fills the field in on the same reasoning.
  assert.equal(vaultChainFor(agent())?.id, 'arc')
  assert.equal(isEvmVault(agent()), true)
})

test('a Stellar vault resolves to Stellar and is not an EVM vault', () => {
  const a = agent({ vaultChainCaip2: 'stellar:pubnet' })
  assert.equal(vaultChainFor(a)?.id, 'stellar')
  assert.equal(isEvmVault(a), false)
})

test('a vault naming a chain the registry does not have resolves to nothing', () => {
  assert.equal(vaultChainFor(agent({ vaultChainCaip2: 'eip155:999999' })), null)
})

test('one USD is a different number of base units on each chain, and that is the whole point', () => {
  // Stellar settles at 7 decimals, every EVM stablecoin we settle in at 6. Converting in
  // the caller rather than here is how a 1 USDC cap gets pushed as 10 USDC.
  assert.equal(toRaw(stellar, 1), 10_000_000n)
  assert.equal(toRaw(arc, 1), 1_000_000n)
  assert.equal(fromRaw(stellar, '10000000'), 1)
  assert.equal(fromRaw(arc, '1000000'), 1)
})

test('a fractional cap survives the round trip on the 7-decimal chain', () => {
  assert.equal(toRaw(stellar, 0.25), 2_500_000n)
  assert.equal(fromRaw(stellar, toRaw(stellar, 0.25)), 0.25)
})

test('a settled Soroban write is success and carries its hash', () => {
  const r = fromCallOutcome({ outcome: 'settled', txHash: 'abc' })
  assert.deepEqual(r, { ok: true, txHash: 'abc' })
})

test('a PENDING write is not success, because the ledger still holds the old policy', () => {
  // The arm that matters. Collapsing five outcomes to a boolean is what made a landed and
  // FAILED transaction read as success once; telling an owner their new limit is in force
  // while it is still in flight is the same mistake wearing a different hat.
  const r = fromCallOutcome({ outcome: 'pending', txHash: 'def' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /not yet in a ledger/)
})

test('no signer is owner-gated, which is not the contract saying no', () => {
  const r = fromCallOutcome({ outcome: 'prepared', reason: 'no signer' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.ownerGated, true)
})

test('refused and failed are both failures, and they do not read the same', () => {
  const refused = fromCallOutcome({ outcome: 'refused', error: 'DailyCapExceeded' })
  const failed = fromCallOutcome({ outcome: 'failed', error: 'trapped' })
  assert.equal(refused.ok, false)
  assert.equal(failed.ok, false)
  if (!refused.ok) assert.match(refused.reason, /refused it in simulation/)
  if (!failed.ok) assert.match(failed.reason, /landed and failed/)
})

test('an allowlist entry is filtered to the address shape its own chain accepts', () => {
  // Mirroring a 0x address onto a Soroban allowlist writes an entry no payee can match.
  const mixed = ['0x000000000000000000000000000000000000dEaD', 'GBLHNAL57WLA5GKTIGPBHCJTQDNEZFX2CVH53EDUOGWIERNKECRENHQ5', 'agent://x']
  assert.deepEqual(allowlistEntriesFor(arc, mixed), ['0x000000000000000000000000000000000000dEaD'])
  assert.deepEqual(allowlistEntriesFor(stellar, mixed), ['GBLHNAL57WLA5GKTIGPBHCJTQDNEZFX2CVH53EDUOGWIERNKECRENHQ5'])
})

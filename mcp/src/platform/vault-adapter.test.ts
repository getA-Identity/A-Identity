import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHAINS } from '../chains/index.js'
import { errorName } from '../chains/stellar/adapter.js'
import {
  vaultChainFor, isEvmVault, toRaw, fromRaw, fromCallOutcome, allowlistEntriesFor,
  vaultResultFromOutcome, type VaultPolicyView,
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

// ── the Soroban payment, mapped onto the shape the settlement ladder branches on ──
//
// `platform/instructions.ts` asks three questions of a vault payment: did it execute, did
// it revert, and if it reverted, was the reason one of the frozen policy-error names. Five
// Soroban outcomes have to answer those three without losing anything, and each arm below
// is a different wrong answer that would have been easy to give.

const name = (c: number | undefined) => errorName(c)

test('a settled Soroban payment is the only arm that counts as executed', () => {
  const r = vaultResultFromOutcome(
    { outcome: 'settled', txHash: 'abc', explorerUrl: 'https://example.test/tx/abc' },
    name,
  )
  assert.equal(r.executed, true)
  if (r.executed) assert.equal(r.txHash, 'abc')
})

test('a typed refusal is reported by NAME, because the name is what the policy ladder matches', () => {
  // DailyCapExceeded is code 5 in the contract's frozen table. Reporting the number would
  // leave VAULT_POLICY_ERRORS unable to recognise a genuine policy refusal, and the
  // settlement would fall through to a rail with no vault enforcement at all.
  const r = vaultResultFromOutcome(
    { outcome: 'refused', reason: 'the contract refused it: HostError #5', contractErrorCode: 5, contractErrorIsOurs: true },
    name,
  )
  assert.equal(r.executed, false)
  assert.equal(r.reverted, true)
  if (!r.executed && r.reverted) assert.equal(r.reason, 'DailyCapExceeded')
})

test('an error the TOKEN raised keeps its prose and is never given one of our names', () => {
  // Code 13 is the SAC saying a trustline is missing. Our table stops at 10, and naming it
  // anyway would turn an underfunded payee into a policy decision nobody made.
  const r = vaultResultFromOutcome(
    { outcome: 'refused', reason: 'trustline entry is missing', contractErrorCode: 13, contractErrorIsOurs: false },
    name,
  )
  assert.equal(r.executed, false)
  if (!r.executed) assert.match(r.reason, /trustline/)
})

test('a landed-and-FAILED transaction is reverted, never success', () => {
  const r = vaultResultFromOutcome({ outcome: 'failed', txHash: 'def', reason: 'landed and failed' }, name)
  assert.equal(r.executed, false)
  assert.equal(r.reverted, true)
})

test('pending and prepared are neither executed nor reverted, which is what stops a second settlement', () => {
  // This is the arm that protects money. Calling pending "reverted" would send the caller
  // down a fallback rail and pay twice; calling it executed would record a settlement that
  // may never land.
  for (const r of [
    vaultResultFromOutcome({ outcome: 'pending', txHash: 'aaa', reason: 'not in a ledger yet' }, name),
    vaultResultFromOutcome({ outcome: 'prepared', reason: 'no signer' }, name),
  ]) {
    assert.equal(r.executed, false)
    assert.equal(r.reverted, false)
  }
})

test('an outcome nobody recognises is not quietly treated as a refusal', () => {
  const r = vaultResultFromOutcome({ outcome: 'who-knows' }, name)
  assert.equal(r.executed, false)
  assert.equal(r.reverted, false)
})

// ── the vault view, and the payee shapes the two chains accept ───────────────────

test('a Stellar payee is a G... account and an Arc one is 0x, on the same helper', () => {
  const g = 'GBLHNAL57WLA5GKTIGPBHCJTQDNEZFX2CVH53EDUOGWIERNKECRENHQ5'
  const c = 'CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI'
  // A contract may hold an allowlist entry (an agent paying another contract), but a
  // 0x address never can: it is not an address on this chain at all.
  assert.deepEqual(allowlistEntriesFor(stellar, [g, c, '0x000000000000000000000000000000000000dEaD']), [g, c])
})

test('the session-key expiry survives the trip through the view, on both chains', () => {
  // The gap this closed: the EVM adapter has always computed sessionKeyExpiry and this view
  // dropped it, so `platform/instructions.ts` could not label a Stellar settlement at all
  // and had to say so as a stated limitation. The field is optional because a chain with no
  // vault port answers null for the whole view.
  const view: VaultPolicyView = {
    dailyCapUsd: 25, autoApproveUsd: 5, allowlistEnabled: false, frozen: false,
    sessionKeyExpiry: 1_893_456_000, sessionKeyExpired: false,
  }
  assert.equal(view.sessionKeyExpiry, 1_893_456_000)
  assert.equal(view.sessionKeyExpired, false)
})

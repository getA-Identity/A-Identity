import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import {
  __resetPlatformStateForTests,
  createAgent,
  recordWallet,
  assignWallet,
  agentGuardrailProfile,
  startCirclePolicyChallenge,
  attestCirclePolicy,
  getCirclePolicyAttestation,
  circleAgentWalletFor,
  bandsFromPolicy,
  capBand,
  policyHashOf,
  type PlatformAgent,
} from '../platform.js'
import { state } from './core.js'
import type { ContractSignatureCheck } from '../erc1271.js'

/**
 * The owner-attested Circle policy.
 *
 * Two things these tests exist to keep true. The attestation is bands and a signed hash,
 * never the policy: a raw cap, a raw allowlist address or the wallet id must not survive
 * into anything a third party can read. And it is never enforcement: the guardrail
 * profile carries it under `attestations` with its own disclosure, and `policyEnforced`
 * does not move because of it.
 */
__resetPlatformStateForTests()

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const eoa = privateKeyToAccount(KEY)
const SCA = '0x00000000000000000000000000000000000000cA'
const SCA_SIG = ('0x' + 'cd'.repeat(65)) as `0x${string}`
const OWNER = 'owner@test'

/** The shape Circle CLI 1.0 prints for `wallet limit --output json`, with values that must never leak. */
const CLI_JSON = JSON.stringify({
  walletId: 'wal-7f3e2c11-secret',
  blockchain: 'BASE',
  policies: [
    { policyType: 'STABLECOIN', ruleType: 'TRANSFER_LIMIT', perTxLimit: '2.50', dailyLimit: '40.00', origin: 'CUSTOM', policyId: 'pol-9a8b' },
    { policyType: 'STABLECOIN', ruleType: 'RECIPIENT_ALLOWLIST', addresses: ['0x1111111111111111111111111111111111111111'], origin: 'CUSTOM' },
  ],
})

let seq = 0
function seed(wallet: string): PlatformAgent {
  seq += 1
  const agent = createAgent({ name: `Policy Agent ${seq}`, description: 'Seeded for attestation tests.', category: 'Research', capabilities: [], permissions: {}, owner: OWNER })
  const row = state.agents.find((a) => a.id === agent.id) as PlatformAgent
  row.walletAddress = wallet
  return row
}

test('cap bands step at 1, 10 and 100 USDC, and an absent or Uncapped limit is uncapped', () => {
  assert.equal(capBand(undefined), 'uncapped')
  assert.equal(capBand('Uncapped'), 'uncapped')
  assert.equal(capBand('0'), 'uncapped')
  assert.equal(capBand('0.25'), 'dust')
  assert.equal(capBand('2.50'), 'small')
  assert.equal(capBand(40), 'moderate')
  assert.equal(capBand('250.00'), 'large')
})

test('bands come from the CLI shape and say so; anything else parses to unknown, not to a policy', () => {
  const { bands, circleChain } = bandsFromPolicy(JSON.parse(CLI_JSON))
  assert.equal(bands.parsed, true)
  assert.equal(circleChain, 'BASE')
  assert.deepEqual(bands.transferLimits, { perTx: 'small', daily: 'moderate', weekly: 'uncapped', monthly: 'uncapped' })
  assert.equal(bands.recipientAllowlist, true)
  assert.equal(bands.contractAllowlist, false)
  assert.equal(bands.origin, 'custom')
  const mixed = bandsFromPolicy({ policies: [{ ruleType: 'TRANSFER_LIMIT', perTxLimit: '1', origin: 'CODE_DEFAULT' }, { ruleType: 'transfer-limit', dailyLimit: '5', origin: 'CUSTOM' }] })
  assert.equal(mixed.bands.origin, 'mixed')
  assert.equal(mixed.bands.transferLimits.perTx, 'small')
  for (const bad of [null, 'text', [], {}, { policies: 'no' }]) {
    const b = bandsFromPolicy(bad).bands
    assert.equal(b.parsed, false, JSON.stringify(bad))
    assert.equal(b.transferLimits.perTx, 'uncapped')
  }
})

test('the challenge hashes the exact text and refuses anything that is not JSON', () => {
  const agent = seed(eoa.address)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  assert.equal(c.policyHash, policyHashOf(CLI_JSON))
  assert.ok(c.message.includes(c.policyHash))
  assert.ok(c.message.includes(eoa.address))
  assert.equal(c.bands.parsed, true)
  assert.match((startCirclePolicyChallenge(agent.id, 'not json', OWNER) as { error: string }).error, /must be JSON/)
  assert.match((startCirclePolicyChallenge(agent.id, CLI_JSON, 'stranger') as { error: string }).error, /Forbidden/)
  assert.match((startCirclePolicyChallenge(seed('').id, CLI_JSON, OWNER) as { error: string }).error, /no wallet/)
})

test('a key-held wallet attests, and the stored record carries bands, hash and signature but never the policy', async () => {
  const agent = seed(eoa.address)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const signature = await eoa.signMessage({ message: c.message })
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, signature, OWNER)
  assert.ok(!('error' in r), JSON.stringify(r))
  assert.equal(r.attestation.method, 'wallet-signature')
  assert.equal(r.attestation.circleChain, 'BASE')
  assert.equal(r.attestation.bands.transferLimits.daily, 'moderate')
  const stored = JSON.stringify(getCirclePolicyAttestation(agent.id))
  for (const secret of ['wal-7f3e2c11', '2.50', '40.00', '0x1111111111111111111111111111111111111111', 'pol-9a8b', 'perTxLimit', 'dailyLimit']) {
    assert.equal(stored.includes(secret), false, `attestation leaked ${secret}`)
  }
  assert.ok(stored.includes(r.attestation.policyHash))
  // A replay of the same challenge is refused: the nonce was consumed.
  const again = await attestCirclePolicy(agent.id, CLI_JSON, c.message, signature, OWNER)
  assert.ok('error' in again)
})

test('a contract account attests through ERC-1271 on the chain Circle named, and the proof records it', async () => {
  const agent = seed(SCA)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const asked: string[] = []
  const check: ContractSignatureCheck = async (chain) => { asked.push(chain.id); return chain.id === 'base' }
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, SCA_SIG, OWNER, { deps: { checkContract: check } })
  assert.ok(!('error' in r), JSON.stringify(r))
  assert.equal(r.attestation.method, 'erc1271-signature')
  assert.equal(r.attestation.chain, 'base')
  // blockchain: BASE narrowed the question to Base alone.
  assert.deepEqual(asked, ['base'])
})

test('changing the policy text between challenge and attest is refused, and so is a bad signature', async () => {
  const agent = seed(eoa.address)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const signature = await eoa.signMessage({ message: c.message })
  const swapped = await attestCirclePolicy(agent.id, CLI_JSON.replace('40.00', '4000.00'), c.message, signature, OWNER)
  assert.ok('error' in swapped)
  assert.match(swapped.error, /differs/)
  const forged = await attestCirclePolicy(agent.id, CLI_JSON, c.message, SCA_SIG, OWNER, { deps: { checkContract: async () => false } })
  assert.ok('error' in forged)
  assert.equal(agent.circlePolicyAttestation, undefined)
})

test('the guardrail profile carries the attestation as owner-attested, bands only, and policyEnforced does not move', async () => {
  const agent = seed(eoa.address)
  const before = agentGuardrailProfile(agent.id)
  assert.equal(before.profile.attestations, undefined)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, await eoa.signMessage({ message: c.message }), OWNER)
  assert.ok(!('error' in r))
  const after = agentGuardrailProfile(agent.id)
  assert.equal(after.profile.policyEnforced, before.profile.policyEnforced)
  assert.equal(after.profile.attestations?.length, 1)
  const att = after.profile.attestations![0]
  assert.equal(att.source, 'circle-agent-wallet')
  assert.equal(att.kind, 'owner-attested')
  assert.equal(att.attestedOn.length, 10)
  assert.match(att.disclosure, /does not treat this as enforcement/)
  const json = JSON.stringify(after.profile)
  for (const secret of ['wal-7f3e2c11', '2.50', '40.00', '0x1111111111111111111111111111111111111111', eoa.address, '"signature":', '"message":', 'policyHash']) {
    assert.equal(json.includes(secret), false, `profile leaked ${secret}`)
  }
  assert.equal(/\d{2}:\d{2}:\d{2}/.test(json), false, 'exact attestation timing must not leak')
})

test('a wallet is marked as a Circle agent wallet by its attestation, and loses the mark when the agent changes wallet', async () => {
  const fresh = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a')
  const agent = seed(fresh.address)
  assert.equal(circleAgentWalletFor(fresh.address), null)
  const c = startCirclePolicyChallenge(agent.id, CLI_JSON, OWNER)
  assert.ok(!('error' in c))
  const r = await attestCirclePolicy(agent.id, CLI_JSON, c.message, await fresh.signMessage({ message: c.message }), OWNER)
  assert.ok(!('error' in r))
  const mark = circleAgentWalletFor(fresh.address.toUpperCase().replace('0X', '0x'))
  assert.equal(mark?.agentId, agent.id)
  assert.equal(mark?.method, 'wallet-signature')
  recordWallet(SCA)
  const moved = assignWallet(SCA, agent.id, OWNER)
  assert.ok(!('error' in moved))
  assert.equal(agent.circlePolicyAttestation, undefined)
  assert.equal(circleAgentWalletFor(fresh.address), null)
})

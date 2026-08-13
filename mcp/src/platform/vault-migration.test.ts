import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateAgentVaults, type PlatformAgent } from './core.js'

/**
 * The vault migration runs once per boot over LIVE data, so the three properties that
 * matter are the three that cannot be checked afterwards: it backfills, it does not do it
 * twice, and it invents nothing.
 */

const ARC = 'eip155:5042002'
const OTHER = 'eip155:8453'

function agent(over: Partial<PlatformAgent> = {}): PlatformAgent {
  return {
    id: 'agent_1', name: 'A', description: '', category: 'Other', capabilities: [], services: [],
    permissions: { dailyCapUsd: 10, autoApproveUnderUsd: 1, payeeAllowlist: [], agentToAgent: false, agentToHuman: false, frozen: false },
    walletAddress: null, chain: 'arc', chainId: 1, kya: 'unverified', onchain: 'queued',
    passport: { standard: 'ERC-8004', registrationJson: {} }, followers: [], activity: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as PlatformAgent
}

test('a flat vault is backfilled onto the multichain fields', () => {
  const a = agent({
    vaultAddress: '0xAbC0000000000000000000000000000000000001',
    vaultExplorer: 'https://example.test/address/0xAbC0000000000000000000000000000000000001',
    vaultOwner: '0x0000000000000000000000000000000000000010',
    vaultOperator: '0x0000000000000000000000000000000000000011',
  })
  const touched = migrateAgentVaults([a], ARC)
  assert.equal(touched, 1)
  assert.equal(a.vaultChainCaip2, ARC)
  assert.equal(a.vaults?.length, 1)
  assert.deepEqual(a.vaults?.[0], {
    chainCaip2: ARC,
    address: a.vaultAddress,
    explorer: a.vaultExplorer,
    owner: a.vaultOwner,
    operator: a.vaultOperator,
    // An inference, and labelled as one. We did not watch this deploy.
    source: 'migrated',
  })
  // The primary stays exactly where every read path expects it.
  assert.equal(a.vaultAddress, '0xAbC0000000000000000000000000000000000001')
})

test('running it twice changes nothing', () => {
  const a = agent({ vaultAddress: '0xAbC0000000000000000000000000000000000001' })
  assert.equal(migrateAgentVaults([a], ARC), 1)
  const after = JSON.stringify(a)
  assert.equal(migrateAgentVaults([a], ARC), 0, 'the second run must report zero, not repeat the work')
  assert.equal(migrateAgentVaults([a], ARC), 0)
  assert.equal(JSON.stringify(a), after)
})

test('an agent with no vault gets no vault invented for it', () => {
  const a = agent()
  assert.equal(migrateAgentVaults([a], ARC), 0)
  assert.equal(a.vaultChainCaip2, undefined)
  assert.equal(a.vaults, undefined, 'an empty array would still be a claim that we looked and found none')
})

test('an already-migrated agent on another chain is left alone', () => {
  // Defensive rather than hypothetical: the day a second chain deploys vaults, this
  // migration is still in the boot path and must not reattribute them to Arc.
  const a = agent({
    vaultAddress: '0xAbC0000000000000000000000000000000000002',
    vaultChainCaip2: OTHER,
    vaults: [{ chainCaip2: OTHER, address: '0xAbC0000000000000000000000000000000000002', source: 'deployed' }],
  })
  assert.equal(migrateAgentVaults([a], ARC), 0)
  assert.equal(a.vaultChainCaip2, OTHER)
  assert.equal(a.vaults?.[0].source, 'deployed')
})

test('a case-different address is recognized as the same vault', () => {
  // Addresses come back checksummed from one path and lowercased from another; matching on
  // the raw string would append a duplicate on every boot.
  const a = agent({
    vaultAddress: '0xAbC0000000000000000000000000000000000003',
    vaultChainCaip2: ARC,
    vaults: [{ chainCaip2: ARC, address: '0xabc0000000000000000000000000000000000003', source: 'deployed' }],
  })
  assert.equal(migrateAgentVaults([a], ARC), 0)
  assert.equal(a.vaults?.length, 1)
})

test('a mixed roster migrates only the rows that need it', () => {
  const withVault = agent({ id: 'a1', vaultAddress: '0xAbC0000000000000000000000000000000000004' })
  const without = agent({ id: 'a2' })
  const done = agent({
    id: 'a3',
    vaultAddress: '0xAbC0000000000000000000000000000000000005',
    vaultChainCaip2: ARC,
    vaults: [{ chainCaip2: ARC, address: '0xAbC0000000000000000000000000000000000005', source: 'migrated' }],
  })
  assert.equal(migrateAgentVaults([withVault, without, done], ARC), 1)
})

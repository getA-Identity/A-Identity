/**
 * The hosted wallet as an agent's own wallet: an owner who never holds a key still gets a
 * wallet that shows a balance and can be paid, the test USDC it starts with is rationed from
 * stored records, and a vault is never given an owner nobody can act as. Circle is a function
 * the tests stand in for, so nothing here reaches a network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPlatformStateForTests, createAgent, provisionCircleWallet, hostedWalletStatus, provisionAgentVault,
} from '../platform.js'
import { STARTER_FUNDING_USD, STARTER_FUNDING_PER_OWNER, STARTER_FUNDING_DAILY_USD } from './vault.js'

const OWNER = 'owner@example.test'
const HOSTED = '0x1111111111111111111111111111111111111111'
const OWN = '0x2222222222222222222222222222222222222222'

function agentOf(owner = OWNER, walletAddress?: string) {
  return createAgent({ name: 'Hosted', description: 'An agent seeded for a hosted wallet test.', category: 'Other', capabilities: [], permissions: {}, owner, ...(walletAddress ? { walletAddress } : {}) })
}

type CreateWallet = NonNullable<NonNullable<Parameters<typeof provisionCircleWallet>[2]>['createWallet']>

/** A stand-in for Circle that records how it was asked and funds exactly when told to. */
function circle(address = HOSTED) {
  const asked: { name: string; fund?: boolean }[] = []
  const createWallet: CreateWallet = async (input) => {
    asked.push({ name: input.name, fund: input.fund })
    return {
      provisioned: true,
      walletId: `wallet-${asked.length}`,
      walletAddress: address,
      blockchain: 'ARC-TESTNET',
      explorerUrl: `https://explorer.example.test/address/${address}`,
      funded: input.fund ? { amountUsd: STARTER_FUNDING_USD, txHash: `0x${'ab'.repeat(32)}`, explorerUrl: 'https://explorer.example.test/tx/0xab' } : null,
    }
  }
  return { asked, createWallet }
}

test('hosted wallet: an agent with no wallet gets the hosted address as its own, funded and remembered', async () => {
  const state = __resetPlatformStateForTests()
  const agent = agentOf()
  const { asked, createWallet } = circle()
  const r = await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, { createWallet })
  assert.ok(!('error' in r))
  assert.equal(r.primary, true)
  assert.equal(r.walletAddress, HOSTED)
  assert.equal(agent.walletAddress, HOSTED)
  assert.equal(agent.circleWalletAddress, HOSTED)
  assert.deepEqual(asked, [{ name: 'Hosted', fund: true }])
  assert.deepEqual(state.wallets.map((w) => [w.address, w.agentId]), [[HOSTED, agent.id]])
  assert.equal(agent.starterFunding?.amountUsd, STARTER_FUNDING_USD)
  assert.equal(agent.starterFunding?.address, HOSTED)
  // Proving control of a key is a different thing, and creating a wallet does not claim it.
  assert.equal(agent.kya, 'unverified')
})

test('hosted wallet: an agent that already holds its own wallet keeps it', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf(OWNER, OWN)
  const r = await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, circle())
  assert.ok(!('error' in r))
  assert.equal(r.primary, false)
  assert.equal(agent.walletAddress, OWN)
  assert.equal(agent.circleWalletAddress, HOSTED)
})

test('hosted wallet: without the primary flag it stays a second layer, as before', async () => {
  const state = __resetPlatformStateForTests()
  const agent = agentOf()
  const r = await provisionCircleWallet(agent.id, { caller: OWNER }, circle())
  assert.ok(!('error' in r))
  assert.equal(agent.walletAddress, null)
  assert.equal(state.wallets.length, 0)
})

test('hosted wallet: when Circle is not configured the reason comes back and nothing is stored', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf()
  const r = await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, {
    createWallet: async () => ({ provisioned: false, reason: 'Circle Agent Wallets not configured.' }),
  })
  assert.deepEqual(r, { error: 'Circle Agent Wallets not configured.' })
  assert.equal(agent.walletAddress, null)
  assert.equal(agent.circleWalletId, undefined)
  assert.equal(agent.starterFunding, undefined)
  // The refused attempt holds nothing: the same agent can be provisioned afterwards.
  const again = await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, circle())
  assert.ok(!('error' in again))
})

test('hosted wallet: only the owner can create it, and only once', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf()
  const { asked, createWallet } = circle()
  assert.match((await provisionCircleWallet(agent.id, { caller: 'someone@example.test', primary: true }, { createWallet }) as { error: string }).error, /not the agent owner/)
  assert.match((await provisionCircleWallet(agent.id, { primary: true }, { createWallet }) as { error: string }).error, /not the agent owner/)
  assert.equal(asked.length, 0)
  await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, { createWallet })
  assert.match((await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, { createWallet }) as { error: string }).error, /already has a Circle Agent Wallet/)
  assert.equal(asked.length, 1)
})

test('hosted wallet: a second request while the first is in flight creates nothing', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf()
  let release: () => void = () => {}
  let calls = 0
  const slow: CreateWallet = async (input) => {
    calls++
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return circle().createWallet(input, process.env)
  }
  const first = provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, { createWallet: slow })
  const second = await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, { createWallet: slow })
  assert.match((second as { error: string }).error, /already being created/)
  release()
  assert.ok(!('error' in (await first)))
  assert.equal(calls, 1)
})

test('hosted wallet: starter funding stops at the per-account ceiling, and the wallet is still created', async () => {
  __resetPlatformStateForTests()
  const { asked, createWallet } = circle()
  for (let i = 0; i < STARTER_FUNDING_PER_OWNER; i++) {
    const r = await provisionCircleWallet(agentOf().id, { caller: OWNER, primary: true }, { createWallet })
    assert.ok(!('error' in r) && r.funded && 'txHash' in r.funded)
  }
  const extra = agentOf()
  const r = await provisionCircleWallet(extra.id, { caller: OWNER, primary: true }, { createWallet })
  assert.ok(!('error' in r))
  assert.equal(asked[asked.length - 1].fund, false)
  assert.equal(extra.walletAddress, HOSTED)
  assert.equal(extra.starterFunding, undefined)
  assert.match((r.funded as { error: string }).error, /already received starter funding/)
  // Another account is not held to this account's count.
  const other = await provisionCircleWallet(agentOf('other@example.test').id, { caller: 'other@example.test', primary: true }, { createWallet })
  assert.ok(!('error' in other) && other.funded && 'txHash' in other.funded)
})

test('hosted wallet: starter funding stops at the daily ceiling, counted from stored records', async () => {
  const state = __resetPlatformStateForTests()
  const slots = Math.floor(STARTER_FUNDING_DAILY_USD / STARTER_FUNDING_USD)
  const at = new Date().toISOString()
  for (let i = 0; i < slots; i++) {
    agentOf(`funded-${i}@example.test`).starterFunding = { address: HOSTED, amountUsd: STARTER_FUNDING_USD, txHash: '0x00', explorerUrl: 'x', at }
  }
  const late = agentOf('late@example.test')
  const { asked, createWallet } = circle()
  const r = await provisionCircleWallet(late.id, { caller: 'late@example.test', primary: true }, { createWallet })
  assert.ok(!('error' in r))
  assert.equal(asked[0].fund, false)
  assert.match((r.funded as { error: string }).error, /used up for today/)
  assert.equal(hostedWalletStatus('late@example.test').starterFunding.available, false)

  // Yesterday's funding does not count against today.
  for (const a of state.agents) if (a.starterFunding) a.starterFunding.at = '2020-01-01T00:00:00.000Z'
  const next = agentOf('next@example.test')
  const funded = await provisionCircleWallet(next.id, { caller: 'next@example.test', primary: true }, { createWallet })
  assert.ok(!('error' in funded) && funded.funded && 'txHash' in funded.funded)
})

test('hosted wallet: an owner who asks for no funding gets none, with no refusal to explain', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf()
  const { asked, createWallet } = circle()
  const r = await provisionCircleWallet(agent.id, { caller: OWNER, primary: true, fund: false }, { createWallet })
  assert.ok(!('error' in r))
  assert.equal(asked[0].fund, false)
  assert.equal(r.funded, null)
})

test('hosted wallet: a funding transfer that fails is said plainly, with its cause kept beside it', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf()
  const r = await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, {
    createWallet: async (input) => ({ ...(await circle().createWallet(input, process.env)), funded: { error: 'No ARC_SIGNER_KEY set.' } }),
  })
  assert.ok(!('error' in r))
  // The wallet exists and is the agent's wallet; only the funding did not arrive.
  assert.equal(agent.walletAddress, HOSTED)
  assert.equal(agent.starterFunding, undefined)
  const funded = r.funded as { error: string; detail?: string }
  assert.match(funded.error, /could not be sent just now/)
  assert.ok(!funded.error.includes('ARC_SIGNER_KEY'), 'the owner is not shown an env var name')
  assert.equal(funded.detail, 'No ARC_SIGNER_KEY set.')
})

test('hosted wallet: the status says what it is before anything is created', () => {
  __resetPlatformStateForTests()
  const keys = ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET'] as const
  const saved = keys.map((k) => process.env[k])
  try {
    for (const k of keys) delete process.env[k]
    const off = hostedWalletStatus(OWNER)
    assert.equal(off.configured, false)
    assert.equal(off.testnet, true)
    assert.deepEqual(off.starterFunding, { amountUsd: STARTER_FUNDING_USD, available: true })
    assert.match(off.custody, /Circle holds the key/)
    for (const k of keys) process.env[k] = 'set-for-a-test'
    assert.equal(hostedWalletStatus(OWNER).configured, true)
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])))
  }
})

test('hosted wallet: it is never the owner of a vault, because it can sign no owner call', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf()
  await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, circle())
  assert.equal(agent.walletAddress, HOSTED)
  // An email session names no address, and the agent's only wallet is hosted: no owner is left.
  const r = await provisionAgentVault(agent.id, { caller: OWNER })
  assert.match((r as { error: string }).error, /Provide an ownerAddress/)
  assert.equal(agent.vaultAddress, undefined)
})

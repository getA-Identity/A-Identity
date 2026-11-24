/**
 * The hosted wallet as an agent's own wallet: an owner who never holds a key still gets a
 * wallet that shows a balance and can be paid, the test USDC it starts with is rationed from
 * stored records, and a vault is never given an owner nobody can act as. Circle is a function
 * the tests stand in for, so nothing here reaches a network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetPlatformStateForTests, createAgent, provisionCircleWallet, hostedWalletStatus, provisionAgentVault, sendStarterFunding,
} from '../platform.js'
import { retiredAddresses } from '../chains/retired.js'
import { STARTER_FUNDING_USD, STARTER_FUNDING_PER_OWNER, STARTER_FUNDING_DAILY_USD } from './vault.js'
import { circleWalletName } from '../circle-agent.js'

const OWNER = 'owner@example.test'
const HOSTED = '0x1111111111111111111111111111111111111111'
const SIGNER = '0x3333333333333333333333333333333333333333'
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
  assert.equal((await hostedWalletStatus('late@example.test', { signerAddress: async () => SIGNER })).starterFunding.available, false)

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

test('hosted wallet: the status says what it is before anything is created', async () => {
  __resetPlatformStateForTests()
  const keys = ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET'] as const
  const saved = keys.map((k) => process.env[k])
  const withSigner = { signerAddress: async () => SIGNER }
  try {
    for (const k of keys) delete process.env[k]
    const off = await hostedWalletStatus(OWNER, withSigner)
    assert.equal(off.configured, false)
    assert.equal(off.testnet, true)
    assert.deepEqual(off.starterFunding, { amountUsd: STARTER_FUNDING_USD, available: true })
    assert.match(off.custody, /Circle holds the key/)
    for (const k of keys) process.env[k] = 'set-for-a-test'
    assert.equal((await hostedWalletStatus(OWNER, withSigner)).configured, true)
    // No usable signer means no funding to send, and the status does not promise any.
    const noSigner = await hostedWalletStatus(OWNER, { signerAddress: async () => null })
    assert.equal(noSigner.starterFunding.available, false)
    assert.match(noSigner.starterFunding.reason ?? '', /not available on this server/)
    const broken = await hostedWalletStatus(OWNER, { signerAddress: async () => { throw new Error('bad key') } })
    assert.equal(broken.starterFunding.available, false)
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])))
  }
})

test('hosted wallet: funding that was sent but not yet confirmed is kept, said as it is, and counted', async () => {
  __resetPlatformStateForTests()
  const pending: CreateWallet = async (input) => ({
    ...(await circle().createWallet(input, process.env)),
    funded: input.fund ? { amountUsd: STARTER_FUNDING_USD, txHash: `0x${'cd'.repeat(32)}`, explorerUrl: 'https://explorer.example.test/tx/0xcd', unconfirmed: true as const } : null,
  })
  const first = agentOf()
  const r = await provisionCircleWallet(first.id, { caller: OWNER, primary: true }, { createWallet: pending })
  assert.ok(!('error' in r))
  // Not a failure: the money may have moved, so the owner is not told to fund it again.
  assert.ok(r.funded && 'txHash' in r.funded && r.funded.unconfirmed === true)
  assert.equal(first.starterFunding?.unconfirmed, true)
  assert.match(first.activity[first.activity.length - 1].text, /waiting for its receipt/)
  // It takes a slot of the per-account ceiling like a confirmed one.
  await provisionCircleWallet(agentOf().id, { caller: OWNER, primary: true }, { createWallet: pending })
  const third = await provisionCircleWallet(agentOf().id, { caller: OWNER, primary: true }, { createWallet: pending })
  assert.ok(!('error' in third))
  assert.match((third.funded as { error: string }).error, /already received starter funding/)
})

test('hosted wallet: requests made at the same moment cannot each take the last slot of the per-account ceiling', async () => {
  __resetPlatformStateForTests()
  const gates: (() => void)[] = []
  const asked: boolean[] = []
  const slow: CreateWallet = async (input) => {
    asked.push(Boolean(input.fund))
    await new Promise<void>((resolve) => gates.push(resolve))
    return circle().createWallet(input, process.env)
  }
  const agents = Array.from({ length: STARTER_FUNDING_PER_OWNER + 1 }, () => agentOf())
  const running = agents.map((a) => provisionCircleWallet(a.id, { caller: OWNER, primary: true }, { createWallet: slow }))
  await new Promise((resolve) => setImmediate(resolve))
  gates.forEach((open) => open())
  const results = await Promise.all(running)
  assert.ok(results.every((r) => !('error' in r)))
  assert.equal(asked.filter(Boolean).length, STARTER_FUNDING_PER_OWNER, 'only as many as the ceiling allows were asked to fund')
  assert.equal(agents.filter((a) => a.starterFunding).length, STARTER_FUNDING_PER_OWNER)
})

type Send = NonNullable<NonNullable<Parameters<typeof sendStarterFunding>[2]>['send']>
const signerIs = { signerAddress: async () => SIGNER }

/** A stand-in for the transfer that records what it was asked to send. */
function sender(result: 'executed' | 'unconfirmed' | 'prepared' = 'executed') {
  const sent: { to: string; amountUsd: number }[] = []
  const send = (async (to: string, amountUsd: number) => {
    sent.push({ to, amountUsd })
    const txHash = `0x${'ef'.repeat(32)}`
    const explorerUrl = 'https://explorer.example.test/tx/0xef'
    if (result === 'executed') return { executed: true, txHash, explorerUrl }
    if (result === 'unconfirmed') return { executed: false, reverted: false, unconfirmed: true, txHash, explorerUrl, reason: 'broadcast, no receipt yet' }
    return { executed: false, contract: '0x0', function: 'transfer(address to, uint256 amount)', args: [to, String(amountUsd)], reason: 'No ARC_SIGNER_KEY set.' }
  }) as unknown as Send
  return { sent, send }
}

test('starter funding: a wallet whose owner holds the key is funded once, and only once', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf(OWNER, OWN)
  const { sent, send } = sender()
  const first = await sendStarterFunding(agent.id, { caller: OWNER }, { send, ...signerIs })
  assert.ok(!('error' in first))
  assert.deepEqual(sent, [{ to: OWN, amountUsd: STARTER_FUNDING_USD }])
  assert.equal(agent.starterFunding?.address, OWN)
  assert.equal(agent.starterFunding?.unconfirmed, undefined)
  assert.match(agent.activity[agent.activity.length - 1].text, /Starter funding: .* test USDC arrived/)
  // Asked again: the same record comes back and nothing more is sent.
  const again = await sendStarterFunding(agent.id, { caller: OWNER }, { send, ...signerIs })
  assert.ok(!('error' in again) && again.already === true)
  assert.equal(sent.length, 1)
})

test('starter funding: with no signer nothing is sent and nothing is recorded, so it can be asked again later', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf(OWNER, OWN)
  const none = sender('prepared')
  const r = await sendStarterFunding(agent.id, { caller: OWNER }, { send: none.send, signerAddress: async () => null })
  assert.ok(!('error' in r))
  const funded = r.funded as { error: string; detail?: string }
  assert.match(funded.error, /could not be sent just now/)
  assert.equal(funded.detail, 'No ARC_SIGNER_KEY set.')
  assert.equal(agent.starterFunding, undefined)
  const later = sender()
  const ok = await sendStarterFunding(agent.id, { caller: OWNER }, { send: later.send, ...signerIs })
  assert.ok(!('error' in ok) && ok.funded && 'txHash' in ok.funded)
  assert.equal(later.sent.length, 1)
})

test('starter funding: a transfer with no receipt yet is kept and never sent a second time', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf(OWNER, OWN)
  const { sent, send } = sender('unconfirmed')
  const r = await sendStarterFunding(agent.id, { caller: OWNER }, { send, ...signerIs })
  assert.ok(!('error' in r) && r.funded && 'txHash' in r.funded && r.funded.unconfirmed === true)
  assert.equal(agent.starterFunding?.unconfirmed, true)
  await sendStarterFunding(agent.id, { caller: OWNER }, { send, ...signerIs })
  assert.equal(sent.length, 1)
})

test('starter funding: refused for someone else, for no wallet, for a reused, retired or signer address, and past the ceiling', async () => {
  __resetPlatformStateForTests()
  const { sent, send } = sender()
  const deps = { send, ...signerIs }
  const mine = agentOf(OWNER, OWN)
  assert.match((await sendStarterFunding(mine.id, { caller: 'someone@example.test' }, deps) as { error: string }).error, /not the agent owner/)
  assert.match((await sendStarterFunding(mine.id, {}, deps) as { error: string }).error, /not the agent owner/)
  assert.match((await sendStarterFunding(agentOf().id, { caller: OWNER }, deps) as { error: string }).error, /no wallet to fund/)
  assert.match((await sendStarterFunding(agentOf(OWNER, retiredAddresses()[0]).id, { caller: OWNER }, deps) as { error: string }).error, /retired/)
  assert.match((await sendStarterFunding(agentOf(OWNER, SIGNER).id, { caller: OWNER }, deps) as { error: string }).error, /server signer/)
  assert.equal(sent.length, 0)

  await sendStarterFunding(mine.id, { caller: OWNER }, deps)
  assert.equal(sent.length, 1)
  // The same address under a second agent is not a second wallet.
  const twin = await sendStarterFunding(agentOf(OWNER, OWN).id, { caller: OWNER }, deps)
  assert.match(((twin as { funded: { error: string } }).funded).error, /already received starter funding through another agent/)
  // The per-account ceiling is shared with hosted wallets.
  await sendStarterFunding(agentOf(OWNER, '0x4444444444444444444444444444444444444444').id, { caller: OWNER }, deps)
  const over = await sendStarterFunding(agentOf(OWNER, '0x5555555555555555555555555555555555555555').id, { caller: OWNER }, deps)
  assert.match(((over as { funded: { error: string } }).funded).error, /already received starter funding for/)
  assert.equal(sent.length, STARTER_FUNDING_PER_OWNER)
})

test('starter funding: a hosted wallet that started empty can be funded afterwards, once', async () => {
  __resetPlatformStateForTests()
  const agent = agentOf()
  await provisionCircleWallet(agent.id, { caller: OWNER, primary: true }, {
    createWallet: async (input) => ({ ...(await circle().createWallet(input, process.env)), funded: { error: 'No ARC_SIGNER_KEY set.' } }),
  })
  assert.equal(agent.starterFunding, undefined)
  const { sent, send } = sender()
  const r = await sendStarterFunding(agent.id, { caller: OWNER }, { send, ...signerIs })
  assert.ok(!('error' in r) && r.funded && 'txHash' in r.funded)
  assert.deepEqual(sent, [{ to: HOSTED, amountUsd: STARTER_FUNDING_USD }])
})

test('starter funding: an agent is funded once across both paths, and its record is never replaced', async () => {
  __resetPlatformStateForTests()
  // The owner's own key was funded when the agent was made.
  const agent = agentOf(OWNER, OWN)
  const { sent, send } = sender()
  await sendStarterFunding(agent.id, { caller: OWNER }, { send, ...signerIs })
  const first = agent.starterFunding
  assert.equal(first?.address, OWN)
  // A hosted wallet added afterwards starts empty, says why, and leaves the record alone.
  const { asked, createWallet } = circle()
  const r = await provisionCircleWallet(agent.id, { caller: OWNER }, { createWallet })
  assert.ok(!('error' in r))
  assert.deepEqual(asked, [{ name: 'Hosted', fund: false }])
  assert.match((r.funded as { error: string }).error, /goes to an agent once/)
  assert.deepEqual(agent.starterFunding, first)
  assert.equal(sent.length, 1)
  // So the address still counts as funded, and a second agent naming it gets nothing.
  const twin = agentOf(OWNER, OWN)
  const again = await sendStarterFunding(twin.id, { caller: OWNER }, { send, ...signerIs })
  assert.match(((again as { funded: { error: string } }).funded).error, /already received starter funding/)
  assert.equal(sent.length, 1)
})

test('starter funding: the two paths cannot both fund one agent at the same moment', async () => {
  __resetPlatformStateForTests()
  // A hosted wallet is being created, and funded, while the owner asks for funding by hand.
  const making = agentOf(OWNER, OWN)
  let letCircleAnswer = () => {}
  const held = new Promise<void>((resolve) => { letCircleAnswer = resolve })
  const slow = circle()
  const createWallet: CreateWallet = async (input) => {
    await held
    return slow.createWallet(input)
  }
  const provision = provisionCircleWallet(making.id, { caller: OWNER }, { createWallet })
  const { sent, send } = sender()
  const during = await sendStarterFunding(making.id, { caller: OWNER }, { send, ...signerIs })
  assert.match((during as { error: string }).error, /hosted wallet is being created/)
  assert.equal(sent.length, 0)
  letCircleAnswer()
  await provision
  assert.equal(making.starterFunding?.address, HOSTED)

  // The other way round: funding is on its way by hand while a hosted wallet is asked for.
  const paying = agentOf('second@example.test', '0x4444444444444444444444444444444444444444')
  let letTransferAnswer = () => {}
  const pending = new Promise<void>((resolve) => { letTransferAnswer = resolve })
  const slowSend = (async (to: string, amountUsd: number) => {
    await pending
    return send(to, amountUsd)
  }) as unknown as Send
  const funding = sendStarterFunding(paying.id, { caller: 'second@example.test' }, { send: slowSend, ...signerIs })
  // Let it pass its checks and reach the transfer.
  await new Promise((resolve) => setImmediate(resolve))
  const second = circle('0x5555555555555555555555555555555555555555')
  const r = await provisionCircleWallet(paying.id, { caller: 'second@example.test' }, { createWallet: second.createWallet })
  assert.ok(!('error' in r))
  assert.deepEqual(second.asked, [{ name: 'Hosted', fund: false }])
  letTransferAnswer()
  await funding
  assert.equal(paying.starterFunding?.address, '0x4444444444444444444444444444444444444444')
  assert.equal(sent.length, 1)
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

test('hosted wallet: the name Circle is given is one it takes, whatever the owner typed', () => {
  // The name that left a new account with no wallet on the live site, 2026-11-24.
  assert.equal(circleWalletName('Rehearsal Buyer (A-Identity team)'), 'Rehearsal Buyer A-Identity team')
  // Every mark Circle refused in that read goes, and what is left reads as one name.
  assert.equal(circleWalletName('a <b> *c*; {d} (e)'), 'a b c d e')
  // The marks it took stay, and so do letters of any alphabet.
  assert.equal(circleWalletName("Maya's bot, v1.2 & co: buy/sell +1 #2 me@x a-b_c"), "Maya's bot, v1.2 & co: buy/sell +1 #2 me@x a-b_c")
  assert.equal(circleWalletName('Meri\u00e7 ajan\u0131'), 'Meri\u00e7 ajan\u0131')
  // Never longer than Circle takes, counted the strict way for letters of more than one byte.
  assert.equal(circleWalletName('x'.repeat(80)), 'x'.repeat(50))
  assert.equal(circleWalletName('\u00e7'.repeat(80)), '\u00e7'.repeat(25))
  assert.equal(circleWalletName(`${'x'.repeat(49)} yz`), 'x'.repeat(49))
  // A name with nothing left in it still gets a label, and the agent id rides in refId.
  assert.equal(circleWalletName('(((())))'), 'A-Identity agent')
  assert.equal(circleWalletName('   '), 'A-Identity agent')
})

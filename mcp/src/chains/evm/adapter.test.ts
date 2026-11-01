import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEvmAdapter } from './adapter.js'
import { resolveRpcUrls, usdcUnits, fromUsdcUnits, txUrl, addressUrl } from './client.js'
import { ARC_CHAIN, getChainById } from '../registry.js'

// An env with no signer key - forces the prepared/no-key path deterministically,
// independent of whatever is in the real process env.
const NO_SIGNER: NodeJS.ProcessEnv = {}

test('createEvmAdapter rejects a non-EVM chain', () => {
  const stellar = getChainById('stellar')!
  assert.throws(() => createEvmAdapter(stellar))
})

test('usdcUnits / fromUsdcUnits round-trip at 6 decimals (Arc)', () => {
  assert.equal(usdcUnits(ARC_CHAIN, 1.5), 1_500_000n)
  assert.equal(usdcUnits(ARC_CHAIN, 0.05), 50_000n)
  assert.equal(fromUsdcUnits(ARC_CHAIN, 1_500_000n), 1.5)
})

test('resolveRpcUrls puts the primary first and honors the override env var', () => {
  const def = resolveRpcUrls(ARC_CHAIN, {})
  assert.equal(def[0], 'https://rpc.testnet.arc.io')
  assert.equal(def.length, 4)
  // The override REPLACES the primary (rpcUrls[0]); the 3 fallbacks stay. Same as the
  // original ARC_RPCS computation, so the length stays 4 and the old primary is gone.
  const overridden = resolveRpcUrls(ARC_CHAIN, { ARC_RPC_URL: 'https://my.node' })
  assert.equal(overridden[0], 'https://my.node')
  assert.equal(overridden.length, 4)
  assert.ok(!overridden.includes('https://rpc.testnet.arc.io'))
})

test('explorer link helpers use the descriptor explorer', () => {
  assert.equal(txUrl(ARC_CHAIN, '0xabc'), 'https://explorer.testnet.arc.io/tx/0xabc')
  assert.equal(addressUrl(ARC_CHAIN, '0xdef'), 'https://explorer.testnet.arc.io/address/0xdef')
})

test('without a signer, registerAgent returns the exact prepared ERC-8004 call', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.registerAgent('https://example/agent.json', NO_SIGNER)
  assert.equal(res.executed, false)
  // Assert it is PREPARED and not REVERTED. Both are `executed: false`, and without this
  // line a reverted result would skip the body below and the test would pass on nothing.
  assert.notEqual(res.reverted, true, 'with no signer nothing was broadcast, so it cannot have reverted')
  assert.ok('contract' in res, 'with no signer it is prepared, not unconfirmed')
  if ('contract' in res) {
    assert.equal(res.contract, '0x8004A818BFB912233c491871b3d84c89A494BD9e')
    assert.equal(res.function, 'register(string metadataURI)')
    assert.deepEqual(res.args, ['https://example/agent.json'])
  }
})

test('without a signer, payUsdc returns the exact prepared USDC transfer (6 decimals)', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.payUsdc('0x1111111111111111111111111111111111111111', 2.5, NO_SIGNER)
  assert.equal(res.executed, false)
  // Assert it is PREPARED and not REVERTED. Both are `executed: false`, and without this
  // line a reverted result would skip the body below and the test would pass on nothing.
  assert.notEqual(res.reverted, true, 'with no signer nothing was broadcast, so it cannot have reverted')
  assert.ok('contract' in res, 'with no signer it is prepared, not unconfirmed')
  if ('contract' in res) {
    assert.equal(res.contract, '0x3600000000000000000000000000000000000000')
    assert.equal(res.function, 'transfer(address to, uint256 amount)')
    assert.deepEqual(res.args, ['0x1111111111111111111111111111111111111111', '2500000'])
  }
})

test('without a signer, deployVault reports no-key (not reverted)', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.deployVault({ dailyCapUsd: 10, autoApproveUsd: 1 }, NO_SIGNER)
  assert.equal(res.executed, false)
  assert.equal(res.reverted, false)
})

test('without a signer, policyPay reports no-key (not reverted)', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.policyPay('0x2222222222222222222222222222222222222222', '0x1111111111111111111111111111111111111111', 1, NO_SIGNER)
  assert.equal(res.executed, false)
  if (res.executed === false) assert.equal(res.reverted, false)
})

test('without a signer, policySetSessionExpiry reports no-key (not reverted)', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.policySetSessionExpiry('0x2222222222222222222222222222222222222222', 1784411598, NO_SIGNER)
  assert.equal(res.executed, false)
  if (res.executed === false) assert.equal(res.reverted, false)
})

test('without a signer, runEscrowDemo returns the prepared lifecycle', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.runEscrowDemo({}, NO_SIGNER)
  assert.equal(res.executed, false)
  if (res.executed === false) {
    assert.equal(res.contract, '0x0747EEf0706327138c69792bF28Cd525089e4583')
    assert.equal(res.outcome, 'complete')
    assert.deepEqual(res.lifecycle, ['createJob', 'setBudget', 'approve(USDC)', 'fund', 'submit', 'complete'])
  }
})

test('runEscrowDemo with outcome=refund prepares a lifecycle that ends in reject', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.runEscrowDemo({ outcome: 'refund' }, NO_SIGNER)
  assert.equal(res.executed, false)
  if (res.executed === false) {
    assert.equal(res.outcome, 'refund')
    assert.deepEqual(res.lifecycle, ['createJob', 'setBudget', 'approve(USDC)', 'fund', 'submit', 'reject'])
  }
})

test('without a signer, rejectJob returns the exact prepared reject call', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.rejectJob(42n, 'bad deliverable', NO_SIGNER)
  assert.equal(res.executed, false)
  assert.ok('contract' in res) // prepared (not a revert) without a signer
  if (res.executed === false && 'contract' in res) {
    assert.equal(res.contract, '0x0747EEf0706327138c69792bF28Cd525089e4583')
    assert.equal(res.function, 'reject(uint256 jobId, bytes32 reason, bytes optParams)')
    assert.equal(res.args[0], '42')
    assert.match(res.args[1] as string, /^0x[0-9a-f]{64}$/) // reason hash
  }
})

test('without a signer, claimJobRefund returns the exact prepared claimRefund call', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.claimJobRefund(42n, NO_SIGNER)
  assert.equal(res.executed, false)
  assert.ok('contract' in res) // prepared (not a revert) without a signer
  if (res.executed === false && 'contract' in res) {
    assert.equal(res.contract, '0x0747EEf0706327138c69792bF28Cd525089e4583')
    assert.equal(res.function, 'claimRefund(uint256 jobId)')
    assert.deepEqual(res.args, ['42'])
  }
})

test('without a signer, payUsdcBatch returns the prepared Multicall3From call (Arc)', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.payUsdcBatch([
    { to: '0x1111111111111111111111111111111111111111', amountUsd: 0.01 },
    { to: '0x2222222222222222222222222222222222222222', amountUsd: 0.02 },
  ], NO_SIGNER)
  assert.equal(res.executed, false)
  assert.ok('contract' in res) // prepared, not a revert
  if (res.executed === false && 'contract' in res) {
    assert.equal(res.contract, '0x522fAf9A91c41c443c66765030741e4AaCe147D0')
    assert.match(res.function as string, /^aggregate3/)
  }
})

test('on a chain without Multicall3From, payUsdcBatch prepares a sequential transfer loop', async () => {
  const base = getChainById('base')! // no contracts.multicall3From
  const adapter = createEvmAdapter(base)
  const res = await adapter.payUsdcBatch([{ to: '0x1111111111111111111111111111111111111111', amountUsd: 0.01 }], NO_SIGNER)
  assert.equal(res.executed, false)
  if (res.executed === false && 'contract' in res) {
    assert.equal((res.contract as string).toLowerCase(), base.contracts.usdc!.toLowerCase())
    assert.match(res.function as string, /^transfer/)
  }
})

test('the adapter constructs for a planned EVM chain (Base)', () => {
  const base = getChainById('base')!
  const adapter = createEvmAdapter(base)
  assert.equal(adapter.chain.id, 'base')
})

test('a signer key is trimmed, and an unusable one is a clean no-op rather than a throw', async () => {
  // A key pasted into a hosting dashboard arrives with a trailing newline often enough
  // that this is the difference between a working rail and a 502 quoting viem's
  // "invalid private key" at someone who cannot act on it. That exact failure reached
  // production once. Garbage still yields null, which every write path already reports as
  // a labeled "no signer" rather than a crash.
  const { evmWalletClientFromKey } = await import('./client.js')
  const chain = getChainById('rhchain')!
  const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  const expected = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

  assert.equal((await evmWalletClientFromKey(chain, key))?.account.address, expected)
  assert.equal((await evmWalletClientFromKey(chain, `${key}\n`))?.account.address, expected, 'a trailing newline must not break a signer')
  assert.equal((await evmWalletClientFromKey(chain, ` ${key} `))?.account.address, expected)
  assert.equal((await evmWalletClientFromKey(chain, key.slice(2)))?.account.address, expected, 'a missing 0x prefix is not an error')
  assert.equal(await evmWalletClientFromKey(chain, 'not-a-key'), null)
  assert.equal(await evmWalletClientFromKey(chain, '0xdeadbeef'), null)
  assert.equal(await evmWalletClientFromKey(chain, '   '), null)
})

// ── receipts come from every RPC, and no receipt is not a revert ─────────────────────

const VAULT = '0x2222222222222222222222222222222222222222'
const PAYEE = '0x1111111111111111111111111111111111111111'
const SENT = `0x${'5a'.repeat(32)}`
const HOST_A = 'https://a.rpc.test'
const HOST_B = 'https://b.rpc.test'

/** A signer and client that never touch a network, and one receipt per host. */
function scene(hosts: Record<string, unknown>, over: { simulateThrows?: Error } = {}) {
  const asked: string[] = []
  const counters = { writes: 0 }
  const adapter = createEvmAdapter(ARC_CHAIN, {
    publicClient: {
      simulateContract: async () => {
        if (over.simulateThrows) throw over.simulateThrows
        return { request: {} }
      },
    },
    walletClient: {
      account: { address: PAYEE },
      client: {
        writeContract: async () => { counters.writes += 1; return SENT },
        deployContract: async () => { counters.writes += 1; return SENT },
      },
    },
    receipts: {
      urls: Object.keys(hosts),
      pollMs: 1,
      timeoutMs: 0,
      call: async (url, _method, params) => {
        asked.push(url)
        const held = hosts[url]
        if (held instanceof Error) throw held
        return held ? { transactionHash: params[0], ...(held as object) } : null
      },
    },
  })
  return { adapter, asked, counters }
}

const MINED = { blockNumber: '0x9', status: '0x1', gasUsed: '0x5208', logs: [] }
const REVERTED = { ...MINED, status: '0x0' }

test('vaultWrite reads a null from the first host and a receipt from the second as executed', async () => {
  const s = scene({ [HOST_A]: null, [HOST_B]: MINED })
  const res = await s.adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.equal(res.executed, true)
  assert.deepEqual(s.asked, [HOST_A, HOST_B])
})

test('vaultWrite with no receipt on any host is unconfirmed with the hash, never reverted', async () => {
  const s = scene({ [HOST_A]: null, [HOST_B]: new Error('HTTP 503') })
  const res = await s.adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.equal(res.executed, false)
  if (res.executed) return
  assert.equal(res.reverted, false, 'a slow receipt is not a revert: that is how a payment went out twice')
  assert.ok('unconfirmed' in res)
  if ('unconfirmed' in res) {
    assert.equal(res.txHash, SENT)
    assert.ok(res.explorerUrl.includes(SENT))
    assert.match(res.reason, /may have landed/)
    assert.doesNotMatch(res.reason, /rpc\.test/, 'a host URL can carry a provider key')
  }
  assert.deepEqual(s.asked, [HOST_A, HOST_B])
  assert.equal(s.counters.writes, 1)
})

test('vaultWrite still reports a mined revert and a simulated refusal as reverted', async () => {
  const mined = await scene({ [HOST_A]: REVERTED }).adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.equal(mined.executed, false)
  if (!mined.executed) assert.equal(mined.reverted, true)

  const refused = scene({ [HOST_A]: MINED }, { simulateThrows: new Error('DailyCapExceeded') })
  const res = await refused.adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.equal(res.executed, false)
  if (!res.executed) assert.equal(res.reverted, true)
  assert.equal(refused.counters.writes, 0, 'a refused simulation broadcasts nothing')
  assert.deepEqual(refused.asked, [])
})

test('registerAgent reads every host, and no receipt is unconfirmed rather than a throw', async () => {
  const landed = scene({ [HOST_A]: null, [HOST_B]: MINED })
  const ok = await landed.adapter.registerAgent('https://example/agent.json', {})
  assert.equal(ok.executed, true)
  assert.deepEqual(landed.asked, [HOST_A, HOST_B])

  const res = await scene({ [HOST_A]: null, [HOST_B]: null }).adapter.registerAgent('https://example/agent.json', {})
  assert.equal(res.executed, false)
  assert.ok('unconfirmed' in res)
  if ('unconfirmed' in res) assert.equal(res.txHash, SENT)
})

test('deployVault reads every host, and no receipt is unconfirmed, not "no vault exists"', async () => {
  const contractAddress = '0x3333333333333333333333333333333333333333'
  const landed = scene({ [HOST_A]: null, [HOST_B]: { ...MINED, contractAddress } })
  const ok = await landed.adapter.deployVault({ dailyCapUsd: 10, autoApproveUsd: 1 }, {})
  assert.equal(ok.executed, true)
  if (ok.executed) assert.equal(ok.vault.toLowerCase(), contractAddress)
  assert.deepEqual(landed.asked, [HOST_A, HOST_B])

  const res = await scene({ [HOST_A]: null }).adapter.deployVault({ dailyCapUsd: 10, autoApproveUsd: 1 }, {})
  assert.equal(res.executed, false)
  assert.ok('unconfirmed' in res)
  if ('unconfirmed' in res) assert.doesNotMatch(res.reason, /no vault exists/)
})

test('the memo and batch settlements report no receipt as unconfirmed too', async () => {
  const memo = await scene({ [HOST_A]: null }).adapter.payUsdcWithMemo(PAYEE, 1, { agentId: 'a', instructionId: 'i', service: 'payment', policyDecision: 'auto_approved' }, {})
  assert.ok('unconfirmed' in memo)
  const batch = await scene({ [HOST_A]: null }).adapter.payUsdcBatch([{ to: PAYEE, amountUsd: 1 }], {})
  assert.ok('unconfirmed' in batch)
})

test('an escrow step with no receipt stops the lifecycle and is labeled unconfirmed, not reverted', async () => {
  const demo = await scene({ [HOST_A]: null }).adapter.runEscrowDemo({}, {})
  assert.equal(demo.executed, true)
  if (demo.executed) {
    assert.equal(demo.status, 'Unconfirmed')
    assert.equal(demo.unconfirmedTx, SENT)
    assert.equal(demo.failedAt, 'createJob')
  }
  const fund = await scene({ [HOST_A]: null }).adapter.fundEscrow({}, {})
  assert.ok('unconfirmed' in fund)
  const complete = await scene({ [HOST_A]: null }).adapter.completeEscrow(1n, {})
  assert.ok('unconfirmed' in complete)
})

test('one look at an earlier transaction says landed, reverted or unknown, and never fails', async () => {
  assert.equal((await scene({ [HOST_A]: null, [HOST_B]: MINED }).adapter.receiptStatus(SENT, {})).status, 'success')
  assert.equal((await scene({ [HOST_A]: REVERTED }).adapter.receiptStatus(SENT, {})).status, 'reverted')
  assert.equal((await scene({ [HOST_A]: null }).adapter.receiptStatus(SENT, {})).status, 'unknown')
  assert.equal((await scene({ [HOST_A]: new Error('HTTP 503') }).adapter.receiptStatus(SENT, {})).status, 'unknown')
  assert.equal((await scene({ [HOST_A]: null }).adapter.receiptStatus('not-a-hash', {})).status, 'unknown')
})

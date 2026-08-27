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
  assert.equal(def[0], 'https://rpc.testnet.arc.network')
  assert.equal(def.length, 4)
  // The override REPLACES the primary (rpcUrls[0]); the 3 fallbacks stay. Same as the
  // original ARC_RPCS computation, so the length stays 4 and the old primary is gone.
  const overridden = resolveRpcUrls(ARC_CHAIN, { ARC_RPC_URL: 'https://my.node' })
  assert.equal(overridden[0], 'https://my.node')
  assert.equal(overridden.length, 4)
  assert.ok(!overridden.includes('https://rpc.testnet.arc.network'))
})

test('explorer link helpers use the descriptor explorer', () => {
  assert.equal(txUrl(ARC_CHAIN, '0xabc'), 'https://testnet.arcscan.app/tx/0xabc')
  assert.equal(addressUrl(ARC_CHAIN, '0xdef'), 'https://testnet.arcscan.app/address/0xdef')
})

test('without a signer, registerAgent returns the exact prepared ERC-8004 call', async () => {
  const arc = createEvmAdapter(ARC_CHAIN)
  const res = await arc.registerAgent('https://example/agent.json', NO_SIGNER)
  assert.equal(res.executed, false)
  // Assert it is PREPARED and not REVERTED. Both are `executed: false`, and without this
  // line a reverted result would skip the body below and the test would pass on nothing.
  assert.notEqual(res.reverted, true, 'with no signer nothing was broadcast, so it cannot have reverted')
  if (res.executed === false && res.reverted !== true) {
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
  if (res.executed === false && res.reverted !== true) {
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

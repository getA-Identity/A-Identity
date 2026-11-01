import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWalletClient, custom, decodeFunctionData, defineChain, keccak256, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createEvmAdapter, SETTLEMENT_WAIT_CEILING_MS } from './adapter.js'
import { resolveRpcUrls, usdcUnits, fromUsdcUnits, txUrl, addressUrl } from './client.js'
import { ARC_CHAIN, getChainById } from '../registry.js'
import { AgentSpendPolicyAbi } from '../../contracts/AgentSpendPolicy.js'

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
const SIGNED = `0x02${'ab'.repeat(40)}` as `0x${string}`
/** The hash of what the fake signer signs, which is how a real one is known before the send. */
const SENT = keccak256(SIGNED)
const HOST_A = 'https://a.rpc.test'
const HOST_B = 'https://b.rpc.test'

/** A signer and client that never touch a network, and one receipt per host. */
function scene(
  hosts: Record<string, unknown>,
  over: { simulateThrows?: Error; prepareThrows?: Error; sendThrows?: Error; receipts?: Record<string, unknown> } = {},
) {
  const asked: string[] = []
  const counters = { writes: 0, sends: 0 }
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
        prepareTransactionRequest: async (req: Record<string, unknown>) => {
          if (over.prepareThrows) throw over.prepareThrows
          return req
        },
        signTransaction: async () => SIGNED,
        sendRawTransaction: async () => {
          counters.writes += 1
          counters.sends += 1
          if (over.sendThrows) throw over.sendThrows
          return SENT
        },
      },
    },
    receipts: {
      urls: Object.keys(hosts),
      pollMs: 1,
      ...(over.receipts ?? { timeoutMs: 0 }),
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

test('a send that throws after a node took it is unconfirmed under the signed hash, not a revert', async () => {
  // Host A accepted the raw transaction and lost the connection, and the fallback resent it to
  // host B, which says one of these. Reading that as a revert paid a second time on another rail.
  for (const said of ['already known', 'nonce too low: next nonce 8, tx nonce 7', 'The request took too long to respond']) {
    const s = scene({ [HOST_A]: MINED }, { sendThrows: new Error(said) })
    const res = await s.adapter.policyPay(VAULT, PAYEE, 1, {})
    assert.equal(res.executed, false)
    if (res.executed) continue
    assert.equal(res.reverted, false, said)
    assert.ok('unconfirmed' in res, said)
    if ('unconfirmed' in res) {
      assert.equal(res.txHash, SENT)
      assert.ok(res.explorerUrl.includes(SENT))
    }
    assert.deepEqual(s.asked, [], 'there is no receipt to wait for in this request')
  }
  // The same rule on the direct paths, where a revert is shown to a human who then re-approves.
  const memo = await scene({ [HOST_A]: MINED }, { sendThrows: new Error('already known') }).adapter.payUsdcWithMemo(PAYEE, 1, { agentId: 'a', instructionId: 'i', service: 'payment', policyDecision: 'auto_approved' }, {})
  assert.ok('unconfirmed' in memo)
  const batch = await scene({ [HOST_A]: MINED }, { sendThrows: new Error('already known') }).adapter.payUsdcBatch([{ to: PAYEE, amountUsd: 1 }], {})
  assert.ok('unconfirmed' in batch)
})

test('a node that turned the transaction away, or a failure before the send, is a refusal', async () => {
  const refused = scene({ [HOST_A]: null, [HOST_B]: null }, { sendThrows: new Error('insufficient funds for gas * price + value') })
  const res = await refused.adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.equal(res.executed, false)
  if (!res.executed) {
    assert.equal(res.reverted, true)
    assert.ok(!('minedTx' in res && res.minedTx), 'nothing was mined')
  }
  const estimate = scene({ [HOST_A]: MINED }, { prepareThrows: new Error('execution reverted') })
  const r2 = await estimate.adapter.payUsdcWithMemo(PAYEE, 1, { agentId: 'a', instructionId: 'i', service: 'payment', policyDecision: 'auto_approved' }, {})
  assert.equal(r2.executed, false)
  if (!r2.executed && 'reverted' in r2) assert.equal(r2.reverted, true)
  assert.equal(estimate.counters.sends, 0, 'estimation failed, so nothing was sent')
})

test('the hash is reported before the send and before any wait', async () => {
  const s = scene({ [HOST_A]: MINED })
  const order: string[] = []
  const hooks = { onBroadcast: (h: string) => { order.push(`hash:${h}:sends=${s.counters.sends}`) } }
  await s.adapter.policyPay(VAULT, PAYEE, 1, {}, hooks)
  await s.adapter.policyOwnerPay(VAULT, PAYEE, 1, {}, hooks)
  await s.adapter.payUsdcWithMemo(PAYEE, 1, { agentId: 'a', instructionId: 'i', service: 'payment', policyDecision: 'auto_approved' }, {}, hooks)
  await s.adapter.payUsdcBatch([{ to: PAYEE, amountUsd: 1 }], {}, hooks)
  assert.deepEqual(order, [0, 1, 2, 3].map((sends) => `hash:${SENT}:sends=${sends}`))
  // A hook that cannot note the hash stops the send: a hash nobody can find again is how a restart
  // pays twice. It is a refusal the caller can read, and not a thrown request.
  const stopped = scene({ [HOST_A]: MINED })
  const r = await stopped.adapter.policyPay(VAULT, PAYEE, 1, {}, { onBroadcast: async () => { throw new Error('disk full') } })
  assert.equal(stopped.counters.sends, 0, 'nothing is sent when the hold cannot be saved')
  assert.equal(r.executed, false)
  if (!r.executed) {
    assert.equal(r.reverted, true)
    assert.match(r.reason, /signed and not sent/)
    assert.match(r.reason, /disk full/)
  }
})

test('underpriced is a refusal only once every host has been asked for the hash', async () => {
  const underpriced = new Error('transaction underpriced')
  const pay = (s: ReturnType<typeof scene>) => s.adapter.policyPay(VAULT, PAYEE, 1, {})

  const nobody = await pay(scene({ [HOST_A]: null, [HOST_B]: null }, { sendThrows: underpriced }))
  assert.ok(!nobody.executed && 'reverted' in nobody && nobody.reverted, 'every host answered and none has it')

  // Host A took it before the connection dropped, and the fallback's resend heard this from B.
  const held = await pay(scene({ [HOST_A]: MINED, [HOST_B]: null }, { sendThrows: underpriced }))
  assert.ok('unconfirmed' in held, 'a host has it, so this was not turned away')
  if ('unconfirmed' in held) assert.equal(held.txHash, SENT)

  const unclear = await pay(scene({ [HOST_A]: null, [HOST_B]: new Error('HTTP 429') }, { sendThrows: underpriced }))
  assert.ok('unconfirmed' in unclear, 'a host that would not answer may be the one that has it')
})

test('a hold names what it was signed with, and a look can tell it can never land', async () => {
  const noted: unknown[] = []
  const FROM = '0x70997970C51812dc3A010C7d01b50e0aa8aF8aA9'
  const s = scene({ [HOST_A]: MINED })
  await s.adapter.policyPay(VAULT, PAYEE, 1, {}, { onBroadcast: (_h, signed) => { noted.push(signed) } })
  assert.deepEqual(noted, [{ nonce: undefined, from: PAYEE }])

  const held = { nonce: 7, from: FROM }
  const look = (hosts: Record<string, (method: string) => unknown>) =>
    createEvmAdapter(ARC_CHAIN, {
      receipts: {
        urls: Object.keys(hosts),
        call: async (url, method) => {
          const out = hosts[url](method)
          if (out instanceof Error) throw out
          return out
        },
      },
    }).receiptStatus(SENT, {}, held)
  const passed = (method: string) => (method === 'eth_getTransactionCount' ? '0x8' : null)

  const gone = await look({ [HOST_A]: passed, [HOST_B]: passed })
  assert.equal(gone.status, 'dropped', 'nonce passed on every host, and no host has it')
  if (gone.status === 'dropped') assert.match(gone.reason, /can never land/)

  // The same nonce not passed yet, on one host: it may still land.
  const lagging = await look({ [HOST_A]: passed, [HOST_B]: (m) => (m === 'eth_getTransactionCount' ? '0x7' : null) })
  assert.equal(lagging.status, 'unknown')
  // A host that will not answer may be the one that has it.
  assert.equal((await look({ [HOST_A]: passed, [HOST_B]: (m) => (m === 'eth_getTransactionCount' ? '0x8' : new Error('HTTP 429')) })).status, 'unknown')
  assert.equal((await look({ [HOST_A]: passed, [HOST_B]: () => new Error('HTTP 503') })).status, 'unknown')
  // Without what it was signed with, no receipt never means gone.
  const plain = await createEvmAdapter(ARC_CHAIN, { receipts: { urls: [HOST_A], call: async (_u, m) => passed(m) } }).receiptStatus(SENT, {})
  assert.equal(plain.status, 'unknown')
})

test('a mined vault revert names its transaction; a refused simulation has none', async () => {
  const mined = await scene({ [HOST_A]: REVERTED }).adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.equal(!mined.executed && 'minedTx' in mined ? mined.minedTx : null, SENT)
  const refused = await scene({ [HOST_A]: MINED }, { simulateThrows: new Error('RPC down') }).adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.ok(!('minedTx' in refused))
})

test('a settlement waits inside the proxy budget, and the wait ends unconfirmed', async () => {
  assert.ok(SETTLEMENT_WAIT_CEILING_MS <= 20_000, 'vercel.json cuts /api at about 30 seconds')
  let clock = 0
  const s = scene({ [HOST_A]: null }, {
    receipts: { now: () => clock, sleep: async (ms: number) => { clock += ms } },
  })
  const res = await s.adapter.policyPay(VAULT, PAYEE, 1, {})
  assert.ok('unconfirmed' in res)
  assert.ok(clock > 0, 'it did wait')
  assert.ok(clock <= SETTLEMENT_WAIT_CEILING_MS, `the wait took ${clock} ms`)
})

test('with a real viem wallet client the raw transaction is signed here, its hash is known first, and it says what was asked', async () => {
  // The other tests fake the three wallet calls, so this is what shows viem really does them this
  // way. No network: the transport answers each RPC method by hand.
  const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const sent: `0x${string}`[] = []
  const answers: Record<string, unknown> = {
    eth_chainId: `0x${ARC_CHAIN.evmChainId!.toString(16)}`,
    eth_getTransactionCount: '0x7',
    eth_estimateGas: '0x15f90',
    eth_gasPrice: '0x4a817c800',
    eth_maxPriorityFeePerGas: '0x3b9aca00',
    eth_getBlockByNumber: { baseFeePerGas: '0x4a817c800', number: '0x1', hash: `0x${'11'.repeat(32)}`, timestamp: '0x1', transactions: [] },
  }
  const client = createWalletClient({
    account,
    chain: defineChain({ id: ARC_CHAIN.evmChainId!, name: 'test', nativeCurrency: ARC_CHAIN.nativeCurrency, rpcUrls: { default: { http: [] } } }),
    transport: custom({
      request: async ({ method, params }: { method: string; params: unknown[] }) => {
        if (method === 'eth_sendRawTransaction') {
          sent.push(params[0] as `0x${string}`)
          return keccak256(params[0] as `0x${string}`)
        }
        if (method in answers) return answers[method]
        throw new Error(`no answer for ${method}`)
      },
    }),
  })
  const noted: string[] = []
  const adapter = createEvmAdapter(ARC_CHAIN, {
    publicClient: { simulateContract: async () => ({ request: {} }) },
    walletClient: { account, client },
    receipts: { urls: [HOST_A], timeoutMs: 0, call: async (_u, _m, p) => ({ transactionHash: p[0], ...MINED }) },
  })
  const res = await adapter.policyPay(VAULT, PAYEE, 1, {}, { onBroadcast: (h) => { noted.push(h) } })
  assert.equal(res.executed, true, JSON.stringify(res))
  assert.equal(sent.length, 1)
  const hash = keccak256(sent[0])
  assert.deepEqual(noted, [hash], 'the hash noted before the send is the hash of what was sent')
  if (res.executed) assert.equal(res.txHash, hash)
  const tx = parseTransaction(sent[0])
  assert.equal(tx.to?.toLowerCase(), VAULT.toLowerCase())
  assert.equal(tx.chainId, ARC_CHAIN.evmChainId)
  assert.equal(tx.nonce, 7)
  const call = decodeFunctionData({ abi: AgentSpendPolicyAbi, data: tx.data! })
  assert.equal(call.functionName, 'pay')
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

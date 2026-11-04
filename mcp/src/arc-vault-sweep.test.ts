import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeEventTopics, encodeFunctionData, encodeFunctionResult, getCreateAddress, type Abi, type Hex } from 'viem'
import { encodeCreationInput, type OurAddresses } from './arc-owner-vault.js'
import { admissionContext, admitVaultDeploy, runAdmission, type AdmissionContext, type RpcHost, type VaultAdmissionAnswer } from './arc-owner-vault-live.js'
import { ARC_VAULT_SWEEP_START_BLOCK } from './arc-season.js'
import { DEFAULT_SWEEP_LIMITS, createVaultSweep, liveVaultSweepDeps, runOnTimer, startVaultSweep, sweepAdmissionDeps, sweepConfig, vaultSweepStatus, type VaultSweepDeps } from './arc-vault-sweep.js'
import { handleArcSeasonRoutes } from './http/arc-season-routes.js'
import { AgentSpendPolicyAbi, AgentSpendPolicyBytecode } from './contracts/AgentSpendPolicy.js'
import { findAdmittedArcVaultByTx, loadAdmittedArcVaults, persistAdmittedArcVault, type ArcVaultStoreIo } from './storage.js'

/**
 * The sweep against a chain made of plain answers. What it holds: it finds a vault from the chain
 * alone and hands the hash to the same admission, an answer the server could not get is never a
 * verdict and never moves anything, and a flood costs time, not a real owner's place.
 */
const abi = AgentSpendPolicyAbi as unknown as Abi
const context = (admissionContext() as { ok: true; context: AdmissionContext }).context
const USDC = context.registryUsdc
const TOPIC = encodeEventTopics({ abi, eventName: 'SessionKeyExpirySet' })[0] as Hex
const USDC_CALL = encodeFunctionData({ abi, functionName: 'usdc' })
const OWNER_CALL = encodeFunctionData({ abi, functionName: 'owner' })
const EMPTY_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'
const START = 1000
const OWNER = '0x1111111111111111111111111111111111111111' as Hex
const OPERATOR = '0x2222222222222222222222222222222222222222'
const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
const hashOf = (n: number) => `0x${n.toString(16).padStart(64, 'a')}`
const num = (v: unknown) => Number(v)

/** One contract on the chain. Its log block is when the end date was set. */
type Contract = {
  address: string
  /** First block with code. */
  deployBlock: number
  logBlock: number
  /** The transaction that created it. Null: something else did, as a factory does. */
  deployTx: string | null
  from: Hex
  nonce: number
  usdc?: string
  owner?: string
}

function vaultAt(nonce: number, deployBlock: number, logBlock: number, from: Hex = OWNER, over: Partial<Contract> = {}): Contract {
  return { address: getCreateAddress({ from, nonce: BigInt(nonce) }).toLowerCase(), deployBlock, logBlock, deployTx: hashOf(nonce + 1), from, nonce, ...over }
}

class Chain {
  head = 500_000
  contracts: Contract[] = []
  /** Every read, as host method. */
  reads: string[] = []
  add(...c: Contract[]) {
    this.contracts.push(...c)
    return this
  }
  logs(from: number, to: number) {
    return this.contracts
      .filter((c) => c.logBlock >= from && c.logBlock <= to)
      .map((c) => ({ address: c.address, blockNumber: `0x${c.logBlock.toString(16)}`, topics: [TOPIC], transactionHash: hashOf(1) }))
  }
  code(address: string, block: number) {
    const c = this.contracts.find((x) => x.address === address.toLowerCase())
    return c && block >= c.deployBlock ? '0x6001' : '0x'
  }
  block(n: number) {
    const transactions = this.contracts
      .filter((c) => c.deployBlock === n && c.deployTx)
      .map((c) => ({ hash: c.deployTx, from: c.from, to: null, nonce: `0x${c.nonce.toString(16)}` }))
    // A call to something else in the same block, which is not a creation.
    const other = { hash: hashOf(999), from: OPERATOR, to: OWNER, nonce: '0x1' }
    return { number: `0x${n.toString(16)}`, transactions: [other, ...transactions], transactionsRoot: `0x${'ab'.repeat(32)}` }
  }
  /** One receipt per transaction: the logs hang off the call, with another topic beside them. */
  receipts(n: number) {
    const blockNumber = `0x${n.toString(16)}`
    return this.block(n).transactions.map((t, i) => ({
      transactionHash: t.hash,
      blockNumber,
      logs: i === 0 ? [{ address: OPERATOR, topics: [`0x${'cd'.repeat(32)}`] }, ...this.logs(n, n)] : [],
    }))
  }
}

/** What a real host does, changed by over for a host that does not. */
function host(chain: Chain, label: string, over: { maxSpan?: number; head?: number; on?: (method: string, params: readonly unknown[]) => unknown } = {}): RpcHost {
  return {
    label,
    request: async (method, params) => {
      chain.reads.push(`${label} ${method}`)
      const custom = over.on?.(method, params)
      if (custom !== undefined) {
        if (custom instanceof Error) throw custom
        return custom === 'null' ? null : custom
      }
      switch (method) {
        case 'eth_blockNumber':
          return `0x${(over.head ?? chain.head).toString(16)}`
        case 'eth_getLogs': {
          const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string }
          if (num(toBlock) - num(fromBlock) + 1 > (over.maxSpan ?? 100_000)) throw new Error('requested range too large')
          return chain.logs(num(fromBlock), num(toBlock))
        }
        case 'eth_getCode':
          return chain.code(params[0] as string, num(params[1]))
        case 'eth_getBlockByNumber':
          return chain.block(num(params[0]))
        case 'eth_getBlockReceipts':
          return chain.receipts(num(params[0]))
        case 'eth_call': {
          const { to, data } = params[0] as { to: string; data: string }
          const c = chain.contracts.find((x) => x.address === to)
          if (!c) return '0x'
          if (data === USDC_CALL) return word(c.usdc ?? USDC)
          if (data === OWNER_CALL) return word(c.owner ?? c.from)
          throw new Error('execution reverted')
        }
        default:
          throw new Error(`unexpected ${method}`)
      }
    },
  }
}

const admitted = (vault: string, deployTx: string): VaultAdmissionAnswer => ({ status: 'admitted', alreadyAdmitted: false, vault, owner: OWNER, deployTx, deployedAt: '2026-11-02', countedOn: 'x' })
const refused = (retryable: boolean, id = 'usdc'): VaultAdmissionAnswer => ({ status: 'refused', vault: null, deployTx: hashOf(1), retryable, reasons: [{ id, reason: id }] })

type Harness = {
  chain: Chain
  clock: { t: number }
  asked: string[]
  lines: string[]
  deps: VaultSweepDeps
}

function harness(chain: Chain, over: Partial<VaultSweepDeps> & { answer?: (tx: string) => VaultAdmissionAnswer; hostList?: RpcHost[]; counted2?: Set<string> } = {}): Harness {
  const clock = { t: Date.parse('2026-11-04T12:00:00Z') }
  const asked: string[] = []
  const lines: string[] = []
  const counted = over.counted2 ?? new Set<string>()
  const deps: VaultSweepDeps = {
    hosts: () => over.hostList ?? [host(chain, 'one'), host(chain, 'two')],
    ready: () => true,
    counted: async () => ({ ok: true, vaults: counted }),
    admit: async (tx) => {
      asked.push(tx)
      return (over.answer ?? ((t) => admitted(`${chain.contracts.find((c) => c.deployTx === t)?.address}`, t)))(tx)
    },
    registryUsdc: USDC,
    startBlock: START,
    now: () => clock.t,
    pause: async () => {},
    log: (line) => lines.push(line),
    limits: { startSpan: 50_000 },
    ...over,
  }
  return { chain, clock, asked, lines, deps }
}

test('it finds a vault from the chain alone and hands its deploy hash to admission', async () => {
  const v = vaultAt(3, 123_456, 123_999)
  const h = harness(new Chain().add(v))
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx])
  const status = sweep.status()
  assert.equal(status.on, true)
  assert.equal(status.lastBlockRead, String(h.chain.head - 20), 'it reads up to the margin behind the head')
  assert.equal(status.lastProblem, null)
  assert.equal(status.lastRun, '2026-11-04T12:00:00.000Z')
  // A second tick finds nothing new to ask: it was admitted.
  await sweep.tick()
  assert.equal(h.asked.length, 1)
})

test('found and counted through the real admission and store: one row, same shape, and it says who found it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-sweep-'))
  const io: ArcVaultStoreIo = { getPool: async () => null, file: join(dir, 'vaults.json') }
  const nonce = 7
  const v = vaultAt(nonce, 200_000, 200_100)
  const chain = new Chain().add(v)
  const input = encodeCreationInput(AgentSpendPolicyBytecode as Hex, abi, { owner: OWNER, operator: OPERATOR, usdc: USDC, dailyCap: 1_000_000n, autoApproveMax: 250_000n })
  const NOW = 1_800_000_000n
  const state: Record<string, unknown> = { owner: OWNER, operator: OPERATOR, usdc: USDC, dailyCap: 1_000_000n, autoApproveMax: 250_000n, sessionKeyExpiry: NOW + 1000n, frozen: false, allowlistEnabled: false, balance: 0n }
  const selectors = new Map(Object.keys(state).map((n) => [encodeFunctionData({ abi, functionName: n }) as string, encodeFunctionResult({ abi, functionName: n, result: state[n] } as never)]))
  const BLOCK_HASH = `0x${'bb'.repeat(32)}`
  const chainHost: RpcHost = {
    label: 'chain',
    request: async (method, params) => {
      switch (method) {
        case 'eth_getTransactionReceipt':
          return { transactionHash: params[0], status: '0x1', from: OWNER, to: null, contractAddress: v.address, blockNumber: `0x${v.deployBlock.toString(16)}`, blockHash: BLOCK_HASH }
        case 'eth_getTransactionByHash':
          return { hash: params[0], from: OWNER, to: null, nonce: `0x${nonce.toString(16)}`, input, blockHash: BLOCK_HASH }
        case 'eth_getBlockByNumber':
          return params[0] === 'latest'
            ? { number: `0x${chain.head.toString(16)}`, hash: `0x${'cc'.repeat(32)}`, timestamp: `0x${NOW.toString(16)}` }
            : { number: params[0], hash: BLOCK_HASH, timestamp: `0x${(NOW - 500n).toString(16)}` }
        case 'eth_getCode':
          return '0x6001'
        case 'eth_call': {
          const data = (params[0] as { data: string }).data
          if (data.length > 100) return '0x6001'
          const out = selectors.get(data)
          if (!out) throw new Error('no such getter')
          return out
        }
        default:
          throw new Error(method)
      }
    },
  }
  const ours: OurAddresses = { byAddress: new Map(), envKeysDerived: ['A_KEY'], envKeysUnreadable: [], keysCommitted: [], keysNotCompared: [] }
  const realAdmit = async (deployTx: string) =>
    (
      await admitVaultDeploy(
        { deployTx },
        {
          findByTx: (hash) => findAdmittedArcVaultByTx(hash, io),
          persist: (rec) => persistAdmittedArcVault(rec, io),
          admit: (tx) => runAdmission({ context, hosts: [chainHost], tx, ours, requireEnvKeys: true }),
          foundBy: 'sweep',
        },
      )
    ).answer
  const h = harness(chain)
  const sweep = createVaultSweep({
    ...h.deps,
    admit: realAdmit,
    counted: async () => {
      const read = await loadAdmittedArcVaults(io)
      return read.ok ? { ok: true, vaults: new Set(read.rows.map((r) => r.address.toLowerCase())) } : read
    },
  })
  await sweep.tick()
  await sweep.tick()
  const rows = JSON.parse(readFileSync(io.file as string, 'utf8')) as { address: string; ownerKind: string; deployTx: string; note: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].address.toLowerCase(), v.address)
  assert.equal(rows[0].ownerKind, 'unstated')
  assert.equal(rows[0].deployTx, v.deployTx)
  assert.match(rows[0].note, /own sweep/)
  assert.doesNotMatch(rows[0].note, /Admitted automatically by POST/)
})

test('the sweep is no new writer of the store: only admitVaultDeploy writes it', async () => {
  const source = readFileSync(new URL('../src/arc-vault-sweep.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /persistAdmittedArcVault/, 'only admitVaultDeploy writes the store')
  assert.match(source, /admitVaultDeploy\(\{ deployTx \}/)
})

test('bisect: a pruned host never moves a bound, and an error hands over to the next host', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  const pruned = host(chain, 'pruned', {
    on: (method, params) => {
      if (method === 'eth_getCode' && num(params[1]) < 400_000) return new Error('state at block is pruned')
      return undefined
    },
  })
  const errors = host(chain, 'errors', { on: (method) => (method === 'eth_getCode' ? new Error('502 bad gateway') : undefined) })
  const good = host(chain, 'good')
  const h = harness(chain, { hostList: [pruned, errors, good] })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx], 'the bisect still lands on the real block')
})

test('bisect: when no host can answer, it keeps its bounds, draws no conclusion, and goes on when one can', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  let down = true
  const only = host(chain, 'only', { on: (method) => (method === 'eth_getCode' && down ? new Error('state at block is pruned') : undefined) })
  const h = harness(chain, { hostList: [only] })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [], 'nothing was asked')
  assert.equal(sweep.status().lastProblem, 'deploy-not-read')
  down = false
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx], 'and it is not closed: the next tick finds it')
})

test('a block handed back without its transactions is no evidence of a factory', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  // As Blockdaemon does at an old block: the header, a root that is not empty, and no transactions.
  const headerOnly = host(chain, 'header-only', { on: (method, params) => (method === 'eth_getBlockByNumber' ? { number: params[0], transactions: [], transactionsRoot: `0x${'ab'.repeat(32)}` } : undefined) })
  const h = harness(chain, { hostList: [headerOnly] })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [])
  assert.equal(sweep.status().lastProblem, 'deploy-not-read')
  await sweep.tick()
  assert.equal(h.lines.filter((l) => /no direct creation/.test(l)).length, 0, 'not closed')
  // Once a host has the whole block, it is found.
  const whole = harness(chain, { hostList: [headerOnly, host(chain, 'whole')] })
  await createVaultSweep(whole.deps).tick()
  assert.deepEqual(whole.asked, [v.deployTx])
})

test('no direct creation: a contract a factory made is not asked about, and not read again', async () => {
  const factoryMade = vaultAt(1, 300_000, 300_040, OWNER, { deployTx: null })
  const chain = new Chain().add(factoryMade)
  const h = harness(chain)
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [])
  assert.ok(h.lines.some((l) => l.includes('no direct creation') && l.includes(factoryMade.address)))
  assert.equal(sweep.status().lastProblem, null, 'a factory is no problem of the sweep')
  const before = chain.reads.filter((r) => /getCode|getBlockByNumber|eth_call/.test(r)).length
  await sweep.tick()
  assert.equal(chain.reads.filter((r) => /getCode|getBlockByNumber|eth_call/.test(r)).length, before)
})

test('no host able to read the block before: no conclusion about a factory yet', async () => {
  const factoryMade = vaultAt(1, 300_000, 300_040, OWNER, { deployTx: null })
  const chain = new Chain().add(factoryMade)
  let down = false
  const only = host(chain, 'only', {
    on: (method) => {
      if (method === 'eth_getBlockByNumber') down = true
      return method === 'eth_getCode' && down ? new Error('502') : undefined
    },
  })
  const h = harness(chain, { hostList: [only] })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'deploy-not-read')
  assert.equal(h.lines.filter((l) => l.includes('no direct creation')).length, 0)
  down = false
  // The next tick reads the whole block again, which sets down again: so it is still not concluded.
  await sweep.tick()
  assert.equal(h.lines.filter((l) => l.includes('no direct creation')).length, 0)
})

test('a host that led the bisect past the real block is caught before anyone is called a factory', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  // Says no code at any old block, and is asked first because it answers.
  const liar = host(chain, 'liar', { on: (method, params) => (method === 'eth_getCode' && num(params[1]) < 300_040 && !lied.done ? '0x' : undefined) })
  const lied = { done: false }
  const h = harness(chain, { hostList: [liar, host(chain, 'honest')] })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'hosts-disagree')
  assert.deepEqual(h.asked, [], 'no conclusion yet')
  lied.done = true
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx], 'and asked again it lands on the real block')
})

test('a host failure leaves the cursor where it was, and blocks read stay read', async () => {
  // Its log is in the first chunk that cannot be read, so a cursor moved over that chunk loses it.
  const v = vaultAt(1, 201_000, 201_010)
  const chain = new Chain().add(v)
  let down = true
  const flaky = host(chain, 'flaky', {
    on: (method, params) => {
      if (method !== 'eth_getLogs') return undefined
      const { fromBlock } = (params as readonly { fromBlock: string }[])[0]
      return down && num(fromBlock) >= 200_000 ? new Error('502') : undefined
    },
  })
  const h = harness(chain, { hostList: [flaky], limits: { startSpan: 5000, logReadsPerTick: 10_000, readsPerTick: 10_000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  const stopped = Number(sweep.status().lastBlockRead)
  assert.equal(stopped, 200_999, 'stopped before the blocks it could not read')
  assert.equal(sweep.status().lastProblem, 'logs-not-read')
  assert.deepEqual(h.asked, [], 'the vault in the unread blocks was not skipped: it is just not found yet')
  down = false
  await sweep.tick()
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20))
  assert.deepEqual(h.asked, [v.deployTx], 'nothing was lost')
})

test('no host answering at all is a problem to report and nothing else', async () => {
  const chain = new Chain()
  const h = harness(chain, { hostList: [host(chain, 'down', { on: () => new Error('connect ECONNREFUSED') })] })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastBlockRead, null)
  assert.equal(sweep.status().lastProblem, 'no-host-answered')
})

test('chunks shrink to what a host takes, and each host is only asked for what its head has reached', async () => {
  const v = vaultAt(1, 450_000, 450_010)
  const chain = new Chain().add(v)
  const ranges: { host: string; from: number; to: number }[] = []
  const logged = (label: string, over: Parameters<typeof host>[2]) => {
    const h = host(chain, label, over)
    return {
      ...h,
      request: async (m: string, p: readonly unknown[]) => {
        if (m === 'eth_getLogs') {
          const { fromBlock, toBlock } = p[0] as { fromBlock: string; toBlock: string }
          ranges.push({ host: label, from: num(fromBlock), to: num(toBlock) })
        }
        return h.request(m, p)
      },
    } as RpcHost
  }
  // Behind the head and glad to say so with an empty list, as dRPC does past its head. Asked for those blocks it would hide the vault.
  const behind = logged('behind', { maxSpan: 1_000_000, head: 400_000, on: (m) => (m === 'eth_getLogs' ? [] : undefined) })
  const strict = logged('strict', { maxSpan: 2000 })
  const other = logged('other', { maxSpan: 2000 })
  const h = harness(chain, { hostList: [strict, other, behind], limits: { logReadsPerTick: 10_000, readsPerTick: 10_000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.ok(ranges.filter((r) => r.host === 'behind').every((r) => r.to <= 400_000), 'a host is not asked past its own head')
  assert.deepEqual(h.asked, [v.deployTx], 'and the vault past that host is found')
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20))
})

test('one host far ahead of the rest is not enough to read blocks the others have not reached', async () => {
  const chain = new Chain()
  const h = harness(chain, { hostList: [host(chain, 'far', { head: 9_000_000, on: (m) => (m === 'eth_getLogs' ? [] : undefined) }), host(chain, 'two')], limits: { logReadsPerTick: 10_000, readsPerTick: 10_000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20))
})

test('a refusal for good is remembered and not asked again in this process', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const h = harness(new Chain().add(v), { answer: () => refused(false, 'owner-not-ours') })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  h.clock.t += 24 * 3600_000
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx])
  // Another log from the same contract does not reopen it.
  h.chain.contracts.push({ ...v, logBlock: h.chain.head })
  h.chain.head += 100
  await sweep.tick()
  assert.equal(h.asked.length, 1)
})

test('a retryable refusal is asked again, later each time, up to an hour, with no second bisect', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  let answer = refused(true, 'session-key-expiry')
  const h = harness(new Chain().add(v), { answer: () => answer })
  const sweep = createVaultSweep(h.deps)
  const minute = 60_000
  await sweep.tick()
  assert.equal(h.asked.length, 1)
  const codeReads = () => h.chain.reads.filter((r) => /getCode/.test(r)).length
  const afterFirst = codeReads()
  h.clock.t += 4 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 1, 'too soon')
  h.clock.t += 1 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 2, 'after five minutes')
  h.clock.t += 9 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 2, 'the wait doubled')
  h.clock.t += 1 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 3)
  assert.equal(codeReads(), afterFirst, 'the hash found once is kept')
  for (let i = 0; i < 12; i++) {
    h.clock.t += 61 * minute
    await sweep.tick()
  }
  assert.equal(h.asked.length, 15, 'never more than once an hour, and never given up on')
  answer = admitted(v.address, v.deployTx as string)
  h.clock.t += 61 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 16)
  h.clock.t += 61 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 16, 'counted, and done with')
})

test('a new end date does not wait out the backoff: it is asked about within one step, and the backoff starts over', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  let answer = refused(true, 'session-key-expiry')
  const counted = new Set<string>()
  const h = harness(new Chain().add(v), { answer: () => answer, counted2: counted })
  const sweep = createVaultSweep(h.deps)
  const minute = 60_000
  const newLog = () => {
    h.chain.contracts.push({ ...v, logBlock: h.chain.head })
    h.chain.head += 100
  }
  await sweep.tick()
  for (const wait of [5, 10, 20, 40, 60]) {
    h.clock.t += wait * minute
    await sweep.tick()
  }
  assert.equal(h.asked.length, 6, 'the wait has grown to an hour')

  h.clock.t += 1 * minute
  newLog()
  await sweep.tick()
  assert.equal(h.asked.length, 6, 'last asked a minute ago, so the log alone does not ask at once')
  h.clock.t += 3 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 6, 'not before the step')
  h.clock.t += 1 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 7, 'one step from the last ask, and not the hour')

  // Refused again: the wait is one step again, and doubles from there.
  h.clock.t += 4 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 7)
  h.clock.t += 1 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 8)
  h.clock.t += 9 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 8, 'the wait doubled, with no new log')

  // A log long after the last ask is asked about in the tick that reads it.
  h.clock.t += 1 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 9)
  h.clock.t += 19 * minute
  newLog()
  answer = admitted(v.address, v.deployTx as string)
  await sweep.tick()
  assert.equal(h.asked.length, 10)
  counted.add(v.address)
  h.clock.t += 60 * minute
  newLog()
  await sweep.tick()
  assert.equal(h.asked.length, 10, 'counted, and a new log does not bring it back')
})

test('the words on the page hold against the sweep: a new end date is asked about within about ten minutes of the write', async () => {
  const words = (await import(new URL('../../src/lib/arc/vault-count.ts', import.meta.url).href)) as { noHashWords: (endDate: string, sweep: string) => string }
  assert.match(words.noHashWords('passed', 'looking'), /within about ten minutes of the new end date/)
  const everyMs = sweepConfig({}).everyMs
  const stepMs = DEFAULT_SWEEP_LIMITS.retryAfterMs
  assert.equal(everyMs + stepMs, 10 * 60_000, 'a tick to read the log, then at most a step from the last ask: if these move, the page has to move')
  assert.ok(DEFAULT_SWEEP_LIMITS.maxRetryAfterMs > 10 * 60_000, 'and it is the new log that makes it so short, not the wait it would have had')

  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  const start = Date.parse('2026-11-04T12:00:00Z')
  const asks: number[] = []
  const h = harness(chain, {
    answer: () => {
      asks.push(h.clock.t)
      h.clock.t += 3000
      return refused(true, 'session-key-expiry')
    },
  })
  // A real read takes a moment, so a step from the last ask usually ends just after the next tick, and the wait is then two ticks.
  const taking = (label: string) => host(chain, label, { on: () => void (h.clock.t += 150) })
  const sweep = createVaultSweep({ ...h.deps, hosts: () => [taking('one'), taking('two')] })
  let tick = 0
  const nextTick = async () => {
    h.clock.t = start + tick++ * everyMs
    await sweep.tick()
  }
  // Until the wait has grown to its longest. The worst moment for an owner is a write just after an ask.
  while (asks.length < 2 || (asks.at(-1) as number) - (asks.at(-2) as number) < DEFAULT_SWEEP_LIMITS.maxRetryAfterMs) {
    assert.ok(tick < 100, 'the wait grows to its longest in a few asks')
    await nextTick()
  }
  const writtenAt = h.clock.t
  chain.contracts.push({ ...v, logBlock: chain.head })
  chain.head += 100
  const before = asks.length
  await nextTick()
  await nextTick()
  assert.ok(asks.length > before, 'asked within two ticks of the write, and not an hour after the last ask')
  assert.ok(asks[before] - writtenAt <= 10 * 60_000, `asked ${asks[before] - writtenAt} ms after the write`)
})

test('a contract paying gas for a new log every tick is asked about no more than once a step, and the cap per tick holds', async () => {
  const minute = 60_000
  const v = vaultAt(1, 300_000, 300_040)
  const h = harness(new Chain().add(v), { answer: () => refused(true, 'session-key-expiry') })
  const sweep = createVaultSweep(h.deps)
  for (let i = 0; i <= 60; i++) {
    h.chain.contracts.push({ ...v, logBlock: h.chain.head })
    h.chain.head += 100
    await sweep.tick()
    h.clock.t += minute
  }
  assert.equal(h.asked.length, 13, 'an hour of ticks a minute apart: one ask at the start, then one every five')

  // Many of them at once: however many have a new log, a tick asks about no more than its cap.
  const chain = new Chain()
  const many = Array.from({ length: 12 }, (_, i) => vaultAt(i + 1, 300_000 + i * 10, 300_100 + i * 10))
  chain.add(...many)
  const m = harness(chain, { answer: () => refused(true, 'session-key-expiry'), limits: { readsPerTick: 2000 } })
  const flood = createVaultSweep(m.deps)
  for (let i = 0; i < 12; i++) {
    const before = m.asked.length
    await flood.tick()
    assert.ok(m.asked.length - before <= DEFAULT_SWEEP_LIMITS.asksPerTick, `tick ${i} asked ${m.asked.length - before}`)
    chain.contracts.push(...many.map((c) => ({ ...c, logBlock: chain.head })))
    chain.head += 100
    m.clock.t += 5 * minute
  }
  assert.ok(m.asked.length >= 5 * 12 - 5, `the cap is what holds it back (${m.asked.length})`)
})

test('an older log brings nothing forward: only a log newer than the one it knows can be a new end date', async () => {
  const FULL = 250_000
  const v = vaultAt(1, 240_000, 300_040)
  const chain = new Chain().add(v)
  // A log of the same contract in a block no host will read yet. It turns up once the hole is read, after the newer one.
  chain.contracts.push({ ...v, logBlock: FULL })
  let block: number | null = FULL
  const hosts = [refusing(chain, 'one', () => block, { receipts: true }), refusing(chain, 'two', () => block, { receipts: true })]
  const h = harness(chain, { hostList: hosts, answer: () => refused(true, 'session-key-expiry'), limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  const sweep = createVaultSweep(h.deps)
  const minute = 60_000
  await sweep.tick()
  assert.equal(h.asked.length, 1)
  h.clock.t += 5 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 2)
  // Both are due in this tick: the hole is read first, and that must not start the wait over.
  block = null
  h.clock.t += 10 * minute
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, null, 'the hole was read')
  assert.equal(h.asked.length, 3)
  h.clock.t += 5 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 3, 'the wait doubled to twenty minutes, as with no log at all')
  h.clock.t += 15 * minute
  await sweep.tick()
  assert.equal(h.asked.length, 4)
})

test('a vault refused for what its owner can still change is not closed: it is asked again at the bounded rate, and counts once they change it', async () => {
  const nonce = 7
  const NOW = 1_800_000_000n
  const BLOCK_HASH = `0x${'bb'.repeat(32)}`
  const good = { owner: OWNER, operator: OPERATOR, usdc: USDC, dailyCap: 1_000_000n, autoApproveMax: 250_000n, sessionKeyExpiry: NOW + 1000n, frozen: false, allowlistEnabled: false, balance: 0n }
  const cases: [string, Partial<typeof good>][] = [
    ['daily-cap', { dailyCap: 0n }],
    ['auto-approve-max', { autoApproveMax: 0n }],
    ['operator-set', { operator: '0x0000000000000000000000000000000000000000' }],
    ['operator-set', { operator: OWNER }],
  ]
  for (const [id, bad] of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'arc-sweep-'))
    const io: ArcVaultStoreIo = { getPool: async () => null, file: join(dir, 'vaults.json') }
    const v = vaultAt(nonce, 200_000, 200_100)
    const chain = new Chain().add(v)
    let state: typeof good = { ...good, ...bad }
    // The deploy's own arguments do not change, whatever the owner has since set.
    const input = encodeCreationInput(AgentSpendPolicyBytecode as Hex, abi, { owner: OWNER, operator: state.operator, usdc: USDC, dailyCap: state.dailyCap, autoApproveMax: state.autoApproveMax })
    const getters = Object.keys(good) as (keyof typeof good)[]
    const chainHost: RpcHost = {
      label: 'chain',
      request: async (method, params) => {
        switch (method) {
          case 'eth_getTransactionReceipt':
            return { transactionHash: params[0], status: '0x1', from: OWNER, to: null, contractAddress: v.address, blockNumber: `0x${v.deployBlock.toString(16)}`, blockHash: BLOCK_HASH }
          case 'eth_getTransactionByHash':
            return { hash: params[0], from: OWNER, to: null, nonce: `0x${nonce.toString(16)}`, input, blockHash: BLOCK_HASH }
          case 'eth_getBlockByNumber':
            return params[0] === 'latest'
              ? { number: `0x${chain.head.toString(16)}`, hash: `0x${'cc'.repeat(32)}`, timestamp: `0x${NOW.toString(16)}` }
              : { number: params[0], hash: BLOCK_HASH, timestamp: `0x${(NOW - 500n).toString(16)}` }
          case 'eth_getCode':
            return '0x6001'
          case 'eth_call': {
            const data = (params[0] as { data: string }).data
            if (data.length > 100) return '0x6001'
            const name = getters.find((n) => encodeFunctionData({ abi, functionName: n }) === data)
            if (!name) throw new Error('no such getter')
            return encodeFunctionResult({ abi, functionName: name, result: state[name] } as never)
          }
          default:
            throw new Error(method)
        }
      },
    }
    const ours: OurAddresses = { byAddress: new Map(), envKeysDerived: ['A_KEY'], envKeysUnreadable: [], keysCommitted: [], keysNotCompared: [] }
    const answers: VaultAdmissionAnswer[] = []
    const realAdmit = async (deployTx: string) => {
      const { answer } = await admitVaultDeploy(
        { deployTx },
        {
          findByTx: (hash) => findAdmittedArcVaultByTx(hash, io),
          persist: (rec) => persistAdmittedArcVault(rec, io),
          admit: (tx) => runAdmission({ context, hosts: [chainHost], tx, ours, requireEnvKeys: true }),
          foundBy: 'sweep',
        },
      )
      answers.push(answer)
      return answer
    }
    const h = harness(chain)
    const sweep = createVaultSweep({
      ...h.deps,
      admit: realAdmit,
      counted: async () => {
        const read = await loadAdmittedArcVaults(io)
        return read.ok ? { ok: true, vaults: new Set(read.rows.map((r) => r.address.toLowerCase())) } : read
      },
    })
    await sweep.tick()
    assert.equal(answers.length, 1, id)
    assert.ok(answers[0].status === 'refused' && answers[0].retryable && answers[0].reasons.some((r) => r.id === id), id)
    assert.ok(h.lines.some((l) => l.startsWith('refused for now')), id)
    assert.ok(!h.lines.some((l) => l.startsWith('refused for good')), `${id} is not for good`)

    // The same bounded rate as any retryable refusal.
    h.clock.t += 4 * 60_000
    await sweep.tick()
    assert.equal(answers.length, 1, `${id}: not before the step`)
    h.clock.t += 60_000
    await sweep.tick()
    assert.equal(answers.length, 2, `${id}: asked again after it`)

    // setPolicy and setOperator log no end date, so this is the wait running out, at most an hour.
    state = good
    h.clock.t += 60 * 60_000
    await sweep.tick()
    assert.equal(answers.length, 3, id)
    assert.equal(answers[2].status, 'admitted', id)
    const rows = JSON.parse(readFileSync(io.file as string, 'utf8')) as { address: string }[]
    assert.equal(rows.length, 1, id)
    assert.equal(rows[0].address.toLowerCase(), v.address)
  }
})

test('an answer that is no answer about the vault, or an admission that throws, closes nothing', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  let throws = true
  const h = harness(new Chain().add(v), {
    answer: () => {
      if (throws) throw new Error('database is down, password=secret')
      return { status: 'unavailable', retryable: true, reason: 'our server could not finish' }
    },
  })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'admission-unavailable', 'fixed words')
  assert.ok(h.lines.some((l) => l.includes('password=secret')), 'the raw text is in the log')
  throws = false
  h.clock.t += 5 * 60_000
  await sweep.tick()
  assert.equal(h.asked.length, 2)
  assert.equal(sweep.status().lastProblem, 'admission-unavailable')
})

/** A flood of contracts that answer usdc() and owner() as a vault does, so each costs a whole bisect, and only then a refusal. */
function floodOf(chain: Chain, count: number, firstNonce: number, firstBlock: number) {
  const flooder = '0x9999999999999999999999999999999999999999' as Hex
  for (let i = 0; i < count; i++) chain.add(vaultAt(firstNonce + i, firstBlock + i * 10, firstBlock + i * 10 + 5, flooder))
}

test('under a flood the caps hold on every tick and a real owner newer than it is reached at once', async () => {
  const chain = new Chain()
  floodOf(chain, 40, 100, 200_000)
  const real = vaultAt(5, 490_000, 490_010)
  chain.add(real)
  const h = harness(chain, { answer: (tx) => (tx === real.deployTx ? admitted(real.address, tx) : refused(true, 'session-key-expiry')) })
  const sweep = createVaultSweep({ ...h.deps, limits: { readsPerTick: 100, logReadsPerTick: 40, asksPerTick: 2, startSpan: 5000, retryAfterMs: 5 * 60_000, maxRetryAfterMs: 60 * 60_000 } })
  for (let ticks = 0; ticks < 5; ticks++) {
    const reads = chain.reads.length
    const asks = h.asked.length
    await sweep.tick()
    assert.ok(chain.reads.length - reads <= 100, `reads per tick are capped: ${chain.reads.length - reads}`)
    assert.ok(h.asked.length - asks <= 2, 'admissions per tick are capped')
    h.clock.t += 5 * 60_000
  }
  assert.equal(h.asked.filter((t) => t === real.deployTx).length, 1, 'it was reached ahead of the 40, and once')
})

test('a restart sooner than an old flood drains does not lock out a real owner newer than it', async () => {
  // Far more than a process gets through between restarts, and every one of them answers usdc() and owner().
  const chain = new Chain()
  floodOf(chain, 500, 100, 200_000)
  const real = vaultAt(5, 490_000, 490_010)
  chain.add(real)
  const h = harness(chain, { answer: (tx) => (tx === real.deployTx ? admitted(real.address, tx) : refused(false, 'creation-input')) })
  for (let process = 0; process < 3; process++) {
    const sweep = createVaultSweep({ ...h.deps, limits: { readsPerTick: 100, logReadsPerTick: 40, asksPerTick: 3 } })
    for (let tick = 0; tick < 2; tick++) {
      await sweep.tick()
      h.clock.t += 5 * 60_000
    }
    assert.ok(h.asked.includes(real.deployTx as string), `reached in the first process's first ticks, as it is in every other (process ${process})`)
    assert.ok(new Set(h.asked).size < 500, 'and the flood had not drained')
  }
})

test('a real owner with a flood on both sides is reached anyway, however often the process restarts', async () => {
  const chain = new Chain()
  floodOf(chain, 60, 100, 200_000)
  const real = vaultAt(5, 300_000, 300_010)
  chain.add(real)
  floodOf(chain, 60, 1000, 400_000)
  const h = harness(chain, { answer: (tx) => (tx === real.deployTx ? admitted(real.address, tx) : refused(false, 'creation-input')) })
  // A seeded pick, so the run is the same each time.
  let seed = 7
  const pick = (n: number) => {
    seed = (seed * 48271) % 2147483647
    return seed % n
  }
  let processes = 0
  while (!h.asked.includes(real.deployTx as string) && processes < 200) {
    processes++
    const sweep = createVaultSweep({ ...h.deps, pick, limits: { readsPerTick: 100, logReadsPerTick: 40, asksPerTick: 3 } })
    for (let tick = 0; tick < 2 && !h.asked.includes(real.deployTx as string); tick++) {
      await sweep.tick()
      h.clock.t += 5 * 60_000
    }
  }
  assert.ok(h.asked.includes(real.deployTx as string), `reached, after ${processes} processes`)
  assert.ok(processes > 1, 'it does take longer than a flood on one side')
})

test('new contracts arriving all the time do not starve an old one nobody has asked about yet', async () => {
  const chain = new Chain()
  const old = vaultAt(1, 200_000, 200_010)
  chain.add(old)
  floodOf(chain, 3, 100, 300_000)
  const h = harness(chain, { answer: () => refused(false, 'creation-input') })
  // The random turn is held to the same place, so only the longest-wait turn can reach it.
  const sweep = createVaultSweep({ ...h.deps, pick: () => 0, limits: { asksPerTick: 2 } })
  let nonce = 2000
  for (let i = 0; i < 3 && !h.asked.includes(old.deployTx as string); i++) {
    for (let k = 0; k < 4; k++) chain.add(vaultAt(nonce++, chain.head, chain.head + 1, '0x9999999999999999999999999999999999999999'))
    chain.head += 100
    await sweep.tick()
    h.clock.t += 5 * 60_000
  }
  assert.ok(h.asked.includes(old.deployTx as string))
})

test('the turns go newest, longest wait, at random, and a contract already asked about is not the newest', async () => {
  const chain = new Chain()
  const all = [1, 2, 3, 4, 5].map((i) => vaultAt(i, 200_000 + i * 1000, 200_000 + i * 1000 + 10))
  chain.add(...all)
  const h = harness(chain, { answer: () => refused(true, 'session-key-expiry') })
  const sweep = createVaultSweep({ ...h.deps, pick: () => 0, limits: { asksPerTick: 1, retryAfterMs: 1000, maxRetryAfterMs: 1000 } })
  for (let i = 0; i < 4; i++) {
    await sweep.tick()
    h.clock.t += 60_000
  }
  assert.deepEqual(
    h.asked,
    [all[4], all[0], all[1], all[3]].map((c) => c.deployTx),
    'one ask a tick: the newest; the longest wait; the random turn; then the newest nobody has asked about yet',
  )
})

test('a contract that never reads does not keep the newest place from a real owner', async () => {
  const chain = new Chain()
  const flooder = '0x9999999999999999999999999999999999999999' as Hex
  floodOf(chain, 30, 100, 100_000)
  const real = vaultAt(1, 300_000, 300_010)
  const never = vaultAt(50, 400_000, 400_010, flooder)
  chain.add(real, never)
  const only = host(chain, 'only', {
    maxSpan: 100_000_000,
    on: (method, params) => {
      const to = method === 'eth_call' ? (params[0] as { to: string }).to : method === 'eth_getCode' ? (params[0] as string) : null
      return to === never.address ? new Error('502') : undefined
    },
  })
  const h = harness(chain, { hostList: [only], answer: () => refused(false, 'creation-input') })
  const sweep = createVaultSweep({ ...h.deps, pick: () => 0, limits: { readsPerTick: 30, logReadsPerTick: 1, startSpan: 10_000_000, asksPerTick: 1 } })
  for (let i = 0; i < 9 && !h.asked.includes(real.deployTx as string); i++) {
    await sweep.tick()
    h.clock.t += 5 * 60_000
  }
  assert.ok(h.asked.includes(real.deployTx as string), 'it does not wait for the 30 older ones to drain')
  assert.ok(h.asked.length < 8, `${h.asked.length} were asked about first`)
})

test('a bisect the read cap stopped goes first next tick, ahead of anything newer', async () => {
  const chain = new Chain()
  const first = vaultAt(1, 300_000, 300_010)
  chain.add(first)
  const h = harness(chain, { hostList: [host(chain, 'one')] })
  // Enough for the head, the logs and part of a bisect.
  const sweep = createVaultSweep({ ...h.deps, limits: { readsPerTick: 8 } })
  await sweep.tick()
  assert.equal(h.asked.length, 0)
  assert.equal(sweep.status().lastProblem, 'read-cap-reached')
  chain.head += 1000
  chain.add(vaultAt(2, chain.head - 200, chain.head - 100))
  for (let i = 0; i < 6 && !h.asked.includes(first.deployTx as string); i++) await sweep.tick()
  assert.deepEqual(h.asked.slice(0, 1), [first.deployTx], 'it was finished before the newer one was started')
})

test('the read cap holds whatever else is going on, and a bisect it stopped goes on from its bounds', async () => {
  const chain = new Chain()
  const flooder = '0x9999999999999999999999999999999999999999' as Hex
  for (let i = 0; i < 40; i++) chain.add(vaultAt(100 + i, 200_000 + i * 10, 200_005 + i * 10, flooder))
  const h = harness(chain)
  const sweep = createVaultSweep({ ...h.deps, limits: { readsPerTick: 50, logReadsPerTick: 20, asksPerTick: 1000 } })
  const perTick: number[] = []
  for (let i = 0; i < 40; i++) {
    const before = chain.reads.length
    await sweep.tick()
    perTick.push(chain.reads.length - before)
    h.clock.t += 5 * 60_000
  }
  assert.ok(perTick.every((n) => n <= 50), `at most the cap each tick: ${perTick.join(',')}`)
  assert.equal(new Set(h.asked).size, 40, 'and they all get their turn')
  // 2 getters, about 18 steps and a block read per contract: a bisect that started over each tick would never finish in 50.
  const codeReads = chain.reads.filter((r) => r.includes('getCode')).length
  assert.ok(codeReads <= 40 * 20, `no bound was given up: ${codeReads}`)
})

test('those being asked again do not starve while new contracts keep coming, and the reverse', async () => {
  const chain = new Chain()
  const first = vaultAt(1, 200_000, 200_010)
  chain.add(first)
  const h = harness(chain, { answer: () => refused(true, 'session-key-expiry') })
  const sweep = createVaultSweep({ ...h.deps, limits: { asksPerTick: 1, retryAfterMs: 60_000, maxRetryAfterMs: 60_000 } })
  await sweep.tick()
  assert.deepEqual(h.asked, [first.deployTx])
  // New contracts every tick, more than the cap, for as long as we care to look.
  let nonce = 1000
  for (let i = 0; i < 6; i++) {
    h.clock.t += 60_000
    for (let k = 0; k < 2; k++) chain.add(vaultAt(nonce++, chain.head, chain.head + 1, '0x9999999999999999999999999999999999999999'))
    chain.head += 100
    await sweep.tick()
  }
  assert.ok(h.asked.filter((t) => t === first.deployTx).length >= 2, 'the first is reached again despite the new ones')
  assert.ok(h.asked.some((t) => t !== first.deployTx), 'and new ones are reached despite it')
})

test('a contract whose usdc() is another token costs no bisect; one that answers nothing readable is not ruled out', async () => {
  const other = vaultAt(1, 300_000, 300_040, OWNER, { usdc: '0x4444444444444444444444444444444444444444' })
  const noOwner = vaultAt(2, 300_000, 300_041, OWNER, { owner: `0x${'0'.repeat(40)}` })
  const chain = new Chain().add(other, noOwner)
  const h = harness(chain)
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [])
  assert.equal(chain.reads.filter((r) => /getCode/.test(r)).length, 0)

  // A host behind the deploy answers 0x, which rules out nothing.
  const v = vaultAt(3, 300_000, 300_040)
  const chain2 = new Chain().add(v)
  const behind = host(chain2, 'behind', { on: (m) => (m === 'eth_call' ? '0x' : undefined) })
  const h2 = harness(chain2, { hostList: [behind] })
  await createVaultSweep(h2.deps).tick()
  assert.deepEqual(h2.asked, [v.deployTx])
})

test('a vault already on the list costs no read beyond the logs', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  const h = harness(chain, { counted2: new Set([v.address]) })
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [])
  assert.equal(chain.reads.filter((r) => /getCode|getBlockByNumber|eth_call/.test(r)).length, 0)
})

test('a restart reads from the same fixed block again, so nothing it had found is lost', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  const h = harness(chain, { answer: () => refused(true, 'vault-state') })
  await createVaultSweep(h.deps).tick()
  assert.equal(h.asked.length, 1)
  const again = createVaultSweep(h.deps)
  assert.equal(again.status().lastBlockRead, null)
  await again.tick()
  assert.equal(h.asked.length, 2, 'the new process found it from the start block')
  assert.equal(sweepConfig({}).startBlock, ARC_VAULT_SWEEP_START_BLOCK)
})

test('catching up after a restart stops at the cap and goes on next tick, with the cursor where it stopped', async () => {
  const chain = new Chain()
  const h = harness(chain, { hostList: [host(chain, 'one')] })
  const sweep = createVaultSweep({ ...h.deps, limits: { startSpan: 5000, logReadsPerTick: 10, readsPerTick: 200 } })
  await sweep.tick()
  assert.equal(chain.reads.filter((r) => r.includes('getLogs')).length, 10)
  assert.equal(sweep.status().lastBlockRead, String(START + 50_000 - 1))
  assert.equal(sweep.status().lastProblem, 'read-cap-reached')
  await sweep.tick()
  assert.equal(sweep.status().lastBlockRead, String(START + 100_000 - 1))
})

test('not ready: the tick reads nothing and moves nothing', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  let ready = false
  const h = harness(chain, { ready: () => ready })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(chain.reads.length, 0)
  assert.deepEqual(h.asked, [])
  assert.equal(sweep.status().lastBlockRead, null)
  assert.equal(sweep.status().lastProblem, 'admission-not-ready')
  assert.ok(sweep.status().lastRun, 'it did run, and says so')
  ready = true
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx])
  assert.equal(sweep.status().lastProblem, null, 'and the word clears')
})

test('a list it cannot read is never an empty one: the tick stops before any read', async () => {
  const chain = new Chain().add(vaultAt(1, 300_000, 300_040))
  const h = harness(chain, { counted: async () => ({ ok: false, reason: 'pg: password authentication failed' }) })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(chain.reads.length, 0)
  assert.deepEqual(h.asked, [])
  assert.equal(sweep.status().lastProblem, 'list-unreadable')
  assert.ok(!JSON.stringify(sweep.status()).includes('password'), 'the raw text stays out of the public block')
  assert.ok(h.lines.some((l) => l.includes('password')))
})

test('nothing can make a tick reject, and two at once are one', async () => {
  const h = harness(new Chain(), {
    ready: () => {
      throw new Error('boom')
    },
  })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'round-failed')

  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  let rounds = 0
  const h2 = harness(new Chain(), {
    ready: () => true,
    counted: async () => {
      rounds++
      await held
      return { ok: true, vaults: new Set<string>() }
    },
  })
  const sweep2 = createVaultSweep(h2.deps)
  const first = sweep2.tick()
  await sweep2.tick()
  release()
  await first
  assert.equal(rounds, 1)
})

test('a stalled host costs its timeout once per tick', async () => {
  const v = vaultAt(1, 300_000, 300_040)
  const chain = new Chain().add(v)
  const h = harness(chain)
  let stalledReads = 0
  const stalls: RpcHost = {
    label: 'stalls',
    request: async () => {
      stalledReads++
      h.clock.t += 8000
      throw new Error('The request took too long to respond.')
    },
  }
  const sweep = createVaultSweep({ ...h.deps, hosts: () => [stalls, host(chain, 'good')] })
  await sweep.tick()
  assert.equal(stalledReads, 1, 'benched for the rest of the tick')
  assert.deepEqual(h.asked, [v.deployTx])
})

test('with every host benched the queue is not walked: it stops at the first contract that got no read, and that one keeps its place', async () => {
  const chain = new Chain()
  const many = Array.from({ length: 40 }, (_, i) => vaultAt(i + 1, 300_000 + i * 10, 300_100 + i * 10))
  chain.add(...many)
  const h = harness(chain)
  let stalling = true
  const stalls = (label: string) =>
    host(chain, label, {
      on: (method) => {
        if (!stalling || method !== 'eth_call') return undefined
        h.clock.t += 8000
        return new Error('The request took too long to respond.')
      },
    })
  const sweep = createVaultSweep({ ...h.deps, hosts: () => [stalls('one'), stalls('two')] })
  await sweep.tick()
  assert.equal(chain.reads.filter((r) => r.endsWith('eth_call')).length, 2, 'each host stalled once and is benched')
  const notRead = h.lines.filter((l) => l.startsWith('deploy-not-read'))
  assert.equal(notRead.length, 2, 'the contract whose read benched them, and the next, which got no read: not the 40 in the queue')
  assert.equal(sweep.status().lastProblem, 'deploy-not-read')
  assert.deepEqual(h.asked, [])

  // A new tick has fresh hosts. The first turn is the longest wait: the one that got no read has not lost that.
  stalling = false
  await sweep.tick()
  assert.equal(h.asked[0], many[0].deployTx)
  assert.equal(sweep.status().lastProblem, null)
})

test('a round has a deadline: past it the asks stop, and no read goes out', async () => {
  const chain = new Chain()
  const a = vaultAt(1, 300_000, 300_010)
  const b = vaultAt(2, 310_000, 310_010)
  chain.add(a, b)
  const clock = { t: Date.parse('2026-11-04T12:00:00Z') }
  const h = harness(chain, {
    now: () => clock.t,
    answer: (tx) => {
      clock.t += 121_000
      return refused(true, tx)
    },
  })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(h.asked.length, 1, 'the one after it was not started')
  assert.equal(sweep.status().lastProblem, 'ran-out-of-time')

  // And a read that takes the clock past it, in the middle of a bisect: the next one does not reach a host.
  const chain2 = new Chain().add(vaultAt(1, 300_000, 300_010))
  const clockJump = harness(chain2)
  const slow = host(chain2, 'slow', {
    on: (method) => {
      if (method === 'eth_getCode') clockJump.clock.t += 121_000
      return undefined
    },
  })
  const late = createVaultSweep({ ...clockJump.deps, hosts: () => [slow] })
  await late.tick()
  assert.equal(chain2.reads.filter((r) => r.includes('eth_getCode')).length, 1, 'no read went out past the deadline')
  assert.deepEqual(clockJump.asked, [])
})

test('a store call that never returns ends the round with a fixed word, and the next tick runs', async () => {
  const chain = new Chain().add(vaultAt(1, 300_000, 300_010))
  let hung = true
  const h = harness(chain, {
    counted: () => (hung ? new Promise(() => {}) : Promise.resolve({ ok: true as const, vaults: new Set<string>() })),
  })
  // The timers here do not hold the process open, so this does until they have fired.
  const keep = setTimeout(() => {}, 2000)
  const sweep = createVaultSweep({ ...h.deps, limits: { listDeadlineMs: 5 } })
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'list-unreadable')
  assert.equal(chain.reads.length, 0, 'nothing is read without the list')
  assert.ok(h.lines.some((l) => l.includes('did not answer')), 'and the log says what happened')
  hung = false
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, null)
  assert.equal(h.asked.length, 1)
  clearTimeout(keep)
})

test('an admission that never returns ends the round with a fixed word, waits its turn, and closes nothing', async () => {
  const a = vaultAt(1, 300_000, 300_010)
  const b = vaultAt(2, 310_000, 310_010)
  const chain = new Chain().add(a, b)
  let hung = true
  const asked: string[] = []
  const h = harness(chain)
  const keep = setTimeout(() => {}, 2000)
  const sweep = createVaultSweep({
    ...h.deps,
    admit: (tx) => {
      asked.push(tx)
      return hung ? new Promise(() => {}) : Promise.resolve(admitted(a.address, tx))
    },
    limits: { askDeadlineMs: 5 },
  })
  await sweep.tick()
  assert.equal(asked.length, 1, 'the next would only wait as long')
  assert.equal(sweep.status().lastProblem, 'admission-unavailable')
  const stuck = asked[0]
  hung = false
  await sweep.tick()
  assert.equal(asked.filter((t) => t === stuck).length, 1, 'too soon for that one')
  assert.equal(asked.length, 2, 'the other one goes on')
  h.clock.t += 5 * 60_000
  await sweep.tick()
  assert.equal(asked.filter((t) => t === stuck).length, 2, 'and it is asked again')
  clearTimeout(keep)
})

test('a round that never ends is said to be stuck by the next tick, and two still do not run at once', async () => {
  const chain = new Chain()
  let reads = 0
  const never: RpcHost = {
    label: 'never',
    request: () => {
      reads++
      return new Promise(() => {})
    },
  }
  const h = harness(chain, { hostList: [never] })
  const sweep = createVaultSweep(h.deps)
  void sweep.tick()
  await new Promise((r) => setImmediate(r))
  assert.equal(reads, 1)
  // Not yet: a slow round is not a stuck one.
  h.clock.t += 60_000
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, null)
  assert.equal(h.lines.length, 0)
  h.clock.t += 10 * 60_000
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'round-stalled')
  assert.ok(h.lines.some((l) => l.startsWith('round-stalled')), 'and the log says so')
  assert.equal(reads, 1, 'it started no second round')
})

test('the timer goes on while a tick has not come back, so the tick after it can say so', async () => {
  const timers: { run: () => void; ms: number }[] = []
  let ticks = 0
  const stop = runOnTimer(
    () => {
      ticks++
      return new Promise<void>(() => {})
    },
    {
      everyMs: 1000,
      firstAfterMs: 50,
      setTimer: (run, ms) => {
        timers.push({ run, ms })
        return {}
      },
    },
  )
  timers[0].run()
  await new Promise((r) => setImmediate(r))
  assert.equal(timers.length, 2, 'set as it started, not when it ended')
  timers[1].run()
  await new Promise((r) => setImmediate(r))
  assert.equal(ticks, 2)
  stop()
})

// -- answers that must not be taken at their word ------------------------------------------

test('a log list with one wrong entry is no answer from that host: the next host is asked', async () => {
  const v = vaultAt(1, 300_000, 300_010)
  const chain = new Chain().add(v)
  const goodLog = { address: v.address, blockNumber: `0x${v.logBlock.toString(16)}`, topics: [TOPIC] }
  const hex = (n: number) => `0x${n.toString(16)}`
  const bad: ((from: number, to: number) => Record<string, unknown>)[] = [
    // Below the range: taken as read, it would set the bisect's top too low and close a real vault as no creation.
    (from) => ({ ...goodLog, blockNumber: hex(from - 1) }),
    (_from, to) => ({ ...goodLog, blockNumber: hex(to + 1) }),
    () => ({ ...goodLog, blockNumber: 'soon' }),
    // Someone else's address: taken as read, this list would hide the real vault's log.
    () => ({ ...goodLog, address: OPERATOR, topics: [`0x${'cd'.repeat(32)}`] }),
    () => ({ ...goodLog, address: OPERATOR, topics: [] }),
    () => ({ ...goodLog, address: '0x1234' }),
  ]
  for (const entry of bad) {
    const liar = host(chain, 'liar', {
      on: (method, params) => {
        if (method !== 'eth_getLogs') return undefined
        const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
        return num(fromBlock) <= v.logBlock && v.logBlock <= num(toBlock) ? [entry(num(fromBlock), num(toBlock))] : undefined
      },
    })
    const h = harness(chain, { hostList: [liar, host(chain, 'honest')] })
    const sweep = createVaultSweep(h.deps)
    await sweep.tick()
    assert.deepEqual(h.asked, [v.deployTx], `the honest host's answer stands against ${JSON.stringify(entry(1000, 2000))}`)
    assert.equal(sweep.status().lastProblem, null)
    assert.ok(!h.lines.some((l) => l.includes('no direct creation')), 'and the vault was not closed')
  }
})

test('a log the chain has removed finds nothing', async () => {
  const v = vaultAt(1, 300_000, 300_010)
  const chain = new Chain().add(v)
  const h = harness(chain, {
    hostList: [
      host(chain, 'one', {
        on: (method, params) => {
          if (method !== 'eth_getLogs') return undefined
          const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
          return num(fromBlock) <= v.logBlock && v.logBlock <= num(toBlock) ? [{ address: v.address, blockNumber: `0x${v.logBlock.toString(16)}`, topics: [TOPIC], removed: true }] : undefined
        },
      }),
    ],
  })
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [])
  assert.equal(chain.reads.filter((r) => /eth_call|getCode/.test(r)).length, 0)
})

test('an admission that throws or says unavailable is not asked again too soon', async () => {
  for (const answer of [
    () => {
      throw new Error('database is down')
    },
    () => ({ status: 'unavailable', retryable: true, reason: 'our server could not finish' }) as VaultAdmissionAnswer,
  ]) {
    const v = vaultAt(1, 300_000, 300_010)
    const h = harness(new Chain().add(v), { answer })
    const sweep = createVaultSweep(h.deps)
    await sweep.tick()
    assert.equal(h.asked.length, 1)
    h.clock.t += 4 * 60_000
    await sweep.tick()
    assert.equal(h.asked.length, 1, 'too soon')
    h.clock.t += 60_000
    await sweep.tick()
    assert.equal(h.asked.length, 2)
  }
})

test('a contract that never reads does not keep first place on the longest-wait turn', async () => {
  const chain = new Chain()
  const flooder = '0x9999999999999999999999999999999999999999' as Hex
  const neverRead = Array.from({ length: 8 }, (_, i) => vaultAt(100 + i, 200_000 + i, 200_010 + i, flooder))
  const real = vaultAt(1, 300_000, 300_010)
  chain.add(...neverRead, real)
  const unreadable = new Set(neverRead.map((c) => c.address))
  const only = host(chain, 'only', {
    maxSpan: 100_000_000,
    on: (method, params) => {
      const to = method === 'eth_call' ? (params[0] as { to: string }).to : method === 'eth_getCode' ? (params[0] as string) : null
      return to && unreadable.has(to) ? new Error('502') : undefined
    },
  })
  let times = 0
  const h = harness(chain, {
    hostList: [only],
    answer: () => {
      times++
      return refused(true, 'session-key-expiry')
    },
  })
  // It has been asked already, so only the longest-wait turn reaches it: the random turn is held to the same place.
  // The few reads a tick all go on the contracts ahead of it, if those keep their place.
  const sweep = createVaultSweep({ ...h.deps, pick: () => 0, limits: { readsPerTick: 8, logReadsPerTick: 1, startSpan: 10_000_000 } })
  for (let i = 0; i < 12 && times === 0; i++) await sweep.tick()
  assert.equal(times, 1, 'asked once, as the newest')
  const asksBefore = times
  for (let i = 0; i < 12; i++) {
    h.clock.t += 2 * 3600_000
    await sweep.tick()
  }
  assert.ok(times > asksBefore + 1, `asked again and again past the ones that never read: ${times - asksBefore}`)
})

test('a host that answered is asked first next time, so a pruned one costs one read and not one per step', async () => {
  const v = vaultAt(1, 300_000, 300_010)
  const chain = new Chain().add(v)
  const pruned = host(chain, 'pruned', { on: (method) => (method === 'eth_getCode' ? new Error('state at block is pruned') : undefined) })
  const h = harness(chain, { hostList: [pruned, host(chain, 'good')] })
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [v.deployTx])
  // The check of the block before asks every host once: so the pruned host is read for that, and for the first step.
  assert.ok(chain.reads.filter((r) => r === 'pruned eth_getCode').length <= 2, `${chain.reads.filter((r) => r === 'pruned eth_getCode').length} reads of the pruned host`)
})

test('an owner word that is no address rules a contract out with no bisect', async () => {
  const v = vaultAt(1, 300_000, 300_010)
  const chain = new Chain().add(v)
  const dirty = host(chain, 'one', { on: (method, params) => (method === 'eth_call' && (params[0] as { data: string }).data === OWNER_CALL ? `0x${'ff'.repeat(12)}${OWNER.slice(2)}` : undefined) })
  const h = harness(chain, { hostList: [dirty] })
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [])
  assert.equal(chain.reads.filter((r) => /getCode/.test(r)).length, 0)
})

test('a transaction with a to is no creation, even with the sender and nonce that would make that address', async () => {
  const v = vaultAt(1, 300_000, 300_010)
  const chain = new Chain().add(v)
  const called = host(chain, 'one', {
    on: (method, params) => {
      if (method !== 'eth_getBlockByNumber') return undefined
      return { number: params[0], transactions: [{ hash: v.deployTx, from: v.from, to: OPERATOR, nonce: `0x${v.nonce.toString(16)}` }], transactionsRoot: `0x${'ab'.repeat(32)}` }
    },
  })
  const h = harness(chain, { hostList: [called] })
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [])
  assert.ok(h.lines.some((l) => l.includes('no direct creation')))
})

test('code at block 0 with no creation there is closed, with no read of a block before it', async () => {
  const v = vaultAt(1, 0, 300_010, OWNER, { deployTx: null })
  const chain = new Chain().add(v)
  const h = harness(chain)
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, null, 'nothing threw')
  assert.ok(h.lines.some((l) => l.includes('no direct creation')))
})

// -- a block no host will read -------------------------------------------------------------

const refusing = (chain: Chain, label: string, block: () => number | null, over: { receipts?: boolean } = {}) =>
  host(chain, label, {
    on: (method, params) => {
      const at = block()
      if (at === null) return undefined
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
        return num(fromBlock) <= at && at <= num(toBlock) ? new Error('query exceeds max results 20000') : undefined
      }
      if (method === 'eth_getBlockReceipts' && over.receipts && num(params[0]) === at) return new Error('response too large')
      return undefined
    },
  })

test('a block every host refuses for good: the vaults after it are still found, and the public block keeps saying so', async () => {
  const FULL = 250_000
  const inside = vaultAt(1, 240_000, FULL)
  const after = vaultAt(2, 300_000, 350_000)
  const chain = new Chain().add(inside, after)
  let block: number | null = FULL
  const hosts = [refusing(chain, 'one', () => block, { receipts: true }), refusing(chain, 'two', () => block, { receipts: true })]
  const h = harness(chain, { hostList: hosts, limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.ok(h.asked.includes(after.deployTx as string), 'the vault after it was found')
  assert.ok(!h.asked.includes(inside.deployTx as string))
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20), 'the scan went on past it')
  assert.equal(sweep.status().lastProblem, 'logs-not-read')
  assert.ok(h.lines.some((l) => l.includes('250000') && l.includes('max results')), 'the raw text is in the log')

  // Not read again too soon, and still open.
  h.clock.t += 60_000
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'logs-not-read', 'it stays open')

  // Once a host will read it, the vault inside it is found, and the word clears.
  block = null
  h.clock.t += 3600_000
  await sweep.tick()
  assert.ok(h.asked.includes(inside.deployTx as string), 'the hole was read, and the vault in it is found')
  h.clock.t += 5 * 60_000
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, null)
})

test('a restart goes through the same block too: no vault after it is lost', async () => {
  const FULL = 250_000
  const after = vaultAt(2, 300_000, 350_000)
  const chain = new Chain().add(after)
  const hosts = [refusing(chain, 'one', () => FULL, { receipts: true })]
  const h = harness(chain, { hostList: hosts, answer: () => refused(true, 'vault-state'), limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  await createVaultSweep(h.deps).tick()
  assert.equal(h.asked.length, 1)
  const again = createVaultSweep(h.deps)
  await again.tick()
  assert.equal(h.asked.length, 2, 'found again after the restart')
  assert.equal(again.status().lastProblem, 'logs-not-read')
})

test('a block too full to list is read from its receipts, so a vault in it is found and no hole is left', async () => {
  const FULL = 250_000
  const inside = vaultAt(1, 240_000, FULL)
  const chain = new Chain().add(inside)
  const h = harness(chain, { hostList: [refusing(chain, 'one', () => FULL)], limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [inside.deployTx])
  assert.equal(sweep.status().lastProblem, null)
  assert.ok(!h.lines.some((l) => l.includes('logs-not-read')))
})

test('from receipts it takes this topic alone, and no log the chain removed', async () => {
  const FULL = 250_000
  const inside = vaultAt(1, 240_000, FULL)
  const chain = new Chain().add(inside)
  const refuser = refusing(chain, 'one', () => FULL)
  const removedOne = { address: '0x7777777777777777777777777777777777777777', topics: [TOPIC], removed: true }
  const withRemoved: RpcHost = {
    label: 'one',
    request: async (method, params) => {
      const answer = await refuser.request(method, params)
      if (method !== 'eth_getBlockReceipts') return answer
      return (answer as { logs: unknown[] }[]).map((r, i) => (i === 0 ? { ...r, logs: [...r.logs, removedOne] } : r))
    },
  }
  const h = harness(chain, { hostList: [withRemoved], limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [inside.deployTx])
  assert.ok(!h.lines.some((l) => l.includes('no direct creation')), 'nothing else became a candidate: not the other topic, and not the removed log')
})

test('after a full block or a crowded range the scan goes back to the width that worked, and is done in one tick', async () => {
  const chain = new Chain()
  const FULL = 150_000
  const CROWDED = 300_000
  const only = host(chain, 'only', {
    maxSpan: 20_000,
    on: (method, params) => {
      if (method === 'eth_getBlockReceipts') return new Error('response too large')
      if (method !== 'eth_getLogs') return undefined
      const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
      const holds = (b: number) => num(fromBlock) <= b && b <= num(toBlock)
      if (holds(FULL)) return new Error('query exceeds max results 20000')
      return holds(CROWDED) && num(toBlock) - num(fromBlock) > 150 ? new Error('query exceeds max results 20000') : undefined
    },
  })
  const h = harness(chain, { hostList: [only], limits: { readsPerTick: 200, logReadsPerTick: 100 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20), `done within the cap of 100: ${chain.reads.filter((r) => r.includes('getLogs')).length} reads`)
})

test('a full block with nothing read before it this tick does not leave the scan at one block a read', async () => {
  const chain = new Chain()
  const only = host(chain, 'only', {
    maxSpan: 100_000_000,
    on: (method, params) => {
      if (method === 'eth_getBlockReceipts') return new Error('response too large')
      if (method !== 'eth_getLogs') return undefined
      const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
      return num(fromBlock) <= START && START <= num(toBlock) ? new Error('query exceeds max results 20000') : undefined
    },
  })
  const h = harness(chain, { hostList: [only] })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20))
})

test('receipts only count against a whole block: a short list or an empty body leaves a hole', async () => {
  const FULL = 250_000
  const inside = vaultAt(1, 240_000, FULL)
  const after = vaultAt(2, 300_000, 350_000)
  for (const answer of [
    // As Blockdaemon does at an old block: no transactions under a root that says otherwise, and no receipts.
    { block: { transactions: [], transactionsRoot: `0x${'ab'.repeat(32)}` }, receipts: [] },
    // One receipt short.
    { block: null, receipts: [] },
    // The wrong transactions.
    { block: null, receipts: [{ transactionHash: hashOf(4242), blockNumber: `0x${FULL.toString(16)}`, logs: [] }] },
    // The right transaction, from another block.
    { block: null, receipts: [{ transactionHash: hashOf(999), blockNumber: `0x${(FULL - 1).toString(16)}`, logs: [] }] },
  ]) {
    const chain = new Chain().add(inside, after)
    const refuser = refusing(chain, 'one', () => FULL)
    const odd: RpcHost = {
      label: 'odd',
      request: async (method, params) => {
        if (method === 'eth_getBlockByNumber' && answer.block && num(params[0]) === FULL) return { number: params[0], ...answer.block }
        if (method === 'eth_getBlockReceipts' && num(params[0]) === FULL) return answer.receipts
        return refuser.request(method, params)
      },
    }
    const h = harness(chain, { hostList: [odd], limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
    const sweep = createVaultSweep(h.deps)
    await sweep.tick()
    assert.deepEqual(h.asked, [after.deployTx], 'nothing was concluded about the block')
    assert.equal(sweep.status().lastProblem, 'logs-not-read', JSON.stringify(answer))
  }
})

test('a block refused while the one before it does not read either is an outage: no hole, and the cursor stays', async () => {
  const chain = new Chain().add(vaultAt(1, 240_000, 250_000))
  let down = true
  // The hosts answer up to here, and then stop answering logs altogether.
  const stopsAt = 201_000
  const stopsAnswering = host(chain, 'one', {
    on: (method, params) => {
      if (method !== 'eth_getLogs' || !down) return undefined
      const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
      return num(toBlock) >= stopsAt || answeredOnce(num(fromBlock)) ? new Error('502') : undefined
    },
  })
  let answered = false
  const answeredOnce = (from: number) => {
    const was = answered && from < stopsAt
    if (from >= stopsAt - 5000) answered = true
    return was
  }
  const h = harness(chain, { hostList: [stopsAnswering], limits: { startSpan: 5000, logReadsPerTick: 1000, readsPerTick: 2000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  const stopped = Number(sweep.status().lastBlockRead)
  assert.ok(stopped < stopsAt, `the cursor stayed behind the blocks it could not read: ${stopped}`)
  assert.equal(sweep.status().lastProblem, 'logs-not-read')
  down = false
  h.clock.t += 60_000
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, null, 'and with no hole left behind, the word clears as soon as it reads')
  assert.equal(h.asked.length, 1)
})

test('holes are read again a few a tick and later each time, so they cannot take the whole read budget', async () => {
  const chain = new Chain()
  const FULL = new Set(Array.from({ length: 12 }, (_, i) => 200_000 + i * 1000))
  const refuser = host(chain, 'one', {
    on: (method, params) => {
      if (method === 'eth_getBlockReceipts') return new Error('response too large')
      if (method !== 'eth_getLogs') return undefined
      const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
      return [...FULL].some((b) => num(fromBlock) <= b && b <= num(toBlock)) ? new Error('too many results') : undefined
    },
  })
  const h = harness(chain, { hostList: [refuser], limits: { logReadsPerTick: 1000, readsPerTick: 2000, holeRetriesPerTick: 3 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20))
  const logReads = () => chain.reads.filter((r) => r === 'one eth_getLogs').length
  let before = logReads()
  await sweep.tick()
  assert.equal(logReads() - before, 0, 'too soon')
  let total = 0
  for (let i = 0; i < 12; i++) {
    h.clock.t += 5 * 60_000
    before = logReads()
    await sweep.tick()
    assert.ok(logReads() - before <= 3, `three a tick at most: ${logReads() - before}`)
    total += logReads() - before
    assert.equal(sweep.status().lastProblem, 'logs-not-read', 'and each stays open')
  }
  assert.ok(total >= 12, `every one of them gets its turn: ${total}`)
})

test('a hole waits longer each time, up to the most a retry waits', async () => {
  const FULL = 250_000
  const chain = new Chain()
  const h = harness(chain, { hostList: [refusing(chain, 'one', () => FULL, { receipts: true })], limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  const readsOf = () => chain.reads.filter((r) => r === 'one eth_getBlockReceipts').length
  assert.equal(readsOf(), 1)
  const at: number[] = []
  for (let minute = 1; minute <= 300; minute++) {
    h.clock.t += 60_000
    const before = readsOf()
    await sweep.tick()
    if (readsOf() > before) at.push(minute)
  }
  assert.deepEqual(at.slice(0, 4), [5, 15, 35, 75], 'waits of 5, 10, 20 and 40 minutes')
  assert.deepEqual(at.slice(4, 6), [135, 195], 'and then an hour, and never given up on')
})

// -- the live wiring -----------------------------------------------------------------------

const KEY = `0x${'ab'.repeat(32)}`

test('the real deps: a process with no key env is not ready, and makes no chain read on that account', () => {
  const none = liveVaultSweepDeps({})
  assert.ok(!('error' in none))
  assert.equal(none.ready(), false, 'a local or CI backend with no key env makes no chain reads')
  const held = liveVaultSweepDeps({ CELO_BUYER_KEY: KEY })
  assert.ok(!('error' in held))
  assert.equal(held.ready(), true)
  const unreadable = liveVaultSweepDeps({ CELO_BUYER_KEY: 'not a key' })
  assert.ok(!('error' in unreadable))
  assert.equal(unreadable.ready(), false, 'a key it cannot read is not a key it compared')
  assert.equal(held.registryUsdc, USDC)
  assert.equal(held.startBlock, ARC_VAULT_SWEEP_START_BLOCK)
  const elsewhere = liveVaultSweepDeps({ ARC_VAULT_SWEEP_START_BLOCK: '42' })
  assert.ok(!('error' in elsewhere))
  assert.equal(elsewhere.startBlock, 42)
  assert.ok(held.hosts().length >= 2, 'the hosts come from the registry')
})

test('the real deps: the list is lowercased, because rows are checksummed and candidates are not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arc-sweep-'))
  const file = join(dir, 'vaults.json')
  const CHECKSUMMED = getCreateAddress({ from: OWNER, nonce: 1n })
  assert.notEqual(CHECKSUMMED, CHECKSUMMED.toLowerCase(), 'this address has capitals to lose')
  writeFileSync(file, JSON.stringify([{ address: CHECKSUMMED, deployTx: hashOf(1) }]))
  const deps = liveVaultSweepDeps({ CELO_BUYER_KEY: KEY }, { getPool: async () => null, file })
  assert.ok(!('error' in deps))
  const read = await deps.counted()
  assert.ok(read.ok)
  assert.deepEqual([...read.vaults], [CHECKSUMMED.toLowerCase()])

  const down = liveVaultSweepDeps({ CELO_BUYER_KEY: KEY }, { getPool: async () => ({ query: async () => { throw new Error('pg is down') } }) })
  assert.ok(!('error' in down))
  assert.equal((await down.counted()).ok, false, 'an unreadable list stays unreadable')
})

test('the real deps say who found the row, and are otherwise the same as the route', () => {
  const deps = sweepAdmissionDeps({ CELO_BUYER_KEY: KEY })
  assert.equal(deps.foundBy, 'sweep')
  assert.deepEqual(Object.keys(deps).sort(), ['admit', 'findByTx', 'foundBy', 'persist'])
  const source = readFileSync(new URL('../src/arc-vault-sweep.ts', import.meta.url), 'utf8')
  assert.match(source, /admitVaultDeploy\(\{ deployTx \}, sweepAdmissionDeps\(env\)\)/, 'and the sweep goes through them')
})

test('the timer does not hold the process open, and a tick that throws does not end it', async () => {
  const timers: { run: () => void; ms: number; unrefd: boolean }[] = []
  const setTimer = (run: () => void, ms: number) => {
    const t = { run, ms, unrefd: false }
    timers.push(t)
    return {
      unref() {
        t.unrefd = true
      },
    }
  }
  let ticks = 0
  const lines: string[] = []
  const stop = runOnTimer(
    async () => {
      ticks++
      throw new Error('a tick failed')
    },
    { everyMs: 1000, firstAfterMs: 50, setTimer, log: (l) => lines.push(l) },
  )
  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 50)
  assert.equal(timers[0].unrefd, true)
  timers[0].run()
  await new Promise((r) => setImmediate(r))
  assert.equal(ticks, 1)
  assert.ok(lines.some((l) => l.includes('a tick failed')))
  assert.equal(timers.length, 2, 'the next is scheduled anyway')
  assert.equal(timers[1].ms, 1000)
  assert.equal(timers[1].unrefd, true)
  stop()
  timers[1].run()
  await new Promise((r) => setImmediate(r))
  assert.equal(timers.length, 2, 'and stop stops it')

  const broken = runOnTimer(async () => {}, {
    everyMs: 1000,
    firstAfterMs: 1,
    setTimer: () => {
      throw new Error('no timers today')
    },
    log: (l) => lines.push(l),
  })
  assert.equal(typeof broken, 'function', 'a timer that cannot start throws nothing out')
})

test('the off switch: off in plain words, and the rest of the config falls back on a typo', () => {
  for (const v of ['off', 'OFF', '0', 'false', 'no', ' off ']) assert.equal(sweepConfig({ ARC_VAULT_SWEEP: v }).on, false, v)
  for (const v of [undefined, '', 'on', '1', 'yes']) assert.equal(sweepConfig({ ARC_VAULT_SWEEP: v }).on, true, String(v))
  assert.equal(sweepConfig({}).everyMs, 5 * 60_000)
  assert.equal(sweepConfig({ ARC_VAULT_SWEEP_EVERY_SECONDS: '60' }).everyMs, 60_000)
  for (const v of ['0', '-5', '1e3', 'soon']) assert.equal(sweepConfig({ ARC_VAULT_SWEEP_EVERY_SECONDS: v }).everyMs, 5 * 60_000, v)
  assert.equal(sweepConfig({ ARC_VAULT_SWEEP_START_BLOCK: '42' }).startBlock, 42)
  assert.equal(sweepConfig({ ARC_VAULT_SWEEP_START_BLOCK: 'x' }).startBlock, ARC_VAULT_SWEEP_START_BLOCK)
})

test('GET /api/arc/vaults says what the sweep is doing, in that block and nothing more', async () => {
  // Never started in this process, which is what off looks like.
  assert.deepEqual(vaultSweepStatus(), { on: false, lastBlockRead: null, lastRun: null, lastProblem: null })
  let sent: { status: number; payload: string } | null = null
  const res = {
    setHeader() {},
    writeHead(status: number) {
      sent = { status, payload: '' }
    },
    end(payload: string) {
      if (sent) sent.payload = payload
    },
  }
  const url = new URL('http://localhost/api/arc/vaults')
  const handled = await handleArcSeasonRoutes({ req: { method: 'GET' }, res, url, caller: null, callerId: undefined } as unknown as Parameters<typeof handleArcSeasonRoutes>[0])
  assert.equal(handled, true)
  const body = JSON.parse((sent as unknown as { payload: string }).payload) as { sweep: Record<string, unknown> }
  assert.deepEqual(Object.keys(body.sweep).sort(), ['lastBlockRead', 'lastProblem', 'lastRun', 'on'])
  assert.equal(body.sweep.on, false)
})

test('every read goes to the hosts it was given, and the start block is not typed into this module', () => {
  const source = readFileSync(new URL('../src/arc-vault-sweep.ts', import.meta.url), 'utf8')
  assert.match(source, /ARC_VAULT_SWEEP_START_BLOCK/)
  assert.doesNotMatch(source, /new URL\(|fetch\(/, 'no read of its own')
})

test('a block that truly holds no transactions is whole, so a contract with code there and no creation is closed', async () => {
  const v = vaultAt(1, 300_000, 300_040, OWNER, { deployTx: null })
  const chain = new Chain().add(v)
  const empty = host(chain, 'empty', { on: (method, params) => (method === 'eth_getBlockByNumber' ? { number: params[0], transactions: [], transactionsRoot: EMPTY_ROOT } : undefined) })
  const h = harness(chain, { hostList: [empty] })
  await createVaultSweep(h.deps).tick()
  assert.deepEqual(h.asked, [])
  assert.ok(h.lines.some((l) => l.includes('no direct creation')))
})

test('the off switch reaches the live start: told to be off it stays off and starts nothing', () => {
  const timers: number[] = []
  for (const v of ['off', 'OFF', '0']) {
    startVaultSweep({ ARC_VAULT_SWEEP: v, CELO_BUYER_KEY: KEY }, (_run, ms) => {
      timers.push(ms)
      return {}
    })
    assert.deepEqual(vaultSweepStatus(), { on: false, lastBlockRead: null, lastRun: null, lastProblem: null }, v)
  }
  assert.deepEqual(timers, [])
})

// Last in this file: it turns the live sweep on for the rest of the process. Its timer is unref'd and its first tick is 30 seconds off.
test('with no off switch the live start turns it on, and sets its timer', () => {
  const timers: number[] = []
  let unrefd = 0
  startVaultSweep({ CELO_BUYER_KEY: KEY, ARC_VAULT_SWEEP_EVERY_SECONDS: '600' }, (_run, ms) => {
    timers.push(ms)
    return { unref: () => unrefd++ }
  })
  const status = vaultSweepStatus()
  assert.equal(status.on, true)
  assert.equal(status.lastRun, null)
  assert.deepEqual(timers, [30_000], 'the first tick waits for the health check')
  assert.equal(unrefd, 1, 'and holds nothing open')
})

test('a tick with nobody to ask reads nothing from the store, so a database that sleeps when idle can sleep', async () => {
  const v = vaultAt(3, 123_456, 123_999)
  const chain = new Chain().add(v)
  let reads = 0
  const h = harness(chain, {
    counted: async () => {
      reads++
      return { ok: true, vaults: new Set<string>() }
    },
  })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(reads, 1, 'a new process reads the list once, before any chain read')
  assert.deepEqual(h.asked, [v.deployTx])
  for (let i = 0; i < 3; i++) {
    h.clock.t += 5 * 60_000
    chain.head += 600
    await sweep.tick()
  }
  assert.equal(reads, 1, 'nobody to ask, so no read')
  assert.equal(sweep.status().lastProblem, null)

  // A vault that turns up later is checked against the list before it is asked about.
  const later = vaultAt(4, chain.head + 100, chain.head + 200)
  chain.add(later)
  chain.head += 600
  h.clock.t += 5 * 60_000
  await sweep.tick()
  assert.equal(reads, 2, 'someone to ask, so one read')
  assert.deepEqual(h.asked, [v.deployTx, later.deployTx])
})

test('a vault already on the list is not asked about, when the list was only read because it turned up', async () => {
  const chain = new Chain()
  const listed = new Set<string>()
  const h = harness(chain, { counted2: listed })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  const v = vaultAt(4, chain.head + 100, chain.head + 200)
  chain.add(v)
  listed.add(v.address)
  chain.head += 600
  h.clock.t += 5 * 60_000
  await sweep.tick()
  assert.deepEqual(h.asked, [], 'the list answered it')
  // The same vault with the list emptied is asked about, so the line above is the list's doing.
  const unlisted = harness(chain)
  await createVaultSweep(unlisted.deps).tick()
  assert.deepEqual(unlisted.asked, [v.deployTx])
})

test('a list that cannot be read when someone turns up says so, and asks nobody', async () => {
  const chain = new Chain()
  let up = true
  const h = harness(chain, { counted: async () => (up ? { ok: true, vaults: new Set<string>() } : { ok: false, reason: 'pg: down' }) })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  const v = vaultAt(4, chain.head + 100, chain.head + 200)
  chain.add(v)
  chain.head += 600
  up = false
  h.clock.t += 5 * 60_000
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'list-unreadable')
  assert.deepEqual(h.asked, [])
  up = true
  h.clock.t += 5 * 60_000
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx], 'and it is asked once the list reads')
})

test('a host that stalls after its headers is cut off at the read limit, and the next host answers', { timeout: 10_000 }, async () => {
  const v = vaultAt(3, 123_456, 123_999)
  const chain = new Chain().add(v)
  const stalled: RpcHost = { label: 'stalled', request: () => new Promise(() => {}) }
  const h = harness(chain, { hostList: [stalled, host(chain, 'two')], limits: { stalledAfterMs: 5 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [v.deployTx])
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20))
})

test('a hole is read again only on a host that has reached it: one far behind cannot close it with an empty list', async () => {
  const FULL = 250_000
  const inside = vaultAt(1, 240_000, FULL)
  const chain = new Chain().add(inside)
  let block: number | null = FULL
  const behind = host(chain, 'behind', { head: 100_000, on: (method) => (method === 'eth_getLogs' ? [] : undefined) })
  const hosts = [refusing(chain, 'one', () => block, { receipts: true }), refusing(chain, 'two', () => block, { receipts: true }), behind]
  const h = harness(chain, { hostList: hosts, limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'logs-not-read')
  h.clock.t += 3600_000
  await sweep.tick()
  assert.equal(sweep.status().lastProblem, 'logs-not-read', 'the host far behind did not close it')
  assert.deepEqual(h.asked, [])
  block = null
  h.clock.t += 3600_000
  await sweep.tick()
  assert.deepEqual(h.asked, [inside.deployTx], 'and it is found once a host that has the block reads it')
})

test('two refused blocks in a row are two holes, not an outage: the reread uses the last block a host answered', async () => {
  const FULL = [250_000, 250_001]
  const after = vaultAt(2, 300_000, 350_000)
  const chain = new Chain().add(after)
  const one = host(chain, 'one', {
    on: (method, params) => {
      const hit = (b: number) => FULL.includes(b)
      if (method === 'eth_getLogs') {
        const { fromBlock, toBlock } = (params as readonly { fromBlock: string; toBlock: string }[])[0]
        return FULL.some((b) => num(fromBlock) <= b && b <= num(toBlock)) ? new Error('query exceeds max results 20000') : undefined
      }
      if (method === 'eth_getBlockReceipts' && hit(num(params[0]))) return new Error('response too large')
      return undefined
    },
  })
  const h = harness(chain, { hostList: [one], limits: { logReadsPerTick: 1000, readsPerTick: 2000 } })
  const sweep = createVaultSweep(h.deps)
  await sweep.tick()
  assert.deepEqual(h.asked, [after.deployTx], 'the vault after both was found')
  assert.equal(sweep.status().lastBlockRead, String(chain.head - 20), 'the scan went on past both')
  assert.equal(sweep.status().lastProblem, 'logs-not-read')
})

test('a value too large for a timer falls back to the default, so a typo cannot make a busy loop', () => {
  assert.equal(sweepConfig({ ARC_VAULT_SWEEP_EVERY_SECONDS: '2147483' }).everyMs, 2_147_483_000)
  assert.equal(sweepConfig({ ARC_VAULT_SWEEP_EVERY_SECONDS: '2147484' }).everyMs, 300_000)
  assert.equal(sweepConfig({ ARC_VAULT_SWEEP_EVERY_SECONDS: '99999999999' }).everyMs, 300_000)
})

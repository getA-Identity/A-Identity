import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeEventTopics, encodeFunctionData, encodeFunctionResult, getCreateAddress, type Abi, type Hex } from 'viem'
import { encodeCreationInput, type OurAddresses } from './arc-owner-vault.js'
import { admissionContext, admitVaultDeploy, runAdmission, type AdmissionContext, type RpcHost, type VaultAdmissionAnswer } from './arc-owner-vault-live.js'
import { ARC_VAULT_SWEEP_START_BLOCK } from './arc-season.js'
import { createVaultSweep, runOnTimer, sweepConfig, vaultSweepStatus, type VaultSweepDeps } from './arc-vault-sweep.js'
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

test('under a flood the caps hold on every tick and the real owner is still reached', async () => {
  const chain = new Chain()
  const flooder = '0x9999999999999999999999999999999999999999' as Hex
  for (let i = 0; i < 40; i++) chain.add(vaultAt(100 + i, 200_000 + i * 10, 200_005 + i * 10, flooder))
  const real = vaultAt(5, 490_000, 490_010)
  chain.add(real)
  const h = harness(chain, { answer: (tx) => (tx === real.deployTx ? admitted(real.address, tx) : refused(true, 'session-key-expiry')) })
  const sweep = createVaultSweep({ ...h.deps, limits: { readsPerTick: 100, logReadsPerTick: 40, asksPerTick: 2, startSpan: 5000, retryAfterMs: 5 * 60_000, maxRetryAfterMs: 60 * 60_000 } })
  let ticks = 0
  while (!h.asked.includes(real.deployTx as string) && ticks < 100) {
    const reads = chain.reads.length
    const asks = h.asked.length
    await sweep.tick()
    ticks++
    assert.ok(chain.reads.length - reads <= 100, `reads per tick are capped: ${chain.reads.length - reads}`)
    assert.ok(h.asked.length - asks <= 2, 'admissions per tick are capped')
    h.clock.t += 5 * 60_000
  }
  assert.ok(h.asked.includes(real.deployTx as string), 'a flood delays a real owner and does not lock one out')
  assert.ok(ticks > 2, `it did delay: ${ticks} ticks`)
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

test('a stalled host costs its timeout once per tick, and a whole round has a deadline', async () => {
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

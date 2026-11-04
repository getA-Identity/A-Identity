import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData, encodeFunctionResult, getCreateAddress, type Abi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { OUR_KEY_PUBLIC_ADDRESSES, collectOurAddresses, encodeCreationInput, liveOurAddressSources, type OurAddresses } from './arc-owner-vault.js'
import {
  PLAIN_REFUSALS,
  admissionContext,
  admissionReadiness,
  admissionSlots,
  admitVaultDeploy,
  admittedVaultsFromStore,
  everyHost,
  listAdmittedVaults,
  plainRefusals,
  refusalIsRetryable,
  runAdmission,
  shortRpcError,
  withDeadline,
  type AdmissionContext,
  type RpcHost,
  type VaultAdmissionDeps,
} from './arc-owner-vault-live.js'
import { AgentSpendPolicyAbi, AgentSpendPolicyBytecode } from './contracts/AgentSpendPolicy.js'
import { rateBudget, rateLimited } from './rate-budget.js'
import { findAdmittedArcVaultByTx, loadAdmittedArcVaults, persistAdmittedArcVault, type ArcAdmittedVaultRecord, type ArcVaultStoreIo } from './storage.js'

/**
 * Admission against a chain made of plain answers, and the store behind the route.
 *
 * The rules themselves are arc-owner-vault.test.ts. What this holds is what the server added to
 * them: nothing refused is ever stored, a vault owned by one of our keys is refused however it got
 * there, a server without our env refuses everything, the same post twice is a no-op, and an
 * admitted vault is called admitted only when the store took it.
 */
const abi = AgentSpendPolicyAbi as unknown as Abi
const context = (admissionContext() as { ok: true; context: AdmissionContext }).context
const OWNER = '0x1111111111111111111111111111111111111111'
const OPERATOR = '0x2222222222222222222222222222222222222222'
const BLOCK_HASH = '0x' + 'bb'.repeat(32)
const TX = '0x' + 'aa'.repeat(32)
const NOW_SECONDS = 1_800_000_000n
const DEPLOY_SECONDS = 1_799_000_000n
const FAKE_KEY = '0x' + '77'.repeat(32)

type ChainFacts = {
  owner?: string
  sender?: string
  operator?: string
  dailyCap?: bigint
  sessionKeyExpiry?: bigint
  receipt?: boolean
  status?: string
  bytecode?: Hex
}

function fakeHost(label: string, facts: ChainFacts = {}, calls: string[] = []): RpcHost {
  const owner = facts.owner ?? OWNER
  const sender = facts.sender ?? owner
  const operator = facts.operator ?? OPERATOR
  const usdc = context.registryUsdc
  const dailyCap = facts.dailyCap ?? 1_000_000n
  const autoApproveMax = 250_000n
  const nonce = 7n
  const vault = getCreateAddress({ from: sender as Hex, nonce })
  const args = { owner, operator, usdc, dailyCap, autoApproveMax }
  const input = encodeCreationInput(facts.bytecode ?? (AgentSpendPolicyBytecode as Hex), abi, args)
  const state: Record<string, unknown> = {
    owner,
    operator,
    usdc,
    dailyCap,
    autoApproveMax,
    sessionKeyExpiry: facts.sessionKeyExpiry ?? NOW_SECONDS + 1000n,
    frozen: false,
    allowlistEnabled: false,
    balance: 5n,
  }
  const selectors = new Map(
    Object.keys(state).map((name) => {
      const out = encodeFunctionResult({ abi, functionName: name, result: state[name] } as never) as Hex
      return [name, out]
    }),
  )
  return {
    label,
    request: async (method, params) => {
      calls.push(method)
      switch (method) {
        case 'eth_getTransactionReceipt':
          if (facts.receipt === false) return null
          return { transactionHash: params[0], status: facts.status ?? '0x1', from: sender, to: null, contractAddress: vault, blockNumber: '0x64', blockHash: BLOCK_HASH }
        case 'eth_getTransactionByHash':
          if (facts.receipt === false) return null
          return { hash: params[0], from: sender, to: null, nonce: `0x${nonce.toString(16)}`, input, blockHash: BLOCK_HASH }
        case 'eth_getBlockByNumber':
          if (params[0] === 'latest') return { number: '0xc8', hash: '0x' + 'cc'.repeat(32), timestamp: `0x${NOW_SECONDS.toString(16)}` }
          return { number: params[0], hash: BLOCK_HASH, timestamp: `0x${DEPLOY_SECONDS.toString(16)}` }
        case 'eth_getCode':
          return '0x6001'
        case 'eth_call': {
          const data = (params[0] as { data: string }).data
          if (data.length > 100) return '0x6001' // the simulated creation
          for (const [name, out] of selectors) {
            if (encodeSelector(name) === data) return out
          }
          throw new Error(`no such getter ${data}`)
        }
        default:
          throw new Error(`unexpected ${method}`)
      }
    },
  }
}

// The four-byte calldata of a getter that takes no arguments.
const encodeSelector = (name: string) => encodeFunctionData({ abi, functionName: name })

function ours(extra: string[] = [], over: Partial<OurAddresses> = {}): OurAddresses {
  return { byAddress: new Map(extra.map((a) => [a.toLowerCase(), ['a test wallet of ours']])), envKeysDerived: ['A_KEY'], envKeysUnreadable: [], keysCommitted: [], keysNotCompared: [], ...over }
}

function tmpIo(): ArcVaultStoreIo {
  const dir = mkdtempSync(join(tmpdir(), 'arc-vaults-'))
  return { getPool: async () => null, file: join(dir, 'vaults.json') }
}

/** The route's core on a chain of plain answers and a real file store. */
function routeDeps(facts: ChainFacts = {}, opts: { ours?: OurAddresses; io?: ArcVaultStoreIo; calls?: string[]; hosts?: RpcHost[] } = {}): VaultAdmissionDeps {
  const io = opts.io ?? tmpIo()
  return {
    findByTx: (hash) => findAdmittedArcVaultByTx(hash, io),
    persist: (rec) => persistAdmittedArcVault(rec, io),
    now: () => Date.parse('2026-11-03T10:00:00Z'),
    admit: (tx) => runAdmission({ context, hosts: opts.hosts ?? [fakeHost('one', facts, opts.calls), fakeHost('two', facts, opts.calls)], tx, ours: opts.ours ?? ours(), requireEnvKeys: true }),
  }
}

test('a vault that passes every check is admitted and stored, its owner not identified', async () => {
  const io = tmpIo()
  const { httpStatus, answer } = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { io }))
  assert.equal(httpStatus, 200)
  assert.equal(answer.status, 'admitted')
  if (answer.status !== 'admitted') return
  assert.equal(answer.alreadyAdmitted, false)
  assert.equal(answer.owner, OWNER)
  assert.equal(answer.countedOn, 'https://a-identity.xyz/proof/arc')
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.equal(read.rows.length, 1)
  assert.equal(read.rows[0].ownerKind, 'unstated')
  assert.equal(read.rows[0].deployTx, TX)
  assert.equal(read.rows[0].deployBlock, '100')
  assert.equal(read.rows[0].deployedAt, '2027-01-03')
  assert.match(read.rows[0].note, /not identified/)
})

test('refused vaults are never stored, and each refusal says why in plain words', async () => {
  const cases: [string, ChainFacts, string][] = [
    ['a reverted deploy', { status: '0x0' }, 'receipt-success'],
    ['no cap', { dailyCap: 0n }, 'daily-cap'],
    ['the agent key is the owner', { operator: OWNER }, 'operator-set'],
    ['no end date on the key', { sessionKeyExpiry: 0n }, 'session-key-expiry'],
    ['an expired key', { sessionKeyExpiry: NOW_SECONDS - 1n }, 'session-key-expiry'],
    ['another wallet deployed it', { sender: '0x3333333333333333333333333333333333333333' }, 'owner-sent-deploy'],
    ['another build', { bytecode: '0x6000' }, 'creation-input'],
  ]
  for (const [name, facts, id] of cases) {
    const io = tmpIo()
    const { answer } = await admitVaultDeploy({ deployTx: TX }, routeDeps(facts, { io }))
    assert.equal(answer.status, 'refused', name)
    if (answer.status !== 'refused') continue
    const hit = answer.reasons.find((r) => r.id === id)
    assert.ok(hit, `${name}: expected ${id} among ${answer.reasons.map((r) => r.id).join(', ')}`)
    assert.equal(hit.reason, PLAIN_REFUSALS[id])
    const read = await loadAdmittedArcVaults(io)
    assert.ok(read.ok)
    assert.deepEqual(read.rows, [], `${name} was stored`)
  }
})

test('a vault owned by any of our keys is refused and never stored: committed lists and the env alike', async () => {
  const io = tmpIo()
  const listed = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { io, ours: ours([OWNER.toUpperCase().replace('0X', '0x')]) }))
  assert.equal(listed.answer.status, 'refused')
  if (listed.answer.status === 'refused') {
    const hit = listed.answer.reasons.find((r) => r.id === 'owner-not-ours')
    assert.ok(hit)
    assert.equal(hit.detail, undefined, 'a public refusal must not say which of our keys it is')
    assert.equal(listed.answer.retryable, false)
  }

  // A key only the env knows: its address is derived, and the deploy from it is refused.
  const fromEnv = privateKeyToAccount(FAKE_KEY as Hex).address
  const envOurs = collectOurAddresses({ provenance: [], gatewayInternalPayers: [], facilitatorInternalPayers: [], attestationValidators: [], committedKeyAddresses: {}, keyEnvVars: ['SOME_KEY'], addressEnvVars: [], env: { SOME_KEY: FAKE_KEY } })
  const viaEnv = await admitVaultDeploy({ deployTx: TX }, routeDeps({ owner: fromEnv }, { io, ours: envOurs }))
  assert.equal(viaEnv.answer.status, 'refused')
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.deepEqual(read.rows, [])
})

test('a server without our key env admits nothing, says that is about the server, and GET says so before anyone deploys', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const noEnv = ours([], { envKeysDerived: [] })
  const io = tmpIo()
  const none = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { io, ours: noEnv }))
  assert.equal(none.httpStatus, 503)
  assert.deepEqual(none.answer, { status: 'unavailable', retryable: true, reason: 'our server could not finish its own safety check, so nothing was decided' })
  assert.match(JSON.stringify(logged.mock.calls.map((c) => c.arguments)), /--env-file/, 'the detail stays in the log')
  const bad = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { io, ours: ours([], { envKeysUnreadable: ['B_KEY'] }) }))
  assert.equal(bad.answer.status, 'unavailable', 'a key it cannot read is the same: nothing is admitted')
  assert.doesNotMatch(JSON.stringify(bad.answer), /B_KEY/)
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.deepEqual(read.rows, [])
  assert.equal(admissionReadiness(noEnv).ready, false)
  assert.deepEqual(admissionReadiness(ours([], { envKeysUnreadable: ['B_KEY'] })), { ready: false, keysCompared: 1, keysUnreadable: ['B_KEY'], keysNotCompared: [] })
  assert.equal(admissionReadiness(ours()).ready, true)
})

test('a vault owned by a key neither this server holds nor the repo commits is not caught, and the server names that key', async () => {
  const onlyThis = { ARC_SIGNER_KEY: '0x' + '11'.repeat(32) } as NodeJS.ProcessEnv
  const funderKey = ('0x' + '22'.repeat(32)) as Hex
  const funder = privateKeyToAccount(funderKey).address
  const server = collectOurAddresses(liveOurAddressSources(onlyThis))

  // The rule is what it was: passing envLoadedCheck does not need every key. What changed is that it says so.
  const ready = admissionReadiness(server)
  assert.equal(ready.ready, true)
  assert.ok(ready.keysNotCompared.includes('X402_3009_FUNDER_KEY'), 'named on GET')
  assert.ok(!ready.keysNotCompared.includes('ARC_SIGNER_KEY'), 'a key it holds was compared')
  assert.ok(!ready.keysNotCompared.includes('X402_3009_BUYER_KEY'), 'a key with a committed address was compared, set or not')
  assert.equal(ready.keysCompared, 1 + Object.values(OUR_KEY_PUBLIC_ADDRESSES).filter(Boolean).length)
  assert.equal((await admitVaultDeploy({ deployTx: TX }, routeDeps({ owner: funder }, { ours: server }))).answer.status, 'admitted')

  // With the key in env, or its public address committed, the same deploy is refused as ours.
  const withKey = collectOurAddresses(liveOurAddressSources({ ...onlyThis, X402_3009_FUNDER_KEY: funderKey } as NodeJS.ProcessEnv))
  const refusedByKey = await admitVaultDeploy({ deployTx: TX }, routeDeps({ owner: funder }, { ours: withKey }))
  assert.ok(refusedByKey.answer.status === 'refused' && refusedByKey.answer.reasons.some((r) => r.id === 'owner-not-ours'))
  const committed = collectOurAddresses({ ...liveOurAddressSources(onlyThis), committedKeyAddresses: { ...OUR_KEY_PUBLIC_ADDRESSES, X402_3009_FUNDER_KEY: funder } })
  assert.ok(!committed.keysNotCompared.includes('X402_3009_FUNDER_KEY'))
  const refusedByAddress = await admitVaultDeploy({ deployTx: TX }, routeDeps({ owner: funder }, { ours: committed }))
  assert.ok(refusedByAddress.answer.status === 'refused' && refusedByAddress.answer.reasons.some((r) => r.id === 'owner-not-ours'))

  // What a row and GET publish claim only what was done.
  const live = readFileSync(new URL('../src/arc-owner-vault-live.ts', import.meta.url), 'utf8')
  assert.match(live, /its owner is none of the keys it was compared with/)
  assert.doesNotMatch(live, /its owner is none of our keys/)
})

/** A host that answers as `base` does, except for what `change` returns something other than undefined for. */
const alteredHost = (label: string, change: (method: string, params: readonly unknown[], real: () => Promise<unknown>) => Promise<unknown> | undefined): RpcHost => {
  const base = fakeHost(label)
  return { label, request: (method, params) => change(method, params, () => base.request(method, params)) ?? base.request(method, params) }
}

test('hosts that disagree about the transaction are retryable, not a verdict, and nothing is stored', async () => {
  const io = tmpIo()
  const otherNonce = alteredHost('two', (method, _params, real) =>
    method === 'eth_getTransactionByHash' ? real().then((t) => ({ ...(t as object), nonce: '0x8' })) : undefined,
  )
  const { answer } = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { io, hosts: [fakeHost('one'), otherNonce] }))
  assert.equal(answer.status, 'refused')
  if (answer.status !== 'refused') return
  assert.deepEqual(answer.reasons.map((r) => r.id), ['creation-tx'])
  assert.equal(answer.retryable, true)
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.deepEqual(read.rows, [])

  // One honest answer that it is no creation stays a fact about this transaction.
  const calls = alteredHost('one', (method, _params, real) =>
    method === 'eth_getTransactionByHash' ? real().then((t) => ({ ...(t as object), to: OPERATOR })) : undefined,
  )
  const fact = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { hosts: [calls] }))
  assert.ok(fact.answer.status === 'refused' && fact.answer.retryable === false)
})

test('a simulation that disagrees with a creation input that matched is retryable and blames no vault; one that did not match stays a verdict', async () => {
  const io = tmpIo()
  const wrongBytes = alteredHost('one', (method, params) =>
    method === 'eth_call' && (params[0] as { data: string }).data.length > 100 ? Promise.resolve('0x6002') : undefined,
  )
  const { answer } = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { io, hosts: [wrongBytes] }))
  assert.equal(answer.status, 'refused', 'the check still refuses: a matched input does not waive it')
  if (answer.status !== 'refused') return
  assert.deepEqual(answer.reasons.map((r) => r.id), ['runtime-code'])
  assert.equal(answer.retryable, true)
  assert.doesNotMatch(answer.reasons[0].reason, /is not the vault contract/)
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.deepEqual(read.rows, [])

  const otherBuild = await admitVaultDeploy({ deployTx: TX }, routeDeps({ bytecode: '0x6000' }))
  assert.equal(otherBuild.answer.status, 'refused')
  if (otherBuild.answer.status !== 'refused') return
  assert.equal(otherBuild.answer.retryable, false)
  assert.ok(otherBuild.answer.reasons.some((r) => r.id === 'creation-input' && /is not the vault contract/.test(r.reason)))
})

test('admissions past the cap read nothing and answer unavailable, and the slot comes back', async (t) => {
  t.mock.method(console, 'error', () => {})
  const slot = admissionSlots(2)
  let release = () => {}
  const held = new Promise<void>((r) => (release = r))
  const first = slot(() => held)
  const second = slot(() => held)
  let read = false
  await assert.rejects(slot(async () => (read = true)), /too many admissions/)
  assert.equal(read, false, 'no chain read was made')

  const io = tmpIo()
  const busy = await admitVaultDeploy({ deployTx: TX }, { ...routeDeps({}, { io }), admit: () => slot(async () => { throw new Error('never reached') }) })
  assert.equal(busy.httpStatus, 503)
  assert.deepEqual(busy.answer, { status: 'unavailable', retryable: true, reason: 'the deploy could not be checked just now, so nothing was decided' })
  release()
  await Promise.all([first, second])
  assert.equal(await slot(async () => 'free'), 'free')
  await assert.rejects(slot(async () => { throw new Error('a failed read') }), /failed read/)
  assert.equal(await slot(async () => 'free again'), 'free again', 'a read that throws gives its slot back')

  const src = readFileSync(new URL('../src/arc-owner-vault-live.ts', import.meta.url), 'utf8')
  assert.match(src, /admit: \(deployTx\) =>\s+liveAdmissionSlot\(/, 'the route reads the chain through the slots')
})

test('the same deploy posted twice is a no-op: no second row and no chain read', async () => {
  const io = tmpIo()
  const calls: string[] = []
  const deps = routeDeps({}, { io, calls })
  const first = await admitVaultDeploy({ deployTx: TX }, deps)
  assert.equal(first.answer.status, 'admitted')
  const readsAfterFirst = calls.length
  assert.ok(readsAfterFirst > 0)
  // Upper case hex is the same hash.
  const second = await admitVaultDeploy({ deployTx: '0x' + TX.slice(2).toUpperCase() }, deps)
  assert.equal(second.answer.status, 'admitted')
  if (second.answer.status === 'admitted') assert.equal(second.answer.alreadyAdmitted, true)
  assert.equal(calls.length, readsAfterFirst, 'a known hash must answer from the store')
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.equal(read.rows.length, 1)
})

test('two posts racing past the lookup still leave one row', async () => {
  const io = tmpIo()
  const deps = { ...routeDeps({}, { io }), findByTx: async () => ({ ok: true as const, row: null }) }
  const [a, b] = await Promise.all([admitVaultDeploy({ deployTx: TX }, deps), admitVaultDeploy({ deployTx: TX }, deps)])
  assert.equal(a.answer.status, 'admitted')
  assert.equal(b.answer.status, 'admitted')
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.equal(read.rows.length, 1)
})

test('an admitted vault the store could not take is not called admitted, and neither is an unreadable store', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const loggedText = () => JSON.stringify(logged.mock.calls.map((c) => c.arguments))

  const failing = { ...routeDeps(), persist: async () => ({ ok: false as const, reason: 'disk full at /var/data' }) }
  const unstored = await admitVaultDeploy({ deployTx: TX }, failing)
  assert.equal(unstored.httpStatus, 503)
  assert.deepEqual(unstored.answer, { status: 'unavailable', retryable: true, reason: 'every check passed but the vault could not be recorded' })
  assert.match(loggedText(), /disk full at \/var\/data/, 'the raw text stays in the server log')

  const calls: string[] = []
  const blind = { ...routeDeps({}, { calls }), findByTx: async () => ({ ok: false as const, reason: 'connect ECONNREFUSED db.internal:5432' }) }
  const unread = await admitVaultDeploy({ deployTx: TX }, blind)
  assert.equal(unread.httpStatus, 503)
  assert.deepEqual(unread.answer, { status: 'unavailable', retryable: true, reason: 'the list of admitted vaults could not be read' })
  assert.equal(calls.length, 0)
  assert.match(loggedText(), /db\.internal/)

  const broken = { ...routeDeps(), admit: async () => { throw new Error('registry gone at https://key@rpc.example') } }
  const thrown = await admitVaultDeploy({ deployTx: TX }, broken)
  assert.equal(thrown.httpStatus, 503)
  assert.deepEqual(thrown.answer, { status: 'unavailable', retryable: true, reason: 'the deploy could not be checked just now, so nothing was decided' })
  assert.match(loggedText(), /registry gone/)
})

test('GET /api/arc/vaults publishes a short fixed message for a store it cannot read, and logs the raw text', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  const raw = 'password authentication failed for user "render" at db.internal:5432'
  const down: ArcVaultStoreIo = { getPool: async () => ({ query: async () => { throw new Error(raw) } }) }
  const { httpStatus, body } = await listAdmittedVaults({}, down)
  assert.equal(httpStatus, 503)
  assert.equal(body.readable, false)
  assert.equal(body.reason, 'the list of admitted vaults could not be read')
  assert.ok(!JSON.stringify(body).includes('db.internal'), 'the store error does not reach the answer')
  assert.ok(JSON.stringify(logged.mock.calls.map((c) => c.arguments)).includes('db.internal'), 'it reaches the log')
})

test('a body that is not a transaction hash on Arc Mainnet is refused before anything is read', async () => {
  const calls: string[] = []
  const deps = routeDeps({}, { calls })
  for (const body of [undefined, null, {}, { deployTx: 'nope' }, { deployTx: 12 }, { deployTx: TX.slice(0, 40) }, { deployTx: TX, chain: 'arc' }, { deployTx: TX, chain: 'base' }]) {
    const { httpStatus, answer } = await admitVaultDeploy(body, deps)
    assert.equal(httpStatus, 400, JSON.stringify(body))
    assert.equal(answer.status, 'invalid')
  }
  assert.equal(calls.length, 0)
})

test('a deploy no host has yet is refused as retryable; a fact about the vault is not', async () => {
  const pending = await admitVaultDeploy({ deployTx: TX }, routeDeps({ receipt: false }))
  assert.equal(pending.answer.status, 'refused')
  if (pending.answer.status === 'refused') {
    assert.equal(pending.answer.retryable, true)
    assert.ok(pending.answer.reasons.some((r) => r.id === 'receipt-found'))
    assert.equal(pending.answer.vault, null)
  }
  // The expiry is set by the transaction after the deploy, so a lagging read can still see none.
  const noExpiry = await admitVaultDeploy({ deployTx: TX }, routeDeps({ sessionKeyExpiry: 0n }))
  assert.equal(noExpiry.answer.status === 'refused' && noExpiry.answer.retryable, true)
  const noCap = await admitVaultDeploy({ deployTx: TX }, routeDeps({ dailyCap: 0n }))
  assert.equal(noCap.answer.status === 'refused' && noCap.answer.retryable, false)
  const reverted = await admitVaultDeploy({ deployTx: TX }, routeDeps({ status: '0x0' }))
  assert.equal(reverted.answer.status === 'refused' && reverted.answer.retryable, false)
})

test('hosts that disagree about the receipt admit nothing', async () => {
  const a = fakeHost('a')
  const b = fakeHost('b')
  const skewed: RpcHost = {
    ...b,
    request: async (method, params) => {
      const out = await b.request(method, params)
      return method === 'eth_getTransactionReceipt' ? { ...out, status: '0x0' } : out
    },
  }
  const io = tmpIo()
  const { answer } = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { io, hosts: [a, skewed] }))
  assert.equal(answer.status, 'refused')
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.deepEqual(read.rows, [])
})

test('one host that errors or returns null does not stop the others, and an error never prints a URL', async () => {
  const good = fakeHost('good')
  const dead: RpcHost = {
    label: 'dead',
    url: 'https://secret.example/key123',
    request: async () => {
      throw new Error('fetch failed at https://secret.example/key123')
    },
  }
  const answers = await everyHost([dead, good], 'eth_getTransactionReceipt', [TX])
  assert.equal(answers[0].value, null)
  assert.doesNotMatch(answers[0].error ?? '', /secret/)
  assert.ok(answers[1].value)
  const { answer } = await admitVaultDeploy({ deployTx: TX }, routeDeps({}, { hosts: [dead, good] }))
  assert.equal(answer.status, 'admitted')
  assert.doesNotMatch(shortRpcError(new Error('x https://secret.example/key123'), [dead]), /secret/)
})

test('past the deadline a read fails at once, and the post is refused as retryable rather than hanging', async () => {
  let t = 0
  const calls: string[] = []
  const hosts = withDeadline([fakeHost('one', {}, calls)], 100, () => t)
  t = 101
  const run = await runAdmission({ context, hosts, tx: TX, ours: ours(), requireEnvKeys: true })
  assert.equal(calls.length, 0)
  assert.equal(run.verdict.admitted, false)
  assert.equal(refusalIsRetryable(run), true)
})

test('every check a run can produce has plain words', async () => {
  const run = await runAdmission({ context, hosts: [fakeHost('one')], tx: TX, ours: ours(), requireEnvKeys: true })
  assert.equal(run.verdict.admitted, true)
  for (const c of run.checks) assert.ok(PLAIN_REFUSALS[c.id], `no plain words for ${c.id}`)
  const refused = await runAdmission({ context, hosts: [fakeHost('one', { dailyCap: 0n })], tx: TX, ours: ours(), requireEnvKeys: true })
  assert.deepEqual(plainRefusals(refused.verdict).map((r) => r.id), ['daily-cap'])
})

test('a state read admits nothing and asks for no env: the script keeps its --vault path', async () => {
  const host = fakeHost('one')
  const receipt = await host.request('eth_getTransactionReceipt', [TX])
  const run = await runAdmission({ context, hosts: [host], vault: receipt.contractAddress, ours: ours([], { envKeysDerived: [] }), requireEnvKeys: false })
  assert.equal(run.evidence, null)
  assert.ok(!run.checks.some((c) => c.id === 'env-keys-loaded'))
  assert.ok(!run.checks.some((c) => c.id === 'receipt-found'))
  assert.equal(run.vault?.toLowerCase(), receipt.contractAddress.toLowerCase())
})

test('stored rows: an unreadable list throws rather than reads empty, and a row that is ours or malformed is skipped by name', async () => {
  const io = tmpIo()
  const rec = (address: string, owner: string): ArcAdmittedVaultRecord => ({
    v: 1,
    address,
    owner,
    ownerKind: 'unstated',
    deployTx: `0x${address.slice(2).padEnd(64, '0')}`,
    deployBlock: '100',
    deployedAt: '2026-11-03',
    admittedAt: '2026-11-03T10:00:00.000Z',
    note: 'n',
  })
  const a = '0x' + 'a1'.repeat(20)
  const b = '0x' + 'b1'.repeat(20)
  assert.deepEqual(await persistAdmittedArcVault(rec(a, OWNER), io), { ok: true, inserted: true })
  assert.deepEqual(await persistAdmittedArcVault(rec(b, OPERATOR), io), { ok: true, inserted: true })
  const skipped: { vault: string | null; reason: string }[] = []
  const rows = await admittedVaultsFromStore(ours([OPERATOR]), (r) => skipped.push(r), io)
  assert.deepEqual(rows.map((r) => r.address), [a])
  assert.equal(rows[0].ownerKind, 'unstated')
  assert.equal(rows[0].deployBlock, '100')
  assert.deepEqual(skipped, [{ vault: b, reason: 'its owner is one of our keys' }])

  writeFileSync(io.file as string, JSON.stringify([{ address: 'nope' }, rec(a, OWNER)]))
  const seen: { vault: string | null; reason: string }[] = []
  assert.equal((await admittedVaultsFromStore(ours(), (r) => seen.push(r), io)).length, 1)
  assert.equal(seen[0].vault, 'nope')

  writeFileSync(io.file as string, 'not json')
  await assert.rejects(() => admittedVaultsFromStore(ours(), undefined, io))
})

test('the file store: empty is not unreadable, and a vault is written once', async () => {
  const io = tmpIo()
  assert.deepEqual(await loadAdmittedArcVaults(io), { ok: true, rows: [] })
  const addr = '0x' + 'a1'.repeat(20)
  const rec: ArcAdmittedVaultRecord = { v: 1, address: addr, owner: OWNER, ownerKind: 'unstated', deployTx: TX.toUpperCase().replace('0X', '0x'), deployBlock: '1', deployedAt: '2026-11-03', admittedAt: 'x', note: 'first' }
  assert.deepEqual(await persistAdmittedArcVault(rec, io), { ok: true, inserted: true })
  assert.deepEqual(await persistAdmittedArcVault({ ...rec, address: addr.toUpperCase().replace('0X', '0x'), note: 'second' }, io), { ok: true, inserted: false })
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.equal(read.rows.length, 1)
  assert.equal(read.rows[0].note, 'first')
  const found = await findAdmittedArcVaultByTx(TX, io)
  assert.ok(found.ok)
  assert.equal(found.row?.address, addr)
  assert.deepEqual(await findAdmittedArcVaultByTx('0x' + 'ee'.repeat(32), io), { ok: true, row: null })
  writeFileSync(io.file as string, '{"not":"a list"}')
  assert.equal((await loadAdmittedArcVaults(io)).ok, false)
  assert.equal((await findAdmittedArcVaultByTx(TX, io)).ok, false)
  assert.equal((await persistAdmittedArcVault(rec, io)).ok, false)
})

test('the Postgres store: keyed by lowercase address, conflict does nothing, and a failing database is an error, not an empty list', async () => {
  const rows = new Map<string, ArcAdmittedVaultRecord>()
  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      if (text.startsWith('CREATE')) return { rows: [] }
      if (text === 'INSERT INTO arc_admitted_vaults (address, data) VALUES ($1, $2::jsonb) ON CONFLICT (address) DO NOTHING RETURNING address') {
        const key = params[0] as string
        if (rows.has(key)) return { rows: [] }
        rows.set(key, JSON.parse(params[1] as string))
        return { rows: [{ address: key }] }
      }
      if (text === "SELECT data FROM arc_admitted_vaults ORDER BY data->>'admittedAt' ASC, address ASC") return { rows: [...rows.values()].map((data) => ({ data })) }
      if (text === "SELECT data FROM arc_admitted_vaults WHERE data->>'deployTx' = $1 LIMIT 1") {
        return { rows: [...rows.values()].filter((r) => r.deployTx === params[0]).map((data) => ({ data })) }
      }
      throw new Error(`unrecognized statement: ${text}`)
    },
  }
  const io: ArcVaultStoreIo = { getPool: async () => pool }
  const rec: ArcAdmittedVaultRecord = { v: 1, address: '0xABc' + 'a'.repeat(37), owner: OWNER, ownerKind: 'unstated', deployTx: TX, deployBlock: '1', deployedAt: '2026-11-03', admittedAt: 'x', note: 'n' }
  assert.deepEqual(await persistAdmittedArcVault(rec, io), { ok: true, inserted: true })
  assert.deepEqual(await persistAdmittedArcVault(rec, io), { ok: true, inserted: false })
  assert.ok(rows.has(rec.address.toLowerCase()))
  const read = await loadAdmittedArcVaults(io)
  assert.ok(read.ok)
  assert.equal(read.rows.length, 1)
  const found = await findAdmittedArcVaultByTx(TX, io)
  assert.ok(found.ok)
  assert.equal(found.row?.note, 'n')

  const down: ArcVaultStoreIo = { getPool: async () => ({ query: async () => { throw new Error('db down') } }) }
  assert.deepEqual(await loadAdmittedArcVaults(down), { ok: false, reason: 'db down' })
  assert.deepEqual(await findAdmittedArcVaultByTx(TX, down), { ok: false, reason: 'db down' })
  assert.deepEqual(await persistAdmittedArcVault(rec, down), { ok: false, reason: 'db down' })
})

test('the route is public and rate limited per IP, and the page of limits says so', () => {
  const post = rateBudget('POST', '/api/arc/vaults')
  assert.ok(post)
  assert.equal(post.bucket, 'arc-vault-admit')
  assert.equal(post.max, 10)
  assert.ok(rateBudget('GET', '/api/arc/vaults'))
  const key = `test-ip:${post.bucket}:${Math.random()}`
  for (let i = 0; i < post.max; i++) assert.equal(rateLimited(key, post.max, post.windowMs), false, `call ${i + 1}`)
  assert.equal(rateLimited(key, post.max, post.windowMs), true)
  assert.equal(rateLimited(`other-ip:${post.bucket}:${Math.random()}`, post.max, post.windowMs), false)

  // http.ts boots a server on import, so its session gate is read as text. Without this line every
  // post from an owner with no A-Identity session answers 401.
  const http = readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8')
  assert.match(http, /url\.pathname !== '\/api\/arc\/vaults' &&/)
  assert.ok(http.indexOf("url.pathname !== '/api/arc/vaults'") < http.indexOf('if (isMutation && !caller)'))
})

test('the script is a wrapper: it opens no client and decides nothing itself', () => {
  const script = readFileSync(new URL('../scripts/arc-owner-vault-check.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /createPublicClient|readContract|eth_getTransactionReceipt|\.deployChecks\(|\.stateChecks\(/)
  assert.match(script, /live\.runAdmission\(/)
})

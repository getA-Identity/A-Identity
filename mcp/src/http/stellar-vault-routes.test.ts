import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'

import { CHAINS } from '../chains/index.js'
import { METHOD_ERROR_CODES, SimulationError, errorName, type OwnerMethod, type VaultState } from '../chains/stellar/adapter.js'
import { __resetPlatformStateForTests } from '../platform.js'
import {
  __clearStellarVaultCacheForTests,
  handleStellarVaultRoutes,
  type StellarVaultRouteDeps,
  type VaultRouteAdapter,
} from './stellar-vault-routes.js'
import type { RouteCtx } from './shared.js'

/**
 * The route surface, at the boundary a frontend actually codes against.
 *
 * Everything with a decision in it is tested in ../stellar-vault.test.ts, where it is pure.
 * What is left here is the part a pure test cannot see: which status code each refusal
 * carries, that a refusal happens BEFORE any network call, and that a path this group does
 * not own is passed on rather than swallowed.
 *
 * Every case below is refused before an RPC handle is built, which is why this file is
 * offline. That is not a testing convenience: it is the property being asserted. A
 * malformed body, a stranger's wallet or an unknown vault must never cost a round trip,
 * because these two endpoints are reachable by anyone with a verified session.
 */

// Persistence off, and no agents, so `ownedVaults` is empty for every caller here.
__resetPlatformStateForTests()

const testnet = CHAINS.find((c) => c.id === 'stellar-testnet')!
const VAULT = testnet.contracts.spendVault as string

/** The smallest ServerResponse a handler here actually uses. */
function fakeRes() {
  const out: { status?: number; body?: Record<string, unknown> } = {}
  const headers: Record<string, unknown> = {}
  return {
    out,
    res: {
      setHeader: (k: string, v: unknown) => {
        headers[k] = v
      },
      writeHead(status: number) {
        out.status = status
        return this
      },
      end: (payload?: string) => {
        if (payload) out.body = JSON.parse(payload) as Record<string, unknown>
      },
    } as never,
  }
}

const V010 = '155eb31c1867254eacbf1b7a4755164d15cc6b6f939644705ab6b8df61579239'
const USDC = testnet.settlementTokens?.[0]?.address as string
/** A contract id in no registry slot and on no agent: the known-build path's subject. */
const LOOSE = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

type Prepared = Awaited<ReturnType<VaultRouteAdapter['prepareOwnerCall']>>
type Submitted = NonNullable<Awaited<ReturnType<VaultRouteAdapter['submitSignedEnvelope']>>['outcome']>

/**
 * A stand-in for the Stellar adapter, so every route below runs with no network.
 *
 * Each method records that it was called, which is how a test asserts the ORDER of the gate:
 * a refusal that should cost nothing must leave `calls` empty, and one that should cost one
 * read must show exactly that read.
 */
function fakeAdapter(
  o: {
    executable?: 'wasm' | 'stellar-asset' | null
    found?: boolean
    wasmHash?: string
    owner?: string
    state?: Partial<VaultState>
    readVaultThrows?: Error
    exeThrows?: Error
    allowed?: boolean
    allowlistEnabled?: boolean
    prepared?: Prepared
    submitted?: Submitted
    envelopeContract?: string
    envelopeMethod?: OwnerMethod
    now?: () => number
  } = {},
) {
  const calls: string[] = []
  const owner = o.owner ?? Keypair.random().publicKey()
  const adapter: VaultRouteAdapter = {
    async readExecutableWasmHash() {
      calls.push('readExecutableWasmHash')
      if (o.exeThrows) throw o.exeThrows
      const found = o.found ?? true
      const executable = found ? (o.executable === undefined ? 'wasm' : o.executable) : null
      return {
        ledger: 4972479,
        found,
        executable,
        wasmHash: executable === 'wasm' ? (o.wasmHash ?? V010) : null,
        liveUntilLedger: found ? 5200000 : null,
        archived: false,
      }
    },
    async readVault() {
      calls.push('readVault')
      if (o.readVaultThrows) throw o.readVaultThrows
      return {
        owner,
        operator: Keypair.random().publicKey(),
        token: USDC,
        decimals: 7,
        dailyCapRaw: '250000000',
        autoApproveMaxRaw: '50000000',
        frozen: false,
        allowlistEnabled: true,
        sessionKeyExpiry: '0',
        day: '20728',
        spentTodayRaw: '30000000',
        balanceRaw: '1000000000',
        ledger: 4972480,
        ...o.state,
      }
    },
    async readInstanceTtl() {
      calls.push('readInstanceTtl')
      return { ledger: 4972480, liveUntilLedger: 5200000, archived: false }
    },
    async readTokenSymbol() {
      calls.push('readTokenSymbol')
      return 'TOK'
    },
    async isAllowed() {
      calls.push('isAllowed')
      return { allowed: o.allowed ?? false, allowlistEnabled: o.allowlistEnabled ?? true, ledger: 4972481 }
    },
    async prepareOwnerCall(contract, method, _args, source) {
      calls.push('prepareOwnerCall')
      return (
        o.prepared ?? {
          ok: true,
          xdr: 'AAAA-unsigned',
          networkPassphrase: 'Test SDF Network ; September 2015',
          network: testnet.caip2,
          contract,
          method,
          args: [],
          source,
          expiresAtLedger: null,
          validUntil: null,
          feeStroops: '123456',
          feeXlm: '0.0123456',
          archivedEntries: [],
          restoreNeeded: false,
          preflight: { xlm: 'checked', trustline: 'not-needed' },
          summary: 'simulated',
        }
      )
    },
    inspectOwnerEnvelope() {
      calls.push('inspectOwnerEnvelope')
      return {
        ok: true,
        source: owner,
        contract: o.envelopeContract ?? LOOSE,
        method: o.envelopeMethod ?? 'set_frozen',
        args: [true],
        signatures: 1,
        sourceSigned: true,
      }
    },
    async submitSignedEnvelope() {
      calls.push('submitSignedEnvelope')
      return {
        inspection: { ok: false, code: 'bad_request', reason: 'unused by the route' },
        outcome: o.submitted ?? { outcome: 'settled', txHash: 'ab'.repeat(32), ledger: 4972490, explorerUrl: 'x', feeChargedStroops: '100' },
      }
    },
  }
  const deps: StellarVaultRouteDeps = {
    adapter: () => adapter,
    agents: () => [],
    linkedWallets: () => [],
    ...(o.now ? { now: o.now } : {}),
  }
  return { adapter, deps, calls, owner }
}

async function get(path: string, deps: StellarVaultRouteDeps) {
  const { out, res } = fakeRes()
  const ctx: RouteCtx = {
    req: { method: 'GET', headers: {} } as never,
    res,
    url: new URL(`http://localhost${path}`),
    caller: null,
    callerId: undefined,
  }
  const handled = await handleStellarVaultRoutes(ctx, deps)
  return { handled, ...out }
}

async function post(path: string, body: unknown, caller?: { subject: string; method: 'wallet' | 'email' }, deps?: StellarVaultRouteDeps) {
  const { out, res } = fakeRes()
  const req = {
    method: 'POST',
    headers: {},
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
      return this
    },
  } as never
  const ctx: RouteCtx = {
    req,
    res,
    url: new URL(`http://localhost${path}`),
    caller: caller ? ({ subject: caller.subject, method: caller.method } as never) : null,
    callerId: caller?.subject,
  }
  const handled = await handleStellarVaultRoutes(ctx, deps)
  return { handled, ...out }
}

test('a path this group does not own is passed on, not swallowed', async () => {
  const { handled } = await post('/api/agents/vault', {})
  assert.equal(handled, false, 'returning true here would shadow the Arc vault route')
})

test('a network that is not a Stellar chain is refused before anything else happens', async () => {
  // Never guessed. The two networks differ by a passphrase, and guessing is exactly how a
  // testnet signature ends up presented to pubnet.
  for (const network of [undefined, '', 'arc', 'eip155:5042002', 'stellar:nope']) {
    const r = await post('/api/stellar/vault/prepare', { network, contract: VAULT, source: Keypair.random().publicKey(), action: 'set_frozen', args: { frozen: true } })
    assert.equal(r.status, 400, `${String(network)} must not be accepted as a Stellar network`)
    assert.equal((r.body as { code?: string }).code, 'bad_request')
  }
})

test('an action outside the six is refused with the list, not with a generic error', async () => {
  const r = await post('/api/stellar/vault/prepare', {
    network: testnet.id,
    contract: VAULT,
    source: Keypair.random().publicKey(),
    action: 'pay',
    args: {},
  })
  assert.equal(r.status, 400)
  assert.match(String((r.body as { reason?: string }).reason), /set_policy/)
})

test('a caller who has not proven that wallet is refused 403, with no round trip spent', async () => {
  // The open-relay case, and the reason the cheap half of the gate runs first: an
  // unauthorized caller must not be able to make this server do an RPC call.
  const stranger = Keypair.random().publicKey()
  const r = await post(
    '/api/stellar/vault/prepare',
    { network: testnet.id, contract: VAULT, source: stranger, action: 'set_frozen', args: { frozen: true } },
    { subject: Keypair.random().publicKey(), method: 'wallet' },
  )
  assert.equal(r.status, 403)
  // The public code is from the shared closed list; the finer reason rides along beside it.
  assert.equal((r.body as { code?: string }).code, 'not_owner')
  assert.equal((r.body as { reasonCode?: string }).reasonCode, 'not_your_wallet')
})

test('a contract neither the registry nor an owned agent names is 404, after one wasm read and nothing else', async () => {
  // Since the known-build path, an unlisted contract costs exactly one ledger-entry read: the
  // one that says what code it runs. A token runs the built-in SAC, so it stops there, and the
  // owner is never read and nothing is simulated.
  const me = Keypair.random()
  const fake = fakeAdapter({ executable: 'stellar-asset' })
  const r = await post(
    '/api/stellar/vault/prepare',
    {
      network: testnet.id,
      // A real contract id on this network (the USDC SAC), which is still not a vault of ours.
      contract: testnet.settlementTokens?.[0]?.address,
      source: me.publicKey(),
      action: 'set_frozen',
      args: { frozen: true },
    },
    { subject: me.publicKey(), method: 'wallet' },
    fake.deps,
  )
  assert.equal(r.status, 404)
  assert.equal((r.body as { code?: string }).code, 'unknown_vault')
  assert.deepEqual(fake.calls, ['readExecutableWasmHash'])
})

test('bad arguments are caught before the wallet check, so the caller learns the real problem first', async () => {
  const me = Keypair.random()
  const r = await post(
    '/api/stellar/vault/prepare',
    { network: testnet.id, contract: VAULT, source: me.publicKey(), action: 'set_policy', args: { dailyCapUsd: 25, autoApproveUsd: 5 } },
    { subject: me.publicKey(), method: 'wallet' },
  )
  assert.equal(r.status, 400)
  assert.match(String((r.body as { reason?: string }).reason), /allowlistEnabled/)
})

test('submit refuses an envelope that is not one, without contacting the network', async () => {
  const me = Keypair.random()
  const r = await post(
    '/api/stellar/vault/submit',
    { network: testnet.id, xdr: 'this is not base64 XDR' },
    { subject: me.publicKey(), method: 'wallet' },
  )
  assert.equal(r.status, 400)
  assert.equal((r.body as { code?: string }).code, 'bad_request')
})

test('submit requires an xdr at all, and says which field is missing', async () => {
  const r = await post('/api/stellar/vault/submit', { network: testnet.id }, { subject: Keypair.random().publicKey(), method: 'wallet' })
  assert.equal(r.status, 400)
  assert.match(String((r.body as { reason?: string }).reason), /xdr/)
})

// ── SOW 2: GET /api/stellar/vault/read ───────────────────────────────────────────

const readUrl = (contract: string, network = testnet.caip2) =>
  `/api/stellar/vault/read?network=${encodeURIComponent(network)}&contract=${contract}`

test('read: a known vault answers 200 with every field, stamped with the ledger and the time it was read', async () => {
  __clearStellarVaultCacheForTests()
  const now = Date.parse('2026-10-02T10:00:00.000Z')
  const fake = fakeAdapter({ now: () => now })
  const r = await get(readUrl(VAULT), fake.deps)
  assert.equal(r.status, 200)
  const b = r.body as Record<string, unknown>
  assert.equal(b.network, testnet.caip2)
  assert.equal(b.chainId, testnet.id)
  assert.equal(b.contract, VAULT)
  assert.equal(b.realMoney, false)
  assert.equal(b.wasmHash, V010)
  assert.equal(b.knownBuild, true)
  assert.equal(b.build, 'v0.1.0')
  assert.equal(b.role, 'flagship')
  assert.equal(b.owner, fake.owner)
  assert.equal(b.ownerKind, 'account')
  assert.equal(b.tokenSymbol, 'USDC', 'the registry vouches for its own token, so its symbol is not re-read')
  assert.deepEqual(b.dailyCap, { raw: '250000000', display: '25' })
  assert.deepEqual(b.spentToday, { raw: '30000000', display: '3' })
  assert.deepEqual(b.remainingToday, { raw: '220000000', display: '22' })
  assert.deepEqual(b.autoApproveMax, { raw: '50000000', display: '5' })
  assert.deepEqual(b.balance, { raw: '1000000000', display: '100' })
  // The newer of the two ledgers the answers came from, and the injected clock, never a guess.
  assert.equal(b.ledger, 4972480)
  assert.equal(b.readAt, '2026-10-02T10:00:00.000Z')
  assert.equal(b.day, 20728)
  assert.equal(b.resetsAt, new Date(20729 * 86_400_000).toISOString())
  assert.deepEqual(b.ttl, { liveUntilLedger: 5200000, archived: false })
  assert.ok(String((b.explorer as { contract: string }).contract).includes(VAULT))
  assert.ok(!fake.calls.includes('readTokenSymbol'))
})

test('read: a cap of 0 comes back as no cap, with nothing-left-today null', async () => {
  __clearStellarVaultCacheForTests()
  const fake = fakeAdapter({ state: { dailyCapRaw: '0' } })
  const r = await get(readUrl(VAULT), fake.deps)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body?.dailyCap, { raw: '0', display: '0' })
  assert.equal(r.body?.remainingToday, null)
})

test('read: a bad network or contract id is 400 and costs no read; the network is never guessed', async () => {
  const fake = fakeAdapter()
  for (const path of [
    readUrl(VAULT, 'stellar:nope'),
    readUrl(VAULT, ''),
    `/api/stellar/vault/read?contract=${VAULT}`,
    readUrl(Keypair.random().publicKey()),
    readUrl('not-a-contract'),
  ]) {
    const r = await get(path, fake.deps)
    assert.equal(r.status, 400, path)
    assert.equal(r.body?.error, 'bad_request')
  }
  assert.deepEqual(fake.calls, [])
})

test('read: the registry id is accepted as well as the CAIP-2 id', async () => {
  __clearStellarVaultCacheForTests()
  const r = await get(readUrl(VAULT, testnet.id), fakeAdapter().deps)
  assert.equal(r.status, 200)
  assert.equal(r.body?.network, testnet.caip2)
})

test('read: no instance on that network is 404', async () => {
  __clearStellarVaultCacheForTests()
  const fake = fakeAdapter({ found: false })
  const r = await get(readUrl(LOOSE), fake.deps)
  assert.equal(r.status, 404)
  assert.equal(r.body?.error, 'not_found')
  assert.deepEqual(fake.calls, ['readExecutableWasmHash'])
})

test('read: a token contract is 422 not_a_spend_vault, and so is unknown wasm whose views fail', async () => {
  __clearStellarVaultCacheForTests()
  const sac = await get(readUrl(USDC), fakeAdapter({ executable: 'stellar-asset' }).deps)
  assert.equal(sac.status, 422)
  assert.equal(sac.body?.error, 'not_a_spend_vault')
  assert.ok(sac.body && 'wasmHash' in sac.body)

  const other = 'cd'.repeat(32)
  const r = await get(
    readUrl(LOOSE),
    fakeAdapter({ wasmHash: other, readVaultThrows: new SimulationError('owner', 'HostError: non-existent contract function') }).deps,
  )
  assert.equal(r.status, 422)
  assert.equal(r.body?.wasmHash, other)
})

test('read: unknown wasm whose views DO answer like a vault is read, with knownBuild false and a note', async () => {
  __clearStellarVaultCacheForTests()
  const fake = fakeAdapter({ wasmHash: 'cd'.repeat(32), state: { token: LOOSE } })
  const r = await get(readUrl(LOOSE), fake.deps)
  assert.equal(r.status, 200)
  assert.equal(r.body?.knownBuild, false)
  assert.equal(r.body?.build, null)
  assert.equal(r.body?.role, null)
  assert.equal(r.body?.tokenSymbol, 'TOK', 'a token the registry does not name is asked for its own symbol')
  assert.match(String(r.body?.note), /not an AgentSpendPolicy build we published/)
})

test('read: a read that does not come back is 502 read_failed with when, never a blank or a stale number', async () => {
  __clearStellarVaultCacheForTests()
  const now = () => Date.parse('2026-10-02T11:00:00.000Z')
  const down = await get(readUrl(VAULT), fakeAdapter({ exeThrows: new Error('fetch failed'), now }).deps)
  assert.equal(down.status, 502)
  assert.equal(down.body?.error, 'read_failed')
  assert.equal(down.body?.at, '2026-10-02T11:00:00.000Z')

  // A known build whose view errors is a failed read too, never "not a vault".
  const known = await get(readUrl(VAULT), fakeAdapter({ readVaultThrows: new SimulationError('owner', 'budget exceeded'), now }).deps)
  assert.equal(known.status, 502)
  assert.equal(known.body?.error, 'read_failed')
})

test('read: cached at most 5 s per contract, and a settled owner call busts it at once', async () => {
  __clearStellarVaultCacheForTests()
  let t = Date.parse('2026-10-02T12:00:00.000Z')
  const me = Keypair.random().publicKey()
  const fake = fakeAdapter({ owner: me, now: () => t, envelopeContract: VAULT })
  const reads = () => fake.calls.filter((c) => c === 'readVault').length

  await get(readUrl(VAULT), fake.deps)
  t += 4_999
  const second = await get(readUrl(VAULT), fake.deps)
  assert.equal(reads(), 1, 'inside 5 s the same answer is served')
  assert.equal(second.body?.readAt, '2026-10-02T12:00:00.000Z', 'and it keeps its own stamp')
  t += 1
  await get(readUrl(VAULT), fake.deps)
  assert.equal(reads(), 2, 'at 5 s it is read again')

  // A settled submit on this vault drops the entry, so the next read is live.
  const sent = await post('/api/stellar/vault/submit', { network: testnet.id, xdr: 'signed' }, { subject: me, method: 'wallet' }, fake.deps)
  assert.equal(sent.status, 200)
  const before = reads()
  await get(readUrl(VAULT), fake.deps)
  assert.equal(reads(), before + 1)
})

// ── SOW 2: GET /api/stellar/vault/is-allowed ─────────────────────────────────────

test('is-allowed: the three answers, each stamped with its ledger', async () => {
  const payee = Keypair.random().publicKey()
  const path = `/api/stellar/vault/is-allowed?network=${testnet.id}&contract=${VAULT}&address=${payee}`
  const cases: [boolean, boolean, string][] = [
    [true, true, 'allowed'],
    [false, true, 'blocked'],
    [false, false, 'not-enforced'],
  ]
  for (const [allowed, allowlistEnabled, effective] of cases) {
    const r = await get(path, fakeAdapter({ allowed, allowlistEnabled }).deps)
    assert.equal(r.status, 200)
    assert.equal(r.body?.effective, effective)
    assert.equal(r.body?.allowed, allowed)
    assert.equal(r.body?.allowlistEnabled, allowlistEnabled)
    assert.equal(r.body?.address, payee)
    assert.equal(r.body?.network, testnet.caip2)
    assert.equal(r.body?.ledger, 4972481)
    assert.equal(typeof r.body?.readAt, 'string')
  }
})

test('is-allowed: an address that is neither G... nor C... is 400, and a contract is a valid payee', async () => {
  const fake = fakeAdapter()
  const bad = await get(`/api/stellar/vault/is-allowed?network=${testnet.id}&contract=${VAULT}&address=nope`, fake.deps)
  assert.equal(bad.status, 400)
  assert.deepEqual(fake.calls, [])
  const ok = await get(`/api/stellar/vault/is-allowed?network=${testnet.id}&contract=${VAULT}&address=${LOOSE}`, fake.deps)
  assert.equal(ok.status, 200)
})

// ── SOW 2: the widened prepare gate ──────────────────────────────────────────────

const prepareBody = (source: string, contract = LOOSE) => ({
  network: testnet.id,
  contract,
  source,
  action: 'set_frozen',
  args: { frozen: true },
})

test('gate: a known build outside every list, whose live owner is the session wallet, is prepared', async () => {
  const me = Keypair.random().publicKey()
  const fake = fakeAdapter({ owner: me })
  const r = await post('/api/stellar/vault/prepare', prepareBody(me), { subject: me, method: 'wallet' }, fake.deps)
  assert.equal(r.status, 200)
  assert.equal(r.body?.ok, true)
  assert.equal(r.body?.feeXlm, '0.0123456')
  assert.equal(r.body?.source, me)
  assert.match(String(r.body?.note), /NOT signed/)
  assert.deepEqual(fake.calls, ['readExecutableWasmHash', 'readVault', 'prepareOwnerCall'])
})

test('gate: a wallet linked to an email session counts as the caller\'s own', async () => {
  const me = Keypair.random().publicKey()
  const fake = fakeAdapter({ owner: me })
  const r = await post('/api/stellar/vault/prepare', prepareBody(me), { subject: 'someone@example.test', method: 'email' }, {
    ...fake.deps,
    linkedWallets: () => [{ ecosystem: 'stellar', address: me }],
  })
  assert.equal(r.status, 200)
})

test('gate: the same known build owned by someone else is not_owner, and nothing is built', async () => {
  const me = Keypair.random().publicKey()
  const fake = fakeAdapter({ owner: Keypair.random().publicKey() })
  const r = await post('/api/stellar/vault/prepare', prepareBody(me), { subject: me, method: 'wallet' }, fake.deps)
  assert.equal(r.status, 403)
  assert.equal(r.body?.code, 'not_owner')
  assert.ok(!fake.calls.includes('prepareOwnerCall'))
})

test('gate: unknown wasm is refused on prepare even when the caller owns it', async () => {
  const me = Keypair.random().publicKey()
  const fake = fakeAdapter({ owner: me, wasmHash: 'cd'.repeat(32) })
  const r = await post('/api/stellar/vault/prepare', prepareBody(me), { subject: me, method: 'wallet' }, fake.deps)
  assert.equal(r.status, 404)
  assert.equal(r.body?.code, 'unknown_vault')
  assert.deepEqual(fake.calls, ['readExecutableWasmHash'], 'an unknown build never costs the owner read')
})

test('gate: a registry vault skips the wasm read and still checks the live owner', async () => {
  const me = Keypair.random().publicKey()
  const fake = fakeAdapter({ owner: me })
  const r = await post('/api/stellar/vault/prepare', prepareBody(me, VAULT), { subject: me, method: 'wallet' }, fake.deps)
  assert.equal(r.status, 200)
  assert.deepEqual(fake.calls, ['readVault', 'prepareOwnerCall'])
})

// ── SOW 2: every prepare refusal carries its code and the fields a client acts on ─

test('prepare: insufficient_xlm, no_trustline, refused and restore_needed each carry their own fields', async () => {
  const me = Keypair.random().publicKey()
  const dest = Keypair.random().publicKey()
  const run = async (prepared: Prepared) =>
    post('/api/stellar/vault/prepare', prepareBody(me, VAULT), { subject: me, method: 'wallet' }, fakeAdapter({ owner: me, prepared }).deps)

  const xlm = await run({ ok: false, code: 'insufficient_xlm', reason: 'short', availableXlm: '0.5', neededXlm: '1.0123456' })
  assert.equal(xlm.status, 409)
  assert.deepEqual(
    { code: xlm.body?.code, availableXlm: xlm.body?.availableXlm, neededXlm: xlm.body?.neededXlm },
    { code: 'insufficient_xlm', availableXlm: '0.5', neededXlm: '1.0123456' },
  )

  const tl = await run({ ok: false, code: 'no_trustline', reason: 'no line', destination: dest, asset: 'USDC:GISSUER' })
  assert.deepEqual(
    { code: tl.body?.code, destination: tl.body?.destination, asset: tl.body?.asset },
    { code: 'no_trustline', destination: dest, asset: 'USDC:GISSUER' },
  )

  const refused = await run({ ok: false, code: 'refused', reason: 'a zero amount', contractErrorCode: 6, contractErrorName: 'InvalidAmount', contractErrorIsOurs: true })
  assert.equal(refused.status, 409)
  assert.deepEqual(
    { code: refused.body?.code, errorName: refused.body?.errorName, errorCode: refused.body?.errorCode },
    { code: 'refused', errorName: 'InvalidAmount', errorCode: 6 },
  )

  const restore = await run({ ok: false, code: 'restore_needed', reason: 'restore the instance first' })
  assert.equal(restore.body?.code, 'restore_needed')
  assert.match(String(restore.body?.reason), /restore/)
})

test('prepare: a simulation that restores state inside its fee says restoreNeeded: true', async () => {
  const me = Keypair.random().publicKey()
  const base = fakeAdapter({ owner: me })
  const prepared = await base.adapter.prepareOwnerCall(VAULT, 'set_frozen', [], me)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const r = await post(
    '/api/stellar/vault/prepare',
    prepareBody(me, VAULT),
    { subject: me, method: 'wallet' },
    fakeAdapter({ owner: me, prepared: { ...prepared, archivedEntries: [0], restoreNeeded: true } }).deps,
  )
  assert.equal(r.status, 200)
  assert.equal(r.body?.restoreNeeded, true)
})

// ── SOW 2: submit outcomes ───────────────────────────────────────────────────────

test('submit: settled is 200 with hash and ledger; in flight is 202 pending with the hash, never failed', async () => {
  const me = Keypair.random().publicKey()
  const hash = 'ef'.repeat(32)
  const settled = await post('/api/stellar/vault/submit', { network: testnet.id, xdr: 'signed' }, { subject: me, method: 'wallet' }, fakeAdapter({ owner: me }).deps)
  assert.equal(settled.status, 200)
  assert.equal(settled.body?.status, 'settled')
  assert.equal(settled.body?.ledger, 4972490)
  assert.equal(settled.body?.hash, 'ab'.repeat(32))

  const pending = await post(
    '/api/stellar/vault/submit',
    { network: testnet.id, xdr: 'signed' },
    { subject: me, method: 'wallet' },
    fakeAdapter({ owner: me, submitted: { outcome: 'pending', txHash: hash, explorerUrl: 'x', reason: 'not yet' } }).deps,
  )
  assert.equal(pending.status, 202)
  assert.equal(pending.body?.status, 'pending')
  assert.equal(pending.body?.code, 'pending')
  assert.equal(pending.body?.hash, hash)
})

test('submit: TRY_AGAIN_LATER is not_accepted with the hash, and an underfunded source is insufficient_xlm', async () => {
  const me = Keypair.random().publicKey()
  const hash = 'ef'.repeat(32)
  const refusedWith = (rejection: { code: 'not_accepted' | 'insufficient_balance'; resultCode: string }) =>
    fakeAdapter({
      owner: me,
      submitted: {
        outcome: 'refused',
        contract: LOOSE,
        method: 'set_frozen',
        args: [],
        network: testnet.caip2,
        reason: 'turned away',
        rejection,
        rejectedHash: hash,
        xlm: { availableXlm: '0.1', neededXlm: '0.2' },
      },
    }).deps
  const signedIn = { subject: me, method: 'wallet' as const }
  const later = await post('/api/stellar/vault/submit', { network: testnet.id, xdr: 'signed' }, signedIn, refusedWith({ code: 'not_accepted', resultCode: 'TRY_AGAIN_LATER' }))
  assert.equal(later.body?.code, 'not_accepted')
  assert.equal(later.body?.hash, hash)
  assert.notEqual(later.status, 202)

  const broke = await post('/api/stellar/vault/submit', { network: testnet.id, xdr: 'signed' }, signedIn, refusedWith({ code: 'insufficient_balance', resultCode: 'txInsufficientBalance' }))
  assert.equal(broke.body?.code, 'insufficient_xlm')
  assert.equal(broke.body?.availableXlm, '0.1')
  assert.equal(broke.body?.neededXlm, '0.2')
})

test('submit: landed and FAILED with a typed error the entrypoint can raise is refused by name; otherwise failed with the result code', async () => {
  const me = Keypair.random().publicKey()
  const signedIn = { subject: me, method: 'wallet' as const }
  const landed = (method: OwnerMethod, over: Partial<Extract<Submitted, { outcome: 'failed' }>>) =>
    fakeAdapter({
      owner: me,
      envelopeMethod: method,
      submitted: { outcome: 'failed', txHash: 'ab'.repeat(32), ledger: 9, explorerUrl: 'x', reason: 'failed', resultCode: 'txFailed', ...over },
    }).deps
  // A code from the adapter's own per-entrypoint table, so this cannot drift from it.
  const code = METHOD_ERROR_CODES.withdraw[0]
  const named = await post('/api/stellar/vault/submit', { network: testnet.id, xdr: 'signed' }, signedIn, landed('withdraw', { contractErrorCode: code, contractErrorIsOurs: true }))
  assert.equal(named.status, 409)
  assert.equal(named.body?.code, 'refused')
  assert.equal(named.body?.errorName, errorName(code))
  assert.equal(named.body?.errorCode, code)

  // #10 on withdraw is not a code withdraw can raise, so it is never named OwnerIsOperator.
  const unnamed = await post('/api/stellar/vault/submit', { network: testnet.id, xdr: 'signed' }, signedIn, landed('withdraw', { contractErrorCode: 10, contractErrorIsOurs: true }))
  assert.equal(unnamed.body?.code, 'failed')
  assert.equal(unnamed.body?.errorName, undefined)
  assert.equal(unnamed.body?.contractErrorCode, 10, 'the bare number is still reported')

  const plain = await post('/api/stellar/vault/submit', { network: testnet.id, xdr: 'signed' }, signedIn, landed('set_frozen', {}))
  assert.equal(plain.body?.code, 'failed')
  assert.equal(plain.body?.resultCode, 'txFailed')
})

// ── SOW 2: the vault list carries roles ──────────────────────────────────────────

test('GET /api/stellar/vaults: every row keeps its old fields and gains role and roleLabel', async () => {
  __clearStellarVaultCacheForTests()
  const r = await get('/api/stellar/vaults', fakeAdapter().deps)
  assert.equal(r.status, 200)
  const rows = (r.body as { vaults: Record<string, unknown>[] }).vaults
  assert.ok(rows.length >= 2)
  for (const row of rows) {
    for (const k of ['chain', 'caip2', 'network', 'contract', 'explorerUrl', 'label', 'ownerKind', 'live', 'role', 'roleLabel']) {
      assert.ok(k in row, `${String(row.contract)} lost ${k}`)
    }
  }
  assert.equal(rows[0].role, 'flagship')
  const rehearsal = rows.find((row) => row.contract === testnet.contracts.passkeyVault)
  assert.equal(rehearsal?.role, 'rehearsal')
  assert.equal(
    rehearsal?.roleLabel,
    'Rehearsal: owner calls were signed by a software P-256 key in our own script, not a device passkey. Not SOW 2 D3 evidence.',
  )
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

import { CHAINS } from './chains/index.js'
import type { RelayAuth, RelayFunc, RelayInspection } from './chains/stellar/relay-shape.js'
import { rateBudget } from './rate-budget.js'
import {
  ALLOWLIST_ENFORCEMENT,
  passkeyCaps,
  createSeedBudget,
  PASSKEY_RELAY_LIMITS,
  PASSKEY_RELEASE,
  allowlistPlan,
  allowlistRequest,
  bindPayeeToAgent,
  createRelayBudget,
  ownerKindOf,
  ozRelayOutcome,
  ozRelayRequest,
  passkeyAgentPayPlan,
  passkeyChain,
  passkeyDeployPlan,
  passkeyStatusView,
  relayDecision,
  relayFeeReported,
  relayFeeSettlement,
  relayParams,
  relayPreflight,
  type OzRelayOutcome,
  type PasskeyRelayLimits,
  type RelayPreflightOk,
} from './stellar-passkey.js'

/**
 * The rules behind the passkey endpoints, tested where they are pure.
 *
 * The shape of the risk here is worth stating, because it decides what is worth testing.
 * These endpoints sit in front of no session: the public /stellar page has no A-Identity
 * login, the owner is a passkey a browser holds. One of them forwards bytes a stranger sent
 * to a relayer that pays for them with our credential, and two more spend the testnet
 * operator key. So almost everything below is a refusal, and the positive cases are here so
 * the refusals are not passing by accident.
 *
 * Offline by construction, and the relay cases are built as the plain shape the decoder
 * produces rather than as XDR: this module never sees the SDK, and the real bytes are
 * exercised in http/stellar-passkey-routes.test.ts, where hand-built XDR goes through the
 * decoder first.
 */

const testnet = CHAINS.find((c) => c.id === 'stellar-testnet')!
const pubnet = CHAINS.find((c) => c.id === 'stellar')!
const WASM = testnet.contracts.smartAccount!.wasmHash
const DECIMALS = testnet.settlementTokens?.[0]?.decimals ?? 7

/** A valid C... StrKey generated at runtime. Never a literal: the shape is what matters. */
const contractId = (): string => StrKey.encodeContract(randomBytes(32))
const accountId = (): string => Keypair.random().publicKey()

// ── which network is served ──────────────────────────────────────────────────────

test('pubnet is served, by registry id and by CAIP-2, now that its constants are recorded', () => {
  for (const want of ['stellar', 'stellar:pubnet']) {
    const gate = passkeyChain(want, CHAINS)
    assert.equal(gate.ok, true, `${want} must resolve`)
    if (gate.ok) assert.equal(gate.chain.caip2, 'stellar:pubnet')
  }
  assert.equal(pubnet.testnet, false, 'this test is only meaningful while stellar is the mainnet descriptor')
})

test('naming no network gets TESTNET, because reaching real money must be something you asked for', () => {
  const gate = passkeyChain(undefined, CHAINS)
  assert.equal(gate.ok, true)
  if (gate.ok) assert.equal(gate.chain.caip2, 'stellar:testnet')
  assert.equal(PASSKEY_RELEASE.defaultNetwork, 'stellar:testnet')
})

test('a Stellar network with no smart-account constants is refused, and says why', () => {
  // The rule is a fact about the registry, not a list kept in the gate: strip the block and
  // the network stops being served, which is what makes "recorded only once read" enforceable.
  const bare = { ...testnet, contracts: { ...testnet.contracts, smartAccount: undefined } }
  const gate = passkeyChain(bare.caip2, [bare])
  assert.equal(gate.ok, false)
  if (!gate.ok) {
    assert.equal(gate.code, 'network_not_served')
    assert.match(gate.reason, /no contracts.smartAccount/)
    assert.match(gate.reason, /Nothing was submitted/)
  }
})

test('the pubnet caps are the tight set, and every one of them is below testnet', () => {
  const t = passkeyCaps(testnet)
  const m = passkeyCaps(pubnet)
  // This is the assertion that matters: a future edit that loosens pubnet, or that points
  // pubnet at the testnet table by accident, fails here rather than on someone's balance.
  assert.ok(m.seedUsdDefault < t.seedUsdDefault, 'the pubnet seed must be smaller')
  assert.ok(m.seedUsdMax < t.seedUsdMax)
  assert.ok(m.agentPayMaxUsd < t.agentPayMaxUsd)
  assert.ok(m.dailyCapUsd < t.dailyCapUsd)
  assert.ok(m.autoApproveUsd < t.autoApproveUsd)
  assert.ok(m.seedDailyTotalUsd < t.seedDailyTotalUsd)
  // And a number, not just an ordering: a dollar a day is the published pubnet ceiling.
  assert.equal(m.seedDailyTotalUsd, 1)
})

test('the seed budget bounds our own USDC across everyone, and hands a reserve back', () => {
  const caps = passkeyCaps(pubnet)
  const b = createSeedBudget()
  const net = pubnet.caip2
  const at = 1_000_000
  // A hundred seeds of a hundredth fit in the dollar; the hundred and first does not.
  for (let i = 0; i < 100; i += 1) {
    assert.equal(b.charge(net, caps.seedUsdDefault, caps, at).ok, true, `seed ${i + 1} should fit`)
  }
  const over = b.charge(net, caps.seedUsdDefault, caps, at)
  assert.equal(over.ok, false)
  if (!over.ok) {
    assert.equal(over.code, 'seed_budget_exhausted')
    assert.match(over.reason, /no USDC left this server/)
    // The refusal must offer the way out rather than just closing the door.
    assert.match(over.reason, /fund a vault yourself/)
  }
  // A deploy that failed after the charge gives the day its money back.
  b.refund(net, caps.seedUsdDefault, at)
  assert.equal(b.charge(net, caps.seedUsdDefault, caps, at).ok, true, 'a refunded seed is spendable again')
})

test('a zero seed costs the budget nothing, because it moves nothing', () => {
  const caps = passkeyCaps(pubnet)
  const b = createSeedBudget()
  for (let i = 0; i < 500; i += 1) assert.equal(b.charge(pubnet.caip2, 0, caps, 1).ok, true)
  assert.equal(b.snapshot(pubnet.caip2, caps, 1).spentUsd, 0)
})

test('the two networks do not share a seed day', () => {
  const b = createSeedBudget()
  const mainCaps = passkeyCaps(pubnet)
  const testCaps = passkeyCaps(testnet)
  b.charge(pubnet.caip2, mainCaps.seedDailyTotalUsd, mainCaps, 1)
  assert.equal(b.charge(pubnet.caip2, mainCaps.seedUsdDefault, mainCaps, 1).ok, false, 'pubnet is spent')
  assert.equal(b.charge(testnet.caip2, testCaps.seedUsdDefault, testCaps, 1).ok, true, 'testnet is untouched')
})

test('a network that is not a Stellar chain is refused before anything else happens', () => {
  for (const want of ['arc', 'eip155:5042002', 'stellar:nope', 'algorand']) {
    const gate = passkeyChain(want, CHAINS)
    assert.equal(gate.ok, false, `${want} must not resolve`)
    if (!gate.ok) assert.equal(gate.code, 'bad_request')
  }
})

test('an unnamed network means testnet, and both the slug and the CAIP-2 id resolve to it', () => {
  for (const want of [undefined, '', 'stellar-testnet', 'stellar:testnet']) {
    const gate = passkeyChain(want, CHAINS)
    assert.equal(gate.ok, true, `${String(want)} should resolve to testnet`)
    if (gate.ok) assert.equal(gate.chain.caip2, PASSKEY_RELEASE.defaultNetwork)
  }
})

test('a Stellar testnet with no smart-account constants serves nothing, rather than guessing them', () => {
  const stripped = { ...testnet, contracts: { ...testnet.contracts, smartAccount: undefined } }
  const gate = passkeyChain('stellar-testnet', [stripped])
  assert.equal(gate.ok, false)
  if (!gate.ok) assert.match(gate.reason, /contracts\.smartAccount/)
})

// ── the relay body ───────────────────────────────────────────────────────────────

test('the kit\'s two bodies are both read, wrapped in params or not', () => {
  const flat = relayParams({ func: 'AAAA', auth: ['BBBB'], network: 'stellar-testnet' })
  assert.equal(flat.ok, true)
  if (flat.ok) {
    assert.deepEqual(flat.params, { func: 'AAAA', auth: ['BBBB'] })
    assert.equal(flat.network, 'stellar-testnet')
  }
  // Channels itself wants { params: ... }, so a caller replaying a request against either
  // endpoint sends the same object and it is understood.
  const wrapped = relayParams({ params: { xdr: 'CCCC' } })
  assert.equal(wrapped.ok, true)
  if (wrapped.ok) assert.deepEqual(wrapped.params, { xdr: 'CCCC' })
})

test('a body that is neither shape, or both at once, is refused', () => {
  for (const body of [null, 'string', {}, { func: 'A' }, { auth: ['B'] }, { func: 'A', auth: 'B' }, { func: 'A', auth: [''] }, { xdr: '' }]) {
    assert.equal(relayParams(body).ok, false, `${JSON.stringify(body)} must not be accepted`)
  }
  const both = relayParams({ func: 'A', auth: [], xdr: 'B' })
  assert.equal(both.ok, false)
  if (!both.ok) assert.match(both.reason, /not both/)
})

// ── the relay allowlist ──────────────────────────────────────────────────────────

const deployFunc = (wasmHash: string | null, createXdr = 'CREATE-1'): RelayFunc => ({
  kind: 'create-contract-v2',
  wasmHash,
  deployer: accountId(),
  createXdr,
  constructorArgs: 2,
})
const invokeFunc = (contract: string, method: string, argsXdr = 'ARGS-1', execute: { target: string; targetFn: string; targetArgs: unknown[] } | null = null): RelayFunc => ({
  kind: 'invoke',
  contract,
  method,
  args: [],
  argsXdr,
  execute,
})
const addressAuth = (address: string, root: RelayAuth['root'], sub: RelayAuth['sub'] = []): RelayAuth => ({ credentials: 'address', address, root, sub })
const ok = (func: RelayFunc, auth: RelayAuth[], carrier: 'func-auth' | 'xdr' = 'func-auth'): RelayInspection => ({ ok: true, carrier, func, auth, envelope: null })
const pre = (i: RelayInspection) => relayPreflight(i, { smartAccountWasmHash: WASM })

test('a deploy of the smart-account wasm the registry names is relayed', () => {
  const func = deployFunc(WASM)
  const r = pre(ok(func, [addressAuth(accountId(), { kind: 'create-contract-v2', wasmHash: WASM, createXdr: 'CREATE-1' })]))
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rule, 'smart-account-deploy')
    assert.equal(r.vault, null)
  }
})

test('REFUSAL: a deploy of any other wasm is not something this relay pays to create', () => {
  const other = 'ff'.repeat(32)
  const r = pre(ok(deployFunc(other), [addressAuth(accountId(), { kind: 'create-contract-v2', wasmHash: other, createXdr: 'CREATE-1' })]))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /only executable this relay pays to create/)
})

test('REFUSAL: a wasm upload is never relayed, whoever signs it', () => {
  const r = pre(ok({ kind: 'other', what: 'a wasm upload, which this relay never pays for' }, [addressAuth(accountId(), { kind: 'contract-fn', contract: contractId(), method: 'set_policy', argsXdr: 'X' })]))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /wasm upload/)
})

test('REFUSAL: an authorization entry for some OTHER call cannot ride along with this one', () => {
  // The entry is a signature over what it names, so an entry whose root is a different
  // invocation is signed authority for that other call, and the relayer would pay to land it.
  const vault = contractId()
  const owner = contractId()
  const func = invokeFunc(vault, 'set_allowed', 'ARGS-REAL')
  const r = pre(ok(func, [addressAuth(owner, { kind: 'contract-fn', contract: vault, method: 'set_allowed', argsXdr: 'ARGS-SOMETHING-ELSE' })]))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /authorizes something other than this exact/)
})

test('REFUSAL: an entry with no authorization at all is not a request anyone signed', () => {
  const r = pre(ok(deployFunc(WASM), []))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /nothing here is signed/)
})

test('REFUSAL: a source-account credential on the kit\'s carrier would be the relayer authorizing itself', () => {
  const vault = contractId()
  const func = invokeFunc(vault, 'set_frozen')
  const r = pre(ok(func, [{ credentials: 'source-account', address: null, root: { kind: 'contract-fn', contract: vault, method: 'set_frozen', argsXdr: 'ARGS-1' }, sub: [] }]))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /relayer's own channel account/)
})

test('REFUSAL: a credential kind this relay cannot read is refused rather than guessed at', () => {
  const vault = contractId()
  const r = pre(ok(invokeFunc(vault, 'set_frozen'), [{ credentials: 'other', address: null, root: { kind: 'contract-fn', contract: vault, method: 'set_frozen', argsXdr: 'ARGS-1' }, sub: [] }]))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /credential kind/)
})

test('a smart account executing an owner entrypoint on a vault is the shape the kit sends', () => {
  const smartAccount = contractId()
  const vault = contractId()
  const func = invokeFunc(smartAccount, 'execute', 'EXEC-ARGS', { target: vault, targetFn: 'set_policy', targetArgs: ['1', '2', true] })
  const r = pre(
    ok(func, [
      addressAuth(smartAccount, { kind: 'contract-fn', contract: smartAccount, method: 'execute', argsXdr: 'EXEC-ARGS' }, [
        { kind: 'contract-fn', contract: vault, method: 'set_policy', argsXdr: 'INNER' },
      ]),
    ]),
  )
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rule, 'smart-account-execute')
    assert.equal(r.vault, vault)
    assert.equal(r.smartAccount, smartAccount)
    assert.equal(r.method, 'set_policy')
  }
})

test('REFUSAL: execute() may not carry pay, which is the operator\'s call and never the owner\'s relay', () => {
  const smartAccount = contractId()
  const vault = contractId()
  const func = invokeFunc(smartAccount, 'execute', 'EXEC-ARGS', { target: vault, targetFn: 'pay', targetArgs: [] })
  const r = pre(ok(func, [addressAuth(smartAccount, { kind: 'contract-fn', contract: smartAccount, method: 'execute', argsXdr: 'EXEC-ARGS' })]))
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.match(r.reason, /only a vault owner entrypoint is relayed/)
    assert.match(r.reason, /pay is the operator's call/)
  }
})

test('REFUSAL: somebody other than the smart account may not authorize its execute()', () => {
  const smartAccount = contractId()
  const stranger = contractId()
  const vault = contractId()
  const func = invokeFunc(smartAccount, 'execute', 'EXEC-ARGS', { target: vault, targetFn: 'withdraw', targetArgs: [] })
  const r = pre(ok(func, [addressAuth(stranger, { kind: 'contract-fn', contract: smartAccount, method: 'execute', argsXdr: 'EXEC-ARGS' })]))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /authorizing its own execute/)
})

test('REFUSAL: a sub-invocation outside the target vault turns one signature into two calls', () => {
  const smartAccount = contractId()
  const vault = contractId()
  const elsewhere = contractId()
  const func = invokeFunc(smartAccount, 'execute', 'EXEC-ARGS', { target: vault, targetFn: 'set_allowed', targetArgs: [] })
  const r = pre(
    ok(func, [
      addressAuth(smartAccount, { kind: 'contract-fn', contract: smartAccount, method: 'execute', argsXdr: 'EXEC-ARGS' }, [
        { kind: 'contract-fn', contract: elsewhere, method: 'transfer', argsXdr: 'INNER' },
      ]),
    ]),
  )
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /sub-invocation outside the target vault/)
})

test('a direct owner call authorized by a CONTRACT owner is relayed; a G... owner is sent to the console instead', () => {
  const vault = contractId()
  const owner = contractId()
  const good = pre(ok(invokeFunc(vault, 'set_allowed'), [addressAuth(owner, { kind: 'contract-fn', contract: vault, method: 'set_allowed', argsXdr: 'ARGS-1' })]))
  assert.equal(good.ok, true)
  if (good.ok) {
    assert.equal(good.rule, 'owner-call')
    assert.equal(good.vault, vault)
  }
  const account = pre(ok(invokeFunc(vault, 'set_allowed'), [addressAuth(accountId(), { kind: 'contract-fn', contract: vault, method: 'set_allowed', argsXdr: 'ARGS-1' })]))
  assert.equal(account.ok, false)
  if (!account.ok) assert.match(account.reason, /prepare/)
})

test('REFUSAL: a method outside the six owner entrypoints is not relayed on any vault', () => {
  const vault = contractId()
  for (const method of ['transfer', 'set_operator', 'upgrade', 'pay']) {
    const r = pre(ok(invokeFunc(vault, method), [addressAuth(contractId(), { kind: 'contract-fn', contract: vault, method, argsXdr: 'ARGS-1' })]))
    assert.equal(r.ok, false, `${method} must not be relayed`)
  }
})

test('a decoder refusal is passed through rather than replaced with a generic one', () => {
  const r = pre({ ok: false, code: 'bad_request', reason: 'func is not a HostFunction: bad XDR' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /not a HostFunction/)
})

// ── the relay's live half ────────────────────────────────────────────────────────

const preOk = (over: Partial<RelayPreflightOk> = {}): RelayPreflightOk => ({
  ok: true,
  rule: 'smart-account-execute',
  vault: contractId(),
  smartAccount: contractId(),
  method: 'set_policy',
  authAddresses: [],
  summary: 's',
  ...over,
})

test('a deploy needs no vault and no operator, because it touches neither', () => {
  const r = relayDecision(preOk({ rule: 'smart-account-deploy', vault: null, smartAccount: null, method: null }), null, null)
  assert.equal(r.ok, true)
})

test('REFUSAL: with no signer this server operates no vault, so it relays no owner call', () => {
  const r = relayDecision(preOk(), { owner: contractId(), operator: accountId() }, null)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 503)
    assert.equal(r.code, 'no_operator')
  }
})

test('REFUSAL: a vault read that did not answer is a 502, never a pass', () => {
  const r = relayDecision(preOk(), null, accountId())
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 502)
    assert.match(r.reason, /never skipped/)
  }
})

test('REFUSAL: a vault somebody else operates is not ours to pay for', () => {
  const signer = accountId()
  const r = relayDecision(preOk(), { owner: contractId(), operator: accountId() }, signer)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 403)
    assert.equal(r.code, 'not_our_vault')
  }
})

test('REFUSAL: the vault\'s LIVE owner decides who may execute on it, not the request', () => {
  const signer = accountId()
  const smartAccount = contractId()
  const p = preOk({ smartAccount })
  const r = relayDecision(p, { owner: contractId(), operator: signer }, signer)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 403)
    assert.equal(r.code, 'not_owner')
    assert.match(r.reason, /read live/)
  }
  const good = relayDecision(p, { owner: smartAccount, operator: signer }, signer)
  assert.equal(good.ok, true)
})

test('REFUSAL: a direct owner call is refused when the live owner is an account rather than a smart account', () => {
  const signer = accountId()
  const owner = accountId()
  const p = preOk({ rule: 'owner-call', smartAccount: null, authAddresses: [owner] })
  const r = relayDecision(p, { owner, operator: signer }, signer)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'owner_not_contract')
})

test('REFUSAL: an owner call signed by a contract that is not the owner is refused', () => {
  const signer = accountId()
  const owner = contractId()
  const p = preOk({ rule: 'owner-call', smartAccount: null, authAddresses: [contractId()] })
  const r = relayDecision(p, { owner, operator: signer }, signer)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'not_owner')
})

// ── the relayer's wire shape ─────────────────────────────────────────────────────

test('what would be posted names the key variable and never carries a key', () => {
  const req = ozRelayRequest('https://relayer.example/testnet/', 'X402_STELLAR_TESTNET_OZ_KEY', { func: 'A', auth: ['B'] })
  assert.equal(req.method, 'POST')
  assert.equal(req.headers.Authorization, 'Bearer <X402_STELLAR_TESTNET_OZ_KEY>')
  // The body is what Channels expects: the kit's own object, under params.
  assert.deepEqual(req.body, { params: { func: 'A', auth: ['B'] } })
})

test('the relayer answer is read exactly the way the smart-account kit reads it', () => {
  // success only on a 2xx AND success: true, with the payload taken from the nested data.
  const good = ozRelayOutcome(200, { success: true, data: { transactionId: 'tx-1', status: 'submitted', hash: 'a'.repeat(64) } })
  assert.equal(good.success, true)
  if (good.success) {
    assert.equal(good.hash, 'a'.repeat(64))
    assert.equal(good.transactionId, 'tx-1')
    assert.equal(good.status, 'submitted')
  }
  // A 200 that does not say success is a failure, which is the case a looser reading misses.
  assert.equal(ozRelayOutcome(200, { success: false, error: 'SIMULATION_FAILED' }).success, false)
})

test('a relayer error carries the message and the code from wherever the kit looks for them', () => {
  const coded = ozRelayOutcome(400, { success: false, error: 'INVALID_PARAMS' })
  assert.equal(coded.success, false)
  if (!coded.success) {
    // A bare SCREAMING_CASE `error` is a CODE, not a message, so it lands in both places
    // rather than being shown to a human as an explanation.
    assert.equal(coded.code, 'INVALID_PARAMS')
    assert.equal(coded.error, 'INVALID_PARAMS')
  }
  const worded = ozRelayOutcome(500, { success: false, error: 'the channel pool is empty', code: 'POOL_CAPACITY' })
  if (!worded.success) {
    assert.equal(worded.error, 'the channel pool is empty')
    assert.equal(worded.code, 'POOL_CAPACITY')
  }
  // Nothing parseable at all still produces a sentence rather than "undefined".
  const nothing = ozRelayOutcome(502, null)
  assert.equal(nothing.success, false)
  if (!nothing.success) assert.match(nothing.error, /HTTP 502/)
})

/** The caps the tests assert against, read from the same table production reads. */
const PASSKEY_CAPS = passkeyCaps(testnet)
const NET = testnet.caip2

// ── the deploy ───────────────────────────────────────────────────────────────────

test('a vault for a passkey account needs a CONTRACT owner, and an account owner is sent elsewhere', () => {
  const good = passkeyDeployPlan({ owner: contractId(), dailyCapUsd: 5, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(good.ok, true)
  if (good.ok) {
    assert.equal(good.dailyCapRaw, '50000000')
    assert.equal(good.autoApproveMaxRaw, '10000000')
    // Unstated seed means the small default, never zero and never the maximum.
    assert.equal(good.seedUsd, PASSKEY_CAPS.seedUsdDefault)
  }
  const account = passkeyDeployPlan({ owner: accountId(), dailyCapUsd: 5, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(account.ok, false)
  if (!account.ok) assert.match(account.reason, /smart account's contract id/)
})

test('the deploy caps are enforced here, because nothing else stands between them and the operator key', () => {
  const owner = contractId()
  const over = [
    { owner, dailyCapUsd: PASSKEY_CAPS.dailyCapUsd + 0.01, autoApproveUsd: 1 },
    { owner, dailyCapUsd: 5, autoApproveUsd: PASSKEY_CAPS.autoApproveUsd + 0.01 },
    { owner, dailyCapUsd: 5, autoApproveUsd: 1, seedUsd: PASSKEY_CAPS.seedUsdMax + 0.01 },
  ]
  for (const body of over) assert.equal(passkeyDeployPlan(body, DECIMALS, PASSKEY_CAPS, NET).ok, false, JSON.stringify(body))
})

test('a zero cap is refused although the contract accepts it, because here zero means no cap', () => {
  const owner = contractId()
  assert.equal(passkeyDeployPlan({ owner, dailyCapUsd: 0, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET).ok, false)
  assert.equal(passkeyDeployPlan({ owner, dailyCapUsd: 5, autoApproveUsd: 0 }, DECIMALS, PASSKEY_CAPS, NET).ok, false)
  // A zero SEED is fine: it means the vault starts empty, which is a choice, not a policy.
  const noSeed = passkeyDeployPlan({ owner, dailyCapUsd: 5, autoApproveUsd: 1, seedUsd: 0 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(noSeed.ok, true)
  if (noSeed.ok) assert.equal(noSeed.seedRaw, '0')
})

test('a cap that is not a finite number never reaches the constructor', () => {
  const owner = contractId()
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '5', null, undefined]) {
    assert.equal(passkeyDeployPlan({ owner, dailyCapUsd: bad, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET).ok, false, String(bad))
  }
})

// ── the agent payment ────────────────────────────────────────────────────────────

test('the agent payment is bounded here as well as on chain, and at a dollar', () => {
  const contract = contractId()
  const good = passkeyAgentPayPlan({ contract, to: accountId(), amountUsd: 0.5 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(good.ok, true)
  if (good.ok) assert.equal(good.amountRaw, '5000000')
  const over = passkeyAgentPayPlan({ contract, to: accountId(), amountUsd: PASSKEY_CAPS.agentPayMaxUsd + 0.01 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(over.ok, false)
  // Zero is refused because the contract refuses it (InvalidAmount), so refusing it here
  // costs a caller a round trip rather than a fee.
  assert.equal(passkeyAgentPayPlan({ contract, to: accountId(), amountUsd: 0 }, DECIMALS, PASSKEY_CAPS, NET).ok, false)
})

test('a payee may be an account or a contract, and a vault must be a contract', () => {
  assert.equal(passkeyAgentPayPlan({ contract: contractId(), to: contractId(), amountUsd: 0.1 }, DECIMALS, PASSKEY_CAPS, NET).ok, true)
  assert.equal(passkeyAgentPayPlan({ contract: accountId(), to: accountId(), amountUsd: 0.1 }, DECIMALS, PASSKEY_CAPS, NET).ok, false)
  assert.equal(passkeyAgentPayPlan({ contract: contractId(), to: 'not-an-address', amountUsd: 0.1 }, DECIMALS, PASSKEY_CAPS, NET).ok, false)
})

// ── the allowlist plan ───────────────────────────────────────────────────────────

test('the allowlist request refuses anything that is not a vault and a payee', () => {
  assert.equal(allowlistRequest({ contract: contractId(), payee: accountId() }).ok, true)
  assert.equal(allowlistRequest({ contract: accountId(), payee: accountId() }).ok, false)
  assert.equal(allowlistRequest({ contract: contractId(), payee: 'nope' }).ok, false)
  const named = allowlistRequest({ contract: contractId(), payee: accountId(), agentId: '  agent-7  ' })
  assert.equal(named.ok, true)
  if (named.ok) assert.equal(named.agentId, 'agent-7')
})

test('ALLOW writes the payee on chain, WARN writes nothing, DENY writes the revoke', () => {
  const payee = accountId()
  const allow = allowlistPlan('ALLOW', payee, [])
  assert.deepEqual(allow.chainAction, { method: 'set_allowed', payee, ok: true })
  assert.equal(allow.serverWarning, null)

  const warn = allowlistPlan('WARN', payee, ['Moderate reputation (410); proceed with caution'])
  assert.equal(warn.chainAction, null, 'a WARN must never be written on chain: the allowlist has no such state')
  assert.match(warn.serverWarning ?? '', /Moderate reputation/)

  const deny = allowlistPlan('DENY', payee, ['KYA has been REVOKED'])
  assert.deepEqual(deny.chainAction, { method: 'set_allowed', payee, ok: false })
})

test('no decision at all is DENY, because on a binary allowlist the only safe default is off', () => {
  const payee = accountId()
  const none = allowlistPlan(null, payee, [])
  assert.equal(none.decision, 'DENY')
  assert.deepEqual(none.chainAction, { method: 'set_allowed', payee, ok: false })
})

test('every plan publishes what the allowlist can and cannot express', () => {
  const plan = allowlistPlan('WARN', accountId(), ['x'])
  assert.equal(plan.enforcement, ALLOWLIST_ENFORCEMENT)
  assert.match(plan.enforcement.allowlist, /binary/)
  // The DENY sentence has to name the contract error, because that is the checkable claim.
  assert.match(plan.enforcement.DENY, /PayeeNotAllowed/)
  assert.match(plan.enforcement.signer, /writes nothing on chain/)
})

test('a payee is bound to an agent by a proven wallet, by a caller\'s word, or not at all', () => {
  const payee = accountId()
  const agents = [{ id: 'agent-1', owner: payee.toLowerCase() }, { id: 'agent-2', owner: 'someone@example.com' }]

  const linked = bindPayeeToAgent({ agentId: null, payee, agents, linkedSubjects: [payee] })
  assert.equal(linked.binding, 'linked-wallet')
  assert.equal(linked.agentId, 'agent-1')

  const declared = bindPayeeToAgent({ agentId: 'agent-2', payee, agents, linkedSubjects: [] })
  assert.equal(declared.binding, 'declared')
  assert.equal(declared.agentId, 'agent-2')
  // The distinction is the point: a declared id is the caller's claim and the note says so.
  assert.match(declared.note, /named by the caller/)

  const none = bindPayeeToAgent({ agentId: null, payee, agents, linkedSubjects: [] })
  assert.equal(none.binding, 'none')
  assert.equal(none.agentId, null)
})

// ── what the relay may spend, across everyone ─────────────────────────────

/**
 * The bounds a judge asks about: what stops someone draining the Channels quota.
 *
 * Three of the four numbers SDF's own reference relayer proxy sets. The per-IP one we
 * already had and the first test keeps the published copy honest against it; the global
 * rate limit and the fee reserve are new and the rest of these pin them. Each test builds
 * its own budget, because a module-level window shared between tests is a test that passes
 * depending on what ran before it.
 */

const smallLimits = (over: Partial<PasskeyRelayLimits> = {}): PasskeyRelayLimits => ({
  perIp: { bucket: 'passkey-relay', max: 10, windowMs: 60_000 },
  global: { max: 3, windowMs: 60_000 },
  fee: { ceilingStroops: 1_100_000n, dailyStroops: 3_300_000n, windowMs: 86_400_000 },
  ...over,
})

test('the per-IP limit the status endpoint publishes is the one rate-budget.ts actually enforces', () => {
  const enforced = rateBudget('POST', '/api/stellar/passkey/relay')
  assert.ok(enforced, 'the relay must still have a per-IP budget at all')
  assert.equal(PASSKEY_RELAY_LIMITS.perIp.bucket, enforced.bucket)
  assert.equal(PASSKEY_RELAY_LIMITS.perIp.max, enforced.max)
  assert.equal(PASSKEY_RELAY_LIMITS.perIp.windowMs, enforced.windowMs)
  // SDF's proxy for this same kit sets 10 per IP per minute, and this is the same number.
  assert.equal(enforced.max, 10)
  assert.equal(enforced.windowMs, 60_000)
})

test('the global rate limit bounds every caller together, not one address at a time', () => {
  const b = createRelayBudget(smallLimits())
  const t0 = 1_000_000
  for (let i = 1; i <= 3; i++) {
    const ok = b.admit(t0)
    assert.equal(ok.ok, true, `admission ${i} should pass`)
    if (ok.ok) assert.equal(ok.used, i)
  }
  const refused = b.admit(t0)
  assert.equal(refused.ok, false, 'the fourth in the same window must be refused')
  if (refused.ok) return
  assert.equal(refused.status, 429)
  assert.equal(refused.code, 'relay_global_rate_limit')
  assert.equal(refused.retryAfterSeconds, 60)
  // The reason has to say what makes this different from the per-IP budget, or an operator
  // reading a 429 cannot tell which of the two fired.
  assert.match(refused.reason, /ALL callers/)
  assert.match(refused.reason, /nothing was forwarded/i)
  // And the window really does reopen, rather than the limit being a one-way door.
  const after = b.admit(t0 + 60_001)
  assert.equal(after.ok, true)
  if (after.ok) assert.equal(after.used, 1)
})

test('every forwarded request reserves the fee ceiling, and the 24 hour budget then refuses', () => {
  const b = createRelayBudget(smallLimits())
  const t0 = 2_000_000
  for (let i = 0; i < 3; i++) {
    const r = b.reserve(t0)
    assert.equal(r.ok, true, `reservation ${i + 1} should fit in 3 ceilings of budget`)
    if (r.ok) assert.equal(r.reservedStroops, 1_100_000n)
  }
  const refused = b.reserve(t0)
  assert.equal(refused.ok, false, 'a fourth reservation does not fit and must be refused')
  if (refused.ok) return
  assert.equal(refused.status, 429)
  assert.equal(refused.code, 'relay_fee_budget_exhausted')
  assert.match(refused.reason, /relayer key was not used/)
  // The honest sentence: this is a ceiling we reserve, not XLM we measured.
  assert.match(refused.reason, /not a measurement/)
  const snap = b.snapshot(t0)
  assert.equal(snap.fee.relaysLeft, 0)
  assert.equal(snap.fee.relaysForwarded, 3)
  assert.equal(snap.fee.reservedStroops, '3300000')
  // 24 hours later the budget is whole again, and nothing carries over.
  const next = b.reserve(t0 + 86_400_001)
  assert.equal(next.ok, true)
  assert.equal(b.snapshot(t0 + 86_400_001).fee.relaysForwarded, 1)
})

test('the real budget is 100 broadcasts a day, which is the ceiling divided into the budget', () => {
  // Stated as a derived fact rather than a second literal: if either number moves, this is
  // what tells the person who moved it what they just changed the demo's day to.
  assert.equal(PASSKEY_RELAY_LIMITS.fee.dailyStroops / PASSKEY_RELAY_LIMITS.fee.ceilingStroops, 100n)
  assert.equal(PASSKEY_RELAY_LIMITS.fee.ceilingStroops, 1_100_000n, 'SDF sets a max total fee of 1,100,000 stroops for the same relayer')
  assert.equal(PASSKEY_RELAY_LIMITS.global.max, 100)
  assert.equal(PASSKEY_RELAY_LIMITS.global.windowMs, 60_000)
  assert.equal(createRelayBudget().snapshot(1).fee.relaysLeft, 100)
})

test('a fee is read only from a charge-shaped field, and a bid is deliberately not one', () => {
  assert.equal(relayFeeReported({ feeCharged: 40_123 }), 40_123n)
  assert.equal(relayFeeReported({ fee: '40123' }), 40_123n)
  assert.equal(relayFeeReported({ fee_stroops: 7 }), 7n)
  // Nothing to read is null, never zero: zero would claim a free broadcast.
  for (const v of [null, undefined, {}, { fee: 'not-a-number' }, { fee: -1 }, { fee: 1.5 }, 'x', 7]) {
    assert.equal(relayFeeReported(v), null, JSON.stringify(v) ?? String(v))
  }
  // maxFee is a bid, and reporting a bid as a charge would be a ceiling wearing a
  // measurement's label. We already have a ceiling.
  assert.equal(relayFeeReported({ maxFee: 1_000_000 }), null)
})

test('a reserve settles against the relayer\'s own number when it reports one', () => {
  const ok: OzRelayOutcome = { success: true, transactionId: 'tx-1', hash: 'a'.repeat(64), status: 'submitted', data: { feeCharged: '100000' } }
  const s = relayFeeSettlement(ok, 1_100_000n)
  assert.equal(s.basis, 'measured')
  assert.equal(s.feeStroops, 100_000n)
  assert.equal(s.refundStroops, 1_000_000n, 'the day keeps only what was charged')
  // A fee above the reserve cannot refund a negative amount into the budget.
  const huge: OzRelayOutcome = { success: true, transactionId: 'tx-2', hash: 'b'.repeat(64), status: 'submitted', data: { feeCharged: '9999999' } }
  assert.equal(relayFeeSettlement(huge, 1_100_000n).refundStroops, 0n)
})

test('a submission the relayer prices silently keeps its whole reserve, labelled as a reserve', () => {
  // This is the production case as of 2026-09-20: Channels answers with transactionId,
  // status and hash, and no fee anywhere. The point of the test is that we say so instead
  // of recording a number we do not have.
  const silent: OzRelayOutcome = { success: true, transactionId: 'tx-3', hash: 'c'.repeat(64), status: 'submitted', data: { transactionId: 'tx-3', status: 'submitted' } }
  const s = relayFeeSettlement(silent, 1_100_000n)
  assert.equal(s.basis, 'reserved')
  assert.equal(s.feeStroops, null, 'an unknown fee is null, never 0')
  assert.equal(s.refundStroops, 0n)
  assert.match(s.note, /not a measurement/)
})

test('a relayer refusal hands the reserve back only when it names no transaction', () => {
  const refusedClean: OzRelayOutcome = { success: false, error: 'SIMULATION_FAILED', code: 'SIMULATION_FAILED', data: { error: 'SIMULATION_FAILED' } }
  const clean = relayFeeSettlement(refusedClean, 1_100_000n)
  assert.equal(clean.basis, 'not-broadcast')
  assert.equal(clean.refundStroops, 1_100_000n, 'nothing was broadcast, so the day owes the whole reserve back')
  assert.equal(clean.feeStroops, 0n)

  // A refusal that names a hash may still have reached the network, and a guess in that
  // direction hands budget back for a transaction we may have paid for.
  const maybe: OzRelayOutcome = { success: false, error: 'TIMEOUT', code: null, data: { hash: 'd'.repeat(64) } }
  const kept = relayFeeSettlement(maybe, 1_100_000n)
  assert.equal(kept.basis, 'reserved')
  assert.equal(kept.refundStroops, 0n)
  assert.match(kept.note, /may have reached the network/)
})

test('settling a reserve into a window that has already rolled credits nothing', () => {
  const b = createRelayBudget(smallLimits())
  const t0 = 3_000_000
  const r = b.reserve(t0)
  assert.equal(r.ok, true)
  if (!r.ok) return
  // A relayer round trip can outlive the window it started in. Refunding then would credit
  // a day that never paid, and the next day would quietly start with free budget.
  const later = t0 + 86_400_001
  b.settle({ windowResetAt: r.windowResetAt, refundStroops: r.reservedStroops, measured: false }, later)
  assert.equal(b.snapshot(later).fee.reservedStroops, '0', 'the new window starts empty either way')
  const fresh = b.reserve(later)
  assert.equal(fresh.ok, true)
  b.settle({ windowResetAt: (fresh as { windowResetAt: number }).windowResetAt, refundStroops: 1_100_000n, measured: true }, later)
  const snap = b.snapshot(later)
  assert.equal(snap.fee.reservedStroops, '0', 'a refund inside its own window is credited')
  assert.equal(snap.fee.feesReported, 1)
  assert.equal(snap.fee.basis, 'measured')
})

test('a snapshot reads the budget without opening a window of its own', () => {
  const b = createRelayBudget(smallLimits())
  const idle = b.snapshot(4_000_000)
  assert.equal(idle.global.used, 0)
  assert.equal(idle.global.resetAt, null, 'a GET must not start the minute')
  assert.equal(idle.fee.resetAt, null)
  assert.equal(idle.fee.basis, 'nothing-forwarded')
  assert.equal(b.admit(4_000_000).ok, true, 'and the first real request still gets its full window')
})

// ── the status view ──────────────────────────────────────────────────────────────

test('the status view names the key variable, says whether it is set, and carries no secret', () => {
  const view = passkeyStatusView(testnet, {
    keyVar: 'X402_STELLAR_TESTNET_OZ_KEY',
    keyConfigured: false,
    relayerUrl: 'https://relayer.example/testnet/',
    operator: null,
    explorerFor: (a) => `https://example/contract/${a}`,
    relayLimits: createRelayBudget().snapshot(),
    seedLimits: createSeedBudget().snapshot(testnet.caip2, passkeyCaps(testnet)),
  })
  const text = JSON.stringify(view)
  assert.equal((view.relayer as Record<string, unknown>).keyVar, 'X402_STELLAR_TESTNET_OZ_KEY')
  assert.equal((view.relayer as Record<string, unknown>).keyConfigured, false)
  assert.equal((view.relayer as Record<string, unknown>).product, PASSKEY_RELEASE.relayerProduct)
  assert.equal(view.realMoney, false)
  assert.equal((view.pubnet as Record<string, unknown>).served, false)
  // The smart-account constants are published as third-party facts, with their provenance.
  const sa = view.smartAccount as Record<string, unknown>
  assert.equal(sa.wasmHash, WASM)
  assert.equal(sa.thirdParty, true)
  assert.match(String(sa.verified), /smart-account-kit/)
  assert.equal(text.includes('Bearer'), false, 'a status view must never carry a credential of any shape')
})

test('the passkey vault is published as a smart-account-owned row, with its explorer link derived', () => {
  const view = passkeyStatusView(testnet, {
    keyVar: 'X402_STELLAR_TESTNET_OZ_KEY',
    keyConfigured: true,
    relayerUrl: 'https://relayer.example/testnet/',
    operator: accountId(),
    explorerFor: (a) => `https://example/contract/${a}`,
    relayLimits: createRelayBudget().snapshot(),
    seedLimits: createSeedBudget().snapshot(testnet.caip2, passkeyCaps(testnet)),
  })
  const vault = view.passkeyVault as Record<string, unknown>
  assert.equal(vault.contract, testnet.contracts.passkeyVault)
  assert.equal(vault.ownerKind, 'smart-account')
  assert.match(String(vault.explorerUrl), new RegExp(String(testnet.contracts.passkeyVault)))
})

test('the status view publishes both relay limits, and calls the fee figure a reserve', () => {
  const b = createRelayBudget()
  const at = 5_000_000
  b.admit(at)
  const r = b.reserve(at)
  const view = passkeyStatusView(testnet, {
    keyVar: 'X402_STELLAR_TESTNET_OZ_KEY',
    keyConfigured: true,
    relayerUrl: 'https://relayer.example/testnet/',
    operator: accountId(),
    explorerFor: (a) => `https://example/contract/${a}`,
    relayLimits: b.snapshot(at),
    seedLimits: createSeedBudget().snapshot(testnet.caip2, passkeyCaps(testnet)),
  })
  const limits = view.limits as Record<string, Record<string, unknown>>
  // Per IP, and it names where it is applied rather than leaving a reader to find out.
  assert.equal(limits.perIp.max, 10)
  assert.match(String(limits.perIp.enforcedIn), /rate-budget\.ts/)
  // Global, with what is left of the current minute.
  assert.equal(limits.global.max, 100)
  assert.equal(limits.global.used, 1)
  // The fee budget, as a count of broadcasts rather than as XLM we claim to have spent.
  assert.equal(limits.fee.ceilingStroops, '1100000')
  assert.equal(limits.fee.dailyStroops, '110000000')
  assert.equal(limits.fee.relaysForwarded, 1)
  assert.equal(limits.fee.relaysLeft, 99)
  assert.equal(limits.fee.basis, 'reserved')
  assert.match(String(limits.fee.note), /Reserved, not measured/)
  assert.ok(r.ok)
  // Nothing in a published limit may be a bigint: it would throw on the way out.
  assert.doesNotThrow(() => JSON.stringify(view))
})

test('an owner kind is read off the StrKey prefix and is never guessed from a label', () => {
  assert.equal(ownerKindOf(contractId()), 'smart-account')
  assert.equal(ownerKindOf(accountId()), 'account')
  for (const bad of [null, undefined, '', 'GARBAGE', 123 as unknown as string]) {
    assert.equal(ownerKindOf(bad), null, String(bad))
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Keypair, StrKey } from '@stellar/stellar-sdk'

import { CHAINS } from './chains/index.js'
import type { RelayAuth, RelayFunc, RelayInspection } from './chains/stellar/relay-shape.js'
import {
  ALLOWLIST_ENFORCEMENT,
  PASSKEY_CAPS,
  PASSKEY_RELEASE,
  allowlistPlan,
  allowlistRequest,
  bindPayeeToAgent,
  ownerKindOf,
  ozRelayOutcome,
  ozRelayRequest,
  passkeyAgentPayPlan,
  passkeyChain,
  passkeyDeployPlan,
  passkeyStatusView,
  relayDecision,
  relayParams,
  relayPreflight,
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

test('pubnet is refused by name, not by falling through to testnet', () => {
  for (const want of ['stellar', 'stellar:pubnet']) {
    const gate = passkeyChain(want, CHAINS)
    assert.equal(gate.ok, false, `${want} must not be served`)
    if (gate.ok) return
    assert.equal(gate.code, 'testnet_only')
    // The reason has to say WHY rather than just no: an operator reading this should learn
    // that the pubnet constants were left out on purpose.
    assert.match(gate.reason, /TESTNET ONLY/)
    assert.match(gate.reason, /pubnet/)
  }
  assert.equal(pubnet.testnet, false, 'this test is only meaningful while stellar is the mainnet descriptor')
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
    if (gate.ok) assert.equal(gate.chain.caip2, PASSKEY_RELEASE.network)
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

// ── the deploy ───────────────────────────────────────────────────────────────────

test('a vault for a passkey account needs a CONTRACT owner, and an account owner is sent elsewhere', () => {
  const good = passkeyDeployPlan({ owner: contractId(), dailyCapUsd: 5, autoApproveUsd: 1 }, DECIMALS)
  assert.equal(good.ok, true)
  if (good.ok) {
    assert.equal(good.dailyCapRaw, '50000000')
    assert.equal(good.autoApproveMaxRaw, '10000000')
    // Unstated seed means the small default, never zero and never the maximum.
    assert.equal(good.seedUsd, PASSKEY_CAPS.seedUsdDefault)
  }
  const account = passkeyDeployPlan({ owner: accountId(), dailyCapUsd: 5, autoApproveUsd: 1 }, DECIMALS)
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
  for (const body of over) assert.equal(passkeyDeployPlan(body, DECIMALS).ok, false, JSON.stringify(body))
})

test('a zero cap is refused although the contract accepts it, because here zero means no cap', () => {
  const owner = contractId()
  assert.equal(passkeyDeployPlan({ owner, dailyCapUsd: 0, autoApproveUsd: 1 }, DECIMALS).ok, false)
  assert.equal(passkeyDeployPlan({ owner, dailyCapUsd: 5, autoApproveUsd: 0 }, DECIMALS).ok, false)
  // A zero SEED is fine: it means the vault starts empty, which is a choice, not a policy.
  const noSeed = passkeyDeployPlan({ owner, dailyCapUsd: 5, autoApproveUsd: 1, seedUsd: 0 }, DECIMALS)
  assert.equal(noSeed.ok, true)
  if (noSeed.ok) assert.equal(noSeed.seedRaw, '0')
})

test('a cap that is not a finite number never reaches the constructor', () => {
  const owner = contractId()
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '5', null, undefined]) {
    assert.equal(passkeyDeployPlan({ owner, dailyCapUsd: bad, autoApproveUsd: 1 }, DECIMALS).ok, false, String(bad))
  }
})

// ── the agent payment ────────────────────────────────────────────────────────────

test('the agent payment is bounded here as well as on chain, and at a dollar', () => {
  const contract = contractId()
  const good = passkeyAgentPayPlan({ contract, to: accountId(), amountUsd: 0.5 }, DECIMALS)
  assert.equal(good.ok, true)
  if (good.ok) assert.equal(good.amountRaw, '5000000')
  const over = passkeyAgentPayPlan({ contract, to: accountId(), amountUsd: PASSKEY_CAPS.agentPayMaxUsd + 0.01 }, DECIMALS)
  assert.equal(over.ok, false)
  // Zero is refused because the contract refuses it (InvalidAmount), so refusing it here
  // costs a caller a round trip rather than a fee.
  assert.equal(passkeyAgentPayPlan({ contract, to: accountId(), amountUsd: 0 }, DECIMALS).ok, false)
})

test('a payee may be an account or a contract, and a vault must be a contract', () => {
  assert.equal(passkeyAgentPayPlan({ contract: contractId(), to: contractId(), amountUsd: 0.1 }, DECIMALS).ok, true)
  assert.equal(passkeyAgentPayPlan({ contract: accountId(), to: accountId(), amountUsd: 0.1 }, DECIMALS).ok, false)
  assert.equal(passkeyAgentPayPlan({ contract: contractId(), to: 'not-an-address', amountUsd: 0.1 }, DECIMALS).ok, false)
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

// ── the status view ──────────────────────────────────────────────────────────────

test('the status view names the key variable, says whether it is set, and carries no secret', () => {
  const view = passkeyStatusView(testnet, {
    keyVar: 'X402_STELLAR_TESTNET_OZ_KEY',
    keyConfigured: false,
    relayerUrl: 'https://relayer.example/testnet/',
    operator: null,
    explorerFor: (a) => `https://example/contract/${a}`,
  })
  const text = JSON.stringify(view)
  assert.equal((view.relayer as Record<string, unknown>).keyVar, 'X402_STELLAR_TESTNET_OZ_KEY')
  assert.equal((view.relayer as Record<string, unknown>).keyConfigured, false)
  assert.equal((view.relayer as Record<string, unknown>).product, PASSKEY_RELEASE.relayerProduct)
  assert.equal(view.testnetOnly, true)
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
  })
  const vault = view.passkeyVault as Record<string, unknown>
  assert.equal(vault.contract, testnet.contracts.passkeyVault)
  assert.equal(vault.ownerKind, 'smart-account')
  assert.match(String(vault.explorerUrl), new RegExp(String(testnet.contracts.passkeyVault)))
})

test('an owner kind is read off the StrKey prefix and is never guessed from a label', () => {
  assert.equal(ownerKindOf(contractId()), 'smart-account')
  assert.equal(ownerKindOf(accountId()), 'account')
  for (const bad of [null, undefined, '', 'GARBAGE', 123 as unknown as string]) {
    assert.equal(ownerKindOf(bad), null, String(bad))
  }
})

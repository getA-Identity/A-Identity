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
  createDeployBudget,
  PASSKEY_RELAY_LIMITS,
  PASSKEY_RELEASE,
  allowlistPlan,
  allowlistRequest,
  bindPayeeToAgent,
  createRelayBudget,
  flagshipVaults,
  operatorGate,
  operatorRefusedVaults,
  ownerAccountCheck,
  ownerKindOf,
  parsePasskeyPublicKey,
  requestedNetwork,
  smartAccountCodeVerdict,
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
  assert.ok(m.deployDailyMax < t.deployDailyMax)
  // And a number, not just an ordering: a dollar a day is the published pubnet ceiling.
  assert.equal(m.seedDailyTotalUsd, 1)
  assert.equal(m.deployDailyMax, 100, 'a hundred operator-paid mainnet deploys a day, seeded or not')
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
    // And it must say who pays for the deploy: the operator, never the relayer.
    assert.match(over.reason, /vault deploy costs a network fee the operator account pays/)
    assert.doesNotMatch(over.reason, /vault deploy[^.;]*relayer sponsors/)
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

// ── how many vaults the operator pays to deploy ──────────────────────────────────

test('the deploy count bounds operator-paid deploys across everyone, seeded or not, and refuses the next one', () => {
  const caps = passkeyCaps(pubnet)
  const b = createDeployBudget()
  const net = pubnet.caip2
  // A zero seed costs the seed budget nothing; it is exactly the deploy this count exists for.
  for (let i = 0; i < caps.deployDailyMax; i += 1) {
    assert.equal(b.charge(net, contractId(), caps, 1).ok, true, `deploy ${i + 1} should fit`)
  }
  const over = b.charge(net, contractId(), caps, 1)
  assert.equal(over.ok, false)
  if (!over.ok) {
    assert.equal(over.status, 429)
    assert.equal(over.code, 'deploy_budget_exhausted')
    assert.match(over.reason, /paid by the operator account, not by the relayer/)
    assert.match(over.reason, /Nothing was deployed and nothing was spent/)
    assert.ok(over.retryAfterSeconds > 0)
  }
  const snap = b.snapshot(net, caps, 1)
  assert.equal(snap.used, caps.deployDailyMax)
  assert.equal(snap.left, 0)
  assert.match(snap.note, /seeded or not/)
})

test('REFUSAL: one smart account gets one operator-paid vault per window, so the same owner cannot be sent again', () => {
  const caps = passkeyCaps(pubnet)
  const b = createDeployBudget()
  const owner = contractId()
  assert.equal(b.charge(pubnet.caip2, owner, caps, 1).ok, true)
  const again = b.charge(pubnet.caip2, owner, caps, 1)
  assert.equal(again.ok, false)
  if (!again.ok) assert.equal(again.code, 'deploy_owner_served')
  assert.equal(b.snapshot(pubnet.caip2, caps, 1).used, 1, 'a refused deploy is not counted')
})

test('a deploy that was never submitted hands its count and its owner back; a rolled window credits nothing', () => {
  const caps = passkeyCaps(testnet)
  const b = createDeployBudget(1_000)
  const owner = contractId()
  assert.equal(b.charge(testnet.caip2, owner, caps, 1).ok, true)
  b.refund(testnet.caip2, owner, 2)
  assert.equal(b.snapshot(testnet.caip2, caps, 2).used, 0)
  assert.equal(b.charge(testnet.caip2, owner, caps, 3).ok, true, 'the same owner may try again after a deploy that cost nothing')
  // Refunding an owner that was never charged moves nothing.
  b.refund(testnet.caip2, contractId(), 4)
  assert.equal(b.snapshot(testnet.caip2, caps, 4).used, 1)
  // Past the window the day is fresh, and a late refund into it is dropped.
  b.refund(testnet.caip2, owner, 5_000)
  assert.equal(b.snapshot(testnet.caip2, caps, 5_000).used, 0)
  assert.equal(b.charge(testnet.caip2, owner, caps, 5_000).ok, true)
})

test('the two networks do not share a deploy count', () => {
  const b = createDeployBudget()
  const mainCaps = passkeyCaps(pubnet)
  const owner = contractId()
  for (let i = 0; i < mainCaps.deployDailyMax; i += 1) b.charge(pubnet.caip2, contractId(), mainCaps, 1)
  assert.equal(b.charge(pubnet.caip2, owner, mainCaps, 1).ok, false, 'pubnet is used up')
  assert.equal(b.charge(testnet.caip2, owner, passkeyCaps(testnet), 1).ok, true, 'testnet is untouched')
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

/** The kit's key data: the 65-byte point, then a credential id. Generated at runtime. */
const keyData = (): string => `04${randomBytes(64).toString('hex')}${randomBytes(20).toString('hex')}`
type DeployAccount = Extract<RelayFunc, { kind: 'create-contract-v2' }>['account']
const deployFunc = (
  wasmHash: string | null,
  createXdr = 'CREATE-1',
  account: DeployAccount = { signers: [{ kind: 'external', verifier: testnet.contracts.smartAccount!.webauthnVerifier, keyHex: keyData() }], policies: 0 },
): RelayFunc => ({
  kind: 'create-contract-v2',
  wasmHash,
  deployer: accountId(),
  createXdr,
  constructorArgs: 2,
  account,
})
const invokeFunc = (contract: string, method: string, argsXdr = 'ARGS-1', execute: { target: string; targetFn: string; targetArgs: unknown[] } | null = null): RelayFunc => ({
  kind: 'invoke',
  contract,
  method,
  args: [],
  argsXdr,
  execute,
  admin: null,
})
const addressAuth = (address: string, root: RelayAuth['root'], sub: RelayAuth['sub'] = []): RelayAuth => ({ credentials: 'address', address, root, sub })
const ok = (func: RelayFunc, auth: RelayAuth[], carrier: 'func-auth' | 'xdr' = 'func-auth'): RelayInspection => ({ ok: true, carrier, func, auth, envelope: null })
const VERIFIER = testnet.contracts.smartAccount!.webauthnVerifier
const pre = (i: RelayInspection) => relayPreflight(i, { smartAccountWasmHash: WASM, webauthnVerifier: VERIFIER })

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

test('REFUSAL: a smart-account deploy whose constructor installs anything but one passkey and no policy is not relayed', () => {
  // The constructor calls every External signer's verifier and every policy's install(),
  // with no authorization entry of their own, so these are contracts our relayer would pay
  // to run. Only the registry's WebAuthn verifier, once, with no policy, is accepted.
  const auth = (createXdr = 'CREATE-1') => [addressAuth(accountId(), { kind: 'create-contract-v2', wasmHash: WASM, createXdr })]
  const passkey = { kind: 'external' as const, verifier: VERIFIER, keyHex: keyData() }
  const ed25519 = testnet.contracts.smartAccount!.ed25519Verifier
  const cases: [DeployAccount, RegExp][] = [
    [null, /do not decode as the OpenZeppelin account's \(signers, policies\)/],
    [{ signers: [], policies: 0 }, /exactly one WebAuthn signer[^]*installs 0 signer/],
    [{ signers: [passkey, passkey], policies: 0 }, /installs 2 signer/],
    [{ signers: [{ kind: 'external', verifier: contractId(), keyHex: keyData() }], policies: 0 }, /External signer under C/],
    [{ signers: [{ kind: 'external', verifier: ed25519, keyHex: 'aa'.repeat(32) }], policies: 0 }, /External signer under/],
    [{ signers: [{ kind: 'delegated', address: accountId() }], policies: 0 }, /delegated account/],
    [{ signers: [{ kind: 'unknown' }], policies: 0 }, /kind this relay does not read/],
    [{ signers: [passkey], policies: 1 }, /1 polic\(ies\)/],
    [{ signers: [{ ...passkey, keyHex: `04${'ab'.repeat(64)}` }], policies: 0 }, /followed by a credential id/],
    [{ signers: [{ ...passkey, keyHex: `03${'ab'.repeat(84)}` }], policies: 0 }, /65-byte uncompressed P-256 point/],
  ]
  for (const [account, why] of cases) {
    const r = pre(ok(deployFunc(WASM, 'CREATE-1', account), auth()))
    assert.equal(r.ok, false, JSON.stringify(account))
    if (!r.ok) assert.match(r.reason, why)
  }
  // A chain that names no verifier relays no deploy rather than skipping the check.
  const noVerifier = relayPreflight(ok(deployFunc(WASM), auth()), { smartAccountWasmHash: WASM, webauthnVerifier: undefined })
  assert.equal(noVerifier.ok, false)
  if (!noVerifier.ok) assert.match(noVerifier.reason, /webauthnVerifier/)
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

/** The live read of a demo smart account: deployed, and running the registry's account wasm. */
const DEMO_CODE = { found: true, executable: 'wasm', wasmHash: WASM }
const decide = (
  p: RelayPreflightOk,
  vault: { owner: string; operator: string } | null,
  signer: string | null,
  accountCode: { found: boolean; executable: string | null; wasmHash: string | null } | null = DEMO_CODE,
  flagship: string[] = [],
) => relayDecision(p, { vault, signer, accountCode, expectedWasmHash: WASM, flagship })

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
  const r = decide(preOk({ rule: 'smart-account-deploy', vault: null, smartAccount: null, method: null }), null, null, null)
  assert.equal(r.ok, true)
})

test('REFUSAL: with no signer this server operates no vault, so it relays no owner call', () => {
  const r = decide(preOk(), { owner: contractId(), operator: accountId() }, null)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 503)
    assert.equal(r.code, 'no_operator')
  }
})

test('REFUSAL: a vault read that did not answer is a 502, never a pass', () => {
  const r = decide(preOk(), null, accountId())
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 502)
    assert.match(r.reason, /never skipped/)
  }
})

test('REFUSAL: a vault somebody else operates is not ours to pay for', () => {
  const signer = accountId()
  const r = decide(preOk(), { owner: contractId(), operator: accountId() }, signer)
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
  const r = decide(p, { owner: contractId(), operator: signer }, signer)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.status, 403)
    assert.equal(r.code, 'not_owner')
    assert.match(r.reason, /read live/)
  }
  const good = decide(p, { owner: smartAccount, operator: signer }, signer)
  assert.equal(good.ok, true)
})

test('REFUSAL: a direct owner call is refused when the live owner is an account rather than a smart account', () => {
  const signer = accountId()
  const owner = accountId()
  const p = preOk({ rule: 'owner-call', smartAccount: null, authAddresses: [owner] })
  const r = decide(p, { owner, operator: signer }, signer)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'owner_not_contract')
})

test('REFUSAL: an owner call signed by a contract that is not the owner is refused', () => {
  const signer = accountId()
  const owner = contractId()
  const p = preOk({ rule: 'owner-call', smartAccount: null, authAddresses: [contractId()] })
  const r = decide(p, { owner, operator: signer }, signer)
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
/** A P-256 point's SHAPE (0x04 and 64 bytes), generated at runtime; nothing here verifies it. */
const passkeyKey = (): string => `04${randomBytes(64).toString('hex')}`

// ── the deploy ───────────────────────────────────────────────────────────────────

test('a vault for a passkey account needs a CONTRACT owner, and an account owner is sent elsewhere', () => {
  const good = passkeyDeployPlan({ owner: contractId(), ownerPublicKey: passkeyKey(), dailyCapUsd: 5, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(good.ok, true)
  if (good.ok) {
    assert.equal(good.dailyCapRaw, '50000000')
    assert.equal(good.autoApproveMaxRaw, '10000000')
    // Unstated seed means the small default, never zero and never the maximum.
    assert.equal(good.seedUsd, PASSKEY_CAPS.seedUsdDefault)
  }
  const account = passkeyDeployPlan({ owner: accountId(), ownerPublicKey: passkeyKey(), dailyCapUsd: 5, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(account.ok, false)
  if (!account.ok) assert.match(account.reason, /smart account's contract id/)
})

test('the deploy caps are enforced here, because nothing else stands between them and the operator key', () => {
  const owner = contractId()
  const over = [
    { owner, ownerPublicKey: passkeyKey(), dailyCapUsd: PASSKEY_CAPS.dailyCapUsd + 0.01, autoApproveUsd: 1 },
    { owner, dailyCapUsd: 5, autoApproveUsd: PASSKEY_CAPS.autoApproveUsd + 0.01 },
    { owner, dailyCapUsd: 5, autoApproveUsd: 1, seedUsd: PASSKEY_CAPS.seedUsdMax + 0.01 },
  ]
  for (const body of over) assert.equal(passkeyDeployPlan(body, DECIMALS, PASSKEY_CAPS, NET).ok, false, JSON.stringify(body))
})

test('a zero cap is refused although the contract accepts it, because here zero means no cap', () => {
  const owner = contractId()
  assert.equal(passkeyDeployPlan({ owner, ownerPublicKey: passkeyKey(), dailyCapUsd: 0, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET).ok, false)
  assert.equal(passkeyDeployPlan({ owner, ownerPublicKey: passkeyKey(), dailyCapUsd: 5, autoApproveUsd: 0 }, DECIMALS, PASSKEY_CAPS, NET).ok, false)
  // A zero SEED is fine: it means the vault starts empty, which is a choice, not a policy.
  const noSeed = passkeyDeployPlan({ owner, ownerPublicKey: passkeyKey(), dailyCapUsd: 5, autoApproveUsd: 1, seedUsd: 0 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(noSeed.ok, true)
  if (noSeed.ok) assert.equal(noSeed.seedRaw, '0')
})

test('a cap that is not a finite number never reaches the constructor', () => {
  const owner = contractId()
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '5', null, undefined]) {
    assert.equal(passkeyDeployPlan({ owner, ownerPublicKey: passkeyKey(), dailyCapUsd: bad, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET).ok, false, String(bad))
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
    deployLimits: createDeployBudget().snapshot(testnet.caip2, passkeyCaps(testnet)),
    servedNetworks: ['stellar:pubnet', 'stellar:testnet'],
  })
  const text = JSON.stringify(view)
  assert.equal((view.relayer as Record<string, unknown>).keyVar, 'X402_STELLAR_TESTNET_OZ_KEY')
  assert.equal((view.relayer as Record<string, unknown>).keyConfigured, false)
  assert.equal((view.relayer as Record<string, unknown>).product, PASSKEY_RELEASE.relayerProduct)
  assert.equal(view.realMoney, false)
  // Served is a fact about the registry; whether each step executes is readiness, kept apart.
  assert.equal(view.served, true)
  assert.deepEqual(view.servedNetworks, ['stellar:pubnet', 'stellar:testnet'])
  assert.equal('pubnet' in view, false, 'the stale "pubnet not served" block is gone, because pubnet is served')
  const readiness = view.readiness as Record<string, unknown>
  assert.equal(readiness.relay, false)
  assert.equal(readiness.operator, false)
  assert.equal(readiness.allSteps, false)
  assert.match(String(readiness.note), /X402_STELLAR_TESTNET_OZ_KEY/)
  // The smart-account constants are published as third-party facts, with their provenance.
  const sa = view.smartAccount as Record<string, unknown>
  assert.equal(sa.wasmHash, WASM)
  assert.equal(sa.thirdParty, true)
  assert.match(String(sa.verified), /v0\.7\.2/, 'testnet runs our own build of the audited release line')
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
    deployLimits: createDeployBudget().snapshot(testnet.caip2, passkeyCaps(testnet)),
    servedNetworks: ['stellar:pubnet', 'stellar:testnet'],
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
    deployLimits: createDeployBudget().snapshot(testnet.caip2, passkeyCaps(testnet)),
    servedNetworks: ['stellar:pubnet', 'stellar:testnet'],
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

// ── SOW 2 D3: the network a request names, from its body or its query string ─────

test('the relay network may come from the query string, because the kit posts only { func, auth }', () => {
  const q = requestedNetwork(undefined, 'stellar:testnet', CHAINS)
  assert.deepEqual(q, { ok: true, network: 'stellar:testnet' })
  const b = requestedNetwork('stellar', null, CHAINS)
  assert.deepEqual(b, { ok: true, network: 'stellar' })
  // The same network named two ways is one network, not a conflict.
  assert.equal(requestedNetwork('stellar', 'stellar:pubnet', CHAINS).ok, true)
  // Neither: the gate's own default (testnet) applies downstream.
  assert.deepEqual(requestedNetwork(undefined, null, CHAINS), { ok: true, network: undefined })
})

test('REFUSAL: a body and a query string that name different networks are refused, never one preferred', () => {
  const r = requestedNetwork('stellar:pubnet', 'stellar:testnet', CHAINS)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, 'network_conflict')
    assert.equal(r.status, 400)
    assert.match(r.reason, /Nothing was decoded or forwarded/)
  }
})

// ── SOW 2 X.4: the recorded vaults are refused by id ────────────────────────────

test('the flagship and rehearsal vaults are named, per network, from the registry', () => {
  const t = flagshipVaults(testnet)
  assert.ok(t.includes(testnet.contracts.spendVault!), 'the flagship testnet vault must be refused by id')
  assert.ok(t.includes(testnet.contracts.passkeyVault!), 'the software-key rehearsal vault must be refused by id')
  assert.ok(flagshipVaults(pubnet).includes(pubnet.contracts.spendVault!))
})

test('the operator refuses every recorded vault, the SOW 2 evidence vaults included, while the relay still serves the D3 owner', () => {
  // Both slots are filled here with fresh ids, so the property holds whatever the registry
  // records: the day ops records a slot, agent-pay already refuses it by id.
  const d3 = contractId()
  const d2 = contractId()
  const filled = { ...testnet, contracts: { ...testnet.contracts, devicePasskeyVault: d3, walletOwnedVault: d2 } }
  const refused = operatorRefusedVaults(filled)
  for (const v of [d3, d2, testnet.contracts.spendVault!, testnet.contracts.passkeyVault!]) {
    assert.ok(refused.includes(v), `${v} must be refused to the operator key`)
  }
  const signer = accountId()
  const g = operatorGate(d3, { flagship: refused, signer, live: { owner: contractId(), operator: signer, allowlistEnabled: true }, ownerCode: DEMO_CODE, expectedWasmHash: WASM })
  assert.equal(g.ok, false)
  if (!g.ok) assert.equal(g.code, 'flagship_vault')
  // The relay's list is the narrower one: the D3 vault's owner calls go through it.
  assert.equal(flagshipVaults(filled).includes(d3), false, 'refusing the D3 vault in the relay would stop its own owner')
  // As recorded today: the D2 slot is filled (2026-10-03) and the D3 slot too (2026-10-04),
  // so the operator list is the relay's list plus both evidence vaults, and the relay's list
  // still leaves the D3 vault to its owner.
  assert.deepEqual(operatorRefusedVaults(testnet), [...flagshipVaults(testnet), testnet.contracts.walletOwnedVault!, testnet.contracts.devicePasskeyVault!])
  assert.equal(flagshipVaults(testnet).includes(testnet.contracts.devicePasskeyVault!), false)
})

// ── SOW 2 D3.8: a smart account adding a device to itself ───────────────────────

type Admin = Extract<RelayFunc, { kind: 'invoke' }>['admin']
const passkeySigner = (verifier = VERIFIER) => ({ kind: 'external' as const, verifier, keyHex: `04${'ab'.repeat(64)}${'cd'.repeat(16)}` })
const adminFunc = (account: string, admin: Admin, method = admin?.method ?? 'add_context_rule'): RelayFunc => ({
  kind: 'invoke',
  contract: account,
  method,
  args: [],
  argsXdr: 'ADMIN-1',
  execute: null,
  admin,
})
const newRule = (over: Partial<Extract<NonNullable<Admin>, { method: 'add_context_rule' }>> = {}): Admin => ({
  method: 'add_context_rule',
  contextType: 'default',
  name: 'device 2',
  validUntil: null,
  signers: [passkeySigner()],
  policies: 0,
  ...over,
})
const selfAuth = (account: string, method = 'add_context_rule') => addressAuth(account, { kind: 'contract-fn', contract: account, method, argsXdr: 'ADMIN-1' })

test('a smart account adding a Default rule with one passkey to ITSELF is relayed', () => {
  const account = contractId()
  const r = pre(ok(adminFunc(account, newRule()), [selfAuth(account)]))
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.rule, 'smart-account-admin')
    assert.equal(r.smartAccount, account)
    assert.equal(r.vault, null)
    assert.equal(r.method, 'add_context_rule')
  }
})

test('REFUSAL: a new rule that is not exactly one WebAuthn signer, Default, with no policy, is not relayed', () => {
  const account = contractId()
  const cases: [Admin, RegExp][] = [
    [newRule({ contextType: 'call-contract' }), /call-contract context is not relayed/],
    [newRule({ signers: [passkeySigner(), passkeySigner()] }), /exactly one WebAuthn signer/],
    [newRule({ signers: [{ kind: 'delegated', address: accountId() }] }), /delegated/],
    [newRule({ signers: [passkeySigner(contractId())] }), /exactly one WebAuthn signer/],
    [newRule({ signers: [] }), /0 signer/],
    [newRule({ policies: 1 }), /with a policy is not relayed/],
  ]
  for (const [admin, why] of cases) {
    const r = pre(ok(adminFunc(account, admin), [selfAuth(account)]))
    assert.equal(r.ok, false, JSON.stringify(admin))
    if (!r.ok) assert.match(r.reason, why)
  }
  // Arguments that did not decode into the account's own types are never guessed at.
  const raw = pre(ok(adminFunc(account, null, 'add_context_rule'), [selfAuth(account)]))
  assert.equal(raw.ok, false)
  if (!raw.ok) assert.match(raw.reason, /argument types/)
})

test('REFUSAL: add_signer on rule 0 would make every action need both devices, so it is not relayed', () => {
  const account = contractId()
  const zero = pre(ok(adminFunc(account, { method: 'add_signer', contextRuleId: 0, signer: passkeySigner() }), [selfAuth(account, 'add_signer')]))
  assert.equal(zero.ok, false)
  if (!zero.ok) assert.match(zero.reason, /2-of-2/)
  const other = pre(ok(adminFunc(account, { method: 'add_signer', contextRuleId: 1, signer: passkeySigner() }), [selfAuth(account, 'add_signer')]))
  assert.equal(other.ok, true)
  const ed = pre(ok(adminFunc(account, { method: 'add_signer', contextRuleId: 1, signer: passkeySigner(contractId()) }), [selfAuth(account, 'add_signer')]))
  assert.equal(ed.ok, false, 'a signer under any other verifier (an Ed25519 key) is not a passkey')
})

test('REFUSAL: only the account itself may authorize a change to its own signers, with no sub-call', () => {
  const account = contractId()
  const stranger = pre(ok(adminFunc(account, newRule()), [addressAuth(contractId(), { kind: 'contract-fn', contract: account, method: 'add_context_rule', argsXdr: 'ADMIN-1' })]))
  assert.equal(stranger.ok, false)
  if (!stranger.ok) assert.match(stranger.reason, /authorizing a change to itself/)
  const otherArgs = pre(ok(adminFunc(account, newRule()), [addressAuth(account, { kind: 'contract-fn', contract: account, method: 'add_context_rule', argsXdr: 'ADMIN-2' })]))
  assert.equal(otherArgs.ok, false, 'an entry for different arguments is authority for a different rule')
  const sub = pre(
    ok(adminFunc(account, newRule()), [
      addressAuth(account, { kind: 'contract-fn', contract: account, method: 'add_context_rule', argsXdr: 'ADMIN-1' }, [
        { kind: 'contract-fn', contract: contractId(), method: 'transfer', argsXdr: 'X' },
      ]),
    ]),
  )
  assert.equal(sub.ok, false)
})

test('the admin rule is decided on the account\'s live CODE: the registry wasm passes, anything else is refused', () => {
  const account = contractId()
  const p = preOk({ rule: 'smart-account-admin', vault: null, smartAccount: account, method: 'add_context_rule' })
  assert.equal(decide(p, null, null).ok, true, 'adding a device needs no vault and no operator key')
  const other = decide(p, null, null, { found: true, executable: 'wasm', wasmHash: 'ee'.repeat(32) })
  assert.equal(other.ok, false)
  if (!other.ok) assert.equal(other.code, 'smart_account_code_mismatch')
  const none = decide(p, null, null, { found: false, executable: null, wasmHash: null })
  assert.equal(none.ok, false)
  if (!none.ok) assert.equal(none.code, 'not_smart_account')
  const unread = decide(p, null, null, null)
  assert.equal(unread.ok, false)
  if (!unread.ok) assert.equal(unread.status, 502, 'an unread code is a reason to stop, never a pass')
})

test('REFUSAL: an owner call on a vault whose owner is not a demo smart account is not relayed, whoever operates it', () => {
  const signer = accountId()
  const smartAccount = contractId()
  const p = preOk({ smartAccount })
  const live = { owner: smartAccount, operator: signer }
  assert.equal(decide(p, live, signer).ok, true)
  const wrongCode = decide(p, live, signer, { found: true, executable: 'wasm', wasmHash: 'ee'.repeat(32) })
  assert.equal(wrongCode.ok, false)
  if (!wrongCode.ok) {
    assert.equal(wrongCode.code, 'smart_account_code_mismatch')
    assert.match(wrongCode.reason, /not a demo vault/)
  }
  const flagship = decide(preOk({ smartAccount, vault: testnet.contracts.spendVault! }), live, signer, DEMO_CODE, flagshipVaults(testnet))
  assert.equal(flagship.ok, false)
  if (!flagship.ok) assert.equal(flagship.code, 'flagship_vault')
})

// ── SOW 2 X.4: the operator key acts only on demo vaults ────────────────────────

test('X.4: the operator key pays only from a vault owned by a smart account running the registry wasm', () => {
  const signer = accountId()
  const owner = contractId()
  const vault = contractId()
  const g = operatorGate(vault, { flagship: [], signer, live: { owner, operator: signer, allowlistEnabled: true }, ownerCode: DEMO_CODE, expectedWasmHash: WASM })
  assert.equal(g.ok, true)
  if (g.ok) assert.equal(g.owner, owner)
})

test('X.4 REFUSAL: a vault the same key operates but a G... account owns is not paid from (the flagship vault shape)', () => {
  // This is the exact shape of the flagship testnet vault: our signer operates it and a
  // person's account owns it. The first version of agent-pay would have paid from it.
  const signer = accountId()
  const vault = contractId()
  const g = operatorGate(vault, { flagship: [], signer, live: { owner: accountId(), operator: signer, allowlistEnabled: true }, ownerCode: null, expectedWasmHash: WASM })
  assert.equal(g.ok, false)
  if (!g.ok) {
    assert.equal(g.code, 'owner_not_contract')
    assert.equal(g.status, 403)
  }
})

test('X.4 REFUSAL: a demo vault whose allowlist is off, or unread, is not paid from, because the payee would be the caller\'s choice', () => {
  // The constructor starts the allowlist OFF and this server seeds the vault before the
  // owner's passkey has signed anything, so this is the state every fresh vault is in.
  const signer = accountId()
  const owner = contractId()
  const vault = contractId()
  for (const allowlistEnabled of [false, undefined as unknown as boolean, 'true' as unknown as boolean]) {
    const g = operatorGate(vault, { flagship: [], signer, live: { owner, operator: signer, allowlistEnabled }, ownerCode: DEMO_CODE, expectedWasmHash: WASM })
    assert.equal(g.ok, false, String(allowlistEnabled))
    if (!g.ok) {
      assert.equal(g.code, 'allowlist_off')
      assert.equal(g.status, 403)
      assert.match(g.reason, /set_policy/)
      assert.match(g.reason, /Nothing was submitted/)
    }
  }
})

test('X.4 REFUSAL: a recorded vault is refused by id before any other check', () => {
  const signer = accountId()
  for (const vault of flagshipVaults(testnet)) {
    const g = operatorGate(vault, { flagship: flagshipVaults(testnet), signer, live: { owner: contractId(), operator: signer, allowlistEnabled: true }, ownerCode: DEMO_CODE, expectedWasmHash: WASM })
    assert.equal(g.ok, false)
    if (!g.ok) assert.equal(g.code, 'flagship_vault')
  }
})

test('X.4 REFUSAL: a contract owner running other code, an unread owner, another operator and no signer are each refused', () => {
  const signer = accountId()
  const vault = contractId()
  const owner = contractId()
  const base = { flagship: [], signer, live: { owner, operator: signer, allowlistEnabled: true }, ownerCode: DEMO_CODE, expectedWasmHash: WASM }
  const cases: [Parameters<typeof operatorGate>[1], string, number][] = [
    [{ ...base, ownerCode: { found: true, executable: 'wasm', wasmHash: 'ee'.repeat(32) } }, 'smart_account_code_mismatch', 403],
    [{ ...base, ownerCode: { found: true, executable: 'stellar-asset', wasmHash: null } }, 'not_smart_account', 403],
    [{ ...base, ownerCode: null }, 'rpc_error', 502],
    [{ ...base, live: { owner, operator: accountId(), allowlistEnabled: true } }, 'not_operator', 403],
    [{ ...base, live: null }, 'rpc_error', 502],
    [{ ...base, signer: null }, 'no_operator', 503],
  ]
  for (const [input, code, status] of cases) {
    const g = operatorGate(vault, input)
    assert.equal(g.ok, false, code)
    if (!g.ok) {
      assert.equal(g.code, code)
      assert.equal(g.status, status)
    }
  }
})

test('the code verdict needs the registry to name an account wasm at all', () => {
  const v = smartAccountCodeVerdict(contractId(), DEMO_CODE, undefined)
  assert.equal(v.ok, false)
  if (!v.ok) assert.equal(v.code, 'network_not_served')
  assert.equal(smartAccountCodeVerdict(contractId(), { ...DEMO_CODE, wasmHash: WASM.toUpperCase() }, WASM).ok, true, 'hex case is not identity')
})

// ── SOW 2 D3.3: the deploy's owner is one passkey, read live ────────────────────

const KEY = `04${'11'.repeat(64)}`
const CREDENTIAL_SUFFIX = '22'.repeat(20)
const oneRule = (signers = [{ kind: 'external' as const, verifier: VERIFIER, keyHex: KEY + CREDENTIAL_SUFFIX }], over: Record<string, unknown> = {}) => ({
  count: 1,
  rules: [{ id: 0, contextType: 'default', signers, policies: [] as string[], validUntil: null as number | null, ...over }],
})
const checkOwner = (over: Partial<Parameters<typeof ownerAccountCheck>[0]> = {}) =>
  ownerAccountCheck({
    owner: contractId(),
    publicKeyHex: KEY,
    code: DEMO_CODE,
    rules: oneRule(),
    expected: { wasmHash: WASM, webauthnVerifier: VERIFIER },
    ...over,
  })

test('D3.3: a vault is deployed for an account whose only signer is the passkey the browser named', () => {
  const r = checkOwner()
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.ruleId, 0)
    assert.equal(r.verifier, VERIFIER)
  }
})

test('D3.3 REFUSAL: the owner must run the registry account wasm, and must exist', () => {
  const wrong = checkOwner({ code: { found: true, executable: 'wasm', wasmHash: 'ee'.repeat(32) } })
  assert.equal(wrong.ok, false)
  if (!wrong.ok) assert.equal(wrong.code, 'smart_account_code_mismatch')
  const none = checkOwner({ code: { found: false, executable: null, wasmHash: null } })
  assert.equal(none.ok, false)
  if (!none.ok) assert.equal(none.code, 'not_smart_account')
  const unread = checkOwner({ rules: null })
  assert.equal(unread.ok, false)
  if (!unread.ok) assert.equal(unread.status, 502)
})

test('D3.3 REFUSAL: a second rule, a policy, an expiry, a second signer, a delegated or Ed25519 signer, or another key', () => {
  const ed25519 = testnet.contracts.smartAccount!.ed25519Verifier
  const two = { count: 2, rules: [...oneRule().rules, { ...oneRule().rules[0], id: 1 }] }
  const cases: [Parameters<typeof ownerAccountCheck>[0]['rules'] | null, string, string?][] = [
    [two, 'owner_rules_unexpected'],
    [oneRule(undefined, { policies: [contractId()] }), 'owner_rules_unexpected'],
    [oneRule(undefined, { validUntil: 99 }), 'owner_rules_unexpected'],
    [oneRule(undefined, { contextType: 'call-contract' }), 'owner_rules_unexpected'],
    [oneRule([oneRule().rules[0].signers[0], oneRule().rules[0].signers[0]]), 'owner_signer_unexpected'],
    [oneRule([{ kind: 'delegated', address: accountId() }] as never), 'owner_signer_unexpected', 'delegated'],
    [oneRule([{ kind: 'external', verifier: ed25519, keyHex: 'aa'.repeat(32) }]), 'owner_signer_unexpected'],
  ]
  for (const [rules, code, words] of cases) {
    const r = checkOwner({ rules: rules as never })
    assert.equal(r.ok, false, code)
    if (!r.ok) {
      assert.equal(r.code, code)
      if (words) assert.match(r.reason, new RegExp(words))
    }
  }
  const otherKey = checkOwner({ publicKeyHex: `04${'33'.repeat(64)}` })
  assert.equal(otherKey.ok, false)
  if (!otherKey.ok) assert.equal(otherKey.code, 'owner_key_mismatch')
})

test('a passkey public key is the 65-byte uncompressed point, in hex or base64, and nothing else', () => {
  const hex = `04${'5a'.repeat(64)}`
  assert.equal(parsePasskeyPublicKey(hex), hex)
  assert.equal(parsePasskeyPublicKey(`0x${hex.toUpperCase()}`), hex)
  const b64url = Buffer.from(hex, 'hex').toString('base64url')
  assert.equal(parsePasskeyPublicKey(b64url), hex)
  assert.equal(parsePasskeyPublicKey(Buffer.from(hex, 'hex').toString('base64')), hex)
  for (const bad of [`03${'5a'.repeat(64)}`, `04${'5a'.repeat(32)}`, '', 'xyz', 42, null]) {
    assert.equal(parsePasskeyPublicKey(bad), null, String(bad))
  }
  const plan = passkeyDeployPlan({ owner: contractId(), dailyCapUsd: 5, autoApproveUsd: 1 }, DECIMALS, PASSKEY_CAPS, NET)
  assert.equal(plan.ok, false, 'the deploy names the passkey it is for, or it is not planned')
  if (!plan.ok) assert.match(plan.reason, /ownerPublicKey/)
})

// ── SOW 2 D3: status, per network ───────────────────────────────────────────────

test('status names per network the caps the page sizes its defaults from, and who can pay and operate', () => {
  const operator = accountId()
  const view = passkeyStatusView(pubnet, {
    keyVar: 'X402_STELLAR_PUBNET_OZ_KEY',
    keyConfigured: true,
    relayerUrl: 'https://relayer.example/mainnet/',
    operator,
    explorerFor: (a) => `https://example/contract/${a}`,
    relayLimits: createRelayBudget().snapshot(),
    seedLimits: createSeedBudget().snapshot(pubnet.caip2, passkeyCaps(pubnet)),
    deployLimits: createDeployBudget().snapshot(pubnet.caip2, passkeyCaps(pubnet)),
    servedNetworks: ['stellar:pubnet', 'stellar:testnet'],
  })
  assert.equal(view.realMoney, true)
  assert.equal(view.served, true)
  const caps = view.caps as Record<string, number>
  const m = passkeyCaps(pubnet)
  assert.equal(caps.seedUsdMax, m.seedUsdMax)
  assert.equal(caps.dailyCapMaxUsd, m.dailyCapUsd)
  assert.equal(caps.perPaymentMaxUsd, m.autoApproveUsd)
  assert.equal(caps.sharedDailyCeilingUsd, m.seedDailyTotalUsd)
  const relayer = view.relayer as Record<string, unknown>
  assert.equal(relayer.configured, true)
  assert.equal(relayer.feePayerAccount, null, 'the relayer pays per transaction; the account is read per hash, never filled in')
  const op = view.operator as Record<string, unknown>
  assert.equal(op.configured, true)
  assert.equal(op.address, operator)
  assert.equal((view.readiness as Record<string, unknown>).allSteps, true)
  const sa = view.smartAccount as Record<string, unknown>
  assert.equal(sa.wasmHash, pubnet.contracts.smartAccount!.wasmHash)
  assert.equal(sa.webauthnVerifier, pubnet.contracts.smartAccount!.webauthnVerifier)
  assert.equal(sa.ed25519Verifier, pubnet.contracts.smartAccount!.ed25519Verifier)
  assert.equal((view.vault as Record<string, unknown>).wasmHash, pubnet.contracts.spendVaultWasmHash)
  assert.deepEqual((view.vault as Record<string, unknown>).operatorRefused, operatorRefusedVaults(pubnet))
  // The deploy count is published beside the seed budget, and the operator's role says the
  // allowlist must be on before it pays, rather than claiming it already is.
  const deploys = view.deployBudget as Record<string, unknown>
  assert.equal(deploys.max, m.deployDailyMax)
  assert.equal(deploys.left, m.deployDailyMax)
  assert.match(String(op.role), /starts with its allowlist off/)
  assert.match(String(op.role), /fee payer of every vault deployed here/)
})

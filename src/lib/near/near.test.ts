/**
 * The NEAR console's pure helpers, run as they ship: `npm test` at the repository root loads
 * these files through Node's TypeScript type stripping (unflagged since Node 22.18), which is
 * why every file under src/lib/near imports its siblings with a .ts extension and nothing that
 * needs the bundler.
 *
 * The shapes in the fixtures are the contracts' own (near/contracts/agent-spend-policy types.rs
 * and event.rs, near/contracts/a-identity-registry types.rs) and the RPC replies are the ones
 * NEAR testnet's hosts gave on 2026-11-12, copied from live reads.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatGrouped, formatNear, formatUnits, isU128, parseUnits, tgas, U128_MAX } from './units.ts'
import { isNearAccountId, isNearTxHash, shortKey } from './ids.ts'
import { classifyViewError, decodeResult, encodeArgs, judgeReply, nearRpc, NearUnreachable, parseAccessKeys, parseAccountView, viewCall, txStatus } from './rpc.ts'
import { eventsOf, heldReason, isAgentMethodList, parseAgents, parseHeld, parseVaultConfig, parseVerdict, payOutcomeOf, tokenTransfersOf, txVerdict, vaultEventsOf } from './abi.ts'
import { dayResetsAtS, keyExpired, keyRows, ownerPayNote, predictAgentPay, registryDown, vaultHeadline } from './model.ts'
import { prepareFreeze, prepareFund, prepareOwnerPay, prepareOwnerReject, prepareSetAllowed, prepareSetHoldUnknown, prepareSetPolicy, prepareUnfreeze, prepareWithdraw, totalDeposit, totalTgas } from './calls.ts'
import { describeEvent } from './events.ts'
import { loadKnownTxs, rememberTx } from './txlog.ts'
import { NEAR_CHAIN, NEAR_RPC_URLS, REGISTRY_USDC, REGISTRY_VAULT, nearAccountUrl, nearTxUrl } from './chain.ts'
import { ALLOWLIST_READ_LIMIT, payeesInView, readNearVault } from './read.ts'

const VAULT = 'vault.aid-demo-owner.testnet'
const OWNER = 'aid-demo-owner.testnet'
const REGISTRY = 'registry.a-identity.testnet'
const USDC = REGISTRY_USDC?.address ?? 'usdc.example.testnet'
const AGENT_PK = 'ed25519:8M2Ppf2etZtcYEXHAztXwW9nyagyZ8N6sLSUZRERTxdL'

// -- amounts -------------------------------------------------------------------------------

test('amounts parse exactly and refuse what they cannot hold', () => {
  assert.deepEqual(parseUnits('1.25', 6), { ok: true, units: 1_250_000n })
  assert.deepEqual(parseUnits(' 3 ', 6), { ok: true, units: 3_000_000n })
  assert.deepEqual(parseUnits('.5', 6), { ok: true, units: 500_000n })
  assert.deepEqual(parseUnits('0.000001', 6), { ok: true, units: 1n })
  // Truncating would turn a payment into nothing: refused instead.
  assert.equal(parseUnits('0.0000005', 6).ok, false)
  assert.equal(parseUnits('1,25', 6).ok, false)
  assert.equal(parseUnits('-1', 6).ok, false)
  assert.equal(parseUnits('1e3', 6).ok, false)
  assert.equal(parseUnits('', 6).ok, false)
  assert.equal(parseUnits('.', 6).ok, false)
  assert.equal(parseUnits((U128_MAX + 1n).toString(), 0).ok, false)
})

test('amounts format exactly, with no float anywhere', () => {
  assert.equal(formatUnits(1_250_000n, 6), '1.25')
  assert.equal(formatUnits('18000000', 6), '18')
  assert.equal(formatUnits(1n, 6), '0.000001')
  assert.equal(formatGrouped(1_234_567_500_000n, 6), '1,234,567.5')
  assert.equal(formatNear('1250000000000000000000'), '0.0012')
  assert.equal(formatNear(1n), 'less than 0.0001')
  assert.equal(formatNear(0n), '0')
  assert.equal(tgas(30), '30000000000000')
  assert.throws(() => tgas(0))
  assert.ok(isU128('0') && isU128('340282366920938463463374607431768211455'))
  assert.ok(!isU128('01') && !isU128('-1') && !isU128(5) && !isU128('340282366920938463463374607431768211456'))
})

// -- ids -----------------------------------------------------------------------------------

test('NEAR account ids and transaction hashes are recognized by shape', () => {
  for (const ok of [VAULT, OWNER, 'a-identity.testnet', USDC, 'ab']) assert.ok(isNearAccountId(ok), ok)
  for (const bad of ['A.testnet', 'a..testnet', '.a', 'a.', 'a', 'x'.repeat(65), 'not valid', 'a_.b']) assert.ok(!isNearAccountId(bad), bad)
  assert.ok(isNearTxHash('9qRji3NtLtJqB9aEyboDYXUzF9V3SXpdDT9f8uQLFo6w'))
  assert.ok(!isNearTxHash('9qRji3NtLtJqB9aEyboDYXUzF9V3SXpdDT9f8uQLFo6'.replace('9', '0')))
  assert.ok(!isNearTxHash('z'.repeat(44)), 'a 44-character string that decodes to more than 32 bytes')
  assert.equal(shortKey(AGENT_PK), 'ed25519:8M2Ppf...ERTxdL')
  assert.equal(shortKey('ed25519:short'), 'ed25519:short')
})

// -- the RPC reader -------------------------------------------------------------------------

test('a reply is judged by what it says about the chain, whatever the HTTP status', () => {
  const unknown = {
    jsonrpc: '2.0',
    error: { name: 'HANDLER_ERROR', cause: { info: { block_height: 277301738, requested_account_id: VAULT }, name: 'UNKNOWN_ACCOUNT' }, code: -32000, message: 'Server error', data: `account ${VAULT} does not exist while viewing` },
    id: 'x',
  }
  assert.deepEqual(judgeReply(200, unknown), { kind: 'decided', cause: 'UNKNOWN_ACCOUNT', message: `account ${VAULT} does not exist while viewing`, blockHeight: 277301738 })
  // FastNEAR sends PARSE_ERROR as a 400, drpc as a 200: both are the chain's answer.
  const parse = { jsonrpc: '2.0', error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR', info: {} }, code: -32700, message: 'Parse error', data: 'Failed parsing args' }, id: 'p' }
  assert.equal(judgeReply(400, parse).kind, 'decided')
  assert.equal(judgeReply(200, parse).kind, 'decided')
  // The host failing is never an answer about the chain.
  assert.equal(judgeReply(408, { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } }).kind, 'failed')
  assert.equal(judgeReply(500, { error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR' } } }).kind, 'failed')
  assert.equal(judgeReply(502, undefined).kind, 'failed')
  assert.equal(judgeReply(200, undefined).kind, 'failed')
  assert.equal(judgeReply(200, { jsonrpc: '2.0', id: 'x' }).kind, 'failed')
  assert.deepEqual(judgeReply(200, { jsonrpc: '2.0', result: { ok: 1 } }), { kind: 'ok', result: { ok: 1 } })
})

test('a failed view is sorted by the chain own words', () => {
  assert.equal(classifyViewError('wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "aid-demo-owner.testnet" })'), 'no-code')
  assert.equal(classifyViewError('wasm execution failed with error: MethodResolveError(MethodNotFound)'), 'no-method')
  assert.equal(classifyViewError('UNKNOWN_ACCOUNT: account x does not exist while viewing'), 'no-account')
  assert.equal(classifyViewError('wasm execution failed with error: HostError(GuestPanic { panic_msg: "panicked at ..." })'), 'panic')
  assert.equal(classifyViewError('something new'), 'other')
})

/** A fetch stub answering per host, in order. */
function stubFetch(byHost: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const host = new URL(String(url)).host
    const answer = byHost[host]
    if (!answer) throw new TypeError('Failed to fetch')
    return answer()
  }) as typeof fetch
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const HOSTS = ['https://one.example', 'https://two.example', 'https://three.example']

test('a read fails over only when a host could not answer, and stops at the first answer', async () => {
  const decided = await nearRpc(HOSTS, 'query', {}, {
    fetchImpl: stubFetch({
      'two.example': () => json(200, { error: { cause: { name: 'UNKNOWN_ACCOUNT', info: { block_height: 5 } }, data: 'gone' } }),
      'three.example': () => json(200, { result: 'never asked' }),
    }),
  })
  assert.deepEqual(decided, { kind: 'decided', cause: 'UNKNOWN_ACCOUNT', message: 'gone', blockHeight: 5, host: 'two.example' })

  await assert.rejects(
    nearRpc(HOSTS, 'query', {}, { fetchImpl: stubFetch({ 'one.example': () => json(503, {}), 'two.example': () => new Response('<html>', { status: 200 }) }) }),
    (e: unknown) => e instanceof NearUnreachable && e.tried.length === 3 && e.tried[0].host === 'one.example',
  )
})

test('a view decodes its result bytes and reports a missing contract as such', async () => {
  const bytes = [...new TextEncoder().encode('"18000000"')]
  assert.equal(decodeResult(bytes), '18000000')
  assert.equal(decodeResult([]), null)
  assert.throws(() => decodeResult('nope'))
  assert.equal(atob(encodeArgs({ account_id: OWNER })), `{"account_id":"${OWNER}"}`)

  const ok = await viewCall(HOSTS, USDC, 'ft_balance_of', { account_id: OWNER }, {
    fetchImpl: stubFetch({ 'one.example': () => json(200, { result: { block_height: 277301765, logs: [], result: bytes } }) }),
  })
  assert.deepEqual(ok, { ok: true, value: '18000000', blockHeight: 277301765, host: 'one.example' })

  const noCode = await viewCall(HOSTS, OWNER, 'get_config', {}, {
    fetchImpl: stubFetch({
      'one.example': () => json(200, { result: { block_height: 9, error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist { account_id: "x" })', logs: [] } }),
    }),
  })
  assert.equal(noCode.ok, false)
  assert.equal(!noCode.ok && noCode.why, 'no-code')
})

test('an account and its keys are read field by field, and an empty key list proves nothing alone', () => {
  const owner = parseAccountView({ amount: '9998250943885478099999999', block_height: 277301765, code_hash: '11111111111111111111111111111111', locked: '0', storage_usage: 182 })
  assert.equal(owner?.hasContract, false, 'the empty code hash is an account without a contract')
  assert.equal(parseAccountView({ amount: 'x', code_hash: 'y' }), null)

  const keys = parseAccessKeys({
    block_height: 10,
    keys: [
      { public_key: 'ed25519:full', access_key: { nonce: 1, permission: 'FullAccess' } },
      { public_key: AGENT_PK, access_key: { nonce: 2, permission: { FunctionCall: { allowance: '250000000000000000000000', receiver_id: VAULT, method_names: ['pay', 'request_payment', 'record_refusal'] } } } },
    ],
  })
  assert.equal(keys?.keys.length, 2)
  assert.deepEqual(keys?.keys[0].permission, { kind: 'full' })
  assert.deepEqual(keys?.keys[1].permission, { kind: 'call', receiverId: VAULT, methodNames: ['pay', 'request_payment', 'record_refusal'], allowanceYocto: 250_000_000_000_000_000_000_000n })
  // NEAR answers keys: [] for an account that does not exist: the reader must ask view_account first.
  assert.deepEqual(parseAccessKeys({ block_height: 1, keys: [] })?.keys, [])
  assert.equal(parseAccessKeys({ keys: [{ public_key: 'x', access_key: { permission: { Weird: {} } } }] }), null)
})

test('a missing vault reads as not deployed, live, with the block that said so', async () => {
  const r = await readNearVault(HOSTS, VAULT, null, {
    fetchImpl: stubFetch({
      'one.example': () => json(200, { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { block_height: 277301738 } }, data: 'does not exist while viewing' } }),
    }),
  })
  assert.equal(r.state, 'missing')
  assert.equal(r.state === 'missing' && r.blockHeight, 277301738)
})

test('a transaction nobody has seen is unknown, one a host has not finished is pending', async () => {
  const unknownTx = { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} }, data: 'does not exist' } }
  assert.deepEqual(
    await txStatus(HOSTS, 'h', VAULT, { fetchImpl: stubFetch({ 'one.example': () => json(200, unknownTx), 'two.example': () => json(200, unknownTx), 'three.example': () => json(200, unknownTx) }) }),
    { state: 'unknown' },
  )
  // A pruned node forgets; the archival host listed last may still know it.
  const final = await txStatus(HOSTS, 'h', VAULT, {
    fetchImpl: stubFetch({ 'one.example': () => json(200, unknownTx), 'three.example': () => json(200, { result: { final_execution_status: 'FINAL', status: { SuccessValue: '' } } }) }),
  })
  assert.equal(final.state, 'final')
  const pending = await txStatus(HOSTS, 'h', VAULT, { fetchImpl: stubFetch({ 'one.example': () => json(200, { result: { final_execution_status: 'EXECUTED_OPTIMISTIC' } }), 'two.example': () => json(200, unknownTx), 'three.example': () => json(200, unknownTx) }) })
  assert.deepEqual(pending, { state: 'pending', finality: 'EXECUTED_OPTIMISTIC', host: 'one.example' })
  await assert.rejects(txStatus(HOSTS, 'h', VAULT, { fetchImpl: stubFetch({}) }), NearUnreachable)
})

// -- the contracts' JSON --------------------------------------------------------------------

const CONFIG = {
  owner_id: OWNER,
  token_id: USDC,
  registry_id: 'registry.a-identity.testnet',
  frozen: false,
  daily_cap: '5000000',
  auto_approve_max: '1000000',
  allowlist_enabled: false,
  token_storage_deposit: '1250000000000000000000',
  version: 'agent-spend-policy 0.1.0',
  hold_unknown: true,
}

test('get_config is read only when it is the vault shape', () => {
  const c = parseVaultConfig(CONFIG)
  assert.equal(c?.dailyCap, 5_000_000n)
  assert.equal(c?.holdUnknown, true)
  assert.equal(parseVaultConfig({ ...CONFIG, hold_unknown: undefined })?.holdUnknown, null, 'a build from before amendment A1 reports no flag')
  assert.equal(parseVaultConfig({ ...CONFIG, registry_id: null })?.registryId, null)
  assert.equal(parseVaultConfig({ ...CONFIG, daily_cap: 5 }), null, 'a JSON number is not a U128 string')
  assert.equal(parseVaultConfig({ ...CONFIG, owner_id: 'Not An Account' }), null)
  assert.equal(parseVaultConfig({ ...CONFIG, frozen: 'no' }), null)
  assert.equal(parseVaultConfig(null), null)
})

test('agents and held payments are read field by field', () => {
  const agents = parseAgents([{ public_key: AGENT_PK, label: 'demo agent', expires_at_s: '1763000000', revoked: false, added_at_s: '1762900000' }])
  assert.equal(agents?.[0].expiresAtS, 1_763_000_000n)
  assert.equal(parseAgents([{ public_key: AGENT_PK, label: 'x', expires_at_s: 1, revoked: false, added_at_s: '1' }]), null)
  const held = parseHeld([
    { id: '3', payment_id: '9', agent_pk: AGENT_PK, payee: 'aid-demo-merchant.testnet', amount: '250000', memo: null, reason: 'UnknownPayee', created_at_s: '100', expires_at_s: '86500' },
  ])
  assert.equal(held?.[0].amount, 250_000n)
  assert.equal(held?.[0].memo, null)
  assert.equal(parseHeld([{ id: '3' }]), null)
  assert.equal(heldReason('RegistryWarn').kind, 'warn')
  assert.equal(heldReason('UnknownPayee').kind, 'unknown')
  assert.equal(heldReason('needs a human').kind, 'agent')
})

test('a registry verdict is read the way the vault reads it: three exact words or nothing', () => {
  assert.deepEqual(parseVerdict(null), { ok: true, verdict: null })
  const deny = parseVerdict({ account_id: 'x.testnet', verdict: 'DENY', reasons: ['drainer'], evidence: null, score: 120, code_hash: null, updated_at_ns: '1', updated_by: 'oracle.a-identity.testnet', expires_at_ns: null })
  assert.ok(deny.ok && deny.verdict?.verdict === 'DENY' && deny.verdict.reasons[0] === 'drainer')
  // Lower case or anything else is unreadable, which the vault refuses as RegistryUnavailable.
  assert.deepEqual(parseVerdict({ verdict: 'deny' }), { ok: false })
  assert.deepEqual(parseVerdict({ verdict: 'NONE' }), { ok: false })
  assert.deepEqual(parseVerdict({}), { ok: false })
  // A malformed decoration loses the decoration, never the verdict.
  const lenient = parseVerdict({ verdict: 'WARN', reasons: 'not-a-list', updated_at_ns: 5 })
  assert.ok(lenient.ok && lenient.verdict?.verdict === 'WARN' && lenient.verdict.reasons.length === 0)
})

/** A FINAL outcome the way the RPC returns it, with the vault's and the token's logs. */
function outcome(opts: { status?: unknown; receiptStatus?: unknown; vaultLogs?: string[]; tokenLogs?: string[]; otherLogs?: string[] } = {}) {
  return {
    final_execution_status: 'FINAL',
    status: opts.status ?? { SuccessValue: btoa(JSON.stringify({ status: 'sent', payment_id: '7', reason: null, held_id: '3' })) },
    transaction: { hash: '9qRji3NtLtJqB9aEyboDYXUzF9V3SXpdDT9f8uQLFo6w', signer_id: OWNER, receiver_id: VAULT, actions: [] },
    transaction_outcome: { id: 'tx', outcome: { executor_id: OWNER, logs: [], status: { SuccessReceiptId: 'r1' } } },
    receipts_outcome: [
      { id: 'r1', outcome: { executor_id: VAULT, logs: opts.vaultLogs ?? [], status: opts.receiptStatus ?? { SuccessValue: '' } } },
      { id: 'r2', outcome: { executor_id: USDC, logs: opts.tokenLogs ?? [], status: { SuccessValue: '' } } },
      { id: 'r3', outcome: { executor_id: 'impostor.testnet', logs: opts.otherLogs ?? [], status: { SuccessValue: '' } } },
    ],
  }
}
const ev = (event: string, data: unknown, standard = 'a_identity_vault') => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data })}`

test('an event counts only for the account that logged it', () => {
  const o = outcome({
    vaultLogs: [ev('payment_sent', { payment_id: '7', payee: 'aid-demo-merchant.testnet', amount: '250000', day: '20404', by_owner: true, memo: null }), 'plain log line'],
    tokenLogs: [ev('ft_transfer', [{ old_owner_id: VAULT, new_owner_id: 'aid-demo-merchant.testnet', amount: '250000' }], 'nep141')],
    // Any contract can log any text: an impostor's "payment_sent" is not the vault's.
    otherLogs: [ev('payment_sent', { payment_id: '666', payee: 'x.testnet', amount: '1', by_owner: false }), ev('ft_transfer', [{ old_owner_id: VAULT, new_owner_id: 'x.testnet', amount: '1' }], 'nep141')],
  })
  assert.equal(eventsOf(o).length, 4)
  const vault = vaultEventsOf(o, VAULT)
  assert.equal(vault.length, 1)
  assert.equal(vault[0].data.payment_id, '7')
  assert.deepEqual(tokenTransfersOf(o, USDC), [{ from: VAULT, to: 'aid-demo-merchant.testnet', amount: 250_000n }])
  assert.deepEqual(payOutcomeOf(o), { status: 'sent', paymentId: '7', reason: null, heldId: '3' })
})

test('a transaction is judged on its own status and on every receipt after it', () => {
  assert.deepEqual(txVerdict(outcome()), { ok: true })
  const panicked = outcome({
    status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: NotOwner' } } } } },
  })
  assert.deepEqual(txVerdict(panicked), { ok: false, reason: 'NotOwner', where: 'transaction' })
  const lateFailure = outcome({ receiptStatus: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: RequiresOneYocto' } } } } } })
  assert.deepEqual(txVerdict(lateFailure), { ok: false, reason: 'RequiresOneYocto', where: 'receipt' })
})

test('every vault event has words, and an unknown one keeps its raw name', () => {
  const refused = describeEvent(
    { standard: 'a_identity_vault', event: 'payment_refused', data: { payment_id: '2', payee: 'aid-demo-attacker.testnet', amount: '1000000', reason: 'RegistryDeny', source: 'registry', registry_reasons: ['drainer'] }, receiptId: 'r', executorId: VAULT },
    6,
    'USDC',
  )
  assert.equal(refused.tone, 'danger')
  assert.match(refused.title, /Refused 1 USDC to aid-demo-attacker\.testnet: RegistryDeny/)
  assert.match(refused.detail ?? '', /A-Identity registry; registry reasons: drainer\. Nothing moved\./)
  const held = describeEvent({ standard: 'a_identity_vault', event: 'payment_held', data: { held_id: '4', payee: 'new.testnet', amount: '500000', reason: 'UnknownPayee' }, receiptId: 'r', executorId: VAULT }, 6, 'USDC')
  assert.match(held.detail ?? '', /Nobody has judged this payee yet/)
  assert.equal(describeEvent({ standard: 'a_identity_vault', event: 'frozen_set', data: { frozen: true }, receiptId: 'r', executorId: VAULT }, 6, 'USDC').tone, 'danger')
  assert.equal(describeEvent({ standard: 'a_identity_vault', event: 'brand_new', data: {}, receiptId: 'r', executorId: VAULT }, 6, 'USDC').title, 'brand_new')
})

// -- what the reads mean -------------------------------------------------------------------

test('a key can pay only with both halves: the protocol key on the vault and the contract record', () => {
  const now = 1_762_950_000n
  const call = (receiverId: string, methodNames: string[], allowanceYocto: bigint | null = 250_000_000_000_000_000_000_000n) =>
    ({ kind: 'call', receiverId, methodNames, allowanceYocto }) as const
  const record = { publicKey: AGENT_PK, label: 'demo', expiresAtS: now + 3600n, revoked: false, addedAtS: now - 60n }
  const rows = keyRows(VAULT, [{ publicKey: AGENT_PK, nonce: '1', permission: call(VAULT, ['record_refusal', 'pay', 'request_payment']) }], [record], now)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].canPay, true)
  assert.deepEqual(rows[0].notes, [])

  const full = keyRows(VAULT, [{ publicKey: 'ed25519:full', nonce: '1', permission: { kind: 'full' } }], [], now)
  assert.equal(full[0].canPay, false)
  assert.equal(full[0].notes[0].tone, 'danger')

  assert.equal(keyRows(VAULT, [{ publicKey: AGENT_PK, nonce: '1', permission: call(VAULT, ['pay']) }], [], now)[0].canPay, false, 'no contract record')
  assert.equal(keyRows(VAULT, [], [record], now)[0].canPay, false, 'no key on the account')
  assert.equal(keyRows(VAULT, [{ publicKey: AGENT_PK, nonce: '1', permission: call(VAULT, ['pay', 'request_payment', 'record_refusal']) }], [{ ...record, expiresAtS: now - 1n }], now)[0].canPay, false)
  assert.ok(keyRows(VAULT, [{ publicKey: AGENT_PK, nonce: '1', permission: call(VAULT, [], null) }], [record], now)[0].notes.some((n) => /ANY method/.test(n.text)))
  assert.ok(isAgentMethodList(['pay', 'request_payment', 'record_refusal']) && !isAgentMethodList(['pay']) && !isAgentMethodList([]))
})

test('a key is valid through its expiry second, and a day resets at the next UTC midnight', () => {
  assert.equal(keyExpired(100n, 100n), false)
  assert.equal(keyExpired(100n, 101n), true)
  assert.equal(keyExpired(0n, 10n ** 12n), false, '0 means no expiry')
  assert.equal(dayResetsAtS(20_404n), 1_762_992_000n, 'day 20404 ends at 2026-11-13 00:00 UTC')
  assert.equal(dayResetsAtS(0n), 86_400n)
})

test('the headline answers "can the agent pay" from the same values as the rest', () => {
  const base = {
    frozen: false,
    payingKeys: 1,
    remaining: 4_000_000n,
    autoApproveMax: 1_000_000n,
    decimals: 6,
    symbol: 'USDC',
    registryId: REGISTRY,
    registryLive: true,
    holdUnknown: true,
  }
  assert.deepEqual(vaultHeadline(base).tone, 'ok')
  assert.match(vaultHeadline(base).title, /up to 4 USDC more today, at most 1 USDC per payment/)
  assert.match(vaultHeadline(base).detail, /registry flags is refused on chain/)
  assert.match(vaultHeadline(base).detail, /no verdict on waits too/)
  assert.match(vaultHeadline({ ...base, holdUnknown: false }).detail, /no verdict on is paid/)
  assert.equal(vaultHeadline({ ...base, frozen: true }).tone, 'danger')
  assert.match(vaultHeadline({ ...base, frozen: true }).detail, /can still approve held payments/)
  assert.equal(vaultHeadline({ ...base, payingKeys: 0 }).tone, 'warn')
  assert.equal(vaultHeadline({ ...base, remaining: 0n }).tone, 'warn')
  assert.match(vaultHeadline({ ...base, remaining: null, autoApproveMax: 0n }).title, /with no daily cap, with no per-payment ceiling/)
})

test('the headline never promises a registry check the vault cannot make', () => {
  const base = {
    frozen: false,
    payingKeys: 1,
    remaining: 4_000_000n,
    autoApproveMax: 1_000_000n,
    decimals: 6,
    symbol: 'USDC',
    registryId: REGISTRY,
    registryLive: true,
    holdUnknown: true,
  }
  // A registry that is not a live contract: the vault fails closed on every payment and approval.
  const down = vaultHeadline({ ...base, registryLive: false })
  assert.equal(down.tone, 'danger')
  assert.equal(down.title, `Every agent payment is refused: the registry ${REGISTRY} is not a live contract.`)
  assert.match(down.detail, /RegistryUnavailable/)
  assert.match(down.detail, /Approving a held payment is refused the same way/)
  assert.doesNotMatch(down.title + down.detail, /can pay up to/)
  assert.equal(vaultHeadline({ ...base, registryLive: false, payingKeys: 0 }).tone, 'danger', 'a dead registry outranks a missing key')
  const frozenDown = vaultHeadline({ ...base, registryLive: false, frozen: true })
  assert.equal(frozenDown.tone, 'danger')
  assert.match(frozenDown.detail, /Approving a held payment is refused too/)
  assert.doesNotMatch(frozenDown.detail, /can still approve/)
  // No registry at all: no verdict is checked, and the page says so instead of promising one.
  const none = vaultHeadline({ ...base, registryId: null, registryLive: null })
  assert.equal(none.tone, 'warn')
  assert.match(none.title, /, with no registry check\.$/)
  assert.match(none.detail, /asks no registry/)
  assert.doesNotMatch(none.detail, /registry flags|refused on chain/)
  assert.match(none.detail, /has never paid waits for the owner/)
  assert.match(vaultHeadline({ ...base, registryId: null, registryLive: null, holdUnknown: false }).detail, /Any payee is paid within those limits/)
  assert.match(vaultHeadline({ ...base, registryId: null, registryLive: null, holdUnknown: null }).detail, /does not report/)
  // A registry whose account was not read: the claim is conditional, not a green light.
  const unread = vaultHeadline({ ...base, registryLive: null })
  assert.equal(unread.tone, 'warn')
  assert.match(unread.title, /if its registry answers\.$/)
  assert.match(unread.detail, /was not read/)
  assert.equal(registryDown({ registryId: REGISTRY, registryLive: false }), true)
  assert.equal(registryDown({ registryId: REGISTRY, registryLive: null }), false, 'not read is not down')
  assert.equal(registryDown({ registryId: null, registryLive: null }), false)
})

test('the approve panel says what owner_pay does with this vault registry', () => {
  const live = ownerPayNote({ registryId: REGISTRY, registryLive: true, payeeDenied: false })
  assert.equal(live.blocked, null)
  assert.match(live.text, new RegExp(`asks ${REGISTRY.replace(/\./g, '\\.')} again before paying`))
  assert.match(live.text, /the hold is dropped/)
  assert.doesNotMatch(live.text, /says DENY for this payee right now/)
  assert.match(ownerPayNote({ registryId: REGISTRY, registryLive: true, payeeDenied: true }).text, /says DENY for this payee right now/)
  const none = ownerPayNote({ registryId: null, registryLive: null, payeeDenied: false })
  assert.equal(none.blocked, null)
  assert.match(none.text, /asks no registry, so the approval pays with no verdict check/)
  assert.doesNotMatch(none.text, /asks the registry|again before paying/)
  const down = ownerPayNote({ registryId: REGISTRY, registryLive: false, payeeDenied: false })
  assert.ok(down.blocked, 'a registry that is not a live contract refuses every approval, so no signature is offered')
  assert.match(down.blocked ?? '', /RegistryUnavailable/)
  assert.match(down.blocked ?? '', /drop the hold and pay nothing/)
})

test('every held payee is read, and only the allowlist is capped', () => {
  const held = (payee: string, id: number) => ({ id: String(id), paymentId: String(id), agentPk: 'ed25519:x', payee, amount: 1n, memo: null, reason: 'UnknownPayee', createdAtS: 0n, expiresAtS: 1n })
  const twentyHeld = Array.from({ length: 20 }, (_, i) => held(`held-${i}.testnet`, i))
  const allowlist = Array.from({ length: 30 }, (_, i) => `listed-${i}.testnet`)
  const payees = payeesInView({ held: twentyHeld, allowlist }, ['checked.testnet'])
  assert.equal(payees[0], 'checked.testnet', 'a payee checked by hand comes first')
  for (const h of twentyHeld) assert.ok(payees.includes(h.payee), `${h.payee} is held, so it is read`)
  assert.equal(payees.filter((p) => p.startsWith('listed-')).length, ALLOWLIST_READ_LIMIT)
  assert.equal(payees.length, 1 + 20 + ALLOWLIST_READ_LIMIT)
  // A payee that is held, listed and checked is read once.
  const overlap = payeesInView({ held: [held('a.testnet', 1), held('a.testnet', 2)], allowlist: ['a.testnet', 'b.testnet'] }, ['a.testnet'])
  assert.deepEqual(overlap, ['a.testnet', 'b.testnet'])
})

test('the prediction follows the contract order: freeze, allowlist, then the registry, then silence', () => {
  const base = { frozen: false, allowlistEnabled: false, onAllowlist: false, registryId: 'registry.a-identity.testnet', holdUnknown: true, paidCount: 0 }
  const verdict = (v: 'ALLOW' | 'WARN' | 'DENY') => parseVerdict({ verdict: v })
  assert.equal(predictAgentPay({ ...base, frozen: true, verdict: verdict('ALLOW') }).kind, 'refused')
  assert.equal(predictAgentPay({ ...base, allowlistEnabled: true, verdict: verdict('ALLOW') }).kind, 'refused')
  assert.deepEqual(predictAgentPay({ ...base, verdict: verdict('DENY') }).kind, 'refused')
  assert.equal(predictAgentPay({ ...base, onAllowlist: true, verdict: verdict('DENY') }).kind, 'refused', 'the owner listing a payee does not override a DENY')
  assert.equal(predictAgentPay({ ...base, verdict: { ok: false } }).kind, 'refused', 'an unreadable registry fails closed')
  assert.equal(predictAgentPay({ ...base, verdict: verdict('WARN') }).kind, 'held')
  assert.equal(predictAgentPay({ ...base, verdict: verdict('ALLOW') }).kind, 'paid')
  const silent = { ok: true as const, verdict: null }
  assert.deepEqual(predictAgentPay({ ...base, verdict: silent }), { kind: 'held', code: 'UnknownPayee', text: 'Held for the owner: nobody has judged this payee and the vault has never paid it.' })
  assert.equal(predictAgentPay({ ...base, verdict: silent, paidCount: 2 }).kind, 'paid')
  assert.equal(predictAgentPay({ ...base, verdict: silent, onAllowlist: true }).kind, 'paid')
  assert.equal(predictAgentPay({ ...base, verdict: silent, holdUnknown: false }).kind, 'paid')
  assert.equal(predictAgentPay({ ...base, registryId: null, verdict: null }).kind, 'held', 'no registry at all is silence too')
  assert.equal(predictAgentPay({ ...base, verdict: null }).kind, 'unread')
})

// -- the prepared calls ----------------------------------------------------------------------

test('owner calls carry the deposit the contract demands and explicit gas', () => {
  const freeze = prepareFreeze(VAULT)
  assert.deepEqual(freeze.actions, [{ type: 'FunctionCall', params: { methodName: 'freeze', args: {}, gas: '30000000000000', deposit: '0' } }])
  assert.equal(prepareUnfreeze(VAULT).actions[0].params.deposit, '1')
  assert.deepEqual(prepareOwnerPay(VAULT, '3', REGISTRY).actions[0].params, { methodName: 'owner_pay', args: { held_id: '3' }, gas: '100000000000000', deposit: '1' })
  assert.deepEqual(prepareOwnerPay(VAULT, '3', null).actions, prepareOwnerPay(VAULT, '3', REGISTRY).actions, 'the registry changes the words, never the call')
  assert.match(prepareOwnerPay(VAULT, '3', REGISTRY).what, /asks the registry registry\.a-identity\.testnet once more/)
  assert.match(prepareOwnerPay(VAULT, '3', null).what, /asks no registry, so no verdict is checked first/)
  assert.deepEqual(prepareOwnerReject(VAULT, '3').actions[0].params.args, { held_id: '3' })
  assert.deepEqual(prepareWithdraw(VAULT, 1_500_000n, '1.5 USDC').actions[0].params, { methodName: 'withdraw', args: { amount: '1500000' }, gas: '50000000000000', deposit: '1' })
  assert.throws(() => prepareWithdraw(VAULT, 0n, '0 USDC'))
  assert.deepEqual(prepareSetHoldUnknown(VAULT, true).actions[0].params.args, { hold_unknown: true })
  assert.deepEqual(prepareSetPolicy(VAULT, { dailyCap: 5_000_000n, autoApproveMax: 0n, allowlistEnabled: true }).actions[0].params.args, {
    daily_cap: '5000000',
    auto_approve_max: '0',
    allowlist_enabled: true,
  })
  assert.deepEqual(prepareSetAllowed(VAULT, 'aid-demo-merchant.testnet', false).actions[0].params.args, { payee: 'aid-demo-merchant.testnet', ok: false })
  for (const tx of [prepareUnfreeze(VAULT), prepareOwnerPay(VAULT, '1', REGISTRY), prepareSetPolicy(VAULT, { dailyCap: 1n, autoApproveMax: 1n, allowlistEnabled: false })]) {
    assert.equal(tx.receiverId, VAULT)
  }
})

test('funding is one transaction to the token: registration only when needed, then ft_transfer_call', () => {
  const fresh = prepareFund(USDC, VAULT, 2_000_000n, '2 USDC', 1_250_000_000_000_000_000_000n)
  assert.equal(fresh.receiverId, USDC)
  assert.deepEqual(
    fresh.actions.map((a) => [a.params.methodName, a.params.deposit, a.params.gas]),
    [
      ['storage_deposit', '1250000000000000000000', '10000000000000'],
      ['ft_transfer_call', '1', '100000000000000'],
    ],
  )
  assert.deepEqual(fresh.actions[0].params.args, { account_id: VAULT, registration_only: true })
  assert.deepEqual(fresh.actions[1].params.args, { receiver_id: VAULT, amount: '2000000', msg: '' })
  const registered = prepareFund(USDC, VAULT, 2_000_000n, '2 USDC', null)
  assert.equal(registered.actions.length, 1)
  assert.equal(totalTgas(fresh), 110)
  assert.equal(totalDeposit(fresh), 1_250_000_000_000_000_000_001n)
})

// -- registry wiring -----------------------------------------------------------------------

test('hosts, explorer and token come from the generated registry, and links use the NearBlocks routes', () => {
  assert.ok(NEAR_RPC_URLS.length > 0)
  assert.equal(NEAR_CHAIN.caip2, 'near:testnet')
  assert.equal(NEAR_CHAIN.testnet, true)
  assert.equal(nearTxUrl('abc'), `${NEAR_CHAIN.explorer}/txns/abc`)
  assert.equal(nearAccountUrl(VAULT), `${NEAR_CHAIN.explorer}/address/${VAULT}`)
  assert.equal(REGISTRY_USDC?.decimals, 6)
  assert.equal(REGISTRY_USDC?.issuer, 'Circle')
  assert.ok(REGISTRY_VAULT === null || isNearAccountId(REGISTRY_VAULT), 'a vault the registry records is an account id, or nothing')
})

test('no file of the NEAR console types a registry host or token', () => {
  // The registry is the one place these live (CLAUDE.md); the forbidden list is generated from it.
  const forbidden = [...NEAR_RPC_URLS.map((u) => new URL(u).host), NEAR_CHAIN.explorer ? new URL(NEAR_CHAIN.explorer).host : null, REGISTRY_USDC?.address ?? null].filter(
    (x): x is string => Boolean(x),
  )
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) files.push(full)
    }
  }
  walk(join(root, 'lib/near'))
  walk(join(root, 'components/app/near'))
  files.push(join(root, 'routes/app/NearVault.tsx'))
  for (const f of files) {
    const text = readFileSync(f, 'utf8')
    for (const needle of forbidden) assert.ok(!text.includes(needle), `${f} types ${needle}; take it from src/lib/chains.ts`)
  }
})

// -- this browser's list of sent transactions ----------------------------------------------

test('the sent-transaction list keeps the newest first, once each, and survives broken storage', () => {
  const mem = new Map<string, string>()
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  const tx = (hash: string) => ({ hash, signerId: OWNER, what: 'freeze', at: '2026-11-12T00:00:00.000Z' })
  rememberTx(VAULT, tx('a'), store)
  rememberTx(VAULT, tx('b'), store)
  rememberTx(VAULT, tx('a'), store)
  assert.deepEqual(loadKnownTxs(VAULT, store).map((t) => t.hash), ['a', 'b'])
  for (let i = 0; i < 30; i++) rememberTx(VAULT, tx(`h${i}`), store)
  assert.equal(loadKnownTxs(VAULT, store).length, 20)
  mem.set(`aid-near-txs:${VAULT}`, '{broken')
  assert.deepEqual(loadKnownTxs(VAULT, store), [])
  assert.deepEqual(loadKnownTxs(VAULT, null), [])
})

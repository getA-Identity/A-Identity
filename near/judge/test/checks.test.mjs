import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { encode } from '../lib/base58.mjs';
import { CHECKS, ed25519SecretsIn, isEd25519SecretKey, projectPaths, recordedDiff, supportsStripTypes } from '../lib/checks.mjs';
import { evaluateClaim } from '../lib/engine.mjs';
import { PendingError, SkipError } from '../lib/evidence.mjs';
import { accessKeyListSpec, accessKeySpec, callFunctionSpec, txStatusSpec, viewAccountSpec } from '../lib/near.mjs';
import { parseCargoTest, parseNodeTest } from '../lib/proc.mjs';
import { NetworkError } from '../lib/rpc.mjs';
import { IDS, NEAR_ROOT, call, fixture, makeCtx, recorded, recordedCall, syntheticPay, syntheticTxCalls, tempDir } from './helpers.mjs';

const run = (check, params, calls, extra) => CHECKS[check].run(params, makeCtx(calls, extra));
const FAUCET = '641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5';

// ------------------------------------------------------------------ account_exists (recorded)

test('account_exists: PASS on a real recorded view_account', async () => {
  const result = await run('account_exists', { account_id: 'a-identity.testnet' }, recorded.calls);
  assert.equal(result.status, 'PASS', result.detail);
  assert.match(result.detail, /view_account at block \d+: \d+\.\d{4} NEAR, no contract/);
});

test('account_exists: UNKNOWN_ACCOUNT fails an existence claim and passes an absence claim', async () => {
  const missing = await run('account_exists', { account_id: 'registry.a-identity.testnet' }, recorded.calls);
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.detail, /does not exist/);
  const absent = await run('account_exists', { account_id: 'registry.a-identity.testnet', exists: false }, recorded.calls);
  assert.equal(absent.status, 'PASS');
  const present = await run('account_exists', { account_id: 'a-identity.testnet', exists: false }, recorded.calls);
  assert.equal(present.status, 'FAIL');
});

test('account_exists: has_contract is checked against the code hash', async () => {
  const usdc = await run('account_exists', { account_id: IDS.usdc, has_contract: true }, recorded.calls);
  assert.equal(usdc.status, 'PASS', usdc.detail);
  const plain = await run('account_exists', { account_id: 'a-identity.testnet', has_contract: true }, recorded.calls);
  assert.equal(plain.status, 'FAIL');
});

test('account_exists: node trouble is not an answer (SkipError, so SKIP)', async () => {
  const spec = viewAccountSpec('testnet', 'x.testnet');
  const busy = call(spec, { error: { name: 'HANDLER_ERROR', cause: { name: 'UNAVAILABLE_SHARD', info: {} }, code: -32000, message: 'Server error' } });
  await assert.rejects(run('account_exists', { account_id: 'x.testnet' }, [busy]), SkipError);
});

// ------------------------------------------------------------------ view_equals (recorded)

test('view_equals: subset match on real ft_metadata shows only the claimed fields', async () => {
  const result = await run('view_equals', { account_id: IDS.usdc, method: 'ft_metadata', args: {}, expect: { spec: 'ft-1.0.0', symbol: 'USDC', decimals: 6 } }, recorded.calls);
  assert.equal(result.status, 'PASS', result.detail);
  assert.match(result.detail, /\{"decimals":6,"spec":"ft-1\.0\.0","symbol":"USDC"\}/);
  assert.doesNotMatch(result.detail, /svg/, 'the icon is not dumped into the line');
  const wrong = await run('view_equals', { account_id: IDS.usdc, method: 'ft_metadata', args: {}, expect: { decimals: 18 } }, recorded.calls);
  assert.equal(wrong.status, 'FAIL');
  assert.match(wrong.detail, /\$\.decimals: expected 18, got 6/);
});

test('view_equals: real is_blocklisted answer and a real missing method', async () => {
  const ok = await run('view_equals', { account_id: IDS.usdc, method: 'is_blocklisted', args: { account_id: 'aid-demo-merchant.testnet' }, expect: false }, recorded.calls);
  assert.equal(ok.status, 'PASS', ok.detail);
  const missing = await run('view_equals', { account_id: IDS.usdc, method: 'no_such_method', args: {}, expect: 1 }, recorded.calls);
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.detail, /MethodNotFound/);
});

// ------------------------------------------------------------------ access_keys

function keyList(account, keys, block = 277400002) {
  return call(accessKeyListSpec('testnet', account), { result: { keys, block_height: block, block_hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' } });
}
const fcKey = (publicKey, receiver, methods, allowance = '250000000000000000000000') => ({
  public_key: publicKey,
  access_key: { nonce: 277000000000001, permission: { FunctionCall: { allowance, receiver_id: receiver, method_names: methods } } },
});
const AGENT_METHODS = ['pay', 'request_payment', 'record_refusal'];
const vaultClaim = (extra = {}) => ({
  account_id: IDS.vault,
  full_access_count: 0,
  function_call: { receiver_id: IDS.vault, method_names: AGENT_METHODS, allowance: 'finite' },
  min_function_call_keys: 1,
  max_function_call_keys: 5,
  must_include: [IDS.agentKey],
  ...extra,
});

test('access_keys: the real a-identity.testnet key list has one full-access key', async () => {
  const locked = await run('access_keys', { account_id: 'a-identity.testnet', full_access_count: 0 }, recorded.calls);
  assert.equal(locked.status, 'FAIL');
  assert.match(locked.detail, /1 full-access key\(s\), the claim says 0/);
  const honest = await run('access_keys', { account_id: 'a-identity.testnet', full_access_count: 1 }, recorded.calls);
  assert.equal(honest.status, 'PASS', honest.detail);
});

test('access_keys: a real function-call-only account (v0.probarion.testnet) passes its own shape', async () => {
  const result = await run(
    'access_keys',
    { account_id: 'v0.probarion.testnet', full_access_count: 0, function_call: { receiver_id: 'v0.probarion.testnet', method_names: ['spend'], allowance: 'finite' }, min_function_call_keys: 1 },
    recorded.calls,
  );
  assert.equal(result.status, 'PASS', result.detail);
  assert.match(result.detail, /0 full-access, 1 function-call/);
});

test('access_keys: an empty key list passes only for an account that exists (nearcore lists no keys for a missing account)', async () => {
  const block = 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo';
  const empty = keyList(IDS.registry, []);
  const lockedRegistry = call(viewAccountSpec('testnet', IDS.registry, block), { result: { amount: '5000000000000000000000000', locked: '0', code_hash: 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z', storage_usage: 300000, block_height: 277400002, block_hash: block } });
  const locked = await run('access_keys', { account_id: IDS.registry, full_access_count: 0 }, [empty, lockedRegistry]);
  assert.equal(locked.status, 'PASS', locked.detail);
  assert.match(locked.detail, /0 full-access, 0 function-call/);
  const noAccount = call(viewAccountSpec('testnet', IDS.registry, block), { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { block_hash: block, block_height: 277400002 } }, code: -32000, message: 'Server error' } });
  const missing = await run('access_keys', { account_id: IDS.registry, full_access_count: 0 }, [empty, noAccount]);
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.detail, /registry\.a-identity\.testnet does not exist at block 277400002: its empty key list proves nothing/);
});

test('access_keys: the locked vault shape passes', async () => {
  const result = await run('access_keys', vaultClaim(), [keyList(IDS.vault, [fcKey(IDS.agentKey, IDS.vault, ['record_refusal', 'pay', 'request_payment'])])]);
  assert.equal(result.status, 'PASS', result.detail);
});

test('access_keys: every way a vault key list can be wrong is a FAIL', async () => {
  const cases = [
    [[{ public_key: 'ed25519:Fak3', access_key: { nonce: 1, permission: 'FullAccess' } }, fcKey(IDS.agentKey, IDS.vault, AGENT_METHODS)], /1 full-access key/],
    [[fcKey(IDS.agentKey, IDS.vault, ['pay', 'request_payment', 'record_refusal', 'withdraw'])], /allows \[pay,request_payment,record_refusal,withdraw\]/],
    [[fcKey(IDS.agentKey, IDS.vault, [])], /ANY method/],
    [[fcKey(IDS.agentKey, IDS.usdc, AGENT_METHODS)], /may call 3e2210e1/],
    [[fcKey(IDS.agentKey, IDS.vault, AGENT_METHODS, null)], /unlimited allowance/],
    [[fcKey('ed25519:Other', IDS.vault, AGENT_METHODS)], /is not on vault/],
    [[], /needs at least 1/],
    [[{ public_key: IDS.agentKey, access_key: { nonce: 1, permission: { GasKeyFullAccess: { balance: '1', num_nonces: 1 } } } }], /full-access key/],
    [[{ public_key: IDS.agentKey, access_key: { nonce: 1, permission: { SomethingNew: {} } } }], /kind this judge does not know/],
  ];
  // The vault exists (asked only when its key list is empty).
  const vaultExists = call(viewAccountSpec('testnet', IDS.vault, 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo'), {
    result: { amount: '5000000000000000000000000', locked: '0', code_hash: 'EoAUFWELjD9gYzsjKDXYRmHDHf1RJ95jaKNSYE6v9b2z', storage_usage: 300000, block_height: 277400002, block_hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' },
  });
  for (const [keys, pattern] of cases) {
    const result = await run('access_keys', vaultClaim(), [keyList(IDS.vault, keys), vaultExists]);
    assert.equal(result.status, 'FAIL', `expected FAIL for ${JSON.stringify(keys).slice(0, 120)}`);
    assert.match(result.detail, pattern);
  }
  const revoked = await run('access_keys', vaultClaim({ must_exclude: ['ed25519:Revoked'] }), [
    keyList(IDS.vault, [fcKey(IDS.agentKey, IDS.vault, AGENT_METHODS), fcKey('ed25519:Revoked', IDS.vault, AGENT_METHODS)]),
  ]);
  assert.equal(revoked.status, 'FAIL');
  assert.match(revoked.detail, /still on/);
});

// ------------------------------------------------------------------ tx_outcome (recorded)

test('tx_outcome: a real Circle USDC ft_transfer is found, with its nep141 event, from archival', async () => {
  const result = await run(
    'tx_outcome',
    {
      tx_hash: 'D6Jp1Ho17KbwV5KDzcdE9RooKG6YFcZRRpap7RiNaV84',
      sender_account_id: FAUCET,
      expect: {
        signer_id: FAUCET,
        receiver_id: IDS.usdc,
        method_name: 'ft_transfer',
        deposit: '1',
        status: 'success',
        no_failed_receipts: true,
        ft_transfers: [{ token_id: IDS.usdc, from: FAUCET, to: 'aid-demo-owner.testnet', amount: '20000000', present: true, symbol: 'USDC', decimals: 6 }],
      },
    },
    recorded.calls,
  );
  assert.equal(result.status, 'PASS', result.detail);
  assert.match(result.detail, /FINAL in block 277290732 \(2026-11-1\dT/);
  assert.match(result.detail, /ft_transfer 20 USDC from 641c8bb1.* to aid-demo-owner\.testnet/);
});

test('tx_outcome: claiming the transfer went elsewhere, or never happened, FAILS on the same record', async () => {
  const base = { tx_hash: 'D6Jp1Ho17KbwV5KDzcdE9RooKG6YFcZRRpap7RiNaV84', sender_account_id: FAUCET };
  const elsewhere = await run('tx_outcome', { ...base, expect: { ft_transfers: [{ token_id: IDS.usdc, to: 'aid-demo-merchant.testnet', present: true }] } }, recorded.calls);
  assert.equal(elsewhere.status, 'FAIL');
  const never = await run('tx_outcome', { ...base, expect: { ft_transfers: [{ token_id: IDS.usdc, to: 'aid-demo-owner.testnet', present: false }], no_receipts_executed_by: [IDS.usdc] } }, recorded.calls);
  assert.equal(never.status, 'FAIL');
  assert.match(never.detail, /WAS transferred/);
  assert.match(never.detail, /receipt\(s\) executed by 3e2210e1/);
});

test('tx_outcome: a real failed token call moves nothing and is reported as failed', async () => {
  const base = { tx_hash: 'ECx6AZwgUJ8iWqi2inekcczZ22gh9SV4sRxf2PzBpLRc', sender_account_id: 'entechnologuelmmxc4.testnet' };
  const status = await run('tx_outcome', { ...base, expect: { status: 'failure', ft_transfers: [{ token_id: IDS.usdc, to: 'sheda-raise-v1.testnet', present: false }] } }, recorded.calls);
  assert.equal(status.status, 'PASS', status.detail);
  const strict = await run('tx_outcome', { ...base, expect: { status: 'success', no_failed_receipts: true } }, recorded.calls);
  assert.equal(strict.status, 'FAIL');
  assert.match(strict.detail, /final status is failure/);
  assert.match(strict.detail, /receipt\(s\) failed/);
});

test('tx_outcome: an unknown transaction is a FAIL, not a hang', async () => {
  const result = await run('tx_outcome', { tx_hash: '11111111111111111111111111111111', sender_account_id: 'a-identity.testnet', expect: {} }, recorded.calls);
  assert.equal(result.status, 'FAIL');
  assert.match(result.detail, /UNKNOWN_TRANSACTION/);
});

// ------------------------------------------------------------------ tx_outcome (synthetic vault)

const payAllowClaim = (amount = '1000000') => ({
  signer_id: IDS.vault,
  public_key: IDS.agentKey,
  receiver_id: IDS.vault,
  method_name: 'pay',
  status: 'success',
  return: { status: 'sent' },
  no_failed_receipts: true,
  events: [{ standard: 'a_identity_vault', event: 'payment_sent', executor_id: IDS.vault, data: { payee: IDS.merchant, amount, by_owner: false }, count: 1 }],
  ft_transfers: [{ token_id: IDS.usdc, from: IDS.vault, to: IDS.merchant, amount, present: true, symbol: 'USDC', decimals: 6 }],
});

const payDenyClaim = {
  signer_id: IDS.vault,
  public_key: IDS.agentKey,
  method_name: 'pay',
  status: 'success',
  return: { status: 'refused', reason: 'RegistryDeny' },
  no_failed_receipts: true,
  events: [{ standard: 'a_identity_vault', event: 'payment_refused', executor_id: IDS.vault, data: { payee: IDS.attacker, reason: 'RegistryDeny', source: 'registry' }, count: 1 }],
  absent_events: [{ standard: 'a_identity_vault', event: 'payment_sent' }],
  ft_transfers: [{ token_id: IDS.usdc, to: IDS.attacker, present: false }],
  no_receipts_executed_by: [IDS.usdc],
};

test('tx_outcome (synthetic): ALLOW pays, DENY refuses with nothing moved, WARN and unknown are held', async () => {
  const allow = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW' });
  const allowed = await run('tx_outcome', { tx_hash: allow.tx_hash, sender_account_id: IDS.vault, expect: payAllowClaim() }, syntheticTxCalls(allow));
  assert.equal(allowed.status, 'PASS', allowed.detail);
  assert.match(allowed.detail, /payment_sent\{payee=aid-demo-merchant\.testnet amount=1000000 by_owner=false\}/);

  const deny = syntheticPay({ payee: IDS.attacker, outcome: 'refused', reason: 'RegistryDeny', verdict: 'DENY' });
  const denied = await run('tx_outcome', { tx_hash: deny.tx_hash, sender_account_id: IDS.vault, expect: payDenyClaim }, syntheticTxCalls(deny));
  assert.equal(denied.status, 'PASS', denied.detail);
  assert.match(denied.detail, /no receipt reached 3e2210e1/);

  for (const [verdict, reason] of [['WARN', 'RegistryWarn'], [null, 'UnknownPayee']]) {
    const held = syntheticPay({ payee: 'aid-demo-rnerchant.testnet', outcome: 'held', reason, verdict });
    const result = await run(
      'tx_outcome',
      {
        tx_hash: held.tx_hash,
        sender_account_id: IDS.vault,
        expect: {
          return: { status: 'held' },
          events: [{ standard: 'a_identity_vault', event: 'payment_held', data: { payee: 'aid-demo-rnerchant.testnet', reason }, count: 1 }],
          absent_events: [{ standard: 'a_identity_vault', event: 'payment_sent' }],
          no_receipts_executed_by: [IDS.usdc],
        },
      },
      syntheticTxCalls(held),
    );
    assert.equal(result.status, 'PASS', result.detail);
    // The evidence line shows what the vault saw, next to the reason it stored.
    assert.match(result.detail, new RegExp(`payment_held\\{payee=aid-demo-rnerchant\\.testnet amount=1000000 reason=${reason} kind=${verdict === 'WARN' ? 'registry_warn' : 'unknown_payee'} held_id=3\\}`));
  }
});

test('tx_outcome (synthetic): a refusal that still touched the token, a wrong key, a wrong amount, a duplicate event all FAIL', async () => {
  const sneaky = syntheticPay({
    payee: IDS.attacker,
    outcome: 'refused',
    reason: 'RegistryDeny',
    verdict: 'DENY',
    extraReceipts: [{ id: 'X', executor_id: IDS.usdc, logs: [], status: { SuccessValue: '' } }],
  });
  const touched = await run('tx_outcome', { tx_hash: sneaky.tx_hash, sender_account_id: IDS.vault, expect: payDenyClaim }, syntheticTxCalls(sneaky));
  assert.equal(touched.status, 'FAIL');
  assert.match(touched.detail, /1 receipt\(s\) executed by 3e2210e1/);

  const otherKey = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW', publicKey: 'ed25519:SomeoneElse' });
  const wrongKey = await run('tx_outcome', { tx_hash: otherKey.tx_hash, sender_account_id: IDS.vault, expect: payAllowClaim() }, syntheticTxCalls(otherKey));
  assert.equal(wrongKey.status, 'FAIL');
  assert.match(wrongKey.detail, /public_key/);

  const allow = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW' });
  const wrongAmount = await run('tx_outcome', { tx_hash: allow.tx_hash, sender_account_id: IDS.vault, expect: payAllowClaim('5000000') }, syntheticTxCalls(allow));
  assert.equal(wrongAmount.status, 'FAIL');

  const doubled = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW' });
  const last = doubled.result.receipts_outcome.at(-1);
  last.outcome.logs.push(last.outcome.logs[0]);
  const twice = await run('tx_outcome', { tx_hash: doubled.tx_hash, sender_account_id: IDS.vault, expect: payAllowClaim() }, syntheticTxCalls(doubled));
  assert.equal(twice.status, 'FAIL', 'an audit trail with a duplicated payment event is wrong');

  const garbled = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW' });
  garbled.result.receipts_outcome.at(-1).outcome.logs.push('EVENT_JSON:{not json');
  const malformed = await run('tx_outcome', { tx_hash: garbled.tx_hash, sender_account_id: IDS.vault, expect: payAllowClaim() }, syntheticTxCalls(garbled));
  assert.equal(malformed.status, 'FAIL');
  assert.match(malformed.detail, /malformed EVENT_JSON/);

  const notFinal = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW' });
  notFinal.result.final_execution_status = 'EXECUTED_OPTIMISTIC';
  const early = await run('tx_outcome', { tx_hash: notFinal.tx_hash, sender_account_id: IDS.vault, expect: payAllowClaim() }, syntheticTxCalls(notFinal));
  assert.equal(early.status, 'FAIL');
  assert.match(early.detail, /not FINAL/);
});

// ------------------------------------------------------------------ protocol_rejection

const signed = fixture('near-api-js-signed.json');
const signedCase = (name) => signed.cases.find((c) => c.name === name);
const rejectionError = (rule) => ({
  name: 'HANDLER_ERROR',
  cause: { name: 'INVALID_TRANSACTION', info: {} },
  code: -32000,
  message: 'Server error',
  data: { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: typeof rule === 'string' ? rule : rule } } },
});

function attackRoot(entries) {
  const root = tempDir();
  mkdirSync(join(root, 'demo'), { recursive: true });
  writeFileSync(join(root, 'demo/attack-log.json'), JSON.stringify({ schema: 'a-identity-near-attack-log/1', rejections: entries }));
  return root;
}

function rejection(id, caseName, error) {
  const c = signedCase(caseName);
  return {
    id,
    sent_at: '2026-11-13T10:00:00Z',
    rpc_url: 'https://rpc.testnet.fastnear.com',
    request: { jsonrpc: '2.0', id: 'demo', method: 'send_tx', params: { signed_tx_base64: c.signed_tx_base64, wait_until: 'FINAL' } },
    response: { jsonrpc: '2.0', id: 'demo', error },
  };
}

function keyAtBlock(permission, caseName = 'agent-ft-transfer') {
  const c = signedCase(caseName);
  const block = encode(Buffer.from(c.block_hash_hex, 'hex'));
  // The shape of a real view_access_key answer (fixtures/testnet-recorded.json), with the agent's permission.
  const real = recordedCall((x) => x.request.params.request_type === 'view_access_key');
  real.request.params = accessKeySpec('testnet', IDS.vault, c.public_key, block).params;
  real.response.result.permission = permission;
  real.response.result.block_hash = block;
  return real;
}

const AGENT_PERMISSION = { FunctionCall: { allowance: '250000000000000000000000', receiver_id: IDS.vault, method_names: AGENT_METHODS } };
const rejectParams = (entry, rule, extra = {}) => ({
  log: 'demo/attack-log.json',
  entry,
  expect_rule: rule,
  signer_id: IDS.vault,
  public_key: signed.public_key,
  ...extra,
});

test('protocol_rejection: a recorded rejection is re-derived from the signed bytes and the on-chain key', async () => {
  const root = attackRoot([
    rejection('agent-ft-transfer', 'agent-ft-transfer', rejectionError('DepositWithFunctionCall')),
    rejection('agent-withdraw', 'agent-withdraw', rejectionError({ MethodNameMismatch: { method_name: 'withdraw' } })),
    rejection('agent-add-key', 'agent-add-key', rejectionError('RequiresFullAccess')),
  ]);
  const keys = [keyAtBlock(AGENT_PERMISSION)];
  const ft = await run('protocol_rejection', rejectParams('agent-ft-transfer', 'DepositWithFunctionCall', { receiver_id: IDS.usdc, method_name: 'ft_transfer' }), keys, { root });
  assert.equal(ft.status, 'PASS', ft.detail);
  assert.match(ft.detail, /signature valid/);
  assert.match(ft.detail, /so nearcore rejects it with DepositWithFunctionCall/);
  const withdraw = await run('protocol_rejection', rejectParams('agent-withdraw', 'AccessKeyMethodNameMismatch', { method_name: 'withdraw' }), keys, { root });
  assert.equal(withdraw.status, 'PASS', withdraw.detail);
  const addKey = await run('protocol_rejection', rejectParams('agent-add-key', 'RequiresFullAccess'), keys, { root });
  assert.equal(addKey.status, 'PASS', addKey.detail);
});

test('protocol_rejection: a log that disagrees with the chain or with itself FAILS', async () => {
  const keys = [keyAtBlock(AGENT_PERMISSION)];
  // The log says ReceiverMismatch, but the transaction carries 1 yocto: nearcore says Deposit first.
  const wrongRule = attackRoot([rejection('x', 'agent-ft-transfer', rejectionError({ ReceiverMismatch: { tx_receiver: IDS.usdc, ak_receiver: IDS.vault } }))]);
  const r1 = await run('protocol_rejection', rejectParams('x', 'ReceiverMismatch'), keys, { root: wrongRule });
  assert.equal(r1.status, 'FAIL');
  assert.match(r1.detail, /gives DepositWithFunctionCall, not ReceiverMismatch/);
  // The error does not name the claimed rule at all.
  const r2 = await run('protocol_rejection', rejectParams('x', 'MethodNameMismatch'), keys, { root: wrongRule });
  assert.equal(r2.status, 'FAIL');
  assert.match(r2.detail, /does not name MethodNameMismatch/);
  // The key was full access at that block: nothing would have been rejected.
  const full = attackRoot([rejection('x', 'agent-ft-transfer', rejectionError('DepositWithFunctionCall'))]);
  const r3 = await run('protocol_rejection', rejectParams('x', 'DepositWithFunctionCall'), [keyAtBlock('FullAccess')], { root: full });
  assert.equal(r3.status, 'FAIL');
  assert.match(r3.detail, /FULL-ACCESS/);
  // A forged signature.
  const entry = rejection('x', 'agent-ft-transfer', rejectionError('DepositWithFunctionCall'));
  const bytes = Buffer.from(entry.request.params.signed_tx_base64, 'base64');
  bytes[bytes.length - 2] ^= 0xff;
  entry.request.params.signed_tx_base64 = bytes.toString('base64');
  const r4 = await run('protocol_rejection', rejectParams('x', 'DepositWithFunctionCall'), keys, { root: attackRoot([entry]) });
  assert.equal(r4.status, 'FAIL');
  assert.match(r4.detail, /signature does not verify/);
  // The claim names a different agent key than the one that signed (a real testnet key, not ours).
  const r5 = await run('protocol_rejection', rejectParams('x', 'DepositWithFunctionCall', { public_key: 'ed25519:5errZXjDMXpk51BLypA3hBRUfBfh9v4bHeyU9vRmzYFK' }), keys, { root: full });
  assert.equal(r5.status, 'FAIL');
  assert.match(r5.detail, /signed with ed25519:2KPT8.*the claim says ed25519:5errZ/);
  // Not an error at all.
  const fine = attackRoot([{ ...rejection('x', 'agent-ft-transfer', null), response: { jsonrpc: '2.0', id: 'demo', result: {} } }]);
  const r6 = await run('protocol_rejection', rejectParams('x', 'DepositWithFunctionCall'), keys, { root: fine });
  assert.equal(r6.status, 'FAIL');
  assert.match(r6.detail, /not an error/);
});

test("protocol_rejection: the attack demo's own run-log shape (no signed bytes) is read honestly", async () => {
  const root = tempDir();
  mkdirSync(join(root, 'demo/logs'), { recursive: true });
  const record = (attempt, rule, errorName = rule) => ({
    phase: 'e',
    attempt,
    label: 'rejected before execution, no transaction',
    error_name: errorName,
    expected_error: rule,
    rpc_error: rejectionError(rule === 'MethodNameMismatch' ? { MethodNameMismatch: { method_name: 'set_registry' } } : rule),
  });
  writeFileSync(
    join(root, 'demo/logs/run.json'),
    JSON.stringify({ run_id: 'run', started_at: '2026-11-13T10:00:00Z', rejections: [record('owner_method', 'MethodNameMismatch'), record('call_token', 'ReceiverMismatch', 'DepositWithFunctionCall')] }),
  );
  const params = (entry, rule, extra = {}) => ({ log: 'demo/logs/run.json', entry, expect_rule: rule, ...extra });
  const owner = await run('protocol_rejection', params('owner_method', 'MethodNameMismatch'), [], { root });
  assert.equal(owner.status, 'PASS', owner.detail);
  assert.match(owner.detail, /not re-derived/);
  const strict = await run('protocol_rejection', params('owner_method', 'MethodNameMismatch', { require_signed_tx: true }), [], { root });
  assert.equal(strict.status, 'FAIL');
  const disagree = await run('protocol_rejection', params('call_token', 'ReceiverMismatch'), [], { root });
  assert.equal(disagree.status, 'FAIL');
  assert.match(disagree.detail, /error_name is DepositWithFunctionCall/);
});

test("protocol_rejection: the attack demo's run log with signed bytes is re-derived, and its own statements must match the bytes", async () => {
  // demo/lib/log.ts RejectionRecord & SignedBytesRecord: the bytes sent, the local hash, sent_at,
  // and what the demo says it sent. The call_token attempt: ft_transfer on USDC, no deposit.
  const c = signedCase('agent-ft-transfer-no-deposit');
  const root = tempDir();
  mkdirSync(join(root, 'demo/logs'), { recursive: true });
  const entry = {
    phase: 'e',
    attempt: 'call_token',
    label: 'rejected before execution, no transaction',
    error_name: 'ReceiverMismatch',
    expected_error: 'ReceiverMismatch',
    rule_matched: true,
    rpc_error: rejectionError({ ReceiverMismatch: { tx_receiver: IDS.usdc, ak_receiver: IDS.vault } }),
    signed_tx_base64: c.signed_tx_base64,
    local_tx_hash: encode(Buffer.from(c.reference_hash_hex, 'hex')),
    sent_at: '2026-11-13T10:00:05Z',
    signer_id: c.signer_id,
    receiver_id: c.receiver_id,
    public_key: c.public_key,
    block_hash: encode(Buffer.from(c.block_hash_hex, 'hex')),
  };
  const write = (entries) => writeFileSync(join(root, 'demo/logs/run.json'), JSON.stringify({ run_id: 'run', started_at: '2026-11-13T10:00:00Z', txs: [], rejections: entries }));
  const params = { log: 'demo/logs/run.json', entry: 'call_token', expect_rule: 'ReceiverMismatch', signer_id: IDS.vault, public_key: signed.public_key, receiver_id: IDS.usdc, method_name: 'ft_transfer', require_signed_tx: true };
  const keys = [keyAtBlock(AGENT_PERMISSION, 'agent-ft-transfer-no-deposit')];
  write([entry]);
  const ok = await run('protocol_rejection', params, keys, { root });
  assert.equal(ok.status, 'PASS', ok.detail);
  assert.match(ok.detail, /\(2026-11-13T10:00:05Z\)/);
  assert.match(ok.detail, /signature valid; key at block .*so nearcore rejects it with ReceiverMismatch/);
  // The log describes one transaction and carries the bytes of another.
  write([{ ...entry, local_tx_hash: '11111111111111111111111111111111', receiver_id: IDS.vault }]);
  const lied = await run('protocol_rejection', params, keys, { root });
  assert.equal(lied.status, 'FAIL');
  assert.match(lied.detail, /the log's local_tx_hash is 1{32}, the signed bytes say /);
  assert.match(lied.detail, /the log's receiver_id is vault\.aid-demo-owner\.testnet, the signed bytes say 3e2210e1/);
  // A different rule fired first: the attempt does not show the claimed rule.
  write([{ ...entry, rule_matched: false, error_name: 'NotEnoughAllowance' }]);
  const other = await run('protocol_rejection', params, keys, { root });
  assert.equal(other.status, 'FAIL');
  assert.match(other.detail, /rule_matched false, error NotEnoughAllowance/);
  // Without the bytes, a claim that requires them FAILS.
  const { signed_tx_base64: _drop, ...noBytes } = entry;
  write([noBytes]);
  const bare = await run('protocol_rejection', params, keys, { root });
  assert.equal(bare.status, 'FAIL');
  assert.match(bare.detail, /does not keep the signed transaction/);
});

test('protocol_rejection: no attack log yet is pending, not a failure', async () => {
  await assert.rejects(run('protocol_rejection', rejectParams('x', 'DepositWithFunctionCall'), [], { root: tempDir() }), PendingError);
});

// ------------------------------------------------------------------ verdict_recompute

const SNAP_BLOCK = 277400000;
const SNAP_HASH = 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo';
const b64json = (value) => Buffer.from(JSON.stringify(value)).toString('base64');

/** Block-pinned reads in the SDK's snapshot shape (sdk/src/engine/types.ts RpcRecord). */
function snapshotReads() {
  return [
    {
      label: 'account',
      network: 'testnet',
      archival: true,
      method: 'query',
      params: { request_type: 'view_account', account_id: IDS.attacker, block_id: SNAP_BLOCK },
      result: { amount: '10000000000000000000000000', locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182, storage_paid_at: 0, block_height: SNAP_BLOCK, block_hash: SNAP_HASH },
    },
    { label: 'block', network: 'testnet', archival: true, method: 'block', params: { block_id: SNAP_BLOCK }, projection: 'header.height,header.hash', result: { header: { height: SNAP_BLOCK, hash: SNAP_HASH } } },
    {
      label: 'registry.get_verdict',
      network: 'testnet',
      archival: true,
      method: 'query',
      params: { request_type: 'call_function', account_id: IDS.registry, method_name: 'get_verdict', args_base64: b64json({ account_id: IDS.attacker }), block_id: SNAP_BLOCK },
      error: { name: 'HANDLER_ERROR', cause: 'UNKNOWN_ACCOUNT', message: 'account registry.a-identity.testnet does not exist while viewing' },
    },
    {
      label: 'third_party.down',
      network: 'testnet',
      archival: false,
      method: 'query',
      params: { request_type: 'call_function', account_id: 'some-registry.testnet', method_name: 'get_risk', args_base64: b64json({ account_id: IDS.attacker }), block_id: SNAP_BLOCK },
      error: { name: 'UNAVAILABLE', cause: 'UNAVAILABLE', message: 'no endpoint answered' },
    },
  ];
}

/** What archival RPC answers to those reads: whole answers (a block with its whole header, an
 *  account view with a field a newer node adds), so projection and subset matching are exercised. */
function archivalAnswers(reads) {
  return reads
    .filter((r) => r.error?.cause !== 'UNAVAILABLE')
    .map((r) => {
      const spec = { network: r.network, kind: 'archival', method: r.method, params: r.params };
      if (r.error) return call(spec, { error: { name: r.error.name, cause: { name: r.error.cause, info: {} }, code: -32000, message: 'Server error', data: r.error.message } });
      if (r.method === 'block') return call(spec, { result: { author: 'node0', header: { prev_hash: SNAP_HASH, timestamp_nanosec: '1794500000000000000', gas_price: '100000000', ...r.result.header }, chunks: [] } });
      return call(spec, { result: { ...r.result, global_contract_hash: null } });
    });
}

function recomputeRoot({ verdict = 'DENY', reasons = ['lookalike', 'new_account'], reads = snapshotReads() } = {}) {
  const root = tempDir();
  mkdirSync(join(root, 'sdk/src/cli'), { recursive: true });
  mkdirSync(join(root, 'evidence/snapshots'), { recursive: true });
  // A stand-in for the SDK's CLI with the documented contract: --offline <snapshot> --json prints
  // { account_id, verdict, reasons }. Plain JavaScript is valid TypeScript, so strip-types runs it.
  writeFileSync(
    join(root, 'sdk/src/cli/verdict.ts'),
    `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const snap = JSON.parse(readFileSync(args[args.indexOf('--offline') + 1], 'utf8'));
console.log(JSON.stringify({ account_id: snap.account_id, verdict: snap.expected_verdict, reasons: snap.expected_reasons }));
`,
  );
  const snapshot = JSON.stringify({ account_id: IDS.attacker, expected_verdict: verdict, expected_reasons: reasons, block_height: SNAP_BLOCK, network: 'testnet', rpc: reads, http: [{ label: 'fastnear.txs', source: 'fastnear' }] });
  writeFileSync(join(root, 'evidence/snapshots/attacker.json'), snapshot);
  return { root, sha: createHash('sha256').update(snapshot).digest('hex'), chain: archivalAnswers(snapshotReads()) };
}

function registryVerdict(view) {
  const spec = callFunctionSpec('testnet', IDS.registry, 'get_verdict', { account_id: IDS.attacker });
  return call(spec, { result: { result: [...Buffer.from(JSON.stringify(view))], logs: [], block_height: 277400010, block_hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' } });
}

const recomputeParams = { account_id: IDS.attacker, registry_id: IDS.registry, snapshot: 'evidence/snapshots/attacker.json', expect_verdict: 'DENY', compare_reasons: true };

test('verdict_recompute: the offline verdict equals the registry, bound by the snapshot hash, and the snapshot is the chain', async () => {
  const { root, sha, chain } = recomputeRoot();
  const view = { account_id: IDS.attacker, verdict: 'DENY', reasons: ['new_account', 'lookalike'], evidence: `sha256:${sha}`, updated_by: IDS.oracle };
  const result = await run('verdict_recompute', { ...recomputeParams, require_snapshot_binding: true }, [registryVerdict(view), ...chain], { root });
  assert.equal(result.status, 'PASS', result.detail);
  assert.match(result.detail, /its evidence names this snapshot \(sha256 [0-9a-f]{12}\.\.\.\)/);
  assert.match(result.detail, /3\/4 snapshot chain reads match archival RPC at their blocks \(1 not comparable: third_party\.down \(the oracle could not read it: UNAVAILABLE\)\), 1 indexer answer\(s\) not pinned/);
  assert.equal(result.observed.chain_reads.checked, 3);
});

test('verdict_recompute: a snapshot read that is not what archival RPC answers FAILS, even with a matching evidence string', async () => {
  // The oracle (or anyone) edits one recorded answer and writes the edited snapshot's hash on
  // chain: engine, hash and registry all agree, and only the chain itself disagrees.
  const reads = snapshotReads();
  reads[0].result.amount = '1';
  const { root, sha, chain } = recomputeRoot({ reads });
  const view = { verdict: 'DENY', reasons: ['new_account', 'lookalike'], evidence: `sha256:${sha}` };
  const result = await run('verdict_recompute', { ...recomputeParams, require_snapshot_binding: true }, [registryVerdict(view), ...chain], { root });
  assert.equal(result.status, 'FAIL');
  assert.match(result.detail, /snapshot read account \(query at block 277400000\): \$\.amount: recorded "1", archival gives "10000000000000000000000000"/);
  // An answer recorded as an error that archival gives as a result, and the other way round.
  const flipped = snapshotReads();
  flipped[2] = { ...flipped[2], error: undefined, result: { result: [...Buffer.from('null')], logs: [], block_height: SNAP_BLOCK, block_hash: SNAP_HASH } };
  const other = recomputeRoot({ reads: flipped });
  const r2 = await run('verdict_recompute', recomputeParams, [registryVerdict({ verdict: 'DENY', reasons: ['new_account', 'lookalike'], evidence: `sha256:${other.sha}` }), ...other.chain], { root: other.root });
  assert.equal(r2.status, 'FAIL');
  assert.match(r2.detail, /registry\.get_verdict .*recorded a result, archival gives UNKNOWN_ACCOUNT/);
});

test('verdict_recompute: a snapshot with no chain reads cannot be checked against the chain (FAIL unless the claim opts out)', async () => {
  const { root, sha } = recomputeRoot({ reads: [] });
  const view = { verdict: 'DENY', reasons: ['new_account', 'lookalike'], evidence: `sha256:${sha}` };
  const strict = await run('verdict_recompute', recomputeParams, [registryVerdict(view)], { root });
  assert.equal(strict.status, 'FAIL');
  assert.match(strict.detail, /records no chain reads/);
  const optedOut = await run('verdict_recompute', { ...recomputeParams, verify_chain_reads: false }, [registryVerdict(view)], { root });
  assert.equal(optedOut.status, 'PASS', optedOut.detail);
});

test('verdict_recompute: projection and subset matching follow the SDK recorder', () => {
  assert.deepEqual(projectPaths({ header: { height: 5, hash: 'h', prev_hash: 'p' }, chunks: [1] }, 'header.height,header.hash'), { header: { height: 5, hash: 'h' } });
  assert.equal(recordedDiff({ a: 1, b: [1, { c: 'x' }] }, { a: 1, b: [1, { c: 'x', extra: true }], more: 2 }), null);
  assert.match(recordedDiff({ b: [1, 2] }, { b: [1, 2, 3] }), /^\$\.b: recorded \[1,2\], archival gives \[1,2,3\]/);
  assert.match(recordedDiff({ a: { c: 1 } }, { a: null }), /^\$\.a: recorded an object/);
});

test('verdict_recompute: a Node without type stripping, or a CLI that outlives its time box, is SKIP', async () => {
  assert.equal(supportsStripTypes('22.5.1'), false);
  assert.equal(supportsStripTypes('20.18.0'), false);
  assert.equal(supportsStripTypes('v22.6.0'), true);
  assert.equal(supportsStripTypes('24.21.0'), true);
  const { root } = recomputeRoot();
  await assert.rejects(run('verdict_recompute', recomputeParams, [], { root, options: { nodeVersion: '20.11.1' } }), /Node 20\.11\.1 cannot run the TypeScript CLI; the recompute needs Node 22\.6 or later/);
  writeFileSync(join(root, 'sdk/src/cli/verdict.ts'), 'setTimeout(() => {}, 60000);\n');
  await assert.rejects(run('verdict_recompute', { ...recomputeParams, timeout_s: 1 }, [], { root }), /did not finish within its 1 s time box/);
});

test('verdict_recompute: the SDK CLI output shape (account, registry_reasons, evidence string) is read as the oracle writes it', async () => {
  const { root, chain } = recomputeRoot();
  const evidence = `near-snapshot sha256:${'b'.repeat(64)} block:277400000 engine:1.0.0`;
  writeFileSync(
    join(root, 'sdk/src/cli/verdict.ts'),
    `console.log(JSON.stringify({ account: '${IDS.attacker}', verdict: 'DENY', reasons: [{ code: 'lookalike', severity: 'deny' }, { code: 'note', severity: 'info' }], registry_reasons: ['lookalike'], snapshot_sha256: '${'b'.repeat(64)}', evidence: '${evidence}' }));\n`,
  );
  const ok = await run('verdict_recompute', { ...recomputeParams, require_snapshot_binding: true, snapshot_sha256: 'b'.repeat(64) }, [registryVerdict({ verdict: 'DENY', reasons: ['lookalike'], evidence }), ...chain], { root });
  assert.equal(ok.status, 'PASS', ok.detail);
  const otherBlock = await run('verdict_recompute', recomputeParams, [registryVerdict({ verdict: 'DENY', reasons: ['lookalike'], evidence: evidence.replace('277400000', '277400001') }), ...chain], { root });
  assert.equal(otherBlock.status, 'FAIL');
  assert.match(otherBlock.detail, /differs from the recomputed/);
  const unbound = await run('verdict_recompute', { ...recomputeParams, require_snapshot_binding: true }, [registryVerdict({ verdict: 'DENY', reasons: ['lookalike'], evidence: 'https://example.invalid' }), ...chain], { root });
  assert.equal(unbound.status, 'FAIL');
  assert.match(unbound.detail, /does not name the snapshot sha256/);
});

test('verdict_recompute: integration with the real SDK CLI and one of its recorded snapshots', async (t) => {
  const snapshot = 'sdk/test/fixtures/snapshot-merchant.testnet.json';
  if (!existsSync(join(NEAR_ROOT, 'sdk/src/cli/verdict.ts')) || !existsSync(join(NEAR_ROOT, snapshot))) {
    t.skip('the SDK CLI or its fixture is not in this tree');
    return;
  }
  // Learn what the CLI computes, then hand the judge a registry that wrote exactly that: what is
  // under test is that the judge reads the real CLI's output format and the real snapshot's reads,
  // not the verdict itself. Archival RPC is played by the snapshot's own recorded answers.
  const cli = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', 'sdk/src/cli/verdict.ts', '--offline', snapshot, '--json'], { cwd: NEAR_ROOT, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const out = JSON.parse(cli.stdout);
  const reads = JSON.parse(readFileSync(join(NEAR_ROOT, snapshot), 'utf8')).rpc;
  const chain = archivalAnswers(reads);
  const spec = callFunctionSpec('testnet', IDS.registry, 'get_verdict', { account_id: out.account });
  const answer = (view) => call(spec, { result: { result: [...Buffer.from(JSON.stringify(view))], logs: [], block_height: 277400010, block_hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' } });
  const params = { account_id: out.account, registry_id: IDS.registry, snapshot, expect_verdict: out.verdict, compare_reasons: true, require_snapshot_binding: true };
  const same = await run('verdict_recompute', params, [answer({ verdict: out.verdict, reasons: out.registry_reasons, evidence: out.evidence }), ...chain]);
  assert.equal(same.status, 'PASS', same.detail);
  assert.ok(same.observed.chain_reads.checked >= 10, `checked ${same.observed.chain_reads.checked} reads`);
  const flipped = await run('verdict_recompute', params, [answer({ verdict: out.verdict === 'DENY' ? 'ALLOW' : 'DENY', reasons: out.registry_reasons, evidence: out.evidence }), ...chain]);
  assert.equal(flipped.status, 'FAIL');
});

test('verdict_recompute: a different verdict, different reasons or a different snapshot hash FAIL', async () => {
  const { root, sha, chain } = recomputeRoot();
  const base = { account_id: IDS.attacker, verdict: 'DENY', reasons: ['new_account', 'lookalike'], evidence: `sha256:${sha}` };
  const warn = await run('verdict_recompute', recomputeParams, [registryVerdict({ ...base, verdict: 'WARN' }), ...chain], { root });
  assert.equal(warn.status, 'FAIL');
  assert.match(warn.detail, /recomputed DENY, registry says WARN/);
  const reasons = await run('verdict_recompute', recomputeParams, [registryVerdict({ ...base, reasons: ['lookalike'] }), ...chain], { root });
  assert.equal(reasons.status, 'FAIL');
  const other = await run('verdict_recompute', recomputeParams, [registryVerdict({ ...base, evidence: `sha256:${'a'.repeat(64)}` }), ...chain], { root });
  assert.equal(other.status, 'FAIL');
  assert.match(other.detail, /names snapshot sha256 a{64}, the recomputed snapshot is/);
  const none = await run('verdict_recompute', recomputeParams, [registryVerdict(null), ...chain], { root });
  assert.equal(none.status, 'FAIL');
  assert.match(none.detail, /no live verdict/);
});

test('verdict_recompute: no SDK CLI yet is SKIP', async () => {
  await assert.rejects(run('verdict_recompute', recomputeParams, [], { root: tempDir() }), SkipError);
});

// ------------------------------------------------------------------ counter_matches_events

const READ_BLOCK = 277400100;

function counterView(method, payee, value, block = READ_BLOCK) {
  return call(callFunctionSpec('testnet', IDS.vault, method, { payee }, block), {
    result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: block, block_hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' },
  });
}

/** A synthetic refusal recorded by the agent's guard: record_refusal, source agent_guard. */
function guardRefusal(payee, salt) {
  const tx = syntheticPay({ payee, outcome: 'refused', reason: 'lookalike_new_account', verdict: 'DENY', method: 'record_refusal', salt });
  for (const receipt of tx.result.receipts_outcome) {
    receipt.outcome.logs = receipt.outcome.logs.map((log) => log.replace('"source":"registry"', '"source":"agent_guard"'));
  }
  return tx;
}

const counterParams = (method, payee, data, extra = {}) => ({
  account_id: IDS.vault,
  method,
  args: { payee },
  block_id: READ_BLOCK,
  event: { standard: 'a_identity_vault', event: data.event, executor_id: IDS.vault, data: data.data },
  ...extra,
});

test('counter_matches_events: paid_count equals the payment_sent events of the demo transactions, one by the owner', async () => {
  const setup = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: null, signer: IDS.owner, method: 'owner_pay', salt: 'setup' });
  const known = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW', salt: 'known' });
  const transactions = { setup_owner_pay: { tx_hash: setup.tx_hash, signer_id: IDS.owner }, pay_known: { tx_hash: known.tx_hash, signer_id: IDS.vault }, later: { tx_hash: null, signer_id: IDS.vault } };
  const chain = [...syntheticTxCalls(setup, IDS.owner, 277400010), ...syntheticTxCalls(known, IDS.vault, 277400050)];
  const params = counterParams('paid_count', IDS.merchant, { event: 'payment_sent', data: { payee: IDS.merchant } }, { transactions, min: 2, include: { data: { by_owner: true } } });
  const ok = await run('counter_matches_events', params, [counterView('paid_count', IDS.merchant, 2), ...chain]);
  assert.equal(ok.status, 'PASS', ok.detail);
  assert.match(ok.detail, /paid_count\(\{"payee":"aid-demo-merchant\.testnet"\}\) on vault\.aid-demo-owner\.testnet at block 277400100 = 2, exactly the 2 a_identity_vault:payment_sent/);
  assert.match(ok.detail, /setup_owner_pay \(block 277400010\), pay_known \(block 277400050\)/);
  // A counter that also counts something these transactions do not show.
  const more = await run('counter_matches_events', params, [counterView('paid_count', IDS.merchant, 3), ...chain]);
  assert.equal(more.status, 'FAIL');
  assert.match(more.detail, /is 3 at block 277400100, but the 2 demo transaction\(s\) hold 2 .*counts something these transactions do not show/);
  // No owner approval among the events.
  const agentOnly = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW', salt: 'again' });
  const noOwner = await run(
    'counter_matches_events',
    { ...params, transactions: { a: { tx_hash: known.tx_hash, signer_id: IDS.vault }, b: { tx_hash: agentOnly.tx_hash, signer_id: IDS.vault } } },
    [counterView('paid_count', IDS.merchant, 2), ...syntheticTxCalls(known, IDS.vault, 277400050), ...syntheticTxCalls(agentOnly, IDS.vault, 277400060)],
  );
  assert.equal(noOwner.status, 'FAIL');
  assert.match(noOwner.detail, /none of the 2 matching event\(s\) also matches \{"by_owner":true\}/);
});

test('counter_matches_events: the two refusal counters each equal their own kind of event, so neither counts the other', async () => {
  const look = 'aid-demo-merchamt.testnet';
  const payDeny = syntheticPay({ payee: look, outcome: 'refused', reason: 'RegistryDeny', verdict: 'DENY', salt: 'pay' });
  const ownerDeny = syntheticPay({ payee: look, outcome: 'refused', reason: 'RegistryDeny', verdict: 'DENY', signer: IDS.owner, method: 'owner_pay', salt: 'owner' });
  const guard = guardRefusal(look, 'guard');
  const transactions = { guard_refusal: { tx_hash: guard.tx_hash, signer_id: IDS.vault }, pay_deny: { tx_hash: payDeny.tx_hash, signer_id: IDS.vault }, owner_pay_denied: { tx_hash: ownerDeny.tx_hash, signer_id: IDS.owner } };
  const chain = [...syntheticTxCalls(guard, IDS.vault, 277400020), ...syntheticTxCalls(payDeny, IDS.vault, 277400030), ...syntheticTxCalls(ownerDeny, IDS.owner, 277400040)];
  const registryParams = counterParams('refusal_count', look, { event: 'payment_refused', data: { payee: look, reason: 'RegistryDeny', source: 'registry' } }, { transactions, min: 2 });
  const guardParams = counterParams('guard_refusal_count', look, { event: 'payment_refused', data: { payee: look, source: 'agent_guard' } }, { transactions, min: 1 });
  const registry = await run('counter_matches_events', registryParams, [counterView('refusal_count', look, 2), ...chain]);
  assert.equal(registry.status, 'PASS', registry.detail);
  const guarded = await run('counter_matches_events', guardParams, [counterView('guard_refusal_count', look, 1), ...chain]);
  assert.equal(guarded.status, 'PASS', guarded.detail);
  // A vault whose counters mixed both kinds would read 3 and 3: both claims FAIL.
  const mixedGuard = await run('counter_matches_events', guardParams, [counterView('guard_refusal_count', look, 3), ...chain]);
  assert.equal(mixedGuard.status, 'FAIL');
  const mixedRegistry = await run('counter_matches_events', registryParams, [counterView('refusal_count', look, 3), ...chain]);
  assert.equal(mixedRegistry.status, 'FAIL');
});

test('counter_matches_events: transactions come from deployments and the demo log, a late or unknown one FAILS, min is enforced', async () => {
  const look = 'aid-demo-merchamt.testnet';
  const payDeny = syntheticPay({ payee: look, outcome: 'refused', reason: 'RegistryDeny', verdict: 'DENY', salt: 'p' });
  const split = syntheticPay({ payee: look, outcome: 'refused', reason: 'RegistryDeny', verdict: 'DENY', salt: 's1' });
  const root = tempDir();
  mkdirSync(join(root, 'demo/logs'), { recursive: true });
  // The run log lists the split payment (and the first one again: listed twice, counted once).
  writeFileSync(join(root, 'demo/logs/run.json'), JSON.stringify({ txs: [{ phase: 'e', step: 'split pay 1/3', tx_hash: split.tx_hash, signer_id: IDS.vault }, { phase: 'c', step: 'retry', tx_hash: payDeny.tx_hash, signer_id: IDS.vault }] }));
  const params = counterParams('refusal_count', look, { event: 'payment_refused', data: { payee: look, reason: 'RegistryDeny', source: 'registry' } }, { transactions: { pay_deny: { tx_hash: payDeny.tx_hash, signer_id: IDS.vault } }, logs: ['demo/logs/run.json'], min: 1 });
  const chain = [...syntheticTxCalls(payDeny, IDS.vault, 277400030), ...syntheticTxCalls(split, IDS.vault, 277400090)];
  const ok = await run('counter_matches_events', params, [counterView('refusal_count', look, 2), ...chain], { root });
  assert.equal(ok.status, 'PASS', ok.detail);
  assert.match(ok.detail, /in the 2 demo transaction\(s\)/);
  assert.match(ok.detail, /demo\/logs\/run\.json e\/split pay 1\/3 \(block 277400090\)/);
  // The split payment executed after the block the counter was read at.
  const late = await run('counter_matches_events', params, [counterView('refusal_count', look, 2), ...syntheticTxCalls(payDeny, IDS.vault, 277400030), ...syntheticTxCalls(split, IDS.vault, 277400500)], { root });
  assert.equal(late.status, 'FAIL');
  assert.match(late.detail, /emitted it in block 277400500, after block 277400100 where the counter was read/);
  // A transaction archival RPC does not know.
  const unknown = await run('counter_matches_events', { ...params, logs: [], transactions: { x: { tx_hash: '11111111111111111111111111111111', signer_id: IDS.vault } } }, [counterView('refusal_count', look, 0), call(txStatusSpec('testnet', '11111111111111111111111111111111', IDS.vault), { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} }, code: -32000, message: 'Server error' } })], { root });
  assert.equal(unknown.status, 'FAIL');
  assert.match(unknown.detail, /archival RPC answers UNKNOWN_TRANSACTION/);
  // Nothing happened at all: 0 equals 0, but the claim needs at least 1.
  const empty = await run('counter_matches_events', { ...params, logs: [], transactions: {} }, [counterView('refusal_count', look, 0)], { root });
  assert.equal(empty.status, 'FAIL');
  assert.match(empty.detail, /needs at least 1/);
  // A log that deployments names but the tree does not hold.
  const missing = await run('counter_matches_events', { ...params, logs: ['demo/logs/nope.json'] }, [], { root });
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.detail, /not in the tree/);
});

// ------------------------------------------------------------------ local checks

/** A fresh ed25519 key pair in NEAR's encoding, made at run time: no secret-shaped string is
 *  ever committed with these tests. */
function nearKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, secret: `ed25519:${encode(Buffer.concat([seed, pub]))}`, publicKey: `ed25519:${encode(pub)}` };
}

test('repo_secret_scan: a clean tree passes, a NEAR secret key or a private_key field fails', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'ok.json'), JSON.stringify({ public_key: IDS.agentKey, signature: 'ed25519-signature-sha256:ab' }));
  const clean = await run('repo_secret_scan', {}, [], { root });
  assert.equal(clean.status, 'PASS', clean.detail);
  const { secret } = nearKeyPair();
  writeFileSync(join(root, 'leak.txt'), `NEAR_KEY=${secret}\n`);
  const leaked = await run('repo_secret_scan', {}, [], { root });
  assert.equal(leaked.status, 'FAIL');
  assert.match(leaked.detail, /leak\.txt: NEAR ed25519 secret key/);
});

test('repo_secret_scan: a raw transaction signature is not a secret key (it was a false FAIL)', async () => {
  // An SDK fixture keeps a real recorded EXPERIMENTAL_tx_status answer, whose transaction carries
  // its 64-byte signature as "ed25519:<base58>": the same shape as a secret key.
  const root = tempDir();
  const pair = nearKeyPair();
  const signature = `ed25519:${encode(sign(null, Buffer.from('a transaction hash'), pair.privateKey))}`;
  writeFileSync(join(root, 'tx-fixture.json'), JSON.stringify({ transaction: { public_key: pair.publicKey, signature } }, null, 2));
  writeFileSync(join(root, 'random.txt'), `ed25519:${encode(randomBytes(64))}\n`);
  const result = await run('repo_secret_scan', {}, [], { root });
  assert.equal(result.status, 'PASS', result.detail);
  assert.match(result.detail, /2 other 64-byte ed25519 value\(s\), signatures by structure/);
  // The structural test itself, both ways.
  assert.deepEqual(ed25519SecretsIn(`${pair.secret} ${signature}`), { keys: 1, others: 1 });
  assert.equal(isEd25519SecretKey(randomBytes(64)), false);
  assert.equal(isEd25519SecretKey(randomBytes(32)), false);
});

test('git_window: a directory that is not a checkout is SKIP, never PASS', async () => {
  await assert.rejects(run('git_window', { since: '2026-10-19T00:00:00Z' }, [], { root: tempDir() }), SkipError);
});

/** A throwaway repository in the OS temp dir (never the project's): an old file tagged
 *  pre-hackathon, then near/ files committed at the given dates. ctx.root is its near/. */
function windowRepo({ nearDates, tagNearFirst = false, tag = true }) {
  const repo = tempDir('judge-test-git-');
  const git = (args, date) => {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) };
    const out = spawnSync('git', ['-c', 'user.name=judge-test', '-c', 'user.email=judge-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'init.defaultBranch=main', '-C', repo, ...args], { encoding: 'utf8', env });
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  };
  git(['init', '-q']);
  writeFileSync(join(repo, 'old.txt'), 'before the hackathon\n');
  git(['add', 'old.txt']);
  git(['commit', '-q', '-m', 'old'], '2026-09-01T00:00:00Z');
  mkdirSync(join(repo, 'near'), { recursive: true });
  nearDates.forEach((date, i) => {
    writeFileSync(join(repo, `near/f${i}.txt`), `${i}\n`);
    git(['add', `near/f${i}.txt`]);
    git(['commit', '-q', '-m', `near ${i}`], date);
    if (i === 0 && tagNearFirst && tag) git(['tag', 'pre-hackathon']);
  });
  if (tag && !tagNearFirst) git(['tag', 'pre-hackathon', 'HEAD~' + nearDates.length]);
  return join(repo, 'near');
}

const windowParams = { since: '2026-10-19T00:00:00Z', until: '2026-11-14T23:59:59Z', baseline_tag: 'pre-hackathon', compare_url: 'https://example.invalid/compare' };

test('git_window: both halves checked is PASS; a missing tag is SKIP, never a half-checked PASS', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not installed');
    return;
  }
  const dates = ['2026-11-12T05:25:46+03:00', '2026-11-12T05:51:22+03:00'];
  const full = await run('git_window', windowParams, [], { root: windowRepo({ nearDates: dates }) });
  assert.equal(full.status, 'PASS', full.detail);
  assert.match(full.detail, /2 commit\(s\) touch near\/.*nothing under near\/ exists at tag pre-hackathon \([0-9a-f]{10}\)/);
  await assert.rejects(
    run('git_window', windowParams, [], { root: windowRepo({ nearDates: dates, tag: false }) }),
    /tag pre-hackathon is not in this clone, so "nothing under near\/ exists at pre-hackathon" cannot be checked here \(git fetch --tags, or see https:\/\/example\.invalid\/compare\); the window part holds: 2 commit/,
  );
});

test('git_window: a commit outside the window or near/ files at the baseline tag FAIL', async (t) => {
  if (spawnSync('git', ['--version']).status !== 0) {
    t.skip('git is not installed');
    return;
  }
  const early = await run('git_window', windowParams, [], { root: windowRepo({ nearDates: ['2026-10-01T00:00:00Z', '2026-11-12T00:00:00Z'] }) });
  assert.equal(early.status, 'FAIL');
  assert.match(early.detail, /dated 2026-10-01/);
  // Outside the window AND no tag: still FAIL (the half that was checked disagrees).
  const earlyNoTag = await run('git_window', windowParams, [], { root: windowRepo({ nearDates: ['2026-10-01T00:00:00Z'], tag: false }) });
  assert.equal(earlyNoTag.status, 'FAIL');
  const tagged = await run('git_window', windowParams, [], { root: windowRepo({ nearDates: ['2026-11-01T00:00:00Z', '2026-11-12T00:00:00Z'], tagNearFirst: true }) });
  assert.equal(tagged.status, 'FAIL');
  assert.match(tagged.detail, /1 commit\(s\) touching near\/ are already in pre-hackathon/);
});

test('command: parses node --test output, enforces exit codes, time boxes and tool checks', async () => {
  const root = tempDir();
  const ok = await run('command', { cmd: ['{node}', '-e', "console.log('# pass 3'); console.log('# fail 0')"], parse: 'node-test', timeout_s: 30 }, [], { root });
  assert.equal(ok.status, 'PASS', ok.detail);
  assert.match(ok.detail, /3 passed, 0 failed/);
  const red = await run('command', { cmd: ['{node}', '-e', "console.log('# pass 2'); console.log('# fail 1'); process.exit(1)"], parse: 'node-test', timeout_s: 30 }, [], { root });
  assert.equal(red.status, 'FAIL');
  const none = await run('command', { cmd: ['{node}', '-e', "console.log('nothing')"], parse: 'cargo-test', timeout_s: 30 }, [], { root });
  assert.equal(none.status, 'FAIL');
  assert.match(none.detail, /ran no tests/);
  // A time box that expires is SKIP (it did not run to the end here), never FAIL.
  await assert.rejects(run('command', { cmd: ['{node}', '-e', 'setTimeout(() => {}, 60000)'], parse: 'exit-code', timeout_s: 1 }, [], { root }), /did not finish within its 1 s time box/);
  await assert.rejects(run('command', { cmd: ['x'], requires_bin: ['definitely-not-a-real-tool-4242'] }, [], { root }), SkipError);
  await assert.rejects(run('command', { cmd: ['x'], platforms: ['plan9-mips'] }, [], { root }), SkipError);
  await assert.rejects(run('command', { cmd: ['x'], script: 'contracts/audit/missing.mjs' }, [], { root }), SkipError);
  await assert.rejects(run('command', { cmd: ['x'], requires_path: ['node_modules'], install_hint: 'run npm ci' }, [], { root }), /run npm ci/);
});

test('test-count parsers read cargo and both node --test reporters', () => {
  const cargo = 'test result: ok. 134 passed; 0 failed; 0 ignored\ntest result: FAILED. 140 passed; 2 failed; 1 ignored';
  assert.deepEqual(parseCargoTest(cargo), { passed: 274, failed: 2, suites: 2 });
  assert.deepEqual(parseNodeTest('# tests 5\n# pass 5\n# fail 0\n'), { passed: 5, failed: 0, suites: 1 });
  assert.deepEqual(parseNodeTest('\u2139 tests 4\n\u2139 pass 3\n\u2139 fail 1\n'), { passed: 3, failed: 1, suites: 1 });
});

test('command: compare_files proves a rebuild matches the committed artifact', async () => {
  const root = tempDir();
  writeFileSync(join(root, 'built.wasm'), 'same bytes');
  writeFileSync(join(root, 'committed.wasm'), 'same bytes');
  writeFileSync(join(root, 'other.wasm'), 'other bytes');
  const same = await run('command', { cmd: ['{node}', '-e', '0'], parse: 'exit-code', compare_files: [{ built: 'built.wasm', committed: 'committed.wasm' }] }, [], { root });
  assert.equal(same.status, 'PASS', same.detail);
  const diff = await run('command', { cmd: ['{node}', '-e', '0'], parse: 'exit-code', compare_files: [{ built: 'built.wasm', committed: 'other.wasm' }] }, [], { root });
  assert.equal(diff.status, 'FAIL');
});

// ------------------------------------------------------------------ engine: every outcome is one status

const DEPLOYMENTS = { data: { status: 'pending', accounts: { a: { account_id: 'a-identity.testnet' } }, pending: { tx: null } }, rel: 'deployments/testnet.json' };
const env = (transport, extra = {}) => ({ root: tempDir(), deployments: DEPLOYMENTS, mode: 'online', transportFor: () => transport, ...extra });
const claim = (params, extra = {}) => ({ id: 'c1', claim: 'a claim under test', check: 'account_exists', params, ...extra });

test('engine: a null template is pending (SKIP), never PASS', async () => {
  const result = await evaluateClaim(claim({ account_id: '${pending.tx}' }), env({ call: () => assert.fail('must not reach the network') }));
  assert.equal(result.status, 'SKIP');
  assert.match(result.detail, /pending: pending\.tx is not recorded in deployments\/testnet\.json yet/);
  const required = await evaluateClaim(claim({ account_id: '${accounts.a.account_id}' }, { requires: ['pending.tx'] }), env({ call: () => assert.fail('must not reach the network') }));
  assert.equal(required.status, 'SKIP');
});

test('engine: no network is SKIP with the reason; a judge bug is FAIL', async () => {
  const offline = { call: async () => { throw new NetworkError('no answer from testnet state RPC (rpc.testnet.fastnear.com: ENOTFOUND)'); } };
  const skipped = await evaluateClaim(claim({ account_id: '${accounts.a.account_id}' }), env(offline));
  assert.equal(skipped.status, 'SKIP');
  assert.match(skipped.detail, /network: .*ENOTFOUND.*try --offline/);
  const broken = { call: async () => { throw new TypeError('boom'); } };
  const failed = await evaluateClaim(claim({ account_id: '${accounts.a.account_id}' }), env(broken));
  assert.equal(failed.status, 'FAIL');
  assert.match(failed.detail, /judge error/);
});

test('engine: signatures in answers are stored as digests', async () => {
  const tx = syntheticPay({ payee: IDS.merchant, outcome: 'sent', verdict: 'ALLOW' });
  const realSig = `ed25519:${encode(randomBytes(64))}`;
  tx.result.transaction.signature = realSig;
  const calls = syntheticTxCalls(tx);
  const result = await evaluateClaim(
    { id: 'c2', claim: 'a tx claim under test', check: 'tx_outcome', params: { tx_hash: tx.tx_hash, sender_account_id: IDS.vault, expect: { status: 'success' } } },
    env({ call: async (spec) => structuredClone(calls.find((c) => c.request.method === spec.method)) }),
  );
  assert.equal(result.status, 'PASS', result.detail);
  const stored = JSON.stringify(result.raw_calls);
  assert.doesNotMatch(stored, new RegExp(realSig.slice(8)));
  assert.match(stored, /ed25519-signature-sha256:[0-9a-f]{64}/);
});

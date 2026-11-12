import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, test } from 'node:test';
import {
  akNonceOf,
  anyTransferTo,
  classifyRpcError,
  describePlan,
  eventItems,
  fnCall,
  keySender,
  nep141Transfers,
  noKeySender,
  parseOutcome,
  payOutcomeOf,
  preparedCall,
  settlementSeen,
  vaultEvents,
} from '../lib/chain.ts';
import type { NearApi, TxPlan } from '../lib/chain.ts';
import { GAS, ONE_YOCTO } from '../lib/config.ts';
import type { LoadedKey } from '../lib/keys.ts';
import { createRpc } from '../lib/rpc.ts';
import type { FetchLike } from '../lib/rpc.ts';
import { ACC, ACCESS_KEY_ERRORS, eventLine, invalidTx, loadFixture, TOKEN, txResult } from './helpers.ts';

const FAUCET = '641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5';

describe('outcome parsing on a RECORDED testnet transaction', () => {
  const o = parseOutcome(loadFixture('tx-usdc-faucet-transfer.json'));

  test('reads hash, signer, receiver and the final status', () => {
    assert.equal(o.txHash, 'D6Jp1Ho17KbwV5KDzcdE9RooKG6YFcZRRpap7RiNaV84');
    assert.equal(o.signerId, FAUCET);
    assert.equal(o.receiverId, TOKEN);
    assert.equal(o.finalExecutionStatus, 'FINAL');
    assert.equal(o.success, true);
    assert.ok(o.gasBurnt > 0n);
  });

  test('finds the NEP-141 ft_transfer the token itself logged', () => {
    assert.deepEqual(nep141Transfers(o, TOKEN), [{ executorId: TOKEN, old_owner_id: FAUCET, new_owner_id: ACC.owner, amount: '20000000' }]);
    assert.equal(settlementSeen(o, TOKEN, FAUCET, ACC.owner, '20000000'), true);
    assert.equal(settlementSeen(o, TOKEN, FAUCET, ACC.owner, '20000001'), false, 'the exact amount');
    assert.equal(anyTransferTo(o, TOKEN, ACC.lookalike), false);
  });

  test('a transfer event logged by any other contract proves nothing', () => {
    assert.equal(nep141Transfers(o, 'usdc.fakes.testnet').length, 0);
    assert.equal(settlementSeen(o, 'usdc.fakes.testnet', FAUCET, ACC.owner, '20000000'), false);
  });
});

describe('outcome parsing on constructed vault outcomes (contract event ABI)', () => {
  test('a refusal is a successful call whose PayOutcome says refused, with no transfer', () => {
    const raw = txResult({
      hash: 'H1',
      signer: ACC.vault,
      receiver: ACC.vault,
      returnValue: { status: 'refused', payment_id: '7', reason: 'RegistryDeny', held_id: null },
      logs: [{ executor: ACC.vault, lines: [eventLine('a_identity_vault', 'payment_refused', { payment_id: '7', payee: ACC.lookalike, amount: '500000', reason: 'RegistryDeny', source: 'registry', registry_reasons: ['lookalike_new_account'] })] }],
    });
    const o = parseOutcome(raw);
    assert.equal(o.success, true);
    assert.deepEqual(payOutcomeOf(o), { status: 'refused', payment_id: '7', reason: 'RegistryDeny', held_id: null });
    assert.equal(anyTransferTo(o, TOKEN, ACC.lookalike), false);
    const ev = vaultEvents(o, ACC.vault);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]?.event, 'payment_refused');
    assert.equal(ev[0]?.data.source, 'registry');
  });

  test('a token receipt that FAILED does not count as settlement', () => {
    const raw = txResult({
      hash: 'H2',
      signer: ACC.vault,
      receiver: ACC.vault,
      returnValue: { status: 'failed', payment_id: '8', reason: 'TransferFailed', held_id: null },
      logs: [
        { executor: ACC.vault, lines: [] },
        { executor: TOKEN, lines: [eventLine('nep141', 'ft_transfer', [{ old_owner_id: ACC.vault, new_owner_id: ACC.merchant, amount: '1' }])], failed: true },
      ],
    });
    assert.equal(settlementSeen(parseOutcome(raw), TOKEN, ACC.vault, ACC.merchant, '1'), false);
  });

  test('a non-PayOutcome return value is not mistaken for one', () => {
    const o = parseOutcome(txResult({ hash: 'H3', signer: ACC.oracle, receiver: ACC.registry, logs: [] }));
    assert.equal(payOutcomeOf(o), null);
    assert.equal(parseOutcome(txResult({ hash: 'H4', signer: 'a', receiver: 'b', returnValue: { status: 'paid' }, logs: [] })).returnValue !== null, true);
    assert.equal(payOutcomeOf(parseOutcome(txResult({ hash: 'H4', signer: 'a', receiver: 'b', returnValue: { status: 'paid' }, logs: [] }))), null);
  });

  test('event data: near-sdk emits one object, NEP-141 an array; both read as a list', () => {
    assert.deepEqual(eventItems({ a: 1 }), [{ a: 1 }]);
    assert.deepEqual(eventItems([{ a: 1 }, { b: 2 }]), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(eventItems('x'), []);
  });

  test('a malformed EVENT_JSON line is ignored, not fatal', () => {
    const o = parseOutcome(txResult({ hash: 'H5', signer: 'a', receiver: 'b', logs: [{ executor: 'b', lines: ['EVENT_JSON:{not json', 'plain log line'] }] }));
    assert.equal(o.events.length, 0);
    // receipts[0] is the transaction's own outcome; the contract's receipt follows it.
    assert.deepEqual(o.receipts[1]?.logs, ['EVENT_JSON:{not json', 'plain log line']);
  });
});

describe('RPC error classification', () => {
  for (const [name, inner] of Object.entries(ACCESS_KEY_ERRORS)) {
    test(`INVALID_TRANSACTION ${name} is a rejection before execution`, () => {
      const c = classifyRpcError(invalidTx(inner));
      assert.equal(c.kind, 'invalid_tx');
      assert.equal(c.name, name);
    });
  }
  test('struct variants keep their detail', () => {
    const c = classifyRpcError(invalidTx(ACCESS_KEY_ERRORS.MethodNameMismatch));
    assert.equal(c.kind, 'invalid_tx');
    assert.deepEqual(c.kind === 'invalid_tx' ? c.detail : null, { method_name: 'set_registry' });
  });
  test('NotEnoughAllowance and InvalidNonce are named too', () => {
    assert.equal(classifyRpcError(invalidTx({ InvalidAccessKeyError: { NotEnoughAllowance: { account_id: ACC.vault, public_key: 'ed25519:x', allowance: '1', cost: '2' } } })).name, 'NotEnoughAllowance');
    const nonce = classifyRpcError(invalidTx({ InvalidNonce: { tx_nonce: 1, ak_nonce: 2 } }));
    assert.equal(nonce.name, 'InvalidNonce');
    assert.equal(akNonceOf(nonce.kind === 'invalid_tx' ? nonce.detail : null), 2n);
    assert.equal(akNonceOf({ Expired: null }), null);
  });
  test('timeouts and unknown transactions are not rejections', () => {
    assert.equal(classifyRpcError({ name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } }).kind, 'timeout');
    assert.equal(classifyRpcError({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } }).kind, 'unknown_tx');
    assert.equal(classifyRpcError({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } }).kind, 'other');
  });
});

describe('prepared calls', () => {
  const plan: TxPlan = { signerId: ACC.owner, receiverId: ACC.vault, actions: [fnCall('owner_pay', { held_id: '3' }, GAS.ownerPay, ONE_YOCTO)] };
  test('carry exact gas and deposit as decimal strings and no key material', () => {
    const p = preparedCall(plan);
    assert.deepEqual(p, {
      signer_id: ACC.owner,
      receiver_id: ACC.vault,
      actions: [{ type: 'FunctionCall', params: { methodName: 'owner_pay', args: { held_id: '3' }, gas: '100000000000000', deposit: '1' } }],
    });
    assert.match(describePlan(plan), /owner_pay\(\{"held_id":"3"\}\) gas 100 Tgas, deposit 1 yocto/);
  });
  test('the no-key sender returns the prepared call and never throws', async () => {
    const r = await noKeySender('no owner key').send(plan);
    assert.equal(r.kind, 'prepared');
    assert.equal(r.kind === 'prepared' ? r.reason : '', 'no owner key');
  });
});

// -- the key sender, with a fake near-api-js and a fake RPC -----------------------------------------

function fakeNear(publicKey: string): NearApi & { signed: unknown[] } {
  const signed: unknown[] = [];
  return {
    signed,
    createTransaction: (signerId, pk, receiverId, nonce, actions, blockHash) => ({ signerId, pk, receiverId, nonce, actions, blockHash }),
    KeyPairSigner: {
      fromSecretKey: () => ({
        getPublicKey: async () => ({ toString: () => publicKey }),
        signTransaction: async (tx: unknown) => {
          signed.push(tx);
          return { txHash: new Uint8Array([1, 2, 3]), signedTransaction: { encode: () => new Uint8Array([9, 9]) } };
        },
      }),
    },
    PublicKey: { fromString: (s: string) => s },
    KeyPair: { fromRandom: () => ({ getPublicKey: () => ({ toString: () => 'ed25519:orphan' }) }) },
    actions: { functionCall: (m, a, g, d) => ({ m, a, g, d }), transfer: (d) => ({ transfer: d }), addFullAccessKey: (pk) => ({ addKey: pk }) },
    baseDecode: () => new Uint8Array(32),
    baseEncode: () => 'TxHashBase58',
  };
}

function rpcWith(handler: (method: string, params: Record<string, unknown>) => { result?: unknown; error?: unknown }): { rpc: ReturnType<typeof createRpc>; methods: string[] } {
  const methods: string[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body ?? '{}') as { method: string; params: Record<string, unknown> };
    methods.push(body.method);
    const r = handler(body.method, body.params);
    return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, ...r }) };
  };
  return { rpc: createRpc({ readUrls: ['https://r1'], sendUrl: 'https://s', archivalUrl: 'https://a', fetchImpl, rounds: 0 }), methods };
}

const KEY: LoadedKey = { role: 'agent', accountId: ACC.vault, publicKey: 'ed25519:Agent', path: '/tmp/k.json', secret: () => 'ed25519:secret' };
const PAY: TxPlan = { signerId: ACC.vault, receiverId: ACC.vault, actions: [fnCall('pay', { payee: ACC.merchant, amount: '500000', memo: 'm' }, GAS.agentPay)] };

describe('key sender', () => {
  test('signs, sends once, then reads the FINAL status by hash', async () => {
    const final = txResult({ hash: 'TxHashBase58', signer: ACC.vault, receiver: ACC.vault, returnValue: { status: 'sent', payment_id: '1', reason: null, held_id: null }, logs: [] });
    const { rpc, methods } = rpcWith((m) => {
      if (m === 'query') return { result: { nonce: 5, permission: 'FullAccess', block_hash: 'b', block_height: 1 } };
      if (m === 'block') return { result: { header: { hash: '11111111111111111111111111111111', height: 10 } } };
      if (m === 'send_tx') return { result: { final_execution_status: 'EXECUTED_OPTIMISTIC' } };
      if (m === 'EXPERIMENTAL_tx_status') return { result: final };
      return { error: { name: 'HANDLER_ERROR', cause: { name: 'UNEXPECTED' } } };
    });
    const near = fakeNear(KEY.publicKey);
    const r = await keySender(rpc, KEY, { nearApi: near, sleep: async () => {} }).send(PAY);
    assert.equal(r.kind, 'executed');
    assert.equal(r.kind === 'executed' ? payOutcomeOf(r.outcome)?.status : null, 'sent');
    assert.deepEqual(methods, ['query', 'block', 'send_tx', 'EXPERIMENTAL_tx_status']);
    assert.equal((near.signed[0] as { nonce: bigint }).nonce, 6n, 'nonce = on-chain nonce + 1');
  });

  test('an INVALID_TRANSACTION answer is a rejection, with the exact RPC error and the signed bytes kept', async () => {
    const err = invalidTx(ACCESS_KEY_ERRORS.DepositWithFunctionCall);
    const { rpc, methods } = rpcWith((m) => {
      if (m === 'query') return { result: { nonce: 5, permission: 'FullAccess', block_hash: 'b', block_height: 1 } };
      if (m === 'block') return { result: { header: { hash: 'BlockHashOfTheFinalBlock', height: 10 } } };
      return { error: err };
    });
    const r = await keySender(rpc, KEY, { nearApi: fakeNear(KEY.publicKey), now: () => new Date('2026-11-13T12:00:00Z') }).send(PAY);
    assert.equal(r.kind, 'rejected');
    if (r.kind !== 'rejected') return;
    assert.equal(r.name, 'DepositWithFunctionCall');
    assert.deepEqual(r.rpcError, err);
    // Exactly the bytes sent in send_tx, so the judge can verify the signature and re-derive the rule.
    assert.deepEqual(r.signed, {
      signed_tx_base64: Buffer.from([9, 9]).toString('base64'),
      local_tx_hash: 'TxHashBase58',
      sent_at: '2026-11-13T12:00:00.000Z',
      signer_id: ACC.vault,
      receiver_id: ACC.vault,
      public_key: KEY.publicKey,
      nonce: '6',
      block_hash: 'BlockHashOfTheFinalBlock',
    });
    assert.equal(r.retries, undefined);
    assert.ok(!methods.includes('EXPERIMENTAL_tx_status'), 'nothing to poll: there is no transaction');
    assert.ok(!JSON.stringify(r).includes(KEY.secret()), 'no key material in the result');
  });

  test('a stale nonce is signed again once with the nonce the node reported, and the first try is kept', async () => {
    let sends = 0;
    const final = txResult({ hash: 'TxHashBase58', signer: ACC.vault, receiver: ACC.vault, returnValue: { status: 'sent', payment_id: '1', reason: null, held_id: null }, logs: [] });
    const { rpc, methods } = rpcWith((m) => {
      if (m === 'query') return { result: { nonce: 5, permission: 'FullAccess', block_hash: 'b', block_height: 1 } };
      if (m === 'block') return { result: { header: { hash: '1', height: 10 } } };
      if (m === 'send_tx') return ++sends === 1 ? { error: invalidTx(ACCESS_KEY_ERRORS.InvalidNonce) } : { result: { final_execution_status: 'EXECUTED_OPTIMISTIC' } };
      return { result: final };
    });
    const near = fakeNear(KEY.publicKey);
    const r = await keySender(rpc, KEY, { nearApi: near, sleep: async () => {} }).send(PAY);
    assert.equal(r.kind, 'executed');
    assert.equal(methods.filter((m) => m === 'send_tx').length, 2);
    assert.deepEqual(near.signed.map((t) => (t as { nonce: bigint }).nonce), [6n, 11n], 'the second try uses ak_nonce 10 + 1');
    assert.equal(r.kind === 'executed' ? r.retries?.[0]?.name : '', 'InvalidNonce');
    assert.equal(r.kind === 'executed' ? r.retries?.[0]?.signed.nonce : '', '6');
  });

  test('a second stale nonce is a rejection: never a third try', async () => {
    const { rpc, methods } = rpcWith((m) => {
      if (m === 'query') return { result: { nonce: 5, permission: 'FullAccess', block_hash: 'b', block_height: 1 } };
      if (m === 'block') return { result: { header: { hash: '1', height: 10 } } };
      return { error: invalidTx(ACCESS_KEY_ERRORS.InvalidNonce) };
    });
    const r = await keySender(rpc, KEY, { nearApi: fakeNear(KEY.publicKey), sleep: async () => {} }).send(PAY);
    assert.equal(r.kind, 'rejected');
    assert.equal(r.kind === 'rejected' ? r.name : '', 'InvalidNonce');
    assert.equal(r.kind === 'rejected' ? r.retries?.length : 0, 1);
    assert.equal(methods.filter((m) => m === 'send_tx').length, 2);
  });

  test('a forbidden action is never retried', async () => {
    const { rpc, methods } = rpcWith((m) => {
      if (m === 'query') return { result: { nonce: 5, permission: 'FullAccess', block_hash: 'b', block_height: 1 } };
      if (m === 'block') return { result: { header: { hash: '1', height: 10 } } };
      return { error: invalidTx(ACCESS_KEY_ERRORS.MethodNameMismatch) };
    });
    const r = await keySender(rpc, KEY, { nearApi: fakeNear(KEY.publicKey) }).send(PAY);
    assert.equal(r.kind === 'rejected' ? r.name : '', 'MethodNameMismatch');
    assert.equal(methods.filter((m) => m === 'send_tx').length, 1);
  });

  test('a send timeout polls by hash and never resends', async () => {
    let polls = 0;
    const final = txResult({ hash: 'TxHashBase58', signer: ACC.vault, receiver: ACC.vault, logs: [] });
    const { rpc, methods } = rpcWith((m) => {
      if (m === 'query') return { result: { nonce: 5, permission: 'FullAccess', block_hash: 'b', block_height: 1 } };
      if (m === 'block') return { result: { header: { hash: '1', height: 10 } } };
      if (m === 'send_tx') return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } };
      polls++;
      return polls < 3 ? { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } } : { result: final };
    });
    const r = await keySender(rpc, KEY, { nearApi: fakeNear(KEY.publicKey), sleep: async () => {} }).send(PAY);
    assert.equal(r.kind, 'executed');
    assert.equal(methods.filter((m) => m === 'send_tx').length, 1);
  });

  test('refuses a key file whose secret derives another public key', async () => {
    const { rpc } = rpcWith(() => ({ result: {} }));
    await assert.rejects(keySender(rpc, KEY, { nearApi: fakeNear('ed25519:Other') }).send(PAY), /derives ed25519:Other/);
  });

  test('refuses a plan signed by another account than the key', async () => {
    const { rpc } = rpcWith(() => ({ result: {} }));
    await assert.rejects(keySender(rpc, KEY, { nearApi: fakeNear(KEY.publicKey) }).send({ ...PAY, signerId: ACC.owner }), /loaded key belongs to/);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from '../lib/base58.mjs';
import { accessKeyRule, decodeSignedTransaction } from '../lib/borsh.mjs';
import { fixture } from './helpers.mjs';

// Built by near-api-js 7.5.3 with a throwaway key (see the fixture's _fixture note). The judge's
// decoder is written independently, so agreeing on the hash is a real cross-check.
const signed = fixture('near-api-js-signed.json');
const byName = Object.fromEntries(signed.cases.map((c) => [c.name, c]));
const VAULT = 'vault.aid-demo-owner.testnet';
const AGENT = { kind: 'FunctionCall', receiver_id: VAULT, method_names: ['pay', 'request_payment', 'record_refusal'], allowance: '250000000000000000000000' };

test('decoder reproduces near-api-js hashes and verifies every signature (V0 and V1)', () => {
  for (const c of signed.cases) {
    const tx = decodeSignedTransaction(c.signed_tx_base64);
    assert.equal(tx.hash, encode(Buffer.from(c.reference_hash_hex, 'hex')), c.name);
    assert.equal(tx.signature_valid, true, `${c.name} signature`);
    assert.equal(tx.public_key, c.public_key);
    assert.equal(tx.signer_id, c.signer_id);
    assert.equal(tx.receiver_id, c.receiver_id);
    assert.equal(tx.block_hash, encode(Buffer.from(c.block_hash_hex, 'hex')));
    assert.equal(tx.version, c.v1 ? 1 : 0);
  }
});

test('decoded actions carry what the transaction asked for', () => {
  const ft = decodeSignedTransaction(byName['agent-ft-transfer'].signed_tx_base64);
  assert.equal(ft.actions.length, 1);
  assert.equal(ft.actions[0].type, 'FunctionCall');
  assert.equal(ft.actions[0].method_name, 'ft_transfer');
  assert.equal(ft.actions[0].deposit, '1');
  assert.deepEqual(JSON.parse(Buffer.from(ft.actions[0].args_base64, 'base64').toString()), { receiver_id: 'aid-demo-attacker.testnet', amount: '1000000' });
  const addKey = decodeSignedTransaction(byName['agent-add-key'].signed_tx_base64);
  assert.equal(addKey.actions[0].type, 'AddKey');
  assert.equal(addKey.actions[0].access_key.permission.kind, 'FullAccess');
  const fcKey = decodeSignedTransaction(byName['agent-add-fc-key'].signed_tx_base64);
  assert.deepEqual(fcKey.actions[0].access_key.permission, { kind: 'FunctionCall', allowance: '250000000000000000000000', receiver_id: VAULT, method_names: ['pay', 'request_payment'] });
  const v1 = decodeSignedTransaction(byName['agent-pay-v1'].signed_tx_base64);
  assert.equal(v1.nonce_index, 3);
  assert.equal(v1.nonce_mode, 'strict');
});

test("nearcore's function-call key rules, in nearcore's order", () => {
  const rule = (name) => accessKeyRule(AGENT, decodeSignedTransaction(byName[name].signed_tx_base64));
  assert.equal(rule('agent-ft-transfer'), 'DepositWithFunctionCall', 'the deposit is checked before the receiver');
  assert.equal(rule('agent-ft-transfer-no-deposit'), 'ReceiverMismatch');
  assert.equal(rule('agent-withdraw'), 'MethodNameMismatch');
  assert.equal(rule('agent-pay-with-deposit'), 'DepositWithFunctionCall');
  assert.equal(rule('agent-pay-twice'), 'RequiresFullAccess', 'one action only');
  assert.equal(rule('agent-add-key'), 'RequiresFullAccess');
  assert.equal(rule('agent-add-fc-key'), 'RequiresFullAccess');
  assert.equal(rule('agent-transfer-near'), 'RequiresFullAccess');
  assert.equal(rule('agent-delete-key'), 'RequiresFullAccess');
  assert.equal(rule('agent-pay-v1'), null, 'a listed method with no deposit goes through');
  assert.equal(accessKeyRule({ kind: 'FullAccess' }, decodeSignedTransaction(byName['agent-add-key'].signed_tx_base64)), null);
  const anyMethod = { ...AGENT, method_names: [] };
  assert.equal(accessKeyRule(anyMethod, decodeSignedTransaction(byName['agent-withdraw'].signed_tx_base64)), null, 'an empty method list allows any method');
});

test('a tampered signature or body is detected', () => {
  const bytes = Buffer.from(byName['agent-withdraw'].signed_tx_base64, 'base64');
  const badSig = Buffer.from(bytes);
  badSig[badSig.length - 1] ^= 0x01;
  assert.equal(decodeSignedTransaction(badSig.toString('base64')).signature_valid, false);
  const badBody = Buffer.from(bytes);
  // Flip a byte inside the method name: the signature no longer covers this body.
  const at = badBody.indexOf(Buffer.from('withdraw'));
  badBody[at] = 'W'.charCodeAt(0);
  const tx = decodeSignedTransaction(badBody.toString('base64'));
  assert.equal(tx.actions[0].method_name, 'Withdraw');
  assert.equal(tx.signature_valid, false);
});

test('truncated or padded input is refused', () => {
  const bytes = Buffer.from(byName['agent-withdraw'].signed_tx_base64, 'base64');
  assert.throws(() => decodeSignedTransaction(bytes.subarray(0, bytes.length - 10).toString('base64')), /unexpected end/);
  assert.throws(() => decodeSignedTransaction(Buffer.concat([bytes, Buffer.from([0])]).toString('base64')), /trailing bytes/);
});

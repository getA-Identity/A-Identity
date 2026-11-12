import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { decode, encode, isBase58OfLength } from '../lib/base58.mjs';
import { recorded } from './helpers.mjs';

// Bitcoin's base58_encode_decode.json vectors (hex, base58).
const VECTORS = [
  ['', ''],
  ['61', '2g'],
  ['626262', 'a3gV'],
  ['636363', 'aPEr'],
  ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
  ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
  ['516b6fcd0f', 'ABnLTmg'],
  ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
  ['572e4794', '3EFU7m'],
  ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
  ['10c8511e', 'Rt5zm'],
  ['00000000000000000000', '1111111111'],
];

test('base58 matches the Bitcoin test vectors both ways', () => {
  for (const [hex, text] of VECTORS) {
    assert.equal(encode(Buffer.from(hex, 'hex')), text, `encode ${hex}`);
    assert.equal(Buffer.from(decode(text)).toString('hex'), hex, `decode ${text}`);
  }
});

test('32 zero bytes is the code_hash of an account without a contract', () => {
  assert.equal(encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.equal(decode('11111111111111111111111111111111').length, 32);
});

test('a real NEAR code_hash: base58(sha256(wasm)) of Circle testnet USDC equals view_account', () => {
  // Recorded 2026-11-12 from testnet: the sha256 of the contract code (view_code) and the
  // code_hash view_account reported for the same account.
  const v = recorded.code_hash_vector;
  assert.equal(encode(Buffer.from(v.sha256_hex, 'hex')), v.view_account_code_hash);
  assert.equal(v.base58_of_sha256, v.view_account_code_hash);
  assert.equal(Buffer.from(decode(v.view_account_code_hash)).toString('hex'), v.sha256_hex);
});

test('round trip on random input, including leading zero bytes', () => {
  for (let i = 0; i < 300; i++) {
    const body = randomBytes(i % 70);
    const bytes = Buffer.concat([Buffer.alloc(i % 4), body]);
    assert.deepEqual(Buffer.from(decode(encode(bytes))), bytes);
  }
});

test('decode rejects characters outside the alphabet', () => {
  for (const bad of ['0', 'O', 'I', 'l', 'abc+', ' x']) {
    assert.throws(() => decode(bad), /invalid character/);
  }
  assert.throws(() => decode(42), /expected a string/);
});

test('isBase58OfLength accepts hashes and keys, rejects the rest', () => {
  const hash = encode(createHash('sha256').update('x').digest());
  assert.equal(isBase58OfLength(hash, 32), true);
  assert.equal(isBase58OfLength(hash, 64), false);
  assert.equal(isBase58OfLength('not-base58!', 32), false);
  assert.equal(isBase58OfLength('', 32), false);
  assert.equal(isBase58OfLength(null, 32), false);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECKS } from '../lib/checks.mjs';
import { viewAccountSpec } from '../lib/near.mjs';
import { call, makeCtx, recordedCall, tempDir } from './helpers.mjs';

// An independent base58 (BigInt arithmetic, unlike lib/base58.mjs) so the comparison is not the
// codec checking itself.
function referenceBase58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function wasmRoot() {
  const root = tempDir();
  mkdirSync(join(root, 'deployments/wasm'), { recursive: true });
  // A minimal valid wasm module header plus a custom section, enough to hash.
  const wasm = Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]), Buffer.from('judge test module')]);
  writeFileSync(join(root, 'deployments/wasm/vault.wasm'), wasm);
  const digest = createHash('sha256').update(wasm).digest();
  return { root, hex: digest.toString('hex'), b58: referenceBase58(digest), bytes: wasm.length };
}

const ACCOUNT = 'vault.aid-demo-owner.testnet';

function viewAccount(codeHash) {
  return call(viewAccountSpec('testnet', ACCOUNT), {
    result: { amount: '5000000000000000000000000', locked: '0', code_hash: codeHash, storage_usage: 300000, block_height: 277400001, block_hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' },
  });
}

const run = (params, calls, root) => CHECKS.code_hash_matches_committed_wasm.run(params, makeCtx(calls, { root }));

test('PASS when the on-chain code_hash is base58(sha256) of the committed wasm', async () => {
  const w = wasmRoot();
  const result = await run({ account_id: ACCOUNT, wasm_path: 'deployments/wasm/vault.wasm', sha256_hex: w.hex, sha256_base58: w.b58, recorded_code_hash: w.b58 }, [viewAccount(w.b58)], w.root);
  assert.equal(result.status, 'PASS', result.detail);
  assert.match(result.detail, new RegExp(w.b58));
  assert.equal(result.observed.wasm_sha256_hex, w.hex);
  assert.equal(result.observed.wasm_bytes, w.bytes);
});

test('FAIL when the chain runs different code', async () => {
  const w = wasmRoot();
  const other = recordedCall((c) => c.request.params.account_id === '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af' && c.request.params.request_type === 'view_account');
  const result = await run({ account_id: ACCOUNT, wasm_path: 'deployments/wasm/vault.wasm' }, [viewAccount(other.response.result.code_hash)], w.root);
  assert.equal(result.status, 'FAIL');
  assert.match(result.detail, /is not base58\(sha256/);
});

test('FAIL when deployments records a different sha256 than the committed file', async () => {
  const w = wasmRoot();
  const result = await run({ account_id: ACCOUNT, wasm_path: 'deployments/wasm/vault.wasm', sha256_hex: '0'.repeat(64) }, [viewAccount(w.b58)], w.root);
  assert.equal(result.status, 'FAIL');
  assert.match(result.detail, /deployments records sha256/);
});

test('FAIL when the committed wasm is missing or the account does not exist', async () => {
  const w = wasmRoot();
  const missing = await run({ account_id: ACCOUNT, wasm_path: 'deployments/wasm/nope.wasm' }, [], w.root);
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.detail, /not in the tree/);
  const unknown = recordedCall((c) => c.response.error?.cause?.name === 'UNKNOWN_ACCOUNT');
  unknown.request.params.account_id = ACCOUNT;
  const gone = await run({ account_id: ACCOUNT, wasm_path: 'deployments/wasm/vault.wasm' }, [unknown], w.root);
  assert.equal(gone.status, 'FAIL');
  assert.match(gone.detail, /does not exist/);
});

#!/usr/bin/env node
// Prints what deployments/testnet.json records for a wasm: its size, its sha256 in hex, and the
// base58 of that sha256, which is exactly the code_hash NEAR reports for an account running it.
//
//   node judge/wasm-hash.mjs deployments/wasm/agent_spend_policy.wasm

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { encode } from './lib/base58.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node judge/wasm-hash.mjs <file.wasm> [...]');
  process.exitCode = 2;
}
for (const file of files) {
  const bytes = readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest();
  console.log(JSON.stringify({ file, wasm_bytes: bytes.length, wasm_sha256_hex: digest.toString('hex'), wasm_sha256_base58: encode(digest) }));
}

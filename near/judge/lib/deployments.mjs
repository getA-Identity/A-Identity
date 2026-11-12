// deployments/<network>.json: what the deploy step recorded, and the templates claims use to
// read it.
//
// A claim never hardcodes a deployed fact (an account, a tx hash, a key, an amount). It names the
// field instead, as `${contracts.vault.account_id}`, and the judge fills it in here. A field the
// deploy step has not filled yet is null, and a claim that needs a null field is PENDING: the
// judge prints SKIP with the field's name, never PASS. That is the whole mechanism that keeps an
// undeployed claim from looking verified.
//
// Template forms, inside any string in a claim's params:
//   "${a.b.c}"         the whole string is replaced by the value (any JSON type)
//   "${?a.b.c}"        the same, but a null value is allowed (the claim is not pending)
//   "x-${a.b}-y"       interpolation; the value must be a string, number or boolean

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getPath } from './json.mjs';
import { isBase58OfLength } from './base58.mjs';

const WHOLE = /^\$\{(\??)([A-Za-z0-9_.-]+)\}$/;
const ANY = /\$\{(\??)([A-Za-z0-9_.-]+)\}/g;

export function readJsonFile(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return { value: JSON.parse(text), sha256: createHash('sha256').update(text).digest('hex') };
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

/**
 * Replace every template in `value` with data from `data`.
 * Returns `{ value, missing }`: `missing` lists the required paths that were null or absent.
 */
export function resolveTemplates(value, data) {
  const missing = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      const whole = node.match(WHOLE);
      if (whole) {
        const [, optional, path] = whole;
        const found = getPath(data, path);
        if (found === null || found === undefined) {
          if (!optional) missing.push(path);
          return null;
        }
        return structuredClone(found);
      }
      return node.replace(ANY, (_, optional, path) => {
        const found = getPath(data, path);
        if (found === null || found === undefined) {
          if (!optional) missing.push(path);
          return '';
        }
        if (typeof found === 'object') throw new Error(`template \${${path}} inside a string must be a scalar`);
        return String(found);
      });
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  const resolved = walk(value);
  return { value: resolved, missing: [...new Set(missing)] };
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Shape checks on the deployments file. It returns problems instead of throwing, because a
 * typo in one field should cost the claims that read that field, not the whole run.
 */
export function validateDeployments(d, network) {
  const problems = [];
  if (!d || typeof d !== 'object') return ['not a JSON object'];
  if (d.network !== network) problems.push(`network is ${JSON.stringify(d.network)}, expected ${JSON.stringify(network)}`);
  if (!['pending', 'partial', 'deployed'].includes(d.status)) {
    problems.push(`status must be pending, partial or deployed, got ${JSON.stringify(d.status)}`);
  }
  for (const [name, contract] of Object.entries(d.contracts ?? {})) {
    const at = `contracts.${name}`;
    if (contract.wasm_sha256_hex != null && !HEX64.test(contract.wasm_sha256_hex)) {
      problems.push(`${at}.wasm_sha256_hex is not 64 lowercase hex characters`);
    }
    for (const field of ['wasm_sha256_base58', 'code_hash']) {
      if (contract[field] != null && !isBase58OfLength(contract[field], 32)) {
        problems.push(`${at}.${field} is not base58 of 32 bytes`);
      }
    }
    if (contract.deploy_tx?.hash != null && !isBase58OfLength(contract.deploy_tx.hash, 32)) {
      problems.push(`${at}.deploy_tx.hash is not a base58 transaction hash`);
    }
  }
  for (const [name, tx] of Object.entries(d.demo?.transactions ?? {})) {
    if (tx.tx_hash != null && !isBase58OfLength(tx.tx_hash, 32)) {
      problems.push(`demo.transactions.${name}.tx_hash is not a base58 transaction hash`);
    }
  }
  // Pinned reads: a block height, so the same question gets the same answer from archival RPC.
  const isHeight = (value) => Number.isInteger(value) && value > 0;
  for (const [name, verdict] of Object.entries(d.verdicts ?? {})) {
    if (verdict?.read_block != null && !isHeight(verdict.read_block)) problems.push(`verdicts.${name}.read_block is not a block height (a positive integer)`);
  }
  if (d.demo?.state_block != null && !isHeight(d.demo.state_block)) problems.push('demo.state_block is not a block height (a positive integer)');
  return problems;
}

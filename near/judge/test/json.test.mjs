import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { resolveTemplates, validateDeployments } from '../lib/deployments.mjs';
import { canonical, getPath, match } from '../lib/json.mjs';
import { NEAR_ROOT } from './helpers.mjs';

test('canonical JSON ignores key order and undefined members', () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: undefined, e: null }] }), '{"a":[1,{"d":2,"e":null}],"b":1}');
  assert.equal(canonical({ x: 1, y: 2 }), canonical({ y: 2, x: 1 }));
});

test('getPath reads nested objects and arrays', () => {
  const data = { a: { b: [{ c: 'x' }] } };
  assert.equal(getPath(data, 'a.b.0.c'), 'x');
  assert.equal(getPath(data, 'a.zz.c'), undefined);
  assert.equal(getPath(data, ''), data);
});

test('match: objects are subsets, arrays are exact, scalars are strict', () => {
  assert.deepEqual(match({ a: 1, b: 2, icon: 'big' }, { a: 1 }), []);
  assert.equal(match({ a: 1 }, { a: '1' }).length, 1, 'no loose equality');
  assert.equal(match(['x', 'y'], ['x']).length, 1, 'array length is part of the claim');
  assert.deepEqual(match(['x', 'y'], ['x', 'y']), []);
  assert.equal(match(null, { a: 1 }).length, 1);
  assert.equal(match(undefined, false).length, 1);
  assert.deepEqual(match(false, false), []);
});

test('match operators', () => {
  assert.deepEqual(match('5', { $gte: 1 }), [], 'U128 strings compare as integers');
  assert.deepEqual(match('340282366920938463463374607431768211455', { $gt: '340282366920938463463374607431768211454' }), []);
  assert.equal(match(0, { $gte: 1 }).length, 1);
  assert.equal(match('abc', { $gte: 1 }).length, 1, 'a non-number never satisfies a bound');
  assert.equal(match(undefined, { $lte: 5 }).length, 1);
  assert.deepEqual(match('set_verdicts', { $oneOf: ['set_verdict', 'set_verdicts'] }), []);
  assert.equal(match('pay', { $oneOf: ['set_verdict'] }).length, 1);
  assert.deepEqual(match(['drainer'], { $nonEmpty: true }), []);
  assert.equal(match([], { $nonEmpty: true }).length, 1);
  assert.deepEqual(match(true, { $type: 'boolean' }), []);
  assert.deepEqual(match('ed25519:abc', { $regex: '^ed25519:' }), []);
  assert.deepEqual(match(undefined, { $absent: true }), []);
  assert.equal(match(0, { $absent: true }).length, 1);
  assert.deepEqual(match(['b', 'a'], { $setEquals: ['a', 'b'] }), []);
  assert.equal(match(['a', 'a', 'b'], { $setEquals: ['a', 'b'] }).length, 1, 'duplicates are not a set');
  assert.deepEqual(match([{ k: 1 }, { k: 2 }], { $contains: { k: 2 } }), []);
  assert.deepEqual(match('DENY', { $not: 'ALLOW' }), []);
  assert.deepEqual(match({ a: 1 }, { $exact: { a: 1 } }), []);
  assert.equal(match({ a: 1, b: 2 }, { $exact: { a: 1 } }).length, 1);
  assert.deepEqual(match([1, 2], { $len: 2 }), []);
  assert.throws(() => match(1, { $nope: 1 }), /unknown matcher operator/);
});

test('templates: whole values, optional values, interpolation and pending fields', () => {
  const data = { a: { id: 'x.testnet', n: 3, list: ['p'], nothing: null } };
  const { value, missing } = resolveTemplates(
    { id: '${a.id}', list: '${a.list}', text: 'id=${a.id} n=${a.n}', opt: '${?a.nothing}', need: '${a.nothing}', deep: ['${a.absent}'] },
    data,
  );
  assert.equal(value.id, 'x.testnet');
  assert.deepEqual(value.list, ['p']);
  assert.equal(value.text, 'id=x.testnet n=3');
  assert.equal(value.opt, null);
  assert.deepEqual(missing.sort(), ['a.absent', 'a.nothing']);
  assert.throws(() => resolveTemplates('x ${a.list}', data), /must be a scalar/);
});

test('the committed deployments file is well-formed and pending', () => {
  const deployments = JSON.parse(readFileSync(join(NEAR_ROOT, 'deployments/testnet.json'), 'utf8'));
  assert.deepEqual(validateDeployments(deployments, 'testnet'), []);
  assert.equal(deployments.schema, 'a-identity-near-deployments/1');
});

test('validateDeployments names malformed fields instead of throwing', () => {
  const problems = validateDeployments(
    {
      network: 'mainnet',
      status: 'live',
      contracts: { vault: { wasm_sha256_hex: 'XYZ', code_hash: 'not base58', deploy_tx: { hash: 'short' } } },
      demo: { transactions: { pay: { tx_hash: '0x1234' } } },
    },
    'testnet',
  );
  assert.equal(problems.length, 6);
  assert.match(problems.join('\n'), /network/);
  assert.match(problems.join('\n'), /contracts\.vault\.code_hash/);
  assert.match(problems.join('\n'), /demo\.transactions\.pay\.tx_hash/);
});

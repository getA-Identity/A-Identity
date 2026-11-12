// The judge and capture against a local fake JSON-RPC server: what happens when one network
// answers and the other does not, when a network stops answering mid-run, and when capture
// cannot record a claim that is ready. No real endpoint is contacted: every JUDGE_*RPC_* variable
// points at 127.0.0.1.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { EVIDENCE_SCHEMA, requestKey } from '../lib/evidence.mjs';
import { viewAccountSpec } from '../lib/near.mjs';
import { HERE, call, recorded, tempDir } from './helpers.mjs';

const JUDGE = join(HERE, '..', 'judge.mjs');
const CAPTURE = join(HERE, '..', 'capture.mjs');

/** A local port nothing listens on: connecting is refused at once (ECONNREFUSED). */
function closedPort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}
const DEAD = await closedPort();

/** A JSON-RPC server: `status` reports the network; anything else goes to `answer(request)`,
 *  which returns a JSON-RPC body, or { http } for a bare HTTP status. */
function fakeRpc(network, answer) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const request = JSON.parse(body);
        const out = request.method === 'status' ? { result: { chain_id: network, sync_info: { latest_block_height: 277400000 } } } : answer(request);
        if (out.http) {
          res.writeHead(out.http);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...out }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** The recorded testnet answers (fixtures/testnet-recorded.json), served as live ones. */
function fromRecorded(request) {
  const key = requestKey('testnet', request.method, request.params);
  const hit = recorded.calls.find((c) => requestKey(c.network, c.request.method, c.request.params) === key);
  return hit ? hit.response : { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: {} }, code: -32000, message: 'Server error' } };
}

function runNode(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const MAINNET_ACCOUNT = { amount: '2854600000000000000000000', locked: '0', code_hash: 'J78A5LY75i4xNSrkSd5A2VshBjHHCnAve43BtHiqoxWx', storage_usage: 100, storage_paid_at: 0, block_height: 224157074, block_hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' };

const CLAIMS = [
  { id: 'owner-exists', claim: 'a-identity.testnet exists on NEAR testnet.', check: 'account_exists', network: 'testnet', params: { account_id: 'a-identity.testnet' } },
  { id: 'usdc-exists', claim: 'Circle testnet USDC runs a contract.', check: 'account_exists', network: 'testnet', params: { account_id: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af', has_contract: true } },
  { id: 'arras-identity', claim: 'identity-registry.erc-8004.near runs a contract on mainnet.', check: 'account_exists', network: 'mainnet', params: { account_id: 'identity-registry.erc-8004.near', has_contract: true } },
];

/** A near/ tree with the claims above and recorded evidence for the ones named. */
function workspace(withEvidence) {
  const root = tempDir();
  for (const dir of ['judge', 'deployments', 'evidence']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'judge/claims.json'), JSON.stringify({ schema: 'a-identity-near-claims/1', deployments: 'deployments/testnet.json', claims: CLAIMS }));
  writeFileSync(join(root, 'deployments/testnet.json'), JSON.stringify({ schema: 'a-identity-near-deployments/1', network: 'testnet', status: 'pending' }));
  const evidence = {
    'owner-exists': recorded.calls.filter((c) => c.request.params?.request_type === 'view_account' && c.request.params.account_id === 'a-identity.testnet'),
    'usdc-exists': recorded.calls.filter((c) => c.request.params?.request_type === 'view_account' && c.request.params.account_id === CLAIMS[1].params.account_id),
    'arras-identity': [call(viewAccountSpec('mainnet', 'identity-registry.erc-8004.near'), { result: MAINNET_ACCOUNT })],
  };
  for (const id of withEvidence) {
    assert.ok(evidence[id].length, `fixture for ${id}`);
    writeFileSync(join(root, `evidence/${id}.json`), JSON.stringify({ schema: EVIDENCE_SCHEMA, claim_id: id, captured_at: '2026-11-12T00:00:00Z', calls: evidence[id] }));
  }
  return root;
}

const lineOf = (stdout, id) => stdout.split('\n').find((line) => line.split(' ')[1] === id) ?? '';

test('one network down: its claims replay evidence, the other network is judged live', async () => {
  const { server, url } = await fakeRpc('testnet', fromRecorded);
  try {
    const root = workspace(['arras-identity']);
    const env = { JUDGE_RPC_TESTNET: url, JUDGE_ARCHIVAL_RPC_TESTNET: url, JUDGE_RPC_MAINNET: DEAD, JUDGE_ARCHIVAL_RPC_MAINNET: DEAD };
    const { code, stdout } = await runNode(JUDGE, ['--root', root, '--report', join(root, 'report.json')], env);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /mode=online/);
    assert.match(stdout, /NOTE NEAR mainnet is not reachable from here \(state RPC: .*ECONNREFUSED.*\); its claims replay the committed evidence instead/);
    assert.match(lineOf(stdout, 'owner-exists'), /^PASS owner-exists .*\(view_account at block \d+: /);
    assert.match(lineOf(stdout, 'arras-identity'), /^PASS arras-identity .*\(replayed evidence \(mainnet RPC not reachable\): view_account at block 224157074/);
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    assert.deepEqual(report.replayed_networks, ['mainnet']);
    assert.equal(report.checks.find((c) => c.id === 'owner-exists').replayed, false);
    assert.equal(report.checks.find((c) => c.id === 'arras-identity').replayed, true);
    // With --no-fallback the down network's claims are SKIP, at once (the dead host is not retried).
    const strict = await runNode(JUDGE, ['--root', root, '--no-report', '--no-fallback'], env);
    assert.equal(strict.code, 0, strict.stdout);
    assert.match(lineOf(strict.stdout, 'arras-identity'), /^SKIP arras-identity .*\(network: no answer from mainnet state RPC/);
  } finally {
    server.close();
  }
});

test('a network that stops answering mid-run: with evidence, that claim and the rest of the network replay it', async () => {
  // Status answers (the probe passes), every query is HTTP 503 (a node that went away).
  const { server, url } = await fakeRpc('testnet', () => ({ http: 503 }));
  try {
    const root = workspace(['owner-exists', 'usdc-exists', 'arras-identity']);
    const env = { JUDGE_RPC_TESTNET: url, JUDGE_ARCHIVAL_RPC_TESTNET: url, JUDGE_RPC_MAINNET: DEAD, JUDGE_ARCHIVAL_RPC_MAINNET: DEAD };
    const { code, stdout } = await runNode(JUDGE, ['--root', root, '--no-report'], env);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /NOTE testnet RPC stopped answering \(no answer from testnet state RPC .*HTTP 503.*\); this and the remaining testnet claims replay the committed evidence/);
    assert.match(lineOf(stdout, 'owner-exists'), /^PASS owner-exists .*replayed evidence \(testnet RPC stopped answering\)/);
    assert.match(lineOf(stdout, 'usdc-exists'), /^PASS usdc-exists .*replayed evidence \(testnet RPC stopped answering\)/);
    assert.match(stdout, /JUDGE: 3 PASS, 0 FAIL, 0 SKIP/);
  } finally {
    server.close();
  }
});

test('capture: a claim that is ready but cannot be recorded is NOT CAPTURED and the exit status is 1', async () => {
  const { server, url } = await fakeRpc('testnet', (request) => (request.params?.account_id === 'a-identity.testnet' ? fromRecorded(request) : { http: 503 }));
  try {
    const root = workspace([]);
    writeFileSync(join(root, 'judge/claims.json'), JSON.stringify({ schema: 'a-identity-near-claims/1', deployments: 'deployments/testnet.json', claims: CLAIMS.slice(0, 2) }));
    const env = { JUDGE_RPC_TESTNET: url, JUDGE_ARCHIVAL_RPC_TESTNET: url };
    const { code, stdout } = await runNode(CAPTURE, ['--root', root], env);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /^wrote evidence\/owner-exists\.json$/m);
    assert.match(stdout, /^NOT CAPTURED usdc-exists \(network: no answer from testnet state RPC/m);
    assert.match(stdout, /CAPTURE: 1 written, 0 FAIL, 1 NOT CAPTURED, 0 pending/);
    assert.equal(existsSync(join(root, 'evidence/usdc-exists.json')), false);
  } finally {
    server.close();
  }
});

// ------------------------------------------------------------------ the transport itself

import { LiveTransport, NetworkError } from '../lib/rpc.mjs';

/** A server that counts its requests and answers with `reply(request, n)`. */
async function countingServer(reply) {
  let n = 0;
  const { server, url } = await fakeRpc('testnet', (request) => reply(request, ++n));
  return { server, url, count: () => n };
}

const blockQuery = { network: 'testnet', kind: 'archival', method: 'block', params: { block_id: 277300516 } };
const BLOCK = { result: { header: { height: 277300516, hash: 'Gj4kb3AtaPFSgTddQkVVUXJthTKe4xgEtBw3DK2ULvjo' }, chunks: [] } };

test('transport: a rate-limited endpoint hands over to the next one at once, and a garbage-collected block is not an answer', async () => {
  const limited = await countingServer(() => ({ http: 429 }));
  const pruned = await countingServer(() => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'GARBAGE_COLLECTED_BLOCK', info: {} }, code: -32000, message: 'Server error' } }));
  const archive = await countingServer(() => BLOCK);
  try {
    const live = new LiveTransport({ env: { JUDGE_ARCHIVAL_RPC_TESTNET: `${limited.url},${pruned.url},${archive.url}` } });
    const started = Date.now();
    const answer = await live.call(blockQuery);
    assert.equal(answer.rpc_url, archive.url);
    assert.equal(answer.block_height, 277300516);
    assert.ok(Date.now() - started < 1500, `no backoff before handing over (${Date.now() - started} ms)`);
    assert.equal(limited.count(), 1, 'the rate-limited endpoint is asked once, not retried');
    assert.equal(pruned.count(), 1);
    // The answer cannot change, so the same question is not asked again in this run.
    await live.call(blockQuery);
    assert.equal(archive.count(), 1);
  } finally {
    for (const s of [limited, pruned, archive]) s.server.close();
  }
});

test('transport: the last endpoint is waited out on a rate limit, then the call is a NetworkError (SKIP, never FAIL)', async () => {
  const limited = await countingServer(() => ({ error: { code: -429, message: 'Rate limits exceeded' } }));
  try {
    const live = new LiveTransport({ attemptsPerEndpoint: 2, env: { JUDGE_ARCHIVAL_RPC_TESTNET: limited.url } });
    await assert.rejects(live.call(blockQuery), (err) => err instanceof NetworkError && /rate limit \(-429\)/.test(err.message));
    assert.equal(limited.count(), 2, 'one backoff retry on the only endpoint');
  } finally {
    limited.server.close();
  }
});

test('transport: a host that times out once is not asked again in the run', async () => {
  // Accepts the connection and never answers.
  const silent = createServer(() => {});
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const silentUrl = `http://127.0.0.1:${silent.address().port}`;
  const archive = await countingServer(() => BLOCK);
  try {
    // No pacing here, so the time measured below is only what the dead host could cost.
    const live = new LiveTransport({ timeoutMs: 300, minIntervalMs: 0, archivalIntervalMs: 0, env: { JUDGE_ARCHIVAL_RPC_TESTNET: `${silentUrl},${archive.url}` } });
    const first = await live.call(blockQuery);
    assert.equal(first.rpc_url, archive.url);
    assert.equal(live.deadHosts.get(new URL(silentUrl).host), 'no answer in 0.3 s');
    const started = Date.now();
    await live.call({ ...blockQuery, params: { block_id: 277300517 } });
    assert.ok(Date.now() - started < 290, 'the dead host was skipped without waiting for another timeout');
  } finally {
    silent.closeAllConnections?.();
    silent.close();
    archive.server.close();
  }
});

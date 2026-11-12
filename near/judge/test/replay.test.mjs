import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateClaim } from '../lib/engine.mjs';
import { EVIDENCE_SCHEMA, RecordingTransport } from '../lib/evidence.mjs';
import { IDS, JUDGE, NEAR_ROOT, memoryTransport, recorded, syntheticPay, syntheticTxCalls, tempDir } from './helpers.mjs';

const FAUCET = '641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5';
const LINE = /^(PASS|FAIL|SKIP) [a-z0-9][a-z0-9-]+ .+ \(.+; \d+\.\d\d s\)$/;
const SUMMARY = /^JUDGE: \d+ PASS, \d+ FAIL, \d+ SKIP \(mode=[a-z-]+, \d+\.\d s\)$/;

const deny = syntheticPay({ payee: IDS.attacker, outcome: 'refused', reason: 'RegistryDeny', verdict: 'DENY' });
const allCalls = [...recorded.calls, ...syntheticTxCalls(deny)];

function deployments(status = 'pending', overrides = {}) {
  return {
    schema: 'a-identity-near-deployments/1',
    network: 'testnet',
    status,
    accounts: { registry_owner: { account_id: 'a-identity.testnet' }, vault: { account_id: IDS.vault }, attacker: { account_id: IDS.attacker } },
    token: { account_id: IDS.usdc },
    demo: { transactions: { faucet: { tx_hash: 'D6Jp1Ho17KbwV5KDzcdE9RooKG6YFcZRRpap7RiNaV84' }, deny: { tx_hash: deny.tx_hash }, later: { tx_hash: null } } },
    ...overrides,
  };
}

const CLAIMS = [
  { id: 'owner-exists', claim: 'a-identity.testnet exists on NEAR testnet.', check: 'account_exists', params: { account_id: '${accounts.registry_owner.account_id}' } },
  {
    id: 'usdc-token',
    claim: 'Circle testnet USDC reports symbol USDC and 6 decimals.',
    check: 'view_equals',
    params: { account_id: '${token.account_id}', method: 'ft_metadata', args: {}, expect: { symbol: 'USDC', decimals: 6 } },
  },
  {
    id: 'faucet-transfer',
    claim: 'The faucet sent 20 USDC to aid-demo-owner.testnet.',
    check: 'tx_outcome',
    params: {
      tx_hash: '${demo.transactions.faucet.tx_hash}',
      sender_account_id: FAUCET,
      expect: { status: 'success', ft_transfers: [{ token_id: '${token.account_id}', to: 'aid-demo-owner.testnet', amount: '20000000', present: true }] },
    },
  },
  {
    id: 'deny-refused',
    claim: 'A DENY payment was refused on chain and nothing reached the token.',
    check: 'tx_outcome',
    params: {
      tx_hash: '${demo.transactions.deny.tx_hash}',
      sender_account_id: '${accounts.vault.account_id}',
      expect: {
        status: 'success',
        return: { status: 'refused', reason: 'RegistryDeny' },
        events: [{ standard: 'a_identity_vault', event: 'payment_refused', data: { payee: '${accounts.attacker.account_id}', source: 'registry' }, count: 1 }],
        no_receipts_executed_by: ['${token.account_id}'],
      },
    },
  },
  { id: 'later-tx', claim: 'A transaction that has not happened yet.', check: 'tx_outcome', params: { tx_hash: '${demo.transactions.later.tx_hash}', sender_account_id: 'x.testnet', expect: {} } },
];

/** A throwaway near/ tree: claims, deployments, and evidence recorded through the real capture path. */
async function workspace({ status = 'pending', deploymentOverrides = {}, skipEvidence = [] } = {}) {
  const root = tempDir();
  mkdirSync(join(root, 'judge'), { recursive: true });
  mkdirSync(join(root, 'deployments'), { recursive: true });
  mkdirSync(join(root, 'evidence'), { recursive: true });
  writeFileSync(join(root, 'judge/claims.json'), JSON.stringify({ schema: 'a-identity-near-claims/1', deployments: 'deployments/testnet.json', claims: CLAIMS }));
  const deployed = deployments(status, deploymentOverrides);
  writeFileSync(join(root, 'deployments/testnet.json'), JSON.stringify(deployed));
  for (const claim of CLAIMS) {
    if (skipEvidence.includes(claim.id)) continue;
    let recorder;
    const result = await evaluateClaim(claim, {
      root,
      deployments: { data: deployments(status), rel: 'deployments/testnet.json' },
      mode: 'capture',
      transportFor: () => {
        recorder = new RecordingTransport(memoryTransport(allCalls));
        return recorder;
      },
    });
    if (result.status !== 'PASS') continue;
    writeFileSync(
      join(root, `evidence/${claim.id}.json`),
      JSON.stringify({ schema: EVIDENCE_SCHEMA, claim_id: claim.id, claim: claim.claim, check: claim.check, network: 'testnet', captured_at: '2026-11-12T00:00:00Z', result, calls: recorder.calls }),
    );
  }
  return root;
}

function judge(root, args) {
  const run = spawnSync(process.execPath, [JUDGE, '--root', root, '--no-report', ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('offline replay re-derives every claim from recorded evidence (no network)', async () => {
  const root = await workspace();
  const { code, stdout } = judge(root, ['--offline', '--json']);
  assert.equal(code, 0, stdout);
  const report = JSON.parse(stdout);
  const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
  assert.deepEqual(status, { 'owner-exists': 'PASS', 'usdc-token': 'PASS', 'faucet-transfer': 'PASS', 'deny-refused': 'PASS', 'later-tx': 'SKIP' });
  assert.equal(report.mode, 'offline');
  assert.ok(report.checks.every((c) => c.calls.every((x) => x.replayed)), 'every answer came from evidence');
  assert.match(report.checks.find((c) => c.id === 'later-tx').detail, /^pending: demo\.transactions\.later\.tx_hash/);
});

test('every output line has the documented shape and the last line is the count', async () => {
  const root = await workspace();
  const { code, stdout } = judge(root, ['--offline']);
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n');
  const claimLines = lines.filter((line) => /^(PASS|FAIL|SKIP) /.test(line));
  assert.equal(claimLines.length, CLAIMS.length);
  for (const line of claimLines) assert.match(line, LINE);
  assert.match(lines.at(-1), SUMMARY);
  assert.equal(lines.at(-1).startsWith('JUDGE: 4 PASS, 0 FAIL, 1 SKIP'), true, lines.at(-1));
});

test('a deployment marked deployed must have evidence for every claim it does not leave pending', async () => {
  const root = await workspace({ status: 'deployed', skipEvidence: ['usdc-token'] });
  const { code, stdout } = judge(root, ['--offline', '--json']);
  assert.equal(code, 1);
  const check = JSON.parse(stdout).checks.find((c) => c.id === 'usdc-token');
  assert.equal(check.status, 'FAIL');
  assert.match(check.detail, /needs recorded evidence/);
});

test('evidence recorded for other deployments is stale: FAIL, not a quiet pass', async () => {
  // The evidence was captured for a-identity.testnet; the deployments now name another account.
  const root = await workspace({ deploymentOverrides: { accounts: { registry_owner: { account_id: 'someone-else.testnet' }, vault: { account_id: IDS.vault }, attacker: { account_id: IDS.attacker } } } });
  const { code, stdout } = judge(root, ['--offline', '--json']);
  assert.equal(code, 1);
  const check = JSON.parse(stdout).checks.find((c) => c.id === 'owner-exists');
  assert.equal(check.status, 'FAIL');
  assert.match(check.detail, /^stale evidence: evidence\/owner-exists\.json has no recorded answer/);
});

test('record then replay gives the same verdict and the same evidence text', async () => {
  const root = await workspace();
  const deploymentsLoaded = { data: deployments(), rel: 'deployments/testnet.json' };
  for (const claim of CLAIMS.slice(0, 4)) {
    const live = await evaluateClaim(claim, { root, deployments: deploymentsLoaded, mode: 'online', transportFor: () => memoryTransport(allCalls) });
    const replay = await evaluateClaim(claim, { root, deployments: deploymentsLoaded, mode: 'offline' });
    assert.equal(replay.status, live.status, claim.id);
    assert.equal(replay.detail, live.detail, claim.id);
  }
});

test('usage errors exit 2 and name the problem', async () => {
  const root = await workspace();
  const unknown = judge(root, ['--offline', '--step', 'no-such-claim']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown step id\(s\): no-such-claim/);
  const flag = judge(root, ['--frobnicate']);
  assert.equal(flag.code, 2);
  const list = judge(root, ['--list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /^owner-exists\s+default\s+account_exists/m);
  const one = judge(root, ['--offline', '--step', 'usdc-token,owner-exists']);
  assert.equal(one.code, 0);
  assert.match(one.stdout, /JUDGE: 2 PASS, 0 FAIL, 0 SKIP/);
});

test('the committed claims table loads and the real tree judges offline without a usage error', () => {
  const run = spawnSync(process.execPath, [JUDGE, '--offline', '--no-report'], { cwd: NEAR_ROOT, encoding: 'utf8', timeout: 60000 });
  assert.notEqual(run.status, 2, run.stderr);
  const lines = run.stdout.trim().split('\n');
  for (const line of lines.filter((l) => /^(PASS|FAIL|SKIP) /.test(l))) assert.match(line, LINE);
  assert.match(lines.at(-1), SUMMARY);
});

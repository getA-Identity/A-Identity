// Child processes: a time-boxed step runs in its own process group, so Ctrl-C at the terminal
// does not reach it. The judge must stop it itself on SIGINT or SIGTERM, and leave nothing
// running behind it.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HERE, tempDir } from './helpers.mjs';

const JUDGE = join(HERE, '..', 'judge.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('SIGINT to the judge stops a running --full step and its process group, then exits 130', { skip: process.platform === 'win32' && 'POSIX process groups' }, async () => {
  const root = tempDir();
  for (const dir of ['judge', 'deployments']) mkdirSync(join(root, dir), { recursive: true });
  const pidFile = join(root, 'child.pid');
  // The step writes its pid and then waits for a minute.
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`;
  const claims = [{ id: 'slow-step', claim: 'A step that takes a minute.', check: 'command', mode: 'full', params: { cmd: ['{node}', '-e', script], parse: 'exit-code', timeout_s: 120 } }];
  writeFileSync(join(root, 'judge/claims.json'), JSON.stringify({ schema: 'a-identity-near-claims/1', deployments: 'deployments/testnet.json', claims }));
  writeFileSync(join(root, 'deployments/testnet.json'), JSON.stringify({ schema: 'a-identity-near-deployments/1', network: 'testnet', status: 'pending' }));

  const judge = spawn(process.execPath, [JUDGE, '--root', root, '--no-report', '--step', 'slow-step'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  judge.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => judge.on('close', (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
  assert.ok(existsSync(pidFile), 'the step started');
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(child), 'the step is running');

  judge.kill('SIGINT');
  const { code } = await exited;
  assert.equal(code, 130, stderr);
  assert.match(stderr, /judge: SIGINT, stopping 1 child process group\(s\)/);
  for (let i = 0; i < 40 && alive(child); i++) await sleep(50);
  assert.equal(alive(child), false, `the step (pid ${child}) was left running`);
});

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { benchStalledHosts, withDeadline, type RpcHost } from './arc-owner-vault-live.js'

/**
 * Guards the fork rehearsal found or needed: a stalled host must not use up an admission's deadline,
 * when the deploy page asks the server to count a vault, and what scripts/rehearse-arc-vault.mjs
 * refuses before it holds any key. The whole path runs in scripts/rehearse-arc-vault-fork.mjs against
 * a real EVM and a real browser, which CI does not do; these keep the rules from sliding back.
 */

const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repoPath = (rel: string) => fileURLToPath(repoUrl(rel))

type VaultCount = { state: string; retryable?: boolean; reasons?: string[]; why?: string }
const loadRules = async () =>
  (await import(repoUrl('src/lib/arc/vault-count.ts').href)) as {
    shouldAsk: (stage: string, count: VaultCount | null, asked: ReadonlySet<string>, sending: boolean) => boolean
    askAgainByItself: (count: VaultCount | null) => boolean
  }

test('a host that stalled is not waited for again in this admission, and one that failed fast still is', async () => {
  let clock = 0
  const asked: string[] = []
  const stalls: RpcHost = {
    label: 'stalls',
    request: async (method) => {
      asked.push(`stalls ${method}`)
      clock += 6000
      throw new Error('The request took too long to respond.')
    },
  }
  const failsFast: RpcHost = {
    label: 'fails-fast',
    request: async (method) => {
      asked.push(`fails-fast ${method}`)
      throw new Error('429')
    },
  }
  const slowButAnswers: RpcHost = {
    label: 'slow',
    request: async (method) => {
      asked.push(`slow ${method}`)
      clock += 6000
      return 'answer'
    },
  }
  const [a, b, c] = benchStalledHosts([stalls, failsFast, slowButAnswers], 5500, () => clock)
  await assert.rejects(a.request('one', []), /too long/)
  await assert.rejects(a.request('two', []), /earlier in this read/, 'the second read fails at once')
  assert.equal(clock, 6000, 'and costs no time')
  await assert.rejects(b.request('one', []), /429/)
  await assert.rejects(b.request('two', []), /429/, 'a host that answered an error quickly is asked again')
  assert.equal(await c.request('one', []), 'answer')
  assert.equal(await c.request('two', []), 'answer', 'a slow answer is still an answer')
  assert.deepEqual(asked, ['stalls one', 'fails-fast one', 'fails-fast two', 'slow one', 'slow two'])
  // Under the deadline too, as the route composes them: the deadline still holds over a benched host.
  clock = 0
  const [d] = withDeadline(benchStalledHosts([slowButAnswers], 5500, () => clock), 100, () => clock)
  await d.request('one', [])
  await assert.rejects(d.request('two', []), /ran out of time/)
})

test('the admission route benches stalled hosts inside its deadline', () => {
  const src = readFileSync(repoPath('mcp/src/arc-owner-vault-live.ts'), 'utf8')
  assert.match(src, /withDeadline\(benchStalledHosts\(live, ROUTE_READ_TIMEOUT_MS - 500\), ROUTE_DEADLINE_MS\)/)
})

test('a stage reached while a question is out is asked when that one comes back, not lost', async () => {
  const { shouldAsk } = await loadRules()
  const asked = new Set(['0xh:before-done'])
  const failed = { state: 'failed', why: 'x' }
  assert.equal(shouldAsk('0xh:done', { state: 'checking' }, asked, true), false, 'never two questions at once')
  assert.equal(asked.has('0xh:done'), false, 'and the stage is still unasked')
  assert.equal(shouldAsk('0xh:done', failed, asked, false), true, 'the last screen asks when the first question came back failed')
  assert.equal(shouldAsk('0xh:done', { state: 'not-counted', reasons: ['r'], retryable: false }, asked, false), true)
  assert.equal(shouldAsk('0xh:done', { state: 'counted' }, asked, false), false, 'a vault already counted is not asked about again')
  assert.equal(shouldAsk('0xh:before-done', failed, asked, false), false, 'a stage is asked once')
  assert.equal(shouldAsk('0xh:before-done', null, new Set(), false), true, 'the first question goes out')
})

test('the page asks once more by itself only when time could change the answer', async () => {
  const { askAgainByItself } = await loadRules()
  assert.equal(askAgainByItself({ state: 'failed', why: 'x' }), true)
  assert.equal(askAgainByItself({ state: 'not-counted', reasons: ['r'], retryable: true }), true)
  assert.equal(askAgainByItself({ state: 'not-counted', reasons: ['r'], retryable: false }), false, 'a fact about the vault stays')
  assert.equal(askAgainByItself({ state: 'counted' }), false)
  assert.equal(askAgainByItself({ state: 'checking' }), false)
  assert.equal(askAgainByItself(null), false)
})

test('the rehearsal refuses an output folder git would publish, before any key exists', () => {
  const dir = 'scripts/rehearsal-outdir-probe'
  const run = (out: string) => spawnSync(process.execPath, [repoPath('scripts/rehearse-arc-vault.mjs'), 'http://127.0.0.1:1', out], { encoding: 'utf8', cwd: repoPath('.'), env: { PATH: process.env.PATH } })
  const inRepo = run(dir)
  assert.equal(inRepo.status, 2, inRepo.stderr)
  assert.match(inRepo.stderr, /git does not ignore it/)
  assert.equal(existsSync(repoPath(dir)), false, 'no folder was made')
  assert.equal(run('.').status, 2, 'the repository root is refused too')
})

test('the rehearsal counts a refusal only as the contract error it names, and gives admission no env', () => {
  const src = readFileSync(repoPath('scripts/rehearse-arc-vault.mjs'), 'utf8')
  assert.match(src, /check\(refusedBy\(refused, 'AboveAutoApprove'\)/)
  assert.match(src, /check\(refusedBy\(frozenRefused, 'IsFrozen'\)/)
  assert.doesNotMatch(src, /check\(Boolean\((refused|frozenRefused)\)/)
  assert.match(src, /arc-owner-vault-check\.mjs[^\n]*env: \{ PATH: process\.env\.PATH \} \}\)/)
  assert.match(src, /mode: 0o600, flag: 'wx'/, 'the key file never exists with default permissions')
})

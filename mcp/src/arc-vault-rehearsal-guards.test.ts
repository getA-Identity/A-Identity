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
type Held = { network: string; vault: string; hash: string }
type KnownList = { vaults: { network: string; address: string; kind: string }[]; partial: string | null; loading?: boolean } | null
const loadRules = async () =>
  (await import(repoUrl('src/lib/arc/vault-count.ts').href)) as {
    shouldAsk: (stage: string, count: VaultCount | null, asked: ReadonlySet<string>, sending: boolean) => boolean
    askAgainByItself: (count: VaultCount | null) => boolean
    setupStage: (hash: string | null, step: string) => string | null
    vaultPageStage: (hash: string | null, sessionKeyExpiry: bigint) => string | null
    deployHashFor: (testnet: boolean, network: string, vault: string, setup: unknown, held: readonly Held[]) => string | null
    vaultThisBrowserHolds: (setup: { vault?: string | null; network: string } | null, held: readonly Held[], network: string) => string | null
    listingOf: (known: KnownList, network: string, vault: string) => string
    shownCount: (hash: string | null, stage: string | null, asked: VaultCount | null, listing: string) => VaultCount
  }
const readSource = (rel: string) => readFileSync(repoPath(rel), 'utf8')

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

test('the deploy flow asks when it did: nothing before the end date, once before the last screen and once on it', async () => {
  const { setupStage } = await loadRules()
  for (const early of ['form', 'review', 'sending', 'deploying', 'expiry', 'expiry-pending', 'deploy-failed']) assert.equal(setupStage('0xh', early), null, early)
  assert.equal(setupStage('0xh', 'fund'), '0xh:before-done')
  assert.equal(setupStage('0xh', 'fund-pending'), '0xh:before-done')
  assert.equal(setupStage('0xh', 'done'), '0xh:done')
  assert.equal(setupStage(null, 'done'), null, 'no hash, no question')
})

test('the vault page asks once the key reads an end date, and again when the end date changes', async () => {
  const { vaultPageStage } = await loadRules()
  assert.equal(vaultPageStage('0xh', 0n), null, 'the deploy leaves it at 0, which admission refuses, so nothing is asked')
  assert.equal(vaultPageStage(null, 123n), null, 'no hash, no question')
  const first = vaultPageStage('0xh', 123n)
  assert.ok(first)
  assert.notEqual(vaultPageStage('0xh', 456n), first, 'a date that passed and was then extended is a new question')
  assert.equal(vaultPageStage('0xh', 123n), first, 'a re-read of the same date is not')
})

test('a vault page holds the hash this browser saw, and no other', async () => {
  const { deployHashFor } = await loadRules()
  const net = 'eip155:1'
  const setup = { network: net, vault: '0xAA', deploy: { hash: '0xh', outcome: 'settled' } }
  assert.equal(deployHashFor(false, net, '0xaa', setup, []), '0xh', 'the setup holds it, whatever the address case')
  assert.equal(deployHashFor(true, net, '0xaa', setup, []), null, 'a testnet vault is never asked about')
  assert.equal(deployHashFor(false, net, '0xbb', setup, []), null, 'the setup is about another vault')
  assert.equal(deployHashFor(false, 'eip155:2', '0xaa', setup, []), null, 'the same address on another network is another vault')
  const held = [{ network: net, vault: '0xBB', hash: '0xkept' }]
  assert.equal(deployHashFor(false, net, '0xbb', null, held), '0xkept', 'a forgotten setup leaves the hash kept when its deploy settled')
  assert.equal(deployHashFor(false, net, '0xbb', setup, held), '0xkept')
  assert.equal(deployHashFor(false, 'eip155:2', '0xbb', null, held), null)
  const replaced = { network: net, vault: '0xAA', deploy: { hash: '0xr', outcome: 'replaced' } }
  assert.equal(deployHashFor(false, net, '0xaa', replaced, []), null, 'a replaced hash created nothing the server can check')
})

test('a browser remembers each settled deploy by vault, and a repeat does not add a row', async () => {
  const pending = (await import(repoUrl('src/lib/arc/pending.ts').href)) as {
    loadDeploys: () => Held[]
    rememberDeploy: (d: Held) => void
  }
  const a = { network: 'n', vault: '0xAa', hash: '0x1' }
  pending.rememberDeploy(a)
  pending.rememberDeploy({ ...a, vault: '0xaA' })
  pending.rememberDeploy({ network: 'n', vault: '0xbb', hash: '0x2' })
  const rows = pending.loadDeploys()
  assert.deepEqual(rows.map((d) => d.vault), ['0xaA', '0xbb'], 'newest last, one row per vault')
})

test('a link with no vault opens the one this browser deployed, on the network the link named', async () => {
  const { vaultThisBrowserHolds } = await loadRules()
  const held = [{ network: 'n', vault: '0xold', hash: '0x1' }, { network: 'n', vault: '0xnew', hash: '0x2' }, { network: 'm', vault: '0xother', hash: '0x3' }]
  assert.equal(vaultThisBrowserHolds({ vault: '0xsetup', network: 'n' }, held, 'n'), '0xsetup')
  assert.equal(vaultThisBrowserHolds({ network: 'n' }, held, 'n'), '0xnew', 'a setup with no vault yet: the newest kept')
  assert.equal(vaultThisBrowserHolds(null, held, 'n'), '0xnew')
  assert.equal(vaultThisBrowserHolds({ vault: '0xsetup', network: 'n' }, [], 'm'), null, 'never across networks')
  assert.equal(vaultThisBrowserHolds(null, [], 'n'), null, 'nothing held: the page lands as it always did')
  const page = readSource('src/routes/app/ArcVault.tsx')
  assert.ok(page.indexOf('vaultThisBrowserHolds(setup') < page.indexOf('autoLandVault(known.vaults'), 'before the list, which an uncounted vault is not on')
})

test('only a list that loaded can say a vault is not on it', async () => {
  const { listingOf, shownCount } = await loadRules()
  const row = { network: 'n', address: '0xAA', kind: 'owner-held' }
  assert.equal(listingOf(null, 'n', '0xaa'), 'reading')
  assert.equal(listingOf({ vaults: [row], partial: null, loading: true }, 'n', '0xaa'), 'reading')
  assert.equal(listingOf({ vaults: [row], partial: null }, 'n', '0xaa'), 'listed')
  assert.equal(listingOf({ vaults: [row], partial: 'x' }, 'n', '0xaa'), 'listed', 'a partial list still holds what it holds')
  assert.equal(listingOf({ vaults: [], partial: null }, 'n', '0xaa'), 'not-listed')
  assert.equal(listingOf({ vaults: [], partial: 'x' }, 'n', '0xaa'), 'unreadable', 'no answer is not a no')
  assert.equal(listingOf({ vaults: [{ ...row, kind: 'ours' }], partial: null }, 'n', '0xaa'), 'not-listed', 'ours is not counted')
  assert.equal(listingOf({ vaults: [{ ...row, network: 'm' }], partial: null }, 'n', '0xaa'), 'not-listed')

  // The season report answers with the curated list alone when the admitted list is unreadable.
  const lib = readSource('src/lib/arc/known-vaults.ts')
  assert.match(lib, /season\.logs\?\.admittedVaults\?\.readable === false/, 'an unreadable admitted list must read as partial, or an uncounted line would be a guess')

  const failed = { state: 'failed', why: 'x' }
  const refused = { state: 'not-counted', reasons: ['r'], retryable: false }
  // No hash: the list is all there is, and it never says more than it knows.
  assert.equal(shownCount(null, null, null, 'listed').state, 'counted')
  assert.equal(shownCount(null, null, null, 'not-listed').state, 'no-hash')
  assert.equal(shownCount(null, null, null, 'unreadable').state, 'failed')
  assert.equal(shownCount(null, null, null, 'reading').state, 'checking')
  // A hash and no end date: nothing asked, and not called refused.
  assert.equal(shownCount('0xh', null, null, 'not-listed').state, 'needs-end-date')
  assert.equal(shownCount('0xh', null, null, 'listed').state, 'counted', 'a counted vault whose key was later revoked stays counted')
  // A hash and a question: its answer, whatever the list says.
  assert.equal(shownCount('0xh', 's', null, 'not-listed').state, 'checking')
  assert.deepEqual(shownCount('0xh', 's', refused, 'not-listed'), refused)
  assert.deepEqual(shownCount('0xh', 's', failed, 'unreadable'), failed)
  assert.equal(shownCount('0xh', 's', { state: 'counted' }, 'not-listed').state, 'counted', 'the answer is newer than the list the page read')
})

test('the vault page reuses the hook and the notice, asks with no wallet, and the route is the only way in', () => {
  const page = readSource('src/routes/app/ArcVault.tsx')
  assert.match(page, /useVaultCount\(\{ hash, stage: vaultPageStage\(hash, expiry\), listing, onReadListAgain \}\)/)
  assert.match(page, /<VaultCountNotice /)
  assert.match(page, /rememberDeploy\(\{ network: setup\.network, vault: setup\.vault, hash \}\)/, 'kept when the deploy settles, before anyone can forget the setup')
  assert.match(page, /!ours && !ownerIsOurKey/, 'ours never counts, so it is never asked about')
  const hook = readSource('src/components/app/arc/useVaultCount.ts')
  assert.equal([...hook.matchAll(/apiFetch\(/g)].length, 1, 'one way to ask')
  assert.doesNotMatch(hook, /sendPrepared|eth_sendTransaction|personal_sign|signMessage|provider/, 'no wallet')
  for (const rel of ['src/lib/arc/vault-count.ts', 'src/routes/app/ArcVault.tsx', 'src/components/app/arc/DeployFlow.tsx', 'src/components/app/arc/VaultCountNotice.tsx']) {
    assert.doesNotMatch(readSource(rel), /apiFetch\('\/api\/arc\/vaults'/, `${rel} must go through the hook`)
  }
  // Nothing on the page waits on it.
  assert.doesNotMatch(page, /disabled=\{[^}]*(deployHash|ownersVault|count)\b/)
  assert.doesNotMatch(readSource('src/components/app/arc/DeployFlow.tsx'), /disabled=\{[^}]*vaultCount/)
})

test('the notice says what it cannot know as that', () => {
  const notice = readSource('src/components/app/arc/VaultCountNotice.tsx')
  assert.match(notice, /once its agent key has an end date/)
  assert.match(notice, /This browser does not hold the transaction that created it, so it cannot ask by itself/)
  assert.match(notice, /If you deployed it from another browser or device, open this page there/)
  assert.match(notice, /We could not find out whether this vault counts on/)
})

test('admission is what it was: only the deploy hash goes in, and the same checks stand', () => {
  const live = readSource('mcp/src/arc-owner-vault-live.ts')
  assert.match(live, /const b = \(body \?\? \{\}\) as \{ deployTx\?: unknown; chain\?: unknown \}/, 'the route takes no vault address: the explorer gives this server no creation transaction')
  assert.match(live, /ownerKind: 'unstated'/)
  assert.doesNotMatch(live, /explorer\.[a-z]+\/api|\/api\/v2\//, 'nothing here reads an explorer')
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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { REVOKED_KEY_EXPIRY } from './arc-owner-vault.js'
import { benchStalledHosts, withDeadline, type RpcHost } from './arc-owner-vault-live.js'
import { rateBudget } from './rate-budget.js'

/**
 * Guards the fork rehearsal found or needed: a stalled host must not use up an admission's deadline,
 * when the deploy page asks the server to count a vault, and what scripts/rehearse-arc-vault.mjs
 * refuses before it holds any key. The whole path runs in scripts/rehearse-arc-vault-fork.mjs against
 * a real EVM and a real browser, which CI does not do; these keep the rules from sliding back.
 */

const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repoPath = (rel: string) => fileURLToPath(repoUrl(rel))

type VaultCount = { state: string; retryable?: boolean; reasons?: string[]; why?: string; waitMs?: number }
type Held = { network: string; vault: string; hash: string }
type KnownList = { vaults: { network: string; address: string; kind: string }[]; partial: string | null; ownerHeldRead?: boolean } | null
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
    vaultCountFromAnswer: (httpStatus: number, body: unknown) => VaultCount
    listReads: <T>(deliver: (answer: T) => void) => { begin: () => (answer: T) => void; out: () => boolean; stop: () => void }
    endDateOf: (sessionKeyExpiry: bigint, expired: boolean) => string
    endDateFromRead: (live: { sessionKeyExpiry: bigint; expired: boolean } | null, readBehind: boolean) => string
    sweepSaysFrom: (body: unknown) => string
    noHashWords: (endDate: string, sweep: string) => string
    PAST_RATE_WINDOW_MS: number
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
  const read = (vaults: { network: string; address: string; kind: string }[], partial: string | null = null) => ({ vaults, partial, ownerHeldRead: true })
  assert.equal(listingOf(null, 'n', '0xaa'), 'reading')
  assert.equal(listingOf({ vaults: [], partial: null }, 'n', '0xaa'), 'reading', 'the first render lists what the build knows, which is no answer')
  assert.equal(listingOf(read([row]), 'n', '0xaa'), 'listed')
  assert.equal(listingOf(read([row], 'x'), 'n', '0xaa'), 'listed', 'a partial list still holds what it holds')
  assert.equal(listingOf(read([]), 'n', '0xaa'), 'not-listed')
  assert.equal(listingOf(read([], 'x'), 'n', '0xaa'), 'unreadable', 'no answer is not a no')
  assert.equal(listingOf(read([{ ...row, kind: 'ours' }]), 'n', '0xaa'), 'not-listed', 'ours is not counted')
  assert.equal(listingOf(read([{ ...row, network: 'm' }]), 'n', '0xaa'), 'not-listed')

  // The season report answers with the curated list alone when the admitted list is unreadable.
  const lib = readSource('src/lib/arc/known-vaults.ts')
  assert.match(lib, /season\.logs\?\.admittedVaults\?\.readable === false/, 'an unreadable admitted list must read as partial, or an uncounted line would be a guess')
  // A slow proof route must not keep an owner waiting on an answer it plays no part in.
  assert.match(lib, /void seasonRead\.then\(\(season\) => onOwnerHeldRead\?\.\(\{ \.\.\.knownFrom\(null, season\)/)

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

test('the no-hash failure line is true whether the server gave no answer, a 429 or a list it could not read', async () => {
  const { shownCount } = await loadRules()
  const told = shownCount(null, null, null, 'unreadable')
  assert.equal(told.state, 'failed')
  assert.equal(told.why, 'Our server could not give its list of counted vaults just now.')
  assert.doesNotMatch(told.why ?? '', /did not answer/)
  assert.doesNotMatch(readSource('src/lib/arc/known-vaults.ts'), /did not answer/)
})

test('a 429 does not blame the owner, and the page asks again only past the route\'s window', async () => {
  const { vaultCountFromAnswer, askAgainByItself, PAST_RATE_WINDOW_MS } = await loadRules()
  const limited = vaultCountFromAnswer(429, { error: 'Too many requests.' })
  assert.equal(limited.state, 'failed')
  assert.doesNotMatch(limited.why ?? '', /your|connection|you\b/i, 'through the site the limit is shared with strangers')
  assert.equal(limited.waitMs, PAST_RATE_WINDOW_MS)
  assert.equal(askAgainByItself(limited), true)
  const budget = rateBudget('POST', '/api/arc/vaults')
  assert.ok(budget && PAST_RATE_WINDOW_MS > budget.windowMs, 'a retry inside the window could only be refused again')
  assert.equal(vaultCountFromAnswer(503, { status: 'unavailable', retryable: true }).waitMs, undefined, 'anything else keeps the usual delay')
  const hook = readSource('src/components/app/arc/useVaultCount.ts')
  assert.match(hook, /answer\.waitMs \?\? AUTO_RETRY_MS/)
})

test('only the newest read of the list may answer, and a read out holds a second one', async () => {
  const { listReads } = await loadRules()
  const shown: string[] = []
  const reads = listReads<string>((a) => shown.push(a))
  assert.equal(reads.out(), false)

  // The first load's proof read is slow; its season read has failed, so the owner clicks Try again.
  const first = reads.begin()
  first('first: season failed')
  assert.equal(reads.out(), false, 'that answered, so a click can start a new read')
  const second = reads.begin()
  assert.equal(reads.out(), true, 'a further click finds this one out')
  second('second: season answered')
  assert.equal(reads.out(), false)
  first('first: its Promise.all ends with season null')
  assert.deepEqual(shown, ['first: season failed', 'second: season answered'], 'the older read does not overwrite the newer')
  second('second: with proof')
  assert.equal(shown.at(-1), 'second: with proof')

  const third = reads.begin()
  reads.stop()
  third('after the page closed')
  assert.equal(shown.at(-1), 'second: with proof')
  assert.equal(reads.out(), false)

  const page = readSource('src/routes/app/ArcVault.tsx')
  assert.match(page, /listReads<KnownVaults>\(setKnown\)/)
  assert.equal([...page.matchAll(/listKnownVaults\(/g)].length, 1, 'the first load and Try again are the same read')
  assert.match(page, /if \(reads\.out\(\)\) return\n\s+setKnown\(\(k\) => k && \{ \.\.\.k, partial: null, loading: true, ownerHeldRead: false \}\)/, 'the click shows at once, and does nothing while a read is out')
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
  assert.doesNotMatch(notice, /send its hash|open this page there/)
  assert.match(notice, /We could not find out whether this vault counts on/)
  // A vault whose end date has passed does not work as one: pay reverts. Whether it counts is what changes nothing.
  assert.match(notice, /Being counted or not changes nothing in how it works\./)
  assert.doesNotMatch(notice, /still works as a vault/)
})

test('with no hash the page says why from the end date, and says the server is looking only when the server says so', async () => {
  const { endDateOf, noHashWords, sweepSaysFrom } = await loadRules()
  const LOOKS = /our server looks for vaults on the chain by itself/
  // With no hash in this browser the server finds a vault by itself, so nobody is sent to a person first.
  const none = noHashWords('none', 'looking')
  assert.match(none, /^, because its agent key has no end date\. Set one in the Session key box on this vault's page, with its Set the expiry button\. You do not have to send anything to anyone: our server looks/)
  assert.match(none, /finds this one once it has an end date/)
  const future = noHashWords('future', 'looking')
  assert.match(future, /^\. You do not have to send anything to anyone/)
  assert.match(future, /this one has the agent key end date it looks for/)
  assert.match(future, /If it still says this tomorrow, tell the A-Identity team/)

  // A date that has passed: the one action that fixes it is renewing, so it says so and sends nobody to a person.
  const passed = noHashWords('passed', 'looking')
  assert.match(passed, /because its agent key's end date has passed\. Set a new one in the Session key box on this vault's page, with its Extend or shorten button\./)
  assert.match(passed, /within about an hour of the new end date/)
  assert.doesNotMatch(passed, /has the agent key end date it looks for|A-Identity team/)
  assert.equal(endDateOf(0n, false), 'none')
  assert.equal(endDateOf(5000n, false), 'future')
  assert.equal(endDateOf(5000n, true), 'passed')

  // Revoked: admission takes it and the sweep finds it from the revoke's own log, so the key being off is no reason, and nothing is asked of the owner.
  assert.equal(endDateOf(REVOKED_KEY_EXPIRY, true), 'revoked', 'the very value admission takes')
  assert.equal(endDateOf(REVOKED_KEY_EXPIRY + 1n, true), 'passed', 'and only that value: admission refuses any other date in the past')
  const revoked = noHashWords('revoked', 'looking')
  assert.match(revoked, /^\. Its agent key is revoked, and that does not stop a vault counting\. You do not have to send anything to anyone: our server looks/)
  assert.match(revoked, /it finds this one with its key revoked too/)
  assert.match(revoked, /If it still says this tomorrow, tell the A-Identity team/)
  assert.doesNotMatch(revoked, /has passed|new one|Set |end date/, 'it never asks an owner to turn back on a key they just cut off')
  assert.equal(noHashWords('revoked', 'reading'), '. Its agent key is revoked, and that does not stop a vault counting.', 'it says what the read showed, and claims no search')
  assert.match(noHashWords('revoked', 'not-looking'), /that does not stop a vault counting\. Our server is not looking .* so if another browser/, 'nothing to do first, so no after that')

  // Off, or not able to admit: nobody is looking, and it gives the path that still works.
  for (const endDate of ['none', 'passed', 'revoked', 'future', 'unknown']) {
    for (const sweep of ['not-looking', 'unknown', 'reading']) {
      const words = noHashWords(endDate, sweep)
      assert.doesNotMatch(words, LOOKS, `${endDate} ${sweep}`)
      assert.doesNotMatch(words, /has the agent key end date it looks for/)
      // This browser holds no hash whoever sent the deploy, and on the setup's last screen it is always the one that did, so only another one can ask.
      if (sweep !== 'reading') assert.match(words, /if another browser of yours saw this vault's deploy land, open this vault there: it can ask by itself\. If none did, tell the A-Identity team\./)
      assert.doesNotMatch(words, /the browser that deployed/)
    }
    assert.match(noHashWords(endDate, 'looking'), LOOKS, endDate)
  }
  assert.match(noHashWords('future', 'not-looking'), /^\. Our server is not looking for vaults on the chain right now/)
  assert.match(noHashWords('none', 'not-looking'), /with its Set the expiry button\. Our server is not looking .* so after that, if another browser/)
  assert.match(noHashWords('passed', 'unknown'), /with its Extend or shorten button\. We could not find out .* so after that, if another browser/)
  assert.match(noHashWords('future', 'unknown'), /We could not find out whether our server is looking/)
  assert.equal(noHashWords('future', 'reading'), '.', 'nothing is claimed while it reads')

  const on = (lastProblem: string | null) => ({ sweep: { on: true, lastBlockRead: '1', lastRun: 'x', lastProblem } })
  assert.equal(sweepSaysFrom(on(null)), 'looking')
  for (const word of ['no-host-answered', 'logs-not-read', 'read-cap-reached', 'ran-out-of-time', 'deploy-not-read', 'hosts-disagree', 'admission-unavailable']) {
    assert.equal(sweepSaysFrom(on(word)), 'looking', `${word} is a read it tries again`)
  }
  for (const word of ['admission-not-ready', 'list-unreadable', 'round-failed', 'round-stalled']) assert.equal(sweepSaysFrom(on(word)), 'not-looking', word)
  assert.equal(sweepSaysFrom({ sweep: { on: false, lastBlockRead: null, lastRun: null, lastProblem: null } }), 'not-looking')
  for (const body of [null, {}, { sweep: null }, { sweep: { on: 'yes' } }]) assert.equal(sweepSaysFrom(body), 'unknown')
})

test('the words name the box and the buttons the page really has, for an owner on the vault page or on the last screen of the setup', async () => {
  const { noHashWords } = await loadRules()
  const controls = readSource('src/components/app/arc/OwnerControls.tsx')
  assert.match(controls, /<Card title="Session key">/)
  assert.match(controls, /vault\.sessionKeyExpiry === 0n \? 'Set the expiry' : 'Extend or shorten'/, 'a key with no date gets the first button, and any other the second')
  for (const endDate of ['none', 'passed']) {
    assert.match(noHashWords(endDate, 'reading'), /in the Session key box on this vault's page/, 'the last screen of the setup has no such box, so the words say where it is')
    assert.doesNotMatch(noHashWords(endDate, 'reading'), /from this page/)
  }
  // The last screen offers the way there, right under the line.
  const flow = readSource('src/components/app/arc/DeployFlow.tsx')
  const done = flow.slice(flow.indexOf('<VaultCountNotice '))
  assert.ok(done.indexOf('Open the vault') > 0 && done.indexOf('Open the vault') < 800)
})

test('the no-hash line can read the list again, because Refresh reads only the chain and the line tells the owner to look', async () => {
  const notice = readSource('src/components/app/arc/VaultCountNotice.tsx')
  const line = notice.slice(notice.indexOf("count.state === 'no-hash') {"), notice.indexOf("count.state === 'checking'"))
  assert.match(line, /\{noHashWords\(endDate, sweep\)\} \{lookAgain\}/, 'whatever the words are, in every state of the search: a read of it that failed recovers through this')
  assert.match(notice, /const lookAgain = \(\s*<button type="button" onClick=\{onRetry\}[^>]*>\s*Look again\s*<\/button>/)

  // The click reaches the list: a null hash goes to the page's read of the list, from both places that show the line.
  const hook = readSource('src/components/app/arc/useVaultCount.ts')
  assert.match(hook, /if \(hash\) void send\(hash\)\s*else onReadListAgain\(\)/)
  assert.match(readSource('src/routes/app/ArcVault.tsx'), /const \{ count, retry \} = useVaultCount[^\n]*\n[^\n]*onRetry=\{retry\}/)
  assert.match(readSource('src/components/app/arc/DeployFlow.tsx'), /onRetry=\{vaultCount\.retry\}/)

  // That read takes the line away and brings it back, or brings the answer.
  const { listingOf, shownCount } = await loadRules()
  const listing = (ownerHeldRead: boolean, address?: string) => listingOf({ vaults: address ? [{ network: 'n', address, kind: 'owner-held' }] : [], partial: null, ownerHeldRead }, 'n', '0xaa')
  assert.equal(shownCount(null, null, null, listing(true)).state, 'no-hash')
  assert.equal(shownCount(null, null, null, listing(false)).state, 'checking', 'the click shows at once')
  assert.equal(shownCount(null, null, null, listing(true)).state, 'no-hash', 'the line comes back, so the search is asked about again')
  assert.equal(shownCount(null, null, null, listing(true, '0xAA')).state, 'counted', 'or a vault the sweep has counted says so, with no reload')

  // The line coming back is what asks about the search again, and nothing from the last answer is said meanwhile.
  assert.match(notice, /const needsSweep = !testnet && count\.state === 'no-hash'/)
  assert.match(notice, /if \(!needsSweep\) return\n\s+let current = true\n\s+setSweep\('reading'\)\n\s+void readSweepSays\(\)/)
  assert.match(notice, /\}, \[needsSweep\]\)/)
})

test('the words the page reads are the words the sweep can say', async () => {
  const sweep = readSource('mcp/src/arc-vault-sweep.ts')
  for (const word of ['admission-not-ready', 'list-unreadable', 'round-failed', 'round-stalled']) assert.match(sweep, new RegExp(`\\| '${word}'`), word)
})

test('both places that show the notice pass what the vault reads as, and the prop has no default that could claim a date', () => {
  const page = readSource('src/routes/app/ArcVault.tsx')
  assert.match(page, /expired=\{v\.expired\}/, 'the vault page passes whether the date has passed')
  assert.match(page, /endDate=\{endDateOf\(expiry, expired\)\}/)
  const flow = readSource('src/components/app/arc/DeployFlow.tsx')
  assert.match(flow, /endDate=\{endDateFromRead\(liveVault, expiryReadBehind\)\}/)
  assert.match(flow, /const liveVault = setup \? liveOf\(setup, snapshot\) : null/, 'with the network check liveOf has')
  assert.match(flow, /const expiryReadBehind = setup \? readBeforeExpiry\(setup, snapshot\) : false/)
  const notice = readSource('src/components/app/arc/VaultCountNotice.tsx')
  assert.match(notice, /^ {2}endDate: EndDate$/m, 'required')
  assert.doesNotMatch(notice, /endDate\s*=\s*'/, 'with no default')
  assert.match(notice, /readSweepSays\(\)/, 'and it asks the server whether anyone is looking')
})

test('on the last screen a read from before the end date, or of another network, says nothing about the end date', async () => {
  const { endDateFromRead, endDateOf, noHashWords } = await loadRules()
  const rules = (await import(repoUrl('src/lib/arc/tx-rules.ts').href)) as {
    liveOf: (setup: unknown, snapshot: unknown) => { sessionKeyExpiry: bigint; expired: boolean } | null
    readBeforeExpiry: (setup: unknown, snapshot: unknown) => boolean
  }
  const setup = { network: 'n', vault: '0xAA', expiryTx: { action: 'expiry', outcome: 'settled', hash: '0xh', block: 100n } }
  const snap = (over: Record<string, unknown>) => ({ network: 'n', address: '0xaa', block: 100n, sessionKeyExpiry: 5000n, expired: false, ...over })
  const onScreen = (snapshot: unknown) => endDateFromRead(rules.liveOf(setup, snapshot), rules.readBeforeExpiry(setup, snapshot))

  // The deploy left 0, and this host has not reached the block of the write. The box says it is still being read.
  const behind = snap({ block: 99n, sessionKeyExpiry: 0n })
  assert.equal(endDateOf(0n, false), 'none', 'as a plain read it would say no end date')
  assert.equal(onScreen(behind), 'unknown')
  assert.doesNotMatch(noHashWords(onScreen(behind), 'looking'), /has no end date/, 'so the line does not say so beside it')
  assert.equal(onScreen(snap({ sessionKeyExpiry: 0n })), 'none', 'a read that reached the block and reads 0 is a key with no date')
  assert.equal(onScreen(snap({})), 'future')
  assert.equal(onScreen(snap({ sessionKeyExpiry: 1n, expired: true })), 'revoked')
  assert.equal(onScreen(snap({ sessionKeyExpiry: 2n, expired: true })), 'passed')

  assert.equal(onScreen(snap({ network: 'm' })), 'unknown', 'the same address on another network is another vault')
  assert.equal(onScreen(snap({ address: '0xbb' })), 'unknown', 'another vault')
  assert.equal(onScreen(null), 'unknown', 'nothing read yet')
})

test('admission is what it was: only the deploy hash goes in, and the same checks stand', () => {
  const live = readSource('mcp/src/arc-owner-vault-live.ts')
  assert.match(live, /const b = \(body \?\? \{\}\) as \{ deployTx\?: unknown; chain\?: unknown \}/, 'the route takes no vault address: finding a hash from one costs a bisect, which a public route should not run for any caller')
  assert.match(live, /ownerKind: 'unstated'/)
  assert.doesNotMatch(live, /explorer\.[a-z]+\/api|\/api\/v2\//, 'nothing here reads an explorer')
  // The sweep finds a hash from the chain alone, so the explorer is not why, and the docs give the real reason.
  const readme = readSource('mcp/README.md')
  assert.match(readme, /The route takes no vault address on purpose: finding a hash from an address costs a bisect of about 25\s+reads plus a block read/)
  assert.doesNotMatch(readme, /one public source of a contract's|the server cannot get it reliably/)
  assert.doesNotMatch(readSource('mcp/src/chains/registry.ts'), /cannot derive a deploy hash/)
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

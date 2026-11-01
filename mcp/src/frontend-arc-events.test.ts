import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The Arc vault page's event history, run from src/ as it ships, against fake hosts. What it
 * RETURNS and what the fake hosts are asked is the guard: the cap on eth_getLogs, the union of two
 * hosts, and above all that "no activity" is never said of a block that was not read.
 */

const repoUrl = (rel: string) => new URL(`../../${rel}`, import.meta.url)
const repo = (rel: string) => readFileSync(fileURLToPath(repoUrl(rel)), 'utf8')

type Range = { from: bigint; to: bigint }
type RawLog = {
  address: string
  eventName?: string
  args?: Record<string, unknown>
  blockNumber: bigint | null
  transactionHash: string | null
  logIndex: number | null
  removed?: boolean
}
type Reader = { host: string; logs: (from: bigint, to: bigint) => Promise<readonly RawLog[]>; blockTime?: (block: bigint) => Promise<bigint | null> }
type Event = { kind: string; block: bigint; logIndex: number; txHash: string; hosts: string[]; to?: string; amount?: bigint; byOwner?: boolean; frozen?: boolean }
type History = {
  vault: string
  head: bigint | null
  windows: (Range & { hosts: string[] })[]
  events: Event[]
  failed: { range: Range | null; reason: string } | null
  skipped: { host: string; reason: string }[]
  dropped: number
  times: Record<string, bigint>
}
type Module = {
  LOG_WINDOW_BLOCKS: bigint
  WINDOWS_PER_READ: number
  MAX_WINDOWS: number
  HOSTS_PER_WINDOW: number
  HOST_STRIKES: number
  HEAD_LAG_BLOCKS: bigint
  EVENTS_SHOWN: number
  emptyHistory: (vault: string, head: bigint | null) => History
  planWindows: (top: bigint, count: number, size?: bigint) => Range[]
  pickHosts: (heads: { host: string; chainId: number | null; block: bigint | null; reason?: string }[], chainId: number) => { top: bigint | null; usable: string[]; skipped: { host: string; reason: string }[] }
  nextWindowTop: (h: History) => bigint | null
  readOlder: (h: History, x: { readers: readonly Reader[]; pause?: () => Promise<void>; aborted?: () => boolean; onProgress?: (h: History) => void }) => Promise<History>
  covered: (h: History) => Range | null
  withBlockTimes: (h: History, x: { readers: readonly Reader[]; pause?: () => Promise<void>; aborted?: () => boolean }) => Promise<History>
  oneHostRanges: (h: History) => Range[]
  historyStatement: (h: History) => { claim: string; limits: string[] }
}

const mod = async () => (await import(repoUrl('src/lib/arc/event-history.ts').href)) as Module

const VAULT = '0x3333333333333333333333333333333333333333'
const PAYEE = '0x2222222222222222222222222222222222222222'
const OTHER = '0x4444444444444444444444444444444444444444'
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`

const paid = (block: bigint, logIndex = 0, over: Partial<RawLog> = {}): RawLog => ({
  address: VAULT,
  eventName: 'Paid',
  args: { to: PAYEE, amount: 10_000n, dayIndex: 1n, byOwner: false },
  blockNumber: block,
  transactionHash: hash(Number(block)),
  logIndex,
  ...over,
})

/** A host that answers from a list of logs by range, and records every range it is asked. */
function host(name: string, logs: RawLog[] = [], opts: { fails?: (r: Range) => string | null; time?: (b: bigint) => bigint | null } = {}) {
  const asked: Range[] = []
  const reader: Reader = {
    host: name,
    logs: async (from, to) => {
      asked.push({ from, to })
      const why = opts.fails?.({ from, to })
      if (why) throw Object.assign(new Error(`long detail\n${why}`), { shortMessage: why })
      return logs.filter((l) => l.blockNumber !== null && l.blockNumber >= from && l.blockNumber <= to)
    },
    blockTime: opts.time ? async (b) => opts.time?.(b) ?? null : undefined,
  }
  return { reader, asked }
}

test('every window is within the eth_getLogs cap, contiguous from the newest block, and never below block 0', async () => {
  const m = await mod()
  assert.equal(m.LOG_WINDOW_BLOCKS, 10_000n, "the cap Arc's RPCs enforce, counting both ends")
  const plan = m.planWindows(1_000_000n, 3)
  assert.deepEqual(plan, [
    { from: 990_001n, to: 1_000_000n },
    { from: 980_001n, to: 990_000n },
    { from: 970_001n, to: 980_000n },
  ])
  for (const w of plan) assert.equal(w.to - w.from + 1n, m.LOG_WINDOW_BLOCKS)
  assert.deepEqual(m.planWindows(15_000n, 5), [
    { from: 5_001n, to: 15_000n },
    { from: 0n, to: 5_000n },
  ])
})

test('the read is bounded: two hosts a window, one window at a time, a pause between, and no more than the limit', async () => {
  const m = await mod()
  let inFlight = 0
  let peak = 0
  const slow = (name: string): Reader => ({
    host: name,
    logs: async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return []
    },
  })
  const hosts = [slow('a'), slow('b'), slow('c'), slow('d')]
  let pauses = 0
  const h = await m.readOlder(m.emptyHistory(VAULT, 2_000_000n), {
    readers: hosts,
    pause: async () => {
      pauses += 1
      assert.equal(inFlight, 0, 'a pause falls between windows, with nothing in flight')
    },
  })
  assert.equal(h.windows.length, m.WINDOWS_PER_READ)
  assert.equal(pauses, m.WINDOWS_PER_READ - 1)
  assert.equal(peak, m.HOSTS_PER_WINDOW)
  assert.ok(h.windows.every((w) => w.hosts.length === m.HOSTS_PER_WINDOW))

  // However often it is asked for more, the page stops at its limit, and offers nothing further.
  let all = h
  for (let i = 0; i < m.MAX_WINDOWS; i++) all = await m.readOlder(all, { readers: hosts })
  assert.equal(all.windows.length, m.MAX_WINDOWS)
  assert.equal(m.nextWindowTop(all), null)
  const again = await m.readOlder(all, { readers: hosts })
  assert.equal(again.windows.length, m.MAX_WINDOWS)
})

test('the union of two hosts is what is shown, each event once, newest first, and only the vault\'s own', async () => {
  const m = await mod()
  const onlyB = paid(1_000_000n, 3)
  const both = paid(999_000n, 1)
  const frozen: RawLog = { address: VAULT, eventName: 'FrozenSet', args: { frozen: true }, blockNumber: 999_000n, transactionHash: hash(7), logIndex: 2 }
  const withdrawn: RawLog = { address: VAULT, eventName: 'Withdrawn', args: { to: PAYEE, amount: 5n }, blockNumber: 998_000n, transactionHash: hash(8), logIndex: 0 }
  const a = host('a', [both, frozen, { ...paid(999_500n), address: OTHER }])
  const b = host('b', [onlyB, { ...both, transactionHash: (both.transactionHash as string).toUpperCase().replace('0X', '0x') }, withdrawn])
  const h = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), { readers: [a.reader, b.reader] })
  assert.deepEqual(h.events.map((e) => e.kind), ['Paid', 'FrozenSet', 'Paid', 'Withdrawn'])
  assert.deepEqual(h.events.map((e) => [e.block, e.logIndex]), [[1_000_000n, 3], [999_000n, 2], [999_000n, 1], [998_000n, 0]])
  assert.deepEqual(h.events[0].hosts, ['b'], 'an event one host misses still shows')
  assert.deepEqual(h.events[2].hosts, ['a', 'b'], 'the same log from two hosts is one event')
  assert.equal(h.events.some((e) => e.block === 999_500n), false, 'a log from another contract is never taken')
  assert.equal(h.events[0].byOwner, false)
  assert.equal(h.events[1].frozen, true)
  assert.equal(h.events[3].amount, 5n)
  assert.match(m.historyStatement(h).claim, /^4 Paid, FrozenSet or Withdrawn events in blocks 880,001 to 1,000,000\.$/)
})

test('a host that fails hands the window to the next, and one that keeps failing stops being asked while another answers', async () => {
  const m = await mod()
  const pruned = host('pruned', [], { fails: (r) => (r.to < 995_000n ? 'pruned history unavailable' : null) })
  const refuses = host('refuses', [], { fails: () => 'ranges over 10000 blocks are not supported on free plan' })
  const good = host('good', [paid(985_000n)])
  const h = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), { readers: [pruned.reader, refuses.reader, good.reader] })
  assert.equal(h.failed, null)
  assert.equal(h.windows.length, m.WINDOWS_PER_READ)
  assert.deepEqual(h.windows[0].hosts, ['pruned', 'good'], 'a second host was found for the first window')
  assert.equal(h.events.length, 1)
  assert.equal(refuses.asked.length, m.HOST_STRIKES, 'a host that keeps refusing is not asked for every window')
  assert.equal(pruned.asked.length, 1 + m.HOST_STRIKES, 'nor is one that has pruned these blocks')
  assert.equal(good.asked.length, m.WINDOWS_PER_READ)
  // Once only one host answers, that is said, as one range.
  const late = h.windows[h.windows.length - 1]
  assert.deepEqual(late.hosts, ['good'])
  const single = m.oneHostRanges(h)
  assert.deepEqual(single, [{ from: late.from, to: h.windows[1].to }])
  assert.ok(m.historyStatement(h).limits.some((l) => /answered by one RPC only/.test(l)))

  // A host that keeps failing is still asked when nobody else answers: a window is given up on
  // only after every host has had its say.
  let flip = false
  const late1 = host('late1', [], { fails: () => (flip ? null : 'timeout') })
  const late2 = host('late2', [], { fails: (r) => (r.to < 985_000n ? 'gone' : null) })
  const mixed = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), {
    readers: [late1.reader, late2.reader],
    onProgress: (x) => {
      if (x.windows.length === 2) flip = true
    },
  })
  assert.equal(mixed.failed, null)
  assert.equal(mixed.windows.length, m.WINDOWS_PER_READ)
  assert.deepEqual(mixed.windows[2].hosts, ['late1'], 'the struck host was asked again when the other had gone')
})

test('a window no host answers stops the read: nothing below it is asked, and nothing is claimed about it', async () => {
  const m = await mod()
  const down = (r: Range) => (r.to <= 980_000n ? '429 rate limit' : null)
  const a = host('a', [], { fails: down })
  const b = host('b', [], { fails: down })
  const h = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), { readers: [a.reader, b.reader] })
  assert.equal(h.windows.length, 2)
  assert.deepEqual(h.failed?.range, { from: 970_001n, to: 980_000n })
  assert.match(h.failed?.reason ?? '', /429 rate limit/)
  assert.doesNotMatch(h.failed?.reason ?? '', /long detail/, 'one line of a host error')
  const lowest = [...a.asked, ...b.asked].reduce((min, r) => (r.from < min ? r.from : min), 1_000_000n)
  assert.equal(lowest, 970_001n, 'nothing older was asked')
  const s = m.historyStatement(h)
  assert.equal(s.claim, 'No Paid, FrozenSet or Withdrawn event in blocks 980,001 to 1,000,000.', 'the claim stops where the read did')
  assert.ok(s.limits.some((l) => /No RPC answered for blocks 970,001 to 980,000/.test(l)))
  assert.ok(s.limits.some((l) => /Blocks before 980,001 were not read/.test(l)))

  // Asked again, the read continues at the window that failed, so the range stays contiguous.
  const healthy = host('healthy', [paid(975_000n)])
  const next = await m.readOlder(h, { readers: [healthy.reader] })
  assert.equal(healthy.asked[0].to, 980_000n)
  assert.equal(next.failed, null)
  const c = m.covered(next)
  assert.equal(c?.to, 1_000_000n)
  for (let i = 1; i < next.windows.length; i++) assert.equal(next.windows[i].to, next.windows[i - 1].from - 1n, 'no gap between windows')
  assert.equal(next.events.length, 1)
})

test('with nothing read, nothing is said about activity, whatever the reason', async () => {
  const m = await mod()
  const a = host('a', [], { fails: () => 'timeout' })
  const none = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), { readers: [a.reader] })
  assert.equal(m.covered(none), null)
  const s = m.historyStatement(none)
  assert.equal(s.claim, "No block range could be read, so this says nothing about the vault's activity.")
  assert.doesNotMatch(s.claim, /No Paid/)
  // No host at all gives the same answer.
  const noHosts = m.historyStatement({ ...m.emptyHistory(VAULT, 0n), failed: { range: null, reason: 'no RPC answered for this chain' }, skipped: [{ host: 'x', reason: 'timeout' }] })
  assert.doesNotMatch(noHosts.claim, /No Paid/)
  assert.ok(noHosts.limits.some((l) => /Not asked: x \(timeout\)/.test(l)))
})

test('the statement always names the range, the hosts and what was not read', async () => {
  const m = await mod()
  const h = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), { readers: [host('a').reader, host('b').reader] })
  const s = m.historyStatement(h)
  assert.equal(s.claim, 'No Paid, FrozenSet or Withdrawn event in blocks 880,001 to 1,000,000.')
  assert.ok(s.limits.includes('Read on a and b.'))
  assert.ok(s.limits.includes('Blocks before 880,001 were not read, so this says nothing about them.'))
  assert.deepEqual(m.oneHostRanges(h), [], 'two hosts on every window, so no caveat about one')

  // Reading all the way to block 0 has no older blocks to disclaim.
  const whole = await m.readOlder(m.emptyHistory(VAULT, 5_000n), { readers: [host('a').reader, host('b').reader] })
  assert.equal(m.nextWindowTop(whole), null)
  assert.ok(!m.historyStatement(whole).limits.some((l) => /were not read/.test(l)))

  // Continuing covers more, and the statement moves with it.
  const more = await m.readOlder(h, { readers: [host('a').reader, host('b').reader] })
  assert.match(m.historyStatement(more).claim, /blocks 760,001 to 1,000,000\.$/)
})

test('a log that is not one of the three events in a usable shape is counted and not listed', async () => {
  const m = await mod()
  const logs: RawLog[] = [
    paid(1_000_000n),
    paid(999_999n, 0, { removed: true }),
    { ...paid(999_998n), args: { to: PAYEE } },
    { ...paid(999_997n), eventName: 'OperatorSet', args: { operator: PAYEE } },
    { ...paid(999_996n), transactionHash: null },
  ]
  const h = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), { readers: [host('a', logs).reader, host('b').reader] })
  assert.equal(h.events.length, 1)
  assert.equal(h.dropped, 4)
  assert.ok(m.historyStatement(h).limits.some((l) => /4 log\(s\)/.test(l)))
})

test('hosts on another chain, silent or far behind are not asked and are named; the read starts at a head all it asks have reached', async () => {
  const m = await mod()
  const picked = m.pickHosts(
    [
      { host: 'ahead', chainId: 5, block: 1_000_010n },
      { host: 'slightly-behind', chainId: 5, block: 1_000_000n },
      { host: 'stuck', chainId: 5, block: 1_000_010n - m.HEAD_LAG_BLOCKS - 1n },
      { host: 'wrong', chainId: 7, block: 2_000_000n },
      { host: 'silent', chainId: null, block: null, reason: 'timeout' },
    ],
    5,
  )
  assert.equal(picked.top, 1_000_000n)
  assert.deepEqual(picked.usable, ['ahead', 'slightly-behind'])
  assert.deepEqual(picked.skipped.map((s) => s.host).sort(), ['silent', 'stuck', 'wrong'])
  assert.match(picked.skipped.find((s) => s.host === 'wrong')?.reason ?? '', /chain 7, not 5/)
  assert.deepEqual(m.pickHosts([{ host: 'wrong', chainId: 7, block: 1n }], 5).top, null)
})

test('block times are read only for what is on screen, and a block no host can date is left undated', async () => {
  const m = await mod()
  const many = Array.from({ length: m.EVENTS_SHOWN + 10 }, (_, i) => paid(1_000_000n - BigInt(i)))
  const askedTimes: bigint[] = []
  const reader = host('a', many, {
    time: (b) => {
      askedTimes.push(b)
      return b === 1_000_000n ? null : b * 2n
    },
  }).reader
  const h = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), { readers: [reader] })
  const dated = await m.withBlockTimes(h, { readers: [reader] })
  assert.ok(askedTimes.length <= m.EVENTS_SHOWN + 2, `asked for ${askedTimes.length} block times`)
  assert.equal(dated.times['999999'], 999_999n * 2n)
  assert.equal(dated.times['1000000'], undefined)
  assert.equal(dated.times[m.covered(h)?.from.toString() ?? ''], (m.covered(h)?.from ?? 0n) * 2n)
})

test('stopping a read returns what it had, and the page reads only on request', async () => {
  const m = await mod()
  let reads = 0
  const a: Reader = {
    host: 'a',
    logs: async () => {
      reads += 1
      return []
    },
  }
  let stop = false
  const h = await m.readOlder(m.emptyHistory(VAULT, 1_000_000n), {
    readers: [a],
    onProgress: () => {
      stop = true
    },
    aborted: () => stop,
  })
  assert.equal(h.windows.length, 1)
  assert.equal(reads, 1)
  // The page: no timer behind the read, the three event names from the generated ABI, and the
  // statement rather than its own words about what was covered.
  const page = repo('src/components/app/arc/VaultEvents.tsx')
  assert.doesNotMatch(page, /setInterval/)
  assert.match(page, /historyStatement\(history\)/)
  const bind = repo('src/lib/arc/vault-events.ts')
  for (const name of ['Paid', 'FrozenSet', 'Withdrawn']) assert.match(bind, new RegExp(`getAbiItem\\(\\{ abi: AGENT_SPEND_POLICY_ABI, name: '${name}' \\}\\)`))
  assert.match(repo('src/routes/app/ArcVault.tsx'), /<VaultEvents /)
})

test('with no head read, there is no further back and no claim about block 0', async () => {
  // No host answered the first read. A head of 0 here used to offer "further back", read the single
  // window {0, 0} once hosts answered, and say in bold there were no events in blocks 0 to 0.
  const m = await mod()
  const none = { ...m.emptyHistory(VAULT, null), failed: { range: null, reason: 'no RPC answered for this chain' } }
  assert.equal(m.nextWindowTop(none), null)
  assert.match(m.historyStatement(none).claim, /says nothing about the vault's activity/)
  const untouched = await m.readOlder(none, { readers: [] })
  assert.equal(untouched.windows.length, 0)
  const page = repo('src/lib/arc/vault-events.ts')
  assert.match(page, /emptyHistory\(address, null\)/)
  assert.match(page, /opts\.older\?\.windows\.length \? opts\.older : emptyHistory\(address, picked\.top\)/, 'a history with nothing read starts at the newest block')
})

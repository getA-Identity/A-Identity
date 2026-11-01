/**
 * A vault's recent Paid, FrozenSet and Withdrawn events, gathered from Arc's RPCs, as pure logic
 * over injected readers. vault-events.ts binds it to real hosts; mcp/src/frontend-arc-events.test.ts
 * loads this file straight from src/ and feeds it fake ones (runtime imports only with their .ts
 * extension, so Node's type stripping can).
 *
 * What the hosts actually do, read on Arc Mainnet on 2026-11-01:
 *   - eth_getLogs is capped at 10,000 blocks counting both ends. The primary and QuickNode refuse
 *     10,001; Blockdaemon has no such cap but answers "pruned history unavailable" for old blocks;
 *     dRPC's free tier refuses the call outright.
 *   - The primary answers 429 to a burst, and kept answering at one request every 400 ms.
 *   - Arc makes about two blocks a second, so one window is about 80 minutes.
 *
 * So the read is bounded and slow on purpose: newest window first, one at a time with a pause
 * between, two hosts per window, and a host that keeps failing stops being asked. Two hosts
 * because an empty answer proves little from a host that may prune: the union is what is shown,
 * and a window only one host answered says so.
 *
 * The covered range is contiguous from the newest block down, so one sentence can state it. A
 * window no host answers stops the read there, and nothing older is asked or claimed. Every
 * statement this module makes is about the blocks it names: "no activity" is never said of a block
 * that was not read.
 */
import { sameAddress } from './vault-rules.ts'

/** eth_getLogs' cap on Arc's RPCs, counting both ends of the range. */
export const LOG_WINDOW_BLOCKS = 10_000n
/** How many windows one read asks for: about 17 hours of Arc Mainnet at about two blocks a second. */
export const WINDOWS_PER_READ = 12
/** How far back this page will go, however many times it is asked: about a week of Arc Mainnet. */
export const MAX_WINDOWS = 120
/** How many hosts each window is read from, where that many answer. */
export const HOSTS_PER_WINDOW = 2
/** A host that failed this many windows in a row is asked again only if no other host answers. */
export const HOST_STRIKES = 2
/** The pause between windows: the pace the primary RPC kept answering at. */
export const WINDOW_PAUSE_MS = 400
/** A host further behind the best head than this is not asked: about 50 seconds of Arc Mainnet. */
export const HEAD_LAG_BLOCKS = 100n
/** How many events are listed, newest first, and have their block's time read. */
export const EVENTS_SHOWN = 25

export type VaultEventKind = 'Paid' | 'FrozenSet' | 'Withdrawn'

/** A log as a host returned it, decoded against the vault's ABI. */
export type RawLog = {
  address: string
  eventName?: string
  args?: Readonly<Record<string, unknown>>
  blockNumber: bigint | null
  transactionHash: string | null
  logIndex: number | null
  removed?: boolean
}

type EventBase = { block: bigint; logIndex: number; txHash: string; hosts: string[] }
export type VaultEvent =
  | (EventBase & { kind: 'Paid'; to: string; amount: bigint; byOwner: boolean })
  | (EventBase & { kind: 'FrozenSet'; frozen: boolean })
  | (EventBase & { kind: 'Withdrawn'; to: string; amount: bigint })

/** One RPC host: its log query and, when it can, a block's timestamp. */
export type HostReader = {
  host: string
  logs: (from: bigint, to: bigint) => Promise<readonly RawLog[]>
  blockTime?: (block: bigint) => Promise<bigint | null>
}

export type BlockRange = { from: bigint; to: bigint }
export type AnsweredWindow = BlockRange & { hosts: string[] }

export type EventHistory = {
  vault: string
  /** The newest block any window starts from. */
  head: bigint
  /** The windows at least one host answered, newest first, each starting right below the last. */
  windows: AnsweredWindow[]
  /** Every event in those windows, across hosts, once each, newest first. */
  events: VaultEvent[]
  /** Why the read stopped early: the window no host answered (null when there was no window to ask). */
  failed: { range: BlockRange | null; reason: string } | null
  /** Hosts this read did not ask, and why. */
  skipped: { host: string; reason: string }[]
  /** Logs a host returned for this vault that were not one of the three events in a usable shape. */
  dropped: number
  /** Block number (decimal) to its timestamp, for the blocks whose time was read. */
  times: Readonly<Record<string, bigint>>
}

export function emptyHistory(vault: string, head: bigint): EventHistory {
  return { vault, head, windows: [], events: [], failed: null, skipped: [], dropped: 0, times: {} }
}

/** The windows to read, newest first, from `top` down: never wider than the cap, never below block 0. */
export function planWindows(top: bigint, count: number, size: bigint = LOG_WINDOW_BLOCKS): BlockRange[] {
  const out: BlockRange[] = []
  let to = top
  while (out.length < count && to >= 0n) {
    const lowest = to - size + 1n
    const from = lowest < 0n ? 0n : lowest
    out.push({ from, to })
    to = from - 1n
  }
  return out
}

// --- which hosts ---

export type HostHead = { host: string; chainId: number | null; block: bigint | null; reason?: string }

/**
 * The hosts to read from and the block to read down from: the lowest head among hosts on this
 * chain and close to the best one, so a window never asks a host for blocks it has not reached.
 * A host on another chain, with no answer, or far behind is not asked, and is named.
 */
export function pickHosts(heads: readonly HostHead[], chainId: number): { top: bigint | null; usable: string[]; skipped: { host: string; reason: string }[] } {
  const skipped: { host: string; reason: string }[] = []
  const live: { host: string; block: bigint }[] = []
  for (const h of heads) {
    if (h.chainId === null || h.block === null) skipped.push({ host: h.host, reason: h.reason ?? 'no answer' })
    else if (h.chainId !== chainId) skipped.push({ host: h.host, reason: `answered for chain ${h.chainId}, not ${chainId}` })
    else live.push({ host: h.host, block: h.block })
  }
  if (!live.length) return { top: null, usable: [], skipped }
  const best = live.reduce((a, h) => (h.block > a ? h.block : a), 0n)
  const near = live.filter((h) => {
    if (best - h.block <= HEAD_LAG_BLOCKS) return true
    skipped.push({ host: h.host, reason: `${best - h.block} blocks behind the best host` })
    return false
  })
  return { top: near.reduce((a, h) => (h.block < a ? h.block : a), best), usable: near.map((h) => h.host), skipped }
}

// --- one log ---

/** A log as an event of this vault, or null. A log from any other address is never taken. */
function eventOf(log: RawLog, vault: string): VaultEvent | 'other' | 'unusable' {
  if (!sameAddress(log.address, vault)) return 'other'
  if (log.removed || log.blockNumber === null || log.transactionHash === null || log.logIndex === null) return 'unusable'
  const base = { block: log.blockNumber, logIndex: log.logIndex, txHash: log.transactionHash, hosts: [] as string[] }
  const a = log.args ?? {}
  if (log.eventName === 'Paid' && typeof a.to === 'string' && typeof a.amount === 'bigint' && typeof a.byOwner === 'boolean')
    return { ...base, kind: 'Paid', to: a.to, amount: a.amount, byOwner: a.byOwner }
  if (log.eventName === 'FrozenSet' && typeof a.frozen === 'boolean') return { ...base, kind: 'FrozenSet', frozen: a.frozen }
  if (log.eventName === 'Withdrawn' && typeof a.to === 'string' && typeof a.amount === 'bigint') return { ...base, kind: 'Withdrawn', to: a.to, amount: a.amount }
  return 'unusable'
}

/** Newest first, and within a block, last log first. */
function newestFirst(a: VaultEvent, b: VaultEvent): number {
  if (a.block !== b.block) return a.block > b.block ? -1 : 1
  return b.logIndex - a.logIndex
}

// --- one window ---

function message(e: unknown): string {
  const m = (e as { shortMessage?: unknown; message?: unknown } | null)?.shortMessage ?? (e as { message?: unknown } | null)?.message ?? e
  return String(m).split('\n')[0].slice(0, 160)
}

/** Which hosts a read is asking, in preference order, and how many times in a row each has failed. */
type HostQueue = { order: HostReader[]; strikes: Map<HostReader, number> }

/**
 * Ask the first hosts in the queue at once, and for each that fails, the next, until
 * HOSTS_PER_WINDOW have answered or there is no host left. A host that fails moves to the back, so
 * it is not asked first for the next window. One that failed HOST_STRIKES times in a row (it has
 * pruned these blocks, or refuses the call) is asked only when no other host answered: a second
 * opinion is wanted, not worth asking a host that keeps saying no for every window.
 */
async function askWindow(w: BlockRange, q: HostQueue): Promise<{ answers: { host: string; logs: readonly RawLog[] }[]; failures: string[] }> {
  const struck = (r: HostReader) => (q.strikes.get(r) ?? 0) >= HOST_STRIKES
  const willing = q.order.filter((r) => !struck(r))
  const queue = [...willing, ...q.order.filter(struck)]
  const answers: { host: string; logs: readonly RawLog[] }[] = []
  const failures: string[] = []
  const failed: HostReader[] = []
  let next = 0
  while (answers.length < HOSTS_PER_WINDOW && next < queue.length) {
    const limit = answers.length > 0 || next < willing.length ? willing.length : queue.length
    if (next >= limit) break
    const batch = queue.slice(next, Math.min(next + (HOSTS_PER_WINDOW - answers.length), limit))
    next += batch.length
    const settled = await Promise.allSettled(batch.map((r) => r.logs(w.from, w.to)))
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') {
        answers.push({ host: batch[i].host, logs: s.value })
        q.strikes.delete(batch[i])
      } else {
        failures.push(`${batch[i].host}: ${message(s.reason)}`)
        q.strikes.set(batch[i], (q.strikes.get(batch[i]) ?? 0) + 1)
        failed.push(batch[i])
      }
    })
  }
  for (const r of failed) {
    q.order.splice(q.order.indexOf(r), 1)
    q.order.push(r)
  }
  return { answers, failures }
}

function withWindow(h: EventHistory, w: BlockRange, answers: { host: string; logs: readonly RawLog[] }[]): EventHistory {
  const byKey = new Map(h.events.map((e) => [`${e.txHash.toLowerCase()}:${e.logIndex}`, e]))
  let dropped = h.dropped
  for (const { host, logs } of answers) {
    for (const log of logs) {
      const e = eventOf(log, h.vault)
      if (e === 'other') continue
      if (e === 'unusable') {
        dropped += 1
        continue
      }
      const key = `${e.txHash.toLowerCase()}:${e.logIndex}`
      const held = byKey.get(key)
      if (held) {
        if (!held.hosts.includes(host)) byKey.set(key, { ...held, hosts: [...held.hosts, host] })
      } else byKey.set(key, { ...e, hosts: [host] })
    }
  }
  return {
    ...h,
    windows: [...h.windows, { ...w, hosts: answers.map((a) => a.host) }],
    events: [...byKey.values()].sort(newestFirst),
    dropped,
  }
}

// --- the read ---

/** Where the next read starts: right below the oldest window answered. Null past block 0, or at the page's limit. */
export function nextWindowTop(h: EventHistory): bigint | null {
  if (h.windows.length >= MAX_WINDOWS) return null
  const oldest = h.windows[h.windows.length - 1]
  if (!oldest) return h.head
  return oldest.from > 0n ? oldest.from - 1n : null
}

/**
 * Read up to WINDOWS_PER_READ more windows below what `h` holds, one window at a time. Stops at
 * the first window no host answers, so the range covered stays one contiguous range.
 */
export async function readOlder(
  h: EventHistory,
  x: { readers: readonly HostReader[]; pause?: () => Promise<void>; aborted?: () => boolean; onProgress?: (h: EventHistory) => void },
): Promise<EventHistory> {
  let out: EventHistory = { ...h, failed: null }
  const top = nextWindowTop(h)
  if (top === null) return out
  const queue: HostQueue = { order: [...x.readers], strikes: new Map() }
  const plan = planWindows(top, Math.min(WINDOWS_PER_READ, MAX_WINDOWS - h.windows.length))
  for (const [i, w] of plan.entries()) {
    if (i > 0) await x.pause?.()
    if (x.aborted?.()) return out
    const { answers, failures } = await askWindow(w, queue)
    if (!answers.length) {
      out = { ...out, failed: { range: w, reason: failures.join('; ') || 'no RPC to ask' } }
      x.onProgress?.(out)
      return out
    }
    out = withWindow(out, w, answers)
    x.onProgress?.(out)
  }
  return out
}

/** The range the windows cover, or null when no window was answered. */
export function covered(h: EventHistory): BlockRange | null {
  const newest = h.windows[0]
  const oldest = h.windows[h.windows.length - 1]
  return newest && oldest ? { from: oldest.from, to: newest.to } : null
}

/**
 * The times of the blocks a person reads on screen: the two ends of the range and the listed
 * events. One host at a time and at most EVENTS_SHOWN + 2 blocks. A block no host can date is left
 * out, and the page shows its number alone.
 */
export async function withBlockTimes(h: EventHistory, x: { readers: readonly HostReader[]; pause?: () => Promise<void>; aborted?: () => boolean }): Promise<EventHistory> {
  const range = covered(h)
  const wanted = new Set<bigint>(h.events.slice(0, EVENTS_SHOWN).map((e) => e.block))
  if (range) {
    wanted.add(range.from)
    wanted.add(range.to)
  }
  const times: Record<string, bigint> = { ...h.times }
  for (const block of wanted) {
    if (times[block.toString()] !== undefined) continue
    if (x.aborted?.()) break
    for (const r of x.readers) {
      if (!r.blockTime) continue
      const t = await r.blockTime(block).catch(() => null)
      if (t !== null) {
        times[block.toString()] = t
        break
      }
    }
    await x.pause?.()
  }
  return { ...h, times }
}

// --- what may be said ---

const n = (b: bigint) => b.toLocaleString('en-US')

/** Contiguous windows only one host answered, as ranges, newest first. */
export function oneHostRanges(h: EventHistory): BlockRange[] {
  const out: BlockRange[] = []
  for (const w of h.windows) {
    if (w.hosts.length !== 1) continue
    const last = out[out.length - 1]
    if (last && last.from === w.to + 1n) last.from = w.from
    else out.push({ from: w.from, to: w.to })
  }
  return out
}

/**
 * What the page may say about this history: one claim about the blocks read, and every limit on it.
 * With no window answered there is no claim about activity at all.
 */
export function historyStatement(h: EventHistory): { claim: string; limits: string[] } {
  const range = covered(h)
  const limits: string[] = []
  if (h.failed) {
    if (h.failed.range)
      limits.push(`No RPC answered for blocks ${n(h.failed.range.from)} to ${n(h.failed.range.to)}, so the read stopped there and nothing older was read (${h.failed.reason}).`)
    else limits.push(`No RPC could be asked (${h.failed.reason}).`)
  }
  if (!range) {
    for (const s of h.skipped) limits.push(`Not asked: ${s.host} (${s.reason}).`)
    return { claim: "No block range could be read, so this says nothing about the vault's activity.", limits }
  }
  const hosts = [...new Set(h.windows.flatMap((w) => w.hosts))]
  limits.unshift(`Read on ${hosts.join(' and ')}.`)
  if (range.from > 0n) limits.push(`Blocks before ${n(range.from)} were not read, so this says nothing about them.`)
  const single = oneHostRanges(h)
  if (single.length) {
    const named = single.slice(0, 3).map((r) => `${n(r.from)} to ${n(r.to)}`).join(', ')
    const rest = single.length > 3 ? ` and ${single.length - 3} more stretch(es)` : ''
    limits.push(`Blocks ${named}${rest} were answered by one RPC only, and an RPC that prunes old logs can answer with nothing, so what is missing there proves less.`)
  }
  for (const s of h.skipped) limits.push(`Not asked: ${s.host} (${s.reason}).`)
  if (h.dropped > 0) limits.push(`${h.dropped} log(s) from this vault could not be read as one of these events and are not listed.`)
  const blocks = `blocks ${n(range.from)} to ${n(range.to)}`
  const count = h.events.length
  return {
    claim: count === 0 ? `No Paid, FrozenSet or Withdrawn event in ${blocks}.` : `${count} Paid, FrozenSet or Withdrawn event${count === 1 ? '' : 's'} in ${blocks}.`,
    limits,
  }
}

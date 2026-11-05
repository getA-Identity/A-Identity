/**
 * The server looks for countable vaults on Arc Mainnet by itself, so a real vault is not left
 * uncounted because nobody came back to the browser that deployed it: another device, cleared
 * storage, a tab closed after a failed question, a deploy sped up in the wallet.
 *
 * A vault logs nothing when it is created, but setting the agent key's end date logs
 * SessionKeyExpirySet(uint256), and a vault counts only once it has one. So eth_getLogs on that topic
 * finds every countable vault. The deploy hash then comes from the chain alone: bisect eth_getCode to
 * the first block with code, and take the transaction in it that created that address.
 *
 * Nothing is decided here. A hash found goes to admitVaultDeploy, the same function POST
 * /api/arc/vaults calls, with the same store and the same checks, and whatever it answers stands. The
 * only reads with an effect of their own are usdc() and owner(), and a word that rules a contract out
 * only saves the bisect: admission would refuse the same contract, for good, on the same fact.
 *
 * What the hosts did when measured on 2026-11-04, which is what the reads below are built on:
 *   - eth_getLogs: the Circle primary and QuickNode took 10000 blocks and said "requested range too
 *     large" at 50000. Blockdaemon took 100000 but only over about its last 420000 blocks, and said
 *     "pruned history unavailable" further back. dRPC took 100 blocks and refused 1000.
 *   - dRPC answered eth_getLogs past its head with an empty list and no error. So an empty list
 *     proves nothing from a host that is behind the range: a chunk is only asked of hosts whose own
 *     head has reached its last block, and the sweep stops short of the head.
 *   - eth_getCode at an old block: three hosts answered, and Blockdaemon said "state at block is
 *     pruned". An error is no answer, so it never moves a bound: the next host is asked.
 *   - eth_getBlockByNumber at an old block: Blockdaemon answered with no transactions and a
 *     transactionsRoot that is not empty's. So "no transaction in this block created the vault" is
 *     only ever concluded from a block whose list is whole, and is checked against every host.
 *   - eth_call on an address with no code answers 0x with no error, so a host behind the deploy looks
 *     like a contract with no getters. Only a full 32-byte word rules anything out.
 *   - eth_getLogs also limits results: Blockdaemon said "query exceeds max results 20000", and the
 *     Circle primary and QuickNode took 19912 logs and refused a little more. So a range can be refused
 *     for what it holds, at any width, and someone can pay to fill a block with this topic.
 *   - eth_getBlockReceipts answered on all four hosts on 2026-11-04 (QuickNode only between its rate
 *     limits), and Blockdaemon gave an old block with 6 transactions as an empty list. So a list of
 *     receipts only counts if it matches a block whose transaction list is whole.
 *
 * Where it starts after a restart. Render restarts on every deploy and the cursor lives only in this
 * process, on purpose: writing it down would be a second thing to keep true, and a cursor saved past
 * a block that was not really read would lose a vault for good. So each process starts again from
 * ARC_VAULT_SWEEP_START_BLOCK, a fixed block from before the page went live for owners, and no vault
 * the page could have made is older than that. Reading it all again costs little: the reads per tick
 * are capped, the cursor goes on from where the cap stopped it, and a vault already on the list costs
 * no read at all. What a restart does cost is its memory of refusals, so a refused contract is asked
 * about once more per process.
 *
 * A block no host will read. A range every host refuses is cut down to one block. If that block is
 * still refused while the last block a host did answer for still reads, the hosts are up and the block
 * is the trouble: it is read through its receipts, and if those fail too it becomes a hole. A hole is
 * still unread and is treated as that: it is kept, read again later with a growing wait, and the public
 * block says logs-not-read for as long as one is open. The cursor goes past it so that one paid-for
 * block cannot stop every vault after it from being found. If the block before does not read either,
 * nothing is known about the block in question, so the cursor stays. A restart reads every block again,
 * holes included.
 *
 * What bounds the work, since anyone can deploy contracts that emit this topic:
 *   - Reads per tick are capped, and so are admissions per tick (each admission reads about 30 times,
 *     through its own hosts, and takes one of the route's slots, so the route still has the rest).
 *   - The queue is taken in turns: the newest contract nobody has asked about, the one that has waited
 *     longest, then one at random. Each process rebuilds the queue in log order and with no memory of
 *     what it closed, so oldest-first alone would put an old flood ahead of a real owner again after
 *     every deploy, for good if deploys come faster than the flood drains. With the turns, an owner
 *     newer than the flood is reached within a few ticks of the scan reaching their log, and new
 *     contracts cannot starve an old one. An owner with a flood on both sides waits on the random
 *     turn, about two contracts a tick. Run against stub hosts with 1000 contracts on each side that
 *     answer usdc() and owner(): about a day with no restart, and with a deploy every 8 hours between
 *     1.5 and 11 days over five runs, a mean of about 5.5. With 300 on each side, about 6 hours. A
 *     restart forgets what was closed, which is why it is slower, but every process gets its own
 *     chance at the owner, so the wait has an end. A flood on both sides at that size can still use up
 *     what is left of a season: it delays, and it costs the flooder gas per contract, and an owner
 *     holding their hash can post at any time. A contract that passes every check is counted, and
 *     then costs no read.
 *   - A flood of blocks costs more for what it gets: about 0.34 USDC for each block too full to read at
 *     the measured gas price. Crossing one takes up to about 50 of the 100 log reads a tick when all four
 *     hosts refuse, so about two such blocks a tick, or about 70 USDC to fill an 8-hour gap between
 *     deploys. A vault after them waits for that crossing, and an owner holding their hash can still post.
 *   - A bisect keeps its bounds between ticks and is finished before anything new is started, and a
 *     deploy hash once found is never looked for again. A tick with every host benched stops at the
 *     first contract that gets no read: nothing else in the queue could be read either.
 *   - Refused for good is remembered for the life of the process, and a new log does not reopen it. A
 *     retryable refusal waits longer each time, up to an hour, and is never given up on: what it is
 *     waiting for, a host catching up or an owner changing an end date, a limit or the agent key, may
 *     take longer than any count of tries. A newer log may be that end date, so the wait starts over and
 *     is cut to one step from when the contract was last asked about. With a tick and a step of 5 minutes
 *     an owner is asked about within about ten minutes of the write, which is what the page says, and a
 *     contract paying gas for logs gets one ask a step, inside the same cap per tick. A new limit or agent
 *     key logs no end date, so that one waits its turn, at most the hour.
 * The queue itself is not capped, since dropping an entry could drop a real vault. It grows only as
 * fast as someone pays to deploy contracts, at a few hundred bytes each.
 *
 * It holds no key and sends nothing. The one thing it writes is through admission: a vault that passes
 * every check becomes a row, as it does for a post. RPC, clock and admission are injected, so every path
 * is unit-tested with plain answers, and scripts/rehearse-arc-vault-fork.mjs runs it against a real EVM.
 */
import { encodeEventTopics, encodeFunctionData, getAddress, getCreateAddress, toHex, type Abi, type Hex } from 'viem'
import { ADMISSION_CHAIN, collectOurAddresses, liveOurAddressSources } from './arc-owner-vault.js'
import {
  admissionContext,
  admissionReadiness,
  admitVaultDeploy,
  benchStalledHosts,
  everyHost,
  liveRpcHosts,
  liveVaultAdmissionDeps,
  shortRpcError,
  withDeadline,
  type RpcHost,
  type VaultAdmissionAnswer,
  type VaultAdmissionDeps,
} from './arc-owner-vault-live.js'
import { ARC_VAULT_SWEEP_START_BLOCK } from './arc-season.js'
import { AgentSpendPolicyAbi } from './contracts/AgentSpendPolicy.js'
import { loadAdmittedArcVaults, type ArcVaultStoreIo } from './storage.js'

const abi = AgentSpendPolicyAbi as unknown as Abi
const EXPIRY_TOPIC = encodeEventTopics({ abi, eventName: 'SessionKeyExpirySet' })[0] as Hex
const USDC_CALL = encodeFunctionData({ abi, functionName: 'usdc' })
const OWNER_CALL = encodeFunctionData({ abi, functionName: 'owner' })
/** The root of a block with no transactions on any EVM chain: keccak256(rlp("")). */
const EMPTY_TX_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const WORD = /^0x[0-9a-fA-F]{64}$/

/** What the public block can say went wrong. Fixed words: a host's own text goes to the server log only. */
export type SweepProblem =
  | 'admission-not-ready'
  | 'list-unreadable'
  | 'no-host-answered'
  | 'logs-not-read'
  | 'read-cap-reached'
  | 'ran-out-of-time'
  | 'deploy-not-read'
  | 'hosts-disagree'
  | 'admission-unavailable'
  | 'round-failed'
  /** A round has run past everything that should bound it, and the ticks after it are not starting. */
  | 'round-stalled'

/**
 * The sweep block of GET /api/arc/vaults. lastBlockRead is decimal, as deployBlock is on a row, and is
 * how far the scan has gone: logs-not-read says a block behind it is still open.
 */
export type SweepStatus = { on: boolean; lastBlockRead: string | null; lastRun: string | null; lastProblem: SweepProblem | null }

export type SweepLimits = {
  /** Every RPC read of one tick, wherever it goes. The admissions are counted by asksPerTick. */
  readsPerTick: number
  /** Of those, how many the log scan may take, so catching up after a restart leaves some for vaults it found. */
  logReadsPerTick: number
  /** Admissions per tick. */
  asksPerTick: number
  /** The range one eth_getLogs starts at each tick: only Blockdaemon's history takes this much. */
  startSpan: number
  /** Blocks every host refused, read again per tick. Each is read again later each time, so none waits behind the others for good. */
  holeRetriesPerTick: number
  /** Blocks left unread behind the head, so a host a little behind can still answer the last chunk. */
  headMargin: number
  /** A pause before each read: two of the four hosts rate limit quickly, and our own reads share them. */
  pauseMs: number
  /** All the reads of one tick. A round whose reads stall stops here, and the next tick goes on. */
  tickDeadlineMs: number
  /** How long the store gets to give the list. Past it the round ends: nothing else bounds a store call. */
  listDeadlineMs: number
  /** How long one admission gets, its store calls included. Past it the round ends. Its chain reads have a shorter deadline of their own. */
  askDeadlineMs: number
  /** A host whose read failed only after this long is not asked again this tick. */
  stalledAfterMs: number
  /** First wait before a retryable refusal is asked about again. It doubles. */
  retryAfterMs: number
  /** The longest that wait gets. */
  maxRetryAfterMs: number
}

export const DEFAULT_SWEEP_LIMITS: SweepLimits = {
  readsPerTick: 200,
  logReadsPerTick: 100,
  asksPerTick: 5,
  startSpan: 50_000,
  holeRetriesPerTick: 3,
  headMargin: 20,
  pauseMs: 100,
  tickDeadlineMs: 120_000,
  listDeadlineMs: 30_000,
  askDeadlineMs: 60_000,
  stalledAfterMs: 7_500,
  retryAfterMs: 5 * 60_000,
  maxRetryAfterMs: 60 * 60_000,
}

export type VaultSweepDeps = {
  /** The RPC hosts, fresh for each tick. */
  hosts: () => readonly RpcHost[]
  /** Whether admission could say yes at all. False means the tick reads nothing. */
  ready: () => boolean
  /** The vaults already on the list, lowercase. Unreadable is never empty. */
  counted: () => Promise<{ ok: true; vaults: ReadonlySet<string> } | { ok: false; reason: string }>
  /** The same function the route calls. Whatever it says stands. */
  admit: (deployTx: string) => Promise<VaultAdmissionAnswer>
  /** What usdc() must read for a contract to be worth a bisect. */
  registryUsdc: string
  startBlock: number
  now?: () => number
  /** An index below n, for the turn that does not go by a contract's place in the queue. */
  pick?: (n: number) => number
  pause?: (ms: number) => Promise<void>
  log?: (line: string) => void
  limits?: Partial<SweepLimits>
}

type Candidate = {
  vault: string
  /** Since when it has waited: found, or last asked about. The longest wait goes first on its turn. */
  waitingSince: number
  /** Its newest log. It orders the contracts nobody has asked about yet. For one already asked, a newer one brings the next ask forward. */
  logBlock: number
  /** Admission has been asked about it at least once. */
  asked: boolean
  /** Times its deploy could not be read. One that never reads must not hold the newest place. */
  unreadTimes: number
  /** The read cap stopped its bisect partway, so it finishes before anything new is started. */
  midway: boolean
  /** Not asked about again before this. */
  notBefore: number
  shapeRead: boolean
  /** The bisect's bounds: no code below lo, code at hi. They only ever move on an answer. */
  lo: number
  hi: number
  deployTx: string | null
  refusals: number
}

type Asked<T> = { ok: true; value: T } | { ok: false; problems: string[] }
type Budget = { hosts: RpcHost[]; used: () => number; empty: () => boolean }
type LogEntry = { vault: string; block: number }
/** A block every host refused, kept until one of them reads it. */
type Hole = { block: number; notBefore: number; tries: number }

class TimedOut extends Error {}

/** Whatever run does, an answer in ms: a pooled store connection can hang with no timeout of its own. Its timer holds nothing open. */
function timed<T>(run: () => Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut(`${what} did not answer in ${ms} ms`)), ms)
    timer.unref?.()
    void Promise.resolve()
      .then(run)
      .then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        },
      )
  })
}

function readBudget(hosts: readonly RpcHost[], max: number, pauseMs: number, pause: (ms: number) => Promise<void>): Budget {
  let used = 0
  return {
    hosts: hosts.map((h) => ({
      ...h,
      request: async (method, params) => {
        if (used >= max) throw new Error('the reads for this round are used up')
        used++
        if (pauseMs > 0) await pause(pauseMs)
        return h.request(method, params)
      },
    })),
    used: () => used,
    empty: () => used >= max,
  }
}

const hasCode = (code: unknown): boolean => typeof code === 'string' && code.length > 2

/** A log list only if every entry in it is what was asked for. Anything else is no answer from that host. */
function readLogs(from: number, to: number) {
  return (raw: unknown): LogEntry[] | undefined => {
    if (!Array.isArray(raw)) return undefined
    const out: LogEntry[] = []
    for (const l of raw as { address?: unknown; blockNumber?: unknown; topics?: unknown[]; removed?: unknown }[]) {
      if (!l || typeof l.address !== 'string' || !ADDRESS.test(l.address) || typeof l.blockNumber !== 'string' || l.topics?.[0] !== EXPIRY_TOPIC) return undefined
      const block = Number(l.blockNumber)
      if (!Number.isSafeInteger(block) || block < from || block > to) return undefined
      if (l.removed !== true) out.push({ vault: l.address.toLowerCase(), block })
    }
    return out
  }
}

/**
 * The logs of one block from its receipts, only if there is one receipt for each of its transactions.
 * A receipt holds every log of its transaction, so here another topic is simply not looked at.
 */
function readReceipts(block: number, txHashes: ReadonlySet<string>) {
  return (raw: unknown): LogEntry[] | undefined => {
    if (!Array.isArray(raw) || raw.length !== txHashes.size) return undefined
    const out: LogEntry[] = []
    for (const r of raw as { transactionHash?: unknown; blockNumber?: unknown; logs?: unknown }[]) {
      if (!r || !txHashes.has(String(r.transactionHash).toLowerCase()) || Number(r.blockNumber) !== block || !Array.isArray(r.logs)) return undefined
      for (const l of r.logs as { address?: unknown; topics?: unknown[]; removed?: unknown }[]) {
        if (!l || l.topics?.[0] !== EXPIRY_TOPIC || l.removed === true) continue
        if (typeof l.address !== 'string' || !ADDRESS.test(l.address)) return undefined
        out.push({ vault: l.address.toLowerCase(), block })
      }
    }
    return out
  }
}

/** The transactions of a block, or null unless the list is whole: a host with the header and not the body gives an empty list under a root that says otherwise. */
function wholeTransactions(block: unknown): Record<string, unknown>[] | null {
  const b = block as { transactions?: unknown; transactionsRoot?: unknown } | null
  if (!b || !Array.isArray(b.transactions)) return null
  if (b.transactions.length === 0) return b.transactionsRoot === EMPTY_TX_ROOT ? [] : null
  return b.transactions.every((t) => t && typeof t === 'object') ? (b.transactions as Record<string, unknown>[]) : null
}

/**
 * The transaction in this list that created the vault by itself. The CREATE address is the sender and
 * nonce, so no receipt has to be read per creation, and one block full of them costs nothing more.
 * Admission reads the receipt and checks this all over again.
 */
function creationOf(vault: string, txs: readonly Record<string, unknown>[]): string | null {
  for (const tx of txs) {
    if (tx.to !== null && tx.to !== undefined) continue
    try {
      const made = getCreateAddress({ from: getAddress(String(tx.from)), nonce: BigInt(String(tx.nonce)) })
      if (made.toLowerCase() === vault && TX_HASH.test(String(tx.hash))) return String(tx.hash).toLowerCase()
    } catch {
      // A sender or a nonce that does not read is not this vault's creation.
    }
  }
  return null
}

export type VaultSweep = { tick: () => Promise<void>; status: () => SweepStatus }

export function createVaultSweep(deps: VaultSweepDeps): VaultSweep {
  const limits = { ...DEFAULT_SWEEP_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const pick = deps.pick ?? ((n: number) => Math.floor(Math.random() * n))
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? ((line: string) => console.error(`[arc-vault-sweep] ${line}`))
  const usdc = deps.registryUsdc.toLowerCase()

  /** How far the scan has gone. Moved by an answer that covers the blocks, or past one block that is kept in holes. */
  let cursor: number | null = null
  /** The newest block a host answered logs for. Every host refusing the block after it says something only while this one still reads. */
  let lastAnswered: number | null = null
  const holes = new Map<number, Hole>()
  const candidates = new Map<string, Candidate>()
  /** Refused for good, or ruled out, in this process. */
  const closed = new Set<string>()
  /** Which host last answered each method, asked first: a pruned host costs one read and not one per step. */
  const answeredLast = new Map<string, string>()
  let firstTurn = 0
  let running = false
  let roundStartedAt = 0
  /** Past everything that bounds a round: the list, the reads and the last admission started before their deadline. */
  const stalledAfter = limits.listDeadlineMs + limits.tickDeadlineMs + limits.askDeadlineMs
  let lastRun: string | null = null
  let lastProblem: SweepProblem | null = null
  let problem: SweepProblem | null = null

  /** The first problem of a tick is the one the public block names. The raw text goes to the log only. */
  const note = (word: SweepProblem, raw?: string) => {
    problem ??= word
    log(raw ? `${word}: ${raw}` : word)
  }

  async function firstAnswer<T>(hosts: readonly RpcHost[], method: string, params: readonly unknown[], read: (raw: unknown) => T | undefined): Promise<Asked<T>> {
    const last = answeredLast.get(method)
    const order = last ? [...hosts.filter((h) => h.label === last), ...hosts.filter((h) => h.label !== last)] : hosts
    const problems: string[] = []
    for (const h of order) {
      try {
        const value = read(await h.request(method, params))
        if (value !== undefined) {
          answeredLast.set(method, h.label)
          return { ok: true, value }
        }
        problems.push(`${h.label}: no usable answer`)
      } catch (e) {
        problems.push(`${h.label}: ${shortRpcError(e, hosts)}`)
      }
    }
    return { ok: false, problems }
  }

  const noteFound = (logs: readonly LogEntry[]) => {
    for (const { vault, block } of logs) {
      const known = candidates.get(vault)
      if (known) {
        if (block <= known.logBlock) continue
        known.logBlock = block
        // A new end date may be what its refusals were waiting for. Not sooner than a step from the last ask, whatever someone pays for logs.
        known.refusals = 0
        known.notBefore = Math.min(known.notBefore, known.waitingSince + limits.retryAfterMs)
      } else if (!closed.has(vault)) {
        candidates.set(vault, { vault, waitingSince: now(), logBlock: block, asked: false, unreadTimes: 0, midway: false, notBefore: 0, shapeRead: false, lo: 0, hi: block, deployTx: null, refusals: 0 })
      }
    }
  }

  /** One block through its receipts, for a block whose logs no host will list. Null is no answer. */
  async function logsByReceipts(hosts: readonly RpcHost[], block: number): Promise<LogEntry[] | null> {
    const answers = await everyHost<unknown>(hosts, 'eth_getBlockByNumber', [toHex(block), true])
    const txs = answers.map((a) => wholeTransactions(a.value)).find((t) => t !== null)
    if (!txs) return null
    const asked = await firstAnswer(hosts, 'eth_getBlockReceipts', [toHex(block)], readReceipts(block, new Set(txs.map((t) => String(t.hash).toLowerCase()))))
    return asked.ok ? asked.value : null
  }

  /** Blocks no host would read last time, whichever has waited longest first. */
  async function retryHoles(budget: Budget, heads: ReadonlyMap<string, number>): Promise<void> {
    const due = [...holes.values()].filter((h) => h.notBefore <= now()).sort((a, b) => a.notBefore - b.notBefore)
    for (const hole of due.slice(0, limits.holeRetriesPerTick)) {
      if (budget.empty()) return
      const covering = budget.hosts.filter((h) => (heads.get(h.label) ?? -1) >= hole.block)
      const asked = await firstAnswer(covering, 'eth_getLogs', [{ fromBlock: toHex(hole.block), toBlock: toHex(hole.block), topics: [EXPIRY_TOPIC] }], readLogs(hole.block, hole.block))
      const logs = asked.ok ? asked.value : await logsByReceipts(covering, hole.block)
      if (logs) {
        noteFound(logs)
        holes.delete(hole.block)
      } else if (!budget.empty()) {
        hole.tries++
        hole.notBefore = now() + Math.min(limits.maxRetryAfterMs, limits.retryAfterMs * 2 ** hole.tries)
        log(`logs-not-read: block ${hole.block} is still open after ${hole.tries} more tries`)
      }
    }
  }

  /** New blocks, oldest first. See the file's comment for when the cursor may pass a block. */
  async function readNewBlocks(budget: Budget): Promise<boolean> {
    const hosts = budget.hosts
    const heads = new Map<string, number>()
    for (const a of await everyHost<number>(hosts, 'eth_blockNumber', [], (v) => Number(BigInt(v)))) {
      if (a.value !== null && Number.isSafeInteger(a.value)) heads.set(a.host, a.value)
    }
    if (heads.size === 0) {
      note('no-host-answered')
      return false
    }
    const startedAt = budget.used()
    await retryHoles(budget, heads)
    // The second highest, not the highest: one host far ahead of the rest is not enough to go on.
    const sorted = [...heads.values()].sort((a, b) => b - a)
    const to = sorted[Math.min(1, sorted.length - 1)] - limits.headMargin
    let from = cursor === null ? deps.startBlock : cursor + 1
    let span = limits.startSpan
    /** The widest range a host took this tick: a range cut down for what it held goes back up to this and no further. */
    let widest = 0
    /** The end of the last range refused. The trouble is somewhere before it, so the width stays down until the scan is past it. */
    let refusedEnd = -1
    while (from <= to) {
      if (budget.empty() || budget.used() - startedAt >= limits.logReadsPerTick) {
        note('read-cap-reached')
        break
      }
      const end = Math.min(from + span - 1, to)
      const covering = hosts.filter((h) => (heads.get(h.label) ?? -1) >= end)
      const asked = await firstAnswer(covering, 'eth_getLogs', [{ fromBlock: toHex(from), toBlock: toHex(end), topics: [EXPIRY_TOPIC] }], readLogs(from, end))
      if (asked.ok) {
        noteFound(asked.value)
        widest = Math.max(widest, end - from + 1)
        if (end >= refusedEnd) span = Math.max(span, Math.min(widest, span * 5))
        cursor = end
        lastAnswered = end
        from = end + 1
        continue
      }
      if (budget.empty()) {
        note('read-cap-reached')
        break
      }
      refusedEnd = end
      if (end > from) {
        span = Math.max(1, Math.floor(Math.min(span, end - from + 1) / 5))
        continue
      }
      // One block, and every host refused it. Only if a block that has read still reads is that about this block.
      const raw = `block ${from}: ${asked.problems.join('; ')}`
      const known = lastAnswered ?? Math.max(0, deps.startBlock - 1)
      const stillReads = await firstAnswer(hosts, 'eth_getLogs', [{ fromBlock: toHex(known), toBlock: toHex(known), topics: [EXPIRY_TOPIC] }], readLogs(known, known))
      if (!stillReads.ok) {
        note(budget.empty() ? 'read-cap-reached' : 'logs-not-read', raw)
        break
      }
      const logs = await logsByReceipts(covering, from)
      if (logs) noteFound(logs)
      else if (budget.empty()) {
        note('read-cap-reached')
        break
      } else {
        holes.set(from, { block: from, notBefore: now() + limits.retryAfterMs, tries: 0 })
        note('logs-not-read', raw)
      }
      cursor = from
      from += 1
      span = widest || limits.startSpan
    }
    return true
  }

  /** False only on a word that rules the contract out. An error or an empty answer, as a host behind the deploy gives, rules nothing out. */
  async function looksLikeAVault(hosts: readonly RpcHost[], vault: string): Promise<boolean> {
    const word = (raw: unknown) => (typeof raw === 'string' && WORD.test(raw) ? raw.toLowerCase() : undefined)
    const usdcWord = await firstAnswer(hosts, 'eth_call', [{ to: vault, data: USDC_CALL }, 'latest'], word)
    if (!usdcWord.ok) return true
    if (`0x${usdcWord.value.slice(26)}` !== usdc) return false
    const ownerWord = await firstAnswer(hosts, 'eth_call', [{ to: vault, data: OWNER_CALL }, 'latest'], word)
    if (!ownerWord.ok) return true
    return /^0x0{24}/.test(ownerWord.value) && !/^0x0{64}$/.test(ownerWord.value)
  }

  /**
   * The deploy hash, or why there is none yet. 'none' is for a contract no transaction created by
   * itself, such as a factory's, which admission could only refuse. 'unread' is no conclusion at all.
   */
  async function findDeploy(budget: Budget, c: Candidate): Promise<'found' | 'none' | 'unread'> {
    const hosts = budget.hosts
    if (c.deployTx) return 'found'
    if (!c.shapeRead) {
      if (!(await looksLikeAVault(hosts, c.vault))) return 'none'
      if (budget.empty()) return 'unread'
      c.shapeRead = true
    }
    while (c.lo < c.hi) {
      const mid = Math.floor((c.lo + c.hi) / 2)
      const code = await firstAnswer(hosts, 'eth_getCode', [c.vault, toHex(mid)], (raw) => (typeof raw === 'string' ? raw : undefined))
      if (!code.ok) {
        if (!budget.empty()) note('deploy-not-read', `${c.vault} at block ${mid}: ${code.problems.join('; ')}`)
        return 'unread'
      }
      if (hasCode(code.value)) c.hi = mid
      else c.lo = mid + 1
    }
    const answers = await everyHost<unknown>(hosts, 'eth_getBlockByNumber', [toHex(c.hi), true])
    const whole = answers.map((a) => wholeTransactions(a.value)).filter((t) => t !== null)
    for (const txs of whole) {
      const hash = creationOf(c.vault, txs)
      if (hash) {
        c.deployTx = hash
        return 'found'
      }
    }
    if (whole.length === 0) {
      if (!budget.empty()) note('deploy-not-read', `${c.vault}: no host gave block ${c.hi} with all its transactions`)
      return 'unread'
    }
    // Nothing here created it. Before saying so, make sure one host's answer did not lead the bisect past the real block.
    if (c.hi === 0) return 'none'
    const before = await everyHost<unknown>(hosts, 'eth_getCode', [c.vault, toHex(c.hi - 1)])
    if (before.some((a) => hasCode(a.value))) {
      note('hosts-disagree', `${c.vault}: a host shows code before block ${c.hi}`)
      c.lo = 0
      c.hi -= 1
      return 'unread'
    }
    if (!before.some((a) => typeof a.value === 'string')) {
      if (!budget.empty()) note('deploy-not-read', `${c.vault}: no host read the block before ${c.hi}`)
      return 'unread'
    }
    return 'none'
  }

  /** False when admission took too long to answer at all, which ends the round: the next would wait as long. */
  async function ask(c: Candidate): Promise<boolean> {
    let answer: VaultAdmissionAnswer
    try {
      answer = await timed(() => deps.admit(c.deployTx as string), limits.askDeadlineMs, 'admission')
    } catch (e) {
      note('admission-unavailable', e instanceof Error ? e.message : String(e))
      c.notBefore = now() + limits.retryAfterMs
      return !(e instanceof TimedOut)
    }
    if (answer.status === 'admitted') {
      log(`counted ${c.vault} from deploy ${c.deployTx}`)
      candidates.delete(c.vault)
    } else if (answer.status === 'refused' && !answer.retryable) {
      log(`refused for good ${c.vault}: ${answer.reasons.map((r) => r.id).join(', ')}`)
      candidates.delete(c.vault)
      closed.add(c.vault)
    } else if (answer.status === 'refused') {
      c.refusals++
      c.notBefore = now() + Math.min(limits.maxRetryAfterMs, limits.retryAfterMs * 2 ** (c.refusals - 1))
      log(`refused for now ${c.vault}: ${answer.reasons.map((r) => r.id).join(', ')}`)
    } else if (answer.status === 'unavailable') {
      note('admission-unavailable', answer.reason)
      c.notBefore = now() + limits.retryAfterMs
    } else {
      log(`not asked again ${c.vault}: ${answer.reason}`)
      candidates.delete(c.vault)
      closed.add(c.vault)
    }
    return true
  }

  /**
   * The due candidates, in the order this tick takes them: any bisect the cap stopped, then in turns
   * the newest nobody has asked about, the one that has waited longest, and one at random, where a new
   * process starts with the newest. See the file's comment for why no single order will do.
   */
  function* turns(due: readonly Candidate[]): Generator<Candidate> {
    // Each tick starts on the next turn, so a cap reached early does not always cut off the same one.
    const taken = new Set<Candidate>()
    // Stable, so of those found in one tick the oldest log goes first.
    const oldest = [...due].sort((a, b) => a.waitingSince - b.waitingSince)
    const newest = due.filter((c) => !c.asked).sort((a, b) => a.unreadTimes - b.unreadTimes || b.logBlock - a.logBlock)
    const firstOf = (list: readonly Candidate[]) => list.find((c) => !taken.has(c))
    const left = () => oldest.filter((c) => !taken.has(c))
    for (const c of due.filter((c) => c.midway)) {
      taken.add(c)
      yield c
    }
    for (let turn = firstTurn++; taken.size < due.length; turn++) {
      const rest = turn % 3 === 2 ? left() : []
      const next = turn % 3 === 0 ? (firstOf(newest) ?? firstOf(oldest)) : turn % 3 === 1 ? firstOf(oldest) : rest[Math.min(rest.length - 1, Math.max(0, pick(rest.length)))]
      if (!next) return
      taken.add(next)
      yield next
    }
  }

  async function askAboutCandidates(budget: Budget, counted: ReadonlySet<string>, deadline: number): Promise<void> {
    for (const vault of candidates.keys()) if (counted.has(vault)) candidates.delete(vault)
    const due = [...candidates.values()].filter((c) => c.notBefore <= now())
    let asks = 0
    for (const c of turns(due)) {
      if (asks >= limits.asksPerTick) break
      if (now() >= deadline) {
        note('ran-out-of-time')
        break
      }
      const readsBefore = budget.used()
      const found = await findDeploy(budget, c)
      if (found === 'none') {
        log(`no direct creation, or not a vault: ${c.vault}`)
        candidates.delete(c.vault)
        closed.add(c.vault)
        continue
      }
      if (found === 'found') {
        asks++
        c.asked = true
        c.midway = false
        c.waitingSince = now()
        if (await ask(c)) continue
        break
      }
      // The cap stopped it partway: it keeps its bounds, and goes first next tick.
      if (budget.empty()) {
        c.midway = true
        note('read-cap-reached')
        break
      }
      // Unread with no read made: every host is benched for this tick. The next contract would find the
      // same, with no pause and no timer in between, for the whole queue. This says nothing about this
      // one, so it keeps its place.
      if (budget.used() === readsBefore) break
      c.midway = false
      c.unreadTimes++
      c.waitingSince = now()
    }
  }

  async function round(): Promise<void> {
    if (!deps.ready()) {
      note('admission-not-ready')
      return
    }
    const readList = async (): Promise<ReadonlySet<string> | null> => {
      let counted: Awaited<ReturnType<VaultSweepDeps['counted']>>
      try {
        counted = await timed(deps.counted, limits.listDeadlineMs, 'the list')
      } catch (e) {
        if (!(e instanceof TimedOut)) throw e
        note('list-unreadable', e.message)
        return null
      }
      if (!counted.ok) {
        note('list-unreadable', counted.reason)
        return null
      }
      return counted.vaults
    }
    const anyDue = () => [...candidates.values()].some((c) => c.notBefore <= now())
    // The list only matters when there is someone to ask. Reading it every tick would keep a database
    // that sleeps when idle awake around the clock. A new process still reads it before any chain read.
    let counted = cursor === null || anyDue() ? await readList() : undefined
    if (counted === null) return
    // viem's own timeout stops at the response headers, so a host that stalls in the body needs this.
    const stoppable = deps.hosts().map((h): RpcHost => ({ ...h, request: (method, params) => timed(() => h.request(method, params), limits.stalledAfterMs + 1000, `${h.label} ${method}`) }))
    const budget = readBudget(stoppable, limits.readsPerTick, limits.pauseMs, pause)
    const hosts = withDeadline(benchStalledHosts(budget.hosts, limits.stalledAfterMs, now), limits.tickDeadlineMs, now)
    const bounded: Budget = { ...budget, hosts }
    const deadline = now() + limits.tickDeadlineMs
    if (!(await readNewBlocks(bounded)) || !anyDue()) return
    counted ??= await readList()
    if (counted !== null) await askAboutCandidates(bounded, counted, deadline)
  }

  return {
    /** Never rejects. Two at once is one: a tick still out when the next is due just carries on, and one out for too long is said to be stuck. */
    async tick() {
      if (running) {
        if (now() - roundStartedAt >= stalledAfter) {
          lastProblem = 'round-stalled'
          log(`round-stalled: the round started at ${new Date(roundStartedAt).toISOString()} has not ended`)
        }
        return
      }
      running = true
      roundStartedAt = now()
      problem = null
      try {
        await round()
      } catch (e) {
        problem ??= 'round-failed'
        log(`round-failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        // Asked about last, so it cannot be hidden by a tick's other trouble that passes by itself.
        const word = problem as SweepProblem | null
        lastProblem = holes.size > 0 && (word === null || word === 'read-cap-reached') ? 'logs-not-read' : word
        lastRun = new Date(now()).toISOString()
        running = false
      }
    },
    status: () => ({ on: true, lastBlockRead: cursor === null ? null : String(cursor), lastRun, lastProblem }),
  }
}

// -- the timer -------------------------------------------------------------------------

type Timer = { unref?: () => void }

/**
 * Runs tick now and then, on a timer that does not hold the process open. A tick that throws, or a
 * timer that does, is logged and ends nothing but that tick. The next one is set as this one starts,
 * never when it ends: the tick keeps two from running at once, and only a tick that does run can say
 * that the one before it never came back. Returns how to stop it.
 */
export function runOnTimer(
  tick: () => Promise<void>,
  opts: { everyMs: number; firstAfterMs: number; setTimer?: (run: () => void, ms: number) => Timer; log?: (line: string) => void },
): () => void {
  const setTimer = opts.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const log = opts.log ?? ((line: string) => console.error(`[arc-vault-sweep] ${line}`))
  let stopped = false
  const schedule = (ms: number) => {
    if (stopped) return
    try {
      setTimer(() => {
        if (stopped) return
        schedule(opts.everyMs)
        void Promise.resolve()
          .then(tick)
          .catch((e) => log(`a tick threw: ${e instanceof Error ? e.message : String(e)}`))
      }, ms).unref?.()
    } catch (e) {
      log(`the timer did not start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  schedule(opts.firstAfterMs)
  return () => {
    stopped = true
  }
}

// -- the real one ----------------------------------------------------------------------

export type SweepConfig = { on: boolean; everyMs: number; startBlock: number }

const DEFAULT_EVERY_MS = 5 * 60_000
/** Render's health check should get its answer first. */
const FIRST_AFTER_MS = 30_000
/** Each read's own limit: long enough for a slow host, and a stalled one is benched after one of these. */
const READ_TIMEOUT_MS = 8_000

/**
 * ARC_VAULT_SWEEP=off is the off switch (also 0, false, no). ARC_VAULT_SWEEP_EVERY_SECONDS sets how
 * often, and ARC_VAULT_SWEEP_START_BLOCK where a new process starts. A value that is not a whole
 * number falls back to the default, so a typo cannot turn the sweep into a busy loop or skip blocks.
 */
export function sweepConfig(env: Readonly<Record<string, string | undefined>>): SweepConfig {
  const whole = (raw: string | undefined, atLeast: number): number | null => {
    const s = raw?.trim() ?? ''
    if (!/^\d+$/.test(s)) return null
    const n = Number(s)
    return Number.isSafeInteger(n) && n >= atLeast ? n : null
  }
  const asked = whole(env.ARC_VAULT_SWEEP_EVERY_SECONDS, 1)
  // setTimeout reads anything past 2^31 - 1 ms as 1 ms, which is the busy loop this is here to prevent.
  const seconds = asked !== null && asked * 1000 <= 2 ** 31 - 1 ? asked : null
  return {
    on: !/^(off|0|false|no)$/i.test(env.ARC_VAULT_SWEEP?.trim() ?? ''),
    everyMs: seconds === null ? DEFAULT_EVERY_MS : seconds * 1000,
    startBlock: whole(env.ARC_VAULT_SWEEP_START_BLOCK, 0) ?? ARC_VAULT_SWEEP_START_BLOCK,
  }
}

/** The route's own store and chain reads. The row says it was the sweep that found it, and nothing else about it differs. */
export function sweepAdmissionDeps(env: NodeJS.ProcessEnv = process.env): VaultAdmissionDeps {
  return { ...liveVaultAdmissionDeps(env), foundBy: 'sweep' }
}

/** The real hosts, store and admission. */
export function liveVaultSweepDeps(env: NodeJS.ProcessEnv = process.env, io: ArcVaultStoreIo = {}): VaultSweepDeps | { error: string } {
  const made = admissionContext(ADMISSION_CHAIN)
  if (!made.ok) return { error: made.reason }
  const { chain, registryUsdc } = made.context
  return {
    hosts: () => liveRpcHosts(chain, env, { timeoutMs: READ_TIMEOUT_MS, retryCount: 0 }),
    ready: () => admissionReadiness(collectOurAddresses(liveOurAddressSources(env))).ready,
    counted: async () => {
      const read = await loadAdmittedArcVaults(io)
      if (!read.ok) return read
      return { ok: true, vaults: new Set(read.rows.map((r) => String(r?.address).toLowerCase())) }
    },
    admit: async (deployTx) => (await admitVaultDeploy({ deployTx }, sweepAdmissionDeps(env))).answer,
    registryUsdc,
    startBlock: sweepConfig(env).startBlock,
  }
}

const OFF: SweepStatus = { on: false, lastBlockRead: null, lastRun: null, lastProblem: null }
let liveSweep: VaultSweep | null = null

/** What GET /api/arc/vaults says of the sweep. Off until it was started, and when it was told to be. */
export function vaultSweepStatus(): SweepStatus {
  return liveSweep?.status() ?? OFF
}

/** Called once from http.ts. Never throws, and a server that cannot sweep still serves. */
export function startVaultSweep(env: NodeJS.ProcessEnv = process.env, setTimer?: (run: () => void, ms: number) => Timer): void {
  try {
    const config = sweepConfig(env)
    if (!config.on) {
      console.error('[arc-vault-sweep] off: ARC_VAULT_SWEEP says so')
      return
    }
    const deps = liveVaultSweepDeps(env)
    if ('error' in deps) {
      console.error(`[arc-vault-sweep] off: ${deps.error}`)
      return
    }
    liveSweep = createVaultSweep(deps)
    runOnTimer(liveSweep.tick, { everyMs: config.everyMs, firstAfterMs: Math.min(FIRST_AFTER_MS, config.everyMs), setTimer })
    console.error(`[arc-vault-sweep] on: every ${config.everyMs / 1000}s from block ${config.startBlock}`)
  } catch (e) {
    console.error(`[arc-vault-sweep] off: ${e instanceof Error ? e.message : String(e)}`)
  }
}

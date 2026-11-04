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
 * What bounds the work, since anyone can deploy contracts that emit this topic:
 *   - Reads per tick are capped, and so are admissions per tick (each admission reads about 30 times,
 *     through its own hosts, and takes one of the route's slots, so the route still has the rest).
 *   - Whoever has waited longest is next, whether it was never asked or is being asked again, so a
 *     flood delays a real owner and cannot lock one out, and it costs the flooder gas per contract.
 *   - A bisect keeps its bounds between ticks, and a deploy hash once found is never looked for again.
 *   - Refused for good is remembered for the life of the process. A retryable refusal waits longer
 *     each time, up to an hour, and is never given up on: what it is waiting for, a host catching up
 *     or an end date being renewed, may take longer than any count of tries.
 * The queue itself is not capped, since dropping an entry could drop a real vault. It grows only as
 * fast as someone pays to deploy contracts, at a few hundred bytes each.
 *
 * Read-only and holds no key. RPC, clock and admission are injected, so every path is unit-tested
 * with plain answers, and scripts/rehearse-arc-vault-fork.mjs runs it against a real EVM.
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
} from './arc-owner-vault-live.js'
import { ARC_VAULT_SWEEP_START_BLOCK } from './arc-season.js'
import { AgentSpendPolicyAbi } from './contracts/AgentSpendPolicy.js'
import { loadAdmittedArcVaults } from './storage.js'

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

/** The sweep block of GET /api/arc/vaults. lastBlockRead is decimal, as deployBlock is on a row. */
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
  /** The smallest range tried, the one the host that takes the least took. Past this a host failing is not about the range. */
  minSpan: number
  /** Blocks left unread behind the head, so a host a little behind can still answer the last chunk. */
  headMargin: number
  /** A pause before each read: two of the four hosts rate limit quickly, and our own reads share them. */
  pauseMs: number
  /** All the reads of one tick. A stalled round stops here, and the next tick goes on. */
  tickDeadlineMs: number
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
  minSpan: 100,
  headMargin: 20,
  pauseMs: 100,
  tickDeadlineMs: 120_000,
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
  pause?: (ms: number) => Promise<void>
  log?: (line: string) => void
  limits?: Partial<SweepLimits>
}

type Candidate = {
  vault: string
  /** Since when it has waited: found, or last asked about. The longest wait goes first. */
  waitingSince: number
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
  return (raw: unknown): { vault: string; block: number }[] | undefined => {
    if (!Array.isArray(raw)) return undefined
    const out: { vault: string; block: number }[] = []
    for (const l of raw as { address?: unknown; blockNumber?: unknown; topics?: unknown[]; removed?: unknown }[]) {
      if (!l || typeof l.address !== 'string' || !ADDRESS.test(l.address) || typeof l.blockNumber !== 'string' || l.topics?.[0] !== EXPIRY_TOPIC) return undefined
      const block = Number(l.blockNumber)
      if (!Number.isSafeInteger(block) || block < from || block > to) return undefined
      if (l.removed !== true) out.push({ vault: l.address.toLowerCase(), block })
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
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = deps.log ?? ((line: string) => console.error(`[arc-vault-sweep] ${line}`))
  const usdc = deps.registryUsdc.toLowerCase()

  /** The last block read in full. Only ever moved by an answer that covers it. */
  let cursor: number | null = null
  const candidates = new Map<string, Candidate>()
  /** Refused for good, or ruled out, in this process. */
  const closed = new Set<string>()
  /** Which host last answered each method, asked first: a pruned host costs one read and not one per step. */
  const answeredLast = new Map<string, string>()
  let running = false
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

  /** New blocks, oldest first. The cursor moves only over a chunk a host whose head had reached it answered. */
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
    // The second highest, not the highest: one host far ahead of the rest is not enough to go on.
    const sorted = [...heads.values()].sort((a, b) => b - a)
    const to = sorted[Math.min(1, sorted.length - 1)] - limits.headMargin
    let from = cursor === null ? deps.startBlock : cursor + 1
    let span = limits.startSpan
    const startedAt = budget.used()
    while (from <= to) {
      if (budget.empty() || budget.used() - startedAt >= limits.logReadsPerTick) {
        note('read-cap-reached')
        break
      }
      const end = Math.min(from + span - 1, to)
      const covering = hosts.filter((h) => (heads.get(h.label) ?? -1) >= end)
      const asked = await firstAnswer(covering, 'eth_getLogs', [{ fromBlock: toHex(from), toBlock: toHex(end), topics: [EXPIRY_TOPIC] }], readLogs(from, end))
      if (asked.ok) {
        for (const { vault, block } of asked.value) {
          if (!candidates.has(vault) && !closed.has(vault)) {
            candidates.set(vault, { vault, waitingSince: now(), notBefore: 0, shapeRead: false, lo: 0, hi: block, deployTx: null, refusals: 0 })
          }
        }
        cursor = end
        from = end + 1
        continue
      }
      if (budget.empty()) {
        note('read-cap-reached')
        break
      }
      if (span <= limits.minSpan) {
        note('logs-not-read', `blocks ${from}..${end}: ${asked.problems.join('; ')}`)
        break
      }
      span = Math.max(limits.minSpan, Math.floor(Math.min(span, end - from + 1) / 5))
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

  async function ask(c: Candidate): Promise<void> {
    let answer: VaultAdmissionAnswer
    try {
      answer = await deps.admit(c.deployTx as string)
    } catch (e) {
      note('admission-unavailable', e instanceof Error ? e.message : String(e))
      c.notBefore = now() + limits.retryAfterMs
      return
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
  }

  async function askAboutCandidates(budget: Budget, counted: ReadonlySet<string>, deadline: number): Promise<void> {
    for (const vault of candidates.keys()) if (counted.has(vault)) candidates.delete(vault)
    // Stable, so of those found in one tick the oldest log goes first.
    const due = [...candidates.values()].filter((c) => c.notBefore <= now()).sort((a, b) => a.waitingSince - b.waitingSince)
    let asks = 0
    for (const c of due) {
      if (asks >= limits.asksPerTick) break
      if (now() >= deadline) {
        note('ran-out-of-time')
        break
      }
      const found = await findDeploy(budget, c)
      if (found === 'none') {
        log(`no direct creation, or not a vault: ${c.vault}`)
        candidates.delete(c.vault)
        closed.add(c.vault)
        continue
      }
      if (found === 'found') {
        asks++
        c.waitingSince = now()
        await ask(c)
        continue
      }
      // The cap stopped it partway: it keeps its place and its bounds, and goes first next tick.
      if (budget.empty()) {
        note('read-cap-reached')
        break
      }
      c.waitingSince = now()
    }
  }

  async function round(): Promise<void> {
    if (!deps.ready()) {
      note('admission-not-ready')
      return
    }
    const counted = await deps.counted()
    if (!counted.ok) {
      note('list-unreadable', counted.reason)
      return
    }
    const budget = readBudget(deps.hosts(), limits.readsPerTick, limits.pauseMs, pause)
    const hosts = withDeadline(benchStalledHosts(budget.hosts, limits.stalledAfterMs, now), limits.tickDeadlineMs, now)
    const bounded: Budget = { ...budget, hosts }
    const deadline = now() + limits.tickDeadlineMs
    if (await readNewBlocks(bounded)) await askAboutCandidates(bounded, counted.vaults, deadline)
  }

  return {
    /** Never rejects. Two at once is one: a tick still out when the next is due just carries on. */
    async tick() {
      if (running) return
      running = true
      problem = null
      try {
        await round()
      } catch (e) {
        problem ??= 'round-failed'
        log(`round-failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        lastProblem = problem
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
 * Runs tick now and then, one after the other, on a timer that does not hold the process open. A tick
 * that throws, or a timer that does, is logged and ends nothing but that tick. Returns how to stop it.
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
        void Promise.resolve()
          .then(tick)
          .catch((e) => log(`a tick threw: ${e instanceof Error ? e.message : String(e)}`))
          .finally(() => schedule(opts.everyMs))
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
  const seconds = whole(env.ARC_VAULT_SWEEP_EVERY_SECONDS, 1)
  return {
    on: !/^(off|0|false|no)$/i.test(env.ARC_VAULT_SWEEP?.trim() ?? ''),
    everyMs: seconds === null ? DEFAULT_EVERY_MS : seconds * 1000,
    startBlock: whole(env.ARC_VAULT_SWEEP_START_BLOCK, 0) ?? ARC_VAULT_SWEEP_START_BLOCK,
  }
}

/** The real hosts, store and admission. The row says it was the sweep that found it, and nothing else about it differs. */
export function liveVaultSweepDeps(env: NodeJS.ProcessEnv = process.env): VaultSweepDeps | { error: string } {
  const made = admissionContext(ADMISSION_CHAIN)
  if (!made.ok) return { error: made.reason }
  const { chain, registryUsdc } = made.context
  return {
    hosts: () => liveRpcHosts(chain, env, { timeoutMs: READ_TIMEOUT_MS, retryCount: 0 }),
    ready: () => admissionReadiness(collectOurAddresses(liveOurAddressSources(env))).ready,
    counted: async () => {
      const read = await loadAdmittedArcVaults()
      if (!read.ok) return read
      return { ok: true, vaults: new Set(read.rows.map((r) => String(r?.address).toLowerCase())) }
    },
    admit: async (deployTx) => (await admitVaultDeploy({ deployTx }, { ...liveVaultAdmissionDeps(env), foundBy: 'sweep' })).answer,
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
export function startVaultSweep(env: NodeJS.ProcessEnv = process.env): void {
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
    runOnTimer(liveSweep.tick, { everyMs: config.everyMs, firstAfterMs: Math.min(FIRST_AFTER_MS, config.everyMs) })
    console.error(`[arc-vault-sweep] on: every ${config.everyMs / 1000}s from block ${config.startBlock}`)
  } catch (e) {
    console.error(`[arc-vault-sweep] off: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * nearCheck: A-Identity's verdict on a NEAR testnet account, computed by the same engine the
 * NEAR SDK CLI runs, so `cd near && npm run verdict -- <id>`, GET /api/near/check and the trust
 * tools give one answer.
 *
 * It collects ONE snapshot of everything the engine reads about the account, pinned to one
 * block (chains/near/engine.ts: the generated copy of near/sdk/src, with every host taken from
 * the near-testnet descriptor), decides with the engine, and returns the verdict with what a
 * judge needs to recompute it: the block, both digests, the engine version and the exact CLI
 * command. The on-chain A-Identity registry's own answer (its verdict and open reports) is part
 * of the snapshot and is surfaced as read; with a vault, so are the vault's counters for this
 * payee (paid_count, refusal_count, guard_refusal_count).
 *
 * The rules, stated once:
 *
 *  - Testnet only. A mainnet name or an id that does not route to near:testnet is refused with
 *    a message that says why and what to write instead; nothing is read for it.
 *  - One routing rule, chains/near/ids.ts nearTargetOf: near:testnet:<id> (any account kind), or
 *    a bare named account ending in .testnet. The same rule the trust tools use, so a form one
 *    surface accepts the other does too.
 *  - Read only. No key, no transaction, and nothing settles on NEAR through this.
 *  - Defaults equal the CLI's: no known payees, the network's registry (or the vault's own),
 *    indexers and other teams' registries on. That is what makes the recompute command
 *    reproduce the same verdict and chain_sha256 at the same block.
 *  - No verdict is invented. When the chain cannot be read the answer is an error that says
 *    so (the CLI's "no verdict"), never a cached guess and never ALLOW.
 *  - Bounded: one answer per account and vault is kept for 60 s, concurrent asks for the same
 *    one share a single collection, at most four collections run at once with at most 32
 *    waiting behind them (a new account past that is told to ask again), and an ask that is not
 *    answered in 20 s is told so (the collection keeps running and fills the cache).
 */
import { getChainById } from '../chains/registry.js'
import { addressUrl } from '../chains/explorer.js'
import { isNearAccountId, nearTargetOf } from '../chains/near/ids.js'
import type { ChainDescriptor } from '../chains/types.js'
import {
  collectSnapshot,
  CollectError,
  formatEvidence,
  nearEngineEnv,
  nearEngineNetwork,
  registryReasons,
  verdictFromSnapshot,
  type FetchLike,
  type NearVerdict,
  type Reason,
  type RegistrySignal,
  type VaultSignal,
} from '../chains/near/engine.js'

/** The registry id of the one NEAR network this check reads. */
export const NEAR_CHECK_CHAIN = 'near-testnet'
export const NEAR_CHECK_TTL_MS = 60_000
export const NEAR_CHECK_TIMEOUT_MS = 20_000
const MAX_ENTRIES = 500
const MAX_CONCURRENT = 4
/** Collections allowed to wait for a slot; past this a new account is told to ask again. */
const MAX_WAITING = 32

/** The honest labels every answer carries, in the words a reader sees. */
export const NEAR_CHECK_LABELS = {
  network: 'NEAR testnet only: test money, and no mainnet account is read here',
  read:
    'read live from NEAR testnet JSON-RPC and an indexer (FastNEAR, with NearBlocks as its fallback and for a contract\'s deployments), every chain read pinned to one block; endpoints names the hosts this answer read',
  settlement: 'nothing settles on NEAR through A-Identity yet: this is a verdict, not a payment',
} as const

export type NearRegistryView = {
  /** The registry contract the snapshot read, or null when none was configured. */
  id: string | null
  state: 'read' | 'not_deployed' | 'unreadable' | 'not_configured'
  /** The registry's own verdict on this account, as written on chain, or null when it holds none. */
  verdict: NearVerdict | null
  reasons: string[]
  written_by: string | null
  written_at: string | null
  expires_at: string | null
  /** Reports the oracle has not reviewed yet. Null when the registry could not be read. */
  open_reports: number | null
  open_reporters: string[]
  why?: string
}

export type NearVaultView = {
  id: string
  state: 'read' | 'unreadable'
  paid_count: number | null
  refusal_count: number | null
  /** Agent-recorded refusals; null for a vault older than the view. Shown, never used to decide. */
  guard_refusal_count: number | null
  allowlisted: boolean | null
  why?: string
}

export type NearCheckAnswer = {
  account: string
  caip10: string
  caip2: string
  /** As the SDK CLI prints it, so the two outputs compare field by field. */
  network: 'testnet'
  testnet: true
  kind: string
  mode: 'online'
  verdict: NearVerdict
  score: number
  warn_kind: 'hard' | 'soft' | null
  reasons: Reason[]
  registry_reasons: string[]
  block: { height: number; hash: string; timestamp_ns: string }
  block_time: string
  snapshot_sha256: string
  chain_sha256: string
  evidence: string
  engine_version: string
  policy_id: string
  registry: NearRegistryView
  vault: NearVaultView | null
  recompute: { command: string; note: string }
  explorer: string
  endpoints: string[]
  notes: string[]
  labels: typeof NEAR_CHECK_LABELS
  checked_at: string
  cached: boolean
}

export type NearCheckError = {
  error: string
  code: 'missing' | 'too_long' | 'invalid' | 'mainnet' | 'other_network' | 'ambiguous' | 'not_configured' | 'no_verdict' | 'timeout' | 'busy'
  httpStatus: 400 | 503
}

export type NearCheckResult = NearCheckAnswer | NearCheckError

/** The seams tests use. Production passes nothing: global fetch, real clock, process env. */
export type NearCheckDeps = {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  clock?: () => Date
  now?: () => number
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

// -- which account ------------------------------------------------------------------

/**
 * The NEAR testnet account a free-form input names, or why it names none. Routing is
 * nearTargetOf's alone; this only explains a refusal, in the order a person would ask.
 */
export function nearCheckTarget(input: string): { account: string } | Omit<NearCheckError, 'httpStatus'> {
  const q = input.trim()
  if (!q) return { code: 'missing', error: 'Name a NEAR testnet account: near:testnet:<account> or a name ending in .testnet.' }
  if (q.length > 128) return { code: 'too_long', error: 'That is too long for a NEAR account id (at most 64 characters, 77 with the near:testnet: prefix).' }
  const routed = nearTargetOf(q)
  if (routed) return { account: routed.account }
  const testnetPrefix = 'near:testnet:'
  if (q.startsWith(testnetPrefix)) {
    return { code: 'invalid', error: `${q.slice(testnetPrefix.length)} is not a NEAR account id: 2 to 64 characters of a-z, 0-9 and the separators . - _, never at either end or twice in a row.` }
  }
  const mainnet = q.startsWith('near:mainnet:') ? q.slice('near:mainnet:'.length) : q.endsWith('.near') ? q : null
  if (mainnet !== null) {
    return {
      code: 'mainnet',
      error:
        `${q} is a NEAR mainnet account. This check reads NEAR testnet only (near:testnet), where A-Identity's NEAR work runs, and refuses mainnet rather than answer about a different network. ` +
        `For a mainnet account the SDK computes the verdict itself, read only: cd near && npm run verdict -- ${mainnet} --network mainnet`,
    }
  }
  if (/^near:/.test(q)) return { code: 'other_network', error: `${q} names a NEAR network this check does not read. Only near:testnet:<account> is served.` }
  if (isNearAccountId(q)) {
    return {
      code: 'ambiguous',
      error:
        `${q} is a valid NEAR account id, but a bare one is read as NEAR only when it ends in .testnet: an implicit id (64 hex, 0x..., 0s..., 0u...) or another top-level name already means something else here (an EVM address, a transaction hash, a web domain). ` +
        `Write it as near:testnet:${q}.`,
    }
  }
  return { code: 'invalid', error: `${q} is not a NEAR testnet account: write near:testnet:<account> or a name ending in .testnet (a-z, 0-9 and . - _ only).` }
}

// -- the bounded part: cache, in-flight sharing, concurrency, timeout -----------------

const answers = new Map<string, { at: number; answer: NearCheckAnswer }>()
const inflight = new Map<string, Promise<NearCheckResult>>()
let active = 0
const waiting: (() => void)[] = []

async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1
    return
  }
  // The releaser hands its slot straight over, so `active` does not move.
  await new Promise<void>((resolve) => waiting.push(resolve))
}

function releaseSlot(): void {
  const next = waiting.shift()
  if (next) next()
  else active -= 1
}

/**
 * Run a collection that is not nearCheck's own inside the same pool, so "at most four at once"
 * holds server-wide whichever door a collection comes through. The NEAR AI market worker
 * (near-market/verdict.ts) is that other door. It waits for a slot like any collection here and
 * is never refused as busy: it runs one collection at a time, abandons one it stops waiting for
 * (the request in flight is aborted and every later one fails at once, so the slot comes back
 * within moments rather than after the collection's own retries), and has an hour to deliver.
 */
export async function inNearCollectionPool<T>(run: () => Promise<T>): Promise<T> {
  await acquireSlot()
  try {
    return await run()
  } finally {
    releaseSlot()
  }
}

/** Forget every kept answer and in-flight collection. Tests only. */
export function __resetNearCheckForTests(): void {
  answers.clear()
  inflight.clear()
}

const isoOfNs = (ns: string | null | undefined): string | null => {
  if (typeof ns !== 'string' || !/^\d+$/.test(ns)) return null
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString()
}

function registryView(r: RegistrySignal): NearRegistryView {
  const none = { verdict: null, reasons: [], written_by: null, written_at: null, expires_at: null, open_reporters: [] }
  if (r.state === 'not_configured') return { id: null, state: 'not_configured', ...none, open_reports: null }
  if (r.state === 'not_deployed') return { id: r.id, state: 'not_deployed', ...none, open_reports: null }
  if (r.state === 'unavailable') return { id: r.id, state: 'unreadable', ...none, open_reports: null, why: r.why }
  const v = r.verdict
  return {
    id: r.id,
    state: 'read',
    verdict: v?.verdict ?? null,
    reasons: v?.reasons ?? [],
    written_by: v?.updated_by || null,
    written_at: v ? isoOfNs(v.updated_at_ns) : null,
    expires_at: v ? isoOfNs(v.expires_at_ns) : null,
    open_reports: r.open_reports,
    open_reporters: r.open_reporters,
  }
}

function vaultView(id: string, v: VaultSignal): NearVaultView {
  if (v.state === 'ok') {
    return { id: v.id, state: 'read', paid_count: v.paid_count, refusal_count: v.refusal_count, guard_refusal_count: v.guard_refusal_count, allowlisted: v.allowlisted }
  }
  const why = v.state === 'unavailable' ? v.why : 'no vault was read'
  return { id, state: 'unreadable', paid_count: null, refusal_count: null, guard_refusal_count: null, allowlisted: null, why }
}

/** The two messages collect/snapshot.ts throws for a malformed request, the only TypeErrors that
 *  are the caller's: an account id that is not one, and a block height that is not one. */
const CALLER_INPUT_ERROR = /is not a valid NEAR account id|at-block must be/

/** The CLI command that recomputes this verdict from the chain at the same block. */
export function recomputeCommand(account: string, height: number, vault: string | null): string {
  return `cd near && npm run verdict -- ${account} --at-block ${height}${vault ? ` --vault ${vault}` : ''}`
}

async function collectAnswer(chain: ChainDescriptor, account: string, vault: string | null, deps: NearCheckDeps): Promise<NearCheckResult> {
  await acquireSlot()
  try {
    const env = deps.env ?? process.env
    const snapshot = await collectSnapshot({
      account,
      network: 'testnet',
      known: [],
      vault,
      config: nearEngineNetwork(chain, env),
      env: nearEngineEnv(env),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
    })
    const replay = verdictFromSnapshot(snapshot)
    const d = replay.decision
    const answer: NearCheckAnswer = {
      account: d.subject,
      caip10: `${chain.caip2}:${d.subject}`,
      caip2: chain.caip2,
      network: 'testnet',
      testnet: true,
      kind: replay.signals.kind,
      mode: 'online',
      verdict: d.verdict,
      score: d.score,
      warn_kind: d.warn_kind,
      reasons: d.reasons,
      registry_reasons: registryReasons(d),
      block: d.block,
      block_time: isoOfNs(d.block.timestamp_ns) ?? '',
      snapshot_sha256: replay.snapshot_sha256,
      chain_sha256: replay.chain_sha256,
      evidence: formatEvidence(replay),
      engine_version: d.engine_version,
      policy_id: d.policy_id,
      registry: registryView(replay.signals.registry),
      vault: vault ? vaultView(vault, replay.signals.vault) : null,
      recompute: {
        command: recomputeCommand(d.subject, d.block.height, vault),
        note:
          'Run from a clone of the repository. It re-sends the same block-pinned reads and prints the same verdict and chain_sha256. ' +
          'snapshot_sha256 also covers the indexer answers with their fetch time, so a new collection prints a new one.',
      },
      explorer: addressUrl(chain, d.subject),
      endpoints: snapshot.meta?.endpoints ?? [],
      notes: snapshot.meta?.notes ?? [],
      labels: NEAR_CHECK_LABELS,
      checked_at: snapshot.meta?.collected_at ?? new Date().toISOString(),
      cached: false,
    }
    return answer
  } catch (e) {
    if (e instanceof CollectError) {
      return { code: 'no_verdict', httpStatus: 503, error: `No verdict: ${e.message}. Nothing was decided and nothing is assumed; ask again shortly.` }
    }
    // The collectors' own input checks (collect/snapshot.ts) are the only caller error that can
    // surface here, and nearCheckTarget applied the same rule before anything was read. Any other
    // exception, a TypeError from a bug of ours included, is our failure: 503 with no verdict,
    // never a 400 that blames what was asked. Its message goes to the server log, not the caller.
    if (e instanceof TypeError && CALLER_INPUT_ERROR.test(e.message)) return { code: 'invalid', httpStatus: 400, error: e.message }
    console.error(`[near-check] ${account}: the collection failed inside the server:`, e)
    return {
      code: 'no_verdict',
      httpStatus: 503,
      error: 'No verdict: the NEAR check failed on our side, not because of the account asked about. Nothing was decided and nothing is assumed; ask again shortly.',
    }
  } finally {
    releaseSlot()
  }
}

/**
 * A-Identity's verdict on one NEAR testnet account, optionally as seen by one vault.
 * Never throws: a refusal or a failure to read is an answer with `error`, `code` and `httpStatus`.
 */
export async function nearCheck(accountId: string, opts: { vault?: string | null } = {}, deps: NearCheckDeps = {}): Promise<NearCheckResult> {
  const target = nearCheckTarget(accountId)
  if ('error' in target) return { ...target, httpStatus: 400 }
  let vault: string | null = null
  if (typeof opts.vault === 'string' && opts.vault.trim() !== '') {
    const v = nearCheckTarget(opts.vault)
    if ('error' in v) return { code: v.code, error: `vault: ${v.error}`, httpStatus: 400 }
    vault = v.account
  }
  const chain = getChainById(NEAR_CHECK_CHAIN)
  if (!chain) return { code: 'not_configured', httpStatus: 503, error: 'The chain registry declares no near-testnet, so there is nothing to read.' }

  const now = deps.now ?? Date.now
  const key = `${target.account}|${vault ?? ''}`
  const hit = answers.get(key)
  if (hit && now() - hit.at < NEAR_CHECK_TTL_MS) return { ...hit.answer, cached: true }

  let pending = inflight.get(key)
  if (!pending && active >= MAX_CONCURRENT && waiting.length >= MAX_WAITING) {
    return { code: 'busy', httpStatus: 503, error: 'No verdict: too many NEAR collections are already waiting. Nothing was decided; ask again shortly.' }
  }
  if (!pending) {
    pending = collectAnswer(chain, target.account, vault, deps).then((result) => {
      if (!('error' in result)) {
        if (answers.size >= MAX_ENTRIES) answers.delete(answers.keys().next().value as string)
        answers.set(key, { at: now(), answer: result })
      }
      return result
    })
    const settled = pending.finally(() => inflight.delete(key))
    inflight.set(key, settled)
    pending = settled
  }

  const ms = deps.timeoutMs ?? NEAR_CHECK_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<NearCheckError>((resolve) => {
    timer = setTimeout(
      () => resolve({ code: 'timeout', httpStatus: 503, error: `No verdict: NEAR testnet did not answer within ${Math.round(ms / 1000)} s. Nothing was decided; ask again shortly.` }),
      ms,
    )
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** True for a computed verdict, false for a refusal or a failure to read. */
export const isNearAnswer = (r: NearCheckResult): r is NearCheckAnswer => !('error' in r)

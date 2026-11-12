/**
 * The verdict a marketplace hire is answered with: A-Identity's NEAR verdict engine, collected
 * exactly as the SDK CLI collects it, on NEAR testnet or NEAR mainnet.
 *
 * Both networks go through the same engine and collectors (chains/near/engine.ts, the generated
 * copy of near/sdk/src) with the CLI's defaults: no known payees, no vault, the network's own
 * registry, indexers and other teams' registries on. That is what makes the deliverable's
 * recompute command (`cd near && npm run verdict -- <id> [--network mainnet] --at-block <N>
 * --json`) print the same verdict and chain_sha256, and what makes the inlined snapshot replay
 * offline to the same digests.
 *
 *  - Testnet: every host from the near-testnet descriptor (nearEngineNetwork), as GET
 *    /api/near/check reads it, so NEAR_TESTNET_RPC_URL applies here too. The registry read is
 *    A-Identity's own on testnet.
 *  - Mainnet: this worker only. The registry has no NEAR mainnet descriptor on purpose (nothing of
 *    ours runs there), so the mainnet hosts are the SDK's own mainnet list, the very ones the CLI's
 *    `--network mainnet` reads and the benchmark ran on. A mainnet collection also reads NEAR
 *    testnet, where MimicWatch keeps the registry it lists mainnet impersonators in; that read goes
 *    through a reader built from the near-testnet descriptor, as every testnet read here does, so
 *    NEAR_TESTNET_RPC_URL applies to it too. Read only: no key, no transaction. There is no
 *    A-Identity registry and no vault on mainnet, so none is read, and the deliverable says so.
 *    GET /api/near/check and the trust tools stay testnet only.
 *
 * Bounded: each collection takes a slot in near-check's pool of four (inNearCollectionPool), so
 * the server-wide bound holds, and an answer that does not come within VERDICT_TIMEOUT_MS is a
 * failure to read, never a verdict. A collection given up on is abandoned, not left running: its
 * request in flight is aborted, every later request fails at once and every wait ends, so it gives
 * its slot back within moments and a retry never runs beside it. No verdict is invented: a
 * collection that fails is an error with its reason, which the worker turns into a retry, then an
 * honest decline.
 */
import { getChainById } from '../chains/registry.js'
import {
  collectSnapshot,
  CollectError,
  createReader,
  explorerAccountUrl,
  headersFromEnv,
  nearEngineEnv,
  nearEngineNetwork,
  SDK_NETWORKS,
  SDK_VERSION,
  verdictFromSnapshot,
  type Decision,
  type FetchLike,
  type NetworkConfig,
  type RegistrySignal,
  type RpcReader,
  type Snapshot,
} from '../chains/near/engine.js'
import { inNearCollectionPool } from '../near-check/check.js'
import type { BriefTarget, NearNetwork } from './brief.js'

/** The near-testnet descriptor's registry id (chains/registry.ts). */
const TESTNET_CHAIN = 'near-testnet'

/** Generous on purpose: every RPC and indexer call inside a collection has its own 15 s limit. */
export const VERDICT_TIMEOUT_MS = 180_000

export type MarketVerdict = {
  network: NearNetwork
  account: string
  caip10: string
  /** The engine's account kind (named, implicit, eth_implicit, deterministic, universal). */
  kind: string
  decision: Decision
  /** The deciding codes, as the registry's `reasons` field would take them. */
  deciding: string[]
  registry: RegistrySignal
  snapshot: Snapshot
  snapshot_sha256: string
  chain_sha256: string
  endpoints: string[]
  notes: string[]
  collected_at: string
  collector: string
  explorer: string
}

export type VerdictFailure = { error: string; code: 'no_verdict' | 'timeout' | 'invalid' | 'not_configured' }

export type VerdictResult = MarketVerdict | VerdictFailure

export const isVerdict = (r: VerdictResult): r is MarketVerdict => !('error' in r)

export type VerdictDeps = {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  clock?: () => Date
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * The codes that decided the verdict: the deny reasons of a DENY, the warnings no positive signal
 * cleared of a WARN, none for an ALLOW. The same set registryReasons gives an oracle, uncut.
 */
function decidingCodes(d: Decision): string[] {
  const deciding = d.verdict === 'DENY' ? d.reasons.filter((r) => r.severity === 'deny') : d.verdict === 'WARN' ? d.reasons.filter((r) => r.severity === 'warn' && !r.cleared_by) : []
  return [...new Set(deciding.map((r) => r.code))]
}

/** The verdict a snapshot supports, with everything the deliverable prints. No network. */
export function marketVerdictFromSnapshot(snapshot: Snapshot): MarketVerdict {
  const replay = verdictFromSnapshot(snapshot)
  const d = replay.decision
  return {
    network: snapshot.network,
    account: d.subject,
    caip10: `near:${snapshot.network}:${d.subject}`,
    kind: replay.signals.kind,
    decision: d,
    deciding: decidingCodes(d),
    registry: replay.signals.registry,
    snapshot,
    snapshot_sha256: replay.snapshot_sha256,
    chain_sha256: replay.chain_sha256,
    endpoints: snapshot.meta?.endpoints ?? [],
    notes: (snapshot.meta?.notes ?? []).filter((n) => n.trim() !== ''),
    collected_at: snapshot.meta?.collected_at ?? '',
    collector: snapshot.meta?.collector ?? SDK_VERSION,
    explorer: explorerAccountUrl(snapshot.network, d.subject),
  }
}

/** The collectors' hosts, as stated above: the network asked about, and NEAR testnet from its descriptor. */
function hosts(network: NearNetwork, env: NodeJS.ProcessEnv): { config: NetworkConfig; testnet: NetworkConfig } | VerdictFailure {
  const chain = getChainById(TESTNET_CHAIN)
  if (!chain) return { code: 'not_configured', error: 'the chain registry declares no near-testnet, so there is nothing to read' }
  const testnet = nearEngineNetwork(chain, env)
  return { config: network === 'mainnet' ? SDK_NETWORKS.mainnet : testnet, testnet }
}

const GIVEN_UP = 'the collection was given up on after its time limit'

/** A fetch that stops answering once `stop` fires: the request in flight is aborted and rejected, every later one fails at once. */
function abandonable(base: FetchLike, stop: AbortSignal): FetchLike {
  return (url, init) =>
    new Promise((resolve, reject) => {
      if (stop.aborted) return reject(new Error(GIVEN_UP))
      const inner = new AbortController()
      const onStop = () => {
        inner.abort()
        reject(new Error(GIVEN_UP))
      }
      const onOwn = () => inner.abort()
      const done = () => {
        stop.removeEventListener('abort', onStop)
        init.signal?.removeEventListener('abort', onOwn)
      }
      stop.addEventListener('abort', onStop, { once: true })
      // The reader's own per-request timeout still applies through the same controller.
      if (init.signal?.aborted) inner.abort()
      else init.signal?.addEventListener('abort', onOwn, { once: true })
      base(url, { ...init, signal: inner.signal }).then(
        (res) => {
          done()
          resolve(res)
        },
        (e) => {
          done()
          reject(e)
        },
      )
    })
}

/** A wait that ends at once when `stop` fires, so pacing and backoff never outlive a collection given up on. */
function abandonableSleep(base: ((ms: number) => Promise<void>) | undefined, stop: AbortSignal): (ms: number) => Promise<void> {
  return (ms) => {
    if (stop.aborted) return Promise.resolve()
    if (base) return base(ms)
    return new Promise<void>((resolve) => {
      const end = () => {
        clearTimeout(timer)
        stop.removeEventListener('abort', end)
        resolve()
      }
      const timer = setTimeout(end, ms)
      stop.addEventListener('abort', end, { once: true })
    })
  }
}

/** A-Identity's verdict on one NEAR account. Never throws: a failure to read is an error with its reason. */
export async function runMarketVerdict(target: BriefTarget, deps: VerdictDeps = {}): Promise<VerdictResult> {
  const env = deps.env ?? process.env
  const ms = deps.timeoutMs ?? VERDICT_TIMEOUT_MS
  const timedOut: VerdictFailure = { code: 'timeout', error: `NEAR ${target.network} did not answer the whole collection within ${Math.round(ms / 1000)} s` }
  let configured: ReturnType<typeof hosts>
  try {
    configured = hosts(target.network, env)
  } catch (e) {
    return { code: 'not_configured', error: e instanceof Error ? e.message : String(e) }
  }
  if ('error' in configured) return configured
  const { config, testnet } = configured

  const stop = new AbortController()
  const fetch = abandonable(deps.fetch ?? ((url, init) => globalThis.fetch(url, init)), stop.signal)
  const sleep = abandonableSleep(deps.sleep, stop.signal)
  const engineEnv = nearEngineEnv(env)
  // A mainnet collection's testnet read (MimicWatch), through the descriptor's hosts.
  const readers: Partial<Record<NearNetwork, RpcReader>> | undefined =
    target.network === 'mainnet' ? { testnet: createReader({ rpc: testnet.rpc, archival: testnet.archival, headersFor: headersFromEnv(engineEnv), fetch, sleep }) } : undefined

  const collect = (): Promise<VerdictResult> =>
    inNearCollectionPool(async (): Promise<VerdictResult> => {
      // Given up on while waiting for a slot: the slot goes straight back.
      if (stop.signal.aborted) return timedOut
      try {
        const snapshot = await collectSnapshot({
          account: target.account,
          network: target.network,
          known: [],
          vault: null,
          config,
          env: engineEnv,
          fetch,
          sleep,
          ...(readers ? { readers } : {}),
          ...(deps.clock ? { clock: deps.clock } : {}),
        })
        return marketVerdictFromSnapshot(snapshot)
      } catch (e) {
        if (stop.signal.aborted) return timedOut
        if (e instanceof CollectError) return { code: 'no_verdict', error: `NEAR ${target.network} could not be read: ${e.message}` }
        if (e instanceof TypeError && /is not a valid NEAR account id|at-block must be/.test(e.message)) return { code: 'invalid', error: e.message }
        // A failure of ours, not of the chain and not of the account asked about. Said as such, and
        // the error goes to the server log (it never carries the marketplace token: that is not
        // passed to the collectors).
        console.error(`[near-market] the ${target.network} collection for ${target.account} failed inside the server:`, e)
        return { code: 'no_verdict', error: `the check failed inside A-Identity's server (${e instanceof Error ? e.name : 'error'}), not because of the account asked about` }
      }
    })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<VerdictFailure>((resolve) => {
    timer = setTimeout(() => {
      stop.abort()
      resolve(timedOut)
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  try {
    return await Promise.race([collect(), timeout])
  } finally {
    clearTimeout(timer)
  }
}

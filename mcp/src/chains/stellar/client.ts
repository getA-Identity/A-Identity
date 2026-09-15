/**
 * The Stellar side of the chain layer: an RPC handle and a signer, resolved from the
 * descriptor exactly the way the EVM side resolves its own.
 *
 * This is the only file besides the adapter that imports `@stellar/stellar-sdk`, mirroring
 * the rule the chains README already sets for viem. Everything above the adapter talks in
 * plain strings and descriptors.
 *
 * The discipline copied deliberately from evm/client.ts:
 *
 * - A malformed key is treated as ABSENT, loudly, rather than throwing. A crash on
 *   startup because someone pasted a key with a trailing newline is worse than a chain
 *   that cleanly reports it cannot sign, and this repo already learned that once on
 *   Robinhood Chain (commit 3e9644d, "a signer key with a stray newline is a key, not a
 *   502").
 * - The RPC comes from the descriptor with an env override, never from a constant here.
 *
 * And one discipline that is this file's own: READS fail over across the chain's RPC list
 * and a submission never does. See FailoverSorobanServer for why that asymmetry is the
 * whole point rather than an omission.
 */
import { Keypair, Networks, SorobanDataBuilder, rpc, xdr } from '@stellar/stellar-sdk'

import type { ChainDescriptor } from '../types.js'
import { resolveRpcUrls } from '../evm/client.js'
import { isSecretSeed } from './strkey.js'

/**
 * Every RPC url this chain can be read from, primary first.
 *
 * Reused rather than duplicated. `resolveRpcUrls` is VM-agnostic in everything but its
 * current address: it reads `chain.rpcEnvVar` and falls back to `chain.rpcUrls`. If a
 * third ecosystem lands it should move to a shared module; copying four lines here would
 * just create two things that must agree.
 *
 * Its precedence is kept exactly as it is, including the part that is easy to miss: an env
 * override replaces the FIRST url and the descriptor's remaining hosts stay behind it. So
 * pointing a deployment at a private RPC does not throw away the public hosts it can fall
 * back to, and it does not silently reinstate the descriptor's primary either.
 */
export function stellarRpcUrls(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string[] {
  const urls = resolveRpcUrls(chain, env)
  if (urls.length === 0) throw new Error(`${chain.id} declares no RPC url`)
  return urls
}

/**
 * The primary RPC url, which is the env override when it is set and the descriptor's first
 * host otherwise. Kept as it was because the scripts under mcp/scripts/ build their own
 * handles from it.
 */
export function stellarRpcUrl(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): string {
  const [first] = stellarRpcUrls(chain, env)
  if (!first) throw new Error(`${chain.id} declares no RPC url`)
  return first
}

/**
 * The network passphrase, which on Stellar is what a signature is actually bound to.
 *
 * It lives here rather than in the adapter because the signing paths need it too, and two
 * copies of this mapping is how a testnet signature ends up presented to pubnet. Throwing
 * on an unknown caip2 is deliberate: there is no safe default, and guessing here would mean
 * signing for a network nobody chose.
 */
export function networkPassphrase(chain: ChainDescriptor): string {
  if (chain.caip2 === 'stellar:pubnet') return Networks.PUBLIC
  if (chain.caip2 === 'stellar:testnet') return Networks.TESTNET
  throw new Error(`${chain.id}: no known network passphrase for ${chain.caip2}`)
}

/**
 * The methods that fail over, named once so the set is a fact rather than a habit.
 *
 * These cover every read this repo makes through a Soroban handle: settlement confirmation,
 * the proof page's live check, the vault reads and the archival script. `sendTransaction`
 * is deliberately absent, and the class below explains at length why adding it would be a
 * payment bug rather than a resilience improvement.
 *
 * `_getLedgerEntries` is in the list and its public sibling `getLedgerEntries` is not, which
 * looks backwards and is not. The SDK's ledger-entry helpers swallow the error they were
 * given: `getAccountEntry` is `catch { throw new Error('Account not found: ' + address) }`,
 * and `getTrustline`, `getClaimableBalance` and `getContractData` do the same. By the time
 * an unreachable host reaches `getAccount`, the SDK has turned "nobody answered" into "the
 * account does not exist", which is a decided answer no honest failover would retry. Going
 * one layer down catches it before the erasure, and everything built on that layer inherits
 * the failover: `getLedgerEntries`, `getLedgerEntry`, `getAccount`, `getAccountEntry`,
 * `getContractData`, `getTrustline` and `getSACBalance`.
 *
 * Two more inherit it the same way at the top: `prepareTransaction` goes through
 * `simulateTransaction` and `pollTransaction` through `getTransaction`.
 */
export const FAILOVER_READ_METHODS = [
  '_getLedgerEntries',
  'getEvents',
  'getFeeStats',
  'getHealth',
  'getLatestLedger',
  'getNetwork',
  'getTransaction',
  'getTransactions',
  'getVersionInfo',
  'simulateTransaction',
] as const

export type FailoverReadMethod = (typeof FAILOVER_READ_METHODS)[number]

/** What a fallback host has to provide: exactly the methods above, and nothing else.
 *  `sendTransaction` is absent from this type as well as from the failover, so a fallback
 *  handle cannot be asked to broadcast even by accident. */
export type SorobanReads = Pick<rpc.Server, FailoverReadMethod>

/** The SDK's own options bag, read off its constructor so the two cannot drift. */
type SorobanOptions = ConstructorParameters<typeof rpc.Server>[1]

/** The seams the unit tests use. In production every default applies and nothing is
 *  substituted: the primary is `super`, the same call the base class would have made. */
export interface FailoverDeps {
  /** Builds each fallback handle. Tests pass fakes so no assertion needs a network. */
  readonly makeServer?: (url: string, opts?: SorobanOptions) => SorobanReads
  /** Where the one-time failover notice goes. Defaults to stderr. */
  readonly log?: (line: string) => void
}

/**
 * Printed once per process, not once per call. A host that is down is down for every
 * request that follows, and a line each time would bury the one line that matters under
 * thousands of identical ones.
 */
let fallbackNoticed = false

/** The host part of a url, or the url itself if it will not parse. Hosts are what an
 *  operator acts on; the path is noise in a log line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function reasonOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return String(e)
}

/** Node reports most connection failures as a bare "fetch failed" with the real code one
 *  level down on `cause`, so both the codes and the messages are matched, and the cause
 *  chain is walked rather than only the top error. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNABORTED', // the SDK's http client uses this for its own timeout
  'ERR_NETWORK',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

const TRANSPORT_MESSAGE =
  /(fetch failed|network error|socket hang up|socket disconnected|timeout|timed out|aborted|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH)/i

/**
 * Is this failure the transport, or is it the network's answer?
 *
 * That distinction is the entire safety argument for failing over. A transport failure
 * means no answer ever arrived, so asking a second host is asking the same question again.
 * Anything the host actually answered is a decision, and asking a second host to overturn
 * a decision is how a clear "no" turns into a confusing "maybe".
 *
 * Retryable, and nothing else is:
 *
 * - A thrown connection failure, by code or by message, anywhere down the `cause` chain.
 * - An HTTP 429 or 5xx from the RPC host. The SDK's client throws those axios-shaped, with
 *   the code on `response.status`. Rate limiting and a gateway error both mean "this host
 *   cannot answer right now", which is what a second host is for. Any other 4xx is a
 *   decided refusal and is left alone.
 *
 * Not retryable, on purpose:
 *
 * - A JSON-RPC error. The SDK throws `response.data.error` verbatim, a plain object whose
 *   `code` is a NUMBER, which is exactly what separates it from its client's own errors,
 *   whose codes are strings. "Method not found" is the clearest case: an RPC that does not
 *   implement a method will not implement it on the retry either, and failing over would
 *   ask every host in the list to confirm the same answer.
 * - A simulation that failed. That one never even reaches here, because the SDK RETURNS a
 *   response carrying an `error` field rather than throwing, so there is no exception for
 *   this predicate to see and no retry to suppress. It is worth stating because it is the
 *   case an operator would most expect to be retried, and must not be: a simulation error
 *   is the contract's answer, identical on every host.
 */
export function isTransportError(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false
  const top = e as { code?: unknown; status?: unknown; response?: { status?: unknown } }

  // A JSON-RPC error object: an answer, not a failure to reach anyone.
  if (typeof top.code === 'number') return false

  const status =
    typeof top.response?.status === 'number'
      ? top.response.status
      : typeof top.status === 'number'
        ? top.status
        : undefined
  if (status !== undefined) return status === 429 || status >= 500

  for (let cur: unknown = e, depth = 0; cur !== null && typeof cur === 'object' && depth < 5; depth += 1) {
    const node = cur as { code?: unknown; message?: unknown; cause?: unknown }
    if (typeof node.code === 'string' && TRANSPORT_CODES.has(node.code.toUpperCase())) return true
    if (typeof node.message === 'string' && TRANSPORT_MESSAGE.test(node.message)) return true
    cur = node.cause
  }
  return false
}

/**
 * An `rpc.Server` that fails over READS across the chain's RPC list, and never a send.
 *
 * It exists because a single host outage used to take every Stellar read down at once:
 * settlement confirmation, the proof page's live check, the vault reads and the archival
 * script all build their handle from the same one url. The registry already lists two or
 * three independent hosts per network; this is what makes the rest of the list mean
 * something.
 *
 * It extends `rpc.Server` rather than wrapping it so that callers keep the type they
 * already hold, including the ones that ask for a narrow `Pick<rpc.Server, ...>`. The
 * primary IS this object: an overridden read calls `super` first, which is the same
 * request on the same host with the same client as before, and only a transport failure
 * sends the same call to the next host in order. Non-overridden methods keep working
 * against the primary exactly as they did.
 *
 * Why `sendTransaction` is not in that list, and must not be added:
 *
 * A submission that throws is NOT decided. The request may never have left, or it may have
 * arrived and been accepted with the response lost on the way back, and from this side the
 * two look identical. Resubmitting the envelope to a second host does not create a second
 * payment, but it does produce a different ANSWER about the first one: the second host can
 * reply DUPLICATE, or TRY_AGAIN_LATER because it will not enqueue it, or ERROR because the
 * first submission already consumed the fee payer's sequence number. Two of those three are
 * read by settle.ts as a decided refusal, so the buyer would be told `broadcast_failed`
 * about a payment that is in flight and may be in the ledger a second later.
 *
 * The safe answer to an ambiguous send is the `ambiguous` handling settle.ts already has:
 * keep the locally computed hash, mark nothing spent, and let confirmStellarTransfer decide
 * by READING the chain against the receipt. That read is failed over, which is where the
 * resilience belongs, and it is why nothing is marked settled without a receipt.
 */
export class FailoverSorobanServer extends rpc.Server {
  private readonly fallbacks: { url: string; server: SorobanReads }[] = []
  private readonly log: (line: string) => void

  constructor(urls: string[], opts?: SorobanOptions, deps: FailoverDeps = {}) {
    super(urls[0], opts)
    this.log = deps.log ?? ((line: string) => console.error(line))
    const make = deps.makeServer ?? ((url: string, o?: SorobanOptions) => new rpc.Server(url, o))
    for (const url of urls.slice(1)) {
      try {
        this.fallbacks.push({ url, server: make(url, opts) })
      } catch (e) {
        // A fallback that cannot even be constructed must never take down a primary that
        // works. Loud, and then absent, the same way a malformed key is handled below.
        this.log(`[chains/stellar] ignoring the RPC fallback ${url}: ${reasonOf(e)}`)
      }
    }
  }

  /** The hosts behind the primary, in the order they would be tried. Reads as a fact for
   *  a caller that wants to report what this handle can fall back to. */
  get fallbackUrls(): string[] {
    return this.fallbacks.map((f) => f.url)
  }

  private async failover<T>(
    method: FailoverReadMethod,
    onPrimary: () => Promise<T>,
    onFallback: (server: SorobanReads) => Promise<T>,
  ): Promise<T> {
    try {
      return await onPrimary()
    } catch (first) {
      if (this.fallbacks.length === 0 || !isTransportError(first)) throw first
      let last: unknown = first
      for (const fallback of this.fallbacks) {
        try {
          const answer = await onFallback(fallback.server)
          this.noteFallback(method, fallback.url, first)
          return answer
        } catch (next) {
          // A fallback that ANSWERS, even to refuse, has settled the question; only a
          // second transport failure is worth another host.
          if (!isTransportError(next)) throw next
          last = next
        }
      }
      throw last
    }
  }

  private noteFallback(method: FailoverReadMethod, answered: string, cause: unknown): void {
    if (fallbackNoticed) return
    fallbackNoticed = true
    this.log(
      `[chains/stellar] RPC failover: ${this.serverURL.host} could not answer ${method} ` +
        `(${reasonOf(cause)}), so ${hostOf(answered)} was asked and did. Reads fail over ` +
        `across this chain's RPC list; a submission never does. Printed once per process, ` +
        `so later failovers in this process are silent.`,
    )
  }

  // The overrides. Each one takes the SDK's own parameter tuple, so a signature change in
  // the SDK is a compile error at the call sites rather than a silent mismatch here.

  /** The raw ledger-entry read. Overriding this one rather than its public siblings is the
   *  point: see FAILOVER_READ_METHODS for the four SDK helpers that would otherwise report
   *  an unreachable host as a missing account, trustline, balance or contract entry. */
  override _getLedgerEntries(...args: Parameters<rpc.Server['_getLedgerEntries']>) {
    return this.failover(
      '_getLedgerEntries',
      () => super._getLedgerEntries(...args),
      (s) => s._getLedgerEntries(...args),
    )
  }

  override getEvents(...args: Parameters<rpc.Server['getEvents']>) {
    return this.failover('getEvents', () => super.getEvents(...args), (s) => s.getEvents(...args))
  }

  override getFeeStats(...args: Parameters<rpc.Server['getFeeStats']>) {
    return this.failover('getFeeStats', () => super.getFeeStats(...args), (s) => s.getFeeStats(...args))
  }

  override getHealth(...args: Parameters<rpc.Server['getHealth']>) {
    return this.failover('getHealth', () => super.getHealth(...args), (s) => s.getHealth(...args))
  }

  override getLatestLedger(...args: Parameters<rpc.Server['getLatestLedger']>) {
    return this.failover('getLatestLedger', () => super.getLatestLedger(...args), (s) => s.getLatestLedger(...args))
  }

  override getNetwork(...args: Parameters<rpc.Server['getNetwork']>) {
    return this.failover('getNetwork', () => super.getNetwork(...args), (s) => s.getNetwork(...args))
  }

  override getTransaction(...args: Parameters<rpc.Server['getTransaction']>) {
    return this.failover('getTransaction', () => super.getTransaction(...args), (s) => s.getTransaction(...args))
  }

  override getTransactions(...args: Parameters<rpc.Server['getTransactions']>) {
    return this.failover('getTransactions', () => super.getTransactions(...args), (s) => s.getTransactions(...args))
  }

  override getVersionInfo(...args: Parameters<rpc.Server['getVersionInfo']>) {
    return this.failover('getVersionInfo', () => super.getVersionInfo(...args), (s) => s.getVersionInfo(...args))
  }

  override simulateTransaction(...args: Parameters<rpc.Server['simulateTransaction']>) {
    return this.failover(
      'simulateTransaction',
      () => super.simulateTransaction(...args),
      (s) => s.simulateTransaction(...args),
    )
  }

  // sendTransaction is NOT overridden. See the class comment: the base class submits to the
  // primary and only the primary, and an ambiguous submission is settled by reading.
}

/**
 * A Soroban RPC handle for this chain.
 *
 * With more than one url it is the failover handle above. With exactly one, which is what
 * a chain declaring a single host produces, the plain SDK client is returned: there is
 * nothing to fall back to, so a wrapper could only ever be a no-op around the same call.
 */
export function sorobanServer(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): rpc.Server {
  if (chain.ecosystem !== 'stellar') {
    throw new Error(`sorobanServer: ${chain.id} is not a Stellar chain (${chain.ecosystem})`)
  }
  const urls = stellarRpcUrls(chain, env)
  if (urls.length === 1) return new rpc.Server(urls[0])
  return new FailoverSorobanServer(urls)
}

// ── archived state ───────────────────────────────────────────────────────────────

/**
 * The footprint indexes a simulation found ARCHIVED, or an empty list.
 *
 * Protocol 23 (CAP-0066) changed how an RPC reports archived state, and the SDK's own helper
 * did not follow. Before it, a simulation that touched an archived entry came back with a
 * separate `restorePreamble`, which is the only thing `rpc.Api.isSimulationRestore` looks at.
 * Since it, the ledger restores an archived entry inside the transaction that touches it, so
 * the RPC sends no preamble at all: it lists the archived footprint indexes in the
 * transaction data's `archivedSorobanEntries` and folds the restore rent into
 * `minResourceFee`. Read live on 2026-09-15 against a pubnet contract whose instance and
 * code had both lapsed: no preamble, archivedSorobanEntries [0, 1], and a 272,124,886 stroop
 * resource fee for a read-only call. Checking the flag alone called that contract warm.
 *
 * Transaction data that will not parse yields an empty list rather than a throw. Callers use
 * this to refuse or to disclose, and a parse failure is not evidence of archived state.
 */
export function simulationArchivedEntries(sim: rpc.Api.SimulateTransactionResponse): number[] {
  if (!rpc.Api.isSimulationSuccess(sim)) return []
  try {
    const raw: unknown = sim.transactionData
    const data =
      raw instanceof SorobanDataBuilder
        ? raw.build()
        : typeof raw === 'string'
          ? xdr.SorobanTransactionData.fromXDR(raw, 'base64')
          : (raw as xdr.SorobanTransactionData | undefined)
    const ext = data?.ext()
    if (!ext || Number(ext.switch()) !== 1) return []
    return [...ext.resourceExt().archivedSorobanEntries()]
  } catch {
    return []
  }
}

/**
 * Whether a simulation touched archived state at all, in either protocol's shape.
 *
 * A caller that has to tell the two shapes apart, because the preamble needs a separate
 * restore transaction while the folded form restores itself, reads
 * `rpc.Api.isSimulationRestore` and `simulationArchivedEntries` directly instead.
 */
export function simulationNeedsRestore(sim: rpc.Api.SimulateTransactionResponse): boolean {
  return rpc.Api.isSimulationRestore(sim) || simulationArchivedEntries(sim).length > 0
}

/**
 * Whether a contract data or code entry read back by getLedgerEntries is live for the NEXT
 * ledger, which is the one a transaction submitted now would land in.
 *
 * Presence proves nothing on its own. An archived entry still comes back from the RPC, with
 * `liveUntilLedgerSeq` 0 (read live on 2026-09-15), so a check of `entries.length > 0`
 * reports an archived contract as deployed and an archived vault as live. Compare against
 * the same response's `latestLedger`, so the answer never mixes two reads.
 */
export function isLiveLedgerEntry(entry: { liveUntilLedgerSeq?: number } | undefined, latestLedger: number): boolean {
  const until = entry?.liveUntilLedgerSeq
  return typeof until === 'number' && Number.isFinite(until) && until > latestLedger
}

/**
 * The signer for this chain, or null when there is none to be had.
 *
 * Null is the normal, supported state: without a key every write returns a labeled
 * prepared no-op instead of broadcasting, which is the rule for every chain here.
 *
 * A Stellar secret is an ed25519 StrKey, `S` followed by 55 base32 characters. It is NOT
 * a 0x hex private key, and the two are not interchangeable in either direction, so a
 * value that fails the shape check is far more likely to be an EVM key in the wrong
 * variable than a typo.
 */
export function stellarKeypair(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Keypair | null {
  const name = chain.signerEnvVar
  if (!name) return null
  const raw = env[name]?.trim()
  if (!raw) return null
  if (!isSecretSeed(raw)) {
    // Loud, and then absent. Never throw: this runs at request time on a shared server.
    console.error(
      `[chains/stellar] ${name} is set but is not a Stellar secret seed (expected S + 55 ` +
        `base32 chars). Treating ${chain.id} as unsigned, so its writes will return prepared ` +
        `rather than broadcasting. If that value is a 0x hex key, it belongs to an EVM chain.`,
    )
    return null
  }
  try {
    return Keypair.fromSecret(raw)
  } catch (e) {
    console.error(
      `[chains/stellar] ${name} has the right shape but did not decode as a keypair ` +
        `(${e instanceof Error ? e.message : String(e)}). Treating ${chain.id} as unsigned.`,
    )
    return null
  }
}

/**
 * Which variable holds the rail's dedicated fee payer for this network.
 *
 * Network-scoped for the same reason the signers and the OZ keys are: one variable plus a
 * network flag is the shape that signs a pubnet transaction with a testnet key.
 *
 * This replaces X402_STELLAR_SIGNER_SECRET, which was worse than useless. It was read by
 * the rail's readiness check and by NOTHING that signs, so setting it made the rail report
 * itself configured and ready while the signing path, which only ever read the chain's own
 * signerEnvVar, still had no key. An adversarial review found it; the variable never worked
 * and is retired rather than fixed in place, since a name that once meant "ready" and now
 * means something else is its own hazard.
 */
export function feePayerEnvVar(chain: ChainDescriptor): string {
  return chain.caip2 === 'stellar:pubnet'
    ? 'X402_STELLAR_PUBNET_FEE_PAYER'
    : 'X402_STELLAR_TESTNET_FEE_PAYER'
}

/**
 * The account that pays network fees when we broadcast for a buyer.
 *
 * Tries the rail's dedicated fee payer first so it can be a thin wallet holding only XLM,
 * separate from the chain's general signer, then falls back to that signer. Validation is
 * the same in both cases, which is the point: readiness and signing must never be able to
 * disagree about whether a key exists.
 */
export function stellarFeePayer(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Keypair | null {
  const dedicated = env[feePayerEnvVar(chain)]?.trim()
  if (dedicated) {
    if (isSecretSeed(dedicated)) return Keypair.fromSecret(dedicated)
    console.error(
      `[chains/stellar] ${feePayerEnvVar(chain)} is set but is not a Stellar secret seed. ` +
        `Falling back to ${chain.signerEnvVar ?? 'the chain signer'}.`,
    )
  }
  return stellarKeypair(chain, env)
}

/** The public account the signer would act as, without exposing the key. */
export function stellarSignerAddress(
  chain: ChainDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return stellarKeypair(chain, env)?.publicKey() ?? null
}

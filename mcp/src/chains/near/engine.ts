/**
 * The NEAR verdict engine as the backend runs it.
 *
 * The engine and its collectors are not written here. They are the generated copy of
 * near/sdk/src in ./sdk.generated/ (cd mcp && npm run gen:near; never edited by hand), so the
 * backend decides with the same code the SDK CLI runs and a judge gets one answer from
 * `npm run verdict`, GET /api/near/check and the trust tools. engine.test.ts fails the build when
 * the copy differs from a fresh render of the source.
 *
 * What this file adds is the one thing the copy must not decide here: which hosts it reads. The
 * copy carries the SDK's own host list (it is a copy), and the backend never dials its testnet
 * list. One reader dials its mainnet list: the NEAR AI market worker (near-market/verdict.ts),
 * for a buyer who asks about a mainnet account. The registry has no NEAR mainnet descriptor on
 * purpose, so there is nothing else to take those hosts from, and they are exactly the ones the
 * CLI's `--network mainnet` reads. A mainnet collection also reads NEAR testnet (MimicWatch keeps
 * its registry there), and left to itself the copy would build that reader from its own testnet
 * list; the worker passes one built from the near-testnet descriptor instead (createReader below),
 * so NEAR_TESTNET_RPC_URL applies to that read too. For testnet, the
 * collectors get a NetworkConfig built from the near-testnet descriptor in ../registry.ts:
 * JSON-RPC through resolveRpcUrls (so NEAR_TESTNET_RPC_URL replaces the primary, as it does for
 * client.ts), the archival hosts, the indexers, the explorer and Circle's USDC account. The
 * values that are account ids rather than hosts (A-Identity's registry, the ERC-8004 registries
 * on NEAR, other teams' registries) are taken from the copy, so the backend asks exactly what the
 * CLI asks; engine.test.ts holds every value that enters a snapshot equal to the SDK's own.
 *
 * Read-only, like everything under chains/near/: no key, no signer, no send.
 */
import type { ChainDescriptor } from '../types.js'
import { resolveRpcUrls } from '../evm/client.js'
import { NETWORKS, type NetworkConfig } from './sdk.generated/collect/networks.js'

export { collectSnapshot, CollectError, type CollectOptions } from './sdk.generated/collect/snapshot.js'
export { createReader, headersFromEnv, type FetchLike, type FetchResponseLike, type RpcReader } from './sdk.generated/collect/rpc.js'
export { NETWORKS as SDK_NETWORKS, explorerAccountUrl, type NetworkConfig } from './sdk.generated/collect/networks.js'
export {
  verdictFromSnapshot,
  assertSnapshot,
  formatEvidence,
  registryReasons,
  ENGINE_VERSION,
  type Decision,
  type Reason,
  type ReasonCode,
  type RegistrySignal,
  type Replay,
  type Signals,
  type Snapshot,
  type VaultSignal,
  type Verdict as NearVerdict,
} from './sdk.generated/engine/index.js'
export { SDK_VERSION } from './sdk.generated/version.js'

/**
 * The collectors' NetworkConfig for a NEAR descriptor, every host from the descriptor.
 *
 * Testnet only, because the account ids it takes from the copy are the copy's testnet ones.
 * Throws on a descriptor that lacks a field the engine reads, rather than falling back to the
 * copy's host for it.
 */
export function nearEngineNetwork(chain: ChainDescriptor, env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  if (chain.ecosystem !== 'near') throw new Error(`nearEngineNetwork: ${chain.id} is not a NEAR chain (${chain.ecosystem})`)
  if (!chain.testnet) throw new Error(`nearEngineNetwork: ${chain.id} is not NEAR testnet; the engine is wired for testnet only`)
  const archival = chain.archivalRpcUrls ?? []
  if (archival.length === 0) throw new Error(`${chain.id} declares no archivalRpcUrls, which the engine's probes need`)
  if (!chain.indexerUrls) throw new Error(`${chain.id} declares no indexerUrls, which the engine's activity signal needs`)
  if (!chain.explorer) throw new Error(`${chain.id} declares no explorer`)
  const usdc = chain.documentedTokens?.find((t) => t.symbol === 'USDC')?.address
  if (!usdc) throw new Error(`${chain.id} documents no USDC account, which the engine reads the blocklist from`)
  // The archival hosts follow the regular ones in every non-archival read already (the reader
  // appends them), so a host in both lists would be asked twice in a row.
  const rpc = resolveRpcUrls(chain, env).filter((u) => !archival.includes(u))
  if (rpc.length === 0) throw new Error(`${chain.id} declares no regular RPC url`)
  const sdk = NETWORKS.testnet
  return {
    network: 'testnet',
    rpc,
    archival,
    fastnearTx: chain.indexerUrls.fastnearTx,
    nearblocks: chain.indexerUrls.nearblocks,
    explorer: chain.explorer,
    usdc,
    registry: sdk.registry,
    erc8004: sdk.erc8004,
    thirdParty: sdk.thirdParty,
  }
}

/**
 * The only environment the collectors read: the optional indexer API keys, which they send to
 * their own hosts and never record or print. Nothing else in the process environment is passed.
 */
export function nearEngineEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return { FASTNEAR_API_KEY: env.FASTNEAR_API_KEY, NEARBLOCKS_API_KEY: env.NEARBLOCKS_API_KEY }
}

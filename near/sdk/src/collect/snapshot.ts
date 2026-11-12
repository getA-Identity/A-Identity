// Collect ONE snapshot of everything the engine reads about a payee, pinned to one block.
//
// Every state read carries the pinned block's height as block_id, and the archival probes carry
// the height of the block they found about 72 hours and 30 days earlier, so anyone can send the
// recorded requests to an archival node and get the recorded answers back (chain_sha256).
// A registry on the other network is read at that network's latest block at or before the
// pinned block's timestamp. Every one of these heights is derived from the pinned block alone,
// so collecting the same block again (--at-block) records the same requests and answers.
// Indexer answers are recorded verbatim with their fetch time.
//
// Read-only: JSON-RPC views and indexer GET/POST queries. No keys, no transactions.

import { isValidAccountId } from "../engine/account.ts";
import { LABEL } from "../engine/labels.ts";
import { DEFAULT_POLICY, type Policy } from "../engine/policy.ts";
import { SNAPSHOT_SCHEMA, type Network, type Snapshot } from "../engine/types.ts";
import { SDK_VERSION } from "../version.ts";
import { CollectError, pinBlock, recordKeys, recordProbeBlock, viewAccountParams } from "./account.ts";
import { recordErc8004 } from "./erc8004.ts";
import { createHttpClient, type HttpClient } from "./http.ts";
import { recordIndexers } from "./indexers.ts";
import { NETWORKS, type NetworkConfig } from "./networks.ts";
import { createRecorder } from "./recorder.ts";
import { createReader, headersFromEnv, type FetchLike, type RpcReader } from "./rpc.ts";
import { recordThirdParty } from "./thirdparty.ts";
import { recordRegistry, recordUsdc, recordVault, recordVaultConfig } from "./views.ts";

export { CollectError };

export type CollectOptions = {
  account: string;
  network?: Network;
  /** Pin to this height (read through archival nodes). Default: the latest final block. */
  atBlock?: number;
  /** Payees the owner already knows; a payee that imitates one is a lookalike. */
  known?: readonly string[];
  /** The agent's vault: prior payments, refusals and the owner allowlist come from it. */
  vault?: string | null;
  /** The A-Identity registry. Default: the vault's registry, else the network's; null for none. */
  registry?: string | null;
  thirdParty?: boolean;
  erc8004?: boolean;
  indexers?: boolean;
  policy?: Policy;
  /** Host overrides, mostly for tests. */
  config?: NetworkConfig;
  readers?: Partial<Record<Network, RpcReader>>;
  http?: HttpClient | null;
  fetch?: FetchLike;
  /** FASTNEAR_API_KEY and NEARBLOCKS_API_KEY are read from here if present. Never recorded. */
  env?: Record<string, string | undefined>;
  clock?: () => Date;
  /** Waits for pacing and backoff (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
};

function requireAccountId(id: string, what: string): void {
  if (!isValidAccountId(id)) throw new TypeError(`${what} is not a valid NEAR account id: ${JSON.stringify(id)}`);
}

export async function collectSnapshot(opts: CollectOptions): Promise<Snapshot> {
  const subject = opts.account;
  requireAccountId(subject, "account");
  const known = [...new Set(opts.known ?? [])].sort();
  for (const k of known) requireAccountId(k, "known payee");
  if (opts.vault) requireAccountId(opts.vault, "vault");
  if (opts.registry) requireAccountId(opts.registry, "registry");
  if (opts.atBlock !== undefined && (!Number.isSafeInteger(opts.atBlock) || opts.atBlock <= 0)) {
    throw new TypeError(`at-block must be a positive block height, got ${opts.atBlock}`);
  }

  const network: Network = opts.network ?? "testnet";
  const cfg = opts.config ?? NETWORKS[network];
  const policy = opts.policy ?? DEFAULT_POLICY;
  const clock = opts.clock ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const headersFor = headersFromEnv(opts.env ?? {});
  const thirdParty = opts.thirdParty === false ? [] : [...cfg.thirdParty];
  const needs = new Set<Network>([network, ...thirdParty.map((s) => s.network)]);
  const readers: Partial<Record<Network, RpcReader>> = { ...opts.readers };
  for (const n of needs) {
    if (!readers[n]) {
      const c = n === network ? cfg : NETWORKS[n];
      readers[n] = createReader({ rpc: c.rpc, archival: c.archival, headersFor, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) });
    }
  }
  const http =
    opts.indexers === false
      ? null
      : opts.http !== undefined
        ? opts.http
        : createHttpClient({ headersFor, clock, ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}) });
  const rec = createRecorder(readers, http);
  // Reads at the pinned block go to regular nodes first even with --at-block: a node that pruned
  // the block answers UNKNOWN_BLOCK or GARBAGE_COLLECTED_BLOCK, which fails over to the archival
  // hosts. Only the probes, days back, are archival-only, which keeps the rate-limited archival
  // hosts for what needs them.
  const archival = false;

  const block = await pinBlock(rec, network, opts.atBlock);
  const height = block.height;

  // If this read fails the snapshot still completes: it records the failure, and the engine
  // answers WARN (rpc_unavailable), never ALLOW.
  const account = await rec.rpc(LABEL.account, network, "query", viewAccountParams(subject, height), archival);
  const view = (account.error ? null : account.result) as { code_hash?: string; global_contract_account_id?: string; global_contract_hash?: string } | null;
  const exists = view !== null;
  const hasContract = exists && (view.code_hash !== "11111111111111111111111111111111" || !!view.global_contract_account_id || !!view.global_contract_hash);

  // The vault config comes first: when no registry is given, the vault's registry is the one
  // that will judge this payment on chain, so it is the one to read.
  let registry: string | null;
  if (opts.vault) {
    const vcfg = await recordVaultConfig(rec, network, opts.vault, height, archival);
    registry = opts.registry !== undefined ? opts.registry : (vcfg?.registry ?? cfg.registry);
  } else {
    registry = opts.registry !== undefined ? opts.registry : cfg.registry;
  }
  const erc8004 = opts.erc8004 === false ? null : cfg.erc8004;

  const views = async () => {
    if (exists) await recordKeys(rec, network, LABEL.keys, subject, height, archival);
    await recordUsdc(rec, network, cfg.usdc, subject, height, archival);
    if (registry) await recordRegistry(rec, network, registry, subject, height, archival);
    if (opts.vault) await recordVault(rec, network, opts.vault, subject, height, archival);
    if (erc8004) await recordErc8004(rec, network, erc8004, subject, height, archival);
  };
  const probes = async () => {
    if (!exists) return;
    const recent = await recordProbeBlock(rec, network, block, policy.recent_s, policy.probe_tolerance_s, LABEL.recentBlock, LABEL.recentSearch);
    if (!recent) return;
    const before = await rec.rpc(LABEL.recentAccount, network, "query", viewAccountParams(subject, recent.height), true);
    if (before.error) return;
    await recordKeys(rec, network, LABEL.recentKeys, subject, recent.height, true);
    const long = await recordProbeBlock(rec, network, block, policy.long_s, policy.probe_tolerance_s, LABEL.longBlock, LABEL.longSearch);
    if (long) await rec.rpc(LABEL.longAccount, network, "query", viewAccountParams(subject, long.height), true);
  };
  const others = async () => {
    if (thirdParty.length) await recordThirdParty(rec, network, thirdParty, subject, block, archival, sleep);
  };
  let usedNearblocks = false;
  const indexers = async () => {
    if (!http) return;
    usedNearblocks = (await recordIndexers(rec, cfg, subject, policy.min_activity_txs, hasContract)).usedNearblocks;
  };
  await Promise.all([views(), probes(), others(), indexers()]);

  const byLabel = (a: { label: string }, b: { label: string }) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  const notes: string[] = [];
  if (usedNearblocks) notes.push("Some data: Powered by Nearblocks.io APIs (https://nearblocks.io).");
  for (const other of new Set(thirdParty.filter((s) => s.network !== network).map((s) => s.network))) {
    const pinnedThere = rec.rpcRecords.some((r) => r.label === LABEL.crossBlock(other));
    notes.push(
      pinnedThere
        ? `Registries on ${other} were read at its latest block at or before this block's time (labels block.${other} and block.${other}.next), so the same block always reads them at the same height.`
        : `Registries on ${other} were not read: no ${other} block at or before this block's time could be established.`,
    );
  }
  if (!http) notes.push("Indexers were disabled for this snapshot.");

  return {
    schema: SNAPSHOT_SCHEMA,
    network,
    subject,
    block,
    context: {
      known,
      vault_id: opts.vault ?? null,
      registry_id: registry,
      usdc_id: cfg.usdc,
      third_party: thirdParty,
      erc8004,
      probes: { recent_s: policy.recent_s, long_s: policy.long_s },
      activity_window: policy.min_activity_txs,
    },
    rpc: [...rec.rpcRecords].sort(byLabel),
    http: [...rec.httpRecords].sort(byLabel),
    meta: { collected_at: clock().toISOString(), collector: SDK_VERSION, endpoints: rec.endpointsUsed(), notes },
  };
}

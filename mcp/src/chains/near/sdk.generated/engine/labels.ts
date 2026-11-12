// GENERATED FILE: do not edit.
// Source: near/sdk/src/engine/labels.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// Record labels: the contract between the collector, which writes each answer under a label,
// and normalize(), which reads answers by label. A label is part of the snapshot format, so a
// label never changes meaning; a new kind of read gets a new label.

import type { Network } from "./types.js";

export const LABEL = {
  /** The pinned block itself (header fields only). */
  block: "block",
  /** view_account at the pinned block. */
  account: "account",
  /** view_access_key_list at the pinned block, one record per page of 100. */
  keys: (page: number) => `keys#${page}`,

  /** The block chosen about `recent_s` before the pinned block, and the steps that found it. */
  recentBlock: "probe.recent.block",
  recentSearch: (step: number) => `probe.recent.search#${step}`,
  recentAccount: "probe.recent.account",
  recentKeys: (page: number) => `probe.recent.keys#${page}`,
  /** The same for `long_s`. */
  longBlock: "probe.long.block",
  longSearch: (step: number) => `probe.long.search#${step}`,
  longAccount: "probe.long.account",

  usdcBlocklisted: "usdc.is_blocklisted",
  usdcStorage: "usdc.storage_balance_of",

  registryVerdict: "registry.get_verdict",
  registryReports: "registry.get_reports",
  registryReportCount: "registry.report_count",
  registryList: "registry.list_verdicts",

  vaultConfig: "vault.get_config",
  vaultPaid: "vault.paid_count",
  vaultRefusals: "vault.refusal_count",
  vaultGuardRefusals: "vault.guard_refusal_count",
  vaultAllowed: "vault.is_allowed",
  vaultAllowlist: "vault.list_allowlist",

  erc8004Tokens: "erc8004.nft_tokens_for_owner",
  erc8004Clients: "erc8004.get_clients",
  erc8004Summary: "erc8004.get_summary",

  thirdParty: (id: string) => `third_party.${id}`,
  /**
   * A block pinned on another network, for reads that live there: the latest block of that
   * network at or before the pinned block's timestamp (snapshots from SDK 0.1.0 used its latest
   * final block, which a later collection cannot reproduce).
   */
  crossBlock: (network: Network) => `block.${network}`,
  /** Its direct successor (prev_hash = the cross block's hash), after the pinned timestamp. */
  crossBlockNext: (network: Network) => `block.${network}.next`,

  fastnearOldest: "fastnear.oldest",
  fastnearNewest: "fastnear.newest",
  nearblocksAccount: "nearblocks.account",
  nearblocksOldest: "nearblocks.oldest",
  nearblocksDeployments: "nearblocks.deployments",
} as const;

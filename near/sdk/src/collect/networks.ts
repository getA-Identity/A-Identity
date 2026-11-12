// Hosts and contract ids per network, in one place. Every value was checked live on 2026-11-12
// with read-only calls (see sdk/README.md, "Data sources").
//
// RPC order matters: the first host is tried first, and a different operator follows it, so one
// provider's outage or rate limit does not take the engine down. Archival hosts answer reads at
// old blocks, which regular nodes garbage-collect after a few epochs.

import type { Network, ThirdPartySource } from "../engine/types.ts";

export type NetworkConfig = {
  network: Network;
  /** Regular JSON-RPC, in failover order. */
  rpc: readonly string[];
  /** Archival JSON-RPC (reads pinned to old blocks, old transactions). */
  archival: readonly string[];
  /** FastNEAR transactions API base (POST /v0/account). */
  fastnearTx: string;
  /** NearBlocks API base (v3 only; v1 is retired). Attribution: "Powered by Nearblocks.io APIs". */
  nearblocks: string;
  /** Human explorer, for links only. Its pages challenge non-browser clients. */
  explorer: string;
  /** Circle's USDC (6 decimals). Never usdc.testnet or usdc.fakes.testnet: they emit no NEP-141 events. */
  usdc: string;
  /** A-Identity's verdict registry, when one is deployed on this network. */
  registry: string | null;
  /** ERC-8004 identity and reputation registries on NEAR (Arras, UltravioletaDAO). */
  erc8004: { identity: string; reputation: string } | null;
  /** Other teams' public registries read as attributed signals. */
  thirdParty: readonly ThirdPartySource[];
};

// Verified 2026-11-12 from each contract's embedded ABI (__contract_abi) and live view calls.
const MIMICWATCH: ThirdPartySource = {
  id: "mimicwatch",
  name: "MimicWatch",
  contract: "registry.mimicwatch-e7iig5g5.testnet",
  network: "testnet",
  method: "is_flagged",
  arg: "id",
};
const TRIPWIRE: ThirdPartySource = {
  id: "tripwire",
  name: "Tripwire",
  contract: "tripwire-registry-44ea74.testnet",
  network: "testnet",
  method: "get_risk",
  arg: "account_id",
};
const NEAR_LEASH: ThirdPartySource = {
  id: "near_leash",
  name: "near-leash",
  contract: "leash-registry.testnet",
  network: "testnet",
  method: "verdict",
  arg: "account_id",
};
const LEASH_COMMONS: ThirdPartySource = {
  id: "leash_commons",
  name: "Leash commons",
  contract: "registry.leash-busel-commons.testnet",
  network: "testnet",
  method: "get_status",
  arg: "account_id",
};

export const NETWORKS: Readonly<Record<Network, NetworkConfig>> = {
  testnet: {
    network: "testnet",
    rpc: ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"],
    // near.org's archival host is deprecated and allows about 20 requests a minute: last resort.
    archival: ["https://archival-rpc.testnet.fastnear.com", "https://archival-rpc.testnet.near.org"],
    fastnearTx: "https://tx.test.fastnear.com",
    nearblocks: "https://api-testnet.nearblocks.io",
    explorer: "https://testnet.nearblocks.io",
    usdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
    registry: "registry.a-identity.testnet",
    erc8004: { identity: "identity-registry.erc-8004.testnet", reputation: "reputation-registry.erc-8004.testnet" },
    thirdParty: [MIMICWATCH, TRIPWIRE, NEAR_LEASH, LEASH_COMMONS],
  },
  mainnet: {
    network: "mainnet",
    rpc: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://free.rpc.fastnear.com"],
    archival: ["https://archival-rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.near.org"],
    fastnearTx: "https://tx.main.fastnear.com",
    nearblocks: "https://api.nearblocks.io",
    explorer: "https://nearblocks.io",
    usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    registry: null,
    erc8004: { identity: "identity-registry.erc-8004.near", reputation: "reputation-registry.erc-8004.near" },
    // MimicWatch keeps its registry on testnet but lists mainnet impersonators in it, so it is
    // read across networks, at the latest testnet block at or before the pinned mainnet block's
    // timestamp (pinCrossBlock). The other three list testnet demo accounts only.
    thirdParty: [MIMICWATCH],
  },
};

export function explorerTxUrl(network: Network, txHash: string): string {
  return `${NETWORKS[network].explorer}/txns/${txHash}`;
}

export function explorerAccountUrl(network: Network, accountId: string): string {
  return `${NETWORKS[network].explorer}/address/${accountId}`;
}

/** A curl a machine can run to check a transaction on archival RPC (explorers block scripts). */
export function archivalTxCurl(network: Network, txHash: string, senderId: string): string {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "tx",
    method: "EXPERIMENTAL_tx_status",
    params: { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" },
  });
  return `curl -s ${NETWORKS[network].archival[0]} -H 'content-type: application/json' -d '${body}'`;
}

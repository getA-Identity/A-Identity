// ERC-8004 on NEAR: Arras's identity and reputation registries (UltravioletaDAO/arras, deployed
// on testnet and mainnet, zero access keys on mainnet). Method names come from their embedded
// ABI, verified live on 2026-11-12:
//   identity:   nft_tokens_for_owner(account_id, from_index, limit) -> agent identity NFTs
//   reputation: get_clients(agent_id, from_index, limit), and
//               get_summary(agent_id, client_addresses, tag1, tag2) -> {count, summary_value,
//               summary_value_decimals}; client_addresses must not be empty (ERC8004_REP_E30).
// An identity is a positive signal for an agent payee; registration is permissionless, so the
// engine lets it raise the score and never clear a warning.

import { LABEL } from "../engine/labels.ts";
import { viewOf } from "../engine/normalize.ts";
import type { Network } from "../engine/types.ts";
import type { Recorder } from "./recorder.ts";
import { view } from "./views.ts";

export async function recordErc8004(
  rec: Recorder,
  network: Network,
  registries: { identity: string; reputation: string },
  subject: string,
  blockId: number,
  archival: boolean,
): Promise<void> {
  const tokens = await view(rec, LABEL.erc8004Tokens, network, registries.identity, "nft_tokens_for_owner", { account_id: subject, from_index: null, limit: 5 }, blockId, archival);
  const t = viewOf(tokens);
  if (!t.ok || !Array.isArray(t.value) || t.value.length === 0) return;
  const ids = t.value
    .map((x) => (typeof x === "object" && x !== null ? (x as { token_id?: unknown }).token_id : undefined))
    .filter((x): x is string => typeof x === "string")
    .sort((a, b) => Number(a) - Number(b));
  const agentId = ids[0];
  if (agentId === undefined) return;
  const clients = await view(rec, LABEL.erc8004Clients, network, registries.reputation, "get_clients", { agent_id: agentId, from_index: 0, limit: 20 }, blockId, archival);
  const c = viewOf(clients);
  if (!c.ok || !Array.isArray(c.value) || c.value.length === 0) return;
  const addresses = c.value.filter((x): x is string => typeof x === "string");
  await view(
    rec,
    LABEL.erc8004Summary,
    network,
    registries.reputation,
    "get_summary",
    { agent_id: agentId, client_addresses: addresses, tag1: null, tag2: null },
    blockId,
    archival,
  );
}

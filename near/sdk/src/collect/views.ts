// Contract views pinned to the snapshot block: Circle USDC, A-Identity's registry, the vault.
// Method and argument names follow the contracts' source (near/contracts/*/src/lib.rs) and, for
// USDC, the live FiatToken contract.

import { LABEL } from "../engine/labels.ts";
import { viewOf } from "../engine/normalize.ts";
import type { JsonObject, JsonValue, Network, RpcRecord } from "../engine/types.ts";
import { argsBase64, type Recorder } from "./recorder.ts";

export function callParams(contract: string, method: string, args: JsonValue, blockId: number): JsonObject {
  return { request_type: "call_function", account_id: contract, method_name: method, args_base64: argsBase64(args), block_id: blockId };
}

export function view(rec: Recorder, label: string, network: Network, contract: string, method: string, args: JsonValue, blockId: number, archival = false): Promise<RpcRecord> {
  return rec.rpc(label, network, "query", callParams(contract, method, args, blockId), archival);
}

export async function recordUsdc(rec: Recorder, network: Network, usdc: string, subject: string, blockId: number, archival: boolean): Promise<void> {
  await view(rec, LABEL.usdcBlocklisted, network, usdc, "is_blocklisted", { account_id: subject }, blockId, archival);
  await view(rec, LABEL.usdcStorage, network, usdc, "storage_balance_of", { account_id: subject }, blockId, archival);
}

/** Registry views. Stops after get_verdict when the registry is not deployed at this block. */
export async function recordRegistry(rec: Recorder, network: Network, registry: string, subject: string, blockId: number, archival: boolean): Promise<void> {
  const first = await view(rec, LABEL.registryVerdict, network, registry, "get_verdict", { account_id: subject }, blockId, archival);
  if (first.error && (first.error.cause === "UNKNOWN_ACCOUNT" || first.error.cause === "NO_CONTRACT_CODE")) return;
  await view(rec, LABEL.registryReports, network, registry, "get_reports", { account_id: subject }, blockId, archival);
  await view(rec, LABEL.registryReportCount, network, registry, "report_count", { account_id: subject }, blockId, archival);
  // The first page of verdicts (the registry's MAX_PAGE): live ALLOW entries join the known set.
  await view(rec, LABEL.registryList, network, registry, "list_verdicts", { from_index: "0", limit: "100" }, blockId, archival);
}

/** The vault's own config, read first when the registry id has to come from it. */
export async function recordVaultConfig(rec: Recorder, network: Network, vault: string, blockId: number, archival: boolean): Promise<{ registry: string | null; token: string | null } | null> {
  const r = await view(rec, LABEL.vaultConfig, network, vault, "get_config", {}, blockId, archival);
  const v = viewOf(r);
  if (!v.ok || typeof v.value !== "object" || v.value === null) return null;
  const cfg = v.value as { registry_id?: unknown; token_id?: unknown };
  return { registry: typeof cfg.registry_id === "string" ? cfg.registry_id : null, token: typeof cfg.token_id === "string" ? cfg.token_id : null };
}

export async function recordVault(rec: Recorder, network: Network, vault: string, subject: string, blockId: number, archival: boolean): Promise<void> {
  await view(rec, LABEL.vaultPaid, network, vault, "paid_count", { payee: subject }, blockId, archival);
  await view(rec, LABEL.vaultRefusals, network, vault, "refusal_count", { payee: subject }, blockId, archival);
  // Added in vault v1.1; an older vault answers MethodNotFound, which the engine accepts.
  await view(rec, LABEL.vaultGuardRefusals, network, vault, "guard_refusal_count", { payee: subject }, blockId, archival);
  await view(rec, LABEL.vaultAllowed, network, vault, "is_allowed", { payee: subject }, blockId, archival);
  await view(rec, LABEL.vaultAllowlist, network, vault, "list_allowlist", {}, blockId, archival);
}

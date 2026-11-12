// Shared test helpers. No network: fixtures are recorded answers, fetch is stubbed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike, RpcReader } from "../src/collect/rpc.ts";
import { assertSnapshot } from "../src/engine/index.ts";
import type { JsonValue, RpcRecord, Signals, Snapshot } from "../src/engine/types.ts";

export const FIXTURES = join(import.meta.dirname, "fixtures");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

export function snapshotFixture(name: string): Snapshot {
  return assertSnapshot(fixture(name));
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

/** A call_function answer as nearcore returns it: the JSON value's bytes. */
export function viewAnswer(value: JsonValue, snap: Snapshot): JsonValue {
  return { block_hash: snap.block.hash, block_height: snap.block.height, logs: [], result: [...new TextEncoder().encode(JSON.stringify(value))] };
}

/** Replace (or add) one recorded view answer, pinned to the snapshot's block. */
export function setView(snap: Snapshot, label: string, contract: string, method: string, value: JsonValue): void {
  snap.rpc = snap.rpc.filter((r) => r.label !== label);
  const rec: RpcRecord = {
    label,
    network: snap.network,
    archival: false,
    method: "query",
    params: { request_type: "call_function", account_id: contract, method_name: method, args_base64: "e30=", block_id: snap.block.height },
    result: viewAnswer(value, snap),
  };
  snap.rpc.push(rec);
}

/** A copy of a recorded snapshot as if collected for the demo vault, with the vault's answers. */
export function withVault(snap: Snapshot, v: { paid: number; refusals?: number; guard?: JsonValue | "missing"; allowed?: boolean }): Snapshot {
  const s = clone(snap);
  const vault = "vault.aid-demo-owner.testnet";
  s.context.vault_id = vault;
  setView(s, "vault.paid_count", vault, "paid_count", v.paid);
  setView(s, "vault.refusal_count", vault, "refusal_count", v.refusals ?? 0);
  if (v.guard === "missing") {
    s.rpc = s.rpc.filter((r) => r.label !== "vault.guard_refusal_count");
    s.rpc.push({
      label: "vault.guard_refusal_count",
      network: s.network,
      archival: false,
      method: "query",
      params: { request_type: "call_function", account_id: vault, method_name: "guard_refusal_count", args_base64: "e30=", block_id: s.block.height },
      error: { name: "HANDLER_ERROR", cause: "CONTRACT_EXECUTION_ERROR", kind: "MethodNotFound", message: "wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))" },
    });
  } else {
    setView(s, "vault.guard_refusal_count", vault, "guard_refusal_count", v.guard ?? 0);
  }
  setView(s, "vault.is_allowed", vault, "is_allowed", v.allowed ?? false);
  setView(s, "vault.list_allowlist", vault, "list_allowlist", []);
  return s;
}

const BLOCK = { height: 277300000, hash: "3LerCNmMVyVpip6XXANLXaNmQqqvL6HQ8zbzMhCg1KBZ", timestamp_ns: "1794450000000000000" };

/** An old, active, clean named account with no registry and no vault: the engine says ALLOW. */
export function baseSignals(): Signals {
  return {
    subject: "shop.testnet",
    network: "testnet",
    kind: "named",
    block: BLOCK,
    known: [],
    is_known: false,
    account: {
      state: "ok",
      exists: true,
      code_hash: "11111111111111111111111111111111",
      has_contract: false,
      global_contract: null,
      balance_yocto: "5000000000000000000000000",
      storage_usage: 182,
      source: "rpc view_account@277300000",
    },
    keys: { state: "ok", total: 1, full_access: 1, function_call: 0, signed_txs_estimate: 40, source: "rpc view_access_key_list@277300000" },
    age: { state: "ok", is_new: false, is_long: true, created_ts_ns: "1700000000000000000", source: "rpc archival view_account@276858000", detail: "existed at block #276858000" },
    key_changes: { state: "ok", added_full_access: [], source: "rpc archival view_access_key_list@276858000" },
    code_change: { state: "not_applicable", why: "no contract code at the block" },
    activity: { state: "ok", tx_count: 5, at_least: true, first_tx: { hash: "9noFqe2r3ViBvDTz2qFMyY1WGjJq9vgMLAiXMxNdS7Nn", height: 44208090, timestamp_ns: "1618602611653886880" }, source: "indexer fastnear" },
    usdc: { state: "ok", blocklisted: false, registered: true, source: "rpc usdc.is_blocklisted@277300000" },
    registry: { state: "not_configured" },
    vault: { state: "not_configured" },
    lookalike: null,
    third_party: [],
    erc8004: { state: "not_configured" },
  };
}

export const REGISTRY_OK = {
  state: "ok" as const,
  id: "registry.a-identity.testnet",
  verdict: null,
  open_reports: 0,
  open_reporters: [],
  newest_open_report_ns: null,
  lifetime_reports: 0,
  source: "rpc registry.a-identity.testnet.get_verdict@277300000",
};

export const VAULT_OK = {
  state: "ok" as const,
  id: "vault.aid-demo-owner.testnet",
  paid_count: 0,
  refusal_count: 0,
  guard_refusal_count: 0,
  allowlisted: false,
  source: "rpc vault.aid-demo-owner.testnet.paid_count@277300000",
};

export type Exchange = { url: string; method: string; body: unknown; status: number; text: string };

/** A fetch that answers only recorded requests (JSON-RPC ids ignored) and fails on anything else. */
export function replayFetch(exchanges: readonly Exchange[], calls: string[] = []): FetchLike {
  return async (url, init) => {
    let body: unknown = null;
    if (init.body) {
      const parsed = JSON.parse(init.body) as Record<string, unknown>;
      if ("jsonrpc" in parsed) delete parsed.id;
      body = parsed;
    }
    const key = JSON.stringify([url, init.method, body]);
    calls.push(key);
    const hit = exchanges.find((x) => JSON.stringify([x.url, x.method, x.body]) === key);
    if (!hit) throw new TypeError(`unrecorded request ${key}`);
    return { status: hit.status, text: async () => hit.text };
  };
}

/** A fetch that fails every request, to prove a code path never touches the network. */
export const noNetwork: FetchLike = async (url) => {
  throw new Error(`network access attempted: ${url}`);
};

/** A reader whose answers come from a function. */
export function stubReader(answer: (method: string, params: Record<string, unknown>) => unknown): RpcReader {
  return {
    async call(method, params) {
      return { result: await answer(method, params), endpoint: "stub" };
    },
    endpointsUsed: () => ["stub"],
  };
}

export const noSleep = async (_ms: number) => {};

// ---------------------------------------------------------------------------------------------
// Synthetic vault outcomes: the vault is not deployed yet, so these follow its event ABI
// (near/contracts/agent-spend-policy/src/event.rs) and the real USDC receipt's log format.

export const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
export const VAULT = "vault.aid-demo-owner.testnet";
export const PAYEE = "aid-demo-merchant.testnet";
const DEFAULT_PAYEE = PAYEE;
export const REGISTRY = "registry.a-identity.testnet";
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const ev = (standard: string, event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard, version: "1.0.0", event, data })}`;

export type VaultTxOpts = {
  outcome: "sent" | "refused" | "held";
  payee?: string;
  amount?: string;
  eventAmount?: string;
  tokenFails?: boolean;
  fakeEventFromVault?: boolean;
  transferCaller?: string;
  /** The held event's `kind` (vault 0.2.0 on); default unknown_payee, null for an earlier build's event without one. */
  holdKind?: string | null;
};

/** A vault pay as EXPERIMENTAL_tx_status returns it (synthetic, see the header). */
export function vaultPayTx(o: VaultTxOpts): unknown {
  const PAYEE = o.payee ?? DEFAULT_PAYEE;
  const amount = o.amount ?? "250000";
  const pay =
    o.outcome === "sent"
      ? { status: "sent", payment_id: "7", reason: null, held_id: null }
      : o.outcome === "refused"
        ? { status: "refused", payment_id: "7", reason: "RegistryDeny", held_id: null }
        : { status: "held", payment_id: "7", reason: "UnknownPayee", held_id: "3" };
  const receipt = (id: string, executor: string, status: unknown, logs: string[] = []) => ({ id, outcome: { executor_id: executor, gas_burnt: 1_000_000_000_000, logs, receipt_ids: [], status } });
  const outcomes = [receipt("R1", VAULT, { SuccessReceiptId: "R3" }), receipt("R2", REGISTRY, { SuccessValue: b64(null) })];
  const receipts: unknown[] = [];
  if (o.outcome === "sent") {
    const transferLogs = [ev("nep141", "ft_transfer", [{ old_owner_id: VAULT, new_owner_id: PAYEE, amount: o.eventAmount ?? amount }])];
    outcomes.push(
      receipt("R3", VAULT, { SuccessReceiptId: "R6" }),
      receipt("R4", USDC, { SuccessValue: b64({ total: "1250000000000000000000", available: "0" }) }),
      receipt("R5", USDC, o.tokenFails ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: FiatToken: paused" } } } } } : { SuccessValue: "" }, o.tokenFails ? [] : transferLogs),
      receipt("R6", VAULT, { SuccessValue: b64(pay) }, [
        ...(o.fakeEventFromVault ? transferLogs : []),
        ev("a_identity_vault", "payment_sent", { payment_id: "7", payee: PAYEE, amount, day: "20769", by_owner: false, memo: null }),
      ]),
    );
    receipts.push({
      receipt_id: "R5",
      predecessor_id: o.transferCaller ?? VAULT,
      receiver_id: USDC,
      receipt: { Action: { actions: [{ FunctionCall: { method_name: "ft_transfer", args: b64({ receiver_id: PAYEE, amount, memo: null }), gas: 15_000_000_000_000, deposit: "1" } }] } },
    });
  } else if (o.outcome === "refused") {
    outcomes.push(receipt("R3", VAULT, { SuccessValue: b64(pay) }, [ev("a_identity_vault", "payment_refused", { payment_id: "7", payee: PAYEE, amount, reason: "RegistryDeny", source: "registry", registry_reasons: ["drainer"] })]));
  } else {
    const kind = o.holdKind === undefined ? "unknown_payee" : o.holdKind;
    outcomes.push(
      receipt("R3", VAULT, { SuccessValue: b64(pay) }, [
        ev("a_identity_vault", "payment_held", { payment_id: "7", held_id: "3", payee: PAYEE, amount, reason: "UnknownPayee", ...(kind === null ? {} : { kind }) }),
      ]),
    );
  }
  const final = outcomes[outcomes.length - 1]!.outcome.status as { SuccessValue?: string };
  return {
    final_execution_status: "FINAL",
    status: o.tokenFails ? { SuccessValue: b64({ status: "failed", payment_id: "7", reason: "TransferFailed", held_id: null }) } : { SuccessValue: final.SuccessValue ?? b64(pay) },
    transaction: { hash: "SynthTx1111111111111111111111111111111111111", signer_id: VAULT, receiver_id: VAULT, actions: [{ FunctionCall: { method_name: "pay", args: b64({ payee: PAYEE, amount, memo: null }), gas: 73_000_000_000_000, deposit: "0" } }] },
    transaction_outcome: { id: "SynthTx1111111111111111111111111111111111111", outcome: { executor_id: VAULT, gas_burnt: 2_300_000_000_000, logs: [], receipt_ids: ["R1"], status: { SuccessReceiptId: "R1" } } },
    receipts_outcome: outcomes,
    receipts,
  };
}


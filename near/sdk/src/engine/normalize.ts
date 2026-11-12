// Snapshot -> Signals.
//
// Every value here is read from a recorded answer by its label (labels.ts). An answer that is
// missing, failed, or has an unexpected shape becomes an explicit "unavailable" signal with the
// reason, never a default: rules.ts turns unavailable data into a WARN, so missing data can never
// produce an ALLOW. All time arithmetic is relative to the pinned block's timestamp, never the
// clock, so a replay a year later gives the same signals.

import { accountKind } from "./account.ts";
import { LABEL } from "./labels.ts";
import { findLookalike } from "./lookalike.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import type {
  AccountSignal,
  ActivitySignal,
  AgeSignal,
  CodeChangeSignal,
  Erc8004Signal,
  HttpRecord,
  KeyChangeSignal,
  KeysSignal,
  RegistrySignal,
  RegistryVerdict,
  RpcRecord,
  Signals,
  Snapshot,
  ThirdPartySignal,
  ThirdPartySource,
  UsdcSignal,
  VaultSignal,
} from "./types.ts";

const NS_PER_S = 1_000_000_000n;
const NO_CODE = "11111111111111111111111111111111";

type GlobalContract = { by: "account"; account_id: string } | { by: "hash"; hash: string } | null;

type View = { ok: true; value: unknown } | { ok: false; why: string; cause: string; kind: string | null };

export function rpcRecord(snapshot: Snapshot, label: string): RpcRecord | undefined {
  return snapshot.rpc.find((r) => r.label === label);
}

function httpRecord(snapshot: Snapshot, label: string): HttpRecord | undefined {
  return snapshot.http.find((h) => h.label === label);
}

/** "rpc view_account@277300000", "rpc archival usdc.is_blocklisted@277300000" and so on. */
export function sourceOf(r: RpcRecord | undefined, fallback: string): string {
  if (!r) return fallback;
  const p = r.params;
  const at = p.block_id !== undefined ? `@${String(p.block_id)}` : "";
  const what =
    p.request_type === "call_function"
      ? `${String(p.account_id)}.${String(p.method_name)}`
      : typeof p.request_type === "string"
        ? p.request_type
        : r.method;
  return `rpc ${r.archival ? "archival " : ""}${what}${at}`;
}

/** Decode a call_function answer: bytes -> UTF-8 -> JSON. */
export function viewOf(r: RpcRecord | undefined): View {
  if (!r) return { ok: false, why: "not collected", cause: "MISSING", kind: null };
  if (r.error) {
    const why = [r.error.cause, r.error.kind, r.error.message].filter(Boolean).join(": ");
    return { ok: false, why, cause: r.error.cause, kind: r.error.kind ?? null };
  }
  const res = r.result as { result?: unknown } | null | undefined;
  if (!res || !Array.isArray(res.result)) return { ok: false, why: "answer has no result bytes", cause: "BAD_SHAPE", kind: null };
  const bytes = Uint8Array.from(res.result as number[]);
  if (bytes.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, why: "answer is not UTF-8 JSON", cause: "BAD_JSON", kind: null };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function nsToIso(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString();
}

function hoursBetween(laterNs: bigint, earlierNs: bigint): string {
  return (Number((laterNs - earlierNs) / NS_PER_S) / 3600).toFixed(1);
}

/** A block header as recorded (block calls keep only the header fields the engine reads). */
function headerOf(r: RpcRecord | undefined): { height: number; ts: bigint } | null {
  if (!r || r.error || !isRecord(r.result)) return null;
  const header = r.result.header;
  if (!isRecord(header) || typeof header.height !== "number" || typeof header.timestamp_nanosec !== "string") return null;
  return { height: header.height, ts: BigInt(header.timestamp_nanosec) };
}

// ---------------------------------------------------------------------------------------------

export function normalize(snapshot: Snapshot, policy: Policy = DEFAULT_POLICY): Signals {
  const blockTs = BigInt(snapshot.block.timestamp_ns);
  const height = snapshot.block.height;
  const kind = accountKind(snapshot.subject);

  const account = readAccount(snapshot);
  const exists = account.state === "ok" && account.exists;
  const keys = readKeys(snapshot, LABEL.keys, height, exists);

  const recent = readProbe(snapshot, LABEL.recentBlock, LABEL.recentAccount, blockTs, policy.recent_s, policy);
  const long = readProbe(snapshot, LABEL.longBlock, LABEL.longAccount, blockTs, policy.long_s, policy);
  const creation = indexerCreation(snapshot, height, blockTs);
  const age = readAge(account, recent, long, creation, blockTs, policy);
  const keyChanges = readKeyChanges(snapshot, account, keys, recent);
  const codeChange = readCodeChange(snapshot, account, recent, height, blockTs, policy);
  const activity = readActivity(snapshot, height);
  const usdc = readUsdc(snapshot);
  const { registry, allowed: registryAllowed } = readRegistry(snapshot, blockTs);
  const { vault, allowlist } = readVault(snapshot);

  const known = [...new Set([...snapshot.context.known, ...allowlist, ...registryAllowed])].sort();
  const isKnown = known.includes(snapshot.subject);
  const lookalike = isKnown ? null : findLookalike(snapshot.subject, known, policy.lookalike);

  return {
    subject: snapshot.subject,
    network: snapshot.network,
    kind,
    block: snapshot.block,
    known,
    is_known: isKnown,
    account,
    keys,
    age,
    key_changes: keyChanges,
    code_change: codeChange,
    activity,
    usdc,
    registry,
    vault,
    lookalike,
    third_party: snapshot.context.third_party.map((src) => readThirdParty(snapshot, src)),
    erc8004: readErc8004(snapshot),
  };
}

// ---------------------------------------------------------------------------------------------
// Account, keys, probes.

function readAccount(snapshot: Snapshot): AccountSignal {
  const r = rpcRecord(snapshot, LABEL.account);
  const source = sourceOf(r, "rpc view_account");
  if (!r) return { state: "unavailable", why: "view_account was not collected", source };
  if (r.error) {
    if (r.error.cause === "UNKNOWN_ACCOUNT") {
      return { state: "ok", exists: false, code_hash: null, has_contract: false, global_contract: null, balance_yocto: null, storage_usage: null, source };
    }
    return { state: "unavailable", why: `view_account failed: ${r.error.cause}`, source };
  }
  const v = r.result;
  if (!isRecord(v) || typeof v.code_hash !== "string") return { state: "unavailable", why: "view_account answer has no code_hash", source };
  let global: GlobalContract = null;
  if (typeof v.global_contract_account_id === "string") global = { by: "account", account_id: v.global_contract_account_id };
  else if (typeof v.global_contract_hash === "string") global = { by: "hash", hash: v.global_contract_hash };
  return {
    state: "ok",
    exists: true,
    code_hash: v.code_hash,
    has_contract: v.code_hash !== NO_CODE || global !== null,
    global_contract: global,
    balance_yocto: typeof v.amount === "string" ? v.amount : null,
    storage_usage: typeof v.storage_usage === "number" ? v.storage_usage : null,
    source,
  };
}

type KeyEntry = { public_key: string; nonce: number; full_access: boolean };

/**
 * All pages of a view_access_key_list under `label(page)`, or why they cannot be read. Every
 * page must be pinned to `blockId`: keys read at another block answer a different question.
 */
function readKeyPages(
  snapshot: Snapshot,
  label: (page: number) => string,
  blockId: number,
): { ok: true; keys: KeyEntry[]; source: string } | { ok: false; why: string; source: string } {
  const keys: KeyEntry[] = [];
  let source = "rpc view_access_key_list";
  for (let page = 0; ; page++) {
    const r = rpcRecord(snapshot, label(page));
    if (!r) {
      if (page === 0) return { ok: false, why: "view_access_key_list was not collected", source };
      break;
    }
    if (page === 0) source = sourceOf(r, source);
    if (r.params.block_id !== blockId) return { ok: false, why: `view_access_key_list page ${page} is not pinned to block #${blockId}`, source };
    if (r.error) return { ok: false, why: `view_access_key_list failed: ${r.error.cause}`, source };
    const res = r.result;
    if (!isRecord(res) || !Array.isArray(res.keys)) return { ok: false, why: "view_access_key_list answer has no keys", source };
    for (const k of res.keys) {
      if (!isRecord(k) || typeof k.public_key !== "string" || !isRecord(k.access_key)) {
        return { ok: false, why: "malformed access key entry", source };
      }
      const nonce = typeof k.access_key.nonce === "number" ? k.access_key.nonce : 0;
      keys.push({ public_key: k.public_key, nonce, full_access: k.access_key.permission === "FullAccess" });
    }
  }
  return { ok: true, keys, source };
}

function readKeys(snapshot: Snapshot, label: (page: number) => string, blockId: number, exists: boolean): KeysSignal {
  if (!exists) return { state: "not_applicable", why: "the account does not exist at the block" };
  const pages = readKeyPages(snapshot, label, blockId);
  if (!pages.ok) return { state: "unavailable", why: pages.why, source: pages.source };
  const full = pages.keys.filter((k) => k.full_access).length;
  return {
    state: "ok",
    total: pages.keys.length,
    full_access: full,
    function_call: pages.keys.length - full,
    // nearcore seeds a new key's nonce with (block_height - 1) * 1e6, so nonce mod 1e6 is the
    // number of transactions that key signed (an estimate: a client may skip nonces).
    signed_txs_estimate: pages.keys.reduce((sum, k) => sum + (k.nonce % 1_000_000), 0),
    source: pages.source,
  };
}

type Probe =
  | { usable: true; height: number; ts: bigint; existed: boolean; code_hash: string | null; source: string }
  | { usable: false; why: string; source: string };

/**
 * An archival probe: the account's state at a block at least `backS` before the pinned block.
 * The probe block is checked here, not trusted: it must lie between `backS` and
 * `backS + probe_tolerance_s` before the pinned block, so the line is never drawn in the payee's
 * favour even if the snapshot was collected with another policy.
 */
function readProbe(snapshot: Snapshot, blockLabel: string, accountLabel: string, blockTs: bigint, backS: number, policy: Policy): Probe {
  const br = rpcRecord(snapshot, blockLabel);
  const ar = rpcRecord(snapshot, accountLabel);
  const source = sourceOf(ar, `rpc archival view_account (${blockLabel})`);
  const header = headerOf(br);
  if (!header) return { usable: false, why: br?.error ? `probe block failed: ${br.error.cause}` : "probe block was not collected", source };
  if (br?.params.block_id !== header.height) return { usable: false, why: `probe block answer #${header.height} is not the block its request names`, source };
  const latest = blockTs - BigInt(backS) * NS_PER_S;
  const earliest = latest - BigInt(policy.probe_tolerance_s) * NS_PER_S;
  if (header.ts > latest || header.ts < earliest) {
    return { usable: false, why: `probe block #${header.height} is not within ${policy.probe_tolerance_s} s before the ${backS} s line`, source };
  }
  if (!ar) return { usable: false, why: "probe view_account was not collected", source };
  if (ar.params.block_id !== header.height) return { usable: false, why: "probe view_account is not pinned to the probe block", source };
  if (ar.error) {
    if (ar.error.cause === "UNKNOWN_ACCOUNT") return { usable: true, height: header.height, ts: header.ts, existed: false, code_hash: null, source };
    return { usable: false, why: `probe view_account failed: ${ar.error.cause}`, source };
  }
  const v = ar.result;
  if (!isRecord(v) || typeof v.code_hash !== "string") return { usable: false, why: "probe view_account answer has no code_hash", source };
  return { usable: true, height: header.height, ts: header.ts, existed: true, code_hash: v.code_hash, source };
}

type Creation = { ts: bigint; hash: string | null; source: string };

/** Creation time from the indexers, at or before the pinned block. Display and fallback only. */
function indexerCreation(snapshot: Snapshot, height: number, blockTs: bigint): Creation | null {
  const fast = fastnearTxs(snapshot, height);
  if (fast) {
    const first = fast.txs.find((t) => t.success && t.receiver) ?? fast.txs[0];
    if (first) return { ts: BigInt(first.timestamp_ns), hash: first.hash, source: "indexer fastnear" };
  }
  const nb = httpRecord(snapshot, LABEL.nearblocksAccount);
  if (nb && nb.status === 200 && isRecord(nb.json) && isRecord(nb.json.data) && isRecord(nb.json.data.created)) {
    const created = nb.json.data.created;
    if (typeof created.block_timestamp === "string" && /^\d+$/.test(created.block_timestamp)) {
      const ts = BigInt(created.block_timestamp);
      if (ts <= blockTs) {
        return { ts, hash: typeof created.transaction_hash === "string" ? created.transaction_hash : null, source: "indexer nearblocks" };
      }
    }
  }
  const nbTxs = nearblocksTxs(snapshot, height);
  if (nbTxs && nbTxs.txs[0]) {
    return { ts: BigInt(nbTxs.txs[0].timestamp_ns), hash: nbTxs.txs[0].hash, source: "indexer nearblocks" };
  }
  return null;
}

function readAge(account: AccountSignal, recent: Probe, long: Probe, creation: Creation | null, blockTs: bigint, policy: Policy): AgeSignal {
  if (account.state !== "ok") return { state: "unavailable", why: "the account itself could not be read", source: account.source };
  if (!account.exists) return { state: "not_applicable", why: "the account does not exist at the block" };
  const createdIso = creation ? `${nsToIso(creation.ts)} (${hoursBetween(blockTs, creation.ts)} h before the block, ${creation.source})` : null;
  const recentLineNs = blockTs - BigInt(policy.recent_s) * NS_PER_S;
  const longLineNs = blockTs - BigInt(policy.long_s) * NS_PER_S;

  let isLong: boolean | null = null;
  if (long.usable) isLong = long.existed;
  else if (creation) isLong = creation.ts <= longLineNs;

  if (recent.usable) {
    const at = `block #${recent.height} (${nsToIso(recent.ts)})`;
    const detail = recent.existed
      ? `existed at ${at}, ${policy.recent_s / 3600} h before the block`
      : `did not exist at ${at}, ${policy.recent_s / 3600} h before the block${createdIso ? `; created ${createdIso}` : ""}`;
    return {
      state: "ok",
      is_new: !recent.existed,
      is_long: recent.existed ? isLong : false,
      created_ts_ns: creation ? creation.ts.toString() : null,
      source: recent.source,
      detail,
    };
  }
  if (creation) {
    const isNew = creation.ts > recentLineNs;
    return {
      state: "ok",
      is_new: isNew,
      is_long: isNew ? false : isLong,
      created_ts_ns: creation.ts.toString(),
      source: creation.source,
      detail: `created ${createdIso} (archival probe unusable: ${recent.why})`,
    };
  }
  return { state: "unavailable", why: `archival probe unusable (${recent.why}) and no indexer answered`, source: recent.source };
}

function readKeyChanges(snapshot: Snapshot, account: AccountSignal, keys: KeysSignal, recent: Probe): KeyChangeSignal {
  if (account.state !== "ok" || !account.exists) return { state: "not_applicable", why: "the account does not exist at the block" };
  if (!recent.usable) return { state: "unavailable", why: `archival probe unusable: ${recent.why}`, source: recent.source };
  if (!recent.existed) return { state: "not_applicable", why: "the account is newer than the probe; new_account covers it" };
  if (keys.state !== "ok") return { state: "unavailable", why: "current keys could not be read", source: keys.state === "unavailable" ? keys.source : "rpc view_access_key_list" };
  // The earlier keys must be the ones at the probe block: keys read one block later or earlier
  // could miss a key added inside the window, which would favour the payee.
  const now = readKeyPages(snapshot, LABEL.keys, snapshot.block.height);
  const before = readKeyPages(snapshot, LABEL.recentKeys, recent.height);
  if (!now.ok) return { state: "unavailable", why: now.why, source: now.source };
  if (!before.ok) return { state: "unavailable", why: before.why, source: before.source };
  const had = new Set(before.keys.map((k) => k.public_key));
  const added = now.keys.filter((k) => k.full_access && !had.has(k.public_key)).map((k) => k.public_key).sort();
  return { state: "ok", added_full_access: added, source: before.source };
}

function readCodeChange(snapshot: Snapshot, account: AccountSignal, recent: Probe, height: number, blockTs: bigint, policy: Policy): CodeChangeSignal {
  if (account.state !== "ok" || !account.exists) return { state: "not_applicable", why: "the account does not exist at the block" };
  if (!account.has_contract) return { state: "not_applicable", why: "no contract code at the block" };
  if (recent.usable) {
    if (!recent.existed) return { state: "not_applicable", why: "the account is newer than the probe; new_account covers it" };
    const changed = recent.code_hash !== account.code_hash;
    return {
      state: "ok",
      changed,
      before: recent.code_hash,
      after: account.code_hash,
      source: recent.source,
      detail: changed
        ? `code hash ${recent.code_hash} at block #${recent.height} became ${account.code_hash} within ${policy.recent_s / 3600} h`
        : `code hash unchanged since block #${recent.height}`,
    };
  }
  // Fallback: the indexer's deployment history, bounded by the pinned block.
  const dep = httpRecord(snapshot, LABEL.nearblocksDeployments);
  if (dep && dep.status === 200 && isRecord(dep.json) && Array.isArray(dep.json.data)) {
    const line = blockTs - BigInt(policy.recent_s) * NS_PER_S;
    const recentDeploys = dep.json.data.filter((d) => {
      if (!isRecord(d) || !isRecord(d.block)) return false;
      const h = Number(d.block.block_height);
      const ts = typeof d.block.block_timestamp === "string" && /^\d+$/.test(d.block.block_timestamp) ? BigInt(d.block.block_timestamp) : null;
      return Number.isFinite(h) && h <= height && ts !== null && ts > line;
    });
    return {
      state: "ok",
      changed: recentDeploys.length > 0,
      before: null,
      after: account.code_hash,
      source: "indexer nearblocks",
      detail: recentDeploys.length > 0 ? `${recentDeploys.length} deployment(s) within ${policy.recent_s / 3600} h (indexer)` : "no deployment within the window (indexer)",
    };
  }
  return { state: "unavailable", why: `archival probe unusable: ${recent.why}`, source: recent.source };
}

// ---------------------------------------------------------------------------------------------
// Indexers.

type IndexedTx = { hash: string; height: number; timestamp_ns: string; success: boolean; receiver: boolean };

/** FastNEAR's oldest-first page, cut at the pinned block. null when it did not answer usably. */
function fastnearTxs(snapshot: Snapshot, height: number): { txs: IndexedTx[]; window: number } | null {
  const r = httpRecord(snapshot, LABEL.fastnearOldest);
  if (!r || r.status !== 200 || !isRecord(r.json) || !Array.isArray(r.json.account_txs)) return null;
  const txs: IndexedTx[] = [];
  for (const t of r.json.account_txs) {
    if (!isRecord(t) || typeof t.transaction_hash !== "string" || typeof t.tx_block_height !== "number") return null;
    if (t.tx_block_height > height) continue;
    txs.push({
      hash: t.transaction_hash,
      height: t.tx_block_height,
      timestamp_ns: String(t.tx_block_timestamp ?? "0"),
      success: t.is_success === true,
      receiver: t.is_real_receiver === true || t.is_receiver === true,
    });
  }
  const body = isRecord(r.body) ? r.body : {};
  const window = typeof body.limit === "number" ? body.limit : snapshot.context.activity_window;
  return { txs, window };
}

function nearblocksTxs(snapshot: Snapshot, height: number): { txs: IndexedTx[]; window: number } | null {
  const r = httpRecord(snapshot, LABEL.nearblocksOldest);
  if (!r || r.status !== 200 || !isRecord(r.json) || !Array.isArray(r.json.data)) return null;
  const txs: IndexedTx[] = [];
  for (const t of r.json.data) {
    if (!isRecord(t) || typeof t.transaction_hash !== "string" || !isRecord(t.block)) return null;
    const h = Number(t.block.block_height);
    if (!Number.isFinite(h) || h > height) continue;
    txs.push({
      hash: t.transaction_hash,
      height: h,
      timestamp_ns: String(t.block.block_timestamp ?? t.block_timestamp ?? "0"),
      success: isRecord(t.outcomes) ? t.outcomes.status === true : false,
      receiver: t.receiver_account_id === snapshot.subject,
    });
  }
  const m = /[?&]limit=(\d+)/.exec(r.url);
  return { txs, window: m ? Number(m[1]) : snapshot.context.activity_window };
}

function readActivity(snapshot: Snapshot, height: number): ActivitySignal {
  const pick = (found: { txs: IndexedTx[]; window: number } | null, source: string): ActivitySignal | null => {
    if (!found) return null;
    const count = Math.min(found.txs.length, found.window);
    const first = found.txs.find((t) => t.success && t.receiver) ?? found.txs[0] ?? null;
    return {
      state: "ok",
      tx_count: count,
      at_least: count >= found.window,
      first_tx: first ? { hash: first.hash, height: first.height, timestamp_ns: first.timestamp_ns } : null,
      source,
    };
  };
  return (
    pick(fastnearTxs(snapshot, height), "indexer fastnear") ??
    pick(nearblocksTxs(snapshot, height), "indexer nearblocks") ?? {
      state: "unavailable",
      why: "neither FastNEAR nor NearBlocks answered",
      source: "indexer fastnear, indexer nearblocks",
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Contract views.

function readUsdc(snapshot: Snapshot): UsdcSignal {
  const r = rpcRecord(snapshot, LABEL.usdcBlocklisted);
  const source = sourceOf(r, "rpc usdc.is_blocklisted");
  const v = viewOf(r);
  if (!v.ok) return { state: "unavailable", why: v.why, source };
  if (typeof v.value !== "boolean") return { state: "unavailable", why: "is_blocklisted did not answer a boolean", source };
  const storageRecord = rpcRecord(snapshot, LABEL.usdcStorage);
  const s = viewOf(storageRecord);
  const registered = s.ok ? s.value != null : null;
  return { state: "ok", blocklisted: v.value, registered, source: storageRecord ? `${source} + storage_balance_of` : source };
}

const VERDICTS = new Set(["ALLOW", "WARN", "DENY"]);

/** The registry's get_verdict answer, read the way the vault reads it: anything odd fails closed. */
function parseVerdict(v: unknown): RegistryVerdict | null | "bad" {
  if (v === null || v === undefined) return null;
  if (!isRecord(v) || typeof v.verdict !== "string" || !VERDICTS.has(v.verdict)) return "bad";
  return {
    verdict: v.verdict as RegistryVerdict["verdict"],
    reasons: Array.isArray(v.reasons) ? v.reasons.filter((x): x is string => typeof x === "string") : [],
    evidence: typeof v.evidence === "string" ? v.evidence : null,
    score: typeof v.score === "number" ? v.score : null,
    code_hash: typeof v.code_hash === "string" ? v.code_hash : null,
    updated_at_ns: typeof v.updated_at_ns === "string" ? v.updated_at_ns : "0",
    updated_by: typeof v.updated_by === "string" ? v.updated_by : "",
    expires_at_ns: typeof v.expires_at_ns === "string" ? v.expires_at_ns : null,
  };
}

function readRegistry(snapshot: Snapshot, blockTs: bigint): { registry: RegistrySignal; allowed: string[] } {
  const id = snapshot.context.registry_id;
  if (id === null) return { registry: { state: "not_configured" }, allowed: [] };
  const r = rpcRecord(snapshot, LABEL.registryVerdict);
  const source = sourceOf(r, `rpc ${id}.get_verdict`);
  const v = viewOf(r);
  if (!v.ok) {
    if (v.cause === "UNKNOWN_ACCOUNT" || v.cause === "NO_CONTRACT_CODE") return { registry: { state: "not_deployed", id, source }, allowed: [] };
    return { registry: { state: "unavailable", id, why: `get_verdict: ${v.why}`, source }, allowed: [] };
  }
  const verdict = parseVerdict(v.value);
  if (verdict === "bad") return { registry: { state: "unavailable", id, why: "get_verdict answered an unknown shape", source }, allowed: [] };

  const reports = viewOf(rpcRecord(snapshot, LABEL.registryReports));
  if (!reports.ok || !Array.isArray(reports.value)) {
    return { registry: { state: "unavailable", id, why: `get_reports: ${reports.ok ? "not a list" : reports.why}`, source }, allowed: [] };
  }
  const reporters = new Set<string>();
  let newest: bigint | null = null;
  for (const rep of reports.value) {
    if (!isRecord(rep)) continue;
    if (typeof rep.reporter === "string") reporters.add(rep.reporter);
    if (typeof rep.at_ns === "string" && /^\d+$/.test(rep.at_ns)) {
      const at = BigInt(rep.at_ns);
      if (newest === null || at > newest) newest = at;
    }
  }
  const count = viewOf(rpcRecord(snapshot, LABEL.registryReportCount));
  const list = viewOf(rpcRecord(snapshot, LABEL.registryList));
  if (!list.ok || !Array.isArray(list.value)) {
    return { registry: { state: "unavailable", id, why: `list_verdicts: ${list.ok ? "not a list" : list.why}`, source }, allowed: [] };
  }
  const allowed = list.value
    .filter((e): e is Record<string, unknown> => isRecord(e) && e.verdict === "ALLOW" && typeof e.account_id === "string")
    .filter((e) => typeof e.expires_at_ns !== "string" || BigInt(e.expires_at_ns) >= blockTs)
    .map((e) => e.account_id as string);
  return {
    registry: {
      state: "ok",
      id,
      verdict,
      open_reports: reports.value.length,
      open_reporters: [...reporters].sort(),
      newest_open_report_ns: newest === null ? null : newest.toString(),
      lifetime_reports: count.ok ? asCount(count.value) : null,
      source,
    },
    allowed,
  };
}

function readVault(snapshot: Snapshot): { vault: VaultSignal; allowlist: string[] } {
  const id = snapshot.context.vault_id;
  if (id === null) return { vault: { state: "not_configured" }, allowlist: [] };
  const paidRecord = rpcRecord(snapshot, LABEL.vaultPaid);
  const source = sourceOf(paidRecord, `rpc ${id}.paid_count`);
  const paid = viewOf(paidRecord);
  const refusals = viewOf(rpcRecord(snapshot, LABEL.vaultRefusals));
  const guard = viewOf(rpcRecord(snapshot, LABEL.vaultGuardRefusals));
  const allowed = viewOf(rpcRecord(snapshot, LABEL.vaultAllowed));
  const list = viewOf(rpcRecord(snapshot, LABEL.vaultAllowlist));
  const fail = (why: string) => ({ vault: { state: "unavailable" as const, id, why, source }, allowlist: [] });
  if (!paid.ok || asCount(paid.value) === null) return fail(`paid_count: ${paid.ok ? "not a count" : paid.why}`);
  if (!refusals.ok || asCount(refusals.value) === null) return fail(`refusal_count: ${refusals.ok ? "not a count" : refusals.why}`);
  if (!allowed.ok || typeof allowed.value !== "boolean") return fail(`is_allowed: ${allowed.ok ? "not a boolean" : allowed.why}`);
  if (!list.ok || !Array.isArray(list.value)) return fail(`list_allowlist: ${list.ok ? "not a list" : list.why}`);
  // guard_refusal_count arrived with vault v1.1; an older vault answers MethodNotFound.
  let guardCount: number | null = null;
  if (guard.ok) guardCount = asCount(guard.value);
  else if (guard.kind !== "MethodNotFound" && guard.cause !== "MISSING") return fail(`guard_refusal_count: ${guard.why}`);
  return {
    vault: {
      state: "ok",
      id,
      paid_count: asCount(paid.value)!,
      refusal_count: asCount(refusals.value)!,
      guard_refusal_count: guardCount,
      allowlisted: allowed.value,
      source,
    },
    allowlist: list.value.filter((x): x is string => typeof x === "string"),
  };
}

// ---------------------------------------------------------------------------------------------
// Other teams' registries (attributed, never decisive on their own) and ERC-8004.

const DEMO_MARK = /\b(demo|test|synthetic|fixture|seeded)\b/i;

export function parseThirdParty(source: ThirdPartySource, v: unknown): Omit<Extract<ThirdPartySignal, { state: "ok" }>, "state" | "source"> | null {
  if (!isRecord(v)) return null;
  switch (source.id) {
    case "mimicwatch": {
      if (typeof v.flagged !== "boolean") return null;
      const e = isRecord(v.entry) ? v.entry : null;
      const text = e ? [e.note, e.evidence_url].filter((x) => typeof x === "string").join(" ") : "";
      return {
        flagged: v.flagged,
        level: e && typeof e.severity === "string" ? e.severity : null,
        detail: v.flagged
          ? `flagged (${String(v.via ?? "exact")}): ${e ? `${String(e.category)} imitating ${String(e.brand ?? "?")}, severity ${String(e.severity)}` : "no entry"}`
          : "not flagged",
        evidence_url: e && typeof e.evidence_url === "string" ? e.evidence_url : null,
        demo: DEMO_MARK.test(text),
      };
    }
    case "tripwire": {
      if (typeof v.level !== "string") return null;
      const flags = Array.isArray(v.flags) ? v.flags.filter(isRecord) : [];
      const first = flags[0];
      return {
        flagged: v.level !== "none",
        level: v.level,
        detail: v.level === "none" ? "level none" : `level ${v.level}, score ${String(v.score)}${first ? `, ${String(first.category)}` : ""}`,
        evidence_url: first && typeof first.evidence_url === "string" ? first.evidence_url : null,
        demo: flags.some((f) => typeof f.reason === "string" && DEMO_MARK.test(f.reason)),
      };
    }
    case "near_leash": {
      if (typeof v.verdict !== "string") return null;
      const reasons = Array.isArray(v.reasons) ? v.reasons.filter((x): x is string => typeof x === "string") : [];
      return {
        flagged: v.verdict !== "clear",
        level: v.verdict,
        detail: v.verdict === "clear" ? "clear" : `verdict ${v.verdict} from ${String(v.distinct_reporters)} reporter(s)${reasons[0] ? `: ${reasons[0]}` : ""}`,
        evidence_url: null,
        demo: reasons.some((r) => DEMO_MARK.test(r)),
      };
    }
    case "leash_commons": {
      if (typeof v.blocked !== "boolean") return null;
      return {
        flagged: v.blocked,
        level: v.blocked ? "blocked" : null,
        detail: v.blocked
          ? `blocked by ${String(v.blocked_by)} (${String(v.reports)} of ${String(v.threshold)} reports)`
          : `not blocked (${String(v.reports ?? 0)} report(s), threshold ${String(v.threshold)})`,
        evidence_url: null,
        demo: typeof v.owner_reason === "string" && DEMO_MARK.test(v.owner_reason),
      };
    }
    default:
      return null;
  }
}

function readThirdParty(snapshot: Snapshot, source: ThirdPartySource): ThirdPartySignal {
  const v = viewOf(rpcRecord(snapshot, LABEL.thirdParty(source.id)));
  if (!v.ok) return { state: "unavailable", source, why: v.why };
  const parsed = parseThirdParty(source, v.value);
  if (!parsed) return { state: "unavailable", source, why: "answer has an unexpected shape" };
  return { state: "ok", source, ...parsed };
}

function readErc8004(snapshot: Snapshot): Erc8004Signal {
  const ctx = snapshot.context.erc8004;
  if (!ctx) return { state: "not_configured" };
  const tokensRecord = rpcRecord(snapshot, LABEL.erc8004Tokens);
  const source = sourceOf(tokensRecord, `rpc ${ctx.identity}.nft_tokens_for_owner`);
  const tokens = viewOf(tokensRecord);
  if (!tokens.ok || !Array.isArray(tokens.value)) return { state: "unavailable", why: tokens.ok ? "not a list" : tokens.why, source };
  const agentIds = tokens.value
    .filter(isRecord)
    .map((t) => t.token_id)
    .filter((x): x is string => typeof x === "string");
  let feedback = 0;
  let mean: number | null = null;
  const summaryRecord = rpcRecord(snapshot, LABEL.erc8004Summary);
  if (summaryRecord) {
    const s = viewOf(summaryRecord);
    if (!s.ok || !isRecord(s.value)) return { state: "unavailable", why: s.ok ? "summary has an unexpected shape" : s.why, source };
    const count = Number(s.value.count);
    const value = Number(s.value.summary_value);
    const decimals = typeof s.value.summary_value_decimals === "number" ? s.value.summary_value_decimals : 0;
    if (Number.isFinite(count) && count > 0 && Number.isFinite(value)) {
      feedback = count;
      mean = value / 10 ** decimals;
    }
  }
  return { state: "ok", identity: ctx.identity, agent_ids: agentIds, feedback_count: feedback, mean, source };
}

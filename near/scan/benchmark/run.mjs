#!/usr/bin/env node
// Benchmark: the A-Identity NEAR verdict engine on the cited mainnet dataset (scan/dataset.json).
//
// What it runs. Every known_good row, every suspicious row and a deterministic stratified sample
// of 100 lookalike_candidate rows (sampleLookalikes below), on NEAR mainnet, read-only. All
// accounts are pinned to ONE block, chosen once (the latest final block when the first snapshot
// was taken) and reused when a run resumes, so the benchmark is one statement about the chain at
// that block.
//
// What the engine is given, and nothing else: the account id, the network, the block and the
// fixed brand list in known-brands.json (its rule is written in that file). This script reads
// dataset.json only to choose which accounts to run and to name the sample strata. No label, seed
// file, cited source, MimicWatch data or registry built from them reaches the engine:
//   - third-party registries are off: MimicWatch's 2026-11-01 scan is the source of the three
//     researcher_dataset suspicious rows, and the other teams' registries list testnet demo data;
//   - no A-Identity registry and no vault are read;
//   - the known list is NOT built from the known_good rows: it is the fixed top-25 token list,
//     which overlaps them (verdicts.leave-self-out.json measures what the overlap hides).
// Every saved snapshot is checked for exactly that context before its verdict is used.
//
// Output. snapshots/<account>.json (the engine's own snapshot format, replayable with
// `npm run verdict -- --offline <file>`); verdicts.json in scan/score.mjs's format, declaring
// labels_used: false; and two replays of the same snapshots in the same format, with no network:
//   - verdicts.leave-self-out.json: each payee compared with the brand list minus its own name.
//     The engine never compares a payee on its known list as a lookalike (it gets the known_payee
//     info reason instead), and part of the list are known_good rows, so this shows what that
//     exemption hides. Every account is treated the same way and no label is read; only accounts
//     whose own name is on the list can change.
//   - verdicts.no-known.json: an empty known list (an ablation of lookalike matching).
// All three verdict files are always derived from the saved snapshots, so --offline rebuilds them
// byte for byte with no network.
//
// Pacing. One shared JSON-RPC reader and one shared indexer client serve every account, behind a
// per-host pacer: a minimum gap between two requests to the same host, a growing cool-down after
// a 429 or a 5xx, and, while a JSON-RPC host cools down, its requests go straight to the next host
// in the SDK's failover list. A snapshot with a read that no endpoint answered, or with a
// missing-data warning, is collected again later (--max-attempts). A saved snapshot is never
// fetched again unless --retry-degraded asks for the ones with missing data.
//
// From near/ (Node >= 22.22.2):
//   node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/run.mjs
//       online: collect the missing snapshots, then write the verdict files (re-run to resume)
//   node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/run.mjs --offline
//       no network: rebuild the three verdict files from snapshots/
//   node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/run.mjs --offline --check
//       no network: exit 1 unless the committed verdict files re-derive exactly
//   node scan/benchmark/run.mjs --list
//       the selection and the sample strata (no network, no SDK)
//
// Online options: --at-block N (default: the block of the saved snapshots, else the latest final
// block), --concurrency N (accounts in flight, default 3), --budget-minutes M (start no new
// account after M minutes; re-run to resume), --max-attempts N (per account and run, default 4),
// --retry-degraded, --only id1,id2 (a subset, to try the runner). FASTNEAR_API_KEY and
// NEARBLOCKS_API_KEY are sent to their own hosts when set and are never recorded.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PATHS = Object.freeze({
  dataset: path.join(HERE, "..", "dataset.json"),
  known: path.join(HERE, "known-brands.json"),
  snapshots: path.join(HERE, "snapshots"),
  verdicts: path.join(HERE, "verdicts.json"),
  leaveSelfOut: path.join(HERE, "verdicts.leave-self-out.json"),
  ablation: path.join(HERE, "verdicts.no-known.json"),
  sdk: path.join(HERE, "..", "..", "sdk", "src"),
});

/** The lookalike sample: its seed, its size, and the "created recently" line of its take-all stratum. */
export const SAMPLE = Object.freeze({ seed: "a-identity-near-benchmark/1", size: 100, recent_s: 30 * 86400 });

// Minimum gap between two requests to one host. Keyless limits are not published for FastNEAR;
// these are below the rates scan/build-dataset.mjs ran at (about 2 a second per FastNEAR RPC
// host, 6 on dRPC, 1.4 on the FastNEAR indexer). NearBlocks documents 6 calls a minute keyless.
export const HOSTS = Object.freeze({
  "rpc.mainnet.fastnear.com": { gapMs: 500, kind: "rpc" },
  "near.drpc.org": { gapMs: 170, kind: "rpc" },
  "free.rpc.fastnear.com": { gapMs: 500, kind: "rpc" },
  "archival-rpc.mainnet.fastnear.com": { gapMs: 500, kind: "rpc" },
  "archival-rpc.mainnet.near.org": { gapMs: 3500, kind: "rpc" },
  "tx.main.fastnear.com": { gapMs: 750, kind: "indexer" },
  "api.nearblocks.io": { gapMs: 10500, kind: "indexer" },
});
const OTHER_HOST = { gapMs: 1000, kind: "indexer" };
/** Wait before the next attempt at an account whose snapshot had missing data, by attempt. */
const RETRY_DELAYS_MS = [20_000, 90_000, 240_000, 480_000];
/** Reason codes that mean "a source could not be read", never a fact about the payee. */
export const MISSING_DATA_CODES = Object.freeze(["rpc_unavailable", "indexer_unavailable", "blocklist_unreadable", "registry_unreadable", "vault_unreadable", "erc8004_unreadable", "third_party_unreadable"]);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Selection (pure; reads the dataset, never the chain).

export function sampleKey(seed, accountId) {
  return createHash("sha256").update(`${seed}|${accountId}`).digest("hex");
}

/** Created at most `seconds` before the row's own check (both from the dataset row). */
export function createdWithin(row, seconds) {
  const created = Date.parse(row.facts?.created_at ?? "");
  const checked = Date.parse(row.checked_at ?? "");
  return Number.isFinite(created) && Number.isFinite(checked) && created <= checked && checked - created <= seconds * 1000;
}

/**
 * The sample stratum of a lookalike_candidate row. Two take-all strata ("all:"): names the imitated
 * brand registered itself (scan/score.mjs flags a DENY on them as over-blocking) and names created
 * in the 30 days before the dataset checked them (the README's nine recent names). Every other row
 * falls in a proportional stratum ("prop:") by predates_brand (the split score.mjs reports) and by
 * the generator rule that produced the name.
 */
export function stratumOf(row, recentS = SAMPLE.recent_s) {
  if (row.facts?.created_by_brand === true) return "all:created_by_brand";
  if (createdWithin(row, recentS)) return "all:created_last_30d";
  const age = row.facts?.predates_brand === true ? "predates_brand" : row.facts?.predates_brand === false ? "after_brand" : "age_unknown";
  return `prop:${age}:${row.facts?.rule ?? row.category ?? "rule_unknown"}`;
}

/**
 * Deterministic stratified sample. Take-all strata are taken whole; the remaining draws are
 * shared among the proportional strata by largest remainder (exact integer arithmetic, ties to
 * the stratum name in sorted order); inside a stratum, rows are ordered by
 * sha256("<seed>|<account_id>") in hex and the first ones are taken. No PRNG, so any language
 * can reproduce it.
 */
export function sampleLookalikes(rows, { seed, size, recent_s } = SAMPLE) {
  const strata = new Map();
  for (const row of rows) {
    const k = stratumOf(row, recent_s);
    if (!strata.has(k)) strata.set(k, []);
    strata.get(k).push(row);
  }
  const keys = [...strata.keys()].sort(cmp);
  const prop = keys.filter((k) => k.startsWith("prop:"));
  const fixed = keys.filter((k) => k.startsWith("all:")).reduce((n, k) => n + strata.get(k).length, 0);
  const draws = size - fixed;
  const pool = prop.reduce((n, k) => n + strata.get(k).length, 0);
  if (draws < 0 || draws > pool) throw new Error(`cannot draw ${size} rows: ${fixed} are taken whole and ${pool} remain`);
  const quota = new Map();
  const remainders = [];
  for (const k of prop) {
    const num = strata.get(k).length * draws;
    const q = pool === 0 ? 0 : Math.floor(num / pool);
    quota.set(k, q);
    remainders.push({ k, r: num - q * pool });
  }
  let left = draws - [...quota.values()].reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.r - a.r || cmp(a.k, b.k));
  for (const { k } of remainders) {
    if (left <= 0) break;
    quota.set(k, quota.get(k) + 1);
    left--;
  }
  const picked = [];
  const summary = {};
  for (const k of keys) {
    const members = strata.get(k).map((row) => ({ id: row.account_id, key: sampleKey(seed, row.account_id) }));
    members.sort((a, b) => cmp(a.key, b.key) || cmp(a.id, b.id));
    const take = k.startsWith("all:") ? members.length : quota.get(k);
    for (const m of members.slice(0, take)) picked.push({ account_id: m.id, stratum: k });
    summary[k] = { rows: members.length, sampled: take };
  }
  return { picked, strata: summary };
}

/** Which accounts the benchmark runs, in run order (suspicious, known_good, lookalike sample). */
export function selectAccounts(dataset, sample = SAMPLE) {
  const rows = (label) => dataset.filter((r) => r.label === label);
  const suspicious = rows("suspicious");
  const knownGood = rows("known_good");
  const lookalikes = rows("lookalike_candidate");
  const s = sampleLookalikes(lookalikes, sample);
  const accounts = [
    ...suspicious.map((r) => ({ account_id: r.account_id, label: "suspicious", stratum: null })),
    ...knownGood.map((r) => ({ account_id: r.account_id, label: "known_good", stratum: null })),
    ...s.picked.map((p) => ({ account_id: p.account_id, label: "lookalike_candidate", stratum: p.stratum })),
  ];
  const seen = new Set();
  for (const a of accounts) {
    if (seen.has(a.account_id)) throw new Error(`account selected twice: ${a.account_id}`);
    seen.add(a.account_id);
  }
  return {
    accounts,
    counts: {
      known_good: knownGood.length,
      suspicious: suspicious.length,
      lookalike_candidate: { rows: lookalikes.length, sampled: s.picked.length, seed: sample.seed, recent_s: sample.recent_s, strata: s.strata },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The fixed known list, and the context every snapshot must have been collected with.

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** known-brands.json's accounts, deduplicated and sorted exactly as collectSnapshot records them. */
export function loadKnown(file = PATHS.known) {
  const j = readJson(file);
  if (!Array.isArray(j.accounts) || j.accounts.length === 0 || !j.accounts.every((a) => typeof a === "string")) {
    throw new Error(`${file}: accounts must be a non-empty list of account ids`);
  }
  return [...new Set(j.accounts)].sort();
}

/** Why a saved snapshot cannot stand for this benchmark (empty when it can). Pure. */
export function contextProblems(snapshot, { accountId, known, block }) {
  const p = [];
  if (snapshot.subject !== accountId) p.push(`subject is ${snapshot.subject}, not ${accountId}`);
  if (snapshot.network !== "mainnet") p.push(`network is ${snapshot.network}`);
  if (block !== undefined && snapshot.block?.height !== block) p.push(`pinned to block ${snapshot.block?.height}, the run is pinned to ${block}`);
  const c = snapshot.context ?? {};
  if (JSON.stringify(c.known) !== JSON.stringify(known)) p.push("context.known is not the list in known-brands.json");
  if (!Array.isArray(c.third_party) || c.third_party.length !== 0) p.push("third-party registries were configured");
  if (c.vault_id !== null) p.push("a vault was configured");
  if (c.registry_id !== null) p.push("an A-Identity registry was configured");
  for (const r of snapshot.rpc ?? []) {
    if (r.network !== "mainnet") p.push(`${r.label} was read on ${r.network}`);
    if (/^(third_party|registry|vault)\./.test(r.label)) p.push(`${r.label} was read`);
  }
  return p;
}

/** Records no endpoint answered (JSON-RPC) or that failed in transit (indexers). Pure. */
export function transportErrors(snapshot) {
  const out = [];
  for (const r of snapshot.rpc) if (r.error && r.error.cause === "UNAVAILABLE") out.push(r.label);
  for (const h of snapshot.http) if (typeof h.error === "string") out.push(h.label);
  return out.sort(cmp);
}

/** Why a snapshot should be collected again: unanswered JSON-RPC reads or missing-data reasons. */
export function degradedBy(snapshot, decision) {
  const out = new Set();
  for (const r of snapshot.rpc) if (r.error && r.error.cause === "UNAVAILABLE") out.add(`unanswered:${r.label}`);
  for (const r of decision.reasons) if (MISSING_DATA_CODES.includes(r.code)) out.add(r.code);
  return [...out].sort(cmp);
}

/** JSON text with every non-ASCII character escaped; JSON.parse returns the same value. */
export function asciiJson(text) {
  return text.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function snapshotFile(accountId) {
  return path.join(PATHS.snapshots, `${accountId}.json`);
}

function blockUtc(timestampNs) {
  return new Date(Number(BigInt(timestampNs) / 1_000_000n)).toISOString();
}

// ---------------------------------------------------------------------------------------------
// The SDK (TypeScript sources, loaded only when needed so --list and the tests' pure imports
// need no type stripping).

export async function loadSdk() {
  const at = (rel) => pathToFileURL(path.join(PATHS.sdk, rel)).href;
  const [engine, snapshot, rpc, http, networks, version] = await Promise.all([
    import(at("engine/index.ts")),
    import(at("collect/snapshot.ts")),
    import(at("collect/rpc.ts")),
    import(at("collect/http.ts")),
    import(at("collect/networks.ts")),
    import(at("version.ts")),
  ]);
  return { engine, collectSnapshot: snapshot.collectSnapshot, rpc, http, networks: networks.NETWORKS, SDK_VERSION: version.SDK_VERSION };
}

// ---------------------------------------------------------------------------------------------
// Verdict files, derived from the saved snapshots only.

const SIGNALS = [
  "account_state",
  "access_keys",
  "age_archival_probes",
  "key_and_code_changes",
  "activity_fastnear",
  "nearblocks_fallback",
  "usdc_blocklist",
  "erc8004",
  "lookalike_fixed_brands",
];
const SIGNALS_OFF = {
  third_party_registries:
    "off (--no-third-party): MimicWatch's 2026-11-01 scan is the source of the three researcher_dataset suspicious rows, so its registry would leak labels; Tripwire, near-leash and Leash commons list testnet demo accounts",
  a_identity_registry: "off (--registry none): no A-Identity registry is deployed on mainnet, and none holding verdicts written from this dataset may be read",
  vault: "off (no --vault): no prior payments, refusals or owner allowlist",
  known_from_labels: "off: the known list is known-brands.json (top 25 NEP-141 tokens by on-chain market cap on NearBlocks), not the known_good rows",
};

function decidingCodes(decision) {
  return [...new Set(decision.reasons.filter((r) => (r.severity === "deny" || r.severity === "warn") && !r.cleared_by).map((r) => r.code))];
}

/**
 * Re-derive the three verdict files from snapshots/. Returns their exact text, or the reasons it
 * cannot (a missing snapshot, one that fails assertSnapshot, or one collected with another
 * context).
 */
export function deriveVerdictFiles(sdk) {
  const dataset = readJson(PATHS.dataset);
  const selection = selectAccounts(dataset);
  const known = loadKnown();
  const knownDoc = readJson(PATHS.known);
  const facts = new Map(dataset.map((r) => [r.account_id, r.facts ?? {}]));
  const entries = [];
  const leaveSelfOut = [];
  const ablation = [];
  const problems = [];
  const missing = [];
  const blocks = new Map();
  const endpoints = new Set();
  const collected = [];
  const degraded = [];
  for (const a of [...selection.accounts].sort((x, y) => cmp(x.account_id, y.account_id))) {
    const file = snapshotFile(a.account_id);
    if (!fs.existsSync(file)) {
      missing.push(a.account_id);
      continue;
    }
    let snapshot;
    try {
      snapshot = sdk.engine.assertSnapshot(readJson(file));
    } catch (e) {
      problems.push(`${a.account_id}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const cp = contextProblems(snapshot, { accountId: a.account_id, known });
    if (cp.length) {
      problems.push(`${a.account_id}: ${cp.join("; ")}`);
      continue;
    }
    const replay = sdk.engine.verdictFromSnapshot(snapshot);
    const d = replay.decision;
    const deg = degradedBy(snapshot, d);
    if (deg.length) degraded.push(a.account_id);
    blocks.set(d.block.height, d.block);
    for (const e of snapshot.meta?.endpoints ?? []) endpoints.add(e);
    if (snapshot.meta?.collected_at) collected.push(snapshot.meta.collected_at);
    entries.push({
      account_id: d.subject,
      verdict: d.verdict,
      score: d.score,
      warn_kind: d.warn_kind,
      deciding: decidingCodes(d),
      reasons: d.reasons,
      block: d.block,
      dataset_block_height: facts.get(a.account_id)?.block_height ?? null,
      snapshot: `snapshots/${a.account_id}.json`,
      snapshot_sha256: replay.snapshot_sha256,
      chain_sha256: replay.chain_sha256,
      engine_version: d.engine_version,
      policy_id: d.policy_id,
      collected_at: snapshot.meta?.collected_at ?? null,
      endpoints: snapshot.meta?.endpoints ?? [],
      transport_errors: transportErrors(snapshot),
      missing_data: deg,
    });
    // Leave-self-out: the same list minus the payee's own name, for every account alike (no label).
    const self = sdk.engine.verdictFromSnapshot({ ...snapshot, context: { ...snapshot.context, known: known.filter((k) => k !== a.account_id) } });
    const sd = self.decision;
    const lk = self.signals.lookalike;
    leaveSelfOut.push({
      account_id: sd.subject,
      own_name_on_list: known.includes(a.account_id),
      verdict: sd.verdict,
      score: sd.score,
      warn_kind: sd.warn_kind,
      deciding: decidingCodes(sd),
      lookalike: lk ? { known: lk.known, kind: lk.kind, strong: lk.strong } : null,
      chain_sha256: replay.chain_sha256,
    });
    const without = sdk.engine.verdictFromSnapshot({ ...snapshot, context: { ...snapshot.context, known: [] } }).decision;
    ablation.push({ account_id: without.subject, verdict: without.verdict, score: without.score, warn_kind: without.warn_kind, deciding: decidingCodes(without), chain_sha256: replay.chain_sha256 });
  }
  if (missing.length || problems.length) return { ok: false, missing, problems, total: selection.accounts.length };

  const engine = `${sdk.engine.ENGINE_VERSION} (policy ${sdk.engine.DEFAULT_POLICY.id}; collector ${sdk.SDK_VERSION})`;
  const sortedBlocks = [...blocks.values()].sort((x, y) => x.height - y.height);
  const blockInfo =
    sortedBlocks.length === 1
      ? { block: { ...sortedBlocks[0], utc: blockUtc(sortedBlocks[0].timestamp_ns) } }
      : { blocks: sortedBlocks.map((b) => ({ ...b, utc: blockUtc(b.timestamp_ns) })) };
  collected.sort(cmp);
  const run = {
    network: "mainnet",
    ...blockInfo,
    collected_first: collected[0] ?? null,
    collected_last: collected[collected.length - 1] ?? null,
    accounts: entries.length,
    selection: selection.counts,
    endpoints: [...endpoints].sort(cmp),
    degraded: degraded.sort(cmp),
    generated_by: "scan/benchmark/run.mjs (verdicts derived from snapshots/; --offline rebuilds this file)",
  };
  const knownInfo = { file: "known-brands.json", rule: knownDoc.rule, source: knownDoc.source, fetched_at: knownDoc.fetched_at, count: known.length, accounts: known };
  const verdicts = {
    engine,
    signals: SIGNALS,
    signals_off: SIGNALS_OFF,
    labels_used: false,
    known: knownInfo,
    run,
    verdicts: entries,
  };
  const minusSelf = {
    engine,
    signals: SIGNALS.map((s) => (s === "lookalike_fixed_brands" ? "lookalike_fixed_brands_minus_self" : s)),
    signals_off: {
      ...SIGNALS_OFF,
      known_payee_exemption:
        "off: a replay of verdicts.json in which every payee is compared with known-brands.json minus its own name (no network; the chain data is identical, so chain_sha256 is shared). The engine never compares a payee on its known list as a lookalike, and gives it the known_payee info reason instead; this replay shows what that exemption hides. It treats every account the same way and reads no label, so only accounts whose own name is on the list can change.",
    },
    labels_used: false,
    derived_from: "verdicts.json",
    run: { network: "mainnet", ...blockInfo, accounts: leaveSelfOut.length, own_name_on_list: leaveSelfOut.filter((e) => e.own_name_on_list).length },
    verdicts: leaveSelfOut,
  };
  const noKnown = {
    engine,
    signals: SIGNALS.filter((s) => s !== "lookalike_fixed_brands"),
    signals_off: { ...SIGNALS_OFF, lookalike: "off: an ablation of verdicts.json, replaying the same snapshots with context.known = [] (no network; the chain data is identical, so chain_sha256 is shared)" },
    labels_used: false,
    derived_from: "verdicts.json",
    run: { network: "mainnet", ...blockInfo, accounts: ablation.length },
    verdicts: ablation,
  };
  return {
    ok: true,
    verdictsText: `${JSON.stringify(verdicts, null, 2)}\n`,
    leaveSelfOutText: `${JSON.stringify(minusSelf, null, 2)}\n`,
    ablationText: `${JSON.stringify(noKnown, null, 2)}\n`,
    entries,
    leaveSelfOut,
    ablation,
    degraded: run.degraded,
  };
}

/** The verdict files deriveVerdictFiles produces, as [path, text] pairs in a fixed order. */
function derivedFiles(r) {
  return [
    [PATHS.verdicts, r.verdictsText],
    [PATHS.leaveSelfOut, r.leaveSelfOutText],
    [PATHS.ablation, r.ablationText],
  ];
}

// ---------------------------------------------------------------------------------------------
// Pacing and the shared clients.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
};

/**
 * A FetchLike (the SDK's fetch interface) that paces per host. JSON-RPC hosts: one attempt; a
 * 429 or 5xx starts a cool-down, and while it lasts the host is skipped (a local -429 answer the
 * SDK treats as rate limited, so it moves on to its next endpoint without a request). Indexer
 * hosts have no failover of their own, so a 429, 5xx or transport error waits out the cool-down
 * and tries again, up to 8 times. It ignores the SDK's abort signal and uses its own 30 s timeout,
 * because a request may wait in the queue longer than the SDK's per-request timeout.
 */
export function createPacer({ hosts = HOSTS, fetchImpl = globalThis.fetch, now = () => Date.now(), wait = sleep } = {}) {
  const state = new Map();
  const get = (host) => {
    let h = state.get(host);
    if (!h) {
      h = { cfg: hosts[host] ?? OTHER_HOST, next: 0, coolUntil: 0, strikes: 0, stats: { sent: 0, ok: 0, rate_limited: 0, server_error: 0, transport_error: 0, skipped: 0 } };
      state.set(host, h);
    }
    return h;
  };
  const cool = (h) => {
    h.strikes++;
    h.coolUntil = now() + Math.min(120_000, 4_000 * 2 ** (h.strikes - 1));
  };
  const answer = (status, text) => ({ status, text: async () => text });
  async function send(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetchImpl(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), signal: controller.signal });
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }
  async function pacedFetch(url, init) {
    const host = hostOf(url);
    const h = get(host);
    const tries = h.cfg.kind === "indexer" ? 8 : 1;
    let last = null;
    for (let i = 0; i < tries; i++) {
      if (h.cfg.kind === "rpc" && h.coolUntil - now() > 1_500) {
        h.stats.skipped++;
        return answer(429, JSON.stringify({ jsonrpc: "2.0", id: "pacer", error: { code: -429, message: "skipped by the benchmark pacer: host cooling down after a 429 or 5xx" } }));
      }
      const t = now();
      const slot = Math.max(t, h.next, h.coolUntil);
      h.next = slot + h.cfg.gapMs;
      if (slot > t) await wait(slot - t);
      h.stats.sent++;
      let res;
      try {
        res = await send(url, init);
      } catch (e) {
        h.stats.transport_error++;
        cool(h);
        last = e;
        if (h.cfg.kind === "rpc") throw e;
        continue;
      }
      const limited = res.status === 429 || /"code"\s*:\s*-429\b/.test(res.text.slice(0, 400));
      if (limited || res.status >= 500 || res.status === 408) {
        if (limited) h.stats.rate_limited++;
        else h.stats.server_error++;
        cool(h);
        last = res;
        if (h.cfg.kind === "rpc") return answer(res.status, res.text);
        continue;
      }
      h.strikes = 0;
      h.stats.ok++;
      return answer(res.status, res.text);
    }
    if (last instanceof Error) throw last;
    return answer(last.status, last.text);
  }
  return {
    fetch: pacedFetch,
    stats: () => Object.fromEntries([...state.entries()].sort((a, b) => cmp(a[0], b[0])).map(([host, h]) => [host, { ...h.stats }])),
  };
}

/**
 * One reader and one indexer client for the whole run, so pacing holds across accounts. Reads of
 * a block by height are memoized: a final block never changes, and with one pinned block every
 * account's probe search reads the same blocks. A decided answer (a skipped height) is kept too;
 * a read no endpoint answered is not.
 */
export function createSharedClients(sdk, pacer, env = process.env) {
  const headersFor = sdk.rpc.headersFromEnv(env);
  const base = sdk.rpc.createReader({
    rpc: sdk.networks.mainnet.rpc,
    archival: sdk.networks.mainnet.archival,
    fetch: pacer.fetch,
    paceMs: 0,
    archivalPaceMs: 0,
    rounds: 6,
    backoffMs: 3_000,
    timeoutMs: 600_000,
    headersFor,
  });
  const blocks = new Map();
  const reader = {
    call(method, params, opts = {}) {
      const keys = Object.keys(params);
      if (method !== "block" || keys.length !== 1 || typeof params.block_id !== "number") return base.call(method, params, opts);
      const key = `${params.block_id}|${opts.archival === true}`;
      let p = blocks.get(key);
      if (!p) {
        p = base.call(method, params, opts).catch((e) => {
          if (!(e instanceof sdk.rpc.RpcAnswerError)) blocks.delete(key);
          throw e;
        });
        blocks.set(key, p);
      }
      return p;
    },
  };
  const http = sdk.http.createHttpClient({ fetch: pacer.fetch, paceMs: 0, retries: 0, timeoutMs: 600_000, headersFor });
  return { reader, http };
}

/** Per-account views of the shared clients, so each snapshot's meta lists its own endpoints. */
function accountClients(shared) {
  const used = new Set();
  const reader = {
    async call(method, params, opts) {
      try {
        const r = await shared.reader.call(method, params, opts);
        used.add(hostOf(r.endpoint));
        return r;
      } catch (e) {
        if (e && typeof e.endpoint === "string") used.add(hostOf(e.endpoint));
        throw e;
      }
    },
    endpointsUsed: () => [...used].sort(cmp),
  };
  const http = {
    async request(req) {
      const record = await shared.http.request(req);
      if (record.error === undefined) used.add(hostOf(req.url));
      return record;
    },
    endpointsUsed: () => [...used].sort(cmp),
  };
  return { reader, http };
}

// ---------------------------------------------------------------------------------------------
// Online run.

function existingStatus(sdk, accountId, known, block) {
  const file = snapshotFile(accountId);
  if (!fs.existsSync(file)) return { state: "missing" };
  try {
    const snapshot = sdk.engine.assertSnapshot(readJson(file));
    const cp = contextProblems(snapshot, { accountId, known, block });
    if (cp.length) return { state: "invalid", why: cp.join("; ") };
    const deg = degradedBy(snapshot, sdk.engine.verdictFromSnapshot(snapshot).decision);
    return deg.length ? { state: "degraded", why: deg.join(", ") } : { state: "ok" };
  } catch (e) {
    return { state: "invalid", why: e instanceof Error ? e.message : String(e) };
  }
}

function savedBlock(sdk, accounts) {
  const heights = new Set();
  for (const a of accounts) {
    const file = snapshotFile(a.account_id);
    if (!fs.existsSync(file)) continue;
    try {
      heights.add(sdk.engine.assertSnapshot(readJson(file)).block.height);
    } catch {
      // an unreadable file is reported and replaced later
    }
  }
  if (heights.size > 1) throw new Error(`saved snapshots are pinned to different blocks (${[...heights].join(", ")}); pass --at-block N`);
  return heights.size === 1 ? [...heights][0] : undefined;
}

function saveSnapshot(sdk, snapshot) {
  const file = snapshotFile(snapshot.subject);
  const text = `${asciiJson(sdk.engine.prettyJson(snapshot))}\n`;
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  // The saved bytes must replay to the verdict and digests computed in memory.
  const back = sdk.engine.verdictFromSnapshot(sdk.engine.assertSnapshot(readJson(file)));
  const live = sdk.engine.verdictFromSnapshot(snapshot);
  if (back.snapshot_sha256 !== live.snapshot_sha256 || back.chain_sha256 !== live.chain_sha256 || back.decision.verdict !== live.decision.verdict) {
    throw new Error(`${snapshot.subject}: the saved snapshot does not replay to the collected one`);
  }
}

async function online(opts) {
  const sdk = await loadSdk();
  const dataset = readJson(PATHS.dataset);
  const selection = selectAccounts(dataset);
  const known = loadKnown();
  fs.mkdirSync(PATHS.snapshots, { recursive: true });
  const pacer = createPacer();
  const shared = createSharedClients(sdk, pacer);
  const started = Date.now();
  const say = (line) => process.stdout.write(`${line}\n`);

  let accounts = selection.accounts;
  if (opts.only) {
    const only = new Set(opts.only);
    accounts = accounts.filter((a) => only.has(a.account_id));
    const unknown = opts.only.filter((id) => !selection.accounts.some((a) => a.account_id === id));
    if (unknown.length) throw new Error(`not in the selection: ${unknown.join(", ")}`);
  }
  let block = opts.atBlock ?? savedBlock(sdk, selection.accounts);
  if (block === undefined) {
    const head = await shared.reader.call("block", { finality: "final" });
    block = head.result.header.height;
    say(`pinned the run to the latest final mainnet block ${block}`);
  } else {
    say(`run pinned to mainnet block ${block}`);
  }

  const queue = [];
  let reuse = 0;
  for (const a of accounts) {
    const st = existingStatus(sdk, a.account_id, known, block);
    if (st.state === "ok" || (st.state === "degraded" && !opts.retryDegraded)) {
      reuse++;
      continue;
    }
    if (st.state === "invalid") say(`  will replace ${a.account_id}: ${st.why}`);
    queue.push({ ...a, attempts: 0, notBefore: 0, best: null, bestDeg: null });
  }
  say(`${accounts.length} accounts selected, ${reuse} already saved, ${queue.length} to collect (concurrency ${opts.concurrency}${opts.budgetMinutes ? `, budget ${opts.budgetMinutes} min` : ""})`);

  const total = queue.length;
  let done = 0;
  const failed = [];
  const budgetOver = () => opts.budgetMinutes !== undefined && Date.now() - started > opts.budgetMinutes * 60_000;

  async function collectOne(item) {
    item.attempts++;
    const t0 = Date.now();
    let snapshot = null;
    let replay = null;
    let error = null;
    try {
      const clients = accountClients(shared);
      snapshot = await sdk.collectSnapshot({
        account: item.account_id,
        network: "mainnet",
        atBlock: block,
        known,
        vault: null,
        registry: null,
        thirdParty: false,
        readers: { mainnet: clients.reader },
        http: clients.http,
      });
      replay = sdk.engine.verdictFromSnapshot(snapshot);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const tag = `${item.label === "lookalike_candidate" ? "lookalike" : item.label}`.padEnd(10);
    if (snapshot) {
      const deg = degradedBy(snapshot, replay.decision);
      if (deg.length === 0) {
        saveSnapshot(sdk, snapshot);
        done++;
        const d = replay.decision;
        say(`[${String(done).padStart(3)}/${total}] ${d.verdict.padEnd(5)} ${String(d.score).padStart(4)} ${tag} ${item.account_id}  (${secs} s, try ${item.attempts}) ${decidingCodes(d).join(", ")}`);
        return;
      }
      if (item.best === null || deg.length < item.bestDeg.length) {
        item.best = snapshot;
        item.bestDeg = deg;
      }
      error = `missing data: ${deg.join(", ")}`;
    }
    if (item.attempts < opts.maxAttempts && !budgetOver()) {
      const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      item.notBefore = Date.now() + delay;
      queue.push(item);
      say(`        retry ${item.account_id} in ${delay / 1000} s (try ${item.attempts}: ${error})`);
      return;
    }
    if (item.best) {
      saveSnapshot(sdk, item.best);
      done++;
      say(`[${String(done).padStart(3)}/${total}] saved WITH MISSING DATA ${item.account_id} after ${item.attempts} tries: ${item.bestDeg.join(", ")} (--retry-degraded collects it again)`);
    } else {
      failed.push(item.account_id);
      say(`        no snapshot for ${item.account_id} after ${item.attempts} tries: ${error}`);
    }
  }

  async function worker() {
    for (;;) {
      if (budgetOver()) return;
      if (queue.length === 0) return;
      const t = Date.now();
      const i = queue.findIndex((q) => q.notBefore <= t);
      if (i < 0) {
        const soonest = Math.min(...queue.map((q) => q.notBefore));
        await sleep(Math.max(200, Math.min(2_000, soonest - t)));
        continue;
      }
      const [item] = queue.splice(i, 1);
      await collectOne(item);
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));

  say("requests per host (sent, ok, rate limited, 5xx, transport errors, skipped while cooling):");
  for (const [host, s] of Object.entries(pacer.stats())) {
    say(`  ${host.padEnd(36)} ${String(s.sent).padStart(5)} ${String(s.ok).padStart(5)} ${String(s.rate_limited).padStart(4)} ${String(s.server_error).padStart(4)} ${String(s.transport_error).padStart(4)} ${String(s.skipped).padStart(4)}`);
  }
  const left = queue.length + failed.length;
  say(`collected ${done} this run in ${((Date.now() - started) / 60_000).toFixed(1)} min; ${left} left${failed.length ? ` (no snapshot: ${failed.join(", ")})` : ""}`);
  if (left > 0 || opts.only) {
    if (left > 0) say("stopped before every account had a snapshot: run the same command again to resume.");
    return left > 0 ? 3 : 0;
  }
  return writeVerdictFiles(sdk, say);
}

function writeVerdictFiles(sdk, say) {
  const r = deriveVerdictFiles(sdk);
  if (!r.ok) {
    say(`cannot write the verdict files: ${r.missing.length} of ${r.total} snapshots missing${r.problems.length ? `; problems: ${r.problems.join(" | ")}` : ""}`);
    return 3;
  }
  for (const [file, text] of derivedFiles(r)) fs.writeFileSync(file, text);
  const mix = {};
  for (const e of r.entries) mix[e.verdict] = (mix[e.verdict] ?? 0) + 1;
  say(`wrote ${path.relative(process.cwd(), PATHS.verdicts)} (${r.entries.length} verdicts: ${JSON.stringify(mix)}), ${path.relative(process.cwd(), PATHS.leaveSelfOut)} and ${path.relative(process.cwd(), PATHS.ablation)}`);
  if (r.degraded.length) say(`with missing data: ${r.degraded.join(", ")}`);
  say("score: node scan/score.mjs scan/benchmark/verdicts.json");
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Offline: rebuild or check, with no network.

async function offline({ check }) {
  const sdk = await loadSdk();
  const say = (line) => process.stdout.write(`${line}\n`);
  if (!check) return writeVerdictFiles(sdk, say);
  const r = deriveVerdictFiles(sdk);
  if (!r.ok) {
    say(`FAIL: ${r.missing.length} of ${r.total} snapshots missing${r.problems.length ? `; ${r.problems.join(" | ")}` : ""}`);
    return 1;
  }
  let ok = true;
  for (const [file, text] of derivedFiles(r)) {
    const committed = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    if (committed === text) {
      say(`ok: ${path.basename(file)} re-derives byte for byte from ${r.entries.length} snapshots`);
      continue;
    }
    ok = false;
    if (committed === null) {
      say(`FAIL: ${path.basename(file)} does not exist`);
      continue;
    }
    const was = new Map((JSON.parse(committed).verdicts ?? []).map((v) => [v.account_id, JSON.stringify(v)]));
    const now = JSON.parse(text).verdicts.map((v) => [v.account_id, JSON.stringify(v)]);
    const changed = now.filter(([id, v]) => was.get(id) !== v).map(([id]) => id);
    say(`FAIL: ${path.basename(file)} differs from the re-derivation${changed.length ? ` (verdict entries: ${changed.slice(0, 10).join(", ")}${changed.length > 10 ? ", ..." : ""})` : " (header fields)"}`);
  }
  return ok ? 0 : 1;
}

function list() {
  const s = selectAccounts(readJson(PATHS.dataset));
  const c = s.counts;
  const out = [`selection: ${c.suspicious} suspicious, ${c.known_good} known_good, ${c.lookalike_candidate.sampled} of ${c.lookalike_candidate.rows} lookalike_candidate (seed "${c.lookalike_candidate.seed}")`, "strata (sampled of rows):"];
  for (const [k, v] of Object.entries(c.lookalike_candidate.strata)) out.push(`  ${k.padEnd(42)} ${String(v.sampled).padStart(3)} of ${String(v.rows).padStart(3)}`);
  out.push("accounts:");
  for (const a of s.accounts) out.push(`  ${a.label.padEnd(20)} ${a.account_id}${a.stratum ? `  [${a.stratum}]` : ""}`);
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      offline: { type: "boolean" },
      check: { type: "boolean" },
      list: { type: "boolean" },
      "at-block": { type: "string" },
      concurrency: { type: "string" },
      "budget-minutes": { type: "string" },
      "max-attempts": { type: "string" },
      "retry-degraded": { type: "boolean" },
      only: { type: "string" },
    },
  });
  if (values.list) return list();
  if (values.offline) return offline({ check: values.check === true });
  if (values.check) throw new Error("--check needs --offline");
  const int = (v, name, min) => {
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`--${name} must be an integer >= ${min}`);
    return Number(v);
  };
  const budget = values["budget-minutes"] === undefined ? undefined : Number(values["budget-minutes"]);
  if (budget !== undefined && !(budget > 0)) throw new Error("--budget-minutes must be a positive number");
  return online({
    atBlock: int(values["at-block"], "at-block", 1),
    concurrency: int(values.concurrency, "concurrency", 1) ?? 3,
    budgetMinutes: budget,
    maxAttempts: int(values["max-attempts"], "max-attempts", 1) ?? 4,
    retryDegraded: values["retry-degraded"] === true,
    only: values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`run.mjs: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}

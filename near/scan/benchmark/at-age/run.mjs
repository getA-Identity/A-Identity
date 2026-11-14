#!/usr/bin/env node
// At-age replay of the benchmark: the same engine on the same scored accounts, each one pinned to
// the first block 1 day and 7 days after its OWN creation block, instead of one recent block for
// all. The rule is PREREGISTRATION.md (written before any at-age read); this script follows it.
//
// What the engine is given is what ../run.mjs gives it, and nothing else: the account id, the
// network, the block and the 25 names in ../known-brands.json, with third-party registries, the
// A-Identity registry and the vault off. The block is chosen here from chain facts alone: the
// account's creation block and block timestamps. scan/dataset.json is read only to choose the 76
// accounts (every suspicious and known_good row) and to cross-check creation dates; no label,
// category, source type, evidence or note reaches a snapshot, plan.json or a verdict file.
//
// Phases, from near/ (Node >= 22.22.2; TS = --experimental-strip-types --no-warnings=ExperimentalWarning):
//   node $TS scan/benchmark/at-age/run.mjs --plan
//       online: prove each account's creation block (archival view_account answers UNKNOWN_ACCOUNT
//       at one block and the account at the next), find the replay block of each age point (the
//       first block at or after creation + D days, proven by its predecessor) and read whether the
//       account exists there. plan.json is written after every account; re-run to resume.
//   node $TS scan/benchmark/at-age/run.mjs --days 1        (then --days 7)
//       online: collect the engine snapshot of every planned account at its replay block into
//       d1/snapshots/ (d7/snapshots/), then write that age point's verdict files. Re-run to resume.
//   node $TS scan/benchmark/at-age/run.mjs --offline [--check]
//       no network: derive d1/ and d7/ verdicts.json and verdicts.leave-self-out.json from plan.json
//       and the snapshots; --check exits 1 unless the committed files re-derive byte for byte.
//   node scan/benchmark/at-age/run.mjs --list
//       the 76 accounts and the age points (no network, no SDK)
//
// Online options: --concurrency N (accounts in flight, default 3), --budget-minutes M (start no
// new account after M minutes; re-run to resume), --max-attempts N (per account and run, default
// 4), --retry-degraded, --only id1,id2, --archival-gap-ms N (default 2400). Every read goes
// through ../run.mjs's per-host pacer (with slower archival gaps, atAgeHosts), and reads pinned to
// old blocks go to the SDK's archival hosts only (regular nodes keep a few epochs).
// FASTNEAR_API_KEY and NEARBLOCKS_API_KEY are sent to their own hosts when set, never recorded.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  HOSTS,
  SIGNALS,
  SIGNALS_OFF,
  accountClients,
  asciiJson,
  blockUtc,
  contextProblems,
  createPacer,
  createSharedClients,
  decidingCodes,
  loadKnown,
  loadSdk,
  PATHS,
  readJson,
  transportErrors,
} from "../run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const AGE_DAYS = Object.freeze([1, 7]);

export const AT_AGE = Object.freeze({
  plan: path.join(HERE, "plan.json"),
  preregistration: path.join(HERE, "PREREGISTRATION.md"),
  snapshots: (days) => path.join(HERE, `d${days}`, "snapshots"),
  verdicts: (days) => path.join(HERE, `d${days}`, "verdicts.json"),
  leaveSelfOut: (days) => path.join(HERE, `d${days}`, "verdicts.leave-self-out.json"),
});

/**
 * PREREGISTRATION.md as written before any at-age read: its first `bytes` bytes hash to `sha256`.
 * An amendment is appended after them, so this prefix never changes.
 */
export const PREREGISTRATION = Object.freeze({
  file: "PREREGISTRATION.md",
  written_utc: "2026-11-12T16:01:04Z",
  bytes: 8297,
  sha256: "0e9dccfc1e8553b8ccdce51844a76fa09d48606755816dc3db59b1c786325af4",
});

/** Pre-registered cross-check: the creation block lies 0 to 600 s after the dataset's created_at. */
export const CROSS_CHECK_S = 600;
const NS_PER_S = 1_000_000_000n;
const NS_PER_DAY = 86_400n * NS_PER_S;
/** Heights walked one by one after the oldest transaction before falling back to bisection. */
const WALK = 40;
/** Wait before the next attempt at an account whose snapshot had a transient missing read. */
const RETRY_DELAYS_MS = [20_000, 90_000, 240_000, 480_000];

/**
 * ../run.mjs's per-host gaps, with slower archival hosts: nearly every at-age read is archival.
 * Measured on 2026-11-12, keyless: at ../run.mjs's 500 ms gap both archival hosts answered 429
 * ("Rate limits exceeded") to every request after about six minutes; at 1250 ms FastNEAR's
 * archival host answered 238 of the first 240 requests and then about 26 a minute, with 429s and
 * the pacer's growing cool-downs in between. 2400 ms stays under that refill rate.
 * --archival-gap-ms sets the FastNEAR archival gap; the near.org archival host keeps at least 6 s.
 */
export function atAgeHosts(archivalGapMs = 2400) {
  return {
    ...HOSTS,
    "archival-rpc.mainnet.fastnear.com": { gapMs: archivalGapMs, kind: "rpc" },
    "archival-rpc.mainnet.near.org": { gapMs: Math.max(6_000, archivalGapMs), kind: "rpc" },
  };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Pure helpers (no SDK, no network).

/** The accounts the at-age replay runs: every suspicious and known_good row, sorted by id. */
export function scoredAccounts(dataset) {
  return dataset
    .filter((r) => r.label === "suspicious" || r.label === "known_good")
    .map((r) => r.account_id)
    .sort(cmp);
}

/** The target time of an age point: the creation block's timestamp plus `days` days, in ns. */
export function targetNs(creationTimestampNs, days) {
  return BigInt(creationTimestampNs) + BigInt(days) * NS_PER_DAY;
}

/** Why a planned replay block does not satisfy the age rule (empty when it does). Pure. */
export function ageRuleProblems(entry, days) {
  const p = [];
  const c = entry.creation;
  if (!c || c.state !== "proven") return [`${entry.account_id}: no proven creation block`];
  const a = entry.ages?.[String(days)];
  if (!a) return [`${entry.account_id}: no ${days}-day age point`];
  const t = targetNs(c.block.timestamp_ns, days);
  if (a.target_ns !== t.toString()) p.push(`target ${a.target_ns} is not creation ${c.block.timestamp_ns} + ${days} d`);
  if (BigInt(a.block.timestamp_ns) < t) p.push(`replay block #${a.block.height} is before the target`);
  if (BigInt(a.predecessor.timestamp_ns) >= t) p.push(`the replay block's predecessor #${a.predecessor.height} is not before the target`);
  if (a.block.prev_hash !== a.predecessor.hash) p.push(`#${a.predecessor.height} is not the replay block's predecessor`);
  if (!(a.predecessor.height < a.block.height)) p.push("predecessor height is not below the replay block");
  // The creation proof: absent at P, present at C, and C directly follows P.
  if (c.block.prev_hash !== c.predecessor.hash) p.push("the creation block does not directly follow its predecessor");
  if (c.view_account_at_block?.block_hash !== c.block.hash || c.view_account_at_block?.block_height !== c.block.height) p.push("view_account at the creation block answered for another block");
  if (c.view_account_at_predecessor?.error !== "UNKNOWN_ACCOUNT" || c.view_account_at_predecessor?.block_id !== c.predecessor.height) p.push("view_account at the predecessor did not answer UNKNOWN_ACCOUNT");
  if (!(BigInt(c.predecessor.timestamp_ns) < BigInt(c.block.timestamp_ns))) p.push("creation block timestamps out of order");
  return p.map((x) => `${entry.account_id} (${days} d): ${x}`);
}

/** What every at-age snapshot records outside the digests, so a reader can check its block. */
export function atAgeMeta(entry, days) {
  const a = entry.ages[String(days)];
  const ref = (b) => ({ height: b.height, hash: b.hash, timestamp_ns: b.timestamp_ns });
  return {
    rule: "the first block at or after the creation block's timestamp + days * 86400 s (scan/benchmark/at-age/PREREGISTRATION.md)",
    days,
    creation: ref(entry.creation.block),
    target_timestamp_ns: a.target_ns,
    block: ref(a.block),
    predecessor: ref(a.predecessor),
  };
}

/** Why a saved at-age snapshot cannot stand for this account and age point (empty when it can). */
export function atAgeProblems(snapshot, entry, days, known) {
  const a = entry.ages[String(days)];
  const p = contextProblems(snapshot, { accountId: entry.account_id, known, block: a.block.height });
  if (snapshot.block?.hash !== a.block.hash || snapshot.block?.timestamp_ns !== a.block.timestamp_ns) p.push("the pinned block is not the planned replay block");
  const head = (snapshot.rpc ?? []).find((r) => r.label === "block")?.result?.header;
  if (!head || head.prev_hash !== a.predecessor.hash) p.push("the recorded block's prev_hash is not the planned predecessor");
  if (JSON.stringify(snapshot.meta?.at_age) !== JSON.stringify(atAgeMeta(entry, days))) p.push("meta.at_age does not record the planned age point");
  return p;
}

/**
 * Reads that make a snapshot not yet usable: a JSON-RPC read no endpoint answered, an indexer
 * request that failed in transit, or no usable indexer answer at all. A decided answer from the
 * chain (for example that a contract did not exist yet at the block) is not in this list.
 */
export function transientProblems(snapshot, decision) {
  const out = new Set(transportErrors(snapshot).map((l) => `unanswered:${l}`));
  for (const r of decision.reasons) if (r.code === "indexer_unavailable") out.add(r.code);
  return [...out].sort(cmp);
}

/** Missing-data reason codes (any severity) in a decision: what the engine could not read. */
export const MISSING_DATA_REASONS = Object.freeze(["rpc_unavailable", "indexer_unavailable", "blocklist_unreadable", "erc8004_unreadable"]);
export function missingDataReasons(decision) {
  return [...new Set(decision.reasons.filter((r) => MISSING_DATA_REASONS.includes(r.code)).map((r) => r.code))].sort(cmp);
}

export function snapshotPath(days, accountId) {
  return path.join(AT_AGE.snapshots(days), `${accountId}.json`);
}
/** Written when collection gave up on an account with no snapshot at all (a technical exclusion). */
export function failurePath(days, accountId) {
  return path.join(AT_AGE.snapshots(days), `${accountId}.failed.json`);
}

// ---------------------------------------------------------------------------------------------
// Chain reads for the plan (archival, through the shared pacer).

class Transient extends Error {}

function makeChain(sdk, shared) {
  const { RpcAnswerError } = sdk.rpc;
  const call = async (method, params) => (await shared.reader.call(method, params, { archival: true })).result;
  const header = (result) => {
    const h = result?.header;
    if (!h || typeof h.height !== "number" || typeof h.hash !== "string" || typeof h.prev_hash !== "string" || !/^\d+$/.test(h.timestamp_nanosec ?? "")) {
      throw new Error("block answer without a header");
    }
    return { height: h.height, hash: h.hash, prev_hash: h.prev_hash, timestamp_ns: h.timestamp_nanosec };
  };
  const decided = (e, cause) => e instanceof RpcAnswerError && e.causeName === cause;
  return {
    /** The block at this height, or null when the height was skipped (no block). */
    async headerAt(height) {
      try {
        return header(await call("block", { block_id: height }));
      } catch (e) {
        if (decided(e, "UNKNOWN_BLOCK")) return null;
        throw e;
      }
    },
    async headerByHash(hash) {
      return header(await call("block", { block_id: hash }));
    },
    /** view_account at a height: exists (with the answer), absent (UNKNOWN_ACCOUNT) or no_block. */
    async viewAt(accountId, height) {
      try {
        const r = await call("query", { request_type: "view_account", account_id: accountId, block_id: height });
        return {
          state: "exists",
          answer: { block_height: r.block_height, block_hash: r.block_hash, code_hash: r.code_hash, amount: r.amount, storage_usage: r.storage_usage },
        };
      } catch (e) {
        if (decided(e, "UNKNOWN_ACCOUNT")) return { state: "absent", answer: { error: "UNKNOWN_ACCOUNT", block_id: height } };
        if (decided(e, "UNKNOWN_BLOCK")) return { state: "no_block" };
        throw e;
      }
    },
  };
}

const withUtc = (h) => ({ ...h, utc: blockUtc(h.timestamp_ns) });

async function existingAtOrAbove(chain, height, limit = 30) {
  for (let k = 0; k < limit; k++) {
    const h = await chain.headerAt(height + k);
    if (h) return h;
  }
  throw new Error(`no block in ${limit} heights from #${height}`);
}

/** The existing block nearest to `est` strictly between two heights, or null if every one is skipped. */
async function existingBetween(chain, est, loH, hiH) {
  const tried = new Set();
  for (let d = 0; tried.size < hiH - loH - 1 && d < 60; d++) {
    for (const h of d === 0 ? [est] : [est + d, est - d]) {
      if (h <= loH || h >= hiH || tried.has(h)) continue;
      tried.add(h);
      const b = await chain.headerAt(h);
      if (b) return b;
    }
  }
  if (tried.size < hiH - loH - 1) throw new Error(`no block found between #${loH} and #${hiH} near #${est}`);
  return null;
}

/**
 * The first block whose timestamp is at or after `target`, starting from a block before it: an
 * interpolation search over heights (bisection whenever a step does not halve the interval),
 * ending at two consecutive blocks, the answer and its predecessor.
 */
export async function firstBlockAtOrAfter(chain, target, from, nsPerHeight = NS_PER_S) {
  const ts = (h) => BigInt(h.timestamp_ns);
  if (ts(from) >= target) throw new Error("the search must start before the target");
  let lo = from;
  let hi = null;
  let rate = nsPerHeight > 0n ? nsPerHeight : NS_PER_S;
  for (let i = 0; i < 60 && hi === null; i++) {
    const h = await existingAtOrAbove(chain, lo.height + Number((target - ts(lo)) / rate) + 2);
    if (ts(h) >= target) {
      hi = h;
    } else {
      rate = (ts(h) - ts(lo)) / BigInt(h.height - lo.height);
      if (rate <= 0n) rate = 1n;
      lo = h;
    }
  }
  if (hi === null) throw new Error("no block after the target found");
  let bisect = false;
  for (let i = 0; i < 200; i++) {
    if (hi.prev_hash === lo.hash) {
      if (!(ts(hi) >= target && ts(lo) < target)) throw new Error("search ended on blocks that do not bracket the target");
      return { block: hi, predecessor: lo, rate: (ts(hi) - ts(from)) / BigInt(Math.max(1, hi.height - from.height)) };
    }
    const span = hi.height - lo.height;
    let est = bisect || span <= 16 ? lo.height + Math.floor(span / 2) : lo.height + Number(((target - ts(lo)) * BigInt(span)) / (ts(hi) - ts(lo)));
    est = Math.min(hi.height - 1, Math.max(lo.height + 1, est));
    const m = await existingBetween(chain, est, lo.height, hi.height);
    if (m === null) throw new Error(`#${lo.height} and #${hi.height} have no block between them but are not linked`);
    if (ts(m) >= target) hi = m;
    else lo = m;
    bisect = hi.height - lo.height > span / 2;
  }
  throw new Error("replay block search did not converge");
}

async function bisectFlip(chain, accountId, lo, hi) {
  // lo: a height where the account is absent; hi: one where it exists (with its answer).
  for (;;) {
    if (hi.height - lo.height <= 1) break;
    const mid = Math.floor((lo.height + hi.height) / 2);
    let found = null;
    for (let d = 0; !found && d < hi.height - lo.height; d++) {
      for (const h of d === 0 ? [mid] : [mid + d, mid - d]) {
        if (found || h <= lo.height || h >= hi.height) continue;
        const v = await chain.viewAt(accountId, h);
        if (v.state !== "no_block") found = { height: h, v };
      }
    }
    if (!found) break;
    if (found.v.state === "exists") hi = { height: found.height, answer: found.v.answer };
    else lo = { height: found.height, answer: found.v.answer };
  }
  return { lo, hi };
}

/**
 * The creation block: the first block at which view_account finds the account, proven by
 * UNKNOWN_ACCOUNT at its predecessor. The search starts at the oldest transaction that touches
 * the account (FastNEAR), walks forward block by block, and falls back to bisection.
 */
async function proveCreation(chain, accountId, txs) {
  const first = txs[0];
  const h0 = first.tx_block_height;
  let lo = null;
  for (let h = h0 - 1; h > h0 - 30 && h > 0; h--) {
    const v = await chain.viewAt(accountId, h);
    if (v.state === "no_block") continue;
    if (v.state === "exists") {
      return { state: "not_proven", why: `the account exists at #${h}, before the oldest transaction that touches it (#${h0}), so that transaction does not locate its creation` };
    }
    lo = { height: h, answer: v.answer };
    break;
  }
  if (!lo) return { state: "not_proven", why: `no block below #${h0} answered` };
  let hi = null;
  let method = "walk";
  for (let h = lo.height + 1; h <= h0 + WALK && !hi; h++) {
    const v = await chain.viewAt(accountId, h);
    if (v.state === "absent") lo = { height: h, answer: v.answer };
    else if (v.state === "exists") hi = { height: h, answer: v.answer };
  }
  if (!hi) {
    method = "bisection";
    const probes = [64, 256, 1024, 4096, 16384].map((k) => h0 + k);
    for (const t of txs.slice(1)) probes.push(t.tx_block_height + 3);
    for (const p of [...new Set(probes)].sort((a, b) => a - b)) {
      if (p <= lo.height) continue;
      const b = await existingAtOrAbove(chain, p);
      const v = await chain.viewAt(accountId, b.height);
      if (v.state === "exists") {
        hi = { height: b.height, answer: v.answer };
        break;
      }
      lo = { height: b.height, answer: v.answer };
    }
    if (!hi) return { state: "not_proven", why: `view_account never found the account after its oldest transaction (#${h0}) at the heights probed` };
    ({ lo, hi } = await bisectFlip(chain, accountId, lo, hi));
  }
  const C = await chain.headerAt(hi.height);
  const P = await chain.headerAt(lo.height);
  if (!C || !P) throw new Error(`${accountId}: creation proof blocks unreadable`);
  if (C.prev_hash !== P.hash) throw new Error(`${accountId}: #${P.height} is not the predecessor of #${C.height}`);
  if (hi.answer.block_hash !== C.hash) throw new Error(`${accountId}: view_account answered for another block`);
  return {
    state: "proven",
    method,
    block: withUtc(C),
    predecessor: withUtc({ height: P.height, hash: P.hash, timestamp_ns: P.timestamp_ns }),
    view_account_at_block: hi.answer,
    view_account_at_predecessor: lo.answer,
    located_by: {
      source: "FastNEAR POST /v0/account {limit: 10, desc: false}: the oldest transaction that touches the account",
      transaction_hash: first.transaction_hash,
      tx_block_height: first.tx_block_height,
      tx_block_timestamp_ns: String(first.tx_block_timestamp),
      is_receiver: first.is_receiver === true,
      is_signer: first.is_signer === true,
      is_success: first.is_success === true,
    },
  };
}

async function planAccount(ctx, accountId, row) {
  const { chain, http, nets } = ctx;
  const fast = await http.request({ label: "fastnear.oldest", source: "fastnear", method: "POST", url: `${nets.fastnearTx}/v0/account`, body: { account_id: accountId, limit: 10, desc: false } });
  if (typeof fast.error === "string" || fast.status !== 200 || !Array.isArray(fast.json?.account_txs)) throw new Transient(`FastNEAR: ${fast.error ?? `HTTP ${fast.status}`}`);
  const txs = [...fast.json.account_txs].sort((a, b) => a.tx_block_height - b.tx_block_height || (a.tx_index ?? 0) - (b.tx_index ?? 0));
  const nb = await http.request({ label: "nearblocks.account", source: "nearblocks", method: "GET", url: `${nets.nearblocks}/v3/accounts/${encodeURIComponent(accountId)}` });
  const creation = txs.length === 0 ? { state: "not_proven", why: "no transaction touches this account in FastNEAR's index" } : await proveCreation(chain, accountId, txs);

  // Cross-checks: recorded, never used to choose a block.
  const f = row?.facts ?? {};
  const cross = {
    dataset_created_at: f.created_at ?? null,
    dataset_creation_tx: f.creation_tx ?? null,
    fastnear_fetched_at: fast.fetched_at,
    fastnear_oldest_tx: txs[0]?.transaction_hash ?? null,
    nearblocks: null,
  };
  if (typeof nb.error === "string" || nb.status !== 200) {
    cross.nearblocks = { unavailable: nb.error ?? `HTTP ${nb.status}`, fetched_at: nb.fetched_at };
  } else {
    const d = nb.json?.data ?? {};
    cross.nearblocks = {
      created_block_timestamp_ns: d.created?.block_timestamp ?? null,
      created_transaction_hash: d.created?.transaction_hash ?? null,
      deleted_block_timestamp_ns: d.deleted?.block_timestamp ?? null,
      deleted_transaction_hash: d.deleted?.transaction_hash ?? null,
      fetched_at: nb.fetched_at,
    };
  }
  if (creation.state === "proven") {
    const cts = BigInt(creation.block.timestamp_ns);
    if (cross.dataset_created_at) {
      const s = (Number(cts / 1_000_000n) - Date.parse(cross.dataset_created_at)) / 1000;
      cross.seconds_after_dataset_created_at = s;
      cross.within_tolerance = s >= 0 && s <= CROSS_CHECK_S;
    }
    if (cross.nearblocks?.created_block_timestamp_ns) cross.seconds_after_nearblocks_created = Number((cts - BigInt(cross.nearblocks.created_block_timestamp_ns)) / 1_000_000n) / 1000;
  }

  const ages = {};
  if (creation.state === "proven") {
    let from = creation.block;
    let rate = NS_PER_S;
    for (const days of AGE_DAYS) {
      const target = targetNs(creation.block.timestamp_ns, days);
      const r = await firstBlockAtOrAfter(chain, target, from, rate);
      const at = await chain.viewAt(accountId, r.block.height);
      if (at.state === "no_block") throw new Error(`${accountId}: no block at the replay height ${r.block.height}`);
      ages[String(days)] = {
        target_ns: target.toString(),
        target_utc: blockUtc(target.toString()),
        block: withUtc(r.block),
        predecessor: withUtc({ height: r.predecessor.height, hash: r.predecessor.hash, timestamp_ns: r.predecessor.timestamp_ns }),
        exists: at.state === "exists",
        view_account: at.answer,
      };
      from = r.block;
      rate = r.rate;
    }
  }
  const entry = { account_id: accountId, creation, cross_checks: cross, ages, planned_at: new Date().toISOString() };
  for (const days of AGE_DAYS) if (creation.state === "proven" && ageRuleProblems(entry, days).length) throw new Error(ageRuleProblems(entry, days).join("; "));
  return entry;
}

function planDoc(entries) {
  return {
    purpose:
      "The creation block of every scored account (all suspicious and known_good rows of scan/dataset.json), proven from the chain, and its replay block at each age point. Input of the at-age replay; the engine never reads this file. No label is recorded here.",
    rule: "PREREGISTRATION.md",
    preregistration: PREREGISTRATION,
    network: "mainnet",
    age_days: AGE_DAYS,
    method: {
      creation:
        "The first block at which archival view_account finds the account: view_account at that block answers the account, and at its predecessor (the block whose hash is its prev_hash) answers UNKNOWN_ACCOUNT. The search starts at the oldest transaction that touches the account in FastNEAR's transactions API and walks forward block by block (bisection when the account does not appear within 40 heights).",
      replay_block:
        "The first block whose timestamp is at or after creation + days * 86400 s: its timestamp is at or after the target and its predecessor's is before it. Found by interpolation and bisection over archival block heights.",
      exists: "view_account at the replay block: an account that answers UNKNOWN_ACCOUNT there is excluded at that age point and gets no snapshot.",
      cross_checks: `Recorded, never used to choose a block: the dataset's facts.created_at and facts.creation_tx (creation expected 0 to ${CROSS_CHECK_S} s after created_at), and NearBlocks v3 GET /v3/accounts/{id} (created, deleted). Powered by Nearblocks.io APIs.`,
    },
    generated_by: "scan/benchmark/at-age/run.mjs --plan",
    accounts: [...entries].sort((a, b) => cmp(a.account_id, b.account_id)),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${asciiJson(JSON.stringify(value, null, 2))}\n`);
  fs.renameSync(`${file}.tmp`, file);
}

export function readPlan() {
  return fs.existsSync(AT_AGE.plan) ? readJson(AT_AGE.plan) : null;
}

/** A plan entry is complete when its creation is decided and, if proven, both age points are planned. */
const complete = (e) => e && (e.creation?.state === "not_proven" || (e.creation?.state === "proven" && AGE_DAYS.every((d) => e.ages?.[String(d)])));

async function runPlan(opts) {
  const sdk = await loadSdk();
  const dataset = readJson(PATHS.dataset);
  const rows = new Map(dataset.map((r) => [r.account_id, r]));
  let ids = scoredAccounts(dataset);
  if (opts.only) {
    const unknown = opts.only.filter((id) => !ids.includes(id));
    if (unknown.length) throw new Error(`not a scored account: ${unknown.join(", ")}`);
    ids = ids.filter((id) => opts.only.includes(id));
  }
  const say = (line) => process.stdout.write(`${line}\n`);
  const pacer = createPacer({ hosts: atAgeHosts(opts.archivalGapMs) });
  const shared = createSharedClients(sdk, pacer, process.env, { rpc: [] });
  const ctx = { chain: makeChain(sdk, shared), http: shared.http, nets: sdk.networks.mainnet };
  const old = readPlan();
  const entries = new Map((old?.accounts ?? []).map((e) => [e.account_id, e]));
  const queue = ids.filter((id) => !complete(entries.get(id))).map((id) => ({ id, attempts: 0, notBefore: 0 }));
  say(`${ids.length} accounts, ${ids.length - queue.length} already planned, ${queue.length} to plan (${new Date().toISOString()})`);
  watchStats(say, pacer);
  const started = Date.now();
  const budgetOver = () => opts.budgetMinutes !== undefined && Date.now() - started > opts.budgetMinutes * 60_000;
  let done = 0;
  const failed = [];
  async function worker() {
    for (;;) {
      if (budgetOver() || queue.length === 0) return;
      const t = Date.now();
      const i = queue.findIndex((q) => q.notBefore <= t);
      if (i < 0) {
        await sleep(Math.max(200, Math.min(2_000, Math.min(...queue.map((q) => q.notBefore)) - t)));
        continue;
      }
      const [item] = queue.splice(i, 1);
      item.attempts++;
      const t0 = Date.now();
      try {
        const e = await planAccount(ctx, item.id, rows.get(item.id));
        entries.set(item.id, e);
        writeJson(AT_AGE.plan, planDoc([...entries.values()]));
        done++;
        const c = e.creation;
        const ages = AGE_DAYS.map((d) => (e.ages[String(d)] ? `${d}d #${e.ages[String(d)].block.height}${e.ages[String(d)].exists ? "" : " ABSENT"}` : `${d}d -`)).join(", ");
        say(`[${String(done).padStart(2)}] ${item.id}: ${c.state === "proven" ? `created #${c.block.height} ${c.block.utc} (${c.method})` : `NOT PROVEN: ${c.why}`}; ${ages}; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (item.attempts < opts.maxAttempts && !budgetOver()) {
          const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
          item.notBefore = Date.now() + delay;
          queue.push(item);
          say(`     retry ${item.id} in ${delay / 1000} s (try ${item.attempts}: ${msg})`);
        } else {
          failed.push(item.id);
          say(`     gave up on ${item.id} for this run after ${item.attempts} tries: ${msg}`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  printStats(say, pacer);
  const left = ids.filter((id) => !complete(entries.get(id)));
  say(`planned ${done} this run in ${((Date.now() - started) / 60_000).toFixed(1)} min; ${left.length} left${left.length ? ` (${left.join(", ")})` : ""}`);
  return left.length ? 3 : 0;
}

function printStats(say, pacer) {
  say(`requests per host at ${new Date().toISOString()} (sent, ok, rate limited, 5xx, transport errors, skipped while cooling):`);
  for (const [host, s] of Object.entries(pacer.stats())) {
    say(`  ${host.padEnd(36)} ${String(s.sent).padStart(5)} ${String(s.ok).padStart(5)} ${String(s.rate_limited).padStart(4)} ${String(s.server_error).padStart(4)} ${String(s.transport_error).padStart(4)} ${String(s.skipped).padStart(4)}`);
  }
}

/** Print the request counts every 5 minutes, and once more if the run is stopped by a signal. */
function watchStats(say, pacer) {
  const timer = setInterval(() => printStats(say, pacer), 300_000);
  timer.unref();
  const stop = (signal) => {
    printStats(say, pacer);
    say(`stopped by ${signal}; re-run the same command to resume`);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------------------------
// Collection at one age point.

function saveSnapshot(sdk, days, snapshot) {
  const file = snapshotPath(days, snapshot.subject);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${asciiJson(sdk.engine.prettyJson(snapshot))}\n`;
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
  const back = sdk.engine.verdictFromSnapshot(sdk.engine.assertSnapshot(readJson(file)));
  const live = sdk.engine.verdictFromSnapshot(snapshot);
  if (back.snapshot_sha256 !== live.snapshot_sha256 || back.chain_sha256 !== live.chain_sha256 || back.decision.verdict !== live.decision.verdict) {
    throw new Error(`${snapshot.subject}: the saved snapshot does not replay to the collected one`);
  }
  if (fs.existsSync(failurePath(days, snapshot.subject))) fs.rmSync(failurePath(days, snapshot.subject));
}

function savedStatus(sdk, entry, days, known) {
  const file = snapshotPath(days, entry.account_id);
  if (!fs.existsSync(file)) return { state: "missing" };
  try {
    const s = sdk.engine.assertSnapshot(readJson(file));
    const p = atAgeProblems(s, entry, days, known);
    if (p.length) return { state: "invalid", why: p.join("; ") };
    const t = transientProblems(s, sdk.engine.verdictFromSnapshot(s).decision);
    return t.length ? { state: "degraded", why: t.join(", ") } : { state: "ok" };
  } catch (e) {
    return { state: "invalid", why: e instanceof Error ? e.message : String(e) };
  }
}

async function runDays(days, opts) {
  const sdk = await loadSdk();
  const plan = readPlan();
  if (!plan) throw new Error("no plan.json: run --plan first");
  const known = loadKnown();
  const say = (line) => process.stdout.write(`${line}\n`);
  let entries = plan.accounts.filter((e) => e.creation.state === "proven" && e.ages[String(days)]?.exists === true);
  if (opts.only) entries = entries.filter((e) => opts.only.includes(e.account_id));
  const pacer = createPacer({ hosts: atAgeHosts(opts.archivalGapMs) });
  const shared = createSharedClients(sdk, pacer, process.env, { rpc: [] });
  const queue = [];
  let reuse = 0;
  for (const e of entries) {
    const st = savedStatus(sdk, e, days, known);
    if (st.state === "ok" || (st.state === "degraded" && !opts.retryDegraded)) {
      reuse++;
      continue;
    }
    if (st.state === "invalid") say(`  will replace ${e.account_id}: ${st.why}`);
    queue.push({ entry: e, attempts: 0, notBefore: 0, best: null, bestT: null });
  }
  say(`${days}-day age point: ${entries.length} accounts exist at their replay block, ${reuse} already saved, ${queue.length} to collect (concurrency ${opts.concurrency}${opts.budgetMinutes ? `, budget ${opts.budgetMinutes} min` : ""}; ${new Date().toISOString()})`);
  watchStats(say, pacer);
  const total = queue.length;
  let done = 0;
  const failed = [];
  const started = Date.now();
  const budgetOver = () => opts.budgetMinutes !== undefined && Date.now() - started > opts.budgetMinutes * 60_000;

  async function collectOne(item) {
    item.attempts++;
    const e = item.entry;
    const a = e.ages[String(days)];
    const t0 = Date.now();
    let snapshot = null;
    let error = null;
    let decision = null;
    try {
      const clients = accountClients(shared);
      snapshot = await sdk.collectSnapshot({
        account: e.account_id,
        network: "mainnet",
        atBlock: a.block.height,
        known,
        vault: null,
        registry: null,
        thirdParty: false,
        readers: { mainnet: clients.reader },
        http: clients.http,
      });
      if (snapshot.block.hash !== a.block.hash) throw new Error(`block #${a.block.height} answered hash ${snapshot.block.hash}, the plan has ${a.block.hash}`);
      snapshot.meta.at_age = atAgeMeta(e, days);
      snapshot.meta.notes = [
        ...snapshot.meta.notes,
        `Pinned by age (scan/benchmark/at-age): the first block at or after the account's creation block #${e.creation.block.height} + ${days} day(s).`,
      ];
      const p = atAgeProblems(snapshot, e, days, known);
      if (p.length) throw new Error(p.join("; "));
      decision = sdk.engine.verdictFromSnapshot(snapshot).decision;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      snapshot = null;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (snapshot) {
      const t = transientProblems(snapshot, decision);
      if (t.length === 0) {
        saveSnapshot(sdk, days, snapshot);
        done++;
        say(`[${String(done).padStart(2)}/${total}] saved ${e.account_id} at #${a.block.height} (${secs} s, try ${item.attempts}; ${missingDataReasons(decision).length ? `decided missing data: ${missingDataReasons(decision).join(", ")}` : "no missing data"})`);
        return;
      }
      if (item.best === null || t.length < item.bestT.length) {
        item.best = snapshot;
        item.bestT = t;
      }
      error = `transient: ${t.join(", ")}`;
    }
    if (item.attempts < opts.maxAttempts && !budgetOver()) {
      const delay = RETRY_DELAYS_MS[Math.min(item.attempts - 1, RETRY_DELAYS_MS.length - 1)];
      item.notBefore = Date.now() + delay;
      queue.push(item);
      say(`        retry ${e.account_id} in ${delay / 1000} s (try ${item.attempts}: ${error})`);
      return;
    }
    if (item.best) {
      saveSnapshot(sdk, days, item.best);
      done++;
      say(`[${String(done).padStart(2)}/${total}] saved WITH A TRANSIENT MISSING READ ${e.account_id} after ${item.attempts} tries: ${item.bestT.join(", ")} (--retry-degraded collects it again; until then it is a technical exclusion)`);
    } else {
      failed.push(e.account_id);
      writeJson(failurePath(days, e.account_id), { account_id: e.account_id, days, attempts: item.attempts, error, at: new Date().toISOString() });
      say(`        no snapshot for ${e.account_id} after ${item.attempts} tries: ${error}`);
    }
  }

  async function worker() {
    for (;;) {
      if (budgetOver() || queue.length === 0) return;
      const t = Date.now();
      const i = queue.findIndex((q) => q.notBefore <= t);
      if (i < 0) {
        await sleep(Math.max(200, Math.min(2_000, Math.min(...queue.map((q) => q.notBefore)) - t)));
        continue;
      }
      const [item] = queue.splice(i, 1);
      await collectOne(item);
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  printStats(say, pacer);
  const left = queue.length;
  say(`collected ${done} this run in ${((Date.now() - started) / 60_000).toFixed(1)} min; ${left} left${failed.length ? `; no snapshot: ${failed.join(", ")}` : ""}`);
  if (left > 0) {
    say("stopped before every account had a snapshot: run the same command again to resume.");
    return 3;
  }
  if (opts.only) return 0;
  return writeAge(sdk, days, say);
}

// ---------------------------------------------------------------------------------------------
// Verdict files, derived from plan.json and the saved snapshots only.

const SELECTION = "every suspicious and known_good row of scan/dataset.json (76 accounts); lookalike_candidate rows are not run";

/**
 * Re-derive one age point's two verdict files. Returns their exact text, or why it cannot (a
 * planned snapshot that is missing, or one that fails its checks).
 */
export function deriveAge(sdk, days, { plan = readPlan(), known = loadKnown(), knownDoc = readJson(PATHS.known), dataset = readJson(PATHS.dataset) } = {}) {
  if (!plan) return { ok: false, missing: [], problems: ["no plan.json"] };
  const ids = scoredAccounts(dataset);
  const byId = new Map(plan.accounts.map((e) => [e.account_id, e]));
  const entries = [];
  const leaveSelfOut = [];
  const excluded = [];
  const problems = [];
  const missing = [];
  const endpoints = new Set();
  const collected = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!complete(e)) {
      missing.push(`${id} (not planned)`);
      continue;
    }
    if (e.creation.state !== "proven") {
      excluded.push({ account_id: id, reason: "creation_not_proven", detail: e.creation.why });
      continue;
    }
    for (const p of ageRuleProblems(e, days)) problems.push(p);
    const a = e.ages[String(days)];
    if (!a.exists) {
      const nb = e.cross_checks?.nearblocks;
      const deleted = nb?.deleted_block_timestamp_ns ? `; NearBlocks dates its deletion ${blockUtc(nb.deleted_block_timestamp_ns)}` : "";
      excluded.push({
        account_id: id,
        reason: "absent_at_replay_block",
        detail: `view_account at the replay block #${a.block.height} (${a.block.utc}) answered UNKNOWN_ACCOUNT; created #${e.creation.block.height} (${e.creation.block.utc})${deleted}`,
      });
      continue;
    }
    const file = snapshotPath(days, id);
    if (!fs.existsSync(file)) {
      if (fs.existsSync(failurePath(days, id))) {
        const f = readJson(failurePath(days, id));
        excluded.push({ account_id: id, reason: "technical", detail: `no snapshot after ${f.attempts} tries: ${f.error}` });
      } else {
        missing.push(id);
      }
      continue;
    }
    let snapshot;
    try {
      snapshot = sdk.engine.assertSnapshot(readJson(file));
    } catch (err) {
      problems.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const ap = atAgeProblems(snapshot, e, days, known);
    if (ap.length) {
      problems.push(`${id}: ${ap.join("; ")}`);
      continue;
    }
    const replay = sdk.engine.verdictFromSnapshot(snapshot);
    const d = replay.decision;
    const t = transientProblems(snapshot, d);
    if (t.length) {
      excluded.push({ account_id: id, reason: "technical", detail: `a transient missing read when collection ended: ${t.join(", ")}` });
      continue;
    }
    for (const x of snapshot.meta?.endpoints ?? []) endpoints.add(x);
    if (snapshot.meta?.collected_at) collected.push(snapshot.meta.collected_at);
    entries.push({
      account_id: d.subject,
      verdict: d.verdict,
      score: d.score,
      warn_kind: d.warn_kind,
      deciding: decidingCodes(d),
      reasons: d.reasons,
      missing_data: missingDataReasons(d),
      block: d.block,
      age_days: days,
      creation_block: { height: e.creation.block.height, hash: e.creation.block.hash, timestamp_ns: e.creation.block.timestamp_ns },
      target_timestamp_ns: a.target_ns,
      snapshot: `d${days}/snapshots/${id}.json`,
      snapshot_sha256: replay.snapshot_sha256,
      chain_sha256: replay.chain_sha256,
      engine_version: d.engine_version,
      policy_id: d.policy_id,
      collected_at: snapshot.meta?.collected_at ?? null,
      endpoints: snapshot.meta?.endpoints ?? [],
      transport_errors: transportErrors(snapshot),
    });
    const self = sdk.engine.verdictFromSnapshot({ ...snapshot, context: { ...snapshot.context, known: known.filter((k) => k !== id) } });
    const sd = self.decision;
    const lk = self.signals.lookalike;
    leaveSelfOut.push({
      account_id: sd.subject,
      own_name_on_list: known.includes(id),
      verdict: sd.verdict,
      score: sd.score,
      warn_kind: sd.warn_kind,
      deciding: decidingCodes(sd),
      lookalike: lk ? { known: lk.known, kind: lk.kind, strong: lk.strong } : null,
      chain_sha256: replay.chain_sha256,
    });
  }
  if (missing.length || problems.length) return { ok: false, missing, problems };

  const engine = `${sdk.engine.ENGINE_VERSION} (policy ${sdk.engine.DEFAULT_POLICY.id}; collector ${sdk.SDK_VERSION}); block: the first block at or after the account's creation + ${days} day${days === 1 ? "" : "s"}`;
  collected.sort(cmp);
  const atAge = {
    days,
    rule: "each account pinned to the first block at or after its own creation block's timestamp + days * 86400 s; the creation block is proven from the chain (plan.json)",
    preregistration: PREREGISTRATION,
    plan: "plan.json",
  };
  const run = {
    network: "mainnet",
    selection: SELECTION,
    accounts: entries.length,
    excluded: excluded.length,
    collected_first: collected[0] ?? null,
    collected_last: collected[collected.length - 1] ?? null,
    endpoints: [...endpoints].sort(cmp),
    generated_by: "scan/benchmark/at-age/run.mjs (verdicts derived from plan.json and the snapshots; --offline rebuilds this file)",
  };
  const knownInfo = { file: "known-brands.json", rule: knownDoc.rule, source: knownDoc.source, fetched_at: knownDoc.fetched_at, count: known.length, accounts: known };
  const verdicts = { engine, signals: SIGNALS, signals_off: SIGNALS_OFF, labels_used: false, known: knownInfo, at_age: atAge, run, excluded, verdicts: entries };
  const minusSelf = {
    engine,
    signals: SIGNALS.map((s) => (s === "lookalike_fixed_brands" ? "lookalike_fixed_brands_minus_self" : s)),
    signals_off: {
      ...SIGNALS_OFF,
      known_payee_exemption:
        "off: a replay of verdicts.json in which every payee is compared with known-brands.json minus its own name (no network; the chain data is identical, so chain_sha256 is shared), computed exactly as ../verdicts.leave-self-out.json is",
    },
    labels_used: false,
    derived_from: "verdicts.json",
    at_age: atAge,
    run: { network: "mainnet", accounts: leaveSelfOut.length, excluded: excluded.length, own_name_on_list: leaveSelfOut.filter((x) => x.own_name_on_list).length },
    excluded,
    verdicts: leaveSelfOut,
  };
  return {
    ok: true,
    verdictsText: `${asciiJson(JSON.stringify(verdicts, null, 2))}\n`,
    leaveSelfOutText: `${asciiJson(JSON.stringify(minusSelf, null, 2))}\n`,
    entries,
    leaveSelfOut,
    excluded,
  };
}

function derivedFiles(days, r) {
  return [
    [AT_AGE.verdicts(days), r.verdictsText],
    [AT_AGE.leaveSelfOut(days), r.leaveSelfOutText],
  ];
}

function writeAge(sdk, days, say) {
  const r = deriveAge(sdk, days);
  if (!r.ok) {
    say(`cannot write the ${days}-day verdict files: ${r.missing.length} missing${r.missing.length ? ` (${r.missing.slice(0, 8).join(", ")}${r.missing.length > 8 ? ", ..." : ""})` : ""}${r.problems.length ? `; problems: ${r.problems.join(" | ")}` : ""}`);
    return 3;
  }
  for (const [file, text] of derivedFiles(days, r)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const mix = {};
  for (const e of r.entries) mix[e.verdict] = (mix[e.verdict] ?? 0) + 1;
  say(`wrote d${days}/verdicts.json (${r.entries.length} verdicts: ${JSON.stringify(mix)}; ${r.excluded.length} excluded) and d${days}/verdicts.leave-self-out.json`);
  say(`score: node scan/score.mjs scan/benchmark/at-age/d${days}/verdicts.json`);
  return 0;
}

async function offline({ check }) {
  const sdk = await loadSdk();
  const say = (line) => process.stdout.write(`${line}\n`);
  let ok = true;
  const pre = preregistrationProblems();
  if (pre.length) {
    say(`FAIL: ${pre.join("; ")}`);
    ok = false;
  }
  for (const days of AGE_DAYS) {
    if (!check) {
      if (writeAge(sdk, days, say) !== 0) ok = false;
      continue;
    }
    const r = deriveAge(sdk, days);
    if (!r.ok) {
      say(`FAIL: ${days}-day: ${r.missing.length} missing${r.problems.length ? `; ${r.problems.join(" | ")}` : ""}`);
      ok = false;
      continue;
    }
    for (const [file, text] of derivedFiles(days, r)) {
      const committed = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
      const rel = path.relative(HERE, file);
      if (committed === text) {
        say(`ok: at-age/${rel} re-derives byte for byte from plan.json and ${r.entries.length} snapshots (${r.excluded.length} excluded)`);
        continue;
      }
      ok = false;
      say(`FAIL: at-age/${rel} ${committed === null ? "does not exist" : "differs from the re-derivation"}`);
    }
  }
  return ok ? 0 : 1;
}

/** PREREGISTRATION.md still begins with the text written before any at-age read. */
export function preregistrationProblems() {
  if (!fs.existsSync(AT_AGE.preregistration)) return ["PREREGISTRATION.md is missing"];
  const bytes = fs.readFileSync(AT_AGE.preregistration);
  const head = bytes.subarray(0, PREREGISTRATION.bytes);
  const sha = createHash("sha256").update(head).digest("hex");
  return sha === PREREGISTRATION.sha256 ? [] : [`PREREGISTRATION.md's first ${PREREGISTRATION.bytes} bytes hash to ${sha}, not ${PREREGISTRATION.sha256}`];
}

function list() {
  const ids = scoredAccounts(readJson(PATHS.dataset));
  process.stdout.write(`${ids.length} accounts, age points ${AGE_DAYS.join(" and ")} days:\n${ids.map((id) => `  ${id}`).join("\n")}\n`);
  return 0;
}

// ---------------------------------------------------------------------------------------------

export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: "boolean" },
      days: { type: "string" },
      offline: { type: "boolean" },
      check: { type: "boolean" },
      list: { type: "boolean" },
      concurrency: { type: "string" },
      "budget-minutes": { type: "string" },
      "max-attempts": { type: "string" },
      "retry-degraded": { type: "boolean" },
      only: { type: "string" },
      "archival-gap-ms": { type: "string" },
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
  const opts = {
    concurrency: int(values.concurrency, "concurrency", 1) ?? 3,
    budgetMinutes: budget,
    maxAttempts: int(values["max-attempts"], "max-attempts", 1) ?? 4,
    retryDegraded: values["retry-degraded"] === true,
    only: values.only ? values.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    archivalGapMs: int(values["archival-gap-ms"], "archival-gap-ms", 100) ?? 2400,
  };
  if (values.plan) return runPlan(opts);
  if (values.days !== undefined) {
    const days = Number(values.days);
    if (!AGE_DAYS.includes(days)) throw new Error(`--days must be one of ${AGE_DAYS.join(", ")}`);
    return runDays(days, opts);
  }
  throw new Error("one of --plan, --days N, --offline or --list");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`at-age/run.mjs: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}

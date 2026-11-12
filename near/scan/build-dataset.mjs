#!/usr/bin/env node
// Builds scan/dataset.json: the labeled, cited set of NEAR mainnet accounts the verdict
// engine is benchmarked on.
//
//   node scan/build-dataset.mjs                     full run: cited rows + lookalike sweep
//   node scan/build-dataset.mjs --skip-lookalikes   cited rows only, keeps the last sweep's rows
//   node scan/build-dataset.mjs --refresh           ignore today's cache and re-read everything
//   node scan/build-dataset.mjs --workers 4         concurrent workers (requests stay paced per host)
//
// Runtime depends on the keyless FastNEAR limits: the cited rows take 3 to 5 minutes; the full
// sweep takes 10 minutes for existence plus 15 minutes to several hours for indexer enrichment,
// because the transactions API answers 429 for long stretches. A quick live check of the
// published file is scan/spot-check.mjs (1 to 2 minutes).
//
// Read-only: JSON-RPC view calls and the FastNEAR transactions indexer. No keys, no
// transactions. Answers are cached per UTC day under scan/.cache/ so an interrupted run
// resumes; a second run on the same day replays that cache unless --refresh is given, and
// dataset.summary.json says how many accounts came from the cache.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NearReader, mapPool, nowIso, yoctoToNear, NO_CONTRACT_CODE_HASH, MAINNET_RPCS, MAINNET_ARCHIVAL_RPC, FASTNEAR_TX_API } from "./lib.mjs";
import { generateLookalikes, annotateLookalikes, derivedQuote, LOOKALIKE_NOTE, GENERATOR_VERSION } from "./lookalikes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const SKIP_LOOKALIKES = flag("--skip-lookalikes");
const REFRESH = flag("--refresh");
const WORKERS = Number(opt("--workers", "4"));
const OUT = path.resolve(opt("--out", path.join(HERE, "dataset.json")));
const SUMMARY_OUT = path.resolve(opt("--summary", path.join(HERE, "dataset.summary.json")));
const CACHE_DIR = path.join(HERE, ".cache");
const TODAY = new Date().toISOString().slice(0, 10);
const CACHE_FILE = path.join(CACHE_DIR, `live-${TODAY}.json`);
// MimicWatch's public 2026-11-01 mainnet scan (MIT), used only to annotate overlaps.
const MIMICWATCH_SCAN = "https://raw.githubusercontent.com/kacpergumieniuk/mimicwatch-near/0906683760d32ae0438f6ab0348b4724f23dc6c5/data/scans/2026-11-01/accounts.json";

const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const knownSeeds = readJson(path.join(HERE, "seeds", "known-good.json")).accounts;
const suspiciousSeeds = readJson(path.join(HERE, "seeds", "suspicious.json")).accounts;

// Seeds must not overlap: an account cannot be both known_good and suspicious.
{
  const k = new Set(knownSeeds.map((s) => s.account_id));
  const clash = suspiciousSeeds.filter((s) => k.has(s.account_id)).map((s) => s.account_id);
  if (clash.length) throw new Error(`seed overlap: ${clash.join(", ")}`);
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
let cache = {};
if (!REFRESH && fs.existsSync(CACHE_FILE)) cache = readJson(CACHE_FILE);
let dirty = 0;
const saveCache = (force = false) => {
  if (!force && dirty < 25) return;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  dirty = 0;
};

// Keyless FastNEAR answered 429 at about 10 RPC requests a second across both hosts and at
// about 3 a second on the transactions API (2026-11-12), so the defaults stay well below that.
// dRPC publishes a free limit in compute units per second that is far above this sweep's
// rate, so it gets a shorter gap and carries most of the load when FastNEAR is benched.
const reader = new NearReader({
  log: (m) => log(m),
  rpcs: opt("--rpc", MAINNET_RPCS.join(",")).split(","),
  rpcGapMs: Number(opt("--rpc-gap", "450")),
  txGapMs: Number(opt("--tx-gap", "700")),
  hostGapMs: { "near-mainnet.drpc.org": Number(opt("--drpc-gap", "150")) },
});
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    saveCache(true);
    log(`${sig}: cache saved (${Object.keys(cache).length} rows), rerun to resume`);
    process.exit(130);
  });
}

// Which accounts this run answered from the day's cache and which it read (at least in part)
// live, so the summary never presents a cache replay as a live run.
const fromCache = new Set();
const readLive = new Set();

// A cached record is complete when its access keys and token metadata were read at the block
// view_account answered at (pinned) and the indexer answered. A record with an error, or one
// from before pinning existed, is finished on the next run instead of being reused as is.
const hasContract = (view) => view.code_hash !== NO_CONTRACT_CODE_HASH;
const complete = (r) => r.full === true && r.pinned === true && "keys" in r && "activity" in r && (!hasContract(r.view) || "ft" in r);

// One live check: view_account always; with full, also access keys and ft_metadata at the
// same block, and the indexer's creation and activity summary, for an account that exists.
async function liveCheck(accountId, { full }) {
  const hit = cache[accountId];
  if (hit && (!full || !hit.view.exists || complete(hit))) {
    fromCache.add(accountId);
    return hit;
  }
  readLive.add(accountId);
  // An existence check from today is reused; only what is missing is read. The record is built
  // on a copy and stored whole, so an interrupted run never caches half of it.
  const rec = hit ? { ...hit } : { checked_at: nowIso(), view: await reader.viewAccount(accountId), full: false };
  const view = rec.view;
  if (view.exists && full) {
    if (rec.pinned !== true) {
      for (const k of ["keys", "keys_error", "ft", "ft_error"]) delete rec[k];
      rec.pinned = true;
    }
    // Keys and token metadata at the recorded block, so every chain-state fact in the row
    // describes that one block (the archival node answers once regular nodes dropped it).
    const at = { block_id: view.block_hash };
    if (!("keys" in rec)) {
      delete rec.keys_error;
      try {
        rec.keys = await reader.accessKeySummary(accountId, at);
      } catch (err) {
        rec.keys_error = err.message;
      }
    }
    if (hasContract(view) && !("ft" in rec)) {
      delete rec.ft_error;
      try {
        const ft = await reader.callView(accountId, "ft_metadata", {}, at);
        rec.ft = ft.ok && ft.value && typeof ft.value === "object" ? { name: String(ft.value.name ?? ""), symbol: String(ft.value.symbol ?? ""), decimals: ft.value.decimals ?? null } : null;
      } catch (err) {
        rec.ft_error = err.message;
      }
    }
    if (!("activity" in rec)) {
      delete rec.activity_error;
      try {
        rec.activity = await reader.activity(accountId);
      } catch (err) {
        rec.activity_error = err.message;
      }
    }
    rec.full = true;
  }
  cache[accountId] = rec;
  dirty++;
  saveCache();
  return rec;
}

// Strip characters outside printable ASCII from on-chain strings (token names are attacker
// controlled and may carry lookalike dots or control characters); keep a flag when it happened.
function cleanOnchain(s) {
  const out = String(s).replace(/[^\x20-\x7E]/g, "?");
  return { text: out.slice(0, 160), altered: out !== s };
}

function factsFrom(rec) {
  const v = rec.view;
  const f = { block_height: v.block_height ?? null };
  if (!v.exists) return f;
  f.balance_near = yoctoToNear(v.amount);
  f.has_contract = hasContract(v);
  f.code_hash = v.code_hash;
  if (v.global_contract_account_id) f.global_contract_account_id = v.global_contract_account_id;
  if (rec.keys) Object.assign(f, rec.keys);
  if (rec.activity) {
    const a = rec.activity;
    Object.assign(f, {
      created_at: a.created_at,
      creation_tx: a.creation_tx,
      creator: a.creator,
      txs_count: a.txs_count,
      last_tx_at: a.last_tx_at,
    });
    // The indexer answered and has no transaction for the account: say so, rather than
    // leaving a reader to guess between "never indexed" and "not read".
    if (!a.created_at) f.creation_indexed = false;
  }
  if (rec.ft) {
    const n = cleanOnchain(rec.ft.name);
    const s = cleanOnchain(rec.ft.symbol);
    f.ft_name = n.text;
    f.ft_symbol = s.text;
    if (n.altered || s.altered) f.ft_metadata_non_ascii = true;
  }
  const errors = [rec.keys_error, rec.activity_error, rec.ft_error].filter(Boolean);
  if (errors.length) f.enrichment_error = errors.join("; ");
  return f;
}

function seedEntry(seed, label, rec) {
  const facts = factsFrom(rec);
  if (label === "suspicious") {
    facts.source_type = seed.source_type;
    facts.incident = seed.incident;
  }
  if (label === "known_good") facts.stems = seed.stems;
  let notes = seed.notes;
  if (!rec.view.exists) notes += " The account does not exist at the checked block (deleted); an implicit id can be re-created by any transfer, so it stays listed.";
  return {
    account_id: seed.account_id,
    network: "mainnet",
    label,
    category: seed.category,
    evidence: seed.evidence,
    exists: rec.view.exists,
    checked_at: rec.checked_at,
    notes,
    facts,
  };
}

async function loadMimicWatch() {
  try {
    const res = await fetch(MIMICWATCH_SCAN, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const map = new Map();
    for (const f of json.findings ?? []) map.set(f.id, `${f.label}/${f.severity}`);
    log(`MimicWatch 2026-11-01 scan loaded: ${map.size} findings`);
    return map;
  } catch (err) {
    log(`MimicWatch scan not loaded (${err.message}); overlaps are not annotated`);
    return null;
  }
}

// Facts a lookalike row derives from the generator or from other rows; they are recomputed on
// every build (also for rows kept by --skip-lookalikes), never carried over.
const DERIVED_FACTS = ["imitates", "stem", "rule", "created_by_brand", "creator_lookalikes", "predates_brand"];

function lookalikeRow(c, checkedAt, base) {
  const facts = { ...base };
  for (const k of DERIVED_FACTS) delete facts[k];
  Object.assign(facts, { imitates: c.imitates, stem: c.stem, rule: c.rule });
  return {
    account_id: c.account_id,
    network: "mainnet",
    label: "lookalike_candidate",
    category: c.rule,
    evidence: [{ url: `https://nearblocks.io/address/${c.account_id}`, date: checkedAt.slice(0, 10), quote: derivedQuote(c, facts) }],
    exists: true,
    checked_at: checkedAt,
    notes: LOOKALIKE_NOTE,
    facts,
  };
}

async function main() {
  const started = nowIso();
  log(`seeds: ${knownSeeds.length} known_good, ${suspiciousSeeds.length} suspicious; cache ${Object.keys(cache).length} rows${REFRESH ? " (ignored: --refresh)" : ""}`);

  const known = await mapPool(knownSeeds, WORKERS, async (s) => seedEntry(s, "known_good", await liveCheck(s.account_id, { full: true })));
  const suspicious = await mapPool(suspiciousSeeds, WORKERS, async (s) => seedEntry(s, "suspicious", await liveCheck(s.account_id, { full: true })));
  saveCache(true);
  for (const e of known) if (!e.exists) log(`WARNING known_good ${e.account_id} does not exist`);
  log(`seeds checked: known_good exist ${known.filter((e) => e.exists).length}/${known.length}, suspicious exist ${suspicious.filter((e) => e.exists).length}/${suspicious.length}`);

  // The generator is pure and offline, so it runs on every build: a suspicious seed whose name it
  // also produces gets the rule noted (the benchmark can then tell lookalike-named bad accounts
  // from the others), with or without the sweep.
  const candidates = generateLookalikes(knownSeeds);
  const candidateById = new Map(candidates.map((c) => [c.account_id, c]));
  for (const e of suspicious) {
    const c = candidateById.get(e.account_id);
    if (c) Object.assign(e.facts, { lookalike_of: c.imitates, lookalike_rule: c.rule });
  }

  let lookalikes = [];
  let sweep = { generated: candidates.length, existing: 0, missing: 0, unchecked: 0, by_rule_existing: {} };
  if (!SKIP_LOOKALIKES) {
    const seedIds = new Set([...knownSeeds, ...suspiciousSeeds].map((s) => s.account_id));
    const mimic = await loadMimicWatch();
    // Phase 1: existence only (RPC pool, fast). Phase 2: enrich the names that exist (the
    // indexer is the slow, single-host part, so it runs on its own after phase 1).
    let done = 0;
    const phase1 = await mapPool(candidates, WORKERS + 4, async (c) => {
      try {
        const rec = await liveCheck(c.account_id, { full: false });
        if (++done % 250 === 0) log(`existence ${done}/${candidates.length}`);
        return { c, rec };
      } catch (err) {
        log(`unchecked ${c.account_id}: ${err.message}`);
        return { c, rec: null };
      }
    });
    saveCache(true);
    const existing = phase1.filter((r) => r.rec?.view.exists);
    log(`phase 1 done: ${existing.length} of ${candidates.length} names exist; enriching`);
    done = 0;
    const rows = await mapPool(phase1, WORKERS, async ({ c, rec }) => {
      if (!rec || !rec.view.exists) return { c, rec };
      try {
        const full = await liveCheck(c.account_id, { full: true });
        if (++done % 50 === 0) log(`enriched ${done}/${existing.length}`);
        return { c, rec: full };
      } catch (err) {
        log(`enrichment failed ${c.account_id}: ${err.message}`);
        return { c, rec, error: err.message };
      }
    });
    saveCache(true);
    for (const { c, rec, error } of rows) {
      if (!rec) {
        sweep.unchecked++;
        continue;
      }
      if (!rec.view.exists) {
        sweep.missing++;
        continue;
      }
      sweep.existing++;
      sweep.by_rule_existing[c.rule] = (sweep.by_rule_existing[c.rule] ?? 0) + 1;
      if (seedIds.has(c.account_id)) continue; // already labeled from a cited source
      const base = factsFrom(rec);
      if (error) base.enrichment_error = [base.enrichment_error, error].filter(Boolean).join("; ");
      if (mimic?.has(c.account_id)) base.mimicwatch_2026_11_01 = mimic.get(c.account_id);
      lookalikes.push(lookalikeRow(c, rec.checked_at, base));
    }
    if (!mimic) sweep.mimicwatch = "not loaded: overlaps not annotated";
    log(`sweep: ${sweep.generated} generated, ${sweep.existing} exist, ${sweep.missing} missing, ${sweep.unchecked} unchecked`);
  } else {
    // Keep the previous sweep when only the cited rows were refreshed: its rows (only those the
    // current generator still produces) and its counts, marked as carried over.
    if (fs.existsSync(OUT)) {
      const previous = readJson(OUT).filter((e) => e.label === "lookalike_candidate");
      const kept = previous.filter((e) => candidateById.has(e.account_id));
      if (kept.length < previous.length) log(`WARNING ${previous.length - kept.length} previous lookalike rows are no longer generated and were dropped; run the full sweep`);
      lookalikes = kept.map((e) => lookalikeRow(candidateById.get(e.account_id), e.checked_at, e.facts));
      log(`kept ${lookalikes.length} lookalike_candidate rows from the previous ${path.basename(OUT)}`);
    }
    const prev = fs.existsSync(SUMMARY_OUT) ? readJson(SUMMARY_OUT) : null;
    sweep =
      prev && typeof prev.lookalike_sweep === "object" && prev.lookalike_sweep
        ? { ...prev.lookalike_sweep, carried_from: prev.lookalike_sweep.carried_from ?? prev.generated_at }
        : { skipped: true, note: "no previous sweep summary" };
  }
  annotateLookalikes(lookalikes, known, knownSeeds);

  const byId = (a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0);
  const dataset = [...known.sort(byId), ...suspicious.sort(byId), ...lookalikes.sort(byId)];
  fs.writeFileSync(OUT, JSON.stringify(dataset, null, 2) + "\n");

  const count = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] ?? 0) + 1), m), {});
  const heights = dataset.map((e) => e.facts.block_height).filter((h) => typeof h === "number");
  const checkedTimes = dataset.map((e) => e.checked_at).sort();
  const snapshotDay = checkedTimes.length ? checkedTimes[checkedTimes.length - 1].slice(0, 10) : TODAY;
  const thirtyDaysBefore = new Date(Date.parse(`${snapshotDay}T00:00:00Z`) - 30 * 86400_000).toISOString().slice(0, 10);
  const summary = {
    generated_at: nowIso(),
    started_at: started,
    network: "mainnet",
    dataset: path.basename(OUT),
    generator: GENERATOR_VERSION,
    sources: {
      rpc: reader.rpcs,
      archival_rpc: MAINNET_ARCHIVAL_RPC,
      tx_indexer: FASTNEAR_TX_API,
      mimicwatch_scan: MIMICWATCH_SCAN,
    },
    counts: {
      known_good: known.length,
      known_good_existing: known.filter((e) => e.exists).length,
      suspicious: suspicious.length,
      suspicious_existing: suspicious.filter((e) => e.exists).length,
      suspicious_named_by_third_party: suspicious.filter((e) => e.facts.source_type !== "onchain_campaign_link").length,
      lookalike_candidate: lookalikes.length,
    },
    suspicious_by_source_type: count(suspicious.map((e) => e.facts), "source_type"),
    suspicious_by_category: count(suspicious, "category"),
    known_good_by_category: count(known, "category"),
    lookalike_sweep: sweep,
    lookalike_by_rule: count(lookalikes, "category"),
    lookalike_flags: {
      created_by_brand: lookalikes.filter((e) => e.facts.created_by_brand).length,
      predates_brand: lookalikes.filter((e) => e.facts.predates_brand === true).length,
      mimicwatch_overlap: lookalikes.filter((e) => e.facts.mimicwatch_2026_11_01).length,
      created_in_30_days_before_snapshot: lookalikes.filter((e) => e.facts.created_at && e.facts.created_at.slice(0, 10) >= thirtyDaysBefore).length,
      enrichment_error: lookalikes.filter((e) => e.facts.enrichment_error).length,
    },
    block_height_range: heights.length ? [Math.min(...heights), Math.max(...heights)] : null,
    // When each row's view_account ran. Keys and token metadata were read at the same block;
    // the indexer facts (txs_count, last_tx_at) were read the same UTC day.
    checked_at_window: checkedTimes.length ? [checkedTimes[0], checkedTimes[checkedTimes.length - 1]] : null,
    cache: {
      file: path.relative(HERE, CACHE_FILE),
      refresh: REFRESH,
      accounts_from_cache: [...fromCache].filter((id) => !readLive.has(id)).length,
      accounts_read_live: readLive.size,
    },
    // Network requests of this run only: all zero when every answer came from the cache.
    requests: reader.stats,
  };
  fs.writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2) + "\n");
  log(`wrote ${path.relative(process.cwd(), OUT)} (${dataset.length} rows) and ${path.relative(process.cwd(), SUMMARY_OUT)}`);
}

main().catch((err) => {
  saveCache(true);
  console.error(err);
  process.exit(1);
});

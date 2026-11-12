#!/usr/bin/env node
// Live spot check of the published dataset, sized for a reviewer's few minutes (1 to 2 minutes
// on keyless endpoints). It re-reads, from mainnet and with no cache, every cited row
// (known_good and suspicious) plus a random sample of lookalike_candidate rows, and compares
// what it reads with scan/dataset.json.
//
//   node scan/spot-check.mjs                  all cited rows + 20 random lookalike rows
//   node scan/spot-check.mjs --sample 50      a larger lookalike sample
//   node scan/spot-check.mjs --seed 12345     repeat a previous sample (every run prints its seed)
//   node scan/spot-check.mjs --keys           also replay the access-key counts (one more call a row)
//   node scan/spot-check.mjs --json           machine-readable report on stdout
//
// Three comparisons:
//   replay   view_account AT the row's recorded block (facts.block_height): exists, code_hash and
//            balance_near (with --keys, the access-key counts too) must equal the dataset.
//            History does not change, so a difference is an error in the dataset. Once regular
//            nodes have garbage-collected the block, the archival node answers.
//   history  for each sampled lookalike row, the FastNEAR indexer's oldest transaction:
//            created_at, creation_tx and creator must equal the dataset.
//   now      view_account at the latest final block. Drift since the snapshot (an account deleted
//            or created, a contract upgraded) is reported, not counted as an error.
// Exit code 1 on any mismatch or on a row that could not be read (re-run later: free endpoints
// rate-limit). Read-only throughout: JSON-RPC view calls and indexer reads, no keys.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NearReader, mapPool, nsToIso, yoctoToNear } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const JSON_OUT = args.includes("--json");
const KEYS = args.includes("--keys");
const SAMPLE = Number(opt("--sample", "20"));
const SEED = Number(opt("--seed", String(Date.now() % 2147483647)));
if (!Number.isInteger(SAMPLE) || SAMPLE < 0 || !Number.isInteger(SEED)) {
  console.error("usage: node scan/spot-check.mjs [--sample N] [--seed N] [--keys] [--json]");
  process.exit(2);
}

// Small seeded PRNG (mulberry32), so a sample can be repeated with --seed.
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleRows(rows, n, seed) {
  const rand = mulberry32(seed);
  const pool = [...rows].sort((a, b) => (a.account_id < b.account_id ? -1 : 1));
  const k = Math.min(n, pool.length);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k).sort((a, b) => (a.account_id < b.account_id ? -1 : 1));
}

async function checkRow(reader, row, { history }) {
  const f = row.facts ?? {};
  const out = { account_id: row.account_id, label: row.label, mismatches: [], drift: [] };
  const differ = (what, published, live) => {
    if (published !== live) out.mismatches.push(`${what}: dataset ${JSON.stringify(published)}, chain ${JSON.stringify(live)}`);
  };
  if (typeof f.block_height !== "number") throw new Error("no recorded block in the dataset");
  // Replay at the recorded block.
  const then = await reader.viewAccount(row.account_id, { block_id: f.block_height });
  differ(`exists at block ${f.block_height}`, row.exists, then.exists);
  if (row.exists && then.exists) {
    differ("code_hash", f.code_hash, then.code_hash);
    differ("balance_near", f.balance_near, yoctoToNear(then.amount));
    if (KEYS && typeof f.full_access_keys === "number") {
      const keys = await reader.accessKeySummary(row.account_id, { block_id: f.block_height });
      differ("full_access_keys", f.full_access_keys, keys.full_access_keys);
      differ("function_call_keys", f.function_call_keys, keys.function_call_keys);
    }
  }
  // Indexer history of the account (sampled lookalike rows).
  if (history && row.exists) {
    if (!f.created_at) {
      out.history = "not comparable: the dataset has no creation for this row";
    } else {
      const first = await reader.accountTxs(row.account_id, { limit: 1, desc: false });
      const tx = first.account_txs[0];
      differ("created_at", f.created_at, tx ? nsToIso(tx.tx_block_timestamp) : null);
      differ("creation_tx", f.creation_tx, tx ? tx.transaction_hash : null);
      if (tx && f.creator) {
        const [t] = await reader.transactions([tx.transaction_hash]);
        differ("creator", f.creator, t?.transaction?.signer_id ?? null);
      }
      out.history = "compared";
    }
  }
  // Now, at the latest final block.
  const now = await reader.viewAccount(row.account_id);
  if (now.exists !== row.exists) out.drift.push(now.exists ? "exists now (re-created or created since)" : "no longer exists (deleted since)");
  else if (now.exists && now.code_hash !== f.code_hash) out.drift.push("contract code changed since the snapshot");
  return out;
}

async function main() {
  const dataset = JSON.parse(fs.readFileSync(path.join(HERE, "dataset.json"), "utf8"));
  const cited = dataset.filter((e) => e.label === "known_good" || e.label === "suspicious");
  const lookalikes = dataset.filter((e) => e.label === "lookalike_candidate");
  const sampled = sampleRows(lookalikes, SAMPLE, SEED);
  const reader = new NearReader({ log: JSON_OUT ? () => {} : (m) => console.error(`  (${m})`) });
  // Monotonic clock (immune to wall-clock adjustments; a machine that sleeps mid-run still
  // counts the sleep).
  const started = process.hrtime.bigint();
  if (!JSON_OUT) {
    console.log("spot check of scan/dataset.json against NEAR mainnet (live reads, no cache)");
    console.log(`rows: ${cited.filter((e) => e.label === "known_good").length} known_good, ${cited.filter((e) => e.label === "suspicious").length} suspicious, ${sampled.length} of ${lookalikes.length} lookalike_candidate (seed ${SEED})`);
  }
  const jobs = [...cited.map((row) => ({ row, history: false })), ...sampled.map((row) => ({ row, history: true }))];
  const results = await mapPool(jobs, 6, async ({ row, history }) => {
    try {
      return await checkRow(reader, row, { history });
    } catch (err) {
      return { account_id: row.account_id, label: row.label, error: err.message, mismatches: [], drift: [] };
    }
  });
  const unreadable = results.filter((r) => r.error);
  const mismatched = results.filter((r) => r.mismatches.length);
  const drifted = results.filter((r) => r.drift.length);
  const historyCompared = results.filter((r) => r.history === "compared");
  const report = {
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    seed: SEED,
    rows: results.length,
    sampled_lookalikes: sampled.map((e) => e.account_id),
    replay_fields: KEYS ? ["exists", "code_hash", "balance_near", "full_access_keys", "function_call_keys"] : ["exists", "code_hash", "balance_near"],
    replay_and_history_match: results.length - mismatched.length - unreadable.length,
    history_compared: historyCompared.length,
    mismatches: mismatched.map((r) => ({ account_id: r.account_id, label: r.label, mismatches: r.mismatches })),
    unreadable: unreadable.map((r) => ({ account_id: r.account_id, error: r.error })),
    drift: drifted.map((r) => ({ account_id: r.account_id, label: r.label, drift: r.drift })),
    requests: reader.stats,
    seconds: Number((process.hrtime.bigint() - started) / 1_000_000n) / 1000,
    pass: mismatched.length === 0 && unreadable.length === 0,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`replay at the recorded block (${report.replay_fields.join(", ")}) and, for the ${historyCompared.length} sampled lookalikes, indexer history (created_at, creation_tx, creator): ${report.replay_and_history_match}/${results.length} rows match`);
    for (const m of report.mismatches) console.log(`  MISMATCH ${m.account_id} [${m.label}]: ${m.mismatches.join("; ")}`);
    for (const u of report.unreadable) console.log(`  UNREADABLE ${u.account_id}: ${u.error}`);
    console.log(`drift since the snapshot (latest final block; reported, not an error): ${report.drift.length} rows`);
    for (const d of report.drift) console.log(`  ${d.account_id} [${d.label}]: ${d.drift.join("; ")}`);
    console.log(`${report.requests.requests} requests (${report.requests.archival} answered by the archival node), ${report.seconds} s; repeat this sample with --seed ${SEED}`);
    console.log(report.pass ? "PASS" : "FAIL");
  }
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

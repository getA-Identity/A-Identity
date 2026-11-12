#!/usr/bin/env node
// Scores engine verdicts against scan/dataset.json, following the benchmark protocol in
// scan/README.md: positives are `suspicious` rows, negatives are `known_good` rows, two
// operating points (strict: DENY; cautious: WARN or DENY), misses listed by name, and the
// verdict mix on `lookalike_candidate` rows reported but never scored.
//
//   node scan/score.mjs verdicts.json                 human summary
//   node scan/score.mjs verdicts.json --json          machine-readable
//   node scan/score.mjs verdicts.json --with-labels   score a run that used label-derived
//                                                     signals, printed as NOT a benchmark result
//
// verdicts.json declares how the verdicts were made, so a reader can rule out label leakage:
//
//   {
//     "engine": "a-identity-near-engine/1.1.0",       free text, printed
//     "signals": ["account", "keys", "fastnear", ...], the signals that were switched on
//     "labels_used": false,                            true if any signal read this dataset's
//                                                      labels or their sources (README, rule 1)
//     "verdicts": {"<account_id>": "ALLOW" | "WARN" | "DENY", ...}
//   }
//
// verdicts may also be an array of {account_id, verdict}. Any other verdict string (or a
// missing row) counts as "NONE". A file without the declaration is refused (exit 2), and so is
// labels_used: true unless --with-labels is given (exit 3).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERDICTS = new Set(["ALLOW", "WARN", "DENY"]);

export function normalizeVerdicts(input) {
  const map = new Map();
  const rows = Array.isArray(input) ? input.map((r) => [r.account_id, r.verdict]) : Object.entries(input ?? {});
  for (const [id, v] of rows) {
    const verdict = String(v ?? "").toUpperCase();
    map.set(id, VERDICTS.has(verdict) ? verdict : "NONE");
  }
  return map;
}

// Reads the declared verdicts file. Throws with code "UNDECLARED" for a file that does not say
// which signals produced it, and "LABELS_USED" for one whose signals read the labels.
export function parseVerdictsFile(json, { allowLabels = false } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!json || typeof json !== "object" || Array.isArray(json) || !("verdicts" in json)) {
    throw fail("UNDECLARED", 'verdicts file must be {"signals": [...], "labels_used": false, "verdicts": {...}} (see scan/README.md, benchmark protocol)');
  }
  if (!Array.isArray(json.signals) || json.signals.length === 0 || !json.signals.every((s) => typeof s === "string")) {
    throw fail("UNDECLARED", "verdicts file must list the signals that were switched on (signals: non-empty array of strings)");
  }
  if (typeof json.labels_used !== "boolean") throw fail("UNDECLARED", "verdicts file must say labels_used: true or false");
  if (json.labels_used && !allowLabels) {
    throw fail("LABELS_USED", "labels_used is true: the verdicts read this dataset's labels or their sources, so precision and recall would be inflated. Re-run the engine with those signals off, or pass --with-labels to print a result marked as not a benchmark.");
  }
  const declaration = { engine: typeof json.engine === "string" ? json.engine : null, signals: json.signals, labels_used: json.labels_used };
  return { declaration, verdicts: normalizeVerdicts(json.verdicts) };
}

function rates(tp, fp, fn) {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  return { tp, fp, fn, precision, recall };
}

export function score(dataset, verdictMap) {
  const v = (id) => verdictMap.get(id) ?? "NONE";
  const suspicious = dataset.filter((e) => e.label === "suspicious");
  const known = dataset.filter((e) => e.label === "known_good");
  const lookalikes = dataset.filter((e) => e.label === "lookalike_candidate");
  const point = (isPositive) => {
    const tp = suspicious.filter((e) => isPositive(v(e.account_id))).length;
    const fn = suspicious.length - tp;
    const fp = known.filter((e) => isPositive(v(e.account_id))).length;
    return rates(tp, fp, fn);
  };
  const strict = (x) => x === "DENY";
  const cautious = (x) => x === "DENY" || x === "WARN";
  const recallBy = (rows, key) => {
    const out = {};
    for (const e of rows) {
      const k = key(e);
      out[k] ??= { rows: 0, caught_cautious: 0, caught_strict: 0 };
      out[k].rows++;
      if (cautious(v(e.account_id))) out[k].caught_cautious++;
      if (strict(v(e.account_id))) out[k].caught_strict++;
    }
    return out;
  };
  const mix = (rows) => rows.reduce((m, e) => ((m[v(e.account_id)] = (m[v(e.account_id)] ?? 0) + 1), m), {});
  const age = (e) => (e.facts?.predates_brand === true ? "predates_brand" : e.facts?.predates_brand === false ? "after_brand" : "unknown");
  return {
    rows: { suspicious: suspicious.length, known_good: known.length, lookalike_candidate: lookalikes.length },
    strict: point(strict),
    cautious: point(cautious),
    missed_suspicious: suspicious.filter((e) => !cautious(v(e.account_id))).map((e) => ({ account_id: e.account_id, verdict: v(e.account_id), category: e.category, source_type: e.facts?.source_type, exists: e.exists })),
    flagged_known_good: known.filter((e) => cautious(v(e.account_id))).map((e) => ({ account_id: e.account_id, verdict: v(e.account_id), category: e.category })),
    suspicious_by_source_type: recallBy(suspicious, (e) => e.facts?.source_type ?? "unknown"),
    suspicious_by_exists: recallBy(suspicious, (e) => (e.exists ? "exists" : "deleted")),
    lookalike_verdicts: mix(lookalikes),
    // A name created before every known_good account of its brand is unlikely to have been
    // registered to imitate it, so a DENY there is likely over-blocking; the mix is reported
    // per side of that line.
    lookalike_verdicts_by_age: {
      predates_brand: mix(lookalikes.filter((e) => age(e) === "predates_brand")),
      after_brand: mix(lookalikes.filter((e) => age(e) === "after_brand")),
      unknown: mix(lookalikes.filter((e) => age(e) === "unknown")),
    },
    lookalike_created_by_brand_denied: lookalikes.filter((e) => e.facts?.created_by_brand && v(e.account_id) === "DENY").map((e) => e.account_id),
    lookalike_predates_brand_denied: lookalikes.filter((e) => e.facts?.predates_brand === true && v(e.account_id) === "DENY").map((e) => e.account_id),
    unscored: [...suspicious, ...known].filter((e) => v(e.account_id) === "NONE").map((e) => e.account_id),
  };
}

const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

function main() {
  const [file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node scan/score.mjs verdicts.json [--json] [--with-labels]");
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dataset = JSON.parse(fs.readFileSync(path.join(here, "dataset.json"), "utf8"));
  let parsed;
  try {
    parsed = parseVerdictsFile(JSON.parse(fs.readFileSync(file, "utf8")), { allowLabels: process.argv.includes("--with-labels") });
  } catch (err) {
    if (!err.code) throw err;
    console.error(`refused: ${err.message}`);
    process.exit(err.code === "LABELS_USED" ? 3 : 2);
  }
  const { declaration: d } = parsed;
  const result = { declaration: d, benchmark: !d.labels_used, ...score(dataset, parsed.verdicts) };
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const r = result;
  if (!r.benchmark) console.log("NOT A BENCHMARK RESULT: labels_used is true, so these numbers are inflated by label leakage.");
  console.log(`engine: ${d.engine ?? "(not given)"}; signals: ${d.signals.join(", ")}; labels_used: ${d.labels_used}`);
  console.log(`rows: ${r.rows.suspicious} suspicious (positives), ${r.rows.known_good} known_good (negatives), ${r.rows.lookalike_candidate} lookalike_candidate (not scored)`);
  for (const [name, p] of [["strict (DENY)", r.strict], ["cautious (WARN or DENY)", r.cautious]]) {
    console.log(`${name}: precision ${pct(p.precision)}, recall ${pct(p.recall)} (tp ${p.tp}, fp ${p.fp}, fn ${p.fn})`);
  }
  console.log(`missed suspicious (${r.missed_suspicious.length}):`);
  for (const m of r.missed_suspicious) console.log(`  ${m.verdict.padEnd(5)} ${m.account_id} [${m.category}, ${m.source_type}${m.exists ? "" : ", deleted"}]`);
  console.log(`flagged known_good (${r.flagged_known_good.length}):`);
  for (const m of r.flagged_known_good) console.log(`  ${m.verdict.padEnd(5)} ${m.account_id} [${m.category}]`);
  console.log(`lookalike_candidate verdicts: ${JSON.stringify(r.lookalike_verdicts)}`);
  console.log(`  created after the brand: ${JSON.stringify(r.lookalike_verdicts_by_age.after_brand)}; before it: ${JSON.stringify(r.lookalike_verdicts_by_age.predates_brand)}; unknown: ${JSON.stringify(r.lookalike_verdicts_by_age.unknown)}`);
  console.log(`  over-blocking flags: DENY on brand-created names ${r.lookalike_created_by_brand_denied.length}, DENY on names older than the brand ${r.lookalike_predates_brand_denied.length}`);
  if (r.unscored.length) console.log(`no verdict for ${r.unscored.length} scored rows`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

// Offline checks of the benchmark scorer on a tiny synthetic dataset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { score, normalizeVerdicts, parseVerdictsFile } from "./score.mjs";

const rows = [
  { account_id: "good-a.near", label: "known_good", category: "dex", exists: true, facts: {} },
  { account_id: "good-b.near", label: "known_good", category: "token", exists: true, facts: {} },
  { account_id: "bad-a.near", label: "suspicious", category: "exploiter", exists: true, facts: { source_type: "security_writeup" } },
  { account_id: "bad-b.near", label: "suspicious", category: "phishing_receiver", exists: true, facts: { source_type: "victim_report" } },
  { account_id: "bad-c.near", label: "suspicious", category: "exploiter", exists: false, facts: { source_type: "security_writeup" } },
  { account_id: "look-a.near", label: "lookalike_candidate", category: "homoglyph", exists: true, facts: { created_by_brand: true, predates_brand: false } },
  { account_id: "look-b.near", label: "lookalike_candidate", category: "affix", exists: true, facts: { predates_brand: true } },
  { account_id: "look-c.near", label: "lookalike_candidate", category: "affix", exists: true, facts: {} },
];

test("strict and cautious operating points, misses named", () => {
  const r = score(rows, normalizeVerdicts({ "good-a.near": "ALLOW", "good-b.near": "WARN", "bad-a.near": "DENY", "bad-b.near": "WARN", "bad-c.near": "ALLOW", "look-a.near": "DENY" }));
  assert.deepEqual(r.strict, { tp: 1, fp: 0, fn: 2, precision: 1, recall: 1 / 3 });
  assert.deepEqual(r.cautious, { tp: 2, fp: 1, fn: 1, precision: 2 / 3, recall: 2 / 3 });
  assert.deepEqual(r.missed_suspicious.map((m) => m.account_id), ["bad-c.near"]);
  assert.deepEqual(r.flagged_known_good.map((m) => m.account_id), ["good-b.near"]);
  assert.deepEqual(r.suspicious_by_exists.deleted, { rows: 1, caught_cautious: 0, caught_strict: 0 });
  assert.deepEqual(r.lookalike_created_by_brand_denied, ["look-a.near"]);
  assert.deepEqual(r.unscored, []);
});

test("missing or unknown verdicts count as NONE, never as a catch", () => {
  const r = score(rows, normalizeVerdicts([{ account_id: "bad-a.near", verdict: "deny" }, { account_id: "bad-b.near", verdict: "MAYBE" }]));
  assert.equal(r.cautious.tp, 1);
  assert.deepEqual(r.unscored.sort(), ["bad-b.near", "bad-c.near", "good-a.near", "good-b.near"]);
});

test("lookalike verdicts are split by whether the name predates the brand", () => {
  const r = score(rows, normalizeVerdicts({ "look-a.near": "WARN", "look-b.near": "DENY", "look-c.near": "ALLOW" }));
  assert.deepEqual(r.lookalike_verdicts_by_age, { predates_brand: { DENY: 1 }, after_brand: { WARN: 1 }, unknown: { ALLOW: 1 } });
  assert.deepEqual(r.lookalike_predates_brand_denied, ["look-b.near"]);
});

test("a verdicts file must declare its signals, and label-derived runs are refused", () => {
  const verdicts = { "bad-a.near": "DENY" };
  const ok = parseVerdictsFile({ engine: "e/1", signals: ["account", "keys"], labels_used: false, verdicts });
  assert.deepEqual(ok.declaration, { engine: "e/1", signals: ["account", "keys"], labels_used: false });
  assert.equal(ok.verdicts.get("bad-a.near"), "DENY");
  const code = (fn) => {
    try {
      fn();
    } catch (err) {
      return err.code;
    }
    return "accepted";
  };
  assert.equal(code(() => parseVerdictsFile(verdicts)), "UNDECLARED", "a bare verdict map has no declaration");
  assert.equal(code(() => parseVerdictsFile([{ account_id: "bad-a.near", verdict: "DENY" }])), "UNDECLARED");
  assert.equal(code(() => parseVerdictsFile({ signals: [], labels_used: false, verdicts })), "UNDECLARED");
  assert.equal(code(() => parseVerdictsFile({ signals: ["account"], verdicts })), "UNDECLARED", "labels_used must be stated");
  assert.equal(code(() => parseVerdictsFile({ signals: ["registry"], labels_used: true, verdicts })), "LABELS_USED");
  assert.equal(parseVerdictsFile({ signals: ["registry"], labels_used: true, verdicts }, { allowLabels: true }).declaration.labels_used, true);
});

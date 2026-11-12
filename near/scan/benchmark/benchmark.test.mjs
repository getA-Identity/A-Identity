// Offline checks of the committed benchmark in scan/benchmark. No network.
//
//   node --experimental-strip-types --no-warnings=ExperimentalWarning --test scan/benchmark/benchmark.test.mjs
//   (from near/, Node >= 22.22.2)
//
// 1. Re-scores verdicts.json, verdicts.leave-self-out.json and verdicts.no-known.json with
//    scan/score.mjs, and checks that RESULTS.md quotes each scorer run as one whole block.
// 2. Recomputes, with this file's own code and not report.mjs's, the Result table, the confusion
//    and recall tables, the lookalike stratum table, the WARN split and the leave-self-out numbers
//    from the verdict files, and finds each in RESULTS.md; names every suspicious row and every
//    false positive with its verdict.
// 3. report.mjs --check: RESULTS.md is exactly what RESULTS.template.md and the committed files
//    produce.
// 4. Re-derives verdicts from committed snapshots with the engine's own CLI in --offline mode (at
//    least 10 accounts, covering every verdict and every combination of deciding reasons) and
//    asserts the same verdict, score, reasons, block and both digests.
// 5. Rebuilds the three verdict files from every snapshot (run.mjs --offline --check): byte for byte.
// 6. Checks the label-independence claims on every snapshot: the known list is known-brands.json,
//    no third-party registry, no A-Identity registry, no vault, mainnet reads only, one block; the
//    verdict files carry no label; the leave-self-out replay changes only listed accounts.
// 7. Re-derives the lookalike sample from dataset.json and the seed.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseVerdictsFile, score } from "../score.mjs";
import { SAMPLE, sampleLookalikes, selectAccounts } from "./run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEAR = path.resolve(HERE, "..", "..");
const TS = ["--experimental-strip-types", "--no-warnings=ExperimentalWarning"];
const read = (file) => JSON.parse(fs.readFileSync(path.join(HERE, file), "utf8"));

const dataset = JSON.parse(fs.readFileSync(path.join(HERE, "..", "dataset.json"), "utf8"));
const verdicts = read("verdicts.json");
const leaveSelfOut = read("verdicts.leave-self-out.json");
const ablation = read("verdicts.no-known.json");
const knownDoc = read("known-brands.json");
const results = fs.readFileSync(path.join(HERE, "RESULTS.md"), "utf8");
/** RESULTS.md with every run of whitespace folded to one space, for prose that wraps. */
const flat = results.replace(/\s+/g, " ");
const labelOf = new Map(dataset.map((r) => [r.account_id, r.label]));
const known = [...new Set(knownDoc.accounts)].sort();
const node = (args) => execFileSync(process.execPath, args, { cwd: NEAR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const VERDICT_FILES = [
  ["verdicts.json", verdicts],
  ["verdicts.leave-self-out.json", leaveSelfOut],
  ["verdicts.no-known.json", ablation],
];

/** The fenced blocks in RESULTS.md that start with "$ <command>", without that line. */
function quotedRuns(command) {
  const head = `\`\`\`\n$ ${command}\n`;
  const out = [];
  for (let i = results.indexOf(head); i >= 0; i = results.indexOf(head, i + 1)) {
    const start = i + head.length;
    const end = results.indexOf("\n```", start);
    assert.ok(end > start, `unterminated block after $ ${command}`);
    out.push(results.slice(start, end));
  }
  return out;
}

/** The text of one "## " section of RESULTS.md. */
function section(title) {
  const start = results.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `RESULTS.md has a "${title}" section`);
  const end = results.indexOf("\n## ", start + 1);
  return results.slice(start, end < 0 ? undefined : end);
}

const has = (line) => assert.ok(results.includes(`${line}\n`), `RESULTS.md does not hold the line: ${line}`);
const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const precisionOf = (p, none) => (p.precision === null ? `n/a (${none})` : `${pct(p.precision)} (${p.tp} of ${p.tp + p.fp})`);
const recallOf = (p) => `${pct(p.recall)} (${p.tp} of ${p.tp + p.fn})`;
const scored = (doc) => score(dataset, parseVerdictsFile(doc).verdicts);

describe("benchmark: scoring", () => {
  for (const [file, doc] of VERDICT_FILES) {
    it(`${file} is a declared, label-free verdicts file that score.mjs accepts`, () => {
      const { declaration, verdicts: map } = parseVerdictsFile(doc);
      assert.equal(declaration.labels_used, false);
      assert.ok(declaration.signals.length > 0);
      for (const s of declaration.signals) assert.doesNotMatch(s, /third_party|mimicwatch|registry|vault|label/i, `signal ${s} would read labels or their sources`);
      const r = score(dataset, map);
      assert.deepEqual(r.unscored, [], "every suspicious and known_good row has a verdict");
      const lookalikes = doc.verdicts.filter((v) => labelOf.get(v.account_id) === "lookalike_candidate");
      assert.equal(lookalikes.length, SAMPLE.size);
      assert.equal(doc.verdicts.length, r.rows.suspicious + r.rows.known_good + SAMPLE.size);
      for (const v of doc.verdicts) {
        assert.ok(labelOf.has(v.account_id), `${v.account_id} is a dataset row`);
        for (const key of ["label", "category", "source_type", "evidence", "notes"]) assert.equal(key in v, false, `${v.account_id} carries ${key}`);
      }
    });

    it(`RESULTS.md quotes node scan/score.mjs scan/benchmark/${file} as one whole block`, () => {
      const out = node([path.join("scan", "score.mjs"), path.join("scan", "benchmark", file)]).replace(/\n+$/, "");
      assert.ok(out.split("\n").length > 5);
      const blocks = quotedRuns(`node scan/score.mjs scan/benchmark/${file}`);
      assert.equal(blocks.length, 1, `quoted exactly once, found ${blocks.length}`);
      assert.equal(blocks[0], out);
    });
  }
});

describe("benchmark: RESULTS.md tables, recomputed from the verdict files", () => {
  const main = scored(verdicts);
  const self = scored(leaveSelfOut);
  const abl = scored(ablation);
  const v = new Map(verdicts.verdicts.map((e) => [e.account_id, e]));
  const a = new Map(ablation.verdicts.map((e) => [e.account_id, e]));
  const rankOf = new Map(knownDoc.ranking.map((r) => [r.account_id, r.rank]));

  it("the Result table", () => {
    for (const [name, p, none] of [
      ["strict: DENY counts as flagged", main.strict, "no DENY issued"],
      ["cautious: WARN or DENY counts as flagged", main.cautious, "nothing flagged"],
      ["strict, listed payees not exempt (leave-self-out)", self.strict, "no DENY issued"],
      ["cautious, listed payees not exempt (leave-self-out)", self.cautious, "nothing flagged"],
      ["strict, without the brand list (ablation)", abl.strict, "no DENY issued"],
      ["cautious, without the brand list (ablation)", abl.cautious, "nothing flagged"],
    ]) {
      has(`| ${name} | ${precisionOf(p, none)} | ${recallOf(p)} | ${p.tp} | ${p.fp} | ${p.fn} |`);
    }
  });

  it("the confusion table", () => {
    for (const [label, name] of [
      ["suspicious", "suspicious (positives)"],
      ["known_good", "known_good (negatives)"],
    ]) {
      const rows = dataset.filter((r) => r.label === label);
      const n = (verdict) => rows.filter((r) => v.get(r.account_id).verdict === verdict).length;
      has(`| ${name} | ${n("ALLOW")} | ${n("WARN")} | ${n("DENY")} | ${rows.length} |`);
    }
  });

  it("the recall table by kind of evidence and by existence", () => {
    const groups = [
      ...Object.entries(main.suspicious_by_source_type).map(([k, x]) => [`\`${k}\``, x]),
      ["exist at the block", main.suspicious_by_exists.exists],
      ["deleted (`exists: false`)", main.suspicious_by_exists.deleted],
    ];
    assert.equal(groups.reduce((n, [k, x]) => n + (k.startsWith("`") ? x.rows : 0), 0), main.rows.suspicious);
    for (const [name, x] of groups) {
      const line = results.split("\n").find((l) => l.startsWith(`| ${name} | `));
      assert.ok(line, `no recall row for ${name}`);
      assert.match(line, new RegExp(`^\\| ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\| ${x.rows} \\| ${x.caught_cautious}( \\(| \\|$)`), `recall row for ${name}`);
    }
  });

  it("the lookalike stratum table and the WARN split", () => {
    const sel = selectAccounts(dataset);
    const look = sel.accounts.filter((x) => x.label === "lookalike_candidate");
    const NAME = {
      "all:created_by_brand": "take-all: created by the brand itself",
      "all:created_last_30d": "take-all: created in the 30 days before the dataset check",
      "prop:after_brand": "proportional: created after the brand",
      "prop:predates_brand": "proportional: created before the brand",
    };
    const groupOf = (s) => (s.startsWith("all:") ? s : s.split(":").slice(0, 2).join(":"));
    const g = new Map();
    for (const [k, x] of Object.entries(sel.counts.lookalike_candidate.strata)) {
      const key = groupOf(k);
      if (!g.has(key)) g.set(key, { rows: 0, sampled: 0, ALLOW: 0, WARN: 0, DENY: 0, ablWarn: 0 });
      g.get(key).rows += x.rows;
      g.get(key).sampled += x.sampled;
    }
    const split = { low_activity: 0, lookalike_known: 0, "lookalike_known+low_activity": 0 };
    for (const x of look) {
      const e = v.get(x.account_id);
      const s = g.get(groupOf(x.stratum));
      s[e.verdict]++;
      if (a.get(x.account_id).verdict === "WARN") s.ablWarn++;
      if (e.verdict === "WARN") {
        const d = e.deciding.join("+");
        assert.ok(d in split, `unexpected deciding set ${d} on ${x.account_id}`);
        split[d]++;
      }
    }
    for (const [key, s] of g) has(`| ${NAME[key]} | ${s.rows} | ${s.sampled} | ${s.ALLOW} | ${s.WARN} | ${s.DENY} | ${s.ablWarn} |`);
    const warns = Object.values(split).reduce((n, x) => n + x, 0);
    const sentence = `Of the ${warns} WARN verdicts, ${split.low_activity} come from \`low_activity\` alone (fewer than 5 transactions; soft), ${split.lookalike_known} from \`lookalike_known\` alone and ${split["lookalike_known+low_activity"]} from both.`;
    assert.ok(flat.includes(sentence), `RESULTS.md does not state: ${sentence}`);
  });

  it("the leave-self-out replay changes only listed accounts, and RESULTS.md carries its numbers next to the run's", () => {
    assert.equal(leaveSelfOut.verdicts.length, verdicts.verdicts.length);
    for (const e of leaveSelfOut.verdicts) {
      const m = v.get(e.account_id);
      assert.equal(e.own_name_on_list, known.includes(e.account_id), `${e.account_id}: own_name_on_list`);
      assert.equal(e.chain_sha256, m.chain_sha256, `${e.account_id}: same chain data`);
      if (!e.own_name_on_list) {
        assert.deepEqual([e.verdict, e.score, e.warn_kind, e.deciding], [m.verdict, m.score, m.warn_kind, m.deciding], `${e.account_id}: not on the list, so the replay must equal verdicts.json`);
      } else {
        assert.ok(m.reasons.some((r) => r.code === "known_payee"), `${e.account_id}: known_payee in verdicts.json`);
      }
    }
    const changed = leaveSelfOut.verdicts.filter((e) => e.verdict !== v.get(e.account_id).verdict);
    assert.ok(changed.length > 0, "the exemption hides at least one warning");
    for (const e of changed) {
      assert.equal(labelOf.get(e.account_id), "known_good", `${e.account_id}: only known_good rows are on the list`);
      assert.ok(e.lookalike && e.deciding.includes("lookalike_known"), `${e.account_id}: warned as a lookalike`);
      const m = v.get(e.account_id);
      assert.ok(results.includes(`| \`${e.account_id}\` | ${rankOf.get(e.account_id)} | ${m.verdict} ${m.score} (\`known_payee\`, info) | ${e.verdict} ${e.score} |`), `${e.account_id}: leave-self-out table row`);
    }
    assert.equal(self.cautious.tp, main.cautious.tp);
    assert.equal(self.cautious.fp, main.cautious.fp + changed.length);
    const names = changed.map((e) => `\`${e.account_id}\``);
    const summary = section("Summary for quoting").replace(/\s+/g, " ");
    assert.ok(
      summary.includes(`precision ${precisionOf(main.cautious, "nothing flagged")}, or ${precisionOf(self.cautious, "nothing flagged")} counting the ${changed.length} \`known_good\` tokens`),
      "the summary carries the leave-self-out precision next to the run's",
    );
    for (const n of names) assert.ok(summary.includes(n), `the summary names ${n}`);
  });

  it("RESULTS.md names every suspicious row and every flagged known_good row with its verdict", () => {
    const named = (id, verdict) => results.includes(`| \`${id}\` | ${verdict} |`);
    for (const row of dataset.filter((e) => e.label === "suspicious")) assert.ok(named(row.account_id, v.get(row.account_id).verdict), `suspicious ${row.account_id} is not in the table`);
    for (const m of main.flagged_known_good) assert.ok(named(m.account_id, m.verdict), `false positive ${m.account_id} is not in the table`);
    assert.ok(results.includes(String(verdicts.run.block.height)), "RESULTS.md states the run block");
    assert.ok(results.includes(verdicts.run.block.hash), "RESULTS.md states the run block hash");
  });

  it("report.mjs --check: RESULTS.md is exactly what the template and the committed files produce", () => {
    const r = spawnSync(process.execPath, [...TS, path.join("scan", "benchmark", "report.mjs"), "--check"], { cwd: NEAR, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^ok: RESULTS\.md is exactly what report\.mjs produces/);
  });
});

describe("benchmark: re-derivation from committed snapshots", () => {
  it("the engine's CLI --offline replays at least 10 snapshots to the committed verdicts", () => {
    const sorted = [...verdicts.verdicts].sort((a, b) => (a.account_id < b.account_id ? -1 : 1));
    const picked = new Map();
    sorted.forEach((e, i) => {
      if (i % 16 === 0) picked.set(e.account_id, e);
    });
    const kinds = new Set();
    for (const e of sorted) {
      const k = `${e.verdict}:${e.deciding.join("+")}`;
      if (!kinds.has(k)) {
        kinds.add(k);
        picked.set(e.account_id, e);
      }
    }
    assert.ok(picked.size >= 10, `only ${picked.size} picked`);
    for (const e of picked.values()) {
      const out = JSON.parse(node([...TS, path.join("sdk", "src", "cli", "verdict.ts"), "--offline", path.join("scan", "benchmark", e.snapshot), "--json"]));
      assert.equal(out.mode, "offline");
      assert.equal(out.account, e.account_id);
      assert.equal(out.network, "mainnet");
      assert.equal(out.verdict, e.verdict, e.account_id);
      assert.equal(out.score, e.score, e.account_id);
      assert.equal(out.warn_kind, e.warn_kind, e.account_id);
      assert.deepEqual(out.reasons, e.reasons, e.account_id);
      assert.deepEqual(out.block, e.block, e.account_id);
      assert.equal(out.snapshot_sha256, e.snapshot_sha256, e.account_id);
      assert.equal(out.chain_sha256, e.chain_sha256, e.account_id);
      assert.equal(out.engine_version, e.engine_version);
      assert.equal(out.policy_id, e.policy_id);
    }
  });

  it("run.mjs --offline --check rebuilds the three verdict files byte for byte from every snapshot", () => {
    const r = spawnSync(process.execPath, [...TS, path.join("scan", "benchmark", "run.mjs"), "--offline", "--check"], { cwd: NEAR, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    for (const [file] of VERDICT_FILES) {
      assert.match(r.stdout, new RegExp(`ok: ${file.replace(/\./g, "\\.")} re-derives byte for byte from ${verdicts.verdicts.length} snapshots`));
    }
  });
});

describe("benchmark: label independence", () => {
  it("the known list is the fixed brand list: 25 tokens in fetched rank order, none chosen by hand", () => {
    assert.equal(knownDoc.accounts.length, 25);
    assert.deepEqual(knownDoc.accounts, knownDoc.ranking.map((r) => r.account_id));
    knownDoc.ranking.forEach((r, i) => assert.equal(r.rank, i + 1));
    for (let i = 1; i < knownDoc.ranking.length; i++) {
      assert.ok(Number(knownDoc.ranking[i - 1].onchain_market_cap_usd) >= Number(knownDoc.ranking[i].onchain_market_cap_usd), "ordered by on-chain market cap");
    }
    for (const id of known) assert.match(id, /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/);
    for (const id of known) assert.notEqual(labelOf.get(id), "suspicious", `${id} is a suspicious row`);
    assert.deepEqual(verdicts.known.accounts, known);
  });

  it("every snapshot was collected with that list, no registry, no vault, no third party, on mainnet at one block", () => {
    const block = verdicts.run.block;
    assert.ok(block && Number.isInteger(block.height), "one run block");
    for (const e of verdicts.verdicts) {
      const s = read(e.snapshot);
      assert.equal(s.subject, e.account_id);
      assert.equal(s.network, "mainnet");
      assert.deepEqual(s.block, { height: block.height, hash: block.hash, timestamp_ns: block.timestamp_ns }, e.account_id);
      assert.deepEqual(s.context.known, known, `${e.account_id}: known list`);
      assert.deepEqual(s.context.third_party, [], `${e.account_id}: third-party registries`);
      assert.equal(s.context.vault_id, null, `${e.account_id}: vault`);
      assert.equal(s.context.registry_id, null, `${e.account_id}: registry`);
      for (const r of s.rpc) {
        assert.equal(r.network, "mainnet", `${e.account_id}: ${r.label}`);
        assert.doesNotMatch(r.label, /^(third_party|registry|vault)\./, `${e.account_id}: ${r.label}`);
      }
    }
  });

  it("the two replays are of the same run and say so", () => {
    for (const doc of [leaveSelfOut, ablation]) {
      assert.equal(doc.derived_from, "verdicts.json");
      assert.equal(doc.engine, verdicts.engine);
      assert.deepEqual(doc.run.block, verdicts.run.block);
      assert.deepEqual(
        doc.verdicts.map((e) => [e.account_id, e.chain_sha256]),
        verdicts.verdicts.map((e) => [e.account_id, e.chain_sha256]),
      );
    }
    assert.equal(leaveSelfOut.run.own_name_on_list, verdicts.verdicts.filter((e) => known.includes(e.account_id)).length);
  });

  it("no verdict was saved with missing data", () => {
    assert.deepEqual(verdicts.run.degraded, []);
    for (const e of verdicts.verdicts) assert.deepEqual(e.missing_data, [], e.account_id);
  });
});

describe("benchmark: the lookalike sample", () => {
  it("re-derives from dataset.json and the seed, and is the set that was run", () => {
    const sel = selectAccounts(dataset);
    assert.deepEqual(selectAccounts(dataset), sel, "deterministic");
    assert.deepEqual(verdicts.run.selection, sel.counts);
    const want = sel.accounts.filter((a) => a.label === "lookalike_candidate").map((a) => a.account_id).sort();
    const got = verdicts.verdicts.filter((v) => labelOf.get(v.account_id) === "lookalike_candidate").map((v) => v.account_id).sort();
    assert.equal(want.length, SAMPLE.size);
    assert.deepEqual(got, want);
    for (const [k, v] of Object.entries(sel.counts.lookalike_candidate.strata)) {
      if (k.startsWith("all:")) assert.equal(v.sampled, v.rows, `${k} is taken whole`);
    }
  });

  it("the sampler takes whole strata, fills the rest by largest remainder, and orders by sha256", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({ account_id: `a${i}.near`, checked_at: "2026-11-12T00:00:00Z", facts: { predates_brand: false, rule: "affix", created_at: "2020-01-01T00:00:00Z" } })),
      ...Array.from({ length: 3 }, (_, i) => ({ account_id: `b${i}.near`, checked_at: "2026-11-12T00:00:00Z", facts: { predates_brand: true, rule: "affix", created_at: "2020-01-01T00:00:00Z" } })),
      { account_id: "new.near", checked_at: "2026-11-12T00:00:00Z", facts: { predates_brand: false, rule: "homoglyph", created_at: "2026-11-01T00:00:00Z" } },
    ];
    const s = sampleLookalikes(rows, { seed: "t", size: 4, recent_s: 30 * 86400 });
    assert.deepEqual(s.strata, {
      "all:created_last_30d": { rows: 1, sampled: 1 },
      "prop:after_brand:affix": { rows: 6, sampled: 2 },
      "prop:predates_brand:affix": { rows: 3, sampled: 1 },
    });
    assert.equal(s.picked.length, 4);
    assert.deepEqual(sampleLookalikes(rows, { seed: "t", size: 4, recent_s: 30 * 86400 }), s);
  });
});

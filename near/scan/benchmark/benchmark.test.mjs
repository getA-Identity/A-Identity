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
// 8. The at-age replay (at-age/): PREREGISTRATION.md still begins with the text written before any
//    at-age read; every creation block and replay block in plan.json satisfies the pre-registered
//    rule, checked with this file's own code; every at-age snapshot is pinned to its planned block,
//    records its age point and carries the benchmark's label-free context; at least 10 snapshots per
//    age point replay through the CLI to the committed verdicts; the at-age tables in RESULTS.md
//    are recomputed from the verdict files; at-age/run.mjs --offline --check rebuilds the four
//    verdict files byte for byte.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseVerdictsFile, score } from "../score.mjs";
import { SAMPLE, sampleLookalikes, selectAccounts } from "./run.mjs";
import { AGE_DAYS, PREREGISTRATION, firstBlockAtOrAfter } from "./at-age/run.mjs";

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

// ---------------------------------------------------------------------------------------------
// The at-age replay (at-age/): the same scored accounts, each pinned to the first block 1 day and
// 7 days after its own creation block. Checked here with this file's own code, not at-age/run.mjs's.

const AT_AGE_DIR = path.join(HERE, "at-age");
const atAge = (rel) => JSON.parse(fs.readFileSync(path.join(AT_AGE_DIR, rel), "utf8"));
const plan = atAge("plan.json");
const planOf = new Map(plan.accounts.map((e) => [e.account_id, e]));
const AGE = Object.fromEntries(AGE_DAYS.map((d) => [d, { verdicts: atAge(`d${d}/verdicts.json`), leaveSelfOut: atAge(`d${d}/verdicts.leave-self-out.json`) }]));
const ageName = (d) => (d === 1 ? "1 day" : `${d} days`);
const scoredIds = dataset.filter((r) => r.label === "suspicious" || r.label === "known_good").map((r) => r.account_id).sort();
const NS_PER_DAY = 86_400_000_000_000n;
const LABEL_KEYS = ["label", "category", "source_type", "evidence", "notes"];

describe("benchmark at age: the pre-registration and the plan", () => {
  it("PREREGISTRATION.md begins with the text written before any at-age read, and RESULTS.md states its digest", () => {
    const bytes = fs.readFileSync(path.join(AT_AGE_DIR, "PREREGISTRATION.md"));
    assert.ok(bytes.length >= PREREGISTRATION.bytes);
    assert.equal(createHash("sha256").update(bytes.subarray(0, PREREGISTRATION.bytes)).digest("hex"), PREREGISTRATION.sha256);
    assert.ok(results.includes(PREREGISTRATION.sha256), "RESULTS.md states the pre-registration digest");
  });

  it("plan.json covers every suspicious and known_good row once, and carries no label", () => {
    assert.deepEqual(plan.accounts.map((e) => e.account_id), scoredIds);
    for (const e of plan.accounts) for (const k of LABEL_KEYS) assert.equal(k in e, false, `${e.account_id} carries ${k}`);
    assert.doesNotMatch(JSON.stringify(plan), /"(label|category|source_type|evidence)"\s*:/);
  });

  it("every proven creation block is where view_account first finds the account, and every replay block follows the age rule", () => {
    for (const e of plan.accounts) {
      const c = e.creation;
      if (c.state !== "proven") {
        assert.equal(c.state, "not_proven", e.account_id);
        assert.ok(typeof c.why === "string" && c.why.length > 0, `${e.account_id}: a reason`);
        continue;
      }
      assert.equal(c.block.prev_hash, c.predecessor.hash, `${e.account_id}: the predecessor is the block before the creation block`);
      assert.ok(c.predecessor.height < c.block.height && BigInt(c.predecessor.timestamp_ns) < BigInt(c.block.timestamp_ns), e.account_id);
      assert.deepEqual([c.view_account_at_block.block_height, c.view_account_at_block.block_hash], [c.block.height, c.block.hash], `${e.account_id}: view_account found it at the creation block`);
      assert.deepEqual(c.view_account_at_predecessor, { error: "UNKNOWN_ACCOUNT", block_id: c.predecessor.height }, `${e.account_id}: absent one block earlier`);
      assert.ok(c.located_by.tx_block_height <= c.block.height, `${e.account_id}: not before the oldest transaction that touches it`);
      for (const d of AGE_DAYS) {
        const a = e.ages[String(d)];
        const target = BigInt(c.block.timestamp_ns) + BigInt(d) * NS_PER_DAY;
        assert.equal(a.target_ns, target.toString(), `${e.account_id} ${d} d: target`);
        assert.ok(BigInt(a.block.timestamp_ns) >= target, `${e.account_id} ${d} d: the replay block is at or after the target`);
        assert.ok(BigInt(a.predecessor.timestamp_ns) < target, `${e.account_id} ${d} d: its predecessor is before the target`);
        assert.equal(a.block.prev_hash, a.predecessor.hash, `${e.account_id} ${d} d: the predecessor is the block before`);
        if (a.exists) assert.deepEqual([a.view_account.block_height, a.view_account.block_hash], [a.block.height, a.block.hash], `${e.account_id} ${d} d`);
        else assert.deepEqual(a.view_account, { error: "UNKNOWN_ACCOUNT", block_id: a.block.height }, `${e.account_id} ${d} d`);
      }
    }
  });

  it("the replay block search returns the first block at or after the target, on a chain with skipped heights", async () => {
    // A synthetic chain: no block at heights 3, 10, 17, ...; timestamps rise unevenly.
    const exists = (h) => h >= 1 && h <= 5000 && h % 7 !== 3;
    const ts = (h) => BigInt(h) * 1_000_000_000n + BigInt((h * 37) % 9) * 90_000_000n;
    const prevOf = (h) => {
      let p = h - 1;
      while (p >= 1 && !exists(p)) p--;
      return p;
    };
    const header = (h) => ({ height: h, hash: `H${h}`, prev_hash: `H${prevOf(h)}`, timestamp_ns: ts(h).toString() });
    const chain = { headerAt: async (h) => (exists(h) ? header(h) : null) };
    for (const target of [1_500_000_000_000n, 2_000_500_000_000n, 2_345_678_901_234n, 3_999_999_999_999n, 4_000_000_000_000n]) {
      let want = 1;
      while (!exists(want) || ts(want) < target) want++;
      const r = await firstBlockAtOrAfter(chain, target, header(1));
      assert.equal(r.block.height, want, `target ${target}`);
      assert.equal(r.predecessor.height, prevOf(want), `target ${target}`);
      assert.ok(BigInt(r.block.timestamp_ns) >= target && BigInt(r.predecessor.timestamp_ns) < target);
      assert.equal(r.block.prev_hash, r.predecessor.hash);
    }
  });

  it("the creation cross-checks against the dataset are computed as recorded", () => {
    const facts = new Map(dataset.map((r) => [r.account_id, r.facts ?? {}]));
    for (const e of plan.accounts) {
      const f = facts.get(e.account_id);
      assert.equal(e.cross_checks.dataset_created_at, f.created_at ?? null, e.account_id);
      assert.equal(e.cross_checks.dataset_creation_tx, f.creation_tx ?? null, e.account_id);
      if (e.creation.state !== "proven" || !f.created_at) continue;
      const s = (Number(BigInt(e.creation.block.timestamp_ns) / 1_000_000n) - Date.parse(f.created_at)) / 1000;
      assert.equal(e.cross_checks.seconds_after_dataset_created_at, s, e.account_id);
      assert.equal(e.cross_checks.within_tolerance, s >= 0 && s <= 600, e.account_id);
    }
  });
});

describe("benchmark at age: verdict files and snapshots", () => {
  for (const d of AGE_DAYS) {
    const doc = AGE[d].verdicts;
    const lso = AGE[d].leaveSelfOut;

    it(`d${d}: both verdict files are declared, label-free, and give every scored account a verdict or a named exclusion`, () => {
      for (const x of [doc, lso]) {
        const { declaration } = parseVerdictsFile(x);
        assert.equal(declaration.labels_used, false);
        for (const s of declaration.signals) assert.doesNotMatch(s, /third_party|mimicwatch|registry|vault|label/i, `signal ${s}`);
        assert.equal(x.at_age.days, d);
        assert.deepEqual(x.at_age.preregistration, { ...PREREGISTRATION });
        assert.deepEqual([...x.verdicts.map((v) => v.account_id), ...x.excluded.map((v) => v.account_id)].sort(), scoredIds);
        for (const v of [...x.verdicts, ...x.excluded]) for (const k of LABEL_KEYS) assert.equal(k in v, false, `${v.account_id} carries ${k}`);
      }
      for (const ex of doc.excluded) {
        const e = planOf.get(ex.account_id);
        assert.ok(typeof ex.detail === "string" && ex.detail.length > 0, `${ex.account_id}: a reason`);
        if (ex.reason === "creation_not_proven") assert.equal(e.creation.state, "not_proven");
        else if (ex.reason === "absent_at_replay_block") assert.equal(e.ages[String(d)].exists, false);
        else assert.equal(ex.reason, "technical", ex.account_id);
      }
      for (const v of doc.verdicts) {
        assert.equal(planOf.get(v.account_id).ages[String(d)].exists, true, v.account_id);
        assert.deepEqual(v.transport_errors, [], v.account_id);
      }
      assert.deepEqual(lso.excluded, doc.excluded);
      assert.deepEqual(
        lso.verdicts.map((v) => [v.account_id, v.chain_sha256]),
        doc.verdicts.map((v) => [v.account_id, v.chain_sha256]),
      );
      const v = new Map(doc.verdicts.map((e) => [e.account_id, e]));
      for (const e of lso.verdicts) {
        assert.equal(e.own_name_on_list, known.includes(e.account_id), e.account_id);
        if (!e.own_name_on_list) assert.deepEqual([e.verdict, e.score, e.deciding], [v.get(e.account_id).verdict, v.get(e.account_id).score, v.get(e.account_id).deciding], e.account_id);
      }
    });

    it(`d${d}: every snapshot is pinned to its planned replay block, records its age point, and carries the benchmark's label-free context`, () => {
      assert.ok(doc.verdicts.length > 0);
      for (const v of doc.verdicts) {
        const s = atAge(v.snapshot);
        const e = planOf.get(v.account_id);
        const a = e.ages[String(d)];
        assert.equal(s.subject, v.account_id);
        assert.equal(s.network, "mainnet");
        assert.deepEqual(s.block, { height: a.block.height, hash: a.block.hash, timestamp_ns: a.block.timestamp_ns }, v.account_id);
        assert.deepEqual(v.block, s.block, v.account_id);
        const head = s.rpc.find((r) => r.label === "block")?.result?.header;
        assert.equal(head?.prev_hash, a.predecessor.hash, `${v.account_id}: the recorded block follows the planned predecessor`);
        const m = s.meta.at_age;
        assert.equal(m.days, d);
        assert.deepEqual(m.creation, { height: e.creation.block.height, hash: e.creation.block.hash, timestamp_ns: e.creation.block.timestamp_ns }, v.account_id);
        assert.equal(m.target_timestamp_ns, (BigInt(e.creation.block.timestamp_ns) + BigInt(d) * NS_PER_DAY).toString(), v.account_id);
        assert.deepEqual(m.block, s.block, v.account_id);
        assert.deepEqual(m.predecessor, { height: a.predecessor.height, hash: a.predecessor.hash, timestamp_ns: a.predecessor.timestamp_ns }, v.account_id);
        // The age rule on the snapshot's own record, without the plan: the pinned block is the
        // first block at or after creation + d days (at or after the target, and the block its
        // recorded prev_hash names is before it).
        const target = BigInt(m.creation.timestamp_ns) + BigInt(d) * NS_PER_DAY;
        assert.ok(BigInt(s.block.timestamp_ns) >= target, `${v.account_id}: the pinned block is at or after creation + ${d} d`);
        assert.ok(BigInt(m.predecessor.timestamp_ns) < target, `${v.account_id}: the pinned block's predecessor is before creation + ${d} d`);
        assert.equal(head.prev_hash, m.predecessor.hash, `${v.account_id}: the recorded prev_hash names the recorded predecessor`);
        assert.ok(m.predecessor.height < s.block.height && m.creation.height < m.predecessor.height, `${v.account_id}: creation, predecessor and pinned block in order`);
        assert.ok(s.meta.notes.some((n) => n.startsWith(`Pinned by age (scan/benchmark/at-age): the first block at or after the account's creation block #${m.creation.height} + ${d} day`)), `${v.account_id}: the age note`);
        assert.deepEqual(s.context.known, known, `${v.account_id}: known list`);
        assert.deepEqual(s.context.third_party, [], `${v.account_id}: third-party registries`);
        assert.equal(s.context.vault_id, null, `${v.account_id}: vault`);
        assert.equal(s.context.registry_id, null, `${v.account_id}: registry`);
        for (const r of s.rpc) {
          assert.equal(r.network, "mainnet", `${v.account_id}: ${r.label}`);
          assert.doesNotMatch(r.label, /^(third_party|registry|vault)\./, `${v.account_id}: ${r.label}`);
          assert.notEqual(r.error?.cause, "UNAVAILABLE", `${v.account_id}: ${r.label} unanswered`);
          if (r.method === "query") assert.ok(r.label.startsWith("probe.") ? r.params.block_id < s.block.height : r.params.block_id === s.block.height, `${v.account_id}: ${r.label} pinned`);
        }
        for (const h of s.http) assert.equal(h.error, undefined, `${v.account_id}: ${h.label} failed in transit`);
        // meta.notes is the collector's own list, not the dataset's notes field: the age note above
        // and the NearBlocks attribution sdk/src/collect/snapshot.ts adds when it used NearBlocks.
        // Any other entry fails, and no label key may appear anywhere else in meta.
        const { notes: collectorNotes, ...metaRest } = s.meta;
        for (const n of collectorNotes) {
          assert.ok(
            n.startsWith("Pinned by age (scan/benchmark/at-age): ") || n === "Some data: Powered by Nearblocks.io APIs (https://nearblocks.io).",
            `${v.account_id}: unexpected meta note ${n}`,
          );
        }
        for (const k of LABEL_KEYS) assert.doesNotMatch(JSON.stringify(metaRest), new RegExp(`"${k}"\\s*:`), `${v.account_id}: meta carries ${k}`);
      }
    });

    it(`d${d}: the engine's CLI --offline replays at least 10 snapshots to the committed verdicts`, () => {
      const sorted = [...doc.verdicts].sort((x, y) => (x.account_id < y.account_id ? -1 : 1));
      const picked = new Map();
      sorted.forEach((e, i) => {
        if (i % 7 === 0) picked.set(e.account_id, e);
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
        const out = JSON.parse(node([...TS, path.join("sdk", "src", "cli", "verdict.ts"), "--offline", path.join("scan", "benchmark", "at-age", e.snapshot), "--json"]));
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
        assert.ok(out.notes.some((n) => n.startsWith("Pinned by age")), `${e.account_id}: the CLI shows the age note`);
      }
    });

    it(`RESULTS.md quotes node scan/score.mjs scan/benchmark/at-age/d${d}/verdicts.json as one whole block`, () => {
      const out = node([path.join("scan", "score.mjs"), path.join("scan", "benchmark", "at-age", `d${d}`, "verdicts.json")]).replace(/\n+$/, "");
      const blocks = quotedRuns(`node scan/score.mjs scan/benchmark/at-age/d${d}/verdicts.json`);
      assert.equal(blocks.length, 1, `quoted exactly once, found ${blocks.length}`);
      assert.equal(blocks[0], out);
    });
  }

  it("the at-age tables in RESULTS.md, recomputed from the verdict files", () => {
    const sus = dataset.filter((r) => r.label === "suspicious");
    const kg = dataset.filter((r) => r.label === "known_good");
    const rowOf = new Map(dataset.map((r) => [r.account_id, r]));
    const v = new Map(verdicts.verdicts.map((e) => [e.account_id, e]));
    const isFlagged = (e) => e !== undefined && (e.verdict === "WARN" || e.verdict === "DENY");
    const EXCLUDED = { absent_at_replay_block: "absent at the replay block", creation_not_proven: "creation not proven", technical: "technical" };
    const ages = AGE_DAYS.map((d) => {
      const doc = AGE[d].verdicts;
      const map = new Map(doc.verdicts.map((e) => [e.account_id, e]));
      const ex = new Map(doc.excluded.map((e) => [e.account_id, e]));
      return { d, name: ageName(d), doc, map, ex, main: scored(doc), self: scored(AGE[d].leaveSelfOut), over: score(dataset.filter((r) => map.has(r.account_id)), parseVerdictsFile(doc).verdicts) };
    });
    const cell = (A, id) => {
      const e = A.map.get(id);
      if (!e) return `excluded: ${EXCLUDED[A.ex.get(id).reason]}`;
      if (e.verdict === "ALLOW") {
        const pos = e.reasons.filter((r) => r.severity === "positive").map((r) => `\`${r.code}\``);
        return `ALLOW ${e.score}: ${pos.length ? pos.join(", ") : "no warning"}`;
      }
      return `${e.verdict} ${e.score}: ${e.deciding.map((c) => `\`${c}\``).join(", ")}`;
    };
    const created = (id) => {
      const c = planOf.get(id).creation;
      return c.state === "proven" ? c.block.utc.slice(0, 10) : "not proven";
    };
    for (const A of ages) {
      for (const [name, p, none] of [
        ["strict: DENY counts as flagged", A.main.strict, "no DENY issued"],
        ["cautious: WARN or DENY counts as flagged", A.main.cautious, "nothing flagged"],
        ["strict, listed payees not exempt (leave-self-out)", A.self.strict, "no DENY issued"],
        ["cautious, listed payees not exempt (leave-self-out)", A.self.cautious, "nothing flagged"],
      ]) {
        has(`| ${A.name} | ${name} | ${precisionOf(p, none)} | ${recallOf(p)} | ${p.tp} | ${p.fp} | ${p.fn} |`);
      }
      const o = A.over;
      has(`| ${A.name} | ${o.rows.suspicious} of ${sus.length} suspicious, ${o.rows.known_good} of ${kg.length} known_good | ${precisionOf(o.strict, "no DENY issued")} | ${recallOf(o.strict)} | ${precisionOf(o.cautious, "nothing flagged")} | ${recallOf(o.cautious)} |`);
      for (const [name, rows] of [
        ["suspicious (positives)", sus],
        ["known_good (negatives)", kg],
      ]) {
        const n = (verdict) => rows.filter((r) => A.map.get(r.account_id)?.verdict === verdict).length;
        has(`| ${A.name} | ${name} | ${n("ALLOW")} | ${n("WARN")} | ${n("DENY")} | ${rows.filter((r) => !A.map.has(r.account_id)).length} | ${rows.length} |`);
      }
      // The scorer's excluded rows are its NONE: missed when suspicious, never flagged when known_good.
      assert.equal(A.main.unscored.length, A.ex.size);
    }
    for (const r of sus) {
      const [d1, d7] = ages;
      has(`| \`${r.account_id}\` | ${r.category}, ${r.facts.source_type} | ${created(r.account_id)} | ${cell(d1, r.account_id)} | ${cell(d7, r.account_id)} | ${v.get(r.account_id).verdict} |`);
    }
    for (const r of kg.filter((x) => ages.some((A) => isFlagged(A.map.get(x.account_id))))) {
      const [d1, d7] = ages;
      has(`| \`${r.account_id}\` | ${r.category} | ${created(r.account_id)} | ${cell(d1, r.account_id)} | ${cell(d7, r.account_id)} |`);
    }
    for (const A of ages) {
      for (const id of A.ex.keys()) assert.ok(results.includes(`| \`${id}\` | ${rowOf.get(id).label} | `), `exclusion of ${id} is not in the table`);
    }
    // Suspicious rows flagged at age by kind of evidence, and by the dataset's exists flag.
    {
      const [d1, d7] = ages;
      const caught = (A, test) => sus.filter((r) => test(r) && isFlagged(A.map.get(r.account_id))).length;
      for (const t of new Set(sus.map((r) => r.facts.source_type))) {
        const test = (r) => r.facts.source_type === t;
        has(`| \`${t}\` | ${sus.filter(test).length} | ${caught(d1, test)} | ${caught(d7, test)} |`);
      }
      const live = (r) => r.exists !== false;
      const gone = (r) => r.exists === false;
      has(`| exist today (dataset \`exists: true\`) | ${sus.filter(live).length} | ${caught(d1, live)} | ${caught(d7, live)} |`);
      has(`| deleted (\`exists: false\`), excluded at age | ${sus.filter(gone).length} | ${caught(d1, gone)} | ${caught(d7, gone)} |`);
    }
    // "What decided the verdicts": each deciding reason with its count per class and age point.
    const SOFT = new Set(["new_account", "low_activity", "implicit_unfunded"]);
    for (const A of ages) {
      for (const c of new Set([...A.map.values()].flatMap((e) => e.deciding))) {
        const count = (rows) => rows.filter((r) => A.map.get(r.account_id)?.deciding.includes(c)).length;
        has(`| ${A.name} | \`${c}\`${SOFT.has(c) ? " (soft)" : ""} | ${count(sus)} of ${A.over.rows.suspicious} | ${count(kg)} of ${A.over.rows.known_good} |`);
      }
    }
    // Pre-registered split (i): replay blocks before, and at or after, the creation block of
    // Circle's USDC contract, which is itself a known_good row dated by the same method.
    const usdc = planOf.get("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1").creation.block.height;
    const ratio = (num, den) => (den === 0 ? "n/a" : `${pct(num / den)} (${num} of ${den})`);
    for (const A of ages) {
      for (const [name, test] of [
        [`before block ${usdc}`, (h) => h < usdc],
        [`at or after block ${usdc}`, (h) => h >= usdc],
      ]) {
        const s = sus.filter((r) => A.map.has(r.account_id) && test(A.map.get(r.account_id).block.height));
        const k = kg.filter((r) => A.map.has(r.account_id) && test(A.map.get(r.account_id).block.height));
        const fsus = s.filter((r) => isFlagged(A.map.get(r.account_id))).length;
        const fkg = k.filter((r) => isFlagged(A.map.get(r.account_id))).length;
        has(`| ${A.name} | ${name} | ${fsus} of ${s.length} | ${fkg} of ${k.length} | ${ratio(fsus, fsus + fkg)} | ${ratio(fsus, s.length)} |`);
      }
      for (const e of A.map.values()) {
        if (e.block.height < usdc) assert.ok(e.deciding.includes("blocklist_unreadable"), `${e.account_id} (${A.name}): before USDC existed, so blocklist_unreadable decides`);
      }
    }
  });

  it("the summary for quoting carries the at-age numbers of both age points, as score.mjs counts them", () => {
    const summary = section("Summary for quoting").replace(/\s+/g, " ");
    for (const d of AGE_DAYS) {
      const m = scored(AGE[d].verdicts);
      const at = `at ${ageName(d)}`;
      assert.ok(summary.includes(`${precisionOf(m.strict, "no DENY issued")} and ${recallOf(m.strict)} ${at}`), `strict at ${ageName(d)}`);
      assert.ok(summary.includes(`${precisionOf(m.cautious, "nothing flagged")} and ${recallOf(m.cautious)} ${at}`), `cautious at ${ageName(d)}`);
      assert.equal(m.rows.suspicious + m.rows.known_good, scoredIds.length, "the denominators are every scored row, the excluded ones counted as NONE");
    }
    assert.ok(!flat.includes("would measure that design; this run does not"), "the Limits no longer say the replay near the incident was not done");
  });

  it("at-age/run.mjs --offline --check rebuilds the four verdict files byte for byte", () => {
    const r = spawnSync(process.execPath, [...TS, path.join("scan", "benchmark", "at-age", "run.mjs"), "--offline", "--check"], { cwd: NEAR, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    for (const d of AGE_DAYS) {
      for (const f of ["verdicts.json", "verdicts.leave-self-out.json"]) assert.match(r.stdout, new RegExp(`ok: at-age/d${d}/${f.replace(/\./g, "\\.")} re-derives byte for byte`));
    }
  });
});

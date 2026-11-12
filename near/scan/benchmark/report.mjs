#!/usr/bin/env node
// Writes scan/benchmark/RESULTS.md from RESULTS.template.md and the committed benchmark files, or,
// with --check, exits 1 unless the committed RESULTS.md is exactly what they produce. No network,
// no dependencies.
//
// From near/ (Node >= 22.22.2):
//   node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/report.mjs
//   node --experimental-strip-types --no-warnings=ExperimentalWarning scan/benchmark/report.mjs --check
//
// What fills the template. Each @@NAME@@ is computed here from verdicts.json,
// verdicts.leave-self-out.json, verdicts.no-known.json, known-brands.json and ../dataset.json. The
// quoted scorer blocks are the output of ../score.mjs, run as a child process. The list
// sensitivity table replays snapshots/ offline with two more known lists cut from the same
// ranking. A placeholder with no value, a value no placeholder uses, or a non-ASCII character is
// an error. The per-row notes ("Why") are written here by hand; the dates, counts and matched
// names in them are read from the files, and the script throws when a row has no note or when a
// fact a sentence relies on stops holding. The template's own prose keeps what the files do not
// hold: the request counts per host and the re-collection check come from the runner's console
// output on the day of the run.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseVerdictsFile, score } from "../score.mjs";
import { PATHS, loadKnown, loadSdk, readJson, selectAccounts } from "./run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEAR = path.resolve(HERE, "..", "..");
const TEMPLATE = path.join(HERE, "RESULTS.template.md");
const OUTPUT = path.join(HERE, "RESULTS.md");

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const code = (s) => `\`${s}\``;
const short = (id) => (/^[0-9a-f]{64}$/.test(id) ? `${id.slice(0, 8)}...${id.slice(-4)}` : id);
const day = (iso) => iso.slice(0, 10);
const daysBetween = (later, earlier) => Math.round((Date.parse(`${day(later)}T00:00:00Z`) - Date.parse(`${day(earlier)}T00:00:00Z`)) / 86_400_000);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthYear = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "a", "a and b", "a, b and c". */
const listJoin = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

function must(condition, message) {
  if (!condition) throw new Error(`report.mjs: ${message}`);
}

/** The precision and recall cells of one operating point, as the tables and the summary print them. */
export function precisionCell(point, none) {
  return point.precision === null ? `n/a (${none})` : `${pct(point.precision)} (${point.tp} of ${point.tp + point.fp})`;
}
export function recallCell(point) {
  return `${pct(point.recall)} (${point.tp} of ${point.tp + point.fn})`;
}

const scorerOutput = (file) =>
  execFileSync(process.execPath, [path.join("scan", "score.mjs"), path.join("scan", "benchmark", file)], { cwd: NEAR, encoding: "utf8" }).replace(/\n+$/, "");

/** Fill the template. Returns the text RESULTS.md must hold. */
export async function buildReport() {
  const sdk = await loadSdk();
  const dataset = readJson(PATHS.dataset);
  const V = readJson(PATHS.verdicts);
  const L = readJson(PATHS.leaveSelfOut);
  const A = readJson(PATHS.ablation);
  const K = readJson(PATHS.known);
  const known = loadKnown();
  const row = new Map(dataset.map((r) => [r.account_id, r]));
  const v = new Map(V.verdicts.map((e) => [e.account_id, e]));
  const l = new Map(L.verdicts.map((e) => [e.account_id, e]));
  const a = new Map(A.verdicts.map((e) => [e.account_id, e]));
  const main = score(dataset, parseVerdictsFile(V).verdicts);
  const self = score(dataset, parseVerdictsFile(L).verdicts);
  const abl = score(dataset, parseVerdictsFile(A).verdicts);
  const rankOf = new Map(K.ranking.map((r) => [r.account_id, r.rank]));
  const soft = new Set(sdk.engine.RULES.filter((r) => r.soft === true).map((r) => r.code));
  const flagged = (verdict) => verdict === "WARN" || verdict === "DENY";
  const isWarnOrDeny = (r) => (r.severity === "deny" || r.severity === "warn") && !r.cleared_by;
  const fill = {};

  // Offline replays of every snapshot with a given known list.
  const snapshots = new Map(V.verdicts.map((e) => [e.account_id, sdk.engine.assertSnapshot(readJson(path.join(HERE, e.snapshot)))]));
  const replayAll = (listFor) => {
    const out = new Map();
    for (const [id, s] of snapshots) out.set(id, sdk.engine.verdictFromSnapshot({ ...s, context: { ...s.context, known: listFor(id) } }));
    return out;
  };
  const asRun = replayAll(() => known);
  for (const [id, r] of asRun) {
    const e = v.get(id);
    must(r.decision.verdict === e.verdict && r.decision.score === e.score && r.chain_sha256 === e.chain_sha256, `${id}: a replay with known-brands.json does not give the committed verdict`);
  }
  const matchOf = (id) => asRun.get(id).signals.lookalike;

  // ------------------------------------------------------------------ run, engine, counts
  const block = V.run.block;
  must(block && Number.isInteger(block.height), "verdicts.json has one run block");
  fill.BLOCK = block.height;
  fill.BLOCK_HASH = block.hash;
  fill.BLOCK_UTC = block.utc;
  fill.BLOCK_DAY = day(block.utc);
  const engines = [...new Set(V.verdicts.map((e) => e.engine_version))];
  const policies = [...new Set(V.verdicts.map((e) => e.policy_id))];
  must(engines.length === 1 && policies.length === 1, "one engine version and one policy");
  fill.ENGINE_SEMVER = engines[0].split("/").pop();
  fill.POLICY_ID = policies[0];
  fill.ENGINE = V.engine;
  const sel = selectAccounts(dataset);
  const look = sel.accounts.filter((x) => x.label === "lookalike_candidate");
  fill.N_SUS = main.rows.suspicious;
  fill.N_KG = main.rows.known_good;
  fill.N_LOOK = main.rows.lookalike_candidate;
  fill.N_LOOK_SAMPLED = look.length;
  fill.N_LOOK_NONE = main.rows.lookalike_candidate - look.length;
  fill.N_TOTAL = V.verdicts.length;
  must(fill.N_TOTAL === fill.N_SUS + fill.N_KG + fill.N_LOOK_SAMPLED, "the run is every scored row plus the sample");
  must(V.verdicts.every((e) => e.verdict !== "DENY"), "no DENY anywhere in the run");
  must(V.run.degraded.length === 0 && V.verdicts.every((e) => e.missing_data.length === 0), "no verdict saved with missing data");
  const hm = (iso) => iso.slice(11, 19);
  fill.COLLECTED = `from ${hm(V.run.collected_first)} to ${hm(V.run.collected_last)}`;
  fill.COLLECT_MIN = Math.round((Date.parse(V.run.collected_last) - Date.parse(V.run.collected_first)) / 60_000);
  const probeOf = (s, label) => {
    const h = s.rpc.find((x) => x.label === label)?.result?.header;
    return h ? `block ${h.height} (${new Date(Number(BigInt(h.timestamp_nanosec) / 1_000_000n)).toISOString()})` : null;
  };
  const existing = [...snapshots.values()].filter((s) => asRun.get(s.subject).signals.account.exists === true);
  const probes = new Set(existing.map((s) => `${probeOf(s, "probe.recent.block")}|${probeOf(s, "probe.long.block")}`));
  must(probes.size === 1, "every account that exists was probed at the same two blocks");
  [fill.PROBE_RECENT, fill.PROBE_LONG] = [...probes][0].split("|");
  const dsb = V.verdicts.map((e) => e.dataset_block_height).filter((x) => x !== null);
  fill.DS_BLOCKS = `${Math.min(...dsb)} to ${Math.max(...dsb)}`;
  const checked = V.verdicts.map((e) => Date.parse(row.get(e.account_id).checked_at));
  const hoursEarlier = [Math.min(...checked), Math.max(...checked)].map((t) => Math.round((Date.parse(block.utc) - t) / 3_600_000));
  must(hoursEarlier[0] === hoursEarlier[1], "the dataset checked the run's rows within one rounded hour");
  fill.DS_HOURS = hoursEarlier[0];

  // ------------------------------------------------------------------ result table and summary
  const POINTS = [
    ["strict: DENY counts as flagged", main.strict, "no DENY issued"],
    ["cautious: WARN or DENY counts as flagged", main.cautious, "nothing flagged"],
    ["strict, listed payees not exempt (leave-self-out)", self.strict, "no DENY issued"],
    ["cautious, listed payees not exempt (leave-self-out)", self.cautious, "nothing flagged"],
    ["strict, without the brand list (ablation)", abl.strict, "no DENY issued"],
    ["cautious, without the brand list (ablation)", abl.cautious, "nothing flagged"],
  ];
  fill.RESULT_ROWS = POINTS.map(([name, p, none]) => `| ${name} | ${precisionCell(p, none)} | ${recallCell(p)} | ${p.tp} | ${p.fp} | ${p.fn} |`).join("\n");
  fill.STRICT_RECALL = recallCell(main.strict);
  fill.C_RECALL = recallCell(main.cautious);
  fill.C_PRECISION = precisionCell(main.cautious, "nothing flagged");
  fill.LSO_PRECISION = precisionCell(self.cautious, "nothing flagged");

  const sus = dataset.filter((r) => r.label === "suspicious");
  const kg = dataset.filter((r) => r.label === "known_good");
  const tps = sus.filter((r) => flagged(v.get(r.account_id).verdict));
  const tpDeleted = tps.filter((r) => r.exists === false);
  const tpLookalike = tps.filter((r) => r.exists !== false);
  must(tps.length === main.cautious.tp, "the catches are the scorer's true positives");
  must(tpDeleted.every((r) => r.facts.incident === "rhea-lend-exploit-2026-04" && v.get(r.account_id).deciding.join("+") === "implicit_unfunded"), "every deleted catch is a Rhea Lend account warned as implicit_unfunded");
  must(tpLookalike.every((r) => r.category === "fake_airdrop_token" && v.get(r.account_id).deciding.join("+") === "lookalike_known"), "every other catch is a fake airdrop token warned as lookalike_known");
  fill.N_TP = tps.length;
  fill.N_TP_DELETED = tpDeleted.length;
  fill.N_TP_LOOKALIKE = tpLookalike.length;
  const deleted = sus.filter((r) => r.exists === false);
  must(deleted.every((r) => /^[0-9a-f]{64}$/.test(r.account_id)), "every deleted suspicious account is an implicit (hex) account");
  fill.N_DELETED = deleted.length;
  const exist = sus.filter((r) => r.exists !== false);
  must(exist.every((r) => v.get(r.account_id).reasons.some((x) => x.code === "long_history")), "every suspicious account that exists has long_history");
  must(sus.every((r) => !v.get(r.account_id).reasons.some((x) => x.code === "usdc_blocklisted")), "no suspicious account is on the USDC blocklist");
  fill.N_EXIST = exist.length;
  fill.N_EXIST_CAUGHT = exist.filter((r) => flagged(v.get(r.account_id).verdict)).length;
  fill.SUS_FIRST_YEAR = exist.map((r) => r.facts.created_at).sort()[0].slice(0, 4);
  fill.SUS_LAST_YEAR = exist.map((r) => r.facts.created_at).sort().pop().slice(0, 4);
  fill.N_RHEA = sus.filter((r) => r.facts.incident === "rhea-lend-exploit-2026-04").length;

  const misses = sus.filter((r) => !flagged(v.get(r.account_id).verdict));
  must(misses.length === main.cautious.fn, "the misses are the scorer's false negatives");
  must(misses.every((r) => v.get(r.account_id).verdict === "ALLOW" && r.facts.created_at && r.facts.last_tx_at), "every miss is an ALLOW of an account with a creation and a last transaction date");
  const missCreated = misses.map((r) => r.facts.created_at).sort();
  fill.N_FN = misses.length;
  fill.MISS_FIRST = missCreated[0].slice(0, 4);
  fill.MISS_LAST = monthYear(missCreated[missCreated.length - 1]);
  fill.N_MISS_IDLE = misses.filter((r) => r.facts.last_tx_at < "2025-01-01").length;

  // False positives: code changes, and token.* contracts matched to a listed token.* account.
  const fps = main.flagged_known_good.map((m) => v.get(m.account_id));
  const fpCode = fps.filter((e) => e.deciding.join("+") === "code_changed_recently");
  const fpToken = fps.filter((e) => e.deciding.join("+") === "lookalike_known" && e.account_id.startsWith("token."));
  must(fpCode.length + fpToken.length === fps.length, "every false positive is a recent code change or a token.* lookalike");
  fill.N_FP = fps.length;
  fill.N_FP_CODE = fpCode.length;
  fill.N_FP_TOKEN = fpToken.length;
  const listedTokens = K.ranking.filter((r) => r.account_id.split(".")[0] === "token");
  fill.N_LISTED_TOKENS = listedTokens.length;
  fill.LISTED_TOKENS = listedTokens.map((r) => `${code(r.account_id)}, rank ${r.rank}`).join("; ");
  const tie = [...new Set(fpToken.map((e) => matchOf(e.account_id)?.known))];
  must(tie.length === 1 && tie[0] === listedTokens.map((r) => r.account_id).sort()[0], "the token.* false positives are all matched to the first listed token.* account in sorted order");
  fill.TIE_NAME = tie[0];
  for (const e of fpToken) {
    must(matchOf(e.account_id).kind === "parent_swap" && matchOf(e.account_id).strong === false, `${e.account_id}: a weak parent_swap`);
    for (const t of listedTokens) {
      const m = sdk.engine.compareAccounts(e.account_id, t.account_id, sdk.engine.DEFAULT_POLICY.lookalike);
      must(m && m.kind === "parent_swap" && m.strong === false && m.distance === 0, `${e.account_id}: the same weak match with ${t.account_id}`);
    }
  }

  // ------------------------------------------------------------------ the brand list, leave-self-out, ablation
  fill.N_KNOWN = known.length;
  fill.KNOWN_FETCHED = K.fetched_at;
  fill.KNOWN_IN_KG = K.ranking.filter((x) => row.get(x.account_id)?.label === "known_good").length;
  fill.KNOWN_ROWS = K.ranking.map((x) => `| ${x.rank} | ${code(x.account_id)} | ${x.symbol} | ${row.get(x.account_id)?.label ?? "not in the dataset"} |`).join("\n");
  const brands = tpLookalike.map((r) => matchOf(r.account_id).known).sort((x, y) => rankOf.get(x) - rankOf.get(y));
  must(brands.every((b) => rankOf.has(b)), "the caught fake tokens imitate names on the list");
  fill.TP_BRANDS = listJoin(brands.map((b) => `${code(b)} (rank ${rankOf.get(b)})`));
  const changedSus = sus.filter((r) => v.get(r.account_id).verdict !== a.get(r.account_id).verdict).map((r) => r.account_id).sort();
  must(JSON.stringify(changedSus) === JSON.stringify(tpLookalike.map((r) => r.account_id).sort()), "the list changes only the caught fake tokens among the suspicious rows");
  fill.ABL_TP_DIFF = main.cautious.tp - abl.cautious.tp;
  fill.ABL_FP_DIFF = main.cautious.fp - abl.cautious.fp;
  const lookWarn = (m) => look.filter((x) => m.get(x.account_id).verdict === "WARN").length;
  fill.ABL_LOOK_DIFF = lookWarn(v) - lookWarn(a);
  must(fill.ABL_TP_DIFF >= 0 && fill.ABL_FP_DIFF >= 0 && fill.ABL_LOOK_DIFF >= 0, "the ablation only removes warnings");

  must(L.labels_used === false && L.verdicts.length === V.verdicts.length, "the leave-self-out file is a full, label-free replay");
  const onList = L.verdicts.filter((e) => e.own_name_on_list);
  for (const e of L.verdicts) {
    const m = v.get(e.account_id);
    must(e.own_name_on_list === known.includes(e.account_id), `${e.account_id}: own_name_on_list`);
    if (!e.own_name_on_list) must(e.verdict === m.verdict && e.score === m.score && e.warn_kind === m.warn_kind && e.deciding.join("+") === m.deciding.join("+"), `${e.account_id}: not on the list, so the replay must equal verdicts.json`);
  }
  must(onList.every((e) => v.get(e.account_id).reasons.some((x) => x.code === "known_payee")), "every account on the list carries known_payee in verdicts.json");
  fill.N_ON_LIST = onList.length;
  const changed = L.verdicts.filter((e) => e.verdict !== v.get(e.account_id).verdict).sort((x, y) => rankOf.get(x.account_id) - rankOf.get(y.account_id));
  must(changed.length > 0 && changed.every((e) => e.own_name_on_list && row.get(e.account_id)?.label === "known_good" && e.lookalike), "the replay changes only known_good accounts on the list, each by a lookalike match");
  must(self.cautious.fp - main.cautious.fp === changed.length && self.cautious.tp === main.cautious.tp, "the changed accounts are the extra false positives");
  fill.N_LSO_CHANGED = changed.length;
  fill.LSO_CHANGED_NAMES = listJoin(changed.map((e) => code(e.account_id)));
  fill.LSO_ROWS = changed
    .map((e) => {
      const m = v.get(e.account_id);
      return `| ${code(e.account_id)} | ${rankOf.get(e.account_id)} | ${m.verdict} ${m.score} (${code("known_payee")}, info) | ${e.verdict} ${e.score} | ${e.lookalike.strong ? "strong" : "weak"} ${code(e.lookalike.kind)} with ${code(e.lookalike.known)} |`;
    })
    .join("\n");

  // List sensitivity: the same snapshots with lists cut from the same ranking.
  const withoutTie = known.filter((k) => k !== fill.TIE_NAME);
  const topTen = K.ranking.slice(0, 10).map((r) => r.account_id).sort();
  const minusTie = replayAll(() => withoutTie);
  const top = replayAll(() => topTen);
  const sensRow = (name, verdictOf, matchFor) => {
    const s = score(dataset, new Map([...snapshots.keys()].map((id) => [id, verdictOf(id)])));
    must(s.strict.tp === 0 && s.strict.fp === 0, `${name}: no DENY`);
    const tokenFps = s.flagged_known_good.map((f) => f.account_id).filter((id) => id.startsWith("token."));
    const matched = [...new Set(tokenFps.map(matchFor))].sort();
    must(matched.every((x) => typeof x === "string"), `${name}: every token.* false positive is a lookalike match`);
    return { line: `| ${name} | ${precisionCell(s.cautious, "nothing flagged")} | ${recallCell(s.cautious)} | ${s.cautious.fp} | ${tokenFps.length} | ${matched.length ? matched.map(code).join(", ") : "none"} |`, tokenFps };
  };
  const sens = [
    sensRow(`the ${known.length}, as run`, (id) => v.get(id).verdict, (id) => matchOf(id)?.known),
    sensRow(`the ${known.length}, each payee's own name left out (leave-self-out)`, (id) => l.get(id).verdict, (id) => l.get(id).lookalike?.known),
    sensRow(`the ${known.length} without ${code(fill.TIE_NAME)} (rank ${rankOf.get(fill.TIE_NAME)})`, (id) => minusTie.get(id).decision.verdict, (id) => minusTie.get(id).signals.lookalike?.known),
    sensRow("the top 10 (ranks 1 to 10)", (id) => top.get(id).decision.verdict, (id) => top.get(id).signals.lookalike?.known),
    sensRow("none (ablation)", (id) => a.get(id).verdict, () => null),
  ];
  fill.SENS_ROWS = sens.map((x) => x.line).join("\n");
  for (const e of fpToken) {
    must(flagged(minusTie.get(e.account_id).decision.verdict) && flagged(top.get(e.account_id).decision.verdict), `${e.account_id}: still flagged without ${fill.TIE_NAME} and with the top 10`);
  }
  const nextMatch = [...new Set(fpToken.map((e) => minusTie.get(e.account_id).signals.lookalike?.known))];
  must(nextMatch.length === 1, "one next match once the reported name is gone");
  fill.NEXT_MATCH = nextMatch[0];
  fill.TOP10_TOKEN_FP = sens[3].tokenFps.length;
  must(sens[3].tokenFps.length > fpToken.length, "the top 10 adds a token.* false positive");
  fill.TOP10_EXTRA = listJoin(sens[3].tokenFps.filter((id) => !fpToken.some((e) => e.account_id === id)).map(code));

  // ------------------------------------------------------------------ how soon the suspicious rows were named
  const reported = sus.filter((r) => r.facts.source_type !== "onchain_campaign_link");
  const lag = new Map();
  for (const r of reported) {
    const first = r.evidence.map((e) => e.date).filter(Boolean).sort()[0];
    must(first, `${r.account_id}: a dated report`);
    let from = r.facts.created_at;
    let by = null;
    if (!from) {
      // A deleted account has no creation date: date it by the account named in the same quoted
      // sentence of the same report that still exists.
      const same = sus.filter((s) => s !== r && s.facts.created_at && s.evidence.some((e) => r.evidence.some((x) => x.url === e.url && x.quote === e.quote)));
      must(same.length === 1, `${r.account_id}: one dated account named in the same sentence`);
      from = same[0].facts.created_at;
      by = same[0].account_id;
    }
    lag.set(r.account_id, { days: daysBetween(first, from), first, by, from });
  }
  const borrowed = [...lag.values()].filter((x) => x.by !== null);
  must(borrowed.length === deleted.length && new Set(borrowed.map((x) => x.by)).size === 1, "the deleted accounts are dated by one surviving account");
  fill.N_LAG_BORROWED = borrowed.length;
  fill.LAG_BORROWED_BY = short(borrowed[0].by);
  fill.LAG_BORROWED_FROM = day(borrowed[0].from);
  fill.N_REPORTED = reported.length;
  fill.N_NAMED_15 = [...lag.values()].filter((x) => x.days <= 15).length;
  const bySource = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.facts.source_type, (m.get(r.facts.source_type) ?? 0) + 1);
    return [...m.entries()].sort((x, y) => y[1] - x[1] || cmp(x[0], y[0])).map(([k, n]) => `${n} ${code(k)}`).join(", ");
  };
  const BUCKETS = [
    ["0 to 15", (d) => d <= 15],
    ["16 to 60", (d) => d > 15 && d <= 60],
    ["more than 60", (d) => d > 60],
  ];
  const namingRows = BUCKETS.map(([name, test]) => {
    const rows = reported.filter((r) => test(lag.get(r.account_id).days));
    const ds = rows.map((r) => lag.get(r.account_id).days);
    const observed = rows.length ? `${Math.min(...ds)} to ${Math.max(...ds)}` : "";
    return `| ${name} | ${rows.length} | ${observed} | ${rows.length ? bySource(rows) : "none"} |`;
  });
  const linked = sus.filter((r) => r.facts.source_type === "onchain_campaign_link");
  namingRows.push(`| no dated report: linked on chain to the lure campaign | ${linked.length} | | ${bySource(linked)} |`);
  fill.NAMING_ROWS = namingRows.join("\n");
  must(BUCKETS.reduce((n, [, test]) => n + reported.filter((r) => test(lag.get(r.account_id).days)).length, 0) === reported.length, "every reported row is in one bucket");
  const namedCell = (r) => {
    const x = lag.get(r.account_id);
    if (!x) return "no dated report (linked on chain)";
    return `${plural(x.days, "day")}${x.by ? ` (from ${code(short(x.by))})` : ""}`;
  };

  // ------------------------------------------------------------------ confusion and recall tables
  const verdictsOf = (rows) => {
    const m = { ALLOW: 0, WARN: 0, DENY: 0 };
    for (const x of rows) m[v.get(x.account_id).verdict]++;
    return m;
  };
  const sm = verdictsOf(sus);
  const km = verdictsOf(kg);
  fill.CONFUSION_ROWS = [`| suspicious (positives) | ${sm.ALLOW} | ${sm.WARN} | ${sm.DENY} | ${sus.length} |`, `| known_good (negatives) | ${km.ALLOW} | ${km.WARN} | ${km.DENY} | ${kg.length} |`].join("\n");
  const caughtBy = (type) => tps.filter((r) => r.facts.source_type === type);
  must(JSON.stringify(caughtBy("security_writeup").map((r) => r.account_id).sort()) === JSON.stringify(tpDeleted.map((r) => r.account_id).sort()), "the security_writeup catches are the deleted accounts");
  must(JSON.stringify(caughtBy("researcher_dataset").map((r) => r.account_id).sort()) === JSON.stringify(tpLookalike.map((r) => r.account_id).sort()), "the researcher_dataset catches are the fake tokens");
  const RECALL_NOTES = {
    security_writeup: `the ${tpDeleted.length} deleted Rhea worker accounts`,
    researcher_dataset: `${listJoin(tpLookalike.map((r) => code(r.account_id)).sort())}: lookalikes of brand-list tokens`,
  };
  const recallRows = Object.entries(main.suspicious_by_source_type)
    .sort((x, y) => y[1].rows - x[1].rows || cmp(x[0], y[0]))
    .map(([k, x]) => `| ${code(k)} | ${x.rows} | ${x.caught_cautious}${RECALL_NOTES[k] && x.caught_cautious ? ` (${RECALL_NOTES[k]})` : ""} |`);
  recallRows.push(`| exist at the block | ${main.suspicious_by_exists.exists.rows} | ${main.suspicious_by_exists.exists.caught_cautious} |`);
  recallRows.push(`| deleted (${code("exists: false")}) | ${main.suspicious_by_exists.deleted.rows} | ${main.suspicious_by_exists.deleted.caught_cautious} |`);
  fill.RECALL_ROWS = recallRows.join("\n");

  // ------------------------------------------------------------------ every suspicious row
  const reasonsCell = (e) => {
    if (e.verdict === "ALLOW") {
      const pos = e.reasons.filter((r) => r.severity === "positive").map((r) => code(r.code));
      return pos.length ? pos.join(", ") : "(no warning and no positive; base score)";
    }
    return e.reasons
      .filter(isWarnOrDeny)
      .map((r) => `${code(r.code)}${soft.has(r.code) ? " (soft)" : ""}`)
      .join(", ");
  };
  const LONG = code("long_history");
  const created = (r) => day(r.facts.created_at);
  const creatorIs = (r, who) => {
    must(r.facts.creator === who, `${r.account_id}: created by ${who}`);
    return who;
  };
  const txs5 = (r) => {
    must(r.facts.txs_count >= 5, `${r.account_id}: 5 or more transactions`);
    return "5 or more transactions";
  };
  const homoglyphOrEdit = (r) => {
    const m = matchOf(r.account_id);
    must(m && m.strong && a.get(r.account_id).verdict === "ALLOW", `${r.account_id}: a strong match, ALLOW without the list`);
    const where = `${code(m.known)} (rank ${rankOf.get(m.known)} on the brand list)`;
    if (m.kind === "homoglyph") return `Its name folds to the same skeleton as ${where}: a strong homoglyph match.`;
    must(m.kind === "edit_distance", `${r.account_id}: homoglyph or edit distance`);
    return `${m.distance === 1 ? "One edit" : `${m.distance} edits`} from ${where}: a strong edit-distance match.`;
  };
  const yearsAfter = (r) => Math.round(daysBetween(block.utc, r.facts.created_at) / 365.25);
  const monthsAfter = (r) => Math.round(daysBetween(block.utc, r.facts.created_at) / 30.44);
  const DELETED = () =>
    "Rhea Lend worker account, deleted after the attack. The implicit account does not exist at the block, and the engine calls it never funded: the rule reads only the account state at the block, which is the same for a deleted account and a never-funded one, and the indexer history that would tell them apart is not used for an absent account. Flagged for being absent, not for the exploit. A transfer would re-create the account for whoever holds its key.";
  const RHEA_TOKEN = (r) => `One of the four fake token contracts of the Rhea Lend exploit, created ${created(r)}, ${txs5(r)}, code unchanged within 72 h: ${LONG}. The shared code hash in the rekt.news report is not something the engine reads.`;
  const RHEA_STAGING = (r) => `Staging account in Rhea's Multichain Account system that received exploit funds, created ${created(r)}: a contract with no full-access key (${code("locked_contract")}, info) and ${LONG}.`;
  const WHY = {
    "5a7695e3626aeae7c0d340b6e58f813c71455d1be490eeb44e90bd9682343040": DELETED,
    "839810a1aef8ed1adb03e795b2a9785d783d4e2f415ab80c8b6fb30483e160f2": DELETED,
    "9053223460198e5e1e54dc15c18295ff0e98dca41ecd6c3872da1ff634d99616": DELETED,
    "d4e8e706f5a59610d85924af858f0562031930d14eb7add9a433edea50cf0b03": DELETED,
    "linear_protocol.near": (r) => `Fake LiNEAR airdrop token, created ${created(r)}. ${homoglyphOrEdit(r)} Older than 72 h, so WARN rather than DENY. ALLOW without the brand list.`,
    "metapools.near": (r) => `Fake Meta Pool airdrop token, created ${created(r)}. ${homoglyphOrEdit(r)} Older than 72 h, so WARN rather than DENY. ALLOW without the brand list.`,
    "31ac7a2705a0686ff427b1a52d3ffd1fcfaa4b1f3cb3e83a0f767494e724a540": (r) => `Rhea Lend attacker wallet and collector, created ${created(r)}, about ${monthsAfter(r)} months before the block: ${LONG}. Keys unchanged within 72 h, not on Circle's USDC blocklist. Nothing the engine reads records the exploit.`,
    "3be304b2151870b2be88b9de0b80acab921337ad152584138bd852fc6e9ae018": (r) => `SWEAT token exploit drainer, a contract account created ${created(r)}, ${txs5(r)}, code unchanged within 72 h: ${LONG}.`,
    "5ebc5ecca14a44175464d0e6a7d3b2a6890229cd5f19cfb29ce8b1651fd58d39": (r) => `Skyward Finance exploiter, created ${created(r)}: ${LONG}; no change within 72 h.`,
    "72633832db9d039b97906320169a8411bc2fa0f78303a4ecb1d35de71af621c5": (r) => `Rhea Lend master account that consolidated the proceeds, a contract account created ${created(r)}: ${LONG}; code and keys unchanged within 72 h.`,
    "9c2a08cf1d06716bb03c662ed67096ea92cedacf058d50e1dea60ff442cf6180": (r) => `Kangaroo Coin Flip exploiter, created ${created(r)}: ${LONG}; no change within 72 h.`,
    "d39fd6da5eda882fe5f6716212552356cde2613054c670ffd6b49b3b25aef473": (r) => `Rhea Lend worker account that still exists, created ${created(r)}: ${LONG}; no change within 72 h.`,
    "gregoshes.near": (r) => {
      must(day(r.evidence[0].date) === created(r), "gregoshes.near: created on the day the incident report dates the attack");
      return `Stader NearX exploiter, created ${created(r)} (the day of the attack): ${LONG} about ${yearsAfter(r)} years later.`;
    },
    "7d06ad005e03aa875875481fb6a2bd1acf9e722100ab8747e4e97801ba340640": RHEA_TOKEN,
    "80f357d92e67f0ea53f299bb16d3af363ba0ef66e0211091edc2181cd323a705": RHEA_TOKEN,
    "9c0df321dd5d9fc1138a09f405f523333fffe74de2ee10932ff756e27ae930ee": RHEA_TOKEN,
    "c122aad2a188ed3abec0517f99c4dd03591d19e6bfcf7f015424351fbdd71163": RHEA_TOKEN,
    "rhea000453.multica.near": RHEA_STAGING,
    "rhea000462.multica.near": RHEA_STAGING,
    "rhea000505.multica.near": RHEA_STAGING,
    "burrowfinancedao.near": (r) => {
      const made = sus.filter((s) => s.facts.creator === r.account_id);
      must(made.length === 4, "burrowfinancedao.near created four other suspicious rows");
      must(!matchOf(r.account_id), "burrowfinancedao.near: no lookalike match");
      return `Lure token that created four others, created ${created(r)}, ${txs5(r)}: ${LONG}, and no warning fires. No brand-list name is close: Burrow has no token in the top ${known.length}, and the engine compares whole account names (${code("token.burrow.near")}), not brand words. The website lure in its token name is not something the engine reads.`;
    },
    "dragoneggsmeme.near": (r) => `Lure token created by ${code(creatorIs(r, "burrowfinancedao.near"))} on ${created(r)}: ${LONG}. It imitates no brand-list name, and the lure in its token name is not read.`,
    "lonkrewards.near": (r) => {
      must(!known.includes("token.lonkingnearbackto2024.near") && !matchOf(r.account_id), "lonkrewards.near: LONK is not on the list and no match fires");
      return `Lure token imitating LONK, created ${created(r)}: ${LONG}. ${code("token.lonkingnearbackto2024.near")} is not on the brand list, and the name is not close to that whole account id either.`;
    },
    "nearreward.near": (r) => `Lure token created by ${code(creatorIs(r, "nearrewards.near"))} on ${created(r)}: ${LONG}. It imitates no brand-list name, and the lure in its token name is not read.`,
    "nearrewards.near": (r) => {
      must(r.facts.full_access_keys === 4, "nearrewards.near: 4 full-access keys");
      return `Creator of the campaign and itself a lure token, created ${created(r)}, last transaction ${day(r.facts.last_tx_at)} by the dataset's count: ${LONG}. Its 4 full-access keys were all there 72 h before the block.`;
    },
    "9ebef819489ae5e6641cc5573740dadc751c35c3ae37c110e4fad8101494e418": (r) => `Received funds phished through a fake wallet website (victim report), created ${created(r)}: ${LONG}.`,
    "bigbank101.near": (r) => `Received funds stolen through a fake NEAR Wallet app (victim report), created ${created(r)}: ${LONG}.`,
    "dolbabob.near": (r) => `Received funds lost to a phishing site (victim report), created ${created(r)}: ${LONG}.`,
    "087184b14c3cad5de72090c4a48816d46e53f39454df13b957e14350793b18e7": (r) => `First hop of stolen funds and NFTs (victim report), created ${created(r)}: ${LONG}.`,
    "wisdom1.near": (r) => `Received a drained guild treasury (victim report), created ${created(r)}, ${txs5(r)}: ${LONG}.`,
  };
  const CAT_ORDER = ["exploiter", "exploit_fake_token", "exploit_staging", "fake_airdrop_token", "phishing_receiver", "theft_receiver"];
  const susSorted = [...sus].sort((x, y) => {
    const fx = flagged(v.get(x.account_id).verdict) ? 0 : 1;
    const fy = flagged(v.get(y.account_id).verdict) ? 0 : 1;
    return fx - fy || CAT_ORDER.indexOf(x.category) - CAT_ORDER.indexOf(y.category) || cmp(x.account_id, y.account_id);
  });
  fill.SUSPICIOUS_ROWS = susSorted
    .map((r) => {
      const e = v.get(r.account_id);
      must(typeof WHY[r.account_id] === "function", `no note for suspicious ${r.account_id}`);
      if (e.verdict === "ALLOW") must(e.reasons.some((x) => x.code === "long_history") && !e.reasons.some(isWarnOrDeny), `${r.account_id}: an ALLOW on long_history`);
      return `| ${code(r.account_id)} | ${e.verdict} | ${e.score} | ${reasonsCell(e)} | ${namedCell(r)} | ${r.category}, ${r.facts.source_type}. ${WHY[r.account_id](r, e)} |`;
    })
    .join("\n");
  must(Object.keys(WHY).length === sus.length, "one note per suspicious row, and no note for a row that is gone");

  // ------------------------------------------------------------------ every false positive
  const codeChange = (e) => {
    const r = e.reasons.find((x) => x.code === "code_changed_recently");
    const m = /^code hash (\S+) at block #(\d+) became (\S+) within 72 h$/.exec(r?.detail ?? "");
    must(m, `${e.account_id}: a code change detail`);
    return { before: `${m[1].slice(0, 8)}...`, block: m[2], after: `${m[3].slice(0, 8)}...` };
  };
  const TOKEN_FP = () =>
    `Weak ${code("parent_swap")}: the same first label ${code("token")} as a listed ${code("token.*")} account, under another parent. Each of the ${listedTokens.length} listed ones (${fill.LISTED_TOKENS}) gives this same weak match; the engine names ${code(fill.TIE_NAME)} only because it breaks ties between equal matches in sorted order. Without ${code(fill.TIE_NAME)} the WARN stays, matched to ${code(fill.NEXT_MATCH)}, and it stays with only the top 10 on the list (list sensitivity). The rule was written for role labels such as ${code("agent.alice.testnet")} against ${code("agent.bob.testnet")}; on NEAR, ${code("token.<project>")} is the usual name of a token contract, so every ${code("token.*")} contract outside the list matches. A weak match only warns and never denies, and age does not clear it. ALLOW without the brand list.`;
  const FP_WHY = {
    "outlayer.near": (e) => {
      const c = codeChange(e);
      return `Its contract was upgraded inside the 72 h window: code hash ${code(c.before)} at the probe block ${c.block} became ${code(c.after)}. Any code change in that window holds a payment for one owner tap, by design, whoever the payee is.`;
    },
    "v1.signer": (e) => {
      const c = codeChange(e);
      return `The Chain Signatures contract was upgraded inside the 72 h window: ${code(c.before)} became ${code(c.after)}. Same rule, same reason.`;
    },
  };
  for (const e of fpToken) {
    must(a.get(e.account_id).verdict === "ALLOW", `${e.account_id}: ALLOW without the brand list`);
    FP_WHY[e.account_id] = TOKEN_FP;
  }
  fill.FP_ROWS = main.flagged_known_good
    .map((m) => {
      const e = v.get(m.account_id);
      must(typeof FP_WHY[m.account_id] === "function", `no note for false positive ${m.account_id}`);
      return `| ${code(m.account_id)} | ${e.verdict} | ${e.score} | ${reasonsCell(e)} | ${row.get(m.account_id).category}. ${FP_WHY[m.account_id](e)} |`;
    })
    .join("\n");
  const kgAllow = kg.filter((r) => v.get(r.account_id).verdict === "ALLOW");
  const kgScores = [...new Set(kgAllow.map((r) => v.get(r.account_id).score))];
  must(kgScores.length === 1 && kgAllow.every((r) => reasonsCell(v.get(r.account_id)) === LONG), "every known_good ALLOW has one score and long_history");
  fill.N_KG_ALLOW = kgAllow.length;
  fill.KG_ALLOW_SCORE = kgScores[0];

  // ------------------------------------------------------------------ lookalike sample
  fill.SEED = sel.counts.lookalike_candidate.seed;
  const strata = sel.counts.lookalike_candidate.strata;
  fill.N_BRAND = strata["all:created_by_brand"].rows;
  fill.N_RECENT = strata["all:created_last_30d"].rows;
  fill.N_TAKEALL = fill.N_BRAND + fill.N_RECENT;
  fill.N_DRAWS = look.length - fill.N_TAKEALL;
  fill.N_PROP_ROWS = Object.entries(strata)
    .filter(([k]) => k.startsWith("prop:"))
    .reduce((n, [, x]) => n + x.rows, 0);
  const group = (s) => (s.startsWith("all:") ? s : s.split(":").slice(0, 2).join(":"));
  const G = new Map();
  for (const [k, x] of Object.entries(strata)) {
    const g = group(k);
    if (!G.has(g)) G.set(g, { rows: 0, sampled: 0, ALLOW: 0, WARN: 0, DENY: 0, ablWarn: 0 });
    G.get(g).rows += x.rows;
    G.get(g).sampled += x.sampled;
  }
  let wLow = 0;
  let wLook = 0;
  let wBoth = 0;
  for (const x of look) {
    const e = v.get(x.account_id);
    must(l.get(x.account_id).verdict === e.verdict, `${x.account_id}: no lookalike row is on the list`);
    const g = G.get(group(x.stratum));
    g[e.verdict]++;
    if (a.get(x.account_id).verdict === "WARN") g.ablWarn++;
    if (e.verdict !== "WARN") continue;
    const d = e.deciding.join("+");
    if (d === "low_activity") wLow++;
    else if (d === "lookalike_known") wLook++;
    else if (d === "lookalike_known+low_activity") wBoth++;
    else must(false, `unexpected deciding set ${d} on ${x.account_id}`);
  }
  const GNAME = {
    "all:created_by_brand": "take-all: created by the brand itself",
    "all:created_last_30d": "take-all: created in the 30 days before the dataset check",
    "prop:after_brand": "proportional: created after the brand",
    "prop:predates_brand": "proportional: created before the brand",
  };
  fill.STRATA_ROWS = [...G.entries()].map(([g, x]) => `| ${GNAME[g] ?? g} | ${x.rows} | ${x.sampled} | ${x.ALLOW} | ${x.WARN} | ${x.DENY} | ${x.ablWarn} |`).join("\n");
  fill.N_LOOK_WARN = wLow + wLook + wBoth;
  fill.W_LOW = wLow;
  fill.W_LOOK = wLook;
  fill.W_BOTH = wBoth;
  const oldLk = look
    .filter((x) => row.get(x.account_id).facts.predates_brand === true && v.get(x.account_id).deciding.includes("lookalike_known"))
    .map((x) => x.account_id)
    .sort();
  fill.N_OLD_LK = oldLk.length;
  fill.OLD_LK_NAMES = oldLk.map(code).join(", ");
  const takeAll = look.filter((x) => x.stratum.startsWith("all:")).sort((x, y) => cmp(x.stratum, y.stratum) || cmp(x.account_id, y.account_id));
  fill.TAKEALL_ROWS = takeAll
    .map((x) => {
      const e = v.get(x.account_id);
      const f = row.get(x.account_id).facts;
      let note = `imitates ${code(f.imitates)}; created ${day(f.created_at)} by ${code(short(f.creator))}; ${plural(f.txs_count, "transaction")} by the dataset's count`;
      if (f.created_by_brand) note += "; a defensive registration by the brand's own account";
      if (e.verdict === "ALLOW" && !e.reasons.some((r) => r.severity === "positive")) {
        const age = daysBetween(block.utc, f.created_at);
        must(age > 3 && age < 30 && f.txs_count >= 5 && !matchOf(x.account_id) && e.score === 600, `${x.account_id}: between the 72 h and 30-day lines, 5 or more transactions, no match`);
        note += `; about ${age} days old at the block, so past the 72 h and 5-transaction lines but short of 30 days, and no brand-list name is close: no warning and no positive, ALLOW at the base score ${e.score}`;
      }
      return `| ${code(x.account_id)} | ${x.stratum.replace("all:", "")} | ${e.verdict} | ${reasonsCell(e)} | ${note} |`;
    })
    .join("\n");
  // The busiest creator among the take-all names: held only for thin history, never matched.
  const byCreator = new Map();
  for (const x of takeAll) {
    const c = row.get(x.account_id).facts.creator;
    if (!byCreator.has(c)) byCreator.set(c, []);
    byCreator.get(c).push(x.account_id);
  }
  const [bulkCreator, bulk] = [...byCreator.entries()].sort((x, y) => y[1].length - x[1].length || cmp(x[0], y[0]))[0];
  for (const id of bulk) {
    must(v.get(id).verdict === "WARN" && v.get(id).deciding.join("+") === "low_activity" && row.get(id).facts.txs_count === 1 && !matchOf(id), `${id}: held only for low_activity, 1 transaction, no match`);
  }
  must(!known.includes("intents.near") && known.includes("wrap.near") && bulk.includes("wr4p.near"), "the bulk names: intents.near is not listed, wrap.near is, wr4p.near is one of them");
  fill.N_BULK = bulk.length;
  fill.BULK_CREATOR = short(bulkCreator);
  fill.BULK_DAYS = listJoin([...new Set(bulk.map((id) => day(row.get(id).facts.created_at)))].sort());

  // ------------------------------------------------------------------ limits
  const c = main.cautious;
  fill.RECALL_STEP = (100 / fill.N_SUS).toFixed(1);
  fill.PREC_UP = (((c.tp + 1) / (c.tp + c.fp + 1) - c.tp / (c.tp + c.fp)) * 100).toFixed(1);
  fill.PREC_DOWN = ((c.tp / (c.tp + c.fp) - c.tp / (c.tp + c.fp + 1)) * 100).toFixed(1);

  // ------------------------------------------------------------------ scorer output, verbatim
  fill.SCORE_MAIN = scorerOutput("verdicts.json");
  fill.SCORE_SELF = scorerOutput("verdicts.leave-self-out.json");
  fill.SCORE_ABLATION = scorerOutput("verdicts.no-known.json");

  // ------------------------------------------------------------------ fill
  const used = new Set();
  let text = fs.readFileSync(TEMPLATE, "utf8").replace(/@@([A-Z0-9_]+)@@/g, (m, k) => {
    must(k in fill, `no value for ${m}`);
    used.add(k);
    return String(fill[k]);
  });
  const unused = Object.keys(fill).filter((k) => !used.has(k));
  must(unused.length === 0, `values no placeholder uses: ${unused.join(", ")}`);
  const bad = text.match(/[^\x09\x0a\x20-\x7e]/g);
  must(!bad, `non-ASCII characters: ${[...new Set(bad ?? [])].join(" ")}`);
  text = text.replace(/\n*$/, "\n");
  return text;
}

export async function main(argv) {
  const check = argv.includes("--check");
  const unknown = argv.filter((x) => x !== "--check");
  if (unknown.length) throw new Error(`unknown argument ${unknown[0]} (only --check)`);
  const text = await buildReport();
  if (!check) {
    fs.writeFileSync(OUTPUT, text);
    process.stdout.write(`wrote ${path.relative(process.cwd(), OUTPUT)} (${text.length} bytes)\n`);
    return 0;
  }
  const committed = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, "utf8") : null;
  if (committed === text) {
    process.stdout.write("ok: RESULTS.md is exactly what report.mjs produces from the committed files\n");
    return 0;
  }
  if (committed === null) {
    process.stdout.write("FAIL: RESULTS.md does not exist\n");
    return 1;
  }
  const want = text.split("\n");
  const have = committed.split("\n");
  let i = 0;
  while (i < want.length && want[i] === have[i]) i++;
  process.stdout.write(`FAIL: RESULTS.md differs from report.mjs's output at line ${i + 1}\n  committed: ${have[i] ?? "(end of file)"}\n  generated: ${want[i] ?? "(end of file)"}\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = 2;
    },
  );
}

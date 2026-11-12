// Offline checks of the real-data dataset: shape, citations, the campaign rule, that every
// lookalike row is re-derived by the documented generator rule, and that the summary and the
// README state what the data says. No network. Run: node --test "scan/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateLookalikes, brandRoots, ancestorsOf, stemsOf, annotateLookalikes, derivedQuote, GENERATOR_VERSION } from "./lookalikes.mjs";
import { isValidAccountId, asciiQuote } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(path.join(HERE, p), "utf8"));
const dataset = read("dataset.json");
const summary = read("dataset.summary.json");
const known = read("seeds/known-good.json").accounts;
const suspicious = read("seeds/suspicious.json").accounts;
const LABELS = new Set(["known_good", "suspicious", "lookalike_candidate"]);
const byLabel = (l) => dataset.filter((e) => e.label === l);
const CAMPAIGN = "onchain_campaign_link";

test("every row has the published schema", () => {
  assert.ok(Array.isArray(dataset) && dataset.length > 0);
  for (const e of dataset) {
    const where = e.account_id;
    assert.ok(isValidAccountId(e.account_id), `${where}: invalid account id`);
    assert.equal(e.network, "mainnet", where);
    assert.ok(LABELS.has(e.label), `${where}: label ${e.label}`);
    assert.equal(typeof e.category, "string", where);
    assert.ok(e.category.length > 0, where);
    assert.equal(typeof e.exists, "boolean", where);
    assert.match(e.checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, where);
    assert.equal(typeof e.notes, "string", where);
    assert.equal(typeof e.facts, "object", where);
    assert.ok(Array.isArray(e.evidence) && e.evidence.length > 0, `${where}: no evidence`);
    for (const ev of e.evidence) {
      assert.match(ev.url, /^https:\/\//, `${where}: evidence url`);
      assert.match(ev.date, /^\d{4}-\d{2}-\d{2}$/, `${where}: evidence date`);
      assert.ok(typeof ev.quote === "string" && ev.quote.length > 0, `${where}: empty quote`);
    }
  }
});

test("account ids are unique and labels do not overlap", () => {
  const ids = dataset.map((e) => e.account_id);
  assert.equal(new Set(ids).size, ids.length);
  const k = new Set(known.map((s) => s.account_id));
  for (const s of suspicious) assert.ok(!k.has(s.account_id), `${s.account_id} is both known_good and suspicious`);
});

test("the published file is plain ASCII (quotes from other pages are normalized)", () => {
  const raw = fs.readFileSync(path.join(HERE, "dataset.json"), "utf8");
  assert.ok(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(raw), "non-ASCII character in dataset.json");
  for (const e of dataset) for (const ev of e.evidence) assert.equal(asciiQuote(ev.quote), ev.quote, `${e.account_id}: quote not normalized`);
});

test("known_good and suspicious rows are exactly the cited seeds, with their citations and grades", () => {
  for (const [label, seeds, min] of [["known_good", known, 40], ["suspicious", suspicious, 30]]) {
    const rows = byLabel(label);
    assert.ok(rows.length >= min, `${label}: ${rows.length} rows, want >= ${min}`);
    assert.deepEqual(rows.map((r) => r.account_id).sort(), seeds.map((s) => s.account_id).sort(), label);
    const seedById = new Map(seeds.map((s) => [s.account_id, s]));
    for (const r of rows) {
      const s = seedById.get(r.account_id);
      assert.deepEqual(r.evidence, s.evidence, `${r.account_id}: evidence differs from the seed`);
      assert.equal(r.category, s.category, r.account_id);
      if (label === "suspicious") {
        assert.equal(r.facts.source_type, s.source_type, `${r.account_id}: source_type differs from the seed`);
        assert.equal(r.facts.incident, s.incident, `${r.account_id}: incident differs from the seed`);
      }
    }
  }
  for (const r of byLabel("known_good")) assert.equal(r.exists, true, `known_good ${r.account_id} must exist`);
});

test("suspicious rows say what kind of source backs them", () => {
  const kinds = new Set(["security_writeup", "project_incident_report", "victim_report", "researcher_dataset", CAMPAIGN]);
  for (const s of suspicious) {
    assert.ok(kinds.has(s.source_type), `${s.account_id}: source_type ${s.source_type}`);
    assert.ok(s.incident, `${s.account_id}: incident`);
    if (s.source_type === CAMPAIGN) {
      assert.ok(s.evidence.some((e) => e.url.startsWith("https://nearblocks.io/txns/")), `${s.account_id}: campaign link needs its creation tx`);
    } else {
      assert.ok(s.evidence.some((e) => !e.url.startsWith("https://nearblocks.io/")), `${s.account_id}: needs a third-party report`);
    }
    // researcher_dataset means the scan flags this very account, with its own evidence file.
    if (s.source_type === "researcher_dataset") {
      assert.ok(s.evidence.some((e) => e.url.endsWith(`/evidence/account/${s.account_id}.json`)), `${s.account_id}: researcher_dataset needs the scan's evidence for this account`);
    }
  }
});

test("campaign rule: each onchain_campaign_link row advertises a website and is tied to a reported account by create_account transactions", () => {
  const CREATE = /^signer (\S+) receiver near create_account \{"new_account_id":"([^"]+)"/;
  const campaign = suspicious.filter((s) => s.source_type === CAMPAIGN);
  assert.ok(campaign.length > 0);
  const links = new Map();
  for (const s of campaign) {
    const lure = s.evidence.find((e) => e.url === `https://nearblocks.io/address/${s.account_id}`);
    assert.ok(lure && /"name":"[^"]*https?:\/\//.test(lure.quote), `${s.account_id}: its own ft_metadata name must advertise a website`);
    const txs = s.evidence.filter((e) => e.url.startsWith("https://nearblocks.io/txns/"));
    const others = txs.map((e) => {
      const m = e.quote.match(CREATE);
      assert.ok(m, `${s.account_id}: a creation quote reads "signer X receiver near create_account {"new_account_id":"Y"" (${e.quote})`);
      const [, signer, created] = m;
      assert.ok(signer === s.account_id || created === s.account_id, `${s.account_id}: the transaction must create it or be signed by it`);
      return signer === s.account_id ? created : signer;
    });
    links.set(s.account_id, others);
  }
  // Start from the accounts a third-party report names in the same incident and grow the set
  // through the creation links; every campaign row must be reached.
  for (const incident of new Set(campaign.map((s) => s.incident))) {
    const reached = new Set(suspicious.filter((s) => s.incident === incident && s.source_type !== CAMPAIGN).map((s) => s.account_id));
    assert.ok(reached.size > 0, `${incident}: no third-party report to start from`);
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of campaign) {
        if (s.incident !== incident || reached.has(s.account_id)) continue;
        if (links.get(s.account_id).some((o) => reached.has(o))) {
          reached.add(s.account_id);
          grew = true;
        }
      }
    }
    for (const s of campaign.filter((c) => c.incident === incident)) assert.ok(reached.has(s.account_id), `${s.account_id} is not linked to a reported account`);
  }
});

test("every account that exists says when it was created, or why it cannot", () => {
  for (const e of dataset) {
    if (!e.exists) continue;
    const f = e.facts;
    assert.ok(f.created_at || f.enrichment_error || f.creation_indexed === false, `${e.account_id}: no created_at, no enrichment_error, no creation_indexed: false`);
    assert.ok(typeof f.full_access_keys === "number" || f.enrichment_error, `${e.account_id}: no key counts and no enrichment_error`);
  }
});

test("suspicious rows carry the lookalike rule exactly when the generator produces their name", () => {
  const generated = new Map(generateLookalikes(known).map((c) => [c.account_id, c]));
  const annotated = [];
  for (const r of byLabel("suspicious")) {
    const c = generated.get(r.account_id);
    assert.equal(r.facts.lookalike_of, c?.imitates, `${r.account_id}: lookalike_of`);
    assert.equal(r.facts.lookalike_rule, c?.rule, `${r.account_id}: lookalike_rule`);
    if (c) annotated.push(r.account_id);
  }
  assert.deepEqual(annotated.sort(), ["linear_protocol.near", "lonkrewards.near", "metapools.near"]);
});

test("every lookalike_candidate is re-derived by the generator and existed when checked", () => {
  const rows = byLabel("lookalike_candidate");
  const generated = new Map(generateLookalikes(known).map((c) => [c.account_id, c]));
  for (const r of rows) {
    const c = generated.get(r.account_id);
    assert.ok(c, `${r.account_id} is not produced by scan/lookalikes.mjs`);
    assert.equal(r.category, c.rule, r.account_id);
    assert.equal(r.facts.imitates, c.imitates, r.account_id);
    assert.equal(r.facts.stem, c.stem, r.account_id);
    assert.equal(r.exists, true, r.account_id);
    assert.equal(typeof r.facts.block_height, "number", r.account_id);
  }
});

test("lookalike rows: cross-row facts, notes and the evidence line recompute from the dataset", () => {
  const published = byLabel("lookalike_candidate");
  const recomputed = annotateLookalikes(structuredClone(published), byLabel("known_good"), known);
  for (const [i, p] of published.entries()) {
    const r = recomputed[i];
    for (const k of ["created_by_brand", "creator_lookalikes", "predates_brand"]) assert.equal(p.facts[k], r.facts[k], `${p.account_id}: ${k}`);
    assert.equal(p.notes, r.notes, `${p.account_id}: notes`);
    assert.equal(p.evidence.length, 1, p.account_id);
    assert.equal(p.evidence[0].quote, derivedQuote(p.facts, p.facts), `${p.account_id}: the evidence line must state exactly what was read`);
    assert.equal(p.evidence[0].url, `https://nearblocks.io/address/${p.account_id}`, p.account_id);
  }
});

test("summary counts match the dataset", () => {
  const L = byLabel("lookalike_candidate");
  const S = byLabel("suspicious");
  assert.equal(summary.generator, GENERATOR_VERSION);
  assert.equal(summary.counts.known_good, byLabel("known_good").length);
  assert.equal(summary.counts.known_good_existing, byLabel("known_good").filter((e) => e.exists).length);
  assert.equal(summary.counts.suspicious, S.length);
  assert.equal(summary.counts.suspicious_existing, S.filter((e) => e.exists).length);
  assert.equal(summary.counts.suspicious_named_by_third_party, S.filter((e) => e.facts.source_type !== CAMPAIGN).length);
  assert.equal(summary.counts.lookalike_candidate, L.length);
  const count = (rows, key) => rows.reduce((m, r) => ((m[key(r)] = (m[key(r)] ?? 0) + 1), m), {});
  assert.deepEqual(summary.suspicious_by_source_type, count(S, (e) => e.facts.source_type));
  assert.deepEqual(summary.lookalike_by_rule, count(L, (e) => e.category));
  assert.equal(summary.lookalike_flags.created_by_brand, L.filter((e) => e.facts.created_by_brand).length);
  assert.equal(summary.lookalike_flags.predates_brand, L.filter((e) => e.facts.predates_brand === true).length);
  assert.equal(summary.lookalike_flags.mimicwatch_overlap, L.filter((e) => e.facts.mimicwatch_2026_11_01).length);
  // The sweep checked every generated name; the names that exist are the lookalike rows plus the
  // suspicious rows the generator also produces.
  assert.equal(summary.lookalike_sweep.generated, generateLookalikes(known).length);
  assert.equal(summary.lookalike_sweep.existing, L.length + S.filter((e) => e.exists && e.facts.lookalike_rule).length);
  assert.equal(summary.lookalike_sweep.unchecked, 0);
  const heights = dataset.map((e) => e.facts.block_height);
  assert.deepEqual(summary.block_height_range, [Math.min(...heights), Math.max(...heights)]);
  const times = dataset.map((e) => e.checked_at).sort();
  assert.deepEqual(summary.checked_at_window, [times[0], times[times.length - 1]]);
});

test("README states the numbers the data has", () => {
  const readme = fs.readFileSync(path.join(HERE, "README.md"), "utf8");
  const n = (x) => x.toLocaleString("en-US");
  const has = (re, what) => assert.match(readme, re, `README: ${what}`);
  const c = summary.counts;
  has(new RegExp(`\\| \`known_good\` \\| ${c.known_good} \\| ${c.known_good_existing} \\|`), "known_good row of the snapshot table");
  has(new RegExp(`\\| \`suspicious\` \\| ${c.suspicious} \\| ${c.suspicious_existing} `), "suspicious row of the snapshot table");
  has(new RegExp(`\\| \`lookalike_candidate\` \\| ${c.lookalike_candidate} \\|`), "lookalike_candidate row of the snapshot table");
  has(new RegExp(`generated ${n(summary.lookalike_sweep.generated)} names from the known_good brands; ${n(summary.lookalike_sweep.existing)} exist`), "sweep sentence");
  has(new RegExp(`between mainnet blocks ${summary.block_height_range[0]} and ${summary.block_height_range[1]}`), "block range");
  has(new RegExp(`${c.suspicious_named_by_third_party} of the ${c.suspicious} suspicious rows`), "third-party share");
  for (const [type, rows] of Object.entries(summary.suspicious_by_source_type)) has(new RegExp(`\\| \`${type}\` \\|[^\\n]*\\| ${rows} \\|`), `source_type table row ${type}`);
  has(new RegExp(`${summary.lookalike_flags.predates_brand} of the ${c.lookalike_candidate} names were created before`), "predates_brand count");
  has(new RegExp(`${summary.lookalike_flags.mimicwatch_overlap} of the ${c.lookalike_candidate} names were also found by MimicWatch`), "MimicWatch overlap");
});

test("generator: deterministic, valid ids, never the brand's own namespace or an ancestor of a brand", () => {
  const a = generateLookalikes(known);
  const b = generateLookalikes(structuredClone(known));
  assert.deepEqual(a, b);
  const roots = brandRoots(known.map((s) => s.account_id));
  const ancestors = ancestorsOf(known.map((s) => s.account_id));
  const ids = new Set(known.map((s) => s.account_id));
  for (const c of a) {
    assert.ok(isValidAccountId(c.account_id), c.account_id);
    assert.ok(!ids.has(c.account_id), `${c.account_id} is a known_good account`);
    assert.ok(!ancestors.has(c.account_id), `${c.account_id} is an ancestor of a known_good account`);
    for (const r of roots) assert.ok(c.account_id !== r && !c.account_id.endsWith("." + r), `${c.account_id} is under brand root ${r}`);
  }
  assert.ok(ancestors.has("mintbase1.near") && !a.some((c) => c.account_id === "mintbase1.near"), "Mintbase's own factory is not a lookalike");
  const sorted = [...a].map((c) => c.account_id);
  assert.deepEqual(sorted, [...sorted].sort());
});

test("generator: each documented trick produces its textbook example", () => {
  const out = new Map(generateLookalikes(known).map((c) => [c.account_id, c.rule]));
  assert.equal(out.get("ref-flnance.near"), "homoglyph"); // i -> l
  assert.equal(out.get("linear_protocol.near"), "separator"); // '-' -> '_'
  assert.equal(out.get("metapools.near"), "affix"); // stem "metapool" + "s"
  assert.equal(out.get("contract-main-burrow.near"), "flattened_subaccount");
  assert.equal(out.get("token-sweat.near"), "flattened_subaccount");
  assert.equal(out.get("v2-ref-finance.near"), "affix"); // the "v2-" lure prefix wins over flattening
  assert.equal(out.get("burrow-airdrop.near"), "affix");
  assert.equal(out.get("ref-finance.tg"), "exact_stem_tg");
  assert.ok(!out.has("ref-finance.near"), "the brand root itself is not a lookalike");
  assert.ok(!out.has("anything.blackdragon.tkn.near"));
});

test("stemsOf: brand words and flattened sub-account names", () => {
  assert.deepEqual(stemsOf("v2.ref-finance.near"), { stems: ["ref-finance"], flattened: ["v2-ref-finance", "v2ref-finance", "v2_ref-finance"] });
  assert.deepEqual(stemsOf("token.sweat"), { stems: ["sweat"], flattened: ["token-sweat", "tokensweat", "token_sweat"] });
  assert.deepEqual(stemsOf("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"), { stems: [], flattened: [] });
});

// Replays recorded snapshots (live testnet and mainnet reads of 2026-11-12) with no network, and
// checks what each real answer turns into. Variants change one recorded answer at a time.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSnapshot, formatEvidence, normalize, SnapshotError, verdictFromSnapshot } from "../src/engine/index.ts";
import type { JsonValue, Snapshot } from "../src/engine/types.ts";
import { clone, fixture, setView, snapshotFixture, withVault } from "./helpers.ts";

const PINNED: Record<string, { verdict: string; score: number; codes: string[]; snapshot_sha256: string; chain_sha256: string }> = {
  "snapshot-merchant.testnet.json": {
    verdict: "WARN",
    score: 440,
    codes: ["new_account", "low_activity", "usdc_unregistered", "registry_not_deployed"],
    snapshot_sha256: "70e404a9498510c72132d3688bc0826039d01347a53b6b789c86448111777af9",
    chain_sha256: "3782912bdc2e279b3456533e745fb0a77de8a8e09b23d79ba42d5687e88ce90f",
  },
  "snapshot-wrap.testnet.json": {
    verdict: "ALLOW",
    score: 680,
    codes: ["long_history", "contract_account", "usdc_unregistered", "registry_not_deployed"],
    snapshot_sha256: "d042ede1a4406f5a42c05c6e69aa3dd50cb2dae3cd150bc0f7869d6c8e3e3c1f",
    chain_sha256: "0c09319ed1c03f24af35e92f04dfd5ee250aa5040f34c9fda2d14b37a54bc085",
  },
  "snapshot-missing.testnet.json": {
    verdict: "DENY",
    score: 199,
    codes: ["account_not_found", "usdc_unregistered", "registry_not_deployed"],
    snapshot_sha256: "0b7ba6986969f6980c0511788ab0d1da651a01f45a8840f4135311b181d488a8",
    chain_sha256: "2e939a5fd77049eefaf3e09332cb41cd07acc2312c107be19114d94d4e9d0a31",
  },
  "snapshot-burrowfinancedao.near.json": {
    verdict: "WARN",
    score: 499,
    codes: ["third_party_flag", "long_history", "contract_account"],
    snapshot_sha256: "617e1de687e2c90276e48479bcca292f92a872945eb57cf588c8b8a3d367c0f9",
    chain_sha256: "e81bb2a23139cfcf5f9c3c52e743ec4841c2b2936d44c7ace4bebcc9b55bd8ed",
  },
  "snapshot-implicit-128-keys.testnet.json": {
    verdict: "ALLOW",
    score: 680,
    codes: ["long_history", "registry_not_deployed"],
    snapshot_sha256: "08e5a3c23809066b9fe1774cd16cb340c0ac6f066064b4f9752c261c260ddfcc",
    chain_sha256: "acf3b016dfe3724cb2a651ce3548b2308210d6562c595e4534c271601f6742af",
  },
};

function withRegistry(snap: Snapshot, verdict: JsonValue, reports: JsonValue = []): Snapshot {
  const s = clone(snap);
  const reg = s.context.registry_id!;
  setView(s, "registry.get_verdict", reg, "get_verdict", verdict);
  setView(s, "registry.get_reports", reg, "get_reports", reports);
  setView(s, "registry.report_count", reg, "report_count", Array.isArray(reports) ? reports.length : 0);
  setView(s, "registry.list_verdicts", reg, "list_verdicts", []);
  return s;
}

describe("recorded snapshots replay to pinned verdicts and digests", () => {
  for (const [file, want] of Object.entries(PINNED)) {
    it(file, () => {
      const r = verdictFromSnapshot(snapshotFixture(file));
      assert.equal(r.decision.verdict, want.verdict);
      assert.equal(r.decision.score, want.score);
      assert.deepEqual(r.decision.reasons.map((x) => x.code), want.codes);
      assert.equal(r.snapshot_sha256, want.snapshot_sha256);
      assert.equal(r.chain_sha256, want.chain_sha256);
      assert.ok(Buffer.byteLength(formatEvidence(r)) <= 256);
    });
  }

  it("the merchant's age comes from the archival probe 72 h back, not from an indexer", () => {
    const s = normalize(snapshotFixture("snapshot-merchant.testnet.json"));
    assert.equal(s.age.state, "ok");
    if (s.age.state === "ok") {
      assert.equal(s.age.is_new, true);
      assert.match(s.age.source, /^rpc archival view_account@276858896$/);
    }
    assert.equal(s.activity.state === "ok" && s.activity.tx_count, 1);
    assert.ok(s.third_party.every((t) => t.state === "ok" && !t.flagged));
  });

  it("view_access_key_list is read across pages (128 keys, two pages of 100)", () => {
    const snap = snapshotFixture("snapshot-implicit-128-keys.testnet.json");
    assert.ok(snap.rpc.some((r) => r.label === "keys#1"));
    const s = normalize(snap);
    assert.equal(s.keys.state === "ok" && s.keys.total, 128);
  });

  it("a mainnet payee is checked against MimicWatch's testnet registry, at the latest testnet block at or before the mainnet block", () => {
    const snap = snapshotFixture("snapshot-burrowfinancedao.near.json");
    const read = snap.rpc.find((r) => r.label === "third_party.mimicwatch")!;
    assert.equal(read.network, "testnet");
    const header = (label: string) => (snap.rpc.find((r) => r.label === label && r.network === "testnet")!.result as { header: { height: number; hash: string; prev_hash: string; timestamp_nanosec: string } }).header;
    const chosen = header("block.testnet");
    const next = header("block.testnet.next");
    assert.equal(read.params.block_id, chosen.height);
    assert.ok(BigInt(chosen.timestamp_nanosec) <= BigInt(snap.block.timestamp_ns));
    assert.ok(BigInt(next.timestamp_nanosec) > BigInt(snap.block.timestamp_ns));
    assert.equal(next.prev_hash, chosen.hash);
    const s = normalize(snap);
    const mw = s.third_party[0]!;
    assert.ok(mw.state === "ok" && mw.flagged && mw.detail.includes("fake-token"));
  });
});

describe("variants of real snapshots", () => {
  const merchant = snapshotFixture("snapshot-merchant.testnet.json");
  const wrap = snapshotFixture("snapshot-wrap.testnet.json");

  it("the demo flow: a first payment waits; once the owner has paid this payee, later payments are ALLOW", () => {
    assert.equal(verdictFromSnapshot(withVault(merchant, { paid: 0 })).decision.verdict, "WARN");
    const after = verdictFromSnapshot(withVault(merchant, { paid: 1 })).decision;
    assert.equal(after.verdict, "ALLOW");
    assert.ok(after.reasons.find((r) => r.code === "new_account")?.cleared_by === "prior_payments");
  });

  it("a registry DENY on an old, active account is DENY", () => {
    const d = verdictFromSnapshot(
      withRegistry(wrap, { account_id: "wrap.testnet", verdict: "DENY", reasons: ["drainer"], evidence: null, score: 10, code_hash: null, updated_at_ns: "1794450000000000000", updated_by: "oracle.a-identity.testnet", expires_at_ns: null }),
    ).decision;
    assert.equal(d.verdict, "DENY");
    assert.equal(d.reasons[0]!.code, "registry_deny");
  });

  it("a registry answer the vault would not accept (lower-case verdict) fails closed as WARN, as on chain", () => {
    const d = verdictFromSnapshot(withRegistry(wrap, { account_id: "wrap.testnet", verdict: "deny", reasons: [] })).decision;
    assert.equal(d.verdict, "WARN");
    assert.ok(d.reasons.some((r) => r.code === "registry_unreadable"));
  });

  it("a v1.0 vault without guard_refusal_count is still read", () => {
    const s = normalize(withVault(wrap, { paid: 0, guard: "missing" }));
    assert.equal(s.vault.state, "ok");
    assert.equal(s.vault.state === "ok" && s.vault.guard_refusal_count, null);
  });

  it("without any indexer answer an otherwise clean account is WARN indexer_unavailable", () => {
    const s = clone(wrap);
    s.http = [];
    const d = verdictFromSnapshot(s).decision;
    assert.equal(d.verdict, "WARN");
    assert.ok(d.reasons.some((r) => r.code === "indexer_unavailable"));
  });

  it("a probe block outside its window is not trusted; age falls back to the indexer and says so", () => {
    const s = clone(merchant);
    const probe = s.rpc.find((r) => r.label === "probe.recent.block")!;
    (probe.result as { header: { timestamp_nanosec: string } }).header.timestamp_nanosec = s.block.timestamp_ns;
    const sig = normalize(s);
    assert.equal(sig.age.state === "ok" && sig.age.source, "indexer fastnear");
    assert.ok(sig.age.state === "ok" && /probe unusable/.test(sig.age.detail));
    assert.equal(verdictFromSnapshot(s).decision.verdict, "WARN");
  });

  it("the same snapshot always replays to the same decision", () => {
    assert.deepEqual(verdictFromSnapshot(clone(merchant)), verdictFromSnapshot(clone(merchant)));
  });

  it("earlier keys read at another block than the probe's are not trusted: key history unknown is WARN", () => {
    const s = clone(wrap);
    const probeHeight = (s.rpc.find((r) => r.label === "probe.recent.block")!.result as { header: { height: number } }).header.height;
    // Still before the pinned block, so assertSnapshot accepts it; one block off the probe.
    s.rpc.find((r) => r.label === "probe.recent.keys#0")!.params.block_id = probeHeight - 1;
    assert.equal(assertSnapshot(s), s);
    const sig = normalize(s);
    assert.equal(sig.key_changes.state, "unavailable");
    assert.match(sig.key_changes.state === "unavailable" ? sig.key_changes.why : "", /not pinned to block/);
    const d = verdictFromSnapshot(s).decision;
    assert.equal(d.verdict, "WARN");
    assert.ok(d.reasons.some((r) => r.code === "rpc_unavailable" && /key history/.test(r.detail)));
  });

  it("a probe block whose answer is not the block its request names is not trusted", () => {
    const s = clone(wrap);
    const probe = s.rpc.find((r) => r.label === "probe.recent.block")!;
    probe.params.block_id = (probe.params.block_id as number) + 1;
    const sig = normalize(s);
    assert.equal(sig.key_changes.state, "unavailable");
    assert.equal(verdictFromSnapshot(s).decision.verdict, "WARN");
  });
});

describe("assertSnapshot", () => {
  const good = fixture<Snapshot>("snapshot-merchant.testnet.json");

  it("accepts a recorded snapshot", () => assert.equal(assertSnapshot(clone(good)).subject, "aid-demo-merchant.testnet"));

  const bad: [string, (s: Snapshot) => void, RegExp][] = [
    ["a wrong schema", (s) => ((s as { schema: string }).schema = "other/1"), /schema/],
    ["a duplicate label", (s) => s.rpc.push(clone(s.rpc[0]!)), /duplicate label/],
    ["a read not pinned to the block", (s) => (s.rpc.find((r) => r.label === "account")!.params.block_id = s.block.height - 1), /not pinned/],
    ["a probe pinned after the block", (s) => (s.rpc.find((r) => r.label === "probe.recent.account")!.params.block_id = s.block.height + 5), /probe must be pinned before/],
    ["a block record that does not match", (s) => (s.block.hash = "11111111111111111111111111111111"), /does not match/],
    ["an invalid subject", (s) => (s.subject = "Not An Account"), /subject/],
    // Every time line (72 h, 30 days, the probe window) is drawn from block.timestamp_ns, so it
    // must be the chain's own timestamp for that block: an hour later would age every account.
    ["a pinned timestamp that is not the block's", (s) => (s.block.timestamp_ns = (BigInt(s.block.timestamp_ns) + 3_600_000_000_000n).toString()), /does not match/],
    ["a snapshot without its block record", (s) => (s.rpc = s.rpc.filter((r) => r.label !== "block")), /no block record/],
    ["a block record read at another height", (s) => (s.rpc.find((r) => r.label === "block")!.params.block_id = s.block.height - 1), /does not match/],
  ];
  for (const [what, mutate, msg] of bad) {
    it(`refuses ${what}`, () => {
      const s = clone(good);
      mutate(s);
      assert.throws(() => assertSnapshot(s), (e: unknown) => e instanceof SnapshotError && msg.test(e.message));
    });
  }

  it("refuses an answer from the other network that is not pinned to the block recorded for it", () => {
    const s = fixture<Snapshot>("snapshot-burrowfinancedao.near.json");
    assert.ok(assertSnapshot(clone(s)));
    s.rpc.find((r) => r.label === "third_party.mimicwatch")!.params.block_id = 1;
    assert.throws(() => assertSnapshot(s), (e: unknown) => e instanceof SnapshotError && /must be pinned to the block recorded as block\.testnet/.test(e.message));
  });
});

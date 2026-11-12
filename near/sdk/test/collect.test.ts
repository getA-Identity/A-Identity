// The collector, end to end, against recorded HTTP exchanges from a live read-only run on
// 2026-11-12 (block responses trimmed to their header, which is all the collector reads).
// Replaying them must rebuild the very same snapshot: same digests, same verdict.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectSnapshot, CollectError } from "../src/collect/snapshot.ts";
import { createReader, RpcAnswerError, type FetchLike, type RpcReader } from "../src/collect/rpc.ts";
import { assertSnapshot, chainSha256, snapshotSha256, verdictFromSnapshot } from "../src/engine/index.ts";
import type { Network, RpcRecord, Snapshot } from "../src/engine/types.ts";
import { fixture, noNetwork, noSleep, replayFetch, stubReader, type Exchange } from "./helpers.ts";

type Recorded = {
  options: { account: string; network: Network; known: string[]; vault: string | null };
  expected: { verdict: string; score: number; codes: string[]; snapshot_sha256: string; chain_sha256: string; block: { height: number } };
  exchanges: Exchange[];
};

const clock = () => new Date("2026-11-12T00:00:00.000Z");

async function replay(file: string, fetchImpl?: FetchLike) {
  const rec = fixture<Recorded>(file);
  const calls: string[] = [];
  const snapshot = await collectSnapshot({
    account: rec.options.account,
    network: rec.options.network,
    known: rec.options.known,
    vault: rec.options.vault,
    fetch: fetchImpl ?? replayFetch(rec.exchanges, calls),
    clock,
    sleep: noSleep,
  });
  return { rec, snapshot, calls };
}

describe("collectSnapshot against recorded exchanges", () => {
  for (const file of ["collect-merchant.json", "collect-lookalike.json"]) {
    it(`${file}: rebuilds the same snapshot and verdict without touching the network`, async () => {
      const { rec, snapshot, calls } = await replay(file);
      assert.equal(snapshot.block.height, rec.expected.block.height);
      assert.equal(chainSha256(snapshot), rec.expected.chain_sha256);
      assert.equal(snapshotSha256(snapshot), rec.expected.snapshot_sha256);
      const d = verdictFromSnapshot(snapshot).decision;
      assert.equal(d.verdict, rec.expected.verdict);
      assert.equal(d.score, rec.expected.score);
      assert.deepEqual(d.reasons.map((r) => r.code), rec.expected.codes);
      assert.ok(calls.length > 0);
    });
  }

  it("every state read in the snapshot is pinned to the block (probes to an earlier one)", async () => {
    const { snapshot } = await replay("collect-merchant.json");
    for (const r of snapshot.rpc) {
      if (r.method !== "query" || r.network !== snapshot.network) continue;
      if (r.label.startsWith("probe.")) assert.ok((r.params.block_id as number) < snapshot.block.height, r.label);
      else assert.equal(r.params.block_id, snapshot.block.height, r.label);
    }
  });

  it("the lookalike payee is refused for the reasons a judge can read", async () => {
    const { snapshot } = await replay("collect-lookalike.json");
    const d = verdictFromSnapshot(snapshot).decision;
    assert.equal(d.verdict, "DENY");
    const look = d.reasons.find((r) => r.code === "lookalike_new_account")!;
    assert.match(look.detail, /aid-demo-merchant\.testnet/);
    assert.match(look.detail, /homoglyph/);
  });

  it("when no RPC endpoint answers there is no snapshot and no verdict: CollectError", async () => {
    await assert.rejects(
      collectSnapshot({
        account: "aid-demo-merchant.testnet",
        readers: { testnet: createReader({ rpc: ["https://down.example"], archival: [], fetch: noNetwork, sleep: noSleep, rounds: 1 }) },
        indexers: false,
        thirdParty: false,
        clock,
      }),
      CollectError,
    );
  });

  it("when the indexers are down the snapshot records it and the verdict is WARN, not ALLOW", async () => {
    const rec = fixture<Recorded>("collect-merchant.json");
    const rpcOnly = rec.exchanges.filter((x) => !/fastnear\.com\/v0|nearblocks\.io/.test(x.url));
    const base = replayFetch(rpcOnly);
    const fetchImpl: FetchLike = (url, init) => (/tx\.test\.fastnear\.com|nearblocks\.io/.test(url) ? Promise.reject(new Error("indexer down")) : base(url, init));
    const snapshot = await collectSnapshot({ account: "aid-demo-merchant.testnet", fetch: fetchImpl, clock, sleep: noSleep });
    assert.ok(snapshot.http.every((h) => typeof h.error === "string"));
    const d = verdictFromSnapshot(snapshot).decision;
    assert.equal(d.verdict, "WARN");
    assert.ok(d.reasons.some((r) => r.code === "indexer_unavailable"));
  });

  it("refuses an invalid account id before any read", async () => {
    await assert.rejects(collectSnapshot({ account: "Not Valid", fetch: noNetwork }), TypeError);
    await assert.rejects(collectSnapshot({ account: "ok.testnet", known: ["Bad Known"], fetch: noNetwork }), TypeError);
  });
});

// ---------------------------------------------------------------------------------------------
// A mainnet payee is also checked against MimicWatch's registry, which lives on testnet. The
// testnet block it is read at must follow from the pinned mainnet block alone, or the same
// mainnet block collected twice gives two chain digests. Synthetic chains, no network: testnet
// makes a block every 600 ms plus a fixed jitter, skips every height that is 3 mod 7, and its
// head moves on between collections.

const MAIN_HEIGHT = 224154515;
const MAIN_TS = 1794450331196124979n;
const TESTNET_BASE = 277300000;
const TESTNET_BASE_TS = MAIN_TS - 3_000_000_000_000n; // 3000 s before the mainnet block

const skipped = (h: number) => h % 7 === 3;
const tsOf = (h: number) => TESTNET_BASE_TS + BigInt(h - TESTNET_BASE) * 600_000_000n + BigInt((h * 7919) % 300) * 1_000_000n;
const hashOf = (h: number) => `T${h}`;
function prevOf(h: number): number {
  let p = h - 1;
  while (skipped(p)) p -= 1;
  return p;
}
function testnetHeader(h: number) {
  return { header: { height: h, hash: hashOf(h), prev_hash: hashOf(prevOf(h)), timestamp_nanosec: tsOf(h).toString() } };
}
/** The answer by brute force: the latest testnet block at or before the mainnet block's time. */
function expectedCrossHeight(): number {
  let best = 0;
  for (let h = TESTNET_BASE; tsOf(h) <= MAIN_TS; h++) if (!skipped(h)) best = h;
  return best;
}
const unknownBlock = () => new RpcAnswerError("HANDLER_ERROR", "UNKNOWN_BLOCK", "DB Not Found Error", "stub");
const viewBytes = (v: unknown) => ({ block_height: 0, block_hash: "x", logs: [], result: [...new TextEncoder().encode(JSON.stringify(v))] });

/** Testnet whose final head is heads[0], then heads[1] on the next read of the head, and so on. */
function testnetReader(heads: number[], seen: Record<string, unknown>[] = []): RpcReader {
  let head = heads[0]!;
  let reads = 0;
  return stubReader((method, p) => {
    seen.push({ method, ...p });
    if (method === "block") {
      if (p.finality === "final") {
        head = heads[Math.min(reads++, heads.length - 1)]!;
        let h = head;
        while (skipped(h)) h -= 1;
        return testnetHeader(h);
      }
      const h = typeof p.block_id === "number" ? p.block_id : Number(String(p.block_id).slice(1));
      if (skipped(h) || h > head) throw unknownBlock();
      return testnetHeader(h);
    }
    if (method === "query" && p.method_name === "is_flagged") {
      assert.ok(typeof p.block_id === "number" && p.block_id <= head);
      return viewBytes({ flagged: false, entry: null, via: null });
    }
    throw new Error(`unexpected testnet read ${method} ${JSON.stringify(p)}`);
  });
}

/** Mainnet with one block and a payee that does not exist. */
const mainnetReader: RpcReader = stubReader((method, p) => {
  if (method === "block") {
    if (p.block_id !== MAIN_HEIGHT) throw unknownBlock();
    return { header: { height: MAIN_HEIGHT, hash: "Gx4HDGEwakKxYQj2UsEwggLSXRSwBeQ21KVVh3yC5hiN", prev_hash: "M0", timestamp_nanosec: MAIN_TS.toString() } };
  }
  if (method === "query" && p.request_type === "view_account") throw new RpcAnswerError("HANDLER_ERROR", "UNKNOWN_ACCOUNT", "does not exist", "stub");
  if (method === "query" && p.method_name === "is_blocklisted") return viewBytes(false);
  if (method === "query" && p.method_name === "storage_balance_of") return viewBytes(null);
  if (method === "query" && p.method_name === "nft_tokens_for_owner") return viewBytes([]);
  throw new Error(`unexpected mainnet read ${method} ${JSON.stringify(p)}`);
});

function collectMainnet(testnet: RpcReader): Promise<Snapshot> {
  return collectSnapshot({ account: "nobody-here-zz9.near", network: "mainnet", atBlock: MAIN_HEIGHT, indexers: false, readers: { mainnet: mainnetReader, testnet }, clock, sleep: noSleep });
}

const recordOf = (s: Snapshot, label: string): RpcRecord | undefined => s.rpc.find((r) => r.label === label);
const headerIn = (r: RpcRecord | undefined) => (r?.result as { header: { height: number; hash: string; prev_hash: string; timestamp_nanosec: string } } | undefined)?.header;

describe("a registry on the other network is read at a block the pinned block alone decides", () => {
  const want = expectedCrossHeight();

  it("two collections of the same mainnet block, minutes of testnet apart, record the same testnet block and one chain digest", async () => {
    const early = await collectMainnet(testnetReader([want + 6_000]));
    const late = await collectMainnet(testnetReader([want + 90_000]));
    assert.equal(chainSha256(early), chainSha256(late));
    for (const s of [early, late]) {
      assertSnapshot(s);
      const chosen = headerIn(recordOf(s, "block.testnet"))!;
      const next = headerIn(recordOf(s, "block.testnet.next"))!;
      assert.equal(chosen.height, want);
      assert.ok(BigInt(chosen.timestamp_nanosec) <= MAIN_TS, "the chosen block is at or before the mainnet block");
      assert.ok(BigInt(next.timestamp_nanosec) > MAIN_TS, "its successor is after it");
      assert.equal(next.prev_hash, chosen.hash, "and directly follows it");
      assert.equal(recordOf(s, "third_party.mimicwatch")!.params.block_id, want);
      assert.equal(recordOf(s, "block.testnet")!.params.block_id, want);
    }
  });

  it("a live pin waits until testnet's final head has passed the pinned time", async () => {
    let sleeps = 0;
    const s = await collectSnapshot({
      account: "nobody-here-zz9.near",
      network: "mainnet",
      atBlock: MAIN_HEIGHT,
      indexers: false,
      readers: { mainnet: mainnetReader, testnet: testnetReader([want - 1, want + 1, want + 40]) },
      clock,
      sleep: async () => void (sleeps += 1),
    });
    assert.ok(sleeps >= 1);
    assert.equal(headerIn(recordOf(s, "block.testnet"))!.height, want);
  });

  it("if testnet never passes the pinned time, nothing is pinned there and MimicWatch counts as not read (info), never as clean", async () => {
    const s = await collectMainnet(testnetReader([want - 1]));
    assert.equal(recordOf(s, "block.testnet"), undefined);
    assert.equal(recordOf(s, "third_party.mimicwatch")!.error!.cause, "UNAVAILABLE");
    assertSnapshot(s);
    const d = verdictFromSnapshot(s).decision;
    assert.ok(d.reasons.some((r) => r.code === "third_party_unreadable" && r.severity === "info"));
    assert.ok(s.meta!.notes.some((n) => /were not read/.test(n)));
  });
});

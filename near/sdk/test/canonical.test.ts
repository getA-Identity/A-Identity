import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalJson, chainSha256, prettyJson, sha256, sha256Hex, snapshotSha256, toHex } from "../src/engine/canonical.ts";
import { clone, snapshotFixture } from "./helpers.ts";

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("sha256 (pure, no node:crypto)", () => {
  it("matches the FIPS 180-4 test vectors", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });
  it("matches node:crypto around every padding boundary and on random input", () => {
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 100_000]) {
      const b = randomBytes(n);
      assert.equal(toHex(sha256(b)), nodeSha(b), `length ${n}`);
    }
  });
  it("hashes UTF-8, not UTF-16", () => assert.equal(sha256Hex("payee \u00e7\u015f \u{1F600}"), nodeSha(Buffer.from("payee \u00e7\u015f \u{1F600}", "utf8"))));
});

describe("canonical JSON", () => {
  it("sorts keys at every level and drops undefined", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it("is independent of key insertion order", () => {
    assert.equal(canonicalJson({ x: 1, y: [1, 2] }), canonicalJson({ y: [1, 2], x: 1 }));
  });
  it("refuses values JSON cannot carry exactly", () => {
    assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ a: 1n }), /unsupported bigint/);
  });
  it("prettyJson round-trips", () => {
    const v = { a: [1, 2, 3], b: { c: "x", d: [{ e: null }] }, f: [] };
    assert.deepEqual(JSON.parse(prettyJson(v)), v);
  });
});

describe("snapshot digests", () => {
  const snap = snapshotFixture("snapshot-merchant.testnet.json");

  it("snapshot_sha256 ignores meta and formatting", () => {
    const a = snapshotSha256(snap);
    const b = clone(snap);
    if (b.meta) b.meta.collected_at = "1999-01-01T00:00:00.000Z";
    assert.equal(snapshotSha256(b), a);
    assert.equal(snapshotSha256(JSON.parse(prettyJson(snap))), a);
  });

  it("chain_sha256 covers only block-pinned reads: indexer answers and record order do not change it", () => {
    const a = chainSha256(snap);
    const b = clone(snap);
    b.http = [];
    b.rpc.reverse();
    assert.equal(chainSha256(b), a);
    assert.notEqual(snapshotSha256(b), snapshotSha256(snap));
  });

  it("any changed answer byte changes both digests", () => {
    const b = clone(snap);
    const rec = b.rpc.find((r) => r.label === "usdc.is_blocklisted")!;
    const bytes = (rec.result as { result: number[] }).result;
    bytes[0] = bytes[0]! ^ 1;
    assert.notEqual(chainSha256(b), chainSha256(snap));
    assert.notEqual(snapshotSha256(b), snapshotSha256(snap));
  });
});

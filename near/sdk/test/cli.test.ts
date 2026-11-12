// The verdict CLI. --offline must work with no network at all: these tests give it a fetch that
// fails every request, so any network use would fail the test.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { main, type CliIo } from "../src/cli/verdict.ts";
import { FIXTURES, fixture, noNetwork, noSleep, replayFetch, type Exchange } from "./helpers.ts";

const run = promisify(execFile);
const MERCHANT = join(FIXTURES, "snapshot-merchant.testnet.json");

function memoryIo(over: Partial<CliIo> = {}): CliIo & { out: string[]; err: string[]; files: Map<string, string> } {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, string>();
  return {
    out,
    err,
    files,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    readFile: async (p) => files.get(p) ?? (await import("node:fs/promises")).readFile(p, "utf8"),
    writeFile: async (p, t) => void files.set(p, t),
    env: {},
    fetch: noNetwork,
    sleep: noSleep,
    ...over,
  };
}

describe("verdict CLI", () => {
  it("--offline --json replays a saved snapshot with no network", async () => {
    const io = memoryIo();
    assert.equal(await main(["--offline", MERCHANT, "--json"], io), 0);
    const j = JSON.parse(io.out.join(""));
    assert.equal(j.mode, "offline");
    assert.equal(j.account, "aid-demo-merchant.testnet");
    assert.equal(j.verdict, "WARN");
    assert.equal(j.snapshot_sha256, "70e404a9498510c72132d3688bc0826039d01347a53b6b789c86448111777af9");
    assert.equal(j.chain_sha256, "3782912bdc2e279b3456533e745fb0a77de8a8e09b23d79ba42d5687e88ce90f");
    assert.deepEqual(j.registry_reasons, ["new_account", "low_activity"]);
  });

  it("prints every reason, the block and both digests in text mode", async () => {
    const io = memoryIo();
    assert.equal(await main(["--offline", MERCHANT], io), 0);
    const text = io.out.join("");
    for (const needle of ["verdict   WARN", "#277300516", "new_account", "low_activity", "source: rpc archival view_account@276858896", "snapshot  sha256 70e404a9", "chain     sha256 3782912b"]) {
      assert.ok(text.includes(needle), needle);
    }
  });

  it("online against recorded answers, saves the snapshot, and the saved file replays to the same digests", async () => {
    const rec = fixture<{ exchanges: Exchange[]; expected: { snapshot_sha256: string; chain_sha256: string } }>("collect-lookalike.json");
    const io = memoryIo({ fetch: replayFetch(rec.exchanges), clock: () => new Date("2026-11-12T00:00:00.000Z") });
    assert.equal(await main(["aid-demo-rnerchant.testnet", "--known", "aid-demo-merchant.testnet", "--json", "--save-snapshot", "/virtual/snap.json"], io), 0);
    const live = JSON.parse(io.out.join(""));
    assert.equal(live.verdict, "DENY");
    assert.equal(live.chain_sha256, rec.expected.chain_sha256);
    const replayIo = memoryIo();
    replayIo.files.set("/virtual/snap.json", io.files.get("/virtual/snap.json")!);
    assert.equal(await main(["--offline", "/virtual/snap.json", "--json"], replayIo), 0);
    const again = JSON.parse(replayIo.out.join(""));
    assert.equal(again.snapshot_sha256, live.snapshot_sha256);
    assert.equal(again.chain_sha256, live.chain_sha256);
    assert.deepEqual(again.reasons, live.reasons);
  });

  for (const [what, argv] of [
    ["no account", []],
    ["two accounts", ["a.testnet", "b.testnet"]],
    ["a bad network", ["a.testnet", "--network", "devnet"]],
    ["a bad block height", ["a.testnet", "--at-block", "12x"]],
    ["an invalid account id", ["Not Valid"]],
    ["an unknown flag", ["a.testnet", "--frobnicate"]],
    ["a missing snapshot file", ["--offline", "/nonexistent/snap.json"]],
    ["a snapshot about another account", ["wrap.testnet", "--offline", MERCHANT]],
  ] as [string, string[]][]) {
    it(`exits 2 on ${what}`, async () => {
      const io = memoryIo();
      assert.equal(await main(argv, io), 2);
      assert.ok(io.err.join("").length > 0);
    });
  }

  it("exits 1 when no RPC endpoint can be reached", async () => {
    const io = memoryIo();
    assert.equal(await main(["aid-demo-merchant.testnet"], io), 1);
    assert.match(io.err.join(""), /no verdict/);
  });

  it("runs as a real process with node --experimental-strip-types", async () => {
    const entry = join(import.meta.dirname, "..", "src", "cli", "verdict.ts");
    const { stdout } = await run(process.execPath, ["--experimental-strip-types", "--no-warnings", entry, "--offline", MERCHANT, "--json"]);
    assert.equal(JSON.parse(stdout).verdict, "WARN");
  });
});

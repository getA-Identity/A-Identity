import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHttpClient } from "../src/collect/http.ts";
import { createReader, headersFromEnv, RpcAnswerError, RpcUnavailableError, type FetchLike } from "../src/collect/rpc.ts";
import { noSleep } from "./helpers.ts";

const A = "https://rpc-a.example";
const B = "https://rpc-b.example";
const ARCH = "https://archival.example";

type Reply = { status?: number; body?: unknown; text?: string; throws?: string };

/** A fetch that answers per host from a queue, and records which hosts were called. */
function scripted(plan: Record<string, Reply[]>, calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    const next = plan[url]?.shift();
    if (!next) throw new Error(`no scripted reply for ${url}`);
    if (next.throws) throw new Error(next.throws);
    return { status: next.status ?? 200, text: async () => next.text ?? JSON.stringify(next.body) };
  };
}

const ok = (result: unknown): Reply => ({ body: { jsonrpc: "2.0", id: "1", result } });
const rpcErr = (cause: string, extra: Record<string, unknown> = {}): Reply => ({
  body: { jsonrpc: "2.0", id: "1", error: { name: "HANDLER_ERROR", cause: { name: cause, info: {} }, code: -32000, message: "Server error", data: `${cause} detail`, ...extra } },
});

function reader(plan: Record<string, Reply[]>, calls: string[] = []) {
  return createReader({ rpc: [A, B], archival: [ARCH], fetch: scripted(plan, calls), sleep: noSleep, paceMs: 0, archivalPaceMs: 0, rounds: 2, backoffMs: 1 });
}

describe("quiet read failover", () => {
  it("answers from the first endpoint", async () => {
    const calls: string[] = [];
    const r = await reader({ [A]: [ok({ x: 1 })] }, calls).call("query", {});
    assert.deepEqual(r, { result: { x: 1 }, endpoint: A });
    assert.deepEqual(calls, [A]);
  });

  for (const [what, failure] of [
    ["a transport error", { throws: "fetch failed" }],
    ["HTTP 503", { status: 503, text: "busy" }],
    ["HTTP 429", { status: 429, text: "slow down" }],
    ["FastNEAR's JSON-RPC -429", { body: { jsonrpc: "2.0", id: "1", error: { code: -429, message: "Rate limits exceeded" } } }],
    ["a body that is not JSON", { status: 200, text: "<html>" }],
    ["an internal error", rpcErr("INTERNAL_ERROR")],
    ["a pruned block on a regular node", rpcErr("GARBAGE_COLLECTED_BLOCK")],
    ["UNKNOWN_BLOCK on a regular node", rpcErr("UNKNOWN_BLOCK")],
  ] as [string, Reply][]) {
    it(`fails over on ${what}`, async () => {
      const calls: string[] = [];
      const r = await reader({ [A]: [failure], [B]: [ok(7)] }, calls).call("query", {});
      assert.equal(r.result, 7);
      assert.deepEqual(calls, [A, B]);
    });
  }

  for (const cause of ["UNKNOWN_ACCOUNT", "NO_CONTRACT_CODE", "UNKNOWN_ACCESS_KEY", "TOO_MANY_ACCESS_KEYS"]) {
    it(`does not fail over on a decided answer: ${cause}`, async () => {
      const calls: string[] = [];
      await assert.rejects(reader({ [A]: [rpcErr(cause)] }, calls).call("query", {}), (e: unknown) => e instanceof RpcAnswerError && e.causeName === cause);
      assert.deepEqual(calls, [A]);
    });
  }

  it("reads a failed view inside a successful response as a decided contract error", async () => {
    const calls: string[] = [];
    const failed = ok({ error: "wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))", logs: [] });
    await assert.rejects(
      reader({ [A]: [failed] }, calls).call("query", { request_type: "call_function" }),
      (e: unknown) => e instanceof RpcAnswerError && e.causeName === "CONTRACT_EXECUTION_ERROR" && e.kind === "MethodNotFound",
    );
    assert.deepEqual(calls, [A]);
  });

  it("UNKNOWN_BLOCK from an archival node is final", async () => {
    const calls: string[] = [];
    await assert.rejects(reader({ [A]: [rpcErr("UNKNOWN_BLOCK")], [B]: [rpcErr("UNKNOWN_BLOCK")], [ARCH]: [rpcErr("UNKNOWN_BLOCK")] }, calls).call("query", {}), RpcAnswerError);
    assert.deepEqual(calls, [A, B, ARCH]);
  });

  it("archival reads go to archival hosts only", async () => {
    const calls: string[] = [];
    await reader({ [ARCH]: [ok(1)] }, calls).call("query", {}, { archival: true });
    assert.deepEqual(calls, [ARCH]);
  });

  it("gives up after its rounds with every attempt listed", async () => {
    const calls: string[] = [];
    const down: Reply = { throws: "ECONNREFUSED" };
    const plan = { [A]: [down, down], [B]: [down, down], [ARCH]: [down, down] };
    await assert.rejects(reader(plan, calls).call("status", {}), (e: unknown) => e instanceof RpcUnavailableError && e.attempts.length === 6);
    assert.equal(calls.length, 6);
  });

  it("paces calls to the same host", async () => {
    let t = 0;
    const waits: number[] = [];
    const r = createReader({
      rpc: [A],
      archival: [],
      fetch: scripted({ [A]: [ok(1), ok(2)] }),
      paceMs: 100,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    });
    await r.call("a", {});
    await r.call("b", {});
    assert.deepEqual(waits, [100]);
  });

  it("never writes to the console", async () => {
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const written: unknown[] = [];
    console.log = console.warn = console.error = console.info = (...a: unknown[]) => void written.push(a);
    try {
      await reader({ [A]: [{ throws: "boom" }, { throws: "boom" }], [B]: [rpcErr("INTERNAL_ERROR"), ok(1)], [ARCH]: [{ status: 500, text: "x" }] }).call("q", {});
    } finally {
      Object.assign(console, original);
    }
    assert.deepEqual(written, []);
  });

  it("sends API keys only to their own hosts", () => {
    const h = headersFromEnv({ FASTNEAR_API_KEY: "k1", NEARBLOCKS_API_KEY: "k2" });
    assert.deepEqual(h("https://rpc.testnet.fastnear.com"), { authorization: "Bearer k1" });
    assert.deepEqual(h("https://api-testnet.nearblocks.io/v3/x"), { authorization: "Bearer k2" });
    assert.deepEqual(h("https://near-testnet.drpc.org"), {});
    assert.deepEqual(headersFromEnv({})("https://rpc.testnet.fastnear.com"), {});
  });
});

describe("indexer client", () => {
  const url = "https://tx.example/v0/account";
  const clock = () => new Date("2026-11-12T00:00:00.000Z");

  it("retries a 429 once and records the answer", async () => {
    const http = createHttpClient({ fetch: scripted({ [url]: [{ status: 429, text: "" }, { body: { txs_count: 1 } }] }), sleep: noSleep, paceMs: 0, clock });
    const rec = await http.request({ label: "fastnear.oldest", source: "fastnear", method: "POST", url, body: { account_id: "a.testnet" } });
    assert.equal(rec.status, 200);
    assert.deepEqual(rec.json, { txs_count: 1 });
    assert.deepEqual(rec.body, { account_id: "a.testnet" });
    assert.equal(rec.fetched_at, "2026-11-12T00:00:00.000Z");
  });

  it("never throws: a failure becomes a recorded error", async () => {
    const http = createHttpClient({ fetch: scripted({ [url]: [{ throws: "ENOTFOUND" }, { throws: "ENOTFOUND" }] }), sleep: noSleep, paceMs: 0, clock });
    const rec = await http.request({ label: "fastnear.oldest", source: "fastnear", method: "GET", url });
    assert.equal(rec.error, "ENOTFOUND");
    assert.equal(rec.json, undefined);
  });
});

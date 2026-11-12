// GENERATED FILE: do not edit.
// Source: near/sdk/src/collect/recorder.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// Records every read as it happens, so a snapshot holds exactly what was asked and answered.
//
// A failed read is recorded too, as an error with nearcore's cause name (or UNAVAILABLE when no
// endpoint answered). The engine turns a recorded failure into an explicit warning, so a
// snapshot taken during an outage replays as the same WARN it produced live.

import type { HttpRecord, JsonObject, JsonValue, Network, RpcErrorRecord, RpcRecord } from "../engine/types.js";
import type { HttpClient, HttpRequest } from "./http.js";
import { RpcAnswerError, RpcUnavailableError, type RpcReader } from "./rpc.js";

export type RpcBody = Omit<RpcRecord, "label">;

export type Recorder = {
  /** Send one JSON-RPC read and return it as a record body (not yet stored). */
  fetch(network: Network, method: string, params: JsonObject, archival: boolean, project?: (result: unknown) => JsonValue, projection?: string): Promise<RpcBody>;
  /** Store a record under a label. */
  push(label: string, body: RpcBody): RpcRecord;
  /** fetch + push. */
  rpc(label: string, network: Network, method: string, params: JsonObject, archival?: boolean): Promise<RpcRecord>;
  http(req: HttpRequest): Promise<HttpRecord>;
  readonly rpcRecords: RpcRecord[];
  readonly httpRecords: HttpRecord[];
  endpointsUsed(): string[];
};

export function errorRecord(e: unknown): RpcErrorRecord {
  if (e instanceof RpcAnswerError) {
    const rec: RpcErrorRecord = { name: e.errorName, cause: e.causeName, message: e.detail };
    if (e.kind) rec.kind = e.kind;
    return rec;
  }
  if (e instanceof RpcUnavailableError) return { name: "UNAVAILABLE", cause: "UNAVAILABLE", message: e.message };
  return { name: "CLIENT_ERROR", cause: "UNAVAILABLE", message: e instanceof Error ? e.message : String(e) };
}

export function createRecorder(readers: Partial<Record<Network, RpcReader>>, http: HttpClient | null): Recorder {
  const rpcRecords: RpcRecord[] = [];
  const httpRecords: HttpRecord[] = [];
  const labels = new Set<string>();

  const recorder: Recorder = {
    rpcRecords,
    httpRecords,
    async fetch(network, method, params, archival, project, projection) {
      const body: RpcBody = { network, archival, method, params };
      const reader = readers[network];
      if (!reader) {
        body.error = { name: "CLIENT_ERROR", cause: "UNAVAILABLE", message: `no reader for ${network}` };
        return body;
      }
      try {
        const { result } = await reader.call(method, params, { archival });
        body.result = project ? project(result) : (result as JsonValue);
        if (projection) body.projection = projection;
      } catch (e) {
        body.error = errorRecord(e);
      }
      return body;
    },
    push(label, body) {
      if (labels.has(label)) throw new Error(`duplicate snapshot label ${label}`);
      labels.add(label);
      const record: RpcRecord = { label, ...body };
      rpcRecords.push(record);
      return record;
    },
    async rpc(label, network, method, params, archival = false) {
      return recorder.push(label, await recorder.fetch(network, method, params, archival));
    },
    async http(req) {
      if (labels.has(req.label)) throw new Error(`duplicate snapshot label ${req.label}`);
      labels.add(req.label);
      const record: HttpRecord = http
        ? await http.request(req)
        : { label: req.label, source: req.source, method: req.method, url: req.url, error: "indexers disabled", fetched_at: new Date(0).toISOString() };
      httpRecords.push(record);
      return record;
    },
    endpointsUsed() {
      const hosts = new Set<string>();
      for (const r of Object.values(readers)) for (const h of r?.endpointsUsed() ?? []) hosts.add(h);
      for (const h of http?.endpointsUsed() ?? []) hosts.add(h);
      return [...hosts].sort();
    },
  };
  return recorder;
}

/** Base64 of the UTF-8 JSON of `args`, as call_function takes it. Works in Node and browsers. */
export function argsBase64(args: JsonValue): string {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

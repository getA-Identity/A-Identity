// Read-only JSON requests to the indexers (FastNEAR transactions API, NearBlocks v3), recorded.
//
// An indexer answer is evidence but not consensus: it is recorded verbatim with its fetch time,
// and the engine only uses facts it can bound by the pinned block (oldest-first transactions at
// or below the block height). It never throws: a failure becomes a record with `error`, which
// the engine turns into an explicit "indexer unavailable" warning.

import type { HttpRecord, JsonValue } from "../engine/types.ts";
import type { FetchLike } from "./rpc.ts";

export type HttpClientOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  paceMs?: number;
  /** Extra attempts after a 429 or 5xx, with a growing wait. */
  retries?: number;
  backoffMs?: number;
  headersFor?: (url: string) => Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  clock?: () => Date;
};

export type HttpRequest = {
  label: string;
  source: HttpRecord["source"];
  method: "GET" | "POST";
  url: string;
  body?: JsonValue;
};

export type HttpClient = { request(req: HttpRequest): Promise<HttpRecord>; endpointsUsed(): string[] };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  // NearBlocks' free tier is documented at 6 calls a minute; FastNEAR publishes no keyless limit.
  const paceMs = options.paceMs ?? 400;
  const retries = options.retries ?? 1;
  const backoffMs = options.backoffMs ?? 1_500;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => new Date());
  const lastCall = new Map<string, number>();
  const used = new Set<string>();

  return {
    async request(req) {
      const host = new URL(req.url).host;
      let lastError = "no attempt";
      for (let i = 0; i <= retries; i++) {
        if (i > 0) await sleep(backoffMs * i);
        const t = now();
        const last = lastCall.get(host);
        const slot = last === undefined ? t : Math.max(t, last + paceMs);
        lastCall.set(host, slot);
        if (slot > t) await sleep(slot - t);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const fetchedAt = clock().toISOString();
        try {
          const res = await doFetch(req.url, {
            method: req.method,
            headers: {
              accept: "application/json",
              ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
              ...(options.headersFor?.(req.url) ?? {}),
            },
            ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
            signal: controller.signal,
          });
          const text = await res.text();
          if (res.status === 429 || res.status >= 500) {
            lastError = `HTTP ${res.status}`;
            continue;
          }
          let json: JsonValue;
          try {
            json = JSON.parse(text) as JsonValue;
          } catch {
            lastError = `HTTP ${res.status}, body is not JSON`;
            continue;
          }
          used.add(host);
          const record: HttpRecord = { label: req.label, source: req.source, method: req.method, url: req.url, status: res.status, json, fetched_at: fetchedAt };
          if (req.body !== undefined) record.body = req.body;
          return record;
        } catch (e) {
          lastError = controller.signal.aborted ? `timeout after ${timeoutMs} ms` : e instanceof Error ? e.message : "fetch failed";
        } finally {
          clearTimeout(timer);
        }
      }
      const record: HttpRecord = { label: req.label, source: req.source, method: req.method, url: req.url, error: lastError, fetched_at: clock().toISOString() };
      if (req.body !== undefined) record.body = req.body;
      return record;
    },
    endpointsUsed() {
      return [...used].sort();
    },
  };
}

// GENERATED FILE: do not edit.
// Source: near/sdk/src/collect/rpc.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// A quiet JSON-RPC reader with failover, built on the global fetch.
//
// Why not near-api-js's FailoverRpcProvider: it moves to the next endpoint on ANY error,
// including answers that are final (an account that does not exist does not start existing on
// another node), it console.errors every attempt, and it wraps typed errors so instanceof checks
// fail. This reader separates the two cases:
//
//   decided answers are thrown at once as RpcAnswerError and never retried elsewhere:
//     UNKNOWN_ACCOUNT, UNKNOWN_ACCESS_KEY, NO_CONTRACT_CODE, CONTRACT_EXECUTION_ERROR (a contract
//     panic or a missing method), INVALID_ACCOUNT, TOO_MANY_ACCESS_KEYS, PARSE_ERROR, and, from
//     an archival node only, UNKNOWN_BLOCK and UNKNOWN_TRANSACTION;
//   everything else fails over to the next endpoint: transport errors and timeouts, HTTP 5xx,
//     408 and 429, FastNEAR's JSON-RPC code -429, an unreadable body, internal errors, and
//     UNKNOWN_BLOCK or UNKNOWN_TRANSACTION from a regular node (it may have pruned the data).
//
// It never logs. It paces calls per host (free endpoints, be polite) and backs off between
// rounds. Reads pinned to old blocks go to archival hosts only.

export type FetchResponseLike = { status: number; text(): Promise<string> };
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export class RpcAnswerError extends Error {
  readonly causeName: string;
  readonly errorName: string;
  readonly kind: string | null;
  readonly endpoint: string;
  /** The node's own text for the error (nearcore's `data`, or a view's panic message). */
  readonly detail: string;
  constructor(errorName: string, causeName: string, detail: string, endpoint: string, kind: string | null = null) {
    super(`${causeName}${kind ? ` (${kind})` : ""}: ${detail}`);
    this.name = "RpcAnswerError";
    this.errorName = errorName;
    this.causeName = causeName;
    this.kind = kind;
    this.endpoint = endpoint;
    this.detail = detail;
  }
}

export class RpcUnavailableError extends Error {
  readonly attempts: readonly string[];
  constructor(method: string, attempts: string[]) {
    super(`no endpoint answered ${method}: ${attempts.join("; ")}`);
    this.name = "RpcUnavailableError";
    this.attempts = attempts;
  }
}

export type RpcCallOptions = {
  /** The read is pinned to an old block or looks up an old transaction: archival hosts only. */
  archival?: boolean;
  /** Per-request timeout override (a FINAL transaction wait needs more than a view). */
  timeoutMs?: number;
};

export type RpcReader = {
  call(method: string, params: Record<string, unknown>, opts?: RpcCallOptions): Promise<{ result: unknown; endpoint: string }>;
  /** Hosts that answered at least once, for the snapshot's meta. */
  endpointsUsed(): string[];
};

export type ReaderOptions = {
  rpc: readonly string[];
  archival: readonly string[];
  fetch?: FetchLike;
  /** Per request. A view answers in well under a second; 15 s covers a slow archival read. */
  timeoutMs?: number;
  /** Minimum gap between two requests to the same regular host. */
  paceMs?: number;
  /** The same for archival hosts, which rate-limit keyless bursts sooner (-429). */
  archivalPaceMs?: number;
  /** Passes over the endpoint list before giving up. */
  rounds?: number;
  /** Wait before pass n+1: backoffMs * 2^(n-1). */
  backoffMs?: number;
  /** Extra headers per URL, for example an API key from the environment. Never logged. */
  headersFor?: (url: string) => Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const ALWAYS_DECIDED = new Set([
  "UNKNOWN_ACCOUNT",
  "UNKNOWN_ACCESS_KEY",
  "NO_CONTRACT_CODE",
  "CONTRACT_EXECUTION_ERROR",
  "INVALID_ACCOUNT",
  "TOO_MANY_ACCESS_KEYS",
  "PARSE_ERROR",
]);
const DECIDED_ON_ARCHIVAL = new Set(["UNKNOWN_BLOCK", "UNKNOWN_TRANSACTION", "UNKNOWN_CHUNK"]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** MethodNotFound, GuestPanic or Other, from a contract execution error message. */
export function executionKind(message: string): string {
  if (/MethodNotFound/.test(message)) return "MethodNotFound";
  if (/GuestPanic|panicked/i.test(message)) return "GuestPanic";
  return "Other";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Attempt = { kind: "answer"; result: unknown } | { kind: "decided"; error: RpcAnswerError } | { kind: "retry"; reason: string };

export function createReader(options: ReaderOptions): RpcReader {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 15_000;
  const paceMs = options.paceMs ?? 100;
  const archivalPaceMs = options.archivalPaceMs ?? 250;
  const rounds = Math.max(1, options.rounds ?? 3);
  const backoffMs = options.backoffMs ?? 750;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const archivalSet = new Set(options.archival);
  const lastCall = new Map<string, number>();
  const used = new Set<string>();
  let nextId = 1;

  // The slot is reserved before sleeping, so concurrent callers to one host queue up instead of
  // all waking at the same moment.
  async function pace(url: string): Promise<void> {
    const host = hostOf(url);
    const t = now();
    const last = lastCall.get(host);
    const gap = archivalSet.has(url) ? archivalPaceMs : paceMs;
    const slot = last === undefined ? t : Math.max(t, last + gap);
    lastCall.set(host, slot);
    if (slot > t) await sleep(slot - t);
  }

  async function attempt(url: string, method: string, params: Record<string, unknown>, ms: number): Promise<Attempt> {
    await pace(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    let status: number;
    let text: string;
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(options.headersFor?.(url) ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: String(nextId++), method, params }),
        signal: controller.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      return { kind: "retry", reason: `${hostOf(url)}: ${controller.signal.aborted ? `timeout after ${ms} ms` : e instanceof Error ? e.message : "fetch failed"}` };
    } finally {
      clearTimeout(timer);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: "retry", reason: `${hostOf(url)}: HTTP ${status}, body is not JSON` };
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as { result?: unknown; error?: Record<string, unknown> };
    if (b.error) {
      const err = b.error;
      if (err.code === -429) return { kind: "retry", reason: `${hostOf(url)}: rate limited (-429)` };
      const cause = (typeof err.cause === "object" && err.cause !== null ? (err.cause as Record<string, unknown>).name : undefined) ?? err.name;
      const causeName = typeof cause === "string" ? cause : "UNKNOWN_ERROR";
      const errorName = typeof err.name === "string" ? err.name : "RPC_ERROR";
      const message = typeof err.data === "string" ? err.data : typeof err.message === "string" ? err.message : causeName;
      const decided = ALWAYS_DECIDED.has(causeName) || (DECIDED_ON_ARCHIVAL.has(causeName) && archivalSet.has(url));
      if (decided) {
        const kind = causeName === "CONTRACT_EXECUTION_ERROR" ? executionKind(message) : null;
        return { kind: "decided", error: new RpcAnswerError(errorName, causeName, message, url, kind) };
      }
      return { kind: "retry", reason: `${hostOf(url)}: ${causeName}` };
    }
    if (status >= 500 || status === 429 || status === 408) return { kind: "retry", reason: `${hostOf(url)}: HTTP ${status}` };
    if (!("result" in b)) return { kind: "retry", reason: `${hostOf(url)}: HTTP ${status}, no result` };
    // nearcore reports a failed view call inside a successful response: {result: {error: "..."}}.
    const r = b.result as Record<string, unknown> | null;
    if (method === "query" && r && typeof r === "object" && typeof r.error === "string") {
      return {
        kind: "decided",
        error: new RpcAnswerError("HANDLER_ERROR", "CONTRACT_EXECUTION_ERROR", r.error, url, executionKind(r.error)),
      };
    }
    return { kind: "answer", result: b.result };
  }

  return {
    async call(method, params, opts = {}) {
      const archival = opts.archival === true;
      const endpoints = archival ? [...options.archival] : [...options.rpc, ...options.archival];
      if (endpoints.length === 0) throw new RpcUnavailableError(method, ["no endpoints configured"]);
      const attempts: string[] = [];
      for (let round = 0; round < rounds; round++) {
        if (round > 0) await sleep(backoffMs * 2 ** (round - 1));
        for (const url of endpoints) {
          const a = await attempt(url, method, params, opts.timeoutMs ?? timeoutMs);
          if (a.kind === "answer") {
            used.add(hostOf(url));
            return { result: a.result, endpoint: url };
          }
          if (a.kind === "decided") {
            used.add(hostOf(url));
            throw a.error;
          }
          attempts.push(a.reason);
        }
      }
      throw new RpcUnavailableError(method, attempts);
    },
    endpointsUsed() {
      return [...used].sort();
    },
  };
}

/** Optional API keys from the environment, sent only to their own hosts and never logged. */
export function headersFromEnv(env: Record<string, string | undefined>): (url: string) => Record<string, string> {
  return (url): Record<string, string> => {
    const host = hostOf(url);
    const fastnear = env.FASTNEAR_API_KEY;
    const nearblocks = env.NEARBLOCKS_API_KEY;
    if (host.endsWith("fastnear.com") && fastnear) return { authorization: `Bearer ${fastnear}` };
    if (host.endsWith("nearblocks.io") && nearblocks) return { authorization: `Bearer ${nearblocks}` };
    return {};
  };
}

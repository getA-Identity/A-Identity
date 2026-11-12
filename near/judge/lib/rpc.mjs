// JSON-RPC transport for the judge: read-only, paced, and honest about the network.
//
// State (views, keys, accounts) is read from the regular RPC at finality "final"; every
// transaction and every read pinned to a block goes to ARCHIVAL RPC, because regular nodes
// garbage-collect history after a few epochs (an 11-day-old testnet tx already answered
// UNKNOWN_TRANSACTION on regular RPC when this was written, 2026-11-12) and judging runs days
// after the demo. Only the EXPERIMENTAL_ method names are used, because the fallback provider
// (dRPC) rejects the newer aliases.
//
// A network that does not answer is not a verdict. When every endpoint fails at the transport
// level (DNS, refused, timeout, HTTP 403 from an egress allowlist, rate limit that does not
// clear) the call throws NetworkError and the claim is reported SKIP with the reason, never FAIL.

import { canonical } from './json.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Endpoints, primary first. Overridable with JUDGE_RPC_<NETWORK> and
 *  JUDGE_ARCHIVAL_RPC_<NETWORK> (comma-separated URLs). */
export const NETWORKS = {
  testnet: {
    chainId: 'testnet',
    state: ['https://rpc.testnet.fastnear.com', 'https://near-testnet.drpc.org'],
    archival: ['https://archival-rpc.testnet.fastnear.com'],
    explorer: 'https://testnet.nearblocks.io',
  },
  mainnet: {
    chainId: 'mainnet',
    state: ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com'],
    archival: ['https://archival-rpc.mainnet.fastnear.com'],
    explorer: 'https://nearblocks.io',
  },
};

export class NetworkError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** JSON-RPC error names that are ANSWERS about the chain (evaluated by the check), as opposed
 *  to node trouble (retried, then reported as a network problem). */
export const ANSWER_ERRORS = new Set([
  'UNKNOWN_ACCOUNT',
  'INVALID_ACCOUNT',
  'UNKNOWN_ACCESS_KEY',
  'UNKNOWN_TRANSACTION',
  'INVALID_TRANSACTION',
  'CONTRACT_EXECUTION_ERROR',
  'NO_CONTRACT_CODE',
  'UNKNOWN_BLOCK',
  'TOO_MANY_ACCESS_KEYS',
  'PARSE_ERROR',
  'REQUEST_VALIDATION_ERROR',
  'HANDLER_ERROR',
]);

const TRANSIENT_ERRORS = new Set(['TIMEOUT_ERROR', 'INTERNAL_ERROR', 'NO_SYNCED_BLOCKS', 'UNAVAILABLE_SHARD', 'NOT_SYNCED_YET']);

export function rpcErrorName(response) {
  const error = response?.error;
  if (!error) return null;
  return error.cause?.name ?? error.name ?? (typeof error.code === 'number' ? `code ${error.code}` : 'error');
}

/** "15 s", or "0.3 s" for a time box under a second. */
function seconds(ms) {
  return `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)} s`;
}

function isRateLimited(error) {
  return error?.code === -429 || /rate limit/i.test(String(error?.message ?? ''));
}

export function endpointsFor(network, kind, env = process.env) {
  const config = NETWORKS[network];
  if (!config) throw new Error(`unknown network ${JSON.stringify(network)} (use testnet or mainnet)`);
  const override = env[`JUDGE_${kind === 'archival' ? 'ARCHIVAL_RPC' : 'RPC'}_${network.toUpperCase()}`];
  if (override) return override.split(',').map((url) => url.trim()).filter(Boolean);
  return kind === 'archival' ? config.archival : config.state;
}

/** Block height and hash an answer was read at, wherever the response shape keeps them. */
export function blockOf(response) {
  const result = response?.result;
  if (result && typeof result === 'object') {
    if (typeof result.block_height === 'number' || typeof result.block_hash === 'string') {
      return { block_height: result.block_height ?? null, block_hash: result.block_hash ?? null };
    }
    if (result.header && typeof result.header.height === 'number') {
      return { block_height: result.header.height, block_hash: result.header.hash };
    }
    if (result.transaction_outcome?.block_hash) {
      return { block_height: null, block_hash: result.transaction_outcome.block_hash };
    }
  }
  const info = response?.error?.cause?.info;
  if (info && (info.block_height !== undefined || info.block_hash !== undefined)) {
    return { block_height: info.block_height ?? null, block_hash: info.block_hash ?? null };
  }
  return { block_height: null, block_hash: null };
}

function host(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describeFetchError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  const code = err?.cause?.code ?? err?.code;
  if (code) return code;
  return err?.cause?.message ?? err?.message ?? String(err);
}

/** Errors after which retrying the same host is pointless. A timeout counts: a node that has not
 *  answered in the whole time box is not going to answer the next call either, and three more
 *  tries per call would spend a judge's two-minute budget on one dead host. */
function isPermanent(reason) {
  return ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'timeout', 'bad port'].includes(reason);
}

/** A question whose answer can never change: anything read from archival RPC pinned to a block,
 *  a block, or a finished transaction. Only these are cached, so a claim asked twice in one run
 *  (three counters reading the same demo transactions) costs one call. */
export function isImmutable(spec) {
  if (spec.kind !== 'archival') return false;
  if (spec.method === 'EXPERIMENTAL_tx_status' || spec.method === 'block') return true;
  return spec.method === 'query' && spec.params && typeof spec.params === 'object' && 'block_id' in spec.params;
}

/**
 * The live transport. `call(spec)` takes `{ network, kind: 'state' | 'archival', method, params }`
 * and returns `{ request, response, rpc_url, fetched_at, ms, block_height, block_hash }`.
 */
export class LiveTransport {
  /** Calls to one host are at least `minIntervalMs` apart, and `archivalIntervalMs` for archival
   *  RPC: free archival nodes are the scarcest resource a judge uses, and a burst there draws
   *  rate limits that take minutes to clear. */
  constructor({ timeoutMs = 15000, minIntervalMs = 150, archivalIntervalMs = 300, attemptsPerEndpoint = 3, env = process.env, onRetry, cache = true } = {}) {
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this.archivalIntervalMs = archivalIntervalMs;
    this.attemptsPerEndpoint = attemptsPerEndpoint;
    this.env = env;
    this.onRetry = onRetry ?? (() => {});
    this.lastCallAt = new Map();
    this.deadHosts = new Map();
    this.cache = cache ? new Map() : null;
    this.count = 0;
  }

  /** Is this network's state or archival RPC answering? A quick `status` with one short try per
   *  endpoint. A host that fails here is marked dead for the whole run. */
  async probe(network, kind, { timeoutMs = 8000 } = {}) {
    try {
      // Two tries per endpoint: a rate limit (HTTP 429) usually clears after one backoff, while a
      // host that times out is marked dead on the first try anyway.
      const call = await this.call({ network, kind, method: 'status', params: [] }, { timeoutMs, attemptsPerEndpoint: 2 });
      const chainId = call.response.result?.chain_id;
      if (chainId !== network) {
        this.deadHosts.set(host(call.rpc_url), `reports chain_id ${chainId}, not ${network}`);
        return { ok: false, reason: `${host(call.rpc_url)} reports chain_id ${chainId}, not ${network}` };
      }
      return { ok: true, height: call.response.result?.sync_info?.latest_block_height ?? null, url: call.rpc_url };
    } catch (err) {
      if (err instanceof NetworkError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  async pace(url, kind) {
    const last = this.lastCallAt.get(host(url)) ?? 0;
    const wait = last + (kind === 'archival' ? this.archivalIntervalMs : this.minIntervalMs) - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt.set(host(url), Date.now());
  }

  async call(spec, { timeoutMs = this.timeoutMs, attemptsPerEndpoint = this.attemptsPerEndpoint } = {}) {
    const cacheKey = this.cache && isImmutable(spec) ? `${spec.network} ${spec.method} ${canonical(spec.params)}` : null;
    if (cacheKey && this.cache.has(cacheKey)) return structuredClone(this.cache.get(cacheKey));
    const endpoints = endpointsFor(spec.network, spec.kind, this.env);
    const request = { jsonrpc: '2.0', id: 'judge', method: spec.method, params: spec.params };
    const body = JSON.stringify(request);
    const failures = [];
    for (const [index, url] of endpoints.entries()) {
      // A rate-limited endpoint hands the question to the next operator at once; only the last
      // endpoint is waited out with backoff.
      const last = index === endpoints.length - 1;
      const dead = this.deadHosts.get(host(url));
      if (dead) {
        failures.push(`${host(url)}: ${dead}`);
        continue;
      }
      for (let attempt = 0; attempt < attemptsPerEndpoint; attempt++) {
        if (attempt > 0) {
          // A rate limit needs a longer pause than a flaky connection.
          const limited = /HTTP 429|-429|rate limit/i.test(failures.at(-1) ?? '');
          const backoff = limited ? Math.min(6000, 1500 * 2 ** (attempt - 1)) : Math.min(4000, 700 * 2 ** (attempt - 1));
          this.onRetry({ url, attempt, reason: failures.at(-1) });
          await sleep(backoff);
        }
        await this.pace(url, spec.kind);
        const started = Date.now();
        let res;
        let text;
        try {
          res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          text = await res.text();
        } catch (err) {
          const reason = describeFetchError(err);
          failures.push(`${host(url)}: ${reason === 'timeout' ? `no answer in ${seconds(timeoutMs)}` : reason}`);
          if (isPermanent(reason)) {
            this.deadHosts.set(host(url), reason === 'timeout' ? `no answer in ${seconds(timeoutMs)}` : reason);
            break;
          }
          continue;
        }
        this.count++;
        if (res.status === 429 || res.status >= 500) {
          failures.push(`${host(url)}: HTTP ${res.status}`);
          if (res.status === 429 && !last) break;
          const retryAfter = Number(res.headers.get('retry-after'));
          if (retryAfter > 0 && retryAfter <= 10) await sleep(retryAfter * 1000);
          continue;
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        if (!json || typeof json !== 'object' || !('result' in json || 'error' in json)) {
          // An egress proxy, an allowlist page or a captive portal answered instead of a node.
          failures.push(`${host(url)}: HTTP ${res.status}, answer is not JSON-RPC`);
          this.deadHosts.set(host(url), `HTTP ${res.status}, not JSON-RPC`);
          break;
        }
        if (json.error && rpcErrorName(json) === 'GARBAGE_COLLECTED_BLOCK') {
          // This node no longer keeps that block: not an answer about the chain. Ask the next one.
          failures.push(`${host(url)}: GARBAGE_COLLECTED_BLOCK (not an archival node for this block)`);
          break;
        }
        if (json.error && (isRateLimited(json.error) || TRANSIENT_ERRORS.has(rpcErrorName(json)))) {
          failures.push(`${host(url)}: ${isRateLimited(json.error) ? 'rate limit (-429)' : rpcErrorName(json)} ${String(json.error.message ?? '').slice(0, 80)}`.trim());
          if (isRateLimited(json.error) && !last) break;
          continue;
        }
        const answer = {
          network: spec.network,
          kind: spec.kind,
          rpc_url: url,
          request,
          response: json,
          fetched_at: new Date(started).toISOString(),
          ms: Date.now() - started,
          ...blockOf(json),
        };
        if (cacheKey) this.cache.set(cacheKey, structuredClone(answer));
        return answer;
      }
    }
    throw new NetworkError(`no answer from ${spec.network} ${spec.kind} RPC (${failures.slice(-3).join('; ')})`);
  }
}

/**
 * The same question pinned to the block it was answered at, for archival RPC. A view read at
 * "final" is re-asked at its recorded block hash, so the answer must be identical however much
 * later it is asked. Returns null for a call that cannot be pinned (a status call, or a view
 * whose answer carried no block).
 */
export function pinnedSpec(call) {
  const { method, params } = call.request;
  if (method === 'query' && params && typeof params === 'object' && !Array.isArray(params)) {
    if ('block_id' in params) return { network: call.network, kind: 'archival', method, params };
    if (!call.block_hash) return null;
    const { finality, ...rest } = params;
    return { network: call.network, kind: 'archival', method, params: { ...rest, block_id: call.block_hash } };
  }
  if (method === 'EXPERIMENTAL_tx_status' || method === 'block') return { network: call.network, kind: 'archival', method, params };
  return null;
}

/** A curl line a reader can paste to ask the same question. Pinned to the recorded block on
 *  archival RPC when the call can be pinned, so it reproduces the recorded answer. */
export function curlFor(call, env = process.env) {
  const pinned = pinnedSpec(call);
  const url = pinned ? endpointsFor(call.network, 'archival', env)[0] : call.rpc_url;
  const request = pinned ? { jsonrpc: '2.0', id: 'judge', method: pinned.method, params: pinned.params } : call.request;
  const body = JSON.stringify(request).replace(/'/g, "'\\''");
  return `curl -s ${url} -H 'content-type: application/json' -d '${body}'`;
}

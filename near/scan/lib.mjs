// Zero-dependency, read-only clients for the real-data scan (NEAR mainnet).
//
// Everything here is a read: JSON-RPC queries (view_account, view_access_key_list,
// call_function on view methods) and the FastNEAR transactions indexer. Nothing signs,
// nothing sends a transaction. Free endpoints are shared by everyone, so every host
// gets a minimum gap between requests and every 429 (HTTP or JSON-RPC -429) backs off.

// Two FastNEAR hosts plus dRPC, a different operator, so a sweep spreads its load. dRPC answers
// a missing account with the same nearcore UNKNOWN_ACCOUNT error (checked 2026-11-12).
export const MAINNET_RPCS = ["https://rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com", "https://near-mainnet.drpc.org"];
export const MAINNET_ARCHIVAL_RPC = "https://archival-rpc.mainnet.fastnear.com";
export const FASTNEAR_TX_API = "https://tx.main.fastnear.com";
export const NO_CONTRACT_CODE_HASH = "11111111111111111111111111111111";

const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

// NEAR account id rules (nearcore AccountId::validate): 2 to 64 chars, lowercase
// alphanumerics separated by single '-', '_' or '.', no leading or trailing separator.
export function isValidAccountId(id) {
  return typeof id === "string" && id.length >= 2 && id.length <= 64 && ACCOUNT_ID_RE.test(id);
}

// 64 lowercase hex chars: an implicit account (ed25519 public key).
export function isImplicitAccount(id) {
  return /^[0-9a-f]{64}$/.test(id);
}

// 0x + 40 hex: an Ethereum-style implicit account (NEP-518).
export function isEthImplicitAccount(id) {
  return /^0x[0-9a-f]{40}$/.test(id);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function nsToIso(ns) {
  if (ns === undefined || ns === null) return null;
  const ms = Number(BigInt(String(ns)) / 1_000_000n);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// yoctoNEAR string -> NEAR number rounded to 6 decimals (display only).
export function yoctoToNear(yocto) {
  if (yocto === undefined || yocto === null) return null;
  const v = BigInt(String(yocto));
  const whole = v / 10n ** 24n;
  const frac = (v % 10n ** 24n) / 10n ** 18n;
  return Number(`${whole}.${frac.toString().padStart(6, "0")}`);
}

class RateLimited extends Error {}

// One pacer per host: callers await their slot, so the gap holds across concurrent workers.
class Pacer {
  constructor(minGapMs) {
    this.minGapMs = minGapMs;
    this.next = 0;
  }
  async slot() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minGapMs;
    if (at > now) await sleep(at - now);
  }
  penalize(ms) {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

export class NearReader {
  constructor(opts = {}) {
    this.rpcs = opts.rpcs ?? MAINNET_RPCS;
    this.archivalRpc = opts.archivalRpc ?? MAINNET_ARCHIVAL_RPC;
    this.txApi = opts.txApi ?? FASTNEAR_TX_API;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxRetries = opts.maxRetries ?? 6;
    this.log = opts.log ?? (() => {});
    this.userAgent = opts.userAgent ?? "a-identity-near-scan/0.1 (read-only research; github.com/getA-Identity/A-Identity)";
    this.pacers = new Map();
    this.rpcGapMs = opts.rpcGapMs ?? 450;
    this.txGapMs = opts.txGapMs ?? 700;
    // Per-host overrides, e.g. a provider with a published, higher free limit.
    this.hostGapMs = opts.hostGapMs ?? {};
    this.rr = 0;
    // archival: queries a regular node refused because their block was garbage-collected and
    // that went to the archival node instead.
    this.stats = { requests: 0, retries: 0, rateLimited: 0, archival: 0 };
  }

  pacerFor(url) {
    const host = new URL(url).host;
    if (!this.pacers.has(host)) {
      const gap = this.hostGapMs[host] ?? (host.startsWith("tx.") ? this.txGapMs : this.rpcGapMs);
      this.pacers.set(host, new Pacer(gap));
    }
    return this.pacers.get(host);
  }

  async postJson(url, body) {
    const pacer = this.pacerFor(url);
    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await pacer.slot();
      this.stats.requests++;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": this.userAgent },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 429) throw new RateLimited(`HTTP 429 from ${url}`);
        if (res.status >= 500) throw new Error(`HTTP ${res.status} from ${url}`);
        const json = await res.json();
        if (json?.error?.code === -429) throw new RateLimited(`JSON-RPC -429 from ${url}`);
        return json;
      } catch (err) {
        lastErr = err;
        if (attempt === this.maxRetries) break;
        this.stats.retries++;
        const limited = err instanceof RateLimited;
        if (limited) this.stats.rateLimited++;
        const wait = (limited ? 2000 : 800) * 2 ** attempt;
        pacer.penalize(wait);
        this.log(`retry ${attempt + 1} after ${wait} ms: ${err.message}`);
      }
    }
    throw lastErr;
  }

  // One POST, no retry; throws RateLimited on HTTP 429 or JSON-RPC -429.
  async postOnce(url, body) {
    await this.pacerFor(url).slot();
    this.stats.requests++;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": this.userAgent },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (res.status === 429) throw new RateLimited(`HTTP 429 from ${url}`);
    if (res.status >= 500) throw new Error(`HTTP ${res.status} from ${url}`);
    const json = await res.json();
    if (json?.error?.code === -429) throw new RateLimited(`JSON-RPC -429 from ${url}`);
    return json;
  }

  // JSON-RPC against the pool. Each attempt goes to the host that can be called soonest; a
  // host that answers 429 is benched with a growing penalty while the others carry the load,
  // so one rate-limited operator does not stall the sweep.
  async rpc(method, params, { archival = false } = {}) {
    const urls = archival ? [this.archivalRpc] : this.rpcs;
    this.strikes ??= new Map();
    let lastErr;
    for (let attempt = 0; attempt < this.maxRetries * urls.length; attempt++) {
      let url = urls[0];
      let soonest = Infinity;
      for (const u of urls) {
        const at = this.pacerFor(u).next;
        if (at < soonest) [soonest, url] = [at, u];
      }
      try {
        const json = await this.postOnce(url, { jsonrpc: "2.0", id: "scan", method, params });
        this.strikes.set(url, 0);
        return json;
      } catch (err) {
        lastErr = err;
        this.stats.retries++;
        const strikes = (this.strikes.get(url) ?? 0) + 1;
        this.strikes.set(url, strikes);
        if (err instanceof RateLimited) this.stats.rateLimited++;
        const penalty = Math.min(60_000, (err instanceof RateLimited ? 2000 : 1000) * 2 ** (strikes - 1));
        this.pacerFor(url).penalize(penalty);
        this.log(`${url} benched ${penalty} ms: ${err.message}`);
      }
    }
    throw lastErr;
  }

  // A JSON-RPC query. One pinned to a block (block_id) that the regular nodes no longer hold
  // (FastNEAR answers GARBAGE_COLLECTED_BLOCK, dRPC UNKNOWN_BLOCK, checked 2026-11-12) is asked
  // again on the archival node, so a recorded block stays readable after the GC window.
  async query(params) {
    const json = await this.rpc("query", params);
    const cause = json?.error?.cause?.name;
    if (params.block_id !== undefined && (cause === "GARBAGE_COLLECTED_BLOCK" || cause === "UNKNOWN_BLOCK")) {
      this.stats.archival++;
      return this.rpc("query", params, { archival: true });
    }
    return json;
  }

  // Existence plus the account's state at a block (the latest final one by default). A missing
  // account is a normal answer (exists: false); every other error is thrown, so "missing" is
  // never guessed.
  async viewAccount(accountId, blockRef = { finality: "final" }) {
    const json = await this.query({ request_type: "view_account", account_id: accountId, ...blockRef });
    if (json.error) {
      const cause = json.error.cause?.name;
      if (cause === "UNKNOWN_ACCOUNT") {
        return { exists: false, block_height: json.error.cause.info?.block_height ?? null, block_hash: json.error.cause.info?.block_hash ?? null };
      }
      throw new Error(`view_account ${accountId}: ${cause ?? json.error.name ?? "error"} ${json.error.data ?? ""}`.trim());
    }
    const r = json.result;
    return {
      exists: true,
      block_height: r.block_height,
      block_hash: r.block_hash,
      amount: r.amount,
      locked: r.locked,
      code_hash: r.code_hash,
      storage_usage: r.storage_usage,
      global_contract_hash: r.global_contract_hash ?? null,
      global_contract_account_id: r.global_contract_account_id ?? null,
    };
  }

  // Full-access and function-call key counts at a block (pass { block_id } to pin it; every
  // page after the first is pinned to the first page's block), paginated: nearcore 2.14 refuses
  // an unpaginated list above 100 keys with TOO_MANY_ACCESS_KEYS.
  async accessKeySummary(accountId, at = { finality: "final" }) {
    let fullAccess = 0;
    let functionCall = 0;
    let afterKey;
    let blockRef = at;
    for (let page = 0; page < 50; page++) {
      const params = { request_type: "view_access_key_list", account_id: accountId, ...blockRef, limit: 100 };
      if (afterKey) params.after_key = afterKey;
      const json = await this.query(params);
      if (json.error) throw new Error(`view_access_key_list ${accountId}: ${json.error.cause?.name ?? json.error.name}`);
      const keys = json.result.keys ?? [];
      for (const k of keys) {
        if (k.access_key?.permission === "FullAccess") fullAccess++;
        else functionCall++;
      }
      blockRef = { block_id: json.result.block_hash };
      if (keys.length < 100) break;
      afterKey = json.result.last_key ?? keys[keys.length - 1].public_key;
    }
    return { full_access_keys: fullAccess, function_call_keys: functionCall };
  }

  // A view call at a block (the latest final one by default). Returns { ok: true, value } or
  // { ok: false, error } for an answer about the contract, because "this contract has no such
  // method" is data here; a node error or a transport failure after every retry throws.
  async callView(accountId, methodName, args = {}, at = { finality: "final" }) {
    const json = await this.query({
      request_type: "call_function",
      ...at,
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    // A contract-level failure comes back as result.error (a string: MethodNotFound,
    // CodeDoesNotExist, a panic) and is data. So is a missing account or contract. Any other
    // node error (a block it cannot serve, a timeout) is thrown, so "not a token" is never
    // concluded from an answer the node did not give.
    if (json.result?.error) return { ok: false, error: String(json.result.error).slice(0, 200) };
    if (json.error) {
      const cause = json.error.cause?.name ?? json.error.name ?? "error";
      if (["UNKNOWN_ACCOUNT", "NO_CONTRACT_CODE", "CONTRACT_EXECUTION_ERROR"].includes(cause)) return { ok: false, error: cause };
      throw new Error(`call_function ${accountId}.${methodName}: ${cause} ${json.error.data ?? ""}`.trim());
    }
    try {
      return { ok: true, value: JSON.parse(Buffer.from(json.result.result).toString("utf8")) };
    } catch {
      return { ok: false, error: "non-JSON result" };
    }
  }

  // FastNEAR transactions API: transactions that touch the account (any role).
  // desc:false gives the oldest first (the creation transaction for a named account).
  // Always pass desc explicitly: the live default disagrees with the schema.
  async accountTxs(accountId, { limit = 1, desc = false } = {}) {
    const json = await this.postJson(`${this.txApi}/v0/account`, { account_id: accountId, limit, desc });
    if (!json || !Array.isArray(json.account_txs)) throw new Error(`tx api ${accountId}: unexpected answer`);
    return json;
  }

  async transactions(hashes) {
    const json = await this.postJson(`${this.txApi}/v0/transactions`, { tx_hashes: hashes });
    return json?.transactions ?? [];
  }

  // Creation and activity summary from the indexer. "created" is the block of the oldest
  // transaction touching the account and "creator" is that transaction's signer; for an
  // implicit account the oldest touch is the first transfer into it.
  async activity(accountId) {
    const first = await this.accountTxs(accountId, { limit: 1, desc: false });
    const out = { txs_count: first.txs_count ?? 0, created_at: null, creation_tx: null, creator: null, last_tx_at: null, last_tx: null };
    const f = first.account_txs[0];
    if (!f) return out;
    out.created_at = nsToIso(f.tx_block_timestamp);
    out.creation_tx = f.transaction_hash;
    out.created_block = f.tx_block_height;
    const last = await this.accountTxs(accountId, { limit: 1, desc: true });
    const l = last.account_txs[0];
    if (l) {
      out.last_tx_at = nsToIso(l.tx_block_timestamp);
      out.last_tx = l.transaction_hash;
    }
    try {
      const [tx] = await this.transactions([f.transaction_hash]);
      out.creator = tx?.transaction?.signer_id ?? null;
    } catch (err) {
      this.log(`creator lookup failed for ${accountId}: ${err.message}`);
    }
    return out;
  }
}

// Runs fn over items with a fixed number of workers; results keep input order.
export async function mapPool(items, workers, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, worker));
  return out;
}

// ASCII-only text for quotes taken from other people's pages: curly quotes and dashes become
// their plain forms, other non-ASCII characters (emoji, arrows) are dropped.
export function asciiQuote(s) {
  return String(s)
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u2192/g, "->")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

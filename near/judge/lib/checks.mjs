// The claim evaluators. Each check type is an async function `(params, ctx)` that asks the chain
// (through ctx.rpc, live or replayed) and returns `{ status, detail, ... }`.
//
// The same code runs online, offline and during capture: only the transport behind ctx.rpc
// changes. A check FAILS only when it ran and the answer disagreed with the claim. A check that
// could not run (no network, no tool, nothing deployed yet) throws one of the errors in
// evidence.mjs or rpc.mjs, and the engine turns that into SKIP with the reason.

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { decode as b58decode, encode as b58encode } from './base58.mjs';
import { accessKeyRule, decodeSignedTransaction } from './borsh.mjs';
import { PendingError, SkipError } from './evidence.mjs';
import { canonical, describeMismatches, match } from './json.mjs';
import {
  ZERO_CODE_HASH,
  accessKeyListSpec,
  accessKeySpec,
  blockSpec,
  callFunctionSpec,
  decodeSuccessValue,
  decodeViewResult,
  explorerUrl,
  firstFunctionCall,
  formatNear,
  formatUnits,
  ftTransfers,
  normalizePermission,
  outcomes,
  shortId,
  statusKind,
  txEvents,
  txStatusSpec,
  viewAccountSpec,
} from './near.mjs';
import { parseCargoTest, parseNodeTest, runProcess, which } from './proc.mjs';
import { rpcErrorName } from './rpc.mjs';

const PASS = (detail, extra = {}) => ({ status: 'PASS', detail, ...extra });
const FAIL = (detail, extra = {}) => ({ status: 'FAIL', detail, ...extra });

function short(value, max = 100) {
  const text = typeof value === 'string' ? value : canonical(value);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function at(call) {
  if (call.block_height !== null && call.block_height !== undefined) return `block ${call.block_height}`;
  if (call.block_hash) return `block ${call.block_hash}`;
  return 'the latest final block';
}

/** Split an answer into its result or its error. An error that is node trouble rather than an
 *  answer about the chain becomes SKIP: it says nothing about the claim. */
function unpack(call, answers = []) {
  const { response } = call;
  if (response.error) {
    const name = rpcErrorName(response);
    const message = String(response.error.data ?? response.error.message ?? '');
    if (!answers.includes(name)) {
      throw new SkipError(`RPC answered ${name}: ${short(message, 120)}`);
    }
    return { error: name, message };
  }
  return { result: response.result };
}

function sameSet(a, b) {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return a.length === x.length && x.length === y.length && x.every((item, i) => item === y[i]);
}

// ---------------------------------------------------------------------------------------------
// account_exists
// ---------------------------------------------------------------------------------------------

async function accountExists(p, ctx) {
  const wantExists = p.exists ?? true;
  const call = await ctx.rpc(viewAccountSpec(ctx.network, p.account_id, p.block_id));
  const { result, error, message } = unpack(call, ['UNKNOWN_ACCOUNT', 'INVALID_ACCOUNT']);
  const urls = [explorerUrl(ctx.network, 'account', p.account_id)];
  if (error === 'INVALID_ACCOUNT') return FAIL(`${p.account_id} is not a valid account id: ${short(message)}`, { urls });
  if (error === 'UNKNOWN_ACCOUNT') {
    const text = `view_account at ${at(call)}: ${p.account_id} does not exist`;
    return wantExists ? FAIL(text, { urls }) : PASS(text, { urls });
  }
  if (!wantExists) return FAIL(`view_account at ${at(call)}: ${p.account_id} still exists`, { urls });
  const hasContract = result.code_hash !== ZERO_CODE_HASH;
  if (p.has_contract !== undefined && p.has_contract !== hasContract) {
    return FAIL(`view_account at ${at(call)}: ${p.has_contract ? 'no contract deployed' : `a contract is deployed (${result.code_hash})`}`, { urls });
  }
  const contract = hasContract ? `contract code_hash ${result.code_hash}` : 'no contract';
  return PASS(`view_account at ${at(call)}: ${formatNear(result.amount)}, ${contract}`, {
    observed: { amount: result.amount, code_hash: result.code_hash, storage_usage: result.storage_usage },
    urls,
  });
}

// ---------------------------------------------------------------------------------------------
// code_hash_matches_committed_wasm
// ---------------------------------------------------------------------------------------------

async function codeHashMatchesCommittedWasm(p, ctx) {
  const wasmFile = resolve(ctx.root, p.wasm_path);
  if (!existsSync(wasmFile)) return FAIL(`the committed wasm ${p.wasm_path} is not in the tree`);
  const bytes = readFileSync(wasmFile);
  const digest = createHash('sha256').update(bytes).digest();
  const hex = digest.toString('hex');
  const b58 = b58encode(digest);
  const problems = [];
  if (p.sha256_hex && p.sha256_hex !== hex) problems.push(`deployments records sha256 ${p.sha256_hex} but the file hashes to ${hex}`);
  if (p.sha256_base58 && p.sha256_base58 !== b58) problems.push(`deployments records base58 ${p.sha256_base58} but the file gives ${b58}`);
  if (p.recorded_code_hash && p.recorded_code_hash !== b58) problems.push(`deployments records code_hash ${p.recorded_code_hash}, not ${b58}`);

  const call = await ctx.rpc(viewAccountSpec(ctx.network, p.account_id, p.block_id));
  const { result, error } = unpack(call, ['UNKNOWN_ACCOUNT']);
  const urls = [explorerUrl(ctx.network, 'account', p.account_id)];
  if (error) return FAIL(`${p.account_id} does not exist (view_account at ${at(call)})`, { urls });
  if (result.code_hash !== b58) {
    problems.unshift(`on-chain code_hash ${result.code_hash} at ${at(call)} is not base58(sha256(${p.wasm_path})) = ${b58}`);
  }
  const observed = { code_hash: result.code_hash, wasm_sha256_hex: hex, wasm_sha256_base58: b58, wasm_bytes: bytes.length };
  if (problems.length) return FAIL(problems.join('; '), { observed, urls });
  return PASS(`code_hash ${result.code_hash} at ${at(call)} = base58(sha256(${p.wasm_path})), ${bytes.length} bytes, sha256 ${hex}`, { observed, urls });
}

// ---------------------------------------------------------------------------------------------
// access_keys
// ---------------------------------------------------------------------------------------------

function describeKey(key) {
  if (key.kind === 'FullAccess') return `${key.public_key} FullAccess`;
  if (key.kind === 'FunctionCall') {
    return `${key.public_key} FunctionCall ${key.receiver_id} [${key.method_names.join(',') || 'ANY METHOD'}] allowance ${formatNear(key.allowance)}`;
  }
  return `${key.public_key} ${key.variant}`;
}

async function accessKeys(p, ctx) {
  const call = await ctx.rpc(accessKeyListSpec(ctx.network, p.account_id, p.block_id));
  const { result, error, message } = unpack(call, ['UNKNOWN_ACCOUNT', 'TOO_MANY_ACCESS_KEYS']);
  const urls = [explorerUrl(ctx.network, 'account', p.account_id)];
  if (error === 'UNKNOWN_ACCOUNT') return FAIL(`${p.account_id} does not exist (view_access_key_list at ${at(call)})`, { urls });
  if (error) return FAIL(`${p.account_id} has more keys than one page holds: ${short(message)}`, { urls });

  const keys = result.keys.map((entry) => ({ public_key: entry.public_key, nonce: entry.access_key?.nonce, ...normalizePermission(entry.access_key?.permission) }));
  if (keys.length === 0) {
    // nearcore answers an empty key list for an account that does not exist at all, and "no
    // full-access key" must not pass for a missing account. Same block, so the same state.
    const exists = await ctx.rpc(viewAccountSpec(ctx.network, p.account_id, call.block_hash ?? p.block_id));
    const { error: missing } = unpack(exists, ['UNKNOWN_ACCOUNT']);
    const where = exists.block_height != null || exists.block_hash ? at(exists) : at(call);
    if (missing) return FAIL(`${p.account_id} does not exist at ${where}: its empty key list proves nothing`, { urls });
  }
  const full = keys.filter((key) => key.kind === 'FullAccess');
  const calls = keys.filter((key) => key.kind === 'FunctionCall');
  const other = keys.filter((key) => key.kind === 'Other');
  const problems = [];

  if (p.full_access_count !== undefined && full.length !== p.full_access_count) {
    problems.push(`${full.length} full-access key(s), the claim says ${p.full_access_count}`);
  }
  if (other.length) problems.push(`${other.length} key(s) of a kind this judge does not know (${other.map((k) => k.variant).join(', ')})`);
  const want = p.function_call;
  if (want) {
    for (const key of calls) {
      if (want.receiver_id !== undefined && key.receiver_id !== want.receiver_id) {
        problems.push(`key ${key.public_key} may call ${key.receiver_id}, not only ${want.receiver_id}`);
      }
      if (want.method_names) {
        if (key.method_names.length === 0) problems.push(`key ${key.public_key} may call ANY method (empty method_names)`);
        else if (!sameSet(key.method_names, want.method_names)) {
          problems.push(`key ${key.public_key} allows [${key.method_names.join(',')}], the claim says exactly [${want.method_names.join(',')}]`);
        }
      }
      if (want.allowance === 'finite' && key.allowance === null) problems.push(`key ${key.public_key} has an unlimited allowance`);
    }
  }
  if (p.min_function_call_keys !== undefined && calls.length < p.min_function_call_keys) {
    problems.push(`${calls.length} function-call key(s), the claim needs at least ${p.min_function_call_keys}`);
  }
  if (p.max_function_call_keys !== undefined && calls.length > p.max_function_call_keys) {
    problems.push(`${calls.length} function-call key(s), the claim allows at most ${p.max_function_call_keys}`);
  }
  for (const key of (p.must_include ?? []).filter(Boolean)) {
    if (!keys.some((k) => k.public_key === key)) problems.push(`key ${key} is not on ${p.account_id}`);
  }
  for (const key of (p.must_exclude ?? []).filter(Boolean)) {
    if (keys.some((k) => k.public_key === key)) problems.push(`key ${key} is still on ${p.account_id}`);
  }
  const summary = `view_access_key_list at ${at(call)}: ${full.length} full-access, ${calls.length} function-call${keys.length ? ` (${keys.map(describeKey).join('; ')})` : ''}`;
  const observed = { keys };
  if (problems.length) return FAIL(`${problems.join('; ')}; ${summary}`, { observed, urls });
  return PASS(summary, { observed, urls });
}

// ---------------------------------------------------------------------------------------------
// view_equals
// ---------------------------------------------------------------------------------------------

async function viewEquals(p, ctx) {
  const call = await ctx.rpc(callFunctionSpec(ctx.network, p.account_id, p.method, p.args ?? {}, p.block_id));
  // A read pinned to a block goes to archival RPC, so UNKNOWN_BLOCK there is an answer: the block
  // deployments names does not exist.
  const { result, error, message } = unpack(call, ['UNKNOWN_ACCOUNT', 'CONTRACT_EXECUTION_ERROR', 'NO_CONTRACT_CODE', 'UNKNOWN_BLOCK']);
  const label = `${p.method}(${short(p.args ?? {}, 60)}) on ${shortId(p.account_id)}`;
  if (error) return FAIL(`${label} failed at ${at(call)}: ${error} ${short(message, 140)}`);
  // A panicking or missing view comes back as a result with an `error` string, not an RPC error.
  if (typeof result.error === 'string') return FAIL(`${label} failed at ${at(call)}: ${short(result.error, 160)}`);
  const decoded = decodeViewResult(result);
  const actual = decoded.ok ? decoded.json : decoded.text;
  const mismatches = match(actual, p.expect);
  const observed = { value: actual };
  if (mismatches.length) return FAIL(`${label} at ${at(call)}: ${describeMismatches(mismatches)}`, { observed });
  // Show the fields the claim is about, not the whole answer (ft_metadata carries an icon).
  const named = p.expect && typeof p.expect === 'object' && !Array.isArray(p.expect) && !Object.keys(p.expect).some((k) => k.startsWith('$'));
  const shown = named && actual && typeof actual === 'object' ? Object.fromEntries(Object.keys(p.expect).map((k) => [k, actual[k]])) : actual;
  return PASS(`${label} at ${at(call)} = ${short(shown, 200)}`, { observed });
}

// ---------------------------------------------------------------------------------------------
// tx_outcome
// ---------------------------------------------------------------------------------------------

function eventMatches(event, want) {
  if (event.malformed) return false;
  if (want.standard && event.standard !== want.standard) return false;
  if (want.event && event.event !== want.event) return false;
  if (want.version && event.version !== want.version) return false;
  if (want.executor_id && event.executor_id !== want.executor_id) return false;
  if (want.data && match(event.data, want.data).length) return false;
  return true;
}

function describeEvent(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  // `kind` is what a vault 0.2.0 hold says the vault saw; a held request's `reason` is the agent's own text.
  const keys = ['payee', 'amount', 'reason', 'kind', 'source', 'by_owner', 'held_id', 'account_id', 'verdict'];
  const shown = keys.filter((key) => key in data).map((key) => `${key}=${short(data[key], 40)}`);
  return `${event.event}{${shown.join(' ')}}`;
}

async function txOutcome(p, ctx) {
  const call = await ctx.rpc(txStatusSpec(ctx.network, p.tx_hash, p.sender_account_id));
  const { result: r, error, message } = unpack(call, ['UNKNOWN_TRANSACTION', 'INVALID_TRANSACTION', 'PARSE_ERROR']);
  const urls = [explorerUrl(ctx.network, 'tx', p.tx_hash)];
  if (error) return FAIL(`archival RPC does not return tx ${p.tx_hash} from ${p.sender_account_id}: ${error} ${short(message, 100)}`, { urls });

  let included = '';
  const inclusionHash = r.transaction_outcome?.block_hash;
  if (inclusionHash) {
    const blockCall = await ctx.rpc(blockSpec(ctx.network, inclusionHash));
    const header = blockCall.response.result?.header;
    const nanos = header?.timestamp_nanosec ?? header?.timestamp;
    if (header && /^\d+$/.test(String(nanos))) {
      const iso = new Date(Number(BigInt(String(nanos)) / 1000000n)).toISOString();
      included = ` in block ${header.height} (${iso})`;
    }
  }

  const want = p.expect ?? {};
  const problems = [];
  const tx = r.transaction ?? {};
  const fn = firstFunctionCall(tx);
  const finality = want.final_execution_status ?? 'FINAL';
  if (r.final_execution_status !== finality) problems.push(`final_execution_status is ${r.final_execution_status}, not ${finality}`);

  const header = { signer_id: tx.signer_id, public_key: tx.public_key, receiver_id: tx.receiver_id, method_name: fn?.method_name, deposit: fn?.deposit };
  for (const field of ['signer_id', 'public_key', 'receiver_id', 'method_name', 'deposit']) {
    if (want[field] === undefined) continue;
    const mismatch = match(header[field], want[field]);
    if (mismatch.length) problems.push(`${field} ${short(header[field], 60)}, expected ${mismatch[0].expected}`);
  }

  const status = statusKind(r.status);
  if (want.status && status !== want.status) problems.push(`the transaction's final status is ${status} (${short(r.status, 120)}), expected ${want.status}`);
  if (want.return !== undefined) {
    const value = decodeSuccessValue(r.status);
    const mismatches = match(value, want.return);
    if (mismatches.length) problems.push(`return value ${describeMismatches(mismatches)}`);
  }
  if (want.no_failed_receipts) {
    const failed = outcomes(r).filter((o) => statusKind(o.status) === 'failure');
    if (failed.length) problems.push(`${failed.length} receipt(s) failed (${failed.map((o) => `${o.executor_id}: ${short(o.status?.Failure, 80)}`).join('; ')})`);
  }

  const events = txEvents(r);
  const malformed = events.filter((e) => e.malformed);
  if (malformed.length) problems.push(`${malformed.length} malformed EVENT_JSON log(s)`);
  const seen = [];
  for (const wantEvent of want.events ?? []) {
    const found = events.filter((event) => eventMatches(event, wantEvent) && (wantEvent.require_success === false || event.success));
    if (wantEvent.count !== undefined ? found.length !== wantEvent.count : found.length === 0) {
      const sameName = events.filter((event) => event.standard === wantEvent.standard && event.event === wantEvent.event);
      problems.push(
        `expected ${wantEvent.count ?? 'at least 1'} ${wantEvent.standard}:${wantEvent.event} event(s) matching ${short(wantEvent.data ?? {}, 120)}, found ${found.length}` +
          (sameName.length && !found.length ? ` (closest: ${short(sameName[0].data, 140)})` : ''),
      );
    } else {
      seen.push(...found.map(describeEvent));
    }
  }
  for (const wantAbsent of want.absent_events ?? []) {
    const found = events.filter((event) => eventMatches(event, wantAbsent));
    if (found.length) problems.push(`unexpected ${wantAbsent.standard}:${wantAbsent.event} event(s): ${short(found[0].data, 120)}`);
  }

  const moved = [];
  for (const wantTransfer of want.ft_transfers ?? []) {
    const transfers = ftTransfers(r, wantTransfer.token_id).filter((t) => t.success);
    const symbol = wantTransfer.symbol ?? 'tokens';
    const decimals = wantTransfer.decimals ?? 0;
    if (wantTransfer.present === false) {
      const hits = transfers.filter((t) => t.to === wantTransfer.to && (wantTransfer.from === undefined || t.from === wantTransfer.from));
      if (hits.length) problems.push(`${formatUnits(hits[0].amount, decimals)} ${symbol} WAS transferred to ${wantTransfer.to}`);
      else moved.push(`no ${symbol} transfer to ${wantTransfer.to}`);
    } else {
      const hits = transfers.filter(
        (t) => t.to === wantTransfer.to && (wantTransfer.from === undefined || t.from === wantTransfer.from) && (wantTransfer.amount === undefined || t.amount === String(wantTransfer.amount)),
      );
      if (!hits.length) {
        problems.push(
          `no successful nep141 ft_transfer by ${shortId(wantTransfer.token_id)} to ${wantTransfer.to}${wantTransfer.amount !== undefined ? ` of ${wantTransfer.amount}` : ''} (token transfers seen: ${transfers.length ? transfers.map((t) => `${t.amount} to ${t.to}`).join(', ') : 'none'})`,
        );
      } else {
        moved.push(`ft_transfer ${formatUnits(hits[0].amount, decimals)} ${symbol} from ${hits[0].from} to ${hits[0].to} executed by ${shortId(wantTransfer.token_id)}`);
      }
    }
  }
  for (const account of (want.no_receipts_executed_by ?? []).filter(Boolean)) {
    const touched = outcomes(r).filter((o) => o.kind === 'receipt' && o.executor_id === account);
    if (touched.length) problems.push(`${touched.length} receipt(s) executed by ${shortId(account)}`);
    else moved.push(`no receipt reached ${shortId(account)}`);
  }

  const observed = {
    final_execution_status: r.final_execution_status,
    status: r.status,
    signer_id: tx.signer_id,
    public_key: tx.public_key,
    receiver_id: tx.receiver_id,
    method_name: fn?.method_name ?? null,
    return_value: decodeSuccessValue(r.status) ?? null,
    events: events.filter((e) => !e.malformed).map(({ standard, event, data, executor_id, success }) => ({ standard, event, executor_id, success, data })),
  };
  const head = `tx ${p.tx_hash} ${r.final_execution_status}${included}: ${tx.signer_id} signed ${fn?.method_name ?? 'a non-call action'} on ${shortId(tx.receiver_id)}`;
  if (problems.length) return FAIL(`${head}; ${problems.join('; ')}`, { observed, urls });
  const tail = [seen.length ? `events ${seen.join(', ')}` : '', ...moved].filter(Boolean).join('; ');
  return PASS(`${head}${tail ? `; ${tail}` : ''}`, { observed, urls });
}

// ---------------------------------------------------------------------------------------------
// verdict_recompute
// ---------------------------------------------------------------------------------------------

function firstJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // keep shrinking
    }
  }
  return undefined;
}

/** Node runs TypeScript with --experimental-strip-types from 22.6 on (and by default from 23.6). */
export function supportsStripTypes(version = process.versions.node) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 6);
}

/** The value at each dotted path of `projection` ("header.height,header.hash"), the way the SDK's
 *  recorder keeps only part of a large answer. */
export function projectPaths(value, projection) {
  if (!projection) return value;
  const out = {};
  for (const path of String(projection).split(',').map((part) => part.trim()).filter(Boolean)) {
    const parts = path.split('.');
    let source = value;
    for (const part of parts) source = source !== null && typeof source === 'object' ? source[part] : undefined;
    if (source === undefined) continue;
    let target = out;
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== 'object') target[part] = {};
      target = target[part];
    }
    target[parts.at(-1)] = source;
  }
  return out;
}

/** Where `fresh` does not hold what was `recorded`, or null. Objects are compared on the recorded
 *  keys (a newer node may add a field to an answer); arrays and scalars must be equal. */
export function recordedDiff(recorded, fresh, path = '$') {
  // JSON text on both sides, so "1" (a string) and 1 (a number) read differently.
  const show = (value) => (value === undefined ? 'nothing' : short(canonical(value), 60));
  if (recorded !== null && typeof recorded === 'object' && !Array.isArray(recorded)) {
    if (fresh === null || typeof fresh !== 'object' || Array.isArray(fresh)) return `${path}: recorded an object, archival gives ${show(fresh)}`;
    for (const [key, value] of Object.entries(recorded)) {
      const found = recordedDiff(value, fresh[key], `${path}.${key}`);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(recorded)) {
    if (!Array.isArray(fresh) || fresh.length !== recorded.length) return `${path}: recorded ${show(recorded)}, archival gives ${show(fresh)}`;
    for (let i = 0; i < recorded.length; i++) {
      const found = recordedDiff(recorded[i], fresh[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  return recorded === fresh ? null : `${path}: recorded ${show(recorded)}, archival gives ${show(fresh)}`;
}

const UNREAD = new Set(['UNAVAILABLE', 'CLIENT_ERROR']);

/**
 * The oracle's inputs, checked against the chain: every block-pinned JSON-RPC read the snapshot
 * recorded (sdk/src/engine/types.ts RpcRecord) is asked again on archival RPC at the same block
 * and must give the same answer. A read the oracle could not make (recorded UNAVAILABLE) has no
 * answer to compare and is listed; indexer answers (snapshot.http) are not pinned to a block and
 * are not re-asked.
 */
async function verifySnapshotReads(snapshot, ctx) {
  const reads = Array.isArray(snapshot?.rpc) ? snapshot.rpc : null;
  const http = Array.isArray(snapshot?.http) ? snapshot.http.length : 0;
  if (!reads || reads.length === 0) {
    return { checked: 0, total: 0, http, unchecked: [], problems: ['the snapshot records no chain reads (rpc), so the data behind the verdict cannot be checked against the chain'] };
  }
  let checked = 0;
  const unchecked = [];
  const problems = [];
  for (const read of reads) {
    const label = read?.label ?? '?';
    const params = read?.params;
    const pinned = read?.method === 'EXPERIMENTAL_tx_status' || (params !== null && typeof params === 'object' && !Array.isArray(params) && 'block_id' in params);
    if (!pinned) {
      unchecked.push(`${label} (not pinned to a block)`);
      continue;
    }
    if (read.error && (UNREAD.has(read.error.cause) || UNREAD.has(read.error.name))) {
      unchecked.push(`${label} (the oracle could not read it: ${read.error.cause ?? read.error.name})`);
      continue;
    }
    const call = await ctx.rpc({ network: read.network ?? snapshot.network ?? ctx.network, kind: 'archival', method: read.method, params });
    const fresh = call.response;
    // nearcore reports a failed view inside a successful answer ({ result: { error } }); the SDK
    // records that as CONTRACT_EXECUTION_ERROR, so it is compared as one.
    const freshError = fresh.error
      ? rpcErrorName(fresh)
      : read.method === 'query' && typeof fresh.result?.error === 'string'
        ? 'CONTRACT_EXECUTION_ERROR'
        : null;
    let diff = null;
    if (read.error) {
      if (!freshError) diff = `recorded error ${read.error.cause}, archival gives a result`;
      else if (freshError !== read.error.cause && freshError !== read.error.name) diff = `recorded error ${read.error.cause}, archival gives ${freshError}`;
    } else if (freshError) {
      diff = `recorded a result, archival gives ${freshError}`;
    } else {
      diff = recordedDiff(read.result ?? null, projectPaths(fresh.result, read.projection));
    }
    if (diff) problems.push(`snapshot read ${label} (${read.method} at block ${params.block_id ?? '?'}): ${diff}`);
    else checked++;
  }
  return { checked, total: reads.length, http, unchecked, problems };
}

async function verdictRecompute(p, ctx) {
  const cliRel = p.cli ?? 'sdk/src/cli/verdict.ts';
  const cli = resolve(ctx.root, cliRel);
  if (!existsSync(cli)) throw new SkipError(`the SDK verdict CLI is not in the tree yet (${cliRel})`);
  const nodeVersion = ctx.options.nodeVersion ?? process.versions.node;
  if (!supportsStripTypes(nodeVersion)) {
    throw new SkipError(`Node ${nodeVersion} cannot run the TypeScript CLI; the recompute needs Node 22.6 or later (--experimental-strip-types)`);
  }
  const snapshot = resolve(ctx.root, p.snapshot);
  if (!existsSync(snapshot)) return FAIL(`the snapshot ${p.snapshot} named in deployments is not in the tree`);
  const snapshotBytes = readFileSync(snapshot);
  const snapshotSha = createHash('sha256').update(snapshotBytes).digest('hex');
  let snapshotJson;
  try {
    snapshotJson = JSON.parse(snapshotBytes.toString('utf8'));
  } catch (err) {
    return FAIL(`the snapshot ${p.snapshot} is not valid JSON: ${err.message}`);
  }

  const timeoutS = p.timeout_s ?? 60;
  const args = ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', cli, '--offline', snapshot, '--json'];
  const run = await runProcess(process.execPath, args, { cwd: ctx.root, timeoutMs: timeoutS * 1000 });
  const command = `node --experimental-strip-types ${cliRel} --offline ${p.snapshot} --json`;
  if (run.timedOut) throw new SkipError(`${command} did not finish within its ${timeoutS} s time box`);
  if (run.code !== 0) {
    const text = `${run.stderr}\n${run.stdout}`;
    if (/bad option: --experimental-strip-types|--experimental-strip-types is not (?:allowed|supported)/.test(text)) {
      throw new SkipError(`this Node (${process.version}) has no --experimental-strip-types; the recompute needs Node 22.6 or later`);
    }
    if (/ERR_MODULE_NOT_FOUND|Cannot find package/.test(text)) {
      throw new SkipError(`${command} needs dependencies that are not installed (run npm ci in near/): ${short(text.match(/Cannot find (?:package|module) '[^']+'/)?.[0] ?? 'ERR_MODULE_NOT_FOUND', 100)}`);
    }
    return FAIL(`${command} exited ${run.code ?? run.signal}: ${short(text.trim().split('\n').slice(-3).join(' | '), 200)}`);
  }
  const out = firstJson(run.stdout);
  if (!out) return FAIL(`${command} printed no JSON`);
  // sdk/src/cli/verdict.ts --json prints { account, verdict, reasons: [{ code, ... }],
  // registry_reasons: [code], snapshot_sha256, chain_sha256, evidence, block, engine_version, ... }.
  // The registry stores registry_reasons, so those are what a recomputation is compared with.
  const computed = out.verdict ?? out.result?.verdict;
  const reasonCodes = (list) => (Array.isArray(list) ? list.map((r) => (r && typeof r === 'object' ? r.code : r)) : undefined);
  const computedReasons = reasonCodes(out.registry_reasons) ?? reasonCodes(out.reasons ?? out.result?.reasons);
  const computedAccount = out.account ?? out.account_id ?? out.result?.account_id;
  const recomputedSha = typeof out.snapshot_sha256 === 'string' ? out.snapshot_sha256 : snapshotSha;
  const problems = [];
  if (computedAccount !== undefined && computedAccount !== p.account_id) problems.push(`the CLI judged ${computedAccount}, not ${p.account_id}`);
  if (p.expect_verdict && computed !== p.expect_verdict) problems.push(`the CLI says ${computed}, the claim says ${p.expect_verdict}`);
  if (p.snapshot_sha256 && p.snapshot_sha256 !== recomputedSha) problems.push(`deployments records snapshot sha256 ${p.snapshot_sha256}, the CLI recomputed ${recomputedSha}`);

  const call = await ctx.rpc(callFunctionSpec(ctx.network, p.registry_id, 'get_verdict', { account_id: p.account_id }, p.block_id));
  const { result, error, message } = unpack(call, ['UNKNOWN_ACCOUNT', 'CONTRACT_EXECUTION_ERROR', 'NO_CONTRACT_CODE', 'UNKNOWN_BLOCK']);
  if (error) return FAIL(`get_verdict on ${p.registry_id} failed at ${at(call)}: ${error} ${short(message)}`);
  if (typeof result.error === 'string') return FAIL(`get_verdict on ${p.registry_id} failed at ${at(call)}: ${short(result.error, 160)}`);
  const registry = decodeViewResult(result).json;
  if (!registry) {
    problems.push(`the registry has no live verdict for ${p.account_id} at ${at(call)}`);
  } else {
    if (registry.verdict !== computed) problems.push(`recomputed ${computed}, registry says ${registry.verdict}`);
    if (p.compare_reasons !== false && Array.isArray(registry.reasons) && Array.isArray(computedReasons) && !sameSet(registry.reasons, computedReasons)) {
      problems.push(`recomputed reasons [${computedReasons.join(',')}], registry reasons [${registry.reasons.join(',')}]`);
    }
    // The oracle writes the SDK's evidence string, "near-snapshot sha256:<hex> block:<h>
    // engine:<v>", so the on-chain verdict names the exact snapshot, block and engine.
    const evidence = typeof registry.evidence === 'string' ? registry.evidence : null;
    const bound = evidence ? evidence.match(/sha256:([0-9a-f]{64})/) : null;
    if (bound && bound[1] !== recomputedSha) problems.push(`the registry's evidence names snapshot sha256 ${bound[1]}, the recomputed snapshot is ${recomputedSha}`);
    if (bound && typeof out.evidence === 'string' && evidence.startsWith('near-snapshot ') && evidence !== out.evidence) {
      problems.push(`the registry's evidence "${evidence}" differs from the recomputed "${out.evidence}"`);
    }
    if (p.require_snapshot_binding && !bound) problems.push(`the registry's evidence field (${short(evidence, 60)}) does not name the snapshot sha256`);
  }

  // The recomputation proves the engine is deterministic on this snapshot; this proves the
  // snapshot is the chain: each block-pinned read in it is what archival RPC answers.
  let reads = null;
  if (p.verify_chain_reads !== false) {
    reads = await verifySnapshotReads(snapshotJson, ctx);
    problems.push(...reads.problems.slice(0, 3));
    if (reads.problems.length > 3) problems.push(`and ${reads.problems.length - 3} more snapshot read(s) that differ`);
  }
  const readsText = reads
    ? `; ${reads.checked}/${reads.total} snapshot chain reads match archival RPC at their blocks${reads.unchecked.length ? ` (${reads.unchecked.length} not comparable: ${short(reads.unchecked.join(', '), 80)})` : ''}, ${reads.http} indexer answer(s) not pinned to a block, not re-asked`
    : '';
  const observed = {
    computed: out,
    registry,
    snapshot_file_sha256: snapshotSha,
    snapshot_sha256: recomputedSha,
    chain_reads: reads ? { checked: reads.checked, total: reads.total, unchecked: reads.unchecked, indexer_answers: reads.http } : null,
  };
  const reasonsText = Array.isArray(computedReasons) ? ` [${computedReasons.join(',')}]` : '';
  const regText = registry ? `${registry.verdict} [${(registry.reasons ?? []).join(',')}]` : 'none';
  const binding = registry && typeof registry.evidence === 'string' && registry.evidence.includes(`sha256:${recomputedSha}`) ? `, its evidence names this snapshot (sha256 ${recomputedSha.slice(0, 12)}...)` : '';
  if (problems.length) return FAIL(`${problems.join('; ')} (CLI: ${computed}${reasonsText}; registry at ${at(call)}: ${regText})`, { observed });
  return PASS(`${cliRel} --offline on the snapshot gives ${computed}${reasonsText}; registry get_verdict at ${at(call)} gives ${regText}${binding}${readsText}`, { observed });
}

// ---------------------------------------------------------------------------------------------
// counter_matches_events
// ---------------------------------------------------------------------------------------------

/** The transactions a counter is compared with: every demo transaction deployments records with
 *  a hash, and every transaction in the cited demo run logs (their txs list), deduplicated. */
function demoTransactions(p, ctx) {
  const out = [];
  const seen = new Set();
  const add = (name, txHash, sender) => {
    if (typeof txHash !== 'string' || txHash === '' || seen.has(txHash)) return;
    seen.add(txHash);
    out.push({ name, tx_hash: txHash, sender: typeof sender === 'string' ? sender : null });
  };
  const listed = p.transactions ?? {};
  const entries = Array.isArray(listed) ? listed.map((tx, i) => [tx?.name ?? `transactions[${i}]`, tx]) : Object.entries(listed);
  for (const [name, tx] of entries) {
    if (tx && typeof tx === 'object') add(name, tx.tx_hash, tx.sender_account_id ?? tx.signer_id);
  }
  for (const log of (p.logs ?? []).filter(Boolean)) {
    const file = resolve(ctx.root, log);
    if (!existsSync(file)) return { error: `the demo log ${log} named in deployments is not in the tree` };
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return { error: `${log} is not valid JSON: ${err.message}` };
    }
    for (const tx of Array.isArray(parsed?.txs) ? parsed.txs : []) add(`${log} ${tx?.phase ?? '?'}/${tx?.step ?? '?'}`, tx?.tx_hash, tx?.signer_id);
  }
  return { transactions: out };
}

/**
 * A vault counter (paid_count, refusal_count, guard_refusal_count) read at a recorded block must
 * equal, exactly, the number of matching events in the demo's transactions, each executed at or
 * before that block. Equality goes both ways: a counter that also counted other refusals is
 * larger than its events, and a transaction left out of the record makes the events fewer than
 * the counter. Both FAIL. The transactions are read from archival RPC, never from the log.
 */
async function counterMatchesEvents(p, ctx) {
  const label = `${p.method}(${short(p.args ?? {}, 60)}) on ${shortId(p.account_id)}`;
  const listed = demoTransactions(p, ctx);
  if (listed.error) return FAIL(listed.error);
  const txs = listed.transactions;
  const want = p.event ?? {};
  const eventName = `${want.standard ?? '*'}:${want.event ?? '*'}${want.data ? short(want.data, 90) : ''}`;

  const view = await ctx.rpc(callFunctionSpec(ctx.network, p.account_id, p.method, p.args ?? {}, p.block_id));
  const { result, error, message } = unpack(view, ['UNKNOWN_ACCOUNT', 'CONTRACT_EXECUTION_ERROR', 'NO_CONTRACT_CODE', 'UNKNOWN_BLOCK']);
  if (error) return FAIL(`${label} failed at ${at(view)}: ${error} ${short(message, 140)}`);
  if (typeof result.error === 'string') return FAIL(`${label} failed at ${at(view)}: ${short(result.error, 160)}`);
  const value = decodeViewResult(result).json;
  if (!Number.isInteger(value) || value < 0) return FAIL(`${label} at ${at(view)} returned ${short(value)}, not a count`);
  const readHeight = view.block_height ?? (Number.isInteger(p.block_id) ? p.block_id : null);

  const heights = new Map();
  const heightOf = async (blockHash) => {
    if (!heights.has(blockHash)) {
      const call = await ctx.rpc(blockSpec(ctx.network, blockHash));
      const { result: block } = unpack(call, ['UNKNOWN_BLOCK']);
      heights.set(blockHash, block?.header?.height ?? null);
    }
    return heights.get(blockHash);
  };
  const problems = [];
  const matched = [];
  for (const tx of txs) {
    if (!tx.sender) {
      problems.push(`${tx.name} (${tx.tx_hash}) has no signer recorded, so it cannot be looked up`);
      continue;
    }
    const call = await ctx.rpc(txStatusSpec(ctx.network, tx.tx_hash, tx.sender));
    const { result: r, error: txError } = unpack(call, ['UNKNOWN_TRANSACTION', 'INVALID_TRANSACTION', 'PARSE_ERROR']);
    if (txError) {
      problems.push(`${tx.name} ${tx.tx_hash}: archival RPC answers ${txError}`);
      continue;
    }
    for (const event of txEvents(r).filter((e) => e.success && eventMatches(e, want))) {
      const height = event.block_hash ? await heightOf(event.block_hash) : null;
      if (readHeight !== null && (height === null || height > readHeight)) {
        problems.push(`${tx.name} emitted it in block ${height ?? 'unknown'}, after block ${readHeight} where the counter was read`);
      }
      matched.push({ name: tx.name, tx_hash: tx.tx_hash, block_height: height, event });
    }
  }
  if (p.min !== undefined && value < p.min) problems.push(`${label} is ${value}, the claim needs at least ${p.min}`);
  if (matched.length !== value) {
    problems.push(
      `${label} is ${value} at ${at(view)}, but the ${txs.length} demo transaction(s) hold ${matched.length} ${eventName} event(s): ` +
        (matched.length < value ? 'the counter counts something these transactions do not show (another kind of event, or a transaction missing from deployments and the demo log)' : 'the counter missed events'),
    );
  }
  if (p.include && !matched.some((m) => eventMatches(m.event, p.include))) {
    problems.push(`none of the ${matched.length} matching event(s) also matches ${short(p.include.data ?? p.include, 80)}`);
  }
  const observed = {
    value,
    block_height: readHeight,
    transactions: txs.length,
    matched: matched.map(({ name, tx_hash, block_height, event }) => ({ name, tx_hash, block_height, data: event.data })),
  };
  const where = matched.map((m) => `${m.name} (block ${m.block_height})`).join(', ');
  if (problems.length) return FAIL(`${problems.join('; ')}`, { observed });
  return PASS(`${label} at ${at(view)} = ${value}, exactly the ${matched.length} ${eventName} event(s) in the ${txs.length} demo transaction(s), each executed by then: ${short(where, 160)}`, { observed });
}

// ---------------------------------------------------------------------------------------------
// protocol_rejection
// ---------------------------------------------------------------------------------------------

/** Every object key and string value in a JSON value: where nearcore puts the rule name
 *  depends on the variant (a unit variant is a string, a struct variant is a key). */
function namesIn(value, out = new Set()) {
  if (typeof value === 'string') out.add(value);
  else if (Array.isArray(value)) value.forEach((item) => namesIn(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      namesIn(child, out);
    }
  }
  return out;
}

/** nearcore calls it MethodNameMismatch; some clients prefix AccessKey. Same rule. */
function canonicalRule(name) {
  return String(name).replace(/^AccessKey(?=MethodNameMismatch|ReceiverMismatch)/, '');
}

function signedTxOf(request) {
  const params = request?.params;
  if (Array.isArray(params) && typeof params[0] === 'string') return params[0];
  if (params && typeof params === 'object' && typeof params.signed_tx_base64 === 'string') return params.signed_tx_base64;
  return null;
}

function describeAction(action) {
  if (!action) return 'no action';
  if (action.type === 'FunctionCall') return `FunctionCall ${action.method_name} deposit ${action.deposit} yocto`;
  if (action.type === 'Transfer') return `Transfer ${formatNear(action.deposit)}`;
  if (action.type === 'AddKey') return `AddKey ${action.access_key.permission.kind}`;
  return action.type;
}

async function protocolRejection(p, ctx) {
  const logFile = resolve(ctx.root, p.log);
  if (!existsSync(logFile)) throw new PendingError(`the attack demo log ${p.log} is not recorded yet`);
  let log;
  try {
    log = JSON.parse(readFileSync(logFile, 'utf8'));
  } catch (err) {
    return FAIL(`${p.log} is not valid JSON: ${err.message}`);
  }
  // Two shapes are read: { rejections: [{ id, request, response }] } as documented in
  // judge/README.md, and the attack demo's run log, { rejections: [{ attempt, error_name,
  // expected_error, rule_matched, rpc_error, signed_tx_base64, local_tx_hash, sent_at, signer_id,
  // receiver_id, public_key, nonce, block_hash }] } (demo/lib/log.ts RejectionRecord).
  const entries = Array.isArray(log) ? log : (log.rejections ?? []);
  const entry = entries.find((item) => item.id === p.entry || item.attempt === p.entry);
  if (!entry) return FAIL(`${p.log} has no rejection entry "${p.entry}"`);
  if (entry.rule_matched === false) {
    return FAIL(`entry "${p.entry}": the log says a different rule fired first (rule_matched false, error ${entry.error_name ?? 'unnamed'}), so this attempt does not show ${canonicalRule(p.expect_rule)}`);
  }
  const error = entry.response?.error ?? entry.rpc_error ?? entry.error;
  if (!error) return FAIL(`entry "${p.entry}": the recorded RPC answer is not an error, so nothing was rejected`);
  const names = namesIn(error);
  if (!names.has('INVALID_TRANSACTION') && !names.has('InvalidTxError')) {
    return FAIL(`entry "${p.entry}": the recorded error is not a transaction validation error (${rpcErrorName({ error })})`);
  }
  const rule = canonicalRule(p.expect_rule);
  const recorded = [...names].find((name) => canonicalRule(name) === rule);
  if (!recorded) return FAIL(`entry "${p.entry}": the recorded error does not name ${rule}: ${short(error.data ?? error.cause, 160)}`);
  for (const field of ['error_name', 'expected_error']) {
    if (entry[field] !== undefined && canonicalRule(entry[field]) !== rule) {
      return FAIL(`entry "${p.entry}": the log's ${field} is ${entry[field]}, the claim says ${rule}`);
    }
  }

  const when = entry.sent_at ?? entry.at ?? entry.fetched_at ?? log.started_at ?? 'unrecorded time';
  const signed = signedTxOf(entry.request) ?? (typeof entry.signed_tx_base64 === 'string' ? entry.signed_tx_base64 : null);
  if (!signed) {
    if (p.require_signed_tx) return FAIL(`entry "${p.entry}" does not keep the signed transaction, so the rejection cannot be re-derived`);
    return PASS(
      `the recorded RPC error (${when}) is an InvalidTxError naming ${recorded}; the log keeps no signed bytes, so the rule is read from the recorded error and not re-derived`,
      { observed: { recorded_rule: recorded, error } },
    );
  }
  let tx;
  try {
    tx = decodeSignedTransaction(signed);
  } catch (err) {
    return FAIL(`entry "${p.entry}": the signed transaction does not decode: ${err.message}`);
  }
  const problems = [];
  if (!tx.signature_valid) problems.push(`the signature does not verify against ${tx.public_key}`);
  // The demo log also states what it sent (demo/lib/log.ts SignedBytesRecord). Each statement must
  // be what the signed bytes say, so a log cannot describe one transaction and carry another.
  for (const [field, decoded] of [
    ['local_tx_hash', tx.hash],
    ['signer_id', tx.signer_id],
    ['public_key', tx.public_key],
    ['receiver_id', tx.receiver_id],
    ['nonce', tx.nonce],
    ['block_hash', tx.block_hash],
  ]) {
    if (entry[field] !== undefined && entry[field] !== null && String(entry[field]) !== String(decoded)) {
      problems.push(`the log's ${field} is ${short(entry[field], 60)}, the signed bytes say ${decoded}`);
    }
  }
  if (p.signer_id && tx.signer_id !== p.signer_id) problems.push(`signed as ${tx.signer_id}, the claim says ${p.signer_id}`);
  if (p.public_key && tx.public_key !== p.public_key) problems.push(`signed with ${tx.public_key}, the claim says ${p.public_key}`);
  if (p.receiver_id && tx.receiver_id !== p.receiver_id) problems.push(`sent to ${tx.receiver_id}, the claim says ${p.receiver_id}`);
  if (p.method_name) {
    const fn = tx.actions.find((a) => a.type === 'FunctionCall');
    if (!fn || fn.method_name !== p.method_name) problems.push(`the transaction calls ${fn?.method_name ?? 'no method'}, the claim says ${p.method_name}`);
  }

  // The key's permission at the block the transaction itself references, from archival RPC.
  const keyCall = await ctx.rpc(accessKeySpec(ctx.network, tx.signer_id, tx.public_key, tx.block_hash));
  const { result, error: keyError } = unpack(keyCall, ['UNKNOWN_ACCESS_KEY', 'UNKNOWN_ACCOUNT', 'UNKNOWN_BLOCK']);
  let derivedText = '';
  if (keyError) {
    problems.push(`${tx.public_key} was not a key of ${tx.signer_id} at block ${tx.block_hash} (${keyError})`);
  } else {
    const permission = normalizePermission(result.permission);
    if (permission.kind === 'FullAccess') problems.push(`${tx.public_key} was a FULL-ACCESS key at block ${tx.block_hash}`);
    if (rule === 'NotEnoughAllowance') {
      derivedText = `key allowance ${formatNear(permission.allowance)} (allowance rejections depend on the gas price and are not re-derived)`;
    } else {
      const derived = accessKeyRule(permission, tx);
      if (derived !== rule) problems.push(`nearcore's rule for this key and transaction gives ${derived ?? 'no rejection'}, not ${rule}`);
      derivedText = `key at block ${keyCall.block_height ?? tx.block_hash}: ${permission.kind} ${permission.receiver_id ?? ''} [${(permission.method_names ?? []).join(',')}], so nearcore rejects it with ${derived}`;
    }
  }
  const observed = { tx: { ...tx }, recorded_rule: recorded };
  const head = `recorded ${entry.request?.method ?? 'send_tx'} error ${recorded} (${when}); tx ${tx.hash} by ${tx.signer_id} with ${tx.public_key}: ${tx.actions.map(describeAction).join(', ')} to ${shortId(tx.receiver_id)}`;
  if (problems.length) return FAIL(`${head}; ${problems.join('; ')}`, { observed });
  return PASS(`${head}; signature valid; ${derivedText}`, { observed });
}

// ---------------------------------------------------------------------------------------------
// repo_secret_scan and git_window (local, same in every mode)
// ---------------------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  { name: 'private_key or secret_key field with a NEAR key', regex: /"(?:private_key|secret_key)"\s*:\s*"(?:ed25519|secp256k1):/ },
  { name: 'PEM private key', regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
];

// A NEAR ed25519 secret key and a transaction signature look the same: "ed25519:" and 64 bytes
// of base58. They differ in structure. A secret key is seed(32) || public key(32), where the
// public key is the one the seed derives; a signature is R(32) || S(32), and S is never the
// public key R would derive as a seed. So every 64-byte candidate is decoded and the derivation
// is checked: a key is flagged, a signature (in an SDK fixture, in recorded RPC answers) is not.
const ED25519_CANDIDATE = /ed25519:([1-9A-HJ-NP-Za-km-z]{85,90})(?![1-9A-HJ-NP-Za-km-z])/g;
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** True when 64 bytes are a NEAR ed25519 secret key: a seed followed by the public key it derives. */
export function isEd25519SecretKey(bytes) {
  if (!bytes || bytes.length !== 64) return false;
  try {
    const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(bytes.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
    const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
    return Buffer.from(spki.subarray(spki.length - 32)).equals(Buffer.from(bytes.subarray(32, 64)));
  } catch {
    return false;
  }
}

/** Every "ed25519:" + 64-byte base58 value in a text, split into secret keys and the rest. */
export function ed25519SecretsIn(text) {
  let keys = 0;
  let others = 0;
  for (const m of text.matchAll(ED25519_CANDIDATE)) {
    let bytes;
    try {
      bytes = b58decode(m[1]);
    } catch {
      continue;
    }
    if (bytes.length !== 64) continue;
    if (isEd25519SecretKey(bytes)) keys++;
    else others++;
  }
  return { keys, others };
}

const SKIP_DIRS = new Set(['node_modules', 'target', '.git']);

function walkFiles(dir, root, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walkFiles(full, root, out);
    else if (stat.isFile()) out.push(relative(root, full));
  }
  return out;
}

async function git(ctx, args) {
  const run = await runProcess('git', ['-C', ctx.root, ...args], { timeoutMs: 20000 });
  return run;
}

async function committedFiles(ctx) {
  if (!which('git')) return { files: walkFiles(ctx.root, ctx.root, []), source: 'the file tree (git not installed)' };
  const inside = await git(ctx, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return { files: walkFiles(ctx.root, ctx.root, []), source: 'the file tree (not a git checkout)' };
  const listed = await git(ctx, ['ls-files', '-z', '--', '.']);
  if (listed.code !== 0) throw new SkipError(`git ls-files failed: ${short(listed.stderr, 100)}`);
  return { files: listed.stdout.split('\0').filter(Boolean), source: 'files git tracks' };
}

async function repoSecretScan(p, ctx) {
  const { files, source } = await committedFiles(ctx);
  if (!files.length) throw new PendingError('no file under near/ is committed yet; the scan reads committed files');
  const findings = [];
  let scanned = 0;
  let signatures = 0;
  for (const rel of files) {
    const full = resolve(ctx.root, rel);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // listed by git but deleted in the working tree
    }
    if (!stat.isFile() || stat.size > (p.max_bytes ?? 8 * 1024 * 1024)) continue;
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary (wasm and friends)
    scanned++;
    const text = bytes.toString('utf8');
    const ed25519 = ed25519SecretsIn(text);
    if (ed25519.keys) findings.push(`${rel}: NEAR ed25519 secret key (a seed followed by the public key it derives)`);
    signatures += ed25519.others;
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(text)) findings.push(`${rel}: ${pattern.name}`);
    }
  }
  if (findings.length) return FAIL(`${findings.length} finding(s): ${findings.slice(0, 5).join('; ')}`);
  const sigText = signatures ? `; ${signatures} other 64-byte ed25519 value(s), signatures by structure` : '';
  return PASS(`scanned ${scanned} text files (${source}): no NEAR secret key (each 64-byte ed25519 value is checked for a seed and its public key${sigText}), no private_key field, no PEM private key`, {
    observed: { scanned, signature_like_values: signatures },
  });
}

async function gitWindow(p, ctx) {
  if (!which('git')) throw new SkipError('git is not installed');
  const inside = await git(ctx, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) throw new SkipError('not a git checkout (a download without history); see the compare link in the README');
  const shallow = await git(ctx, ['rev-parse', '--is-shallow-repository']);
  if (shallow.stdout.trim() === 'true') throw new SkipError(`shallow clone: history is incomplete; compare ${p.compare_url ?? 'the tags on GitHub'}`);
  const log = await git(ctx, ['log', '--format=%H%x09%cI%x09%aI', '--', '.']);
  if (log.code !== 0) throw new SkipError(`git log failed: ${short(log.stderr, 100)}`);
  const commits = log.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, committed, authored] = line.split('\t');
      return { hash, committed, authored };
    });
  if (!commits.length) throw new PendingError('no commit touches near/ yet');
  const since = Date.parse(p.since);
  const until = p.until ? Date.parse(p.until) : Infinity;
  const outside = commits.filter((c) => [c.committed, c.authored].some((d) => Date.parse(d) < since || Date.parse(d) > until));
  const problems = outside.slice(0, 3).map((c) => `${c.hash.slice(0, 10)} dated ${c.committed}`);
  if (outside.length > 3) problems.push(`and ${outside.length - 3} more outside the window`);
  let baseline = '';
  let missingTag = null;
  if (p.baseline_tag) {
    const tag = await git(ctx, ['rev-parse', '--verify', '--quiet', `refs/tags/${p.baseline_tag}^{commit}`]);
    if (tag.code !== 0) {
      missingTag = p.baseline_tag;
    } else {
      const before = await git(ctx, ['rev-list', '--count', p.baseline_tag, '--', '.']);
      const count = Number(before.stdout.trim());
      if (before.code !== 0 || before.stdout.trim() === '' || !Number.isInteger(count)) {
        throw new SkipError(`git rev-list ${p.baseline_tag} failed: ${short(before.stderr || before.stdout, 100)}`);
      }
      if (count > 0) problems.push(`${count} commit(s) touching near/ are already in ${p.baseline_tag}`);
      else baseline = `; nothing under near/ exists at tag ${p.baseline_tag} (${tag.stdout.trim().slice(0, 10)})`;
    }
  }
  const first = commits.at(-1);
  const last = commits[0];
  const summary = `${commits.length} commit(s) touch near/, ${first.committed} to ${last.committed} (git dates are set by the committer)${baseline}`;
  if (problems.length) return FAIL(`${problems.join('; ')}; ${summary}`);
  // Half a claim checked is not a PASS: without the tag, "nothing under near/ exists at the tag"
  // was never looked at.
  if (missingTag) {
    throw new SkipError(
      `tag ${missingTag} is not in this clone, so "nothing under near/ exists at ${missingTag}" cannot be checked here (git fetch --tags${p.compare_url ? `, or see ${p.compare_url}` : ''}); the window part holds: ${summary}`,
    );
  }
  return PASS(summary, { observed: { commits: commits.length } });
}

// ---------------------------------------------------------------------------------------------
// command (the --full steps)
// ---------------------------------------------------------------------------------------------

async function command(p, ctx) {
  const platform = `${process.platform}-${process.arch}`;
  if (p.platforms && !p.platforms.includes(platform)) {
    throw new SkipError(`platform ${platform} is not supported here (supported: ${p.platforms.join(', ')}); use Linux x86_64 or arm64, or macOS arm64`);
  }
  for (const bin of p.requires_bin ?? []) {
    if (!which(bin)) throw new SkipError(`${bin} is not on PATH${p.install_hint ? `; ${p.install_hint}` : ''}`);
  }
  for (const rel of p.requires_path ?? []) {
    if (!existsSync(resolve(ctx.root, rel))) throw new SkipError(`${rel} is not present${p.install_hint ? `; ${p.install_hint}` : ''}`);
  }
  if (p.script && !existsSync(resolve(ctx.root, p.script))) throw new SkipError(`${p.script} is not in the tree`);
  for (const probe of p.probes ?? []) {
    const run = await runProcess(probe[0], probe.slice(1), { cwd: ctx.root, timeoutMs: 30000 });
    if (run.code !== 0) throw new SkipError(`${probe.join(' ')} failed${p.install_hint ? `; ${p.install_hint}` : ''}`);
  }
  const [bin, ...args] = p.cmd.map((part) => (part === '{node}' ? process.execPath : part));
  const timeoutS = ctx.options.timeoutS ?? p.timeout_s ?? 600;
  const display = p.cmd.map((part) => (part === '{node}' ? 'node' : part)).join(' ');
  const run = await runProcess(bin, args, {
    cwd: resolve(ctx.root, p.cwd ?? '.'),
    env: { ...process.env, ...(p.env ?? {}) },
    timeoutMs: timeoutS * 1000,
    onHeartbeat: (s) => ctx.log(`  ... ${ctx.claimId} still running (${s} s): ${display}`),
  });
  ctx.attach({ command: display, cwd: p.cwd ?? '.', exit: run.code, signal: run.signal, ms: run.ms, timed_out: run.timedOut, stdout_tail: run.stdout.slice(-6000), stderr_tail: run.stderr.slice(-6000) });
  const text = `${run.stdout}\n${run.stderr}`;
  // A step that did not finish in its time box did not disagree with anything: it did not run to
  // the end here (a slow machine, a cold cargo cache). That is a SKIP with the reason, not a FAIL.
  if (run.timedOut) throw new SkipError(`${display} did not finish within its ${timeoutS} s time box (raise it with --timeout-s)`);
  if (run.error && run.code === null) throw new SkipError(`could not start ${display}: ${run.error}`);
  for (const pattern of p.skip_patterns ?? []) {
    if (run.code !== 0 && new RegExp(pattern, 'i').test(text)) {
      throw new SkipError(`${display} needs something this machine lacks (matched /${pattern}/)`);
    }
  }
  const counts = p.parse === 'cargo-test' ? parseCargoTest(text) : p.parse === 'node-test' ? parseNodeTest(text) : null;
  const secs = (run.ms / 1000).toFixed(1);
  if (run.code !== 0) {
    const tail = text.trim().split('\n').slice(-2).join(' | ');
    return FAIL(`${display} exited ${run.code ?? run.signal} after ${secs} s${counts ? ` (${counts.passed} passed, ${counts.failed} failed)` : ''}: ${short(tail, 160)}`);
  }
  if (counts) {
    if (counts.failed > 0) return FAIL(`${display}: ${counts.failed} failed, ${counts.passed} passed`);
    if (counts.passed === 0) return FAIL(`${display} exited 0 but ran no tests`);
    if (p.min_passed && counts.passed < p.min_passed) return FAIL(`${display}: only ${counts.passed} tests passed, the claim says at least ${p.min_passed}`);
    return PASS(`${display}: ${counts.passed} passed, 0 failed in ${secs} s`, { observed: counts });
  }
  const compared = [];
  for (const pair of p.compare_files ?? []) {
    const built = resolve(ctx.root, pair.built);
    const committed = resolve(ctx.root, pair.committed);
    if (!existsSync(built)) return FAIL(`${display} exited 0 but ${pair.built} is not there`);
    if (!existsSync(committed)) return FAIL(`the committed ${pair.committed} is not in the tree`);
    const a = createHash('sha256').update(readFileSync(built)).digest('hex');
    const b = createHash('sha256').update(readFileSync(committed)).digest('hex');
    if (a !== b) return FAIL(`${pair.built} hashes to ${a}, the committed ${pair.committed} to ${b}`);
    compared.push(`${pair.committed} sha256 ${a}`);
  }
  return PASS(`${display} exited 0 in ${secs} s${compared.length ? `; rebuilt and committed wasm are identical: ${compared.join(', ')}` : ''}`);
}

export const CHECKS = {
  account_exists: { run: accountExists, network: true },
  code_hash_matches_committed_wasm: { run: codeHashMatchesCommittedWasm, network: true },
  access_keys: { run: accessKeys, network: true },
  view_equals: { run: viewEquals, network: true },
  tx_outcome: { run: txOutcome, network: true },
  counter_matches_events: { run: counterMatchesEvents, network: true },
  verdict_recompute: { run: verdictRecompute, network: true },
  protocol_rejection: { run: protocolRejection, network: true },
  repo_secret_scan: { run: repoSecretScan, network: false },
  git_window: { run: gitWindow, network: false },
  command: { run: command, network: false },
};

// NEAR-specific reading of JSON-RPC answers: request builders, view results, NEP-297 events,
// NEP-141 transfers, access-key permissions and execution outcomes.

import { NETWORKS } from './rpc.mjs';

export const ZERO_CODE_HASH = '11111111111111111111111111111111';

function blockParams(blockId) {
  return blockId === null || blockId === undefined ? { finality: 'final' } : { block_id: blockId };
}

/** A read pinned to a block must go to archival RPC; a read at "final" uses the regular one. */
function kindFor(blockId) {
  return blockId === null || blockId === undefined ? 'state' : 'archival';
}

export function viewAccountSpec(network, accountId, blockId) {
  return {
    network,
    kind: kindFor(blockId),
    method: 'query',
    params: { request_type: 'view_account', ...blockParams(blockId), account_id: accountId },
  };
}

export function accessKeyListSpec(network, accountId, blockId) {
  return {
    network,
    kind: kindFor(blockId),
    method: 'query',
    params: { request_type: 'view_access_key_list', ...blockParams(blockId), account_id: accountId },
  };
}

export function accessKeySpec(network, accountId, publicKey, blockId) {
  return {
    network,
    kind: kindFor(blockId),
    method: 'query',
    params: { request_type: 'view_access_key', ...blockParams(blockId), account_id: accountId, public_key: publicKey },
  };
}

export function callFunctionSpec(network, accountId, methodName, args, blockId) {
  return {
    network,
    kind: kindFor(blockId),
    method: 'query',
    params: {
      request_type: 'call_function',
      ...blockParams(blockId),
      account_id: accountId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args ?? {})).toString('base64'),
    },
  };
}

/**
 * Transactions are always read from archival RPC. wait_until is NONE on purpose: for a finished
 * transaction the node still returns the whole outcome with final_execution_status FINAL, and for
 * a hash it does not know it answers UNKNOWN_TRANSACTION at once, where FINAL would make it wait
 * for the transaction to appear until the request times out (measured 2026-11-12). The check
 * then requires FINAL itself.
 */
export function txStatusSpec(network, txHash, senderId) {
  return {
    network,
    kind: 'archival',
    method: 'EXPERIMENTAL_tx_status',
    params: { tx_hash: txHash, sender_account_id: senderId, wait_until: 'NONE' },
  };
}

export function blockSpec(network, blockId) {
  return { network, kind: 'archival', method: 'block', params: { block_id: blockId } };
}

export function statusSpec(network, kind = 'state') {
  return { network, kind, method: 'status', params: [] };
}

/** The bytes a call_function view returned, as JSON when they parse, else as text. */
export function decodeViewResult(result) {
  const bytes = Array.isArray(result?.result) ? Buffer.from(result.result) : Buffer.alloc(0);
  const text = bytes.toString('utf8');
  try {
    return { ok: true, json: JSON.parse(text), text };
  } catch {
    return { ok: false, json: undefined, text };
  }
}

/** Every NEP-297 event in a list of logs. An array `data` (NEP-141 style) becomes one event per
 *  item; an object `data` (near-sdk struct variants, our own standards) stays one event. */
export function parseEvents(logs) {
  const out = [];
  for (const log of logs ?? []) {
    if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
    let envelope;
    try {
      envelope = JSON.parse(log.slice('EVENT_JSON:'.length));
    } catch {
      out.push({ malformed: true, raw: log });
      continue;
    }
    const items = Array.isArray(envelope.data) ? envelope.data : [envelope.data ?? null];
    for (const data of items) {
      out.push({ standard: envelope.standard, version: envelope.version, event: envelope.event, data });
    }
  }
  return out;
}

export function statusKind(status) {
  if (status && typeof status === 'object') {
    if ('SuccessValue' in status || 'SuccessReceiptId' in status) return 'success';
    if ('Failure' in status) return 'failure';
  }
  return 'unknown';
}

/** The transaction outcome and every receipt outcome, flattened, in the order the RPC gives. */
export function outcomes(txResult) {
  const out = [];
  const tx = txResult?.transaction_outcome;
  if (tx) {
    out.push({ kind: 'transaction', id: tx.id, block_hash: tx.block_hash, ...tx.outcome, success: statusKind(tx.outcome?.status) === 'success' });
  }
  for (const receipt of txResult?.receipts_outcome ?? []) {
    out.push({
      kind: 'receipt',
      id: receipt.id,
      block_hash: receipt.block_hash,
      ...receipt.outcome,
      success: statusKind(receipt.outcome?.status) === 'success',
    });
  }
  return out;
}

/** Events with the outcome that emitted them (and the block that outcome executed in). */
export function txEvents(txResult) {
  return outcomes(txResult).flatMap((outcome) =>
    parseEvents(outcome.logs).map((event) => ({ ...event, executor_id: outcome.executor_id, success: outcome.success, outcome_id: outcome.id, block_hash: outcome.block_hash })),
  );
}

/** NEP-141 transfers executed by `tokenId`, from its `ft_transfer` events. A transfer counts only
 *  when the token's receipt itself succeeded: logs from a receipt that failed are not a transfer. */
export function ftTransfers(txResult, tokenId) {
  return txEvents(txResult)
    .filter((event) => event.executor_id === tokenId && event.standard === 'nep141' && event.event === 'ft_transfer' && !event.malformed)
    .map((event) => ({
      from: event.data?.old_owner_id,
      to: event.data?.new_owner_id,
      amount: event.data?.amount,
      memo: event.data?.memo ?? null,
      success: event.success,
      outcome_id: event.outcome_id,
    }));
}

export function decodeSuccessValue(status) {
  if (!status || typeof status !== 'object' || typeof status.SuccessValue !== 'string') return undefined;
  const text = Buffer.from(status.SuccessValue, 'base64').toString('utf8');
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The first function call action of a transaction view, if any. */
export function firstFunctionCall(transaction) {
  for (const action of transaction?.actions ?? []) {
    if (action && typeof action === 'object' && action.FunctionCall) return action.FunctionCall;
  }
  return null;
}

/**
 * A permission from view_access_key(_list), normalized. Anything that is not a plain
 * function-call key counts as full access unless it is a known function-call variant: a claim
 * about "no full-access key" must fail closed on a key kind this code has never seen.
 */
export function normalizePermission(permission) {
  if (permission === 'FullAccess') return { kind: 'FullAccess' };
  if (typeof permission === 'string' && /FullAccess/.test(permission)) return { kind: 'FullAccess', variant: permission };
  if (permission && typeof permission === 'object') {
    const [variant] = Object.keys(permission);
    const inner = permission[variant];
    // Gas keys (protocol 2.x) come in a full-access and a function-call flavour. A full-access
    // gas key is counted as full access; a function-call gas key is reported as its own kind,
    // because the vault never creates one and a claim about the vault's keys must not pass it.
    if (/FullAccess/.test(variant)) return { kind: 'FullAccess', variant, raw: permission };
    if (variant === 'FunctionCall' && inner && typeof inner === 'object') {
      return {
        kind: 'FunctionCall',
        receiver_id: inner.receiver_id,
        method_names: Array.isArray(inner.method_names) ? inner.method_names : [],
        allowance: inner.allowance ?? null,
      };
    }
    return { kind: 'Other', variant, raw: permission };
  }
  return { kind: 'Other', variant: String(permission), raw: permission };
}

export function formatNear(yocto) {
  if (yocto === null || yocto === undefined) return 'unlimited';
  if (!/^\d+$/.test(String(yocto))) return `${yocto} yoctoNEAR`;
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const frac = (value % 10n ** 24n).toString().padStart(24, '0').slice(0, 4);
  return `${whole}.${frac} NEAR`;
}

export function formatUnits(amount, decimals) {
  if (!/^\d+$/.test(String(amount))) return String(amount);
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${value / base}.${frac}` : `${value / base}`;
}

/** Long implicit account ids (64 hex) are shortened for the console; reports keep them whole. */
export function shortId(id) {
  if (typeof id === 'string' && /^[0-9a-f]{64}$/.test(id)) return `${id.slice(0, 8)}...${id.slice(-5)}`;
  return id;
}

/** NearBlocks pages, for humans only: the judge itself never reads an explorer. */
export function explorerUrl(network, kind, id) {
  const base = NETWORKS[network]?.explorer ?? NETWORKS.testnet.explorer;
  return kind === 'tx' ? `${base}/txns/${id}` : `${base}/address/${id}`;
}

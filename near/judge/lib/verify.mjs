// --verify-evidence: is the committed evidence what the chain actually said?
//
// Every recorded call is asked again on archival RPC, pinned to the block it was answered at, and
// the semantically relevant part of the two answers is compared. Views at a fixed block and
// finished transactions are immutable, so a faithful evidence file matches exactly; an edited one
// does not. Fields a node is free to vary (proof paths, gas profiles, how a provider words an
// error message) are left out of the comparison and nothing else is.

import { relative } from 'node:path';
import { evidencePathFor } from './engine.mjs';
import { loadEvidence, redactSignatures } from './evidence.mjs';
import { canonical } from './json.mjs';
import { NetworkError, pinnedSpec, rpcErrorName } from './rpc.mjs';

function project(method, response) {
  if (response?.error) return { error: rpcErrorName(response) };
  const result = response?.result;
  if (method === 'EXPERIMENTAL_tx_status') {
    const tx = result?.transaction ?? {};
    return {
      final_execution_status: result?.final_execution_status,
      status: result?.status,
      transaction: { hash: tx.hash, signer_id: tx.signer_id, public_key: tx.public_key, receiver_id: tx.receiver_id, nonce: tx.nonce, actions: tx.actions, signature: tx.signature },
      transaction_outcome: { id: result?.transaction_outcome?.id, block_hash: result?.transaction_outcome?.block_hash },
      receipts_outcome: (result?.receipts_outcome ?? []).map((r) => ({
        id: r.id,
        block_hash: r.block_hash,
        executor_id: r.outcome?.executor_id,
        status: r.outcome?.status,
        logs: r.outcome?.logs,
      })),
    };
  }
  if (method === 'block') return { height: result?.header?.height, hash: result?.header?.hash, timestamp_nanosec: result?.header?.timestamp_nanosec };
  return result;
}

function firstDifference(a, b, path = '$') {
  if (canonical(a) === canonical(b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const found = firstDifference(a[key], b[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  const show = (v) => {
    const text = canonical(v);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };
  return `${path}: recorded ${show(a)}, archival ${show(b)}`;
}

export async function verifyEvidence(claim, env, transport) {
  const started = performance.now();
  const path = evidencePathFor(env.root, claim, env.evidenceDir);
  const rel = relative(env.root, path);
  const out = (status, detail) => ({ id: claim.id, claim: claim.claim, check: claim.check, network: claim.network ?? 'testnet', status, detail, evidence_file: rel, calls: [], ms: Math.round(performance.now() - started) });
  let evidence;
  try {
    evidence = loadEvidence(path);
  } catch (err) {
    return out('FAIL', `unreadable evidence: ${err.message}`);
  }
  if (!evidence) return out('SKIP', `no recorded evidence (${rel})`);
  let checked = 0;
  let unpinned = 0;
  for (const [i, call] of evidence.calls.entries()) {
    const spec = pinnedSpec(call);
    if (!spec) {
      unpinned++;
      continue;
    }
    let live;
    try {
      live = await transport.call(spec);
    } catch (err) {
      if (err instanceof NetworkError) return out('SKIP', `network: ${err.message}`);
      throw err;
    }
    const recorded = project(call.request.method, call.response);
    const fresh = project(call.request.method, redactSignatures(live.response));
    const diff = firstDifference(recorded, fresh);
    if (diff) return out('FAIL', `${rel} call ${i + 1} (${call.request.method}) differs from archival RPC at block ${call.block_hash ?? spec.params.block_id ?? '?'}: ${diff}`);
    checked++;
  }
  if (!checked) return out('SKIP', `${rel} has no call that can be pinned to a block`);
  return out('PASS', `${checked} recorded call(s) in ${rel} match archival RPC at their recorded blocks${unpinned ? ` (${unpinned} unpinnable call(s) not compared)` : ''}; captured ${evidence.captured_at}`);
}

// Shared by the judge's tests: recorded fixtures, an in-memory transport over them, a ctx for
// calling a check directly, and builders for SYNTHETIC vault transactions (labelled as such:
// nothing is deployed yet, so these follow the event ABI in contracts/agent-spend-policy/src/event.rs
// and the shape of the real EXPERIMENTAL_tx_status answers in fixtures/testnet-recorded.json).

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encode as b58encode } from '../lib/base58.mjs';
import { EvidenceStaleError, requestKey } from '../lib/evidence.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const NEAR_ROOT = join(HERE, '..', '..');
export const JUDGE = join(HERE, '..', 'judge.mjs');

export function fixture(name) {
  return JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf8'));
}

export const recorded = fixture('testnet-recorded.json');

/** The recorded call whose request matches, or throws. */
export function recordedCall(predicate) {
  const call = recorded.calls.find(predicate);
  if (!call) throw new Error('fixture call not found');
  return structuredClone(call);
}

/** A transport answering from a list of calls, exactly like ReplayTransport does. */
export function memoryTransport(calls) {
  return {
    async call(spec) {
      const key = requestKey(spec.network, spec.method, spec.params);
      const hit = calls.find((c) => requestKey(c.network, c.request.method, c.request.params) === key);
      if (!hit) throw new EvidenceStaleError(`no fixture for ${spec.method} ${JSON.stringify(spec.params)}`);
      return structuredClone(hit);
    },
  };
}

export function makeCtx(calls = [], extra = {}) {
  const transport = memoryTransport(calls);
  const attached = [];
  return {
    root: extra.root ?? NEAR_ROOT,
    network: extra.network ?? 'testnet',
    mode: 'offline',
    claimId: 'test-claim',
    deployments: {},
    options: extra.options ?? {},
    log: () => {},
    attach: (item) => attached.push(item),
    attached,
    rpc: (spec) => transport.call(spec),
  };
}

/** A recorded call for an arbitrary request/answer pair (synthetic answers). */
export function call(spec, response, block = {}) {
  return {
    network: spec.network,
    kind: spec.kind,
    rpc_url: 'https://fixture.invalid',
    request: { jsonrpc: '2.0', id: 'judge', method: spec.method, params: spec.params },
    response: { jsonrpc: '2.0', id: 'judge', ...response },
    fetched_at: '2026-11-12T00:00:00.000Z',
    ms: 1,
    block_height: block.block_height ?? response.result?.block_height ?? null,
    block_hash: block.block_hash ?? response.result?.block_hash ?? null,
  };
}

// Every temporary tree a test makes is removed when the test process exits.
const made = [];
process.on('exit', () => {
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

export function tempDir(prefix = 'judge-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const hashOf = (text) => b58encode(createHash('sha256').update(text).digest());
const event = (standard, name, data) => `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event: name, data })}`;

export const IDS = {
  vault: 'vault.aid-demo-owner.testnet',
  owner: 'aid-demo-owner.testnet',
  registry: 'registry.a-identity.testnet',
  oracle: 'oracle.a-identity.testnet',
  merchant: 'aid-demo-merchant.testnet',
  attacker: 'aid-demo-attacker.testnet',
  usdc: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af',
  agentKey: 'ed25519:2KPT8iffxLvWsnknUUWRqcaM4Vhz1Fa4pPMKVTLizKkf',
};

/**
 * SYNTHETIC: a vault `pay` as EXPERIMENTAL_tx_status would return it.
 * outcome: 'sent' | 'refused' | 'held'.
 */
export function syntheticPay({ payee, amount = '1000000', outcome, reason, verdict, extraReceipts = [], signer = IDS.vault, publicKey = IDS.agentKey, method = 'pay', salt = '' }) {
  const id = (n) => hashOf(salt ? `${payee}-${outcome}-${salt}-${n}` : `${payee}-${outcome}-${n}`);
  const tx = id('tx');
  const block = id('block');
  const ret = { status: outcome, payment_id: '7', reason: reason ?? null, held_id: outcome === 'held' ? '3' : null };
  const receipts = [
    { id: id('pay'), executor_id: IDS.vault, logs: [], status: { SuccessReceiptId: id('verdict') } },
    { id: id('verdict'), executor_id: IDS.registry, logs: [], status: { SuccessValue: b64(verdict === null ? 'null' : { account_id: payee, verdict, reasons: ['lookalike'] }) } },
  ];
  if (outcome === 'sent') {
    receipts.push(
      { id: id('cb'), executor_id: IDS.vault, logs: [], status: { SuccessReceiptId: id('storage') } },
      { id: id('storage'), executor_id: IDS.usdc, logs: [], status: { SuccessValue: b64({ total: '1250000000000000000000', available: '0' }) } },
      { id: id('ft'), executor_id: IDS.usdc, logs: [event('nep141', 'ft_transfer', [{ old_owner_id: IDS.vault, new_owner_id: payee, amount }])], status: { SuccessValue: '' } },
      {
        id: id('done'),
        executor_id: IDS.vault,
        logs: [event('a_identity_vault', 'payment_sent', { payment_id: '7', payee, amount, day: '20404', by_owner: signer !== IDS.vault, memo: null })],
        status: { SuccessValue: b64(ret) },
      },
    );
  } else if (outcome === 'refused') {
    receipts.push({
      id: id('cb'),
      executor_id: IDS.vault,
      logs: [event('a_identity_vault', 'payment_refused', { payment_id: '7', payee, amount, reason, source: 'registry', registry_reasons: ['drainer_pattern'] })],
      status: { SuccessValue: b64(ret) },
    });
  } else {
    receipts.push({
      id: id('cb'),
      executor_id: IDS.vault,
      logs: [event('a_identity_vault', 'payment_held', { payment_id: '7', held_id: '3', payee, amount, reason })],
      status: { SuccessValue: b64(ret) },
    });
  }
  receipts.push(...extraReceipts);
  const result = {
    final_execution_status: 'FINAL',
    status: { SuccessValue: b64(ret) },
    transaction: {
      signer_id: signer,
      public_key: publicKey,
      receiver_id: IDS.vault,
      nonce: 277000000000001,
      priority_fee: 0,
      hash: tx,
      signature: 'ed25519-signature-sha256:00',
      actions: [{ FunctionCall: { method_name: method, args: b64({ payee, amount }), gas: 80000000000000, deposit: signer === IDS.vault ? '0' : '1' } }],
    },
    transaction_outcome: { id: tx, block_hash: block, outcome: { executor_id: signer, logs: [], receipt_ids: [id('pay')], status: { SuccessReceiptId: id('pay') } } },
    receipts_outcome: receipts.map((r) => ({ id: r.id, block_hash: block, outcome: { executor_id: r.executor_id, logs: r.logs, receipt_ids: [], status: r.status } })),
  };
  return { tx_hash: tx, block_hash: block, result };
}

/** The two calls a tx_outcome check makes for a synthetic transaction. */
export function syntheticTxCalls({ tx_hash, block_hash, result }, sender = IDS.vault, height = 277400000) {
  return [
    call({ network: 'testnet', kind: 'archival', method: 'EXPERIMENTAL_tx_status', params: { tx_hash, sender_account_id: sender, wait_until: 'NONE' } }, { result }, { block_hash }),
    call(
      { network: 'testnet', kind: 'archival', method: 'block', params: { block_id: block_hash } },
      { result: { header: { height, hash: block_hash, timestamp: 1794500000000000000, timestamp_nanosec: '1794500000000000000' }, chunks: [] } },
    ),
  ];
}

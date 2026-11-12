import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GuardResult as SdkGuardResult } from '../../sdk/src/guard.ts';
import { bindEngine, fromSdkGuardResult } from '../lib/sdk.ts';
import { ACC, decision, reason } from './helpers.ts';

const links = { explorer: 'https://testnet.nearblocks.io/txns/TxA', archival_curl: 'curl ...' };

function sdkResult(o: Partial<SdkGuardResult> & Pick<SdkGuardResult, 'route' | 'status'>): SdkGuardResult {
  const d = decision(ACC.merchant, 'ALLOW', [reason('prior_payments', 'positive')]);
  return {
    verdict: { verdict: d.verdict, source: 'local', decision: d, reasons: ['prior_payments'], snapshot_sha256: 'ef'.repeat(32), unavailable: null },
    onchain: null,
    contract_overrode: false,
    settled: false,
    settlement: null,
    tx_hash: null,
    links: null,
    prepared: null,
    error: null,
    summary: 'summary',
    ...o,
  };
}

describe("the SDK guard's answer in the demo's terms", () => {
  test('executed pay, sent and settled', () => {
    const g = fromSdkGuardResult(
      sdkResult({ route: 'pay', status: 'executed', onchain: { status: 'sent', payment_id: '3', reason: null, held_id: null }, settled: true, tx_hash: 'TxA', links }),
      ACC.vault,
    );
    assert.equal(g.verdict, 'ALLOW');
    assert.equal(g.action, 'pay');
    assert.equal(g.status, 'executed');
    assert.equal(g.txHash, 'TxA');
    assert.equal(g.signerId, ACC.vault);
    assert.deepEqual(g.payOutcome, { status: 'sent', payment_id: '3', reason: null, held_id: null });
    assert.equal(g.settled, true);
    assert.equal(g.snapshotSha256, 'ef'.repeat(32));
    assert.equal(g.block?.height, 277300000);
    assert.deepEqual(g.reasons, [{ code: 'prior_payments', severity: 'positive', detail: 'prior_payments observed' }]);
  });

  test('pending is a transaction that exists: executed, to be waited for', () => {
    const g = fromSdkGuardResult(sdkResult({ route: 'pay', status: 'pending', tx_hash: 'TxB', links, error: 'not final yet' }), ACC.vault);
    assert.equal(g.status, 'executed');
    assert.equal(g.txHash, 'TxB');
  });

  test('prepared keeps the exact call and no tx hash', () => {
    const prepared = { status: 'prepared' as const, signer_id: ACC.vault, receiver_id: ACC.vault, actions: [], note: 'no signing key loaded' };
    const g = fromSdkGuardResult(sdkResult({ route: 'record_refusal', status: 'prepared', prepared }), ACC.vault);
    assert.equal(g.status, 'prepared');
    assert.equal(g.txHash, null);
    assert.equal(g.signerId, null);
    assert.deepEqual(g.prepared, prepared);
    assert.equal(g.settled, null, 'settlement only means something for an executed pay');
  });

  test('an uncomputable verdict is WARN, and the reason is kept', () => {
    const r = sdkResult({ route: 'request_payment', status: 'executed', tx_hash: 'TxC', links, onchain: { status: 'held', payment_id: '4', reason: 'a-identity guard WARN: verdict_unavailable', held_id: '2' } });
    r.verdict = { verdict: 'WARN', source: 'local', decision: null, reasons: [], snapshot_sha256: null, unavailable: 'verdict could not be computed: rpc down' };
    const g = fromSdkGuardResult(r, ACC.vault);
    assert.equal(g.verdict, 'WARN');
    assert.equal(g.unavailable, 'verdict could not be computed: rpc down');
    assert.equal(g.score, null);
    assert.equal(g.payOutcome?.held_id, '2');
  });

  test('the engine binding is the SDK engine', () => {
    const b = bindEngine('testnet', {});
    assert.equal(b.ok, true);
    assert.match(b.ok ? b.port.version : '', /^a-identity-near-engine\//);
  });
});

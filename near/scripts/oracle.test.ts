import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { noKeySender } from '../demo/lib/chain.ts';
import { displayPath, NEAR_ROOT } from '../demo/lib/paths.ts';
import type { HeldView } from '../demo/lib/views.ts';
import { ACC, decision, demoDecisions, FakeChain, fakeEngine, NET, reason, snapshot } from '../demo/test/helpers.ts';
import { DEFAULT_TTL_S, expiresAbout, FLOOR_REASON, lookalikeHit, observedCodeHash, oracleWritePolicy, registryCodes, runOracleOnce, setVerdictArgs, watch } from './oracle.ts';
import type { OracleConfig, OracleDeps, OracleRecord } from './oracle.ts';

const NOW = new Date('2026-11-13T12:00:00Z');
const KNOWN = [ACC.merchant];

function cfg(o: Partial<OracleConfig> = {}): OracleConfig {
  return { vault: ACC.vault, registry: ACC.registry, oracle: ACC.oracle, known: KNOWN, writeSoftWarn: false, ttl: { ...DEFAULT_TTL_S }, dryRun: false, ...o };
}

function held(id: string, payee: string, expires = '9999999999'): HeldView {
  return { id, payment_id: id, agent_pk: 'ed25519:FAKE-agent-function-call-key', payee, amount: '500000', memo: null, reason: 'UnknownPayee', created_at_s: '1794500000', expires_at_s: expires };
}

function deps(chain: FakeChain, o: { key?: boolean; engine?: ReturnType<typeof fakeEngine> } = {}): { d: OracleDeps; lines: string[]; records: OracleRecord[]; snapshots: string[] } {
  const lines: string[] = [];
  const records: OracleRecord[] = [];
  const snapshots: string[] = [];
  return {
    lines,
    records,
    snapshots,
    d: {
      views: chain.views(),
      engine: o.engine ?? fakeEngine(),
      sender: o.key === false ? noKeySender('no oracle key: test') : chain.sender(ACC.oracle),
      net: NET,
      log: (s) => lines.push(s),
      now: () => NOW,
      saveSnapshot: (sha) => (snapshots.push(sha), `/logs/snapshots/${sha}.json`),
      saveRecord: (r) => records.push(r),
    },
  };
}

describe('what the oracle writes', () => {
  test('engine DENY -> DENY with the deny codes', () => {
    const d = demoDecisions()[ACC.lookalike];
    assert.ok(d);
    const p = oracleWritePolicy(d, ACC.lookalike, KNOWN, false);
    assert.deepEqual([p.write, p.verdict, p.reasons], [true, 'DENY', ['lookalike_new_account']]);
  });

  test('a soft WARN is not written: the vault already holds unknown payees', () => {
    const d = demoDecisions()[ACC.newVendor];
    assert.ok(d);
    const p = oracleWritePolicy(d, ACC.newVendor, KNOWN, false);
    assert.equal(p.write, false);
    assert.match(p.why, /soft WARN/);
    assert.equal(oracleWritePolicy(d, ACC.newVendor, KNOWN, true).verdict, 'WARN', '--write-soft-warn writes it');
  });

  test('a hard WARN is written with its uncleared warn codes', () => {
    const d = decision('x.testnet', 'WARN', [reason('code_changed_recently', 'warn'), reason('new_account', 'warn', 'n', 'prior_payments'), reason('prior_payments', 'positive')], { warn_kind: 'hard' });
    const p = oracleWritePolicy(d, 'x.testnet', KNOWN, false);
    assert.deepEqual([p.verdict, p.reasons], ['WARN', ['code_changed_recently']]);
  });

  test('ALLOW is written with the positive codes', () => {
    const d = demoDecisions()[ACC.merchant];
    assert.ok(d);
    const p = oracleWritePolicy(d, ACC.merchant, KNOWN, false);
    assert.deepEqual([p.verdict, p.reasons], ['ALLOW', ['prior_payments']]);
  });

  test('NEVER ALLOW for a lookalike: by the engine reasons ...', () => {
    const d = decision(ACC.lookalike, 'ALLOW', [reason('lookalike_known', 'warn', 'one edit from the merchant', 'long_history'), reason('long_history', 'positive')]);
    const p = oracleWritePolicy(d, ACC.lookalike, KNOWN, false);
    assert.equal(p.verdict, 'WARN');
    assert.ok(p.reasons.includes(FLOOR_REASON));
    assert.equal(p.scoreFromEngine, false);
  });

  test('... and by the engine lookalike function, even when the reasons miss it', () => {
    const d = decision(ACC.lookalike, 'ALLOW', [reason('long_history', 'positive')]);
    assert.equal(lookalikeHit(d, ACC.lookalike, KNOWN).hit, true);
    const p = oracleWritePolicy(d, ACC.lookalike, KNOWN, false);
    assert.equal(p.verdict, 'WARN');
    assert.deepEqual(p.reasons, ['lookalike_known', FLOOR_REASON]);
    assert.equal(lookalikeHit(d, ACC.newVendor, KNOWN).hit, false, 'a different name is not a lookalike');
    assert.equal(lookalikeHit(d, ACC.merchant, KNOWN).hit, false, 'the known payee itself is not its own lookalike');
  });

  test('registry codes: [a-z0-9_], at most 32 bytes, at most 8, deduplicated', () => {
    const codes = registryCodes(['Lookalike-New', 'lookalike_new', 'x'.repeat(40), 'a', 'b', 'c', 'd', 'e', 'f', 'g']);
    assert.equal(codes[0], 'lookalike_new');
    assert.equal(codes[1], 'x'.repeat(32));
    assert.equal(codes.length, 8);
    for (const c of codes) assert.match(c, /^[a-z0-9_]{1,32}$/);
  });

  test('set_verdict args: evidence = snapshot sha256, block and engine (SDK format), ttl, observed code hash', () => {
    const d = demoDecisions()[ACC.lookalike];
    assert.ok(d);
    const evidence = `near-snapshot sha256:${'ab'.repeat(32)} block:277300000 engine:1.0.0`;
    const j = { decision: d, snapshot: snapshot(ACC.lookalike, 'CodeHash111'), snapshotSha256: 'ab'.repeat(32), evidence };
    const args = setVerdictArgs(ACC.lookalike, oracleWritePolicy(d, ACC.lookalike, KNOWN, false), j, DEFAULT_TTL_S);
    assert.deepEqual(args, {
      account_id: ACC.lookalike,
      verdict: 'DENY',
      reasons: ['lookalike_new_account'],
      evidence,
      score: d.score,
      code_hash: 'CodeHash111',
      ttl_s: String(7 * 86400),
    });
    assert.ok(String(args.evidence).length <= 256);
    assert.equal(observedCodeHash({ ...j, snapshot: { ...j.snapshot, rpc: [] } }), null);
  });
});

describe('one pass over the held payments', () => {
  test('judges the unjudged held payee, writes DENY with the oracle key, confirms the event', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const h = held('1', ACC.lookalike);
    chain.held.set(h.id, h);
    const { d, records, snapshots, lines } = deps(chain);
    const recs = await runOracleOnce(d, cfg());
    assert.equal(recs.length, 1);
    assert.equal(recs[0]?.action, 'written');
    assert.equal(recs[0]?.set_verdict?.verdict, 'DENY');
    assert.match(String(recs[0]?.set_verdict?.evidence), /^near-snapshot sha256:[0-9a-f]{64} block:277300000 engine:/);
    assert.match(recs[0]?.recompute ?? '', /^npm run verdict -- --offline \/logs\/snapshots\/[0-9a-f]{64}\.json$/);
    assert.equal(chain.verdicts.get(ACC.lookalike)?.verdict, 'DENY');
    assert.equal(snapshots.length, 1);
    assert.deepEqual(records, recs);
    assert.ok(lines.some((l) => /snapshot sha256 [0-9a-f]{64} at block 277300000/.test(l)), 'every decision is logged with its snapshot hash');
    assert.ok(recs[0]?.archival_curl?.includes('archival-rpc.testnet.fastnear.com'));
    // When it lapses, in the record and in the log.
    assert.equal(recs[0]?.expires_about, '2026-11-20T12:00:00Z');
    assert.ok(lines.some((l) => /wrote DENY \[lookalike_new_account\], ttl 604800 s, expires about 2026-11-20T12:00:00Z/.test(l)));
  });

  test('a TTL of 0 writes no expiry, and says so', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.held.set('1', held('1', ACC.lookalike));
    const { d, lines } = deps(chain);
    const recs = await runOracleOnce(d, cfg({ ttl: { ...DEFAULT_TTL_S, DENY: 0 } }));
    assert.equal(recs[0]?.set_verdict?.ttl_s, null);
    assert.equal(recs[0]?.expires_about, null);
    assert.ok(lines.some((l) => /wrote DENY \[lookalike_new_account\], no expiry/.test(l)));
    assert.equal(expiresAbout(NOW, '0'), null);
    assert.equal(expiresAbout(NOW, '86400'), '2026-11-14T12:00:00Z');
  });

  test('the snapshot path in a record is the one saveSnapshot returns: the CLI saves it relative to near/', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.held.set('1', held('1', ACC.lookalike));
    const { d } = deps(chain);
    const recs = await runOracleOnce({ ...d, saveSnapshot: (sha) => displayPath(join(NEAR_ROOT, 'demo', 'logs', 'oracle', 'snapshots', `${sha}.json`)) }, cfg());
    assert.match(recs[0]?.snapshot_file ?? '', /^demo\/logs\/oracle\/snapshots\/[0-9a-f]{64}\.json$/);
    assert.match(recs[0]?.recompute ?? '', /^npm run verdict -- --offline demo\/logs\/oracle\/snapshots\/[0-9a-f]{64}\.json$/);
  });

  test('a payee with a live verdict is left alone; expired holds are ignored', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.setVerdict(ACC.lookalike, 'DENY', ['lookalike_new_account']);
    chain.held.set('1', held('1', ACC.lookalike));
    chain.held.set('2', held('2', ACC.newVendor, '1700000000'));
    const engine = fakeEngine();
    const { d } = deps(chain, { engine });
    const recs = await runOracleOnce(d, cfg());
    assert.deepEqual(recs.map((r) => [r.payee, r.action]), [[ACC.lookalike, 'skipped_has_verdict']]);
    assert.deepEqual(engine.calls, [], 'nothing was recomputed');
  });

  test('a soft WARN vendor is judged and logged but not written', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.held.set('1', held('1', ACC.newVendor));
    const { d } = deps(chain);
    const recs = await runOracleOnce(d, cfg());
    assert.equal(recs[0]?.action, 'not_written');
    assert.equal(chain.verdicts.get(ACC.newVendor), undefined);
    assert.equal(recs[0]?.engine?.warn_kind, 'soft');
  });

  test('without the oracle key: the exact set_verdict call, labeled prepared; nothing written', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.held.set('1', held('1', ACC.lookalike));
    const { d, lines } = deps(chain, { key: false });
    const recs = await runOracleOnce(d, cfg());
    assert.equal(recs[0]?.action, 'prepared');
    const call = recs[0]?.prepared;
    assert.equal(call?.receiver_id, ACC.registry);
    assert.equal(call?.signer_id, ACC.oracle);
    const action = call?.actions[0];
    assert.equal(action?.type === 'FunctionCall' ? action.params.methodName : '', 'set_verdict');
    assert.equal(chain.verdicts.size, 0);
    assert.ok(lines.some((l) => /prepared, not executed/.test(l)));
  });

  test('dry run: prepared even with a key', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.held.set('1', held('1', ACC.lookalike));
    const { d } = deps(chain);
    const recs = await runOracleOnce(d, cfg({ dryRun: true }));
    assert.equal(recs[0]?.action, 'prepared');
    assert.equal(chain.sent.length, 0);
  });

  test('an engine failure for one payee is recorded, not thrown', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.held.set('1', held('1', 'unknown-to-the-engine.testnet'));
    chain.held.set('2', held('2', ACC.lookalike));
    const { d } = deps(chain);
    const recs = await runOracleOnce(d, cfg());
    assert.deepEqual(recs.map((r) => r.action), ['judge_failed', 'written']);
  });

  test('the vault allowlist joins the known payees the lookalike check uses', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.allowlist.push('northwind-supplier.testnet');
    chain.held.set('1', held('1', ACC.lookalike));
    const { d, lines } = deps(chain);
    await runOracleOnce(d, cfg());
    assert.ok(lines.some((l) => /known payees \(configured \[aid-demo-merchant\.testnet\], plus the vault allowlist \[northwind-supplier\.testnet\]\): aid-demo-merchant\.testnet, northwind-supplier\.testnet/.test(l)));
  });
});

describe('watch mode', () => {
  test('a failing round is logged and backs off; the watcher keeps going', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const { d, lines } = deps(chain);
    let n = 0;
    const flaky: OracleDeps = { ...d, views: { ...d.views, listHeld: async () => (n++ === 0 ? Promise.reject(new Error('rpc down')) : []) } };
    const waits: number[] = [];
    const rounds = await watch(flaky, cfg(), { intervalS: 15, maxRounds: 3, sleep: async (ms) => void waits.push(ms) });
    assert.equal(rounds, 3);
    assert.ok(lines.some((l) => /round 1 failed \(rpc down\); next round in 30 s/.test(l)));
    assert.deepEqual(waits, [30_000, 15_000]);
  });
});

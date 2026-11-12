import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { DEMO_TTL_DENY_S, modeText, networkRecord, parseDemoArgs, PHASES, runDemo } from '../attack.ts';
import type { DemoDeps, DemoOptions } from '../attack.ts';
import type { LlmRuntime } from '../agent/agent.ts';
import { loadLlmConfig } from '../agent/llm.ts';
import { noKeySender } from '../lib/chain.ts';
import { lineTag, makeRunId, runLabel, StoryLog } from '../lib/log.ts';
import type { RunMode } from '../lib/log.ts';
import { displayPath } from '../lib/paths.ts';
import type { FetchLike } from '../lib/rpc.ts';
import { allInvoices } from '../scenarios/invoices.ts';
import { ACC, decision, demoDecisions, FakeChain, fakeEngine, NET, reason, TOKEN } from './helpers.ts';

const FIXED = new Date('2026-11-13T12:00:00Z');

function options(o: Partial<DemoOptions> = {}): DemoOptions {
  return { llm: false, dryRun: false, phases: [...PHASES], logDir: '/nonexistent', oracleStep: true, onchainVicious: true, signatures: false, ttlDenyS: DEMO_TTL_DENY_S, ...o };
}

function build(
  chain: FakeChain | null,
  o: { keys?: boolean; llm?: LlmRuntime | null; llmSkip?: string | null; mode?: RunMode; decisions?: ReturnType<typeof demoDecisions>; oracleSaveDir?: string | null } = {},
) {
  const lines: string[] = [];
  const mode = o.mode ?? { llm: false, dryRun: chain === null };
  const log = new StoryLog({ runId: 'test-run', mode, network: networkRecord(NET), accounts: ACC, clock: () => FIXED, sink: (l) => lines.push(l) });
  const keys = o.keys ?? true;
  const agent = chain && keys ? chain.sender(ACC.vault, { functionCallKey: true }) : noKeySender('no agent key: test');
  const deps: DemoDeps = {
    net: NET,
    accounts: ACC,
    log,
    views: chain ? chain.views() : null,
    txOutcome: chain ? chain.txOutcome : null,
    guard: chain ? chain.guard(keys ? agent : null, o.decisions) : null,
    guardWhy: chain ? '' : 'dry run',
    engine: chain ? fakeEngine(o.decisions) : null,
    engineWhy: chain ? '' : 'dry run',
    agent,
    owner: chain && keys ? chain.sender(ACC.owner) : noKeySender('no owner key: test'),
    oracle: chain && keys ? chain.sender(ACC.oracle) : noKeySender('no oracle key: test'),
    llm: o.llm ?? null,
    llmSkip: o.llmSkip ?? null,
    orphanKey: async () => 'ed25519:FAKE-orphan-key',
    oracleSaveDir: o.oracleSaveDir ?? null,
    now: () => FIXED,
  };
  return { deps, lines, log };
}

const result = (phases: Array<{ id: string; result: string }>) => Object.fromEntries(phases.map((p) => [p.id, p.result]));

/** "<t> [<phase>] [<tag>] <source>: <text>" */
function parse(line: string): { phase: string; tag: string; source: string; text: string } {
  const m = /^\S+ \[([^\]]+)\] \[([^\]]+)\] ([^:]+): (.*)$/.exec(line);
  if (!m) throw new Error(`not a log line: ${line}`);
  return { phase: m[1] ?? '', tag: m[2] ?? '', source: m[3] ?? '', text: m[4] ?? '' };
}

/** A mocked NEAR AI endpoint that follows each invoice: it proposes the invoice's scripted call
 * (for the poisoned one, the lookalike), then answers in one sentence once the tool replied. */
function followingModel(): { fetchImpl: FetchLike; calls: number } {
  const state = { calls: 0 };
  const invoices = allInvoices(ACC);
  const fetchImpl: FetchLike = async (_url, init) => {
    state.calls++;
    const body = JSON.parse(init.body ?? '{}') as { messages: Array<{ role: string; content: string | null }> };
    const last = body.messages.at(-1);
    if (last?.role === 'tool') return { ok: true, status: 200, text: async () => JSON.stringify({ id: `chat-${state.calls}`, choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }] }) };
    const inv = Object.values(invoices).find((i) => (body.messages[1]?.content ?? '').includes(i.scripted.memo));
    if (!inv) throw new Error('unknown invoice');
    const call = { id: `t${state.calls}`, type: 'function', function: { name: 'pay_invoice', arguments: JSON.stringify(inv.scripted) } };
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: `chat-${state.calls}`, choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [call] } }] }) };
  };
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

function llmRuntime(fetchImpl: FetchLike): LlmRuntime {
  const cfg = loadLlmConfig({ NEAR_AI_API_KEY: 'fake-near-ai-key-for-tests' });
  if (!cfg.ok) throw new Error('setup');
  return { settings: cfg.settings, key: cfg.key, deps: { fetchImpl } };
}

describe('dry run', () => {
  test('no network: every phase planned, exact prepared calls, every line tagged', async () => {
    const { deps, lines, log } = build(null);
    const r = await runDemo(options({ dryRun: true }), deps);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(result(r.phases), { setup: 'PLANNED', a: 'PLANNED', b: 'PLANNED', c: 'PLANNED', d: 'PLANNED', e: 'PLANNED' });
    assert.ok(lines.length > 50);
    for (const l of lines) assert.match(l, /\[dry-run scripted\]/);
    assert.ok(log.record.prepared.length >= 15);
    assert.equal(log.record.txs.length, 0);
    const methods = log.record.prepared.flatMap((p) => ((p.call as { actions?: Array<{ params?: { methodName?: string } }> }).actions ?? []).map((a) => a.params?.methodName));
    for (const m of ['request_payment', 'owner_pay', 'pay', 'record_refusal', 'set_verdict', 'set_registry', 'ft_transfer']) assert.ok(methods.includes(m), `plans ${m}`);
  });

  test('the planned set_verdict carries placeholders, never a hand-written verdict, and the demo TTL', async () => {
    const { deps, lines, log } = build(null);
    await runDemo(options({ dryRun: true, phases: ['c'] }), deps);
    const plan = log.record.prepared.find((p) => p.step.startsWith('oracle set_verdict'));
    const args = (plan?.call as { actions: Array<{ params: { args: Record<string, unknown> } }> }).actions[0]?.params.args ?? {};
    assert.match(String(args.verdict), /^<engine verdict/);
    assert.ok(Array.isArray(args.reasons) && (args.reasons as string[]).every((x) => x.startsWith('<')));
    assert.equal(args.ttl_s, String(30 * 86_400));
    assert.ok(lines.some((l) => /would expire about 2026-12-13T12:00:00Z/.test(l)));
  });
});

describe('scripted run against the in-memory chain', () => {
  test('the whole story: paid, refused by the guard, held then refused on chain, held then approved, protocol rejections', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const { deps, lines, log } = build(chain);
    const r = await runDemo(options(), deps);
    assert.deepEqual(result(r.phases), { setup: 'PASS', a: 'PASS', b: 'PASS', c: 'PASS', d: 'PASS', e: 'PASS' }, lines.filter((l) => / result: /.test(l)).join('\n'));
    assert.equal(r.exitCode, 0);
    for (const l of lines) assert.match(l, /\[scripted\]/, 'every line of a scripted run says so');

    // Money: the merchant and the vendor were paid; the lookalike never received anything.
    assert.equal(chain.balances.get(ACC.lookalike) ?? 0n, 0n);
    assert.equal(chain.balances.get(ACC.merchant), 10_000n + 500_000n);
    assert.equal(chain.balances.get(ACC.newVendor), 750_000n);
    // The oracle wrote DENY for the lookalike from the engine's decision, and nothing for the vendor.
    assert.equal(chain.verdicts.get(ACC.lookalike)?.verdict, 'DENY');
    assert.deepEqual(chain.verdicts.get(ACC.lookalike)?.reasons, ['lookalike_new_account']);
    assert.equal(chain.verdicts.get(ACC.newVendor), undefined);
    // Protocol rejections are recorded as such, never as transactions, with the signed bytes.
    assert.deepEqual(log.record.rejections.map((x) => [x.attempt, x.error_name, x.rule_matched]), [
      ['owner_method', 'MethodNameMismatch', true],
      ['attach_deposit', 'DepositWithFunctionCall', true],
      ['call_token', 'ReceiverMismatch', true],
      ['add_key', 'RequiresFullAccess', true],
      ['send_near', 'RequiresFullAccess', true],
    ]);
    for (const x of log.record.rejections) {
      assert.equal(x.label, 'rejected before execution, no transaction');
      assert.ok(x.signed_tx_base64 && x.signed_tx_base64.length > 0, 'the signed bytes are kept');
      assert.ok(x.local_tx_hash && x.nonce && x.block_hash && x.sent_at);
      assert.equal(x.public_key, 'ed25519:FAKE-agent-function-call-key');
      assert.equal(x.signer_id, ACC.vault);
    }
    assert.ok(lines.some((l) => /add_key: rejected before execution, no transaction: RequiresFullAccess/.test(l)));
    assert.ok(lines.some((l) => /signed bytes kept for re-derivation/.test(l)));
    // Every on-chain step carries an explorer link and an archival curl line.
    assert.ok(log.record.txs.length >= 10);
    for (const t of log.record.txs) {
      assert.match(t.explorer, /^https:\/\/testnet\.nearblocks\.io\/txns\//);
      assert.match(t.archival_curl, /archival-rpc\.testnet\.fastnear\.com.*EXPERIMENTAL_tx_status/);
    }
    // Phase c told the whole on-chain story, with the expiry of the DENY it wrote.
    const cNotes = r.phases.find((p) => p.id === 'c')?.notes.join(' | ') ?? '';
    assert.match(cNotes, /direct pay: held UnknownPayee \(kind unknown_payee\), nothing moved/);
    assert.match(r.phases.find((p) => p.id === 'b')?.notes.join(' | ') ?? '', /recorded on chain as the guard's refusal \(payment_refused, source agent_guard\)/);
    assert.match(cNotes, /oracle: written DENY/);
    assert.match(cNotes, /retry: refused RegistryDeny/);
    assert.match(cNotes, /owner approval: refused RegistryDeny/);
    const written = chain.sent.find((p) => p.actions[0]?.type === 'FunctionCall' && p.actions[0].methodName === 'set_verdict');
    const ttl = written?.actions[0]?.type === 'FunctionCall' ? written.actions[0].args.ttl_s : undefined;
    assert.equal(ttl, String(30 * 86_400), 'the demo DENY outlives the judging window');
    assert.ok(lines.some((l) => /wrote DENY \[lookalike_new_account\], ttl 2592000 s, expires about 2026-12-13T12:00:00Z/.test(l)));
    // The exact expiry, as the registry reports it (block time + ttl), and the evidence it stores.
    assert.ok(lines.some((l) => /registry now: DENY \[lookalike_new_account\] .* evidence near-snapshot sha256:[0-9a-f]{64} block:277300000 .* expires 2026-12-12T16:13:20Z \(get_verdict expires_at_ns\)/.test(l)));
    assert.match(cNotes, /registry DENY expires 2026-12-12T16:13:20Z/);
    // Every hold says what the VAULT saw (its kind), and a request's reason is the agent's words.
    assert.match(r.phases.find((p) => p.id === 'setup')?.notes.join(' | ') ?? '', /held \d+ \(kind unknown_payee\), approved/);
    assert.match(r.phases.find((p) => p.id === 'd')?.notes.join(' | ') ?? '', /held \d+ \(kind unknown_payee; the agent's own reason: "new_account"\)/);
    assert.ok(lines.some((l) => /vault answered held UnknownPayee \(payment \d+, held \d+, kind unknown_payee\)/.test(l)));
    assert.ok(lines.some((l) => /payment_held\{payment_id \d+, held_id \d+, payee aid-demo-merchamt\.testnet, amount 500000, reason UnknownPayee, kind unknown_payee\}/.test(l)));
    const heldEvents = log.record.txs.flatMap((t) => t.events.filter((e) => e.event === 'payment_held').map((e) => (e.data as { kind?: string }).kind));
    assert.deepEqual(heldEvents, ['unknown_payee', 'unknown_payee', 'unknown_payee'], 'setup, c and d each recorded the kind on chain');
    assert.ok(!lines.some((l) => /WARNING: the vault reports/.test(l)), 'a 0.2.0 vault raises no version warning');
    // The known payees and where they came from, on the guard's line and in the preflight.
    assert.ok(lines.some((l) => /known payees \(demo config \[aid-demo-merchant\.testnet\] plus the vault allowlist \[\]\): aid-demo-merchant\.testnet/.test(l)));
    // The direct calls are named as scripted, never as an agent's or a model's choice.
    assert.ok(lines.some((l) => /\[e\] \[scripted\] vicious agent \(scripted, no model\): Call an owner method/.test(l)));
    assert.ok(lines.some((l) => /\[setup\] \[scripted\] setup \(scripted direct call, agent key\): request_payment/.test(l)));
    assert.ok(lines.some((l) => /\[c\] \[scripted\] compromised agent \(scripted direct call, no guard, no model\)/.test(l)));
    // The committed record must pass the repository's secret scan: gitleaks' generic-api-key rule
    // reads a field named like "token" holding a 64-hex value as a credential. The USDC contract
    // id is recorded as usdc_contract instead.
    const json = log.toJson();
    assert.doesNotMatch(json, /"[^"]*token[^"]*"\s*:\s*"[0-9a-f]{64}"/i);
    assert.ok(json.includes(`"usdc_contract": "${TOKEN}"`));
  });

  test('the setup phase is skipped once the merchant has been paid', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.paid.set(ACC.merchant, 1);
    const { deps } = build(chain);
    const r = await runDemo(options({ phases: ['setup', 'a'] }), deps);
    assert.deepEqual(result(r.phases), { setup: 'SKIP', a: 'PASS' });
  });

  test('a rehearsal replay: phase d asks for a fresh vendor instead of failing', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.paid.set(ACC.newVendor, 1);
    const { deps, lines } = build(chain);
    const r = await runDemo(options({ phases: ['d'] }), deps);
    assert.deepEqual(result(r.phases), { d: 'SKIP' });
    assert.match(r.phases[0]?.notes[0] ?? '', /AID_NEW_VENDOR/);
    assert.equal(chain.sent.length, 0);
    assert.ok(lines.some((l) => /WARNING: the vault has paid or allowlisted the new vendor/.test(l)), 'the preflight said so first');
  });

  test('a second full run on the same chain: the lookalike is refused outright, nothing moves', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const first = build(chain);
    await runDemo(options(), first.deps);
    const second = build(chain);
    const r = await runDemo(options({ phases: ['setup', 'a', 'b', 'c', 'e'] }), second.deps);
    assert.deepEqual(result(r.phases), { setup: 'SKIP', a: 'PASS', b: 'PASS', c: 'PASS', e: 'PASS' });
    assert.match(r.phases.find((p) => p.id === 'c')?.notes.join(' | ') ?? '', /direct pay: refused RegistryDeny/);
    assert.equal(chain.balances.get(ACC.lookalike) ?? 0n, 0n);
    assert.ok(second.lines.some((l) => /WARNING: the registry already has DENY for the lookalike .* this is a replay/.test(l)));
  });

  test('a wrong verdict is a FAIL, not a quiet pass', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const decisions = { ...demoDecisions(), [ACC.lookalike]: decision(ACC.lookalike, 'ALLOW', [reason('long_history', 'positive')]) };
    const { deps, lines } = build(chain, { decisions });
    const r = await runDemo(options({ phases: ['b'] }), deps);
    assert.deepEqual(result(r.phases), { b: 'FAIL' });
    assert.equal(r.exitCode, 1);
    assert.equal(chain.balances.get(ACC.lookalike) ?? 0n, 0n, 'the vault still held the unknown payee (A1)');
    assert.ok(lines.some((l) => /WARNING: the engine does not find aid-demo-merchamt\.testnet a NEW lookalike/.test(l)), 'the preflight warned before the run');
  });

  test('a different validation rule than the attempt was built to show is a FAIL, kept in the record', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.rejectWith.set('set_registry', 'NotEnoughAllowance');
    const { deps, log } = build(chain);
    const r = await runDemo(options({ phases: ['e'], onchainVicious: false }), deps);
    assert.deepEqual(result(r.phases), { e: 'FAIL' });
    const rec = log.record.rejections.find((x) => x.attempt === 'owner_method');
    assert.equal(rec?.error_name, 'NotEnoughAllowance');
    assert.equal(rec?.expected_error, 'MethodNameMismatch');
    assert.equal(rec?.rule_matched, false);
    assert.match(r.phases[0]?.notes.join(' | ') ?? '', /owner_method: NotEnoughAllowance \(expected MethodNameMismatch\)/);
  });

  test('phase c in a fresh log folder: the oracle record is appended even when no snapshot was saved first', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    // A leftover hold for a payee the registry already judged: the oracle's first record is
    // skipped_has_verdict, written before any snapshot creates the folder.
    chain.setVerdict(ACC.newVendor, 'WARN', ['low_activity']);
    chain.held.set('99', { id: '99', payment_id: '99', agent_pk: 'ed25519:FAKE-agent-function-call-key', payee: ACC.newVendor, amount: '1', memo: null, reason: 'RegistryWarn', created_at_s: '1794500000', expires_at_s: '9999999999', kind: 'registry_warn' });
    const dir = join(mkdtempSync(join(tmpdir(), 'aid-demo-logs-')), 'fresh', 'oracle');
    const { deps } = build(chain, { oracleSaveDir: dir });
    const r = await runDemo(options({ phases: ['c'] }), deps);
    assert.deepEqual(result(r.phases), { c: 'PASS' }, r.phases[0]?.notes.join(' | '));
    const records = readFileSync(join(dir, 'oracle-2026-11-13.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { payee: string; action: string; snapshot_file?: string });
    assert.deepEqual(records.map((x) => [x.payee, x.action]), [[ACC.newVendor, 'skipped_has_verdict'], [ACC.lookalike, 'written']]);
    assert.ok(existsSync(join(dir, 'snapshots')));
  });

  test('--ttl-deny sets the TTL of the DENY phase c writes', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const { deps } = build(chain);
    await runDemo(options({ phases: ['c'], ttlDenyS: 86_400 }), deps);
    const written = chain.sent.find((p) => p.actions[0]?.type === 'FunctionCall' && p.actions[0].methodName === 'set_verdict');
    assert.equal(written?.actions[0]?.type === 'FunctionCall' ? written.actions[0].args.ttl_s : null, '86400');
  });
});

describe('vault builds', () => {
  test('a 0.1.0 vault: the preflight says so, and every hold prints with no kind rather than a guess from its reason', async () => {
    const chain = new FakeChain({ holdUnknown: true, legacy: true });
    const { deps, lines } = build(chain);
    const r = await runDemo(options({ phases: ['setup', 'c'] }), deps);
    assert.deepEqual(result(r.phases), { setup: 'PASS', c: 'PASS' });
    assert.ok(lines.some((l) => /WARNING: the vault reports agent-spend-policy 0\.1\.0; the demo is written for agent-spend-policy 0\.2\.0/.test(l)));
    assert.match(r.phases.find((p) => p.id === 'c')?.notes.join(' | ') ?? '', /direct pay: held UnknownPayee \(kind not reported \(a vault build before 0\.2\.0\)\)/);
    assert.ok(lines.some((l) => /vault answered held .*kind not reported/.test(l)));
  });

  test('0.2.0 can refuse to record a guard refusal: still nothing moves, but phase b says it was not recorded and fails', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.refuseRecordsWith = 'GuardRefusalLimitReached';
    const { deps } = build(chain);
    const r = await runDemo(options({ phases: ['b'] }), deps);
    assert.deepEqual(result(r.phases), { b: 'FAIL' });
    const notes = r.phases[0]?.notes.join(' | ') ?? '';
    assert.match(notes, /NOT recorded as the guard's refusal: the vault refused the record itself \(GuardRefusalLimitReached, source policy\); nothing moved/);
    assert.match(notes, /nothing moved to the lookalike/);
    assert.equal(chain.balances.get(ACC.lookalike) ?? 0n, 0n);
  });

  test('a contract that is not an agent-spend-policy build stops the run before anything is sent', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    (chain.config as { version: string }).version = 'some-other-contract 1.0.0';
    const { deps, lines } = build(chain);
    const r = await runDemo(options(), deps);
    assert.deepEqual(result(r.phases), { preflight: 'FAIL' });
    assert.equal(chain.sent.length, 0);
    assert.ok(lines.some((l) => /STOP: the vault reports version "some-other-contract 1\.0\.0", not an agent-spend-policy build/.test(l)));
  });

  test('the dry run plans every agent call with the gas the SDK attaches: 73 Tgas to pay and request, 10 to record', async () => {
    const { deps, log } = build(null);
    await runDemo(options({ dryRun: true }), deps);
    const gasByMethod = new Map<string, Set<string>>();
    for (const p of log.record.prepared) {
      for (const a of (p.call as { actions?: Array<{ params?: { methodName?: string; gas?: string } }> }).actions ?? []) {
        const m = a.params?.methodName;
        if (m && a.params?.gas) gasByMethod.set(m, new Set([...(gasByMethod.get(m) ?? []), a.params.gas]));
      }
    }
    assert.deepEqual([...(gasByMethod.get('request_payment') ?? [])], ['73000000000000']);
    assert.deepEqual([...(gasByMethod.get('record_refusal') ?? [])], ['10000000000000']);
    // pay is planned at 73 Tgas; the one exception is phase e's 1-yocto pay, which the protocol
    // rejects before execution and which carries the small forbidden-call figure on purpose.
    assert.deepEqual([...(gasByMethod.get('pay') ?? [])].sort(), ['5000000000000', '73000000000000']);
  });
});

describe('preflight', () => {
  test('a vault reading another registry stops the run before anything is sent', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    (chain.config as { registry_id: string | null }).registry_id = 'registry.someone-else.testnet';
    const { deps, lines } = build(chain);
    const r = await runDemo(options(), deps);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(result(r.phases), { preflight: 'FAIL' });
    assert.equal(chain.sent.length, 0);
    assert.ok(lines.some((l) => /STOP: the vault reads registry registry\.someone-else\.testnet/.test(l)));
  });

  test('a vault paying in another token stops the run', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    (chain.config as { token_id: string }).token_id = 'usdc.fakes.testnet';
    const { deps } = build(chain);
    const r = await runDemo(options(), deps);
    assert.deepEqual(result(r.phases), { preflight: 'FAIL' });
    assert.equal(chain.sent.length, 0);
  });

  test('a lookalike that does not exist yet stops the phases that need it, and only those', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.accounts.delete(ACC.lookalike);
    const stopped = build(chain);
    const r = await runDemo(options({ phases: ['b', 'c'] }), stopped.deps);
    assert.deepEqual(result(r.phases), { preflight: 'FAIL' });
    assert.match(r.phases[0]?.notes.join(' | ') ?? '', /aid-demo-merchamt\.testnet \(the lookalike\) does not exist on testnet; phases b, c need it/);
    assert.equal(chain.sent.length, 0);
    const other = build(chain);
    const ok = await runDemo(options({ phases: ['e'], onchainVicious: false }), other.deps);
    assert.deepEqual(result(ok.phases), { e: 'PASS' });
    assert.ok(other.lines.some((l) => /WARNING: aid-demo-merchamt\.testnet \(the lookalike\) does not exist on testnet; no chosen phase needs it/.test(l)));
  });

  test('the vault allowlist joins the known payees the guard is given', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.allowlist.push('northwind-supplier.testnet');
    const guardCalls: string[][] = [];
    const { deps } = build(chain);
    const guard = deps.guard;
    assert.ok(guard);
    deps.guard = { description: guard.description, verifyThenPay: (args) => (guardCalls.push(args.known), guard.verifyThenPay(args)) };
    await runDemo(options({ phases: ['a'] }), deps);
    assert.deepEqual(guardCalls, [['aid-demo-merchant.testnet', 'northwind-supplier.testnet']]);
  });
});

describe('missing keys and unsafe setups', () => {
  test('no keys: every write is a labeled prepared call; nothing is sent; no crash', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const { deps, lines, log } = build(chain, { keys: false });
    const r = await runDemo(options(), deps);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(result(r.phases), { setup: 'PREPARED', a: 'PREPARED', b: 'PREPARED', c: 'PREPARED', d: 'PREPARED', e: 'PREPARED' });
    assert.equal(chain.sent.length, 0);
    assert.equal(log.record.txs.length, 0);
    assert.ok(lines.some((l) => /prepared, not executed/.test(l)));
  });

  test('phase c is not run against a vault that would pay an unjudged payee', async () => {
    const chain = new FakeChain({ holdUnknown: undefined });
    const { deps } = build(chain);
    const r = await runDemo(options({ phases: ['c'] }), deps);
    assert.deepEqual(result(r.phases), { c: 'SKIP' });
    assert.equal(chain.sent.length, 0);
  });

  test('a full-access agent key stops the run before anything is sent', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    chain.agentPermission = 'FullAccess';
    const { deps, lines } = build(chain);
    const r = await runDemo(options(), deps);
    assert.equal(r.exitCode, 1);
    assert.equal(chain.sent.length, 0);
    assert.ok(lines.some((l) => /REFUSED: the key is a FULL-ACCESS key/.test(l)));
  });
});

describe('llm mode', () => {
  test('without a key: the header says the model phases are skipped, nothing claims a model, files are not named -llm', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const skip = loadLlmConfig({});
    assert.equal(skip.ok, false);
    const mode: RunMode = { llm: true, dryRun: false, modelSkipped: skip.ok ? '' : skip.short };
    const { deps, lines, log } = build(chain, { llm: null, llmSkip: skip.ok ? null : skip.skip, mode });
    const r = await runDemo(options({ llm: true, phases: ['a', 'b', 'c', 'd', 'e'] }), deps);
    assert.equal(result(r.phases).a, 'SKIP');
    assert.equal(result(r.phases).b, 'SKIP');
    assert.equal(result(r.phases).d, 'SKIP');
    assert.equal(result(r.phases).c, 'PASS');
    assert.ok(lines.some((l) => /SKIP: no NEAR AI key/.test(l)));
    const head = lines.find((l) => /Mode: /.test(l)) ?? '';
    assert.match(head, /Mode: model phases skipped: no NEAR AI key/);
    assert.doesNotMatch(lines.join('\n'), /real model|\[model\]/);
    assert.match(makeRunId(FIXED, mode), /-no-model$/);
    assert.doesNotMatch(makeRunId(FIXED, mode), /llm/);
    assert.match(log.toText().split('\n')[0] ?? '', /model phases skipped: no NEAR AI key/);
    for (const l of lines.map(parse).filter((x) => x.phase === 'c' || x.phase === 'e')) assert.equal(l.tag, 'scripted', `${l.phase} ${l.source}: ${l.text}`);
  });

  test('a model that does not take the bait is MODEL_DECLINED, recorded with its words', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'chat-x', choices: [{ finish_reason: 'stop', message: { content: 'The account change looks suspicious; not paying.' } }] }) });
    const { deps, lines, log } = build(chain, { llm: llmRuntime(fetchImpl), mode: { llm: true, dryRun: false, model: 'm' } });
    const r = await runDemo(options({ llm: true, phases: ['b'] }), deps);
    assert.deepEqual(result(r.phases), { b: 'MODEL_DECLINED' });
    assert.equal(r.exitCode, 0);
    assert.ok(lines.some((l) => /\[model\] model .*says: .*suspicious/.test(l)), 'its words are tagged as the model\'s');
    assert.equal(log.record.llm_exchanges.length, 1);
    assert.ok(!log.toJson().includes('fake-near-ai-key-for-tests'));
  });

  test('a model that takes the bait: its raw call is logged before the guard refuses it', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n++;
      const body =
        n === 1
          ? { id: 'chat-1', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'pay_invoice', arguments: JSON.stringify({ payee: ACC.lookalike, amount_usdc: '0.50', memo: 'INV-1002' }) } }] } }] }
          : { id: 'chat-2', choices: [{ finish_reason: 'stop', message: { content: 'The payment was refused.' } }] };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const { deps, lines } = build(chain, { llm: llmRuntime(fetchImpl), mode: { llm: true, dryRun: false, model: 'm' } });
    const r = await runDemo(options({ llm: true, phases: ['b'] }), deps);
    assert.deepEqual(result(r.phases), { b: 'PASS' });
    const raw = lines.findIndex((l) => /\[model\] model .*raw tool call: pay_invoice/.test(l));
    const verdict = lines.findIndex((l) => /verdict DENY for aid-demo-merchamt\.testnet/.test(l));
    assert.ok(raw >= 0 && verdict > raw, 'the proposal is logged before the verdict');
    assert.ok(lines.some((l) => /\[report\] demo: the model took the bait/.test(l)), 'commentary on the model is not tagged as the model');
    assert.ok(lines.some((l) => /\[b\] \[report\] guard: verdict DENY/.test(l)), 'the guard verdict is a report, not the model');
    for (const l of lines) assert.doesNotMatch(l, /\[llm\]/, 'no line is tagged by run mode');
    assert.equal(chain.balances.get(ACC.lookalike) ?? 0n, 0n);
    assert.equal(TOKEN.length, 64);
  });

  test('a full llm run: setup, c and e are tagged scripted on every line; [model] only on what the model produced', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const model = followingModel();
    const { deps, lines } = build(chain, { llm: llmRuntime(model.fetchImpl), mode: { llm: true, dryRun: false, model: 'm' } });
    const r = await runDemo(options({ llm: true }), deps);
    assert.deepEqual(result(r.phases), { setup: 'PASS', a: 'PASS', b: 'PASS', c: 'PASS', d: 'PASS', e: 'PASS' }, lines.filter((l) => / result: /.test(l)).join('\n'));
    assert.ok(model.calls >= 6, 'the model read every invoice');
    const parsed = lines.map(parse);
    for (const l of parsed.filter((x) => x.phase === 'setup' || x.phase === 'c' || x.phase === 'e')) {
      assert.equal(l.tag, 'scripted', `${l.phase} ${l.source}: ${l.text}`);
    }
    for (const l of parsed.filter((x) => x.tag === 'model')) assert.match(l.source, /^model /, `only the model's own lines: ${l.source}: ${l.text}`);
    assert.ok(parsed.some((x) => x.phase === 'e' && x.source === 'vicious agent (scripted, no model)'));
    assert.ok(parsed.some((x) => x.phase === 'd' && x.tag === 'scripted' && x.source.startsWith('owner (scripted')), "the owner's approval is the demo, not the model");
    assert.ok(parsed.some((x) => x.phase === 'b' && x.tag === 'model' && /raw tool call/.test(x.text)));
  });

  test('a NEAR AI HTTP error is recorded with its exchange before the phase fails', async () => {
    const chain = new FakeChain({ holdUnknown: true });
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 500, text: async () => '{"error":"upstream model unavailable"}' });
    const { deps, log } = build(chain, { llm: llmRuntime(fetchImpl), mode: { llm: true, dryRun: false, model: 'm' } });
    const r = await runDemo(options({ llm: true, phases: ['a'] }), deps);
    assert.deepEqual(result(r.phases), { a: 'FAIL' });
    assert.equal(log.record.llm_exchanges.length, 1);
    assert.equal((log.record.llm_exchanges[0] as { response_status: number }).response_status, 500);
  });
});

describe('log hygiene, tags and arguments', () => {
  test('a registered secret never reaches a line or the JSON record', () => {
    const lines: string[] = [];
    const log = new StoryLog({ runId: 'x', mode: { llm: false, dryRun: true }, network: NET, accounts: ACC, sink: (l) => lines.push(l) });
    log.addSecret('ed25519:FAKE-secret-for-tests-only');
    log.line('a', 'test', 'oops ed25519:FAKE-secret-for-tests-only leaked');
    assert.ok(!lines.join('\n').includes('FAKE-secret'));
    assert.ok(!log.toJson().includes('FAKE-secret'));
    assert.ok(!log.toText().includes('FAKE-secret'));
    assert.match(lines[0] ?? '', /<redacted>/);
  });

  test('tags: a run with no model says scripted on every line; an llm run names who acted', () => {
    assert.equal(lineTag({ llm: false, dryRun: false }, 'model'), 'scripted');
    assert.equal(lineTag({ llm: false, dryRun: true }, 'report'), 'dry-run scripted');
    assert.equal(lineTag({ llm: true, dryRun: false, model: 'm' }, 'model'), 'model');
    assert.equal(lineTag({ llm: true, dryRun: false, model: 'm' }, 'scripted'), 'scripted');
    assert.equal(lineTag({ llm: true, dryRun: false, model: 'm' }, 'report'), 'report');
    assert.match(makeRunId(FIXED, { llm: true, dryRun: false, model: 'm' }), /^20261113T120000Z-llm$/);
    assert.match(makeRunId(FIXED, { llm: false, dryRun: false }), /-scripted$/);
    assert.match(makeRunId(FIXED, { llm: true, dryRun: true }), /-dry-run$/);
    assert.match(runLabel({ llm: true, dryRun: false, modelSkipped: 'no NEAR AI key' }), /model phases skipped/);
    assert.match(modeText({ llm: true, dryRun: false }, null, { skipped: 'no NEAR AI key' }), /^model phases skipped: no NEAR AI key/);
    assert.doesNotMatch(modeText({ llm: true, dryRun: false }, null, { skipped: 'no NEAR AI key' }), /real model|seed/);
  });

  test('paths in committed records: relative to near/ inside the tree, ~ under home, else unchanged', () => {
    assert.equal(displayPath('/x/near/demo/logs/oracle/snapshots/ab.json', '/x/near/', '/home/u'), 'demo/logs/oracle/snapshots/ab.json');
    assert.equal(displayPath('/home/u/.near-credentials/testnet/k.json', '/x/near/', '/home/u'), '~/.near-credentials/testnet/k.json');
    assert.equal(displayPath('/tmp/elsewhere/a.json', '/x/near/', '/home/u'), '/tmp/elsewhere/a.json');
    assert.equal(displayPath('demo/logs/a.json', '/x/near/', '/home/u'), 'demo/logs/a.json');
  });

  test('arguments: --llm and --no-llm are exclusive; phases are validated and ordered; --ttl-deny', () => {
    assert.throws(() => parseDemoArgs(['--llm', '--no-llm']), /choose one/);
    assert.throws(() => parseDemoArgs(['--phases', 'a,z']), /unknown phase z/);
    assert.deepEqual(parseDemoArgs(['--phases', 'e,0,b']).phases, ['setup', 'b', 'e']);
    assert.equal(parseDemoArgs(['--dry-run', '--no-llm']).dryRun, true);
    assert.equal(parseDemoArgs([]).ttlDenyS, 30 * 86_400);
    assert.equal(parseDemoArgs(['--ttl-deny', '86400']).ttlDenyS, 86_400);
    assert.throws(() => parseDemoArgs(['--ttl-deny', '7d']), /whole seconds/);
  });
});

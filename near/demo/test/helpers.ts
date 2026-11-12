// Test helpers. Nothing here touches the network.
//
// Two kinds of fixtures:
// - RECORDED: fixtures/tx-usdc-faucet-transfer.json is a real testnet transaction, fetched on
//   2026-11-12 from https://archival-rpc.testnet.fastnear.com with EXPERIMENTAL_tx_status
//   (tx D6Jp1Ho17KbwV5KDzcdE9RooKG6YFcZRRpap7RiNaV84: Circle's testnet USDC faucet sending
//   20 USDC to aid-demo-owner.testnet). It pins the outcome parser to real RPC output. One field
//   was changed: transaction.signature, a 64-byte ed25519 value, is replaced by a placeholder,
//   because the repository's secret scan rejects every 64-byte ed25519 value, signatures included.
//   The parser never reads it; the original is one archival curl away.
// - CONSTRUCTED: the vault and registry outcomes and the invalid-transaction errors below are
//   built from the contracts' event ABI (agent-spend-policy event.rs, registry event.rs) and from
//   nearcore's RPC error serialization (the path near-api-js 7.5.3 parses:
//   error.data.TxExecutionError.InvalidTxError). Replace them with recorded ones after the first
//   testnet run; demo/logs/<run-id>.json keeps every raw RPC error it saw.

import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import type { HoldKind } from '../../sdk/src/chain/abi.ts';
import type { Decision, Reason, Snapshot } from '../../sdk/src/engine/types.ts';
import { parseOutcome, preparedCall } from '../lib/chain.ts';
import type { ParsedOutcome, SendResult, Sender, SignedTx, TxPlan } from '../lib/chain.ts';
import { GAS, TESTNET_DEFAULTS } from '../lib/config.ts';
import type { EngineJudgement, EnginePort, GuardArgs, GuardPort, GuardResult } from '../lib/ports.ts';
import type { JsonRpcErrorBody } from '../lib/rpc.ts';
import type { HeldView, RegistryVerdictView, VaultConfigView, Views } from '../lib/views.ts';
import { DEFAULT_ACCOUNTS } from '../scenarios/accounts.ts';

export const ACC = DEFAULT_ACCOUNTS;
export const TOKEN = TESTNET_DEFAULTS.tokenId;
export const NET = TESTNET_DEFAULTS;
/** Fake ("-" is not base58), so it can never be mistaken for a real key. */
export const AGENT_PK = 'ed25519:FAKE-agent-function-call-key';

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

export function b64json(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64');
}

export function eventLine(standard: string, event: string, data: unknown): string {
  return `EVENT_JSON:${JSON.stringify({ standard, version: '1.0.0', event, data })}`;
}

export type PayOutcome = { status: 'sent' | 'refused' | 'held' | 'failed'; payment_id: string; reason: string | null; held_id: string | null };

/** A FINAL EXPERIMENTAL_tx_status result shaped like nearcore's, for one call. */
export function txResult(o: {
  hash: string;
  signer: string;
  receiver: string;
  returnValue?: unknown;
  logs: Array<{ executor: string; lines: string[]; failed?: boolean }>;
  failure?: unknown;
}): Record<string, unknown> {
  return {
    final_execution_status: 'FINAL',
    status: o.failure ? { Failure: o.failure } : { SuccessValue: o.returnValue === undefined ? '' : b64json(o.returnValue) },
    transaction: { hash: o.hash, signer_id: o.signer, receiver_id: o.receiver },
    transaction_outcome: { id: o.hash, outcome: { executor_id: o.signer, logs: [], status: { SuccessReceiptId: 'r0' }, gas_burnt: 300000000000 } },
    receipts_outcome: o.logs.map((l, i) => ({
      id: `${o.hash}-r${i}`,
      outcome: { executor_id: l.executor, logs: l.lines, status: l.failed ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'failed' } } } } } : { SuccessValue: '' }, gas_burnt: 2000000000000 },
    })),
  };
}

/** nearcore's JSON-RPC error for a transaction rejected at validation. */
export function invalidTx(inner: unknown): JsonRpcErrorBody {
  return { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: inner } } };
}

export const ACCESS_KEY_ERRORS: Record<string, unknown> = {
  MethodNameMismatch: { InvalidAccessKeyError: { MethodNameMismatch: { method_name: 'set_registry' } } },
  DepositWithFunctionCall: { InvalidAccessKeyError: 'DepositWithFunctionCall' },
  ReceiverMismatch: { InvalidAccessKeyError: { ReceiverMismatch: { tx_receiver: TOKEN, ak_receiver: ACC.vault } } },
  RequiresFullAccess: { InvalidAccessKeyError: 'RequiresFullAccess' },
  NotEnoughAllowance: { InvalidAccessKeyError: { NotEnoughAllowance: { account_id: ACC.vault, public_key: 'ed25519:FAKE-agent-function-call-key', allowance: '1', cost: '2' } } },
  InvalidNonce: { InvalidNonce: { tx_nonce: 6, ak_nonce: 10 } },
};

/** Stand-in signed bytes for the in-memory chain: base64 of the prepared call, NOT a borsh
 * SignedTransaction (the judge would refuse to decode it). The shape is what is under test. */
export function fakeSigned(plan: TxPlan, publicKey: string, nonce: number): SignedTx {
  return {
    signed_tx_base64: Buffer.from(JSON.stringify(preparedCall(plan))).toString('base64'),
    local_tx_hash: `LocalHash${String(nonce).padStart(4, '0')}`,
    sent_at: '2026-11-13T12:00:00.000Z',
    signer_id: plan.signerId,
    receiver_id: plan.receiverId,
    public_key: publicKey,
    nonce: String(nonce),
    block_hash: 'BlockHash1111111111111111111111111111111111',
  };
}

// -- engine and snapshots ------------------------------------------------------------------------

export function reason(code: Reason['code'], severity: Reason['severity'], detail = `${code} observed`, cleared_by?: Reason['code']): Reason {
  return { code, severity, detail, source: 'test', ...(cleared_by ? { cleared_by } : {}) };
}

export function decision(subject: string, verdict: Decision['verdict'], reasons: Reason[], o: { score?: number; warn_kind?: Decision['warn_kind'] } = {}): Decision {
  return {
    subject,
    network: 'testnet',
    verdict,
    score: o.score ?? (verdict === 'ALLOW' ? 700 : verdict === 'WARN' ? 400 : 100),
    reasons,
    warn_kind: o.warn_kind ?? (verdict === 'WARN' ? 'hard' : null),
    engine_version: 'a-identity-near-engine/1.0.0',
    policy_id: 'near-default/1',
    block: { height: 277300000, hash: 'BlockHash1111111111111111111111111111111111', timestamp_ns: '1794500000000000000' },
  };
}

export function snapshot(subject: string, codeHash = '11111111111111111111111111111111'): Snapshot {
  return {
    schema: 'a-identity.near.snapshot/1',
    network: 'testnet',
    subject,
    block: { height: 277300000, hash: 'BlockHash1111111111111111111111111111111111', timestamp_ns: '1794500000000000000' },
    context: {
      known: [ACC.merchant],
      vault_id: ACC.vault,
      registry_id: ACC.registry,
      usdc_id: TOKEN,
      third_party: [],
      erc8004: null,
      probes: { recent_s: 259200, long_s: 2592000 },
      activity_window: 5,
    },
    rpc: [
      {
        label: 'account',
        network: 'testnet',
        archival: false,
        method: 'query',
        params: { request_type: 'view_account', account_id: subject, block_id: 277300000 },
        result: { amount: '10000000000000000000000000', locked: '0', code_hash: codeHash, storage_usage: 182, storage_paid_at: 0, block_height: 277300000, block_hash: 'BlockHash1111111111111111111111111111111111' },
      },
    ],
    http: [],
  };
}

/** The engine's expected answers for the demo's three payees. */
export function demoDecisions(): Record<string, Decision> {
  return {
    [ACC.merchant]: decision(ACC.merchant, 'ALLOW', [reason('new_account', 'warn', 'created 30 h before the block', 'prior_payments'), reason('prior_payments', 'positive', 'paid 1 time by the vault'), reason('known_payee', 'info')]),
    [ACC.lookalike]: decision(ACC.lookalike, 'DENY', [reason('lookalike_new_account', 'deny', `one edit from ${ACC.merchant}, created 4 min before the block`), reason('new_account', 'warn'), reason('new_full_access_key', 'warn')]),
    [ACC.newVendor]: decision(ACC.newVendor, 'WARN', [reason('new_account', 'warn'), reason('low_activity', 'warn', '2 transactions')], { warn_kind: 'soft' }),
  };
}

export function fakeEngine(decisions: Record<string, Decision> = demoDecisions()): EnginePort & { calls: string[] } {
  const calls: string[] = [];
  return {
    version: 'a-identity-near-engine/1.0.0 (fake)',
    calls,
    async judge(subject): Promise<EngineJudgement> {
      calls.push(subject);
      const d = decisions[subject];
      if (!d) throw new Error(`no decision for ${subject}`);
      const sha = `${'ab'.repeat(31)}${calls.length.toString(16).padStart(2, '0')}`;
      return { decision: d, snapshot: snapshot(subject), snapshotSha256: sha, evidence: `near-snapshot sha256:${sha} block:${d.block.height} engine:1.0.0` };
    },
  };
}

// -- an in-memory vault, registry and token ------------------------------------------------------

/**
 * A small simulator of the deployed contracts, following CONTRACTS-SPEC.md, amendment A1 and
 * vault 0.2.0 (near/contracts/agent-spend-policy/src/lib.rs, after_verdict): DENY refuses
 * (RegistryDeny), WARN holds (RegistryWarn), no verdict holds unless the payee is allowlisted or
 * was paid before (UnknownPayee), request_payment always holds, owner_pay re-reads the registry,
 * and a function-call key is checked the way nearcore checks it. Every hold records the vault's
 * own `kind` (registry_warn, unknown_payee, agent_request), as 0.2.0 does; `legacy: true`
 * simulates a 0.1.0 vault, whose holds and payment_held events carry none.
 */
export class FakeChain {
  readonly config: VaultConfigView;
  readonly held = new Map<string, HeldView>();
  readonly verdicts = new Map<string, RegistryVerdictView>();
  readonly paid = new Map<string, number>();
  readonly refusals = new Map<string, number>();
  readonly allowlist: string[] = [];
  readonly balances = new Map<string, bigint>();
  readonly txs = new Map<string, Record<string, unknown>>();
  readonly sent: TxPlan[] = [];
  /** Accounts that exist. Every demo account does, unless a test removes one. */
  readonly accounts = new Set<string>(Object.values(ACC));
  /** Make the protocol answer with another InvalidTxError for a method (or "Transfer"/"AddKey"),
   * as nearcore does when a check that runs first fails (the allowance, a stale nonce). */
  readonly rejectWith = new Map<string, string>();
  /** Vault 0.2.0's own refusal of a record_refusal it will not write (GuardRefusalLimitReached,
   * StorageNotCovered): refused with that name and source policy, nothing counted. */
  refuseRecordsWith: string | null = null;
  agentPermission: 'FullAccess' | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } } = {
    FunctionCall: { allowance: '250000000000000000000000', receiver_id: ACC.vault, method_names: ['pay', 'request_payment', 'record_refusal'] },
  };
  private nextPayment = 1;
  private nextHeld = 1;
  private nextTx = 1;
  private nextNonce = 1;

  /** A 0.1.0 vault: no `kind` on holds or on payment_held. */
  readonly legacy: boolean;

  constructor(o: { holdUnknown?: boolean | undefined; ceiling?: string; legacy?: boolean } = {}) {
    this.legacy = o.legacy === true;
    this.config = {
      owner_id: ACC.owner,
      token_id: TOKEN,
      registry_id: ACC.registry,
      frozen: false,
      daily_cap: '5000000',
      auto_approve_max: o.ceiling ?? '2000000',
      allowlist_enabled: false,
      token_storage_deposit: '1250000000000000000000',
      version: this.legacy ? 'agent-spend-policy 0.1.0' : 'agent-spend-policy 0.2.0',
      ...(o.holdUnknown === undefined ? {} : { hold_unknown: o.holdUnknown }),
    };
    this.balances.set(ACC.vault, 20_000_000n);
  }

  views(): Views {
    return {
      getConfig: async () => this.config,
      listHeld: async () => [...this.held.values()],
      getVerdict: async (_r, a) => this.verdicts.get(a) ?? null,
      paidCount: async (_v, p) => this.paid.get(p) ?? 0,
      refusalCount: async (_v, p) => this.refusals.get(p) ?? 0,
      guardRefusalCount: async () => 0,
      isAllowed: async (_v, p) => this.allowlist.includes(p),
      listAllowlist: async () => [...this.allowlist],
      ftBalance: async (_t, a) => this.balances.get(a) ?? null,
      accessKey: async (account, pk) => (account === ACC.vault && pk === AGENT_PK ? { nonce: 1n, permission: this.agentPermission, blockHash: 'h', blockHeight: 1 } : null),
      accessKeyList: async (account) => (account === ACC.vault ? [{ publicKey: AGENT_PK, permission: this.agentPermission }] : []),
      account: async (id) => (this.accounts.has(id) ? { amount: '10000000000000000000000000', locked: '0', code_hash: '11111111111111111111111111111111', storage_usage: 182, block_height: 277300000 } : null),
    };
  }

  txOutcome = async (hash: string): Promise<ParsedOutcome> => {
    const t = this.txs.get(hash);
    if (!t) throw new Error(`unknown tx ${hash}`);
    return parseOutcome(t);
  };

  /** The registry's clock in this simulator: the fixed block time of every fake block. */
  static readonly BLOCK_TIME_NS = 1_794_500_000_000_000_000n;

  setVerdict(account: string, verdict: RegistryVerdictView['verdict'], reasons: string[] = [], ttlS: string | null = null, evidence: string | null = null): void {
    const ttl = ttlS && /^\d+$/.test(ttlS) ? BigInt(ttlS) : 0n;
    const expires = ttl > 0n ? String(FakeChain.BLOCK_TIME_NS + ttl * 1_000_000_000n) : null;
    this.verdicts.set(account, { account_id: account, verdict, reasons, evidence, score: null, code_hash: null, updated_at_ns: String(FakeChain.BLOCK_TIME_NS), updated_by: ACC.oracle, expires_at_ns: expires });
  }

  private record(signer: string, receiver: string, returnValue: unknown, logs: Array<{ executor: string; lines: string[] }>): { kind: 'executed'; txHash: string; outcome: ParsedOutcome } {
    const hash = `Tx${String(this.nextTx++).padStart(4, '0')}`;
    const raw = txResult({ hash, signer, receiver, returnValue, logs });
    this.txs.set(hash, raw);
    return { kind: 'executed', txHash: hash, outcome: parseOutcome(raw) };
  }

  private vaultEvent(event: string, data: Record<string, unknown>): string {
    return eventLine('a_identity_vault', event, data);
  }

  /** Hold a payment, as the vault does: the hold and its payment_held line carry `kind` (0.2.0). */
  private hold(payee: string, amount: string, memo: string | null, reason: string, paymentId: string, kind: HoldKind): { out: PayOutcome; line: string } {
    const id = String(this.nextHeld++);
    const k = this.legacy ? {} : { kind };
    this.held.set(id, { id, payment_id: paymentId, agent_pk: AGENT_PK, payee, amount, memo, reason, created_at_s: '1794500000', expires_at_s: '9999999999', ...k });
    const out: PayOutcome = { status: 'held', payment_id: paymentId, reason, held_id: id };
    return { out, line: this.vaultEvent('payment_held', { payment_id: paymentId, held_id: id, payee, amount, reason, ...k }) };
  }

  /** The vault already knows the payee: the owner listed it or the vault paid it before. */
  private known(payee: string): boolean {
    return this.allowlist.includes(payee) || (this.paid.get(payee) ?? 0) > 0;
  }

  /** The vault pipeline after the gates: what the registry answer means for this mode. */
  private pipeline(mode: 'pay' | 'request' | 'owner', payee: string, amount: string, memo: string | null, paymentId: string, heldId: string | null, agentReason?: string) {
    const v = this.verdicts.get(payee) ?? null;
    const lines: string[] = [];
    let out: PayOutcome;
    let transfer = false;
    if (v?.verdict === 'DENY') {
      this.refusals.set(payee, (this.refusals.get(payee) ?? 0) + 1);
      out = { status: 'refused', payment_id: paymentId, reason: 'RegistryDeny', held_id: heldId };
      lines.push(this.vaultEvent('payment_refused', { payment_id: paymentId, payee, amount, reason: 'RegistryDeny', source: 'registry', registry_reasons: v.reasons.slice(0, 3) }));
      if (mode === 'owner') lines.push(this.vaultEvent('held_settle_failed', { held_id: heldId, reason: 'RegistryDeny', payment_id: paymentId, payee, amount, memo }));
    } else if (mode === 'request') {
      // The agent's reason is its own text; the kind is what the vault saw, whatever it says.
      const kind: HoldKind = v?.verdict === 'WARN' ? 'registry_warn' : !v && !this.known(payee) ? 'unknown_payee' : 'agent_request';
      const h = this.hold(payee, amount, memo, agentReason ?? '', paymentId, kind);
      out = h.out;
      lines.push(h.line);
    } else if (mode === 'pay' && v?.verdict === 'WARN') {
      const h = this.hold(payee, amount, memo, 'RegistryWarn', paymentId, 'registry_warn');
      out = h.out;
      lines.push(h.line);
    } else if (mode === 'pay' && !v && this.config.hold_unknown === true && !this.known(payee)) {
      const h = this.hold(payee, amount, memo, 'UnknownPayee', paymentId, 'unknown_payee');
      out = h.out;
      lines.push(h.line);
    } else {
      transfer = true;
      this.paid.set(payee, (this.paid.get(payee) ?? 0) + 1);
      this.balances.set(ACC.vault, (this.balances.get(ACC.vault) ?? 0n) - BigInt(amount));
      this.balances.set(payee, (this.balances.get(payee) ?? 0n) + BigInt(amount));
      out = { status: 'sent', payment_id: paymentId, reason: null, held_id: heldId };
      lines.push(this.vaultEvent('payment_sent', { payment_id: paymentId, payee, amount, day: '20769', by_owner: mode === 'owner', memo }));
    }
    const logs = [{ executor: ACC.vault, lines }];
    if (transfer) logs.push({ executor: TOKEN, lines: [eventLine('nep141', 'ft_transfer', [{ old_owner_id: ACC.vault, new_owner_id: payee, amount }])] });
    return { out, logs };
  }

  /** A Sender for one signer, checking a function-call key the way nearcore does. */
  sender(signerId: string, o: { functionCallKey?: boolean } = {}): Sender {
    const chain = this;
    return {
      signer: { accountId: signerId, publicKey: o.functionCallKey ? AGENT_PK : `ed25519:${signerId}` },
      reasonIfNoKey: null,
      async send(plan: TxPlan): Promise<SendResult> {
        chain.sent.push(plan);
        const first = plan.actions[0];
        if (o.functionCallKey && chain.agentPermission !== 'FullAccess') {
          const perm = chain.agentPermission.FunctionCall;
          const publicKey = AGENT_PK;
          const reject = (name: string) => ({ kind: 'rejected' as const, name, detail: null, rpcError: invalidTx(ACCESS_KEY_ERRORS[name]), signed: fakeSigned(plan, publicKey, chain.nextNonce) });
          const override = chain.rejectWith.get(first?.type === 'FunctionCall' ? first.methodName : (first?.type ?? ''));
          if (override) return reject(override);
          if (plan.actions.length !== 1 || !first || first.type !== 'FunctionCall') return reject('RequiresFullAccess');
          if (first.deposit > 0n) return reject('DepositWithFunctionCall');
          if (plan.receiverId !== perm.receiver_id) return reject('ReceiverMismatch');
          if (!perm.method_names.includes(first.methodName)) return reject('MethodNameMismatch');
        }
        // A transaction that passed validation uses its nonce.
        chain.nextNonce++;
        if (!first || first.type !== 'FunctionCall') return chain.record(signerId, plan.receiverId, null, []);
        const a = first.args as Record<string, unknown>;
        const paymentId = String(chain.nextPayment++);
        switch (first.methodName) {
          case 'pay': {
            const amount = String(a.amount);
            if (BigInt(chain.config.auto_approve_max) > 0n && BigInt(amount) > BigInt(chain.config.auto_approve_max)) {
              const out = { status: 'refused', payment_id: paymentId, reason: 'AboveAutoApprove', held_id: null };
              return chain.record(signerId, plan.receiverId, out, [{ executor: ACC.vault, lines: [chain.vaultEvent('payment_refused', { payment_id: paymentId, payee: a.payee, amount, reason: 'AboveAutoApprove', source: 'policy', registry_reasons: [] })] }]);
            }
            const { out, logs } = chain.pipeline('pay', String(a.payee), amount, (a.memo as string | null) ?? null, paymentId, null);
            return chain.record(signerId, plan.receiverId, out, logs);
          }
          case 'request_payment': {
            const { out, logs } = chain.pipeline('request', String(a.payee), String(a.amount), (a.memo as string | null) ?? null, paymentId, null, String(a.reason));
            return chain.record(signerId, plan.receiverId, out, logs);
          }
          case 'record_refusal': {
            const reason = chain.refuseRecordsWith ?? String(a.reason);
            const source = chain.refuseRecordsWith ? 'policy' : 'agent_guard';
            const out = { status: 'refused', payment_id: paymentId, reason, held_id: null };
            return chain.record(signerId, plan.receiverId, out, [{ executor: ACC.vault, lines: [chain.vaultEvent('payment_refused', { payment_id: paymentId, payee: a.payee, amount: a.amount, reason, source, registry_reasons: [] })] }]);
          }
          case 'owner_pay': {
            const h = chain.held.get(String(a.held_id));
            if (!h) throw new Error(`HeldNotFound ${String(a.held_id)}`);
            chain.held.delete(h.id);
            const { out, logs } = chain.pipeline('owner', h.payee, h.amount, h.memo, h.payment_id, h.id);
            return chain.record(signerId, plan.receiverId, out, logs);
          }
          case 'owner_reject': {
            chain.held.delete(String(a.held_id));
            return chain.record(signerId, plan.receiverId, null, [{ executor: ACC.vault, lines: [chain.vaultEvent('held_rejected', { held_id: a.held_id })] }]);
          }
          case 'set_verdict': {
            chain.setVerdict(String(a.account_id), a.verdict as RegistryVerdictView['verdict'], a.reasons as string[], typeof a.ttl_s === 'string' ? a.ttl_s : null, typeof a.evidence === 'string' ? a.evidence : null);
            return chain.record(signerId, plan.receiverId, null, [{ executor: ACC.registry, lines: [eventLine('a_identity_registry', 'verdict_set', { account_id: a.account_id, verdict: a.verdict, reasons: a.reasons, evidence: a.evidence, by: signerId })] }]);
          }
          default:
            throw new Error(`FakeChain: no method ${first.methodName}`);
        }
      },
    };
  }

  /** A guard that decides with `decisions` and routes ALLOW/WARN/DENY to pay/request_payment/
   * record_refusal through `agent`, as sdk/src/guard.ts is documented to. */
  guard(agent: Sender | null, decisions: Record<string, Decision> = demoDecisions()): GuardPort & { calls: GuardArgs[] } {
    const calls: GuardArgs[] = [];
    return {
      description: 'fake guard',
      calls,
      async verifyThenPay(args): Promise<GuardResult> {
        calls.push(args);
        const d = decisions[args.payee];
        if (!d) throw new Error(`no decision for ${args.payee}`);
        const deciding = d.reasons.find((r) => (r.severity === 'deny' || r.severity === 'warn') && !r.cleared_by)?.code ?? 'guard';
        // The gas the SDK attaches (sdk/src/chain/abi.ts, held to the vault's AGENT_PREPAID_GAS).
        const plan: TxPlan =
          d.verdict === 'ALLOW'
            ? { signerId: ACC.vault, receiverId: ACC.vault, actions: [{ type: 'FunctionCall', methodName: 'pay', args: { payee: args.payee, amount: args.amount, memo: args.memo }, gas: GAS.agentPay, deposit: 0n }] }
            : d.verdict === 'WARN'
              ? { signerId: ACC.vault, receiverId: ACC.vault, actions: [{ type: 'FunctionCall', methodName: 'request_payment', args: { payee: args.payee, amount: args.amount, memo: args.memo, reason: deciding }, gas: GAS.agentRequest, deposit: 0n }] }
              : { signerId: ACC.vault, receiverId: ACC.vault, actions: [{ type: 'FunctionCall', methodName: 'record_refusal', args: { payee: args.payee, amount: args.amount, reason: deciding }, gas: GAS.recordRefusal, deposit: 0n }] };
        const action = d.verdict === 'ALLOW' ? 'pay' : d.verdict === 'WARN' ? 'request_payment' : 'record_refusal';
        const base = {
          verdict: d.verdict,
          reasons: d.reasons.map((r) => ({ code: r.code, severity: r.severity, detail: r.detail })),
          score: d.score,
          snapshotSha256: 'cd'.repeat(32),
          block: { height: d.block.height },
          action,
          signerId: ACC.vault,
          settled: null,
          raw: { payee: args.payee },
        } as const;
        if (!agent) return { ...base, status: 'prepared', txHash: null, payOutcome: null, prepared: preparedCall(plan) };
        const r = await agent.send(plan);
        if (r.kind !== 'executed') return { ...base, status: 'error', txHash: null, payOutcome: null, prepared: null, error: r.kind };
        return { ...base, status: 'executed', txHash: r.txHash, payOutcome: null, prepared: null };
      },
    };
  }
}

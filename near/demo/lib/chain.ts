// Transactions for the demo and the oracle: plans, the exact prepared call, signing, sending,
// and reading the outcome back.
//
// Three results, never blurred into each other:
// - executed: the transaction is on chain. Its final status, every receipt, every EVENT_JSON
//   line and the vault's PayOutcome are parsed from EXPERIMENTAL_tx_status with FINAL.
// - rejected: the RPC node refused the transaction at validation (InvalidTxError), so there is
//   NO transaction on chain. The exact RPC error is kept verbatim, and so are the signed bytes
//   that were sent, so the rejection can be re-derived by anyone (the signature, what was asked,
//   the key's permission at the referenced block). A function-call key that tries an owner
//   method, a deposit, another receiver or a non-call action ends here.
// - prepared: no key was available, so nothing was signed; the exact call is returned instead.
//
// A stale nonce or block hash (InvalidNonce, Expired: an RPC node that lags behind the last
// transaction) is a rejection too, with nothing executed; the sender signs again with a fresh
// nonce and sends once more, and keeps the first try in `retries`.
//
// near-api-js 7.5.3 is only used to build and sign a transaction, and is loaded lazily, so plans,
// dry runs and every test run without it. The import specifier is a variable on purpose: the
// repository root also resolves an older near-api-js (5.x) whose API is different, and
// `loadNearApi` checks the shape it gets instead of trusting whatever resolved.

import { Buffer } from 'node:buffer';
import type { LoadedKey } from './keys.ts';
import { displayPath } from './paths.ts';
import { finalBlock, RpcAnswerError, RpcTransportError, txStatus, viewAccessKey } from './rpc.ts';
import type { JsonRpcErrorBody, RpcClient } from './rpc.ts';

// -- plans ---------------------------------------------------------------------------------

export type ActionSpec =
  | { type: 'FunctionCall'; methodName: string; args: Record<string, unknown>; gas: bigint; deposit: bigint }
  | { type: 'Transfer'; deposit: bigint }
  | { type: 'AddKey'; publicKey: string; permission: 'FullAccess' };

export type TxPlan = { signerId: string; receiverId: string; actions: ActionSpec[] };

export type PreparedCall = {
  signer_id: string;
  receiver_id: string;
  actions: Array<
    | { type: 'FunctionCall'; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }
    | { type: 'Transfer'; params: { deposit: string } }
    | { type: 'AddKey'; params: { publicKey: string; accessKey: { permission: 'FullAccess' } } }
  >;
};

export function fnCall(methodName: string, args: Record<string, unknown>, gas: bigint, deposit = 0n): ActionSpec {
  return { type: 'FunctionCall', methodName, args, gas, deposit };
}

/** The exact call, in the wallet ConnectorAction shape, with amounts as decimal strings. No key
 * material, ever. */
export function preparedCall(plan: TxPlan): PreparedCall {
  return {
    signer_id: plan.signerId,
    receiver_id: plan.receiverId,
    actions: plan.actions.map((a) => {
      if (a.type === 'FunctionCall') {
        return { type: 'FunctionCall' as const, params: { methodName: a.methodName, args: a.args, gas: a.gas.toString(), deposit: a.deposit.toString() } };
      }
      if (a.type === 'Transfer') return { type: 'Transfer' as const, params: { deposit: a.deposit.toString() } };
      return { type: 'AddKey' as const, params: { publicKey: a.publicKey, accessKey: { permission: 'FullAccess' as const } } };
    }),
  };
}

export function describePlan(plan: TxPlan): string {
  const parts = plan.actions.map((a) => {
    if (a.type === 'FunctionCall') {
      const tgas = a.gas / 1_000_000_000_000n;
      return `${a.methodName}(${JSON.stringify(a.args)}) gas ${tgas} Tgas, deposit ${a.deposit} yocto`;
    }
    if (a.type === 'Transfer') return `Transfer ${a.deposit} yoctoNEAR`;
    return `AddKey ${a.publicKey} FullAccess`;
  });
  return `${plan.signerId} -> ${plan.receiverId}: ${parts.join(' + ')}`;
}

// -- outcomes ------------------------------------------------------------------------------

export type EventRecord = { receiptId: string; executorId: string; standard: string; version: string; event: string; data: unknown };
export type ReceiptRecord = { id: string; executorId: string; status: 'SuccessValue' | 'SuccessReceiptId' | 'Failure' | 'Unknown'; failure?: unknown; logs: string[] };

export type ParsedOutcome = {
  txHash: string;
  signerId: string;
  receiverId: string;
  finalExecutionStatus: string;
  /** The transaction's final status is SuccessValue. For the vault this does NOT mean money moved:
   * a refusal is a successful call that returns status "refused". */
  success: boolean;
  /** The decoded SuccessValue (JSON), or the raw string when it is not JSON. */
  returnValue: unknown;
  failure?: unknown;
  receipts: ReceiptRecord[];
  events: EventRecord[];
  gasBurnt: bigint;
};

type RawExecOutcome = { id: string; outcome: { logs?: string[]; executor_id: string; status: Record<string, unknown> | string; gas_burnt?: number | string } };
type RawTx = {
  final_execution_status?: string;
  status?: Record<string, unknown> | string;
  transaction?: { hash: string; signer_id: string; receiver_id: string };
  transaction_outcome?: RawExecOutcome;
  receipts_outcome?: RawExecOutcome[];
};

function statusKind(s: Record<string, unknown> | string): ReceiptRecord['status'] {
  if (typeof s === 'object' && s !== null) {
    if ('SuccessValue' in s) return 'SuccessValue';
    if ('SuccessReceiptId' in s) return 'SuccessReceiptId';
    if ('Failure' in s) return 'Failure';
  }
  return 'Unknown';
}

function decodeValue(b64: unknown): unknown {
  if (typeof b64 !== 'string' || b64 === '') return null;
  const text = Buffer.from(b64, 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseEventLine(line: string): Omit<EventRecord, 'receiptId' | 'executorId'> | null {
  if (!line.startsWith('EVENT_JSON:')) return null;
  try {
    const e = JSON.parse(line.slice('EVENT_JSON:'.length)) as { standard?: unknown; version?: unknown; event?: unknown; data?: unknown };
    if (typeof e.standard !== 'string' || typeof e.event !== 'string') return null;
    return { standard: e.standard, version: typeof e.version === 'string' ? e.version : '', event: e.event, data: e.data };
  } catch {
    return null;
  }
}

export function parseOutcome(raw: unknown): ParsedOutcome {
  const tx = raw as RawTx;
  const outcomes: RawExecOutcome[] = [...(tx.transaction_outcome ? [tx.transaction_outcome] : []), ...(tx.receipts_outcome ?? [])];
  const receipts: ReceiptRecord[] = [];
  const events: EventRecord[] = [];
  let gasBurnt = 0n;
  for (const o of outcomes) {
    const logs = o.outcome.logs ?? [];
    const status = statusKind(o.outcome.status);
    const rec: ReceiptRecord = { id: o.id, executorId: o.outcome.executor_id, status, logs };
    if (status === 'Failure' && typeof o.outcome.status === 'object') rec.failure = (o.outcome.status as Record<string, unknown>).Failure;
    receipts.push(rec);
    gasBurnt += BigInt(o.outcome.gas_burnt ?? 0);
    for (const line of logs) {
      const e = parseEventLine(line);
      if (e) events.push({ receiptId: o.id, executorId: o.outcome.executor_id, ...e });
    }
  }
  const finalStatus = tx.status ?? {};
  const success = typeof finalStatus === 'object' && finalStatus !== null && 'SuccessValue' in finalStatus;
  const parsed: ParsedOutcome = {
    txHash: tx.transaction?.hash ?? tx.transaction_outcome?.id ?? '',
    signerId: tx.transaction?.signer_id ?? '',
    receiverId: tx.transaction?.receiver_id ?? '',
    finalExecutionStatus: tx.final_execution_status ?? 'UNKNOWN',
    success,
    returnValue: success ? decodeValue((finalStatus as Record<string, unknown>).SuccessValue) : null,
    receipts,
    events,
    gasBurnt,
  };
  if (typeof finalStatus === 'object' && finalStatus !== null && 'Failure' in finalStatus) parsed.failure = (finalStatus as Record<string, unknown>).Failure;
  return parsed;
}

/** The vault's receipt for every pay, request_payment, record_refusal and owner_pay. */
export type PayOutcomeJson = { status: 'sent' | 'refused' | 'held' | 'failed'; payment_id: string; reason: string | null; held_id: string | null };

export function payOutcomeOf(o: ParsedOutcome): PayOutcomeJson | null {
  const v = o.returnValue as Partial<PayOutcomeJson> | null;
  if (!v || typeof v !== 'object' || typeof v.status !== 'string') return null;
  if (!['sent', 'refused', 'held', 'failed'].includes(v.status)) return null;
  return {
    status: v.status,
    payment_id: String(v.payment_id ?? ''),
    reason: v.reason ?? null,
    held_id: v.held_id == null ? null : String(v.held_id),
  };
}

export function eventsOf(o: ParsedOutcome, standard: string, executorId?: string): EventRecord[] {
  return o.events.filter((e) => e.standard === standard && (executorId === undefined || e.executorId === executorId));
}

/** An event's data as a list of objects. near-sdk's event macro (the vault, the registry) emits
 * one object; NEP-141 tokens emit an array. */
export function eventItems(data: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(data) ? data : [data];
  return list.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x));
}

/** The vault's audit-trail events (payment_sent, payment_refused, payment_held, payment_failed,
 * held_settle_failed, ...) with their data objects. */
export function vaultEvents(o: ParsedOutcome, vaultId: string): Array<{ event: string; data: Record<string, unknown> }> {
  return eventsOf(o, 'a_identity_vault', vaultId).flatMap((e) => eventItems(e.data).map((data) => ({ event: e.event, data })));
}

/**
 * The `kind` the vault recorded on the payment_held event of payment `paymentId`: what the VAULT
 * saw (registry_warn, unknown_payee, agent_request), never the agent's words. null when the
 * transaction holds no such event, or the event has no kind (a vault build before 0.2.0).
 */
export function holdKindIn(o: ParsedOutcome, vaultId: string, paymentId: string): string | null {
  const held = vaultEvents(o, vaultId).find((e) => e.event === 'payment_held' && e.data.payment_id === paymentId);
  return held && typeof held.data.kind === 'string' ? held.data.kind : null;
}

export type FtTransfer = { executorId: string; old_owner_id: string; new_owner_id: string; amount: string; memo?: string };

/** NEP-141 ft_transfer events emitted by the token's OWN receipts. A log line printed by any other
 * contract proves nothing about a token balance. */
export function nep141Transfers(o: ParsedOutcome, tokenId: string): FtTransfer[] {
  const out: FtTransfer[] = [];
  for (const e of eventsOf(o, 'nep141', tokenId)) {
    if (e.event !== 'ft_transfer' || !Array.isArray(e.data)) continue;
    for (const d of e.data as Array<Partial<FtTransfer>>) {
      if (typeof d.old_owner_id === 'string' && typeof d.new_owner_id === 'string' && typeof d.amount === 'string') {
        out.push({ executorId: e.executorId, old_owner_id: d.old_owner_id, new_owner_id: d.new_owner_id, amount: d.amount, ...(d.memo ? { memo: d.memo } : {}) });
      }
    }
  }
  return out;
}

/** Settlement proof: the token's own receipt succeeded and logged the exact transfer. */
export function settlementSeen(o: ParsedOutcome, tokenId: string, from: string, to: string, amount: string): boolean {
  const okReceipts = new Set(o.receipts.filter((r) => r.executorId === tokenId && r.status !== 'Failure').map((r) => r.id));
  return o.events.some(
    (e) =>
      okReceipts.has(e.receiptId) &&
      e.executorId === tokenId &&
      e.standard === 'nep141' &&
      e.event === 'ft_transfer' &&
      Array.isArray(e.data) &&
      (e.data as Array<Partial<FtTransfer>>).some((d) => d.old_owner_id === from && d.new_owner_id === to && d.amount === amount),
  );
}

export function anyTransferTo(o: ParsedOutcome, tokenId: string, to: string): boolean {
  return nep141Transfers(o, tokenId).some((t) => t.new_owner_id === to);
}

// -- RPC errors ----------------------------------------------------------------------------

export type RpcErrorClass =
  | { kind: 'invalid_tx'; name: string; detail: unknown }
  | { kind: 'timeout' | 'unknown_tx' | 'other'; name: string };

function findKey(node: unknown, key: string, depth = 0): unknown {
  if (depth > 8 || node === null || typeof node !== 'object') return undefined;
  if (key in (node as Record<string, unknown>)) return (node as Record<string, unknown>)[key];
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The variant name of a nested NEAR error value: "RequiresFullAccess" for a unit variant, the
 * single key for a struct variant ({"MethodNameMismatch": {...}}). */
function variantName(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    if (keys.length === 1 && keys[0]) return keys[0];
  }
  return 'Unknown';
}

/**
 * Classify a JSON-RPC error. An INVALID_TRANSACTION carries the nearcore InvalidTxError under
 * data.TxExecutionError.InvalidTxError (the path near-api-js 7.5.3 parses); the access-key family
 * is one level deeper, under InvalidAccessKeyError, and that leaf name is what the demo reports.
 */
export function classifyRpcError(err: JsonRpcErrorBody): RpcErrorClass {
  const cause = err.cause?.name ?? err.name ?? '';
  if (cause === 'TIMEOUT_ERROR') return { kind: 'timeout', name: cause };
  if (cause === 'UNKNOWN_TRANSACTION') return { kind: 'unknown_tx', name: cause };
  const invalid = findKey(err.data, 'InvalidTxError') ?? (cause === 'INVALID_TRANSACTION' ? err.cause?.info : undefined);
  if (cause === 'INVALID_TRANSACTION' || invalid !== undefined) {
    const accessKey = findKey(invalid, 'InvalidAccessKeyError');
    if (accessKey !== undefined) {
      const name = variantName(accessKey);
      const detail = typeof accessKey === 'object' && accessKey !== null ? (accessKey as Record<string, unknown>)[name] : null;
      return { kind: 'invalid_tx', name, detail: detail ?? null };
    }
    const name = invalid !== undefined ? variantName(invalid) : 'INVALID_TRANSACTION';
    return { kind: 'invalid_tx', name, detail: invalid ?? null };
  }
  return { kind: 'other', name: cause || String(err.code ?? 'error') };
}

// -- sending -------------------------------------------------------------------------------

/** What was signed and sent for one try: the bytes, never a key. */
export type SignedTx = {
  /** borsh SignedTransaction, base64: exactly the send_tx parameter. */
  signed_tx_base64: string;
  /** The transaction hash computed locally from those bytes. For a rejected try no chain lookup
   * finds it: the transaction never reached a block. */
  local_tx_hash: string;
  sent_at: string;
  signer_id: string;
  receiver_id: string;
  public_key: string;
  nonce: string;
  block_hash: string;
};

/** A try refused for a stale nonce or block hash: nothing executed; the sender tried again. */
export type StaleTry = { name: string; rpcError: JsonRpcErrorBody; signed: SignedTx };

/** InvalidTxError variants that only say the signing inputs were stale, not that the action is
 * forbidden: signing again with a fresh nonce and block hash is the fix. */
export const STALE_TX_ERRORS: readonly string[] = ['InvalidNonce', 'Expired'];

export type SendResult =
  | { kind: 'executed'; txHash: string; outcome: ParsedOutcome; retries?: StaleTry[] }
  | { kind: 'rejected'; name: string; detail: unknown; rpcError: JsonRpcErrorBody; signed?: SignedTx; retries?: StaleTry[] }
  | { kind: 'prepared'; reason: string; prepared: PreparedCall }
  | { kind: 'unconfirmed'; txHash: string; reason: string; retries?: StaleTry[] };

export type Sender = {
  /** Who signs, for the log: account and public key, never the secret. */
  readonly signer: { accountId: string; publicKey: string } | null;
  readonly reasonIfNoKey: string | null;
  send(plan: TxPlan): Promise<SendResult>;
};

/** The near-api-js 7.5.3 surface this module uses, checked at load time. */
export type NearApi = {
  createTransaction(signerId: string, publicKey: unknown, receiverId: string, nonce: bigint, actions: unknown[], blockHash: Uint8Array): unknown;
  KeyPairSigner: {
    fromSecretKey(secret: string): {
      getPublicKey(): Promise<{ toString(): string }>;
      signTransaction(tx: unknown): Promise<{ txHash: Uint8Array; signedTransaction: { encode(): Uint8Array } }>;
    };
  };
  PublicKey: { fromString(s: string): unknown };
  KeyPair: { fromRandom(curve: string): { getPublicKey(): { toString(): string } } };
  actions: {
    functionCall(methodName: string, args: object, gas: bigint, deposit: bigint): unknown;
    transfer(deposit: bigint): unknown;
    addFullAccessKey(publicKey: unknown): unknown;
  };
  baseDecode(s: string): Uint8Array;
  baseEncode(b: Uint8Array): string;
};

let cachedNearApi: NearApi | null = null;

export async function loadNearApi(): Promise<NearApi> {
  if (cachedNearApi) return cachedNearApi;
  const spec = 'near-api-js';
  let mod: Record<string, unknown>;
  try {
    mod = (await import(spec)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`near-api-js is not installed (${(e as Error).message}); run npm ci in near/`);
  }
  const api = mod as unknown as Partial<NearApi>;
  const ok =
    typeof api.createTransaction === 'function' &&
    typeof api.KeyPairSigner?.fromSecretKey === 'function' &&
    typeof api.PublicKey?.fromString === 'function' &&
    typeof api.KeyPair?.fromRandom === 'function' &&
    typeof api.actions?.functionCall === 'function' &&
    typeof api.actions?.transfer === 'function' &&
    typeof api.actions?.addFullAccessKey === 'function' &&
    typeof api.baseDecode === 'function' &&
    typeof api.baseEncode === 'function';
  if (!ok) {
    throw new Error('the near-api-js that resolved is not 7.x (no createTransaction/KeyPairSigner/actions); run npm ci in near/ so near/node_modules wins over the repository root');
  }
  cachedNearApi = api as NearApi;
  return cachedNearApi;
}

/** A fresh ed25519 public key whose secret is dropped on the spot: the key the forbidden AddKey
 * attempt asks for. Nobody can ever sign with it, even if the attempt had landed. */
export async function freshOrphanPublicKey(): Promise<string> {
  const near = await loadNearApi();
  return near.KeyPair.fromRandom('ed25519').getPublicKey().toString();
}

export type SenderOptions = {
  /** How long to poll for a FINAL status after sending. */
  finalTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  nearApi?: NearApi;
  /** The clock for `sent_at`. */
  now?: () => Date;
};

/** The access key's nonce an InvalidNonce error reports ({"InvalidNonce": {tx_nonce, ak_nonce}}). */
export function akNonceOf(detail: unknown): bigint | null {
  const v = findKey(detail, 'ak_nonce');
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function noKeySender(reason: string): Sender {
  return {
    signer: null,
    reasonIfNoKey: reason,
    async send(plan) {
      return { kind: 'prepared', reason, prepared: preparedCall(plan) };
    },
  };
}

export function keySender(rpc: RpcClient, key: LoadedKey, opts: SenderOptions = {}): Sender {
  const sleep = opts.sleep ?? sleepMs;
  const now = opts.now ?? (() => new Date());
  const finalTimeoutMs = opts.finalTimeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 1_500;
  let lastNonce = 0n;

  async function waitFinal(txHash: string, signerId: string): Promise<unknown | null> {
    const deadline = Date.now() + finalTimeoutMs;
    while (Date.now() < deadline) {
      try {
        return await txStatus(rpc, txHash, signerId, 'FINAL');
      } catch (e) {
        if (e instanceof RpcAnswerError) {
          const c = classifyRpcError(e.rpcError);
          if (c.kind !== 'timeout' && c.kind !== 'unknown_tx') throw e;
        } else if (!(e instanceof RpcTransportError)) {
          throw e;
        }
      }
      await sleep(pollMs);
    }
    return null;
  }

  return {
    signer: { accountId: key.accountId, publicKey: key.publicKey },
    reasonIfNoKey: null,
    async send(plan) {
      if (plan.signerId !== key.accountId) {
        throw new Error(`plan is signed by ${plan.signerId} but the loaded key belongs to ${key.accountId}`);
      }
      const near = opts.nearApi ?? (await loadNearApi());
      const signer = near.KeyPairSigner.fromSecretKey(key.secret());
      const derived = (await signer.getPublicKey()).toString();
      if (derived !== key.publicKey) {
        throw new Error(`key file ${displayPath(key.path)} says ${key.publicKey} but its secret derives ${derived}`);
      }
      const stale: StaleTry[] = [];
      const withRetries = () => (stale.length > 0 ? { retries: stale } : {});
      let nonceFloor = lastNonce;
      // At most two tries: the second only after a stale nonce or block hash, which executed nothing.
      for (let attempt = 0; ; attempt++) {
        const ak = await viewAccessKey(rpc, key.accountId, key.publicKey, 'optimistic');
        const nonce = (ak.nonce > nonceFloor ? ak.nonce : nonceFloor) + 1n;
        const block = await finalBlock(rpc);
        const built = plan.actions.map((a) => {
          if (a.type === 'FunctionCall') return near.actions.functionCall(a.methodName, a.args, a.gas, a.deposit);
          if (a.type === 'Transfer') return near.actions.transfer(a.deposit);
          return near.actions.addFullAccessKey(near.PublicKey.fromString(a.publicKey));
        });
        const tx = near.createTransaction(key.accountId, near.PublicKey.fromString(key.publicKey), plan.receiverId, nonce, built, near.baseDecode(block.hash));
        const { txHash, signedTransaction } = await signer.signTransaction(tx);
        const hash = near.baseEncode(txHash);
        const signed: SignedTx = {
          signed_tx_base64: Buffer.from(signedTransaction.encode()).toString('base64'),
          local_tx_hash: hash,
          sent_at: now().toISOString(),
          signer_id: key.accountId,
          receiver_id: plan.receiverId,
          public_key: key.publicKey,
          nonce: nonce.toString(),
          block_hash: block.hash,
        };
        try {
          await rpc.call<unknown>('send_tx', { signed_tx_base64: signed.signed_tx_base64, wait_until: 'EXECUTED_OPTIMISTIC' }, 'send');
        } catch (e) {
          if (e instanceof RpcAnswerError) {
            const c = classifyRpcError(e.rpcError);
            // Rejected at validation: the nonce was not used and nothing is on chain.
            if (c.kind === 'invalid_tx') {
              if (attempt === 0 && STALE_TX_ERRORS.includes(c.name)) {
                stale.push({ name: c.name, rpcError: e.rpcError, signed });
                const reported = akNonceOf(c.detail);
                if (reported !== null && reported > nonceFloor) nonceFloor = reported;
                continue;
              }
              return { kind: 'rejected', name: c.name, detail: c.detail, rpcError: e.rpcError, signed, ...withRetries() };
            }
            if (c.kind !== 'timeout') throw e;
          } else if (!(e instanceof RpcTransportError)) {
            throw e;
          }
          // A timeout or a lost connection: the transaction may still land. Poll, never resend.
        }
        lastNonce = nonce;
        const final = await waitFinal(hash, key.accountId);
        if (final === null) return { kind: 'unconfirmed', txHash: hash, reason: `no FINAL status within ${Math.round(finalTimeoutMs / 1000)} s`, ...withRetries() };
        return { kind: 'executed', txHash: hash, outcome: parseOutcome(final), ...withRetries() };
      }
    },
  };
}

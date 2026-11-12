// What a transaction actually did, read from the chain: its final status, every receipt, every
// NEP-297 event, the vault's PayOutcome, and a settlement proof.
//
// The rule, as on A-Identity's EIP-3009 rail: nothing is called settled without a receipt. Here
// that means the token contract's OWN receipt succeeded and emitted a NEP-141 ft_transfer from
// the vault to the payee for the exact amount, and the vault's own receipt emitted payment_sent.
// An event only counts when the account that emitted it is the account it speaks for: a
// nep141 event logged by any other contract is ignored, because any contract can log any text.

import type { RpcReader } from "../collect/rpc.ts";
import { RpcAnswerError, RpcUnavailableError } from "../collect/rpc.ts";
import { isVaultError, parseHoldKind, VAULT_EVENT_STANDARD, type HoldKind, type VaultError } from "./abi.ts";

export type NearEvent = {
  standard: string;
  version: string;
  event: string;
  data: unknown;
  receipt_id: string;
  /** The account whose receipt logged it: the only account it can speak for. */
  executor_id: string;
};

export type ReceiptAction =
  | { kind: "function_call"; method: string; args: unknown; deposit: string; gas: string }
  | { kind: "transfer"; deposit: string }
  | { kind: "other"; name: string };

export type ReceiptView = {
  id: string;
  executor_id: string;
  predecessor_id: string | null;
  succeeded: boolean;
  /** Base64 return value for SuccessValue, null otherwise. */
  return_base64: string | null;
  failure: unknown;
  logs: string[];
  events: NearEvent[];
  /** From the receipts list; empty when the RPC answer did not include it. */
  actions: ReceiptAction[];
  gas_burnt: number;
};

export type TxOutcome = {
  tx_hash: string;
  signer_id: string;
  receiver_id: string;
  final_execution_status: string | null;
  /** The transaction's final status is SuccessValue. A refusal by the vault is still a success. */
  succeeded: boolean;
  failure: unknown;
  /** The decoded JSON return value, undefined when there is none or it is not JSON. */
  return_value: unknown;
  receipts: ReceiptView[];
  events: NearEvent[];
  gas_burnt_tgas: number;
};

export type PayStatus = "sent" | "refused" | "held" | "failed";

/** The vault's receipt for every pay, request_payment, record_refusal and owner_pay. */
export type PayOutcome = { status: PayStatus; payment_id: string; reason: string | null; held_id: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function base64ToText(b64: string): string | null {
  try {
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeJson(b64: string): unknown {
  if (b64 === "") return undefined;
  const text = base64ToText(b64);
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** One log line to an event, or null when it is not a well-formed EVENT_JSON line. */
export function parseEventLine(line: string, receiptId: string, executorId: string): NearEvent | null {
  if (!line.startsWith("EVENT_JSON:")) return null;
  let v: unknown;
  try {
    v = JSON.parse(line.slice("EVENT_JSON:".length));
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.standard !== "string" || typeof v.version !== "string" || typeof v.event !== "string") return null;
  return { standard: v.standard, version: v.version, event: v.event, data: v.data, receipt_id: receiptId, executor_id: executorId };
}

function parseActions(receipt: unknown): ReceiptAction[] {
  const action = isObj(receipt) && isObj(receipt.Action) ? receipt.Action : null;
  if (!action || !Array.isArray(action.actions)) return [];
  return action.actions.map((a): ReceiptAction => {
    if (isObj(a) && isObj(a.FunctionCall)) {
      const fc = a.FunctionCall;
      return {
        kind: "function_call",
        method: String(fc.method_name),
        args: typeof fc.args === "string" ? decodeJson(fc.args) : undefined,
        deposit: String(fc.deposit ?? "0"),
        gas: String(fc.gas ?? "0"),
      };
    }
    if (isObj(a) && isObj(a.Transfer)) return { kind: "transfer", deposit: String(a.Transfer.deposit ?? "0") };
    return { kind: "other", name: typeof a === "string" ? a : isObj(a) ? (Object.keys(a)[0] ?? "unknown") : "unknown" };
  });
}

/** Parse an EXPERIMENTAL_tx_status (or send_tx) answer. Throws on a shape that is not a tx outcome. */
export function parseOutcome(raw: unknown): TxOutcome {
  if (!isObj(raw) || !isObj(raw.transaction) || !isObj(raw.transaction_outcome) || !Array.isArray(raw.receipts_outcome)) {
    throw new TypeError("not a transaction outcome: missing transaction, transaction_outcome or receipts_outcome");
  }
  const tx = raw.transaction;
  const byReceipt = new Map<string, { predecessor: string | null; actions: ReceiptAction[] }>();
  if (Array.isArray(raw.receipts)) {
    for (const r of raw.receipts) {
      if (!isObj(r) || typeof r.receipt_id !== "string") continue;
      byReceipt.set(r.receipt_id, { predecessor: typeof r.predecessor_id === "string" ? r.predecessor_id : null, actions: parseActions(r.receipt) });
    }
  }
  let gas = 0;
  const outcomeOf = (o: unknown) => (isObj(o) && isObj(o.outcome) ? o.outcome : {});
  const txOut = outcomeOf(raw.transaction_outcome);
  gas += typeof txOut.gas_burnt === "number" ? txOut.gas_burnt : 0;

  const receipts: ReceiptView[] = raw.receipts_outcome.map((ro) => {
    const id = isObj(ro) && typeof ro.id === "string" ? ro.id : "";
    const out = outcomeOf(ro);
    const executor = typeof out.executor_id === "string" ? out.executor_id : "";
    const status = isObj(out.status) ? out.status : {};
    const logs = Array.isArray(out.logs) ? out.logs.filter((l): l is string => typeof l === "string") : [];
    const burnt = typeof out.gas_burnt === "number" ? out.gas_burnt : 0;
    gas += burnt;
    const extra = byReceipt.get(id);
    return {
      id,
      executor_id: executor,
      predecessor_id: extra?.predecessor ?? null,
      succeeded: "SuccessValue" in status || "SuccessReceiptId" in status,
      return_base64: typeof status.SuccessValue === "string" ? status.SuccessValue : null,
      failure: "Failure" in status ? status.Failure : null,
      logs,
      events: logs.map((l) => parseEventLine(l, id, executor)).filter((e): e is NearEvent => e !== null),
      actions: extra?.actions ?? [],
      gas_burnt: burnt,
    };
  });
  const status = isObj(raw.status) ? raw.status : {};
  return {
    tx_hash: typeof tx.hash === "string" ? tx.hash : "",
    signer_id: typeof tx.signer_id === "string" ? tx.signer_id : "",
    receiver_id: typeof tx.receiver_id === "string" ? tx.receiver_id : "",
    final_execution_status: typeof raw.final_execution_status === "string" ? raw.final_execution_status : null,
    succeeded: typeof status.SuccessValue === "string",
    failure: "Failure" in status ? status.Failure : null,
    return_value: typeof status.SuccessValue === "string" ? decodeJson(status.SuccessValue) : undefined,
    receipts,
    events: receipts.flatMap((r) => r.events),
    gas_burnt_tgas: Math.round((gas / 1e12) * 100) / 100,
  };
}

/** Events of one standard, emitted by one account only. */
export function eventsFrom(outcome: TxOutcome, standard: string, emitter: string): NearEvent[] {
  return outcome.events.filter((e) => e.standard === standard && e.executor_id === emitter);
}

const PAY_STATUSES = new Set(["sent", "refused", "held", "failed"]);

/** The vault's PayOutcome from the transaction's return value, validated, or null. */
export function payOutcomeOf(outcome: TxOutcome): PayOutcome | null {
  const v = outcome.return_value;
  if (!isObj(v) || typeof v.status !== "string" || !PAY_STATUSES.has(v.status) || typeof v.payment_id !== "string") return null;
  return {
    status: v.status as PayStatus,
    payment_id: v.payment_id,
    reason: typeof v.reason === "string" ? v.reason : null,
    held_id: typeof v.held_id === "string" ? v.held_id : null,
  };
}

/** The vault event that matches a PayOutcome (payment_sent, payment_refused, payment_held or payment_failed). */
export function vaultEventFor(outcome: TxOutcome, vaultId: string, pay: PayOutcome): NearEvent | null {
  const name = { sent: "payment_sent", refused: "payment_refused", held: "payment_held", failed: "payment_failed" }[pay.status];
  return (
    eventsFrom(outcome, VAULT_EVENT_STANDARD, vaultId).find(
      (e) => e.event === name && isObj(e.data) && e.data.payment_id === pay.payment_id,
    ) ?? null
  );
}

/**
 * What the vault itself saw when it held a payment, from its payment_held event (vault 0.2.0
 * on): registry_warn, unknown_payee or agent_request. Null for any other event, and for a
 * payment_held without a kind this SDK knows (an earlier build writes none). The event's
 * `reason` is the vault's code for a held pay but the agent's own words for a request, so the
 * kind, not the reason, says why a payment waits.
 */
export function holdKindOf(event: NearEvent | null | undefined): HoldKind | null {
  if (!event || event.event !== "payment_held" || event.standard !== VAULT_EVENT_STANDARD || !isObj(event.data)) return null;
  return parseHoldKind(event.data.kind);
}

/**
 * The stable name a contract panicked with ("Smart contract panicked: NotAgent" gives
 * "NotAgent"), from a failure as the RPC serializes it, or null when the failure is not a
 * contract panic (an exceeded prepaid gas, a missing method, an action error of the protocol).
 */
export function panicNameOf(failure: unknown): string | null {
  if (failure === null || failure === undefined) return null;
  const text = typeof failure === "string" ? failure : JSON.stringify(failure);
  const m = /Smart contract panicked: ([A-Za-z][A-Za-z0-9_]*)/.exec(text);
  return m ? m[1]! : null;
}

/**
 * The vault error a failed transaction carries, if one does: the transaction's own failure, or
 * else the first failed receipt the vault executed. Every vault panic is exactly an error name
 * (error.rs), so a name outside VAULT_ERRORS is not the vault speaking. A refusal of an
 * authenticated agent is not a failure at all: it is PayOutcome.reason (payOutcomeOf).
 */
export function vaultErrorOf(outcome: TxOutcome, vaultId: string): VaultError | null {
  const candidates = [outcome.failure, ...outcome.receipts.filter((r) => r.executor_id === vaultId && r.failure !== null).map((r) => r.failure)];
  for (const f of candidates) {
    const name = panicNameOf(f);
    if (isVaultError(name)) return name;
  }
  return null;
}

export type SettlementCheck = { name: string; ok: boolean; detail: string };
export type Settlement = { settled: boolean; checks: SettlementCheck[] };

/**
 * Settled means all of: the transaction succeeded; the vault returned status "sent"; the vault's
 * own receipt emitted payment_sent for this payee and amount; and the TOKEN's own receipt
 * succeeded, was an ft_transfer called by the vault (when the receipt list is present), and
 * emitted a nep141 ft_transfer from the vault to the payee for exactly this amount.
 */
export function proveSettlement(outcome: TxOutcome, expect: { tokenId: string; vaultId: string; payee: string; amount: string }): Settlement {
  const checks: SettlementCheck[] = [];
  checks.push({ name: "tx_succeeded", ok: outcome.succeeded, detail: outcome.succeeded ? "final status SuccessValue" : `final status failure: ${JSON.stringify(outcome.failure)}` });

  const pay = payOutcomeOf(outcome);
  checks.push({ name: "vault_returned_sent", ok: pay?.status === "sent", detail: pay ? `PayOutcome status ${pay.status}${pay.reason ? ` (${pay.reason})` : ""}` : "no PayOutcome in the return value" });

  const sent = eventsFrom(outcome, "a_identity_vault", expect.vaultId).find(
    (e) => e.event === "payment_sent" && isObj(e.data) && e.data.payee === expect.payee && e.data.amount === expect.amount,
  );
  checks.push({ name: "vault_event", ok: Boolean(sent), detail: sent ? `payment_sent in receipt ${sent.receipt_id}` : `no payment_sent from ${expect.vaultId} for ${expect.payee} and ${expect.amount}` });

  const tokenReceipt = outcome.receipts.find((r) => {
    if (r.executor_id !== expect.tokenId || !r.succeeded || r.return_base64 === null) return false;
    if (r.actions.length > 0) {
      const call = r.actions.find((a) => a.kind === "function_call" && a.method === "ft_transfer");
      if (!call || r.predecessor_id !== expect.vaultId) return false;
    }
    return r.events.some(
      (e) =>
        e.standard === "nep141" &&
        e.event === "ft_transfer" &&
        Array.isArray(e.data) &&
        e.data.some((d) => isObj(d) && d.old_owner_id === expect.vaultId && d.new_owner_id === expect.payee && d.amount === expect.amount),
    );
  });
  checks.push({
    name: "token_transfer",
    ok: Boolean(tokenReceipt),
    detail: tokenReceipt
      ? `receipt ${tokenReceipt.id} on ${expect.tokenId}: SuccessValue with nep141 ft_transfer ${expect.vaultId} -> ${expect.payee} ${expect.amount}`
      : `no successful ${expect.tokenId} receipt with a nep141 ft_transfer ${expect.vaultId} -> ${expect.payee} for exactly ${expect.amount}`,
  });
  return { settled: checks.every((c) => c.ok), checks };
}

export class TxPendingError extends Error {
  readonly txHash: string;
  constructor(txHash: string, waitedMs: number) {
    super(`transaction ${txHash} was not final after ${Math.round(waitedMs / 1000)} s; check it later on archival RPC`);
    this.name = "TxPendingError";
    this.txHash = txHash;
  }
}

/**
 * Poll EXPERIMENTAL_tx_status (the method every provider accepts, dRPC included) with
 * wait_until NONE until the transaction is FINAL. Polling instead of a server-side FINAL wait
 * avoids nearcore's 10 s deadline on a multi-hop payment (vault, registry, token, callbacks).
 * An unknown transaction is retried until the deadline: it may not have reached the node yet.
 */
export async function waitFinal(
  reader: RpcReader,
  args: { txHash: string; senderId: string; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<TxOutcome> {
  const timeoutMs = args.timeoutMs ?? 90_000;
  const pollMs = args.pollMs ?? 1_500;
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = args.now ?? (() => Date.now());
  const start = now();
  for (;;) {
    try {
      const { result } = await reader.call("EXPERIMENTAL_tx_status", { tx_hash: args.txHash, sender_account_id: args.senderId, wait_until: "NONE" });
      if (isObj(result) && result.final_execution_status === "FINAL" && isObj(result.transaction)) return parseOutcome(result);
    } catch (e) {
      const transient = e instanceof RpcUnavailableError || (e instanceof RpcAnswerError && e.causeName === "UNKNOWN_TRANSACTION");
      if (!transient) throw e;
    }
    if (now() - start >= timeoutMs) throw new TxPendingError(args.txHash, now() - start);
    await sleep(pollMs);
  }
}

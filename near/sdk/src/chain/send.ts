// Prepared or executed, never in between.
//
// Without a key, a write returns the exact transaction it would send (signer, receiver, method,
// arguments, gas, deposit), in the action shape NEAR wallets accept, labeled "prepared". With a
// key it signs, computes the transaction hash locally (so a send timeout never loses it),
// submits, and polls the chain until the transaction is FINAL. A transaction the network
// refuses at validation (a function-call key used outside its scope, a deposit from a
// function-call key, an exhausted allowance) is reported as "rejected": nothing was included on
// chain, so it is never presented as an on-chain refusal.
//
// Anything else that goes wrong after the transaction left this process (nearcore's 10 s
// deadline, which arrives as HTTP 408, a 5xx, a dropped connection, a node's internal error) says
// nothing about whether it was delivered: it may already be included, or still be waiting in a
// mempool while its block hash is valid. So the hash is polled for the full timeout and the
// result is "executed" or "pending", never "rejected": only a decided answer from the chain can
// say a transaction is not there, and an agent that wrongly believed it could pay twice.
//
// Gas is always explicit: near-api-js's actions.functionCall defaults it to 0.

import { Account, JsonRpcProvider, actions, baseEncode, encodeTransaction, teraToGas } from "near-api-js";
import { InvalidNonceError, InvalidTransactionError, RequestValidationError, TransactionExecutionError } from "near-api-js/rpc-errors";
import { archivalTxCurl, explorerTxUrl, NETWORKS } from "../collect/networks.ts";
import type { RpcReader } from "../collect/rpc.ts";
import { sha256 } from "../engine/canonical.ts";
import type { Network } from "../engine/types.ts";
import type { LoadedKey } from "./keys.ts";
import { TxPendingError, waitFinal, type TxOutcome } from "./outcome.ts";

export type Call = {
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  /** Prepaid gas in Tgas. An agent key's allowance holds 0.001 NEAR per Tgas of it upfront. */
  gasTgas: number;
  /** yoctoNEAR as a decimal string. A function-call key can only send "0". */
  deposit: string;
};

/** The wallet action shape (NEAR Connect and near-api-js both accept it). */
export type ConnectorAction = {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
};

export type Prepared = {
  status: "prepared";
  signer_id: string;
  receiver_id: string;
  actions: ConnectorAction[];
  note: string;
};

export type Links = { explorer: string; archival_curl: string };

export type Executed = { status: "executed"; tx_hash: string; signer_id: string; receiver_id: string; outcome: TxOutcome; links: Links };
export type Pending = { status: "pending"; tx_hash: string; signer_id: string; receiver_id: string; note: string; links: Links };
export type Rejected = { status: "rejected"; signer_id: string; receiver_id: string; error: string; message: string; note: string };
export type SendResult = Executed | Pending | Rejected;

export function prepare(signerId: string, call: Call, why = "no signing key loaded"): Prepared {
  return {
    status: "prepared",
    signer_id: signerId,
    receiver_id: call.receiverId,
    actions: [
      {
        type: "FunctionCall",
        params: { methodName: call.methodName, args: call.args, gas: teraToGas(call.gasTgas).toString(), deposit: call.deposit },
      },
    ],
    note: `not sent (${why}): this is the exact transaction; sign it as ${signerId} and send it unchanged`,
  };
}

export type Sender = {
  network: Network;
  /** The account the transaction is signed as. For an agent key that is the VAULT account. */
  signerId: string;
  key: LoadedKey;
  reader: RpcReader;
  /** One provider for writes, so near-api-js nonce handling is not split across nodes. */
  rpcUrl?: string;
  timeoutMs?: number;
  /** Injected provider (tests); default: a JsonRpcProvider on rpcUrl or the network's first RPC. */
  provider?: Pick<JsonRpcProvider, "viewAccessKey" | "viewBlock" | "sendTransactionUntil">;
  sleep?: (ms: number) => Promise<void>;
};

function links(network: Network, txHash: string, signerId: string): Links {
  return { explorer: explorerTxUrl(network, txHash), archival_curl: archivalTxCurl(network, txHash, signerId) };
}

function errorName(e: unknown): string {
  if (e instanceof Error) return e.constructor.name !== "Error" ? e.constructor.name : e.name;
  return "Error";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function rejected(sender: Sender, call: Call, e: unknown, note: string): Rejected {
  return {
    status: "rejected",
    signer_id: sender.signerId,
    receiver_id: call.receiverId,
    error: errorName(e),
    message: message(e),
    note,
  };
}

/**
 * True only for nearcore's decided refusals of the transaction itself: INVALID_TRANSACTION
 * (near-api-js parses its InvalidTxError details into TransactionExecutionError subclasses:
 * a bad nonce, the key's receiver or method, a deposit from a function-call key, the
 * allowance, an expired block hash) and a request the node could not parse. A refused
 * transaction was never accepted, so nothing of it can be included later. Everything else,
 * TransactionTimeoutError and internal errors included, is NOT a refusal.
 */
export function refusedAtValidation(e: unknown): boolean {
  return e instanceof InvalidTransactionError || e instanceof TransactionExecutionError || e instanceof RequestValidationError;
}

/** A transaction may live this many blocks after the block it references (nearcore genesis). */
const VALIDITY_NOTE = "a transaction can still be included for 86400 blocks (about half a day at testnet's 0.6 s) after the block it references";

export async function send(sender: Sender, call: Call): Promise<SendResult> {
  const provider = (sender.provider ??
    new JsonRpcProvider({ url: sender.rpcUrl ?? NETWORKS[sender.network].rpc[0]! }, { retries: 2, wait: 500, backoff: 1.5 })) as JsonRpcProvider;
  const action = actions.functionCall(call.methodName, call.args, teraToGas(call.gasTgas), BigInt(call.deposit));
  let txHash = "";
  // Set when the send itself failed without a decided refusal: the transaction may be out there.
  let sendError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // A fresh Account per attempt re-reads the access key nonce from the chain.
    const account = new Account(sender.signerId, provider, sender.key.signer);
    let signed;
    try {
      signed = await account.createSignedTransaction({ receiverId: call.receiverId, actions: [action] });
    } catch (e) {
      return rejected(sender, call, e, "could not build the transaction (is this key an access key of the signer?); nothing was sent");
    }
    txHash = baseEncode(sha256(encodeTransaction(signed.transaction)));
    try {
      await provider.sendTransactionUntil(signed, "INCLUDED_FINAL");
      break;
    } catch (e) {
      // A stale nonce is a decided refusal of this transaction: sign once more with a fresh one.
      if (e instanceof InvalidNonceError && attempt === 0) continue;
      if (refusedAtValidation(e)) return rejected(sender, call, e, "refused at validation: no transaction was included on chain");
      // Not a refusal (a timeout, HTTP 408 or 5xx, a dropped connection, an internal error):
      // never sign again, look for THIS hash.
      sendError = e;
      break;
    }
  }
  const base = { tx_hash: txHash, signer_id: sender.signerId, receiver_id: call.receiverId, links: links(sender.network, txHash, sender.signerId) };
  const failedSend = sendError === null ? "" : `the send ended with ${errorName(sendError)} (${message(sendError)}), which does not say whether it was delivered; `;
  try {
    const outcome = await waitFinal(sender.reader, {
      txHash,
      senderId: sender.signerId,
      timeoutMs: sender.timeoutMs ?? 90_000,
      ...(sender.sleep ? { sleep: sender.sleep } : {}),
    });
    return { status: "executed", ...base, outcome };
  } catch (e) {
    // Not final yet, or its status could not be read: the hash is the handle, and nothing here
    // proves the transaction absent. Check it before sending again.
    const why = e instanceof TxPendingError ? e.message : `its status could not be read (${errorName(e)}: ${message(e)})`;
    return { status: "pending", ...base, note: `${failedSend}${why}; ${VALIDITY_NOTE}, so check this hash before sending again` };
  }
}

/** A read-only view at the final block, decoded from JSON. Option::None arrives as null. */
export async function viewFunction<T>(reader: RpcReader, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const bytes = new TextEncoder().encode(JSON.stringify(args));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const { result } = await reader.call("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: btoa(binary),
  });
  const raw = (result as { result?: number[] } | null)?.result;
  if (!Array.isArray(raw)) throw new TypeError(`${contractId}.${method} returned no result bytes`);
  if (raw.length === 0) return undefined as T;
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(raw))) as T;
}

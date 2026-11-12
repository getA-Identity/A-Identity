// The executed path of send(), with a fake provider (no network, nothing is sent): the hash we
// compute locally must equal near-api-js's own, every outcome the network can give must map to
// executed, rejected or pending, and a refusal at validation must never look like an on-chain one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseEncode, KeyPair, KeyPairSigner, TypedError, type SignedTransaction } from "near-api-js";
import { InternalRpcError, InvalidNonceError, InvalidTransactionError, RpcRequestParseError, TransactionTimeoutError } from "near-api-js/rpc-errors";
import { keyFromSecret } from "../src/chain/keys.ts";
import { refusedAtValidation, send, type Sender } from "../src/chain/send.ts";
import { RpcAnswerError } from "../src/collect/rpc.ts";
import { noSleep, stubReader, VAULT, vaultPayTx } from "./helpers.ts";

/**
 * near-api-js 7.5.3 turns HTTP 408 (nearcore's send_tx deadline), 500, 502 and 503 into its
 * internal ProviderError (not exported) with the status as `cause`, after its own retries.
 */
class ProviderErrorLike extends Error {
  constructor(message: string, status: number) {
    super(message, { cause: status });
    this.name = "ProviderError";
  }
}

const BLOCK_HASH = "3LerCNmMVyVpip6XXANLXaNmQqqvL6HQ8zbzMhCg1KBZ";
const call = { receiverId: VAULT, methodName: "pay", args: { payee: "aid-demo-merchant.testnet", amount: "250000", memo: null }, gasTgas: 73, deposit: "0" };

function fakeProvider(onSend: (signed: SignedTransaction, attempt: number) => unknown) {
  let attempt = 0;
  const sent: SignedTransaction[] = [];
  return {
    sent,
    provider: {
      viewAccessKey: async () => ({ nonce: 277000000000005n, permission: "FullAccess", block_hash: BLOCK_HASH, block_height: 1 }) as never,
      viewBlock: async () => ({ header: { hash: BLOCK_HASH } }) as never,
      sendTransactionUntil: async (signed: SignedTransaction) => {
        sent.push(signed);
        return onSend(signed, attempt++) as never;
      },
    },
  };
}

function finalFor(hash: string) {
  const tx = vaultPayTx({ outcome: "sent" }) as { transaction: { hash: string }; transaction_outcome: { id: string } };
  tx.transaction.hash = hash;
  tx.transaction_outcome.id = hash;
  return tx;
}

function sender(over: Partial<Sender>, pair = KeyPair.fromRandom("ed25519")): Sender {
  return { network: "testnet", signerId: VAULT, key: keyFromSecret(pair.toString()), reader: stubReader(() => null), sleep: noSleep, ...over };
}

describe("send", () => {
  it("signs as the vault with explicit gas and no deposit; the local hash equals near-api-js's own", async () => {
    const pair = KeyPair.fromRandom("ed25519");
    const { provider, sent } = fakeProvider(() => ({ final_execution_status: "INCLUDED_FINAL" }));
    let polledHash = "";
    const reader = stubReader((method, params) => {
      assert.equal(method, "EXPERIMENTAL_tx_status");
      assert.equal(params.sender_account_id, VAULT);
      polledHash = String(params.tx_hash);
      return finalFor(polledHash);
    });
    const r = await send(sender({ provider, reader }, pair), call);
    assert.equal(r.status, "executed");
    if (r.status !== "executed") return;
    const signed = sent[0]!;
    assert.equal(signed.transaction.signerId, VAULT);
    const fc = signed.transaction.actions[0]!.functionCall!;
    assert.equal(fc.methodName, "pay");
    assert.equal(fc.gas, 73_000_000_000_000n);
    assert.equal(fc.deposit, 0n);
    const reference = await new KeyPairSigner(pair).signTransaction(signed.transaction);
    assert.equal(r.tx_hash, baseEncode(reference.txHash));
    assert.equal(polledHash, r.tx_hash);
    assert.match(r.links.explorer, new RegExp(`/txns/${r.tx_hash}$`));
    assert.match(r.links.archival_curl, /EXPERIMENTAL_tx_status/);
  });

  it("a validation error is 'rejected': nothing on chain, and no polling", async () => {
    const { provider } = fakeProvider(() => {
      throw new InvalidTransactionError();
    });
    let polled = false;
    const r = await send(sender({ provider, reader: stubReader(() => ((polled = true), null)) }), call);
    assert.equal(r.status, "rejected");
    assert.equal(polled, false);
    assert.ok(r.status === "rejected" && /no transaction was included/.test(r.note));
  });

  it("a send timeout still polls the locally computed hash to FINAL", async () => {
    const { provider } = fakeProvider(() => {
      throw new TransactionTimeoutError();
    });
    const r = await send(sender({ provider, reader: stubReader((_m, p) => finalFor(String(p.tx_hash))) }), call);
    assert.equal(r.status, "executed");
  });

  it("retries once with a fresh nonce on an invalid-nonce answer", async () => {
    const { provider, sent } = fakeProvider((_s, attempt) => {
      if (attempt === 0) throw new InvalidNonceError(1, 1, "h", "b");
      return {};
    });
    const r = await send(sender({ provider, reader: stubReader((_m, p) => finalFor(String(p.tx_hash))) }), call);
    assert.equal(r.status, "executed");
    assert.equal(sent.length, 2);
  });

  it("a transaction that never turns final is 'pending', with its hash and links", async () => {
    const { provider } = fakeProvider(() => ({}));
    const reader = stubReader(() => {
      throw new RpcAnswerError("HANDLER_ERROR", "UNKNOWN_TRANSACTION", "not yet", "stub");
    });
    const r = await send(sender({ provider, reader, timeoutMs: 1 }), call);
    assert.equal(r.status, "pending");
    assert.ok(r.status === "pending" && r.tx_hash.length > 40 && r.links.explorer.includes(r.tx_hash));
  });
});

describe("send: a failed send is never reported as nothing on chain", () => {
  // Each of these says nothing about whether the transaction was delivered. It may already be
  // included, or land later while its block hash is valid. Reporting "rejected, nothing is on
  // chain" would invite the agent to pay again.
  const ambiguous: [string, () => Error][] = [
    ["HTTP 408 (nearcore's send_tx deadline, a ProviderError)", () => new ProviderErrorLike("Timeout error", 408)],
    ["HTTP 503 (a ProviderError)", () => new ProviderErrorLike("https://rpc.testnet.fastnear.com unavailable", 503)],
    ["a dropped connection", () => new TypeError("fetch failed")],
    ["near-api-js giving up on its retries (TypedError)", () => new TypedError("Exceeded 12 attempts for https://rpc.testnet.fastnear.com.", "RetriesExceeded")],
    ["a node's internal error", () => new InternalRpcError("internal")],
  ];

  for (const [what, makeError] of ambiguous) {
    it(`${what}: the hash is polled for the full timeout, and the landed transaction is 'executed'`, async () => {
      const { provider, sent } = fakeProvider(() => {
        throw makeError();
      });
      let polls = 0;
      const reader = stubReader((_m, p) => {
        polls += 1;
        if (polls < 3) throw new RpcAnswerError("HANDLER_ERROR", "UNKNOWN_TRANSACTION", "not yet", "stub");
        return finalFor(String(p.tx_hash));
      });
      const r = await send(sender({ provider, reader }), call);
      assert.equal(r.status, "executed");
      assert.equal(sent.length, 1, "never signs a second transaction while the first may land");
      assert.equal(polls, 3);
    });

    it(`${what}: not found before the timeout is 'pending' with the hash, never 'rejected'`, async () => {
      const { provider, sent } = fakeProvider(() => {
        throw makeError();
      });
      const reader = stubReader(() => {
        throw new RpcAnswerError("HANDLER_ERROR", "UNKNOWN_TRANSACTION", "not yet", "stub");
      });
      const r = await send(sender({ provider, reader, timeoutMs: 1 }), call);
      assert.equal(r.status, "pending");
      if (r.status !== "pending") return;
      assert.equal(sent.length, 1);
      assert.ok(r.tx_hash.length > 40);
      assert.match(r.note, /does not say whether it was delivered/);
      assert.match(r.note, /check this hash before sending again/);
    });
  }

  it("an included transaction whose status cannot be read is 'pending', not an exception", async () => {
    const { provider } = fakeProvider(() => ({ final_execution_status: "INCLUDED_FINAL" }));
    const reader = stubReader(() => {
      throw new RpcAnswerError("HANDLER_ERROR", "PARSE_ERROR", "odd answer", "stub");
    });
    const r = await send(sender({ provider, reader }), call);
    assert.equal(r.status, "pending");
    assert.ok(r.status === "pending" && /could not be read/.test(r.note));
  });

  it("only nearcore's decided refusals count as 'refused at validation'", () => {
    for (const e of [new InvalidTransactionError(), new InvalidNonceError(1, 1, "h", "b"), new RpcRequestParseError("bad request")]) assert.equal(refusedAtValidation(e), true, e.constructor.name);
    for (const e of [new TransactionTimeoutError(), new InternalRpcError("x"), new ProviderErrorLike("Timeout error", 408), new TypeError("fetch failed"), new TypedError("x", "RetriesExceeded")]) {
      assert.equal(refusedAtValidation(e), false, e.constructor.name);
    }
  });
});

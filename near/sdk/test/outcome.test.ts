// Outcome parsing and the settlement proof.
//
// tx-usdc-ft-transfer.testnet.json is a REAL transaction: Circle's testnet USDC faucet sending
// 20 USDC to aid-demo-owner.testnet, read from archival RPC. The vault outcomes below are
// SYNTHETIC (the vault is not deployed yet): they follow the vault's event ABI
// (near/contracts/agent-spend-policy/src/event.rs) and reuse the real USDC receipt's exact log
// format, so the parser is tested on the shapes the chain produces.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RpcAnswerError } from "../src/collect/rpc.ts";
import { eventsFrom, parseEventLine, parseOutcome, payOutcomeOf, proveSettlement, TxPendingError, vaultEventFor, waitFinal } from "../src/chain/outcome.ts";
import { fixture, noSleep, PAYEE, stubReader, USDC, VAULT, vaultPayTx, type VaultTxOpts as Opts } from "./helpers.ts";

const expect = { tokenId: USDC, vaultId: VAULT, payee: PAYEE, amount: "250000" };

describe("parseOutcome on a real Circle USDC transfer", () => {
  const raw = fixture<{ result: unknown }>("tx-usdc-ft-transfer.testnet.json").result;
  const out = parseOutcome(raw);

  it("reads the transaction, every receipt and the token's NEP-141 event", () => {
    assert.equal(out.tx_hash, "D6Jp1Ho17KbwV5KDzcdE9RooKG6YFcZRRpap7RiNaV84");
    assert.equal(out.final_execution_status, "FINAL");
    assert.equal(out.succeeded, true);
    assert.equal(out.receipts.length, 2);
    const transfers = eventsFrom(out, "nep141", USDC);
    assert.equal(transfers.length, 1);
    assert.deepEqual(transfers[0]!.data, [{ old_owner_id: "641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5", new_owner_id: "aid-demo-owner.testnet", amount: "20000000" }]);
  });

  it("decodes the receipt's action and its caller", () => {
    const tokenReceipt = out.receipts.find((r) => r.executor_id === USDC)!;
    assert.equal(tokenReceipt.predecessor_id, "641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5");
    assert.deepEqual(tokenReceipt.actions[0], { kind: "function_call", method: "ft_transfer", args: { amount: "20000000", receiver_id: "aid-demo-owner.testnet" }, deposit: "1", gas: "300000000000000" });
  });

  it("the token-receipt check passes on real data; with no vault involved the payment is not called settled", () => {
    const s = proveSettlement(out, { tokenId: USDC, vaultId: "641c8bb12ddfc8f0a1475ed00e84dade985d5f8e40c877f7958e1db0e96234a5", payee: "aid-demo-owner.testnet", amount: "20000000" });
    assert.equal(s.checks.find((c) => c.name === "token_transfer")!.ok, true);
    assert.equal(s.settled, false);
  });
});

describe("vault outcomes and the settlement proof", () => {
  it("a sent payment with the token's own transfer receipt is settled", () => {
    const out = parseOutcome(vaultPayTx({ outcome: "sent" }));
    const pay = payOutcomeOf(out)!;
    assert.deepEqual(pay, { status: "sent", payment_id: "7", reason: null, held_id: null });
    assert.equal(vaultEventFor(out, VAULT, pay)!.event, "payment_sent");
    const s = proveSettlement(out, expect);
    assert.equal(s.settled, true, JSON.stringify(s.checks));
  });

  const notSettled: [string, Opts][] = [
    ["the token moved a different amount", { outcome: "sent", eventAmount: "250001" }],
    ["the transfer event was logged by the vault, not the token", { outcome: "sent", eventAmount: "999", fakeEventFromVault: true }],
    ["the token's receipt failed", { outcome: "sent", tokenFails: true }],
    ["someone other than the vault called ft_transfer", { outcome: "sent", transferCaller: "attacker.testnet" }],
  ];
  for (const [what, o] of notSettled) {
    it(`is NOT settled when ${what}`, () => {
      const s = proveSettlement(parseOutcome(vaultPayTx(o)), expect);
      assert.equal(s.settled, false);
    });
  }

  it("a fake nep141 line from the vault does not count even with the right amount", () => {
    const tx = vaultPayTx({ outcome: "sent", fakeEventFromVault: true, eventAmount: "250000" }) as { receipts_outcome: { id: string; outcome: { logs: string[] } }[] };
    tx.receipts_outcome.find((r) => r.id === "R5")!.outcome.logs = [];
    assert.equal(proveSettlement(parseOutcome(tx), expect).settled, false);
  });

  it("a registry refusal is read with its reasons and matched to its event", () => {
    const out = parseOutcome(vaultPayTx({ outcome: "refused" }));
    const pay = payOutcomeOf(out)!;
    assert.equal(pay.status, "refused");
    assert.equal(pay.reason, "RegistryDeny");
    const e = vaultEventFor(out, VAULT, pay)!;
    assert.deepEqual((e.data as { registry_reasons: string[] }).registry_reasons, ["drainer"]);
    assert.equal(proveSettlement(out, expect).settled, false);
  });

  it("an unknown payee held for the owner carries its held id", () => {
    const out = parseOutcome(vaultPayTx({ outcome: "held" }));
    assert.deepEqual(payOutcomeOf(out), { status: "held", payment_id: "7", reason: "UnknownPayee", held_id: "3" });
  });

  it("payOutcomeOf rejects shapes the vault never returns", () => {
    const out = parseOutcome(vaultPayTx({ outcome: "sent" }));
    for (const bad of [null, "sent", { status: "paid", payment_id: "1" }, { status: "sent", payment_id: 1 }]) {
      assert.equal(payOutcomeOf({ ...out, return_value: bad }), null);
    }
  });
});

describe("event lines", () => {
  it("parses NEP-297 lines and ignores everything else", () => {
    assert.equal(parseEventLine('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}', "r", "t")?.event, "ft_transfer");
    for (const line of ["Transfer 5 from a to b", "EVENT_JSON:not json", 'EVENT_JSON:{"standard":"x"}', 'EVENT_JSON:["a"]']) {
      assert.equal(parseEventLine(line, "r", "t"), null, line);
    }
  });
});

describe("waitFinal", () => {
  const raw = fixture<{ result: Record<string, unknown> }>("tx-usdc-ft-transfer.testnet.json").result;

  it("polls through 'not yet known' and non-final answers until FINAL", async () => {
    let n = 0;
    const reader = stubReader(() => {
      n += 1;
      if (n === 1) throw new RpcAnswerError("HANDLER_ERROR", "UNKNOWN_TRANSACTION", "not yet", "stub");
      if (n === 2) return { ...raw, final_execution_status: "EXECUTED_OPTIMISTIC" };
      return raw;
    });
    const out = await waitFinal(reader, { txHash: "D6Jp1Ho17KbwV5KDzcdE9RooKG6YFcZRRpap7RiNaV84", senderId: "x", sleep: noSleep });
    assert.equal(out.final_execution_status, "FINAL");
    assert.equal(n, 3);
  });

  it("gives up with TxPendingError, keeping the hash", async () => {
    let t = 0;
    const reader = stubReader(() => ({ ...raw, final_execution_status: "INCLUDED" }));
    await assert.rejects(
      waitFinal(reader, { txHash: "abc", senderId: "x", timeoutMs: 5_000, pollMs: 1_000, now: () => t, sleep: async (ms) => void (t += ms) }),
      (e: unknown) => e instanceof TxPendingError && e.txHash === "abc",
    );
  });

  it("does not swallow a decided error", async () => {
    const reader = stubReader(() => {
      throw new RpcAnswerError("HANDLER_ERROR", "PARSE_ERROR", "bad hash", "stub");
    });
    await assert.rejects(waitFinal(reader, { txHash: "!", senderId: "x", sleep: noSleep }), RpcAnswerError);
  });
});

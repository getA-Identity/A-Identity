// verifyThenPay routing, with the snapshot collector and the vault client replaced by fixtures
// and mocks: no network, no keys.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOutcome, type PayOutcome } from "../src/chain/outcome.ts";
import type { Executed, Prepared, Rejected } from "../src/chain/send.ts";
import { vaultClient, type PayCallResult, type VaultClient } from "../src/chain/vault.ts";
import { createReader, type FetchLike } from "../src/collect/rpc.ts";
import type { Snapshot } from "../src/engine/types.ts";
import { guardReason, routeFor, verifyThenPay } from "../src/guard.ts";
import { clone, noNetwork, snapshotFixture, USDC, VAULT, vaultPayTx, withVault } from "./helpers.ts";

const offline = createReader({ rpc: ["https://unused.example"], archival: [], fetch: noNetwork });
const prepared = (vault = VAULT) => vaultClient({ vaultId: vault, reader: offline });
/** A recorded snapshot as the collector returns it for VAULT: the vault's own answers included. */
const collectFrom = (file: string, vault: Parameters<typeof withVault>[1] = { paid: 0 }) => async () => withVault(snapshotFixture(file), vault);

describe("routing", () => {
  it("maps ALLOW to pay, WARN to request_payment, DENY to record_refusal", () => {
    assert.equal(routeFor("ALLOW"), "pay");
    assert.equal(routeFor("WARN"), "request_payment");
    assert.equal(routeFor("DENY"), "record_refusal");
  });

  it("ALLOW: prepares vault.pay with no key loaded", async () => {
    const r = await verifyThenPay({ vault: VAULT, payee: "wrap.testnet", amount: "250000", collect: collectFrom("snapshot-wrap.testnet.json"), client: prepared() });
    assert.equal(r.verdict.verdict, "ALLOW");
    assert.equal(r.route, "pay");
    assert.equal(r.status, "prepared");
    assert.equal(r.prepared!.actions[0]!.params.methodName, "pay");
    assert.match(r.summary, /prepared \(not sent/);
  });

  it("WARN: asks the owner with the deciding reason codes", async () => {
    const r = await verifyThenPay({ vault: VAULT, payee: "aid-demo-merchant.testnet", amount: "250000", collect: collectFrom("snapshot-merchant.testnet.json"), client: prepared() });
    assert.equal(r.route, "request_payment");
    assert.deepEqual(r.prepared!.actions[0]!.params.args.reason, "a-identity guard WARN: new_account,low_activity");
  });

  it("DENY: records the refusal on chain and moves nothing", async () => {
    const r = await verifyThenPay({ vault: VAULT, payee: "no-such-account-zz91.testnet", amount: "250000", collect: collectFrom("snapshot-missing.testnet.json"), client: prepared() });
    assert.equal(r.route, "record_refusal");
    assert.equal(r.prepared!.actions[0]!.params.args.reason, "a-identity guard DENY: account_not_found");
    assert.equal(r.prepared!.actions[0]!.params.deposit, "0");
  });

  it("no verdict (collection failed) is WARN: the owner decides, the agent never pays blind", async () => {
    const r = await verifyThenPay({
      vault: VAULT,
      payee: "aid-demo-merchant.testnet",
      amount: "1",
      collect: async () => {
        throw new Error("all RPC endpoints down");
      },
      client: prepared(),
    });
    assert.equal(r.verdict.verdict, "WARN");
    assert.match(r.verdict.unavailable!, /all RPC endpoints down/);
    assert.equal(r.route, "request_payment");
    assert.equal(r.prepared!.actions[0]!.params.args.reason, "a-identity guard WARN: verdict_unavailable");
  });

  it("refuses bad input before any read", async () => {
    await assert.rejects(verifyThenPay({ vault: "Bad Vault", payee: "a.testnet", amount: "1", client: prepared() }), TypeError);
    await assert.rejects(verifyThenPay({ vault: VAULT, payee: "a.testnet", amount: "0.5", client: prepared() }), /amount/);
  });

  it("the vault reason field stays within 128 bytes", () => {
    const long = guardReason({ verdict: "WARN", source: "local", decision: null, reasons: Array(20).fill("code_changed_since_verdict"), snapshot_sha256: null, unavailable: null });
    assert.ok(Buffer.byteLength(long) <= 128);
  });
});

describe("a snapshot is checked, not trusted", () => {
  // Each case hands the guard a real snapshot that does not answer THIS payment. Using it could
  // pay a payee on another account's ALLOW; the guard must fall back to WARN (the owner decides).
  const cases: [string, Partial<Parameters<typeof verifyThenPay>[0]>, () => Promise<Snapshot>, RegExp][] = [
    ["about another payee", { payee: "aid-demo-merchant.testnet" }, collectFrom("snapshot-wrap.testnet.json"), /snapshot is about wrap\.testnet, not the payee aid-demo-merchant\.testnet/],
    ["collected without the vault", { payee: "wrap.testnet" }, async () => snapshotFixture("snapshot-wrap.testnet.json"), /collected for vault \(none\), not vault\.aid-demo-owner\.testnet/],
    ["for another vault", { payee: "wrap.testnet", vault: "vault.someone-else.testnet" }, collectFrom("snapshot-wrap.testnet.json"), /not vault\.someone-else\.testnet/],
    ["on another network", { payee: "burrowfinancedao.near", network: "testnet" }, collectFrom("snapshot-burrowfinancedao.near.json"), /snapshot is about mainnet, not testnet/],
    ["collected without a known payee the caller named", { payee: "wrap.testnet", known: ["aid-demo-merchant.testnet"] }, collectFrom("snapshot-wrap.testnet.json"), /without the known payee\(s\) aid-demo-merchant\.testnet/],
    [
      "that fails assertSnapshot (a forged timestamp)",
      { payee: "wrap.testnet" },
      async () => {
        const s = clone(await collectFrom("snapshot-wrap.testnet.json")());
        s.block.timestamp_ns = (BigInt(s.block.timestamp_ns) + 1n).toString();
        return s;
      },
      /not a valid A-Identity NEAR snapshot/,
    ],
  ];
  for (const [what, over, collect, why] of cases) {
    it(`a snapshot ${what} is not used: WARN, routed to the owner`, async () => {
      const r = await verifyThenPay({ vault: VAULT, payee: "wrap.testnet", amount: "1", collect, client: prepared(over.vault ?? VAULT), ...over });
      assert.equal(r.verdict.verdict, "WARN");
      assert.equal(r.verdict.decision, null);
      assert.match(r.verdict.unavailable ?? "", why);
      assert.equal(r.route, "request_payment");
      assert.equal(r.prepared!.actions[0]!.params.args.reason, "a-identity guard WARN: verdict_unavailable");
    });
  }

  it("the same snapshot about the right payee, vault and known set is used", async () => {
    const r = await verifyThenPay({ vault: VAULT, payee: "wrap.testnet", amount: "1", collect: collectFrom("snapshot-wrap.testnet.json"), client: prepared() });
    assert.equal(r.verdict.unavailable, null);
    assert.equal(r.verdict.verdict, "ALLOW");
  });
});

describe("hosted verdicts", () => {
  const hosted = (status: number, body: unknown): FetchLike => async () => ({ status, text: async () => JSON.stringify(body) });
  const run = (fetchImpl: FetchLike, hostedUrl: string | undefined = "https://api.example/near/verdict") =>
    verifyThenPay({ vault: VAULT, payee: "wrap.testnet", amount: "1", verdictSource: "hosted", fetch: fetchImpl, client: prepared(), ...(hostedUrl ? { hostedUrl } : {}) });

  it("uses a well-formed hosted answer", async () => {
    const r = await run(hosted(200, { account: "wrap.testnet", verdict: "ALLOW", registry_reasons: ["long_history"], snapshot_sha256: "ab" }));
    assert.equal(r.verdict.verdict, "ALLOW");
    assert.equal(r.verdict.source, "hosted");
    assert.equal(r.route, "pay");
  });

  for (const [what, f, url] of [
    ["an HTTP error", hosted(502, {}), undefined],
    ["an unknown verdict", hosted(200, { account: "wrap.testnet", verdict: "OK" }), undefined],
    ["an answer about another account", hosted(200, { account: "evil.testnet", verdict: "ALLOW" }), undefined],
    ["an answer about another network", hosted(200, { account: "wrap.testnet", network: "mainnet", verdict: "ALLOW" }), undefined],
    ["an unreachable host", noNetwork, undefined],
    ["no hosted URL", hosted(200, {}), ""],
  ] as [string, FetchLike, string | undefined][]) {
    it(`treats ${what} as WARN`, async () => {
      const r = await run(f, url === "" ? undefined : url);
      assert.equal(r.verdict.verdict, "WARN");
      assert.ok(r.verdict.unavailable);
      assert.equal(r.route, "request_payment");
    });
  }
});

describe("executed: the contract has the final word", () => {
  function mockClient(result: PayCallResult): VaultClient {
    const base = prepared();
    return { ...base, pay: async () => result, requestPayment: async () => result, recordRefusal: async () => result, getConfig: async () => ({ token_id: USDC }) as never } as VaultClient;
  }
  const executed = (kind: "sent" | "held", payee: string): PayCallResult => {
    const outcome = parseOutcome(vaultPayTx({ outcome: kind, payee }));
    const pay: PayOutcome = kind === "sent" ? { status: "sent", payment_id: "7", reason: null, held_id: null } : { status: "held", payment_id: "7", reason: "UnknownPayee", held_id: "3" };
    const e: Executed = { status: "executed", tx_hash: outcome.tx_hash, signer_id: VAULT, receiver_id: VAULT, outcome, links: { explorer: "x", archival_curl: "y" } };
    return { ...e, pay, event: null };
  };

  it("ALLOW (the owner paid this merchant before) and the vault sent it: settled, with the token's receipt as proof", async () => {
    const collect = collectFrom("snapshot-merchant.testnet.json", { paid: 1 });
    const r = await verifyThenPay({ vault: VAULT, payee: "aid-demo-merchant.testnet", amount: "250000", collect, client: mockClient(executed("sent", "aid-demo-merchant.testnet")) });
    assert.equal(r.verdict.verdict, "ALLOW");
    assert.equal(r.status, "executed");
    assert.equal(r.settled, true);
    assert.equal(r.contract_overrode, false);
    assert.match(r.summary, /settled/);
  });

  it("ALLOW but the vault held it (unknown payee): reported as the contract overriding, not settled", async () => {
    const r = await verifyThenPay({ vault: VAULT, payee: "wrap.testnet", amount: "250000", collect: collectFrom("snapshot-wrap.testnet.json"), client: mockClient(executed("held", "wrap.testnet")) });
    assert.equal(r.verdict.verdict, "ALLOW");
    assert.equal(r.onchain!.status, "held");
    assert.equal(r.contract_overrode, true);
    assert.equal(r.settled, false);
    assert.match(r.summary, /held \(UnknownPayee\)/);
  });

  it("a payment the vault reports sent to the payee is NOT settled when the transfer went elsewhere", async () => {
    const collect = collectFrom("snapshot-merchant.testnet.json", { paid: 1 });
    const r = await verifyThenPay({ vault: VAULT, payee: "aid-demo-merchant.testnet", amount: "250000", collect, client: mockClient(executed("sent", "someone-else.testnet")) });
    assert.equal(r.status, "executed");
    assert.equal(r.settled, false);
    assert.match(r.summary, /NOT proven settled/);
  });

  it("a key used outside its scope is rejected before inclusion and nothing is claimed on chain", async () => {
    const rejected: Rejected = { status: "rejected", signer_id: VAULT, receiver_id: VAULT, error: "AccessKeyMethodNameMismatchActionError", message: "method not allowed", note: "refused at validation" };
    const r = await verifyThenPay({ vault: VAULT, payee: "wrap.testnet", amount: "1", collect: collectFrom("snapshot-wrap.testnet.json"), client: mockClient(rejected) });
    assert.equal(r.status, "rejected");
    assert.equal(r.tx_hash, null);
    assert.match(r.summary, /nothing is on chain/);
  });

  it("prepared results pass through untouched", async () => {
    const p: Prepared = { status: "prepared", signer_id: VAULT, receiver_id: VAULT, actions: [], note: "n" };
    const r = await verifyThenPay({ vault: VAULT, payee: "wrap.testnet", amount: "1", collect: collectFrom("snapshot-wrap.testnet.json"), client: mockClient(p) });
    assert.equal(r.prepared, p);
  });
});

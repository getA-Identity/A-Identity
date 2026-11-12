// The guard CLI with no key: it must decide, route, and print the exact prepared call, sending
// nothing. Chain answers come from a recorded live run; reads it did not record fail, which the
// engine reports honestly (the demo vault is not deployed in that recording).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main, type GuardIo } from "../src/cli/guard.ts";
import { fixture, noSleep, replayFetch, type Exchange } from "./helpers.ts";

function io(over: Partial<GuardIo> = {}): GuardIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (t) => void out.push(t), stderr: (t) => void err.push(t), env: {}, sleep: noSleep, ...over };
}

describe("guard CLI", () => {
  it("a lookalike payee: DENY, routed to record_refusal, prepared and not sent", async () => {
    const rec = fixture<{ exchanges: Exchange[] }>("collect-lookalike.json");
    const t = io({ fetch: replayFetch(rec.exchanges) });
    const argv = ["--vault", "vault.aid-demo-owner.testnet", "--payee", "aid-demo-rnerchant.testnet", "--amount", "0.25", "--known", "aid-demo-merchant.testnet", "--json"];
    assert.equal(await main(argv, t), 0);
    const r = JSON.parse(t.out.join(""));
    assert.equal(r.verdict.verdict, "DENY");
    assert.equal(r.route, "record_refusal");
    assert.equal(r.status, "prepared");
    assert.equal(r.tx_hash, null);
    const action = r.prepared.actions[0];
    assert.equal(r.prepared.signer_id, "vault.aid-demo-owner.testnet");
    assert.equal(action.params.methodName, "record_refusal");
    assert.equal(action.params.args.amount, "250000");
    assert.equal(action.params.deposit, "0");
    assert.match(action.params.args.reason, /^a-identity guard DENY: account_not_found,lookalike_new_account/);
  });

  it("text output says plainly that nothing was sent", async () => {
    const rec = fixture<{ exchanges: Exchange[] }>("collect-lookalike.json");
    const t = io({ fetch: replayFetch(rec.exchanges) });
    assert.equal(await main(["--vault", "vault.aid-demo-owner.testnet", "--payee", "aid-demo-rnerchant.testnet", "--amount", "1", "--known", "aid-demo-merchant.testnet"], t), 0);
    assert.match(t.out.join(""), /NOT SENT/);
  });

  for (const [what, argv] of [
    ["missing arguments", ["--vault", "v.testnet"]],
    ["more decimals than USDC has", ["--vault", "v.testnet", "--payee", "p.testnet", "--amount", "0.1234567"]],
    ["a zero amount", ["--vault", "v.testnet", "--payee", "p.testnet", "--amount", "0"]],
    ["an invalid payee", ["--vault", "v.testnet", "--payee", "Not Valid", "--amount", "1"]],
  ] as [string, string[]][]) {
    it(`exits 2 on ${what}`, async () => {
      const t = io();
      assert.equal(await main(argv, t), 2);
    });
  }

  it("--help exits 0", async () => {
    const t = io();
    assert.equal(await main(["--help"], t), 0);
    assert.match(t.out.join(""), /Without a key nothing is sent/);
  });
});

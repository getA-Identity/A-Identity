// Keys, and the vault and registry clients in prepared mode (no key: the exact call comes back
// and nothing is sent). Keys are generated at runtime; none is stored in this repository.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { inspect } from "node:util";
import { KeyPair } from "near-api-js";
import { keyFromSecret, KeyError, loadKey } from "../src/chain/keys.ts";
import { checkVerdictInput, REPORT_DEPOSIT, RegistryArgumentError, registryClient, verdictInputFromDecision } from "../src/chain/registry.ts";
import { checkAmount, toUnits, truncateBytes, VAULT_GAS_TGAS, VaultArgumentError, vaultClient } from "../src/chain/vault.ts";
import { decide } from "../src/engine/rules.ts";
import type { Decision } from "../src/engine/types.ts";
import { baseSignals, noNetwork, stubReader } from "./helpers.ts";
import { createReader } from "../src/collect/rpc.ts";

const offline = createReader({ rpc: ["https://unused.example"], archival: [], fetch: noNetwork });
const TGAS = (n: number) => (BigInt(n) * 10n ** 12n).toString();

describe("keys", () => {
  let dir = "";
  const pair = KeyPair.fromRandom("ed25519");
  const secret = pair.toString();
  const publicKey = pair.getPublicKey().toString();
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "aid-keys-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a 0600 key file and never shows the secret", async () => {
    const file = join(dir, "agent.key");
    await writeFile(file, `${secret}\n`);
    await chmod(file, 0o600);
    const k = (await loadKey({ file }))!;
    assert.equal(k.publicKey, publicKey);
    assert.ok(!inspect(k).includes(secret.slice(8, 30)));
    assert.ok(!JSON.stringify(k).includes(secret.slice(8, 30)));
    assert.ok(!Object.keys(k).includes("signer"));
  });

  it("loads near-cli JSON key files", async () => {
    const file = join(dir, "cli.json");
    await writeFile(file, JSON.stringify({ account_id: "vault.aid-demo-owner.testnet", public_key: publicKey, private_key: secret }));
    await chmod(file, 0o600);
    assert.equal((await loadKey({ file, expectPublicKey: publicKey }))!.publicKey, publicKey);
  });

  it("refuses a key file other users can read, without printing the key", async () => {
    const file = join(dir, "open.key");
    await writeFile(file, secret);
    await chmod(file, 0o644);
    await assert.rejects(loadKey({ file, platform: "darwin" }), (e: unknown) => e instanceof KeyError && /chmod 600/.test(e.message) && !e.message.includes(secret.slice(8, 30)));
  });

  it("reads an environment variable; absent means null (prepared mode), malformed is an error without the value", async () => {
    assert.equal((await loadKey({ envVar: "AID_AGENT_KEY", env: { AID_AGENT_KEY: secret } }))!.publicKey, publicKey);
    assert.equal(await loadKey({ envVar: "AID_AGENT_KEY", env: {} }), null);
    assert.equal(await loadKey({}), null);
    await assert.rejects(loadKey({ envVar: "K", env: { K: "ed25519:notbase58!!" } }), (e: unknown) => e instanceof KeyError && !e.message.includes("notbase58"));
  });

  it("checks the expected public key", () => {
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    assert.throws(() => keyFromSecret(secret, "memory", other), KeyError);
  });
});

describe("vault client, prepared", () => {
  const v = vaultClient({ vaultId: "vault.aid-demo-owner.testnet", reader: offline, owner: { accountId: "aid-demo-owner.testnet" } });

  it("an agent pay is signed as the vault, with 73 Tgas and no deposit", async () => {
    const r = await v.pay({ payee: "aid-demo-merchant.testnet", amount: "250000", memo: "invoice 7" });
    assert.equal(r.status, "prepared");
    if (r.status !== "prepared") return;
    assert.equal(r.signer_id, "vault.aid-demo-owner.testnet");
    assert.equal(r.receiver_id, "vault.aid-demo-owner.testnet");
    assert.deepEqual(r.actions, [{ type: "FunctionCall", params: { methodName: "pay", args: { payee: "aid-demo-merchant.testnet", amount: "250000", memo: "invoice 7" }, gas: TGAS(73), deposit: "0" } }]);
  });

  it("request_payment takes 73 Tgas and record_refusal 10 Tgas (the contract's measured figures)", async () => {
    const req = await v.requestPayment({ payee: "a.testnet", amount: "1", reason: "a-identity guard WARN: new_account" });
    const rec = await v.recordRefusal({ payee: "a.testnet", amount: "1", reason: "a-identity guard DENY: lookalike_new_account" });
    assert.ok(req.status === "prepared" && req.actions[0]!.params.gas === TGAS(73) && req.actions[0]!.params.deposit === "0");
    assert.ok(rec.status === "prepared" && rec.actions[0]!.params.gas === TGAS(10) && rec.actions[0]!.params.methodName === "record_refusal");
  });

  // The vault's source states the one number to attach (AGENT_PREPAID_GAS); this keeps the SDK
  // from drifting away from it. Skipped only where the contract sources are not checked out.
  const contractSource = join(import.meta.dirname, "..", "..", "contracts", "agent-spend-policy", "src", "lib.rs");
  it("pay and request_payment attach exactly the contract's AGENT_PREPAID_GAS", { skip: existsSync(contractSource) ? false : "contract sources not present" }, () => {
    const m = /pub const AGENT_PREPAID_GAS: Gas = Gas::from_tgas\((\d+)\);/.exec(readFileSync(contractSource, "utf8"));
    assert.ok(m, "AGENT_PREPAID_GAS not found in the vault's lib.rs");
    assert.equal(VAULT_GAS_TGAS.pay, Number(m[1]));
    assert.equal(VAULT_GAS_TGAS.request_payment, Number(m[1]));
  });

  it("owner calls attach exactly 1 yoctoNEAR, except freeze", async () => {
    for (const r of [await v.ownerPay("3"), await v.ownerReject("3"), await v.unfreeze(), await v.setHoldUnknown(true), await v.setAllowed("a.testnet", true), await v.withdraw("1000")]) {
      assert.ok(r.status === "prepared" && r.signer_id === "aid-demo-owner.testnet" && r.actions[0]!.params.deposit === "1", JSON.stringify(r));
    }
    const f = await v.freeze();
    assert.ok(f.status === "prepared" && f.actions[0]!.params.deposit === "0");
  });

  it("validates amounts and text before anything is built", () => {
    for (const bad of ["0", "-1", "1.5", "", "01", (1n << 128n).toString()]) assert.throws(() => checkAmount(bad), VaultArgumentError, bad);
    assert.throws(() => v.pay({ payee: "a.testnet", amount: "1", memo: "x".repeat(129) }), /128 bytes/);
    assert.equal(toUnits("0.25"), "250000");
    assert.equal(toUnits("20"), "20000000");
    assert.throws(() => toUnits("1.0000001"), /more than 6 decimals/);
    assert.equal(truncateBytes("\u00e7".repeat(100), 9), "\u00e7".repeat(4));
  });

  it("views decode JSON, and Option::None arrives as null", async () => {
    const reader = stubReader((_m, p) => ({ result: [...new TextEncoder().encode(p.method_name === "get_held" ? "null" : "3")] }));
    const vv = vaultClient({ vaultId: "vault.aid-demo-owner.testnet", reader });
    assert.equal(await vv.paidCount("a.testnet"), 3);
    assert.equal(await vv.getHeld("9"), null);
  });
});

describe("registry client, prepared", () => {
  const r = registryClient({ registryId: "registry.a-identity.testnet", reader: offline, oracle: { accountId: "oracle.a-identity.testnet" } });
  const decision: Decision = decide(baseSignals());

  it("turns a decision into a valid set_verdict input", () => {
    const v = verdictInputFromDecision(decision, { evidence: "near-snapshot sha256:abc block:1 engine:1.0.0", codeHash: "11111111111111111111111111111111" });
    assert.equal(v.verdict, "ALLOW");
    assert.deepEqual(v.reasons, ["long_history"]);
    assert.equal(v.score, decision.score);
  });

  it("oracle writes carry no deposit, so a function-call key can sign them", async () => {
    const res = await r.setVerdict(verdictInputFromDecision(decision, { evidence: null, codeHash: null }));
    assert.ok(res.status === "prepared" && res.actions[0]!.params.deposit === "0" && res.signer_id === "oracle.a-identity.testnet");
  });

  it("a report carries the 0.01 NEAR deposit", async () => {
    const res = await r.report({ accountId: "x.testnet", reason: "drainer", evidence: "https://example.org/e" });
    assert.ok(res.status === "prepared" && res.actions[0]!.params.deposit === REPORT_DEPOSIT);
  });

  it("refuses what the registry would refuse", () => {
    const ok = verdictInputFromDecision(decision, { evidence: null, codeHash: null });
    assert.throws(() => checkVerdictInput({ ...ok, reasons: ["Bad-Code"] }), RegistryArgumentError);
    assert.throws(() => checkVerdictInput({ ...ok, reasons: Array(9).fill("a") }), /TooManyReasons/);
    assert.throws(() => checkVerdictInput({ ...ok, evidence: "e".repeat(257) }), /EvidenceTooLong/);
    assert.throws(() => checkVerdictInput({ ...ok, score: 1001 }), /ScoreOutOfRange/);
  });
});

// The decision table, case by case. Each case starts from a clean, old, active account (ALLOW)
// and changes one fact, so a failure points at exactly one rule.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_POLICY, SCORE_BANDS } from "../src/engine/policy.ts";
import { decide, registryReasons, RULES } from "../src/engine/rules.ts";
import { REASON_CODES, type Decision, type Signals } from "../src/engine/types.ts";
import { baseSignals, REGISTRY_OK, VAULT_OK } from "./helpers.ts";

const codes = (d: Decision): string[] => d.reasons.map((r) => r.code);
const deciding = (d: Decision): string[] => d.reasons.filter((r) => (r.severity === "deny" || r.severity === "warn") && !r.cleared_by).map((r) => r.code);
const reason = (d: Decision, code: string) => d.reasons.find((r) => r.code === code);

function inBand(d: Decision): boolean {
  const [lo, hi] = SCORE_BANDS[d.verdict];
  return d.score >= lo && d.score <= hi;
}

function with_(patch: (s: Signals) => void): Decision {
  const s = baseSignals();
  patch(s);
  return decide(s);
}

const NEW_AGE = { state: "ok" as const, is_new: true, is_long: false, created_ts_ns: "1794440817913926032", source: "rpc archival view_account@276858896", detail: "did not exist at block #276858896" };

describe("baseline", () => {
  it("an old, active, clean account is ALLOW with long_history", () => {
    const d = decide(baseSignals());
    assert.equal(d.verdict, "ALLOW");
    assert.deepEqual(codes(d), ["long_history"]);
    assert.equal(d.warn_kind, null);
    assert.ok(inBand(d));
    assert.equal(d.engine_version, "a-identity-near-engine/1.1.0");
    assert.equal(d.policy_id, DEFAULT_POLICY.id);
  });

  it("is deterministic: the same signals give the same decision", () => {
    assert.deepEqual(decide(baseSignals()), decide(baseSignals()));
  });
});

describe("deny rules", () => {
  it("a named account that does not exist is DENY account_not_found", () => {
    const d = with_((s) => {
      s.account = { ...s.account, exists: false } as Signals["account"];
      s.age = { state: "not_applicable", why: "absent" };
      s.keys = { state: "not_applicable", why: "absent" };
    });
    assert.equal(d.verdict, "DENY");
    assert.deepEqual(deciding(d), ["account_not_found"]);
    assert.ok(d.score <= 199);
  });

  it("Circle USDC is_blocklisted = true is DENY", () => {
    const d = with_((s) => {
      s.usdc = { state: "ok", blocklisted: true, registered: true, source: "rpc usdc" };
    });
    assert.equal(d.verdict, "DENY");
    assert.deepEqual(deciding(d), ["usdc_blocklisted"]);
  });

  it("a registry DENY is DENY and carries the registry's reasons", () => {
    const d = with_((s) => {
      s.registry = { ...REGISTRY_OK, verdict: { verdict: "DENY", reasons: ["drainer"], evidence: null, score: 50, code_hash: null, updated_at_ns: "1", updated_by: "oracle.a-identity.testnet", expires_at_ns: null } };
    });
    assert.equal(d.verdict, "DENY");
    assert.match(reason(d, "registry_deny")!.detail, /drainer/);
  });

  it("no positive signal overrides a DENY", () => {
    const d = with_((s) => {
      s.registry = { ...REGISTRY_OK, verdict: { verdict: "DENY", reasons: [], evidence: null, score: null, code_hash: null, updated_at_ns: "1", updated_by: "o", expires_at_ns: null } };
      s.vault = { ...VAULT_OK, paid_count: 9, allowlisted: true };
      s.erc8004 = { state: "ok", identity: "identity-registry.erc-8004.testnet", agent_ids: ["0"], feedback_count: 3, mean: 90, source: "rpc" };
    });
    assert.equal(d.verdict, "DENY");
    assert.ok(codes(d).includes("prior_payments"));
    assert.ok(d.score <= 199);
  });

  it("a lookalike of a known payee that is new is DENY", () => {
    const d = with_((s) => {
      s.age = NEW_AGE;
      s.lookalike = { known: "aid-demo-merchant.testnet", kind: "homoglyph", strong: true, distance: 2, similarity: 1, detail: "reads the same" };
    });
    assert.equal(d.verdict, "DENY");
    assert.ok(deciding(d).includes("lookalike_new_account"));
  });

  it("a lookalike that does not exist yet is DENY too (it is as new as it gets)", () => {
    const d = with_((s) => {
      s.subject = "1a2b3c4d00000000000000000000000000000000000000000000000000009f8e";
      s.kind = "implicit";
      s.account = { ...s.account, exists: false } as Signals["account"];
      s.age = { state: "not_applicable", why: "absent" };
      s.lookalike = { known: "1a2b3c4dffffffffffffffffffffffffffffffffffffffffffffffffffff9f8e", kind: "address_poisoning", strong: true, distance: 50, similarity: 0.2, detail: "shares the first 4 and last 4" };
    });
    assert.equal(d.verdict, "DENY");
    assert.deepEqual(deciding(d), ["lookalike_new_account", "implicit_unfunded"]);
  });

  it("a lookalike with unknown age is WARN, not DENY: unknown is not proof", () => {
    const d = with_((s) => {
      s.age = { state: "unavailable", why: "probe failed and no indexer", source: "rpc" };
      s.lookalike = { known: "aid-demo-merchant.testnet", kind: "homoglyph", strong: true, distance: 2, similarity: 1, detail: "reads the same" };
    });
    assert.equal(d.verdict, "WARN");
    assert.ok(deciding(d).includes("lookalike_known"));
    assert.ok(deciding(d).includes("rpc_unavailable"));
  });

  it("a NEW sibling that shares only a role label (weak match) is WARN lookalike_known, never DENY", () => {
    const weak = { known: "agent.alice.testnet", kind: "parent_swap" as const, strong: false, distance: 0, similarity: 0.6, detail: 'first label "agent" matches agent.alice.testnet' };
    const d = with_((s) => {
      s.subject = "agent.bob.testnet";
      s.age = NEW_AGE;
      s.lookalike = weak;
    });
    assert.equal(d.verdict, "WARN");
    assert.ok(!codes(d).includes("lookalike_new_account"));
    assert.deepEqual(deciding(d), ["lookalike_known", "new_account"]);
    assert.match(reason(d, "lookalike_known")!.detail, /shared role label/);
    // The owner's one tap clears it, as for any payee nobody has history with.
    const paid = with_((s) => {
      s.subject = "agent.bob.testnet";
      s.age = NEW_AGE;
      s.lookalike = weak;
      s.vault = { ...VAULT_OK, paid_count: 1 };
    });
    assert.equal(paid.verdict, "ALLOW");
  });
});

describe("warn rules about the payee", () => {
  const hard: [string, (s: Signals) => void][] = [
    ["registry_warn", (s) => (s.registry = { ...REGISTRY_OK, verdict: { verdict: "WARN", reasons: ["new_account"], evidence: null, score: 400, code_hash: null, updated_at_ns: "1", updated_by: "o", expires_at_ns: null } })],
    ["code_changed_recently", (s) => (s.code_change = { state: "ok", changed: true, before: "AAA", after: "BBB", source: "rpc archival", detail: "code hash AAA became BBB" })],
    ["global_contract_mutable", (s) => (s.account = { ...s.account, has_contract: true, global_contract: { by: "account", account_id: "publisher.testnet" } } as Signals["account"])],
    ["new_full_access_key", (s) => (s.key_changes = { state: "ok", added_full_access: ["ed25519:4bDw7tvHVTe1NMzqUbYKXaGKhw1tDYXF7hW7BJhG8Pvb"], source: "rpc archival" })],
  ];
  for (const [code, patch] of hard) {
    it(`${code} is a hard WARN that prior payments, the allowlist and a registry ALLOW do not clear`, () => {
      const d = with_((s) => {
        patch(s);
        s.vault = { ...VAULT_OK, paid_count: 3, allowlisted: true };
      });
      assert.equal(d.verdict, "WARN");
      assert.ok(deciding(d).includes(code), `${code} should decide: ${JSON.stringify(codes(d))}`);
      assert.equal(d.warn_kind, "hard");
      assert.equal(reason(d, code)!.cleared_by, undefined);
    });
  }

  it("code_changed_since_verdict: the registry's ALLOW was for other code", () => {
    const d = with_((s) => {
      s.account = { ...s.account, has_contract: true, code_hash: "NEWCODE" } as Signals["account"];
      s.registry = { ...REGISTRY_OK, verdict: { verdict: "ALLOW", reasons: [], evidence: null, score: 700, code_hash: "OLDCODE", updated_at_ns: "1", updated_by: "o", expires_at_ns: null } };
    });
    assert.equal(d.verdict, "WARN");
    assert.ok(deciding(d).includes("code_changed_since_verdict"));
  });

  it("open reports hold the payment until the oracle writes an ALLOW after the newest report", () => {
    const reported = (updatedAt: string) =>
      with_((s) => {
        s.registry = {
          ...REGISTRY_OK,
          verdict: { verdict: "ALLOW", reasons: [], evidence: null, score: 800, code_hash: null, updated_at_ns: updatedAt, updated_by: "o", expires_at_ns: null },
          open_reports: 1,
          open_reporters: ["someone.testnet"],
          newest_open_report_ns: "2000",
        };
      });
    const stale = reported("1000");
    assert.equal(stale.verdict, "WARN");
    assert.ok(deciding(stale).includes("open_reports"));
    const reviewed = reported("3000");
    assert.equal(reviewed.verdict, "ALLOW");
    assert.equal(reason(reviewed, "open_reports")!.cleared_by, "registry_allow");
  });

  it("an open report alone never refuses: WARN at most", () => {
    const d = with_((s) => {
      s.registry = { ...REGISTRY_OK, open_reports: 5, open_reporters: ["a.testnet", "b.testnet"], newest_open_report_ns: "1" };
    });
    assert.equal(d.verdict, "WARN");
  });

  it("another team's flag is WARN, never DENY, and says when the entry is demo data", () => {
    const d = with_((s) => {
      s.third_party = [
        {
          state: "ok",
          source: { id: "tripwire", name: "Tripwire", contract: "tripwire-registry-44ea74.testnet", network: "testnet", method: "get_risk", arg: "account_id" },
          flagged: true,
          level: "block",
          detail: "level block, score 95, drainer",
          evidence_url: "https://github.com/Afar88/tripwire#demo-data",
          demo: true,
        },
      ];
    });
    assert.equal(d.verdict, "WARN");
    const r = reason(d, "third_party_flag")!;
    assert.match(r.detail, /Tripwire \(tripwire-registry-44ea74\.testnet\)/);
    assert.match(r.detail, /demo data/);
    assert.match(r.detail, /never decisive alone/);
  });

  it("a third-party flag is cleared by A-Identity's own ALLOW, not by a prior payment", () => {
    const flag = (s: Signals) =>
      (s.third_party = [
        { state: "ok", source: { id: "mimicwatch", name: "MimicWatch", contract: "registry.mimicwatch-e7iig5g5.testnet", network: "testnet", method: "is_flagged", arg: "id" }, flagged: true, level: "high", detail: "flagged", evidence_url: null, demo: false },
      ]);
    const paid = with_((s) => {
      flag(s);
      s.vault = { ...VAULT_OK, paid_count: 2 };
    });
    assert.equal(paid.verdict, "WARN");
    const allowed = with_((s) => {
      flag(s);
      s.registry = { ...REGISTRY_OK, verdict: { verdict: "ALLOW", reasons: [], evidence: null, score: 800, code_hash: null, updated_at_ns: "1", updated_by: "o", expires_at_ns: null } };
    });
    assert.equal(allowed.verdict, "ALLOW");
  });

  it("prior registry refusals at this vault warn once the DENY is gone", () => {
    const d = with_((s) => {
      s.vault = { ...VAULT_OK, refusal_count: 2 };
    });
    assert.equal(d.verdict, "WARN");
    assert.ok(deciding(d).includes("prior_registry_refusals"));
  });

  it("agent-recorded guard refusals never decide (amendment A2)", () => {
    const d = with_((s) => {
      s.vault = { ...VAULT_OK, guard_refusal_count: 40 };
    });
    assert.equal(d.verdict, "ALLOW");
    assert.equal(reason(d, "guard_refusals")!.severity, "info");
  });

  it("an old lookalike is WARN and the owner's earlier payment to it clears it", () => {
    const look = { known: "aid-demo-merchant.testnet", kind: "edit_distance" as const, strong: true, distance: 1, similarity: 0.94, detail: "1 edit" };
    const d = with_((s) => (s.lookalike = look));
    assert.equal(d.verdict, "WARN");
    assert.ok(deciding(d).includes("lookalike_known"));
    const paid = with_((s) => {
      s.lookalike = look;
      s.vault = { ...VAULT_OK, paid_count: 1 };
    });
    assert.equal(paid.verdict, "ALLOW");
    assert.equal(reason(paid, "lookalike_known")!.cleared_by, "prior_payments");
  });
});

describe("soft warnings: nobody has history with this payee yet", () => {
  const newAndQuiet = (s: Signals) => {
    s.age = NEW_AGE;
    s.activity = { state: "ok", tx_count: 1, at_least: false, first_tx: null, source: "indexer fastnear" };
  };

  it("a new, quiet account is a soft WARN", () => {
    const d = with_(newAndQuiet);
    assert.equal(d.verdict, "WARN");
    assert.deepEqual(deciding(d), ["new_account", "low_activity"]);
    assert.equal(d.warn_kind, "soft");
  });

  for (const [clearer, patch] of [
    ["prior_payments", (s: Signals) => (s.vault = { ...VAULT_OK, paid_count: 1 })],
    ["owner_allowlisted", (s: Signals) => (s.vault = { ...VAULT_OK, allowlisted: true })],
    ["registry_allow", (s: Signals) => (s.registry = { ...REGISTRY_OK, verdict: { verdict: "ALLOW", reasons: [], evidence: null, score: 700, code_hash: null, updated_at_ns: "1", updated_by: "o", expires_at_ns: null } })],
  ] as const) {
    it(`${clearer} clears it: the owner's one tap is what makes later payments flow`, () => {
      const d = with_((s) => {
        newAndQuiet(s);
        patch(s);
      });
      assert.equal(d.verdict, "ALLOW");
      assert.equal(reason(d, "new_account")!.cleared_by, clearer);
      assert.equal(reason(d, "low_activity")!.cleared_by, clearer);
    });
  }

  it("an ERC-8004 identity raises the score but does not clear a soft warning (registration is permissionless)", () => {
    const plain = with_(newAndQuiet);
    const withId = with_((s) => {
      newAndQuiet(s);
      s.erc8004 = { state: "ok", identity: "identity-registry.erc-8004.testnet", agent_ids: ["0"], feedback_count: 1, mean: 85, source: "rpc" };
    });
    assert.equal(withId.verdict, "WARN");
    assert.ok(codes(withId).includes("erc8004_identity"));
    assert.ok(codes(withId).includes("erc8004_reputation"));
    assert.ok(withId.score >= plain.score);
  });

  it("an unfunded implicit account is a soft WARN", () => {
    const d = with_((s) => {
      s.subject = "fe0a574258f8277099875e46d4ca0043cdb6274ff2501b375a0d3d64bc211079";
      s.kind = "implicit";
      s.account = { ...s.account, exists: false } as Signals["account"];
      s.age = { state: "not_applicable", why: "absent" };
      s.keys = { state: "not_applicable", why: "absent" };
    });
    assert.equal(d.verdict, "WARN");
    assert.deepEqual(deciding(d), ["implicit_unfunded"]);
    assert.equal(d.warn_kind, "soft");
  });
});

describe("missing data is WARN, never ALLOW, and nothing clears it", () => {
  const cases: [string, (s: Signals) => void][] = [
    ["rpc_unavailable", (s) => (s.account = { state: "unavailable", why: "UNAVAILABLE", source: "rpc" })],
    ["rpc_unavailable", (s) => (s.key_changes = { state: "unavailable", why: "probe failed", source: "rpc archival" })],
    ["indexer_unavailable", (s) => (s.activity = { state: "unavailable", why: "neither answered", source: "indexer" })],
    ["registry_unreadable", (s) => (s.registry = { state: "unavailable", id: "registry.a-identity.testnet", why: "get_verdict answered an unknown shape", source: "rpc" })],
    ["blocklist_unreadable", (s) => (s.usdc = { state: "unavailable", why: "UNAVAILABLE", source: "rpc" })],
    ["vault_unreadable", (s) => (s.vault = { state: "unavailable", id: "vault.aid-demo-owner.testnet", why: "UNAVAILABLE", source: "rpc" })],
  ];
  for (const [code, patch] of cases) {
    it(`${code}`, () => {
      const d = with_((s) => {
        patch(s);
        if (s.vault.state !== "unavailable") s.vault = { ...VAULT_OK, paid_count: 5, allowlisted: true };
      });
      assert.equal(d.verdict, "WARN");
      assert.ok(deciding(d).includes(code), JSON.stringify(codes(d)));
      assert.equal(d.warn_kind, "hard");
    });
  }

  it("third-party and ERC-8004 outages are info only: optional, attributed sources", () => {
    const d = with_((s) => {
      s.third_party = [{ state: "unavailable", source: { id: "tripwire", name: "Tripwire", contract: "tripwire-registry-44ea74.testnet", network: "testnet", method: "get_risk", arg: "account_id" }, why: "UNAVAILABLE" }];
      s.erc8004 = { state: "unavailable", why: "UNAVAILABLE", source: "rpc" };
    });
    assert.equal(d.verdict, "ALLOW");
    assert.equal(reason(d, "third_party_unreadable")!.severity, "info");
  });
});

describe("table invariants", () => {
  it("every reason code is a registry reason code: 1 to 32 bytes of [a-z0-9_]", () => {
    for (const code of REASON_CODES) assert.match(code, /^[a-z0-9_]{1,32}$/);
  });

  it("each reason code has exactly one rule, and every rule's code is declared", () => {
    const ruleCodes = RULES.map((r) => r.code);
    assert.equal(new Set(ruleCodes).size, ruleCodes.length);
    assert.deepEqual([...ruleCodes].sort(), [...REASON_CODES].sort());
  });

  it("random signal mixes always land the score inside the verdict's band and decide deterministically", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed / 0x7fffffff);
    for (let i = 0; i < 500; i++) {
      const s = baseSignals();
      if (rnd() < 0.2) s.age = NEW_AGE;
      if (rnd() < 0.2) s.activity = { state: "ok", tx_count: Math.floor(rnd() * 5), at_least: false, first_tx: null, source: "i" };
      if (rnd() < 0.1) s.usdc = { state: "ok", blocklisted: true, registered: null, source: "u" };
      if (rnd() < 0.1) s.activity = { state: "unavailable", why: "x", source: "i" };
      if (rnd() < 0.3) s.vault = { ...VAULT_OK, paid_count: Math.floor(rnd() * 3), refusal_count: rnd() < 0.2 ? 1 : 0, allowlisted: rnd() < 0.3 };
      if (rnd() < 0.2) s.lookalike = { known: "aid-demo-merchant.testnet", kind: "homoglyph", strong: rnd() < 0.7, distance: 1, similarity: 1, detail: "x" };
      if (rnd() < 0.2) s.key_changes = { state: "ok", added_full_access: ["ed25519:x"], source: "r" };
      const d = decide(s);
      assert.ok(inBand(d), `score ${d.score} outside ${d.verdict}`);
      assert.deepEqual(decide(structuredClone(s)), d);
      if (d.verdict === "ALLOW") assert.equal(deciding(d).length, 0);
      if (deciding(d).some((c) => ["usdc_blocklisted", "account_not_found", "registry_deny", "lookalike_new_account"].includes(c))) assert.equal(d.verdict, "DENY");
      if (s.lookalike && !s.lookalike.strong) assert.ok(!codes(d).includes("lookalike_new_account"), "a weak match never denies");
    }
  });

  it("registryReasons gives the deciding codes, at most 8, for the registry's reasons field", () => {
    const d = with_((s) => {
      s.age = NEW_AGE;
      s.activity = { state: "ok", tx_count: 0, at_least: false, first_tx: null, source: "i" };
      s.usdc = { state: "unavailable", why: "x", source: "u" };
    });
    const rr = registryReasons(d);
    assert.deepEqual(rr, ["new_account", "low_activity", "blocklist_unreadable"]);
    const denied = with_((s) => (s.usdc = { state: "ok", blocklisted: true, registered: null, source: "u" }));
    assert.deepEqual(registryReasons(denied), ["usdc_blocklisted"]);
    assert.deepEqual(registryReasons(decide(baseSignals())), ["long_history"]);
  });
});

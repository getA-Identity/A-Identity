import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { accountKind, isValidAccountId } from "../src/engine/account.ts";
import { compareAccounts, editDistance, findLookalike, hexBody, skeleton } from "../src/engine/lookalike.ts";
import { DEFAULT_POLICY } from "../src/engine/policy.ts";

const P = DEFAULT_POLICY.lookalike;
const kindOf = (payee: string, known: string) => compareAccounts(payee, known, P)?.kind ?? null;

describe("homoglyphs and separator tricks", () => {
  const cases: [string, string][] = [
    ["aid-demo-rnerchant.testnet", "aid-demo-merchant.testnet"], // rn reads as m
    ["ref-flnance.near", "ref-finance.near"], // l for i
    ["g00gle-pay.near", "google-pay.near"], // 0 for o
    ["vvallet-ops.near", "wallet-ops.near"], // vv for w
    ["clao-treasury.near", "dao-treasury.near"], // cl for d
    ["pay1ink.near", "paylink.near"], // 1 for l
    ["aiddemo-merchant.testnet", "aid-demo-merchant.testnet"], // dropped hyphen
    ["aid_demo_merchant.testnet", "aid-demo-merchant.testnet"], // underscores
    ["aid-demo.merchant-x.testnet", "aid-demomerchant-x.testnet"], // a dot that reads like a separator
  ];
  for (const [payee, known] of cases) {
    it(`${payee} looks like ${known}`, () => assert.equal(kindOf(payee, known), "homoglyph"));
  }
  it("the skeleton folds look-alike characters and drops separators", () => {
    assert.equal(skeleton("aid-demo-rnerchant"), skeleton("aid-demo-merchant"));
    assert.equal(skeleton("A1D_DEMO"), "alddemo");
  });
});

describe("parent and network swaps", () => {
  const strength = (payee: string, known: string) => compareAccounts(payee, known, P)?.strong ?? null;
  it(".near vs .testnet with the same name", () => {
    assert.equal(kindOf("aid-demo-merchant.near", "aid-demo-merchant.testnet"), "parent_swap");
    assert.equal(strength("aid-demo-merchant.near", "aid-demo-merchant.testnet"), true);
  });
  it("the known account's own name as a first label under someone else's account is strong", () => {
    assert.equal(kindOf("aid-demo-merchant.attacker.testnet", "aid-demo-merchant.testnet"), "parent_swap");
    assert.equal(strength("aid-demo-merchant.attacker.testnet", "aid-demo-merchant.testnet"), true);
    assert.equal(strength("merchant.evil.near", "merchant.near"), true);
  });
  it("a generic short first label is not a swap", () => assert.equal(kindOf("app.bob.near", "app.alice.near"), null));

  // A role label under someone's account is not that account's name: any account can create
  // agent.<itself>. Siblings match only weakly, so a new one is held for the owner, never refused.
  const siblings: [string, string][] = [
    ["agent.bob.testnet", "agent.alice.testnet"],
    ["vault.someone.testnet", "vault.aid-demo-owner.testnet"],
    ["store.bob.near", "store.alice.near"],
    ["payments.ref.near", "payments.sweat.near"],
  ];
  for (const [payee, known] of siblings) {
    it(`${payee} vs ${known}: a role-label sibling is a weak parent swap`, () => {
      const m = compareAccounts(payee, known, P)!;
      assert.equal(m.kind, "parent_swap");
      assert.equal(m.strong, false);
      assert.match(m.detail, /role label/);
    });
  }

  it("a weak sibling match never hides a strong one for the same known account", () => {
    const affix = compareAccounts("agent.alice-pay.testnet", "agent.alice.testnet", P)!;
    assert.deepEqual([affix.kind, affix.strong], ["affix", true]);
    const edit = compareAccounts("agent.alicee.testnet", "agent.alice.testnet", P)!;
    assert.deepEqual([edit.kind, edit.strong], ["edit_distance", true]);
    assert.deepEqual([kindOf("agent.a1ice.testnet", "agent.alice.testnet"), strength("agent.a1ice.testnet", "agent.alice.testnet")], ["homoglyph", true]);
  });

  it("findLookalike prefers a strong match over a weak one, whatever the kind ranks", () => {
    const m = findLookalike("vault.aid-demo-merchamt.testnet", ["vault.aid-demo-owner.testnet", "vault.aid-demo-merchant.testnet"], P)!;
    assert.equal(m.strong, true);
    assert.equal(m.known, "vault.aid-demo-merchant.testnet");
    const weakOnly = findLookalike("vault.zed.testnet", ["vault.aid-demo-owner.testnet"], P)!;
    assert.deepEqual([weakOnly.kind, weakOnly.strong], ["parent_swap", false]);
  });
});

describe("edit distance and affixes", () => {
  it("a transposition is one edit", () => {
    assert.equal(editDistance("merchant", "merhcant"), 1);
    assert.equal(kindOf("aid-demo-merhcant.testnet", "aid-demo-merchant.testnet"), "edit_distance");
  });
  it("one substitution on a long name", () => assert.equal(kindOf("aid-demo-merchamt.testnet", "aid-demo-merchant.testnet"), "edit_distance"));
  it("two edits are allowed from 9 characters on, not below", () => {
    assert.equal(kindOf("merchxxnt.near", "merchaant.near"), "edit_distance");
    assert.equal(kindOf("abcxy.near", "abczz.near"), null);
  });
  it("names shorter than 5 characters only match on identical skeletons", () => {
    assert.equal(kindOf("rob.near", "bob.near"), null);
    assert.equal(kindOf("b0b.near", "bob.near"), "homoglyph");
  });
  it("a known name with a short affix", () => {
    assert.equal(kindOf("aid-demo-merchant-pay.testnet", "aid-demo-merchant.testnet"), "affix");
    assert.equal(kindOf("pay-aid-demo-merchant.testnet", "aid-demo-merchant.testnet"), "affix");
    assert.equal(kindOf("aid-demo-merch.testnet", "aid-demo-merchant.testnet"), "affix");
  });
  it("a long affix is a different name", () => assert.equal(kindOf("aid-demo-merchant-services-intl.testnet", "aid-demo-merchant.testnet"), null));
});

describe("implicit accounts: address poisoning", () => {
  const known = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809";
  const poisoned = "1a2b0000000000000000000000000000000000000000000000000000000ef809";
  it("same first 4 and last 4 hex digits", () => {
    assert.equal(accountKind(poisoned), "implicit");
    assert.equal(kindOf(poisoned, known), "address_poisoning");
  });
  it("an eth-implicit account whose hex body matches", () => assert.equal(kindOf("0x1a2b00000000000000000000000000000000f809", known), "address_poisoning"));
  it("a named account whose first label is hex (implicit vs named confusion)", () => {
    assert.equal(hexBody("1a2b3c4d5e6f7081ffffef809.testnet"), "1a2b3c4d5e6f7081ffffef809");
    assert.equal(kindOf("1a2b3c4d5e6f7081ffffef809.testnet", known), "address_poisoning");
  });
  it("unrelated implicit accounts do not match", () => assert.equal(kindOf("ffff3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809", known), null));
});

describe("not lookalikes", () => {
  it("the known account itself", () => assert.equal(kindOf("aid-demo-merchant.testnet", "aid-demo-merchant.testnet"), null));
  it("a sub-account (only the parent can create it)", () => {
    assert.equal(kindOf("pay.aid-demo-merchant.testnet", "aid-demo-merchant.testnet"), null);
    assert.equal(kindOf("aid-demo-merchant.testnet", "pay.aid-demo-merchant.testnet"), null);
  });
  it("unrelated names", () => {
    assert.equal(kindOf("wrap.testnet", "aid-demo-merchant.testnet"), null);
    assert.equal(kindOf("aid-demo-owner.testnet", "aid-demo-merchant.testnet"), null);
  });
});

describe("findLookalike", () => {
  it("returns the strongest match and does not depend on the order of the known list", () => {
    const known = ["aid-demo-merchant-pay.testnet", "aid-demo-merchant.testnet", "wrap.testnet"];
    const a = findLookalike("aid-demo-rnerchant.testnet", known, P);
    const b = findLookalike("aid-demo-rnerchant.testnet", [...known].reverse(), P);
    assert.deepEqual(a, b);
    assert.equal(a?.kind, "homoglyph");
    assert.equal(a?.known, "aid-demo-merchant.testnet");
  });
  it("is null against an empty known set", () => assert.equal(findLookalike("aid-demo-rnerchant.testnet", [], P), null));
});

describe("account ids", () => {
  it("validates NEAR account ids", () => {
    for (const ok of ["wrap.testnet", "a-b_c.near", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809", "0x1a2b00000000000000000000000000000000f809"]) assert.ok(isValidAccountId(ok), ok);
    for (const bad of ["", "a", "Upper.near", "a..b", "-a.near", "a-.near", "x".repeat(65), "has space.near"]) assert.ok(!isValidAccountId(bad), bad);
  });
  it("classifies kinds", () => {
    assert.equal(accountKind("wrap.testnet"), "named");
    assert.equal(accountKind(`0s${"a".repeat(40)}`), "deterministic");
    assert.equal(accountKind(`0u${"b".repeat(52)}`), "universal");
  });
});

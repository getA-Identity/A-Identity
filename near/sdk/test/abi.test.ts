// The SDK's copy of the contracts' ABI facts (src/chain/abi.ts), held to the contract source it
// restates: the vault's version, agent methods, bounds, hold kinds, error names and event
// names, and the registry's error names. A contract change that renames, reorders or adds one
// fails here until abi.ts follows. Skipped only where the contract sources are not checked out.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AGENT_METHODS,
  HOLD_KINDS,
  isVaultError,
  MAX_FORGET_BATCH,
  MAX_GUARD_PAYEES,
  MAX_PENDING_HELD,
  MAX_REFUSAL_PAYEES,
  parseHoldKind,
  REASON_REGISTRY_WARN,
  REASON_UNKNOWN_PAYEE,
  REGISTRY_ERRORS,
  VAULT_ERRORS,
  VAULT_EVENTS,
  VAULT_VERSION,
  VAULT_VERSION_PREFIX,
} from "../src/chain/abi.ts";

const CONTRACTS = join(import.meta.dirname, "..", "..", "contracts");
const VAULT_SRC = join(CONTRACTS, "agent-spend-policy", "src");
const REGISTRY_SRC = join(CONTRACTS, "a-identity-registry", "src");
const skip = existsSync(join(VAULT_SRC, "lib.rs")) && existsSync(join(REGISTRY_SRC, "error.rs")) ? false : "contract sources not present";
const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

/** CamelCase to the snake_case serde and near-sdk's event macro write. */
const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** The body of `pub enum <name>` up to its closing brace at column 0. */
function enumBody(source: string, name: string): string {
  const start = source.search(new RegExp(`pub enum ${name}\\b`));
  assert.ok(start >= 0, `enum ${name} not found`);
  const end = source.indexOf("\n}", start);
  return source.slice(start, end);
}

/** The names `as_str` maps each variant to, in source order, checking each name is its variant's. */
function errorNames(source: string): string[] {
  const arms = [...source.matchAll(/Error::(\w+) => "(\w+)",/g)];
  for (const [, variant, name] of arms) assert.equal(name, variant, `the stable name of ${variant}`);
  return arms.map((m) => m[2]!);
}

/** The variants of `pub const ALL: [Error; n]`, in order, and n. */
function errorAll(source: string): { count: number; names: string[] } {
  const m = /pub const ALL: \[Error; (\d+)\] = \[([\s\S]*?)\];/.exec(source);
  assert.ok(m, "Error::ALL not found");
  return { count: Number(m[1]), names: [...m[2]!.matchAll(/Error::(\w+),/g)].map((x) => x[1]!) };
}

const rustConst = (source: string, name: string, type: string) => {
  const m = new RegExp(`pub const ${name}: ${type.replace(/[&]/g, "\\&")} = "?([^";]+)"?;`).exec(source);
  assert.ok(m, `${name} not found`);
  return m[1]!;
};

describe("the vault's ABI, as the SDK restates it", { skip }, () => {
  it("version, agent methods, bounds and the held reasons are the contract's", () => {
    const lib = read(VAULT_SRC, "lib.rs");
    assert.equal(rustConst(lib, "VERSION", "&str"), VAULT_VERSION);
    assert.ok(VAULT_VERSION.startsWith(VAULT_VERSION_PREFIX));
    assert.equal(rustConst(lib, "AGENT_METHODS", "&str"), AGENT_METHODS.join(","));
    assert.equal(Number(rustConst(lib, "MAX_GUARD_PAYEES", "u32")), MAX_GUARD_PAYEES);
    assert.equal(Number(rustConst(lib, "MAX_REFUSAL_PAYEES", "u32")), MAX_REFUSAL_PAYEES);
    assert.equal(Number(rustConst(lib, "MAX_FORGET_BATCH", "usize")), MAX_FORGET_BATCH);
    assert.equal(Number(rustConst(read(VAULT_SRC, "policy.rs"), "MAX_PENDING_HELD", "u32")), MAX_PENDING_HELD);
    assert.equal(rustConst(lib, "REASON_REGISTRY_WARN", "&str"), REASON_REGISTRY_WARN);
    assert.equal(rustConst(lib, "REASON_UNKNOWN_PAYEE", "&str"), REASON_UNKNOWN_PAYEE);
  });

  it("every error name, in ABI order, the 0.2.0 names appended last", () => {
    const source = read(VAULT_SRC, "error.rs");
    assert.deepEqual(errorNames(source), [...VAULT_ERRORS]);
    const all = errorAll(source);
    assert.equal(all.count, VAULT_ERRORS.length);
    assert.deepEqual(all.names, [...VAULT_ERRORS]);
    assert.deepEqual(VAULT_ERRORS.slice(VAULT_ERRORS.indexOf("NotCallback")), ["NotCallback", "GuardRefusalLimitReached", "StorageNotCovered", "InitNotAllowed", "BatchTooLarge"]);
    assert.ok(isVaultError("StorageNotCovered") && !isVaultError("FiatToken: paused") && !isVaultError(7));
  });

  it("the hold kinds are HoldKind's variants, snake_case", () => {
    const body = enumBody(read(VAULT_SRC, "types.rs"), "HoldKind");
    const variants = [...body.matchAll(/^ {4}([A-Z]\w*),$/gm)].map((m) => snake(m[1]!));
    assert.deepEqual(variants, [...HOLD_KINDS]);
  });

  it("every event name, in event.rs order, with kind on payment_held and payee and count on the two forget events", () => {
    const source = read(VAULT_SRC, "event.rs");
    const body = enumBody(source, "VaultEvent");
    const variants = [...body.matchAll(/^ {4}([A-Z]\w*) \{/gm)].map((m) => m[1]!);
    assert.deepEqual(variants.map(snake), [...VAULT_EVENTS]);
    const fields = (variant: string) => {
      const at = body.indexOf(`    ${variant} {`);
      return body.slice(at, body.indexOf("}", at));
    };
    assert.match(fields("PaymentHeld"), /kind: HoldKind/);
    for (const v of ["GuardRefusalsForgotten", "RefusalsForgotten"]) assert.match(fields(v), /payee: &'a AccountId, count: u32/);
  });

  it("the forget methods exist under the names the client calls", () => {
    const lib = read(VAULT_SRC, "lib.rs");
    for (const m of ["forget_guard_refusals", "forget_refusals"]) assert.match(lib, new RegExp(`pub fn ${m}\\(&mut self, payees: Vec<AccountId>\\)`));
    for (const m of ["guard_refusal_payees", "refusal_payees"]) assert.match(lib, new RegExp(`pub fn ${m}\\(&self\\) -> u32`));
  });
});

describe("the registry's ABI, as the SDK restates it", { skip }, () => {
  it("every error name, in ABI order, InitNotAllowed appended last", () => {
    const source = read(REGISTRY_SRC, "error.rs");
    assert.deepEqual(errorNames(source), [...REGISTRY_ERRORS]);
    const all = errorAll(source);
    assert.equal(all.count, REGISTRY_ERRORS.length);
    assert.deepEqual(all.names, [...REGISTRY_ERRORS]);
    assert.equal(REGISTRY_ERRORS.at(-1), "InitNotAllowed");
  });
});

describe("hold kinds and the forget bound", () => {
  it("parseHoldKind knows the three kinds and nothing else", () => {
    for (const k of HOLD_KINDS) assert.equal(parseHoldKind(k), k);
    for (const bad of [undefined, null, "RegistryWarn", "registry_warn ", "agent_asked", 3, {}]) assert.equal(parseHoldKind(bad), null, String(bad));
  });

  it("a full forget call stays inside a receipt's 100 lines and 16384 bytes of log", () => {
    // The longest line one removal can log: a 64-byte payee and the largest u32 count.
    const payee = `${"x".repeat(56)}.testnet`;
    const line = `EVENT_JSON:${JSON.stringify({ standard: "a_identity_vault", version: "1.0.0", event: "guard_refusals_forgotten", data: { payee, count: 4294967295 } })}`;
    assert.equal(payee.length, 64);
    assert.equal(line.length, 198, "the contract's own figure for the longest line");
    assert.ok(MAX_FORGET_BATCH <= 100);
    assert.ok(MAX_FORGET_BATCH * line.length <= 16384, `${MAX_FORGET_BATCH} x ${line.length} bytes`);
    assert.ok(100 * line.length > 16384, "a full map in one call would not fit, which is why the bound exists");
  });
});

// GENERATED FILE: do not edit.
// Source: near/sdk/src/engine/account.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// NEAR account ids: validation and kinds.
//
// The kinds matter to the verdict. A named account that does not exist can be registered by
// anyone, so tokens sent to it go to whoever registers the name first. An implicit account that
// does not exist yet is normal (it appears when first funded) and is controlled by whoever holds
// its private key. NEP-616 deterministic (0s) and protocol-88 universal (0u) accounts are
// derived from code and state, and Ethereum-style (0x) accounts from an EVM key.

import type { AccountKind } from "./types.js";

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID.test(id);
}

export function accountKind(id: string): AccountKind {
  if (/^[0-9a-f]{64}$/.test(id)) return "implicit";
  if (/^0x[0-9a-f]{40}$/.test(id)) return "eth_implicit";
  if (/^0s[0-9a-f]{40}$/.test(id)) return "deterministic";
  if (/^0u[0-9a-f]{52}$/.test(id)) return "universal";
  return "named";
}

/** Kinds whose account exists only once something funds or initializes it. */
export function isKeyDerived(kind: AccountKind): boolean {
  return kind !== "named";
}

/** Top-level suffixes a payee name is usually under. */
const NETWORK_TLAS = new Set(["near", "testnet"]);

export type AccountParts = {
  labels: string[];
  /** "near" or "testnet" when the id ends with one, else null. */
  tla: string | null;
  /** The id without that suffix ("aid-demo-merchant" for "aid-demo-merchant.testnet"). */
  name: string;
  first: string;
  /** Everything after the first label, "" for a top-level account. */
  parent: string;
};

export function accountParts(id: string): AccountParts {
  const labels = id.split(".");
  const last = labels.length > 1 ? labels[labels.length - 1]! : null;
  const tla = last !== null && NETWORK_TLAS.has(last) ? last : null;
  const name = tla === null ? id : labels.slice(0, -1).join(".");
  return { labels, tla, name, first: labels[0]!, parent: labels.slice(1).join(".") };
}

/** True when one id is a sub-account of the other: only the parent can create a sub-account. */
export function isRelated(a: string, b: string): boolean {
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

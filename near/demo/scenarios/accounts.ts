// The demo's accounts. Every name is deterministic so the run, the README and the judge script
// point at the same objects, and every one of them belongs to A-Identity's demo setup.
//
// Two of them are created fresh by the deploy step, minutes before the recorded run, because the
// signals the verdict is computed from (account age, a recently added full-access key, the
// similarity to a payee the vault already knows) only mean something on a new account:
//
//   lookalike   aid-demo-merchamt.testnet   "merchant" with its last "n" turned into "m": one
//               substitution (edit distance 1 to aid-demo-merchant.testnet), easy to miss when
//               read quickly. It stands in for the account a fraudster registers to redirect
//               invoice payments. It gets no hand-written label anywhere: its verdict comes from
//               the engine's computed signals.
//   new vendor  aid-demo-printshop.testnet  a legitimate vendor the vault has never paid and
//               nobody has judged. Not similar to any known payee.
//
// Both are created the same way, with near-cli-rs (10 NEAR from the testnet faucet helper, one
// full-access key saved to the local keychain and never used by the demo):
//
//   near account create-account sponsor-by-faucet-service aid-demo-merchamt.testnet \
//     autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
//   near account create-account sponsor-by-faucet-service aid-demo-printshop.testnet \
//     autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
//
// aid-demo-attacker.testnet exists from an earlier setup and is deliberately NOT used: an account
// literally named "attacker" proves nothing about a classifier. `assertNoAttackerNames` enforces it.

import type { Env } from '../lib/config.ts';

export type DemoAccounts = {
  /** The vault's human owner; approves held payments with a full-access key. */
  owner: string;
  /** The agent spend vault. Its only key is the agent's function-call key. */
  vault: string;
  /** A-Identity's verdict registry, read by the vault before every payment. */
  registry: string;
  /** The oracle account; signs set_verdict with a function-call key scoped to the registry. */
  oracle: string;
  /** The legitimate payee the vault already knows. */
  merchant: string;
  /** The fresh lookalike of the merchant. */
  lookalike: string;
  /** The fresh, never-judged legitimate vendor. */
  newVendor: string;
};

export const DEFAULT_ACCOUNTS: DemoAccounts = {
  owner: 'aid-demo-owner.testnet',
  vault: 'vault.aid-demo-owner.testnet',
  registry: 'registry.a-identity.testnet',
  oracle: 'oracle.a-identity.testnet',
  merchant: 'aid-demo-merchant.testnet',
  lookalike: 'aid-demo-merchamt.testnet',
  newVendor: 'aid-demo-printshop.testnet',
};

const ENV_NAMES: Record<keyof DemoAccounts, string> = {
  owner: 'AID_OWNER',
  vault: 'AID_VAULT',
  registry: 'AID_REGISTRY',
  oracle: 'AID_ORACLE',
  merchant: 'AID_MERCHANT',
  lookalike: 'AID_LOOKALIKE',
  newVendor: 'AID_NEW_VENDOR',
};

/** NEAR account id rules: 2 to 64 characters, lowercase alphanumerics separated by single "-",
 * "_" or "." characters. Covers named and 64-hex implicit accounts. */
export function isValidAccountId(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

export function assertNoAttackerNames(accounts: DemoAccounts): void {
  for (const [role, id] of Object.entries(accounts)) {
    if (id.includes('attacker')) {
      throw new Error(
        `${role} = ${id}: the demo never uses an account named "attacker"; a verdict on it would prove nothing`,
      );
    }
  }
}

export function accountsFromEnv(env: Env): DemoAccounts {
  const out = { ...DEFAULT_ACCOUNTS };
  for (const key of Object.keys(ENV_NAMES) as Array<keyof DemoAccounts>) {
    const value = env[ENV_NAMES[key]]?.trim();
    if (value) out[key] = value;
  }
  for (const [role, id] of Object.entries(out)) {
    if (!isValidAccountId(id)) throw new Error(`${role} = ${JSON.stringify(id)} is not a valid NEAR account id`);
  }
  assertNoAttackerNames(out);
  return out;
}

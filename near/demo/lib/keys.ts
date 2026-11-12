// Signing keys for the demo and the oracle, read from the near-cli legacy keychain
// (~/.near-credentials/testnet) or from a file named in an environment variable. Keys never live
// in this repository, and an environment variable may only hold a PATH, never a key.
//
// A key file must be private to its owner (mode 0600 or stricter): a file that group or others
// can read is refused, the way ssh refuses a loose private key. The secret is kept inside a
// closure, so JSON.stringify drops it and util.inspect shows a function, and nothing in this
// module prints it. Only the fields named below are read: a keychain file can also hold a seed
// phrase, which is never touched.
//
// A key whose secret has been seen outside the keychain is refused by its PUBLIC key, whatever
// file holds it (EXPOSED_PUBLIC_KEYS, plus AID_REVOKED_KEYS). Rotating it on chain is the owner's
// job; refusing it here means the demo can never be the thing that signs with it.
//
// A missing or unusable key is not an error for the caller: it gets { ok: false, reason } and
// turns the write into a labeled "prepared, not executed" step.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Env } from './config.ts';
import { displayPath } from './paths.ts';

export type KeyRole = 'agent' | 'owner' | 'oracle';

export type LoadedKey = {
  role: KeyRole;
  /** The account the key signs as. For the agent this is the VAULT account: the agent's only key
   * is a function-call key that lives on the vault. */
  accountId: string;
  publicKey: string;
  path: string;
  secret: () => string;
};

export type KeyLookup = { ok: true; key: LoadedKey } | { ok: false; reason: string; tried: string[] };

export const KEY_ENV: Record<KeyRole, string> = {
  agent: 'AID_AGENT_KEY_FILE',
  owner: 'AID_OWNER_KEY_FILE',
  oracle: 'AID_ORACLE_KEY_FILE',
};

/**
 * Public keys this code never signs with. A key lands here when its secret, or the seed phrase
 * stored next to it in a keychain file, has been seen outside the keychain. Public keys only:
 * nothing here is secret.
 */
export const EXPOSED_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  'ed25519:8M2Ppf2etZtcYEXHAztXwW9nyagyZ8N6sLSUZRERTxdL':
    "aid-demo-owner.testnet's keychain file (seed phrase included) was exposed on 2026-11-12; add a new full-access key, delete this one on chain, and move its keychain files out of ~/.near-credentials (demo/README.md, \"The owner key\")",
};

/** EXPOSED_PUBLIC_KEYS plus the comma list in AID_REVOKED_KEYS. */
export function revokedKeys(env: Env): Map<string, string> {
  const out = new Map(Object.entries(EXPOSED_PUBLIC_KEYS));
  for (const k of (env.AID_REVOKED_KEYS ?? '').split(',')) {
    const pk = k.trim();
    if (pk !== '' && !out.has(pk)) out.set(pk, 'listed in AID_REVOKED_KEYS');
  }
  return out;
}

export function credentialsDir(env: Env): string {
  return env.NEAR_CREDENTIALS_DIR?.trim() || join(homedir(), '.near-credentials', 'testnet');
}

const KEY_PREFIXES = ['ed25519:', 'secp256k1:'];

/** Group and other permission bits must be clear. */
export function isPrivateMode(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export function readKeyFile(path: string, role: KeyRole, expectAccount?: string, revoked: ReadonlyMap<string, string> = revokedKeys({})): KeyLookup {
  const shown = displayPath(path);
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { ok: false, reason: `no key file at ${shown}`, tried: [path] };
  }
  if (!isPrivateMode(mode)) {
    const octal = (mode & 0o777).toString(8).padStart(4, '0');
    return { ok: false, reason: `${shown} has mode ${octal}, readable by group or others; run: chmod 600 ${shown}`, tried: [path] };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: `${shown} is not a JSON key file`, tried: [path] };
  }
  const secretRaw = parsed.private_key ?? parsed.secret_key;
  const publicKey = parsed.public_key;
  const fileAccount = typeof parsed.account_id === 'string' ? parsed.account_id : undefined;
  if (typeof secretRaw !== 'string' || !KEY_PREFIXES.some((p) => secretRaw.startsWith(p))) {
    return { ok: false, reason: `${shown} has no private_key of the form ed25519:...`, tried: [path] };
  }
  if (typeof publicKey !== 'string' || !KEY_PREFIXES.some((p) => publicKey.startsWith(p))) {
    return { ok: false, reason: `${shown} has no public_key of the form ed25519:...`, tried: [path] };
  }
  const exposed = revoked.get(publicKey);
  if (exposed !== undefined) {
    return { ok: false, reason: `${shown} holds ${publicKey}, a key this demo never signs with: ${exposed}`, tried: [path] };
  }
  if (expectAccount && fileAccount && fileAccount !== expectAccount) {
    return { ok: false, reason: `${shown} is a key for ${fileAccount}, expected ${expectAccount}`, tried: [path] };
  }
  const accountId = fileAccount ?? expectAccount;
  if (!accountId) return { ok: false, reason: `${shown} does not say which account it belongs to`, tried: [path] };
  const secret = secretRaw;
  return { ok: true, key: { role, accountId, publicKey, path, secret: () => secret } };
}

/**
 * Find the key `role` signs with as `accountId`. The environment variable for the role, when set,
 * is the only place looked at. Otherwise the legacy keychain: <dir>/<account>.json and every
 * <dir>/<account>/*.json. When several distinct keys are found, `preferPublicKeys` (for example
 * the account's on-chain key list) narrows them; if that still leaves more than one, the caller
 * must name the file. Exposed keys are never among the candidates.
 */
export function findKey(role: KeyRole, accountId: string, env: Env, preferPublicKeys?: string[]): KeyLookup {
  const revoked = revokedKeys(env);
  const fromEnv = env[KEY_ENV[role]]?.trim();
  if (fromEnv) return readKeyFile(fromEnv, role, accountId, revoked);

  const dir = credentialsDir(env);
  const candidates: string[] = [join(dir, `${accountId}.json`)];
  try {
    for (const name of readdirSync(join(dir, accountId)).sort()) {
      if (name.endsWith('.json')) candidates.push(join(dir, accountId, name));
    }
  } catch {
    // no per-account folder
  }
  const found = new Map<string, LoadedKey>();
  const problems: string[] = [];
  for (const path of candidates) {
    const r = readKeyFile(path, role, accountId, revoked);
    if (r.ok) {
      if (!found.has(r.key.publicKey)) found.set(r.key.publicKey, r.key);
    } else if (!r.reason.startsWith('no key file') && !problems.includes(r.reason)) {
      problems.push(r.reason);
    }
  }
  let keys = [...found.values()];
  if (preferPublicKeys && keys.length > 1) {
    const narrowed = keys.filter((k) => preferPublicKeys.includes(k.publicKey));
    if (narrowed.length > 0) keys = narrowed;
  }
  if (keys.length === 1 && keys[0]) return { ok: true, key: keys[0] };
  if (keys.length > 1) {
    return {
      ok: false,
      reason: `${keys.length} keys found for ${accountId} (${keys.map((k) => k.publicKey).join(', ')}); name one with ${KEY_ENV[role]}`,
      tried: candidates,
    };
  }
  const why = problems.length > 0 ? problems.join('; ') : `no key file for ${accountId} in ${displayPath(dir)}`;
  return { ok: false, reason: `${why}; or set ${KEY_ENV[role]} to a 0600 key file`, tried: candidates };
}

/** Safe to print: account, public key and path, never the secret. */
export function describeKey(key: LoadedKey): string {
  return `${key.accountId} ${key.publicKey} (${displayPath(key.path)})`;
}

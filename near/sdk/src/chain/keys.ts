// Load a signing key from a file readable only by its owner (mode 0600) or from an environment
// variable, and never let it reach a log, an error message or a JSON dump.
//
// No key ever lives in this repository. A missing key is not an error: the caller gets null and
// the SDK returns the exact transaction it would have sent, labeled prepared (the repository's
// prepared-or-executed rule). A key that is present but unsafe or malformed is an error, and the
// error names the file or the variable, never the key.

import { readFile, stat } from "node:fs/promises";
import { inspect } from "node:util";
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/** A loaded key. `signer` is not enumerable, and inspect/JSON show only the public key. */
export type LoadedKey = {
  readonly publicKey: string;
  /** Where it came from, for messages: "file <path>" or "env <NAME>". */
  readonly origin: string;
  readonly signer: KeyPairSigner;
};

export type LoadKeyOptions = {
  /** Path to a key file: "ed25519:..." on its own, or near-cli JSON with private_key or secret_key. */
  file?: string;
  /** Name of an environment variable holding "ed25519:...". */
  envVar?: string;
  env?: Record<string, string | undefined>;
  /** When set, the key must have this public key (catches loading the wrong file). */
  expectPublicKey?: string;
  /** Platform override for tests; the mode check runs on POSIX systems. */
  platform?: string;
};

function parseSecret(text: string, origin: string): KeyPairString {
  const trimmed = text.trim();
  let candidate: unknown = trimmed;
  if (trimmed.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      throw new KeyError(`${origin} is neither a key string nor valid JSON`);
    }
    const obj = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
    candidate = obj.private_key ?? obj.secret_key;
  }
  if (typeof candidate !== "string" || !/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/.test(candidate)) {
    throw new KeyError(`${origin} does not hold a key in the form ed25519:<base58>`);
  }
  return candidate as KeyPairString;
}

function wrap(secret: KeyPairString, origin: string, expectPublicKey: string | undefined): LoadedKey {
  let pair: KeyPair;
  try {
    pair = KeyPair.fromString(secret);
  } catch {
    throw new KeyError(`${origin} holds a malformed key`);
  }
  const signer = new KeyPairSigner(pair);
  const publicKey = pair.getPublicKey().toString();
  if (expectPublicKey !== undefined && expectPublicKey !== publicKey) {
    throw new KeyError(`${origin} holds the key for ${publicKey}, not the expected ${expectPublicKey}`);
  }
  const loaded = { publicKey, origin } as { publicKey: string; origin: string; signer: KeyPairSigner };
  Object.defineProperty(loaded, "signer", { value: signer, enumerable: false });
  Object.defineProperty(loaded, inspect.custom, { value: () => `LoadedKey(${publicKey}, ${origin})`, enumerable: false });
  Object.defineProperty(loaded, "toJSON", { value: () => ({ publicKey, origin }), enumerable: false });
  return Object.freeze(loaded);
}

export async function loadKey(opts: LoadKeyOptions): Promise<LoadedKey | null> {
  if (opts.file) {
    const origin = `file ${opts.file}`;
    let info;
    try {
      info = await stat(opts.file);
    } catch {
      throw new KeyError(`${origin} cannot be read`);
    }
    const platform = opts.platform ?? process.platform;
    if (platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new KeyError(`${origin} is readable by group or others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`);
    }
    return wrap(parseSecret(await readFile(opts.file, "utf8"), origin), origin, opts.expectPublicKey);
  }
  if (opts.envVar) {
    const value = (opts.env ?? process.env)[opts.envVar];
    if (value === undefined || value === "") return null;
    const origin = `env ${opts.envVar}`;
    return wrap(parseSecret(value, origin), origin, opts.expectPublicKey);
  }
  return null;
}

/** For tests and in-memory use: wrap a key string that is already in hand. */
export function keyFromSecret(secret: string, origin = "memory", expectPublicKey?: string): LoadedKey {
  return wrap(parseSecret(secret, origin), origin, expectPublicKey);
}

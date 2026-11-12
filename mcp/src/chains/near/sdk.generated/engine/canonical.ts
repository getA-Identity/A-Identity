// GENERATED FILE: do not edit.
// Source: near/sdk/src/engine/canonical.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// Canonical JSON and SHA-256, with no dependencies, so the engine runs the same in Node, in a
// browser (the /proof/near page) and anywhere else.
//
// Canonical JSON here is RFC 8785 (JCS) for the values a snapshot can hold: object keys sorted
// by UTF-16 code units, no whitespace, strings escaped exactly as JSON.stringify escapes them,
// integers written plainly. Anything JCS would serialize differently from JSON.stringify
// (non-integer floats in exotic forms) never appears in a snapshot, and non-finite numbers,
// bigints and functions are refused rather than silently dropped.

import type { JsonValue, Snapshot } from "./types.js";

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => (item === undefined ? "null" : write(item, `${path}[${i}]`))).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(compareUtf16);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${write(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Indented JSON for files people read and diff. Arrays of numbers or short scalars stay on one
 * line (a recorded view answer is an array of bytes). Formatting never affects a digest: the
 * digests are computed over canonicalJson, not over the file's text.
 */
export function prettyJson(value: unknown, indent = ""): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) return `[${value.map((v) => JSON.stringify(v) ?? "null").join(",")}]`;
    return `[\n${value.map((v) => `${next}${prettyJson(v, next)}`).join(",\n")}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, v]) => `${next}${JSON.stringify(k)}: ${prettyJson(v, next)}`).join(",\n")}\n${indent}}`;
}

// ---------------------------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), byte oriented.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Length in bits as a 64-bit big-endian integer; inputs here are far below 2^53 bits.
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function sha256Hex(text: string): string {
  return toHex(sha256(utf8(text)));
}

// ---------------------------------------------------------------------------------------------
// Snapshot digests.

/**
 * Identity of the evidence artifact: sha256 of the canonical JSON of the snapshot without its
 * `meta` (who collected it, when, through which hosts). Two copies of the same snapshot file have
 * the same digest however they are formatted.
 */
export function snapshotSha256(snapshot: Snapshot): string {
  const { meta: _meta, ...hashed } = snapshot;
  return sha256Hex(canonicalJson(hashed));
}

/**
 * Digest of the block-pinned chain reads only: every JSON-RPC request and its answer, with error
 * answers reduced to the fields that decide (name, cause, kind). Anyone who re-sends the same
 * requests to an archival node gets the same answers, so this digest is reproducible from the
 * chain alone, while snapshot_sha256 also covers indexer answers that are not pinned to a block.
 */
export function chainSha256(snapshot: Snapshot): string {
  const reads = snapshot.rpc
    .map((r) => {
      const entry: { [k: string]: JsonValue } = { label: r.label, network: r.network, method: r.method, params: r.params };
      if (r.error) entry.error = { name: r.error.name, cause: r.error.cause, kind: r.error.kind ?? null };
      else entry.result = r.result ?? null;
      return entry;
    })
    .sort((a, b) => compareUtf16(String(a.label), String(b.label)));
  return sha256Hex(canonicalJson({ subject: snapshot.subject, network: snapshot.network, block: snapshot.block, reads }));
}

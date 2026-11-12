// Evidence files (evidence/<claim id>.json) and the two transports built on them.
//
// capture.mjs runs every claim live through a RecordingTransport and writes down each raw
// JSON-RPC request and response with the RPC URL, the block it was read at and the time. The
// judge's --offline mode then runs the SAME check code through a ReplayTransport that answers
// each request from that file. Nothing is summarized or pre-digested: the offline verdict is
// re-derived from the raw responses, so offline is a faithful replay of what the chain said,
// and --verify-evidence can re-ask archival RPC the same questions at the same blocks.
//
// One field is transformed: any 64-byte ed25519 value (a transaction signature) is stored as
// the sha256 of its bytes. The repository's secret scanner (.gitleaks.toml) treats every 64-byte
// ed25519 value as a possible secret key, and no check reads signatures. The digest still lets
// anyone confirm the signature against archival RPC.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { decode as b58decode } from './base58.mjs';
import { canonical } from './json.mjs';

export const EVIDENCE_SCHEMA = 'a-identity-near-evidence/1';

const SIGNATURE_64 = /^ed25519:[1-9A-HJ-NP-Za-km-z]{85,90}$/;
export const REDACTED_PREFIX = 'ed25519-signature-sha256:';

/** Claim is waiting on something that does not exist yet (not a failure). */
export class PendingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PendingError';
  }
}

/** The environment cannot run this check (a missing tool, an unsupported platform). */
export class SkipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkipError';
  }
}

/** Offline and there is no evidence file for this claim. */
export class EvidenceAbsentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvidenceAbsentError';
  }
}

/** Offline and the evidence file does not hold the answer this check asks for: the file was
 *  captured for different deployments or claims, so it no longer proves this claim. */
export class EvidenceStaleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EvidenceStaleError';
  }
}

export function redactSignatures(value) {
  if (typeof value === 'string') {
    if (!SIGNATURE_64.test(value)) return value;
    try {
      const bytes = b58decode(value.slice('ed25519:'.length));
      if (bytes.length !== 64) return value;
      return REDACTED_PREFIX + createHash('sha256').update(bytes).digest('hex');
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) return value.map(redactSignatures);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSignatures(child)]));
  }
  return value;
}

export function requestKey(network, method, params) {
  return `${network} ${method} ${canonical(params)}`;
}

export function loadEvidence(path) {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.schema !== EVIDENCE_SCHEMA) {
    throw new Error(`${path}: schema is ${JSON.stringify(parsed.schema)}, expected ${EVIDENCE_SCHEMA}`);
  }
  if (!Array.isArray(parsed.calls)) throw new Error(`${path}: no calls array`);
  return parsed;
}

/** Answers from an evidence file. The file is read on the first call, so a check that never
 *  touches the network (a repo scan, a command) does not need one. */
export class ReplayTransport {
  constructor(path, label) {
    this.path = path;
    this.label = label ?? path;
    this.evidence = undefined;
  }

  load() {
    if (this.evidence === undefined) this.evidence = loadEvidence(this.path);
    return this.evidence;
  }

  async call(spec) {
    const evidence = this.load();
    if (!evidence) throw new EvidenceAbsentError(`no recorded evidence (${this.label})`);
    const key = requestKey(spec.network, spec.method, spec.params);
    const hit = evidence.calls.find((call) => requestKey(call.network, call.request.method, call.request.params) === key);
    if (!hit) {
      const shown = canonical(spec.params);
      throw new EvidenceStaleError(
        `${this.label} has no recorded answer for ${spec.method} ${shown.length > 90 ? `${shown.slice(0, 87)}...` : shown}; re-run node judge/capture.mjs`,
      );
    }
    return { ...hit, replayed: true };
  }
}

/** Wraps a live transport and keeps every call, already redacted, for the evidence file. */
export class RecordingTransport {
  constructor(inner) {
    this.inner = inner;
    this.calls = [];
  }

  async call(spec) {
    const result = await this.inner.call(spec);
    const recorded = { ...result, response: redactSignatures(result.response) };
    this.calls.push(recorded);
    return recorded;
  }
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

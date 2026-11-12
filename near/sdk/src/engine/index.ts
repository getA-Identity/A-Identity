// The engine's public surface: check a snapshot, replay it, and get the verdict with both digests.
// Pure and dependency-free, so a browser page or a judge script can recompute a verdict from a
// saved snapshot with nothing but this directory.

import { isValidAccountId } from "./account.ts";
import { chainSha256, snapshotSha256 } from "./canonical.ts";
import { normalize } from "./normalize.ts";
import { DEFAULT_POLICY, type Policy } from "./policy.ts";
import { decide } from "./rules.ts";
import { SNAPSHOT_SCHEMA, type Decision, type Signals, type Snapshot } from "./types.ts";

export * from "./types.ts";
export { DEFAULT_POLICY, SCORE_BANDS, type Policy, type LookalikePolicy, type ScorePolicy } from "./policy.ts";
export { canonicalJson, chainSha256, prettyJson, sha256, sha256Hex, snapshotSha256, toHex, utf8 } from "./canonical.ts";
export { accountKind, accountParts, isRelated, isValidAccountId } from "./account.ts";
export { compareAccounts, editDistance, findLookalike, hexBody, skeleton } from "./lookalike.ts";
export { normalize, parseThirdParty, viewOf } from "./normalize.ts";
export { decide, registryReasons, RULES } from "./rules.ts";
export { LABEL } from "./labels.ts";

export type Replay = {
  decision: Decision;
  signals: Signals;
  snapshot_sha256: string;
  chain_sha256: string;
};

/** Recompute the verdict a snapshot supports. No network, no clock. */
export function verdictFromSnapshot(snapshot: Snapshot, policy: Policy = DEFAULT_POLICY): Replay {
  const signals = normalize(snapshot, policy);
  return {
    decision: decide(signals, policy),
    signals,
    snapshot_sha256: snapshotSha256(snapshot),
    chain_sha256: chainSha256(snapshot),
  };
}

export class SnapshotError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`not a valid A-Identity NEAR snapshot: ${problems.join("; ")}`);
    this.name = "SnapshotError";
    this.problems = problems;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Structural check before a replay. Beyond the shape, it checks the claims a snapshot makes
 * about pinning: the recorded block answer is the pinned block (height, hash AND timestamp,
 * because every time line is drawn from that timestamp); every state read on the snapshot's
 * network is pinned to that block, except the archival probes, which must be pinned to an
 * earlier block; and every answered read on another network is pinned to the block recorded
 * for that network (label block.<network>).
 */
export function assertSnapshot(value: unknown): Snapshot {
  const problems: string[] = [];
  if (!isObj(value)) throw new SnapshotError(["not a JSON object"]);
  if (value.schema !== SNAPSHOT_SCHEMA) problems.push(`schema is not ${SNAPSHOT_SCHEMA}`);
  if (value.network !== "testnet" && value.network !== "mainnet") problems.push("network must be testnet or mainnet");
  if (typeof value.subject !== "string" || !isValidAccountId(value.subject)) problems.push("subject is not a valid account id");
  const block = value.block;
  if (!isObj(block) || typeof block.height !== "number" || typeof block.hash !== "string" || typeof block.timestamp_ns !== "string" || !/^\d+$/.test(block.timestamp_ns)) {
    problems.push("block must have height, hash and timestamp_ns");
  }
  const ctx = value.context;
  if (!isObj(ctx) || !Array.isArray(ctx.known) || typeof ctx.usdc_id !== "string" || !Array.isArray(ctx.third_party) || !isObj(ctx.probes) || typeof ctx.activity_window !== "number") {
    problems.push("context is incomplete");
  }
  if (!Array.isArray(value.rpc) || !Array.isArray(value.http)) problems.push("rpc and http must be lists");
  if (problems.length) throw new SnapshotError(problems);

  const { height, hash, timestamp_ns } = block as { height: number; hash: string; timestamp_ns: string };
  const records = (value.rpc as unknown[]).filter(isObj);
  // Heights of the blocks recorded for other networks, by network.
  const crossHeights = new Map<unknown, unknown>();
  for (const r of records) {
    if (typeof r.label !== "string" || !isObj(r.result) || !isObj(r.result.header)) continue;
    const m = /^block\.(testnet|mainnet)$/.exec(r.label);
    if (m && m[1] !== value.network && r.network === m[1]) crossHeights.set(m[1], r.result.header.height);
  }
  const seen = new Set<string>();
  for (const r of value.rpc as unknown[]) {
    if (!isObj(r) || typeof r.label !== "string" || typeof r.method !== "string" || !isObj(r.params)) {
      problems.push("an rpc record lacks label, method or params");
      continue;
    }
    if (seen.has(r.label)) problems.push(`duplicate label ${r.label}`);
    seen.add(r.label);
    if (("result" in r) === ("error" in r)) problems.push(`${r.label}: exactly one of result and error`);
    const p = r.params;
    if (r.method === "query" && r.network === value.network) {
      if (r.label.startsWith("probe.")) {
        if (typeof p.block_id !== "number" || p.block_id >= height) problems.push(`${r.label}: probe must be pinned before the block`);
      } else if (p.block_id !== height) {
        problems.push(`${r.label}: not pinned to block ${height}`);
      }
    } else if (r.method === "query" && "result" in r) {
      const at = crossHeights.get(r.network);
      if (at === undefined || p.block_id !== at) problems.push(`${r.label}: an answer from ${String(r.network)} must be pinned to the block recorded as block.${String(r.network)}`);
    }
  }
  for (const h of value.http as unknown[]) {
    if (!isObj(h) || typeof h.label !== "string" || typeof h.url !== "string") {
      problems.push("an http record lacks label or url");
      continue;
    }
    if (seen.has(h.label)) problems.push(`duplicate label ${h.label}`);
    seen.add(h.label);
  }
  // The block record is required: the pinned block's timestamp draws the 72 h and 30 day lines,
  // so it must be the chain's own answer for that height, not a value written next to it.
  const head = records.find((r) => r.label === "block");
  const header = head && isObj(head.result) && isObj(head.result.header) ? head.result.header : null;
  if (!head || !header) {
    problems.push("no block record: the pinned block's own header must be recorded under the label block");
  } else if (
    head.network !== value.network ||
    !isObj(head.params) ||
    head.params.block_id !== height ||
    header.height !== height ||
    header.hash !== hash ||
    header.timestamp_nanosec !== timestamp_ns
  ) {
    problems.push("the block record does not match the pinned block (network, height, hash and timestamp must all agree)");
  }
  if (problems.length) throw new SnapshotError(problems);
  return value as unknown as Snapshot;
}

/**
 * A compact evidence pointer for the registry's `evidence` field (at most 256 bytes): the
 * snapshot digest, the block and the engine version, enough to find and replay the snapshot.
 */
export function formatEvidence(replay: Replay): string {
  const d = replay.decision;
  return `near-snapshot sha256:${replay.snapshot_sha256} block:${d.block.height} engine:${d.engine_version.split("/")[1] ?? d.engine_version}`;
}

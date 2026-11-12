// Account state at a block: the pinned block, view_account, the access key list (paged), and
// the archival probes that answer "did this account exist, with which keys and which code,
// at least N hours before the pinned block?" from the chain itself.

import { LABEL } from "../engine/labels.ts";
import type { BlockRef, JsonObject, JsonValue, Network, RpcRecord } from "../engine/types.ts";
import type { Recorder, RpcBody } from "./recorder.ts";

const NS_PER_S = 1_000_000_000n;

/** Keep only the header fields the engine reads; a full testnet block is tens of kilobytes. */
export function projectBlock(result: unknown): JsonValue {
  const header = (result as { header?: Record<string, unknown> } | null)?.header ?? {};
  return {
    header: {
      height: header.height as JsonValue,
      hash: header.hash as JsonValue,
      prev_hash: header.prev_hash as JsonValue,
      timestamp_nanosec: header.timestamp_nanosec as JsonValue,
    },
  };
}
const BLOCK_PROJECTION = "header.height,header.hash,header.prev_hash,header.timestamp_nanosec";

type Header = { height: number; hash: string; prevHash: string | null; ts: bigint };

function headerOf(body: RpcBody): Header | null {
  const h = (body.result as { header?: Record<string, unknown> } | undefined)?.header;
  if (!h || typeof h.height !== "number" || typeof h.hash !== "string" || typeof h.timestamp_nanosec !== "string" || !/^\d+$/.test(h.timestamp_nanosec)) return null;
  return { height: h.height, hash: h.hash, prevHash: typeof h.prev_hash === "string" ? h.prev_hash : null, ts: BigInt(h.timestamp_nanosec) };
}

export class CollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectError";
  }
}

/**
 * Pin the snapshot to one block. With no height, take the latest final block and record it as
 * the block_id query that re-fetches it, so the record is exactly what anyone can send again.
 */
export async function pinBlock(rec: Recorder, network: Network, atBlock: number | undefined): Promise<BlockRef> {
  let height = atBlock;
  if (height === undefined) {
    const latest = await rec.fetch(network, "block", { finality: "final" }, false, projectBlock, BLOCK_PROJECTION);
    const h = headerOf(latest);
    if (!h) throw new CollectError(`cannot read the latest final block on ${network}: ${latest.error?.message ?? "no header"}`);
    height = h.height;
  }
  // A regular node that pruned an old height answers UNKNOWN_BLOCK and the reader moves on to
  // the archival hosts, so this works for any height.
  const body = await rec.fetch(network, "block", { block_id: height }, false, projectBlock, BLOCK_PROJECTION);
  const h = headerOf(body);
  if (!h) throw new CollectError(`cannot read block ${height} on ${network}: ${body.error?.message ?? "no header"}`);
  rec.push(LABEL.block, body);
  return { height: h.height, hash: h.hash, timestamp_ns: h.ts.toString() };
}

/** A live pin is a second or two old: wait up to this long for the other network to pass it. */
const CROSS_WAIT_ROUNDS = 8;
const CROSS_WAIT_MS = 1_000;
/** Interpolation reads that bring a block after the target within CROSS_NEAR_NS of it. */
const CROSS_SEARCH_ROUNDS = 16;
const CROSS_NEAR_NS = 15n * NS_PER_S;
/** Steps back along prev_hash from there (about 25 at 0.6 s a block); more means no answer. */
const CROSS_WALK_MAX = 48;
/** A target older than this is read from archival hosts only (regular nodes keep a few epochs). */
const CROSS_ARCHIVAL_AFTER_NS = 1_800n * NS_PER_S;

/**
 * Pin a block on another network, for registries that live there: the LATEST block of that
 * network whose timestamp is at or before the pinned block's. That choice depends only on the
 * pinned block, so collecting the same block again (--at-block) re-derives the same height and
 * the same answers, today or in a year. Two records prove it, both read by height: the chosen
 * block (label block.<network>, at or before the pinned time) and its direct successor (label
 * block.<network>.next, after it, with the chosen block's hash as its prev_hash). The reads that
 * only locate the block are not recorded, because they depend on when the search ran.
 *
 * Returns the chosen height, or null (nothing recorded) when the block cannot be established:
 * the other network has not passed the pinned time yet, or its RPC did not answer.
 */
export async function pinCrossBlock(rec: Recorder, network: Network, pinned: BlockRef, sleep: (ms: number) => Promise<void>): Promise<number | null> {
  const target = BigInt(pinned.timestamp_ns);
  const finalHead = async () => headerOf(await rec.fetch(network, "block", { finality: "final" }, false, projectBlock, BLOCK_PROJECTION));
  // A block after the target must already be final, or a block produced later could still turn
  // out to be the answer.
  let hi = await finalHead();
  for (let i = 0; hi !== null && hi.ts <= target && i < CROSS_WAIT_ROUNDS; i++) {
    await sleep(CROSS_WAIT_MS);
    hi = await finalHead();
  }
  if (hi === null || hi.ts <= target) return null;
  const archival = hi.ts - target > CROSS_ARCHIVAL_AFTER_NS;
  const read = async (blockId: number | string) => headerOf(await rec.fetch(network, "block", { block_id: blockId }, archival, projectBlock, BLOCK_PROJECTION));

  // 1. Interpolate by timestamp until a block after the target is close to it. Aim two heights
  //    past the estimate, so the read usually lands just after the target.
  let lo: Header | null = null;
  for (let round = 0; round < CROSS_SEARCH_ROUNDS && hi.ts - target > CROSS_NEAR_NS; round++) {
    const nsPerHeight = lo ? (hi.ts - lo.ts) / BigInt(Math.max(1, hi.height - lo.height)) : 600_000_000n;
    const from = lo ?? hi;
    let guess = from.height + Number((target - from.ts) / (nsPerHeight > 0n ? nsPerHeight : 600_000_000n)) + 2;
    if (guess >= hi.height) guess = hi.height - 1;
    if (lo && guess <= lo.height) guess = lo.height + 1;
    if (guess <= 0 || (lo && guess >= hi.height)) break;
    // Heights without a block (skipped) answer UNKNOWN_BLOCK: try a few heights below the guess,
    // then a few above it, staying strictly between lo and hi.
    let found: Header | null = null;
    const floor = lo?.height ?? 0;
    for (let h = guess; !found && h > floor && h > guess - 6; h--) found = await read(h);
    for (let h = guess + 1; !found && h < hi.height && h < guess + 6; h++) found = await read(h);
    if (!found) break;
    if (found.ts <= target) {
      if (!lo || found.height > lo.height) lo = found;
    } else if (found.height < hi.height) {
      hi = found;
    } else {
      break;
    }
  }

  // 2. Walk back along prev_hash: every step is exact, skipped heights included.
  let next = hi;
  let chosen: Header | null = null;
  for (let step = 0; step < CROSS_WALK_MAX && next.prevHash; step++) {
    const prev = lo && lo.hash === next.prevHash ? lo : await read(next.prevHash);
    if (!prev) return null;
    if (prev.ts <= target) {
      chosen = prev;
      break;
    }
    next = prev;
  }
  if (!chosen) return null;

  // 3. Record the pair by height and check it once more as recorded.
  const chosenBody = await rec.fetch(network, "block", { block_id: chosen.height }, archival, projectBlock, BLOCK_PROJECTION);
  const nextBody = await rec.fetch(network, "block", { block_id: next.height }, archival, projectBlock, BLOCK_PROJECTION);
  const c = headerOf(chosenBody);
  const n = headerOf(nextBody);
  if (!c || !n || c.hash !== chosen.hash || n.prevHash !== c.hash || c.ts > target || n.ts <= target) return null;
  rec.push(LABEL.crossBlock(network), chosenBody);
  rec.push(LABEL.crossBlockNext(network), nextBody);
  return c.height;
}

export function viewAccountParams(accountId: string, blockId: number): JsonObject {
  return { request_type: "view_account", account_id: accountId, block_id: blockId };
}

/** view_access_key_list, 100 keys a page (nearcore refuses an unpaged list above 100 keys). */
export async function recordKeys(
  rec: Recorder,
  network: Network,
  label: (page: number) => string,
  accountId: string,
  blockId: number,
  archival: boolean,
): Promise<RpcRecord[]> {
  const pages: RpcRecord[] = [];
  let afterKey: string | null = null;
  for (let page = 0; page < 20; page++) {
    const params: JsonObject = { request_type: "view_access_key_list", account_id: accountId, block_id: blockId, limit: 100 };
    if (afterKey) params.after_key = afterKey;
    const record = await rec.rpc(label(page), network, "query", params, archival);
    pages.push(record);
    const last = (record.result as { last_key?: unknown } | undefined)?.last_key;
    if (record.error || typeof last !== "string") break;
    afterKey = last;
  }
  return pages;
}

/**
 * Find a block between `backS` and `backS + toleranceS` seconds before the pinned block, by
 * timestamp. Deterministic: the first guess assumes a fixed block time, and each next guess uses
 * the block time measured between the pinned block and the last block read, so the same pinned
 * block always leads to the same probe block. Every block read is recorded; the accepted one under
 * `blockLabel`, the others under `searchLabel(step)`.
 */
export async function recordProbeBlock(
  rec: Recorder,
  network: Network,
  pinned: BlockRef,
  backS: number,
  toleranceS: number,
  blockLabel: string,
  searchLabel: (step: number) => string,
): Promise<{ height: number; ts: bigint } | null> {
  const pinnedTs = BigInt(pinned.timestamp_ns);
  const latest = pinnedTs - BigInt(backS) * NS_PER_S;
  const earliest = latest - BigInt(toleranceS) * NS_PER_S;
  const aim = latest - (BigInt(toleranceS) * NS_PER_S) / 2n;
  // NEAR produces a block about every 0.6 s; the guess only seeds the search.
  let blockTimeNs = 600_000_000n;
  let height = pinned.height - Number((pinnedTs - aim) / blockTimeNs);
  let step = 0;
  for (let round = 0; round < 8 && height > 0 && height < pinned.height; round++) {
    let body = await rec.fetch(network, "block", { block_id: height }, true, projectBlock, BLOCK_PROJECTION);
    // Heights without a block (skipped) answer UNKNOWN_BLOCK: walk back a few heights.
    for (let skip = 0; skip < 5 && body.error?.cause === "UNKNOWN_BLOCK" && height > 1; skip++) {
      rec.push(searchLabel(step++), body);
      height -= 1;
      body = await rec.fetch(network, "block", { block_id: height }, true, projectBlock, BLOCK_PROJECTION);
    }
    const h = headerOf(body);
    if (!h) {
      rec.push(searchLabel(step++), body);
      return null;
    }
    if (h.ts <= latest && h.ts >= earliest) {
      rec.push(blockLabel, body);
      return { height: h.height, ts: h.ts };
    }
    rec.push(searchLabel(step++), body);
    const spanBlocks = BigInt(pinned.height - h.height);
    if (spanBlocks > 0n) blockTimeNs = (pinnedTs - h.ts) / spanBlocks;
    if (blockTimeNs <= 0n) blockTimeNs = 600_000_000n;
    const delta = Number((h.ts - aim) / blockTimeNs);
    height = h.height - (delta === 0 ? (h.ts > aim ? 1 : -1) : delta);
  }
  return null;
}

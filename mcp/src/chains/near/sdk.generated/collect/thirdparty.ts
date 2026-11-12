// GENERATED FILE: do not edit.
// Source: near/sdk/src/collect/thirdparty.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// Other NEAR HACKATHON teams' public registries, read as attributed signals.
//
// Each source names its team and contract in every reason it produces, a hit is at most a
// WARN (never a DENY on its own), and an entry that calls itself demo or test data is labeled
// so. Their contracts may change or vanish after the hackathon; a failed read is recorded and
// shown as info, never as a reason to hold a payment.
//
// A registry on another network (MimicWatch keeps its testnet registry for mainnet names too)
// is read at that network's latest block at or before the pinned block's timestamp
// (pinCrossBlock), so a collection at the same block always reads it at the same height.

import { LABEL } from "../engine/labels.js";
import type { BlockRef, Network, ThirdPartySource } from "../engine/types.js";
import { pinCrossBlock } from "./account.js";
import type { Recorder } from "./recorder.js";
import { view } from "./views.js";

export async function recordThirdParty(
  rec: Recorder,
  network: Network,
  sources: readonly ThirdPartySource[],
  subject: string,
  block: BlockRef,
  archival: boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const crossBlocks = new Map<Network, number | null>();
  for (const src of sources) {
    let at: number | null = block.height;
    let useArchival = archival;
    if (src.network !== network) {
      if (!crossBlocks.has(src.network)) crossBlocks.set(src.network, await pinCrossBlock(rec, src.network, block, sleep));
      at = crossBlocks.get(src.network) ?? null;
      useArchival = false;
    }
    if (at === null) {
      rec.push(LABEL.thirdParty(src.id), {
        network: src.network,
        archival: false,
        method: "query",
        params: { request_type: "call_function", account_id: src.contract, method_name: src.method },
        error: { name: "UNAVAILABLE", cause: "UNAVAILABLE", message: `no ${src.network} block at or before the pinned block's time could be established` },
      });
      continue;
    }
    await view(rec, LABEL.thirdParty(src.id), src.network, src.contract, src.method, { [src.arg]: subject }, at, useArchival);
  }
}

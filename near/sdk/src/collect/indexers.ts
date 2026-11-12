// Transaction history from the indexers.
//
// FastNEAR's transactions API is the primary source: POST /v0/account with desc:false returns
// the account's OLDEST transactions, which never change once indexed, so "how many of the first
// N transactions are at or below the pinned block" gives the same answer today and next year.
// The newest transaction is recorded for display only. NearBlocks v3 is the fallback when
// FastNEAR does not answer, and the source of a contract's deployment history; its terms ask
// for the attribution "Powered by Nearblocks.io APIs", which the CLI prints when it was used.

import { LABEL } from "../engine/labels.ts";
import type { HttpRecord } from "../engine/types.ts";
import type { NetworkConfig } from "./networks.ts";
import type { Recorder } from "./recorder.ts";

export function fastnearUsable(r: HttpRecord): boolean {
  return r.status === 200 && typeof r.json === "object" && r.json !== null && Array.isArray((r.json as { account_txs?: unknown }).account_txs);
}

export async function recordIndexers(
  rec: Recorder,
  cfg: NetworkConfig,
  subject: string,
  window: number,
  hasContract: boolean,
): Promise<{ usedNearblocks: boolean }> {
  const oldest = await rec.http({
    label: LABEL.fastnearOldest,
    source: "fastnear",
    method: "POST",
    url: `${cfg.fastnearTx}/v0/account`,
    body: { account_id: subject, limit: window, desc: false },
  });
  if (fastnearUsable(oldest)) {
    await rec.http({
      label: LABEL.fastnearNewest,
      source: "fastnear",
      method: "POST",
      url: `${cfg.fastnearTx}/v0/account`,
      body: { account_id: subject, limit: 1, desc: true },
    });
  }
  let usedNearblocks = false;
  const id = encodeURIComponent(subject);
  if (!fastnearUsable(oldest)) {
    usedNearblocks = true;
    await rec.http({ label: LABEL.nearblocksAccount, source: "nearblocks", method: "GET", url: `${cfg.nearblocks}/v3/accounts/${id}` });
    await rec.http({
      label: LABEL.nearblocksOldest,
      source: "nearblocks",
      method: "GET",
      url: `${cfg.nearblocks}/v3/accounts/${id}/txns?limit=${window}&order=asc`,
    });
  }
  if (hasContract) {
    usedNearblocks = true;
    await rec.http({
      label: LABEL.nearblocksDeployments,
      source: "nearblocks",
      method: "GET",
      url: `${cfg.nearblocks}/v3/accounts/${id}/contract/deployments`,
    });
  }
  return { usedNearblocks };
}

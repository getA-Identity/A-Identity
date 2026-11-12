// verifyThenPay: the agent-side wrapper. Check the payee first, then let the vault decide.
//
//   ALLOW -> vault.pay             the vault still checks its policy and the registry, and may
//                                  hold (UnknownPayee, RegistryWarn) or refuse (RegistryDeny)
//   WARN  -> vault.request_payment the payment waits for the owner's one tap
//   DENY  -> vault.record_refusal  nothing moves; the refusal is on chain with a receipt
//
// The contract has the final word: the result reports the guard's verdict AND what the vault
// did, and says when they differ. A verdict that cannot be computed (RPC down, hosted API down
// or unreadable) is WARN, never ALLOW. With no signing key the result is "prepared": the exact
// call the agent would send, and nothing is sent.

import { collectSnapshot, type CollectOptions } from "./collect/snapshot.ts";
import type { FetchLike, RpcReader } from "./collect/rpc.ts";
import { isValidAccountId } from "./engine/account.ts";
import { assertSnapshot, verdictFromSnapshot } from "./engine/index.ts";
import { registryReasons } from "./engine/rules.ts";
import type { Decision, Network, Snapshot, Verdict } from "./engine/types.ts";
import type { LoadedKey } from "./chain/keys.ts";
import { proveSettlement, type PayOutcome, type Settlement } from "./chain/outcome.ts";
import type { Links, Prepared } from "./chain/send.ts";
import { checkAmount, truncateBytes, vaultClient, type PayCallResult, type VaultClient } from "./chain/vault.ts";

export type VerdictSource = "local" | "hosted";
export type Route = "pay" | "request_payment" | "record_refusal";

export type VerifyThenPayOptions = {
  vault: string;
  payee: string;
  /** Token base units as a decimal string ("250000" is 0.25 USDC). */
  amount: string;
  memo?: string;
  /** The agent's function-call key on the vault. Absent: the result is prepared, nothing is sent. */
  signer?: LoadedKey | null;
  verdictSource?: VerdictSource;
  network?: Network;
  known?: readonly string[];
  /** For "hosted": an endpoint that answers POST {account, network, vault} with the CLI's --json shape. */
  hostedUrl?: string;
  /** The vault's token, for the settlement proof. Default: read from the vault's get_config. */
  tokenId?: string;
  reader?: RpcReader;
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  /** Waits for pacing and backoff while collecting (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injection points for tests and for callers that already hold a snapshot or a client. A
   * snapshot from `collect` is checked, not trusted: it must pass assertSnapshot and be about
   * this payee, network and vault, collected with every `known` payee; otherwise the verdict is
   * WARN. A custom client must never throw after it sent something (send() returns "pending").
   */
  collect?: (opts: CollectOptions) => Promise<Snapshot>;
  client?: VaultClient;
};

export type GuardVerdict = {
  verdict: Verdict;
  source: VerdictSource;
  /** Full decision for a local verdict; null for hosted or when it could not be computed. */
  decision: Decision | null;
  reasons: string[];
  snapshot_sha256: string | null;
  /** Set when no verdict could be computed and WARN was assumed. */
  unavailable: string | null;
};

export type GuardResult = {
  verdict: GuardVerdict;
  route: Route;
  status: "prepared" | "executed" | "pending" | "rejected";
  /** What the vault answered (executed only). */
  onchain: PayOutcome | null;
  /** True when the vault did something other than what the guard asked for. */
  contract_overrode: boolean;
  /** Only for a pay the vault reports as sent: the token's own receipt proves the transfer. */
  settled: boolean;
  settlement: Settlement | null;
  tx_hash: string | null;
  links: Links | null;
  prepared: Prepared | null;
  error: string | null;
  summary: string;
};

async function hostedVerdict(opts: VerifyThenPayOptions, network: Network): Promise<GuardVerdict> {
  const unavailable = (why: string): GuardVerdict => ({ verdict: "WARN", source: "hosted", decision: null, reasons: [], snapshot_sha256: null, unavailable: why });
  if (!opts.hostedUrl) return unavailable("no hostedUrl configured");
  const doFetch = opts.fetch ?? ((url: string, init: Parameters<FetchLike>[1]) => fetch(url, init));
  try {
    const res = await doFetch(opts.hostedUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ account: opts.payee, network, vault: opts.vault, known: opts.known ?? [] }),
    });
    if (res.status !== 200) return unavailable(`hosted API answered HTTP ${res.status}`);
    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    const v = body.verdict;
    if ((v !== "ALLOW" && v !== "WARN" && v !== "DENY") || body.account !== opts.payee || (body.network !== undefined && body.network !== network)) {
      return unavailable("hosted API answered an unexpected shape");
    }
    const reasons = Array.isArray(body.registry_reasons) ? body.registry_reasons.filter((x): x is string => typeof x === "string") : [];
    return { verdict: v, source: "hosted", decision: null, reasons, snapshot_sha256: typeof body.snapshot_sha256 === "string" ? body.snapshot_sha256 : null, unavailable: null };
  } catch (e) {
    return unavailable(`hosted API unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Why a snapshot cannot decide this payment, or null when it can. A snapshot of another payee,
 * network or vault answers another question (the vault's prior payments, refusals and allowlist
 * are per vault), and one collected without a known payee never compared the payee with it.
 */
export function snapshotMismatch(snapshot: Snapshot, want: { payee: string; network: Network; vault: string; known: readonly string[] }): string | null {
  if (snapshot.subject !== want.payee) return `snapshot is about ${snapshot.subject}, not the payee ${want.payee}`;
  if (snapshot.network !== want.network) return `snapshot is about ${snapshot.network}, not ${want.network}`;
  if (snapshot.context.vault_id !== want.vault) return `snapshot was collected for vault ${snapshot.context.vault_id ?? "(none)"}, not ${want.vault}`;
  const missing = want.known.filter((k) => !snapshot.context.known.includes(k));
  if (missing.length > 0) return `snapshot was collected without the known payee(s) ${missing.join(", ")}`;
  return null;
}

async function localVerdict(opts: VerifyThenPayOptions, network: Network): Promise<GuardVerdict> {
  const collect = opts.collect ?? collectSnapshot;
  const known = opts.known ?? [];
  try {
    const snapshot = assertSnapshot(
      await collect({
        account: opts.payee,
        network,
        vault: opts.vault,
        known,
        ...(opts.env ? { env: opts.env } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
      }),
    );
    const mismatch = snapshotMismatch(snapshot, { payee: opts.payee, network, vault: opts.vault, known });
    if (mismatch) return { verdict: "WARN", source: "local", decision: null, reasons: [], snapshot_sha256: null, unavailable: mismatch };
    const replay = verdictFromSnapshot(snapshot);
    return {
      verdict: replay.decision.verdict,
      source: "local",
      decision: replay.decision,
      reasons: registryReasons(replay.decision),
      snapshot_sha256: replay.snapshot_sha256,
      unavailable: null,
    };
  } catch (e) {
    return { verdict: "WARN", source: "local", decision: null, reasons: [], snapshot_sha256: null, unavailable: `verdict could not be computed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function routeFor(verdict: Verdict): Route {
  return verdict === "ALLOW" ? "pay" : verdict === "WARN" ? "request_payment" : "record_refusal";
}

/** The vault's reason field (at most 128 bytes): who decided, what, and the deciding codes. */
export function guardReason(v: GuardVerdict): string {
  const codes = v.unavailable ? "verdict_unavailable" : v.reasons.join(",") || "none";
  return truncateBytes(`a-identity guard ${v.verdict}: ${codes}`);
}

function overrode(route: Route, onchain: PayOutcome | null): boolean {
  if (!onchain) return false;
  if (route === "pay") return onchain.status !== "sent";
  if (route === "request_payment") return onchain.status !== "held";
  return false;
}

export async function verifyThenPay(opts: VerifyThenPayOptions): Promise<GuardResult> {
  if (!isValidAccountId(opts.vault)) throw new TypeError(`vault is not a valid account id: ${JSON.stringify(opts.vault)}`);
  if (!isValidAccountId(opts.payee)) throw new TypeError(`payee is not a valid account id: ${JSON.stringify(opts.payee)}`);
  checkAmount(opts.amount);
  const network = opts.network ?? "testnet";
  const verdict = opts.verdictSource === "hosted" ? await hostedVerdict(opts, network) : await localVerdict(opts, network);
  const route = routeFor(verdict.verdict);
  const client =
    opts.client ?? vaultClient({ vaultId: opts.vault, network, agentKey: opts.signer ?? null, ...(opts.reader ? { reader: opts.reader } : {}) });

  let result: PayCallResult;
  try {
    if (route === "pay") result = await client.pay({ payee: opts.payee, amount: opts.amount, ...(opts.memo !== undefined ? { memo: opts.memo } : {}) });
    else if (route === "request_payment") result = await client.requestPayment({ payee: opts.payee, amount: opts.amount, ...(opts.memo !== undefined ? { memo: opts.memo } : {}), reason: guardReason(verdict) });
    else result = await client.recordRefusal({ payee: opts.payee, amount: opts.amount, reason: guardReason(verdict) });
  } catch (e) {
    // The built-in client throws only before anything is signed (invalid amount or text, a
    // transaction it cannot build); once a transaction has left, send() returns "pending".
    const error = e instanceof Error ? e.message : String(e);
    return { verdict, route, status: "rejected", onchain: null, contract_overrode: false, settled: false, settlement: null, tx_hash: null, links: null, prepared: null, error, summary: `${verdict.verdict} -> ${route} not sent: ${error}` };
  }

  const base = { verdict, route, contract_overrode: false, settled: false, settlement: null, tx_hash: null, links: null, prepared: null, error: null, onchain: null } as const;
  if (result.status === "prepared") {
    return { ...base, status: "prepared", prepared: result, summary: `${verdict.verdict} -> ${route} prepared (not sent: no agent key loaded)` };
  }
  if (result.status === "rejected") {
    return { ...base, status: "rejected", error: `${result.error}: ${result.message}`, summary: `${verdict.verdict} -> ${route} rejected before inclusion (${result.error}); nothing is on chain` };
  }
  if (result.status === "pending") {
    return {
      ...base,
      status: "pending",
      tx_hash: result.tx_hash,
      links: result.links,
      error: result.note,
      summary: `${verdict.verdict} -> ${route} signed as ${result.tx_hash}, outcome not known yet: check this hash before sending again`,
    };
  }

  const onchain = result.pay;
  let settlement: Settlement | null = null;
  if (route === "pay" && onchain?.status === "sent") {
    const tokenId = opts.tokenId ?? (await client.getConfig().then((c) => c.token_id).catch(() => null));
    settlement = tokenId
      ? proveSettlement(result.outcome, { tokenId, vaultId: opts.vault, payee: opts.payee, amount: opts.amount })
      : { settled: false, checks: [{ name: "token_known", ok: false, detail: "could not read the vault's token id" }] };
  }
  const settled = settlement?.settled === true;
  const what = onchain ? `${onchain.status}${onchain.reason ? ` (${onchain.reason})` : ""}` : "no PayOutcome";
  return {
    verdict,
    route,
    status: "executed",
    onchain,
    contract_overrode: overrode(route, onchain),
    settled,
    settlement,
    tx_hash: result.tx_hash,
    links: result.links,
    prepared: null,
    error: null,
    summary: `${verdict.verdict} -> ${route} -> vault ${what}${route === "pay" && onchain?.status === "sent" ? (settled ? ", settled" : ", NOT proven settled") : ""} (tx ${result.tx_hash})`,
  };
}

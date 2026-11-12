// Client for A-Identity's verdict registry (near/contracts/a-identity-registry).
//
// The ORACLE writes verdicts. Its writes are deliberately not payable, so the oracle account can
// hold only a function-call key limited to set_verdict, set_verdicts, clear_verdict and
// clear_reports, which can never attach a deposit or move the oracle's NEAR. The OWNER manages
// the oracle set with 1 yoctoNEAR calls. Anyone may file a report with REPORT_DEPOSIT attached.
// Every write is prepared-or-executed (send.ts).

import { NETWORKS } from "../collect/networks.ts";
import { createReader, type RpcReader } from "../collect/rpc.ts";
import { registryReasons } from "../engine/rules.ts";
import type { Decision, Network, Verdict } from "../engine/types.ts";
import { ORACLE_METHODS, REGISTRY_GAS_TGAS } from "./abi.ts";
import type { LoadedKey } from "./keys.ts";
import { prepare, send, viewFunction, type Call, type Executed, type Pending, type Prepared, type Rejected } from "./send.ts";

// The oracle's methods (deployment amendment A3) and the gas figures live in abi.ts, with no
// imports, so the demo and the oracle read them without near-api-js; re-exported here.
export { ORACLE_METHODS, REGISTRY_GAS_TGAS };
/** The registry's REPORT_DEPOSIT: 0.01 NEAR, kept in full as the price of a report. */
export const REPORT_DEPOSIT = "10000000000000000000000";
/** The registry's own limits (rules.rs). */
export const REGISTRY_LIMITS = { reasons: 8, code_bytes: 32, evidence_bytes: 256, code_hash_bytes: 64, score_max: 1000, batch: 20 } as const;

export type VerdictView = {
  account_id: string;
  verdict: Verdict;
  reasons: string[];
  evidence: string | null;
  score: number | null;
  code_hash: string | null;
  updated_at_ns: string;
  updated_by: string;
  expires_at_ns: string | null;
};
export type ReportView = { reporter: string; reason: string; evidence: string; at_ns: string };
export type CheckView = { verdict: Verdict | "NONE"; reasons: string[]; reports: number };

/** One set_verdict call's arguments, also one set_verdicts entry. */
export type VerdictInput = {
  account_id: string;
  verdict: Verdict;
  reasons: string[];
  evidence: string | null;
  score: number | null;
  code_hash: string | null;
  /** Seconds as a decimal string; null or "0" means no expiry. */
  ttl_s: string | null;
};

export class RegistryArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryArgumentError";
  }
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The registry's own checks, run before sending so a bad entry fails here with a clear message. */
export function checkVerdictInput(v: VerdictInput): VerdictInput {
  if (v.reasons.length > REGISTRY_LIMITS.reasons) throw new RegistryArgumentError(`at most ${REGISTRY_LIMITS.reasons} reasons (TooManyReasons)`);
  for (const r of v.reasons) {
    if (!/^[a-z0-9_]+$/.test(r) || bytes(r) > REGISTRY_LIMITS.code_bytes) throw new RegistryArgumentError(`reason ${JSON.stringify(r)} is not 1 to 32 bytes of [a-z0-9_] (InvalidReason)`);
  }
  if (v.evidence !== null && bytes(v.evidence) > REGISTRY_LIMITS.evidence_bytes) throw new RegistryArgumentError("evidence is longer than 256 bytes (EvidenceTooLong)");
  if (v.score !== null && (!Number.isInteger(v.score) || v.score < 0 || v.score > REGISTRY_LIMITS.score_max)) throw new RegistryArgumentError("score must be 0..1000 (ScoreOutOfRange)");
  if (v.code_hash !== null && bytes(v.code_hash) > REGISTRY_LIMITS.code_hash_bytes) throw new RegistryArgumentError("code_hash is longer than 64 bytes (CodeHashTooLong)");
  if (v.ttl_s !== null && !/^\d+$/.test(v.ttl_s)) throw new RegistryArgumentError("ttl_s must be a decimal string of seconds");
  return v;
}

/**
 * Turn an engine decision into the registry entry an oracle writes: the deciding reason codes
 * (they already follow the registry's [a-z0-9_] rule), the score, the payee's code hash as
 * observed in the snapshot, and an evidence pointer (formatEvidence(), or a URL to the snapshot).
 */
export function verdictInputFromDecision(d: Decision, extra: { evidence: string | null; codeHash: string | null; ttlS?: string | null }): VerdictInput {
  return checkVerdictInput({
    account_id: d.subject,
    verdict: d.verdict,
    reasons: registryReasons(d),
    evidence: extra.evidence,
    score: d.score,
    code_hash: extra.codeHash,
    ttl_s: extra.ttlS ?? null,
  });
}

export type RegistryClientOptions = {
  registryId: string;
  network?: Network;
  reader?: RpcReader;
  /** The oracle account and its key (a function-call key limited to ORACLE_METHODS). */
  oracle?: { accountId: string; key?: LoadedKey | null } | null;
  /** The registry owner (full-access key, 1 yoctoNEAR calls). */
  owner?: { accountId: string; key?: LoadedKey | null } | null;
  /** Any account filing a report (needs a full-access key: a report carries a deposit). */
  reporter?: { accountId: string; key?: LoadedKey | null } | null;
  rpcUrl?: string;
  timeoutMs?: number;
};

export type RegistryClient = ReturnType<typeof registryClient>;

export function registryClient(opts: RegistryClientOptions) {
  const network = opts.network ?? "testnet";
  const reader = opts.reader ?? createReader({ rpc: NETWORKS[network].rpc, archival: NETWORKS[network].archival });
  const registryId = opts.registryId;

  function write(as: { accountId: string; key?: LoadedKey | null } | null | undefined, role: string, methodName: string, args: Record<string, unknown>, deposit: string, gasTgas: number): Promise<Prepared | Rejected | Pending | Executed> {
    const signerId = as?.accountId ?? `<${role}>`;
    const call: Call = { receiverId: registryId, methodName, args, gasTgas, deposit };
    if (!as?.key) return Promise.resolve(prepare(signerId, call, `no ${role} key loaded`));
    return send({ network, signerId, key: as.key, reader, ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }, call);
  }

  return {
    registryId,
    network,
    // -- oracle (no deposit, so a function-call key works) --
    setVerdict: (v: VerdictInput) => write(opts.oracle, "oracle", "set_verdict", { ...checkVerdictInput(v) }, "0", REGISTRY_GAS_TGAS.set_verdict),
    setVerdicts: (entries: VerdictInput[]) => {
      if (entries.length > REGISTRY_LIMITS.batch) throw new RegistryArgumentError(`at most ${REGISTRY_LIMITS.batch} entries (BatchTooLarge)`);
      return write(opts.oracle, "oracle", "set_verdicts", { entries: entries.map(checkVerdictInput) }, "0", REGISTRY_GAS_TGAS.set_verdicts);
    },
    clearVerdict: (accountId: string) => write(opts.oracle, "oracle", "clear_verdict", { account_id: accountId }, "0", REGISTRY_GAS_TGAS.clear),
    clearReports: (accountId: string) => write(opts.oracle, "oracle", "clear_reports", { account_id: accountId }, "0", REGISTRY_GAS_TGAS.clear),
    // -- anyone, with the report deposit --
    report: (r: { accountId: string; reason: string; evidence: string }) => {
      if (!/^[a-z0-9_]+$/.test(r.reason) || bytes(r.reason) > REGISTRY_LIMITS.code_bytes) throw new RegistryArgumentError("reason must be 1 to 32 bytes of [a-z0-9_]");
      if (bytes(r.evidence) > REGISTRY_LIMITS.evidence_bytes) throw new RegistryArgumentError("evidence is longer than 256 bytes");
      return write(opts.reporter, "reporter", "report", { account_id: r.accountId, reason: r.reason, evidence: r.evidence }, REPORT_DEPOSIT, REGISTRY_GAS_TGAS.report);
    },
    // -- owner (1 yoctoNEAR) --
    addOracle: (accountId: string) => write(opts.owner, "registry owner", "add_oracle", { account_id: accountId }, "1", REGISTRY_GAS_TGAS.owner),
    removeOracle: (accountId: string) => write(opts.owner, "registry owner", "remove_oracle", { account_id: accountId }, "1", REGISTRY_GAS_TGAS.owner),
    setOwner: (newOwner: string) => write(opts.owner, "registry owner", "set_owner", { new_owner: newOwner }, "1", REGISTRY_GAS_TGAS.owner),
    // -- views (final block) --
    getVerdict: (accountId: string) => viewFunction<VerdictView | null>(reader, registryId, "get_verdict", { account_id: accountId }),
    check: (accountId: string) => viewFunction<CheckView>(reader, registryId, "check", { account_id: accountId }),
    getReports: (accountId: string) => viewFunction<ReportView[]>(reader, registryId, "get_reports", { account_id: accountId }),
    reportCount: (accountId: string) => viewFunction<number>(reader, registryId, "report_count", { account_id: accountId }),
    oracles: () => viewFunction<string[]>(reader, registryId, "oracles"),
    owner: () => viewFunction<string>(reader, registryId, "owner"),
    listVerdicts: (fromIndex = "0", limit = "100") => viewFunction<VerdictView[]>(reader, registryId, "list_verdicts", { from_index: fromIndex, limit }),
  };
}

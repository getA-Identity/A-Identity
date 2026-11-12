// The two things the demo and the oracle need from the SDK, as narrow interfaces. attack.ts and
// scripts/oracle.ts are written against these, and demo/lib/sdk.ts binds them to the SDK
// (sdk/src/guard.ts, sdk/src/engine, sdk/src/collect). Tests bind them to fakes.

import type { Decision, Snapshot, Verdict } from '../../sdk/src/engine/types.ts';
import type { PayOutcomeJson } from './chain.ts';

export type { Decision, Snapshot, Verdict };

/** One verdict computed from public chain data at a recorded block. */
export type EngineJudgement = {
  decision: Decision;
  snapshot: Snapshot;
  /** sha256 of the snapshot's canonical JSON: what a replay (`npm run verdict -- --offline <file>`)
   * must reproduce. */
  snapshotSha256: string;
  /** The registry evidence string, in the SDK's format (formatEvidence): the snapshot digest, the
   * block and the engine version, at most 256 bytes. */
  evidence: string;
};

export type JudgeOptions = { known: string[]; vaultId: string | null; registryId: string | null };

export type EnginePort = {
  readonly version: string;
  judge(subject: string, opts: JudgeOptions): Promise<EngineJudgement>;
};

export type GuardAction = 'pay' | 'request_payment' | 'record_refusal';

/** verifyThenPay's answer, normalized. `raw` keeps the SDK's full return value for the log. */
export type GuardResult = {
  verdict: Verdict | null;
  reasons: Array<{ code: string; severity?: string; detail?: string }>;
  score: number | null;
  snapshotSha256: string | null;
  block: { height: number; hash?: string } | null;
  action: GuardAction | null;
  /** prepared: no key, nothing signed; executed: on chain; rejected/error: see `error`. */
  status: 'prepared' | 'executed' | 'rejected' | 'error';
  txHash: string | null;
  signerId: string | null;
  payOutcome: PayOutcomeJson | null;
  /** True when the token's own receipt logged the exact transfer to the payee. */
  settled: boolean | null;
  prepared: unknown;
  error?: string;
  /** Set when no verdict could be computed and the guard assumed WARN (never ALLOW). */
  unavailable?: string;
  /** The vault did something other than what the guard asked (for example held an ALLOW). */
  contractOverrode?: boolean;
  /** The SDK's one-line summary. */
  summary?: string;
  raw: unknown;
};

export type GuardArgs = { vault: string; payee: string; amount: string; memo: string; known: string[] };

export type GuardPort = {
  readonly description: string;
  verifyThenPay(args: GuardArgs): Promise<GuardResult>;
};

// GENERATED FILE: do not edit.
// Source: near/sdk/src/engine/types.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// Shared types of the verdict engine.
//
// The engine is a pure function: Snapshot -> Signals -> Decision. A Snapshot holds every raw
// answer the collector got (JSON-RPC calls pinned to one block, and indexer answers), so the
// same Snapshot always gives the same Decision, on any machine, with no network. Nothing in
// this directory reads the clock, the network, the disk or the environment.
//
// Reason codes are written into the on-chain registry by the oracle, so they follow the
// registry's rule for reason codes: 1 to 32 bytes of [a-z0-9_]. They are public ABI in the
// same sense as the contracts' error names: append new codes, never rename or reuse one.

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Network = "testnet" | "mainnet";
export type Verdict = "ALLOW" | "WARN" | "DENY";

/** deny and warn decide the verdict; positive can clear a soft warning; info only explains. */
export type Severity = "deny" | "warn" | "positive" | "info";

/**
 * Bumped when a rule, a threshold or a reason code changes meaning. Printed with every verdict.
 * 1.1.0: a parent swap on a sub-account role label (agent.bob vs agent.alice) only warns.
 */
export const ENGINE_VERSION = "a-identity-near-engine/1.1.0";
export const SNAPSHOT_SCHEMA = "a-identity.near.snapshot/1";

export const REASON_CODES = [
  // deny
  "account_not_found",
  "usdc_blocklisted",
  "registry_deny",
  "lookalike_new_account",
  // warn
  "registry_warn",
  "code_changed_since_verdict",
  "code_changed_recently",
  "global_contract_mutable",
  "new_full_access_key",
  "prior_registry_refusals",
  "open_reports",
  "third_party_flag",
  "lookalike_known",
  "new_account",
  "low_activity",
  "implicit_unfunded",
  "rpc_unavailable",
  "indexer_unavailable",
  "registry_unreadable",
  "blocklist_unreadable",
  "vault_unreadable",
  // positive
  "registry_allow",
  "prior_payments",
  "owner_allowlisted",
  "long_history",
  "erc8004_identity",
  "erc8004_reputation",
  // info
  "known_payee",
  "contract_account",
  "locked_contract",
  "usdc_unregistered",
  "guard_refusals",
  "erc8004_low_reputation",
  "registry_not_deployed",
  "third_party_unreadable",
  "erc8004_unreadable",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export type Reason = {
  code: ReasonCode;
  severity: Severity;
  /** One plain sentence with the observed values and the threshold that applied. */
  detail: string;
  /** Where the fact came from, for example "rpc view_account@277300000" or "indexer fastnear". */
  source: string;
  /** Set on a warning that a positive signal cleared; a cleared warning does not decide. */
  cleared_by?: ReasonCode;
};

export type BlockRef = { height: number; hash: string; timestamp_ns: string };

export type Decision = {
  subject: string;
  network: Network;
  verdict: Verdict;
  /** 0..1000, higher is more trustworthy. Clamped into the verdict's band (see policy.ts). */
  score: number;
  /** Deny first, then warnings, positives and info, each in rule order. */
  reasons: Reason[];
  /**
   * For a WARN: "hard" when at least one deciding warning is about the payee itself or about
   * missing data, "soft" when every deciding warning only says nobody has history with this
   * payee yet (new, quiet, unfunded). null for ALLOW and DENY. An oracle can use it to leave a
   * soft WARN unwritten, because the vault already holds a first payment to an unknown payee.
   */
  warn_kind: "hard" | "soft" | null;
  engine_version: string;
  policy_id: string;
  block: BlockRef;
};

// ---------------------------------------------------------------------------------------------
// Snapshot: the recorded evidence.

/** A JSON-RPC error as recorded. `cause` is nearcore's error cause name, the part that decides. */
export type RpcErrorRecord = {
  name: string;
  cause: string;
  /** For contract execution errors: MethodNotFound, GuestPanic or Other. */
  kind?: string;
  /** Human text (panic message, nearcore message). Never decides anything. */
  message?: string;
};

export type RpcRecord = {
  /** Stable key the normalizer looks the answer up by, unique within a snapshot. */
  label: string;
  network: Network;
  /** True when the call needs a node that keeps old state (any read pinned to an old block). */
  archival: boolean;
  method: string;
  /** Exactly what was sent. Every state read carries a block_id. */
  params: JsonObject;
  /** Exactly one of result or error. */
  result?: JsonValue;
  error?: RpcErrorRecord;
  /** Set when `result` keeps only some fields of a large answer (block calls keep the header). */
  projection?: string;
};

export type HttpRecord = {
  label: string;
  source: "fastnear" | "nearblocks";
  method: "GET" | "POST";
  url: string;
  body?: JsonValue;
  status?: number;
  json?: JsonValue;
  /** Transport failure, HTTP error or unreadable body. */
  error?: string;
  fetched_at: string;
};

export type ThirdPartySource = {
  /** Short stable id used in labels, for example "mimicwatch". */
  id: string;
  /** Who runs it, as shown in reasons. */
  name: string;
  contract: string;
  network: Network;
  method: string;
  /** The argument name the method takes for the account. */
  arg: string;
};

export type ProbeSpec = { recent_s: number; long_s: number };

export type SnapshotContext = {
  /** Caller-supplied known payees (lookalike targets), validated, sorted, deduplicated. */
  known: string[];
  vault_id: string | null;
  registry_id: string | null;
  /** Circle USDC on this network: the token the vault pays in and the blocklist we read. */
  usdc_id: string;
  third_party: ThirdPartySource[];
  erc8004: { identity: string; reputation: string } | null;
  /** How far back the archival probes looked, so a replay can check the probe blocks. */
  probes: ProbeSpec;
  /** Oldest-first transactions requested from the indexers (the activity threshold). */
  activity_window: number;
};

export type SnapshotMeta = {
  collected_at: string;
  collector: string;
  /** Endpoints that answered, for humans. Not evidence. */
  endpoints: string[];
  notes: string[];
};

export type Snapshot = {
  schema: typeof SNAPSHOT_SCHEMA;
  network: Network;
  subject: string;
  block: BlockRef;
  context: SnapshotContext;
  rpc: RpcRecord[];
  http: HttpRecord[];
  /** Excluded from snapshot_sha256: who collected it, when, and through which hosts. */
  meta?: SnapshotMeta;
};

// ---------------------------------------------------------------------------------------------
// Signals: what normalize() extracts from a snapshot. rules.ts reads only this.

export type AccountKind = "named" | "implicit" | "eth_implicit" | "deterministic" | "universal";

export type Unavailable = { state: "unavailable"; why: string; source: string };
export type NotApplicable = { state: "not_applicable"; why: string };

export type AccountSignal =
  | {
      state: "ok";
      exists: boolean;
      code_hash: string | null;
      has_contract: boolean;
      /** Set when the account runs a global contract. "account" means the publisher can change it. */
      global_contract: { by: "account"; account_id: string } | { by: "hash"; hash: string } | null;
      balance_yocto: string | null;
      storage_usage: number | null;
      source: string;
    }
  | Unavailable;

export type KeysSignal =
  | {
      state: "ok";
      total: number;
      full_access: number;
      function_call: number;
      /** Sum of nonce mod 1e6 over current keys: transactions signed by them (estimate). */
      signed_txs_estimate: number;
      source: string;
    }
  | Unavailable
  | NotApplicable;

export type AgeSignal =
  | {
      state: "ok";
      /** Did not exist at the recent probe (or the indexer says it was created after it). */
      is_new: boolean;
      /** Existed at the long probe. null when the long probe and the indexer both failed. */
      is_long: boolean | null;
      created_ts_ns: string | null;
      source: string;
      detail: string;
    }
  | Unavailable
  | NotApplicable;

export type KeyChangeSignal =
  | { state: "ok"; added_full_access: string[]; source: string }
  | Unavailable
  | NotApplicable;

export type CodeChangeSignal =
  | { state: "ok"; changed: boolean; before: string | null; after: string | null; source: string; detail: string }
  | Unavailable
  | NotApplicable;

export type ActivitySignal =
  | {
      state: "ok";
      /** Transactions at or before the pinned block, counted among the oldest `window`. */
      tx_count: number;
      /** True when tx_count reached the window, so the real count may be higher. */
      at_least: boolean;
      first_tx: { hash: string; height: number; timestamp_ns: string } | null;
      source: string;
    }
  | Unavailable;

export type UsdcSignal =
  | { state: "ok"; blocklisted: boolean; registered: boolean | null; source: string }
  | Unavailable;

export type RegistryVerdict = {
  verdict: Verdict;
  reasons: string[];
  evidence: string | null;
  score: number | null;
  code_hash: string | null;
  updated_at_ns: string;
  updated_by: string;
  expires_at_ns: string | null;
};

export type RegistrySignal =
  | {
      state: "ok";
      id: string;
      verdict: RegistryVerdict | null;
      open_reports: number;
      open_reporters: string[];
      newest_open_report_ns: string | null;
      lifetime_reports: number | null;
      source: string;
    }
  | { state: "not_configured" }
  | { state: "not_deployed"; id: string; source: string }
  | (Unavailable & { id: string });

export type VaultSignal =
  | {
      state: "ok";
      id: string;
      paid_count: number;
      refusal_count: number;
      /** null when the vault predates the v1.1 view. Agent-reported; never used to decide. */
      guard_refusal_count: number | null;
      allowlisted: boolean;
      source: string;
    }
  | { state: "not_configured" }
  | (Unavailable & { id: string });

export type LookalikeKind =
  | "homoglyph"
  | "parent_swap"
  | "address_poisoning"
  | "edit_distance"
  | "affix";

export type LookalikeMatch = {
  known: string;
  kind: LookalikeKind;
  /**
   * True when the payee imitates the known account's own name, so a NEW payee with this match
   * is a DENY (lookalike_new_account). False for a sibling that shares only a sub-account role
   * label (agent.bob.testnet vs agent.alice.testnet): any account can create agent.<itself>, so
   * such a match only warns (lookalike_known), whatever the payee's age.
   */
  strong: boolean;
  /** Edit distance between the compared names (0 for a pure homoglyph or parent swap). */
  distance: number;
  /** 0..1 for display only. */
  similarity: number;
  detail: string;
};

export type ThirdPartySignal =
  | {
      state: "ok";
      source: ThirdPartySource;
      flagged: boolean;
      level: string | null;
      detail: string;
      evidence_url: string | null;
      /** The entry itself says it is demo or test data. */
      demo: boolean;
    }
  | { state: "unavailable"; source: ThirdPartySource; why: string };

export type Erc8004Signal =
  | {
      state: "ok";
      identity: string;
      agent_ids: string[];
      feedback_count: number;
      /** summary_value / 10^decimals, on the scale the feedback used (ERC-8004 suggests 0..100). */
      mean: number | null;
      source: string;
    }
  | Unavailable
  | { state: "not_configured" };

export type Signals = {
  subject: string;
  network: Network;
  kind: AccountKind;
  block: BlockRef;
  /** Caller list plus the vault allowlist plus live registry ALLOW verdicts. */
  known: string[];
  is_known: boolean;
  account: AccountSignal;
  keys: KeysSignal;
  age: AgeSignal;
  key_changes: KeyChangeSignal;
  code_change: CodeChangeSignal;
  activity: ActivitySignal;
  usdc: UsdcSignal;
  registry: RegistrySignal;
  vault: VaultSignal;
  lookalike: LookalikeMatch | null;
  third_party: ThirdPartySignal[];
  erc8004: Erc8004Signal;
};

// The vault's and the registry's ABI facts as plain data: version, agent methods, gas, bounds,
// hold kinds, error names and event names.
//
// No imports, on purpose. The demo's config (demo/lib/config.ts) and the oracle read their gas
// from here without loading near-api-js, so the SDK, the demo and the oracle quote one number
// each. sdk/test/abi.test.ts holds every value below to the contract source it restates
// (near/contracts/agent-spend-policy/src and near/contracts/a-identity-registry/src), so the
// two cannot drift apart.
//
// The error and event lists are public ABI and append-only on chain; they stay append-only here.

/** get_config().version of the vault build this SDK is written against (lib.rs VERSION). */
export const VAULT_VERSION = "agent-spend-policy 0.2.0";

/** Every vault build reports a get_config().version that starts with this. */
export const VAULT_VERSION_PREFIX = "agent-spend-policy ";

/** The only methods an agent key may call (lib.rs AGENT_METHODS). */
export const AGENT_METHODS = ["pay", "request_payment", "record_refusal"] as const;

/** The only methods the oracle's function-call key on the registry may call (deployment amendment A3). */
export const ORACLE_METHODS = ["set_verdict", "set_verdicts", "clear_verdict", "clear_reports"] as const;

/**
 * Prepaid gas per vault method, in Tgas. The agent figures are the contract's own:
 * AGENT_PREPAID_GAS in near/contracts/agent-spend-policy/src/lib.rs (73: measured, the registry
 * check plus storage_deposit, ft_transfer and the callbacks cannot be scheduled below 51, and 73
 * keeps 30 percent over that floor) and its 10 Tgas for record_refusal. A test reads the
 * contract source so the two numbers cannot drift apart. The protocol holds 0.001 NEAR per
 * prepaid Tgas from the key's allowance until the receipts finish, so a payment in flight holds
 * 0.073 NEAR of it.
 *
 * forget_counters is the owner's forget_guard_refusals and forget_refusals: one removal and one
 * event per payee, well under 1 Tgas each by the contract's own account, for at most
 * MAX_FORGET_BATCH payees. The owner's key has no allowance to protect, and unused gas is
 * refunded.
 */
export const VAULT_GAS_TGAS = {
  pay: 73,
  request_payment: 73,
  record_refusal: 10,
  owner_pay: 100,
  withdraw: 50,
  add_agent_key: 40,
  register_with_token: 30,
  forget_counters: 100,
  owner_default: 30,
} as const;

/** Prepaid gas per registry method, in Tgas. */
export const REGISTRY_GAS_TGAS = { set_verdict: 30, set_verdicts: 100, clear: 30, report: 30, owner: 30 } as const;

/** MAX_GUARD_PAYEES (lib.rs): most payees with a guard refusal counter (record_refusal). */
export const MAX_GUARD_PAYEES = 100;

/** MAX_REFUSAL_PAYEES (lib.rs): most payees with a registry refusal counter (refusal_count). */
export const MAX_REFUSAL_PAYEES = 100;

/** MAX_PENDING_HELD (policy.rs): most payments waiting for the owner at once. */
export const MAX_PENDING_HELD = 20;

/**
 * MAX_FORGET_BATCH (lib.rs): most payees one forget_guard_refusals or forget_refusals call may
 * name, duplicates and payees without a counter included; more is refused BatchTooLarge before
 * anything is removed. The bound is the receipt's log budget: each removal logs one event line
 * of up to 198 bytes, and a receipt may log at most 100 lines and 16384 bytes. A longer list
 * goes out as several transactions (chunkPayees in vault.ts); two clear a full map of 100.
 */
export const MAX_FORGET_BATCH = 50;

/**
 * What the VAULT saw when it held a payment (types.rs HoldKind, snake_case), recorded on the
 * hold (get_held, list_held) and on its payment_held event from 0.2.0 on:
 *   registry_warn  the registry answered WARN for the payee;
 *   unknown_payee  the registry had no verdict (or no registry is set), the owner had not
 *                  listed the payee and the vault had never paid it;
 *   agent_request  the agent asked for a human (request_payment) about a payee the registry
 *                  allowed, or had no verdict on but the vault knew.
 * A hold's `reason` is the vault's code for a held pay and the agent's own free text for a
 * request, and that text can read like a vault code. Decide what a hold means from `kind`,
 * never from `reason`.
 */
export const HOLD_KINDS = ["registry_warn", "unknown_payee", "agent_request"] as const;
export type HoldKind = (typeof HOLD_KINDS)[number];

/** A hold kind, or null for anything else: absent (a build before 0.2.0) or a value this SDK does not know. */
export function parseHoldKind(v: unknown): HoldKind | null {
  return typeof v === "string" && (HOLD_KINDS as readonly string[]).includes(v) ? (v as HoldKind) : null;
}

/** The held reasons the vault writes for a held pay (lib.rs REASON_REGISTRY_WARN, REASON_UNKNOWN_PAYEE). */
export const REASON_REGISTRY_WARN = "RegistryWarn";
export const REASON_UNKNOWN_PAYEE = "UnknownPayee";

/**
 * Every name the vault can answer with, in ABI order (error.rs Error::ALL). A refusal of an
 * authenticated agent carries it in PayOutcome.reason and in payment_refused; everything else
 * is a panic whose failure text is exactly the name.
 */
export const VAULT_ERRORS = [
  "NotOwner",
  "NotAgent",
  "Frozen",
  "SessionKeyExpired",
  "PayeeNotAllowed",
  "AboveAutoApprove",
  "DailyCapExceeded",
  "InvalidAmount",
  "InvalidPayee",
  "MathOverflow",
  "OwnerIsVault",
  "RegistryDeny",
  "RegistryUnavailable",
  "TransferFailed",
  "HeldLimitReached",
  "HeldNotFound",
  "HeldExpired",
  "KeyLimitReached",
  "KeyExists",
  "KeyNotFound",
  "KeyNotRevoked",
  "AllowlistFull",
  "MemoTooLong",
  "RequiresOneYocto",
  "NotCallback",
  "GuardRefusalLimitReached",
  "StorageNotCovered",
  "InitNotAllowed",
  "BatchTooLarge",
] as const;
export type VaultError = (typeof VAULT_ERRORS)[number];

export function isVaultError(v: unknown): v is VaultError {
  return typeof v === "string" && (VAULT_ERRORS as readonly string[]).includes(v);
}

/** Every name the registry can answer with, in ABI order (registry error.rs Error::ALL). */
export const REGISTRY_ERRORS = [
  "NotOwner",
  "NotOracle",
  "OracleLimitReached",
  "InvalidReason",
  "EvidenceTooLong",
  "TooManyReasons",
  "ReportDepositTooLow",
  "DuplicateReport",
  "SelfReport",
  "ReportLimitReached",
  "BatchTooLarge",
  "ScoreOutOfRange",
  "RequiresOneYocto",
  "CodeHashTooLong",
  "MathOverflow",
  "InitNotAllowed",
] as const;
export type RegistryError = (typeof REGISTRY_ERRORS)[number];

/** The vault's NEP-297 event standard (event.rs). */
export const VAULT_EVENT_STANDARD = "a_identity_vault";

/**
 * Every vault event name, in event.rs order. payment_held carries `kind` (0.2.0 on), and the
 * two owner events at the end, guard_refusals_forgotten and refusals_forgotten, carry the
 * payee and the count its counter had when the owner removed it.
 */
export const VAULT_EVENTS = [
  "vault_initialized",
  "agent_key_added",
  "agent_key_add_failed",
  "agent_key_revoked",
  "agent_expiry_set",
  "policy_updated",
  "allowlist_set",
  "registry_set",
  "hold_unknown_set",
  "frozen_set",
  "deposited",
  "payment_sent",
  "payment_refused",
  "payment_held",
  "payment_failed",
  "held_rejected",
  "held_expired",
  "held_settle_failed",
  "withdrawn",
  "withdraw_failed",
  "guard_refusals_forgotten",
  "refusals_forgotten",
] as const;
export type VaultEventName = (typeof VAULT_EVENTS)[number];

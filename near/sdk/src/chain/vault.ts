// Client for the agent spend vault (near/contracts/agent-spend-policy).
//
// Two kinds of signer, and they are different accounts:
//   the AGENT signs as the VAULT account itself, with the function-call key the vault created
//     for it (receiver = the vault, methods = pay, request_payment, record_refusal). That key
//     cannot attach a deposit, call the token, move NEAR or touch keys: the protocol refuses.
//     The agent's transaction must be its own: from vault 0.2.0 on, a NEP-366 delegate action
//     the key signed and someone else relayed is refused NotAgent (the signer must be the vault),
//     so every agent call is paid from the key's own allowance. This client never relays.
//   the OWNER signs as the owner account with a full-access key. Methods that change policy or
//     move money require exactly 1 yoctoNEAR, which only a full-access key can attach; freeze
//     deliberately does not, so it works in one click.
//
// Every write is prepared-or-executed (send.ts): with no key it returns the exact call.

import { NETWORKS } from "../collect/networks.ts";
import { createReader, type RpcReader } from "../collect/rpc.ts";
import { isValidAccountId } from "../engine/account.ts";
import type { Network } from "../engine/types.ts";
import { AGENT_METHODS, MAX_FORGET_BATCH, VAULT_GAS_TGAS, type HoldKind } from "./abi.ts";
import type { LoadedKey } from "./keys.ts";
import { payOutcomeOf, vaultEventFor, type NearEvent, type PayOutcome } from "./outcome.ts";
import { prepare, send, viewFunction, type Call, type Executed, type Pending, type Prepared, type Rejected } from "./send.ts";

// The agent methods and the gas figures live in abi.ts (no imports, so the demo and the oracle
// read them without near-api-js); re-exported here, where the SDK has always offered them.
export { AGENT_METHODS, VAULT_GAS_TGAS };

export const ONE_YOCTO = "1";
const U128_MAX = (1n << 128n) - 1n;
/** The contract's MAX_MEMO_BYTES and MAX_REASON_BYTES. */
export const MAX_TEXT_BYTES = 128;

export type VaultConfig = {
  owner_id: string;
  token_id: string;
  registry_id: string | null;
  frozen: boolean;
  daily_cap: string;
  auto_approve_max: string;
  allowlist_enabled: boolean;
  token_storage_deposit: string;
  /** "agent-spend-policy 0.2.0" for the build this SDK is written against (abi.ts VAULT_VERSION). */
  version: string;
  /** Present from vault v1.1 (amendment A1) on. */
  hold_unknown?: boolean;
};

export type HeldPayment = {
  id: string;
  payment_id: string;
  agent_pk: string;
  payee: string;
  amount: string;
  memo: string | null;
  /** The vault's code for a held pay (RegistryWarn, UnknownPayee), or the agent's own words for a
   * request, which can read like either. Decide what the hold means from `kind`, never from this. */
  reason: string;
  created_at_s: string;
  expires_at_s: string;
  /** What the vault itself saw when it held the payment (abi.ts HoldKind), from 0.2.0 on. Absent
   * on an earlier build, whose holds say nothing reliable about why they wait. */
  kind?: HoldKind;
};

export type AgentKeyView = { public_key: string; label: string; expires_at_s: string; revoked: boolean; added_at_s: string };

/** An executed vault payment call, with the vault's own answer and its matching event. */
export type PayCallResult = Prepared | Rejected | Pending | (Executed & { pay: PayOutcome | null; event: NearEvent | null });
export type CallResult = Prepared | Rejected | Pending | Executed;

export class VaultArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultArgumentError";
  }
}

/** Token amounts are base units as a decimal string ("250000" is 0.25 USDC at 6 decimals). */
export function checkAmount(amount: string): string {
  if (!/^[1-9][0-9]*$/.test(amount) || BigInt(amount) > U128_MAX) {
    throw new VaultArgumentError(`amount must be a positive integer string in token base units, got ${JSON.stringify(amount)}`);
  }
  return amount;
}

/** "0.25" USDC -> "250000". Refuses more decimals than the token has instead of truncating them. */
export function toUnits(decimal: string, decimals = 6): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!m) throw new VaultArgumentError(`not a decimal amount: ${JSON.stringify(decimal)}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new VaultArgumentError(`${decimal} has more than ${decimals} decimals`);
  return checkAmount((BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString());
}

function checkText(text: string | undefined, what: string): void {
  if (text !== undefined && new TextEncoder().encode(text).length > MAX_TEXT_BYTES) {
    throw new VaultArgumentError(`${what} is longer than ${MAX_TEXT_BYTES} bytes (the vault refuses it with MemoTooLong)`);
  }
}

/** Cut a text to at most `max` UTF-8 bytes on a character boundary. */
export function truncateBytes(text: string, max = MAX_TEXT_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

/**
 * The payee list of one forget_guard_refusals or forget_refusals call, checked before anything is
 * built: 1 to MAX_FORGET_BATCH valid account ids, each once. The contract skips a repeat without
 * an event but counts it toward MAX_FORGET_BATCH, so repeats are dropped here first. An invalid
 * id would make the whole call fail to deserialize.
 */
export function checkForgetList(payees: readonly string[]): string[] {
  const unique = [...new Set(payees)];
  if (unique.length === 0) throw new VaultArgumentError("name at least one payee whose counter to forget");
  const bad = unique.find((p) => !isValidAccountId(p));
  if (bad !== undefined) throw new VaultArgumentError(`not a NEAR account id: ${JSON.stringify(bad)}`);
  if (unique.length > MAX_FORGET_BATCH) {
    throw new VaultArgumentError(
      `at most ${MAX_FORGET_BATCH} payees per call, got ${unique.length}: the vault refuses more (BatchTooLarge), because each removal logs one event and a receipt may log at most 16384 bytes; split the list with chunkPayees`,
    );
  }
  return unique;
}

/** A payee list of any length as calls of at most `max` payees each, duplicates dropped, order kept. */
export function chunkPayees(payees: readonly string[], max: number = MAX_FORGET_BATCH): string[][] {
  if (!Number.isInteger(max) || max < 1) throw new VaultArgumentError(`chunk size must be a positive whole number, got ${max}`);
  const unique = [...new Set(payees)];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += max) out.push(unique.slice(i, i + max));
  return out;
}

export type VaultClientOptions = {
  vaultId: string;
  network?: Network;
  reader?: RpcReader;
  /** The agent's function-call key on the vault account. Absent: agent calls come back prepared. */
  agentKey?: LoadedKey | null;
  /** The owner account and its full-access key. Absent key: owner calls come back prepared. */
  owner?: { accountId: string; key?: LoadedKey | null } | null;
  rpcUrl?: string;
  timeoutMs?: number;
};

export type VaultClient = ReturnType<typeof vaultClient>;

export function vaultClient(opts: VaultClientOptions) {
  const network = opts.network ?? "testnet";
  const reader = opts.reader ?? createReader({ rpc: NETWORKS[network].rpc, archival: NETWORKS[network].archival });
  const vaultId = opts.vaultId;

  async function asAgent(methodName: (typeof AGENT_METHODS)[number], args: Record<string, unknown>): Promise<PayCallResult> {
    const call: Call = { receiverId: vaultId, methodName, args, gasTgas: VAULT_GAS_TGAS[methodName], deposit: "0" };
    if (!opts.agentKey) return prepare(vaultId, call, "no agent key loaded");
    const result = await send({ network, signerId: vaultId, key: opts.agentKey, reader, ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }, call);
    if (result.status !== "executed") return result;
    const pay = payOutcomeOf(result.outcome);
    return { ...result, pay, event: pay ? vaultEventFor(result.outcome, vaultId, pay) : null };
  }

  async function asOwner(methodName: string, args: Record<string, unknown>, deposit: string, gasTgas: number = VAULT_GAS_TGAS.owner_default): Promise<CallResult> {
    const signerId = opts.owner?.accountId ?? "<vault owner>";
    const call: Call = { receiverId: vaultId, methodName, args, gasTgas, deposit };
    if (!opts.owner?.key) return prepare(signerId, call, "no owner key loaded");
    return send({ network, signerId, key: opts.owner.key, reader, ...(opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }, call);
  }

  return {
    vaultId,
    network,

    // -- agent (function-call key, signed as the vault) --
    pay(a: { payee: string; amount: string; memo?: string }) {
      checkAmount(a.amount);
      checkText(a.memo, "memo");
      return asAgent("pay", { payee: a.payee, amount: a.amount, memo: a.memo ?? null });
    },
    requestPayment(a: { payee: string; amount: string; memo?: string; reason: string }) {
      checkAmount(a.amount);
      checkText(a.memo, "memo");
      checkText(a.reason, "reason");
      return asAgent("request_payment", { payee: a.payee, amount: a.amount, memo: a.memo ?? null, reason: a.reason });
    },
    recordRefusal(a: { payee: string; amount: string; reason: string }) {
      checkAmount(a.amount);
      checkText(a.reason, "reason");
      return asAgent("record_refusal", { payee: a.payee, amount: a.amount, reason: a.reason });
    },

    // -- owner (full-access key; 1 yoctoNEAR where the contract requires it) --
    async ownerPay(heldId: string): Promise<PayCallResult> {
      const r = await asOwner("owner_pay", { held_id: heldId }, ONE_YOCTO, VAULT_GAS_TGAS.owner_pay);
      if (r.status !== "executed") return r;
      const pay = payOutcomeOf(r.outcome);
      return { ...r, pay, event: pay ? vaultEventFor(r.outcome, vaultId, pay) : null };
    },
    ownerReject: (heldId: string) => asOwner("owner_reject", { held_id: heldId }, ONE_YOCTO),
    freeze: () => asOwner("freeze", {}, "0"),
    unfreeze: () => asOwner("unfreeze", {}, ONE_YOCTO),
    setPolicy: (p: { dailyCap: string; autoApproveMax: string; allowlistEnabled: boolean }) =>
      asOwner("set_policy", { daily_cap: p.dailyCap, auto_approve_max: p.autoApproveMax, allowlist_enabled: p.allowlistEnabled }, ONE_YOCTO),
    setAllowed: (payee: string, ok: boolean) => asOwner("set_allowed", { payee, ok }, ONE_YOCTO),
    setRegistry: (registryId: string | null) => asOwner("set_registry", { registry_id: registryId }, ONE_YOCTO),
    setHoldUnknown: (holdUnknown: boolean) => asOwner("set_hold_unknown", { hold_unknown: holdUnknown }, ONE_YOCTO),
    /** `allowance` is yoctoNEAR of gas allowance; the vault refuses 0 rather than make it unlimited. */
    addAgentKey: (k: { publicKey: string; label: string; expiresAtS: string; allowance: string }) =>
      asOwner("add_agent_key", { public_key: k.publicKey, label: k.label, expires_at_s: k.expiresAtS, allowance: k.allowance }, ONE_YOCTO, VAULT_GAS_TGAS.add_agent_key),
    /**
     * Revoke an agent key: refused by the contract at once, then deleted from the account. From
     * vault 0.2.0 on it also drops every held payment the key asked for (one held_rejected each),
     * and a payment of the key still in flight is refused NotAgent instead of held; the agent asks
     * again with its new key.
     */
    revokeAgentKey: (publicKey: string) => asOwner("revoke_agent_key", { public_key: publicKey }, ONE_YOCTO),
    forgetAgentKey: (publicKey: string) => asOwner("forget_agent_key", { public_key: publicKey }, ONE_YOCTO),
    setAgentExpiry: (publicKey: string, expiresAtS: string) => asOwner("set_agent_expiry", { public_key: publicKey, expires_at_s: expiresAtS }, ONE_YOCTO),
    withdraw: (amount: string) => asOwner("withdraw", { amount: checkAmount(amount) }, ONE_YOCTO, VAULT_GAS_TGAS.withdraw),
    registerWithToken: () => asOwner("register_with_token", {}, "0", VAULT_GAS_TGAS.register_with_token),
    /**
     * Remove the agent's recorded-refusal counters of `payees` (0.2.0 on), freeing their slots
     * under MAX_GUARD_PAYEES and their storage stake. One guard_refusals_forgotten event per
     * removed counter, with the count it had; a payee with no counter is skipped. At most
     * MAX_FORGET_BATCH payees per call (checkForgetList); chunkPayees splits a longer list.
     */
    forgetGuardRefusals: (payees: readonly string[]) =>
      asOwner("forget_guard_refusals", { payees: checkForgetList(payees) }, ONE_YOCTO, VAULT_GAS_TGAS.forget_counters),
    /** The same for the registry refusal counters (refusal_count), under MAX_REFUSAL_PAYEES; one refusals_forgotten each. */
    forgetRefusals: (payees: readonly string[]) => asOwner("forget_refusals", { payees: checkForgetList(payees) }, ONE_YOCTO, VAULT_GAS_TGAS.forget_counters),

    // -- views (final block) --
    getConfig: () => viewFunction<VaultConfig>(reader, vaultId, "get_config"),
    today: () => viewFunction<string>(reader, vaultId, "today"),
    spentToday: () => viewFunction<string>(reader, vaultId, "spent_today"),
    remainingToday: () => viewFunction<string | null>(reader, vaultId, "remaining_today"),
    getAgent: (publicKey: string) => viewFunction<AgentKeyView | null>(reader, vaultId, "get_agent", { public_key: publicKey }),
    listAgents: () => viewFunction<AgentKeyView[]>(reader, vaultId, "list_agents"),
    listHeld: (fromIndex?: string, limit?: string) => viewFunction<HeldPayment[]>(reader, vaultId, "list_held", { from_index: fromIndex ?? null, limit: limit ?? null }),
    getHeld: (heldId: string) => viewFunction<HeldPayment | null>(reader, vaultId, "get_held", { held_id: heldId }),
    isAllowed: (payee: string) => viewFunction<boolean>(reader, vaultId, "is_allowed", { payee }),
    listAllowlist: (fromIndex?: string, limit?: string) => viewFunction<string[]>(reader, vaultId, "list_allowlist", { from_index: fromIndex ?? null, limit: limit ?? null }),
    refusalCount: (payee: string) => viewFunction<number>(reader, vaultId, "refusal_count", { payee }),
    guardRefusalCount: (payee: string) => viewFunction<number>(reader, vaultId, "guard_refusal_count", { payee }),
    paidCount: (payee: string) => viewFunction<number>(reader, vaultId, "paid_count", { payee }),
    /** How many payees have a guard refusal counter, at most MAX_GUARD_PAYEES (0.2.0 on). */
    guardRefusalPayees: () => viewFunction<number>(reader, vaultId, "guard_refusal_payees"),
    /** How many payees have a registry refusal counter, at most MAX_REFUSAL_PAYEES (0.2.0 on). */
    refusalPayees: () => viewFunction<number>(reader, vaultId, "refusal_payees"),
  };
}

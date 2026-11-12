// GENERATED FILE: do not edit.
// Source: near/sdk/src/engine/rules.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// Signals -> Decision. The whole policy is the RULES table below, read top to bottom.
//
//   DENY  if any deny rule fires. Deny rules are facts, not judgement calls: the name is not
//         registered, Circle's USDC blocklists the account, A-Identity's registry says DENY, or
//         the account imitates a known payee's own name AND is new. No positive signal
//         overrides a DENY.
//   WARN  if any warn rule fires and is not cleared. A warning means "a human should look", and
//         the vault holds the payment for one owner tap. Some warnings name the positive
//         signals that clear them (an owner who already paid this payee, A-Identity's own
//         ALLOW); missing data and changes to the payee are never cleared.
//   ALLOW otherwise.
//
// Each reason says what was observed, which threshold applied, and where the fact came from.
// Pure: the same Signals always give the same Decision.

import { DEFAULT_POLICY, SCORE_BANDS, type Policy } from "./policy.js";
import type { Decision, Reason, ReasonCode, Severity, Signals, Verdict } from "./types.js";
import { ENGINE_VERSION } from "./types.js";

type Fired = { detail: string; source: string } | null;

type Rule = {
  code: ReasonCode;
  severity: Severity;
  /** For warnings: only says nobody has history with this payee yet. */
  soft?: boolean;
  /** For warnings: the positive signal that clears it here, or null. */
  clear?: (s: Signals, positives: ReadonlySet<ReasonCode>) => ReasonCode | null;
  test: (s: Signals, p: Policy) => Fired;
};

const exists = (s: Signals) => s.account.state === "ok" && s.account.exists;

/** Clearers for "nobody has history with this payee yet": a human already vouched for it. */
const HISTORY_CLEARERS: readonly ReasonCode[] = ["registry_allow", "prior_payments", "owner_allowlisted"];
const clearByHistory = (_s: Signals, positives: ReadonlySet<ReasonCode>) => HISTORY_CLEARERS.find((c) => positives.has(c)) ?? null;
const clearByRegistryAllow = (_s: Signals, positives: ReadonlySet<ReasonCode>) => (positives.has("registry_allow") ? "registry_allow" : null);

function hours(seconds: number): string {
  return `${seconds / 3600} h`;
}

function isNewOrAbsent(s: Signals): boolean {
  if (s.account.state !== "ok") return false;
  if (!s.account.exists) return true;
  return s.age.state === "ok" && s.age.is_new;
}

export const RULES: readonly Rule[] = [
  // ---------------------------------------------------------------- deny
  {
    code: "account_not_found",
    severity: "deny",
    test: (s) =>
      s.kind === "named" && s.account.state === "ok" && !s.account.exists
        ? {
            detail: `named account ${s.subject} does not exist at block #${s.block.height}; tokens sent to an unregistered name belong to whoever registers it first`,
            source: s.account.source,
          }
        : null,
  },
  {
    code: "usdc_blocklisted",
    severity: "deny",
    test: (s) =>
      s.usdc.state === "ok" && s.usdc.blocklisted
        ? { detail: "Circle's USDC contract reports is_blocklisted = true for this account", source: s.usdc.source }
        : null,
  },
  {
    code: "registry_deny",
    severity: "deny",
    test: (s) =>
      s.registry.state === "ok" && s.registry.verdict?.verdict === "DENY"
        ? {
            detail: `A-Identity registry ${s.registry.id} says DENY${s.registry.verdict.reasons.length ? ` (${s.registry.verdict.reasons.join(", ")})` : ""}, written by ${s.registry.verdict.updated_by}`,
            source: s.registry.source,
          }
        : null,
  },
  {
    code: "lookalike_new_account",
    severity: "deny",
    // Only a strong match: a sibling sharing a role label (agent.bob vs agent.alice) is not an
    // impersonation of anyone's name, so it warns below instead (lookalike_known).
    test: (s, p) => {
      if (!s.lookalike || !s.lookalike.strong || !isNewOrAbsent(s)) return null;
      const age = s.account.state === "ok" && !s.account.exists ? "does not exist yet" : s.age.state === "ok" ? s.age.detail : "is new";
      return {
        detail: `${s.lookalike.kind}: ${s.lookalike.detail}; and it is new (${age}; line ${hours(p.recent_s)})`,
        source: `engine lookalike + ${s.age.state === "ok" ? s.age.source : s.account.state === "ok" ? s.account.source : "rpc"}`,
      };
    },
  },

  // ---------------------------------------------------------------- warn (about the payee)
  {
    code: "registry_warn",
    severity: "warn",
    test: (s) =>
      s.registry.state === "ok" && s.registry.verdict?.verdict === "WARN"
        ? {
            detail: `A-Identity registry ${s.registry.id} says WARN${s.registry.verdict.reasons.length ? ` (${s.registry.verdict.reasons.join(", ")})` : ""}`,
            source: s.registry.source,
          }
        : null,
  },
  {
    code: "code_changed_since_verdict",
    severity: "warn",
    test: (s) => {
      if (s.registry.state !== "ok" || !s.registry.verdict?.code_hash || s.account.state !== "ok" || !s.account.exists) return null;
      if (s.registry.verdict.code_hash === s.account.code_hash) return null;
      return {
        detail: `the registry's verdict was written for code hash ${s.registry.verdict.code_hash}; the account now runs ${s.account.code_hash}`,
        source: `${s.registry.source} + ${s.account.source}`,
      };
    },
  },
  {
    code: "code_changed_recently",
    severity: "warn",
    test: (s) => (s.code_change.state === "ok" && s.code_change.changed ? { detail: s.code_change.detail, source: s.code_change.source } : null),
  },
  {
    code: "global_contract_mutable",
    severity: "warn",
    test: (s) =>
      s.account.state === "ok" && s.account.global_contract?.by === "account"
        ? {
            detail: `runs the global contract published by ${s.account.global_contract.account_id}, which can change the code at any time without a deploy on this account`,
            source: s.account.source,
          }
        : null,
  },
  {
    code: "new_full_access_key",
    severity: "warn",
    test: (s, p) =>
      s.key_changes.state === "ok" && s.key_changes.added_full_access.length > 0
        ? {
            detail: `${s.key_changes.added_full_access.length} full-access key(s) added within ${hours(p.recent_s)} on an older account (${s.key_changes.added_full_access.join(", ")}): someone new can sign for it`,
            source: s.key_changes.source,
          }
        : null,
  },
  {
    code: "prior_registry_refusals",
    severity: "warn",
    clear: clearByRegistryAllow,
    test: (s) => {
      if (s.vault.state !== "ok" || s.vault.refusal_count === 0) return null;
      if (s.registry.state === "ok" && s.registry.verdict?.verdict === "DENY") return null;
      return {
        detail: `vault ${s.vault.id} refused ${s.vault.refusal_count} payment(s) to this payee on a registry DENY that no longer stands`,
        source: s.vault.source,
      };
    },
  },
  {
    code: "open_reports",
    severity: "warn",
    // A report is a claim anyone can file for 0.01 NEAR, so it can delay a payment but never
    // refuse one. It stops counting once the oracle has written an ALLOW after the newest report.
    clear: (s, positives) => {
      if (!positives.has("registry_allow") || s.registry.state !== "ok" || !s.registry.verdict) return null;
      const newest = s.registry.newest_open_report_ns;
      return newest !== null && BigInt(s.registry.verdict.updated_at_ns) > BigInt(newest) ? "registry_allow" : null;
    },
    test: (s) =>
      s.registry.state === "ok" && s.registry.open_reports > 0
        ? {
            detail: `${s.registry.open_reports} open report(s) from ${s.registry.open_reporters.length} reporter(s) in ${s.registry.id}, not yet reviewed by the oracle`,
            source: s.registry.source,
          }
        : null,
  },
  {
    code: "third_party_flag",
    severity: "warn",
    clear: clearByRegistryAllow,
    test: (s) => {
      const flagged = s.third_party.filter((t) => t.state === "ok" && t.flagged);
      if (flagged.length === 0) return null;
      const parts = flagged.map((t) =>
        t.state === "ok"
          ? `${t.source.name} (${t.source.contract}): ${t.detail}${t.demo ? " [the entry says it is demo data]" : ""}${t.evidence_url ? `, evidence ${t.evidence_url}` : ""}`
          : "",
      );
      return {
        detail: `flagged in another team's public NEAR registry, attributed and never decisive alone: ${parts.join("; ")}`,
        source: flagged.map((t) => `rpc ${t.source.contract}.${t.source.method}`).join(" + "),
      };
    },
  },
  {
    code: "lookalike_known",
    severity: "warn",
    clear: clearByHistory,
    test: (s) => {
      if (!s.lookalike) return null;
      if (!s.lookalike.strong) return { detail: `${s.lookalike.kind}: ${s.lookalike.detail} (a shared role label, so a human decides)`, source: "engine lookalike" };
      return isNewOrAbsent(s) ? null : { detail: `${s.lookalike.kind}: ${s.lookalike.detail} (not new, so a human decides)`, source: "engine lookalike" };
    },
  },

  // ---------------------------------------------------------------- warn (no history yet: soft)
  {
    code: "new_account",
    severity: "warn",
    soft: true,
    clear: clearByHistory,
    test: (s) => (exists(s) && s.age.state === "ok" && s.age.is_new ? { detail: s.age.detail, source: s.age.source } : null),
  },
  {
    code: "low_activity",
    severity: "warn",
    soft: true,
    clear: clearByHistory,
    test: (s, p) =>
      exists(s) && s.activity.state === "ok" && s.activity.tx_count < p.min_activity_txs
        ? { detail: `${s.activity.tx_count} transaction(s) at or before the block (threshold ${p.min_activity_txs})`, source: s.activity.source }
        : null,
  },
  {
    code: "implicit_unfunded",
    severity: "warn",
    soft: true,
    clear: clearByHistory,
    test: (s) =>
      s.kind !== "named" && s.account.state === "ok" && !s.account.exists
        ? { detail: `${s.kind} account has never been funded: no history, controlled by whoever holds its key`, source: s.account.source }
        : null,
  },

  // ---------------------------------------------------------------- warn (missing data: never cleared)
  {
    code: "rpc_unavailable",
    severity: "warn",
    test: (s) => {
      const missing: string[] = [];
      if (s.account.state === "unavailable") missing.push(`account (${s.account.why})`);
      if (s.keys.state === "unavailable") missing.push(`keys (${s.keys.why})`);
      if (s.age.state === "unavailable") missing.push(`age (${s.age.why})`);
      if (s.key_changes.state === "unavailable") missing.push(`key history (${s.key_changes.why})`);
      if (s.code_change.state === "unavailable") missing.push(`code history (${s.code_change.why})`);
      return missing.length ? { detail: `chain reads missing, so this cannot be ALLOW: ${missing.join("; ")}`, source: "rpc" } : null;
    },
  },
  {
    code: "indexer_unavailable",
    severity: "warn",
    test: (s) =>
      s.activity.state === "unavailable"
        ? { detail: `transaction history unknown (${s.activity.why}); unknown is not clean`, source: s.activity.source }
        : null,
  },
  {
    code: "registry_unreadable",
    severity: "warn",
    test: (s) =>
      s.registry.state === "unavailable"
        ? { detail: `A-Identity registry ${s.registry.id} could not be read (${s.registry.why}); a DENY there would be missed`, source: s.registry.source }
        : null,
  },
  {
    code: "blocklist_unreadable",
    severity: "warn",
    test: (s) =>
      s.usdc.state === "unavailable" ? { detail: `USDC is_blocklisted could not be read (${s.usdc.why})`, source: s.usdc.source } : null,
  },
  {
    code: "vault_unreadable",
    severity: "warn",
    test: (s) =>
      s.vault.state === "unavailable"
        ? { detail: `vault ${s.vault.id} could not be read (${s.vault.why}); its refusal history is unknown`, source: s.vault.source }
        : null,
  },

  // ---------------------------------------------------------------- positive
  {
    code: "registry_allow",
    severity: "positive",
    test: (s) =>
      s.registry.state === "ok" && s.registry.verdict?.verdict === "ALLOW"
        ? { detail: `A-Identity registry ${s.registry.id} says ALLOW, written by ${s.registry.verdict.updated_by}`, source: s.registry.source }
        : null,
  },
  {
    code: "prior_payments",
    severity: "positive",
    test: (s) =>
      s.vault.state === "ok" && s.vault.paid_count > 0
        ? { detail: `vault ${s.vault.id} has paid this payee ${s.vault.paid_count} time(s): its owner approved it before`, source: s.vault.source }
        : null,
  },
  {
    code: "owner_allowlisted",
    severity: "positive",
    test: (s) =>
      s.vault.state === "ok" && s.vault.allowlisted ? { detail: `on vault ${s.vault.id}'s owner allowlist`, source: s.vault.source } : null,
  },
  {
    code: "long_history",
    severity: "positive",
    test: (s, p) =>
      exists(s) &&
      s.age.state === "ok" &&
      s.age.is_long === true &&
      s.activity.state === "ok" &&
      s.activity.tx_count >= p.min_activity_txs
        ? {
            detail: `existed at least ${p.long_s / 86400} days before the block with ${s.activity.at_least ? "at least " : ""}${s.activity.tx_count} transactions`,
            source: `${s.age.source} + ${s.activity.source}`,
          }
        : null,
  },
  {
    code: "erc8004_identity",
    severity: "positive",
    test: (s) =>
      s.erc8004.state === "ok" && s.erc8004.agent_ids.length > 0
        ? {
            detail: `owns ERC-8004 agent identity ${s.erc8004.agent_ids.join(", ")} in ${s.erc8004.identity} (registration is permissionless, so this raises the score only)`,
            source: s.erc8004.source,
          }
        : null,
  },
  {
    code: "erc8004_reputation",
    severity: "positive",
    test: (s, p) =>
      s.erc8004.state === "ok" && s.erc8004.feedback_count > 0 && s.erc8004.mean !== null && s.erc8004.mean >= p.erc8004_good_mean
        ? { detail: `ERC-8004 feedback: ${s.erc8004.feedback_count} rating(s), mean ${s.erc8004.mean}`, source: s.erc8004.source }
        : null,
  },

  // ---------------------------------------------------------------- info
  {
    code: "known_payee",
    severity: "info",
    test: (s) => (s.is_known ? { detail: "in the known payee set (caller list, vault allowlist or registry ALLOW)", source: "context" } : null),
  },
  {
    code: "contract_account",
    severity: "info",
    test: (s) =>
      s.account.state === "ok" && s.account.exists && s.account.has_contract
        ? { detail: `runs contract code ${s.account.code_hash}`, source: s.account.source }
        : null,
  },
  {
    code: "locked_contract",
    severity: "info",
    test: (s) =>
      s.account.state === "ok" && s.account.exists && s.account.has_contract && s.keys.state === "ok" && s.keys.full_access === 0
        ? { detail: "no full-access key: only the contract's own logic can change it", source: s.keys.source }
        : null,
  },
  {
    code: "usdc_unregistered",
    severity: "info",
    test: (s) =>
      s.usdc.state === "ok" && s.usdc.registered === false
        ? { detail: "no USDC storage registration yet; the vault attaches the 0.00125 NEAR registration before paying", source: s.usdc.source }
        : null,
  },
  {
    code: "guard_refusals",
    severity: "info",
    test: (s) =>
      s.vault.state === "ok" && s.vault.guard_refusal_count !== null && s.vault.guard_refusal_count > 0
        ? {
            detail: `agents of vault ${s.vault.id} recorded ${s.vault.guard_refusal_count} guard refusal(s); any agent key can record one, so this is never used to decide`,
            source: s.vault.source,
          }
        : null,
  },
  {
    code: "erc8004_low_reputation",
    severity: "info",
    test: (s, p) =>
      s.erc8004.state === "ok" && s.erc8004.feedback_count > 0 && s.erc8004.mean !== null && s.erc8004.mean < p.erc8004_good_mean
        ? { detail: `ERC-8004 feedback mean ${s.erc8004.mean} from ${s.erc8004.feedback_count} rating(s) (below ${p.erc8004_good_mean}; ratings cost a small deposit, so this lowers the score only)`, source: s.erc8004.source }
        : null,
  },
  {
    code: "registry_not_deployed",
    severity: "info",
    test: (s) =>
      s.registry.state === "not_deployed"
        ? { detail: `no A-Identity registry contract at ${s.registry.id} at this block`, source: s.registry.source }
        : null,
  },
  {
    code: "third_party_unreadable",
    severity: "info",
    test: (s) => {
      const down = s.third_party.filter((t) => t.state === "unavailable");
      return down.length
        ? { detail: `not read: ${down.map((t) => `${t.source.name} (${t.state === "unavailable" ? t.why : ""})`).join("; ")}`, source: down.map((t) => `rpc ${t.source.contract}`).join(" + ") }
        : null;
    },
  },
  {
    code: "erc8004_unreadable",
    severity: "info",
    test: (s) => (s.erc8004.state === "unavailable" ? { detail: `ERC-8004 registries not read (${s.erc8004.why})`, source: s.erc8004.source } : null),
  },
];

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { deny: 0, warn: 1, positive: 2, info: 3 };

export function decide(s: Signals, policy: Policy = DEFAULT_POLICY): Decision {
  const fired: { rule: Rule; reason: Reason; index: number }[] = [];
  RULES.forEach((rule, index) => {
    const hit = rule.test(s, policy);
    if (hit) fired.push({ rule, reason: { code: rule.code, severity: rule.severity, detail: hit.detail, source: hit.source }, index });
  });

  const positives = new Set(fired.filter((f) => f.rule.severity === "positive").map((f) => f.rule.code));
  for (const f of fired) {
    if (f.rule.severity !== "warn" || !f.rule.clear) continue;
    const by = f.rule.clear(s, positives);
    if (by) f.reason.cleared_by = by;
  }

  const deciding = fired.filter((f) => f.rule.severity === "deny" || (f.rule.severity === "warn" && !f.reason.cleared_by));
  const verdict: Verdict = deciding.some((f) => f.rule.severity === "deny") ? "DENY" : deciding.length > 0 ? "WARN" : "ALLOW";
  const warn_kind = verdict !== "WARN" ? null : deciding.every((f) => f.rule.soft === true) ? "soft" : "hard";

  // Score: base, minus each deciding concern, plus each positive, then clamped into the band.
  let raw = policy.score.base;
  for (const f of fired) {
    if (f.rule.severity === "deny") raw -= policy.score.deny;
    else if (f.rule.severity === "warn") raw -= f.reason.cleared_by ? policy.score.cleared_warn : f.rule.soft ? policy.score.soft_warn : policy.score.hard_warn;
    else if (f.rule.severity === "positive") raw += policy.score.positive[f.rule.code] ?? 0;
    else raw += policy.score.info[f.rule.code] ?? 0;
  }
  const [lo, hi] = SCORE_BANDS[verdict];
  const score = Math.min(hi, Math.max(lo, raw));

  const reasons = fired
    .sort((a, b) => {
      const sev = SEVERITY_ORDER[a.rule.severity] - SEVERITY_ORDER[b.rule.severity];
      if (sev !== 0) return sev;
      const cleared = Number(Boolean(a.reason.cleared_by)) - Number(Boolean(b.reason.cleared_by));
      return cleared !== 0 ? cleared : a.index - b.index;
    })
    .map((f) => f.reason);

  return {
    subject: s.subject,
    network: s.network,
    verdict,
    score,
    reasons,
    warn_kind,
    engine_version: ENGINE_VERSION,
    policy_id: policy.id,
    block: s.block,
  };
}

/** The deciding reason codes, as the registry's `reasons` field takes them (at most 8). */
export function registryReasons(d: Decision): string[] {
  const deciding = d.reasons.filter((r) => (r.severity === "deny" || r.severity === "warn") && !r.cleared_by);
  const chosen = d.verdict === "DENY" ? deciding.filter((r) => r.severity === "deny") : d.verdict === "WARN" ? deciding : d.reasons.filter((r) => r.severity === "positive");
  return [...new Set(chosen.map((r) => r.code))].slice(0, 8);
}

// GENERATED FILE: do not edit.
// Source: near/sdk/src/engine/policy.ts, the NEAR verdict engine's canonical copy.
// Rendered by mcp/scripts/gen-near-engine.mjs (cd mcp && npm run gen:near): the source's
// bytes, with relative import specifiers rewritten from .ts to .js. chains/near/engine.test.ts
// fails the build when this file differs from a fresh render. Change the source, then rerun.

// The thresholds the engine decides with, and why each one has the value it has.
//
// A threshold here is a claim a judge can argue with, so each carries its reason. They are
// deliberately few, round and conservative: a WARN only holds a payment for one human tap, so
// the cost of a false WARN is a delay, while the cost of a false ALLOW is money sent. DENY is
// reserved for facts that are not judgement calls (see rules.ts).
//
// Changing a value changes verdicts, so it changes `id` and bumps ENGINE_VERSION in types.ts.

export type LookalikePolicy = {
  /** Names shorter than this only match on an identical skeleton (homoglyphs, separators). */
  min_len_edit: number;
  /** Names at least this long may differ by 2 edits; shorter ones by 1. */
  long_len: number;
  /** Most extra characters around a contained known name ("merchant" -> "merchant-pay"). */
  max_affix: number;
  /**
   * Shortest first label for a parent swap (aid-demo-merchant.evil.testnet vs
   * aid-demo-merchant.testnet). When the known label is a role under someone's account
   * (shop.alice.testnet vs shop.bob.testnet) the swap is weak and only warns (lookalike.ts).
   */
  min_label_parent_swap: number;
  /** Hex characters compared at each end of an implicit account (address poisoning). */
  hex_prefix: number;
  hex_suffix: number;
};

export type ScorePolicy = {
  base: number;
  deny: number;
  hard_warn: number;
  soft_warn: number;
  cleared_warn: number;
  positive: Partial<Record<string, number>>;
  info: Partial<Record<string, number>>;
};

export type Policy = {
  id: string;
  /** New account, new full-access key and recent code change all use this window. */
  recent_s: number;
  /** An account at least this old, with at least min_activity_txs transactions, has history. */
  long_s: number;
  /** Fewer transactions than this, at or before the block, is low activity. */
  min_activity_txs: number;
  /** A probe block may be at most this much older than its target time. */
  probe_tolerance_s: number;
  /** ERC-8004 mean feedback at or above this (on a 0..100 scale) counts as good. */
  erc8004_good_mean: number;
  lookalike: LookalikePolicy;
  score: ScorePolicy;
};

export const DEFAULT_POLICY: Policy = {
  id: "near-default/1",

  // 72 hours. Drainer and impersonation accounts are typically created minutes to hours before
  // use (address poisoning plants its lookalike right after a test transfer, and the Dec 2025
  // USD 50M poisoning loss used one created minutes earlier). 72 h is long enough to cover a
  // weekend, so the owner and the shared registries have had a chance to see the account before
  // money goes to it, and short enough that a legitimate new merchant waits only for its first
  // payment: the owner approves once and later payments flow (prior_payments clears it).
  recent_s: 72 * 3600,

  // 30 days. Burner accounts rarely live this long before they are used; an account that has
  // existed for a month and transacted is past the window in which almost all of the field's
  // demo and real drainer entries were created and used. Positive only: age never clears a
  // flag, a report or a code change.
  long_s: 30 * 86400,

  // 5 transactions. Setting up an account by hand (create, fund, add a key, register a token)
  // already takes 3 or 4; an account with fewer than 5 has done essentially nothing anyone
  // could have observed. Soft: a prior payment or an owner allowlist entry clears it.
  min_activity_txs: 5,

  // 10 minutes. The archival probe looks for the latest block at least `recent_s` before the
  // pinned block; a probe block up to 10 minutes earlier than that target is accepted, so the
  // 72 h line is drawn to within 10 minutes and never in the payee's favour.
  probe_tolerance_s: 600,

  // 50 of 100: the middle of ERC-8004's suggested 0..100 feedback scale.
  erc8004_good_mean: 50,

  lookalike: {
    // One edit to a 4-letter name makes a different name ("bob" vs "rob"), not a lookalike, so
    // short names match only when they look identical after the homoglyph mapping.
    min_len_edit: 5,
    // Typosquatting studies find most squats at Damerau-Levenshtein distance 1 from the target;
    // 2 edits are allowed only from 9 characters on, where they leave at least 78% unchanged.
    long_len: 9,
    // "aid-demo-merchant-pay" or "pay-aid-demo-merchant": up to 8 extra characters around a
    // known name of 5 or more characters.
    max_affix: 8,
    // A first label like "app" or "pool" is generic; from 5 characters it names something. It
    // names the account itself only directly under .near, .testnet or the root: "agent" in
    // agent.alice.testnet is a role any account can give a sub-account, so a sibling such as
    // agent.bob.testnet only warns, and a new one is never refused for that alone.
    min_label_parent_swap: 5,
    // Wallets truncate implicit accounts to their first and last 4 to 6 characters, which is
    // exactly what address poisoning matches. Two unrelated 64-hex accounts share the first 4
    // and last 4 hex digits with probability 16^-8 (1 in 4.3 billion), so a match is deliberate.
    hex_prefix: 4,
    hex_suffix: 4,
  },

  // The score orders payees inside a verdict band; it never decides the verdict. Bands follow
  // A-Identity's published methodology on other chains: DENY below 200, WARN 200..499,
  // ALLOW 500 and up (mcp/src/commerce.ts).
  score: {
    base: 600,
    deny: 400,
    hard_warn: 120,
    soft_warn: 80,
    cleared_warn: 20,
    positive: {
      registry_allow: 150,
      prior_payments: 100,
      owner_allowlisted: 80,
      long_history: 80,
      erc8004_reputation: 50,
      erc8004_identity: 30,
    },
    info: {
      erc8004_low_reputation: -30,
    },
  },
};

/** Inclusive score bands per verdict. */
export const SCORE_BANDS = {
  DENY: [0, 199],
  WARN: [200, 499],
  ALLOW: [500, 1000],
} as const;

//! The event ABI (NEP-297, standard `a_identity_vault`, version `1.0.0`).
//!
//! These are not diagnostics. `payment_sent`, `payment_refused`, `payment_held` and
//! `payment_failed` are the vault's audit trail: every authenticated payment attempt ends in
//! exactly one of them, carrying the same `payment_id` the caller got back in its `PayOutcome`.
//! The running day total in storage is a working number that is reset every UTC day; the log is
//! the permanent record of who was paid, who was refused, and why.
//!
//! Each line is `EVENT_JSON:{"standard":"a_identity_vault","version":"1.0.0","event":<name>,
//! "data":{...}}`, where `<name>` is the variant name in snake_case. Like the error names, the
//! event names and their field names are public ABI: renaming one changes what every indexer
//! downstream sees. Amounts, ids, days and timestamps are decimal strings (`U128`/`U64`).
//!
//! One deliberate addition to the spec's field lists: `held_settle_failed` carries the held
//! payment's `payment_id`, `payee`, `amount` and `memo` next to `held_id` and `reason`. The held
//! entry is removed when `owner_pay` starts (so it cannot be approved twice concurrently), which
//! means a failed settlement leaves the owner nothing to read in storage; the event is the only
//! place left that says what the agent would have to request again.

use near_sdk::json_types::{U64, U128};
use near_sdk::serde::Serialize;
use near_sdk::{AccountId, PublicKey, near};

/// Who refused a payment. Only `registry` refusals (a DENY) count against the payee, in
/// `refusal_count`. `agent_guard` refusals are counted apart, in `guard_refusal_count`, because
/// any agent key, a prompt-injected one included, can record one against any payee. `policy`
/// refusals are the vault's own rules and say nothing about the payee at all.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde", rename_all = "snake_case")]
pub enum RefusalSource {
    /// A gate in `policy.rs`, the held-payment limit, or a last-moment freeze or revocation.
    Policy,
    /// The on-chain registry said DENY, or could not be read.
    Registry,
    /// The agent's off-chain A-Identity guard said DENY, recorded with `record_refusal`.
    AgentGuard,
}

#[near(event_json(standard = "a_identity_vault"))]
pub enum VaultEvent<'a> {
    #[event_version("1.0.0")]
    VaultInitialized {
        owner_id: &'a AccountId,
        token_id: &'a AccountId,
        registry_id: Option<&'a AccountId>,
    },
    #[event_version("1.0.0")]
    AgentKeyAdded {
        public_key: &'a PublicKey,
        label: &'a str,
        expires_at_s: U64,
        allowance: U128,
    },
    #[event_version("1.0.0")]
    AgentKeyAddFailed { public_key: &'a PublicKey },
    #[event_version("1.0.0")]
    AgentKeyRevoked { public_key: &'a PublicKey },
    #[event_version("1.0.0")]
    AgentExpirySet {
        public_key: &'a PublicKey,
        expires_at_s: U64,
    },
    #[event_version("1.0.0")]
    PolicyUpdated {
        daily_cap: U128,
        auto_approve_max: U128,
        allowlist_enabled: bool,
    },
    #[event_version("1.0.0")]
    AllowlistSet { payee: &'a AccountId, ok: bool },
    #[event_version("1.0.0")]
    RegistrySet { registry_id: Option<&'a AccountId> },
    /// Amendment A1. Not emitted at init, where the flag starts true; `get_config` shows it.
    #[event_version("1.0.0")]
    HoldUnknownSet { hold_unknown: bool },
    #[event_version("1.0.0")]
    FrozenSet { frozen: bool },
    #[event_version("1.0.0")]
    Deposited {
        sender_id: &'a AccountId,
        amount: U128,
    },
    #[event_version("1.0.0")]
    PaymentSent {
        payment_id: U64,
        payee: &'a AccountId,
        amount: U128,
        /// The UTC day the payment was reserved against.
        day: U64,
        /// True when the owner settled a held payment, false when the agent spent inside the
        /// policy. Both count toward the day, so this flag is the only thing that tells them
        /// apart after the fact.
        by_owner: bool,
        memo: Option<&'a str>,
    },
    #[event_version("1.0.0")]
    PaymentRefused {
        payment_id: U64,
        payee: &'a AccountId,
        amount: U128,
        /// An error name, or for `agent_guard` the guard's own reason.
        reason: &'a str,
        source: RefusalSource,
        /// Up to three registry reason codes, each at most 32 bytes. Empty unless the registry
        /// said DENY.
        registry_reasons: &'a [String],
    },
    #[event_version("1.0.0")]
    PaymentHeld {
        payment_id: U64,
        held_id: U64,
        payee: &'a AccountId,
        amount: U128,
        reason: &'a str,
    },
    #[event_version("1.0.0")]
    PaymentFailed {
        payment_id: U64,
        payee: &'a AccountId,
        amount: U128,
        reason: &'a str,
    },
    #[event_version("1.0.0")]
    HeldRejected { held_id: U64 },
    #[event_version("1.0.0")]
    HeldExpired { held_id: U64 },
    #[event_version("1.0.0")]
    HeldSettleFailed {
        held_id: U64,
        reason: &'a str,
        payment_id: U64,
        payee: &'a AccountId,
        amount: U128,
        memo: Option<&'a str>,
    },
    #[event_version("1.0.0")]
    Withdrawn { amount: U128 },
    #[event_version("1.0.0")]
    WithdrawFailed { amount: U128 },
}

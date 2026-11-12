//! The vault's records and its JSON shapes.
//!
//! Stored records are Borsh and use native integers. Everything that crosses the JSON boundary
//! uses `U64` and `U128`, which serialize as decimal strings: JSON numbers lose precision above
//! 2^53, and a token amount or a nanosecond timestamp gets there. The rule is applied to every
//! `u64` and `u128` in a JSON shape, ids included, so a client never has to know which fields
//! happen to be small. The two per-payee counters are `u32` and stay JSON numbers.
//!
//! These shapes are public ABI for the TypeScript SDK and the console. Adding a field is safe for
//! a client that ignores unknown fields; renaming or retyping one is not.

use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, PublicKey, near};

/// What happened to one agent or owner payment attempt.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PayStatus {
    /// The token transfer succeeded. Only the transfer callback ever reports this.
    Sent,
    /// A gate, the registry or the agent's guard said no. Nothing moved.
    Refused,
    /// Waiting for the owner as a held payment. Nothing moved.
    Held,
    /// The token transfer was attempted and failed, or could not be funded. Nothing moved and the
    /// reservation was released.
    Failed,
}

/// The receipt every `pay`, `request_payment`, `record_refusal` and `owner_pay` returns.
///
/// Each status has exactly one matching event (`payment_sent`, `payment_refused`, `payment_held`,
/// `payment_failed`), so a client can rebuild the history from either the return values or the
/// log and get the same answer.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayOutcome {
    pub status: PayStatus,
    /// Assigned on every authenticated attempt, including refused ones, so every refusal has an
    /// id an indexer can join on. A held payment keeps the id of the attempt that created it, and
    /// `owner_pay` settles it under that same id.
    pub payment_id: U64,
    /// The error name for `refused` and `failed`, the held reason for `held`, the agent's own
    /// reason for a recorded guard refusal, and `None` for `sent`.
    pub reason: Option<String>,
    pub held_id: Option<U64>,
}

/// Which entry point a payment pipeline started from. It decides what each registry answer means.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PayMode {
    /// The agent's `pay`: reserved against the cap, transfers on ALLOW, holds on WARN, and with
    /// `hold_unknown` on also holds a payee the registry is silent on and nobody vouches for.
    Pay,
    /// The agent's `request_payment`: reserves nothing, holds on anything but DENY.
    Request,
    /// The owner's `owner_pay`: reserved against the cap, transfers on ALLOW and on WARN, because
    /// the owner is the human a WARN asks for.
    OwnerPay,
}

/// Everything a callback needs, carried in its arguments rather than in storage, so an in-flight
/// payment costs no storage and cannot be confused with another one.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentCtx {
    pub payment_id: U64,
    pub mode: PayMode,
    /// The agent key that started the attempt. For `OwnerPay`, the key that requested the held
    /// payment being settled.
    pub agent_pk: PublicKey,
    pub payee: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    /// The UTC day the reservation was made on. A release only applies to that day.
    pub day: U64,
    /// The agent's reason, for `Request` only.
    pub reason: Option<String>,
    /// The held payment being settled, for `OwnerPay` only.
    pub held_id: Option<U64>,
}

/// An agent key record. The key itself is a real function-call access key on the vault account.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentKey {
    pub label: String,
    /// Unix seconds; 0 means no expiry. Valid through that second inclusive.
    pub expires_at_s: u64,
    /// Set by `revoke_agent_key` before the on-chain key is deleted, so the contract refuses the
    /// key even in the window before the delete lands, and even if the delete were to fail.
    pub revoked: bool,
    pub added_at_s: u64,
    /// Internal, not part of any JSON shape. Identifies the `add_agent_key` call that created
    /// this record, so a failed add only ever removes the record it created, never a newer record
    /// for the same public key.
    pub nonce: u64,
}

/// A payment waiting for the owner.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldPayment {
    /// The held id, equal to its key in the map.
    pub id: u64,
    /// The id of the agent attempt that created it.
    pub payment_id: u64,
    pub agent_pk: PublicKey,
    pub payee: AccountId,
    pub amount: u128,
    pub memo: Option<String>,
    /// `RegistryWarn` when a `pay` was held because the registry warned, `UnknownPayee` when it
    /// was held because nobody has judged the payee (`hold_unknown`); otherwise the agent's own
    /// reason from `request_payment`.
    pub reason: String,
    pub created_at_s: u64,
    /// `created_at_s + HELD_TTL_S`. Valid through that second inclusive.
    pub expires_at_s: u64,
}

/// JSON view of an agent key record.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentKeyView {
    pub public_key: PublicKey,
    pub label: String,
    pub expires_at_s: U64,
    pub revoked: bool,
    pub added_at_s: U64,
}

impl AgentKeyView {
    pub fn new(public_key: &PublicKey, key: &AgentKey) -> Self {
        Self {
            public_key: public_key.clone(),
            label: key.label.clone(),
            expires_at_s: U64(key.expires_at_s),
            revoked: key.revoked,
            added_at_s: U64(key.added_at_s),
        }
    }
}

/// JSON view of a held payment.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldPaymentView {
    pub id: U64,
    pub payment_id: U64,
    pub agent_pk: PublicKey,
    pub payee: AccountId,
    pub amount: U128,
    pub memo: Option<String>,
    pub reason: String,
    pub created_at_s: U64,
    pub expires_at_s: U64,
}

impl From<&HeldPayment> for HeldPaymentView {
    fn from(h: &HeldPayment) -> Self {
        Self {
            id: U64(h.id),
            payment_id: U64(h.payment_id),
            agent_pk: h.agent_pk.clone(),
            payee: h.payee.clone(),
            amount: U128(h.amount),
            memo: h.memo.clone(),
            reason: h.reason.clone(),
            created_at_s: U64(h.created_at_s),
            expires_at_s: U64(h.expires_at_s),
        }
    }
}

/// `get_config()`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VaultConfig {
    pub owner_id: AccountId,
    pub token_id: AccountId,
    pub registry_id: Option<AccountId>,
    pub frozen: bool,
    pub daily_cap: U128,
    pub auto_approve_max: U128,
    pub allowlist_enabled: bool,
    /// yoctoNEAR attached to `storage_deposit` before each transfer.
    pub token_storage_deposit: U128,
    pub version: String,
    /// Amendment A1: whether an agent `pay` to a payee nobody has judged waits for the owner.
    /// Last, because it was added after the first shape was published.
    pub hold_unknown: bool,
}

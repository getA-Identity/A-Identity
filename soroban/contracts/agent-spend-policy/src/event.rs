//! The event ABI.
//!
//! These are not diagnostics. `Paid` is the vault's audit trail, and it is the reason the
//! per-day accumulator can safely live in temporary storage: the running total is a
//! working number that may expire, while the permanent record of who was paid, how much,
//! and on which UTC day is here, in the ledger, indexable. A storage entry could never
//! carry the counterparty anyway.
//!
//! `to` and `day` are topics so an indexer can filter by payee or by day without reading
//! every event. Everything else is data.
//!
//! Like the error discriminants, these shapes are public ABI. Renaming a field or moving
//! one between the topic and data sections changes what downstream indexers see.

use soroban_sdk::{contractevent, Address};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Paid {
    #[topic]
    pub to: Address,
    #[topic]
    pub day: u64,
    pub amount: i128,
    /// True when the owner settled it out of band, false when the agent spent it inside
    /// the policy. Both count toward the day, so this flag is the only thing that
    /// distinguishes them after the fact.
    pub by_owner: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawn {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyUpdated {
    pub daily_cap: i128,
    pub auto_approve_max: i128,
    pub allowlist_enabled: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowlistSet {
    #[topic]
    pub payee: Address,
    pub allowed: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorSet {
    #[topic]
    pub operator: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionKeyExpirySet {
    pub expiry: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrozenSet {
    pub frozen: bool,
}

//! Typed storage keys, and the TTL policy that goes with each one.
//!
//! Every accessor in this file owns the TTL bump for the entry it touches, so no call
//! site can forget one. That matters more here than in most contracts: an archived entry
//! in a vault holding real money is not a stale read, it is a vault that cannot be paid
//! out of until someone restores it.
//!
//! ## Why the day bucket is NOT in instance storage
//!
//! The whole instance map is a SINGLE ledger entry. A `SpentOnDay(day)` key that is
//! written once per UTC day and never removed would grow that one entry without bound
//! until it exceeds the entry size limit, at which point EVERY entrypoint bricks,
//! because every entrypoint reads instance storage. Including `withdraw`. A vault
//! holding a stranger's USDC would become permanently unspendable, on a timer. This is
//! the sharpest form of the instance-storage-exhaustion finding class that shows up in
//! published Soroban audits, and it is ruled out here by construction, not by review.
//!
//! The same reasoning applies to `Allowed(payee)`, which is per-payee and unbounded in
//! count, so it is persistent rather than instance.
//!
//! ## Why the day bucket is temporary rather than persistent
//!
//! A persistent entry that archives must be restored before it can be read. If
//! `SpentOnDay(today)` archived mid-day, the next `pay()` would abort with an opaque
//! host archival error instead of a typed policy error, and "the revert reason is
//! exactly why the human-in-the-loop path should take over" is the product. With
//! temporary storage, expired means gone, and a missing bucket correctly reads as zero.
//! Persistent would also accrue rent forever for a number nobody will read again.
//!
//! The audit trail does not live in this storage. It lives in the `Paid` event, which is
//! permanent, indexable, and carries the counterparty and the timestamp, which a running
//! total does not.
//!
//! ## The TTL numbers
//!
//! Read live from pubnet on 2026-08-15 under protocol 27, not copied from a doc:
//! `max_entry_ttl` 3,110,400 ledgers, `min_persistent_ttl` 2,073,600,
//! `min_temporary_ttl` 17,280. Measured close time was about 5 to 6 seconds, so one day
//! is roughly 15,000 to 17,300 ledgers.
//!
//! Note what that means for the day bucket: the network's own minimum temporary TTL is
//! about one day, so a bucket created early in a UTC day survives to the end of it only
//! just. "Only just" is the thing a review flags, and if it ever failed the cap would
//! silently reset mid-day and the agent could spend twice its limit. So every write
//! extends to a two-day floor. TTL can only ever be extended, never shortened, and
//! extension is permissionless, so a floor is genuinely enforceable.

use soroban_sdk::{contracttype, Address, Env};

// One UTC day, in ledgers, taking the conservative (faster close, therefore more
// ledgers) end of the measured range. Being wrong in this direction over-reserves TTL,
// which costs a little rent. Being wrong in the other direction resets a spend cap.
pub const LEDGERS_PER_DAY: u32 = 17_280;

/// The day bucket must outlive the remainder of its own UTC day with room to spare.
pub const DAY_BUCKET_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY;
pub const DAY_BUCKET_TTL_EXTEND: u32 = 2 * LEDGERS_PER_DAY;

/// Config and allowlist entries are long-lived. Both stay comfortably under the live
/// `max_entry_ttl` of 3,110,400 so that a future reduction of that network setting
/// cannot turn a routine bump into a failing call.
pub const LONG_TTL_THRESHOLD: u32 = 60 * LEDGERS_PER_DAY;
pub const LONG_TTL_EXTEND: u32 = 150 * LEDGERS_PER_DAY;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    // ── instance: small, global, read on nearly every invocation ──────────────────
    Owner,
    Operator,
    Token,
    /// Read once from the token at construction and stored, so the hot path makes no
    /// cross-contract call for it and nothing assumes Stellar USDC's 7 decimals.
    Decimals,
    DailyCap,
    AutoApproveMax,
    Frozen,
    AllowlistEnabled,
    SessionKeyExpiry,

    // ── persistent: per-payee, unbounded in count ─────────────────────────────────
    Allowed(Address),

    // ── temporary: one per UTC day, expired means gone ────────────────────────────
    SpentOnDay(u64),
}

/// Bump the instance entry. Called at the top of every entrypoint that writes, so a
/// vault that is used at all never drifts toward archival.
pub fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(LONG_TTL_THRESHOLD, LONG_TTL_EXTEND);
}

// ── instance accessors ────────────────────────────────────────────────────────────

pub fn get_owner(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Owner).unwrap()
}

pub fn set_owner(env: &Env, v: &Address) {
    env.storage().instance().set(&DataKey::Owner, v);
}

pub fn get_operator(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Operator).unwrap()
}

pub fn set_operator(env: &Env, v: &Address) {
    env.storage().instance().set(&DataKey::Operator, v);
}

pub fn get_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Token).unwrap()
}

pub fn set_token(env: &Env, v: &Address) {
    env.storage().instance().set(&DataKey::Token, v);
}

pub fn get_decimals(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Decimals).unwrap()
}

pub fn set_decimals(env: &Env, v: u32) {
    env.storage().instance().set(&DataKey::Decimals, &v);
}

pub fn get_daily_cap(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::DailyCap)
        .unwrap_or(0)
}

pub fn set_daily_cap(env: &Env, v: i128) {
    env.storage().instance().set(&DataKey::DailyCap, &v);
}

pub fn get_auto_approve_max(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::AutoApproveMax)
        .unwrap_or(0)
}

pub fn set_auto_approve_max(env: &Env, v: i128) {
    env.storage().instance().set(&DataKey::AutoApproveMax, &v);
}

pub fn get_frozen(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Frozen)
        .unwrap_or(false)
}

pub fn set_frozen(env: &Env, v: bool) {
    env.storage().instance().set(&DataKey::Frozen, &v);
}

pub fn get_allowlist_enabled(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::AllowlistEnabled)
        .unwrap_or(false)
}

pub fn set_allowlist_enabled(env: &Env, v: bool) {
    env.storage().instance().set(&DataKey::AllowlistEnabled, &v);
}

/// 0 means no time bound, matching the Solidity original. The owner revokes by setting
/// this to now or to any past time, and extends by setting it further out.
pub fn get_session_key_expiry(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::SessionKeyExpiry)
        .unwrap_or(0)
}

pub fn set_session_key_expiry(env: &Env, v: u64) {
    env.storage().instance().set(&DataKey::SessionKeyExpiry, &v);
}

// ── persistent: the allowlist ─────────────────────────────────────────────────────

pub fn is_allowed(env: &Env, payee: &Address) -> bool {
    let key = DataKey::Allowed(payee.clone());
    let ok: bool = env.storage().persistent().get(&key).unwrap_or(false);
    if ok {
        env.storage()
            .persistent()
            .extend_ttl(&key, LONG_TTL_THRESHOLD, LONG_TTL_EXTEND);
    }
    ok
}

pub fn set_allowed(env: &Env, payee: &Address, ok: bool) {
    let key = DataKey::Allowed(payee.clone());
    if ok {
        env.storage().persistent().set(&key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&key, LONG_TTL_THRESHOLD, LONG_TTL_EXTEND);
    } else {
        // Remove rather than store `false`. A removed entry stops accruing rent, and
        // "absent" and "explicitly disallowed" mean the same thing to every reader.
        env.storage().persistent().remove(&key);
    }
}

// ── temporary: the per-UTC-day accumulator ────────────────────────────────────────

/// The current UTC day index. There is no wall clock in a contract; this is the ledger
/// timestamp, which is Unix epoch seconds, bucketed the same way the Solidity original
/// buckets `block.timestamp`.
pub fn today(env: &Env) -> u64 {
    env.ledger().timestamp() / 86_400
}

/// A missing bucket reads as zero, which is the correct answer for a day with no spend
/// and also for a day whose bucket has expired.
pub fn get_spent_on_day(env: &Env, day: u64) -> i128 {
    env.storage()
        .temporary()
        .get(&DataKey::SpentOnDay(day))
        .unwrap_or(0)
}

/// Writes the running total AND extends past the end of the day in the same call, so
/// the cap cannot silently reset while the day is still running.
pub fn set_spent_on_day(env: &Env, day: u64, v: i128) {
    let key = DataKey::SpentOnDay(day);
    env.storage().temporary().set(&key, &v);
    env.storage()
        .temporary()
        .extend_ttl(&key, DAY_BUCKET_TTL_THRESHOLD, DAY_BUCKET_TTL_EXTEND);
}

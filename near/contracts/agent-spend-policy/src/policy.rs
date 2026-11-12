//! The gate ladders, as pure functions.
//!
//! Nothing in this file touches `env`, reads storage, or writes anything. It takes a snapshot of
//! the policy and answers whether a payment is allowed and what the new day total would be. That
//! is what makes the ladder cheap to test exhaustively: the interesting logic has no I/O to mock,
//! and the contract in `lib.rs` is left with assembling the snapshot and acting on the answer.
//!
//! The order of the gates is deliberate and matches the Solidity original
//! (`mcp/contracts/AgentSpendPolicy.sol`) and the Soroban port. Order is observable behaviour,
//! not an implementation detail: an agent that gets `Frozen` back when it expected
//! `DailyCapExceeded` will route to the wrong recovery path. What matches is the order of the
//! SHARED gates, and the meaning of a zero (a 0 cap, a 0 ceiling and a 0 expiry all mean "no
//! bound"), because the console and the spend-preflight API already assume both.
//!
//! Where this ladder departs from the siblings, and why:
//!
//! * `MemoTooLong` sits after `InvalidPayee` and before the state gates. The siblings have no
//!   memo, so no shared ordering is disturbed; grouping it with the other argument checks means a
//!   malformed request is named as malformed before the vault's state is consulted at all.
//! * There is no balance gate. A NEAR contract cannot read its own token balance synchronously
//!   (the token is another contract, reachable only by an asynchronous call), so an underfunded
//!   vault is caught where the money moves: `ft_transfer` fails, and the transfer callback
//!   releases the reservation and reports `TransferFailed`. Soroban's `InsufficientBalance` has
//!   no equivalent here, and that is stated rather than papered over.
//! * `request_payment` runs only the argument gates, the freeze and the key expiry, then the
//!   held-payment limit. It asks a human, so the allowlist, the ceiling and the cap are exactly
//!   the things it exists to go around, and it reserves nothing.
//! * `record_refusal` runs the same first gates as `request_payment`. It moves nothing, but it
//!   writes a per-payee counter (`guard_refusal_count`) that the owner and the console read, so
//!   a frozen vault or an expired key must not be able to write it either. Its last rung is the
//!   counter's own bound (`check_guard_capacity`), in the place the held limit has for a
//!   request: a payee name does not have to be an existing account, so without a bound a key
//!   could lock the vault's NEAR in counters for names it makes up.

use near_sdk::AccountId;

use crate::error::Error;

/// Longest memo, in bytes, an agent may attach to a payment.
pub const MAX_MEMO_BYTES: usize = 128;
/// Longest reason, in bytes, an agent may give for a request or a recorded refusal.
pub const MAX_REASON_BYTES: usize = 128;
/// Longest label, in bytes, the owner may give an agent key.
pub const MAX_LABEL_BYTES: usize = 64;
/// Most payments that may wait for the owner at once.
pub const MAX_PENDING_HELD: u32 = 20;

const NANOS_PER_SECOND: u64 = 1_000_000_000;
const SECONDS_PER_DAY: u64 = 86_400;

/// Everything the ladder is allowed to look at. Assembled by the caller from storage and `env`.
pub struct Snapshot<'a> {
    /// The vault's own account. Paying it moves nothing and still consumes the day's budget.
    pub vault_id: &'a AccountId,
    /// The settlement token. Paying the token contract is a loss, not a payment.
    pub token_id: &'a AccountId,
    pub frozen: bool,
    /// The calling key's expiry in Unix seconds. 0 means no time bound, as in Solidity.
    pub key_expires_at_s: u64,
    /// Block time in Unix seconds.
    pub now_s: u64,
    pub allowlist_enabled: bool,
    pub payee_allowed: bool,
    /// 0 means no ceiling.
    pub auto_approve_max: u128,
    /// 0 means no cap.
    pub daily_cap: u128,
    /// What has been spent on the CURRENT UTC day. The caller passes 0 when the stored
    /// accumulator belongs to an earlier day; see `spent_on`.
    pub spent_today: u128,
    /// Payments currently waiting for the owner, after any pruning the caller did.
    pub held_count: u32,
}

/// The agent's `pay` ladder, in Solidity order. Returns the new day total on success, so the
/// caller never recomputes it and the checked arithmetic happens exactly once.
pub fn check_agent_pay(
    s: &Snapshot,
    payee: &AccountId,
    amount: u128,
    memo: Option<&str>,
) -> Result<u128, Error> {
    check_amount(amount)?;
    check_payee(s, payee)?;
    check_text(memo, MAX_MEMO_BYTES)?;
    check_live_session(s)?;

    if s.allowlist_enabled && !s.payee_allowed {
        return Err(Error::PayeeNotAllowed);
    }

    if s.auto_approve_max != 0 && amount > s.auto_approve_max {
        return Err(Error::AboveAutoApprove);
    }

    let next = accumulate(s.spent_today, amount)?;
    if s.daily_cap != 0 && next > s.daily_cap {
        return Err(Error::DailyCapExceeded);
    }
    Ok(next)
}

/// The agent's `request_payment` ladder: the argument gates, the freeze, the key expiry, then
/// the held-payment limit. Reserves nothing, so it returns nothing.
///
/// The limit is the LAST rung on purpose. The caller prunes expired held payments only when this
/// answers `HeldLimitReached`, which means every earlier gate already passed, so a malformed
/// request never triggers the pruning walk.
pub fn check_agent_request(
    s: &Snapshot,
    payee: &AccountId,
    amount: u128,
    memo: Option<&str>,
    reason: &str,
) -> Result<(), Error> {
    check_amount(amount)?;
    check_payee(s, payee)?;
    check_text(memo, MAX_MEMO_BYTES)?;
    check_text(Some(reason), MAX_REASON_BYTES)?;
    check_live_session(s)?;
    check_held_capacity(s.held_count)
}

/// The agent's `record_refusal` ladder: the same first gates as a request. Its capacity rung,
/// `check_guard_capacity`, needs a storage read of the payee's counter, so the caller runs it
/// after this one answers `Ok`, and a malformed or frozen record never pays for that read.
pub fn check_agent_record(
    s: &Snapshot,
    payee: &AccountId,
    amount: u128,
    reason: &str,
) -> Result<(), Error> {
    check_amount(amount)?;
    check_payee(s, payee)?;
    check_text(Some(reason), MAX_REASON_BYTES)?;
    check_live_session(s)
}

/// The owner's ladder for settling a held payment. `owner_pay` is a human act, so it bypasses
/// the freeze, the key expiry, the allowlist, the ceiling and the cap check, but it STILL adds to
/// the day's total, matching Solidity's `ownerPay` exactly, so on-chain accounting stays honest
/// about total outflow.
///
/// Note what it does not bypass: the amount guard, the payee guard and the arithmetic. Those are
/// correctness, not policy, and no role gets to skip correctness. (The registry is not bypassed
/// either, but that check is asynchronous and lives in the contract, not here.)
pub fn check_owner_pay(s: &Snapshot, payee: &AccountId, amount: u128) -> Result<u128, Error> {
    check_amount(amount)?;
    check_payee(s, payee)?;
    accumulate(s.spent_today, amount)
}

/// A zero payment passes every policy gate on EVM, transfers nothing and still emits `Paid`.
/// Refusing it here keeps the event stream free of payments that are not payments.
pub fn check_amount(amount: u128) -> Result<(), Error> {
    if amount == 0 {
        return Err(Error::InvalidAmount);
    }
    Ok(())
}

/// Paying the vault itself, or the token contract, moves nothing useful but still consumes the
/// day's budget. Left open, a compromised agent key could burn the whole cap at zero cost every
/// day and deny the legitimate agent indefinitely (finding G-1 on the siblings).
pub fn check_payee(s: &Snapshot, payee: &AccountId) -> Result<(), Error> {
    if payee == s.vault_id || payee == s.token_id {
        return Err(Error::InvalidPayee);
    }
    Ok(())
}

/// Free text is bounded because the vault pays for it: in storage when a payment is held, and in
/// the log every event writes. Measured in bytes, the unit NEAR charges in.
pub fn check_text(text: Option<&str>, max_bytes: usize) -> Result<(), Error> {
    match text {
        Some(t) if t.len() > max_bytes => Err(Error::MemoTooLong),
        _ => Ok(()),
    }
}

/// The two gates every agent write shares: the owner's panic button, then the key's clock.
///
/// The expiry is a stored deadline compared against block time, strictly greater-than, matching
/// Solidity: a payment at exactly the expiry second still goes through, and the key is valid
/// through that second inclusive.
pub fn check_live_session(s: &Snapshot) -> Result<(), Error> {
    if s.frozen {
        return Err(Error::Frozen);
    }
    if is_expired(s.key_expires_at_s, s.now_s) {
        return Err(Error::SessionKeyExpired);
    }
    Ok(())
}

/// The held-payment map is bounded because the vault pays its storage and the owner reviews it by
/// hand. An unbounded queue would let a misbehaving agent turn the review page into noise and
/// lock the vault's NEAR in storage.
pub fn check_held_capacity(held_count: u32) -> Result<(), Error> {
    if held_count >= MAX_PENDING_HELD {
        return Err(Error::HeldLimitReached);
    }
    Ok(())
}

/// The last rung of `record_refusal`. A payee that already has a guard counter only increments
/// it, which adds no storage, so it always passes. A payee without one gets a new counter only
/// while fewer than `max` payees have one.
pub fn check_guard_capacity(has_counter: bool, guard_payees: u32, max: u32) -> Result<(), Error> {
    if !has_counter && guard_payees >= max {
        return Err(Error::GuardRefusalLimitReached);
    }
    Ok(())
}

/// `0` means no bound. Otherwise valid through `expires_at_s` inclusive.
pub fn is_expired(expires_at_s: u64, now_s: u64) -> bool {
    expires_at_s != 0 && now_s > expires_at_s
}

/// Explicit `checked_add` rather than a bare `+`. The release profile sets `overflow-checks`, so
/// `+` would abort, but an abort is an untyped failure the client cannot name, and a profile
/// setting is something a future edit can quietly lose.
fn accumulate(spent: u128, amount: u128) -> Result<u128, Error> {
    spent.checked_add(amount).ok_or(Error::MathOverflow)
}

/// Block time in whole Unix seconds.
pub fn seconds(timestamp_ns: u64) -> u64 {
    timestamp_ns / NANOS_PER_SECOND
}

/// The UTC day index, `timestamp / 1e9 / 86400`, the same day boundary as Solidity's
/// `block.timestamp / 86400`.
pub fn day_index(timestamp_ns: u64) -> u64 {
    seconds(timestamp_ns) / SECONDS_PER_DAY
}

/// What has been spent on `today`, given the stored accumulator and the day it belongs to. The
/// accumulator is a single number that is reset lazily: a stored total from an earlier day is
/// simply not today's total.
pub fn spent_on(stored_day: u64, stored_spent: u128, today: u64) -> u128 {
    if stored_day == today { stored_spent } else { 0 }
}

/// Give back a reservation made on `reserved_day`, if and only if the accumulator still belongs
/// to that day and that day is still today. A reservation from yesterday must not be subtracted
/// from today's spend: that would hand the agent budget it never consumed today. Saturating,
/// because a callback must never abort, and a release can only ever shrink the number.
pub fn release(
    stored_day: u64,
    stored_spent: u128,
    reserved_day: u64,
    today: u64,
    amount: u128,
) -> u128 {
    if stored_day == reserved_day && reserved_day == today {
        stored_spent.saturating_sub(amount)
    } else {
        stored_spent
    }
}

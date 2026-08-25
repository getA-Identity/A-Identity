//! The gate ladder, as pure functions.
//!
//! Nothing in this file touches `Env`, reads storage, or writes anything. It takes a
//! snapshot of the policy and answers whether a payment is allowed and what the new
//! day total would be. That is what makes the ladder cheap to fuzz and property-test:
//! the interesting logic has no I/O to mock.
//!
//! The order of the gates is deliberate and matches the Solidity original
//! (`mcp/contracts/AgentSpendPolicy.sol`). Order is observable behaviour, not an
//! implementation detail: an agent that gets `Frozen` back when it expected
//! `DailyCapExceeded` will route to the wrong recovery path.
//!
//! What matches is the order of the SHARED gates. This comment used to say "the same
//! rejected payment produces the same reason on both chains", which is false for at least
//! four input classes (finding A5-05d): `amount == 0` is accepted on EVM and refused here,
//! a negative amount is unrepresentable there, `to == vault` is accepted there and burns
//! the cap (open item G-1), and an underfunded vault answers `TransferFailed` from the
//! ERC-20 bool there against `InsufficientBalance` one gate earlier here.
//!
//! Four gates here have no Solidity counterpart. See `error.rs` for each.

use crate::error::Error;

/// Everything the ladder is allowed to look at. Assembled by the caller from storage.
pub struct Snapshot {
    pub frozen: bool,
    /// 0 means no time bound, matching the Solidity original.
    pub session_key_expiry: u64,
    /// The ledger timestamp, in Unix epoch seconds.
    pub now: u64,
    pub allowlist_enabled: bool,
    pub payee_allowed: bool,
    /// 0 means no ceiling.
    pub auto_approve_max: i128,
    /// 0 means no cap.
    pub daily_cap: i128,
    pub spent_today: i128,
    pub vault_balance: i128,
}

/// Reject an amount that is zero or negative.
///
/// A correction, because the original justification for this guard was wrong and an
/// adversarial review caught it. It said an unguarded negative amount would decrement the
/// day accumulator and hand the agent its cap back. It would not: the Stellar Asset
/// Contract validates the sign itself (`check_nonnegative_amount`, called by `transfer`),
/// the resulting panic aborts the whole invocation, and Soroban rolls back every state
/// change including the accumulator write. There was never a persistent bypass.
///
/// The guard is still right, for two reasons that are actually true:
///
/// 1. Without it the refusal comes from the TOKEN as an untyped host trap, and the client
///    cannot name it. With it, the refusal is `InvalidAmount`, which the human-in-the-loop
///    path can act on. That is the product claim, not a nicety.
/// 2. It does not depend on the token being well behaved. The SAC checks the sign; a
///    SEP-41 token that did not would make the bypass real, and a vault whose safety rests
///    on a property of whatever token it was pointed at is not a vault.
///
/// The class is genuinely new against the Solidity original, where `uint256` made a
/// negative amount unrepresentable. Only the mechanism was misdescribed.
pub fn check_amount(amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    Ok(())
}

/// The operator's ladder, in Solidity order. Returns the new day total on success, so the
/// caller never recomputes it and the checked arithmetic happens exactly once.
pub fn check_operator_pay(s: &Snapshot, amount: i128) -> Result<i128, Error> {
    check_amount(amount)?;

    if s.frozen {
        return Err(Error::Frozen);
    }

    // A stored deadline compared against the ledger clock, never storage expiry. Anyone
    // can extend any entry's TTL, so "the entry expired, therefore the permission ended"
    // is broken by design. Strictly greater-than, matching Solidity: a payment at exactly
    // the expiry second still goes through.
    if s.session_key_expiry != 0 && s.now > s.session_key_expiry {
        return Err(Error::SessionKeyExpired);
    }

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

    check_balance(s.vault_balance, amount)?;
    Ok(next)
}

/// The owner's ladder. `owner_pay` is a human act, so it bypasses the ceiling, the
/// allowlist and the freeze, but it STILL counts toward the daily cap, matching Solidity
/// exactly, so on-chain accounting stays honest about total outflow.
///
/// Note what it does not bypass: the amount guard, the arithmetic, and the balance. Those
/// are correctness, not policy, and no role gets to skip correctness.
pub fn check_owner_pay(s: &Snapshot, amount: i128) -> Result<i128, Error> {
    check_amount(amount)?;
    let next = accumulate(s.spent_today, amount)?;
    check_balance(s.vault_balance, amount)?;
    Ok(next)
}

/// Explicit `checked_add` rather than a bare `+`. The release profile sets
/// `overflow-checks`, so `+` would panic, but a panic is an untyped abort the client
/// cannot name, and a profile setting is something a future edit can quietly lose.
fn accumulate(spent: i128, amount: i128) -> Result<i128, Error> {
    spent.checked_add(amount).ok_or(Error::MathOverflow)
}

/// Catch an underfunded vault here, by name, rather than letting the token contract
/// panic anonymously. The SAC has no bool return to check the way the Solidity original
/// checked ERC-20's, so this is where the equivalent guarantee has to live.
fn check_balance(balance: i128, amount: i128) -> Result<(), Error> {
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }
    Ok(())
}

//! The pure ladders in `policy.rs`: each gate on its own, zero meaning "no bound", overflow, and
//! the ORDER between gates, swept exhaustively over every combination of failing conditions.

use near_sdk::AccountId;

use super::{other_shop, shop, token, vault};
use crate::Error;
use crate::policy::{self, MAX_MEMO_BYTES, MAX_PENDING_HELD, MAX_REASON_BYTES, Snapshot};

const NOW: u64 = 1_000_000;

/// A snapshot every gate passes: not frozen, no expiry, allowlist off, no ceiling, no cap.
fn open<'a>(vault_id: &'a AccountId, token_id: &'a AccountId) -> Snapshot<'a> {
    Snapshot {
        vault_id,
        token_id,
        frozen: false,
        key_expires_at_s: 0,
        now_s: NOW,
        allowlist_enabled: false,
        payee_allowed: false,
        auto_approve_max: 0,
        daily_cap: 0,
        spent_today: 0,
        held_count: 0,
    }
}

// -- pay: each gate ---------------------------------------------------------------------------

#[test]
fn pay_open_policy_returns_the_new_day_total() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.spent_today = 40;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 2, None), Ok(42));
}

#[test]
fn pay_zero_amount_is_invalid() {
    let (v, t) = (vault(), token());
    let s = open(&v, &t);
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 0, None),
        Err(Error::InvalidAmount)
    );
    assert_eq!(policy::check_agent_pay(&s, &shop(), 1, None), Ok(1));
}

#[test]
fn pay_to_the_vault_or_the_token_is_invalid() {
    let (v, t) = (vault(), token());
    let s = open(&v, &t);
    assert_eq!(
        policy::check_agent_pay(&s, &vault(), 1, None),
        Err(Error::InvalidPayee)
    );
    assert_eq!(
        policy::check_agent_pay(&s, &token(), 1, None),
        Err(Error::InvalidPayee)
    );
    assert_eq!(policy::check_agent_pay(&s, &other_shop(), 1, None), Ok(1));
}

#[test]
fn pay_memo_is_bounded_in_bytes() {
    let (v, t) = (vault(), token());
    let s = open(&v, &t);
    let at_limit = "m".repeat(MAX_MEMO_BYTES);
    let over = "m".repeat(MAX_MEMO_BYTES + 1);
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, Some(&at_limit)),
        Ok(1)
    );
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, Some(&over)),
        Err(Error::MemoTooLong)
    );
    // Bytes, not characters: 43 three-byte characters are 129 bytes.
    let wide = "\u{20ac}".repeat(43);
    assert_eq!(wide.len(), 129);
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, Some(&wide)),
        Err(Error::MemoTooLong)
    );
}

#[test]
fn pay_frozen_is_refused() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.frozen = true;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, None),
        Err(Error::Frozen)
    );
}

#[test]
fn pay_key_expiry_is_inclusive_and_zero_means_never() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.key_expires_at_s = NOW;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, None),
        Ok(1),
        "valid through the expiry second"
    );
    s.key_expires_at_s = NOW - 1;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, None),
        Err(Error::SessionKeyExpired)
    );
    s.key_expires_at_s = 0;
    s.now_s = u64::MAX;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 1, None), Ok(1));
}

#[test]
fn pay_allowlist_only_applies_when_enabled() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.allowlist_enabled = true;
    s.payee_allowed = false;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, None),
        Err(Error::PayeeNotAllowed)
    );
    s.payee_allowed = true;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 1, None), Ok(1));
    s.allowlist_enabled = false;
    s.payee_allowed = false;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 1, None), Ok(1));
}

#[test]
fn pay_ceiling_is_inclusive_and_zero_means_none() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.auto_approve_max = 100;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 100, None), Ok(100));
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 101, None),
        Err(Error::AboveAutoApprove)
    );
    s.auto_approve_max = 0;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), u128::MAX, None),
        Ok(u128::MAX)
    );
}

#[test]
fn pay_cap_is_inclusive_and_zero_means_none() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.daily_cap = 1_000;
    s.spent_today = 900;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 100, None), Ok(1_000));
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 101, None),
        Err(Error::DailyCapExceeded)
    );
    s.daily_cap = 0;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), u128::MAX - 900, None),
        Ok(u128::MAX)
    );
}

#[test]
fn pay_accumulator_overflow_is_a_named_refusal_not_a_wrap() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.spent_today = u128::MAX;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, None),
        Err(Error::MathOverflow)
    );
    s.spent_today = u128::MAX - 1;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 1, None), Ok(u128::MAX));
    // Overflow is reported even with no cap: it is correctness, not policy.
    s.spent_today = u128::MAX;
    s.daily_cap = 0;
    assert_eq!(
        policy::check_agent_pay(&s, &shop(), 1, None),
        Err(Error::MathOverflow)
    );
}

#[test]
fn pay_ignores_the_held_limit() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.held_count = MAX_PENDING_HELD;
    assert_eq!(policy::check_agent_pay(&s, &shop(), 1, None), Ok(1));
}

// -- pay: the order between gates ---------------------------------------------------------------

/// The pay ladder's gates, in the order they must fire.
const PAY_ORDER: [Error; 9] = [
    Error::InvalidAmount,
    Error::InvalidPayee,
    Error::MemoTooLong,
    Error::Frozen,
    Error::SessionKeyExpired,
    Error::PayeeNotAllowed,
    Error::AboveAutoApprove,
    Error::MathOverflow,
    Error::DailyCapExceeded,
];

/// Every one of the 512 combinations of failing pay conditions answers with the FIRST failing
/// gate in `PAY_ORDER`, and the all-pass combination answers with the day total.
#[test]
fn pay_gate_order_holds_for_every_combination() {
    let (v, t) = (vault(), token());
    let long_memo = "m".repeat(MAX_MEMO_BYTES + 1);
    for mask in 0u32..(1 << PAY_ORDER.len()) {
        let fails = |i: usize| mask & (1 << i) != 0;
        let mut s = open(&v, &t);
        let amount: u128 = if fails(0) { 0 } else { 10 };
        let payee = if fails(1) { vault() } else { shop() };
        let memo = if fails(2) {
            Some(long_memo.as_str())
        } else {
            Some("ok")
        };
        s.frozen = fails(3);
        s.key_expires_at_s = if fails(4) { NOW - 1 } else { 0 };
        s.allowlist_enabled = fails(5);
        s.payee_allowed = false;
        s.auto_approve_max = if fails(6) { 5 } else { 0 };
        s.spent_today = if fails(7) { u128::MAX } else { 0 };
        s.daily_cap = if fails(8) { 9 } else { 0 };

        let expected = (0..PAY_ORDER.len())
            .find(|&i| fails(i))
            .map(|i| PAY_ORDER[i]);
        let got = policy::check_agent_pay(&s, &payee, amount, memo);
        match expected {
            Some(err) => assert_eq!(got, Err(err), "mask {mask:09b}"),
            None => assert_eq!(got, Ok(10), "mask {mask:09b}"),
        }
    }
}

// -- request_payment ----------------------------------------------------------------------------

#[test]
fn request_ignores_allowlist_ceiling_cap_and_overflow() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.allowlist_enabled = true;
    s.payee_allowed = false;
    s.auto_approve_max = 1;
    s.daily_cap = 1;
    s.spent_today = u128::MAX;
    assert_eq!(
        policy::check_agent_request(&s, &shop(), 1_000_000, None, "above ceiling"),
        Ok(())
    );
}

#[test]
fn request_reason_is_bounded_in_bytes() {
    let (v, t) = (vault(), token());
    let s = open(&v, &t);
    let at_limit = "r".repeat(MAX_REASON_BYTES);
    let over = "r".repeat(MAX_REASON_BYTES + 1);
    assert_eq!(
        policy::check_agent_request(&s, &shop(), 1, None, &at_limit),
        Ok(())
    );
    assert_eq!(
        policy::check_agent_request(&s, &shop(), 1, None, &over),
        Err(Error::MemoTooLong)
    );
}

#[test]
fn request_held_limit_is_exact() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.held_count = MAX_PENDING_HELD - 1;
    assert_eq!(
        policy::check_agent_request(&s, &shop(), 1, None, "r"),
        Ok(())
    );
    s.held_count = MAX_PENDING_HELD;
    assert_eq!(
        policy::check_agent_request(&s, &shop(), 1, None, "r"),
        Err(Error::HeldLimitReached)
    );
}

const REQUEST_ORDER: [Error; 7] = [
    Error::InvalidAmount,
    Error::InvalidPayee,
    Error::MemoTooLong, // memo
    Error::MemoTooLong, // reason
    Error::Frozen,
    Error::SessionKeyExpired,
    Error::HeldLimitReached,
];

#[test]
fn request_gate_order_holds_for_every_combination() {
    let (v, t) = (vault(), token());
    let long = "m".repeat(MAX_MEMO_BYTES + 1);
    for mask in 0u32..(1 << REQUEST_ORDER.len()) {
        let fails = |i: usize| mask & (1 << i) != 0;
        let mut s = open(&v, &t);
        let amount: u128 = if fails(0) { 0 } else { 10 };
        let payee = if fails(1) { token() } else { shop() };
        let memo = if fails(2) { Some(long.as_str()) } else { None };
        let reason = if fails(3) { long.as_str() } else { "why" };
        s.frozen = fails(4);
        s.key_expires_at_s = if fails(5) { NOW - 1 } else { 0 };
        s.held_count = if fails(6) { MAX_PENDING_HELD } else { 0 };

        let expected = (0..REQUEST_ORDER.len())
            .find(|&i| fails(i))
            .map(|i| REQUEST_ORDER[i]);
        let got = policy::check_agent_request(&s, &payee, amount, memo, reason);
        assert_eq!(got, expected.map_or(Ok(()), Err), "mask {mask:07b}");
    }
}

// -- record_refusal -----------------------------------------------------------------------------

const RECORD_ORDER: [Error; 5] = [
    Error::InvalidAmount,
    Error::InvalidPayee,
    Error::MemoTooLong,
    Error::Frozen,
    Error::SessionKeyExpired,
];

#[test]
fn record_gate_order_holds_for_every_combination() {
    let (v, t) = (vault(), token());
    let long = "r".repeat(MAX_REASON_BYTES + 1);
    for mask in 0u32..(1 << RECORD_ORDER.len()) {
        let fails = |i: usize| mask & (1 << i) != 0;
        let mut s = open(&v, &t);
        let amount: u128 = if fails(0) { 0 } else { 10 };
        let payee = if fails(1) { vault() } else { shop() };
        let reason = if fails(2) {
            long.as_str()
        } else {
            "guard_deny"
        };
        s.frozen = fails(3);
        s.key_expires_at_s = if fails(4) { NOW - 1 } else { 0 };

        let expected = (0..RECORD_ORDER.len())
            .find(|&i| fails(i))
            .map(|i| RECORD_ORDER[i]);
        let got = policy::check_agent_record(&s, &payee, amount, reason);
        assert_eq!(got, expected.map_or(Ok(()), Err), "mask {mask:05b}");
    }
}

#[test]
fn record_ignores_allowlist_ceiling_cap_and_held_limit() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.allowlist_enabled = true;
    s.auto_approve_max = 1;
    s.daily_cap = 1;
    s.spent_today = u128::MAX;
    s.held_count = MAX_PENDING_HELD;
    assert_eq!(
        policy::check_agent_record(&s, &shop(), 1_000, "guard"),
        Ok(())
    );
}

// -- owner_pay ----------------------------------------------------------------------------------

#[test]
fn owner_pay_bypasses_policy_but_still_counts() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.frozen = true;
    s.key_expires_at_s = 1;
    s.allowlist_enabled = true;
    s.payee_allowed = false;
    s.auto_approve_max = 1;
    s.daily_cap = 10;
    s.spent_today = 10;
    s.held_count = MAX_PENDING_HELD;
    // Above the ceiling, over the cap, frozen, expired, not allowlisted: still settles, and the
    // day total goes past the cap, which is the honest record of outflow.
    assert_eq!(policy::check_owner_pay(&s, &shop(), 500), Ok(510));
}

#[test]
fn owner_pay_keeps_the_correctness_gates_in_order() {
    let (v, t) = (vault(), token());
    let mut s = open(&v, &t);
    s.spent_today = u128::MAX;
    assert_eq!(
        policy::check_owner_pay(&s, &vault(), 0),
        Err(Error::InvalidAmount)
    );
    assert_eq!(
        policy::check_owner_pay(&s, &vault(), 1),
        Err(Error::InvalidPayee)
    );
    assert_eq!(
        policy::check_owner_pay(&s, &token(), 1),
        Err(Error::InvalidPayee)
    );
    assert_eq!(
        policy::check_owner_pay(&s, &shop(), 1),
        Err(Error::MathOverflow)
    );
    s.spent_today = 0;
    assert_eq!(policy::check_owner_pay(&s, &shop(), 1), Ok(1));
}

// -- the day and the clock ----------------------------------------------------------------------

#[test]
fn day_index_rolls_at_utc_midnight() {
    let day_ns = 86_400u64 * 1_000_000_000;
    assert_eq!(policy::day_index(0), 0);
    assert_eq!(policy::day_index(day_ns - 1), 0);
    assert_eq!(policy::day_index(day_ns), 1);
    assert_eq!(
        policy::day_index(super::T0_S * 1_000_000_000),
        super::T0_DAY
    );
    assert_eq!(policy::seconds(1_999_999_999), 1);
}

#[test]
fn spent_on_only_counts_the_stored_day() {
    assert_eq!(policy::spent_on(7, 500, 7), 500);
    assert_eq!(policy::spent_on(6, 500, 7), 0);
}

#[test]
fn release_only_gives_back_a_reservation_from_today() {
    // Same day: given back.
    assert_eq!(policy::release(7, 500, 7, 7, 200), 300);
    // Saturating: a release can only shrink the number, never wrap.
    assert_eq!(policy::release(7, 100, 7, 7, 200), 0);
    // Reserved yesterday, and today's accumulator already belongs to today: untouched.
    assert_eq!(policy::release(8, 50, 7, 8, 200), 50);
    // Reserved yesterday and nothing spent today yet: the stored total is yesterday's and is
    // already ignored by `spent_on`, so it is left alone too.
    assert_eq!(policy::release(7, 500, 7, 8, 200), 500);
}

#[test]
fn is_expired_is_strict_and_zero_means_never() {
    assert!(!policy::is_expired(0, u64::MAX));
    assert!(!policy::is_expired(10, 10));
    assert!(policy::is_expired(10, 11));
}

#[test]
fn text_limits_are_the_spec_values() {
    assert_eq!(MAX_MEMO_BYTES, 128);
    assert_eq!(MAX_REASON_BYTES, 128);
    assert_eq!(crate::MAX_LABEL_BYTES, 64);
    assert_eq!(MAX_PENDING_HELD, 20);
    assert_eq!(crate::MAX_AGENT_KEYS, 5);
    assert_eq!(crate::MAX_ALLOWLIST, 100);
    assert_eq!(crate::HELD_TTL_S, 86_400);
}

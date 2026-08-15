//! Day bucketing and the session key.
//!
//! A contract has no wall clock. `env.ledger().timestamp()` is Unix epoch seconds, and
//! the day index is that divided by 86400, exactly as the Solidity original divides
//! `block.timestamp`. So the cap resets at 00:00 UTC, not 24 hours after the first spend,
//! and the two are visibly different to anyone watching a vault at 23:59.

use super::{assert_error, setup, UNIT};
use crate::Error;

/// 2026-08-15T12:00:00Z. Mid-day on purpose, so a test that accidentally depends on being
/// near a boundary fails rather than passing by luck.
const NOON: u64 = 1_786_795_200;
const DAY: u64 = 86_400;

#[test]
fn the_day_index_is_the_timestamp_divided_by_86400() {
    let s = setup(0, 0);
    s.set_time(NOON);
    assert_eq!(s.client().today(), NOON / DAY);
}

#[test]
fn the_cap_resets_at_utc_midnight_not_24h_after_the_first_spend() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();

    // Spend the day out at 23:00.
    let almost_midnight = (NOON / DAY) * DAY + 23 * 3_600;
    s.set_time(almost_midnight);
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);

    // One hour later is a new UTC day, not a partial one. A rolling 24-hour window would
    // still be refusing here, and the difference is exactly what the product promises.
    s.set_time(almost_midnight + 3_600);
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(
        s.client().spent_today(),
        10 * UNIT,
        "the new day starts empty"
    );
}

#[test]
fn an_expired_day_bucket_reads_as_zero_rather_than_erroring() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();

    s.set_time(NOON);
    s.client().pay(&s.payee, &(10 * UNIT));

    // Far in the future, well past any bucket's TTL. Temporary storage means "expired is
    // gone", and gone must read as zero. If it read as an error instead, a vault that sat
    // idle would refuse its first payment back with an opaque host abort rather than a
    // typed reason, which is the failure mode temporary storage was chosen to avoid.
    s.set_time(NOON + 400 * DAY);
    assert_eq!(s.client().spent_today(), 0);
    s.client().pay(&s.payee, &(10 * UNIT));
}

#[test]
fn a_session_key_expiry_of_zero_means_no_time_bound() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    assert_eq!(s.client().session_key_expiry(), 0);
    s.set_time(NOON + 10_000 * DAY);
    s.client().pay(&s.payee, &UNIT);
}

#[test]
fn pay_after_the_session_key_expires_returns_session_key_expired() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().set_session_key_expiry(&(NOON + 3_600));
    s.client().pay(&s.payee, &UNIT);

    s.set_time(NOON + 3_601);
    assert_error(
        s.client().try_pay(&s.payee, &UNIT),
        Error::SessionKeyExpired,
    );

    // The owner extends, and the agent is back inside its bounds without redeploying
    // anything. This is the whole point of the session key being a stored deadline rather
    // than a property of storage lifetime.
    s.client().set_session_key_expiry(&(NOON + 7_200));
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.token().balance(&s.payee), 2 * UNIT);
}

#[test]
fn a_payment_at_exactly_the_expiry_second_still_goes_through() {
    // Strictly greater-than, matching the Solidity original. An off-by-one here would
    // refuse a payment the human believed they had authorized, which is a worse failure
    // than allowing one extra second.
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().set_session_key_expiry(&NOON);
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.token().balance(&s.payee), UNIT);
}

#[test]
fn the_owner_revokes_the_session_key_by_setting_it_into_the_past() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().set_session_key_expiry(&(NOON - 1));
    assert_error(
        s.client().try_pay(&s.payee, &UNIT),
        Error::SessionKeyExpired,
    );

    // Revocation stops the agent and never the human: the override exists precisely for
    // the window between a revoked key and a new one.
    s.client().owner_pay(&s.payee, &UNIT);
    assert_eq!(s.token().balance(&s.payee), UNIT);
}

//! The read-only surface, pinned.
//!
//! `cargo mutants` left exactly four survivors after the arithmetic and durability suites
//! landed, and all four were views: `frozen` forced to true and to false,
//! `allowlist_enabled` forced to false, `session_key_expiry` forced to 0. Every one of them
//! kept the suite green.
//!
//! It would be easy to wave those away as harmless, because a view cannot move money: the
//! gate ladder reads storage directly rather than through these functions, so a lying view
//! changes no payment decision. That reasoning is why they survived, and it is wrong for
//! this contract specifically. The product claim is that a human can read the agent's
//! bounds off the ledger and trust what they read. A `frozen()` stuck at `false` tells an
//! operator the kill switch is off while it is on; a `session_key_expiry()` stuck at 0
//! reports "no time bound" for a key that is in fact revoked. The console and the
//! spend-preflight API both render exactly these values.
//!
//! So: every view is asserted to change when the state it reports changes, in both
//! directions where the type has two.

use super::{setup, UNIT};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

#[test]
fn frozen_reports_both_states_and_follows_the_setter() {
    let s = setup(10 * UNIT, 2 * UNIT);
    s.mock_auths();
    assert!(
        !s.client().frozen(),
        "a fresh vault must not report itself frozen"
    );
    s.client().set_frozen(&true);
    assert!(
        s.client().frozen(),
        "frozen() did not follow set_frozen(true)"
    );
    s.client().set_frozen(&false);
    assert!(
        !s.client().frozen(),
        "frozen() did not follow set_frozen(false)"
    );
}

#[test]
fn allowlist_enabled_reports_both_states_and_follows_set_policy() {
    let s = setup(10 * UNIT, 2 * UNIT);
    s.mock_auths();
    assert!(
        !s.client().allowlist_enabled(),
        "the constructor leaves the allowlist off"
    );
    s.client().set_policy(&(10 * UNIT), &(2 * UNIT), &true);
    assert!(
        s.client().allowlist_enabled(),
        "allowlist_enabled() did not follow set_policy(true)"
    );
    s.client().set_policy(&(10 * UNIT), &(2 * UNIT), &false);
    assert!(
        !s.client().allowlist_enabled(),
        "allowlist_enabled() did not follow set_policy(false)"
    );
}

#[test]
fn session_key_expiry_reports_the_stored_deadline_and_zero_means_unbounded() {
    let s = setup(10 * UNIT, 2 * UNIT);
    s.mock_auths();
    assert_eq!(
        s.client().session_key_expiry(),
        0,
        "0 is the constructor's no-bound value"
    );
    s.client().set_session_key_expiry(&1_700_000_000);
    assert_eq!(
        s.client().session_key_expiry(),
        1_700_000_000,
        "session_key_expiry() did not report the deadline that was set"
    );
    // Revoking into the past is a real deadline, not a return to unbounded.
    s.client().set_session_key_expiry(&1);
    assert_eq!(s.client().session_key_expiry(), 1);
    // And 0 genuinely means unbounded again.
    s.client().set_session_key_expiry(&0);
    assert_eq!(s.client().session_key_expiry(), 0);
}

/// The views a human reads before trusting an agent must agree with the state the ladder
/// acts on. Asserted together, because agreeing one at a time is not the claim.
#[test]
fn every_view_agrees_with_the_state_the_ladder_uses() {
    let s = setup(10 * UNIT, 2 * UNIT);
    s.fund_vault(5 * UNIT);
    s.mock_auths();
    let payee: Address = Address::generate(&s.env);

    s.client().set_policy(&(7 * UNIT), &(3 * UNIT), &true);
    s.client().set_allowed(&payee, &true);
    s.client().set_session_key_expiry(&1_900_000_000);
    s.client().set_frozen(&true);

    assert_eq!(s.client().daily_cap(), 7 * UNIT);
    assert_eq!(s.client().auto_approve_max(), 3 * UNIT);
    assert!(s.client().allowlist_enabled());
    assert!(s.client().is_allowed(&payee));
    assert!(!s.client().is_allowed(&s.stranger));
    assert_eq!(s.client().session_key_expiry(), 1_900_000_000);
    assert!(s.client().frozen());
    assert_eq!(s.client().owner(), s.owner);
    assert_eq!(s.client().operator(), s.operator);
    assert_eq!(s.client().token(), s.token_id);
    assert_eq!(s.client().decimals(), 7);
    assert_eq!(s.client().balance(), 5 * UNIT);
    assert_eq!(s.client().spent_today(), 0);

    // And the ladder acts on the same state the views just reported: frozen is true, so
    // the agent path is closed while the human path is not.
    assert!(s.client().try_pay(&payee, &1).is_err());
    s.client().owner_pay(&payee, &UNIT);
    assert_eq!(
        s.client().spent_today(),
        UNIT,
        "owner_pay is charged to the day, as the views imply"
    );
}

//! The error ABI, pinned.
//!
//! A client decodes an integer, not a name. So renumbering a variant silently changes
//! what a deployed contract appears to say: an agent that routed `DailyCapExceeded` to
//! "wait until tomorrow" would start routing it to "ask a human" with no error anywhere.
//! The table below is a second, independent copy of the discriminants on purpose. Two
//! copies that must agree is the point; a test that imported the numbers from the enum
//! would agree with any renumbering.

use super::{assert_error, setup, UNIT};
use crate::Error;

/// `Env::default()` starts the ledger clock at timestamp 0, and the session-key gate is
/// `now > expiry`. So any expiry is in the FUTURE of a fresh test env, and a test that
/// forgets to advance the clock silently exercises a gate that cannot fire. Every test
/// here that touches the expiry sets the clock first.
const NOON: u64 = 1_786_795_200;

#[test]
fn error_discriminants_are_frozen() {
    for (variant, code) in [
        (Error::Frozen, 1u32),
        (Error::SessionKeyExpired, 2),
        (Error::PayeeNotAllowed, 3),
        (Error::AboveAutoApprove, 4),
        (Error::DailyCapExceeded, 5),
        (Error::InvalidAmount, 6),
        (Error::InvalidPayee, 7),
        (Error::MathOverflow, 8),
        (Error::InsufficientBalance, 9),
        (Error::OwnerIsOperator, 10),
    ] {
        assert_eq!(
            variant as u32, code,
            "error codes are public ABI and this list is append-only. To retire a meaning, \
             stop returning the code and leave the variant in place. Never reuse a number.",
        );
    }
}

/// Paying the vault itself, or the token contract, moves nothing while still consuming
/// the day's budget. Left open, a compromised operator could burn the whole cap at zero
/// cost, every day, and deny the legitimate agent indefinitely. No Solidity analogue:
/// there the only address guard was a zero-address check.
#[test]
fn paying_the_vault_or_the_token_returns_invalid_payee() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    assert_error(
        s.client().try_pay(&s.contract_id, &UNIT),
        Error::InvalidPayee,
    );
    assert_error(s.client().try_pay(&s.token_id, &UNIT), Error::InvalidPayee);
    assert_error(
        s.client().try_owner_pay(&s.contract_id, &UNIT),
        Error::InvalidPayee,
    );
    assert_error(
        s.client().try_withdraw(&s.contract_id, &UNIT),
        Error::InvalidPayee,
    );

    assert_eq!(
        s.client().spent_today(),
        0,
        "a refused payee must not burn the day's budget"
    );
}

/// The gates fire in the Solidity order, so the same rejected payment gives the same
/// reason on both chains. Order is observable behaviour: an agent that gets `Frozen` when
/// it expected `DailyCapExceeded` routes to the wrong recovery path.
#[test]
fn the_gate_order_matches_the_solidity_original() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(UNIT);
    s.mock_auths();
    s.set_time(NOON);

    // Every gate is violated at once; the ladder must report the first one.
    s.client().set_policy(&UNIT, &UNIT, &true);
    s.client().set_frozen(&true);
    s.client().set_session_key_expiry(&(NOON - 1));

    // Amount is checked before anything else, even a freeze.
    assert_error(s.client().try_pay(&s.payee, &0), Error::InvalidAmount);
    // Then payee validity, still ahead of the freeze.
    assert_error(
        s.client().try_pay(&s.contract_id, &UNIT),
        Error::InvalidPayee,
    );
    // Then the freeze, ahead of the expiry.
    assert_error(s.client().try_pay(&s.payee, &(99 * UNIT)), Error::Frozen);

    s.client().set_frozen(&false);
    // Then the session key, ahead of the allowlist.
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::SessionKeyExpired,
    );

    s.client().set_session_key_expiry(&0);
    // Then the allowlist, ahead of the ceiling.
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::PayeeNotAllowed,
    );

    s.client().set_allowed(&s.payee, &true);
    // Then the ceiling, ahead of the cap.
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::AboveAutoApprove,
    );
}

/// Every variant is reachable from outside, so none is decoration. `InsufficientBalance`,
/// `MathOverflow` and `OwnerIsOperator` are covered in their own files; this asserts the
/// remaining set can each be produced by a real call.
#[test]
fn every_policy_error_is_reachable_through_the_public_abi() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    assert_error(s.client().try_pay(&s.payee, &0), Error::InvalidAmount);
    assert_error(s.client().try_pay(&s.token_id, &UNIT), Error::InvalidPayee);

    s.client().set_frozen(&true);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::Frozen);
    s.client().set_frozen(&false);

    s.client().set_session_key_expiry(&(NOON - 1));
    assert_error(
        s.client().try_pay(&s.payee, &UNIT),
        Error::SessionKeyExpired,
    );
    s.client().set_session_key_expiry(&0);

    s.client().set_policy(&UNIT, &UNIT, &true);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::PayeeNotAllowed);

    s.client().set_allowed(&s.payee, &true);
    assert_error(
        s.client().try_pay(&s.payee, &(2 * UNIT)),
        Error::AboveAutoApprove,
    );

    s.client().set_policy(&UNIT, &(10 * UNIT), &true);
    s.client().pay(&s.payee, &UNIT);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
}

/// Every gate returns rather than traps. A trap is an untyped abort the client cannot
/// name, and "the revert reason is exactly why the human path should take over" is the
/// product claim. `assert_error` distinguishes the two: it fails on `Err(Err(_))`.
#[test]
fn every_gate_returns_a_typed_error_rather_than_trapping() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(UNIT);
    s.mock_auths();
    s.client().set_frozen(&true);
    // If this had been written with panic! instead of a typed return, the call would come
    // back as Err(Err(InvokeError)) and this assertion would fail with a clear message.
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::Frozen);
}

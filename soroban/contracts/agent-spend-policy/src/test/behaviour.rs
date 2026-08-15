//! The seven scenarios the product is judged on.
//!
//! Each of these has a matching real transaction on testnet, because a unit test proves
//! the logic and only a transaction proves the deployment. The Instawards success metric
//! is two of them: an under-limit payment that settles and an over-limit one that reverts
//! with a typed error, both linkable on stellar.expert.

use super::{assert_error, setup, UNIT};
use crate::Error;

#[test]
fn happy_path_operator_pay_moves_the_token_and_charges_the_day() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(3 * UNIT));

    assert_eq!(s.token().balance(&s.payee), 3 * UNIT);
    assert_eq!(s.client().balance(), 47 * UNIT);
    assert_eq!(s.client().spent_today(), 3 * UNIT);
}

#[test]
fn pay_above_the_daily_cap_returns_daily_cap_exceeded() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(6 * UNIT));
    assert_error(
        s.client().try_pay(&s.payee, &(5 * UNIT)),
        Error::DailyCapExceeded,
    );

    // The refused payment must leave nothing behind: not the money, not the accounting.
    assert_eq!(s.token().balance(&s.payee), 6 * UNIT);
    assert_eq!(s.client().spent_today(), 6 * UNIT);
}

#[test]
fn the_cap_is_cumulative_across_several_payments_in_one_day() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    for _ in 0..10 {
        s.client().pay(&s.payee, &UNIT);
    }
    assert_eq!(s.client().spent_today(), 10 * UNIT);
    // Structuring one over-cap payment into many under-cap ones is the thing a per-action
    // ceiling alone cannot stop, and the daily cap is what stops it.
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
}

#[test]
fn pay_above_the_auto_approve_ceiling_returns_above_auto_approve() {
    let s = setup(100 * UNIT, 5 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    assert_error(
        s.client().try_pay(&s.payee, &(6 * UNIT)),
        Error::AboveAutoApprove,
    );
    // Exactly at the ceiling is allowed, matching the Solidity original's `>` comparison.
    s.client().pay(&s.payee, &(5 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 5 * UNIT);
}

#[test]
fn pay_while_frozen_returns_frozen() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    s.client().set_frozen(&true);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::Frozen);

    s.client().set_frozen(&false);
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.token().balance(&s.payee), UNIT);
}

#[test]
fn pay_to_an_unallowlisted_payee_returns_payee_not_allowed() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    // Off by default, so an existing vault does not change meaning when this lands.
    assert!(!s.client().allowlist_enabled());
    s.client().pay(&s.payee, &UNIT);

    s.client().set_policy(&(100 * UNIT), &(100 * UNIT), &true);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::PayeeNotAllowed);

    s.client().set_allowed(&s.payee, &true);
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.token().balance(&s.payee), 2 * UNIT);

    // Removing an entry must actually remove the permission, not just the record of it.
    s.client().set_allowed(&s.payee, &false);
    assert!(!s.client().is_allowed(&s.payee));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::PayeeNotAllowed);
}

#[test]
fn owner_pay_bypasses_the_ceiling_the_allowlist_and_the_freeze() {
    let s = setup(100 * UNIT, UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    // Every gate the agent would hit, all at once.
    s.client().set_policy(&(100 * UNIT), &UNIT, &true);
    s.client().set_frozen(&true);
    assert_error(s.client().try_pay(&s.payee, &(20 * UNIT)), Error::Frozen);

    // The human settles it anyway, because that is what the override is for.
    s.client().owner_pay(&s.payee, &(20 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 20 * UNIT);
}

/// `owner_pay` is COUNTED by the daily cap without being LIMITED by it, and the
/// difference is worth pinning because the phrase "counts toward the cap" reads like it
/// means both.
///
/// The Solidity original adds to `spentOnDay` inside `ownerPay` and never compares it to
/// `dailyCap`, and that is right rather than an oversight: the owner can call `withdraw`
/// for the entire balance at any time, so refusing their payment at some threshold would
/// be theatre. What the increment buys is an honest on-chain total. Every unit that left
/// the vault is recorded, so the number a human reads is real outflow rather than
/// agent-only outflow, and the agent's remaining budget shrinks accordingly.
#[test]
fn owner_pay_is_counted_by_the_daily_cap_without_being_limited_by_it() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    s.client().owner_pay(&s.payee, &(9 * UNIT));
    assert_eq!(
        s.client().spent_today(),
        9 * UNIT,
        "an override is still outflow"
    );

    // Not refused, even though it takes the day well past a 10 unit cap.
    s.client().owner_pay(&s.payee, &(30 * UNIT));
    assert_eq!(s.client().spent_today(), 39 * UNIT);

    // And this is what the counting is for: the AGENT is now out of budget for the day,
    // because the human already spent it.
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
}

#[test]
fn owner_withdraw_moves_the_balance_and_does_not_touch_the_day() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(4 * UNIT));
    s.client().withdraw(&s.owner, &(46 * UNIT));

    assert_eq!(s.token().balance(&s.owner), 46 * UNIT);
    assert_eq!(s.client().balance(), 0);
    // A withdrawal is the owner reclaiming their own money, not the agent spending it, so
    // it must not consume the agent's budget for the day.
    assert_eq!(s.client().spent_today(), 4 * UNIT);
}

#[test]
fn a_zero_cap_and_a_zero_ceiling_both_mean_unbounded() {
    // The Solidity original uses 0 as "no bound" for the cap, the ceiling and the expiry,
    // and the console plus the spend-preflight API already assume it. A port that treated
    // 0 as "nothing may move" would brick every existing configuration.
    let s = setup(0, 0);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(999 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 999 * UNIT);
}

#[test]
fn paying_more_than_the_vault_holds_returns_insufficient_balance() {
    let s = setup(0, 0);
    s.fund_vault(UNIT);
    s.mock_auths();

    // Named here rather than left to the token, which would panic anonymously: the SAC
    // has no bool return for the Solidity original's `if (!transfer) revert` to check.
    assert_error(
        s.client().try_pay(&s.payee, &(2 * UNIT)),
        Error::InsufficientBalance,
    );
    assert_error(
        s.client().try_withdraw(&s.owner, &(2 * UNIT)),
        Error::InsufficientBalance,
    );
    assert_eq!(
        s.client().spent_today(),
        0,
        "a refused payment charges nothing"
    );
}

#[test]
fn set_operator_rotates_who_may_spend() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();
    let fresh = soroban_sdk::Address::generate(&s.env);

    s.client().set_operator(&fresh);
    assert_eq!(s.client().operator(), fresh);

    // Rotation is the incident response for a leaked agent key, so it is rehearsed here
    // and again on testnet before a mainnet key ever exists.
    s.enforce_auth();
    let args = (s.payee.clone(), UNIT).into_val(&s.env);
    s.env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &s.operator,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "pay",
            args,
            sub_invokes: &[],
        },
    }]);
    assert!(
        s.client().try_pay(&s.payee, &UNIT).is_err(),
        "the retired operator must stop working the moment it is replaced"
    );
}

#[test]
fn the_owner_and_the_operator_may_never_be_the_same_address() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.mock_auths();
    // One key that can both spend past the policy and lift the policy is the same as no
    // policy. The TypeScript vault path already refuses this; the contract makes it
    // unbypassable.
    assert_error(
        s.client().try_set_operator(&s.owner),
        Error::OwnerIsOperator,
    );
}

use soroban_sdk::testutils::Address as _;
use soroban_sdk::IntoVal;

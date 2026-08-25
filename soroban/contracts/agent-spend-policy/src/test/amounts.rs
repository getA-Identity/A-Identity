//! The class with no Solidity counterpart.
//!
//! The original stored amounts as `uint256`, so a negative amount could not be expressed
//! and no guard was needed. Here they are `i128`.
//!
//! What the guard actually buys, after a review corrected the original claim: the SAC
//! rejects a negative transfer itself and the invocation rolls back, so there was never a
//! persistent cap bypass. The guard turns an untyped host trap out of the token into
//! `InvalidAmount`, which the client can name and route on, and it keeps the vault's
//! safety from depending on whichever SEP-41 token it was pointed at.
//!
//! Zero is refused for a smaller reason: it moves nothing, emits a `Paid` event that says
//! a payment happened, and pollutes the audit trail the vault's honesty rests on.

use super::{assert_error, setup, UNIT};
use crate::Error;

#[test]
fn pay_with_a_negative_amount_returns_invalid_amount() {
    let s = setup(10 * UNIT, 10 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(9 * UNIT));
    assert_error(
        s.client().try_pay(&s.payee, &(-5 * UNIT)),
        Error::InvalidAmount,
    );

    // A refused amount must not credit the day. The guard is not what makes that true:
    // without `check_amount` the SAC's own sign check panics and Soroban rolls the
    // accumulator write back with it, so the total would still read 9. What the guard
    // buys is a typed `InvalidAmount` instead of an untyped trap out of the token.
    assert_eq!(
        s.client().spent_today(),
        9 * UNIT,
        "a refused amount must not credit the day"
    );
    assert_error(
        s.client().try_pay(&s.payee, &(2 * UNIT)),
        Error::DailyCapExceeded,
    );
}

#[test]
fn pay_with_zero_returns_invalid_amount() {
    let s = setup(0, 0);
    s.fund_vault(UNIT);
    s.mock_auths();
    assert_error(s.client().try_pay(&s.payee, &0), Error::InvalidAmount);
}

#[test]
fn pay_with_i128_min_returns_invalid_amount() {
    // The extreme of the same class. It must be refused by the sign check before any
    // arithmetic touches it, because negating or adding i128::MIN is itself a trap.
    let s = setup(0, 0);
    s.fund_vault(UNIT);
    s.mock_auths();
    assert_error(
        s.client().try_pay(&s.payee, &i128::MIN),
        Error::InvalidAmount,
    );
}

#[test]
fn owner_pay_and_withdraw_reject_negative_amounts_too() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    // No role gets to skip correctness. The override skips POLICY, which is a different
    // thing: a negative owner_pay would corrupt the same accounting.
    assert_error(
        s.client().try_owner_pay(&s.payee, &(-UNIT)),
        Error::InvalidAmount,
    );
    assert_error(
        s.client().try_withdraw(&s.owner, &(-UNIT)),
        Error::InvalidAmount,
    );
    assert_error(s.client().try_owner_pay(&s.payee, &0), Error::InvalidAmount);
}

/// A negative cap compares as "always under budget" and a negative ceiling as "always
/// over it". Both are silently wrong rather than loud, so they are refused at
/// construction, where the mistake is still free. This SDK has no fallible `register`, so
/// the assertion is the panic itself.
#[test]
#[should_panic]
fn the_constructor_refuses_a_negative_daily_cap() {
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env};
    let env = Env::default();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    env.register(
        crate::AgentSpendPolicy,
        (
            Address::generate(&env),
            Address::generate(&env),
            sac.address(),
            -1i128,
            0i128,
        ),
    );
}

#[test]
#[should_panic]
fn the_constructor_refuses_a_negative_auto_approve_ceiling() {
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env};
    let env = Env::default();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    env.register(
        crate::AgentSpendPolicy,
        (
            Address::generate(&env),
            Address::generate(&env),
            sac.address(),
            0i128,
            -1i128,
        ),
    );
}

/// The same guard the contract enforces on set_operator, applied at deploy. One key that
/// can both spend past the policy and lift the policy is the same as no policy.
#[test]
#[should_panic]
fn the_constructor_refuses_an_owner_that_is_also_the_operator() {
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Address, Env};
    let env = Env::default();
    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    let same = Address::generate(&env);
    env.register(
        crate::AgentSpendPolicy,
        (same.clone(), same, sac.address(), 0i128, 0i128),
    );
}

#[test]
fn set_policy_refuses_a_negative_policy() {
    let s = setup(0, 0);
    s.mock_auths();
    assert_error(
        s.client().try_set_policy(&(-1), &0, &false),
        Error::InvalidAmount,
    );
    assert_error(
        s.client().try_set_policy(&0, &(-1), &false),
        Error::InvalidAmount,
    );
}

#[test]
fn the_day_accumulator_uses_checked_add_and_returns_math_overflow() {
    // Reachable only with an unbounded cap and a vault big enough to matter, which is why
    // the guard is explicit rather than left to the release profile: `overflow-checks`
    // would turn this into a bare panic, and a bare panic is an untyped abort the client
    // cannot name. The product's claim is that the revert reason tells the human what to
    // do next.
    let s = setup(0, 0);
    s.mock_auths();
    s.fund_vault(i128::MAX);

    s.client().pay(&s.payee, &(i128::MAX / 2));
    s.client().pay(&s.payee, &(i128::MAX / 2));
    assert_error(
        s.client().try_pay(&s.payee, &(i128::MAX / 2)),
        Error::MathOverflow,
    );
}

//! The authorization spine.
//!
//! These are the tests the whole contract rests on. `pay` moves the vault's own balance,
//! so the token's `from`-side check is satisfied by the direct-call rule and cannot help
//! us. Soroban has no `msg.sender`. That leaves exactly one thing standing between a
//! funded stranger and the vault: `operator.require_auth()` at the top of `pay`.
//!
//! Two habits in this file are deliberate and load-bearing:
//!
//! 1. Every test calls `s.enforce_auth()` before the call under test. Blanket mocking is
//!    what would make these pass against a contract with the guard deleted.
//! 2. Where a payment must succeed, the test asserts the AUTH TREE, not merely that the
//!    call returned. A contract that authorized the owner instead of the operator, or
//!    authorized nobody at all, would also "work".
//!
//! `soroban/audit/negative-controls/` proves mechanically that this file does its job:
//! it deletes the guard and requires the suite to go red.

use super::{setup, UNIT};
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke,
};
use soroban_sdk::{Address, IntoVal, Symbol};

#[test]
fn pay_without_any_auth_fails() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.enforce_auth();
    assert!(
        s.client().try_pay(&s.payee, &UNIT).is_err(),
        "pay must not succeed without the operator's authorization"
    );
}

/// The one that matters most. A funded stranger signs for themselves and calls `pay`.
/// Their signature is real and their authorization entry is present; it is simply not the
/// operator's. Without the guard, this call would drain the vault up to the policy
/// limits, and the policy would happily allow it, because a cap says how much may move,
/// never who may move it.
#[test]
fn a_funded_stranger_signing_for_itself_cannot_pay() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.enforce_auth();

    let args = (s.payee.clone(), UNIT).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.stranger,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "pay",
            args,
            sub_invokes: &[],
        },
    }]);

    assert!(
        s.client().try_pay(&s.payee, &UNIT).is_err(),
        "an authorization from someone who is not the operator must not be accepted"
    );
    assert_eq!(
        s.token().balance(&s.payee),
        0,
        "not a single unit may move on a rejected call"
    );
}

/// The owner is not the operator either. Authority here is specific, not hierarchical.
#[test]
fn the_owner_cannot_call_pay() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.enforce_auth();

    let args = (s.payee.clone(), UNIT).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.owner,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "pay",
            args,
            sub_invokes: &[],
        },
    }]);

    assert!(s.client().try_pay(&s.payee, &UNIT).is_err());
}

/// And symmetrically: the operator may not do owner things. A compromised agent key must
/// not be able to lift the policy that bounds it, which is the whole point of the split.
#[test]
fn the_operator_cannot_call_any_owner_function() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    let other = Address::generate(&s.env);

    for (name, args) in [
        ("set_frozen", (false,).into_val(&s.env)),
        ("set_policy", (0i128, 0i128, false).into_val(&s.env)),
        ("set_operator", (other.clone(),).into_val(&s.env)),
        ("set_session_key_expiry", (0u64,).into_val(&s.env)),
        ("withdraw", (s.payee.clone(), UNIT).into_val(&s.env)),
        ("owner_pay", (s.payee.clone(), UNIT).into_val(&s.env)),
    ] {
        s.enforce_auth();
        s.env.mock_auths(&[MockAuth {
            address: &s.operator,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: name,
                args,
                sub_invokes: &[],
            },
        }]);
        let c = s.client();
        let failed = match name {
            "set_frozen" => c.try_set_frozen(&false).is_err(),
            "set_policy" => c.try_set_policy(&0, &0, &false).is_err(),
            "set_operator" => c.try_set_operator(&other).is_err(),
            "set_session_key_expiry" => c.try_set_session_key_expiry(&0).is_err(),
            "withdraw" => c.try_withdraw(&s.payee, &UNIT).is_err(),
            "owner_pay" => c.try_owner_pay(&s.payee, &UNIT).is_err(),
            _ => unreachable!(),
        };
        assert!(failed, "the operator must not be able to call {name}");
    }
}

#[test]
fn owner_pay_without_any_auth_fails() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.enforce_auth();
    assert!(s.client().try_owner_pay(&s.payee, &UNIT).is_err());
}

#[test]
fn withdraw_without_any_auth_fails() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.enforce_auth();
    assert!(s.client().try_withdraw(&s.owner, &UNIT).is_err());
}

#[test]
fn every_owner_setter_without_auth_fails() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.enforce_auth();
    let c = s.client();
    let other = Address::generate(&s.env);
    assert!(c.try_set_policy(&1, &1, &false).is_err(), "set_policy");
    assert!(c.try_set_allowed(&s.payee, &true).is_err(), "set_allowed");
    assert!(c.try_set_operator(&other).is_err(), "set_operator");
    assert!(c.try_set_frozen(&true).is_err(), "set_frozen");
    assert!(
        c.try_set_session_key_expiry(&1).is_err(),
        "set_session_key_expiry"
    );
}

#[test]
fn pay_requires_exactly_the_operator_and_nothing_else() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &UNIT);

    let auths = s.env.auths();
    assert_eq!(auths.len(), 1, "exactly one address should have authorized");
    let (who, invocation) = auths.first().unwrap().clone();
    assert_eq!(
        who, s.operator,
        "the operator, not the owner, authorizes pay"
    );
    let AuthorizedInvocation { function, .. } = invocation;
    match function {
        AuthorizedFunction::Contract((contract, fname, args)) => {
            assert_eq!(contract, s.contract_id);
            assert_eq!(fname, Symbol::new(&s.env, "pay"));
            assert_eq!(
                args,
                (s.payee.clone(), UNIT).into_val(&s.env),
                "the authorization must be scoped to this payee and this amount"
            );
        }
        other => panic!("expected a contract invocation, got {other:?}"),
    }
}

/// The operator authorizes `pay`, and that is the ONLY authorization in the tree. In
/// particular the operator does not authorize the token transfer: the vault moves its own
/// balance, so the token's `from` is the contract and the direct call is the
/// authorization. This is the EVM-shaped mistake worth pinning against, because a port
/// that made the operator sign for the transfer would be asking the agent to authorize
/// moving funds it does not own.
#[test]
fn the_operator_never_authorizes_the_token_transfer() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &UNIT);

    let (_, invocation) = s.env.auths().first().unwrap().clone();
    assert!(
        invocation.sub_invocations.is_empty(),
        "the token transfer must not appear in the operator's auth tree"
    );
}

#[test]
fn owner_pay_is_authorized_by_the_owner_not_the_operator() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.client().owner_pay(&s.payee, &UNIT);

    let auths = s.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths.first().unwrap().0, s.owner);
}

/// `pay` takes no caller address, so there is nothing to spoof. This pins that as a
/// property of the ABI rather than a habit: if someone adds a `from: Address` parameter,
/// the signature below stops compiling and they have to come and read this comment.
#[test]
fn the_operator_is_read_from_storage_not_from_an_argument() {
    let s = setup(100 * UNIT, 100 * UNIT);
    let _pay_takes_only_payee_and_amount: fn(&crate::AgentSpendPolicyClient<'_>, &Address, &i128) =
        |c, to, amount| {
            c.pay(to, amount);
        };
    assert_eq!(s.client().operator(), s.operator);
}

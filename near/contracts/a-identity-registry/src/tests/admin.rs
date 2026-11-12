//! The owner's methods: `add_oracle`, `remove_oracle`, `set_owner`. Owner first, then
//! exactly 1 yoctoNEAR, then the method's own rule; idempotent no-ops log nothing.

use super::*;
use crate::MAX_ORACLES;
use near_sdk::serde_json::json;

const TWO_YOCTO: NearToken = NearToken::from_yoctonear(2);

type OwnerCall = fn(&mut Registry);

fn owner_calls() -> Vec<(&'static str, OwnerCall)> {
    vec![
        ("add_oracle", |r: &mut Registry| r.add_oracle(oracle2())),
        ("remove_oracle", |r: &mut Registry| {
            r.remove_oracle(oracle())
        }),
        ("set_owner", |r: &mut Registry| r.set_owner(stranger())),
    ]
}

// -- the shared guards, on every owner method ---------------------------------------------

#[test]
fn every_owner_method_refuses_a_caller_that_is_not_the_owner() {
    for (name, method) in owner_calls() {
        let mut registry = fresh();
        // Including an oracle, and including with the yocto attached.
        for caller in [stranger(), oracle(), registry_id()] {
            call(&caller, ONE_YOCTO, T0);
            expect_err(Error::NotOwner, || method(&mut registry));
        }
        assert_eq!(registry.owner(), owner(), "{name}");
        assert_eq!(registry.oracles(), vec![oracle()], "{name}");
    }
}

#[test]
fn every_owner_method_requires_exactly_one_yocto() {
    for (name, method) in owner_calls() {
        let mut registry = fresh();
        for deposit in [NO_DEPOSIT, TWO_YOCTO, NearToken::from_near(1)] {
            call(&owner(), deposit, T0);
            expect_err(Error::RequiresOneYocto, || method(&mut registry));
        }
        assert_eq!(registry.owner(), owner(), "{name}");
        assert_eq!(registry.oracles(), vec![oracle()], "{name}");
    }
}

#[test]
fn the_owner_check_comes_before_the_yocto_check() {
    for (_, method) in owner_calls() {
        let mut registry = fresh();
        call(&stranger(), NO_DEPOSIT, T0);
        expect_err(Error::NotOwner, || method(&mut registry));
    }
}

#[test]
fn the_owner_is_the_predecessor_not_the_signer() {
    let mut registry = fresh();
    call_signed(&owner(), &stranger(), ONE_YOCTO, T0);
    expect_err(Error::NotOwner, || registry.add_oracle(oracle2()));
    call_signed(&stranger(), &owner(), ONE_YOCTO, T0);
    registry.add_oracle(oracle2());
    assert_eq!(registry.oracles(), vec![oracle(), oracle2()]);
}

// -- add_oracle ---------------------------------------------------------------------------

#[test]
fn the_owner_adds_an_oracle_and_it_is_logged() {
    let mut registry = fresh();
    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(oracle2());
    assert_eq!(registry.oracles(), vec![oracle(), oracle2()]);
    let events = events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "oracle_added");
    assert_eq!(events[0]["data"], json!({ "account_id": "oracle2.near" }));
    // And the new oracle can write.
    call(&oracle2(), NO_DEPOSIT, T0);
    set(&mut registry, entry(&payee(), Verdict::Warn));
}

#[test]
fn adding_an_existing_oracle_is_a_silent_no_op() {
    let mut registry = fresh();
    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(oracle());
    assert_eq!(registry.oracles(), vec![oracle()]);
    assert!(events().is_empty());
}

#[test]
fn the_oracle_set_stops_at_its_limit() {
    let mut registry = fresh();
    for i in 1..MAX_ORACLES {
        call(&owner(), ONE_YOCTO, T0);
        registry.add_oracle(acc(&format!("extra{i}.near")));
    }
    assert_eq!(registry.oracles().len(), MAX_ORACLES as usize);
    call(&owner(), ONE_YOCTO, T0);
    expect_err(Error::OracleLimitReached, || registry.add_oracle(oracle2()));
    assert_eq!(registry.oracles().len(), MAX_ORACLES as usize);
    // Re-adding a member of a full set asks for a state that already holds: not an error.
    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(oracle());
    // Removing one makes room again.
    call(&owner(), ONE_YOCTO, T0);
    registry.remove_oracle(acc("extra1.near"));
    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(oracle2());
    assert!(registry.oracles().contains(&oracle2()));
}

// -- remove_oracle ------------------------------------------------------------------------

#[test]
fn the_owner_removes_an_oracle_and_it_is_logged() {
    let mut registry = fresh();
    call(&owner(), ONE_YOCTO, T0);
    registry.remove_oracle(oracle());
    assert!(registry.oracles().is_empty());
    let events = events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "oracle_removed");
    assert_eq!(events[0]["data"], json!({ "account_id": "oracle.near" }));
}

#[test]
fn removing_an_account_that_is_not_an_oracle_is_a_silent_no_op() {
    let mut registry = fresh();
    call(&owner(), ONE_YOCTO, T0);
    registry.remove_oracle(stranger());
    assert_eq!(registry.oracles(), vec![oracle()]);
    assert!(events().is_empty());
}

#[test]
fn removing_an_oracle_keeps_the_verdicts_it_wrote() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Deny), T0);
    call(&owner(), ONE_YOCTO, T0);
    registry.remove_oracle(oracle());
    let view = registry.get_verdict(payee()).unwrap();
    assert_eq!(view.verdict, Verdict::Deny);
    assert_eq!(view.updated_by, oracle());
}

// -- set_owner ----------------------------------------------------------------------------

#[test]
fn set_owner_hands_the_role_over_in_one_step_and_it_is_logged() {
    let mut registry = fresh();
    let next = acc("next-owner.near");
    call(&owner(), ONE_YOCTO, T0);
    registry.set_owner(next.clone());
    assert_eq!(registry.owner(), next);
    let events = events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "owner_set");
    assert_eq!(events[0]["data"], json!({ "owner_id": "next-owner.near" }));

    // The old owner is out in the same call; the new one is in.
    call(&owner(), ONE_YOCTO, T0);
    expect_err(Error::NotOwner, || registry.add_oracle(oracle2()));
    call(&next, ONE_YOCTO, T0);
    registry.add_oracle(oracle2());
    assert_eq!(registry.oracles(), vec![oracle(), oracle2()]);
}

#[test]
fn set_owner_to_the_current_owner_is_allowed_and_logged() {
    let mut registry = fresh();
    call(&owner(), ONE_YOCTO, T0);
    registry.set_owner(owner());
    assert_eq!(registry.owner(), owner());
    assert_eq!(event_names(), vec!["owner_set"]);
}

#[test]
fn the_owner_role_grants_nothing_beyond_oracle_management() {
    let mut registry = fresh();
    call(&stranger(), crate::REPORT_DEPOSIT, T0);
    registry.report(payee(), "drainer".to_string(), "tx:1".to_string());
    oracle_sets(&mut registry, entry(&payee(), Verdict::Deny), T0);
    for deposit in [NO_DEPOSIT, ONE_YOCTO] {
        call(&owner(), deposit, T0);
        expect_err(Error::NotOracle, || registry.clear_verdict(payee()));
        expect_err(Error::NotOracle, || registry.clear_reports(payee()));
        expect_err(Error::NotOracle, || registry.set_verdicts(Vec::new()));
    }
}

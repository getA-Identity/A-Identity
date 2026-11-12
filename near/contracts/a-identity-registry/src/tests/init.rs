//! `new`: the owner, the initial oracle set, its bound, and the events that let the log
//! rebuild both from the first block.

use super::*;
use crate::MAX_ORACLES;

#[test]
fn new_sets_the_owner_and_the_oracles() {
    let registry = fresh();
    assert_eq!(registry.owner(), owner());
    assert_eq!(registry.oracles(), vec![oracle()]);
}

#[test]
fn new_logs_the_owner_and_every_initial_oracle() {
    begin();
    let _registry = Registry::new(owner(), vec![oracle(), oracle2()]);
    let events = events();
    assert_eq!(
        event_names(),
        vec!["owner_set", "oracle_added", "oracle_added"]
    );
    assert_eq!(
        events[0]["data"],
        serde_json::json!({ "owner_id": "owner.near" })
    );
    assert_eq!(
        events[1]["data"],
        serde_json::json!({ "account_id": "oracle.near" })
    );
    assert_eq!(
        events[2]["data"],
        serde_json::json!({ "account_id": "oracle2.near" })
    );
}

#[test]
fn new_collapses_duplicate_oracles() {
    begin();
    let registry = Registry::new(owner(), vec![oracle(), oracle(), oracle2(), oracle()]);
    assert_eq!(registry.oracles(), vec![oracle(), oracle2()]);
    // One event per distinct oracle, not per list entry.
    assert_eq!(
        event_names(),
        vec!["owner_set", "oracle_added", "oracle_added"]
    );
}

fn oracles(n: u32) -> Vec<AccountId> {
    (0..n).map(|i| acc(&format!("oracle{i}.near"))).collect()
}

#[test]
fn new_accepts_exactly_the_oracle_limit() {
    begin();
    let registry = Registry::new(owner(), oracles(MAX_ORACLES));
    assert_eq!(registry.oracles().len(), MAX_ORACLES as usize);
}

#[test]
fn new_refuses_one_oracle_over_the_limit() {
    begin();
    expect_err(Error::OracleLimitReached, || {
        Registry::new(owner(), oracles(MAX_ORACLES + 1))
    });
}

#[test]
fn new_counts_distinct_oracles_against_the_limit() {
    // Eleven entries, ten distinct: the bound is on the set, not on the argument list.
    let mut list = oracles(MAX_ORACLES);
    list.push(list[0].clone());
    begin();
    let registry = Registry::new(owner(), list);
    assert_eq!(registry.oracles().len(), MAX_ORACLES as usize);
}

#[test]
fn new_with_no_oracles_leaves_nobody_able_to_write() {
    begin();
    let mut registry = Registry::new(owner(), Vec::new());
    assert!(registry.oracles().is_empty());
    assert_eq!(event_names(), vec!["owner_set"]);
    // Not even the owner: managing oracles is not the same as being one.
    call(&owner(), NO_DEPOSIT, T0);
    expect_err(Error::NotOracle, || {
        set(&mut registry, entry(&payee(), Verdict::Deny))
    });
}

/// Finding AUTH-4: `new` is `#[init]` but has no `#[private]`, because the batch that creates
/// `registry.<parent>` comes from the parent. It admits the registry account itself and its
/// parent, and nobody else, so a deploy sent without its init is not the first stranger's to
/// claim with an owner and an oracle of its own.
#[test]
fn only_the_registry_account_or_its_parent_may_initialize_it() {
    for (caller, who) in [
        (stranger(), "a stranger"),
        (
            owner(),
            "the owner named in the call, which is not the parent here",
        ),
        (acc("x.registry.near"), "a sub-account of the registry"),
        (acc("try.near"), "a suffix that is not the parent"),
    ] {
        begin();
        call(&caller, NO_DEPOSIT, T0);
        expect_err(Error::InitNotAllowed, || {
            Registry::new(caller.clone(), vec![caller.clone()])
        });
        assert!(events().is_empty(), "{who}: nothing logged");
    }

    // The parent that creates `registry.near` in the same batch.
    begin();
    call(&acc("near"), NO_DEPOSIT, T0);
    let registry = Registry::new(owner(), vec![oracle()]);
    assert_eq!(registry.owner(), owner());

    // The registry account itself, as in a self-deploy.
    begin();
    let registry = Registry::new(owner(), vec![oracle()]);
    assert_eq!(registry.oracles(), vec![oracle()]);
}

#[test]
fn new_starts_with_no_verdicts_and_no_reports() {
    let registry = fresh();
    assert_eq!(registry.get_verdict(payee()), None);
    assert!(registry.list_verdicts(None, None).is_empty());
    assert!(registry.get_reports(payee()).is_empty());
    assert_eq!(registry.report_count(payee()), 0);
}

//! The views: `get_verdict`, `check`, `list_verdicts` paging, `get_reports`,
//! `report_count`, `oracles`, `owner`.

use super::*;
use crate::{CheckVerdict, CheckView, DEFAULT_PAGE, MAX_PAGE};

fn subject(i: usize) -> AccountId {
    acc(&format!("acct{i:03}.near"))
}

/// A registry holding `n` verdicts, written one call at a time in index order.
fn with_verdicts(n: usize) -> Registry {
    let mut registry = fresh();
    for i in 0..n {
        // One context per write, as one transaction per write is on chain: the runtime's
        // log limit is per receipt, and 120 writes in one would exceed it.
        call(&oracle(), NO_DEPOSIT, T0);
        set(&mut registry, entry(&subject(i), Verdict::Allow));
    }
    registry
}

fn listed(registry: &Registry, from: Option<u64>, limit: Option<u64>) -> Vec<AccountId> {
    registry
        .list_verdicts(from.map(U64), limit.map(U64))
        .into_iter()
        .map(|view| view.account_id)
        .collect()
}

fn subjects(range: std::ops::Range<usize>) -> Vec<AccountId> {
    range.map(subject).collect()
}

// -- list_verdicts ------------------------------------------------------------------------

#[test]
fn list_verdicts_pages_in_storage_order() {
    let registry = with_verdicts(5);
    assert_eq!(listed(&registry, None, None), subjects(0..5));
    assert_eq!(listed(&registry, Some(1), Some(2)), subjects(1..3));
    assert_eq!(listed(&registry, Some(3), Some(10)), subjects(3..5));
    assert_eq!(listed(&registry, Some(4), None), subjects(4..5));
}

#[test]
fn list_verdicts_past_the_end_is_empty() {
    let registry = with_verdicts(5);
    assert!(listed(&registry, Some(5), None).is_empty());
    assert!(listed(&registry, Some(1_000), Some(10)).is_empty());
    // 2^32 would wrap to 0 on wasm32 if converted with `as`; it is past the end.
    assert!(listed(&registry, Some(1 << 32), None).is_empty());
    assert!(listed(&registry, Some(u64::MAX), Some(u64::MAX)).is_empty());
}

#[test]
fn a_zero_limit_returns_nothing() {
    let registry = with_verdicts(3);
    assert!(listed(&registry, None, Some(0)).is_empty());
}

#[test]
fn the_default_page_and_the_page_ceiling_apply() {
    let n = MAX_PAGE as usize + 20;
    let registry = with_verdicts(n);
    assert_eq!(listed(&registry, None, None).len(), DEFAULT_PAGE as usize);
    assert_eq!(
        listed(&registry, None, Some(MAX_PAGE)).len(),
        MAX_PAGE as usize
    );
    // Asking for more than the ceiling gets the ceiling, not a refusal.
    assert_eq!(
        listed(&registry, None, Some(1_000)),
        subjects(0..MAX_PAGE as usize)
    );
    assert_eq!(
        listed(&registry, None, Some(u64::MAX)).len(),
        MAX_PAGE as usize
    );
    // And the rest is reachable by paging.
    assert_eq!(
        listed(&registry, Some(MAX_PAGE), Some(MAX_PAGE)),
        subjects(MAX_PAGE as usize..n)
    );
}

#[test]
fn list_verdicts_returns_the_same_view_get_verdict_does() {
    let mut registry = fresh();
    let mut input = entry(&payee(), Verdict::Warn);
    input.ttl_s = ttl(60);
    input.code_hash = Some("abc".to_string());
    oracle_sets(&mut registry, input, T0);
    assert_eq!(
        registry.list_verdicts(None, None),
        vec![registry.get_verdict(payee()).unwrap()]
    );
}

#[test]
fn clearing_a_verdict_moves_the_last_one_into_its_position() {
    // Documented on list_verdicts: paging is over storage positions, and removal swaps.
    let mut registry = with_verdicts(4);
    call(&oracle(), NO_DEPOSIT, T0);
    registry.clear_verdict(subject(1));
    assert_eq!(
        listed(&registry, None, None),
        vec![subject(0), subject(3), subject(2)]
    );
}

// -- check --------------------------------------------------------------------------------

#[test]
fn check_reports_each_live_verdict_with_its_reasons() {
    let mut registry = fresh();
    for (verdict, expected) in [
        (Verdict::Allow, CheckVerdict::Allow),
        (Verdict::Warn, CheckVerdict::Warn),
        (Verdict::Deny, CheckVerdict::Deny),
    ] {
        let mut input = entry(&payee(), verdict);
        input.reasons = vec!["a".to_string(), "b".to_string()];
        oracle_sets(&mut registry, input, T0);
        assert_eq!(
            registry.check(payee()),
            CheckView {
                verdict: expected,
                reasons: vec!["a".to_string(), "b".to_string()],
                reports: 0,
            }
        );
    }
}

#[test]
fn check_says_none_for_an_account_never_assessed() {
    let registry = fresh();
    assert_eq!(
        registry.check(payee()),
        CheckView {
            verdict: CheckVerdict::NoVerdict,
            reasons: Vec::new(),
            reports: 0,
        }
    );
}

#[test]
fn check_counts_open_reports_even_without_a_verdict() {
    let mut registry = fresh();
    for who in [stranger(), oracle2()] {
        call(&who, crate::REPORT_DEPOSIT, T0);
        registry.report(payee(), "drainer".to_string(), "tx:1".to_string());
    }
    let check = registry.check(payee());
    assert_eq!(check.verdict, CheckVerdict::NoVerdict);
    assert_eq!(check.reports, 2);
}

// -- the rest -----------------------------------------------------------------------------

#[test]
fn get_verdict_for_an_unknown_account_is_none() {
    let registry = with_verdicts(2);
    assert_eq!(registry.get_verdict(acc("unknown.near")), None);
}

#[test]
fn get_reports_and_report_count_for_an_unreported_account_are_empty() {
    let registry = fresh();
    assert!(registry.get_reports(acc("unknown.near")).is_empty());
    assert_eq!(registry.report_count(acc("unknown.near")), 0);
}

#[test]
fn oracles_lists_the_set_in_insertion_order() {
    let mut registry = fresh();
    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(oracle2());
    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(stranger());
    assert_eq!(registry.oracles(), vec![oracle(), oracle2(), stranger()]);
}

#[test]
fn views_work_for_any_caller_with_nothing_attached() {
    let registry = with_verdicts(1);
    call(&acc("anyone.near"), NO_DEPOSIT, T0);
    assert_eq!(registry.owner(), owner());
    assert_eq!(registry.oracles(), vec![oracle()]);
    assert!(registry.get_verdict(subject(0)).is_some());
    assert_eq!(registry.check(subject(0)).verdict, CheckVerdict::Allow);
    assert_eq!(registry.list_verdicts(None, None).len(), 1);
}

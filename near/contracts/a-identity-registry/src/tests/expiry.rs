//! Verdict expiry: the deadline a TTL gives, live through the deadline inclusive, read as no
//! verdict after it (by `get_verdict` and `check`, not by `list_verdicts`), the meaning of
//! zero, and a deadline that would not fit refused rather than wrapped into the past.

use super::*;
use crate::CheckVerdict;

const SECOND: u64 = 1_000_000_000;

fn with_ttl(verdict: Verdict, ttl_s: Option<U64>) -> VerdictInput {
    VerdictInput {
        ttl_s,
        ..entry(&payee(), verdict)
    }
}

/// Read as a view call at `now_ns`.
fn verdict_at(registry: &Registry, now_ns: u64) -> Option<Verdict> {
    call(&stranger(), NO_DEPOSIT, now_ns);
    registry.get_verdict(payee()).map(|view| view.verdict)
}

#[test]
fn a_ttl_sets_the_deadline_in_nanoseconds() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(3600)), T0);
    let view = registry.get_verdict(payee()).unwrap();
    assert_eq!(view.expires_at_ns, Some(U64(T0 + 3600 * SECOND)));
}

#[test]
fn a_verdict_is_live_through_its_deadline_and_gone_one_nanosecond_after() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(60)), T0);
    let deadline = T0 + 60 * SECOND;
    assert_eq!(verdict_at(&registry, T0), Some(Verdict::Deny));
    assert_eq!(verdict_at(&registry, deadline - 1), Some(Verdict::Deny));
    assert_eq!(verdict_at(&registry, deadline), Some(Verdict::Deny));
    assert_eq!(verdict_at(&registry, deadline + 1), None);
    assert_eq!(verdict_at(&registry, u64::MAX), None);
}

#[test]
fn an_expired_deny_reads_exactly_like_no_verdict() {
    // This is the case the crate comment warns about: the vault no longer refuses an account
    // whose DENY has lapsed, because it cannot tell the two apart, by design.
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(1)), T0);
    call(&stranger(), NO_DEPOSIT, T0 + 2 * SECOND);
    assert_eq!(registry.get_verdict(payee()), None);
    assert_eq!(
        registry.get_verdict(payee()),
        registry.get_verdict(acc("never.near"))
    );
}

#[test]
fn check_reads_an_expired_verdict_as_none_but_still_counts_reports() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(1)), T0);
    call(&stranger(), crate::REPORT_DEPOSIT, T0);
    registry.report(payee(), "drainer".to_string(), "tx:1".to_string());

    call(&stranger(), NO_DEPOSIT, T0 + SECOND);
    assert_eq!(registry.check(payee()).verdict, CheckVerdict::Deny);

    call(&stranger(), NO_DEPOSIT, T0 + SECOND + 1);
    let check = registry.check(payee());
    assert_eq!(check.verdict, CheckVerdict::NoVerdict);
    assert!(check.reasons.is_empty());
    assert_eq!(check.reports, 1);
}

#[test]
fn no_ttl_never_expires() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, None), T0);
    assert_eq!(registry.get_verdict(payee()).unwrap().expires_at_ns, None);
    assert_eq!(verdict_at(&registry, u64::MAX), Some(Verdict::Deny));
}

#[test]
fn a_zero_ttl_means_no_expiry_not_already_expired() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(0)), T0);
    assert_eq!(registry.get_verdict(payee()).unwrap().expires_at_ns, None);
    assert_eq!(verdict_at(&registry, u64::MAX), Some(Verdict::Deny));
}

#[test]
fn a_ttl_whose_nanoseconds_overflow_is_refused() {
    let mut registry = fresh();
    // u64::MAX / 1e9 seconds is the largest TTL whose nanoseconds fit; one more does not.
    let largest = u64::MAX / SECOND;
    call(&oracle(), NO_DEPOSIT, 0);
    set(&mut registry, with_ttl(Verdict::Deny, ttl(largest)));
    assert_eq!(
        registry.get_verdict(payee()).unwrap().expires_at_ns,
        Some(U64(largest * SECOND))
    );
    expect_err(Error::MathOverflow, || {
        set(&mut registry, with_ttl(Verdict::Deny, ttl(largest + 1)))
    });
    expect_err(Error::MathOverflow, || {
        set(&mut registry, with_ttl(Verdict::Deny, ttl(u64::MAX)))
    });
}

#[test]
fn a_deadline_past_the_end_of_time_is_refused_not_wrapped() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, None), T0);
    // Late enough that now + 1 s no longer fits. A wrapped deadline would be in the past
    // and expire this DENY on the spot; the write is refused and the old DENY stays.
    let late = u64::MAX - SECOND + 1;
    call(&oracle(), NO_DEPOSIT, late);
    expect_err(Error::MathOverflow, || {
        set(&mut registry, with_ttl(Verdict::Deny, ttl(1)))
    });
    assert_eq!(verdict_at(&registry, late), Some(Verdict::Deny));
    // Exactly at the edge it fits.
    call(&oracle(), NO_DEPOSIT, u64::MAX - SECOND);
    set(&mut registry, with_ttl(Verdict::Deny, ttl(1)));
    assert_eq!(
        registry.get_verdict(payee()).unwrap().expires_at_ns,
        Some(U64(u64::MAX))
    );
}

#[test]
fn rewriting_a_verdict_replaces_its_deadline() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(60)), T0);
    // Extended by a later write, whose TTL counts from the later write's block.
    oracle_sets(
        &mut registry,
        with_ttl(Verdict::Deny, ttl(60)),
        T0 + 30 * SECOND,
    );
    assert_eq!(
        registry.get_verdict(payee()).unwrap().expires_at_ns,
        Some(U64(T0 + 90 * SECOND))
    );
    // Made permanent by a write without one.
    oracle_sets(
        &mut registry,
        with_ttl(Verdict::Deny, None),
        T0 + 40 * SECOND,
    );
    assert_eq!(verdict_at(&registry, u64::MAX), Some(Verdict::Deny));
}

#[test]
fn an_expired_verdict_can_be_written_again() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Warn, ttl(1)), T0);
    assert_eq!(verdict_at(&registry, T0 + 2 * SECOND), None);
    oracle_sets(
        &mut registry,
        with_ttl(Verdict::Deny, ttl(1)),
        T0 + 2 * SECOND,
    );
    assert_eq!(verdict_at(&registry, T0 + 2 * SECOND), Some(Verdict::Deny));
}

#[test]
fn list_verdicts_still_shows_an_expired_verdict_with_its_deadline() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(1)), T0);
    call(&stranger(), NO_DEPOSIT, T0 + 2 * SECOND);
    assert_eq!(registry.get_verdict(payee()), None);
    let listed = registry.list_verdicts(None, None);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].verdict, Verdict::Deny);
    assert_eq!(listed[0].expires_at_ns, Some(U64(T0 + SECOND)));
}

#[test]
fn an_expired_verdict_can_be_cleared_and_the_clear_is_logged() {
    let mut registry = fresh();
    oracle_sets(&mut registry, with_ttl(Verdict::Deny, ttl(1)), T0);
    call(&oracle(), NO_DEPOSIT, T0 + 2 * SECOND);
    registry.clear_verdict(payee());
    assert_eq!(event_names(), vec!["verdict_cleared"]);
    assert!(registry.list_verdicts(None, None).is_empty());
}

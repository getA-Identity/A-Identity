//! `report` and `clear_reports`: the deposit, self-report, one open report per reporter,
//! the per-account cap, the order of the rules, the lifetime counter, the review cycle, and
//! that the deposit really does cover the storage a report takes.

use super::*;
use crate::{
    CheckVerdict, MAX_CODE_LEN, MAX_EVIDENCE_LEN, MAX_OPEN_REPORTS, REPORT_DEPOSIT, ReportView,
};
use near_sdk::env;
use near_sdk::serde_json::json;

fn reporter(i: usize) -> AccountId {
    acc(&format!("reporter{i}.near"))
}

/// `who` reports `payee()` with the exact deposit.
fn file(registry: &mut Registry, who: &AccountId, now_ns: u64) {
    call(who, REPORT_DEPOSIT, now_ns);
    registry.report(payee(), "drainer".to_string(), "tx:9f2c".to_string());
}

fn below(deposit: NearToken) -> NearToken {
    NearToken::from_yoctonear(deposit.as_yoctonear() - 1)
}

// -- filing -------------------------------------------------------------------------------

#[test]
fn a_report_with_the_exact_deposit_is_stored_counted_and_logged() {
    let mut registry = fresh();
    file(&mut registry, &stranger(), T0);
    assert_eq!(
        registry.get_reports(payee()),
        vec![ReportView {
            reporter: stranger(),
            reason: "drainer".to_string(),
            evidence: "tx:9f2c".to_string(),
            at_ns: U64(T0),
        }]
    );
    assert_eq!(registry.report_count(payee()), 1);
    let events = events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "report_filed");
    assert_eq!(
        events[0]["data"],
        json!({
            "account_id": "payee.near",
            "reporter": "stranger.near",
            "reason": "drainer",
            "evidence": "tx:9f2c",
        })
    );
}

#[test]
fn the_deposit_is_one_hundredth_of_a_near() {
    assert_eq!(REPORT_DEPOSIT.as_yoctonear(), 10u128.pow(22));
}

#[test]
fn a_report_below_the_deposit_is_refused() {
    let mut registry = fresh();
    for deposit in [NO_DEPOSIT, ONE_YOCTO, below(REPORT_DEPOSIT)] {
        call(&stranger(), deposit, T0);
        expect_err(Error::ReportDepositTooLow, || {
            registry.report(payee(), "drainer".to_string(), "tx:1".to_string())
        });
    }
    assert!(registry.get_reports(payee()).is_empty());
    assert_eq!(registry.report_count(payee()), 0);
}

#[test]
fn a_report_above_the_deposit_is_accepted_and_the_excess_kept() {
    let mut registry = fresh();
    call(&stranger(), NearToken::from_near(1), T0);
    registry.report(payee(), "drainer".to_string(), "tx:1".to_string());
    assert_eq!(registry.report_count(payee()), 1);
    // Kept, not refunded: the call schedules no transfer back.
    assert!(near_sdk::test_utils::get_created_receipts().is_empty());
}

#[test]
fn an_account_cannot_report_itself() {
    let mut registry = fresh();
    call(&payee(), REPORT_DEPOSIT, T0);
    expect_err(Error::SelfReport, || {
        registry.report(payee(), "drainer".to_string(), "tx:1".to_string())
    });
    assert!(registry.get_reports(payee()).is_empty());
}

#[test]
fn a_reporter_has_one_open_report_per_account() {
    let mut registry = fresh();
    file(&mut registry, &stranger(), T0);
    call(&stranger(), REPORT_DEPOSIT, T0 + 1);
    expect_err(Error::DuplicateReport, || {
        registry.report(payee(), "phishing".to_string(), "other".to_string())
    });
    // A different reporter on the same account, and the same reporter on another account.
    file(&mut registry, &reporter(1), T0 + 2);
    call(&stranger(), REPORT_DEPOSIT, T0 + 3);
    registry.report(acc("other.near"), "drainer".to_string(), "tx:1".to_string());
    assert_eq!(registry.get_reports(payee()).len(), 2);
    assert_eq!(registry.get_reports(acc("other.near")).len(), 1);
}

#[test]
fn an_account_takes_twenty_open_reports_and_refuses_the_next() {
    let mut registry = fresh();
    for i in 0..MAX_OPEN_REPORTS {
        file(&mut registry, &reporter(i), T0 + i as u64);
    }
    assert_eq!(registry.get_reports(payee()).len(), MAX_OPEN_REPORTS);
    call(&reporter(MAX_OPEN_REPORTS), REPORT_DEPOSIT, T0);
    expect_err(Error::ReportLimitReached, || {
        registry.report(payee(), "drainer".to_string(), "tx:1".to_string())
    });
    assert_eq!(registry.report_count(payee()), MAX_OPEN_REPORTS as u32);
    // The open list is oldest first.
    let at: Vec<u64> = registry
        .get_reports(payee())
        .iter()
        .map(|r| r.at_ns.0)
        .collect();
    assert_eq!(
        at,
        (0..MAX_OPEN_REPORTS as u64)
            .map(|i| T0 + i)
            .collect::<Vec<_>>()
    );
}

#[test]
fn a_full_list_refuses_by_cap_and_a_repeat_reporter_by_duplicate() {
    let mut registry = fresh();
    for i in 0..MAX_OPEN_REPORTS {
        file(&mut registry, &reporter(i), T0);
    }
    // Both rules apply to reporter(0) on a full list; the duplicate is the answer.
    call(&reporter(0), REPORT_DEPOSIT, T0);
    expect_err(Error::DuplicateReport, || {
        registry.report(payee(), "drainer".to_string(), "tx:1".to_string())
    });
}

#[test]
fn the_reason_must_be_one_valid_code() {
    let mut registry = fresh();
    for reason in [
        String::new(),
        "Drainer".to_string(),
        "drain er".to_string(),
        "drain-er".to_string(),
        bytes('a', MAX_CODE_LEN + 1),
    ] {
        call(&stranger(), REPORT_DEPOSIT, T0);
        expect_err(Error::InvalidReason, || {
            registry.report(payee(), reason, "tx:1".to_string())
        });
    }
    call(&stranger(), REPORT_DEPOSIT, T0);
    registry.report(payee(), bytes('a', MAX_CODE_LEN), "tx:1".to_string());
}

#[test]
fn evidence_of_256_bytes_is_accepted_and_257_refused() {
    let mut registry = fresh();
    call(&stranger(), REPORT_DEPOSIT, T0);
    expect_err(Error::EvidenceTooLong, || {
        registry.report(
            payee(),
            "drainer".to_string(),
            bytes('e', MAX_EVIDENCE_LEN + 1),
        )
    });
    call(&stranger(), REPORT_DEPOSIT, T0);
    registry.report(payee(), "drainer".to_string(), bytes('e', MAX_EVIDENCE_LEN));
    call(&reporter(1), REPORT_DEPOSIT, T0);
    registry.report(payee(), "drainer".to_string(), String::new());
    assert_eq!(registry.get_reports(payee()).len(), 2);
}

#[test]
fn the_rules_fire_in_their_documented_order() {
    let mut registry = fresh();
    file(&mut registry, &stranger(), T0);
    for i in 0..MAX_OPEN_REPORTS - 1 {
        file(&mut registry, &reporter(i), T0);
    }
    // The list is full and stranger() is already on it. One call that breaks every rule,
    // repaired one rule at a time: each repair moves the refusal to the next rule in the
    // order the method documents.
    let bad_reason = "BAD".to_string();
    let long = bytes('e', MAX_EVIDENCE_LEN + 1);
    call(&payee(), NO_DEPOSIT, T0);
    expect_err(Error::ReportDepositTooLow, || {
        registry.report(payee(), bad_reason.clone(), long.clone())
    });
    call(&payee(), REPORT_DEPOSIT, T0);
    expect_err(Error::SelfReport, || {
        registry.report(payee(), bad_reason.clone(), long.clone())
    });
    call(&stranger(), REPORT_DEPOSIT, T0);
    expect_err(Error::InvalidReason, || {
        registry.report(payee(), bad_reason.clone(), long.clone())
    });
    expect_err(Error::EvidenceTooLong, || {
        registry.report(payee(), "drainer".to_string(), long.clone())
    });
    expect_err(Error::DuplicateReport, || {
        registry.report(payee(), "drainer".to_string(), "ok".to_string())
    });
    call(&acc("late.near"), REPORT_DEPOSIT, T0);
    expect_err(Error::ReportLimitReached, || {
        registry.report(payee(), "drainer".to_string(), "ok".to_string())
    });
}

#[test]
fn a_lifetime_counter_at_its_maximum_refuses_rather_than_wrapping() {
    let mut registry = fresh();
    registry.report_count.insert(payee(), u32::MAX);
    call(&stranger(), REPORT_DEPOSIT, T0);
    expect_err(Error::MathOverflow, || {
        registry.report(payee(), "drainer".to_string(), "tx:1".to_string())
    });
    assert!(registry.get_reports(payee()).is_empty());
    assert_eq!(registry.report_count(payee()), u32::MAX);
}

#[test]
fn a_report_never_changes_the_verdict() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Allow), T0);
    for i in 0..MAX_OPEN_REPORTS {
        file(&mut registry, &reporter(i), T0);
    }
    assert_eq!(
        registry.get_verdict(payee()).unwrap().verdict,
        Verdict::Allow
    );
    let check = registry.check(payee());
    assert_eq!(check.verdict, CheckVerdict::Allow);
    assert_eq!(check.reports, MAX_OPEN_REPORTS as u32);
}

#[test]
fn a_contract_reports_as_itself() {
    let mut registry = fresh();
    // A user signed; their wallet contract is the predecessor, and the reporter.
    call_signed(&stranger(), &acc("wallet.near"), REPORT_DEPOSIT, T0);
    registry.report(payee(), "drainer".to_string(), "tx:1".to_string());
    assert_eq!(
        registry.get_reports(payee())[0].reporter,
        acc("wallet.near")
    );
}

// -- the review cycle ---------------------------------------------------------------------

#[test]
fn an_oracle_clears_open_reports_and_the_lifetime_count_stays() {
    let mut registry = fresh();
    file(&mut registry, &stranger(), T0);
    file(&mut registry, &reporter(1), T0);
    call(&oracle(), NO_DEPOSIT, T0 + 1);
    registry.clear_reports(payee());
    assert!(registry.get_reports(payee()).is_empty());
    assert_eq!(registry.report_count(payee()), 2);
    assert_eq!(registry.check(payee()).reports, 0);
    let events = events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "reports_cleared");
    assert_eq!(
        events[0]["data"],
        json!({ "account_id": "payee.near", "by": "oracle.near" })
    );
}

#[test]
fn after_a_review_the_same_reporter_may_report_again() {
    let mut registry = fresh();
    file(&mut registry, &stranger(), T0);
    call(&oracle(), NO_DEPOSIT, T0);
    registry.clear_reports(payee());
    file(&mut registry, &stranger(), T0 + 1);
    assert_eq!(registry.get_reports(payee()).len(), 1);
    assert_eq!(registry.report_count(payee()), 2);
}

#[test]
fn after_a_review_a_full_account_takes_reports_again() {
    let mut registry = fresh();
    for i in 0..MAX_OPEN_REPORTS {
        file(&mut registry, &reporter(i), T0);
    }
    call(&oracle(), NO_DEPOSIT, T0);
    registry.clear_reports(payee());
    file(&mut registry, &reporter(MAX_OPEN_REPORTS), T0);
    assert_eq!(registry.get_reports(payee()).len(), 1);
    assert_eq!(registry.report_count(payee()), MAX_OPEN_REPORTS as u32 + 1);
}

#[test]
fn clearing_no_open_reports_is_a_silent_no_op() {
    let mut registry = fresh();
    call(&oracle(), NO_DEPOSIT, T0);
    registry.clear_reports(payee());
    assert!(events().is_empty());
}

#[test]
fn only_an_oracle_can_clear_reports() {
    let mut registry = fresh();
    file(&mut registry, &stranger(), T0);
    for caller in [stranger(), owner(), payee()] {
        call(&caller, NO_DEPOSIT, T0);
        expect_err(Error::NotOracle, || registry.clear_reports(payee()));
    }
    assert_eq!(registry.get_reports(payee()).len(), 1);
}

#[test]
fn clearing_reports_leaves_the_verdict_alone() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Deny), T0);
    file(&mut registry, &stranger(), T0);
    call(&oracle(), NO_DEPOSIT, T0);
    registry.clear_reports(payee());
    assert_eq!(
        registry.get_verdict(payee()).unwrap().verdict,
        Verdict::Deny
    );
}

// -- the deposit pays for the storage -----------------------------------------------------

/// Storage bytes a report adds, measured on the mocked trie after flushing.
fn storage_added_by(registry: &mut Registry, subject: &AccountId, who: &AccountId) -> u64 {
    call(who, REPORT_DEPOSIT, T0);
    let before = env::storage_usage();
    registry.report(
        subject.clone(),
        bytes('r', MAX_CODE_LEN),
        bytes('e', MAX_EVIDENCE_LEN),
    );
    registry.reports.flush();
    registry.report_count.flush();
    env::storage_usage() - before
}

#[test]
fn the_deposit_covers_the_storage_of_a_maximal_report() {
    let mut registry = fresh();
    // The longest account ids there are, on both sides.
    let subject = acc(&bytes('s', 64));
    let first = storage_added_by(
        &mut registry,
        &subject,
        &acc(&format!("{}00", bytes('p', 62))),
    );
    let mut largest = first;
    for i in 1..MAX_OPEN_REPORTS {
        let who = acc(&format!("{}{i:02}", bytes('p', 62)));
        largest = largest.max(storage_added_by(&mut registry, &subject, &who));
    }
    assert_eq!(
        registry.get_reports(subject.clone()).len(),
        MAX_OPEN_REPORTS
    );

    let cost = |bytes: u64| u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
    // The first report also creates the account's list and counter, so it is the largest.
    assert_eq!(largest, first);
    assert!(
        cost(first) <= REPORT_DEPOSIT.as_yoctonear(),
        "a maximal first report takes {first} bytes, {} yocto, against a deposit of {}",
        cost(first),
        REPORT_DEPOSIT.as_yoctonear()
    );
    // The crate documents about 600 bytes; hold the claim to the measurement.
    assert!((500..=700).contains(&first), "{first} bytes");
}

//! The pure rules in `rules.rs`, exhaustively where the domain allows: every byte value for
//! the reason alphabet, every boundary for every length, both edges of every deadline.

use crate::Error;
use crate::rules::*;
use crate::types::{Report, Verdict, VerdictInput};
use near_sdk::json_types::U64;
use near_sdk::{AccountId, NearToken};

fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}

#[test]
fn the_reason_alphabet_is_exactly_lowercase_digits_and_underscore() {
    for byte in 0u8..=255 {
        let allowed = byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_';
        // Every byte, alone and between valid neighbours. A non-ASCII byte alone is not a
        // valid &str, so those are checked as the second byte of a two-byte character.
        if byte.is_ascii() {
            let alone = String::from(byte as char);
            let framed = format!("a{}a", byte as char);
            let want = if allowed {
                Ok(())
            } else {
                Err(Error::InvalidReason)
            };
            assert_eq!(check_code(&alone), want, "byte {byte:#04x}");
            assert_eq!(check_code(&framed), want, "byte {byte:#04x} framed");
        }
    }
    for non_ascii in ["\u{e9}", "\u{430}", "\u{ff3f}", "\u{1f600}"] {
        assert_eq!(
            check_code(non_ascii),
            Err(Error::InvalidReason),
            "{non_ascii:?}"
        );
    }
}

#[test]
fn a_reason_code_is_one_to_thirty_two_bytes() {
    assert_eq!(check_code(""), Err(Error::InvalidReason));
    for len in 1..=MAX_CODE_LEN {
        assert_eq!(check_code(&"a".repeat(len)), Ok(()), "{len}");
    }
    assert_eq!(
        check_code(&"a".repeat(MAX_CODE_LEN + 1)),
        Err(Error::InvalidReason)
    );
    assert_eq!(check_code(&"a".repeat(10_000)), Err(Error::InvalidReason));
}

#[test]
fn reasons_are_counted_before_they_are_read() {
    let ok = |n: usize| vec!["a".to_string(); n];
    for n in 0..=MAX_REASONS {
        assert_eq!(check_reasons(&ok(n)), Ok(()));
    }
    assert_eq!(
        check_reasons(&ok(MAX_REASONS + 1)),
        Err(Error::TooManyReasons)
    );
    let bad = vec!["NOPE".to_string(); MAX_REASONS + 1];
    assert_eq!(check_reasons(&bad), Err(Error::TooManyReasons));
    let one_bad = vec!["a".to_string(), "b".to_string(), "C".to_string()];
    assert_eq!(check_reasons(&one_bad), Err(Error::InvalidReason));
}

#[test]
fn evidence_and_code_hash_lengths_are_bytes_with_inclusive_bounds() {
    assert_eq!(check_evidence(""), Ok(()));
    assert_eq!(check_evidence(&"e".repeat(MAX_EVIDENCE_LEN)), Ok(()));
    assert_eq!(
        check_evidence(&"e".repeat(MAX_EVIDENCE_LEN + 1)),
        Err(Error::EvidenceTooLong)
    );
    // 128 two-byte characters are exactly 256 bytes; one more character is not.
    assert_eq!(check_evidence(&"\u{e9}".repeat(128)), Ok(()));
    assert_eq!(
        check_evidence(&"\u{e9}".repeat(129)),
        Err(Error::EvidenceTooLong)
    );

    assert_eq!(check_code_hash(None), Ok(()));
    assert_eq!(check_code_hash(Some("")), Ok(()));
    assert_eq!(
        check_code_hash(Some(&"h".repeat(MAX_CODE_HASH_LEN))),
        Ok(())
    );
    assert_eq!(
        check_code_hash(Some(&"h".repeat(MAX_CODE_HASH_LEN + 1))),
        Err(Error::CodeHashTooLong)
    );
}

#[test]
fn every_score_from_0_to_1000_passes_and_every_other_fails() {
    assert_eq!(check_score(None), Ok(()));
    for score in 0..=u16::MAX {
        let want = if score <= MAX_SCORE {
            Ok(())
        } else {
            Err(Error::ScoreOutOfRange)
        };
        assert_eq!(check_score(Some(score)), want, "{score}");
    }
}

#[test]
fn expiry_absent_or_zero_is_none_and_otherwise_checked() {
    assert_eq!(expiry_ns(123, None), Ok(None));
    assert_eq!(expiry_ns(123, Some(0)), Ok(None));
    assert_eq!(expiry_ns(0, Some(1)), Ok(Some(1_000_000_000)));
    assert_eq!(expiry_ns(5, Some(2)), Ok(Some(2_000_000_005)));
    // The multiplication's edge.
    let largest = u64::MAX / 1_000_000_000;
    assert_eq!(
        expiry_ns(0, Some(largest)),
        Ok(Some(largest * 1_000_000_000))
    );
    assert_eq!(expiry_ns(0, Some(largest + 1)), Err(Error::MathOverflow));
    assert_eq!(expiry_ns(0, Some(u64::MAX)), Err(Error::MathOverflow));
    // The addition's edge.
    assert_eq!(
        expiry_ns(u64::MAX - 1_000_000_000, Some(1)),
        Ok(Some(u64::MAX))
    );
    assert_eq!(
        expiry_ns(u64::MAX - 999_999_999, Some(1)),
        Err(Error::MathOverflow)
    );
    assert_eq!(expiry_ns(u64::MAX, Some(1)), Err(Error::MathOverflow));
}

#[test]
fn liveness_is_inclusive_of_the_deadline() {
    assert!(is_live(None, 0));
    assert!(is_live(None, u64::MAX));
    assert!(is_live(Some(10), 0));
    assert!(is_live(Some(10), 9));
    assert!(is_live(Some(10), 10));
    assert!(!is_live(Some(10), 11));
    assert!(is_live(Some(0), 0));
    assert!(!is_live(Some(0), 1));
    assert!(is_live(Some(u64::MAX), u64::MAX));
}

fn input() -> VerdictInput {
    VerdictInput {
        account_id: acc("payee.near"),
        verdict: Verdict::Deny,
        reasons: vec!["ok".to_string()],
        evidence: Some("e".to_string()),
        score: Some(1),
        code_hash: Some("h".to_string()),
        ttl_s: Some(U64(1)),
    }
}

#[test]
fn a_verdict_input_returns_its_deadline_when_every_rule_passes() {
    assert_eq!(check_verdict_input(&input(), 7), Ok(Some(1_000_000_007)));
    let no_ttl = VerdictInput {
        ttl_s: None,
        ..input()
    };
    assert_eq!(check_verdict_input(&no_ttl, 7), Ok(None));
    let no_evidence = VerdictInput {
        evidence: None,
        ..input()
    };
    assert_eq!(
        check_verdict_input(&no_evidence, 7),
        Ok(Some(1_000_000_007))
    );
}

#[test]
fn the_deposit_is_checked_first_and_inclusive() {
    let a = acc("a.near");
    let b = acc("b.near");
    let below = NearToken::from_yoctonear(REPORT_DEPOSIT.as_yoctonear() - 1);
    assert_eq!(check_new_report(REPORT_DEPOSIT, &a, &b, "x", ""), Ok(()));
    assert_eq!(
        check_new_report(below, &a, &b, "x", ""),
        Err(Error::ReportDepositTooLow)
    );
    // Underfunded and self and bad reason and long evidence: the deposit is the answer.
    let long = "e".repeat(MAX_EVIDENCE_LEN + 1);
    assert_eq!(
        check_new_report(below, &a, &a, "BAD", &long),
        Err(Error::ReportDepositTooLow)
    );
    assert_eq!(
        check_new_report(REPORT_DEPOSIT, &a, &a, "BAD", &long),
        Err(Error::SelfReport)
    );
    assert_eq!(
        check_new_report(REPORT_DEPOSIT, &a, &b, "BAD", &long),
        Err(Error::InvalidReason)
    );
    assert_eq!(
        check_new_report(REPORT_DEPOSIT, &a, &b, "x", &long),
        Err(Error::EvidenceTooLong)
    );
}

fn report(by: &str) -> Report {
    Report {
        reporter: acc(by),
        reason: "x".to_string(),
        evidence: String::new(),
        at_ns: 0,
    }
}

#[test]
fn open_reports_refuse_a_duplicate_before_the_cap() {
    let me = acc("me.near");
    assert_eq!(check_open_reports(&[], &me), Ok(()));
    let others: Vec<Report> = (0..MAX_OPEN_REPORTS - 1)
        .map(|i| report(&format!("r{i}.near")))
        .collect();
    assert_eq!(check_open_reports(&others, &me), Ok(()));
    let mut full = others.clone();
    full.push(report("last.near"));
    assert_eq!(
        check_open_reports(&full, &me),
        Err(Error::ReportLimitReached)
    );
    let mut full_with_me = others;
    full_with_me.push(report("me.near"));
    assert_eq!(
        check_open_reports(&full_with_me, &me),
        Err(Error::DuplicateReport)
    );
    assert_eq!(
        check_open_reports(&[report("me.near")], &me),
        Err(Error::DuplicateReport)
    );
}

#[test]
fn the_report_counter_refuses_to_wrap() {
    assert_eq!(next_report_count(0), Ok(1));
    assert_eq!(next_report_count(u32::MAX - 1), Ok(u32::MAX));
    assert_eq!(next_report_count(u32::MAX), Err(Error::MathOverflow));
}

#[test]
fn the_log_budget_is_inclusive() {
    let line = |n: usize| "x".repeat(n);
    assert_eq!(check_log_budget(&[]), Ok(()));
    assert_eq!(check_log_budget(&[line(MAX_LOG_BYTES)]), Ok(()));
    assert_eq!(
        check_log_budget(&[line(MAX_LOG_BYTES + 1)]),
        Err(Error::BatchTooLarge)
    );
    assert_eq!(
        check_log_budget(&[line(MAX_LOG_BYTES - 10), line(10)]),
        Ok(())
    );
    assert_eq!(
        check_log_budget(&[line(MAX_LOG_BYTES - 10), line(11)]),
        Err(Error::BatchTooLarge)
    );
}

#[test]
fn a_page_is_skip_and_take_with_defaults_and_a_ceiling() {
    assert_eq!(page(None, None), (0, DEFAULT_PAGE as usize));
    assert_eq!(page(Some(7), Some(3)), (7, 3));
    assert_eq!(page(None, Some(0)), (0, 0));
    assert_eq!(page(None, Some(MAX_PAGE)), (0, MAX_PAGE as usize));
    assert_eq!(page(None, Some(MAX_PAGE + 1)), (0, MAX_PAGE as usize));
    assert_eq!(page(None, Some(u64::MAX)), (0, MAX_PAGE as usize));
    // Never wraps: an index that does not fit usize skips everything.
    let (skip, _) = page(Some(u64::MAX), None);
    assert_eq!(skip, usize::try_from(u64::MAX).unwrap_or(usize::MAX));
}

#[test]
fn the_limits_are_the_ones_the_spec_states() {
    assert_eq!(MAX_ORACLES, 10);
    assert_eq!(MAX_REASONS, 8);
    assert_eq!(MAX_CODE_LEN, 32);
    assert_eq!(MAX_EVIDENCE_LEN, 256);
    assert_eq!(MAX_CODE_HASH_LEN, 64);
    assert_eq!(MAX_SCORE, 1000);
    assert_eq!(MAX_BATCH, 20);
    assert_eq!(MAX_OPEN_REPORTS, 20);
    assert_eq!(REPORT_DEPOSIT, NearToken::from_millinear(10));
}

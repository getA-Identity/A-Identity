//! `set_verdicts`: the entry bound, all-or-nothing validation, the log budget, and that
//! a batch entry obeys exactly the rules a single write does.

use super::*;
use crate::{
    MAX_BATCH, MAX_CODE_HASH_LEN, MAX_CODE_LEN, MAX_EVIDENCE_LEN, MAX_LOG_BYTES, MAX_REASONS,
};
use near_sdk::test_utils::get_logs;

fn subject(i: usize) -> AccountId {
    acc(&format!("payee{i}.near"))
}

fn batch(n: usize) -> Vec<VerdictInput> {
    (0..n).map(|i| entry(&subject(i), Verdict::Deny)).collect()
}

/// An entry as large as every rule allows, on a 64-byte account id, with evidence that
/// is plain ASCII, the way a URL or a hash is.
fn maximal(i: usize) -> VerdictInput {
    let account_id = acc(&format!("{}{:02}", bytes('m', 62), i));
    VerdictInput {
        account_id,
        verdict: Verdict::Deny,
        reasons: (0..MAX_REASONS)
            .map(|r| format!("{}{r}", bytes('r', MAX_CODE_LEN - 1)))
            .collect(),
        evidence: Some(bytes('e', MAX_EVIDENCE_LEN)),
        score: Some(1000),
        code_hash: Some(bytes('h', MAX_CODE_HASH_LEN)),
        ttl_s: None,
    }
}

/// The same, but with evidence that JSON has to escape: every control byte becomes six
/// (`\u0001`), so 256 bytes of evidence log as 1536. The length rule is on stored bytes,
/// which is what storage costs; the log limit is on logged bytes, which is what this is.
fn worst(i: usize) -> VerdictInput {
    VerdictInput {
        evidence: Some(bytes('\u{1}', MAX_EVIDENCE_LEN)),
        ..maximal(i)
    }
}

#[test]
fn a_full_batch_is_written_and_logged_in_order() {
    let mut registry = fresh();
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(batch(MAX_BATCH));
    for i in 0..MAX_BATCH {
        let view = registry.get_verdict(subject(i)).unwrap();
        assert_eq!(view.verdict, Verdict::Deny);
        assert_eq!(view.updated_by, oracle());
        assert_eq!(view.updated_at_ns, U64(T0));
    }
    let events = events();
    assert_eq!(events.len(), MAX_BATCH);
    for (i, event) in events.iter().enumerate() {
        assert_eq!(event["event"], "verdict_set");
        assert_eq!(event["data"]["account_id"], subject(i).as_str());
    }
}

#[test]
fn one_entry_over_the_bound_is_refused() {
    let mut registry = fresh();
    call(&oracle(), NO_DEPOSIT, T0);
    expect_err(Error::BatchTooLarge, || {
        registry.set_verdicts(batch(MAX_BATCH + 1))
    });
    assert!(registry.list_verdicts(None, None).is_empty());
}

#[test]
fn the_entry_bound_is_checked_before_any_entry() {
    let mut registry = fresh();
    let mut entries = batch(MAX_BATCH + 1);
    entries[0].reasons = vec!["BAD".to_string()];
    call(&oracle(), NO_DEPOSIT, T0);
    expect_err(Error::BatchTooLarge, || registry.set_verdicts(entries));
}

#[test]
fn an_empty_batch_is_a_no_op() {
    let mut registry = fresh();
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(Vec::new());
    assert!(registry.list_verdicts(None, None).is_empty());
    assert!(events().is_empty());
}

#[test]
fn only_an_oracle_can_write_a_batch() {
    let mut registry = fresh();
    for caller in [stranger(), owner()] {
        call(&caller, NO_DEPOSIT, T0);
        expect_err(Error::NotOracle, || registry.set_verdicts(batch(1)));
    }
}

#[test]
fn one_bad_entry_refuses_the_whole_batch_and_writes_nothing() {
    let mut registry = fresh();
    let mut entries = batch(3);
    entries[2].score = Some(1001);
    call(&oracle(), NO_DEPOSIT, T0);
    expect_err(Error::ScoreOutOfRange, || registry.set_verdicts(entries));
    // Not even the entries before the bad one: validation finishes before any write.
    for i in 0..3 {
        assert_eq!(registry.get_verdict(subject(i)), None);
    }
    assert!(get_logs().is_empty());
}

#[test]
fn a_batch_entry_obeys_every_single_write_rule() {
    let mut registry = fresh();
    // Each case breaks one rule on the second entry of an otherwise valid batch.
    type Breaks = fn(&mut VerdictInput);
    let cases: [(Error, Breaks); 6] = [
        (Error::TooManyReasons, |e| {
            e.reasons = vec!["a".to_string(); MAX_REASONS + 1]
        }),
        (Error::InvalidReason, |e| e.reasons = vec!["A".to_string()]),
        (Error::EvidenceTooLong, |e| {
            e.evidence = Some(bytes('e', MAX_EVIDENCE_LEN + 1))
        }),
        (Error::ScoreOutOfRange, |e| e.score = Some(1001)),
        (Error::CodeHashTooLong, |e| {
            e.code_hash = Some(bytes('h', MAX_CODE_HASH_LEN + 1))
        }),
        (Error::MathOverflow, |e| e.ttl_s = ttl(u64::MAX)),
    ];
    for (want, breaks) in cases {
        let mut entries = batch(2);
        breaks(&mut entries[1]);
        call(&oracle(), NO_DEPOSIT, T0);
        expect_err(want, || registry.set_verdicts(entries));
    }
    assert!(registry.list_verdicts(None, None).is_empty());
}

#[test]
fn entries_for_the_same_account_apply_in_order() {
    let mut registry = fresh();
    let entries = vec![
        entry(&payee(), Verdict::Deny),
        entry(&payee(), Verdict::Warn),
        entry(&payee(), Verdict::Allow),
    ];
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(entries);
    assert_eq!(
        registry.get_verdict(payee()).unwrap().verdict,
        Verdict::Allow
    );
    assert_eq!(registry.list_verdicts(None, None).len(), 1);
    // Each write is still in the history.
    let verdicts: Vec<Value> = events()
        .iter()
        .map(|e| e["data"]["verdict"].clone())
        .collect();
    assert_eq!(verdicts, vec!["DENY", "WARN", "ALLOW"]);
}

#[test]
fn each_entry_gets_its_own_ttl() {
    let mut registry = fresh();
    let mut entries = batch(3);
    entries[0].ttl_s = ttl(10);
    entries[1].ttl_s = None;
    entries[2].ttl_s = ttl(0);
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(entries);
    let deadlines: Vec<Option<U64>> = (0..3)
        .map(|i| registry.get_verdict(subject(i)).unwrap().expires_at_ns)
        .collect();
    assert_eq!(deadlines, vec![Some(U64(T0 + 10_000_000_000)), None, None]);
}

// -- the log budget -----------------------------------------------------------------------

#[test]
fn a_full_batch_of_full_size_entries_with_plain_evidence_fits() {
    // The bound is reachable with real content: twenty entries at every length limit, with
    // URL-like evidence, log under the runtime limit and are written.
    let mut registry = fresh();
    let entries: Vec<VerdictInput> = (0..MAX_BATCH).map(maximal).collect();
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(entries);
    assert_eq!(registry.list_verdicts(None, None).len(), MAX_BATCH);
    let logged: usize = get_logs().iter().map(String::len).sum();
    assert!(logged <= MAX_LOG_BYTES, "{logged}");
}

#[test]
fn a_full_batch_that_would_overflow_the_log_is_refused_by_name() {
    let mut registry = fresh();
    let entries: Vec<VerdictInput> = (0..MAX_BATCH).map(worst).collect();
    call(&oracle(), NO_DEPOSIT, T0);
    // Refused by this contract's own check, with a name, before the runtime would have
    // refused it with TotalLogLengthExceeded, and before anything was written.
    expect_err(Error::BatchTooLarge, || registry.set_verdicts(entries));
    assert!(registry.list_verdicts(None, None).is_empty());
    assert!(get_logs().is_empty());
}

#[test]
fn the_mocked_runtime_enforces_the_limit_the_budget_mirrors() {
    // Without this, the next test's "the runtime accepted it" would prove nothing.
    call(&oracle(), NO_DEPOSIT, T0);
    near_sdk::env::log_str(&bytes('x', MAX_LOG_BYTES));
    let overflow = std::panic::catch_unwind(|| near_sdk::env::log_str("x"));
    let payload = overflow.expect_err("one byte past the limit must be refused");
    let message = payload
        .downcast_ref::<String>()
        .cloned()
        .unwrap_or_default();
    assert!(message.contains("TotalLogLengthExceeded"), "{message}");
}

#[test]
fn a_batch_the_budget_admits_fits_the_runtime_limit_it_mirrors() {
    let mut registry = fresh();
    // Every worst-case entry renders to the same length: measure one.
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(vec![worst(0)]);
    let one = get_logs()[0].len();
    let n = MAX_LOG_BYTES / one;
    assert!(
        (1..MAX_BATCH).contains(&n),
        "worst-case entries per batch: {n}"
    );

    // The most that fit is written, and the mocked runtime, which enforces the real
    // max_total_log_length, accepts its logs. A budget looser than the runtime's would make
    // this write fail inside the runtime instead.
    let entries: Vec<VerdictInput> = (1..=n).map(worst).collect();
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(entries);
    let logged: usize = get_logs().iter().map(String::len).sum();
    assert!(logged <= MAX_LOG_BYTES);
    assert_eq!(get_logs().len(), n);

    // One more is what tips it over, and it is refused by name.
    let over: Vec<VerdictInput> = (1..=n + 1).map(worst).collect();
    call(&oracle(), NO_DEPOSIT, T0);
    expect_err(Error::BatchTooLarge, || registry.set_verdicts(over));
}

#[test]
fn the_logged_lines_are_the_ones_that_were_measured() {
    let mut registry = fresh();
    call(&oracle(), NO_DEPOSIT, T0);
    registry.set_verdicts(batch(2));
    let logs = get_logs();
    assert_eq!(logs.len(), 2);
    for line in logs {
        assert!(line.starts_with(
            "EVENT_JSON:{\"standard\":\"a_identity_registry\",\"version\":\"1.0.0\",\"event\":\"verdict_set\",\"data\":{"
        ));
    }
}

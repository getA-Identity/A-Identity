//! `set_verdict` and `clear_verdict`: who may write, what a write stores and logs, every
//! input rule at and past its boundary, the order the rules fire in, and that a refused
//! write leaves the old verdict alone.

use super::*;
use crate::{
    MAX_CODE_HASH_LEN, MAX_CODE_LEN, MAX_EVIDENCE_LEN, MAX_REASONS, MAX_SCORE, VerdictView,
};
use near_sdk::serde_json::json;

fn reasons(n: usize) -> Vec<String> {
    (0..n).map(|i| format!("code_{i}")).collect()
}

// -- who may write ------------------------------------------------------------------------

#[test]
fn an_oracle_writes_a_verdict() {
    let mut registry = fresh();
    let input = VerdictInput {
        account_id: payee(),
        verdict: Verdict::Deny,
        reasons: vec!["drainer".to_string(), "kya_revoked".to_string()],
        evidence: Some("https://a-identity.xyz/e/42".to_string()),
        score: Some(120),
        code_hash: Some("8Yk1v3Lq9e2wZb4cRt7uHn5sJm6pXd2aQf8gVh3kEo1".to_string()),
        ttl_s: None,
    };
    oracle_sets(&mut registry, input, T0);

    assert_eq!(
        registry.get_verdict(payee()),
        Some(VerdictView {
            account_id: payee(),
            verdict: Verdict::Deny,
            reasons: vec!["drainer".to_string(), "kya_revoked".to_string()],
            evidence: Some("https://a-identity.xyz/e/42".to_string()),
            score: Some(120),
            code_hash: Some("8Yk1v3Lq9e2wZb4cRt7uHn5sJm6pXd2aQf8gVh3kEo1".to_string()),
            updated_at_ns: U64(T0),
            updated_by: oracle(),
            expires_at_ns: None,
        })
    );
}

#[test]
fn a_write_logs_verdict_set_with_what_was_stored() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Warn), T0);
    let events = events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "verdict_set");
    assert_eq!(
        events[0]["data"],
        json!({
            "account_id": "payee.near",
            "verdict": "WARN",
            "reasons": ["test_reason"],
            "evidence": "https://a-identity.xyz/e/1",
            "by": "oracle.near",
        })
    );
}

#[test]
fn a_write_without_evidence_logs_null_evidence() {
    let mut registry = fresh();
    let mut input = entry(&payee(), Verdict::Allow);
    input.evidence = None;
    input.reasons = Vec::new();
    oracle_sets(&mut registry, input, T0);
    assert_eq!(events()[0]["data"]["evidence"], Value::Null);
    assert_eq!(events()[0]["data"]["reasons"], json!([]));
}

#[test]
fn a_stranger_cannot_write() {
    let mut registry = fresh();
    call(&stranger(), NO_DEPOSIT, T0);
    expect_err(Error::NotOracle, || {
        set(&mut registry, entry(&payee(), Verdict::Allow))
    });
    assert_eq!(registry.get_verdict(payee()), None);
}

#[test]
fn the_owner_cannot_write_unless_it_is_an_oracle() {
    let mut registry = fresh();
    call(&owner(), NO_DEPOSIT, T0);
    expect_err(Error::NotOracle, || {
        set(&mut registry, entry(&payee(), Verdict::Allow))
    });

    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(owner());
    call(&owner(), NO_DEPOSIT, T0);
    set(&mut registry, entry(&payee(), Verdict::Allow));
    assert_eq!(registry.get_verdict(payee()).unwrap().updated_by, owner());
}

#[test]
fn a_removed_oracle_cannot_write() {
    let mut registry = fresh();
    call(&owner(), ONE_YOCTO, T0);
    registry.remove_oracle(oracle());
    call(&oracle(), NO_DEPOSIT, T0);
    expect_err(Error::NotOracle, || {
        set(&mut registry, entry(&payee(), Verdict::Allow))
    });
}

#[test]
fn the_caller_is_the_predecessor_not_the_signer() {
    let mut registry = fresh();
    // The oracle signed, but a stranger's contract is the one calling: refused.
    call_signed(&oracle(), &stranger(), NO_DEPOSIT, T0);
    expect_err(Error::NotOracle, || {
        set(&mut registry, entry(&payee(), Verdict::Allow))
    });
    // A stranger signed a transaction that reached the oracle, and the oracle calls: allowed,
    // and recorded as the oracle's write.
    call_signed(&stranger(), &oracle(), NO_DEPOSIT, T0);
    set(&mut registry, entry(&payee(), Verdict::Allow));
    assert_eq!(registry.get_verdict(payee()).unwrap().updated_by, oracle());
}

#[test]
fn authentication_comes_before_any_input_rule() {
    let mut registry = fresh();
    let mut bad = entry(&payee(), Verdict::Deny);
    bad.reasons = reasons(MAX_REASONS + 1);
    bad.score = Some(MAX_SCORE + 1);
    call(&stranger(), NO_DEPOSIT, T0);
    expect_err(Error::NotOracle, || set(&mut registry, bad));
}

// -- what a write replaces ----------------------------------------------------------------

#[test]
fn a_new_verdict_replaces_the_old_one_whole() {
    let mut registry = fresh();
    let mut first = entry(&payee(), Verdict::Deny);
    first.score = Some(10);
    first.code_hash = Some("old".to_string());
    first.ttl_s = ttl(60);
    oracle_sets(&mut registry, first, T0);

    call(&owner(), ONE_YOCTO, T0);
    registry.add_oracle(oracle2());
    let mut second = entry(&payee(), Verdict::Allow);
    second.evidence = None;
    second.score = None;
    call(&oracle2(), NO_DEPOSIT, T0 + 5);
    set(&mut registry, second);

    let view = registry.get_verdict(payee()).unwrap();
    assert_eq!(view.verdict, Verdict::Allow);
    // Nothing carries over from the first write: not the score, code hash or expiry.
    assert_eq!(view.evidence, None);
    assert_eq!(view.score, None);
    assert_eq!(view.code_hash, None);
    assert_eq!(view.expires_at_ns, None);
    assert_eq!(view.updated_at_ns, U64(T0 + 5));
    assert_eq!(view.updated_by, oracle2());
    assert_eq!(registry.list_verdicts(None, None).len(), 1);
}

#[test]
fn a_refused_write_leaves_the_previous_verdict_in_place() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Deny), T0);
    let before = registry.get_verdict(payee());

    let mut bad = entry(&payee(), Verdict::Allow);
    bad.reasons = vec!["NotACode".to_string()];
    call(&oracle(), NO_DEPOSIT, T0 + 1);
    expect_err(Error::InvalidReason, || set(&mut registry, bad));
    assert_eq!(registry.get_verdict(payee()), before);
}

// -- the input rules, at and past each boundary -------------------------------------------

#[test]
fn eight_reasons_are_accepted_and_nine_refused() {
    let mut registry = fresh();
    let mut ok = entry(&payee(), Verdict::Deny);
    ok.reasons = reasons(MAX_REASONS);
    oracle_sets(&mut registry, ok, T0);
    assert_eq!(
        registry.get_verdict(payee()).unwrap().reasons.len(),
        MAX_REASONS
    );

    let mut over = entry(&payee(), Verdict::Deny);
    over.reasons = reasons(MAX_REASONS + 1);
    expect_err(Error::TooManyReasons, || set(&mut registry, over));
}

#[test]
fn a_reason_code_of_exactly_32_bytes_is_accepted() {
    let mut registry = fresh();
    let mut ok = entry(&payee(), Verdict::Deny);
    ok.reasons = vec![bytes('a', MAX_CODE_LEN), "0".to_string(), "_".to_string()];
    oracle_sets(&mut registry, ok, T0);
}

#[test]
fn every_malformed_reason_code_is_refused() {
    let mut registry = fresh();
    let bad_codes = [
        bytes('a', MAX_CODE_LEN + 1),
        String::new(),
        "Scam".to_string(),
        "drain-er".to_string(),
        "two words".to_string(),
        "a.b".to_string(),
        "kya\n".to_string(),
        "caf\u{e9}".to_string(),
    ];
    for code in bad_codes {
        let mut bad = entry(&payee(), Verdict::Deny);
        bad.reasons = vec!["fine".to_string(), code.clone()];
        call(&oracle(), NO_DEPOSIT, T0);
        expect_err(Error::InvalidReason, || set(&mut registry, bad));
    }
    assert_eq!(registry.get_verdict(payee()), None);
}

#[test]
fn evidence_of_256_bytes_is_accepted_and_257_refused() {
    let mut registry = fresh();
    let mut ok = entry(&payee(), Verdict::Deny);
    ok.evidence = Some(bytes('e', MAX_EVIDENCE_LEN));
    oracle_sets(&mut registry, ok, T0);

    let mut over = entry(&payee(), Verdict::Deny);
    over.evidence = Some(bytes('e', MAX_EVIDENCE_LEN + 1));
    expect_err(Error::EvidenceTooLong, || set(&mut registry, over));
}

#[test]
fn evidence_is_measured_in_bytes_not_characters() {
    let mut registry = fresh();
    // 129 two-byte characters: 129 characters, 258 bytes.
    let mut over = entry(&payee(), Verdict::Deny);
    over.evidence = Some(bytes('\u{e9}', 129));
    call(&oracle(), NO_DEPOSIT, T0);
    expect_err(Error::EvidenceTooLong, || set(&mut registry, over));
}

#[test]
fn empty_evidence_is_accepted() {
    let mut registry = fresh();
    let mut ok = entry(&payee(), Verdict::Allow);
    ok.evidence = Some(String::new());
    oracle_sets(&mut registry, ok, T0);
    assert_eq!(
        registry.get_verdict(payee()).unwrap().evidence,
        Some(String::new())
    );
}

#[test]
fn scores_from_0_to_1000_are_accepted_and_1001_refused() {
    let mut registry = fresh();
    for score in [Some(0), Some(MAX_SCORE), None] {
        let mut ok = entry(&payee(), Verdict::Allow);
        ok.score = score;
        oracle_sets(&mut registry, ok, T0);
        assert_eq!(registry.get_verdict(payee()).unwrap().score, score);
    }
    for score in [MAX_SCORE + 1, u16::MAX] {
        let mut over = entry(&payee(), Verdict::Allow);
        over.score = Some(score);
        expect_err(Error::ScoreOutOfRange, || set(&mut registry, over));
    }
}

#[test]
fn a_code_hash_of_64_bytes_is_accepted_and_65_refused() {
    let mut registry = fresh();
    let mut ok = entry(&payee(), Verdict::Allow);
    ok.code_hash = Some(bytes('f', MAX_CODE_HASH_LEN));
    oracle_sets(&mut registry, ok, T0);

    let mut over = entry(&payee(), Verdict::Allow);
    over.code_hash = Some(bytes('f', MAX_CODE_HASH_LEN + 1));
    expect_err(Error::CodeHashTooLong, || set(&mut registry, over));
}

#[test]
fn the_rules_fire_in_their_documented_order() {
    let mut registry = fresh();
    // An input that breaks every rule, repaired one rule at a time: each repair moves the
    // refusal to the next rule in the order the method documents.
    let mut input = VerdictInput {
        account_id: payee(),
        verdict: Verdict::Deny,
        reasons: vec!["BAD".to_string(); MAX_REASONS + 1],
        evidence: Some(bytes('e', MAX_EVIDENCE_LEN + 1)),
        score: Some(MAX_SCORE + 1),
        code_hash: Some(bytes('f', MAX_CODE_HASH_LEN + 1)),
        ttl_s: ttl(u64::MAX),
    };
    call(&oracle(), NO_DEPOSIT, T0);
    expect_err(Error::TooManyReasons, || set(&mut registry, input.clone()));
    input.reasons.truncate(MAX_REASONS);
    expect_err(Error::InvalidReason, || set(&mut registry, input.clone()));
    input.reasons = vec!["ok".to_string()];
    expect_err(Error::EvidenceTooLong, || set(&mut registry, input.clone()));
    input.evidence = None;
    expect_err(Error::ScoreOutOfRange, || set(&mut registry, input.clone()));
    input.score = None;
    expect_err(Error::CodeHashTooLong, || set(&mut registry, input.clone()));
    input.code_hash = None;
    expect_err(Error::MathOverflow, || set(&mut registry, input.clone()));
    input.ttl_s = None;
    set(&mut registry, input);
    assert_eq!(
        registry.get_verdict(payee()).unwrap().verdict,
        Verdict::Deny
    );
}

#[test]
fn a_maximal_verdict_costs_the_registry_under_one_kilobyte() {
    // The crate comment tells the operator what an oracle's write costs the registry
    // account; hold the figure to a measurement. Every field at its limit, including a
    // 64-byte oracle id in `updated_by`.
    let long_oracle = acc(&bytes('o', 64));
    begin();
    let mut registry = Registry::new(owner(), vec![long_oracle.clone()]);
    call(&long_oracle, NO_DEPOSIT, T0);
    let before = near_sdk::env::storage_usage();
    set(
        &mut registry,
        VerdictInput {
            account_id: acc(&bytes('m', 64)),
            verdict: Verdict::Deny,
            reasons: (0..MAX_REASONS)
                .map(|r| format!("{}{r}", bytes('r', MAX_CODE_LEN - 1)))
                .collect(),
            evidence: Some(bytes('e', MAX_EVIDENCE_LEN)),
            score: Some(MAX_SCORE),
            code_hash: Some(bytes('h', MAX_CODE_HASH_LEN)),
            ttl_s: ttl(1),
        },
    );
    registry.verdicts.flush();
    let used = near_sdk::env::storage_usage() - before;
    assert!((800..=1024).contains(&used), "{used} bytes");
}

// -- clear_verdict ------------------------------------------------------------------------

#[test]
fn an_oracle_clears_a_verdict_and_it_is_logged() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Deny), T0);
    call(&oracle(), NO_DEPOSIT, T0 + 1);
    registry.clear_verdict(payee());
    assert_eq!(registry.get_verdict(payee()), None);
    assert!(registry.list_verdicts(None, None).is_empty());
    let events = events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event"], "verdict_cleared");
    assert_eq!(
        events[0]["data"],
        json!({ "account_id": "payee.near", "by": "oracle.near" })
    );
}

#[test]
fn clearing_a_missing_verdict_is_a_silent_no_op() {
    let mut registry = fresh();
    call(&oracle(), NO_DEPOSIT, T0);
    registry.clear_verdict(payee());
    assert!(events().is_empty());
}

#[test]
fn only_an_oracle_can_clear_a_verdict() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Deny), T0);
    for caller in [stranger(), owner()] {
        call(&caller, NO_DEPOSIT, T0);
        expect_err(Error::NotOracle, || registry.clear_verdict(payee()));
    }
    assert_eq!(
        registry.get_verdict(payee()).unwrap().verdict,
        Verdict::Deny
    );
}

#[test]
fn clearing_a_verdict_leaves_reports_alone() {
    let mut registry = fresh();
    oracle_sets(&mut registry, entry(&payee(), Verdict::Deny), T0);
    call(&stranger(), crate::REPORT_DEPOSIT, T0);
    registry.report(payee(), "drainer".to_string(), "tx:abc".to_string());
    call(&oracle(), NO_DEPOSIT, T0);
    registry.clear_verdict(payee());
    assert_eq!(registry.get_reports(payee()).len(), 1);
    assert_eq!(registry.report_count(payee()), 1);
}

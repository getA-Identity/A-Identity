//! The public ABI, held to its spelling: error names, the JSON of every view and input, the
//! event envelope. These are the tests that fail when a refactor renames something a
//! deployed client depends on.

use super::*;
use crate::{CheckVerdict, CheckView, RegistryEvent, ReportView, VerdictRecord, VerdictView};
use near_sdk::AsNep297Event;
use near_sdk::serde_json::json;

// -- errors -------------------------------------------------------------------------------

/// The spec's list, then the two appended names, in declaration order.
const NAMES: [&str; 15] = [
    "NotOwner",
    "NotOracle",
    "OracleLimitReached",
    "InvalidReason",
    "EvidenceTooLong",
    "TooManyReasons",
    "ReportDepositTooLow",
    "DuplicateReport",
    "SelfReport",
    "ReportLimitReached",
    "BatchTooLarge",
    "ScoreOutOfRange",
    "RequiresOneYocto",
    "CodeHashTooLong",
    "MathOverflow",
];

#[test]
fn every_error_has_its_stable_name() {
    let names: Vec<&str> = Error::ALL.iter().map(|e| e.as_str()).collect();
    assert_eq!(names, NAMES);
}

#[test]
fn error_names_are_unique_and_none_contains_another() {
    // A client matching on a substring must not be able to confuse two refusals.
    for (i, a) in NAMES.iter().enumerate() {
        for (j, b) in NAMES.iter().enumerate() {
            if i != j {
                assert!(!a.contains(b), "{a} contains {b}");
            }
        }
    }
}

#[test]
fn a_refusal_panics_with_the_bare_name_and_nothing_else() {
    for error in Error::ALL {
        call(&stranger(), NO_DEPOSIT, T0);
        expect_err(error, || error.panic());
    }
}

/// An exhaustive match: adding a variant without deciding its name fails to compile here.
#[test]
fn the_variant_list_is_exhaustive() {
    for error in Error::ALL {
        let named = match error {
            Error::NotOwner
            | Error::NotOracle
            | Error::OracleLimitReached
            | Error::InvalidReason
            | Error::EvidenceTooLong
            | Error::TooManyReasons
            | Error::ReportDepositTooLow
            | Error::DuplicateReport
            | Error::SelfReport
            | Error::ReportLimitReached
            | Error::BatchTooLarge
            | Error::ScoreOutOfRange
            | Error::RequiresOneYocto
            | Error::CodeHashTooLong
            | Error::MathOverflow => error.as_str(),
        };
        assert!(NAMES.contains(&named));
    }
}

// -- what the vault reads -----------------------------------------------------------------

fn deny_with_everything() -> Registry {
    let mut registry = fresh();
    let input = VerdictInput {
        account_id: payee(),
        verdict: Verdict::Deny,
        reasons: vec!["drainer".to_string(), "kya_revoked".to_string()],
        evidence: Some("https://a-identity.xyz/e/42".to_string()),
        score: Some(120),
        code_hash: Some("8Yk1v3Lq9e2wZb4cRt7uHn5sJm6pXd2aQf8gVh3kEo1".to_string()),
        ttl_s: ttl(3600),
    };
    oracle_sets(&mut registry, input, T0);
    registry
}

#[test]
fn get_verdict_serializes_to_the_exact_shape_the_vault_parses() {
    let registry = deny_with_everything();
    let json = serde_json::to_value(registry.get_verdict(payee())).unwrap();
    assert_eq!(
        json,
        json!({
            "account_id": "payee.near",
            "verdict": "DENY",
            "reasons": ["drainer", "kya_revoked"],
            "evidence": "https://a-identity.xyz/e/42",
            "score": 120,
            "code_hash": "8Yk1v3Lq9e2wZb4cRt7uHn5sJm6pXd2aQf8gVh3kEo1",
            "updated_at_ns": T0.to_string(),
            "updated_by": "oracle.near",
            "expires_at_ns": (T0 + 3_600_000_000_000).to_string(),
        })
    );
}

#[test]
fn get_verdict_serializes_absent_and_expired_as_json_null() {
    let registry = deny_with_everything();
    let never: Option<VerdictView> = registry.get_verdict(acc("never.near"));
    assert_eq!(serde_json::to_string(&never).unwrap(), "null");
    call(&stranger(), NO_DEPOSIT, u64::MAX);
    assert_eq!(
        serde_json::to_string(&registry.get_verdict(payee())).unwrap(),
        "null"
    );
}

#[test]
fn optional_fields_serialize_as_explicit_nulls() {
    let mut registry = fresh();
    let input = VerdictInput {
        evidence: None,
        score: None,
        code_hash: None,
        ttl_s: None,
        ..entry(&payee(), Verdict::Allow)
    };
    oracle_sets(&mut registry, input, T0);
    let json = serde_json::to_value(registry.get_verdict(payee())).unwrap();
    for field in ["evidence", "score", "code_hash", "expires_at_ns"] {
        assert_eq!(json[field], Value::Null, "{field}");
    }
}

/// The vault's reading, restated: the raw bytes must parse as JSON null or as an object
/// with a string "verdict" from the three it knows. Anything else, it refuses.
fn vault_reads(bytes: &[u8]) -> Option<Option<String>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    match value {
        Value::Null => Some(None),
        Value::Object(map) => match map.get("verdict")?.as_str()? {
            v @ ("ALLOW" | "WARN" | "DENY") => Some(Some(v.to_string())),
            _ => None,
        },
        _ => None,
    }
}

#[test]
fn the_vault_reading_accepts_every_answer_this_registry_gives() {
    let mut registry = fresh();
    for (verdict, word) in [
        (Verdict::Allow, "ALLOW"),
        (Verdict::Warn, "WARN"),
        (Verdict::Deny, "DENY"),
    ] {
        oracle_sets(&mut registry, entry(&payee(), verdict), T0);
        let bytes = serde_json::to_vec(&registry.get_verdict(payee())).unwrap();
        assert_eq!(vault_reads(&bytes), Some(Some(word.to_string())));
    }
    let none = serde_json::to_vec(&registry.get_verdict(acc("never.near"))).unwrap();
    assert_eq!(vault_reads(&none), Some(None));
}

// -- the verdict words --------------------------------------------------------------------

#[test]
fn verdicts_are_the_plain_upper_case_words_both_ways() {
    for (verdict, word) in [
        (Verdict::Allow, "\"ALLOW\""),
        (Verdict::Warn, "\"WARN\""),
        (Verdict::Deny, "\"DENY\""),
    ] {
        assert_eq!(serde_json::to_string(&verdict).unwrap(), word);
        assert_eq!(serde_json::from_str::<Verdict>(word).unwrap(), verdict);
    }
    for wrong in [
        "\"allow\"",
        "\"Allow\"",
        "\"NONE\"",
        "\"BLOCK\"",
        "0",
        "null",
    ] {
        assert!(serde_json::from_str::<Verdict>(wrong).is_err(), "{wrong}");
    }
}

#[test]
fn check_serializes_to_its_documented_shape() {
    let none = CheckView {
        verdict: CheckVerdict::NoVerdict,
        reasons: Vec::new(),
        reports: 3,
    };
    assert_eq!(
        serde_json::to_value(&none).unwrap(),
        json!({ "verdict": "NONE", "reasons": [], "reports": 3 })
    );
    for (verdict, word) in [
        (CheckVerdict::Allow, "ALLOW"),
        (CheckVerdict::Warn, "WARN"),
        (CheckVerdict::Deny, "DENY"),
    ] {
        let view = CheckView {
            verdict,
            reasons: vec!["x".to_string()],
            reports: 0,
        };
        assert_eq!(serde_json::to_value(&view).unwrap()["verdict"], word);
    }
}

#[test]
fn reports_serialize_with_a_string_timestamp() {
    let view = ReportView {
        reporter: stranger(),
        reason: "drainer".to_string(),
        evidence: "tx:1".to_string(),
        at_ns: U64(T0),
    };
    assert_eq!(
        serde_json::to_value(&view).unwrap(),
        json!({
            "reporter": "stranger.near",
            "reason": "drainer",
            "evidence": "tx:1",
            "at_ns": T0.to_string(),
        })
    );
}

// -- inputs -------------------------------------------------------------------------------

#[test]
fn a_batch_entry_parses_from_the_json_a_client_sends() {
    let full: VerdictInput = serde_json::from_value(json!({
        "account_id": "payee.near",
        "verdict": "WARN",
        "reasons": ["new_account"],
        "evidence": "https://a-identity.xyz/e/7",
        "score": 450,
        "code_hash": "abc",
        "ttl_s": "86400",
    }))
    .unwrap();
    assert_eq!(full.verdict, Verdict::Warn);
    assert_eq!(full.ttl_s, ttl(86_400));

    // Optional fields may be omitted, or sent as null.
    let minimal: VerdictInput = serde_json::from_value(json!({
        "account_id": "payee.near",
        "verdict": "DENY",
        "reasons": [],
        "evidence": null,
    }))
    .unwrap();
    assert_eq!(
        (
            minimal.evidence,
            minimal.score,
            minimal.code_hash,
            minimal.ttl_s
        ),
        (None, None, None, None)
    );
}

#[test]
fn a_ttl_sent_as_a_json_number_is_rejected_by_the_parser() {
    // U64 is a decimal string on purpose (see types.rs); a number does not parse, so a
    // client cannot send a rounded nanosecond-scale value by accident.
    let result = serde_json::from_value::<VerdictInput>(json!({
        "account_id": "payee.near",
        "verdict": "DENY",
        "reasons": [],
        "ttl_s": 86400,
    }));
    assert!(result.is_err());
}

#[test]
fn a_score_outside_u16_is_rejected_by_the_parser() {
    let result = serde_json::from_value::<VerdictInput>(json!({
        "account_id": "payee.near",
        "verdict": "DENY",
        "reasons": [],
        "score": 70000,
    }));
    assert!(result.is_err());
}

// -- events -------------------------------------------------------------------------------

#[test]
fn every_event_carries_the_standard_and_version_and_a_data_object() {
    let account = payee();
    let by = oracle();
    let record = VerdictRecord {
        verdict: Verdict::Deny,
        reasons: vec!["x".to_string()],
        evidence: None,
        score: None,
        code_hash: None,
        updated_at_ns: T0,
        updated_by: by.clone(),
        expires_at_ns: None,
    };
    let all = [
        (RegistryEvent::verdict_set(&account, &record), "verdict_set"),
        (
            RegistryEvent::VerdictCleared {
                account_id: &account,
                by: &by,
            },
            "verdict_cleared",
        ),
        (
            RegistryEvent::ReportFiled {
                account_id: &account,
                reporter: &by,
                reason: "x",
                evidence: "y",
            },
            "report_filed",
        ),
        (
            RegistryEvent::ReportsCleared {
                account_id: &account,
                by: &by,
            },
            "reports_cleared",
        ),
        (
            RegistryEvent::OracleAdded { account_id: &by },
            "oracle_added",
        ),
        (
            RegistryEvent::OracleRemoved { account_id: &by },
            "oracle_removed",
        ),
        (RegistryEvent::OwnerSet { owner_id: &by }, "owner_set"),
    ];
    for (event, name) in all {
        let line = event.to_nep297_event().to_event_log();
        let json: Value = serde_json::from_str(line.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
        assert_eq!(json["standard"], "a_identity_registry", "{name}");
        assert_eq!(json["version"], "1.0.0", "{name}");
        assert_eq!(json["event"], name);
        assert!(json["data"].is_object(), "{name}");
        assert_eq!(json.as_object().unwrap().len(), 4, "{name}");
    }
}

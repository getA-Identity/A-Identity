//! `verdict::read_answer`: the two shapes it understands, and that every other input, including
//! random bytes, is `Unusable` rather than an abort.

use crate::verdict::{
    Answer, MAX_ANSWER_BYTES, MAX_REASON_CODE_BYTES, MAX_REASON_CODES, read_answer, truncate_utf8,
};

fn read(json: &str) -> Answer {
    read_answer(json.as_bytes())
}

#[test]
fn null_means_no_verdict() {
    assert_eq!(read("null"), Answer::NoVerdict);
    assert_eq!(read("  null \n"), Answer::NoVerdict);
}

#[test]
fn the_three_verdicts() {
    assert_eq!(read(r#"{"verdict":"ALLOW"}"#), Answer::Allow);
    assert_eq!(read(r#"{"verdict":"WARN"}"#), Answer::Warn);
    assert_eq!(
        read(r#"{"verdict":"DENY"}"#),
        Answer::Deny { reasons: vec![] }
    );
}

#[test]
fn a_full_registry_view_is_read_by_its_verdict_field() {
    let view = r#"{
        "account_id": "shop.testnet",
        "verdict": "DENY",
        "reasons": ["kya_revoked", "wash_traded"],
        "evidence": "https://a-identity.xyz/proof/x",
        "score": 120,
        "code_hash": "8b5f3e",
        "updated_at_ns": "1794484800000000000",
        "updated_by": "oracle.a-identity.testnet",
        "expires_at_ns": null
    }"#;
    assert_eq!(
        read(view),
        Answer::Deny {
            reasons: vec!["kya_revoked".to_owned(), "wash_traded".to_owned()]
        }
    );
}

#[test]
fn deny_reasons_are_bounded_to_three_codes_of_32_bytes() {
    let long = "x".repeat(40);
    let json = format!(r#"{{"verdict":"DENY","reasons":["a","{long}","c","d","e"]}}"#);
    let Answer::Deny { reasons } = read(&json) else {
        panic!("expected DENY");
    };
    assert_eq!(reasons.len(), MAX_REASON_CODES);
    assert_eq!(reasons[0], "a");
    assert_eq!(reasons[1].len(), MAX_REASON_CODE_BYTES);
    assert_eq!(reasons[2], "c");
}

#[test]
fn malformed_reasons_lose_the_decoration_never_the_refusal() {
    assert_eq!(
        read(r#"{"verdict":"DENY","reasons":"kya_revoked"}"#),
        Answer::Deny { reasons: vec![] }
    );
    assert_eq!(
        read(r#"{"verdict":"DENY","reasons":[1,null,{"a":1},"ok"]}"#),
        Answer::Deny {
            reasons: vec!["ok".to_owned()]
        }
    );
}

#[test]
fn anything_else_fails_closed() {
    for bad in [
        "",
        "   ",
        "garbage",
        "{}",
        "[]",
        "true",
        "0",
        r#""DENY""#,
        r#"{"verdict":null}"#,
        r#"{"verdict":1}"#,
        r#"{"verdict":["DENY"]}"#,
        r#"{"verdict":{"DENY":true}}"#,
        r#"{"verdict":"deny"}"#,
        r#"{"verdict":"Allow"}"#,
        r#"{"verdict":"BLOCK"}"#,
        r#"{"verdict":"NONE"}"#,
        r#"{"verdict":""}"#,
        r#"{"Verdict":"ALLOW"}"#,
        r#"{"result":{"verdict":"ALLOW"}}"#,
        r#"[{"verdict":"ALLOW"}]"#,
        r#"null null"#,
        r#"{"verdict":"ALLOW"} trailing"#,
        r#"{"verdict":"ALLOW""#,
    ] {
        assert_eq!(read(bad), Answer::Unusable, "{bad:?}");
    }
}

#[test]
fn invalid_utf8_fails_closed() {
    assert_eq!(read_answer(&[0xff, 0xfe, 0xfd]), Answer::Unusable);
    let mut bytes = br#"{"verdict":"ALLOW","x":""#.to_vec();
    bytes.extend_from_slice(&[0xc3, 0x28]);
    bytes.extend_from_slice(br#""}"#);
    assert_eq!(read_answer(&bytes), Answer::Unusable);
}

#[test]
fn deep_nesting_fails_closed_without_aborting() {
    let bomb = format!("{}{}", "[".repeat(5_000), "]".repeat(5_000));
    assert_eq!(read(&bomb), Answer::Unusable);
    let object_bomb = format!(
        r#"{{"verdict":"ALLOW","x":{}{}}}"#,
        "[".repeat(1_000),
        "]".repeat(1_000)
    );
    assert_eq!(read(&object_bomb), Answer::Unusable);
}

#[test]
fn a_reply_longer_than_the_bound_is_not_read() {
    let padding = " ".repeat(MAX_ANSWER_BYTES);
    let at_limit = format!("{}null", &padding[4..]);
    assert_eq!(at_limit.len(), MAX_ANSWER_BYTES);
    assert_eq!(read(&at_limit), Answer::NoVerdict);
    let over = format!("{padding}null");
    assert_eq!(read(&over), Answer::Unusable);
}

/// A deterministic fuzz pass: random bytes, and random single-byte mutations of valid answers,
/// never abort. A mutation of the verdict string itself must never be read as a verdict it does
/// not spell.
#[test]
fn random_bytes_never_abort() {
    let mut state: u64 = 0x5eed_a1de_c0de_f00d;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state
    };
    for _ in 0..20_000 {
        let len = (next() % 64) as usize;
        let bytes: Vec<u8> = (0..len).map(|_| (next() & 0xff) as u8).collect();
        let _ = read_answer(&bytes);
    }
    let seeds: [&[u8]; 4] = [
        br#"{"verdict":"ALLOW"}"#,
        br#"{"verdict":"DENY","reasons":["a","b"]}"#,
        br#"{"verdict":"WARN","score":10}"#,
        b"null",
    ];
    for seed in seeds {
        for _ in 0..5_000 {
            let mut bytes = seed.to_vec();
            let at = (next() as usize) % bytes.len();
            bytes[at] = (next() & 0xff) as u8;
            let answer = read_answer(&bytes);
            let text = String::from_utf8_lossy(&bytes);
            match answer {
                Answer::Allow => assert!(text.contains(r#""ALLOW""#), "{text}"),
                Answer::Warn => assert!(text.contains(r#""WARN""#), "{text}"),
                Answer::Deny { .. } => assert!(text.contains(r#""DENY""#), "{text}"),
                Answer::NoVerdict => assert!(text.trim() == "null", "{text}"),
                Answer::Unusable => {}
            }
        }
    }
}

#[test]
fn truncation_never_splits_a_character() {
    assert_eq!(truncate_utf8("short", 32), "short");
    let exact = "a".repeat(32);
    assert_eq!(truncate_utf8(&exact, 32), exact);
    // 31 ASCII bytes then a 2-byte character that would straddle byte 32.
    let straddle = format!("{}\u{e9}", "a".repeat(31));
    assert_eq!(straddle.len(), 33);
    assert_eq!(truncate_utf8(&straddle, 32), "a".repeat(31));
    // A 4-byte character at the start and a limit inside it.
    assert_eq!(truncate_utf8("\u{1f600}abc", 2), "");
    assert_eq!(truncate_utf8("\u{1f600}abc", 5), "\u{1f600}a");
    assert_eq!(truncate_utf8("", 0), "");
}

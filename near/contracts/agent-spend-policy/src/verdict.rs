//! Reading the registry's answer, as a pure function over bytes.
//!
//! The vault asks `registry.get_verdict({account_id: payee})` before every payment. Whatever comes
//! back arrives in a callback, and a callback that aborts is the worst failure this contract can
//! have: the reservation made before the call stays charged, no event is written, and the agent
//! is told nothing. So the answer is never deserialized by the SDK's typed callback arguments,
//! which abort on bytes they do not expect. It is read here, from raw bytes, by code that maps
//! every input to an `Answer` and cannot panic.
//!
//! The rule is fail closed. Only two shapes are understood: JSON `null` (the registry has nothing
//! on this payee) and a JSON object whose `verdict` field is exactly the string `"ALLOW"`,
//! `"WARN"` or `"DENY"`. Anything else, including a lower-case verdict, a missing field, an empty
//! reply, or a reply longer than `MAX_ANSWER_BYTES`, is `Unusable`, and an unusable answer refuses
//! the payment with `RegistryUnavailable`. A registry the vault cannot read is a registry that has
//! not said ALLOW.

use near_sdk::serde_json::{self, Value};

/// Longest registry reply the vault will read. A `VerdictView` with every field at its registry
/// limit is well under 3 KiB of JSON; the rest is headroom for additive fields. A longer reply is
/// refused rather than read, because reading costs gas per byte and the reply is not ours.
pub const MAX_ANSWER_BYTES: usize = 8 * 1024;
/// Registry reason codes copied into the refusal event.
pub const MAX_REASON_CODES: usize = 3;
/// Longest reason code, in bytes, copied into the refusal event.
pub const MAX_REASON_CODE_BYTES: usize = 32;

/// What the vault understood the registry to say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    /// The registry has no verdict for this payee (`null`). Treated like ALLOW for a payee the
    /// owner listed or the vault has paid before; with `hold_unknown` on, an agent `pay` to any
    /// other payee is held for the owner (`UnknownPayee`). A vault with no registry reads every
    /// payee this way.
    NoVerdict,
    Allow,
    Warn,
    /// Carries the registry's first reason codes, bounded, for the refusal event.
    Deny {
        reasons: Vec<String>,
    },
    /// Failed call, unreadable bytes, or a verdict string the vault does not know.
    Unusable,
}

/// Map the raw bytes of a successful `get_verdict` reply to an `Answer`. Never panics:
/// `serde_json` reports malformed or too-deep input as an error, and every error is `Unusable`.
pub fn read_answer(bytes: &[u8]) -> Answer {
    if bytes.len() > MAX_ANSWER_BYTES {
        return Answer::Unusable;
    }
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(_) => return Answer::Unusable,
    };
    match value {
        Value::Null => Answer::NoVerdict,
        Value::Object(map) => match map.get("verdict") {
            Some(Value::String(verdict)) => match verdict.as_str() {
                "ALLOW" => Answer::Allow,
                "WARN" => Answer::Warn,
                "DENY" => Answer::Deny {
                    reasons: reason_codes(map.get("reasons")),
                },
                _ => Answer::Unusable,
            },
            _ => Answer::Unusable,
        },
        _ => Answer::Unusable,
    }
}

/// The first `MAX_REASON_CODES` string entries of `reasons`, each cut to `MAX_REASON_CODE_BYTES`.
/// Lenient on purpose: the codes only decorate a refusal that is already decided by `verdict`, so
/// a malformed `reasons` field loses the decoration, never the refusal.
fn reason_codes(reasons: Option<&Value>) -> Vec<String> {
    match reasons {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .take(MAX_REASON_CODES)
            .map(|code| truncate_utf8(code, MAX_REASON_CODE_BYTES).to_owned())
            .collect(),
        _ => Vec::new(),
    }
}

/// The longest prefix of `s` that is at most `max_bytes` long and ends on a character boundary.
/// Slicing a `str` mid-character aborts, and the registry's own `[a-z0-9_]` rule is not something
/// this contract gets to assume about bytes it did not write.
pub fn truncate_utf8(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.get(..end).unwrap_or("")
}

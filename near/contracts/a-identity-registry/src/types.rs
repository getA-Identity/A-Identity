//! What the registry stores, and the JSON shapes it reads and returns.
//!
//! The split between a borsh record and a JSON view is deliberate. State uses native
//! integers, because that is what borsh stores compactly. JSON wraps every u64 as `U64`, a
//! decimal string, because a JSON number is an IEEE double and silently rounds above 2^53,
//! and a nanosecond timestamp is already above 2^60. A reader that gets a rounded deadline
//! gets the wrong answer to "is this verdict still live".
//!
//! The JSON shapes here are public ABI: the TypeScript SDK, the console, and (for
//! `VerdictView`) the vault's cross-contract read all depend on the field names. The borsh
//! layouts are the on-chain state of a deployed contract: field order and variant order are
//! frozen, and a new field means a state migration, not an edit.

use near_sdk::json_types::U64;
use near_sdk::{AccountId, near};

/// What an oracle concluded about an account.
///
/// JSON is the plain upper-case string, "ALLOW", "WARN" or "DENY". The vault matches those
/// exact strings and fails closed on anything else, so this spelling is not cosmetic.
/// The borsh discriminant is the declaration order, which makes the order frozen too.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "UPPERCASE")]
pub enum Verdict {
    /// The vault pays.
    Allow,
    /// The vault holds the payment for its owner to approve or reject.
    Warn,
    /// The vault refuses the payment on chain, even when the vault's owner approves it.
    Deny,
}

/// One verdict as stored. One per account; a new verdict replaces the old one, and the
/// old one survives only in the `verdict_set` event that announced it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerdictRecord {
    pub verdict: Verdict,
    /// Machine-readable reason codes, at most 8, each 1 to 32 bytes of `[a-z0-9_]`.
    pub reasons: Vec<String>,
    /// A pointer to the evidence (a URL or a content hash), at most 256 bytes.
    pub evidence: Option<String>,
    /// The off-chain engine's score on its 0 to 1000 scale. Informational: the vault acts
    /// on `verdict` alone.
    pub score: Option<u16>,
    /// The code hash the oracle observed on the account when it wrote this verdict, at most
    /// 64 bytes. NEAR has no host function that reads another account's code, so this is
    /// the oracle's observation, not a check the contract makes. A reader compares it with
    /// the account's current code hash to see whether the code changed after the verdict.
    pub code_hash: Option<String>,
    pub updated_at_ns: u64,
    pub updated_by: AccountId,
    /// None means the verdict does not expire. Otherwise it is live through this
    /// nanosecond inclusive and reads as no verdict after it.
    pub expires_at_ns: Option<u64>,
}

/// `get_verdict`'s answer, and the element type of `list_verdicts`.
///
/// The vault reads this shape cross-contract: the top-level `verdict` must stay a plain
/// string. `updated_at_ns` and `expires_at_ns` are decimal strings (see the module comment).
#[near(serializers = [json])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerdictView {
    pub account_id: AccountId,
    pub verdict: Verdict,
    pub reasons: Vec<String>,
    pub evidence: Option<String>,
    pub score: Option<u16>,
    pub code_hash: Option<String>,
    pub updated_at_ns: U64,
    pub updated_by: AccountId,
    pub expires_at_ns: Option<U64>,
}

impl VerdictView {
    pub(crate) fn from_record(account_id: AccountId, record: &VerdictRecord) -> Self {
        Self {
            account_id,
            verdict: record.verdict,
            reasons: record.reasons.clone(),
            evidence: record.evidence.clone(),
            score: record.score,
            code_hash: record.code_hash.clone(),
            updated_at_ns: U64(record.updated_at_ns),
            updated_by: record.updated_by.clone(),
            expires_at_ns: record.expires_at_ns.map(U64),
        }
    }
}

/// One entry of `set_verdicts`. The fields are `set_verdict`'s arguments, under the same
/// names, so a client builds a batch entry exactly the way it builds a single call.
/// `ttl_s` is a decimal string of seconds; omitting it, or sending "0", means no expiry.
#[near(serializers = [json])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerdictInput {
    pub account_id: AccountId,
    pub verdict: Verdict,
    pub reasons: Vec<String>,
    pub evidence: Option<String>,
    pub score: Option<u16>,
    pub code_hash: Option<String>,
    pub ttl_s: Option<U64>,
}

/// A report as stored: who filed it, why, and what they pointed at.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Report {
    pub reporter: AccountId,
    /// One reason code, 1 to 32 bytes of `[a-z0-9_]`.
    pub reason: String,
    /// At most 256 bytes.
    pub evidence: String,
    pub at_ns: u64,
}

/// `get_reports`'s element type.
#[near(serializers = [json])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReportView {
    pub reporter: AccountId,
    pub reason: String,
    pub evidence: String,
    pub at_ns: U64,
}

impl From<&Report> for ReportView {
    fn from(report: &Report) -> Self {
        Self {
            reporter: report.reporter.clone(),
            reason: report.reason.clone(),
            evidence: report.evidence.clone(),
            at_ns: U64(report.at_ns),
        }
    }
}

/// `check`'s verdict: the three verdicts plus "NONE", for an account with no live verdict.
///
/// NONE is a separate value rather than a missing field so a caller that only reads
/// `verdict` cannot mistake "never assessed, or the assessment lapsed" for ALLOW.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CheckVerdict {
    #[serde(rename = "ALLOW")]
    Allow,
    #[serde(rename = "WARN")]
    Warn,
    #[serde(rename = "DENY")]
    Deny,
    #[serde(rename = "NONE")]
    NoVerdict,
}

impl From<Verdict> for CheckVerdict {
    fn from(verdict: Verdict) -> Self {
        match verdict {
            Verdict::Allow => CheckVerdict::Allow,
            Verdict::Warn => CheckVerdict::Warn,
            Verdict::Deny => CheckVerdict::Deny,
        }
    }
}

/// `check`'s answer: the live verdict and its reasons, and how many reports are open.
#[near(serializers = [json])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckView {
    pub verdict: CheckVerdict,
    /// The live verdict's reason codes; empty when `verdict` is NONE.
    pub reasons: Vec<String>,
    /// Open reports: the ones filed since the last oracle review, which `get_reports`
    /// lists. Not `report_count`, which also counts reports an oracle has reviewed and
    /// cleared. See `Registry::check` for why.
    pub reports: u32,
}

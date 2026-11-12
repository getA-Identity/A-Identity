//! The event ABI: NEP-297, standard "a_identity_registry", version "1.0.0".
//!
//! The event log is the registry's history, and the only one it has. State holds the
//! current verdict per account and the open reports; what a verdict said before it was
//! replaced, which reports an oracle reviewed and cleared, and who was an oracle when, exist
//! only here. That is why `clear_reports` can drop stored reports without destroying
//! anything: every report was logged in full the moment it was filed.
//!
//! Each line is `EVENT_JSON:{"standard":"a_identity_registry","version":"1.0.0",
//! "event":"<name>","data":{...}}`. `data` is a JSON object, which is what near-sdk's
//! `event_json` emits for a struct variant, and every event here is a struct variant. The
//! event name is the variant name in snake_case.
//!
//! Like the error names, these shapes are public ABI. Renaming a variant or a field changes
//! what indexers and the console see; add a variant, or a new version, instead.

use near_sdk::{AccountId, near};

use crate::types::{Verdict, VerdictRecord};

#[near(event_json(standard = "a_identity_registry"))]
pub enum RegistryEvent<'a> {
    /// A verdict was written, new or replacing. `by` is the oracle that wrote it. Score,
    /// code hash and expiry are not in the event; `get_verdict` has them.
    #[event_version("1.0.0")]
    VerdictSet {
        account_id: &'a AccountId,
        verdict: Verdict,
        reasons: &'a [String],
        evidence: Option<&'a str>,
        by: &'a AccountId,
    },
    /// An oracle removed an account's verdict. Emitted only when there was one to remove.
    #[event_version("1.0.0")]
    VerdictCleared {
        account_id: &'a AccountId,
        by: &'a AccountId,
    },
    /// A report was filed and its deposit kept.
    #[event_version("1.0.0")]
    ReportFiled {
        account_id: &'a AccountId,
        reporter: &'a AccountId,
        reason: &'a str,
        evidence: &'a str,
    },
    /// An oracle reviewed an account's open reports and cleared them. Emitted only when
    /// there were open reports.
    #[event_version("1.0.0")]
    ReportsCleared {
        account_id: &'a AccountId,
        by: &'a AccountId,
    },
    /// Also emitted by `new`, once per initial oracle, so the oracle set can be rebuilt from
    /// the log alone.
    #[event_version("1.0.0")]
    OracleAdded { account_id: &'a AccountId },
    #[event_version("1.0.0")]
    OracleRemoved { account_id: &'a AccountId },
    /// Also emitted by `new`, for the initial owner, for the same reason.
    #[event_version("1.0.0")]
    OwnerSet { owner_id: &'a AccountId },
}

impl<'a> RegistryEvent<'a> {
    /// The `verdict_set` event for a record about to be written. Built from the record, not
    /// from the input, so the event says exactly what was stored.
    pub(crate) fn verdict_set(account_id: &'a AccountId, record: &'a VerdictRecord) -> Self {
        RegistryEvent::VerdictSet {
            account_id,
            verdict: record.verdict,
            reasons: &record.reasons,
            evidence: record.evidence.as_deref(),
            by: &record.updated_by,
        }
    }
}

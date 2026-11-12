//! The input rules, as pure functions.
//!
//! Nothing in this file touches `env`, reads storage, or writes anything. It takes the
//! inputs of a call and answers whether they are acceptable, and with which stable error if
//! not. That keeps the rules cheap to test exhaustively: the interesting logic has no I/O to
//! mock, and the contract methods are left with authentication, storage and events.
//!
//! The order of the checks is observable behaviour, not an implementation detail. An input
//! that breaks two rules is refused with the first one in the order written here, and a
//! client branching on the name should get the same answer every time.

use near_sdk::{AccountId, NearToken};

use crate::error::Error;
use crate::types::{Report, VerdictInput};

/// The oracle set is bounded so `new` and `oracles()` stay cheap and so the set an owner
/// has to reason about stays small enough to audit by eye.
pub const MAX_ORACLES: u32 = 10;
/// Reason codes per verdict. The vault carries at most 3 into its refusal event; 8 leaves
/// room for an oracle to say more than the vault repeats.
pub const MAX_REASONS: usize = 8;
/// Bytes per reason code.
pub const MAX_CODE_LEN: usize = 32;
/// Bytes of evidence. Evidence is a pointer (a URL or a content hash), never the content.
pub const MAX_EVIDENCE_LEN: usize = 256;
/// Bytes of code hash: a base58 sha256 is 43 or 44 bytes and a hex one is 64.
pub const MAX_CODE_HASH_LEN: usize = 64;
/// The top of the off-chain engine's score scale.
pub const MAX_SCORE: u16 = 1000;
/// Entries per `set_verdicts`.
pub const MAX_BATCH: usize = 20;
/// Open reports per account.
pub const MAX_OPEN_REPORTS: usize = 20;
/// The runtime's `max_total_log_length`: the most log bytes one receipt may write
/// (`near-parameters` `parameters.yaml`: 16_384).
///
/// Twenty entries at every length limit fit under it when their evidence is plain ASCII, as
/// a URL or a hash is. They do not fit when the evidence is something JSON must escape: the
/// length rule counts stored bytes, and a control byte stored as one logs as six. So a batch
/// is measured before it writes anything, and refused with a name, instead of failing inside
/// the runtime with `TotalLogLengthExceeded` after the oracle has paid for the attempt.
pub const MAX_LOG_BYTES: usize = 16_384;
/// The page `list_verdicts` returns when the caller does not ask for one.
pub const DEFAULT_PAGE: u64 = 50;
/// The most `list_verdicts` returns in one call, whatever the caller asks for. A view has a
/// gas limit too, and a page that cannot be served is worse than a short one.
pub const MAX_PAGE: u64 = 100;

const NS_PER_S: u64 = 1_000_000_000;

/// The price of a report, kept in full by the contract.
///
/// It does two jobs. It pays for the storage a report occupies (a maximal first report,
/// 64-byte ids on both sides, takes 598 bytes, 0.00598 NEAR; a unit test measures it), and
/// it makes a report cost something, because reports are written by anyone and a free one is
/// a free way to fill a reviewer's queue. The excess over the storage cost is not refunded:
/// a refund would cut the price of a report to its storage alone, and even that comes back
/// to the registry, not the reporter, once an oracle clears the reports. Kept whole, every
/// report costs its filer 0.01 NEAR whether or not anyone ever reviews it.
pub const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);

/// A reason code is 1 to 32 bytes of `[a-z0-9_]`.
///
/// Codes are matched by machines, in the vault's events, the SDK and the console, so they
/// are kept to one spelling of one alphabet: no case, no punctuation, no Unicode look-alikes.
/// Empty is refused as well, because an empty code says nothing while still taking a slot.
pub fn check_code(code: &str) -> Result<(), Error> {
    let charset = code
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if code.is_empty() || code.len() > MAX_CODE_LEN || !charset {
        return Err(Error::InvalidReason);
    }
    Ok(())
}

/// At most 8 codes, each a valid code. The count is checked first, so a long list of bad
/// codes answers `TooManyReasons` without validating any of them.
pub fn check_reasons(reasons: &[String]) -> Result<(), Error> {
    if reasons.len() > MAX_REASONS {
        return Err(Error::TooManyReasons);
    }
    reasons.iter().try_for_each(|code| check_code(code))
}

/// At most 256 bytes. Bytes, not characters: storage and the log limit are paid in bytes.
pub fn check_evidence(evidence: &str) -> Result<(), Error> {
    if evidence.len() > MAX_EVIDENCE_LEN {
        return Err(Error::EvidenceTooLong);
    }
    Ok(())
}

/// 0 to 1000 inclusive, or absent.
pub fn check_score(score: Option<u16>) -> Result<(), Error> {
    match score {
        Some(score) if score > MAX_SCORE => Err(Error::ScoreOutOfRange),
        _ => Ok(()),
    }
}

/// At most 64 bytes, or absent.
pub fn check_code_hash(code_hash: Option<&str>) -> Result<(), Error> {
    match code_hash {
        Some(hash) if hash.len() > MAX_CODE_HASH_LEN => Err(Error::CodeHashTooLong),
        _ => Ok(()),
    }
}

/// The deadline a TTL gives, in block nanoseconds.
///
/// Absent and zero both mean no expiry. Zero follows the house rule that a zero bound means
/// no bound (the vault's cap, ceiling and key expiry read it the same way). The alternative
/// reading, "expire immediately", would let a client that sends 0 for "no TTL" write a DENY
/// that is already gone, and the vault no longer refuses a payee whose verdict reads as absent.
///
/// The multiplication and the addition are both checked. A deadline that wrapped would land
/// in the past and expire the verdict the moment it was written; it is refused instead.
pub fn expiry_ns(now_ns: u64, ttl_s: Option<u64>) -> Result<Option<u64>, Error> {
    match ttl_s {
        None | Some(0) => Ok(None),
        Some(ttl_s) => ttl_s
            .checked_mul(NS_PER_S)
            .and_then(|ttl_ns| now_ns.checked_add(ttl_ns))
            .map(Some)
            .ok_or(Error::MathOverflow),
    }
}

/// A verdict is live through its deadline inclusive, and dead strictly after it.
///
/// Strictly greater-than means expired, which is how the vault's key expiry and the Solidity
/// session key read a deadline too, so one sentence describes all three.
pub fn is_live(expires_at_ns: Option<u64>, now_ns: u64) -> bool {
    expires_at_ns.is_none_or(|deadline| now_ns <= deadline)
}

/// Every rule a verdict write is subject to, in order: the reasons, the evidence, the
/// score, the code hash, then the TTL. Returns the deadline the TTL gives.
pub fn check_verdict_input(input: &VerdictInput, now_ns: u64) -> Result<Option<u64>, Error> {
    check_reasons(&input.reasons)?;
    if let Some(evidence) = input.evidence.as_deref() {
        check_evidence(evidence)?;
    }
    check_score(input.score)?;
    check_code_hash(input.code_hash.as_deref())?;
    expiry_ns(now_ns, input.ttl_s.map(|ttl| ttl.0))
}

/// The rules for a new report that need nothing from state, in order: the deposit, the
/// reporter, the reason, the evidence.
///
/// The deposit is first because it is the price of being heard at all. Self-report is next:
/// a report an account files against itself carries no information about a counterparty,
/// and its only effect would be to take one of the account's own open slots, which is a
/// way to crowd out real reports without needing a second account.
pub fn check_new_report(
    deposit: NearToken,
    reporter: &AccountId,
    subject: &AccountId,
    reason: &str,
    evidence: &str,
) -> Result<(), Error> {
    if deposit < REPORT_DEPOSIT {
        return Err(Error::ReportDepositTooLow);
    }
    if reporter == subject {
        return Err(Error::SelfReport);
    }
    check_code(reason)?;
    check_evidence(evidence)
}

/// The rules that need the account's open reports: one open report per reporter, then the
/// cap. The duplicate check comes first because it is the more specific answer: a reporter
/// who already has a report open is told that, not that the list is full.
///
/// The cap refuses rather than evicting the oldest report. Evicting would let anyone with
/// 20 funded accounts push every honest report about an account out of state for 0.2 NEAR.
/// Refusing has its own cost, stated rather than hidden: the same 20 accounts can fill the
/// list so new reports wait for an oracle to review and clear it. Either way every report
/// is in the event log in full, so nothing filed is lost.
pub fn check_open_reports(open: &[Report], reporter: &AccountId) -> Result<(), Error> {
    if open.iter().any(|report| report.reporter == *reporter) {
        return Err(Error::DuplicateReport);
    }
    if open.len() >= MAX_OPEN_REPORTS {
        return Err(Error::ReportLimitReached);
    }
    Ok(())
}

/// The lifetime report counter, plus one. Checked: a counter that wrapped would claim an
/// account with four billion reports had never had one.
pub fn next_report_count(count: u32) -> Result<u32, Error> {
    count.checked_add(1).ok_or(Error::MathOverflow)
}

/// The total bytes a batch's events would log, refused when over the runtime's limit.
/// The sum is checked like every other accumulator here, although twenty bounded events
/// cannot reach `usize::MAX`.
pub fn check_log_budget(lines: &[String]) -> Result<(), Error> {
    let total = lines
        .iter()
        .try_fold(0usize, |total, line| total.checked_add(line.len()));
    match total {
        Some(total) if total <= MAX_LOG_BYTES => Ok(()),
        _ => Err(Error::BatchTooLarge),
    }
}

/// `(skip, take)` for a page request.
///
/// `from_index` is converted with `try_from`, never `as`: the contract runs on wasm32,
/// where `usize` is 32 bits, and `as` would wrap an index of 2^32 back to 0 and hand the
/// caller the first page when it asked for one past the end.
pub fn page(from_index: Option<u64>, limit: Option<u64>) -> (usize, usize) {
    let skip = usize::try_from(from_index.unwrap_or(0)).unwrap_or(usize::MAX);
    let take = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE);
    let take = usize::try_from(take).unwrap_or(0);
    (skip, take)
}

//! The error ABI.
//!
//! THESE NAMES ARE FROZEN. A refused call surfaces on chain as
//! `Smart contract panicked: <Name>`, and the TypeScript SDK and the console branch on that
//! name, so renaming a variant silently changes what a deployed contract appears to say.
//! The list is append-only. To retire a meaning, stop raising it and leave the variant in
//! place with a comment; never reuse a name for a different meaning.
//!
//! Every name is raised through [`Error::panic`], which calls `env::panic_str` with exactly
//! the name and nothing else. No formatting, no account ids, no amounts: a client matches
//! the whole message, and a message with data in it is a message nobody can match.
//!
//! The last three variants are not in the spec's list, and each is there because the spec's
//! list had no honest name for a refusal the contract needs:
//!
//! * `CodeHashTooLong`. The spec bounds `code_hash` at 64 bytes but names no error for it.
//!   Reusing `EvidenceTooLong` would send a client looking at the wrong field.
//! * `MathOverflow`. A TTL whose deadline does not fit in u64 nanoseconds, and a report
//!   counter at `u32::MAX`. Wrapping the deadline would put it in the past, which would
//!   expire a DENY the moment it was written, so it is refused by name instead. The vault
//!   uses the same name for the same class of refusal.
//! * `InitNotAllowed`. `new` is `#[init]` but open to any caller, so it also requires the
//!   registry account itself or the parent that creates it in the same batch. A deploy sent
//!   without its init must not let the first stranger name itself owner and oracle. The vault
//!   uses the same name for the same check.
//!
//! Two failures deliberately have NO name here, because near-sdk raises them in the
//! generated entry point before any code in this crate runs, and clients must expect the
//! SDK's own text for them:
//!
//! * A deposit attached to a method that is not `#[payable]`: "Method <name> doesn't
//!   accept deposit". Oracle writes are deliberately not payable, so an oracle can run on
//!   a function-call access key that can never attach one.
//! * A second `new`: "The contract has already been initialized".

use near_sdk::env;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// The caller is not the owner. Only the owner manages the oracle set and the owner.
    NotOwner,
    /// The caller is not an oracle. Verdicts and report reviews are oracle-only.
    NotOracle,
    /// The oracle set is full. Bounded so `oracles()` and `new` stay cheap.
    OracleLimitReached,
    /// A reason code is empty, longer than 32 bytes, or uses a byte outside `[a-z0-9_]`.
    InvalidReason,
    /// Evidence is longer than 256 bytes. It is a pointer (a URL or a hash), not a document.
    EvidenceTooLong,
    /// More than 8 reason codes on one verdict.
    TooManyReasons,
    /// A report was filed with less than `REPORT_DEPOSIT` attached.
    ReportDepositTooLow,
    /// This reporter already has an open report against this account.
    DuplicateReport,
    /// The reporter and the reported account are the same account.
    SelfReport,
    /// This account already has the maximum number of open reports. An oracle review
    /// (`clear_reports`) makes room.
    ReportLimitReached,
    /// More than 20 entries in one `set_verdicts`, or entries whose events would not fit
    /// in the runtime's per-receipt log limit.
    BatchTooLarge,
    /// A score above 1000.
    ScoreOutOfRange,
    /// An owner method was called without exactly 1 yoctoNEAR attached.
    RequiresOneYocto,
    /// A code hash longer than 64 bytes. Appended; see the module comment.
    CodeHashTooLong,
    /// A deadline or a counter would not fit its integer type. Appended; see the module
    /// comment.
    MathOverflow,
    /// `new` was called by an account that is neither the registry account itself nor its
    /// parent. Appended; see the module comment.
    InitNotAllowed,
}

impl Error {
    /// Every variant, in declaration order, so tests can hold the names to the spec.
    pub const ALL: [Error; 16] = [
        Error::NotOwner,
        Error::NotOracle,
        Error::OracleLimitReached,
        Error::InvalidReason,
        Error::EvidenceTooLong,
        Error::TooManyReasons,
        Error::ReportDepositTooLow,
        Error::DuplicateReport,
        Error::SelfReport,
        Error::ReportLimitReached,
        Error::BatchTooLarge,
        Error::ScoreOutOfRange,
        Error::RequiresOneYocto,
        Error::CodeHashTooLong,
        Error::MathOverflow,
        Error::InitNotAllowed,
    ];

    /// The stable name. It is the whole panic message.
    pub const fn as_str(self) -> &'static str {
        match self {
            Error::NotOwner => "NotOwner",
            Error::NotOracle => "NotOracle",
            Error::OracleLimitReached => "OracleLimitReached",
            Error::InvalidReason => "InvalidReason",
            Error::EvidenceTooLong => "EvidenceTooLong",
            Error::TooManyReasons => "TooManyReasons",
            Error::ReportDepositTooLow => "ReportDepositTooLow",
            Error::DuplicateReport => "DuplicateReport",
            Error::SelfReport => "SelfReport",
            Error::ReportLimitReached => "ReportLimitReached",
            Error::BatchTooLarge => "BatchTooLarge",
            Error::ScoreOutOfRange => "ScoreOutOfRange",
            Error::RequiresOneYocto => "RequiresOneYocto",
            Error::CodeHashTooLong => "CodeHashTooLong",
            Error::MathOverflow => "MathOverflow",
            Error::InitNotAllowed => "InitNotAllowed",
        }
    }

    /// Abort the call with the stable name. A panic reverts every write the call made, so
    /// a refused call leaves no partial state behind.
    pub fn panic(self) -> ! {
        env::panic_str(self.as_str())
    }
}

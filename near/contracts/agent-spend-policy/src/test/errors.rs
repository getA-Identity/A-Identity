//! The error names are public ABI: pinned here, in order, so an edit that renames, drops or
//! reorders one fails the test run instead of silently changing what a deployed vault says.

use super::assert_panics_with;
use crate::Error;

/// The spec's list (append-only), followed by what this crate appended.
const FROZEN_NAMES: [&str; 25] = [
    "NotOwner",
    "NotAgent",
    "Frozen",
    "SessionKeyExpired",
    "PayeeNotAllowed",
    "AboveAutoApprove",
    "DailyCapExceeded",
    "InvalidAmount",
    "InvalidPayee",
    "MathOverflow",
    "OwnerIsVault",
    "RegistryDeny",
    "RegistryUnavailable",
    "TransferFailed",
    "HeldLimitReached",
    "HeldNotFound",
    "HeldExpired",
    "KeyLimitReached",
    "KeyExists",
    "KeyNotFound",
    "KeyNotRevoked",
    "AllowlistFull",
    "MemoTooLong",
    "RequiresOneYocto",
    // Appended by this crate, after the spec's list.
    "NotCallback",
];

#[test]
fn names_are_frozen_in_order() {
    let names: Vec<&str> = Error::ALL.iter().map(|e| e.as_str()).collect();
    assert_eq!(names, FROZEN_NAMES);
}

#[test]
fn every_name_is_its_variant_and_unique() {
    for err in Error::ALL {
        assert_eq!(err.as_str(), format!("{err:?}"));
    }
    let mut names: Vec<&str> = Error::ALL.iter().map(|e| e.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), Error::ALL.len());
}

#[test]
fn a_panic_carries_exactly_the_name() {
    for err in Error::ALL {
        assert_panics_with(err.as_str(), || err.panic());
    }
}

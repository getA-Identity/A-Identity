//! The error names are public ABI: pinned here, in order, so an edit that renames, drops or
//! reorders one fails the test run instead of silently changing what a deployed vault says.

use super::assert_panics_with;
use crate::Error;

/// The spec's list (append-only), followed by what this crate appended.
const FROZEN_NAMES: [&str; 29] = [
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
    "GuardRefusalLimitReached",
    "StorageNotCovered",
    "InitNotAllowed",
    "BatchTooLarge",
];

#[test]
fn no_name_contains_another() {
    // A client that matches a failure text by substring must not mistake one name for another.
    for a in FROZEN_NAMES {
        for b in FROZEN_NAMES {
            if a != b {
                assert!(!a.contains(b), "{a} contains {b}");
            }
        }
    }
}

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

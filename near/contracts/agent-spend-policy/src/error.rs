//! The error ABI.
//!
//! On NEAR an error is a panic message, not a number. `Error::panic` hands `as_str()` to
//! `env::panic_str`, so a failed transaction's failure text is exactly the variant name, and a
//! refused payment carries the same name in `PayOutcome.reason` and in the `payment_refused`
//! event. The NAMES are therefore public ABI here, the way the discriminants are in the Soroban
//! sibling: the TypeScript SDK and the console match on `"DailyCapExceeded"`, so renaming a
//! variant silently changes what a deployed vault appears to say. This list is append-only. To
//! retire a meaning, stop returning it and leave the variant in place with a comment; never reuse
//! a name for something else.
//!
//! Two different delivery paths share these names, and a client has to know which one it is on:
//!
//! * A refusal of an AUTHENTICATED agent is not a panic. `pay`, `request_payment` and
//!   `record_refusal` return `PayOutcome { status: "refused", reason: Some(name) }` and emit
//!   `payment_refused`, so every refusal leaves a receipt and an event on chain. That is the
//!   product: a refusal nobody can see is indistinguishable from an outage.
//! * Everything else panics: a caller that is not the agent or not the owner, a missing yocto,
//!   a bad argument to an owner method. A panic writes nothing and logs nothing, which is the
//!   point for `NotAgent`: an unauthenticated caller must not be able to fill the vault's log.
//!
//! What has no counterpart in the Solidity original (`mcp/contracts/AgentSpendPolicy.sol`) or the
//! Soroban port, and why:
//!
//! * `InvalidAmount` covers `amount == 0`, as on Soroban; `uint256` on EVM accepts a zero payment.
//!   It also refuses a zero gas allowance in `add_agent_key`, because `Allowance::limited` cannot
//!   express zero and turning it into an unlimited allowance would let a leaked agent key burn the
//!   vault's whole NEAR balance on gas.
//! * `OwnerIsVault` is this chain's form of Soroban's `OwnerIsOperator`. The agent's key lives ON
//!   the vault account, so a vault that owned itself would let an agent key satisfy the owner
//!   check. Refused at `new`.
//! * `RegistryDeny`, `RegistryUnavailable`, `HeldLimitReached`, `HeldNotFound`, `HeldExpired`
//!   exist because this vault consults A-Identity's registry on chain and can hold a payment for
//!   the owner. Neither sibling does either.
//! * `KeyLimitReached`, `KeyExists`, `KeyNotFound`, `KeyNotRevoked` exist because agent keys are
//!   real NEAR access keys managed by the contract, not a single operator address.
//! * `MemoTooLong` bounds every free-text field (memo, reason, key label): the vault pays for the
//!   storage a held payment uses and for the log line every event writes.
//! * `RequiresOneYocto` replaces near-sdk's own `assert_one_yocto` message so the failure text is
//!   a stable name like every other error.
//! * `NotCallback` is appended after the spec's list. A callback is `#[private]`, but the agent's
//!   key signs as the vault account itself, so `#[private]` alone cannot tell a scheduled callback
//!   from a direct call. A real callback always has exactly one promise result and a direct call
//!   has none; anything else is refused with this name.
//! * `GuardRefusalLimitReached` is appended next. `record_refusal` writes a counter for each payee
//!   it names, and a payee name does not have to be an existing account, so the number of payees
//!   with a guard counter is bounded (`MAX_GUARD_PAYEES`). A record that would add one more is
//!   refused with this name and writes nothing; the owner frees room with
//!   `forget_guard_refusals`.
//! * `StorageNotCovered` is appended next. A receipt whose new storage the vault's NEAR cannot
//!   cover fails at its end with no event, and in a callback that would also strand the day's
//!   reservation. So a held payment or a payee's first guard counter is refused with this name
//!   instead of written when the vault's liquid NEAR is below `STORAGE_HEADROOM`.
//! * `InitNotAllowed` is appended next. `new` is `#[init]` but open to any caller, so it also
//!   requires the vault account itself or the parent account that creates it in the same batch:
//!   a deploy sent without its init must not let the first stranger make itself the owner.
//! * `BatchTooLarge` is appended last, with the registry's name for the same refusal.
//!   `forget_guard_refusals` and `forget_refusals` log one event per counter they remove, and a
//!   receipt may log at most 16384 bytes, which 100 removals of 64-byte payees overrun. So one
//!   call names at most `MAX_FORGET_BATCH` payees, and more is refused with this name before
//!   anything is removed, instead of failing in the runtime (`TotalLogLengthExceeded`) after
//!   the owner paid for the attempt.
//!
//! What the Solidity original has that this enum does not: `ZeroAddress` (a NEAR `AccountId` is
//! validated at deserialization, there is no zero account) and Solidity's `TransferFailed` as a
//! revert. Here `TransferFailed` is a `PayOutcome` reason reported by the transfer callback,
//! because the token call is asynchronous and cannot revert the payment that started it.

use near_sdk::env;

/// Every name the vault can answer with. Order and spelling are frozen (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    /// The caller is not the vault's owner.
    NotOwner,
    /// The caller is not an active agent key of this vault: the call did not come from the vault
    /// account itself, or the signing key is unknown or revoked.
    NotAgent,
    /// The owner froze the vault. The agent cannot spend or record; `owner_pay` still works.
    Frozen,
    /// The agent key's expiry has passed. The owner can extend it with `set_agent_expiry`.
    SessionKeyExpired,
    /// The allowlist is on and this payee is not on it.
    PayeeNotAllowed,
    /// A single payment above the auto-approve ceiling. This is the human-approval line: the
    /// agent should call `request_payment` instead.
    AboveAutoApprove,
    /// This payment would take the UTC day's cumulative spend over the cap.
    DailyCapExceeded,
    /// Amount is zero (or, in `add_agent_key`, the gas allowance is zero).
    InvalidAmount,
    /// Payee is the vault itself or the settlement token (or, in `new`, the token is the vault).
    InvalidPayee,
    /// The day accumulator (or an id counter) would overflow. Reached through checked
    /// arithmetic, never a wrap.
    MathOverflow,
    /// `new` was asked to make the vault its own owner.
    OwnerIsVault,
    /// The A-Identity registry says DENY for this payee.
    RegistryDeny,
    /// The registry call failed, or answered something that is not `null` or an object with a
    /// known `verdict` string. The vault fails closed: no verdict it can read means no payment.
    RegistryUnavailable,
    /// The token call failed: an underfunded vault, an unregistered payee the deposit could not
    /// register, a paused token, a vault or payee on the token's blocklist (Circle's USDC has
    /// both a pause switch and a blocklist), or a vault without the NEAR to attach the
    /// registration deposit. A callback sees only that the call failed, never the token's
    /// reason, so this one name covers them all. The day's reservation is released.
    TransferFailed,
    /// `MAX_PENDING_HELD` payments are already waiting for the owner, after expired ones were
    /// pruned.
    HeldLimitReached,
    /// No held payment has this id (never existed, already settled, rejected or pruned).
    HeldNotFound,
    /// The held payment's time to live has passed. It is removed when this is reported.
    HeldExpired,
    /// `MAX_AGENT_KEYS` records exist (revoked ones count until forgotten).
    KeyLimitReached,
    /// A record for this public key already exists, possibly revoked.
    KeyExists,
    /// No record for this public key.
    KeyNotFound,
    /// `forget_agent_key` on a key that is still active. Revoke it first.
    KeyNotRevoked,
    /// The allowlist already holds `MAX_ALLOWLIST` payees.
    AllowlistFull,
    /// A memo, reason or label is longer than its byte limit.
    MemoTooLong,
    /// An owner method that changes policy or moves money was called without exactly one
    /// yoctoNEAR attached.
    RequiresOneYocto,
    /// A callback was invoked directly, or with other than exactly one promise result.
    NotCallback,
    /// `record_refusal` named a payee with no guard counter while `MAX_GUARD_PAYEES` payees
    /// already have one. Nothing was written; `forget_guard_refusals` makes room.
    GuardRefusalLimitReached,
    /// The vault's NEAR above its storage stake is below `STORAGE_HEADROOM`, so it does not write
    /// the held payment or the new counter this call would add. Nothing moved and nothing was
    /// held; the owner tops the vault up with a plain NEAR transfer.
    StorageNotCovered,
    /// `new` was called by an account that is neither the vault account itself nor its parent.
    InitNotAllowed,
    /// `forget_guard_refusals` or `forget_refusals` named more than `MAX_FORGET_BATCH` payees.
    /// Nothing was removed; the owner splits the list over several calls.
    BatchTooLarge,
}

impl Error {
    /// Every variant, in ABI order. A test pins this list, so an edit that renames, removes or
    /// reorders a name fails the build's test run instead of shipping.
    pub const ALL: [Error; 29] = [
        Error::NotOwner,
        Error::NotAgent,
        Error::Frozen,
        Error::SessionKeyExpired,
        Error::PayeeNotAllowed,
        Error::AboveAutoApprove,
        Error::DailyCapExceeded,
        Error::InvalidAmount,
        Error::InvalidPayee,
        Error::MathOverflow,
        Error::OwnerIsVault,
        Error::RegistryDeny,
        Error::RegistryUnavailable,
        Error::TransferFailed,
        Error::HeldLimitReached,
        Error::HeldNotFound,
        Error::HeldExpired,
        Error::KeyLimitReached,
        Error::KeyExists,
        Error::KeyNotFound,
        Error::KeyNotRevoked,
        Error::AllowlistFull,
        Error::MemoTooLong,
        Error::RequiresOneYocto,
        Error::NotCallback,
        Error::GuardRefusalLimitReached,
        Error::StorageNotCovered,
        Error::InitNotAllowed,
        Error::BatchTooLarge,
    ];

    /// The stable name. Written out rather than derived from `Debug`, because `Debug` output is
    /// not a stability promise and this string is.
    pub const fn as_str(self) -> &'static str {
        match self {
            Error::NotOwner => "NotOwner",
            Error::NotAgent => "NotAgent",
            Error::Frozen => "Frozen",
            Error::SessionKeyExpired => "SessionKeyExpired",
            Error::PayeeNotAllowed => "PayeeNotAllowed",
            Error::AboveAutoApprove => "AboveAutoApprove",
            Error::DailyCapExceeded => "DailyCapExceeded",
            Error::InvalidAmount => "InvalidAmount",
            Error::InvalidPayee => "InvalidPayee",
            Error::MathOverflow => "MathOverflow",
            Error::OwnerIsVault => "OwnerIsVault",
            Error::RegistryDeny => "RegistryDeny",
            Error::RegistryUnavailable => "RegistryUnavailable",
            Error::TransferFailed => "TransferFailed",
            Error::HeldLimitReached => "HeldLimitReached",
            Error::HeldNotFound => "HeldNotFound",
            Error::HeldExpired => "HeldExpired",
            Error::KeyLimitReached => "KeyLimitReached",
            Error::KeyExists => "KeyExists",
            Error::KeyNotFound => "KeyNotFound",
            Error::KeyNotRevoked => "KeyNotRevoked",
            Error::AllowlistFull => "AllowlistFull",
            Error::MemoTooLong => "MemoTooLong",
            Error::RequiresOneYocto => "RequiresOneYocto",
            Error::NotCallback => "NotCallback",
            Error::GuardRefusalLimitReached => "GuardRefusalLimitReached",
            Error::StorageNotCovered => "StorageNotCovered",
            Error::InitNotAllowed => "InitNotAllowed",
            Error::BatchTooLarge => "BatchTooLarge",
        }
    }

    /// Abort the receipt with the stable name as the failure message. Nothing the receipt wrote
    /// survives, and no event it logged is kept.
    pub fn panic(self) -> ! {
        env::panic_str(self.as_str())
    }
}

//! The typed error ABI.
//!
//! THESE DISCRIMINANTS ARE FROZEN. They are public ABI: a client decodes an integer, not
//! a name, so renumbering a variant silently changes what a deployed contract appears to
//! say. This list is append-only. To retire a meaning, stop returning the code and leave
//! the variant in place with a comment; never reuse the number.
//!
//! Two things in this enum have no analogue in the Solidity original
//! (`mcp/contracts/AgentSpendPolicy.sol`), because the port is not a translation:
//!
//! * `InvalidAmount`. Solidity's `uint256` made a negative amount unrepresentable. Here
//!   the amount is an `i128`, and a SEP-41 `transfer(from, to, -1000)` is a withdrawal
//!   *from* `to` if it is not guarded. Worse than a panic: a negative amount would
//!   decrement the day counter, which resets the cap. That is a silent cap bypass, and
//!   the cap is the entire product.
//! * `InvalidPayee`. Paying the vault itself, or the token contract, moves nothing but
//!   still consumes the day's budget. A compromised operator could burn the whole cap at
//!   zero cost and deny the legitimate agent every day, forever.
//!
//! Two failures deliberately have NO code here, and clients must expect a host trap
//! rather than a numbered error:
//!
//! * A failed `require_auth()` is a host panic, not a contract error. There is no
//!   `NotOwner` or `NotOperator` code, and a client that waits for one will misreport an
//!   unauthorized call as a success path that returned nothing.
//! * A failed SAC `transfer` panics inside the token contract. Solidity checked a bool
//!   return; the SAC has no bool to check. `InsufficientBalance` exists so the common
//!   case is caught here, by name, before the token gets a chance to panic anonymously.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The owner froze the vault. The agent cannot spend at all; `owner_pay` still works.
    Frozen = 1,
    /// The session key's expiry has passed. The owner can extend, re-grant, or override.
    SessionKeyExpired = 2,
    /// The allowlist is on and this payee is not on it.
    PayeeNotAllowed = 3,
    /// A single payment above the auto-approve ceiling. This is the human-approval line.
    AboveAutoApprove = 4,
    /// This payment would take the UTC day's cumulative spend over the cap.
    DailyCapExceeded = 5,
    /// Amount is zero or negative. No Solidity analogue: `uint256` ruled it out.
    InvalidAmount = 6,
    /// Payee is the vault itself or the settlement token. No Solidity analogue.
    InvalidPayee = 7,
    /// The day accumulator would overflow. Reached through `checked_add`, never a panic.
    MathOverflow = 8,
    /// The vault does not hold enough to make this payment. Named here so an underfunded
    /// vault gives a reason the human path can act on, instead of an opaque token panic.
    InsufficientBalance = 9,
    /// Owner and operator are the same address. Refused at construction and on
    /// `set_operator`, because a single compromised key would then be able to both spend
    /// past the policy and lift the policy. The TypeScript vault path already refuses
    /// this (`mcp/src/platform/vault.ts`); enforcing it here makes it unbypassable.
    OwnerIsOperator = 10,
}

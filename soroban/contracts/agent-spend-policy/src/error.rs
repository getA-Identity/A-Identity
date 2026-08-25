//! The typed error ABI.
//!
//! THESE DISCRIMINANTS ARE FROZEN. They are public ABI: a client decodes an integer, not
//! a name, so renumbering a variant silently changes what a deployed contract appears to
//! say. This list is append-only. To retire a meaning, stop returning the code and leave
//! the variant in place with a comment; never reuse the number.
//!
//! FOUR things in this enum have no analogue in the Solidity original
//! (`mcp/contracts/AgentSpendPolicy.sol`), because the port is not a translation. This
//! said "two" until the 2026-08-25 audit counted them (finding A5-05a), and the two it
//! omitted are not the harmless ones:
//!
//! * `InvalidAmount`. Solidity's `uint256` made a negative amount unrepresentable; an
//!   `i128` does not. The SAC does reject a negative transfer itself, and the rollback
//!   means there was never a persistent cap bypass, contrary to what this comment claimed
//!   before a review corrected it. What the guard buys is the difference between an
//!   untyped host trap out of the token and a typed reason the client can name, and
//!   independence from whether the token happens to validate its own inputs.
//!
//!   It also covers a case the negative-amount story does not: `amount == 0`. Solidity's
//!   `pay(to, 0)` passes every gate, transfers nothing and still emits `Paid(to, 0, d,
//!   false)`. Here it is refused. That is a real behavioural divergence and a benign one,
//!   but anyone reconciling the two chains' event streams will find EVM `Paid` events with
//!   no Soroban counterpart, and this is the note that explains why.
//! * `InvalidPayee`. Paying the vault itself, or the token contract, moves nothing but
//!   still consumes the day's budget. A compromised operator could burn the whole cap at
//!   zero cost and deny the legitimate agent every day, forever. The EVM sibling still
//!   lacks this gate; it is tracked as open item G-1 rather than fixed here.
//! * `MathOverflow`. Solidity 0.8 raises `Panic(0x11)` on overflow, which is not a named
//!   error a client can branch on. `checked_add` plus a typed code is.
//! * `OwnerIsOperator`, and this is the one that matters, because it is a security check
//!   rather than an ergonomic one. The Solidity constructor rejects only a zero owner and
//!   a zero USDC address; it accepts `_owner == _operator`, and `setOperator` has no check
//!   at all. So the EVM contract can be put into a state where one key both spends past
//!   the policy and lifts the policy. This contract refuses that at construction and on
//!   `set_operator`. Soroban is strictly safer here, which is worth saying out loud rather
//!   than leaving as an unexplained extra variant.
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

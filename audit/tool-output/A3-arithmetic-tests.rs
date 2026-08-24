//! A3 audit: arithmetic, boundaries, conversions and ladder order.
//!
//! Written by the arithmetic audit agent. Every test here either kills a mutant that
//! survives the existing 52, or pins a boundary that nothing else asserts.

use super::{assert_error, setup, UNIT};
use crate::policy::{check_operator_pay, check_owner_pay, Snapshot};
use crate::Error;

const NOON: u64 = 1_786_795_200;
const DAY: u64 = 86_400;

// ── A3-01: the check_balance boundary (INV-08) ────────────────────────────────────
//
// `cargo mutants` reports `replace < with <= in check_balance` (policy.rs:120) as a
// SURVIVING mutant against the existing 52 tests. It survives because nothing asserts
// that paying EXACTLY the vault balance succeeds. Under the mutant, `balance <= amount`
// refuses the full-balance payment, so a vault could never be emptied through `pay`,
// `owner_pay` or `withdraw`: the last unit would be permanently stranded, and with no
// upgrade path that is unrecoverable. These three tests kill it.

#[test]
fn paying_exactly_the_vault_balance_succeeds() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 10 * UNIT);
    assert_eq!(s.client().balance(), 0, "the vault must be emptiable");
}

#[test]
fn owner_pay_of_exactly_the_vault_balance_succeeds() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.client().owner_pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.client().balance(), 0);
}

#[test]
fn withdrawing_exactly_the_vault_balance_succeeds() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.client().withdraw(&s.owner, &(10 * UNIT));
    assert_eq!(s.token().balance(&s.owner), 10 * UNIT);
    assert_eq!(s.client().balance(), 0, "withdraw must drain to zero");
}

#[test]
fn one_unit_over_the_balance_is_refused_on_every_money_path() {
    // The other side of the same boundary, so the pair pins `<` exactly.
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    assert_error(
        s.client().try_pay(&s.payee, &(10 * UNIT + 1)),
        Error::InsufficientBalance,
    );
    assert_error(
        s.client().try_owner_pay(&s.payee, &(10 * UNIT + 1)),
        Error::InsufficientBalance,
    );
    assert_error(
        s.client().try_withdraw(&s.owner, &(10 * UNIT + 1)),
        Error::InsufficientBalance,
    );
    assert_eq!(s.client().balance(), 10 * UNIT, "nothing moved");
}

#[test]
fn a_payment_of_the_last_remaining_unit_succeeds() {
    // The smallest representable positive amount at the smallest possible balance.
    let s = setup(0, 0);
    s.fund_vault(1);
    s.mock_auths();

    s.client().pay(&s.payee, &1);
    assert_eq!(s.token().balance(&s.payee), 1);
    assert_eq!(s.client().balance(), 0);
}

// ── A3-02: DailyCapExceeded fires BEFORE InsufficientBalance (INV-17) ─────────────
//
// The existing `the_gate_order_matches_the_solidity_original` stops at
// `AboveAutoApprove`. The last two rungs of the documented ladder are untested, and the
// lead auditor relied on exactly this ordering on mainnet.

#[test]
fn the_daily_cap_is_reported_before_the_balance() {
    let s = setup(UNIT, 0);
    s.fund_vault(UNIT / 2); // deliberately less than the amount asked for
    s.mock_auths();

    // Both gates are violated: 5 UNIT is over the 1 UNIT cap AND over the half-unit
    // balance. The ladder must name the cap, because "wait until tomorrow" and "fund the
    // vault" are different recoveries for the human-in-the-loop.
    assert_error(
        s.client().try_pay(&s.payee, &(5 * UNIT)),
        Error::DailyCapExceeded,
    );
}

#[test]
fn the_whole_operator_ladder_fires_in_order_including_the_last_two_rungs() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(UNIT / 2);
    s.mock_auths();
    s.set_time(NOON);

    s.client().set_policy(&UNIT, &UNIT, &true);
    s.client().set_frozen(&true);
    s.client().set_session_key_expiry(&(NOON - 1));

    // Every rung below is violated at once by `99 * UNIT` to a non-allowlisted payee.
    assert_error(s.client().try_pay(&s.payee, &0), Error::InvalidAmount);
    assert_error(s.client().try_pay(&s.payee, &(99 * UNIT)), Error::Frozen);

    s.client().set_frozen(&false);
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::SessionKeyExpired,
    );

    s.client().set_session_key_expiry(&0);
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::PayeeNotAllowed,
    );

    s.client().set_allowed(&s.payee, &true);
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::AboveAutoApprove,
    );

    // Lift the ceiling only. Cap and balance are both still violated; the cap wins.
    s.client().set_policy(&UNIT, &0, &true);
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::DailyCapExceeded,
    );

    // Lift the cap too. Now only the balance is left, and it must be named.
    s.client().set_policy(&0, &0, &true);
    assert_error(
        s.client().try_pay(&s.payee, &(99 * UNIT)),
        Error::InsufficientBalance,
    );

    assert_eq!(s.client().spent_today(), 0, "no refusal charged the day");
}

#[test]
fn math_overflow_is_reported_before_the_daily_cap_and_the_balance() {
    // The undocumented rung. `accumulate` runs between the ceiling and the cap, so a
    // day total near i128::MAX produces MathOverflow rather than DailyCapExceeded, even
    // though the cap is also exceeded. INV-17 does not list MathOverflow at all.
    let s = Snapshot {
        frozen: false,
        session_key_expiry: 0,
        now: NOON,
        allowlist_enabled: false,
        payee_allowed: false,
        auto_approve_max: 0,
        daily_cap: UNIT,      // violated
        spent_today: i128::MAX,
        vault_balance: 0,     // violated
    };
    assert_eq!(check_operator_pay(&s, UNIT), Err(Error::MathOverflow));
}

// ── A3-03: the negative-amount guard, on every money path ────────────────────────
//
// The OpenZeppelin "Spending Limit Policy Bypass By Specifying Negative Amount" finding.
// Verified reachable on all three paths, for the full range of negative i128, and proven
// to leave the day accumulator and the vault balance untouched.

#[test]
fn every_money_path_refuses_every_negative_amount() {
    let s = setup(0, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();

    // Seed a non-zero day total so a decrement would be visible.
    s.client().pay(&s.payee, &(10 * UNIT));
    let spent_before = s.client().spent_today();
    let balance_before = s.client().balance();
    assert_eq!(spent_before, 10 * UNIT);

    for amount in [
        i128::MIN,
        i128::MIN + 1,
        -(i128::MAX),
        -1_000_000_000_000_000_000i128,
        -(10 * UNIT),
        -UNIT,
        -2,
        -1,
        0,
    ] {
        assert_error(s.client().try_pay(&s.payee, &amount), Error::InvalidAmount);
        assert_error(
            s.client().try_owner_pay(&s.payee, &amount),
            Error::InvalidAmount,
        );
        assert_error(
            s.client().try_withdraw(&s.owner, &amount),
            Error::InvalidAmount,
        );
        assert_eq!(
            s.client().spent_today(),
            spent_before,
            "a refused amount must never move the day accumulator",
        );
        assert_eq!(
            s.client().balance(),
            balance_before,
            "a refused amount must never move value",
        );
    }
}

#[test]
fn the_pure_ladder_never_accepts_a_non_positive_amount() {
    // Independent of the token, which is the whole point of the guard: a SEP-41 token
    // that treated a negative transfer as a zero transfer must not be able to grow the
    // agent's remaining budget.
    for amount in [i128::MIN, -1, 0] {
        let s = Snapshot {
            frozen: false,
            session_key_expiry: 0,
            now: NOON,
            allowlist_enabled: false,
            payee_allowed: true,
            auto_approve_max: 0,
            daily_cap: 0,
            spent_today: 50 * UNIT,
            vault_balance: i128::MAX,
        };
        assert_eq!(check_operator_pay(&s, amount), Err(Error::InvalidAmount));
        assert_eq!(check_owner_pay(&s, amount), Err(Error::InvalidAmount));
    }
}

// ── A3-04: overflow boundaries on both ladders ───────────────────────────────────

#[test]
fn the_owner_ladder_overflows_by_name_rather_than_panicking() {
    // `check_owner_pay` has the shorter ladder and no cap gate, so `accumulate` is the
    // only thing between the sign check and the balance check.
    let s = setup(0, 0);
    s.mock_auths();
    s.fund_vault(i128::MAX);

    s.client().owner_pay(&s.payee, &(i128::MAX / 2));
    s.client().owner_pay(&s.payee, &(i128::MAX / 2));
    assert_error(
        s.client().try_owner_pay(&s.payee, &(i128::MAX / 2)),
        Error::MathOverflow,
    );
}

#[test]
fn the_exact_overflow_boundary_is_off_by_nothing() {
    let base = Snapshot {
        frozen: false,
        session_key_expiry: 0,
        now: NOON,
        allowlist_enabled: false,
        payee_allowed: true,
        auto_approve_max: 0,
        daily_cap: 0,
        spent_today: i128::MAX - 10,
        vault_balance: i128::MAX,
    };

    // Exactly reaching i128::MAX is fine.
    assert_eq!(check_operator_pay(&base, 10), Ok(i128::MAX));
    assert_eq!(check_owner_pay(&base, 10), Ok(i128::MAX));
    // One past it is MathOverflow, not a wrap and not a panic.
    assert_eq!(check_operator_pay(&base, 11), Err(Error::MathOverflow));
    assert_eq!(check_owner_pay(&base, 11), Err(Error::MathOverflow));
}

#[test]
fn a_daily_cap_of_i128_max_still_admits_a_payment() {
    let s = setup(i128::MAX, i128::MAX);
    s.fund_vault(UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.client().spent_today(), UNIT);
}

// ── A3-05: zero semantics, each sentinel independently (INV-16) ──────────────────
//
// `a_zero_cap_and_a_zero_ceiling_both_mean_unbounded` sets both to zero, through the
// CONSTRUCTOR only. `cargo mutants` reports `replace < with <= in set_policy`
// (lib.rs:163, twice) as surviving, because nothing calls `set_policy` with a zero.

#[test]
fn set_policy_accepts_a_zero_cap_and_a_zero_ceiling() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();

    s.client().set_policy(&0, &UNIT, &false);
    assert_eq!(s.client().daily_cap(), 0);
    assert_eq!(s.client().auto_approve_max(), UNIT);

    s.client().set_policy(&UNIT, &0, &false);
    assert_eq!(s.client().daily_cap(), UNIT);
    assert_eq!(s.client().auto_approve_max(), 0);

    s.client().set_policy(&0, &0, &false);
    assert_eq!(s.client().daily_cap(), 0);
    assert_eq!(s.client().auto_approve_max(), 0);
}

#[test]
fn a_zero_cap_alone_means_unbounded_while_the_ceiling_still_binds() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();

    s.client().set_policy(&0, &UNIT, &false);
    // Unbounded in total, still ceilinged per payment.
    for _ in 0..5 {
        s.client().pay(&s.payee, &UNIT);
    }
    assert_eq!(s.client().spent_today(), 5 * UNIT);
    assert_error(
        s.client().try_pay(&s.payee, &(2 * UNIT)),
        Error::AboveAutoApprove,
    );
}

#[test]
fn a_zero_ceiling_alone_means_unbounded_while_the_cap_still_binds() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();

    s.client().set_policy(&(10 * UNIT), &0, &false);
    s.client().pay(&s.payee, &(10 * UNIT)); // far above the old ceiling, allowed
    assert_error(s.client().try_pay(&s.payee, &1), Error::DailyCapExceeded);
}

#[test]
fn a_zero_session_key_expiry_means_unbounded_after_a_real_one_was_set() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().set_session_key_expiry(&(NOON - 1));
    assert_error(
        s.client().try_pay(&s.payee, &UNIT),
        Error::SessionKeyExpired,
    );
    // 0 must clear the bound, not set a bound at the epoch.
    s.client().set_session_key_expiry(&0);
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.token().balance(&s.payee), UNIT);
}

#[test]
fn the_pure_ladder_treats_each_zero_as_no_bound_at_extreme_inputs() {
    let s = Snapshot {
        frozen: false,
        session_key_expiry: 0,   // no time bound, even at u64::MAX
        now: u64::MAX,
        allowlist_enabled: false,
        payee_allowed: false,
        auto_approve_max: 0,     // no ceiling, even at i128::MAX
        daily_cap: 0,            // no cap, even at i128::MAX
        spent_today: 0,
        vault_balance: i128::MAX,
    };
    assert_eq!(check_operator_pay(&s, i128::MAX), Ok(i128::MAX));
}

// ── A3-06: today() and the day boundary ──────────────────────────────────────────

#[test]
fn the_day_index_is_safe_at_both_ends_of_u64() {
    let s = setup(0, 0);

    // A fresh Env starts at timestamp 0. Division by the constant 86_400 cannot trap.
    s.set_time(0);
    assert_eq!(s.client().today(), 0);

    s.set_time(86_399);
    assert_eq!(s.client().today(), 0, "the epoch day runs to 86_399");
    s.set_time(86_400);
    assert_eq!(s.client().today(), 1);

    // Far future. u64::MAX / 86_400 is representable; nothing wraps.
    s.set_time(u64::MAX);
    assert_eq!(s.client().today(), u64::MAX / 86_400);
    s.set_time(u64::MAX - 1);
    assert_eq!(s.client().today(), (u64::MAX - 1) / 86_400);
}

#[test]
fn two_full_daily_caps_can_move_across_a_utc_midnight_two_seconds_apart() {
    // Not a bug, but it is the documented consequence of a calendar-day bucket rather
    // than a rolling window, and INV-05 is stated per-day rather than per-24-hours.
    // Worth pinning so nobody "fixes" the bucket without noticing the widened window.
    let s = setup(10 * UNIT, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();

    let midnight = (NOON / DAY + 1) * DAY;
    s.set_time(midnight - 1);
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_error(s.client().try_pay(&s.payee, &1), Error::DailyCapExceeded);

    s.set_time(midnight);
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(
        s.token().balance(&s.payee),
        20 * UNIT,
        "two caps moved one second apart",
    );
}

// ── A3-07: the refusal ladder must not depend on which money path is taken ───────
//
// FAILS ON CURRENT CODE. `settle` runs `require_valid_payee` BEFORE `check_amount`;
// `withdraw` runs `check_amount` BEFORE `require_valid_payee`. So an input that violates
// both gets a different first reason depending on the entrypoint.

#[test]
fn a_doubly_invalid_input_names_the_same_first_reason_on_every_money_path() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    // Same two violations (payee is the vault itself, amount is zero), three paths.
    let via_pay = s.client().try_pay(&s.contract_id, &0);
    let via_owner_pay = s.client().try_owner_pay(&s.contract_id, &0);
    let via_withdraw = s.client().try_withdraw(&s.contract_id, &0);

    assert_error(via_pay, Error::InvalidAmount);
    assert_error(via_owner_pay, Error::InvalidAmount);
    assert_error(via_withdraw, Error::InvalidAmount);
}

// ── A3-08: property sweep over the pure ladder ───────────────────────────────────
//
// The ladder takes no Env, so it can be swept exhaustively over boundary values with no
// host in the way. This is the property test the crate has no proptest dependency for:
// a deterministic LCG over a pool of boundary and random i128/u64 values, asserting the
// money invariants on every accepted result.

struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        // SplitMix64. Deterministic, so a failure is reproducible from the seed alone.
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn pick_i128(&mut self) -> i128 {
        const POOL: [i128; 14] = [
            i128::MIN,
            i128::MIN + 1,
            -2,
            -1,
            0,
            1,
            2,
            UNIT,
            10 * UNIT,
            1_000_000 * UNIT,
            i128::MAX / 2,
            i128::MAX - 2,
            i128::MAX - 1,
            i128::MAX,
        ];
        let r = self.next_u64();
        if r % 3 == 0 {
            POOL[(r >> 8) as usize % POOL.len()]
        } else {
            // A wide but representable spread, including negatives.
            let hi = self.next_u64() as i128;
            let lo = self.next_u64() as i128;
            (hi << 64) | lo
        }
    }

    fn pick_u64(&mut self) -> u64 {
        const POOL: [u64; 6] = [0, 1, 86_399, 86_400, u64::MAX - 1, u64::MAX];
        let r = self.next_u64();
        if r % 3 == 0 {
            POOL[(r >> 8) as usize % POOL.len()]
        } else {
            r
        }
    }

    fn pick_bool(&mut self) -> bool {
        self.next_u64() & 1 == 1
    }
}

#[test]
fn the_operator_ladder_holds_its_money_invariants_over_a_boundary_sweep() {
    let mut rng = Lcg(0xA3_0000_0000_0001);

    for _ in 0..200_000 {
        let s = Snapshot {
            frozen: rng.pick_bool(),
            session_key_expiry: rng.pick_u64(),
            now: rng.pick_u64(),
            allowlist_enabled: rng.pick_bool(),
            payee_allowed: rng.pick_bool(),
            auto_approve_max: rng.pick_i128(),
            daily_cap: rng.pick_i128(),
            spent_today: rng.pick_i128(),
            vault_balance: rng.pick_i128(),
        };
        let amount = rng.pick_i128();

        match check_operator_pay(&s, amount) {
            Err(_) => {}
            Ok(next) => {
                // INV-09: nothing non-positive is ever accepted.
                assert!(amount > 0, "accepted a non-positive amount {amount}");
                // The returned total is the true sum, never a wrapped one.
                assert_eq!(
                    next,
                    s.spent_today.checked_add(amount).unwrap(),
                    "the returned day total is not the exact sum",
                );
                // INV-11: the day total never decreases.
                assert!(next > s.spent_today, "the day total went backwards");
                // INV-05: the cap holds whenever it is set.
                if s.daily_cap != 0 {
                    assert!(next <= s.daily_cap, "accepted past the daily cap");
                }
                // INV-06: the ceiling holds whenever it is set.
                if s.auto_approve_max != 0 {
                    assert!(amount <= s.auto_approve_max, "accepted past the ceiling");
                }
                // INV-08: never more than the vault holds.
                assert!(amount <= s.vault_balance, "accepted past the balance");
                // INV-13/14/15: the switches are respected.
                assert!(!s.frozen, "accepted while frozen");
                assert!(
                    s.session_key_expiry == 0 || s.now <= s.session_key_expiry,
                    "accepted past the session key expiry",
                );
                assert!(
                    !s.allowlist_enabled || s.payee_allowed,
                    "accepted a payee that is not allowlisted",
                );
            }
        }
    }
}

#[test]
fn the_owner_ladder_holds_its_money_invariants_over_a_boundary_sweep() {
    let mut rng = Lcg(0xA3_0000_0000_0002);

    for _ in 0..200_000 {
        let s = Snapshot {
            frozen: rng.pick_bool(),
            session_key_expiry: rng.pick_u64(),
            now: rng.pick_u64(),
            allowlist_enabled: rng.pick_bool(),
            payee_allowed: rng.pick_bool(),
            auto_approve_max: rng.pick_i128(),
            daily_cap: rng.pick_i128(),
            spent_today: rng.pick_i128(),
            vault_balance: rng.pick_i128(),
        };
        let amount = rng.pick_i128();

        if let Ok(next) = check_owner_pay(&s, amount) {
            assert!(amount > 0, "accepted a non-positive amount {amount}");
            assert_eq!(next, s.spent_today.checked_add(amount).unwrap());
            assert!(next > s.spent_today, "the day total went backwards");
            assert!(amount <= s.vault_balance, "accepted past the balance");
        }
    }
}

/// The invariant the threat model states for the daily cap, applied to `owner_pay`.
///
/// FAILS ON CURRENT CODE, and correctly so: `check_owner_pay` accumulates into the day
/// total but never compares it to `daily_cap`. This test exists to prove that INV-05 as
/// written in `audit/00-threat-model.md` does not hold, so that the invariant text is
/// corrected rather than the code.
#[test]
fn inv_05_as_written_the_sum_of_pay_and_owner_pay_stays_under_the_cap() {
    let s = setup(10 * UNIT, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(5 * UNIT));
    s.client().owner_pay(&s.payee, &(50 * UNIT));

    assert!(
        s.client().spent_today() <= 10 * UNIT,
        "INV-05: the sum of pay and owner_pay on a day must be <= daily_cap, got {}",
        s.client().spent_today(),
    );
}

// ── A3-09: the TTL constants are arithmetic, and their margins are untested ───────
//
// `cargo mutants` reports three surviving mutants on the const expressions in
// storage.rs:
//   storage.rs:57:42  replace * with + in DAY_BUCKET_TTL_EXTEND  (34_560 -> 17_282)
//   storage.rs:62:40  replace * with + in LONG_TTL_THRESHOLD     (1_036_800 -> 17_340)
//   storage.rs:62:40  replace * with / in LONG_TTL_THRESHOLD     (1_036_800 -> 0)
//
// They survive for two different reasons, and both are worth fixing:
//
//  * `the_day_bucket_survives_the_rest_of_its_own_day` advances by exactly
//    LEDGERS_PER_DAY, so the mutated 17_282-ledger floor still clears it, by two
//    ledgers. The test intends to prove a two-day floor and actually proves a
//    two-LEDGER one.
//  * `the_instance_ttl_is_extended_by_a_payment` asserts `ttl >= LONG_TTL_THRESHOLD`,
//    which is the mutated constant itself. A self-referential assertion cannot detect a
//    change to the thing it reads.

#[test]
fn the_ttl_constants_are_the_numbers_the_safety_argument_rests_on() {
    // Literals on purpose. An assertion written in terms of the constant it is checking
    // agrees with any value that constant takes.
    assert_eq!(crate::storage::LEDGERS_PER_DAY, 17_280);
    assert_eq!(crate::storage::DAY_BUCKET_TTL_THRESHOLD, 17_280);
    assert_eq!(
        crate::storage::DAY_BUCKET_TTL_EXTEND,
        34_560,
        "the day bucket's floor must be TWO days, so a bucket written at 00:00:01 \
         outlives its own UTC day with a full day to spare",
    );
    assert_eq!(crate::storage::LONG_TTL_THRESHOLD, 1_036_800);
    assert_eq!(crate::storage::LONG_TTL_EXTEND, 2_592_000);

    // The relations the comments in storage.rs claim, stated as arithmetic.
    assert!(crate::storage::DAY_BUCKET_TTL_EXTEND >= 2 * crate::storage::LEDGERS_PER_DAY);
    assert!(crate::storage::LONG_TTL_EXTEND > crate::storage::LONG_TTL_THRESHOLD);
    // Live pubnet max_entry_ttl under protocol 27, read 2026-08-15.
    assert!(crate::storage::LONG_TTL_EXTEND <= 3_110_400);
}

#[test]
fn the_day_bucket_outlives_its_own_day_with_a_full_day_to_spare() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &(10 * UNIT));

    // A day and a half of ledgers. Inside the intended two-day floor, well outside the
    // one-day-plus-two-ledgers floor a `*`-to-`+` typo would leave.
    s.advance_ledgers(crate::storage::LEDGERS_PER_DAY + crate::storage::LEDGERS_PER_DAY / 2);
    assert_eq!(
        s.client().spent_today(),
        10 * UNIT,
        "the bucket expired inside its own day, so the cap silently reset",
    );
}

#[test]
fn a_payment_leaves_the_instance_entry_above_a_literal_floor() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.advance_ledgers(100_000);
    s.client().pay(&s.payee, &UNIT);

    use soroban_sdk::testutils::Deployer as _;
    let ttl = s.env.deployer().get_contract_instance_ttl(&s.contract_id);
    // 60 days of ledgers, as a literal. Asserting against LONG_TTL_THRESHOLD would agree
    // with any value that constant took, which is why the existing test cannot see a
    // change to it.
    assert!(
        ttl >= 1_036_800,
        "pay must leave the instance entry at least 60 days out, got {ttl}",
    );
}

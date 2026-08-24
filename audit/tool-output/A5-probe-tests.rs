#![cfg(test)]
//! A5 economic-logic probes. AUDIT SCRATCH ONLY, not part of the shipped suite.

use super::{assert_error, setup, UNIT};
use crate::Error;
extern crate std;
use soroban_sdk::testutils::storage::Temporary as _;
use soroban_sdk::testutils::{Address as _, Events as _, Ledger as _};
use soroban_sdk::{token, Address};

const NOON: u64 = 1_786_795_200;
const DAY: u64 = 86_400;

// ─────────────────────────────────────────────────────────────────────────────
// Q1 / INV-05
// ─────────────────────────────────────────────────────────────────────────────

/// INV-05 says: for any UTC day with daily_cap != 0, the sum of all amounts moved by
/// `pay` AND `owner_pay` is <= daily_cap. This test asserts exactly that and MUST FAIL.
#[test]
fn a5_inv05_sum_of_pay_and_owner_pay_stays_within_daily_cap() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    // The agent spends the day out, legitimately.
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);

    // The owner then settles 500 units on the SAME UTC day. No cap gate runs.
    s.client().owner_pay(&s.payee, &(500 * UNIT));

    let moved = s.token().balance(&s.payee);
    assert_eq!(s.client().today(), NOON / DAY);
    assert!(
        moved <= s.client().daily_cap(),
        "INV-05 broken: {} moved on day {} against a daily_cap of {}",
        moved,
        s.client().today(),
        s.client().daily_cap()
    );
}

/// The accumulator itself is driven past the cap and stays there, which is the
/// mechanism: `check_owner_pay` accumulates but never compares against `daily_cap`.
#[test]
fn a5_owner_pay_drives_the_accumulator_past_the_cap() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().owner_pay(&s.payee, &(500 * UNIT));
    assert_eq!(s.client().spent_today(), 500 * UNIT);
    assert_eq!(s.client().daily_cap(), 10 * UNIT);
    // Repeatable without limit within the same day.
    s.client().owner_pay(&s.payee, &(400 * UNIT));
    assert_eq!(s.client().spent_today(), 900 * UNIT);
}

/// Lowering the cap mid-day below spent_today: no claw-back, no underflow, agent simply
/// blocked for the rest of the day. Raising it re-opens budget immediately.
#[test]
fn a5_set_policy_midday_cap_moves_are_not_exploitable() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.client().spent_today(), 10 * UNIT);

    // LOWER below spent_today.
    s.client().set_policy(&(1 * UNIT), &(100 * UNIT), &false);
    assert_eq!(s.client().spent_today(), 10 * UNIT, "no claw-back");
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
    // Zero is "no bound", not "bound of zero": lowering to 0 UNLOCKS everything.
    s.client().set_policy(&0, &(100 * UNIT), &false);
    s.client().pay(&s.payee, &(100 * UNIT));
    assert_eq!(s.client().spent_today(), 110 * UNIT);

    // RAISE. Budget re-opens for the remainder of the same day.
    s.client().set_policy(&(200 * UNIT), &(100 * UNIT), &false);
    s.client().pay(&s.payee, &(90 * UNIT));
    assert_eq!(s.client().spent_today(), 200 * UNIT);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
}

/// The UTC-day bucket makes 2x daily_cap reachable inside a two-second window straddling
/// midnight. Not an INV-05 violation (INV-05 is per calendar day) but it is the real
/// rate limit.
#[test]
fn a5_two_full_caps_move_across_the_midnight_boundary_in_two_seconds() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();

    let midnight = (NOON / DAY + 1) * DAY;
    s.set_time(midnight - 1);
    s.client().pay(&s.payee, &(10 * UNIT));
    s.set_time(midnight);
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 20 * UNIT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Q2 / INV-07 withdraw
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn a5_inv07_withdraw_never_touches_the_day_accumulator() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().pay(&s.payee, &(4 * UNIT));
    let before = s.client().spent_today();
    s.client().withdraw(&s.owner, &(900 * UNIT));
    assert_eq!(s.client().spent_today(), before, "withdraw must not move it");
    // And it cannot be used to reset it either: still capped afterwards.
    s.client().pay(&s.payee, &(6 * UNIT));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
}

/// The operator cannot reach withdraw. Real auth, not mocked.
#[test]
fn a5_operator_cannot_reach_withdraw() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.enforce_auth();
    let r = s.client().try_withdraw(&s.operator, &UNIT);
    assert!(
        matches!(r, Err(Err(_))),
        "expected a host trap from require_auth, got {r:?}"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Q3 griefing
// ─────────────────────────────────────────────────────────────────────────────

/// The refund grief. `require_valid_payee` blocks the vault and the token, but a
/// compromised operator can pay any OTHER address it controls and send the funds
/// straight back. Net token cost: zero. The day's cap is burned and the honest agent is
/// denied for the rest of the UTC day.
#[test]
fn a5_grief_burn_the_cap_at_zero_net_cost_via_a_refunding_payee() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    let attacker = Address::generate(&s.env);
    let vault_before = s.token().balance(&s.contract_id);

    // Operator burns the whole day's cap to an address it controls.
    s.client().pay(&attacker, &(10 * UNIT));
    // ...and hands it straight back. No net loss to the vault.
    token::Client::new(&s.env, &s.token_id).transfer(&attacker, &s.contract_id, &(10 * UNIT));

    assert_eq!(s.token().balance(&s.contract_id), vault_before, "zero cost");
    assert_eq!(s.client().spent_today(), 10 * UNIT, "cap fully burned");
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
}

/// Dust repetition is NOT a cheap grief: each call costs its own amount, so burning the
/// cap costs the cap. Recorded so the report can say which grief is real.
#[test]
fn a5_dust_repetition_costs_the_full_cap() {
    let s = setup(100, 0);
    s.fund_vault(1_000);
    s.mock_auths();
    s.set_time(NOON);
    for _ in 0..100 {
        s.client().pay(&s.payee, &1);
    }
    assert_eq!(s.client().spent_today(), 100);
    assert_eq!(s.token().balance(&s.payee), 100, "the grief cost 100 units");
}

// ─────────────────────────────────────────────────────────────────────────────
// Q4 INV-13/14/15
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn a5_inv13_freeze_blocks_pay_and_leaves_both_owner_paths_working() {
    let s = setup(0, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().set_frozen(&true);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::Frozen);
    s.client().owner_pay(&s.payee, &UNIT);
    s.client().withdraw(&s.owner, &UNIT);
}

#[test]
fn a5_inv14_expiry_blocks_pay_and_leaves_both_owner_paths_working() {
    let s = setup(0, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.set_time(NOON);
    s.client().set_session_key_expiry(&(NOON - 1));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::SessionKeyExpired);
    s.client().owner_pay(&s.payee, &UNIT);
    s.client().withdraw(&s.owner, &UNIT);
}

#[test]
fn a5_inv15_allowlist_blocks_pay_and_leaves_both_owner_paths_working() {
    let s = setup(0, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().set_policy(&0, &0, &true);
    assert_error(s.client().try_pay(&s.stranger, &UNIT), Error::PayeeNotAllowed);
    s.client().owner_pay(&s.stranger, &UNIT);
    s.client().withdraw(&s.stranger, &UNIT);
}

/// PROOF that the session key is the LEDGER CLOCK and not storage lifetime.
///
/// Axis 1: burn 500 days of LEDGER SEQUENCE (which expires every temporary entry and
/// would archive anything storage-lifetime-based) while holding the CLOCK before the
/// expiry. `pay` still works, so nothing about the permission is tied to storage age.
///
/// Axis 2: move the CLOCK one second past the expiry without advancing the sequence at
/// all. `pay` refuses. Only the clock moved.
#[test]
fn a5_session_key_is_the_ledger_clock_not_storage_expiry() {
    let s = setup(0, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.set_time(NOON);
    s.client().set_session_key_expiry(&(NOON + 3_600));

    s.advance_ledgers(500 * crate::storage::LEDGERS_PER_DAY);
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.client().session_key_expiry(), NOON + 3_600);

    s.set_time(NOON + 3_601);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::SessionKeyExpired);
}

// ─────────────────────────────────────────────────────────────────────────────
// Q5 state machine
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn a5_allowlist_can_be_enabled_over_an_empty_set_and_locks_the_agent_out() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().set_policy(&(10 * UNIT), &(100 * UNIT), &true);
    assert!(!s.client().is_allowed(&s.payee));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::PayeeNotAllowed);
    // Recovery is a second owner call. There is no atomic set-policy-with-payees.
    s.client().set_allowed(&s.payee, &true);
    s.client().pay(&s.payee, &UNIT);
}

/// Repeating a transition is accepted and still emits an event claiming a change.
#[test]
fn a5_no_op_transitions_still_emit_change_events() {
    let s = setup(0, 0);
    s.mock_auths();
    s.client().set_frozen(&false); // was already false
    s.client().set_allowed(&s.stranger, &false); // never was allowed
    s.client().set_operator(&s.operator); // same operator
    let n = s
        .env
        .events()
        .all()
        .filter_by_contract(&s.contract_id)
        .events()
        .len();
    // `all()` reports the LAST invocation only, so this asserts the last no-op call
    // (set_operator to the operator already in storage) still published an OperatorSet.
    assert_eq!(n, 1, "a no-op set_operator published {n} events");
}

// ─────────────────────────────────────────────────────────────────────────────
// Q6 completeness of the outflow record
// ─────────────────────────────────────────────────────────────────────────────

/// The accumulator alone is NOT a record of outflow: `withdraw` moves value without
/// touching it. Only Paid + Withdrawn together reconcile against the balance.
#[test]
fn a5_accumulator_alone_does_not_reconcile_with_outflow() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().pay(&s.payee, &(10 * UNIT));
    s.client().owner_pay(&s.payee, &(90 * UNIT));
    s.client().withdraw(&s.stranger, &(400 * UNIT));

    let outflow = 1_000 * UNIT - s.token().balance(&s.contract_id);
    assert_eq!(outflow, 500 * UNIT);
    assert_eq!(s.client().spent_today(), 100 * UNIT);
    assert!(outflow > s.client().spent_today(), "the gap is withdraw");
}

// ─────────────────────────────────────────────────────────────────────────────
// Refusal-ladder consistency (INV-17)
// ─────────────────────────────────────────────────────────────────────────────

/// `settle` runs require_valid_payee BEFORE check_amount; `withdraw` runs them the other
/// way round. The same pair of bad arguments therefore gets two different names
/// depending on the entrypoint.
#[test]
fn a5_the_refusal_ladder_orders_payee_and_amount_differently_per_entrypoint() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    let vault = s.contract_id.clone();

    assert_error(s.client().try_pay(&vault, &0), Error::InvalidPayee);
    assert_error(s.client().try_owner_pay(&vault, &0), Error::InvalidPayee);
    // Same arguments, opposite answer.
    assert_error(s.client().try_withdraw(&vault, &0), Error::InvalidAmount);
}

// ─────────────────────────────────────────────────────────────────────────────
// Day-bucket TTL under PUBNET ledger parameters
// ─────────────────────────────────────────────────────────────────────────────

/// storage.rs claims "every write extends to a two-day floor". Under the pubnet
/// parameters recorded in that same file (min_temporary_ttl = 17,280 = LEDGERS_PER_DAY)
/// the threshold test in `extend_ttl` is "TTL strictly below threshold", so a
/// freshly-created bucket may not clear it. Measure what the bucket actually gets.
#[test]
fn a5_day_bucket_ttl_under_pubnet_parameters() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.env.ledger().with_mut(|l| {
        l.min_temp_entry_ttl = crate::storage::LEDGERS_PER_DAY;
        l.min_persistent_entry_ttl = 2_073_600;
        l.max_entry_ttl = 3_110_400;
    });
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);
    s.client().pay(&s.payee, &UNIT);

    let day = s.client().today();
    let ttl = s.env.as_contract(&s.contract_id, || {
        s.env.storage()
            .temporary()
            .get_ttl(&crate::storage::DataKey::SpentOnDay(day))
    });
    std::println!("A5: day-bucket TTL after first write = {ttl} ledgers");
    std::println!("A5: DAY_BUCKET_TTL_EXTEND = {}", crate::storage::DAY_BUCKET_TTL_EXTEND);
    assert!(
        ttl >= crate::storage::DAY_BUCKET_TTL_EXTEND,
        "the documented two-day floor was not applied: got {ttl}, wanted >= {}",
        crate::storage::DAY_BUCKET_TTL_EXTEND
    );
}

/// The consequence if the bucket does die inside its own UTC day: the cap silently
/// resets and the agent spends a second full cap on the same calendar day. This models
/// it directly by expiring the entry mid-day.
#[test]
fn a5_an_early_bucket_expiry_hands_back_a_second_full_cap_on_the_same_day() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    s.client().pay(&s.payee, &(10 * UNIT));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);

    // Same UTC day, bucket gone.
    s.advance_ledgers(3 * crate::storage::LEDGERS_PER_DAY);
    assert_eq!(s.client().today(), NOON / DAY, "clock must not have moved");
    assert_eq!(s.client().spent_today(), 0);

    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(
        s.token().balance(&s.payee),
        20 * UNIT,
        "two full caps on one UTC day"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Parity with the Solidity original
// ─────────────────────────────────────────────────────────────────────────────

/// Solidity `pay(to, 0)` succeeds: uint256 zero passes every gate and emits Paid.
/// Here it is refused. The error.rs note explains the NEGATIVE case only.
#[test]
fn a5_parity_zero_amount_is_refused_here_but_accepted_by_solidity() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    assert_error(s.client().try_pay(&s.payee, &0), Error::InvalidAmount);
}

/// Solidity's constructor and setOperator accept owner == operator. This one refuses,
/// and error.rs lists only TWO codes as having no Solidity analogue.
#[test]
fn a5_parity_owner_is_operator_has_no_solidity_analogue_either() {
    let s = setup(0, 0);
    s.mock_auths();
    let r = s.client().try_set_operator(&s.owner);
    assert_error(r, Error::OwnerIsOperator);
}


/// INV-16: each zero means "no bound", never "bound of zero", on all three switches.
#[test]
fn a5_inv16_every_zero_means_no_bound() {
    let s = setup(0, 0);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);
    assert_eq!(s.client().session_key_expiry(), 0);

    // daily_cap 0: the operator can move the entire vault in one UTC day.
    s.client().pay(&s.payee, &(500 * UNIT));
    s.client().pay(&s.payee, &(500 * UNIT));
    assert_eq!(s.token().balance(&s.contract_id), 0);
    assert_eq!(s.client().spent_today(), 1_000 * UNIT);
}

/// `set_policy` is a full-struct overwrite with no partial update and no
/// compare-and-swap: tightening the cap forces the owner to restate the ceiling and the
/// allowlist flag, and a stale client silently reverts the other two.
#[test]
fn a5_set_policy_is_a_whole_struct_overwrite_with_no_compare_and_swap() {
    let s = setup(10 * UNIT, 1 * UNIT);
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);
    s.client().set_policy(&(10 * UNIT), &(1 * UNIT), &true);
    s.client().set_allowed(&s.payee, &true);
    assert_error(
        s.client().try_pay(&s.payee, &(2 * UNIT)),
        Error::AboveAutoApprove,
    );

    // The owner now wants ONLY to lower the cap, and uses a stale snapshot of the other
    // two fields. The ceiling and the allowlist are silently thrown away.
    s.client().set_policy(&(5 * UNIT), &0, &false);
    assert_eq!(s.client().auto_approve_max(), 0, "ceiling gone");
    assert!(!s.client().allowlist_enabled(), "allowlist gone");
    s.client().pay(&s.stranger, &(5 * UNIT));
}

/// Empirical probe of the host's extend_ttl threshold semantics and the initial TTL of a
/// freshly created temporary entry. No assertions: this exists to print facts.
#[test]
fn a5_probe_raw_temporary_ttl_semantics() {
    let s = setup(0, 0);
    for min_ttl in [17_280u32, 17_281, 34_559, 34_560, 34_561] {
        s.env.ledger().with_mut(|l| {
            l.min_temp_entry_ttl = min_ttl;
            l.max_entry_ttl = 3_110_400;
        });
        s.env.as_contract(&s.contract_id, || {
            let k = crate::storage::DataKey::SpentOnDay(min_ttl as u64);
            s.env.storage().temporary().set(&k, &1i128);
            let raw = s.env.storage().temporary().get_ttl(&k);
            s.env.storage().temporary().extend_ttl(
                &k,
                crate::storage::DAY_BUCKET_TTL_THRESHOLD,
                crate::storage::DAY_BUCKET_TTL_EXTEND,
            );
            let after = s.env.storage().temporary().get_ttl(&k);
            std::println!(
                "A5: min_temp_entry_ttl={min_ttl} -> ttl_after_set={raw} ttl_after_extend={after}"
            );
        });
    }
}

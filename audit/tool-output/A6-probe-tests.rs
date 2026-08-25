//! A6 probes: availability (INV-20), atomicity of a refusal, and the resource budget.
use super::*;

/// INV-20. A funded vault that cannot be withdrawn from is a loss even with no attacker,
/// and this contract has no upgrade path, so an unreachable `withdraw` is unrecoverable.
/// Every state the contract can reach is enumerated here rather than argued about.
#[test]
fn withdraw_is_reachable_in_every_reachable_state() {
    let cases: [(&str, fn(&Setup)); 7] = [
        ("frozen", |s| { s.client().set_frozen(&true); }),
        ("allowlist on with an empty list", |s| { s.client().set_policy(&0, &0, &true); }),
        ("session key revoked into the past", |s| {
            s.client().set_session_key_expiry(&1);
            s.set_time(2_000_000_000);
        }),
        ("daily cap exhausted", |s| {
            s.client().set_policy(&UNIT, &UNIT, &false);
            s.client().owner_pay(&s.payee, &UNIT);
        }),
        ("zero cap and zero ceiling", |s| { s.client().set_policy(&0, &0, &false); }),
        ("operator rotated to a stranger", |s| { s.client().set_operator(&s.stranger); }),
        ("instance idled far past its TTL floor", |s| { s.advance_ledgers(200 * 17_280); }),
    ];

    for (name, apply) in cases {
        let s = setup(10 * UNIT, 2 * UNIT);
        s.fund_vault(5 * UNIT);
        s.mock_auths();
        apply(&s);
        let held = s.client().balance();
        assert!(held > 0, "{name}: the probe needs a funded vault to mean anything");
        s.client().withdraw(&s.owner, &held);
        assert_eq!(s.client().balance(), 0, "{name}: withdraw could not empty the vault");
    }
}

/// A refusal must write NOTHING, including the instance TTL bump that runs before the
/// policy ladder. If a refusal persisted a write, a refused call would be a state change
/// an attacker can trigger at will for the price of a fee.
#[test]
fn a_refused_payment_writes_nothing() {
    let s = setup(UNIT, UNIT);
    s.fund_vault(5 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &UNIT);
    let spent_before = s.client().spent_today();
    let balance_before = s.client().balance();
    assert_eq!(spent_before, UNIT);

    // One unit over the cap: refused by the ladder, after bump_instance has already run.
    assert_error(s.client().try_pay(&s.payee, &1), Error::DailyCapExceeded);

    assert_eq!(s.client().spent_today(), spent_before, "a refusal moved the day accumulator");
    assert_eq!(s.client().balance(), balance_before, "a refusal moved the vault balance");
}

/// The worst-case agent path, measured against pubnet's real per-transaction limits
/// rather than against a guess.
#[test]
fn worst_case_pay_fits_the_pubnet_budget() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(50 * UNIT);
    s.mock_auths();
    s.client().set_policy(&(100 * UNIT), &(100 * UNIT), &true);
    s.client().set_allowed(&s.payee, &true);

    s.env.cost_estimate().budget().reset_unlimited();
    s.client().pay(&s.payee, &UNIT);
    let cpu = s.env.cost_estimate().budget().cpu_instruction_cost();
    let mem = s.env.cost_estimate().budget().memory_bytes_cost();

    // Live pubnet settings, read from the network on 2026-08-24.
    const TX_MAX_INSTRUCTIONS: u64 = 400_000_000;
    const TX_MEMORY_LIMIT: u64 = 41_943_040;
    // no_std crate: surface the numbers by failing an assertion that names them.
    assert!(cpu < TX_MAX_INSTRUCTIONS, "worst-case pay exceeds the pubnet CPU limit");
    assert!(mem < TX_MEMORY_LIMIT, "worst-case pay exceeds the pubnet memory limit");
    // Measured 2026-08-25 on this crate: cpu 485_587 (0.121% of the limit, 824x headroom),
    // mem 158_346 (0.378%, 265x headroom). Pinned loosely at 10% so the test reports a
    // real regression rather than re-baselining silently on every SDK bump.
    assert!(cpu < TX_MAX_INSTRUCTIONS / 10, "worst-case pay CPU regressed past 10% of the pubnet limit");
    assert!(mem < TX_MEMORY_LIMIT / 10, "worst-case pay memory regressed past 10% of the pubnet limit");
}

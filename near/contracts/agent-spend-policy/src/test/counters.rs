//! The per-payee counters an agent key can make the vault create, and their bounds.
//!
//! A counter is a storage entry, and a payee name does not have to be an existing account, so
//! without a bound any agent key could lock the vault's NEAR in counters for names it makes up
//! (`record_refusal`), or for every payee a registry DENYs (`refusal_count`). These tests hold
//! the bounds to bytes: what a counter costs, that the bound stops new ones, that a counter that
//! exists still counts, that the owner can free a slot, and that nothing is written when the
//! vault's NEAR could not cover it.
//!
//! The mocked blockchain starts every context at the same storage usage, and `store`
//! collections write only when flushed. So a test flushes what earlier contexts buffered, then
//! measures within one context, flushing again before it reads the usage back.

use near_sdk::json_types::U128;
use near_sdk::{AccountId, env};

use super::*;
use crate::{MAX_FORGET_BATCH, MAX_GUARD_PAYEES, MAX_REFUSAL_PAYEES};

const DENY: &str = r#"{"verdict":"DENY","reasons":["drainer"]}"#;

/// A distinct payee id of exactly 64 bytes, the longest NEAR allows, for each `n`. None of them
/// is an account anywhere, which is the point.
fn invented(prefix: char, n: u32) -> AccountId {
    let head = format!("{prefix}{n:03}-");
    let tail = ".testnet";
    let id = format!("{head}{}{tail}", "x".repeat(64 - head.len() - tail.len()));
    assert_eq!(id.len(), 64);
    id.parse().unwrap()
}

fn record(v: &mut crate::AgentSpendPolicy, payee: AccountId) -> PayOutcome {
    v.record_refusal(payee, U128(1), "guard_deny".to_owned())
}

/// A registry vault's `pay` of 1 to `payee`, answered DENY: what `on_verdict` returns.
fn denied(v: &mut crate::AgentSpendPolicy, payee: AccountId) -> PayOutcome {
    as_agent();
    promise(v.pay(payee, U128(1), None));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json(DENY)]);
    value(v.on_verdict(ctx))
}

// -- guard refusal counters ------------------------------------------------------------------------

/// Findings AUTH-2 and STOR-1: the guard counters stop at `MAX_GUARD_PAYEES` payees, which caps
/// what they can ever hold in storage at 100 times 113 bytes, about 0.11 NEAR.
#[test]
fn guard_counters_stop_at_the_bound_and_a_refused_record_writes_nothing() {
    let mut v = plain_vault();
    // One context per call: a receipt may log at most 100 lines and 16 KiB, as on chain.
    let mut stored = 0;
    for n in 0..MAX_GUARD_PAYEES {
        as_agent();
        let before = env::storage_usage();
        assert_refused(&record(&mut v, invented('g', n)), "guard_deny");
        v.guard_refusals.flush();
        stored += env::storage_usage() - before;
    }
    assert_eq!(counter_entry_bytes(&invented('g', 0)), 113);
    assert_eq!(
        stored,
        u64::from(MAX_GUARD_PAYEES) * 113,
        "113 bytes a payee, 11300 at the bound"
    );
    assert_eq!(v.guard_refusal_payees(), MAX_GUARD_PAYEES);

    // Five more names: each refused by the vault's own policy, each writing nothing.
    for n in MAX_GUARD_PAYEES..MAX_GUARD_PAYEES + 5 {
        let payee = invented('g', n);
        as_agent();
        let before = env::storage_usage();
        let out = record(&mut v, payee.clone());
        assert_refused(&out, "GuardRefusalLimitReached");
        let e = event("payment_refused");
        assert_eq!(e["source"], "policy");
        assert_eq!(e["reason"], "GuardRefusalLimitReached");
        assert_eq!(e["payee"], payee.as_str());
        v.guard_refusals.flush();
        assert_eq!(env::storage_usage(), before, "nothing was stored");
        assert_eq!(v.guard_refusal_count(payee), 0);
    }
    assert_eq!(v.guard_refusal_payees(), MAX_GUARD_PAYEES);

    // A payee that already has a counter still counts, because incrementing adds no storage.
    as_agent();
    let before = env::storage_usage();
    assert_refused(&record(&mut v, invented('g', 7)), "guard_deny");
    v.guard_refusals.flush();
    assert_eq!(env::storage_usage(), before);
    assert_eq!(v.guard_refusal_count(invented('g', 7)), 2);
    assert_eq!(v.guard_refusal_payees(), MAX_GUARD_PAYEES);
}

#[test]
fn the_bound_is_the_last_rung_of_the_record_ladder() {
    // A frozen vault or a malformed record is named for what it is, full or not.
    let mut v = plain_vault();
    for n in 0..MAX_GUARD_PAYEES {
        as_agent();
        let _ = record(&mut v, invented('g', n));
    }
    as_agent();
    assert_refused(
        &v.record_refusal(invented('n', 0), U128(0), "guard_deny".to_owned()),
        "InvalidAmount",
    );
    as_owner(0);
    v.freeze();
    as_agent();
    assert_refused(&record(&mut v, invented('n', 0)), "Frozen");
    as_agent();
    assert_refused(&record(&mut v, invented('g', 0)), "Frozen");
    assert_eq!(v.guard_refusal_count(invented('g', 0)), 1);
}

#[test]
fn the_owner_forgets_guard_counters_and_frees_exactly_their_slots() {
    let mut v = plain_vault();
    for n in 0..MAX_GUARD_PAYEES {
        as_agent();
        let _ = record(&mut v, invented('g', n));
    }
    as_agent();
    let _ = record(&mut v, invented('g', 3));
    v.guard_refusals.flush();

    // A duplicate and a payee with no counter are skipped without an event.
    as_owner_yocto();
    let before = env::storage_usage();
    v.forget_guard_refusals(vec![invented('g', 3), invented('g', 3), invented('z', 1)]);
    let forgotten: Vec<serde_json::Value> = events()
        .into_iter()
        .filter(|e| e["event"] == "guard_refusals_forgotten")
        .map(|e| e["data"].clone())
        .collect();
    assert_eq!(
        forgotten,
        vec![serde_json::json!({ "payee": invented('g', 3).as_str(), "count": 2 })]
    );
    v.guard_refusals.flush();
    assert_eq!(
        before - env::storage_usage(),
        counter_entry_bytes(&invented('g', 3)),
        "the stake of exactly one counter is free again"
    );
    assert_eq!(v.guard_refusal_count(invented('g', 3)), 0);
    assert_eq!(v.guard_refusal_payees(), MAX_GUARD_PAYEES - 1);

    // One slot: one new payee fits, the next does not.
    as_agent();
    assert_refused(&record(&mut v, invented('n', 1)), "guard_deny");
    as_agent();
    assert_refused(
        &record(&mut v, invented('n', 2)),
        "GuardRefusalLimitReached",
    );
    assert_eq!(v.guard_refusal_payees(), MAX_GUARD_PAYEES);
}

// -- registry refusal counters ---------------------------------------------------------------------

/// Finding NEAR-MP-02: every DENY'd payee an agent names starts a registry refusal counter, so
/// those are bounded too. Past the bound the money decision is the same: refused `RegistryDeny`,
/// with its event, and the reservation released. Only the count is skipped.
#[test]
fn a_deny_past_the_refusal_bound_is_refused_all_the_same_and_not_counted() {
    let mut v = fresh_vault(Some(registry()), 0, 0);
    for n in 0..MAX_REFUSAL_PAYEES {
        assert_refused(&denied(&mut v, invented('d', n)), "RegistryDeny");
    }
    v.refusals.flush();
    assert_eq!(v.refusal_payees(), MAX_REFUSAL_PAYEES);

    let next = invented('d', MAX_REFUSAL_PAYEES);
    as_agent();
    promise(v.pay(next.clone(), U128(1), None));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json(DENY)]);
    let before = env::storage_usage();
    let out = value(v.on_verdict(ctx));
    assert_refused(&out, "RegistryDeny");
    let e = event("payment_refused");
    assert_eq!(e["source"], "registry");
    assert_eq!(e["registry_reasons"], serde_json::json!(["drainer"]));
    assert!(calls().is_empty(), "nothing reaches the token");
    v.refusals.flush();
    assert_eq!(env::storage_usage(), before, "no counter was started");
    assert_eq!(v.refusal_count(next.clone()), 0);
    assert_eq!(v.spent_today(), U128(0), "released all the same");

    // A payee that already has a counter still counts.
    assert_refused(&denied(&mut v, invented('d', 0)), "RegistryDeny");
    assert_eq!(v.refusal_count(invented('d', 0)), 2);

    // The owner forgets one, and the next new DENY is counted again.
    as_owner_yocto();
    v.forget_refusals(vec![invented('d', 0), invented('z', 0)]);
    let e = event("refusals_forgotten");
    assert_eq!(e["payee"], invented('d', 0).as_str());
    assert_eq!(e["count"], 2);
    assert_eq!(v.refusal_count(invented('d', 0)), 0);
    assert_eq!(v.refusal_payees(), MAX_REFUSAL_PAYEES - 1);
    assert_refused(&denied(&mut v, next.clone()), "RegistryDeny");
    assert_eq!(v.refusal_count(next), 1);
    assert_eq!(v.refusal_payees(), MAX_REFUSAL_PAYEES);
}

// -- what one call may forget ----------------------------------------------------------------------

/// The longest line `forget_guard_refusals` logs per removal: the 11-byte `EVENT_JSON:` prefix,
/// the 91 bytes of envelope up to `"data":`, 95 bytes of data for a 64-byte payee and a count of
/// `u32::MAX` (10 digits), and the closing brace. 189 bytes when the count is 1.
const LONGEST_GUARD_LINE: usize = 198;
/// The same for `forget_refusals`: its event name, `refusals_forgotten`, is 6 bytes shorter.
const LONGEST_REFUSAL_LINE: usize = 192;

/// The receipt log limits the mocked runtime enforces, the protocol's own: 16384 bytes and 100
/// lines. Pinned, because the bound below is derived from them.
fn log_budget() -> usize {
    let limits = test_vm_config().limit_config;
    assert_eq!(limits.max_number_logs, 100);
    usize::try_from(limits.max_total_log_length).unwrap()
}

/// Finding: one forget call could not clear a full map. Every removal logs one event, and 100
/// removals of 64-byte payees overrun the 16384 bytes a receipt may log, so the call aborted in
/// the runtime (`TotalLogLengthExceeded`) after the owner paid for it. Now a call names at most
/// `MAX_FORGET_BATCH` payees and more is refused by name, and a full batch of the longest
/// lines fits. The mocked runtime enforces the protocol's log limits, so the full batches
/// below would fail here as they would on chain if they did not fit.
#[test]
fn forget_guard_refusals_takes_a_batch_of_50_and_two_calls_clear_a_full_map() {
    let budget = log_budget();
    assert_eq!(budget, 16_384);
    let full = usize::try_from(MAX_GUARD_PAYEES).unwrap();
    assert!(
        full * LONGEST_GUARD_LINE > budget,
        "a full map does not fit one call"
    );
    assert!(
        MAX_FORGET_BATCH * LONGEST_GUARD_LINE <= budget,
        "a full batch does"
    );
    assert_eq!(2 * MAX_FORGET_BATCH, full, "so two calls clear a full map");

    let mut v = plain_vault();
    for n in 0..MAX_GUARD_PAYEES {
        as_agent();
        let _ = record(&mut v, invented('g', n));
    }
    // Every count at its maximum, so every removal logs the longest line there is.
    for n in 0..MAX_GUARD_PAYEES {
        *v.guard_refusals.get_mut(&invented('g', n)).unwrap() = u32::MAX;
    }
    v.guard_refusals.flush();
    let all: Vec<AccountId> = (0..MAX_GUARD_PAYEES).map(|n| invented('g', n)).collect();

    // One name over, duplicates count: refused by name before anything is removed or logged.
    as_owner_yocto();
    assert_panics_with("BatchTooLarge", || {
        v.forget_guard_refusals(all[..=MAX_FORGET_BATCH].to_vec());
    });
    assert!(get_logs().is_empty());
    as_owner_yocto();
    assert_panics_with("BatchTooLarge", || {
        v.forget_guard_refusals(vec![invented('g', 0); MAX_FORGET_BATCH + 1]);
    });
    assert!(get_logs().is_empty());
    assert_eq!(
        v.guard_refusal_payees(),
        MAX_GUARD_PAYEES,
        "nothing was removed"
    );

    // A full batch of the longest lines: every removal logged, within the receipt's budget.
    as_owner_yocto();
    v.forget_guard_refusals(all[..MAX_FORGET_BATCH].to_vec());
    let lines = get_logs();
    assert_eq!(lines.len(), MAX_FORGET_BATCH);
    assert!(lines.iter().all(|line| line.len() == LONGEST_GUARD_LINE));
    assert!(lines.iter().map(String::len).sum::<usize>() <= budget);
    let forgotten = events();
    assert!(
        forgotten
            .iter()
            .all(|e| e["event"] == "guard_refusals_forgotten" && e["data"]["count"] == u32::MAX)
    );
    assert_eq!(v.guard_refusal_payees(), MAX_GUARD_PAYEES / 2);
    assert_eq!(v.guard_refusal_count(all[0].clone()), 0);

    // The second call clears the rest.
    as_owner_yocto();
    v.forget_guard_refusals(all[MAX_FORGET_BATCH..].to_vec());
    assert_eq!(get_logs().len(), MAX_FORGET_BATCH);
    assert_eq!(v.guard_refusal_payees(), 0);
}

#[test]
fn forget_refusals_takes_a_batch_of_50_and_two_calls_clear_a_full_map() {
    let budget = log_budget();
    assert_eq!(budget, 16_384);
    let full = usize::try_from(MAX_REFUSAL_PAYEES).unwrap();
    assert!(
        full * LONGEST_REFUSAL_LINE > budget,
        "a full map does not fit one call"
    );
    assert!(
        MAX_FORGET_BATCH * LONGEST_REFUSAL_LINE <= budget,
        "a full batch does"
    );
    assert_eq!(2 * MAX_FORGET_BATCH, full, "so two calls clear a full map");

    let mut v = fresh_vault(Some(registry()), 0, 0);
    for n in 0..MAX_REFUSAL_PAYEES {
        assert_refused(&denied(&mut v, invented('d', n)), "RegistryDeny");
    }
    // Every count at its maximum, so every removal logs the longest line there is.
    for n in 0..MAX_REFUSAL_PAYEES {
        *v.refusals.get_mut(&invented('d', n)).unwrap() = u32::MAX;
    }
    v.refusals.flush();
    let all: Vec<AccountId> = (0..MAX_REFUSAL_PAYEES).map(|n| invented('d', n)).collect();

    // One name over, duplicates count: refused by name before anything is removed or logged.
    as_owner_yocto();
    assert_panics_with("BatchTooLarge", || {
        v.forget_refusals(all[..=MAX_FORGET_BATCH].to_vec());
    });
    assert!(get_logs().is_empty());
    as_owner_yocto();
    assert_panics_with("BatchTooLarge", || {
        v.forget_refusals(vec![invented('d', 0); MAX_FORGET_BATCH + 1]);
    });
    assert!(get_logs().is_empty());
    assert_eq!(
        v.refusal_payees(),
        MAX_REFUSAL_PAYEES,
        "nothing was removed"
    );

    // A full batch of the longest lines: every removal logged, within the receipt's budget.
    as_owner_yocto();
    v.forget_refusals(all[..MAX_FORGET_BATCH].to_vec());
    let lines = get_logs();
    assert_eq!(lines.len(), MAX_FORGET_BATCH);
    assert!(lines.iter().all(|line| line.len() == LONGEST_REFUSAL_LINE));
    assert!(lines.iter().map(String::len).sum::<usize>() <= budget);
    assert!(
        events()
            .iter()
            .all(|e| e["event"] == "refusals_forgotten" && e["data"]["count"] == u32::MAX)
    );
    assert_eq!(v.refusal_payees(), MAX_REFUSAL_PAYEES / 2);
    assert_eq!(v.refusal_count(all[0].clone()), 0);

    // The second call clears the rest.
    as_owner_yocto();
    v.forget_refusals(all[MAX_FORGET_BATCH..].to_vec());
    assert_eq!(get_logs().len(), MAX_FORGET_BATCH);
    assert_eq!(v.refusal_payees(), 0);
}

// -- what the vault's NEAR cannot cover ------------------------------------------------------------

/// Finding NEAR-MP-04, the storage half: a new entry the vault's NEAR cannot cover would fail
/// its receipt at the end with no event, and in a callback strand the reservation. Instead the
/// record and the hold are refused by name and a DENY goes uncounted; nothing is written.
#[test]
fn a_new_counter_or_hold_the_vault_cannot_cover_is_refused_not_written() {
    let mut v = registry_vault();
    // 300 KiB of mocked storage locks 3.072 NEAR; leave 1 milliNEAR, under the 10 of headroom.
    set_balance(3_073_000_000_000_000_000_000_000);

    as_agent();
    let before = env::storage_usage();
    assert_refused(&record(&mut v, newcomer()), "StorageNotCovered");
    assert_eq!(event("payment_refused")["source"], "policy");
    v.guard_refusals.flush();
    assert_eq!(env::storage_usage(), before);
    assert_eq!(v.guard_refusal_count(newcomer()), 0);
    assert_eq!(v.guard_refusal_payees(), 0);

    // A hold, in the callback: refused by name, the reservation given back, no abort.
    as_agent();
    promise(v.pay(newcomer(), U128(60), None));
    assert_eq!(v.spent_today(), U128(60));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json("null")]);
    let before = env::storage_usage();
    let out = value(v.on_verdict(ctx));
    assert_refused(&out, "StorageNotCovered");
    assert_eq!(event_names(), vec!["payment_refused"]);
    v.held.flush();
    assert_eq!(env::storage_usage(), before);
    assert!(v.list_held(None, None).is_empty());
    assert_eq!(v.spent_today(), U128(0), "released");

    // A DENY: still refused, and not counted.
    assert_refused(&denied(&mut v, newcomer()), "RegistryDeny");
    assert_eq!(v.refusal_count(newcomer()), 0);
    assert_eq!(v.spent_today(), U128(0));

    // With NEAR again, the same three calls write.
    set_balance(DEFAULT_BALANCE);
    as_agent();
    assert_refused(&record(&mut v, newcomer()), "guard_deny");
    assert_eq!(v.guard_refusal_count(newcomer()), 1);
    as_agent();
    promise(v.pay(newcomer(), U128(60), None));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json("null")]);
    assert_status(&value(v.on_verdict(ctx)), crate::PayStatus::Held);
    assert_refused(&denied(&mut v, newcomer()), "RegistryDeny");
    assert_eq!(v.refusal_count(newcomer()), 1);
}

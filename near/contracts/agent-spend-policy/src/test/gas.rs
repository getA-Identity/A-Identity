//! The gas budget an agent transaction has to fit in.
//!
//! The agent signs with a function-call key, and the protocol takes the whole prepaid gas out
//! of that key's allowance upfront, at 0.001 NEAR per Tgas, until the payment's receipts finish.
//! So every Tgas of static budget the vault reserves is allowance the agent has to hold. The
//! evidence comes in two layers, because neither is enough on its own:
//!
//! * The figures in the crate docs ("Gas") were measured on near-sandbox 2.14.0 (protocol 88,
//!   the testnet version) with the release wasm: what each receipt burns, and the smallest
//!   prepaid gas at which a payment still lands. The overheads below carry them, rounded up,
//!   and the relations between the budgets are pinned, so an edit to one budget that starves
//!   another fails here instead of failing payments.
//! * The mock runs nearcore's own host functions, so a schedule that does not fit aborts here
//!   exactly as on chain. It runs native code with no action fees (`as_agent_with_gas`), so
//!   those tests check the static schedule, and the overheads cover the rest.

use near_sdk::Gas;
use near_sdk::json_types::U128;

use super::*;
use crate::{
    AGENT_PREPAID_GAS, GAS_FT_TRANSFER, GAS_ON_KEY_ADDED, GAS_ON_TRANSFER, GAS_ON_VERDICT,
    GAS_ON_WITHDRAW, GAS_REGISTRY_VIEW, GAS_STORAGE_DEPOSIT, PayStatus,
};

/// What `pay` needs on top of the static budgets it schedules: its own execution and the fees
/// of the receipts it creates. Measured: with a registry, a paying `pay` lands at 51 Tgas and
/// aborts at 50, against 47 Tgas of budgets, so at most 4 Tgas; without one it landed at 40
/// against 35, so 4.5 Tgas (three receipts instead of two).
const PAY_OVERHEAD: Gas = Gas::from_tgas(5);
/// What `on_verdict` needs on top of the transfer chain's three budgets. Measured: with a 37
/// Tgas budget it ran dry on the lightest ALLOW already, with 39 it settled the heaviest ALLOW
/// the registry can produce, so at most 4 Tgas (its own execution, sending fees included, and
/// the three receipts' prepaid execution fees).
const ON_VERDICT_OVERHEAD: Gas = Gas::from_tgas(7);
/// The smallest prepaid gas at which an ALLOW payment through the registry lands, measured to
/// the Tgas in `sandbox-tests/tests/gas.rs` for the lightest and the heaviest ALLOW.
const MEASURED_ALLOW_FLOOR: Gas = Gas::from_tgas(51);

fn tgas(gas: Gas) -> u64 {
    gas.as_tgas()
}

fn transfer_chain() -> u64 {
    tgas(GAS_STORAGE_DEPOSIT) + tgas(GAS_FT_TRANSFER) + tgas(GAS_ON_TRANSFER)
}

#[test]
fn the_budgets_are_the_measured_ones_and_nest() {
    // Pinned: the SDK and the docs quote these numbers.
    assert_eq!(GAS_REGISTRY_VIEW, Gas::from_tgas(5));
    assert_eq!(GAS_ON_VERDICT, Gas::from_tgas(42));
    assert_eq!(GAS_STORAGE_DEPOSIT, Gas::from_tgas(10));
    assert_eq!(GAS_FT_TRANSFER, Gas::from_tgas(15));
    assert_eq!(GAS_ON_TRANSFER, Gas::from_tgas(10));
    assert_eq!(GAS_ON_KEY_ADDED, Gas::from_tgas(10));
    assert_eq!(GAS_ON_WITHDRAW, Gas::from_tgas(10));
    assert_eq!(AGENT_PREPAID_GAS, Gas::from_tgas(73));

    // The verdict callback can always schedule the transfer chain from its own budget, even
    // when the agent attached the bare minimum and nothing was left over for it.
    assert!(tgas(GAS_ON_VERDICT) >= transfer_chain() + tgas(ON_VERDICT_OVERHEAD));
    // The recommended prepaid gas covers the longest path, with a registry and without one.
    assert!(
        tgas(AGENT_PREPAID_GAS)
            >= tgas(GAS_REGISTRY_VIEW) + tgas(GAS_ON_VERDICT) + tgas(PAY_OVERHEAD)
    );
    assert!(tgas(AGENT_PREPAID_GAS) >= transfer_chain() + tgas(PAY_OVERHEAD));
    // It keeps at least 30 percent of itself free over the measured floor (the sandbox suite
    // measures the floor and holds it to the same rule)...
    assert!(tgas(MEASURED_ALLOW_FLOOR) * 100 <= tgas(AGENT_PREPAID_GAS) * 70);
    // ...and is the smallest whole Tgas that does, because every Tgas of it is allowance the
    // agent's key holds while a payment is in flight.
    assert!((tgas(AGENT_PREPAID_GAS) - 1) * 70 < tgas(MEASURED_ALLOW_FLOOR) * 100);
    // And stays at or under 100 Tgas, so one payment in flight holds at most 0.1 NEAR of the
    // agent key's allowance.
    assert!(AGENT_PREPAID_GAS <= Gas::from_tgas(100));
}

#[test]
fn the_recommended_gas_schedules_a_payment_through_the_registry() {
    let mut v = registry_vault();
    as_agent_with_gas(AGENT_PREPAID_GAS);
    promise(v.pay(shop(), U128(60), None));
    let calls = calls();
    assert_eq!(call_names(), vec!["get_verdict", "on_verdict"]);
    assert_eq!(calls[0].gas, GAS_REGISTRY_VIEW);
    assert_eq!(calls[0].weight, 0, "the registry gets exactly its budget");
    assert_eq!(calls[1].gas, GAS_ON_VERDICT);
    assert_eq!(
        calls[1].weight, 1,
        "the callback inherits what the agent left over"
    );
}

#[test]
fn below_the_static_floor_a_payment_aborts_before_it_writes_anything() {
    // One gas unit short of the two budgets: the protocol refuses to schedule the second
    // promise, so the receipt aborts and nothing it wrote (the reservation, the payment id)
    // survives. The agent sees a failed transaction, not a stuck reservation.
    let floor = GAS_REGISTRY_VIEW.as_gas() + GAS_ON_VERDICT.as_gas();
    let mut v = registry_vault();
    as_agent_with_gas(Gas::from_gas(floor - 1));
    let text = panic_text(|| {
        let _ = v.pay(shop(), U128(60), None);
    });
    assert!(text.contains("GasExceeded"), "{text}");
}

#[test]
fn the_verdict_callback_can_schedule_the_transfer_on_its_own_budget() {
    let mut v = registry_vault();
    as_agent();
    promise(v.pay(shop(), U128(60), None));
    let ctx = scheduled_ctx("on_verdict");
    as_callback_with_gas(vec![ok_json("null")], GAS_ON_VERDICT);
    promise(v.on_verdict(ctx));
    let calls = calls();
    assert_eq!(
        call_names(),
        vec!["storage_deposit", "ft_transfer", "on_transfer"]
    );
    assert_eq!(calls[0].gas, GAS_STORAGE_DEPOSIT);
    assert_eq!(calls[0].weight, 0);
    assert_eq!(calls[1].gas, GAS_FT_TRANSFER);
    assert_eq!(calls[1].weight, 0, "the token gets exactly its budget");
    assert_eq!(calls[2].gas, GAS_ON_TRANSFER);
    assert_eq!(
        calls[2].weight, 1,
        "the transfer callback inherits the rest"
    );
}

#[test]
fn the_recommended_gas_schedules_a_payment_without_a_registry() {
    let mut v = plain_vault();
    as_agent_with_gas(AGENT_PREPAID_GAS);
    promise(v.pay(shop(), U128(60), None));
    assert_eq!(
        call_names(),
        vec!["storage_deposit", "ft_transfer", "on_transfer"]
    );
}

#[test]
fn refusals_and_holds_schedule_nothing_and_need_no_budget() {
    // A refused `pay`, a request held with no registry, an unknown payee held with no registry
    // and a recorded refusal never call out, so a few Tgas cover them; the SDK can attach 10
    // Tgas to `record_refusal`.
    let mut v = plain_vault();
    as_agent_with_gas(Gas::from_tgas(10));
    assert_refused(&value(v.pay(shop(), U128(101), None)), "AboveAutoApprove");
    as_agent_with_gas(Gas::from_tgas(10));
    assert_status(
        &value(v.request_payment(shop(), U128(500), None, "why".to_owned())),
        PayStatus::Held,
    );
    as_agent_with_gas(Gas::from_tgas(10));
    assert_status(&value(v.pay(newcomer(), U128(5), None)), PayStatus::Held);
    as_agent_with_gas(Gas::from_tgas(10));
    assert_refused(
        &v.record_refusal(shop(), U128(5), "guard_deny".to_owned()),
        "guard_deny",
    );
    assert!(calls().is_empty());
}

//! Amendment A1, `hold_unknown`: what the registry's silence means for the agent's own `pay`.
//!
//! A payee is known when the owner listed it or the vault has paid it before. With the flag on
//! (the default), a `pay` to any other payee that the registry is silent on, or that no
//! registry was asked about, is held for the owner with reason `UnknownPayee` and its
//! reservation released, and the owner's settlement of that hold is what makes the payee known.
//! The verdicts keep their meaning: ALLOW pays, WARN holds, DENY refuses, and an answer the
//! vault cannot read fails closed.

use near_sdk::json_types::{U64, U128};

use super::*;
use crate::{AgentSpendPolicy, MAX_PENDING_HELD, PayMode, PayStatus, REASON_UNKNOWN_PAYEE};

const ALLOW: &str = r#"{"verdict":"ALLOW","reasons":[]}"#;
const WARN: &str = r#"{"verdict":"WARN","reasons":["new_account"]}"#;
const DENY: &str = r#"{"verdict":"DENY","reasons":["drainer"]}"#;
const TRANSFER_CHAIN: [&str; 3] = ["storage_deposit", "ft_transfer", "on_transfer"];

/// Require `out` to be the hold of a payee nobody has judged, and return its held id.
#[track_caller]
fn assert_unknown_hold(out: &PayOutcome) -> U64 {
    assert_status(out, PayStatus::Held);
    assert_eq!(out.reason.as_deref(), Some(REASON_UNKNOWN_PAYEE), "{out:?}");
    out.held_id.expect("a hold carries its held id")
}

/// A registry vault's agent `pay` of 60 to `payee`, with the registry answering `answer`:
/// what `on_verdict` returns.
fn pay_answered(
    v: &mut AgentSpendPolicy,
    payee: AccountId,
    answer: &str,
) -> PromiseOrValue<PayOutcome> {
    as_agent();
    promise(v.pay(payee, U128(60), None));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json(answer)]);
    v.on_verdict(ctx)
}

// -- the flag -------------------------------------------------------------------------------------

#[test]
fn a_new_vault_holds_unknown_payees_and_only_the_owner_can_change_that() {
    let mut v = plain_vault();
    assert!(v.get_config().hold_unknown);

    // It decides whether money can reach a payee nobody has judged, so it is a policy change:
    // the owner, with the yocto. The agent key cannot reach it either.
    env_as(stranger(), key(99), 1, vec![]);
    assert_panics_with("NotOwner", || v.set_hold_unknown(false));
    as_agent();
    assert_panics_with("NotOwner", || v.set_hold_unknown(false));
    as_owner(0);
    assert_panics_with("RequiresOneYocto", || v.set_hold_unknown(false));

    as_owner_yocto();
    v.set_hold_unknown(false);
    assert!(!v.get_config().hold_unknown);
    assert_eq!(event_names(), vec!["hold_unknown_set"]);
    assert_eq!(event("hold_unknown_set")["hold_unknown"], false);
    as_owner_yocto();
    v.set_hold_unknown(true);
    assert!(v.get_config().hold_unknown);
    assert_eq!(event("hold_unknown_set")["hold_unknown"], true);
}

// -- silence about a payee nobody vouches for -------------------------------------------------------

#[test]
fn without_a_registry_a_pay_to_an_unknown_payee_is_held_and_moves_nothing() {
    let mut v = plain_vault();
    as_agent();
    let out = value(v.pay(newcomer(), U128(60), Some("first order".to_owned())));
    let held_id = assert_unknown_hold(&out);
    assert!(
        calls().is_empty(),
        "no registration and no transfer is scheduled"
    );
    assert_eq!(v.spent_today(), U128(0), "the reservation was released");

    assert_eq!(event_names(), vec!["payment_held"]);
    let e = event("payment_held");
    assert_eq!(e["reason"], "UnknownPayee");
    assert_eq!(e["payee"], newcomer().as_str());
    assert_eq!(e["amount"], "60");
    assert_eq!(e["payment_id"], out.payment_id.0.to_string());
    assert_eq!(e["held_id"], held_id.0.to_string());

    let held = v.get_held(held_id).unwrap();
    assert_eq!(held.reason, "UnknownPayee");
    assert_eq!(held.payee, newcomer());
    assert_eq!(held.agent_pk, agent());
    assert_eq!(held.memo.as_deref(), Some("first order"));
    assert_eq!(held.payment_id, out.payment_id);
    assert_eq!(v.paid_count(newcomer()), 0);
    assert_eq!(v.refusal_count(newcomer()), 0, "being new is not a refusal");
}

#[test]
fn with_a_registry_silence_about_an_unknown_payee_holds_it() {
    let mut v = registry_vault();
    as_agent();
    promise(v.pay(newcomer(), U128(60), None));
    assert_eq!(
        v.spent_today(),
        U128(60),
        "reserved while the registry is asked"
    );
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json("null")]);
    assert_unknown_hold(&value(v.on_verdict(ctx)));
    assert!(calls().is_empty());
    assert_eq!(v.spent_today(), U128(0), "released, as for a WARN");
    assert_eq!(event_names(), vec!["payment_held"]);
}

#[test]
fn verdicts_keep_their_meaning_for_an_unknown_payee() {
    // ALLOW pays a payee nobody else vouches for: the registry has judged it.
    let mut v = registry_vault();
    promise(pay_answered(&mut v, newcomer(), ALLOW));
    assert_eq!(call_names(), TRANSFER_CHAIN);

    let mut v = registry_vault();
    let out = value(pay_answered(&mut v, newcomer(), WARN));
    assert_status(&out, PayStatus::Held);
    assert_eq!(out.reason.as_deref(), Some("RegistryWarn"));

    let mut v = registry_vault();
    assert_refused(
        &value(pay_answered(&mut v, newcomer(), DENY)),
        "RegistryDeny",
    );
    assert_eq!(v.refusal_count(newcomer()), 1);
    assert!(v.list_held(None, None).is_empty());

    let mut v = registry_vault();
    assert_refused(
        &value(pay_answered(&mut v, newcomer(), r#"{"verdict":"MAYBE"}"#)),
        "RegistryUnavailable",
    );
    assert!(
        v.list_held(None, None).is_empty(),
        "unreadable is not silence"
    );
}

// -- what makes a payee known ----------------------------------------------------------------------

#[test]
fn a_listed_payee_is_known_whether_or_not_the_allowlist_gate_is_on() {
    for gate in [false, true] {
        let mut v = plain_vault();
        as_owner_yocto();
        v.set_policy(U128(1_000), U128(100), gate);
        as_owner_yocto();
        v.set_allowed(newcomer(), true);
        as_agent();
        promise(v.pay(newcomer(), U128(60), None));
        assert_eq!(call_names(), TRANSFER_CHAIN, "gate on: {gate}");

        // Off the list again, and never paid (that transfer never reported back): unknown
        // again, or simply not allowed when the gate is on.
        as_owner_yocto();
        v.set_allowed(newcomer(), false);
        as_agent();
        let out = value(v.pay(newcomer(), U128(60), None));
        if gate {
            assert_refused(&out, "PayeeNotAllowed");
        } else {
            assert_unknown_hold(&out);
        }
    }
}

/// The headline: a payee's first payment waits for one human tap, and the payment that tap
/// makes is what lets the next ones flow.
#[test]
fn the_owners_settlement_makes_the_payee_known() {
    let mut v = plain_vault();
    as_agent();
    let held_id = assert_unknown_hold(&value(v.pay(newcomer(), U128(60), None)));

    as_owner_yocto();
    promise(v.owner_pay(held_id));
    assert_eq!(
        call_names(),
        TRANSFER_CHAIN,
        "the owner is the human it waited for"
    );
    let ctx = scheduled_ctx("on_transfer");
    assert_eq!(ctx.mode, PayMode::OwnerPay);
    assert_eq!(ctx.held_id, Some(held_id));
    as_callback(vec![ok_bytes(b"")]);
    assert_status(&v.on_transfer(ctx), PayStatus::Sent);
    assert_eq!(v.paid_count(newcomer()), 1);

    // Paid once, known from now on: the agent's next payment goes straight to the transfer.
    as_agent();
    promise(v.pay(newcomer(), U128(60), None));
    assert_eq!(call_names(), TRANSFER_CHAIN);
    assert_eq!(scheduled_ctx("on_transfer").mode, PayMode::Pay);
}

#[test]
fn with_a_registry_the_settlement_still_asks_and_then_silence_pays_the_known_payee() {
    let mut v = registry_vault();
    let held_id = assert_unknown_hold(&value(pay_answered(&mut v, newcomer(), "null")));

    as_owner_yocto();
    promise(v.owner_pay(held_id));
    let ctx = scheduled_ctx("on_verdict");
    assert_eq!(ctx.mode, PayMode::OwnerPay);
    as_callback(vec![ok_json("null")]);
    promise(v.on_verdict(ctx));
    assert_eq!(call_names(), TRANSFER_CHAIN);
    let ctx = scheduled_ctx("on_transfer");
    as_callback(vec![ok_bytes(b"")]);
    assert_status(&v.on_transfer(ctx), PayStatus::Sent);

    promise(pay_answered(&mut v, newcomer(), "null"));
    assert_eq!(call_names(), TRANSFER_CHAIN);
}

#[test]
fn a_settlement_that_fails_to_transfer_leaves_the_payee_unknown() {
    let mut v = plain_vault();
    as_agent();
    let held_id = assert_unknown_hold(&value(v.pay(newcomer(), U128(60), None)));
    as_owner_yocto();
    promise(v.owner_pay(held_id));
    let ctx = scheduled_ctx("on_transfer");
    as_callback(vec![failed()]);
    assert_status(&v.on_transfer(ctx), PayStatus::Failed);
    assert_eq!(v.paid_count(newcomer()), 0);

    as_agent();
    assert_unknown_hold(&value(v.pay(newcomer(), U128(60), None)));
}

#[test]
fn with_hold_unknown_off_silence_pays_as_before() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_hold_unknown(false);
    as_agent();
    promise(v.pay(newcomer(), U128(60), None));
    assert_eq!(call_names(), TRANSFER_CHAIN);

    let mut v = registry_vault();
    as_owner_yocto();
    v.set_hold_unknown(false);
    promise(pay_answered(&mut v, newcomer(), "null"));
    assert_eq!(call_names(), TRANSFER_CHAIN);
}

// -- what it does not change -------------------------------------------------------------------------

#[test]
fn a_request_is_held_with_the_agents_own_reason_known_or_not() {
    let mut v = plain_vault();
    for payee in [newcomer(), shop()] {
        as_agent();
        let out =
            value(v.request_payment(payee.clone(), U128(60), None, "AboveAutoApprove".to_owned()));
        assert_status(&out, PayStatus::Held);
        assert_eq!(out.reason.as_deref(), Some("AboveAutoApprove"), "{payee}");
    }
}

#[test]
fn holding_an_unknown_payee_gives_the_days_budget_back() {
    // The cap is exactly one payment, and a held one must not use it up.
    let mut v = fresh_vault(None, 100, 100);
    as_agent();
    assert_unknown_hold(&value(v.pay(newcomer(), U128(100), None)));
    assert_eq!(v.remaining_today(), Some(U128(100)));
    as_agent();
    promise(v.pay(shop(), U128(100), None));
    assert_eq!(v.spent_today(), U128(100));
}

#[test]
fn an_unknown_payee_with_the_held_map_full_is_refused_not_aborted() {
    let mut v = plain_vault();
    for _ in 0..MAX_PENDING_HELD {
        as_agent();
        assert_status(
            &value(v.request_payment(shop(), U128(5), None, "why".to_owned())),
            PayStatus::Held,
        );
    }
    as_agent();
    let out = value(v.pay(newcomer(), U128(60), None));
    assert_refused(&out, "HeldLimitReached");
    assert_eq!(
        v.spent_today(),
        U128(0),
        "released before the hold was attempted"
    );
    assert_eq!(event("payment_refused")["source"], "policy");
}

/// Like a WARN, the hold comes before the in-flight re-check: a payment that was in flight when
/// the owner froze the vault is put in front of the owner rather than refused, because a hold
/// moves nothing and the owner reads it either way.
#[test]
fn an_unknown_payee_in_flight_across_a_freeze_is_held_not_paid() {
    let mut v = registry_vault();
    as_agent();
    promise(v.pay(newcomer(), U128(60), None));
    let ctx = scheduled_ctx("on_verdict");
    as_owner(0);
    v.freeze();
    as_callback(vec![ok_json("null")]);
    assert_unknown_hold(&value(v.on_verdict(ctx)));
    assert!(calls().is_empty());
    assert_eq!(v.spent_today(), U128(0));
}

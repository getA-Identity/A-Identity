//! The agent's three methods through the contract: refusals are receipts and events, never
//! panics; the reservation is made before any external call; held payments are bounded.

use near_sdk::NearToken;
use near_sdk::json_types::{U64, U128};

use super::*;
use crate::{
    GAS_FT_TRANSFER, GAS_ON_TRANSFER, GAS_ON_VERDICT, GAS_REGISTRY_VIEW, GAS_STORAGE_DEPOSIT,
    HELD_TTL_S, MAX_PENDING_HELD, PayMode, PayStatus,
};

// -- pay: refusals ------------------------------------------------------------------------------

#[test]
fn a_policy_refusal_is_a_receipt_and_an_event_not_a_panic() {
    let mut v = plain_vault();
    as_agent();
    let out = value(v.pay(shop(), U128(101), Some("inv-1".to_owned())));
    assert_refused(&out, "AboveAutoApprove");
    assert_eq!(out.payment_id, U64(1));
    assert_eq!(out.held_id, None);

    let e = event("payment_refused");
    assert_eq!(e["payment_id"], "1");
    assert_eq!(e["payee"], shop().as_str());
    assert_eq!(e["amount"], "101");
    assert_eq!(e["reason"], "AboveAutoApprove");
    assert_eq!(e["source"], "policy");
    assert_eq!(e["registry_reasons"], serde_json::json!([]));
    assert_eq!(event_names(), vec!["payment_refused"]);
    assert!(calls().is_empty(), "nothing is scheduled");
    assert_eq!(v.spent_today(), U128(0), "nothing is reserved");
}

/// One refusal case: the expected error name and the `pay` call that should produce it.
type PayCase = (
    &'static str,
    Box<dyn Fn(&mut crate::AgentSpendPolicy) -> PayOutcome>,
);

#[test]
fn every_pay_gate_refuses_through_the_contract() {
    let mut v = plain_vault();
    let cases: Vec<PayCase> = vec![
        (
            "InvalidAmount",
            Box::new(|v| value(v.pay(shop(), U128(0), None))),
        ),
        (
            "InvalidPayee",
            Box::new(|v| value(v.pay(vault(), U128(1), None))),
        ),
        (
            "InvalidPayee",
            Box::new(|v| value(v.pay(token(), U128(1), None))),
        ),
        (
            "MemoTooLong",
            Box::new(|v| value(v.pay(shop(), U128(1), Some(text(129))))),
        ),
        (
            "AboveAutoApprove",
            Box::new(|v| value(v.pay(shop(), U128(101), None))),
        ),
    ];
    for (reason, case) in cases {
        as_agent();
        let out = case(&mut v);
        assert_refused(&out, reason);
    }
}

#[test]
fn frozen_vault_refuses_the_agent() {
    let mut v = plain_vault();
    as_owner(0);
    v.freeze();
    as_agent();
    assert_refused(&value(v.pay(shop(), U128(1), None)), "Frozen");
}

#[test]
fn allowlist_refuses_unlisted_payees_only() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_policy(U128(1_000), U128(100), true);
    as_owner_yocto();
    v.set_allowed(shop(), true);
    // `newcomer()` is the one payee `fresh_vault` does not list.
    as_agent();
    assert_refused(&value(v.pay(newcomer(), U128(1), None)), "PayeeNotAllowed");
    as_agent();
    promise(v.pay(shop(), U128(1), None));
}

#[test]
fn the_daily_cap_counts_every_payment_in_flight() {
    // Reserved before the transfer is even scheduled: three in-flight payments of 100 against a
    // 250 cap leave the third refused, although no transfer has completed yet.
    let mut v = fresh_vault(None, 250, 100);
    as_agent();
    promise(v.pay(shop(), U128(100), None));
    as_agent();
    promise(v.pay(shop(), U128(100), None));
    assert_eq!(v.spent_today(), U128(200));
    as_agent();
    assert_refused(&value(v.pay(shop(), U128(100), None)), "DailyCapExceeded");
    as_agent();
    promise(v.pay(shop(), U128(50), None));
    assert_eq!(v.spent_today(), U128(250));
    assert_eq!(v.remaining_today(), Some(U128(0)));
}

#[test]
fn the_cap_resets_on_the_next_utc_day() {
    let mut v = fresh_vault(None, 100, 100);
    as_agent();
    promise(v.pay(shop(), U128(100), None));
    as_agent();
    assert_refused(&value(v.pay(shop(), U128(1), None)), "DailyCapExceeded");
    advance_s(DAY_S / 2); // 00:00 UTC of the next day
    as_viewer();
    assert_eq!(v.spent_today(), U128(0));
    as_agent();
    promise(v.pay(shop(), U128(100), None));
    assert_eq!(v.spent_today(), U128(100));
    assert_eq!(v.today(), U64(T0_DAY + 1));
}

#[test]
fn payment_ids_are_assigned_to_every_attempt() {
    let mut v = plain_vault();
    as_agent();
    assert_eq!(value(v.pay(shop(), U128(0), None)).payment_id, U64(1));
    as_agent();
    promise(v.pay(shop(), U128(1), None));
    assert_eq!(scheduled_ctx("on_transfer").payment_id, U64(2));
    as_agent();
    assert_eq!(
        v.record_refusal(shop(), U128(5), "guard".to_owned())
            .payment_id,
        U64(3)
    );
    as_agent();
    assert_eq!(
        value(v.request_payment(shop(), U128(5), None, "why".to_owned())).payment_id,
        U64(4)
    );
}

// -- pay: the path to the token -----------------------------------------------------------------

#[test]
fn without_a_registry_pay_reserves_then_registers_the_payee_then_transfers() {
    let mut v = plain_vault();
    as_agent();
    promise(v.pay(shop(), U128(60), Some("order 9".to_owned())));
    assert_eq!(v.spent_today(), U128(60));

    let calls = calls();
    assert_eq!(
        calls.iter().map(|c| c.method.as_str()).collect::<Vec<_>>(),
        vec!["storage_deposit", "ft_transfer", "on_transfer"]
    );
    let (deposit, transfer, callback) = (&calls[0], &calls[1], &calls[2]);

    assert_eq!(deposit.receiver, token());
    assert_eq!(deposit.args["account_id"], shop().as_str());
    assert_eq!(deposit.args["registration_only"], true);
    assert_eq!(deposit.deposit, NearToken::from_yoctonear(STORAGE_DEPOSIT));
    assert_eq!(deposit.gas, GAS_STORAGE_DEPOSIT);
    assert_eq!(deposit.weight, 0);

    assert_eq!(transfer.receiver, token());
    assert_eq!(transfer.args["receiver_id"], shop().as_str());
    assert_eq!(transfer.args["amount"], "60");
    assert_eq!(transfer.args["memo"], "order 9");
    assert_eq!(transfer.deposit, NearToken::from_yoctonear(1));
    assert_eq!(transfer.gas, GAS_FT_TRANSFER);
    assert_eq!(transfer.weight, 0);

    assert_eq!(callback.receiver, vault());
    assert_eq!(callback.deposit, NearToken::from_yoctonear(0));
    assert_eq!(callback.gas, GAS_ON_TRANSFER);
    assert_eq!(callback.weight, 1, "the leftover gas goes to the callback");

    let ctx = scheduled_ctx("on_transfer");
    assert_eq!(ctx.mode, PayMode::Pay);
    assert_eq!(ctx.agent_pk, agent());
    assert_eq!(ctx.payee, shop());
    assert_eq!(ctx.amount, U128(60));
    assert_eq!(ctx.memo.as_deref(), Some("order 9"));
    assert_eq!(ctx.day, U64(T0_DAY));
    assert!(
        events().is_empty(),
        "nothing is announced until the transfer reports"
    );
}

#[test]
fn with_a_registry_pay_reserves_then_asks_for_the_verdict() {
    let mut v = registry_vault();
    as_agent();
    promise(v.pay(shop(), U128(60), None));
    assert_eq!(
        v.spent_today(),
        U128(60),
        "reserved BEFORE the external call"
    );

    let calls = calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].receiver, registry());
    assert_eq!(calls[0].method, "get_verdict");
    assert_eq!(
        calls[0].args,
        serde_json::json!({ "account_id": shop().as_str() })
    );
    assert_eq!(calls[0].deposit, NearToken::from_yoctonear(0));
    assert_eq!(calls[0].gas, GAS_REGISTRY_VIEW);
    assert_eq!(calls[0].weight, 0);
    assert_eq!(calls[1].receiver, vault());
    assert_eq!(calls[1].method, "on_verdict");
    assert_eq!(calls[1].gas, GAS_ON_VERDICT);
    assert_eq!(calls[1].weight, 1);
    assert_eq!(scheduled_ctx("on_verdict").mode, PayMode::Pay);
}

#[test]
fn a_vault_that_cannot_fund_the_registration_reports_failed_instead_of_aborting() {
    let mut v = plain_vault();
    // 300 KiB of mocked storage locks 3.072 NEAR; leave less than the deposit plus headroom.
    set_balance(3_073_000_000_000_000_000_000_000);
    as_agent();
    let out = value(v.pay(shop(), U128(60), None));
    assert_status(&out, PayStatus::Failed);
    assert_eq!(out.reason.as_deref(), Some("TransferFailed"));
    assert!(calls().is_empty());
    assert_eq!(v.spent_today(), U128(0), "released");
    assert_eq!(event("payment_failed")["reason"], "TransferFailed");
}

// -- request_payment ----------------------------------------------------------------------------

#[test]
fn a_request_without_a_registry_is_held_at_once_and_reserves_nothing() {
    let mut v = plain_vault();
    // Above the ceiling and the cap: exactly what a request is for.
    as_agent();
    let out = value(v.request_payment(
        shop(),
        U128(5_000),
        Some("invoice 12".to_owned()),
        "AboveAutoApprove".to_owned(),
    ));
    assert_status(&out, PayStatus::Held);
    assert_eq!(out.reason.as_deref(), Some("AboveAutoApprove"));
    let held_id = out.held_id.unwrap();
    assert_eq!(v.spent_today(), U128(0));

    let held = v.get_held(held_id).unwrap();
    assert_eq!(held.id, held_id);
    assert_eq!(held.payment_id, out.payment_id);
    assert_eq!(held.agent_pk, agent());
    assert_eq!(held.payee, shop());
    assert_eq!(held.amount, U128(5_000));
    assert_eq!(held.memo.as_deref(), Some("invoice 12"));
    assert_eq!(held.reason, "AboveAutoApprove");
    assert_eq!(held.created_at_s, U64(T0_S));
    assert_eq!(held.expires_at_s, U64(T0_S + HELD_TTL_S));

    let e = event("payment_held");
    assert_eq!(e["payment_id"], out.payment_id.0.to_string());
    assert_eq!(e["held_id"], held_id.0.to_string());
    assert_eq!(e["payee"], shop().as_str());
    assert_eq!(e["amount"], "5000");
    assert_eq!(e["reason"], "AboveAutoApprove");
}

#[test]
fn a_request_still_respects_the_freeze_and_the_key_expiry() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_agent_expiry(agent(), U64(T0_S - 1));
    as_agent();
    let out = value(v.request_payment(shop(), U128(5), None, "why".to_owned()));
    assert_refused(&out, "SessionKeyExpired");
    as_owner_yocto();
    v.set_agent_expiry(agent(), U64(0));
    as_owner(0);
    v.freeze();
    as_agent();
    let out = value(v.request_payment(shop(), U128(5), None, "why".to_owned()));
    assert_refused(&out, "Frozen");
    assert!(v.list_held(None, None).is_empty());
}

#[test]
fn a_request_with_a_registry_asks_first_and_reserves_nothing() {
    let mut v = registry_vault();
    as_agent();
    promise(v.request_payment(shop(), U128(5_000), None, "why".to_owned()));
    assert_eq!(call_names(), vec!["get_verdict", "on_verdict"]);
    assert_eq!(v.spent_today(), U128(0));
    let ctx = scheduled_ctx("on_verdict");
    assert_eq!(ctx.mode, PayMode::Request);
    assert_eq!(ctx.reason.as_deref(), Some("why"));
}

#[test]
fn held_payments_are_bounded_and_expired_ones_make_room() {
    let mut v = plain_vault();
    for _ in 0..MAX_PENDING_HELD {
        as_agent();
        assert_status(
            &value(v.request_payment(shop(), U128(5), None, "why".to_owned())),
            PayStatus::Held,
        );
    }
    as_agent();
    assert_refused(
        &value(v.request_payment(shop(), U128(5), None, "why".to_owned())),
        "HeldLimitReached",
    );
    assert_eq!(v.list_held(None, None).len(), MAX_PENDING_HELD as usize);

    // A day and a second later every entry has expired; the next request prunes them first.
    advance_s(HELD_TTL_S + 1);
    as_agent();
    let out = value(v.request_payment(shop(), U128(5), None, "why".to_owned()));
    assert_status(&out, PayStatus::Held);
    let names = event_names();
    assert_eq!(
        names.iter().filter(|n| *n == "held_expired").count(),
        MAX_PENDING_HELD as usize
    );
    assert_eq!(names.last().map(String::as_str), Some("payment_held"));
    assert_eq!(v.list_held(None, None).len(), 1);
}

#[test]
fn a_malformed_request_never_triggers_the_pruning_walk() {
    let mut v = plain_vault();
    for _ in 0..MAX_PENDING_HELD {
        as_agent();
        let _ = value(v.request_payment(shop(), U128(5), None, "why".to_owned()));
    }
    advance_s(HELD_TTL_S + 1);
    as_agent();
    let out = value(v.request_payment(shop(), U128(0), None, "why".to_owned()));
    assert_refused(&out, "InvalidAmount");
    assert_eq!(event_names(), vec!["payment_refused"]);
    assert_eq!(v.list_held(None, None).len(), MAX_PENDING_HELD as usize);
}

// -- record_refusal -----------------------------------------------------------------------------

/// Amendment A2: what the agent records goes to its own counter. `refusal_count` is the
/// registry's alone, so a prompt-injected agent recording refusals against an honest payee
/// cannot move the number other vaults may read about that payee.
#[test]
fn record_refusal_counts_in_the_guard_counter_and_moves_nothing() {
    let mut v = plain_vault();
    as_agent();
    let out = v.record_refusal(shop(), U128(70), "guard_deny_kya_revoked".to_owned());
    assert_refused(&out, "guard_deny_kya_revoked");
    assert_eq!(v.guard_refusal_count(shop()), 1);
    assert_eq!(v.refusal_count(shop()), 0, "never the registry's counter");
    let e = event("payment_refused");
    assert_eq!(e["source"], "agent_guard");
    assert_eq!(e["reason"], "guard_deny_kya_revoked");
    assert_eq!(e["amount"], "70");
    assert!(calls().is_empty());
    assert_eq!(v.spent_today(), U128(0));

    as_agent();
    let _ = v.record_refusal(shop(), U128(70), "again".to_owned());
    assert_eq!(v.guard_refusal_count(shop()), 2);
    assert_eq!(v.refusal_count(shop()), 0);
    assert_eq!(v.guard_refusal_count(other_shop()), 0);
}

#[test]
fn record_refusal_is_refused_like_a_request_and_then_counts_nothing() {
    let mut v = plain_vault();
    as_agent();
    assert_refused(
        &v.record_refusal(shop(), U128(0), "g".to_owned()),
        "InvalidAmount",
    );
    as_agent();
    assert_refused(
        &v.record_refusal(vault(), U128(1), "g".to_owned()),
        "InvalidPayee",
    );
    as_agent();
    assert_refused(&v.record_refusal(shop(), U128(1), text(129)), "MemoTooLong");
    assert_eq!(event("payment_refused")["source"], "policy");
    as_owner(0);
    v.freeze();
    as_agent();
    assert_refused(&v.record_refusal(shop(), U128(1), "g".to_owned()), "Frozen");
    for payee in [shop(), vault()] {
        assert_eq!(v.guard_refusal_count(payee.clone()), 0);
        assert_eq!(v.refusal_count(payee), 0);
    }
}

#[test]
fn policy_refusals_never_count_against_the_payee() {
    let mut v = plain_vault();
    as_agent();
    assert_refused(&value(v.pay(shop(), U128(101), None)), "AboveAutoApprove");
    assert_eq!(v.refusal_count(shop()), 0);
}

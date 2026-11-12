//! Every callback against mocked promise results: DENY, WARN, ALLOW, null, malformed bytes, a
//! reply that is too long, and a failed promise, in each mode, asserting the outcome, the events
//! and what happened to the reservation. None of them may abort.

use near_sdk::json_types::{U64, U128};
use near_sdk::{PromiseResult, env};

use super::*;
use crate::{AgentSpendPolicy, HoldKind, MAX_PENDING_HELD, PayMode, PayStatus, PaymentCtx};

const DENY: &str = r#"{"account_id":"shop.testnet","verdict":"DENY","reasons":["kya_revoked","wash_traded","sybil_cluster","fourth_reason"],"evidence":null,"score":12,"code_hash":null,"updated_at_ns":"1","updated_by":"oracle.testnet","expires_at_ns":null}"#;
const WARN: &str = r#"{"account_id":"shop.testnet","verdict":"WARN","reasons":["kya_unverified"]}"#;
const ALLOW: &str = r#"{"account_id":"shop.testnet","verdict":"ALLOW","reasons":[]}"#;

/// Every answer that must fail closed.
fn unusable_answers() -> Vec<(&'static str, PromiseResult)> {
    vec![
        ("failed promise", failed()),
        ("malformed bytes", ok_bytes(&[0x7b, 0xff, 0x00, 0x22])),
        ("empty reply", ok_bytes(b"")),
        ("unknown verdict", ok_json(r#"{"verdict":"BLOCK"}"#)),
        ("lower-case verdict", ok_json(r#"{"verdict":"deny"}"#)),
        ("no verdict field", ok_json(r#"{"reasons":["x"]}"#)),
        ("verdict not a string", ok_json(r#"{"verdict":true}"#)),
        (
            "too long",
            ok_bytes(format!("{}null", " ".repeat(crate::verdict::MAX_ANSWER_BYTES)).as_bytes()),
        ),
    ]
}

/// A registry vault with one `pay` of 60 in flight; returns the scheduled `on_verdict` ctx.
fn pay_in_flight(v: &mut AgentSpendPolicy) -> PaymentCtx {
    as_agent();
    promise(v.pay(shop(), U128(60), Some("memo".to_owned())));
    scheduled_ctx("on_verdict")
}

fn request_of(v: &mut AgentSpendPolicy, amount: u128) -> PaymentCtx {
    as_agent();
    promise(v.request_payment(shop(), U128(amount), None, "AboveAutoApprove".to_owned()));
    scheduled_ctx("on_verdict")
}

fn request_in_flight(v: &mut AgentSpendPolicy) -> PaymentCtx {
    request_of(v, 5_000)
}

/// A registry vault with a held payment of 700 that the owner has just approved; returns the
/// scheduled `on_verdict` ctx and the held id.
fn owner_pay_in_flight(v: &mut AgentSpendPolicy) -> (PaymentCtx, u64) {
    let ctx = request_of(v, 700);
    as_callback(vec![ok_json("null")]);
    let held_id = value(v.on_verdict(ctx)).held_id.unwrap().0;
    as_owner_yocto();
    promise(v.owner_pay(U64(held_id)));
    (scheduled_ctx("on_verdict"), held_id)
}

// -- on_verdict, mode Pay -------------------------------------------------------------------------

#[test]
fn pay_deny_releases_counts_and_refuses_on_chain() {
    let mut v = registry_vault();
    let ctx = pay_in_flight(&mut v);
    assert_eq!(v.spent_today(), U128(60));

    as_callback(vec![ok_json(DENY)]);
    let out = value(v.on_verdict(ctx));
    assert_refused(&out, "RegistryDeny");
    assert_eq!(v.spent_today(), U128(0), "released");
    assert_eq!(v.refusal_count(shop()), 1, "a DENY is the payee's");
    assert!(calls().is_empty(), "no token movement is even scheduled");
    let e = event("payment_refused");
    assert_eq!(e["source"], "registry");
    assert_eq!(e["reason"], "RegistryDeny");
    assert_eq!(
        e["registry_reasons"],
        serde_json::json!(["kya_revoked", "wash_traded", "sybil_cluster"])
    );
}

#[test]
fn pay_warn_releases_and_holds_for_the_owner() {
    let mut v = registry_vault();
    let ctx = pay_in_flight(&mut v);
    as_callback(vec![ok_json(WARN)]);
    let out = value(v.on_verdict(ctx.clone()));
    assert_status(&out, PayStatus::Held);
    assert_eq!(out.reason.as_deref(), Some("RegistryWarn"));
    assert_eq!(out.payment_id, ctx.payment_id);
    assert_eq!(v.spent_today(), U128(0), "a held payment reserves nothing");
    assert_eq!(v.refusal_count(shop()), 0, "a WARN is not a refusal");
    let held = v.get_held(out.held_id.unwrap()).unwrap();
    assert_eq!(held.reason, "RegistryWarn");
    assert_eq!(held.kind, HoldKind::RegistryWarn);
    assert_eq!(held.amount, U128(60));
    assert_eq!(held.memo.as_deref(), Some("memo"));
    assert_eq!(held.payment_id, ctx.payment_id);
    let e = event("payment_held");
    assert_eq!(e["reason"], "RegistryWarn");
    assert_eq!(e["kind"], "registry_warn");
    assert!(calls().is_empty());
}

/// `shop()` is a known payee (`fresh_vault` lists it), so silence pays it like an ALLOW. The
/// payee nobody vouches for is `test/unknown.rs`.
#[test]
fn pay_allow_and_no_verdict_go_on_to_the_transfer() {
    for answer in [ALLOW, "null"] {
        let mut v = registry_vault();
        let ctx = pay_in_flight(&mut v);
        as_callback(vec![ok_json(answer)]);
        promise(v.on_verdict(ctx.clone()));
        assert_eq!(
            call_names(),
            vec!["storage_deposit", "ft_transfer", "on_transfer"],
            "{answer}"
        );
        assert_eq!(scheduled_ctx("on_transfer"), ctx);
        assert_eq!(
            v.spent_today(),
            U128(60),
            "still reserved while the transfer runs"
        );
        assert!(events().is_empty());
    }
}

#[test]
fn pay_fails_closed_on_every_unusable_answer() {
    for (what, result) in unusable_answers() {
        let mut v = registry_vault();
        let ctx = pay_in_flight(&mut v);
        as_callback(vec![result]);
        let out = value(v.on_verdict(ctx));
        assert_refused(&out, "RegistryUnavailable");
        assert_eq!(v.spent_today(), U128(0), "{what}: released");
        assert_eq!(v.refusal_count(shop()), 0, "{what}: not the payee's fault");
        assert!(calls().is_empty(), "{what}");
        let e = event("payment_refused");
        assert_eq!(e["source"], "registry", "{what}");
        assert_eq!(e["registry_reasons"], serde_json::json!([]), "{what}");
    }
}

#[test]
fn a_freeze_while_the_registry_answers_stops_the_payment() {
    let mut v = registry_vault();
    let ctx = pay_in_flight(&mut v);
    as_owner(0);
    v.freeze();
    as_callback(vec![ok_json(ALLOW)]);
    let out = value(v.on_verdict(ctx));
    assert_refused(&out, "Frozen");
    assert_eq!(v.spent_today(), U128(0));
    assert!(calls().is_empty());
    assert_eq!(event("payment_refused")["source"], "policy");
}

#[test]
fn a_revocation_while_the_registry_answers_stops_the_payment() {
    let mut v = registry_vault();
    let ctx = pay_in_flight(&mut v);
    as_owner_yocto();
    v.revoke_agent_key(agent());
    as_callback(vec![ok_json("null")]);
    assert_refused(&value(v.on_verdict(ctx.clone())), "NotAgent");
    assert_eq!(v.spent_today(), U128(0));

    // Forgotten entirely: the same.
    let mut v = registry_vault();
    let ctx = pay_in_flight(&mut v);
    as_owner_yocto();
    v.revoke_agent_key(agent());
    as_owner_yocto();
    v.forget_agent_key(agent());
    as_callback(vec![ok_json("null")]);
    assert_refused(&value(v.on_verdict(ctx)), "NotAgent");
}

#[test]
fn an_expiry_passing_while_the_registry_answers_stops_the_payment() {
    let mut v = registry_vault();
    as_owner_yocto();
    v.set_agent_expiry(agent(), U64(T0_S));
    let ctx = pay_in_flight(&mut v);
    advance_s(1);
    as_callback(vec![ok_json(ALLOW)]);
    assert_refused(&value(v.on_verdict(ctx)), "SessionKeyExpired");
    assert_eq!(v.spent_today(), U128(0));
}

#[test]
fn a_warned_pay_with_the_held_map_full_is_refused_not_aborted() {
    let mut v = registry_vault();
    // Fill the map through the request path.
    for _ in 0..MAX_PENDING_HELD {
        let ctx = request_in_flight(&mut v);
        as_callback(vec![ok_json("null")]);
        assert_status(&value(v.on_verdict(ctx)), PayStatus::Held);
    }
    let ctx = pay_in_flight(&mut v);
    as_callback(vec![ok_json(WARN)]);
    let out = value(v.on_verdict(ctx));
    assert_refused(&out, "HeldLimitReached");
    assert_eq!(
        v.spent_today(),
        U128(0),
        "released before the hold was attempted"
    );
}

#[test]
fn a_release_on_a_later_day_leaves_that_day_alone() {
    let mut v = fresh_vault(Some(registry()), 1_000, 1_000);
    let ctx = pay_in_flight(&mut v); // reserved 60 on T0_DAY
    advance_s(DAY_S); // the next day
    as_agent();
    promise(v.pay(other_shop(), U128(300), None)); // reserved 300 on T0_DAY + 1
    assert_eq!(v.spent_today(), U128(300));
    as_callback(vec![ok_json(DENY)]);
    assert_refused(&value(v.on_verdict(ctx)), "RegistryDeny");
    assert_eq!(
        v.spent_today(),
        U128(300),
        "yesterday's release is not today's budget"
    );
}

// -- on_verdict, mode Request ---------------------------------------------------------------------

#[test]
fn request_deny_is_refused_and_counted() {
    let mut v = registry_vault();
    let ctx = request_in_flight(&mut v);
    as_callback(vec![ok_json(DENY)]);
    let out = value(v.on_verdict(ctx));
    assert_refused(&out, "RegistryDeny");
    assert_eq!(v.refusal_count(shop()), 1);
    assert!(v.list_held(None, None).is_empty());
    assert_eq!(v.spent_today(), U128(0));
}

#[test]
fn request_warn_allow_and_no_verdict_are_all_held_with_the_agents_reason() {
    // `shop()` is a payee the owner listed, so silence about it is not an unknown payee.
    for (answer, kind) in [
        (WARN, HoldKind::RegistryWarn),
        (ALLOW, HoldKind::AgentRequest),
        ("null", HoldKind::AgentRequest),
    ] {
        let mut v = registry_vault();
        let ctx = request_in_flight(&mut v);
        as_callback(vec![ok_json(answer)]);
        let out = value(v.on_verdict(ctx));
        assert_status(&out, PayStatus::Held);
        assert_eq!(out.reason.as_deref(), Some("AboveAutoApprove"), "{answer}");
        let held = v.get_held(out.held_id.unwrap()).unwrap();
        assert_eq!(held.amount, U128(5_000));
        assert_eq!(held.reason, "AboveAutoApprove");
        assert_eq!(held.kind, kind, "{answer}");
        assert_eq!(
            event("payment_held")["kind"],
            serde_json::to_value(kind).unwrap(),
            "{answer}"
        );
        assert_eq!(v.spent_today(), U128(0), "{answer}");
        assert!(calls().is_empty(), "{answer}");
    }
}

/// Finding ABI-1: a request's reason is the agent's own text, and a prompt-injected agent can
/// make it read like a vault code, here to pass a payee the registry warned on off as merely
/// new. The hold's `kind` is the vault's word, from the registry's answer.
#[test]
fn an_agent_cannot_relabel_a_registry_warn_as_an_unknown_payee() {
    let mut v = registry_vault();
    as_agent();
    promise(v.request_payment(newcomer(), U128(60), None, "UnknownPayee".to_owned()));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json(WARN)]);
    let out = value(v.on_verdict(ctx));
    assert_status(&out, PayStatus::Held);
    assert_eq!(
        out.reason.as_deref(),
        Some("UnknownPayee"),
        "the agent's words stay its words"
    );
    let held = v.get_held(out.held_id.unwrap()).unwrap();
    assert_eq!(held.kind, HoldKind::RegistryWarn);
    let e = event("payment_held");
    assert_eq!(e["reason"], "UnknownPayee");
    assert_eq!(e["kind"], "registry_warn");
}

/// Finding AUTH-3: a request in flight when the owner revokes its key is refused, not held.
/// The revocation already dropped the key's held payments; one arriving after it must not
/// refill the owner's queue.
#[test]
fn a_request_in_flight_when_its_key_is_revoked_is_refused_not_held() {
    for answer in [WARN, ALLOW, "null"] {
        let mut v = registry_vault();
        let ctx = request_in_flight(&mut v);
        as_owner_yocto();
        v.revoke_agent_key(agent());
        as_callback(vec![ok_json(answer)]);
        let out = value(v.on_verdict(ctx));
        assert_refused(&out, "NotAgent");
        assert_eq!(event("payment_refused")["source"], "policy", "{answer}");
        assert!(v.list_held(None, None).is_empty(), "{answer}");
        assert_eq!(v.spent_today(), U128(0), "{answer}");
    }
}

/// The same for the agent's own `pay`: a WARN, or silence about a payee nobody has judged,
/// would have been held. A freeze still holds it (`test/unknown.rs`); a revoked key does not.
#[test]
fn a_pay_in_flight_when_its_key_is_revoked_is_refused_rather_than_held() {
    for (payee, answer) in [(shop(), WARN), (newcomer(), "null")] {
        let mut v = registry_vault();
        as_agent();
        promise(v.pay(payee.clone(), U128(60), None));
        let ctx = scheduled_ctx("on_verdict");
        assert_eq!(v.spent_today(), U128(60));
        as_owner_yocto();
        v.revoke_agent_key(agent());
        as_callback(vec![ok_json(answer)]);
        assert_refused(&value(v.on_verdict(ctx)), "NotAgent");
        assert_eq!(v.spent_today(), U128(0), "{payee}: released");
        assert!(v.list_held(None, None).is_empty(), "{payee}");
    }
}

#[test]
fn request_fails_closed_on_every_unusable_answer() {
    for (what, result) in unusable_answers() {
        let mut v = registry_vault();
        let ctx = request_in_flight(&mut v);
        as_callback(vec![result]);
        let out = value(v.on_verdict(ctx));
        assert_refused(&out, "RegistryUnavailable");
        assert!(v.list_held(None, None).is_empty(), "{what}");
        assert_eq!(v.refusal_count(shop()), 0, "{what}");
    }
}

/// A request reserves nothing, so its refusal gives nothing back. Given back anyway, a refused
/// request would be a budget refund on demand: an agent at its cap asks for a payment the
/// registry refuses (a DENY payee, or any payee while the registry cannot answer) and has that
/// much to spend again the same day.
#[test]
fn a_refused_request_gives_back_no_budget() {
    for (answer, reason) in [
        (ok_json(DENY), "RegistryDeny"),
        (failed(), "RegistryUnavailable"),
    ] {
        let mut v = registry_vault();
        // 60 of the day's 1000 is reserved by a payment on its way to the token.
        let paying = pay_in_flight(&mut v);
        as_callback(vec![ok_json(ALLOW)]);
        promise(v.on_verdict(paying));
        assert_eq!(v.spent_today(), U128(60));

        let ctx = request_of(&mut v, 50);
        as_callback(vec![answer]);
        assert_refused(&value(v.on_verdict(ctx)), reason);
        assert_eq!(v.spent_today(), U128(60), "{reason}: nothing to give back");
    }
}

#[test]
fn requests_racing_for_the_last_held_slot_cannot_overfill_it() {
    let mut v = registry_vault();
    // MAX + 3 requests pass the limit check while none has been held yet.
    let ctxs: Vec<PaymentCtx> = (0..MAX_PENDING_HELD + 3)
        .map(|_| request_in_flight(&mut v))
        .collect();
    let mut held = 0;
    let mut refused = 0;
    for ctx in ctxs {
        as_callback(vec![ok_json("null")]);
        let out = value(v.on_verdict(ctx));
        match out.status {
            PayStatus::Held => held += 1,
            PayStatus::Refused => {
                assert_eq!(out.reason.as_deref(), Some("HeldLimitReached"));
                refused += 1;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(held, MAX_PENDING_HELD);
    assert_eq!(refused, 3);
    assert_eq!(v.list_held(None, None).len(), MAX_PENDING_HELD as usize);
}

// -- on_verdict, mode OwnerPay --------------------------------------------------------------------

#[test]
fn owner_pay_deny_is_refused_even_for_the_owner() {
    let mut v = registry_vault();
    let (ctx, held_id) = owner_pay_in_flight(&mut v);
    assert_eq!(ctx.mode, PayMode::OwnerPay);
    assert_eq!(v.spent_today(), U128(700));
    as_callback(vec![ok_json(DENY)]);
    let out = value(v.on_verdict(ctx));
    assert_refused(&out, "RegistryDeny");
    assert_eq!(out.held_id, Some(U64(held_id)));
    assert_eq!(v.spent_today(), U128(0));
    assert_eq!(v.refusal_count(shop()), 1);
    assert!(v.get_held(U64(held_id)).is_none(), "not re-inserted");
    let failed = event("held_settle_failed");
    assert_eq!(failed["held_id"], held_id.to_string());
    assert_eq!(failed["reason"], "RegistryDeny");
    assert_eq!(failed["payee"], shop().as_str());
    assert_eq!(failed["amount"], "700");
    assert_eq!(event("payment_refused")["source"], "registry");
}

#[test]
fn owner_pay_warn_and_allow_transfer_because_the_owner_is_the_human() {
    for answer in [WARN, ALLOW, "null"] {
        let mut v = registry_vault();
        let (ctx, _) = owner_pay_in_flight(&mut v);
        as_callback(vec![ok_json(answer)]);
        promise(v.on_verdict(ctx.clone()));
        assert_eq!(
            call_names(),
            vec!["storage_deposit", "ft_transfer", "on_transfer"],
            "{answer}"
        );
        assert_eq!(scheduled_ctx("on_transfer"), ctx);
    }
}

#[test]
fn owner_pay_fails_closed_and_tells_the_owner() {
    for (what, result) in unusable_answers() {
        let mut v = registry_vault();
        let (ctx, held_id) = owner_pay_in_flight(&mut v);
        as_callback(vec![result]);
        let out = value(v.on_verdict(ctx));
        assert_refused(&out, "RegistryUnavailable");
        assert_eq!(v.spent_today(), U128(0), "{what}");
        let failed = event("held_settle_failed");
        assert_eq!(failed["held_id"], held_id.to_string(), "{what}");
        assert_eq!(failed["reason"], "RegistryUnavailable", "{what}");
    }
}

#[test]
fn owner_pay_frozen_in_flight_still_transfers() {
    // The freeze binds the agent, not the owner.
    let mut v = registry_vault();
    let (ctx, _) = owner_pay_in_flight(&mut v);
    as_owner(0);
    v.freeze();
    as_callback(vec![ok_json(ALLOW)]);
    promise(v.on_verdict(ctx));
}

// -- on_transfer ----------------------------------------------------------------------------------

/// A plain vault with a `pay` of 60 whose transfer is in flight.
fn transfer_in_flight(v: &mut AgentSpendPolicy) -> PaymentCtx {
    as_agent();
    promise(v.pay(shop(), U128(60), Some("memo".to_owned())));
    scheduled_ctx("on_transfer")
}

#[test]
fn a_successful_transfer_is_counted_and_announced() {
    let mut v = plain_vault();
    let ctx = transfer_in_flight(&mut v);
    as_callback(vec![ok_bytes(b"")]);
    let out = v.on_transfer(ctx.clone());
    assert_status(&out, PayStatus::Sent);
    assert_eq!(out.reason, None);
    assert_eq!(out.payment_id, ctx.payment_id);
    assert_eq!(v.paid_count(shop()), 1);
    assert_eq!(
        v.spent_today(),
        U128(60),
        "the reservation becomes the spend"
    );
    let e = event("payment_sent");
    assert_eq!(e["payment_id"], ctx.payment_id.0.to_string());
    assert_eq!(e["payee"], shop().as_str());
    assert_eq!(e["amount"], "60");
    assert_eq!(e["day"], T0_DAY.to_string());
    assert_eq!(e["by_owner"], false);
    assert_eq!(e["memo"], "memo");
}

/// Finding NEAR-MP-04: `on_transfer` runs after the token moved the money, so it must not add
/// storage: a receipt whose new storage the vault cannot cover fails at its end, and here that
/// would be tokens gone with no `payment_sent` and the agent told the payment failed. The
/// payee's `paid_count` entry is written by the receipt that checked the vault can afford it.
#[test]
fn on_transfer_adds_no_storage_after_the_token_moved() {
    // `other_shop()` is listed, so it is paid on silence, and it has never been paid.
    let mut v = registry_vault();
    as_agent();
    promise(v.pay(other_shop(), U128(60), None));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json("null")]);
    let before = env::storage_usage();
    promise(v.on_verdict(ctx));
    v.paid_count.flush();
    assert_eq!(
        env::storage_usage() - before,
        counter_entry_bytes(&other_shop()),
        "the entry is written before the token is called"
    );
    assert_eq!(
        v.paid_count(other_shop()),
        0,
        "an entry at 0 is still never paid"
    );

    let ctx = scheduled_ctx("on_transfer");
    as_callback(vec![ok_bytes(b"")]);
    let before = env::storage_usage();
    assert_status(&v.on_transfer(ctx), PayStatus::Sent);
    v.paid_count.flush();
    assert_eq!(
        env::storage_usage(),
        before,
        "on_transfer only overwrote it"
    );
    assert_eq!(v.paid_count(other_shop()), 1);

    // Without a registry the entry is written by `pay` itself, the same way.
    let mut v = plain_vault();
    as_agent();
    let before = env::storage_usage();
    promise(v.pay(other_shop(), U128(60), None));
    v.paid_count.flush();
    assert_eq!(
        env::storage_usage() - before,
        counter_entry_bytes(&other_shop())
    );
    let ctx = scheduled_ctx("on_transfer");
    as_callback(vec![ok_bytes(b"")]);
    let before = env::storage_usage();
    assert_status(&v.on_transfer(ctx), PayStatus::Sent);
    v.paid_count.flush();
    assert_eq!(env::storage_usage(), before);
}

/// An entry left at 0 by a transfer that failed changes nothing: the payee is still unknown.
#[test]
fn a_failed_first_transfer_leaves_nothing_behind() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_hold_unknown(false);
    as_agent();
    promise(v.pay(newcomer(), U128(60), None));
    v.paid_count.flush();
    let ctx = scheduled_ctx("on_transfer");
    as_callback(vec![failed()]);
    let before = env::storage_usage();
    assert_status(&v.on_transfer(ctx), PayStatus::Failed);
    v.paid_count.flush();
    assert_eq!(
        before - env::storage_usage(),
        counter_entry_bytes(&newcomer()),
        "the entry written for the attempt is gone with it"
    );
    assert_eq!(v.paid_count(newcomer()), 0);

    // Never paid, so still unknown once the owner holds unknown payees again.
    as_owner_yocto();
    v.set_hold_unknown(true);
    as_agent();
    let out = value(v.pay(newcomer(), U128(60), None));
    assert_status(&out, PayStatus::Held);
    assert_eq!(out.reason.as_deref(), Some("UnknownPayee"));
}

#[test]
fn a_failed_transfer_never_removes_a_count_that_landed() {
    // Two payments to a listed, never-paid payee in flight; the first lands, the second fails.
    let mut v = plain_vault();
    as_agent();
    promise(v.pay(other_shop(), U128(60), None));
    let first = scheduled_ctx("on_transfer");
    as_agent();
    promise(v.pay(other_shop(), U128(40), None));
    let second = scheduled_ctx("on_transfer");
    as_callback(vec![ok_bytes(b"")]);
    assert_status(&v.on_transfer(first), PayStatus::Sent);
    as_callback(vec![failed()]);
    assert_status(&v.on_transfer(second), PayStatus::Failed);
    assert_eq!(v.paid_count(other_shop()), 1);
}

/// The other order: a failed transfer removed the entry while a second payment to the same
/// never-paid payee was still in flight, so the landing finds none. It writes one if the vault
/// can cover it, and otherwise skips the count, never the event and never the receipt: the
/// money has moved, and an uncounted payee only stays unknown.
#[test]
fn a_landing_after_a_failed_one_counts_when_it_can_and_never_aborts() {
    for (balance, counted) in [
        (DEFAULT_BALANCE, 1),
        // 300 KiB of mocked storage locks 3.072 NEAR; 1 milliNEAR is under the headroom.
        (3_073_000_000_000_000_000_000_000, 0),
    ] {
        let mut v = plain_vault();
        as_agent();
        promise(v.pay(other_shop(), U128(60), None));
        let first = scheduled_ctx("on_transfer");
        as_agent();
        promise(v.pay(other_shop(), U128(40), None));
        let second = scheduled_ctx("on_transfer");
        as_callback(vec![failed()]);
        assert_status(&v.on_transfer(first), PayStatus::Failed);

        set_balance(balance);
        as_callback(vec![ok_bytes(b"")]);
        assert_status(&v.on_transfer(second), PayStatus::Sent);
        assert_eq!(event("payment_sent")["amount"], "40");
        assert_eq!(v.paid_count(other_shop()), counted, "balance {balance}");
        assert_eq!(v.spent_today(), U128(40));
    }
}

#[test]
fn a_transfer_reply_body_never_matters() {
    // Success is the promise status; a token that returns a large body is still a success.
    let mut v = plain_vault();
    let ctx = transfer_in_flight(&mut v);
    as_callback(vec![ok_bytes(&vec![b'x'; 100_000])]);
    assert_status(&v.on_transfer(ctx), PayStatus::Sent);
}

#[test]
fn a_failed_transfer_releases_and_reports() {
    let mut v = plain_vault();
    let ctx = transfer_in_flight(&mut v);
    as_callback(vec![failed()]);
    let out = v.on_transfer(ctx.clone());
    assert_status(&out, PayStatus::Failed);
    assert_eq!(out.reason.as_deref(), Some("TransferFailed"));
    assert_eq!(v.spent_today(), U128(0));
    assert_eq!(v.paid_count(shop()), 0);
    let e = event("payment_failed");
    assert_eq!(e["payment_id"], ctx.payment_id.0.to_string());
    assert_eq!(e["reason"], "TransferFailed");
    assert_eq!(event_names(), vec!["payment_failed"]);
}

#[test]
fn a_failed_transfer_reported_on_a_later_day_leaves_that_day_alone() {
    let mut v = fresh_vault(None, 1_000, 1_000);
    let ctx = transfer_in_flight(&mut v);
    advance_s(DAY_S);
    as_agent();
    promise(v.pay(other_shop(), U128(400), None));
    as_callback(vec![failed()]);
    assert_status(&v.on_transfer(ctx), PayStatus::Failed);
    assert_eq!(v.spent_today(), U128(400));
}

#[test]
fn an_owner_settlement_that_fails_to_transfer_tells_the_owner() {
    let mut v = plain_vault();
    as_agent();
    let held_id =
        value(v.request_payment(shop(), U128(700), Some("inv".to_owned()), "why".to_owned()))
            .held_id
            .unwrap();
    as_owner_yocto();
    promise(v.owner_pay(held_id));
    let ctx = scheduled_ctx("on_transfer");
    assert_eq!(v.spent_today(), U128(700));
    as_callback(vec![failed()]);
    let out = v.on_transfer(ctx);
    assert_status(&out, PayStatus::Failed);
    assert_eq!(out.held_id, Some(held_id));
    assert_eq!(v.spent_today(), U128(0));
    let failed = event("held_settle_failed");
    assert_eq!(failed["held_id"], held_id.0.to_string());
    assert_eq!(failed["reason"], "TransferFailed");
    assert_eq!(failed["memo"], "inv");
}

#[test]
fn an_owner_settlement_that_lands_is_marked_by_owner() {
    let mut v = plain_vault();
    as_agent();
    let held_id = value(v.request_payment(shop(), U128(700), None, "why".to_owned()))
        .held_id
        .unwrap();
    as_owner_yocto();
    promise(v.owner_pay(held_id));
    let ctx = scheduled_ctx("on_transfer");
    as_callback(vec![ok_bytes(b"")]);
    let out = v.on_transfer(ctx);
    assert_status(&out, PayStatus::Sent);
    assert_eq!(out.held_id, Some(held_id));
    assert_eq!(event("payment_sent")["by_owner"], true);
    assert_eq!(v.paid_count(shop()), 1);
}

// -- on_agent_key_added and on_withdraw ------------------------------------------------------------

#[test]
fn a_successful_key_add_keeps_the_record() {
    let mut v = plain_vault();
    as_callback(vec![ok_bytes(b"")]);
    assert!(v.on_agent_key_added(agent(), U64(1)));
    assert!(v.get_agent(agent()).is_some());
    assert!(events().is_empty());
}

#[test]
fn a_failed_key_add_removes_the_record_it_wrote() {
    let mut v = plain_vault();
    as_callback(vec![failed()]);
    assert!(!v.on_agent_key_added(agent(), U64(1)));
    assert!(v.get_agent(agent()).is_none());
    assert_eq!(
        event("agent_key_add_failed")["public_key"],
        agent().to_string()
    );
    as_agent();
    assert_panics_with("NotAgent", || {
        let _ = v.pay(shop(), U128(1), None);
    });
}

#[test]
fn a_stale_failed_add_never_removes_a_newer_record() {
    // add (nonce 1) ... revoke, forget, add again (nonce 2) ... then add #1 reports failure.
    let mut v = plain_vault();
    as_owner_yocto();
    v.revoke_agent_key(agent());
    as_owner_yocto();
    v.forget_agent_key(agent());
    grant(&mut v, agent());
    as_callback(vec![failed()]);
    assert!(!v.on_agent_key_added(agent(), U64(1)));
    let record = v.get_agent(agent()).expect("the newer record survives");
    assert!(!record.revoked);
    assert_eq!(
        event("agent_key_add_failed")["public_key"],
        agent().to_string()
    );
}

#[test]
fn withdrawal_results_are_announced_either_way() {
    let mut v = plain_vault();
    as_callback(vec![ok_bytes(b"")]);
    assert!(v.on_withdraw(U128(250)));
    assert_eq!(event("withdrawn")["amount"], "250");
    as_callback(vec![failed()]);
    assert!(!v.on_withdraw(U128(250)));
    assert_eq!(event("withdraw_failed")["amount"], "250");
}

#[test]
fn a_successful_call_with_a_reply_body_is_still_a_success() {
    // The status-only callbacks read zero bytes of the reply, so a body is `TooLong` to them,
    // and only `Failed` means failure. A token or an add-key that answers with bytes has still
    // done what it was asked.
    let body = || ok_bytes(br#"{"unexpected":"reply"}"#);
    let mut v = plain_vault();
    as_callback(vec![body()]);
    assert!(v.on_withdraw(U128(250)));
    assert_eq!(event_names(), vec!["withdrawn"]);
    as_callback(vec![body()]);
    assert!(v.on_agent_key_added(agent(), U64(1)));
    assert!(v.get_agent(agent()).is_some(), "the record stays");
    as_agent();
    promise(v.pay(shop(), U128(60), None));
    let ctx = scheduled_ctx("on_transfer");
    as_callback(vec![body()]);
    assert_status(&v.on_transfer(ctx), PayStatus::Sent);
    assert_eq!(
        v.spent_today(),
        U128(60),
        "a success keeps the reservation as spend"
    );
}

// -- the callback context is exactly what was scheduled ---------------------------------------------

#[test]
fn the_ctx_round_trips_through_the_callback_arguments() {
    let mut v = registry_vault();
    let ctx = pay_in_flight(&mut v);
    let json = serde_json::to_value(&ctx).unwrap();
    assert_eq!(json["mode"], "pay");
    assert_eq!(json["payment_id"], "1");
    assert_eq!(json["amount"], "60");
    assert_eq!(json["day"], T0_DAY.to_string());
    assert_eq!(json["agent_pk"], agent().to_string());
    let back: PaymentCtx = serde_json::from_value(json).unwrap();
    assert_eq!(back, ctx);
    let owner_json = serde_json::to_value(PayMode::OwnerPay).unwrap();
    assert_eq!(owner_json, "owner_pay");
}

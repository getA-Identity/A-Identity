//! One test per guard, each checked where it matters: on chain, after the receipts ran.
//!
//! A guard that refuses in a unit test can still be bypassed by the receipt chain around
//! it: a reservation that is not released, a refusal that reaches the token anyway, a panic
//! that a client cannot name. So each test here asserts three things about a refusal: the
//! name it carries, that nothing moved, and that the day's accounting is where it was.

mod common;

use common::*;
use near_api::NearToken;
use near_sdk::serde_json::json;

// ---------------------------------------------------------------------------------------
// The spend ladder
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn the_per_payment_ceiling_refuses_above_it_and_pays_at_it() {
    let w = World::new(Setup::default()).await;

    let tx = w
        .pay(&w.merchant, DEFAULT_AUTO_APPROVE_MAX + 1, None)
        .await
        .assert_ok();
    tx.outcome().assert_refused("AboveAutoApprove");
    let refused = tx.vault_event("payment_refused");
    assert_eq!(str_field(&refused, "source"), "policy");
    assert!(str_list(&refused, "registry_reasons").is_empty());
    assert!(
        !tx.touched(&w.registry),
        "a policy refusal is decided before any external call"
    );
    assert!(!tx.touched(&w.token));
    assert_eq!(w.spent_today().await, 0);
    assert_eq!(
        w.refusal_count(&w.merchant).await,
        0,
        "a policy refusal says nothing about the payee"
    );

    // Exactly at the ceiling is allowed: strictly greater-than, as in the siblings.
    w.pay(&w.merchant, DEFAULT_AUTO_APPROVE_MAX, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    assert_eq!(w.ft_balance(&w.merchant).await, DEFAULT_AUTO_APPROVE_MAX);

    // Zero means no ceiling, never "nothing may be paid".
    w.set_policy(DEFAULT_DAILY_CAP, 0, false).await.assert_ok();
    w.pay(&w.merchant, 50 * UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
}

/// Structuring one large payment into many small ones is what a per-payment ceiling cannot
/// stop on its own, and the cumulative daily cap is what stops it.
#[tokio::test]
async fn the_daily_cap_is_cumulative_and_refuses_the_payment_that_would_cross_it() {
    let w = World::new(Setup::with_policy(30 * UNIT, 20 * UNIT)).await;

    w.pay(&w.merchant, 20 * UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    assert_eq!(w.remaining_today().await, Some(10 * UNIT));
    // Reaching the cap exactly is allowed.
    w.pay(&w.merchant, 10 * UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    assert_eq!(w.remaining_today().await, Some(0));

    let tx = w.pay(&w.merchant, 1, None).await.assert_ok();
    tx.outcome().assert_refused("DailyCapExceeded");
    assert_eq!(
        str_field(&tx.vault_event("payment_refused"), "source"),
        "policy"
    );
    assert!(!tx.touched(&w.token));
    assert_eq!(w.spent_today().await, 30 * UNIT);
    assert_eq!(w.ft_balance(&w.merchant).await, 30 * UNIT);
    assert_eq!(w.refusal_count(&w.merchant).await, 0);

    // Zero means no cap: the remaining budget reads as none, and the payment goes through.
    w.set_policy(0, 20 * UNIT, false).await.assert_ok();
    assert_eq!(w.remaining_today().await, None);
    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
}

/// A NEAR contract cannot read its token balance synchronously, so an underfunded vault is
/// caught where the money moves. The same path covers a token that refuses for reasons of
/// its own (Circle's FiatToken can be paused and has a blocklist): the transfer fails, the
/// callback gives the reservation back, and the outcome says so by name.
#[tokio::test]
async fn a_failed_transfer_rolls_the_reservation_back_and_says_so() {
    let w = World::new(Setup {
        fund: 10 * UNIT,
        ..Setup::default()
    })
    .await;

    let tx = w
        .pay(&w.merchant, 15 * UNIT, Some("too-much"))
        .await
        .assert_ok();
    let outcome = tx.outcome();
    outcome.assert_failed("TransferFailed");
    assert!(
        tx.failed_on(&w.token),
        "the token's ft_transfer is what failed"
    );
    assert!(
        tx.receipt_failure_text()
            .contains("The account doesn't have enough balance"),
        "{}",
        tx.receipt_failure_text()
    );

    let failed = tx.vault_event("payment_failed");
    assert_eq!(str_field(&failed, "reason"), "TransferFailed");
    assert_eq!(
        num_field(&failed, "payment_id"),
        u128::from(outcome.payment_id.0)
    );
    assert_eq!(num_field(&failed, "amount"), 15 * UNIT);
    assert!(!tx.has_vault_event("payment_sent"));

    assert_eq!(w.spent_today().await, 0, "the reservation was released");
    assert_eq!(w.ft_balance(&w.vault).await, 10 * UNIT);
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(w.paid_count(&w.merchant).await, 0);
    assert_eq!(
        w.refusal_count(&w.merchant).await,
        0,
        "a failed transfer is not the payee's fault"
    );

    // The budget really is back: a payment the vault can cover goes through.
    w.pay(&w.merchant, 10 * UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    assert_eq!(w.spent_today().await, 10 * UNIT);
}

// ---------------------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn freeze_is_one_click_and_stops_every_agent_write() {
    let w = World::new(Setup::default()).await;
    // A request the owner will still be able to settle while frozen.
    let held_id = w
        .request_payment(&w.merchant, 2 * UNIT, None, "asking_first")
        .await
        .assert_ok()
        .outcome()
        .assert_held();

    w.call(&w.stranger, &w.vault, "freeze", json!({}))
        .send()
        .await
        .assert_panicked_with("NotOwner");

    // No yocto: a panic button has to work from the console's function-call key.
    let tx = w.freeze().await.assert_ok();
    assert!(bool_field(&tx.vault_event("frozen_set"), "frozen"));
    assert!(w.config().await.frozen);

    let tx = w.pay(&w.merchant, UNIT, None).await.assert_ok();
    tx.outcome().assert_refused("Frozen");
    assert!(!tx.touched(&w.registry));
    w.request_payment(&w.merchant, UNIT, None, "asking")
        .await
        .assert_ok()
        .outcome()
        .assert_refused("Frozen");
    w.record_refusal(&w.attacker, UNIT, "guard_deny")
        .await
        .assert_ok()
        .outcome()
        .assert_refused("Frozen");
    assert_eq!(
        w.guard_refusal_count(&w.attacker).await,
        0,
        "a frozen vault writes no counter either"
    );
    assert_eq!(w.refusal_count(&w.attacker).await, 0);
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(w.spent_today().await, 0);

    // The freeze stops the agent, not the owner.
    w.owner_pay(held_id)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    assert_eq!(w.ft_balance(&w.merchant).await, 2 * UNIT);
    assert!(w.config().await.frozen);
}

/// The yocto rule's whole point, shown with the key a web wallet would actually hold: a
/// function-call key the owner's console signed in with can freeze, but it can never lift
/// the freeze, because lifting needs exactly one yoctoNEAR and that key cannot attach any.
#[tokio::test]
async fn unfreeze_needs_one_yocto_so_a_console_key_cannot_lift_a_freeze() {
    let w = World::new(Setup::default()).await;
    let console = w
        .add_function_call_key(
            &w.owner,
            &w.vault,
            &["freeze", "unfreeze", "set_policy"],
            Some(NearToken::from_near(1)),
        )
        .await;

    w.owner_call_plain("freeze", json!({}))
        .signed_with(console.clone())
        .send()
        .await
        .assert_ok();
    assert!(w.config().await.frozen);

    // Without the yocto the contract refuses it...
    w.owner_call_plain("unfreeze", json!({}))
        .signed_with(console.clone())
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    // ...and with it the protocol does, before the contract is reached.
    assert_protocol_rejected(
        w.owner_call("unfreeze", json!({}))
            .signed_with(console.clone())
            .try_send_raw()
            .await,
        &["DepositWithFunctionCall"],
    );
    // The same holds for every policy change.
    w.call(&w.owner, &w.vault, "set_policy", policy_args(0, 0, false))
        .signed_with(console)
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    assert!(w.config().await.frozen, "still frozen");
    assert_eq!(w.config().await.daily_cap.0, DEFAULT_DAILY_CAP);

    // Exactly one: two yocto is refused as well.
    w.owner_call_plain("unfreeze", json!({}))
        .deposit(NearToken::from_yoctonear(2))
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");

    // The owner's full-access key, with exactly one yocto.
    let tx = w.unfreeze().await.assert_ok();
    assert!(!bool_field(&tx.vault_event("frozen_set"), "frozen"));
    assert!(!w.config().await.frozen);
    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
}

// ---------------------------------------------------------------------------------------
// Key expiry
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn an_expired_agent_key_is_refused_and_the_owner_can_lift_the_bound() {
    let w = World::new(Setup::default()).await;
    // A minute of block time: comfortably more than the two transactions that must land
    // before it, and cheap to cross with fast_forward.
    let expires = w.chain_time_s().await + 60;

    let tx = w.set_agent_expiry(&w.agent_pk, expires).await.assert_ok();
    let set = tx.vault_event("agent_expiry_set");
    assert_eq!(str_field(&set, "public_key"), w.agent_pk.to_string());
    assert_eq!(num_field(&set, "expires_at_s"), u128::from(expires));
    assert_decimal_string(&set, "expires_at_s");
    w.call(
        &w.stranger,
        &w.vault,
        "set_agent_expiry",
        json!({ "public_key": w.agent_pk, "expires_at_s": "0" }),
    )
    .one_yocto()
    .send()
    .await
    .assert_panicked_with("NotOwner");

    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();

    w.advance_time_past_second(expires).await;
    let tx = w.pay(&w.merchant, UNIT, None).await.assert_ok();
    tx.outcome().assert_refused("SessionKeyExpired");
    assert!(!tx.touched(&w.token));
    w.request_payment(&w.merchant, UNIT, None, "asking")
        .await
        .assert_ok()
        .outcome()
        .assert_refused("SessionKeyExpired");
    w.record_refusal(&w.attacker, UNIT, "guard_deny")
        .await
        .assert_ok()
        .outcome()
        .assert_refused("SessionKeyExpired");
    assert_eq!(w.ft_balance(&w.merchant).await, UNIT);
    assert_eq!(w.spent_today().await, UNIT);
    // Expiry is the contract's rule; the access key itself is still on the account.
    assert!(w.access_key(&w.vault, &w.agent_pk).await.is_some());

    // Zero removes the bound.
    w.set_agent_expiry(&w.agent_pk, 0).await.assert_ok();
    assert_eq!(
        w.agent_record(&w.agent_pk)
            .await
            .expect("record")
            .expires_at_s
            .0,
        0
    );
    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
}

// ---------------------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn with_the_allowlist_on_only_listed_payees_are_paid() {
    let w = World::new(Setup::default()).await;

    let tx = w
        .set_policy(DEFAULT_DAILY_CAP, DEFAULT_AUTO_APPROVE_MAX, true)
        .await
        .assert_ok();
    let policy = tx.vault_event("policy_updated");
    assert!(bool_field(&policy, "allowlist_enabled"));
    assert_eq!(num_field(&policy, "daily_cap"), DEFAULT_DAILY_CAP);
    assert_decimal_string(&policy, "daily_cap");
    assert_decimal_string(&policy, "auto_approve_max");
    assert!(w.config().await.allowlist_enabled);

    let tx = w.pay(&w.merchant, UNIT, None).await.assert_ok();
    tx.outcome().assert_refused("PayeeNotAllowed");
    assert!(!tx.touched(&w.registry));

    // Only the owner edits the list, with the yocto.
    w.call(
        &w.stranger,
        &w.vault,
        "set_allowed",
        json!({ "payee": w.stranger, "ok": true }),
    )
    .one_yocto()
    .send()
    .await
    .assert_panicked_with("NotOwner");
    w.owner_call_plain("set_allowed", json!({ "payee": w.merchant, "ok": true }))
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    assert!(!w.is_allowed(&w.merchant).await);

    let tx = w.set_allowed(&w.merchant, true).await.assert_ok();
    let set = tx.vault_event("allowlist_set");
    assert_eq!(str_field(&set, "payee"), w.merchant.as_str());
    assert!(bool_field(&set, "ok"));
    assert!(w.is_allowed(&w.merchant).await);
    assert!(w.allowlist_text().await.contains(w.merchant.as_str()));

    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    w.pay(&w.stranger, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_refused("PayeeNotAllowed");

    // Being listed does not override the registry.
    w.set_allowed(&w.attacker, true).await.assert_ok();
    w.set_verdict(&w.attacker, "DENY", &["drainer"]).await;
    w.pay(&w.attacker, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_refused("RegistryDeny");

    // Removal takes effect on the next payment.
    w.set_allowed(&w.merchant, false).await.assert_ok();
    assert!(!w.is_allowed(&w.merchant).await);
    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_refused("PayeeNotAllowed");
    assert_eq!(w.ft_balance(&w.merchant).await, UNIT);
    assert_eq!(w.ft_balance(&w.stranger).await, 0);
    assert_eq!(w.ft_balance(&w.attacker).await, 0);
}

// ---------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------

/// A registry the vault cannot read is a registry that has not said ALLOW. Two ways to be
/// unreadable are shown: an account with no contract, and a contract with no `get_verdict`.
/// Neither is the payee's fault, so neither counts against it.
#[tokio::test]
async fn a_registry_that_cannot_answer_fails_closed() {
    let w = World::new(Setup::default()).await;

    w.owner_call_plain("set_registry", json!({ "registry_id": w.stranger }))
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    let tx = w.set_registry(Some(&w.stranger)).await.assert_ok();
    assert_eq!(
        str_field(&tx.vault_event("registry_set"), "registry_id"),
        w.stranger.as_str()
    );

    for unreadable in [w.stranger.clone(), w.token.clone()] {
        w.set_registry(Some(&unreadable)).await.assert_ok();
        let tx = w.pay(&w.merchant, UNIT, None).await.assert_ok();
        let outcome = tx.outcome();
        outcome.assert_refused("RegistryUnavailable");
        assert!(
            tx.failed_on(&unreadable),
            "the cross-contract call to {unreadable} is what failed"
        );
        let refused = tx.vault_event("payment_refused");
        assert_eq!(str_field(&refused, "source"), "registry");
        assert!(str_list(&refused, "registry_reasons").is_empty());
        // When the "registry" is the token itself the token is touched, by the failed
        // `get_verdict`; what must never happen is a transfer.
        assert!(
            tx.events_of(NEP141_STANDARD).is_empty(),
            "nothing was transferred"
        );
        assert!(!tx.has_vault_event("payment_sent"));
        assert_eq!(w.spent_today().await, 0, "the reservation was released");
    }
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(w.refusal_count(&w.merchant).await, 0);

    // Back on the real registry, the same payment goes through.
    w.set_registry(Some(&w.registry)).await.assert_ok();
    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();

    // With no registry at all, the vault skips the check: an explicit owner choice, logged.
    // Every payee then reads as one the registry is silent on, so only a known payee is paid:
    // the merchant, which the vault paid a moment ago...
    let tx = w.set_registry(None).await.assert_ok();
    assert!(
        tx.vault_event("registry_set")
            .get("registry_id")
            .is_some_and(|id| id.is_null())
    );
    assert!(w.config().await.registry_id.is_none());
    assert_eq!(w.paid_count(&w.merchant).await, 1);
    let tx = w.pay(&w.merchant, UNIT, None).await.assert_ok();
    tx.outcome().assert_sent();
    assert!(!tx.touched(&w.registry));
    assert_eq!(w.ft_balance(&w.merchant).await, 2 * UNIT);
    // ...while a payee the vault never paid waits for the owner (amendment A1).
    let tx = w.pay(&w.newshop, UNIT, None).await.assert_ok();
    tx.outcome().assert_held_because("UnknownPayee");
    assert!(!tx.touched(&w.token));
    assert_eq!(w.ft_balance(&w.newshop).await, 0);
}

/// A held payment can wait while A-Identity learns more about the payee. The owner's
/// approval settles a WARN, but it does not override a DENY that arrived in the meantime.
#[tokio::test]
async fn the_owners_approval_does_not_override_a_later_deny() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(&w.merchant, "WARN", &["new_account"]).await;
    let held_id = w
        .pay(&w.merchant, 5 * UNIT, Some("inv-9"))
        .await
        .assert_ok()
        .outcome()
        .assert_held();

    w.set_verdict(&w.merchant, "DENY", &["drainer"]).await;

    let tx = w.owner_pay(held_id).await.assert_ok();
    tx.outcome().assert_refused("RegistryDeny");
    assert!(!tx.touched(&w.token));
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(
        w.spent_today().await,
        0,
        "the settlement's reservation was released"
    );
    assert_eq!(w.refusal_count(&w.merchant).await, 1);

    // The entry left the queue when the settlement started, so it cannot be approved twice
    // at once; this event is where the owner reads what did not go through.
    let failed = tx.vault_event("held_settle_failed");
    assert_eq!(num_field(&failed, "held_id"), u128::from(held_id));
    assert_eq!(str_field(&failed, "reason"), "RegistryDeny");
    assert!(w.held(held_id).await.is_none());
}

// ---------------------------------------------------------------------------------------
// Tokens in and out
// ---------------------------------------------------------------------------------------

/// The vault only keeps the token its policy governs. Anything else is handed back in full
/// by `ft_on_transfer`, so its sender is refunded and the vault never holds a balance that
/// no cap or verdict applies to.
#[tokio::test]
async fn a_foreign_token_is_refunded_and_never_logged_as_a_deposit() {
    let w = World::new(Setup::default()).await;
    let other = w.deploy_foreign_token("othertoken").await;
    let owner_before = w.ft_balance_on(&other, &w.owner).await;

    let tx = w
        .call(
            &w.owner,
            &other,
            "ft_transfer_call",
            json!({ "receiver_id": w.vault, "amount": (5 * UNIT).to_string(), "memo": null, "msg": "" }),
        )
        .one_yocto()
        .send()
        .await
        .assert_ok();
    assert_eq!(tx.json::<String>(), "0", "the vault kept none of it");
    assert_eq!(w.ft_balance_on(&other, &w.vault).await, 0);
    assert_eq!(w.ft_balance_on(&other, &w.owner).await, owner_before);
    assert!(
        tx.vault_events().is_empty(),
        "no deposit is logged for a token the vault does not govern"
    );

    // A direct call that pretends to be a token deposit gets the same answer.
    let fake = w
        .call(
            &w.stranger,
            &w.vault,
            "ft_on_transfer",
            json!({ "sender_id": w.stranger, "amount": (5 * UNIT).to_string(), "msg": "" }),
        )
        .send()
        .await
        .assert_ok();
    assert_eq!(fake.json::<String>(), (5 * UNIT).to_string());
    assert!(fake.vault_events().is_empty());

    // The vault's own token, by contrast, is kept and logged.
    let tx = w.fund_vault(UNIT).await;
    assert_eq!(num_field(&tx.vault_event("deposited"), "amount"), UNIT);
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND + UNIT);
}

/// There is no `to` on `withdraw`: a console session that can get the owner to sign a
/// withdrawal still cannot send the funds anywhere but the owner.
#[tokio::test]
async fn withdraw_pays_only_the_owner() {
    let w = World::new(Setup::default()).await;
    let owner_before = w.ft_balance(&w.owner).await;
    let amount = 100 * UNIT;

    w.call(
        &w.stranger,
        &w.vault,
        "withdraw",
        json!({ "amount": amount.to_string() }),
    )
    .one_yocto()
    .send()
    .await
    .assert_panicked_with("NotOwner");
    w.owner_call_plain("withdraw", json!({ "amount": amount.to_string() }))
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    w.withdraw(0).await.assert_panicked_with("InvalidAmount");
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND);

    // An argument naming another receiver is either refused outright or ignored. Either way
    // the attacker receives nothing; whatever moves, moves to the owner.
    let redirect = json!({
        "amount": amount.to_string(),
        "receiver_id": w.attacker,
        "to": w.attacker,
    });
    let tx = w.owner_call("withdraw", redirect).send().await;
    assert_eq!(w.ft_balance(&w.attacker).await, 0);
    if tx.is_success() {
        let withdrawn = tx.vault_event("withdrawn");
        assert_eq!(num_field(&withdrawn, "amount"), amount);
        assert_decimal_string(&withdrawn, "amount");
        assert_eq!(w.ft_balance(&w.owner).await, owner_before + amount);
        assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND - amount);
    } else {
        assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND);
        w.withdraw(amount).await.assert_ok();
        assert_eq!(w.ft_balance(&w.owner).await, owner_before + amount);
    }
    assert_eq!(
        w.spent_today().await,
        0,
        "the owner reclaiming funds is not the agent spending them"
    );

    // More than the vault holds: the token refuses, the callback says so, nothing moves.
    let left = w.ft_balance(&w.vault).await;
    let tx = w.withdraw(left + 1).await.assert_ok();
    assert_eq!(
        num_field(&tx.vault_event("withdraw_failed"), "amount"),
        left + 1
    );
    assert!(!tx.has_vault_event("withdrawn"));
    assert_eq!(w.ft_balance(&w.vault).await, left);
    assert_eq!(w.ft_balance(&w.owner).await, owner_before + amount);
}

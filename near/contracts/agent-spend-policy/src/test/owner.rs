//! The owner's surface: init, agent keys, policy, held payments, withdrawals, deposits.

use near_sdk::json_types::{U64, U128};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::get_created_receipts;
use near_sdk::{AccountId, NearToken};

use super::*;
use crate::{
    AGENT_METHODS, AgentSpendPolicy, GAS_FT_TRANSFER, GAS_ON_KEY_ADDED, GAS_ON_VERDICT,
    GAS_ON_WITHDRAW, GAS_REGISTRY_VIEW, GAS_STORAGE_DEPOSIT, MAX_AGENT_KEYS, MAX_ALLOWLIST,
    PayStatus, VERSION,
};

struct AddedKey {
    account: AccountId,
    public_key: String,
    allowance: Option<NearToken>,
    receiver: AccountId,
    methods: Vec<String>,
}

fn added_keys() -> Vec<AddedKey> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::AddKeyWithFunctionCall {
                public_key,
                allowance,
                receiver_id,
                method_names,
                ..
            } = action
            {
                out.push(AddedKey {
                    account: receipt.receiver_id.clone(),
                    public_key: public_key.to_string(),
                    allowance,
                    receiver: receiver_id,
                    methods: method_names,
                });
            }
        }
    }
    out
}

fn deleted_keys() -> Vec<(AccountId, String)> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::DeleteKey { public_key, .. } = action {
                out.push((receipt.receiver_id.clone(), public_key.to_string()));
            }
        }
    }
    out
}

/// A vault with one held payment of 500 to `shop()`, created by a no-registry request.
fn vault_with_held() -> (AgentSpendPolicy, u64) {
    let mut v = plain_vault();
    as_agent();
    let out = value(v.request_payment(
        shop(),
        U128(500),
        Some("inv-7".to_owned()),
        "AboveAutoApprove".to_owned(),
    ));
    assert_status(&out, PayStatus::Held);
    (v, out.held_id.unwrap().0)
}

// -- init -----------------------------------------------------------------------------------------

#[test]
fn init_records_the_config_and_announces_it() {
    begin();
    let v = AgentSpendPolicy::new(
        owner(),
        token(),
        Some(registry()),
        U128(STORAGE_DEPOSIT),
        U128(1_000),
        U128(100),
    );
    let config = v.get_config();
    assert_eq!(config.owner_id, owner());
    assert_eq!(config.token_id, token());
    assert_eq!(config.registry_id, Some(registry()));
    assert!(!config.frozen);
    assert_eq!(config.daily_cap, U128(1_000));
    assert_eq!(config.auto_approve_max, U128(100));
    assert!(!config.allowlist_enabled);
    assert_eq!(config.token_storage_deposit, U128(STORAGE_DEPOSIT));
    assert_eq!(config.version, VERSION);
    assert_eq!(config.version, "agent-spend-policy 0.2.0");
    assert!(
        config.hold_unknown,
        "a new vault holds payees nobody has judged"
    );

    let e = event("vault_initialized");
    assert_eq!(e["owner_id"], owner().as_str());
    assert_eq!(e["token_id"], token().as_str());
    assert_eq!(e["registry_id"], registry().as_str());
}

#[test]
fn init_registers_the_vault_on_the_token_from_its_own_balance() {
    begin();
    let _v = AgentSpendPolicy::new(
        owner(),
        token(),
        None,
        U128(STORAGE_DEPOSIT),
        U128(0),
        U128(0),
    );
    let calls = calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].receiver, token());
    assert_eq!(calls[0].method, "storage_deposit");
    assert_eq!(calls[0].args["account_id"], vault().as_str());
    assert_eq!(calls[0].args["registration_only"], true);
    assert_eq!(calls[0].deposit, NearToken::from_yoctonear(STORAGE_DEPOSIT));
    assert_eq!(calls[0].gas, GAS_STORAGE_DEPOSIT);
}

#[test]
fn init_skips_the_registration_rather_than_failing_when_it_cannot_afford_it() {
    begin();
    // Default mocked storage usage is 300 KiB: 3.072 NEAR locked. Leave 1 milliNEAR liquid.
    set_balance(3_073_000_000_000_000_000_000_000);
    as_owner(0);
    let v = AgentSpendPolicy::new(
        owner(),
        token(),
        None,
        U128(STORAGE_DEPOSIT),
        U128(0),
        U128(0),
    );
    assert!(calls().is_empty());
    assert_eq!(v.get_config().owner_id, owner());
    assert_eq!(event_names(), vec!["vault_initialized"]);
}

// -- agent keys -----------------------------------------------------------------------------------

#[test]
fn add_agent_key_creates_a_restricted_function_call_key_on_the_vault() {
    begin();
    let mut v = AgentSpendPolicy::new(
        owner(),
        token(),
        None,
        U128(STORAGE_DEPOSIT),
        U128(0),
        U128(0),
    );
    as_owner_yocto();
    v.add_agent_key(
        key(5),
        "shopping bot".to_owned(),
        U64(T0_S + DAY_S),
        U128(ALLOWANCE),
    )
    .detach();

    let added = added_keys();
    assert_eq!(added.len(), 1);
    let k = &added[0];
    assert_eq!(k.account, vault(), "the key lives on the vault account");
    assert_eq!(k.receiver, vault(), "and may only call the vault");
    assert_eq!(k.methods, vec!["pay", "request_payment", "record_refusal"]);
    assert_eq!(AGENT_METHODS, "pay,request_payment,record_refusal");
    assert_eq!(k.allowance, Some(NearToken::from_yoctonear(ALLOWANCE)));
    assert_eq!(k.public_key, key(5).to_string());

    let calls = calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].receiver, vault());
    assert_eq!(calls[0].method, "on_agent_key_added");
    assert_eq!(calls[0].args["public_key"], key(5).to_string());
    assert_eq!(calls[0].gas, GAS_ON_KEY_ADDED);

    let e = event("agent_key_added");
    assert_eq!(e["public_key"], key(5).to_string());
    assert_eq!(e["label"], "shopping bot");
    assert_eq!(e["expires_at_s"], (T0_S + DAY_S).to_string());
    assert_eq!(e["allowance"], ALLOWANCE.to_string());

    let view = v.get_agent(key(5)).unwrap();
    assert_eq!(view.label, "shopping bot");
    assert_eq!(view.expires_at_s, U64(T0_S + DAY_S));
    assert!(!view.revoked);
    assert_eq!(view.added_at_s, U64(T0_S));
}

#[test]
fn a_zero_allowance_is_refused_not_made_unlimited() {
    let mut v = plain_vault();
    as_owner_yocto();
    assert_panics_with("InvalidAmount", || {
        let _ = v.add_agent_key(key(5), "l".to_owned(), U64(0), U128(0));
    });
}

#[test]
fn the_label_is_bounded() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.add_agent_key(key(5), text(64), U64(0), U128(1)).detach();
    as_owner_yocto();
    assert_panics_with("MemoTooLong", || {
        let _ = v.add_agent_key(key(6), text(65), U64(0), U128(1));
    });
}

#[test]
fn a_key_cannot_be_added_twice_even_after_revoke() {
    let mut v = plain_vault();
    as_owner_yocto();
    assert_panics_with("KeyExists", || {
        let _ = v.add_agent_key(agent(), "again".to_owned(), U64(0), U128(1));
    });
    as_owner_yocto();
    v.revoke_agent_key(agent());
    as_owner_yocto();
    assert_panics_with("KeyExists", || {
        let _ = v.add_agent_key(agent(), "again".to_owned(), U64(0), U128(1));
    });
}

#[test]
fn key_records_are_bounded_and_revoked_ones_count_until_forgotten() {
    let mut v = plain_vault();
    for n in 2..=MAX_AGENT_KEYS as u8 {
        grant(&mut v, key(n));
    }
    assert_eq!(v.list_agents().len(), MAX_AGENT_KEYS as usize);
    as_owner_yocto();
    assert_panics_with("KeyLimitReached", || {
        let _ = v.add_agent_key(key(50), "sixth".to_owned(), U64(0), U128(1));
    });
    as_owner_yocto();
    v.revoke_agent_key(key(2));
    as_owner_yocto();
    assert_panics_with("KeyLimitReached", || {
        let _ = v.add_agent_key(key(50), "sixth".to_owned(), U64(0), U128(1));
    });
    as_owner_yocto();
    v.forget_agent_key(key(2));
    grant(&mut v, key(50));
    assert_eq!(v.list_agents().len(), MAX_AGENT_KEYS as usize);
}

#[test]
fn revoke_marks_the_record_and_deletes_the_access_key() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.revoke_agent_key(agent());
    assert!(v.get_agent(agent()).unwrap().revoked);
    assert_eq!(deleted_keys(), vec![(vault(), agent().to_string())]);
    assert_eq!(
        event("agent_key_revoked")["public_key"],
        agent().to_string()
    );
    // Refused immediately, before the delete has landed.
    as_agent();
    assert_panics_with("NotAgent", || {
        let _ = v.pay(shop(), U128(1), None);
    });
}

/// Finding AUTH-3: a revoked key's requests do not outlive it. They are dropped in the revoking
/// receipt, each with `held_rejected`, so a leaked key's crafted requests neither keep the
/// owner's queue full nor wait there to be approved by mistake. Another key's are untouched.
#[test]
fn revoking_a_key_drops_its_held_payments_and_only_its_own() {
    let mut v = plain_vault();
    grant(&mut v, key(2));
    as_agent();
    let a1 = value(v.request_payment(shop(), U128(500), None, "why".to_owned()))
        .held_id
        .unwrap();
    as_agent();
    let a2 = value(v.pay(newcomer(), U128(5), None)).held_id.unwrap();
    as_agent_key(key(2));
    let b1 = value(v.request_payment(shop(), U128(7), None, "why".to_owned()))
        .held_id
        .unwrap();
    assert_eq!(v.list_held(None, None).len(), 3);

    as_owner_yocto();
    v.revoke_agent_key(agent());
    let rejected: Vec<String> = events()
        .iter()
        .filter(|e| e["event"] == "held_rejected")
        .map(|e| e["data"]["held_id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(rejected, vec![a1.0.to_string(), a2.0.to_string()]);
    assert_eq!(
        event_names().first().map(String::as_str),
        Some("agent_key_revoked")
    );
    let left: Vec<U64> = v.list_held(None, None).iter().map(|h| h.id).collect();
    assert_eq!(left, vec![b1]);
    assert_eq!(v.get_held(b1).unwrap().agent_pk, key(2));

    // What the revoked key asked for is gone; the owner cannot approve it by mistake.
    as_owner_yocto();
    assert_panics_with("HeldNotFound", || {
        let _ = v.owner_pay(a1);
    });
    // Revoking again finds nothing left to drop.
    as_owner_yocto();
    v.revoke_agent_key(agent());
    assert!(!event_names().iter().any(|n| n == "held_rejected"));
    assert_eq!(v.list_held(None, None).len(), 1);
}

#[test]
fn revoking_again_reissues_the_delete() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.revoke_agent_key(agent());
    as_owner_yocto();
    v.revoke_agent_key(agent());
    assert_eq!(deleted_keys().len(), 1);
    assert!(v.get_agent(agent()).unwrap().revoked);
}

#[test]
fn revoke_and_forget_need_an_existing_record() {
    let mut v = plain_vault();
    as_owner_yocto();
    assert_panics_with("KeyNotFound", || v.revoke_agent_key(key(42)));
    as_owner_yocto();
    assert_panics_with("KeyNotFound", || v.forget_agent_key(key(42)));
    as_owner_yocto();
    assert_panics_with("KeyNotFound", || v.set_agent_expiry(key(42), U64(1)));
}

#[test]
fn a_live_key_cannot_be_forgotten() {
    let mut v = plain_vault();
    as_owner_yocto();
    assert_panics_with("KeyNotRevoked", || v.forget_agent_key(agent()));
    as_owner_yocto();
    v.revoke_agent_key(agent());
    as_owner_yocto();
    v.forget_agent_key(agent());
    assert!(v.get_agent(agent()).is_none());
}

#[test]
fn set_agent_expiry_updates_the_record() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_agent_expiry(agent(), U64(T0_S - 1));
    assert_eq!(v.get_agent(agent()).unwrap().expires_at_s, U64(T0_S - 1));
    let e = event("agent_expiry_set");
    assert_eq!(e["public_key"], agent().to_string());
    assert_eq!(e["expires_at_s"], (T0_S - 1).to_string());
    as_agent();
    let out = value(v.pay(shop(), U128(1), None));
    assert_refused(&out, "SessionKeyExpired");
}

// -- policy -----------------------------------------------------------------------------------------

#[test]
fn set_policy_updates_and_announces() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_policy(U128(5_000), U128(0), true);
    let c = v.get_config();
    assert_eq!(c.daily_cap, U128(5_000));
    assert_eq!(c.auto_approve_max, U128(0));
    assert!(c.allowlist_enabled);
    let e = event("policy_updated");
    assert_eq!(e["daily_cap"], "5000");
    assert_eq!(e["auto_approve_max"], "0");
    assert_eq!(e["allowlist_enabled"], true);
}

#[test]
fn allowlist_add_remove_and_bound() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_allowed(shop(), true);
    assert!(v.is_allowed(shop()));
    let e = event("allowlist_set");
    assert_eq!(e["payee"], shop().as_str());
    assert_eq!(e["ok"], true);
    as_owner_yocto();
    v.set_allowed(shop(), false);
    assert!(!v.is_allowed(shop()));
    assert_eq!(event("allowlist_set")["ok"], false);

    // Fill the list to its bound, counting what `fresh_vault` already listed.
    let listed = u32::try_from(v.list_allowlist(None, None).len()).unwrap();
    for n in 0..MAX_ALLOWLIST - listed {
        as_owner_yocto();
        v.set_allowed(format!("payee-{n}.testnet").parse().unwrap(), true);
    }
    assert_eq!(v.list_allowlist(None, None).len(), MAX_ALLOWLIST as usize);
    as_owner_yocto();
    assert_panics_with("AllowlistFull", || v.set_allowed(shop(), true));
    // Re-adding a payee already on the list is not growth.
    as_owner_yocto();
    v.set_allowed("payee-0.testnet".parse().unwrap(), true);
    // Removing one makes room.
    as_owner_yocto();
    v.set_allowed("payee-0.testnet".parse().unwrap(), false);
    as_owner_yocto();
    v.set_allowed(shop(), true);
    assert!(v.is_allowed(shop()));
}

#[test]
fn set_registry_switches_and_announces() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.set_registry(Some(registry()));
    assert_eq!(v.get_config().registry_id, Some(registry()));
    assert_eq!(event("registry_set")["registry_id"], registry().as_str());
    as_owner_yocto();
    v.set_registry(None);
    assert_eq!(v.get_config().registry_id, None);
    assert!(event("registry_set")["registry_id"].is_null());
}

#[test]
fn freeze_and_unfreeze_announce() {
    let mut v = plain_vault();
    as_owner(0);
    v.freeze();
    assert_eq!(event("frozen_set")["frozen"], true);
    as_owner_yocto();
    v.unfreeze();
    assert_eq!(event("frozen_set")["frozen"], false);
}

// -- held payments ----------------------------------------------------------------------------------

#[test]
fn owner_reject_removes_and_announces() {
    let (mut v, held_id) = vault_with_held();
    as_owner_yocto();
    v.owner_reject(U64(held_id));
    assert!(v.get_held(U64(held_id)).is_none());
    assert_eq!(event("held_rejected")["held_id"], held_id.to_string());
    as_owner_yocto();
    assert_panics_with("HeldNotFound", || v.owner_reject(U64(held_id)));
}

#[test]
fn owner_pay_unknown_id_is_not_found() {
    let mut v = plain_vault();
    as_owner_yocto();
    assert_panics_with("HeldNotFound", || {
        let _ = v.owner_pay(U64(77));
    });
}

#[test]
fn owner_pay_settles_a_held_payment_outside_the_policy_but_counts_it() {
    let (mut v, held_id) = vault_with_held();
    // Make every agent gate fail: frozen, expired key, allowlist on without the payee, cap and
    // ceiling far below the amount.
    as_owner(0);
    v.freeze();
    as_owner_yocto();
    v.set_policy(U128(10), U128(1), true);
    as_owner_yocto();
    v.set_agent_expiry(agent(), U64(1));

    as_owner_yocto();
    promise(v.owner_pay(U64(held_id)));
    assert!(
        v.get_held(U64(held_id)).is_none(),
        "removed when the pipeline starts"
    );
    assert_eq!(v.spent_today(), U128(500), "counted, past the cap");

    let calls = calls();
    assert_eq!(
        calls.iter().map(|c| c.method.as_str()).collect::<Vec<_>>(),
        vec!["storage_deposit", "ft_transfer", "on_transfer"]
    );
    assert_eq!(calls[1].args["receiver_id"], shop().as_str());
    assert_eq!(calls[1].args["amount"], "500");
    assert_eq!(calls[1].args["memo"], "inv-7");
    let ctx = scheduled_ctx("on_transfer");
    assert_eq!(ctx.mode, crate::PayMode::OwnerPay);
    assert_eq!(ctx.held_id, Some(U64(held_id)));
}

#[test]
fn owner_pay_keeps_the_payment_id_of_the_request() {
    let mut v = plain_vault();
    as_agent();
    let requested = value(v.request_payment(shop(), U128(500), None, "why".to_owned()));
    let held_id = requested.held_id.unwrap();
    as_owner_yocto();
    promise(v.owner_pay(held_id));
    assert_eq!(
        scheduled_ctx("on_transfer").payment_id,
        requested.payment_id
    );
}

#[test]
fn owner_pay_still_asks_the_registry() {
    let mut v = registry_vault();
    as_agent();
    promise(v.request_payment(shop(), U128(500), None, "why".to_owned()));
    let ctx = scheduled_ctx("on_verdict");
    as_callback(vec![ok_json("null")]);
    let held_id = value(v.on_verdict(ctx)).held_id.unwrap();

    as_owner_yocto();
    promise(v.owner_pay(held_id));
    let calls = calls();
    assert_eq!(calls[0].receiver, registry());
    assert_eq!(calls[0].method, "get_verdict");
    assert_eq!(calls[0].args["account_id"], shop().as_str());
    assert_eq!(calls[0].gas, GAS_REGISTRY_VIEW);
    assert_eq!(calls[1].method, "on_verdict");
    assert_eq!(calls[1].gas, GAS_ON_VERDICT);
    assert_eq!(scheduled_ctx("on_verdict").mode, crate::PayMode::OwnerPay);
}

#[test]
fn owner_pay_on_an_expired_entry_removes_it_and_says_so() {
    let (mut v, held_id) = vault_with_held();
    advance_s(crate::HELD_TTL_S + 1);
    as_owner_yocto();
    let out = value(v.owner_pay(U64(held_id)));
    assert_refused(&out, "HeldExpired");
    assert_eq!(out.held_id, Some(U64(held_id)));
    assert!(v.get_held(U64(held_id)).is_none());
    assert_eq!(event("held_expired")["held_id"], held_id.to_string());
    assert_eq!(event("payment_refused")["reason"], "HeldExpired");
    assert!(calls().is_empty());
    assert_eq!(v.spent_today(), U128(0));
}

#[test]
fn owner_pay_at_the_last_valid_second_still_settles() {
    let (mut v, held_id) = vault_with_held();
    advance_s(crate::HELD_TTL_S);
    as_owner_yocto();
    promise(v.owner_pay(U64(held_id)));
}

#[test]
fn owner_pay_overflow_is_refused_and_the_entry_kept() {
    let mut v = fresh_vault(None, 0, 0);
    // A no-cap, no-ceiling vault lets the agent reserve close to the top of u128.
    as_agent();
    promise(v.pay(shop(), U128(u128::MAX - 10), None));
    as_agent();
    let held_id = value(v.request_payment(other_shop(), U128(500), None, "why".to_owned()))
        .held_id
        .unwrap();
    as_owner_yocto();
    let out = value(v.owner_pay(held_id));
    assert_refused(&out, "MathOverflow");
    assert!(
        v.get_held(held_id).is_some(),
        "nothing started, so the entry stays"
    );
}

// -- funds ------------------------------------------------------------------------------------------

#[test]
fn withdraw_goes_only_to_the_owner_and_reports_back() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.withdraw(U128(250)).detach();
    let calls = calls();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].receiver, token());
    assert_eq!(calls[0].method, "ft_transfer");
    assert_eq!(calls[0].args["receiver_id"], owner().as_str());
    assert_eq!(calls[0].args["amount"], "250");
    assert_eq!(calls[0].deposit, NearToken::from_yoctonear(1));
    assert_eq!(calls[0].gas, GAS_FT_TRANSFER);
    assert_eq!(calls[0].weight, 0);
    assert_eq!(calls[1].receiver, vault());
    assert_eq!(calls[1].method, "on_withdraw");
    assert_eq!(calls[1].gas, GAS_ON_WITHDRAW);
    assert_eq!(v.spent_today(), U128(0), "a withdrawal is not agent spend");
}

#[test]
fn withdraw_zero_is_invalid() {
    let mut v = plain_vault();
    as_owner_yocto();
    assert_panics_with("InvalidAmount", || {
        let _ = v.withdraw(U128(0));
    });
}

#[test]
fn deposits_from_the_token_are_kept_and_announced() {
    let mut v = plain_vault();
    env_as(token(), key(9), 0, vec![]);
    let kept = value(v.ft_on_transfer(owner(), U128(1_000), String::new()));
    assert_eq!(kept, U128(0));
    let e = event("deposited");
    assert_eq!(e["sender_id"], owner().as_str());
    assert_eq!(e["amount"], "1000");
}

#[test]
fn a_foreign_token_is_refunded_in_full_and_silently() {
    let mut v = plain_vault();
    env_as("fake-usdc.testnet".parse().unwrap(), key(9), 0, vec![]);
    let refund = value(v.ft_on_transfer(owner(), U128(1_000), "deposit".to_owned()));
    assert_eq!(refund, U128(1_000));
    assert!(events().is_empty());
}

//! Who may call what: agent authentication, the owner check, the one-yocto rule, the init
//! guards, and the callbacks' own guard.

use near_sdk::json_types::{U64, U128};

use super::*;
use crate::{AgentSpendPolicy, PayMode, PaymentCtx};

// -- the agent ---------------------------------------------------------------------------------

#[test]
fn agent_key_signing_as_the_vault_is_authenticated() {
    let mut v = plain_vault();
    as_agent();
    promise(v.pay(shop(), U128(10), None));
}

#[test]
fn registered_key_forwarded_through_another_account_is_not_an_agent() {
    // The signer's key survives every hop of a call chain. A contract the key holder was lured
    // into calling arrives with the agent's signer key but its own account as predecessor.
    let mut v = plain_vault();
    env_as(stranger(), agent(), 0, vec![]);
    assert_panics_with("NotAgent", || {
        let _ = v.pay(shop(), U128(10), None);
    });
}

#[test]
fn unknown_key_on_the_vault_account_is_not_an_agent() {
    let mut v = plain_vault();
    as_agent_key(key(42));
    assert_panics_with("NotAgent", || {
        let _ = v.pay(shop(), U128(10), None);
    });
}

#[test]
fn revoked_key_is_not_an_agent_on_any_agent_method() {
    let mut v = plain_vault();
    as_owner_yocto();
    v.revoke_agent_key(agent());
    as_agent();
    assert_panics_with("NotAgent", || {
        let _ = v.pay(shop(), U128(10), None);
    });
    as_agent();
    assert_panics_with("NotAgent", || {
        let _ = v.request_payment(shop(), U128(10), None, "why".to_owned());
    });
    as_agent();
    assert_panics_with("NotAgent", || {
        let _ = v.record_refusal(shop(), U128(10), "guard".to_owned());
    });
}

#[test]
fn outsiders_cannot_call_agent_methods() {
    let mut v = plain_vault();
    as_stranger();
    assert_panics_with("NotAgent", || {
        let _ = v.request_payment(shop(), U128(10), None, "why".to_owned());
    });
    as_owner(0);
    assert_panics_with("NotAgent", || {
        let _ = v.record_refusal(shop(), U128(10), "guard".to_owned());
    });
}

#[test]
fn an_unauthenticated_call_writes_nothing_and_logs_nothing() {
    let mut v = plain_vault();
    as_stranger();
    let _ = panic_text(|| {
        let _ = v.pay(shop(), U128(10), None);
    });
    assert!(events().is_empty());
    assert!(calls().is_empty());
    assert_eq!(v.spent_today(), U128(0));
}

// -- the owner -----------------------------------------------------------------------------------

/// An owner method's name and a call to it.
type OwnerMethod = (&'static str, Box<dyn Fn(&mut AgentSpendPolicy)>);

/// Every owner method that must require exactly one yoctoNEAR, as a closure over the vault.
fn owner_methods() -> Vec<OwnerMethod> {
    vec![
        (
            "add_agent_key",
            Box::new(|v| {
                let _ = v.add_agent_key(key(7), "l".to_owned(), U64(0), U128(1));
            }),
        ),
        (
            "revoke_agent_key",
            Box::new(|v| v.revoke_agent_key(agent())),
        ),
        (
            "forget_agent_key",
            Box::new(|v| v.forget_agent_key(agent())),
        ),
        (
            "set_agent_expiry",
            Box::new(|v| v.set_agent_expiry(agent(), U64(1))),
        ),
        (
            "set_policy",
            Box::new(|v| v.set_policy(U128(1), U128(1), true)),
        ),
        ("set_allowed", Box::new(|v| v.set_allowed(shop(), true))),
        ("set_registry", Box::new(|v| v.set_registry(None))),
        ("set_hold_unknown", Box::new(|v| v.set_hold_unknown(false))),
        ("unfreeze", Box::new(|v| v.unfreeze())),
        (
            "owner_pay",
            Box::new(|v| {
                let _ = v.owner_pay(U64(1));
            }),
        ),
        ("owner_reject", Box::new(|v| v.owner_reject(U64(1)))),
        (
            "withdraw",
            Box::new(|v| {
                let _ = v.withdraw(U128(1));
            }),
        ),
    ]
}

#[test]
fn every_owner_method_refuses_a_non_owner() {
    let mut v = plain_vault();
    for (name, method) in owner_methods() {
        env_as(stranger(), key(99), 1, vec![]);
        let text = panic_text(|| method(&mut v));
        assert!(text.contains("panic_msg: \"NotOwner\""), "{name}: {text}");
    }
    // The two that need no yocto check the owner too.
    as_stranger();
    assert_panics_with("NotOwner", || v.freeze());
    as_stranger();
    assert_panics_with("NotOwner", || {
        let _ = v.register_with_token();
    });
}

#[test]
fn the_agent_key_cannot_reach_an_owner_method() {
    // The protocol already forbids it (method names); the contract refuses it anyway.
    let mut v = plain_vault();
    as_agent();
    assert_panics_with("NotOwner", || v.freeze());
}

#[test]
fn every_sensitive_owner_method_requires_exactly_one_yocto() {
    let mut v = plain_vault();
    for deposit in [0u128, 2, 1_000_000_000_000_000_000_000_000] {
        for (name, method) in owner_methods() {
            as_owner(deposit);
            let text = panic_text(|| method(&mut v));
            assert!(
                text.contains("panic_msg: \"RequiresOneYocto\""),
                "{name} with {deposit} yocto: {text}"
            );
        }
    }
}

#[test]
fn freeze_needs_no_yocto_and_unfreeze_does() {
    let mut v = plain_vault();
    as_owner(0);
    v.freeze();
    assert!(v.get_config().frozen);
    as_owner(0);
    assert_panics_with("RequiresOneYocto", || v.unfreeze());
    as_owner_yocto();
    v.unfreeze();
    assert!(!v.get_config().frozen);
}

#[test]
fn register_with_token_needs_no_yocto() {
    let mut v = plain_vault();
    as_owner(0);
    v.register_with_token().detach();
    assert_eq!(call_names(), vec!["storage_deposit"]);
}

// -- init -----------------------------------------------------------------------------------------

#[test]
fn a_vault_cannot_own_itself() {
    begin();
    assert_panics_with("OwnerIsVault", || {
        let _ = AgentSpendPolicy::new(
            vault(),
            token(),
            None,
            U128(STORAGE_DEPOSIT),
            U128(0),
            U128(0),
        );
    });
}

#[test]
fn the_token_cannot_be_the_vault() {
    begin();
    assert_panics_with("InvalidPayee", || {
        let _ = AgentSpendPolicy::new(
            owner(),
            vault(),
            None,
            U128(STORAGE_DEPOSIT),
            U128(0),
            U128(0),
        );
    });
}

// -- callbacks ------------------------------------------------------------------------------------

fn some_ctx() -> PaymentCtx {
    PaymentCtx {
        payment_id: U64(1),
        mode: PayMode::Pay,
        agent_pk: agent(),
        payee: shop(),
        amount: U128(10),
        memo: None,
        day: U64(T0_DAY),
        reason: None,
        held_id: None,
    }
}

#[test]
fn a_direct_call_to_a_callback_is_refused() {
    // The agent's key signs as the vault, so it passes `#[private]`. It has no promise result.
    let mut v = plain_vault();
    as_agent();
    assert_panics_with("NotCallback", || {
        let _ = v.on_verdict(some_ctx());
    });
    as_agent();
    assert_panics_with("NotCallback", || {
        let _ = v.on_transfer(some_ctx());
    });
    as_agent();
    assert_panics_with("NotCallback", || {
        let _ = v.on_agent_key_added(agent(), U64(1));
    });
    as_agent();
    assert_panics_with("NotCallback", || {
        let _ = v.on_withdraw(U128(1));
    });
}

#[test]
fn a_callback_from_another_account_is_refused() {
    let mut v = plain_vault();
    env_as(stranger(), key(99), 0, vec![ok_json("null")]);
    assert_panics_with("NotCallback", || {
        let _ = v.on_verdict(some_ctx());
    });
}

#[test]
fn a_callback_with_two_results_is_refused() {
    let mut v = plain_vault();
    as_callback(vec![ok_json("null"), ok_json("null")]);
    assert_panics_with("NotCallback", || {
        let _ = v.on_transfer(some_ctx());
    });
}

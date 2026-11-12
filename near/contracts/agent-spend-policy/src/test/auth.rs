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

/// The registered agent key, signing for an account that is not the vault. A public key can be
/// an access key on any number of accounts, and a thief who holds the leaked agent key holds it
/// with full access on the key's implicit account, which anyone can create with a transfer. A
/// transaction such an account signs and sends to the vault directly arrives with that account
/// as both signer and predecessor, and the agent key as `signer_account_pk`, so the key check
/// alone would pass. Both account checks refuse it, so this test stays green with either one
/// deleted: what each check alone stops is pinned by its own test, the predecessor check by
/// `a_contract_forwarding_the_agent_keys_transaction_is_not_an_agent` and the signer check by
/// `a_delegate_action_relayed_by_another_account_is_not_an_agent`.
#[test]
fn a_registered_key_signing_for_another_account_is_not_an_agent() {
    let mut v = plain_vault();
    for account in [implicit_account_of(&agent()), stranger()] {
        env_as(account.clone(), agent(), 0, vec![]);
        assert_panics_with("NotAgent", || {
            let _ = v.pay(shop(), U128(10), None);
        });
        assert!(
            events().is_empty(),
            "{account}: a refused call logs nothing"
        );
        env_as(account.clone(), agent(), 0, vec![]);
        assert_panics_with("NotAgent", || {
            let _ = v.record_refusal(newcomer(), U128(1), "guard_deny".to_owned());
        });
    }
}

/// The agent key's own transaction, as a contract further along its call chain sees it. The key
/// can only sign calls to the vault, so the forwarder is something the vault itself calls: its
/// token in the middle of `ft_transfer`, its registry in the middle of `get_verdict`, or a
/// contract one of them calls. The signer account and the signer's key are the vault's and the
/// agent's, exactly as in the agent's own call, so only the predecessor tells them apart.
#[test]
fn a_contract_forwarding_the_agent_keys_transaction_is_not_an_agent() {
    let mut v = registry_vault();
    for forwarder in [token(), registry(), stranger()] {
        forwarded_by(&forwarder, agent());
        assert_panics_with("NotAgent", || {
            let _ = v.pay(shop(), U128(10), None);
        });
        assert!(
            events().is_empty(),
            "{forwarder}: a refused call logs nothing"
        );
        assert!(calls().is_empty(), "{forwarder}: and schedules nothing");
        forwarded_by(&forwarder, agent());
        assert_panics_with("NotAgent", || {
            let _ = v.request_payment(shop(), U128(10), None, "why".to_owned());
        });
        forwarded_by(&forwarder, agent());
        assert_panics_with("NotAgent", || {
            let _ = v.record_refusal(newcomer(), U128(1), "guard_deny".to_owned());
        });
    }
    assert_eq!(v.spent_today(), U128(0));
    assert_eq!(v.guard_refusal_count(newcomer()), 0);
    assert!(v.list_held(None, None).is_empty());

    // The same key, in the transaction it signed itself, is the agent.
    as_agent();
    promise(v.pay(shop(), U128(10), None));
}

/// A receipt on the vault from `forwarder`, inside a transaction the vault account signed with
/// `pk`. (`env_as` makes the signer the predecessor, which is a different case: an account that
/// is not the vault signing for itself, which both account checks refuse; see
/// `a_registered_key_signing_for_another_account_is_not_an_agent`.)
fn forwarded_by(forwarder: &AccountId, pk: PublicKey) {
    let context = VMContextBuilder::new()
        .current_account_id(vault())
        .signer_account_id(vault())
        .signer_account_pk(pk)
        .predecessor_account_id(forwarder.clone())
        .account_balance(NearToken::from_yoctonear(DEFAULT_BALANCE))
        .block_timestamp(now_ns())
        .prepaid_gas(MAX_PREPAID_GAS)
        .build();
    testing_env!(
        context,
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![]
    );
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

/// A NEP-366 delegate action the agent key signed, relayed by the key's own implicit account
/// (where a thief who holds the leaked key has it as a full-access key). The inner receipt has
/// the vault as predecessor and the agent key as `signer_account_pk`, so the first and the last
/// check pass; only the signer account tells it apart. Accepted, it would let the key act with
/// no charge to its allowance, so the allowance would stop bounding what it can make the vault
/// store.
#[test]
fn a_delegate_action_relayed_by_another_account_is_not_an_agent() {
    let mut v = plain_vault();
    let thief = implicit_account_of(&agent());
    assert_eq!(thief.as_str(), "01".repeat(32));

    as_relayed(thief.clone(), agent());
    assert_panics_with("NotAgent", || {
        let _ = v.record_refusal(newcomer(), U128(1), "guard_deny".to_owned());
    });
    assert!(events().is_empty(), "a refused relay logs nothing");
    as_relayed(thief.clone(), agent());
    assert_panics_with("NotAgent", || {
        let _ = v.pay(shop(), U128(10), None);
    });
    assert!(events().is_empty());
    assert!(calls().is_empty(), "and schedules nothing");
    as_relayed(thief, agent());
    assert_panics_with("NotAgent", || {
        let _ = v.request_payment(newcomer(), U128(10), None, "why".to_owned());
    });
    assert!(events().is_empty());

    // A relayer that is any other account is the same case.
    as_relayed(stranger(), agent());
    assert_panics_with("NotAgent", || {
        let _ = v.record_refusal(newcomer(), U128(1), "guard_deny".to_owned());
    });

    assert_eq!(v.guard_refusal_count(newcomer()), 0);
    assert_eq!(v.guard_refusal_payees(), 0);
    assert_eq!(v.spent_today(), U128(0));
    assert!(v.list_held(None, None).is_empty());

    // The same key, signing directly as the vault, is the agent.
    as_agent();
    assert_refused(
        &v.record_refusal(newcomer(), U128(1), "guard_deny".to_owned()),
        "guard_deny",
    );
    assert_eq!(v.guard_refusal_count(newcomer()), 1);
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
        (
            "forget_guard_refusals",
            Box::new(|v| v.forget_guard_refusals(vec![shop()])),
        ),
        (
            "forget_refusals",
            Box::new(|v| v.forget_refusals(vec![shop()])),
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

/// `new` is `#[init]` but has no `#[private]`: the batch that creates `vault.<parent>` comes
/// from the parent. So it admits the vault account itself and its parent, and nobody else. A
/// deploy that went out without its init would otherwise be the first stranger's to claim.
#[test]
fn only_the_vault_account_or_its_parent_may_initialize_it() {
    let init = || {
        let _ = AgentSpendPolicy::new(
            owner(),
            token(),
            None,
            U128(STORAGE_DEPOSIT),
            U128(0),
            U128(0),
        );
    };
    for (caller, who) in [
        (stranger(), "a stranger"),
        ("testnet".parse().unwrap(), "the parent's parent"),
        ("other.owner.testnet".parse().unwrap(), "a sibling"),
        (
            "x.vault.owner.testnet".parse().unwrap(),
            "a sub-account of the vault",
        ),
        (
            "ner.testnet".parse().unwrap(),
            "a suffix that is not the parent",
        ),
    ] {
        begin();
        env_as(caller, key(99), 0, vec![]);
        let text = panic_text(init);
        assert!(
            text.contains("panic_msg: \"InitNotAllowed\""),
            "{who}: {text}"
        );
        assert!(events().is_empty(), "{who}: nothing logged");
    }

    // The parent that creates `vault.owner.testnet` in the same batch (also the owner here).
    begin();
    let v = AgentSpendPolicy::new(
        owner(),
        token(),
        None,
        U128(STORAGE_DEPOSIT),
        U128(0),
        U128(0),
    );
    assert_eq!(v.get_config().owner_id, owner());

    // The vault account itself, as in a self-deploy, may name any other account as owner.
    begin();
    env_as(vault(), owner_key(), 0, vec![]);
    let v = AgentSpendPolicy::new(
        stranger(),
        token(),
        None,
        U128(STORAGE_DEPOSIT),
        U128(0),
        U128(0),
    );
    assert_eq!(v.get_config().owner_id, stranger());
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

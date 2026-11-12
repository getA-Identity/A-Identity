//! The agent's key, checked against the protocol rather than against the contract's word.
//!
//! The vault's security rests on one access key it creates on its own account: receiver =
//! the vault, methods = exactly `pay`, `request_payment`, `record_refusal`, a bounded gas
//! allowance, and never a deposit. These tests read that key back from the chain, then try
//! every other thing a stolen copy of it could be used for, and expect the PROTOCOL to say
//! no, by the name of the rule, before the vault's code is even reached. Where the contract
//! is what refuses (an unknown signer, a direct callback), the test says so by name too.

mod common;

use common::*;
use near_api::types::Action;
use near_api::types::transaction::actions::{
    AccessKeyPermission, DeleteAccountAction, DeployContractAction, FunctionCallAction,
};
use near_api::{NearGas, NearToken};
use near_sdk::serde_json::{self, json};

// ---------------------------------------------------------------------------------------
// What add_agent_key creates
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn add_agent_key_creates_a_function_call_key_for_exactly_three_methods_on_the_vault() {
    let w = World::new(Setup::default()).await;

    let key = w
        .access_key(&w.vault, &w.agent_pk)
        .await
        .expect("the agent key is on the vault account");
    let permission = function_call_permission(&key);
    assert_eq!(permission.receiver_id, w.vault.as_str());
    assert_eq!(sorted(&permission.method_names), agent_methods_sorted());
    assert_eq!(
        permission.allowance,
        Some(AGENT_ALLOWANCE),
        "exactly the allowance the owner granted, never an unlimited one"
    );
    // The account holds the harness's own key (a sandbox artifact, see common/mod.rs) and
    // the agent's. The vault added nothing else.
    let keys = w.access_keys(&w.vault).await;
    assert_eq!(keys.len(), 2, "{keys:?}");
    assert!(keys.iter().any(|(pk, _)| *pk == genesis_public_key()));

    let record = w
        .agent_record(&w.agent_pk)
        .await
        .expect("the vault's record");
    assert_eq!(record.label, "sandbox-agent");
    assert!(!record.revoked);
    assert_eq!(record.expires_at_s.0, 0);
    let now = w.chain_time_s().await;
    assert!(
        record.added_at_s.0 <= now && record.added_at_s.0 + 600 > now,
        "added_at_s {} is not the time of the add (now {now})",
        record.added_at_s.0
    );

    let added = the_event(&w.setup_events, VAULT_STANDARD, "agent_key_added");
    assert_eq!(str_field(&added, "public_key"), w.agent_pk.to_string());
    assert_eq!(str_field(&added, "label"), "sandbox-agent");
    assert_eq!(
        num_field(&added, "allowance"),
        AGENT_ALLOWANCE.as_yoctonear()
    );
    assert_eq!(num_field(&added, "expires_at_s"), 0);
    assert_decimal_string(&added, "allowance");
    assert_decimal_string(&added, "expires_at_s");
}

#[tokio::test]
async fn only_the_owner_adds_keys_with_the_yocto_and_within_bounds() {
    let w = World::new(Setup::default()).await;
    let (_, other) = new_key();
    let args = agent_key_args(&other, "second", 0, AGENT_ALLOWANCE);

    w.call(&w.stranger, &w.vault, "add_agent_key", args.clone())
        .one_yocto()
        .send()
        .await
        .assert_panicked_with("NotOwner");
    w.owner_call_plain("add_agent_key", args)
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    // A zero allowance is refused rather than turned into an unlimited one: unlimited would
    // let a leaked key burn the vault's whole NEAR balance on gas.
    w.add_agent_key(&other, "second", 0, ZERO)
        .await
        .assert_panicked_with("InvalidAmount");
    // The same key twice.
    w.add_agent_key(&w.agent_pk, "again", 0, AGENT_ALLOWANCE)
        .await
        .assert_panicked_with("KeyExists");
    // A label is bounded like every free-text field the vault stores.
    w.add_agent_key(&other, &"x".repeat(65), 0, AGENT_ALLOWANCE)
        .await
        .assert_panicked_with("MemoTooLong");
    assert!(w.access_key(&w.vault, &other).await.is_none());
    assert!(w.agent_record(&other).await.is_none());

    // A key the vault has no record of cannot be revoked, re-timed or forgotten.
    w.revoke_agent_key(&other)
        .await
        .assert_panicked_with("KeyNotFound");
    w.set_agent_expiry(&other, 0)
        .await
        .assert_panicked_with("KeyNotFound");
    w.forget_agent_key(&other)
        .await
        .assert_panicked_with("KeyNotFound");

    // Every record is a real access key that can burn the vault's NEAR on gas, so there are
    // at most five. The protocol has no such limit; the vault does.
    let mut added = vec![w.agent_pk];
    while added.len() < 5 {
        let (_, extra) = new_key();
        w.add_agent_key(&extra, "extra", 0, NearToken::from_millinear(100))
            .await
            .assert_ok();
        added.push(extra);
    }
    w.add_agent_key(&other, "sixth", 0, AGENT_ALLOWANCE)
        .await
        .assert_panicked_with("KeyLimitReached");
    for key in &added {
        assert!(w.access_key(&w.vault, key).await.is_some());
    }
    assert!(w.access_key(&w.vault, &other).await.is_none());
    assert_eq!(
        w.access_keys(&w.vault).await.len(),
        6,
        "five agents and the harness key"
    );
}

/// The vault writes its record before the protocol adds the key, so that the key works the
/// moment it exists. If the add then fails, the callback must take the record back out, or
/// the vault's books would name an agent the chain never created. The key used here is one
/// the vault account already has (the sandbox's full-access key), which the protocol
/// refuses to add a second time.
#[tokio::test]
async fn a_key_the_protocol_refuses_to_add_leaves_no_record_behind() {
    let w = World::new(Setup::default()).await;
    let existing = genesis_public_key();

    let tx = w
        .add_agent_key(&existing, "collides", 0, AGENT_ALLOWANCE)
        .await
        .assert_ok();
    assert!(
        !tx.json::<bool>(),
        "the callback reports the failed add as false"
    );
    assert!(tx.failed_on(&w.vault), "the AddKey action itself failed");
    let failed = tx.vault_event("agent_key_add_failed");
    assert_eq!(str_field(&failed, "public_key"), existing.to_string());
    assert!(w.agent_record(&existing).await.is_none());
    let key = w
        .access_key(&w.vault, &existing)
        .await
        .expect("the existing key is untouched");
    assert!(matches!(key.permission, AccessKeyPermission::FullAccess));
}

// ---------------------------------------------------------------------------------------
// What the agent key cannot do
// ---------------------------------------------------------------------------------------

/// `#[private]` only checks that the caller is the vault account, and the agent's key signs
/// AS the vault account, so it is the key's method list that keeps the agent out of the
/// callbacks and the owner methods. Every one is tried here.
#[tokio::test]
async fn the_agent_key_cannot_call_an_owner_method_or_a_callback() {
    let w = World::new(Setup::default()).await;
    let (_, rogue) = new_key();
    let today = w.today().await;
    let ctx = json!({ "ctx": payment_ctx(&w.agent_pk, &w.attacker, 5 * UNIT, today) });

    let calls = [
        ("withdraw", json!({ "amount": "1" })),
        ("set_policy", policy_args(0, 0, false)),
        ("set_allowed", json!({ "payee": w.attacker, "ok": true })),
        ("set_registry", json!({ "registry_id": null })),
        ("freeze", json!({})),
        ("unfreeze", json!({})),
        (
            "add_agent_key",
            agent_key_args(&rogue, "rogue", 0, AGENT_ALLOWANCE),
        ),
        ("revoke_agent_key", json!({ "public_key": w.agent_pk })),
        ("forget_agent_key", json!({ "public_key": w.agent_pk })),
        (
            "set_agent_expiry",
            json!({ "public_key": w.agent_pk, "expires_at_s": "0" }),
        ),
        ("owner_pay", held_args(1)),
        ("owner_reject", held_args(1)),
        ("register_with_token", json!({})),
        (
            "ft_on_transfer",
            json!({ "sender_id": w.attacker, "amount": "1", "msg": "" }),
        ),
        ("on_verdict", ctx.clone()),
        ("on_transfer", ctx),
        (
            "on_agent_key_added",
            json!({ "public_key": rogue, "nonce": "1" }),
        ),
        ("on_withdraw", json!({ "amount": "1" })),
    ];
    for (method, args) in calls {
        assert_protocol_rejected(
            w.agent_call(method, args).try_send_raw().await,
            &["MethodNameMismatch"],
        );
    }

    let config = w.config().await;
    assert!(!config.frozen);
    assert_eq!(config.daily_cap.0, DEFAULT_DAILY_CAP);
    assert_eq!(config.registry_id.as_deref(), Some(w.registry.as_str()));
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND);
    assert!(w.agent_record(&rogue).await.is_none());
}

/// The protocol's four rules for a function-call key, applied to the agent's key: one
/// action, a function call, zero deposit, this receiver and these methods. Everything a
/// thief would want from a key on the vault account falls outside them.
#[tokio::test]
async fn the_agent_key_can_only_sign_one_zero_deposit_call_to_the_vault() {
    let w = World::new(Setup::default()).await;
    let agent = w.agent_signer.clone();
    let (_, rogue) = new_key();

    // A deposit, even one yocto: so the 1-yocto owner gate is unreachable from this key.
    assert_protocol_rejected(
        w.agent_call("pay", pay_args(&w.merchant, UNIT, None))
            .one_yocto()
            .try_send_raw()
            .await,
        &["DepositWithFunctionCall"],
    );

    // Another contract: the token's own transfer, with and without its 1 yocto.
    let steal = json!({ "receiver_id": w.attacker, "amount": UNIT.to_string() });
    assert_protocol_rejected(
        w.call(&w.vault, &w.token, "ft_transfer", steal.clone())
            .signed_with(agent.clone())
            .try_send_raw()
            .await,
        &["ReceiverMismatch"],
    );
    assert_protocol_rejected(
        w.call(&w.vault, &w.token, "ft_transfer", steal)
            .one_yocto()
            .signed_with(agent.clone())
            .try_send_raw()
            .await,
        &["DepositWithFunctionCall"],
    );

    // Two permitted calls batched into one transaction.
    let pay_action = || {
        Action::FunctionCall(Box::new(FunctionCallAction {
            method_name: "pay".to_owned(),
            args: serde_json::to_vec(&pay_args(&w.merchant, UNIT, None)).expect("serialize"),
            gas: NearGas::from_tgas(100),
            deposit: ZERO,
        }))
    };
    assert_protocol_rejected(
        w.send_actions_raw(
            &w.vault,
            &w.vault,
            vec![pay_action(), pay_action()],
            agent.clone(),
        )
        .await,
        &["RequiresFullAccess"],
    );

    // NEAR out of the vault account.
    assert_protocol_rejected(
        w.transfer_near(
            &w.vault,
            &w.attacker,
            NearToken::from_yoctonear(1),
            agent.clone(),
        )
        .await,
        &["RequiresFullAccess"],
    );
    // Keys: add a full-access key of its own, or delete another key.
    assert_protocol_rejected(
        w.add_key_directly(
            &w.vault,
            AccessKeyPermission::FullAccess,
            rogue,
            agent.clone(),
        )
        .await,
        &["RequiresFullAccess"],
    );
    assert_protocol_rejected(
        w.delete_key_directly(&w.vault, genesis_public_key(), agent.clone())
            .await,
        &["RequiresFullAccess"],
    );
    // The code, and the account itself.
    let deploy = Action::DeployContract(DeployContractAction {
        code: vec![0u8; 16],
    });
    assert_protocol_rejected(
        w.send_actions_raw(&w.vault, &w.vault, vec![deploy], agent.clone())
            .await,
        &["RequiresFullAccess"],
    );
    let delete = Action::DeleteAccount(DeleteAccountAction {
        beneficiary_id: w.attacker.clone(),
    });
    assert_protocol_rejected(
        w.send_actions_raw(&w.vault, &w.vault, vec![delete], agent)
            .await,
        &["RequiresFullAccess"],
    );

    // All of it was refused before execution: the chain is as it was.
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND);
    assert_eq!(w.ft_balance(&w.attacker).await, 0);
    assert!(w.has_contract(&w.vault).await);
    assert_eq!(w.access_keys(&w.vault).await.len(), 2);
    assert!(w.access_key(&w.vault, &rogue).await.is_none());
}

// ---------------------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_revoked_agent_key_cannot_sign_at_all() {
    let w = World::new(Setup::default()).await;
    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    // Something the key asked the owner for, still waiting when the key is revoked.
    let asked = w
        .request_payment(&w.merchant, 30 * UNIT, None, "above_ceiling")
        .await
        .assert_ok()
        .outcome()
        .assert_held();
    let nonce = w
        .access_key(&w.vault, &w.agent_pk)
        .await
        .expect("present before revoke")
        .nonce
        .0;

    // A live key's record cannot be dropped: revoke first.
    w.forget_agent_key(&w.agent_pk)
        .await
        .assert_panicked_with("KeyNotRevoked");
    w.call(
        &w.stranger,
        &w.vault,
        "revoke_agent_key",
        json!({ "public_key": w.agent_pk }),
    )
    .one_yocto()
    .send()
    .await
    .assert_panicked_with("NotOwner");

    let tx = w.revoke_agent_key(&w.agent_pk).await.assert_ok();
    assert_eq!(
        str_field(&tx.vault_event("agent_key_revoked"), "public_key"),
        w.agent_pk.to_string()
    );
    assert!(
        w.access_key(&w.vault, &w.agent_pk).await.is_none(),
        "revoke deleted the access key from the vault account"
    );
    // ...and dropped what it had asked for, in the same receipt: a revoked key's requests do
    // not keep the owner's queue full or wait there to be approved by mistake.
    assert_eq!(
        num_field(&tx.vault_event("held_rejected"), "held_id"),
        u128::from(asked)
    );
    assert!(w.held_ids().await.is_empty());
    assert_refused_or_panicked(&w.owner_pay(asked).await, "HeldNotFound");
    let record = w.agent_record(&w.agent_pk).await.expect("kept for audit");
    assert!(record.revoked);

    // The client cannot even find a nonce to sign with...
    assert_protocol_rejected(
        w.agent_call("pay", pay_args(&w.merchant, UNIT, None))
            .try_send()
            .await,
        &[&key_does_not_exist(&w.agent_pk), "UnknownAccessKey"],
    );
    // ...and bytes signed offline are refused by the protocol itself.
    assert_protocol_rejected(
        w.agent_call("pay", pay_args(&w.merchant, UNIT, None))
            .try_send_presigned(nonce + 10)
            .await,
        &["AccessKeyNotFound"],
    );
    assert_eq!(w.ft_balance(&w.merchant).await, UNIT);

    // A revoked record still blocks a re-add of the same key until the owner forgets it.
    w.add_agent_key(&w.agent_pk, "again", 0, AGENT_ALLOWANCE)
        .await
        .assert_panicked_with("KeyExists");
    w.forget_agent_key(&w.agent_pk).await.assert_ok();
    assert!(w.agent_record(&w.agent_pk).await.is_none());
}

#[tokio::test]
async fn revoking_one_agent_key_leaves_the_others_working() {
    let w = World::new(Setup::default()).await;
    let (secret, second_pk) = new_key();
    let second = signer_for(secret);
    w.add_agent_key(&second_pk, "second-agent", 0, AGENT_ALLOWANCE)
        .await
        .assert_ok();
    assert!(w.access_key(&w.vault, &second_pk).await.is_some());

    w.agent_call("pay", pay_args(&w.merchant, UNIT, None))
        .signed_with(second.clone())
        .send()
        .await
        .assert_ok()
        .outcome()
        .assert_sent();

    w.revoke_agent_key(&w.agent_pk).await.assert_ok();
    assert_protocol_rejected(
        w.agent_call("pay", pay_args(&w.merchant, UNIT, None))
            .try_send()
            .await,
        &[&key_does_not_exist(&w.agent_pk), "UnknownAccessKey"],
    );

    let tx = w
        .agent_call("pay", pay_args(&w.merchant, UNIT, None))
        .signed_with(second)
        .send()
        .await
        .assert_ok();
    tx.outcome().assert_sent();
    assert_eq!(w.ft_balance(&w.merchant).await, 2 * UNIT);
    assert!(w.agents_text().await.contains(&second_pk.to_string()));
}

// ---------------------------------------------------------------------------------------
// Callers that are not the agent
// ---------------------------------------------------------------------------------------

/// An agent is the vault account itself (the predecessor) signing with a registered key
/// (the signer's public key). Anything else is `NotAgent`, which panics, so it writes
/// nothing and logs nothing: an outsider cannot fill the vault's event log.
#[tokio::test]
async fn anyone_but_an_agent_key_signing_as_the_vault_is_not_an_agent() {
    let w = World::new(Setup::default()).await;
    let callers = [
        (w.stranger.clone(), "another account"),
        (
            w.owner.clone(),
            "the owner, who owns the vault but is not its agent",
        ),
        (
            w.vault.clone(),
            "the vault account with a key the vault never registered",
        ),
    ];
    for (caller, who) in &callers {
        let calls = [
            ("pay", pay_args(&w.merchant, UNIT, None)),
            (
                "request_payment",
                request_args(&w.merchant, UNIT, None, "asking"),
            ),
            (
                "record_refusal",
                refusal_args(&w.attacker, UNIT, "guard_deny"),
            ),
        ];
        for (method, args) in calls {
            let tx = w.call(caller, &w.vault, method, args).send().await;
            tx.assert_panicked_with("NotAgent");
            assert!(
                tx.vault_events().is_empty(),
                "{who}: {method} was refused but still logged"
            );
        }
    }
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(w.refusal_count(&w.attacker).await, 0);
    assert_eq!(w.guard_refusal_count(&w.attacker).await, 0);
    assert!(w.held_ids().await.is_empty());
    assert_eq!(w.spent_today().await, 0);
}

/// Finding AUTH-1. A thief with a leaked agent key does not need the key's allowance: a plain
/// transfer to the key's implicit account creates an account where the same public key has
/// full access, and from there the thief can relay a NEP-366 delegate action the key signed as
/// the vault. The protocol checks such an action against the key's method list and bumps its
/// nonce on the vault, but charges its allowance nothing, and the vault pays no gas. Accepted,
/// it would let the key create storage on the vault (guard counters, holds, registrations) at
/// the thief's gas price with no bound from the allowance. The inner receipt has the vault as
/// predecessor and the agent key as signer key, so only the signer ACCOUNT gives it away, and
/// the vault refuses it `NotAgent`: nothing written, nothing logged, the allowance untouched.
/// The outer transaction still reports success, so the refusal is read from the receipt.
#[tokio::test]
async fn a_delegate_action_relayed_from_the_agent_keys_own_account_is_refused() {
    let w = World::new(Setup::default()).await;
    let thief = implicit_account_of(&w.agent_pk);
    w.transfer_near(&w.stranger, &thief, NearToken::from_near(5), w.root.clone())
        .await
        .expect("a transfer creates the implicit account")
        .assert_ok();
    let thief_keys = w.access_keys(&thief).await;
    assert_eq!(thief_keys.len(), 1);
    assert_eq!(
        thief_keys[0].0, w.agent_pk,
        "the leaked key, with full access"
    );
    let as_thief = signer_for(w.agent_secret.clone());

    let allowance = w.agent_allowance(&w.agent_pk).await;
    let storage = w.storage_usage(&w.vault).await;
    let invented: near_api::AccountId = format!("invented-{}.sandbox", "x".repeat(47))
        .parse()
        .expect("a valid 64-byte account id");

    let record = w
        .signed_delegate(
            &w.agent_secret,
            &w.agent_pk,
            "record_refusal",
            refusal_args(&invented, 1, "guard_deny"),
            NearGas::from_tgas(10),
        )
        .await;
    let tx = w
        .send_actions_raw(
            &thief,
            &w.vault,
            vec![Action::Delegate(Box::new(record))],
            as_thief.clone(),
        )
        .await
        .expect("the relay is accepted");
    assert!(
        tx.receipt_failure_text().contains("NotAgent"),
        "the vault must refuse the relayed call: {}",
        tx.failure_text()
    );
    assert!(tx.vault_events().is_empty(), "a refused relay logs nothing");
    assert_eq!(w.guard_refusal_count(&invented).await, 0);
    assert_eq!(w.guard_refusal_payees().await, 0);

    // The same path to `pay`: refused before anything is reserved or scheduled.
    let pay = w
        .signed_delegate(
            &w.agent_secret,
            &w.agent_pk,
            "pay",
            pay_args(&w.merchant, UNIT, None),
            AGENT_GAS,
        )
        .await;
    let tx = w
        .send_actions_raw(
            &thief,
            &w.vault,
            vec![Action::Delegate(Box::new(pay))],
            as_thief,
        )
        .await
        .expect("the relay is accepted");
    assert!(
        tx.receipt_failure_text().contains("NotAgent"),
        "{}",
        tx.failure_text()
    );
    assert!(!tx.touched(&w.registry) && !tx.touched(&w.token));
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(w.spent_today().await, 0);

    assert_eq!(
        w.storage_usage(&w.vault).await,
        storage,
        "the vault stored nothing"
    );
    assert_eq!(
        w.agent_allowance(&w.agent_pk).await,
        allowance,
        "and the relays never touched the allowance either"
    );

    // Relaying from the vault account itself would make the signer the vault, but the agent's
    // function-call key cannot sign a delegate action at all.
    let again = w
        .signed_delegate(
            &w.agent_secret,
            &w.agent_pk,
            "record_refusal",
            refusal_args(&invented, 1, "guard_deny"),
            NearGas::from_tgas(10),
        )
        .await;
    assert_protocol_rejected(
        w.send_actions_raw(
            &w.vault,
            &w.vault,
            vec![Action::Delegate(Box::new(again))],
            w.agent_signer.clone(),
        )
        .await,
        &["RequiresFullAccess"],
    );

    // The key signing directly, as the agent does, is charged and counted as before.
    let tx = w
        .agent_call("record_refusal", refusal_args(&invented, 1, "guard_deny"))
        .gas(NearGas::from_tgas(10))
        .send()
        .await
        .assert_ok();
    tx.outcome().assert_refused("guard_deny");
    assert_eq!(w.guard_refusal_count(&invented).await, 1);
    assert!(w.agent_allowance(&w.agent_pk).await < allowance);
}

/// A scheduled callback always carries exactly one promise result, and a direct call
/// carries none. That is the check that stops a key on the vault account from calling a
/// callback with a made-up context, because `#[private]` alone lets the vault account in.
#[tokio::test]
async fn a_callback_called_directly_is_refused_even_from_the_vault_account() {
    let w = World::new(Setup::default()).await;
    let today = w.today().await;
    let ctx = json!({ "ctx": payment_ctx(&w.agent_pk, &w.attacker, 5 * UNIT, today) });

    // From another account, near-sdk's #[private] check refuses first.
    w.call(&w.stranger, &w.vault, "on_transfer", ctx.clone())
        .send()
        .await
        .assert_panicked_with("Method on_transfer is private");

    // From the vault account itself #[private] passes, and the promise-result check is what
    // refuses. Believed, `on_transfer` would count the attacker as paid and log a payment
    // that never happened.
    w.vault_self_call("on_transfer", ctx.clone())
        .send()
        .await
        .assert_panicked_with("NotCallback");
    w.vault_self_call("on_verdict", ctx)
        .send()
        .await
        .assert_panicked_with("NotCallback");
    let (_, rogue) = new_key();
    w.vault_self_call(
        "on_agent_key_added",
        json!({ "public_key": rogue, "nonce": "1" }),
    )
    .send()
    .await
    .assert_panicked_with("NotCallback");
    w.vault_self_call("on_withdraw", json!({ "amount": "1" }))
        .send()
        .await
        .assert_panicked_with("NotCallback");

    assert_eq!(w.paid_count(&w.attacker).await, 0);
    assert_eq!(w.spent_today().await, 0);
    assert_eq!(w.ft_balance(&w.attacker).await, 0);
}

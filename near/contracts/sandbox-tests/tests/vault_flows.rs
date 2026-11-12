//! The flows the product is judged on, end to end on a local chain.
//!
//! Every test here drives the three contracts together through real transactions. The
//! agent signs AS THE VAULT ACCOUNT with the function-call key the vault created for it, the
//! vault asks the registry over a real cross-contract call, and the money moves through a
//! real NEP-141 contract. What a unit test cannot show, and these do, is the receipt chain:
//! that a refusal never reaches the token, that a hold reserves nothing, and that the
//! outcome the agent reads back is the one the last callback in the chain wrote.

mod common;

use common::*;
use near_api::types::Action;
use near_api::types::transaction::actions::{
    CreateAccountAction, DeployContractAction, FunctionCallAction, TransferAction,
};
use near_api::{AccountId, NearToken};
use near_sdk::serde_json::{Value, json};

// ---------------------------------------------------------------------------------------
// Deploy, init, fund
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn deploy_init_and_fund_leave_a_vault_ready_to_pay() {
    let w = World::new(Setup::default()).await;

    let config = w.config().await;
    assert_eq!(config.owner_id, w.owner.as_str());
    assert_eq!(config.token_id, w.token.as_str());
    assert_eq!(config.registry_id.as_deref(), Some(w.registry.as_str()));
    assert!(!config.frozen);
    assert_eq!(config.daily_cap.0, DEFAULT_DAILY_CAP);
    assert_eq!(config.auto_approve_max.0, DEFAULT_AUTO_APPROVE_MAX);
    assert!(!config.allowlist_enabled);
    assert_eq!(config.token_storage_deposit.0, w.storage_min);
    assert_eq!(config.version, "agent-spend-policy 0.2.0");
    assert!(
        config.hold_unknown,
        "a new vault holds payees nobody has judged"
    );
    // NEP-330: each contract reports the crate version it was built from, read from the
    // deployed code (the build embeds it), so it holds for given bytes as well as built ones.
    // Both crates are at 0.2.0, the version in which each last extended its error ABI.
    for contract in [&w.vault, &w.registry] {
        let metadata: Value = w
            .view(contract, "contract_source_metadata", json!({}))
            .await;
        assert_eq!(metadata["version"], "0.2.0", "{contract}: {metadata}");
        assert_eq!(
            metadata["standards"][0],
            json!({ "standard": "nep330", "version": "1.3.0" }),
            "{contract}: {metadata}"
        );
    }
    // Amounts are U128 JSON, decimal strings, in every public shape.
    let raw = w.config_json().await;
    for key in ["daily_cap", "auto_approve_max", "token_storage_deposit"] {
        assert_decimal_string(&raw, key);
    }
    assert_eq!(raw["hold_unknown"], json!(true));

    // `new` registered the vault on its token from the vault's own NEAR, so a deposit can
    // arrive without anyone else paying for the vault's storage on the token.
    assert!(
        w.vault_registered_by_init,
        "the registration promise scheduled by `new` did not land"
    );
    // The retry is the owner's, and harmless once registered: NEP-145 refunds the deposit.
    w.call(&w.stranger, &w.vault, "register_with_token", json!({}))
        .send()
        .await
        .assert_panicked_with("NotOwner");
    w.owner_call_plain("register_with_token", json!({}))
        .send()
        .await
        .assert_ok();
    assert!(w.is_registered(&w.vault).await);

    let init = the_event(&w.setup_events, VAULT_STANDARD, "vault_initialized");
    assert_eq!(str_field(&init, "owner_id"), w.owner.as_str());
    assert_eq!(str_field(&init, "token_id"), w.token.as_str());
    assert_eq!(str_field(&init, "registry_id"), w.registry.as_str());

    // Funding goes through `ft_transfer_call`, so the vault logs who funded it and how much.
    let deposited = the_event(&w.setup_events, VAULT_STANDARD, "deposited");
    assert_eq!(str_field(&deposited, "sender_id"), w.owner.as_str());
    assert_eq!(num_field(&deposited, "amount"), DEFAULT_FUND);
    assert_decimal_string(&deposited, "amount");
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND);

    // A fresh UTC day: nothing spent, the whole cap left, nothing waiting for the owner.
    assert_eq!(w.today().await, w.chain_time_s().await / 86_400);
    assert_eq!(w.spent_today().await, 0);
    assert_eq!(w.remaining_today().await, Some(DEFAULT_DAILY_CAP));
    assert!(w.held_ids().await.is_empty());
    assert!(w.agents_text().await.contains(&w.agent_pk.to_string()));
}

/// The two inits the spec refuses, each of which would hand the agent more than its key.
/// Deploy and init travel in one transaction, so a refused init also leaves no code behind
/// for the first caller of `new` to claim.
#[tokio::test]
async fn init_refuses_a_vault_that_owns_itself_or_is_its_own_token() {
    let w = World::new(Setup::token_only()).await;
    let code = vault_wasm();
    let fresh: AccountId = "vault2.sandbox".parse().expect("a valid account id");
    w.create_account(&fresh, NearToken::from_near(50)).await;

    // The agent keys live on the vault account, so a self-owned vault would let any agent
    // key pass the owner check.
    let init = vault_init_args(&fresh, &w.token, None, w.storage_min, 0, 0);
    w.deploy(&fresh, code.clone(), "new", init)
        .await
        .assert_panicked_with("OwnerIsVault");
    assert!(!w.has_contract(&fresh).await);

    let init = vault_init_args(&w.owner, &fresh, None, w.storage_min, 0, 0);
    w.deploy(&fresh, code.clone(), "new", init)
        .await
        .assert_panicked_with("InvalidPayee");
    assert!(!w.has_contract(&fresh).await);

    // The correct init works once; a second `new` is refused by near-sdk itself.
    let init = vault_init_args(&w.owner, &w.token, None, w.storage_min, 0, 0);
    w.deploy(&fresh, code, "new", init).await.assert_ok();
    let hijack = vault_init_args(&w.stranger, &w.token, None, w.storage_min, 0, 0);
    w.call(&w.stranger, &fresh, "new", hijack)
        .send()
        .await
        .assert_panicked_with("The contract has already been initialized");
    let config: Value = w.view(&fresh, "get_config", json!({})).await;
    assert_eq!(config["owner_id"], w.owner.as_str());
}

/// Finding AUTH-4. A deploy sent WITHOUT its init leaves `new` open, and both contracts are
/// meant for accounts with no full-access key left to redeploy them. So `new` admits only the
/// account itself and its parent: a stranger who sees the bare deploy first is refused by
/// name, and the rightful init still works afterwards. The keyless path the deploy plans, a
/// parent creating `vault.<parent>` and initializing it in one batch with no key added at all,
/// is admitted.
#[tokio::test]
async fn a_deploy_without_its_init_cannot_be_claimed_by_a_stranger() {
    let w = World::new(Setup::token_only()).await;

    for (account, code, hijack, rightful) in [
        (
            "vault3.sandbox",
            vault_wasm(),
            vault_init_args(&w.stranger, &w.token, None, w.storage_min, 0, 0),
            vault_init_args(&w.owner, &w.token, None, w.storage_min, 0, 0),
        ),
        (
            "registry3.sandbox",
            registry_wasm(),
            json!({ "owner_id": w.stranger, "oracles": [w.stranger] }),
            json!({ "owner_id": w.owner, "oracles": [w.oracle] }),
        ),
    ] {
        let account: AccountId = account.parse().expect("a valid account id");
        w.create_account(&account, NearToken::from_near(50)).await;
        w.deploy_without_init(&account, code).await.assert_ok();
        assert!(w.has_contract(&account).await);

        let tx = w.call(&w.stranger, &account, "new", hijack).send().await;
        tx.assert_panicked_with("InitNotAllowed");
        assert!(
            tx.events().is_empty(),
            "{account}: a refused init logs nothing"
        );

        // The account itself (a self-deploy's init) is admitted.
        w.call(&account, &account, "new", rightful.clone())
            .send()
            .await
            .assert_ok();

        // Once. A second `new`, even from a caller `new` admits, is refused by near-sdk's
        // generated entry point before the contract's code runs, so nobody re-initializes a
        // live vault or registry over the funds or the verdicts it holds. Only the wasm has
        // this check; the unit tests call `new` as a plain function.
        w.call(&account, &account, "new", rightful)
            .send()
            .await
            .assert_panicked_with("The contract has already been initialized");
    }
    let config: Value = w
        .view(&"vault3.sandbox".parse().unwrap(), "get_config", json!({}))
        .await;
    assert_eq!(config["owner_id"], w.owner.as_str());
    let owner: String = w
        .view(&"registry3.sandbox".parse().unwrap(), "owner", json!({}))
        .await;
    assert_eq!(owner, w.owner.as_str());

    // The parent creates `vault.owner.sandbox`, funds it, deploys and initializes it in one
    // batch. No key is ever added to it, so it is keyless from its first block.
    let child: AccountId = format!("vault.{}", w.owner)
        .parse()
        .expect("a valid account id");
    let init = vault_init_args(&w.owner, &w.token, None, w.storage_min, 0, 0);
    let tx = w
        .send_actions_raw(
            &w.owner,
            &child,
            vec![
                Action::CreateAccount(CreateAccountAction {}),
                Action::Transfer(TransferAction {
                    deposit: NearToken::from_near(5),
                }),
                Action::DeployContract(DeployContractAction { code: vault_wasm() }),
                Action::FunctionCall(Box::new(FunctionCallAction {
                    method_name: "new".to_owned(),
                    args: near_sdk::serde_json::to_vec(&init).expect("serialize"),
                    gas: near_api::NearGas::from_tgas(100),
                    deposit: NearToken::from_yoctonear(0),
                })),
            ],
            w.root.clone(),
        )
        .await
        .expect("the batch is accepted")
        .assert_ok();
    let config: Value = w.view(&child, "get_config", json!({})).await;
    assert_eq!(config["owner_id"], w.owner.as_str());
    assert!(
        w.access_keys(&child).await.is_empty(),
        "no key was ever added to the vault account"
    );
    assert!(tx.events().iter().any(|e| e.event == "vault_initialized"));
}

// ---------------------------------------------------------------------------------------
// ALLOW and no verdict
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn an_allow_payee_is_paid_and_the_day_is_charged() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(&w.merchant, "ALLOW", &["known_merchant"])
        .await;

    let tx = w
        .pay(&w.merchant, 5 * UNIT, Some("order-1"))
        .await
        .assert_ok();
    let outcome = tx.outcome();
    outcome.assert_sent();
    assert_eq!(outcome.reason, None);
    assert_eq!(outcome.held_id, None);

    assert_eq!(w.ft_balance(&w.merchant).await, 5 * UNIT);
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND - 5 * UNIT);
    assert_eq!(w.spent_today().await, 5 * UNIT);
    assert_eq!(
        w.remaining_today().await,
        Some(DEFAULT_DAILY_CAP - 5 * UNIT)
    );
    assert_eq!(w.paid_count(&w.merchant).await, 1);
    assert_eq!(w.refusal_count(&w.merchant).await, 0);

    // The registry was asked before the token moved, inside the same transaction.
    assert!(tx.touched(&w.registry));
    assert!(tx.touched(&w.token));

    let sent = tx.vault_event("payment_sent");
    assert_eq!(
        num_field(&sent, "payment_id"),
        u128::from(outcome.payment_id.0)
    );
    assert_eq!(str_field(&sent, "payee"), w.merchant.as_str());
    assert_eq!(num_field(&sent, "amount"), 5 * UNIT);
    assert!(!bool_field(&sent, "by_owner"));
    assert_eq!(str_field(&sent, "memo"), "order-1");
    for key in ["payment_id", "amount", "day"] {
        assert_decimal_string(&sent, key);
    }
    assert_eq!(num_field(&sent, "day"), u128::from(w.today().await));
    assert!(!tx.has_vault_event("payment_refused"));

    let moved = tx.event(NEP141_STANDARD, "ft_transfer");
    assert_eq!(str_field(&moved, "old_owner_id"), w.vault.as_str());
    assert_eq!(str_field(&moved, "new_owner_id"), w.merchant.as_str());
    assert_eq!(num_field(&moved, "amount"), 5 * UNIT);
}

/// Amendment A1, the headline: a first payment to a payee nobody has judged waits for one
/// human tap. The registry has nothing on `newshop`, the owner never listed it and the vault
/// never paid it, so the agent's payment is held, not paid blind. The owner's approval pays
/// it, and that payment is what lets the next ones flow. `newshop` is also unregistered on the
/// token, so the settlement is where the vault pays the payee's NEP-145 storage from its own
/// NEAR before transferring.
#[tokio::test]
async fn a_payee_nobody_has_judged_waits_for_one_owner_tap_and_then_flows() {
    let w = World::new(Setup::default()).await;
    assert!(w.verdict(&w.newshop).await.is_none());
    assert!(!w.is_registered(&w.newshop).await);

    let tx = w
        .pay(&w.newshop, 3 * UNIT, Some("first order"))
        .await
        .assert_ok();
    let outcome = tx.outcome();
    let held_id = outcome.assert_held_because("UnknownPayee");
    assert!(tx.touched(&w.registry), "the registry was asked first");
    assert!(!tx.touched(&w.token), "nothing reached the token");
    assert_eq!(w.ft_balance(&w.newshop).await, 0);
    assert_eq!(w.spent_today().await, 0, "the reservation was released");
    assert_eq!(
        w.refusal_count(&w.newshop).await,
        0,
        "being new is no refusal"
    );
    let held_event = tx.vault_event("payment_held");
    assert_eq!(str_field(&held_event, "reason"), "UnknownPayee");
    assert_eq!(str_field(&held_event, "kind"), "unknown_payee");
    assert_eq!(num_field(&held_event, "held_id"), u128::from(held_id));
    let held = w.held(held_id).await.expect("the hold is stored");
    assert_eq!(held.reason, "UnknownPayee");
    assert_eq!(held.kind, "unknown_payee");
    assert_eq!(held.memo.as_deref(), Some("first order"));

    // The one human tap.
    let settle = w.owner_pay(held_id).await.assert_ok();
    let settled = settle.outcome();
    settled.assert_sent();
    assert_eq!(settled.payment_id, outcome.payment_id);
    assert!(bool_field(&settle.vault_event("payment_sent"), "by_owner"));
    assert!(
        w.is_registered(&w.newshop).await,
        "the vault registered its payee"
    );
    assert_eq!(w.ft_balance(&w.newshop).await, 3 * UNIT);
    assert_eq!(w.paid_count(&w.newshop).await, 1);

    // Paid once, known from then on: the registry is still silent, and the agent's next
    // payment goes straight through.
    let tx = w.pay(&w.newshop, 2 * UNIT, None).await.assert_ok();
    tx.outcome().assert_sent();
    let sent = tx.vault_event("payment_sent");
    assert!(!bool_field(&sent, "by_owner"));
    assert!(sent.get("memo").is_some_and(Value::is_null));
    assert_eq!(w.ft_balance(&w.newshop).await, 5 * UNIT);
    assert_eq!(w.spent_today().await, 5 * UNIT);
    assert_eq!(w.paid_count(&w.newshop).await, 2);
}

/// The owner can turn the hold off, and then silence pays as before. Only the owner, only
/// with the yocto: it decides whether money can reach a payee nobody has judged.
#[tokio::test]
async fn with_hold_unknown_off_a_payee_with_no_verdict_is_paid() {
    let w = World::new(Setup::default()).await;

    w.call(
        &w.stranger,
        &w.vault,
        "set_hold_unknown",
        json!({ "hold_unknown": false }),
    )
    .one_yocto()
    .send()
    .await
    .assert_panicked_with("NotOwner");
    w.owner_call_plain("set_hold_unknown", json!({ "hold_unknown": false }))
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    assert_protocol_rejected(
        w.agent_call("set_hold_unknown", json!({ "hold_unknown": false }))
            .try_send_raw()
            .await,
        &["MethodNameMismatch"],
    );
    assert!(w.config().await.hold_unknown);

    let tx = w.set_hold_unknown(false).await.assert_ok();
    assert!(!bool_field(
        &tx.vault_event("hold_unknown_set"),
        "hold_unknown"
    ));
    assert!(!w.config().await.hold_unknown);

    let tx = w.pay(&w.newshop, 3 * UNIT, None).await.assert_ok();
    tx.outcome().assert_sent();
    assert!(w.is_registered(&w.newshop).await);
    assert_eq!(w.ft_balance(&w.newshop).await, 3 * UNIT);
    assert_eq!(w.paid_count(&w.newshop).await, 1);

    // Back on: a verdict-less payee the vault never paid waits again.
    let tx = w.set_hold_unknown(true).await.assert_ok();
    assert!(bool_field(
        &tx.vault_event("hold_unknown_set"),
        "hold_unknown"
    ));
    w.pay(&w.stranger, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_held_because("UnknownPayee");
    assert_eq!(w.ft_balance(&w.stranger).await, 0);
}

// ---------------------------------------------------------------------------------------
// DENY
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_deny_payee_is_refused_on_chain_and_nothing_moves() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(
        &w.attacker,
        "DENY",
        &["drainer", "phishing", "sybil", "wash_trading"],
    )
    .await;

    let tx = w.pay(&w.attacker, 5 * UNIT, None).await.assert_ok();
    let outcome = tx.outcome();
    outcome.assert_refused("RegistryDeny");

    assert_eq!(w.ft_balance(&w.attacker).await, 0);
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND);
    assert!(
        !tx.touched(&w.token),
        "a refused payment never reaches the token"
    );
    assert_eq!(w.spent_today().await, 0, "the reservation was released");
    assert_eq!(w.refusal_count(&w.attacker).await, 1);
    assert_eq!(w.paid_count(&w.attacker).await, 0);

    let refused = tx.vault_event("payment_refused");
    assert_eq!(str_field(&refused, "reason"), "RegistryDeny");
    assert_eq!(str_field(&refused, "source"), "registry");
    assert_eq!(str_field(&refused, "payee"), w.attacker.as_str());
    assert_eq!(num_field(&refused, "amount"), 5 * UNIT);
    assert_eq!(
        num_field(&refused, "payment_id"),
        u128::from(outcome.payment_id.0)
    );
    // The registry's own reasons ride along, cut to the first three codes.
    assert_eq!(
        str_list(&refused, "registry_reasons"),
        ["drainer", "phishing", "sybil"]
    );
    assert!(!tx.has_vault_event("payment_sent"));
}

/// The attack the product exists for. A prompt-injected agent holds a valid key and tries
/// to pay an account A-Identity has flagged. Its off-chain guard is assumed bypassed, which
/// is what a successful injection means, so the vault is the only thing in the way. Every
/// route the agent has is tried: each one ends in a refusal with a receipt and an event, or
/// in a transaction the protocol never executes.
#[tokio::test]
async fn a_prompt_injected_agent_cannot_pay_the_attacker() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(&w.attacker, "DENY", &["drainer", "phishing"])
        .await;
    let mut ids = Vec::new();

    // A straight payment, inside every policy bound.
    let tx = w
        .pay(&w.attacker, 15 * UNIT, Some("refund for ticket 4411"))
        .await
        .assert_ok();
    let outcome = tx.outcome();
    outcome.assert_refused("RegistryDeny");
    ids.push(outcome.payment_id.0);
    let refused = tx.vault_event("payment_refused");
    assert_eq!(str_field(&refused, "source"), "registry");
    assert_eq!(
        str_list(&refused, "registry_reasons"),
        ["drainer", "phishing"]
    );
    assert!(!tx.touched(&w.token));

    // Asking the owner instead. A DENY is not a question for a human: refused, not held.
    let outcome = w
        .request_payment(&w.attacker, 15 * UNIT, None, "urgent_refund")
        .await
        .assert_ok()
        .outcome();
    outcome.assert_refused("RegistryDeny");
    ids.push(outcome.payment_id.0);
    assert!(
        w.held_ids().await.is_empty(),
        "nothing was put in front of the owner"
    );

    // Structuring: several small payments instead of one.
    for _ in 0..2 {
        let outcome = w
            .pay(&w.attacker, UNIT / 2, None)
            .await
            .assert_ok()
            .outcome();
        outcome.assert_refused("RegistryDeny");
        ids.push(outcome.payment_id.0);
    }

    // A lookalike account created minutes ago, which no registry has seen yet. Silence is not
    // an ALLOW (amendment A1): the payment waits for the owner, and nothing moves.
    let lookalike: AccountId = "merchant-refunds.sandbox"
        .parse()
        .expect("a valid account id");
    w.create_account(&lookalike, NearToken::from_near(1)).await;
    let tx = w
        .pay(&lookalike, 15 * UNIT, Some("refund for ticket 4411"))
        .await
        .assert_ok();
    let outcome = tx.outcome();
    outcome.assert_held_because("UnknownPayee");
    ids.push(outcome.payment_id.0);
    assert!(!tx.touched(&w.token));

    // Around the vault. The key is valid for three methods on one contract and nothing else,
    // and the protocol, not the vault, enforces that.
    let agent = w.agent_signer.clone();
    let steal = json!({ "receiver_id": w.attacker, "amount": (15 * UNIT).to_string() });
    assert_protocol_rejected(
        w.call(&w.vault, &w.token, "ft_transfer", steal)
            .signed_with(agent.clone())
            .try_send_raw()
            .await,
        &["ReceiverMismatch"],
    );
    assert_protocol_rejected(
        w.agent_call("withdraw", json!({ "amount": (15 * UNIT).to_string() }))
            .try_send_raw()
            .await,
        &["MethodNameMismatch"],
    );
    assert_protocol_rejected(
        w.agent_call("set_registry", json!({ "registry_id": null }))
            .try_send_raw()
            .await,
        &["MethodNameMismatch"],
    );
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

    // Nothing moved, nothing stays reserved, and every attempt is on chain with its own id.
    assert_eq!(w.ft_balance(&w.attacker).await, 0);
    assert_eq!(w.ft_balance(&lookalike).await, 0);
    assert_eq!(w.ft_balance(&w.vault).await, DEFAULT_FUND);
    assert_eq!(w.spent_today().await, 0);
    assert_eq!(w.refusal_count(&w.attacker).await, 4);
    assert!(
        ids.windows(2).all(|pair| pair[0] < pair[1]),
        "every attempt gets its own increasing payment id: {ids:?}"
    );
}

// ---------------------------------------------------------------------------------------
// WARN, holds and the owner
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn a_warn_payee_is_held_and_the_owner_settles_it() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(&w.merchant, "WARN", &["new_account"]).await;

    let tx = w
        .pay(&w.merchant, 5 * UNIT, Some("invoice-7"))
        .await
        .assert_ok();
    let outcome = tx.outcome();
    let held_id = outcome.assert_held();
    assert_eq!(outcome.reason.as_deref(), Some("RegistryWarn"));
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert!(!tx.touched(&w.token));
    assert_eq!(w.spent_today().await, 0, "a held payment reserves nothing");
    assert_eq!(
        w.refusal_count(&w.merchant).await,
        0,
        "a warning is not a refusal"
    );

    let event = tx.vault_event("payment_held");
    assert_eq!(num_field(&event, "held_id"), u128::from(held_id));
    assert_eq!(
        num_field(&event, "payment_id"),
        u128::from(outcome.payment_id.0)
    );
    assert_eq!(str_field(&event, "payee"), w.merchant.as_str());
    assert_eq!(num_field(&event, "amount"), 5 * UNIT);
    assert_eq!(str_field(&event, "reason"), "RegistryWarn");

    let held = w.held(held_id).await.expect("the held payment is stored");
    assert_eq!(held.id.0, held_id);
    assert_eq!(held.payee, w.merchant.as_str());
    assert_eq!(held.amount.0, 5 * UNIT);
    assert_eq!(held.memo.as_deref(), Some("invoice-7"));
    assert_eq!(held.reason, "RegistryWarn");
    assert_eq!(held.kind, "registry_warn");
    assert_eq!(held.agent_pk, w.agent_pk.to_string());
    assert_eq!(held.expires_at_s.0, held.created_at_s.0 + 86_400);
    assert_eq!(w.held_ids().await, vec![held_id]);

    // The owner is the human the warning asks for: the WARN is not asked about again.
    let settle = w.owner_pay(held_id).await.assert_ok();
    let settled = settle.outcome();
    settled.assert_sent();
    assert_eq!(
        settled.payment_id, outcome.payment_id,
        "a settlement keeps the id of the attempt that created the hold"
    );
    assert_eq!(settled.held_id.map(|id| id.0), Some(held_id));
    assert_eq!(w.ft_balance(&w.merchant).await, 5 * UNIT);
    assert_eq!(
        w.spent_today().await,
        5 * UNIT,
        "the owner's settlement still counts toward the day"
    );
    assert_eq!(w.paid_count(&w.merchant).await, 1);
    assert!(w.held(held_id).await.is_none());
    assert!(w.held_ids().await.is_empty());
    let sent = settle.vault_event("payment_sent");
    assert!(bool_field(&sent, "by_owner"));
    assert_eq!(str_field(&sent, "memo"), "invoice-7");

    // A hold settles once.
    assert_refused_or_panicked(&w.owner_pay(held_id).await, "HeldNotFound");
    assert_eq!(w.ft_balance(&w.merchant).await, 5 * UNIT);

    // A request's reason is the agent's own text, and an injected agent can make it read like
    // a vault code to pass the warned payee off as merely new. The hold's `kind` is the
    // vault's word, from the registry's answer, and that is what the console shows.
    let tx = w
        .request_payment(&w.merchant, 4 * UNIT, None, "UnknownPayee")
        .await
        .assert_ok();
    let spoofed = tx.outcome().assert_held_because("UnknownPayee");
    assert_eq!(
        str_field(&tx.vault_event("payment_held"), "kind"),
        "registry_warn"
    );
    let held = w.held(spoofed).await.expect("stored");
    assert_eq!(held.reason, "UnknownPayee");
    assert_eq!(held.kind, "registry_warn");
}

#[tokio::test]
async fn the_owner_can_reject_a_held_payment() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(&w.merchant, "WARN", &["new_account"]).await;
    let held_id = w
        .pay(&w.merchant, 5 * UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_held();

    // Only the owner, and only with the yocto.
    w.call(&w.stranger, &w.vault, "owner_reject", held_args(held_id))
        .one_yocto()
        .send()
        .await
        .assert_panicked_with("NotOwner");
    w.owner_call_plain("owner_reject", held_args(held_id))
        .send()
        .await
        .assert_panicked_with("RequiresOneYocto");
    assert!(
        w.held(held_id).await.is_some(),
        "refused calls changed nothing"
    );

    let tx = w.owner_reject(held_id).await.assert_ok();
    let rejected = tx.vault_event("held_rejected");
    assert_eq!(num_field(&rejected, "held_id"), u128::from(held_id));
    assert_decimal_string(&rejected, "held_id");
    assert!(w.held(held_id).await.is_none());
    assert!(w.held_ids().await.is_empty());
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(w.spent_today().await, 0);

    // Rejected is final: there is nothing left to pay, and nothing to reject twice.
    assert_refused_or_panicked(&w.owner_pay(held_id).await, "HeldNotFound");
    assert_refused_or_panicked(&w.owner_reject(held_id).await, "HeldNotFound");
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
}

/// `request_payment` is the agent's way past its own ceiling: it asks, and a human decides.
/// The owner's settlement bypasses the ceiling and the cap check, never the accounting.
#[tokio::test]
async fn an_agent_request_above_the_ceiling_waits_for_the_owner() {
    let w = World::new(Setup::default()).await;
    let amount = 30 * UNIT;
    assert!(amount > DEFAULT_AUTO_APPROVE_MAX);

    // The agent may not pay this on its own...
    w.pay(&w.merchant, amount, None)
        .await
        .assert_ok()
        .outcome()
        .assert_refused("AboveAutoApprove");

    // ...so it asks. The registry says ALLOW for the merchant, and the request is still
    // held: the agent asked for a human, and a clean verdict does not change that.
    let tx = w
        .request_payment(&w.merchant, amount, Some("bulk-order"), "above_ceiling")
        .await
        .assert_ok();
    let outcome = tx.outcome();
    let held_id = outcome.assert_held();
    assert_eq!(outcome.reason.as_deref(), Some("above_ceiling"));
    assert!(tx.touched(&w.registry), "a request is still checked");
    assert_eq!(w.spent_today().await, 0, "asking reserves nothing");
    let held = w.held(held_id).await.expect("stored");
    assert_eq!(held.reason, "above_ceiling");
    assert_eq!(
        held.kind, "agent_request",
        "the registry said ALLOW; the agent asked"
    );
    assert_eq!(held.amount.0, amount);

    let settle = w.owner_pay(held_id).await.assert_ok();
    settle.outcome().assert_sent();
    assert_eq!(w.ft_balance(&w.merchant).await, amount);
    assert_eq!(w.spent_today().await, amount);
    assert!(bool_field(&settle.vault_event("payment_sent"), "by_owner"));
}

/// The agent's own guard refusal is on chain with a receipt and an event, and it is counted
/// apart (amendment A2): `guard_refusal_count` is this agent's word, `refusal_count` is the
/// registry's alone. Any agent key, a prompt-injected one included, can record a refusal
/// against an honest merchant, and that must not move the number other vaults may read.
#[tokio::test]
async fn the_agents_own_guard_refusal_is_recorded_on_chain_and_counted_apart() {
    let w = World::new(Setup::default()).await;

    let tx = w
        .record_refusal(&w.attacker, 7 * UNIT, "a_identity_deny")
        .await
        .assert_ok();
    let outcome = tx.outcome();
    outcome.assert_refused("a_identity_deny");
    let refused = tx.vault_event("payment_refused");
    assert_eq!(str_field(&refused, "source"), "agent_guard");
    assert_eq!(str_field(&refused, "reason"), "a_identity_deny");
    assert_eq!(str_field(&refused, "payee"), w.attacker.as_str());
    assert_eq!(num_field(&refused, "amount"), 7 * UNIT);
    assert_eq!(
        num_field(&refused, "payment_id"),
        u128::from(outcome.payment_id.0)
    );
    assert!(str_list(&refused, "registry_reasons").is_empty());
    assert_eq!(w.guard_refusal_count(&w.attacker).await, 1);
    assert_eq!(w.refusal_count(&w.attacker).await, 0);

    // Nothing was ever about to move: no registry call, no token call, no reservation.
    assert!(!tx.touched(&w.registry));
    assert!(!tx.touched(&w.token));
    assert_eq!(w.spent_today().await, 0);

    // A recorded refusal against the merchant the registry says ALLOW for stays the agent's
    // word: the registry's counter does not move, and the merchant is still paid.
    w.record_refusal(&w.merchant, UNIT, "guard_deny")
        .await
        .assert_ok()
        .outcome()
        .assert_refused("guard_deny");
    assert_eq!(w.guard_refusal_count(&w.merchant).await, 1);
    assert_eq!(w.refusal_count(&w.merchant).await, 0);
    w.pay(&w.merchant, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();

    // The reason is bounded like every free-text field the vault pays to store and log, and
    // a malformed record does not count against the payee.
    let too_long = "x".repeat(129);
    let tx = w.record_refusal(&w.attacker, UNIT, &too_long).await;
    assert_refused_or_panicked(&tx, "MemoTooLong");
    assert_eq!(w.guard_refusal_count(&w.attacker).await, 1);
    assert_eq!(w.refusal_count(&w.attacker).await, 0);
}

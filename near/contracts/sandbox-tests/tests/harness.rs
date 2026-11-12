//! The harness, checked against what already exists: mock-ft and the protocol.
//!
//! Every other file in this directory drives contracts that are written from the same spec
//! in parallel, so when one of those tests goes red the first question is whether the
//! harness or the contract is wrong. These tests answer it. They touch only mock-ft and the
//! protocol's own access-key rules, so they pass or fail on the harness alone, and they pin
//! the exact error text that the agent-key tests match on.

mod common;

use common::*;
use near_api::types::transaction::actions::{AccessKeyPermission, FunctionCallPermission};
use near_api::{Chain, NearToken};
use near_sdk::serde_json::json;

#[tokio::test]
async fn the_token_moves_and_its_events_parse() {
    let w = World::new(Setup::token_only()).await;

    assert_eq!(w.ft_balance(&w.owner).await, TOTAL_SUPPLY);
    assert!(
        w.storage_min > 0,
        "mock-ft charges for registration like a real NEP-145 token"
    );
    assert!(w.is_registered(&w.merchant).await);
    assert!(
        !w.is_registered(&w.newshop).await,
        "newshop stays unregistered: it is how the vault's own registration gets exercised"
    );

    let tx = w
        .call(
            &w.owner,
            &w.token,
            "ft_transfer",
            json!({ "receiver_id": w.merchant, "amount": (5 * UNIT).to_string(), "memo": "harness" }),
        )
        .one_yocto()
        .send()
        .await
        .assert_ok();
    assert_eq!(w.ft_balance(&w.merchant).await, 5 * UNIT);
    let moved = tx.event(NEP141_STANDARD, "ft_transfer");
    assert_eq!(str_field(&moved, "old_owner_id"), w.owner.as_str());
    assert_eq!(str_field(&moved, "new_owner_id"), w.merchant.as_str());
    assert_eq!(num_field(&moved, "amount"), 5 * UNIT);
    assert_decimal_string(&moved, "amount");

    // A contract panic is an executed transaction that failed, and the harness can read
    // the panic message out of it. The vault tests rely on exactly this to match names.
    let refused = w
        .call(
            &w.owner,
            &w.token,
            "ft_transfer",
            json!({ "receiver_id": w.newshop, "amount": "1" }),
        )
        .one_yocto()
        .send()
        .await;
    refused.assert_panicked_with("is not registered");
    assert_eq!(w.ft_balance(&w.newshop).await, 0);
}

/// The same four rules the vault's agent key lives under, shown on a key the vault had
/// nothing to do with. If one of these stops holding, the vault's key model stops holding
/// with it, whatever the contract code says.
#[tokio::test]
async fn function_call_keys_are_bounded_by_the_protocol() {
    let w = World::new(Setup::token_only()).await;
    let (secret, public) = new_key();
    let limited = signer_for(secret);
    let permission = AccessKeyPermission::FunctionCall(FunctionCallPermission {
        allowance: Some(NearToken::from_near(1)),
        receiver_id: w.token.to_string(),
        method_names: vec!["storage_deposit".to_owned()],
    });
    w.add_key_directly(&w.owner, permission, public, w.root.clone())
        .await
        .expect("the owner's full-access key can add a function-call key")
        .assert_ok();
    let key = w
        .access_key(&w.owner, &public)
        .await
        .expect("the new key is on the owner account");
    let granted = function_call_permission(&key);
    assert_eq!(granted.receiver_id, w.token.as_str());
    assert_eq!(granted.method_names, vec!["storage_deposit"]);

    let register_newshop = json!({ "account_id": w.newshop, "registration_only": true });

    // A listed method with no deposit is the one thing the key may do. The protocol lets
    // it through and the CONTRACT decides: mock-ft wants the storage deposit, which the key
    // cannot attach, so the call executes and fails with the token's own message.
    let through = w
        .call(
            &w.owner,
            &w.token,
            "storage_deposit",
            register_newshop.clone(),
        )
        .signed_with(limited.clone())
        .try_send()
        .await
        .expect("a listed method without a deposit is accepted by the protocol");
    through.assert_panicked_with("The attached deposit is less than the minimum storage balance");

    // A method that is not on the list.
    assert_protocol_rejected(
        w.call(
            &w.owner,
            &w.token,
            "mint",
            json!({ "account_id": w.owner, "amount": "1" }),
        )
        .signed_with(limited.clone())
        .try_send_raw()
        .await,
        &["MethodNameMismatch"],
    );

    // A listed method with a deposit attached.
    assert_protocol_rejected(
        w.call(
            &w.owner,
            &w.token,
            "storage_deposit",
            register_newshop.clone(),
        )
        .deposit(NearToken::from_yoctonear(w.storage_min))
        .signed_with(limited.clone())
        .try_send_raw()
        .await,
        &["DepositWithFunctionCall"],
    );

    // Any receiver other than the one the key names.
    assert_protocol_rejected(
        w.call(
            &w.owner,
            &w.stranger,
            "storage_deposit",
            register_newshop.clone(),
        )
        .signed_with(limited.clone())
        .try_send_raw()
        .await,
        &["ReceiverMismatch"],
    );

    // Anything that is not a single function call. The amount is 1 yoctoNEAR on purpose:
    // the protocol debits the allowance BEFORE it looks at the action type, so a transfer
    // larger than the allowance is refused as `NotEnoughAllowance` and never reaches the
    // rule this line is about (seen on near-sandbox 2.14.0 with a 1 NEAR transfer).
    assert_protocol_rejected(
        w.transfer_near(
            &w.owner,
            &w.stranger,
            NearToken::from_yoctonear(1),
            limited.clone(),
        )
        .await,
        &["RequiresFullAccess"],
    );
    let (_, other) = new_key();
    assert_protocol_rejected(
        w.add_key_directly(
            &w.owner,
            AccessKeyPermission::FullAccess,
            other,
            limited.clone(),
        )
        .await,
        &["RequiresFullAccess"],
    );

    // Once the key is deleted it cannot sign: the client finds no nonce to use, and bytes
    // signed offline and handed straight to the RPC are refused by the protocol itself.
    let nonce = key.nonce.0;
    w.delete_key_directly(&w.owner, public, w.root.clone())
        .await
        .expect("the owner's full-access key can delete it")
        .assert_ok();
    assert!(w.access_key(&w.owner, &public).await.is_none());
    assert_protocol_rejected(
        w.call(
            &w.owner,
            &w.token,
            "storage_deposit",
            register_newshop.clone(),
        )
        .signed_with(limited.clone())
        .try_send()
        .await,
        &[&key_does_not_exist(&public), "UnknownAccessKey"],
    );
    assert_protocol_rejected(
        w.call(&w.owner, &w.token, "storage_deposit", register_newshop)
            .signed_with(limited)
            .try_send_presigned(nonce + 1)
            .await,
        &["AccessKeyNotFound"],
    );
    assert!(
        !w.is_registered(&w.newshop).await,
        "nothing above changed the token"
    );
}

/// The expiry tests move the block clock with `sandbox_fast_forward` instead of sleeping.
/// This pins that it moves the TIMESTAMP and not only the height, and that the chain still
/// takes transactions after the jump.
#[tokio::test]
async fn fast_forward_moves_the_block_clock() {
    let w = World::new(Setup::token_only()).await;

    let height_before = Chain::block_number()
        .fetch_from(&w.network)
        .await
        .expect("block height");
    let before = w.chain_time_ns().await;
    let wall = std::time::Instant::now();
    w.sandbox
        .fast_forward(100)
        .await
        .expect("sandbox_fast_forward");
    let wall_ms = wall.elapsed().as_millis();
    let after = w.chain_time_ns().await;
    let height_after = Chain::block_number()
        .fetch_from(&w.network)
        .await
        .expect("block height");
    eprintln!(
        "fast_forward(100): height {height_before} -> {height_after}, block clock +{} ms in {wall_ms} ms of wall time",
        (after - before) / 1_000_000
    );
    assert!(height_after >= height_before + 100);

    let target = w.chain_time_ns().await + 120 * NS_PER_S;
    let wall = std::time::Instant::now();
    w.advance_time_past_ns(target).await;
    eprintln!(
        "advance_time_past_ns(+120 s of block time) took {} ms of wall time",
        wall.elapsed().as_millis()
    );
    assert!(w.chain_time_ns().await > target);

    w.call(
        &w.owner,
        &w.token,
        "ft_transfer",
        json!({ "receiver_id": w.merchant, "amount": "1" }),
    )
    .one_yocto()
    .send()
    .await
    .assert_ok();
    assert_eq!(w.ft_balance(&w.merchant).await, 1);
}

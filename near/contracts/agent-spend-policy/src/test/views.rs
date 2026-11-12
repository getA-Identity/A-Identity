//! Views and JSON shapes: what the SDK and the console read.

use near_sdk::json_types::{U64, U128};

use super::*;
use crate::{PayOutcome, PayStatus};

#[test]
fn spent_and_remaining_follow_the_day() {
    let mut v = fresh_vault(None, 1_000, 500);
    assert_eq!(v.remaining_today(), Some(U128(1_000)));
    as_agent();
    promise(v.pay(shop(), U128(400), None));
    assert_eq!(v.spent_today(), U128(400));
    assert_eq!(v.remaining_today(), Some(U128(600)));
    advance_s(DAY_S);
    as_viewer();
    assert_eq!(v.today(), U64(T0_DAY + 1));
    assert_eq!(v.spent_today(), U128(0), "the stored total is yesterday's");
    assert_eq!(v.remaining_today(), Some(U128(1_000)));
}

#[test]
fn remaining_is_none_without_a_cap_and_never_negative() {
    let mut v = fresh_vault(None, 0, 0);
    assert_eq!(v.remaining_today(), None);
    // An owner settlement can take the day past the cap; remaining saturates at zero.
    as_owner_yocto();
    v.set_policy(U128(100), U128(0), false);
    as_agent();
    let held_id = value(v.request_payment(shop(), U128(300), None, "why".to_owned()))
        .held_id
        .unwrap();
    as_owner_yocto();
    promise(v.owner_pay(held_id));
    assert_eq!(v.spent_today(), U128(300));
    assert_eq!(v.remaining_today(), Some(U128(0)));
}

#[test]
fn list_held_pages_and_caps_its_limit() {
    let mut v = plain_vault();
    for n in 0..5u128 {
        as_agent();
        let _ = value(v.request_payment(shop(), U128(10 + n), None, "why".to_owned()));
    }
    assert_eq!(v.list_held(None, None).len(), 5);
    let page = v.list_held(Some(U64(1)), Some(U64(2)));
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].amount, U128(11));
    assert_eq!(page[1].amount, U128(12));
    assert!(v.list_held(Some(U64(10)), None).is_empty());
    assert!(
        v.list_held(Some(U64(u64::MAX)), Some(U64(u64::MAX)))
            .is_empty()
    );
    assert_eq!(v.list_held(None, Some(U64(u64::MAX))).len(), 5);
    assert!(v.get_held(U64(999)).is_none());
}

#[test]
fn list_allowlist_pages() {
    let mut v = plain_vault();
    // `fresh_vault` listed its known payees first.
    let listed = known_payees().len();
    assert_eq!(v.list_allowlist(None, None), known_payees().to_vec());
    for n in 0..4 {
        as_owner_yocto();
        v.set_allowed(format!("p{n}.testnet").parse().unwrap(), true);
    }
    assert_eq!(v.list_allowlist(None, None).len(), listed + 4);
    let page = v.list_allowlist(Some(U64(listed as u64 + 2)), Some(U64(5)));
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].as_str(), "p2.testnet");
    assert_eq!(v.list_allowlist(None, Some(U64(1))), vec![shop()]);
}

#[test]
fn agents_list_with_their_records() {
    let mut v = plain_vault();
    grant(&mut v, key(2));
    let agents = v.list_agents();
    assert_eq!(agents.len(), 2);
    assert_eq!(agents[0].public_key, agent());
    assert_eq!(agents[1].public_key, key(2));
    let json = serde_json::to_value(&agents[0]).unwrap();
    assert_eq!(json["public_key"], agent().to_string());
    assert_eq!(json["label"], "test agent");
    assert_eq!(json["expires_at_s"], "0");
    assert_eq!(json["revoked"], false);
    assert_eq!(json["added_at_s"], T0_S.to_string());
    assert!(json.get("nonce").is_none(), "the nonce is internal");
    assert!(v.get_agent(key(77)).is_none());
}

#[test]
fn counters_default_to_zero() {
    let v = plain_vault();
    assert_eq!(v.refusal_count(stranger()), 0);
    assert_eq!(v.guard_refusal_count(stranger()), 0);
    assert_eq!(v.paid_count(stranger()), 0);
    assert!(!v.is_allowed(stranger()));
}

#[test]
fn outcome_json_uses_lower_case_status_and_string_ids() {
    let out = PayOutcome {
        status: PayStatus::Held,
        payment_id: U64(7),
        reason: Some("RegistryWarn".to_owned()),
        held_id: Some(U64(3)),
    };
    assert_eq!(
        serde_json::to_value(&out).unwrap(),
        serde_json::json!({
            "status": "held",
            "payment_id": "7",
            "reason": "RegistryWarn",
            "held_id": "3"
        })
    );
    for (status, name) in [
        (PayStatus::Sent, "sent"),
        (PayStatus::Refused, "refused"),
        (PayStatus::Held, "held"),
        (PayStatus::Failed, "failed"),
    ] {
        assert_eq!(serde_json::to_value(status).unwrap(), name);
    }
}

#[test]
fn config_json_shape() {
    let v = registry_vault();
    let json = serde_json::to_value(v.get_config()).unwrap();
    assert_eq!(
        json,
        serde_json::json!({
            "owner_id": owner().as_str(),
            "token_id": token().as_str(),
            "registry_id": registry().as_str(),
            "frozen": false,
            "daily_cap": "1000",
            "auto_approve_max": "100",
            "allowlist_enabled": false,
            "token_storage_deposit": STORAGE_DEPOSIT.to_string(),
            "version": "agent-spend-policy 0.1.0",
            "hold_unknown": true
        })
    );
}

#[test]
fn held_view_json_shape() {
    let mut v = plain_vault();
    as_agent();
    let held_id = value(v.request_payment(shop(), U128(42), None, "why".to_owned()))
        .held_id
        .unwrap();
    let json = serde_json::to_value(v.get_held(held_id).unwrap()).unwrap();
    assert_eq!(json["id"], held_id.0.to_string());
    assert_eq!(json["amount"], "42");
    assert_eq!(json["agent_pk"], agent().to_string());
    assert!(json["memo"].is_null());
    assert_eq!(
        u128_of(&json["expires_at_s"]),
        u128::from(T0_S + crate::HELD_TTL_S)
    );
}

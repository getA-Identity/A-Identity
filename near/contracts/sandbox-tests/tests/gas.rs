//! What an agent payment costs in gas, measured on a real chain rather than estimated.
//!
//! The agent signs with a function-call key, and the protocol charges that key's allowance
//! (and the vault account's balance) UP FRONT for every Tgas attached, at the purchase
//! price: 0.001 NEAR per Tgas, ten times the burn price. Unused gas is refunded to the
//! allowance afterwards. So the prepaid gas an agent attaches is not free headroom: it is
//! the allowance one payment in flight holds. These tests pay at the recommended figure,
//! record what the chain actually burnt, hop by hop, and show the allowance rule on the
//! vault's own agent keys.
//!
//! Run with `-- --nocapture` to see the measurements, or set `SANDBOX_GAS_REPORT` to a file
//! to collect them as JSON lines.

mod common;

use common::*;
use near_api::{AccountId, NearGas, NearToken};
use near_sdk::serde_json::{Value, json};

/// What the agent attaches to `record_refusal`: it calls nothing, and burns a few Tgas.
const RECORD_REFUSAL_GAS: NearGas = NearGas::from_tgas(10);
/// What the owner's console attaches to `owner_pay`: the same registry-then-transfer chain as
/// an agent payment, whose floor is about 51 Tgas. The owner signs with a full-access key that
/// no allowance bounds, so the console can afford a round figure with twice that.
const OWNER_PAY_GAS: NearGas = NearGas::from_tgas(100);
/// What the console attaches to `withdraw`: `ft_transfer` (15 Tgas) and `on_withdraw` (10).
const WITHDRAW_GAS: NearGas = NearGas::from_tgas(40);
/// What the console attaches to `add_agent_key`: the add-key action and `on_agent_key_added`
/// (10 Tgas).
const ADD_AGENT_KEY_GAS: NearGas = NearGas::from_tgas(30);

/// The allowance the docs recommend for an agent key that makes ten payments one after the
/// other: the up-front hold for one payment in flight (`AGENT_GAS` at 0.001 NEAR per Tgas,
/// 0.073 NEAR) plus what nine landed payments burnt before the tenth is submitted (about
/// 0.0012 NEAR each at 0.0001 NEAR per Tgas), rounded up to leave room for the gas price to
/// double. Ten payments in flight at once need ten holds instead.
const TEN_PAYMENTS_ALLOWANCE: NearToken = NearToken::from_millinear(100);

/// The share of the recommended prepaid gas an ALLOW payment may need before the vault's
/// static budgets count as too tight: the rest, at least 30 percent, is headroom.
const ALLOW_FLOOR_SHARE_PERCENT: u64 = 70;

fn tgas(gas: NearGas) -> f64 {
    gas.as_gas() as f64 / 1e12
}

fn near(amount: NearToken) -> f64 {
    amount.as_yoctonear() as f64 / 1e24
}

/// Every agent call in this suite attaches `AGENT_GAS`, so it must be the figure the vault
/// publishes for the SDK, not a copy that went stale. The constant is read from the vault's
/// source because this crate deliberately does not link the vault as a library: what is
/// under test is the wasm that ships.
#[test]
fn the_harness_pays_at_the_prepaid_gas_the_vault_publishes() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("agent-spend-policy")
        .join("src")
        .join("lib.rs");
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()));
    let line = source
        .lines()
        .find(|line| line.trim_start().starts_with("pub const AGENT_PREPAID_GAS"))
        .unwrap_or_else(|| {
            panic!(
                "the vault no longer publishes AGENT_PREPAID_GAS in {}",
                path.display()
            )
        });
    let published: u64 = line
        .split("from_tgas(")
        .nth(1)
        .and_then(|rest| rest.split(')').next())
        .and_then(|digits| digits.trim().replace('_', "").parse().ok())
        .unwrap_or_else(|| panic!("cannot read a Tgas figure from `{line}`"));
    assert_eq!(
        NearGas::from_tgas(published),
        AGENT_GAS,
        "the vault publishes {published} Tgas for an agent call; set AGENT_GAS in common/mod.rs to match"
    );
}

/// One line of the gas report for a transaction: what was attached, what every receipt
/// burnt, and the NEAR that burning cost. Also asserts the one property every measured call
/// shares: it burnt less than it was given.
#[track_caller]
fn report_tx(case: &str, attached: NearGas, tx: &Tx, extra: Value) {
    let burnt = tx.gas_burnt();
    assert!(
        burnt < attached,
        "{case}: burnt {burnt} of {attached} attached"
    );
    let receipts: Vec<Value> = tx
        .receipt_gas()
        .into_iter()
        .map(|(executor, gas)| json!({ "executor": executor, "tgas": tgas(gas) }))
        .collect();
    let mut line = json!({
        "case": case,
        "attached_tgas": tgas(attached),
        "burnt_tgas": tgas(burnt),
        "transaction_tgas": tgas(tx.transaction_gas()),
        "receipts": receipts,
        "tokens_burnt_near": near(tx.tokens_burnt()),
        "upfront_hold_near": near(upfront_gas_cost(attached)),
    });
    if let (Some(line), Value::Object(extra)) = (line.as_object_mut(), extra) {
        line.extend(extra);
    }
    record_gas_report(&line);
}

/// The measurement the gas budget is tuned from: an ALLOW payment at `AGENT_GAS`, the
/// prepaid gas the vault documents for an agent, once to a payee that is already registered
/// on the token and once to one the vault has to register first (the most expensive pay).
#[tokio::test]
async fn an_allow_payment_at_the_recommended_prepaid_gas_and_what_it_burns() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(&w.merchant, "ALLOW", &["known_merchant"])
        .await;
    w.set_verdict(&w.newshop, "ALLOW", &["known_merchant"])
        .await;

    // The second case pays a payee the vault must first register on the token, so the vault
    // also spends the token's storage minimum on it.
    let cases = [
        ("registered payee, ALLOW verdict", w.merchant.clone(), 0),
        (
            "unregistered payee, ALLOW verdict",
            w.newshop.clone(),
            w.storage_min,
        ),
    ];
    for (case, payee, registration) in cases {
        let allowance_before = w.agent_allowance(&w.agent_pk).await.expect("agent key");
        let vault_near_before = w.near_balance(&w.vault).await;

        let tx = w.pay(&payee, UNIT, None).await.assert_ok();
        tx.outcome().assert_sent();
        assert_eq!(w.ft_balance(&payee).await, UNIT, "{case}");

        let allowance_after = w.agent_allowance(&w.agent_pk).await.expect("agent key");
        let vault_near_after = w.near_balance(&w.vault).await;
        let charged = allowance_before.saturating_sub(allowance_after);
        let vault_spent = vault_near_before.saturating_sub(vault_near_after);
        let hold = upfront_gas_cost(AGENT_GAS);

        // The hold came back whole except for what was burnt: the allowance is charged the
        // NEAR the chain burnt for this transaction's gas, to the yocto, and nothing for the
        // gas that was attached and not used. This is what sizes an allowance in payments.
        assert_eq!(
            charged,
            tx.tokens_burnt(),
            "{case}: the allowance was charged something other than the burnt gas"
        );
        assert!(
            charged > ZERO && charged < hold,
            "{case}: {charged} of {hold}"
        );
        // The vault account signs agent transactions, so it pays the same gas, plus the
        // 1 yoctoNEAR `ft_transfer` requires (the token keeps it), plus the payee's
        // registration when the token did not know the payee yet. A known payee's
        // registration deposit comes back from the token in the same transaction.
        assert_eq!(
            vault_spent.as_yoctonear(),
            tx.tokens_burnt().as_yoctonear() + ONE_YOCTO.as_yoctonear() + registration,
            "{case}: the vault spent {vault_spent}"
        );

        report_tx(
            case,
            AGENT_GAS,
            &tx,
            json!({
                "allowance_charged_near": near(charged),
                "vault_near_spent": near(vault_spent),
            }),
        );
    }
}

/// Every entry point the SDK and the console call, at the prepaid gas each is documented
/// with, in one vault, recorded receipt by receipt: the agent's ALLOW, DENY, WARN and
/// unknown-payee paths, a request, a recorded refusal, the owner's settlement of a WARN hold
/// and of an unknown-payee hold, a withdrawal and a new agent key.
#[tokio::test]
async fn every_entry_point_at_its_documented_gas_and_what_it_burns() {
    let w = World::new(Setup::default()).await;
    w.set_verdict(&w.attacker, "DENY", &["drainer"]).await;
    w.set_verdict(&w.stranger, "WARN", &["new_account"]).await;
    let vault_storage_before = w.storage_usage(&w.vault).await;

    let tx = w.pay(&w.merchant, UNIT, None).await.assert_ok();
    tx.outcome().assert_sent();
    report_tx(
        "agent pay, ALLOW",
        AGENT_GAS,
        &tx,
        json!({ "status": "sent" }),
    );

    let tx = w.pay(&w.attacker, UNIT, None).await.assert_ok();
    tx.outcome().assert_refused("RegistryDeny");
    report_tx(
        "agent pay, DENY",
        AGENT_GAS,
        &tx,
        json!({ "status": "refused" }),
    );

    let tx = w.pay(&w.stranger, UNIT, None).await.assert_ok();
    let warn_held = tx.outcome().assert_held_because("RegistryWarn");
    report_tx(
        "agent pay, WARN held",
        AGENT_GAS,
        &tx,
        json!({ "status": "held" }),
    );

    let tx = w.pay(&w.newshop, UNIT, None).await.assert_ok();
    let unknown_held = tx.outcome().assert_held_because("UnknownPayee");
    report_tx(
        "agent pay, no verdict and never paid, held",
        AGENT_GAS,
        &tx,
        json!({ "status": "held" }),
    );

    let tx = w
        .request_payment(&w.merchant, 30 * UNIT, None, "above_ceiling")
        .await
        .assert_ok();
    tx.outcome().assert_held_because("above_ceiling");
    report_tx(
        "agent request_payment, held",
        AGENT_GAS,
        &tx,
        json!({ "status": "held" }),
    );

    let tx = w
        .agent_call(
            "record_refusal",
            refusal_args(&w.attacker, UNIT, "guard_deny"),
        )
        .gas(RECORD_REFUSAL_GAS)
        .send()
        .await
        .assert_ok();
    tx.outcome().assert_refused("guard_deny");
    report_tx(
        "agent record_refusal",
        RECORD_REFUSAL_GAS,
        &tx,
        json!({ "status": "refused" }),
    );

    let tx = w
        .owner_call("owner_pay", held_args(warn_held))
        .gas(OWNER_PAY_GAS)
        .send()
        .await
        .assert_ok();
    tx.outcome().assert_sent();
    report_tx(
        "owner_pay, WARN hold, registered payee",
        OWNER_PAY_GAS,
        &tx,
        json!({ "status": "sent" }),
    );

    let tx = w
        .owner_call("owner_pay", held_args(unknown_held))
        .gas(OWNER_PAY_GAS)
        .send()
        .await
        .assert_ok();
    tx.outcome().assert_sent();
    report_tx(
        "owner_pay, unknown-payee hold, payee registered by the vault",
        OWNER_PAY_GAS,
        &tx,
        json!({ "status": "sent" }),
    );

    let tx = w
        .owner_call("withdraw", json!({ "amount": UNIT.to_string() }))
        .gas(WITHDRAW_GAS)
        .send()
        .await
        .assert_ok();
    assert!(tx.has_vault_event("withdrawn"));
    report_tx("owner withdraw", WITHDRAW_GAS, &tx, json!({}));

    let (_, new_pk) = new_key();
    let tx = w
        .owner_call(
            "add_agent_key",
            agent_key_args(&new_pk, "second", 0, AGENT_ALLOWANCE),
        )
        .gas(ADD_AGENT_KEY_GAS)
        .send()
        .await
        .assert_ok();
    assert!(!tx.has_vault_event("agent_key_add_failed"));
    assert!(w.access_key(&w.vault, &new_pk).await.is_some());
    report_tx("owner add_agent_key", ADD_AGENT_KEY_GAS, &tx, json!({}));

    // What the vault's NEAR has to stake for: its code and its state, at 1e19 yoctoNEAR per
    // byte. Recorded so the deploy can fund the account from a measured figure.
    let vault_storage_after = w.storage_usage(&w.vault).await;
    record_gas_report(&json!({
        "case": "vault storage",
        "code_bytes": vault_wasm().len(),
        "storage_bytes_after_setup": vault_storage_before,
        "storage_bytes_after_these_calls": vault_storage_after,
        "storage_stake_near": vault_storage_after as f64 * 1e19 / 1e24,
    }));
}

/// The allowance rule on the vault's own agent key: a key whose allowance is below the
/// up-front hold for `AGENT_GAS` cannot even submit a payment, although the payment would
/// burn a small fraction of it. A key sized at the hold plus a margin can. This is what
/// "size the allowance for the payments in flight" means in practice.
#[tokio::test]
async fn an_agent_key_needs_the_whole_upfront_gas_hold_in_its_allowance() {
    let w = World::new(Setup::default()).await;
    let hold = upfront_gas_cost(AGENT_GAS);

    let (secret, thin_pk) = new_key();
    let thin = signer_for(secret);
    let half = NearToken::from_yoctonear(hold.as_yoctonear() / 2);
    w.add_agent_key(&thin_pk, "thin", 0, half).await.assert_ok();
    assert_protocol_rejected(
        w.agent_call("pay", pay_args(&w.merchant, UNIT, None))
            .signed_with(thin)
            .try_send_raw()
            .await,
        &["NotEnoughAllowance"],
    );
    assert_eq!(w.ft_balance(&w.merchant).await, 0);
    assert_eq!(
        w.agent_allowance(&thin_pk).await,
        Some(half),
        "nothing was charged"
    );

    let (secret, sized_pk) = new_key();
    let sized = signer_for(secret);
    let margin = NearToken::from_millinear(10);
    w.add_agent_key(&sized_pk, "sized", 0, hold.saturating_add(margin))
        .await
        .assert_ok();
    w.agent_call("pay", pay_args(&w.merchant, UNIT, None))
        .signed_with(sized)
        .send()
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    record_gas_report(&json!({
        "case": "allowance needed per payment in flight",
        "prepaid_tgas": tgas(AGENT_GAS),
        "refused_allowance_near": near(half),
        "accepted_allowance_near": near(hold.saturating_add(margin)),
    }));
}

/// The allowance the docs recommend for ten payments, on a real key: ten ALLOW payments in a
/// row land, each held at `AGENT_GAS` up front and charged only what it burnt, and the figure
/// would still cover the hold and nine payments' burn at twice the gas price.
#[tokio::test]
async fn the_recommended_allowance_covers_ten_payments_in_a_row() {
    let w = World::new(Setup::with_policy(0, 0)).await;
    let (secret, pk) = new_key();
    let signer = signer_for(secret);
    w.add_agent_key(&pk, "ten payments", 0, TEN_PAYMENTS_ALLOWANCE)
        .await
        .assert_ok();

    let mut burnt = Vec::new();
    for n in 0..10 {
        let tx = w
            .agent_call("pay", pay_args(&w.merchant, UNIT, None))
            .signed_with(signer.clone())
            .send()
            .await
            .assert_ok();
        tx.outcome().assert_sent();
        burnt.push(tx.tokens_burnt());
        assert_eq!(w.ft_balance(&w.merchant).await, (n + 1) * UNIT);
    }
    let left = w
        .agent_allowance(&pk)
        .await
        .expect("the key is still there");
    let charged = TEN_PAYMENTS_ALLOWANCE.saturating_sub(left);
    let total_burnt = burnt.iter().fold(ZERO, |sum, one| sum.saturating_add(*one));
    assert_eq!(charged, total_burnt, "charged exactly what the ten burnt");

    let hold = upfront_gas_cost(AGENT_GAS);
    let max_burn = burnt.iter().copied().max().unwrap_or(ZERO);
    let at_twice_the_price = hold.saturating_add(NearToken::from_yoctonear(
        max_burn.as_yoctonear().saturating_mul(2 * 9),
    ));
    assert!(
        at_twice_the_price <= TEN_PAYMENTS_ALLOWANCE,
        "the hold plus nine payments at twice the measured burn needs {at_twice_the_price}"
    );
    record_gas_report(&json!({
        "case": "ten ALLOW payments on the recommended allowance",
        "allowance_near": near(TEN_PAYMENTS_ALLOWANCE),
        "upfront_hold_near": near(hold),
        "burnt_per_payment_near": burnt.iter().map(|one| near(*one)).collect::<Vec<_>>(),
        "charged_near": near(charged),
        "left_near": near(left),
        "needed_at_twice_the_gas_price_near": near(at_twice_the_price),
    }));
}

/// The lowest prepaid gas, to the Tgas, at which an agent `pay` of one unit to `payee` with
/// `memo` settles, found by bisection between a figure known to be short and `AGENT_GAS`.
/// Every probe is held to the property that matters more than the number: a payment either
/// settles in full or fails CLEAN, with no token movement and the day's accounting untouched.
/// A probe that lands between "the agent's receipt could schedule its calls" and "every
/// callback had what it needed" is where a static budget smaller than its callback's need
/// shows: the payment is scheduled, the callback runs dry, and the reservation is stranded.
async fn floor_of(w: &World, case: &str, payee: &AccountId, memo: Option<&str>) -> u64 {
    let mut ok_tgas = AGENT_GAS.as_tgas();
    let mut short_tgas = 30;
    let mut probes = Vec::new();
    while ok_tgas - short_tgas > 1 {
        let probe = short_tgas + (ok_tgas - short_tgas) / 2;
        let paid_before = w.ft_balance(payee).await;
        let spent_before = w.spent_today().await;

        let tx = w
            .agent_call("pay", pay_args(payee, UNIT, memo))
            .gas(NearGas::from_tgas(probe))
            .send()
            .await;
        let sent = tx.is_success() && tx.outcome().status == "sent";
        let moved = w.ft_balance(payee).await - paid_before;
        let spent = w.spent_today().await;

        if sent {
            assert_eq!(
                moved, UNIT,
                "{case}, {probe} Tgas: sent, so the token moved"
            );
            assert_eq!(
                spent,
                spent_before + UNIT,
                "{case}, {probe} Tgas: sent and charged"
            );
            ok_tgas = probe;
        } else {
            assert_eq!(
                moved,
                0,
                "{case}, {probe} Tgas: tokens moved without a sent outcome: {}",
                tx.failure_text()
            );
            assert_eq!(
                spent,
                spent_before,
                "{case}, {probe} Tgas: a failed payment left its reservation behind: {}",
                tx.failure_text()
            );
            short_tgas = probe;
        }
        probes.push(
            json!({ "prepaid_tgas": probe, "sent": sent, "burnt_tgas": tgas(tx.gas_burnt()) }),
        );
    }
    record_gas_report(&json!({
        "case": format!("lowest prepaid gas that settles an ALLOW payment, {case}"),
        "lowest_ok_tgas": ok_tgas,
        "highest_short_tgas": short_tgas,
        "recommended_tgas": tgas(AGENT_GAS),
        "headroom_percent_of_recommended":
            100.0 * (1.0 - ok_tgas as f64 / AGENT_GAS.as_tgas() as f64),
        "probes": probes,
    }));
    ok_tgas
}

/// Where the floor is, for the lightest ALLOW and for the heaviest one the A-Identity registry
/// can produce: every field of the verdict at its registry limit, a memo at the vault's limit
/// and a payee whose account id is 64 bytes long and is not yet registered on the token. Both
/// must fail clean at every probe (`floor_of`), which is what proves `GAS_ON_VERDICT` and
/// `GAS_ON_TRANSFER` cover their callbacks on the heaviest paying path. And the recommended
/// `AGENT_GAS` keeps at least 30 percent headroom over the higher floor: the floor is at most
/// 70 percent of what an agent attaches.
#[tokio::test]
async fn an_underfunded_payment_fails_clean_and_the_floor_keeps_its_headroom() {
    // No cap and no ceiling, so a probe that did strand a reservation could not refuse the
    // next probe for a reason that has nothing to do with gas.
    let w = World::new(Setup::with_policy(0, 0)).await;
    w.set_verdict(&w.merchant, "ALLOW", &[]).await;
    let light = floor_of(&w, "light", &w.merchant, None).await;

    let heavy_payee: AccountId = format!("{}.sandbox", "h".repeat(56))
        .parse()
        .expect("a valid 64-byte account id");
    assert_eq!(heavy_payee.as_str().len(), 64);
    w.create_account(&heavy_payee, NearToken::from_near(1))
        .await;
    let reasons: Vec<String> = (0..8)
        .map(|n| format!("{}{n:02}", "r".repeat(30)))
        .collect();
    let evidence = format!("https://a-identity.xyz/e/{}", "x".repeat(231));
    assert_eq!(evidence.len(), 256);
    w.oracle_call(
        "set_verdict",
        json!({
            "account_id": heavy_payee,
            "verdict": "ALLOW",
            "reasons": reasons,
            "evidence": evidence,
            "score": 1000,
            "code_hash": "ab".repeat(32),
            "ttl_s": null,
        }),
    )
    .send()
    .await
    .assert_ok();
    let memo = "m".repeat(128);
    let heavy = floor_of(&w, "heaviest", &heavy_payee, Some(&memo)).await;

    let floor = light.max(heavy);
    // The headroom is what the vault's own callbacks inherit when a reply or a token costs
    // more than here, and a token on testnet does more work than mock-ft.
    assert!(
        floor * 100 <= AGENT_GAS.as_tgas() * ALLOW_FLOOR_SHARE_PERCENT,
        "AGENT_GAS ({} Tgas) keeps under 30 percent headroom over the measured floor ({floor} Tgas)",
        AGENT_GAS.as_tgas()
    );
}

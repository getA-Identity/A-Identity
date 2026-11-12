//! The registry on chain: who may write a verdict, what a report costs, and what an
//! expired verdict means for the vault that reads it.
//!
//! The registry's unit tests call its Rust methods directly, so two things they cannot
//! reach are covered here: the rules near-sdk enforces in the generated entry point (a
//! deposit on a method that is not payable), and a verdict's expiry as the vault sees it
//! through a real cross-contract read.

mod common;

use common::*;
use near_api::NearToken;
use near_sdk::serde_json::json;

#[tokio::test]
async fn only_an_oracle_writes_verdicts_and_only_the_owner_names_oracles() {
    let w = World::new(Setup::registry_only()).await;
    let deny = verdict_args(&w.attacker, "DENY", &["drainer"]);

    // Owning the registry is not being an oracle: the owner manages the oracle set and
    // nothing else.
    for caller in [&w.stranger, &w.owner] {
        w.call(caller, &w.registry, "set_verdict", deny.clone())
            .send()
            .await
            .assert_panicked_with("NotOracle");
    }
    assert!(w.verdict(&w.attacker).await.is_none());

    let tx = w.set_verdict(&w.attacker, "DENY", &["drainer"]).await;
    let set = tx.registry_event("verdict_set");
    assert_eq!(str_field(&set, "account_id"), w.attacker.as_str());
    assert_eq!(str_field(&set, "verdict"), "DENY");
    assert_eq!(str_list(&set, "reasons"), ["drainer"]);
    assert_eq!(str_field(&set, "by"), w.oracle.as_str());

    // The shape the vault parses cross-contract: a plain-string `verdict` at the top level.
    let raw: near_sdk::serde_json::Value = w
        .registry_view("get_verdict", account_arg(&w.attacker))
        .await;
    assert_eq!(raw["verdict"], "DENY");
    assert_decimal_string(&raw, "updated_at_ns");
    let verdict = w.verdict(&w.attacker).await.expect("written");
    assert_eq!(verdict.account_id, w.attacker.as_str());
    assert_eq!(verdict.reasons, ["drainer"]);
    assert_eq!(verdict.updated_by, w.oracle.as_str());
    assert!(verdict.expires_at_ns.is_none());
    assert_eq!(w.check(&w.attacker).await.verdict, "DENY");

    // Oracle writes are not payable, so an oracle can run on a function-call key that can
    // never attach a deposit. A deposit is refused by near-sdk, with its own message.
    w.oracle_call("set_verdict", deny.clone())
        .one_yocto()
        .send()
        .await
        .assert_panicked_with("Method set_verdict doesn't accept deposit");

    // The input rules reach the chain by name.
    w.oracle_call(
        "set_verdict",
        verdict_args(&w.attacker, "DENY", &["Not-A-Code"]),
    )
    .send()
    .await
    .assert_panicked_with("InvalidReason");
    let mut out_of_range = verdict_args(&w.attacker, "ALLOW", &[]);
    out_of_range["score"] = json!(1001);
    w.oracle_call("set_verdict", out_of_range)
        .send()
        .await
        .assert_panicked_with("ScoreOutOfRange");
    assert_eq!(
        w.verdict(&w.attacker).await.expect("unchanged").verdict,
        "DENY"
    );

    // Batches follow the same rule.
    let batch = json!({ "entries": [
        verdict_args(&w.merchant, "ALLOW", &["known_merchant"]),
        verdict_args(&w.newshop, "WARN", &["new_account"]),
    ] });
    w.call(&w.stranger, &w.registry, "set_verdicts", batch.clone())
        .send()
        .await
        .assert_panicked_with("NotOracle");
    let tx = w
        .oracle_call("set_verdicts", batch)
        .send()
        .await
        .assert_ok();
    assert_eq!(tx.registry_events().len(), 2);
    assert_eq!(w.check(&w.newshop).await.verdict, "WARN");

    // Clearing is an oracle write too.
    w.call(
        &w.stranger,
        &w.registry,
        "clear_verdict",
        account_arg(&w.attacker),
    )
    .send()
    .await
    .assert_panicked_with("NotOracle");
    let tx = w
        .oracle_call("clear_verdict", account_arg(&w.attacker))
        .send()
        .await
        .assert_ok();
    let cleared = tx.registry_event("verdict_cleared");
    assert_eq!(str_field(&cleared, "by"), w.oracle.as_str());
    assert!(w.verdict(&w.attacker).await.is_none());
    assert_eq!(w.check(&w.attacker).await.verdict, "NONE");

    // The owner names oracles, with the yocto, and every change is an event.
    w.call(
        &w.stranger,
        &w.registry,
        "add_oracle",
        account_arg(&w.stranger),
    )
    .one_yocto()
    .send()
    .await
    .assert_panicked_with("NotOwner");
    w.call(
        &w.owner,
        &w.registry,
        "add_oracle",
        account_arg(&w.stranger),
    )
    .send()
    .await
    .assert_panicked_with("RequiresOneYocto");
    let tx = w
        .registry_owner_call("add_oracle", account_arg(&w.stranger))
        .send()
        .await
        .assert_ok();
    assert_eq!(
        str_field(&tx.registry_event("oracle_added"), "account_id"),
        w.stranger.as_str()
    );
    let tx = w
        .call(&w.stranger, &w.registry, "set_verdict", deny.clone())
        .send()
        .await
        .assert_ok();
    assert_eq!(
        str_field(&tx.registry_event("verdict_set"), "by"),
        w.stranger.as_str()
    );
    let tx = w
        .registry_owner_call("remove_oracle", account_arg(&w.stranger))
        .send()
        .await
        .assert_ok();
    assert_eq!(
        str_field(&tx.registry_event("oracle_removed"), "account_id"),
        w.stranger.as_str()
    );
    w.call(&w.stranger, &w.registry, "set_verdict", deny)
        .send()
        .await
        .assert_panicked_with("NotOracle");
    let oracles: Vec<String> = w
        .registry_view("oracles", near_sdk::serde_json::json!({}))
        .await;
    assert_eq!(oracles, [w.oracle.to_string()]);
}

/// A report is input for an oracle's review and never a verdict by itself. It costs
/// `REPORT_DEPOSIT`, kept in full, because anyone can file one.
#[tokio::test]
async fn a_report_costs_the_deposit_and_the_registry_keeps_it() {
    let w = World::new(Setup::registry_only()).await;
    let args = report_args(&w.attacker, "phishing", "https://example.com/evidence/1");

    w.call(&w.stranger, &w.registry, "report", args.clone())
        .deposit(NearToken::from_yoctonear(REPORT_DEPOSIT.as_yoctonear() - 1))
        .send()
        .await
        .assert_panicked_with("ReportDepositTooLow");
    w.call(
        &w.attacker,
        &w.registry,
        "report",
        report_args(&w.attacker, "phishing", ""),
    )
    .deposit(REPORT_DEPOSIT)
    .send()
    .await
    .assert_panicked_with("SelfReport");
    assert_eq!(w.check(&w.attacker).await.reports.0, 0);

    let registry_before = w.near_balance(&w.registry).await;
    let reporter_before = w.near_balance(&w.stranger).await;
    let tx = w
        .call(&w.stranger, &w.registry, "report", args.clone())
        .deposit(REPORT_DEPOSIT)
        .send()
        .await
        .assert_ok();
    let filed = tx.registry_event("report_filed");
    assert_eq!(str_field(&filed, "account_id"), w.attacker.as_str());
    assert_eq!(str_field(&filed, "reporter"), w.stranger.as_str());
    assert_eq!(str_field(&filed, "reason"), "phishing");
    assert_eq!(
        str_field(&filed, "evidence"),
        "https://example.com/evidence/1"
    );
    // Kept whole: the registry gained at least the deposit, and the reporter paid at least it.
    let registry_after = w.near_balance(&w.registry).await;
    let reporter_after = w.near_balance(&w.stranger).await;
    assert!(
        registry_after.as_yoctonear()
            >= registry_before.as_yoctonear() + REPORT_DEPOSIT.as_yoctonear(),
        "the registry kept {registry_before} -> {registry_after}"
    );
    assert!(
        reporter_before.as_yoctonear()
            >= reporter_after.as_yoctonear() + REPORT_DEPOSIT.as_yoctonear(),
        "the reporter paid {reporter_before} -> {reporter_after}"
    );

    let reports: Vec<ReportView> = w
        .registry_view("get_reports", account_arg(&w.attacker))
        .await;
    assert_eq!(reports.len(), 1);
    assert_eq!(reports[0].reporter, w.stranger.as_str());
    assert_eq!(reports[0].reason, "phishing");
    let count: u64 = w
        .registry_view("report_count", account_arg(&w.attacker))
        .await;
    assert_eq!(count, 1);
    let check = w.check(&w.attacker).await;
    assert_eq!(check.reports.0, 1);
    assert_eq!(
        check.verdict, "NONE",
        "a report is input for review, not a verdict"
    );

    // One open report per reporter.
    w.call(&w.stranger, &w.registry, "report", args.clone())
        .deposit(REPORT_DEPOSIT)
        .send()
        .await
        .assert_panicked_with("DuplicateReport");

    // An oracle's review clears the open reports; the lifetime count stays.
    w.call(
        &w.stranger,
        &w.registry,
        "clear_reports",
        account_arg(&w.attacker),
    )
    .send()
    .await
    .assert_panicked_with("NotOracle");
    let tx = w
        .oracle_call("clear_reports", account_arg(&w.attacker))
        .send()
        .await
        .assert_ok();
    assert_eq!(
        str_field(&tx.registry_event("reports_cleared"), "by"),
        w.oracle.as_str()
    );
    let reports: Vec<ReportView> = w
        .registry_view("get_reports", account_arg(&w.attacker))
        .await;
    assert!(reports.is_empty());
    let count: u64 = w
        .registry_view("report_count", account_arg(&w.attacker))
        .await;
    assert_eq!(count, 1);
    assert_eq!(w.check(&w.attacker).await.reports.0, 0);

    // After the review the same reporter may report again.
    w.call(&w.stranger, &w.registry, "report", args)
        .deposit(REPORT_DEPOSIT)
        .send()
        .await
        .assert_ok();
}

/// An expired verdict reads exactly like no verdict, including an expired DENY. A TTL on a
/// DENY is a decision to let the payee be paid again once it lapses, and this test shows that
/// decision taking effect through the vault: the payee is no longer refused. Nobody vouches for
/// it either (the vault never paid it and the owner never listed it), so under the vault's
/// `hold_unknown` (amendment A1, on by default) the payment waits for the owner, who can then
/// pay it.
#[tokio::test]
async fn an_expired_verdict_reads_as_none_and_the_vault_acts_on_that() {
    let w = World::new(Setup::default()).await;
    let ttl_s = 60;

    w.oracle_call(
        "set_verdict",
        verdict_args_with_ttl(&w.attacker, "DENY", &["drainer"], ttl_s),
    )
    .send()
    .await
    .assert_ok();
    let live = w.verdict(&w.attacker).await.expect("live");
    let expires_at_ns = live.expires_at_ns.expect("a TTL gives a deadline").0;
    assert_eq!(expires_at_ns, live.updated_at_ns.0 + ttl_s * NS_PER_S);

    w.pay(&w.attacker, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_refused("RegistryDeny");

    w.advance_time_past_ns(expires_at_ns).await;
    assert!(
        w.verdict(&w.attacker).await.is_none(),
        "an expired verdict reads exactly like no verdict"
    );
    assert_eq!(w.check(&w.attacker).await.verdict, "NONE");
    // The enumeration still shows it, so an operator can see what lapsed.
    let listed: Vec<VerdictView> = w
        .registry_view(
            "list_verdicts",
            json!({ "from_index": null, "limit": null }),
        )
        .await;
    assert!(
        listed
            .iter()
            .any(|entry| entry.account_id == w.attacker.as_str())
    );

    let tx = w.pay(&w.attacker, UNIT, None).await.assert_ok();
    let held_id = tx.outcome().assert_held_because("UnknownPayee");
    assert!(!tx.touched(&w.token));
    assert_eq!(w.ft_balance(&w.attacker).await, 0);
    w.owner_pay(held_id)
        .await
        .assert_ok()
        .outcome()
        .assert_sent();
    assert_eq!(w.ft_balance(&w.attacker).await, UNIT);

    // A TTL of "0" means no expiry, never "already expired".
    w.oracle_call(
        "set_verdict",
        verdict_args_with_ttl(&w.attacker, "DENY", &["drainer"], 0),
    )
    .send()
    .await
    .assert_ok();
    let verdict = w.verdict(&w.attacker).await.expect("live");
    assert!(verdict.expires_at_ns.is_none());
    w.pay(&w.attacker, UNIT, None)
        .await
        .assert_ok()
        .outcome()
        .assert_refused("RegistryDeny");
}

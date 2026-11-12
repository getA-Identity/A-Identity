//! Unit tests.
//!
//! These run the contract as native Rust against near-sdk's mocked blockchain, which executes
//! every host call through nearcore's own host-function code. Two things this layer cannot show,
//! and where they are covered instead:
//!
//! * The `#[private]` and "doesn't accept deposit" checks are generated into the wasm entry
//!   point only, so calling a method directly here skips them. The callbacks' own
//!   `require_callback` check is tested here; the macro checks belong to `sandbox-tests`.
//! * A panic does not roll state back here the way the protocol does, so no test reads state
//!   after a panic it provoked. Panics are asserted by their stable name.
//!
//! Two properties of the mocked blockchain every helper below is shaped around:
//!
//! * `testing_env!` hands the trie from one context to the next for the whole test thread, and
//!   `store` collections flush into it when they are dropped. So every vault a test deploys
//!   starts on an empty trie (`begin`), the way a new account starts with empty storage;
//!   otherwise a vault a loop dropped would leave its agent keys under the same prefixes and
//!   the next vault's first `add_agent_key` would answer `KeyExists`.
//! * Block time belongs to the context. `advance_s` moves the clock the NEXT context is built
//!   with, so a test that moves the clock and then reads a view enters one first (`as_viewer`).
//!
//! And one property of the vault: with `hold_unknown` on (its default), an agent `pay` to a
//! payee the registry is silent on is held unless the payee is known. Every vault `fresh_vault`
//! deploys keeps that default and has the owner list `shop()` and `other_shop()` (the allowlist
//! gate stays off), the way an owner lists the vendors its agent pays, so the tests of the
//! transfer path run against the default policy. `newcomer()` is never listed and never paid:
//! it is the payee nobody has judged (`test/unknown.rs`).

mod agent;
mod auth;
mod callbacks;
mod counters;
mod errors;
mod gas;
mod ladder;
mod owner;
mod unknown;
mod verdict;
mod views;

use std::cell::Cell;

use near_sdk::json_types::{U64, U128};
use near_sdk::mock::MockAction;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{
    AccountId, CurveType, Gas, MockedBlockchain, NearToken, PromiseOrValue, PromiseResult,
    PublicKey, RuntimeFeesConfig, test_vm_config, testing_env,
};

use crate::{AgentSpendPolicy, PayOutcome, PaymentCtx};

pub const DAY_S: u64 = 86_400;
/// 2026-11-12 12:00:00 UTC (UTC day 20769). Noon, so a test can move a few hours either way
/// without crossing a day boundary by accident.
pub const T0_S: u64 = 1_794_484_800;
pub const T0_DAY: u64 = 20_769;
/// A typical NEP-145 `storage_balance_bounds().min`: 0.00125 NEAR.
pub const STORAGE_DEPOSIT: u128 = 1_250_000_000_000_000_000_000;
/// 0.25 NEAR of gas allowance, what wallets give a function-call key.
pub const ALLOWANCE: u128 = 250_000_000_000_000_000_000_000;
/// 100 NEAR, the mocked account's default balance.
pub const DEFAULT_BALANCE: u128 = 100_000_000_000_000_000_000_000_000;

thread_local! {
    static NOW_NS: Cell<u64> = const { Cell::new(T0_S * 1_000_000_000) };
    static BALANCE: Cell<u128> = const { Cell::new(DEFAULT_BALANCE) };
}

pub fn vault() -> AccountId {
    "vault.owner.testnet".parse().unwrap()
}
pub fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}
pub fn token() -> AccountId {
    "usdc.testnet".parse().unwrap()
}
pub fn registry() -> AccountId {
    "registry.a-identity.testnet".parse().unwrap()
}
pub fn shop() -> AccountId {
    "shop.testnet".parse().unwrap()
}
pub fn other_shop() -> AccountId {
    "other-shop.testnet".parse().unwrap()
}
pub fn stranger() -> AccountId {
    "stranger.testnet".parse().unwrap()
}
/// A payee no vault in these tests lists or has paid, and no mocked registry answer vouches
/// for: what `hold_unknown` exists for.
pub fn newcomer() -> AccountId {
    "newcomer.testnet".parse().unwrap()
}

/// A distinct, valid ed25519 public key per `n`.
pub fn key(n: u8) -> PublicKey {
    PublicKey::from_parts(CurveType::ED25519, vec![n; 32]).unwrap()
}
/// The agent key every `fresh_vault` grants.
pub fn agent() -> PublicKey {
    key(1)
}
/// The owner's own full-access key. Never registered with the vault.
pub fn owner_key() -> PublicKey {
    key(200)
}

// -- the clock and the balance ---------------------------------------------------------------

pub fn now_ns() -> u64 {
    NOW_NS.with(Cell::get)
}
pub fn set_now_s(s: u64) {
    NOW_NS.with(|n| n.set(s * 1_000_000_000));
}
pub fn advance_s(ds: u64) {
    NOW_NS.with(|n| n.set(n.get() + ds * 1_000_000_000));
}
pub fn set_balance(yocto: u128) {
    BALANCE.with(|b| b.set(yocto));
}

// -- execution contexts ----------------------------------------------------------------------

/// The protocol's per-transaction ceiling, and the mock's default prepaid gas.
pub const MAX_PREPAID_GAS: Gas = Gas::from_tgas(1_000);

/// Point the mocked blockchain at a new receipt executing on the vault.
pub fn env_as(
    predecessor: AccountId,
    signer_pk: PublicKey,
    deposit_yocto: u128,
    results: Vec<PromiseResult>,
) {
    enter(
        predecessor,
        signer_pk,
        deposit_yocto,
        results,
        MAX_PREPAID_GAS,
        RuntimeFeesConfig::test(),
    );
}

fn enter(
    predecessor: AccountId,
    signer_pk: PublicKey,
    deposit_yocto: u128,
    results: Vec<PromiseResult>,
    prepaid_gas: Gas,
    fees: RuntimeFeesConfig,
) {
    let context = VMContextBuilder::new()
        .current_account_id(vault())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .signer_account_pk(signer_pk)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .account_balance(NearToken::from_yoctonear(BALANCE.with(Cell::get)))
        .block_timestamp(now_ns())
        .prepaid_gas(prepaid_gas)
        .build();
    testing_env!(context, test_vm_config(), fees, Default::default(), results);
}

pub fn as_owner(deposit_yocto: u128) {
    env_as(owner(), owner_key(), deposit_yocto, vec![]);
}
pub fn as_owner_yocto() {
    as_owner(1);
}
/// A transaction the agent signed with its function-call key: it arrives FROM the vault account.
pub fn as_agent_key(pk: PublicKey) {
    env_as(vault(), pk, 0, vec![]);
}
pub fn as_agent() {
    as_agent_key(agent());
}
/// The agent's transaction with exactly `prepaid_gas` attached, for the gas tests.
///
/// The mock runs nearcore's own host functions, so a promise whose static gas does not fit in
/// what is left aborts here as it would on chain. Two things it cannot show, which is why these
/// contexts charge no action fees: native code burns no wasm gas, and the mock's test fees are
/// pre-protocol-66 values, several times what testnet charges today. So these contexts check
/// the static schedule exactly, and `test/gas.rs` pins the measured overheads on top.
pub fn as_agent_with_gas(prepaid_gas: Gas) {
    enter(
        vault(),
        agent(),
        0,
        vec![],
        prepaid_gas,
        RuntimeFeesConfig::free(),
    );
}
/// A callback receipt with exactly `prepaid_gas` and no action fees (see `as_agent_with_gas`):
/// what its static budget alone gives it when the caller left nothing over.
pub fn as_callback_with_gas(results: Vec<PromiseResult>, prepaid_gas: Gas) {
    enter(
        vault(),
        agent(),
        0,
        results,
        prepaid_gas,
        RuntimeFeesConfig::free(),
    );
}
pub fn as_stranger() {
    env_as(stranger(), key(99), 0, vec![]);
}
/// The receipt a NEP-366 delegate action becomes: `pk` signed the action as the vault, so the
/// predecessor is the vault, but the transaction around it came from `relayer`, so the signer
/// account (and, when the relayer holds the same public key, the signer's key) is the
/// relayer's. What nearcore builds for the inner receipt, field for field.
pub fn as_relayed(relayer: AccountId, pk: PublicKey) {
    let context = VMContextBuilder::new()
        .current_account_id(vault())
        .signer_account_id(relayer)
        .predecessor_account_id(vault())
        .signer_account_pk(pk)
        .account_balance(NearToken::from_yoctonear(BALANCE.with(Cell::get)))
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
/// The implicit account of `pk`: the 64 hex characters of its 32 key bytes. Anyone can create
/// it with a plain transfer, and its only key is `pk` with full access, which is how a thief
/// holding a leaked agent key gets an account to relay from.
pub fn implicit_account_of(pk: &PublicKey) -> AccountId {
    // A near-sdk `PublicKey` is the curve byte followed by the key bytes.
    let hex: String = pk.as_bytes()[1..]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    hex.parse().unwrap()
}
/// A view call at the current test clock. Views read block time from the context, so this is
/// what a test enters after `advance_s` and before it reads `today`, `spent_today` or
/// `remaining_today`.
pub fn as_viewer() {
    as_stranger();
}
/// A callback receipt: from the vault to itself, with the given promise results.
pub fn as_callback(results: Vec<PromiseResult>) {
    env_as(vault(), agent(), 0, results);
}
pub fn ok_json(json: &str) -> PromiseResult {
    PromiseResult::Successful(json.as_bytes().to_vec())
}
pub fn ok_bytes(bytes: &[u8]) -> PromiseResult {
    PromiseResult::Successful(bytes.to_vec())
}
pub fn failed() -> PromiseResult {
    PromiseResult::Failed
}

// -- setup -----------------------------------------------------------------------------------

/// Start over: an empty mocked trie, the clock at `T0`, the default balance, and the owner's
/// context. Every vault a test deploys is deployed right after this (see the module docs).
pub fn begin() {
    set_now_s(T0_S);
    set_balance(DEFAULT_BALANCE);
    near_sdk::env::set_blockchain_interface(MockedBlockchain::new(
        VMContextBuilder::new().current_account_id(vault()).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Vec::new(),
        Default::default(),
        Default::default(),
        None,
    ));
    as_owner(0);
}

/// A vault at `T0` with one active agent key, `agent()`, and no expiry. `hold_unknown` keeps
/// its default (on), and `shop()` and `other_shop()` are known payees: listed by the owner,
/// with the allowlist gate off (see the module docs).
pub fn fresh_vault(
    registry_id: Option<AccountId>,
    daily_cap: u128,
    ceiling: u128,
) -> AgentSpendPolicy {
    begin();
    let mut vault = AgentSpendPolicy::new(
        owner(),
        token(),
        registry_id,
        U128(STORAGE_DEPOSIT),
        U128(daily_cap),
        U128(ceiling),
    );
    for payee in known_payees() {
        as_owner_yocto();
        vault.set_allowed(payee, true);
    }
    grant(&mut vault, agent());
    vault
}

/// The payees `fresh_vault` lists, in listing order.
pub fn known_payees() -> [AccountId; 2] {
    [shop(), other_shop()]
}

/// The common case: no registry, 1000-unit cap, 100-unit ceiling.
pub fn plain_vault() -> AgentSpendPolicy {
    fresh_vault(None, 1_000, 100)
}

/// The same with a registry, so payments stop at the verdict check.
pub fn registry_vault() -> AgentSpendPolicy {
    fresh_vault(Some(registry()), 1_000, 100)
}

pub fn grant(vault: &mut AgentSpendPolicy, pk: PublicKey) {
    as_owner_yocto();
    vault
        .add_agent_key(pk, "test agent".to_owned(), U64(0), U128(ALLOWANCE))
        .detach();
}

// -- reading results -------------------------------------------------------------------------

pub fn value<T>(out: PromiseOrValue<T>) -> T {
    match out {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(p) => {
            // Never dropped: dropping a promise schedules its receipts, and in a context with
            // little gas that panics inside the unwind, which aborts the whole test binary and
            // loses every other test's result.
            std::mem::forget(p);
            panic!("expected a value, got a promise")
        }
    }
}

/// Assert the call returned a promise, and build its receipts by dropping it.
pub fn promise<T>(out: PromiseOrValue<T>) {
    match out {
        PromiseOrValue::Promise(p) => p.detach(),
        PromiseOrValue::Value(_) => panic!("expected a promise, got a value"),
    }
}

/// Every `EVENT_JSON` log of the current receipt, checked for the NEP-297 envelope.
pub fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .map(|json| {
            let event: Value = serde_json::from_str(json).unwrap();
            assert_eq!(event["standard"], "a_identity_vault");
            assert_eq!(event["version"], "1.0.0");
            event
        })
        .collect()
}

pub fn event_names() -> Vec<String> {
    events()
        .iter()
        .map(|e| e["event"].as_str().unwrap().to_owned())
        .collect()
}

/// The `data` of the only event with this name.
pub fn event(name: &str) -> Value {
    let matching: Vec<Value> = events()
        .into_iter()
        .filter(|e| e["event"] == name)
        .collect();
    assert_eq!(
        matching.len(),
        1,
        "expected one {name} event, got {}",
        matching.len()
    );
    matching[0]["data"].clone()
}

#[derive(Debug, Clone)]
pub struct Call {
    pub receiver: AccountId,
    pub method: String,
    pub args: Value,
    pub deposit: NearToken,
    pub gas: Gas,
    pub weight: u64,
}

/// Every function call the receipt scheduled, in creation order.
pub fn calls() -> Vec<Call> {
    let mut out = Vec::new();
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                prepaid_gas,
                gas_weight,
                ..
            } = action
            {
                out.push(Call {
                    receiver: receipt.receiver_id.clone(),
                    method: String::from_utf8(method_name).unwrap(),
                    args: serde_json::from_slice(&args).unwrap_or(Value::Null),
                    deposit: attached_deposit,
                    gas: prepaid_gas,
                    weight: gas_weight.0,
                });
            }
        }
    }
    out
}

pub fn call_names() -> Vec<String> {
    calls().into_iter().map(|c| c.method).collect()
}

/// The `ctx` argument of the scheduled callback `method`, exactly as the vault will receive it.
pub fn scheduled_ctx(method: &str) -> PaymentCtx {
    let call = calls()
        .into_iter()
        .find(|c| c.method == method)
        .unwrap_or_else(|| panic!("no {method} call was scheduled"));
    serde_json::from_value(call.args["ctx"].clone()).unwrap()
}

/// Run `f`, require it to panic, and return the panic text.
pub fn panic_text<F: FnOnce()>(f: F) -> String {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f))
        .expect_err("expected the call to panic");
    if let Some(s) = err.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = err.downcast_ref::<&str>() {
        (*s).to_owned()
    } else {
        String::new()
    }
}

/// Require `f` to abort the receipt with exactly this stable error name.
pub fn assert_panics_with<F: FnOnce()>(name: &str, f: F) {
    let text = panic_text(f);
    assert!(
        text.contains(&format!("panic_msg: \"{name}\"")),
        "expected the receipt to abort with {name}, got: {text}"
    );
}

pub fn assert_refused(out: &PayOutcome, reason: &str) {
    assert_eq!(out.status, crate::PayStatus::Refused, "{out:?}");
    assert_eq!(out.reason.as_deref(), Some(reason), "{out:?}");
}

pub fn assert_status(out: &PayOutcome, status: crate::PayStatus) {
    assert_eq!(out.status, status, "{out:?}");
}

/// A memo or reason of exactly `n` bytes.
pub fn text(n: usize) -> String {
    "m".repeat(n)
}

/// What one per-payee counter (`paid_count`, `refusals`, `guard_refusals`) adds to storage: the
/// collection's one-byte prefix, the payee id as borsh (a 4-byte length and its bytes), the u32
/// count, and the 40 bytes the protocol charges for every record. So `len(payee) + 49`.
pub fn counter_entry_bytes(payee: &AccountId) -> u64 {
    u64::try_from(payee.as_str().len()).unwrap() + 49
}

pub fn u128_of(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

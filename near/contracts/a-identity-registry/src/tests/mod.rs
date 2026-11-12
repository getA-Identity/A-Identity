//! Unit tests, against near-sdk's mocked blockchain (`testing_env!`).
//!
//! What these can and cannot see. They call the contract's Rust methods directly, so they
//! exercise every guard this crate writes. They do not go through the generated wasm entry
//! points, so the SDK's own guards (a deposit on a non-payable method, a second `new`) and
//! the JSON argument parsing are covered by the sandbox tests, not here.
//!
//! A refused call panics. `expect_err` catches the panic and requires the exact stable name
//! as the mocked host recorded it (`GuestPanic { panic_msg: "<Name>" }`), so a test cannot
//! pass on a different error whose name happens to contain the expected one.

mod abi;
mod admin;
mod batch;
mod expiry;
mod init;
mod reports;
mod rules;
mod verdicts;
mod views;

use std::panic::{AssertUnwindSafe, catch_unwind};

use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{AccountId, NearToken, testing_env};

use crate::{Error, Registry, Verdict, VerdictInput};

/// A realistic block time (2023-11-14), in nanoseconds.
pub const T0: u64 = 1_700_000_000_000_000_000;
pub const NO_DEPOSIT: NearToken = NearToken::from_yoctonear(0);
pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

pub fn acc(id: &str) -> AccountId {
    id.parse().unwrap()
}
pub fn registry_id() -> AccountId {
    acc("registry.near")
}
pub fn owner() -> AccountId {
    acc("owner.near")
}
pub fn oracle() -> AccountId {
    acc("oracle.near")
}
pub fn oracle2() -> AccountId {
    acc("oracle2.near")
}
pub fn stranger() -> AccountId {
    acc("stranger.near")
}
pub fn payee() -> AccountId {
    acc("payee.near")
}

/// Set the context for the calls that follow: who calls, what it attaches, and the block
/// time. The signer is the caller too; `call_signed` separates them.
pub fn call(predecessor: &AccountId, deposit: NearToken, now_ns: u64) {
    call_signed(predecessor, predecessor, deposit, now_ns);
}

pub fn call_signed(signer: &AccountId, predecessor: &AccountId, deposit: NearToken, now_ns: u64) {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(registry_id())
        .signer_account_id(signer.clone())
        .predecessor_account_id(predecessor.clone())
        .attached_deposit(deposit)
        .block_timestamp(now_ns);
    testing_env!(builder.build());
}

/// Start over on an empty mocked trie, as the owner, at `T0`.
///
/// `testing_env!` carries storage from one context to the next on purpose, so the calls in
/// one test share state the way consecutive transactions do. The cost is that a second
/// registry built in the same test would find the first one's flushed collections under the
/// same prefixes and read them as its own. Every registry a test builds starts here.
pub fn begin() {
    let mut builder = VMContextBuilder::new();
    builder.current_account_id(registry_id());
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        builder.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Vec::new(),
        Default::default(),
        Default::default(),
        None,
    ));
    call(&owner(), NO_DEPOSIT, T0);
}

/// A registry owned by `owner()` with `oracle()` as its only oracle, at `T0`.
pub fn fresh() -> Registry {
    begin();
    Registry::new(owner(), vec![oracle()])
}

/// A minimal valid entry.
pub fn entry(account_id: &AccountId, verdict: Verdict) -> VerdictInput {
    VerdictInput {
        account_id: account_id.clone(),
        verdict,
        reasons: vec!["test_reason".to_string()],
        evidence: Some("https://a-identity.xyz/e/1".to_string()),
        score: Some(100),
        code_hash: None,
        ttl_s: None,
    }
}

/// `set_verdict` with an entry's fields, so tests can build one value and send it either way.
pub fn set(registry: &mut Registry, input: VerdictInput) {
    registry.set_verdict(
        input.account_id,
        input.verdict,
        input.reasons,
        input.evidence,
        input.score,
        input.code_hash,
        input.ttl_s,
    );
}

/// As the oracle at `now_ns`, write a verdict.
pub fn oracle_sets(registry: &mut Registry, input: VerdictInput, now_ns: u64) {
    call(&oracle(), NO_DEPOSIT, now_ns);
    set(registry, input);
}

pub fn ttl(seconds: u64) -> Option<U64> {
    Some(U64(seconds))
}

/// Run `f` and require that it panics with exactly `want`'s stable name.
pub fn expect_err<R>(want: Error, f: impl FnOnce() -> R) {
    let payload = match catch_unwind(AssertUnwindSafe(f)) {
        Ok(_) => panic!("expected {} but the call succeeded", want.as_str()),
        Err(payload) => payload,
    };
    let message = payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default();
    let needle = format!("GuestPanic {{ panic_msg: \"{}\" }}", want.as_str());
    assert!(
        message.contains(&needle),
        "expected {needle}, got: {message}"
    );
}

/// The NEP-297 events logged since the last context change, parsed.
pub fn events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
        .map(|json| serde_json::from_str(json).unwrap())
        .collect()
}

/// Event names logged since the last context change, in order.
pub fn event_names() -> Vec<String> {
    events()
        .iter()
        .map(|event| event["event"].as_str().unwrap().to_string())
        .collect()
}

/// A string of `len` bytes of `byte`.
pub fn bytes(byte: char, len: usize) -> String {
    std::iter::repeat_n(byte, len).collect()
}

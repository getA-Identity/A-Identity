//! The shared sandbox harness.
//!
//! One local near-sandbox per test, so no test can see another test's state, and the three
//! contracts built ONCE per test binary with `cargo near build`, each from its own
//! manifest. That is the same command the deploy uses, so the artifact under test is the
//! artifact that ships, ABI and all.
//!
//! The world a full `Setup` starts from:
//!
//! * `token.sandbox`: mock-ft, 6 decimals like USDC. `owner.sandbox` holds the supply.
//! * `registry.sandbox`: the A-Identity registry, owned by `owner.sandbox`, with one
//!   oracle, `oracle.sandbox`.
//! * `vault.sandbox`: the vault, owned by `owner.sandbox`, pointed at the token and the
//!   registry, funded through `ft_transfer_call`, and holding ONE agent key that the vault
//!   itself added through `add_agent_key`.
//! * `merchant`, `attacker` and `stranger` are registered on the token. `newshop` is left
//!   unregistered on purpose: paying it is what exercises the vault's own NEP-145
//!   registration of a payee.
//! * With both the registry and the vault deployed, the oracle has judged `merchant` ALLOW
//!   (`known_merchant`). The vault holds a payee nobody has judged (`hold_unknown`, on by
//!   default), and `merchant` is the payee every guard test pays, so it starts judged the way
//!   a real merchant would be. Nobody has judged `newshop`, `attacker` or `stranger`.
//!
//! Every account here is created by sandbox state patching with the sandbox genesis key as
//! its full-access key, the vault account included. That is a property of the harness, not
//! of a deployment, and it is useful: it lets a test sign as the vault with a key that is
//! not a registered agent key and watch the contract refuse it. The agent never touches
//! that key. It signs as the vault account with its own function-call key, exactly as it
//! would on testnet.
//!
//! Two rules the helpers enforce, because a vacuous test is worse than no test:
//!
//! * A refusal is asserted by NAME. The spec makes the error names public ABI, so
//!   `Tx::assert_panicked_with` and `PayOutcome::assert_refused` compare names. A test
//!   that only checked "it failed" would pass just as happily against a contract that
//!   failed for the wrong reason, or against a guard that degenerated into a gas panic.
//! * "Rejected by the protocol" and "refused by the contract" are different claims and get
//!   different helpers. `assert_protocol_rejected` is for the first: an access-key rule
//!   stopped the transaction before or instead of the contract, and the text names the rule.
//!
//! Environment:
//!
//! * `cargo near` must be on PATH; the builds shell out to it.
//! * `SANDBOX_TESTS_PARALLEL` caps how many sandboxes one test binary runs at once
//!   (default 4). Each is a full neard process, and a laptop running a dozen of them in
//!   parallel produces blocks slowly enough to turn timing margins into flakes.
//! * `NEAR_SANDBOX_BIN_PATH` is near-sandbox's own: point it at an already downloaded
//!   `near-sandbox` binary to skip the download into a fresh target directory.
//! * `SANDBOX_GAS_REPORT`, when set, is a file the gas tests append one JSON line per
//!   measurement to. They print the same lines either way (`-- --nocapture` shows them).
//!
//! Time: `sandbox_fast_forward` moves the block clock about 15 times faster than the wall
//! clock on near-sandbox 2.14.0 (100 blocks, about 30 s of block time, in about 1.4 s).
//! That makes a key expiry or a verdict TTL of a minute cheap to cross, and a held
//! payment's 24 h time to live too slow for this suite: the vault's unit tests own that one.
//!
//! The vault's day index is UTC. A run that straddles 00:00 UTC can see `spent_today` roll
//! over in the middle of a cap test; that is the contract being right, not the test.

#![allow(dead_code)] // each test binary uses a different part of the harness

use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use cargo_near_build::camino::Utf8PathBuf;
use near_api::advanced::ExecuteSignedTransaction;
use near_api::errors::ExecuteTransactionError;
use near_api::signer::generate_secret_key;
use near_api::types::account::ContractState;
use near_api::types::transaction::actions::{
    AccessKey, AccessKeyPermission, FunctionCallAction, FunctionCallPermission, TransferAction,
};
use near_api::types::transaction::result::{ExecutionFinalResult, TransactionResult};
use near_api::types::{Action, TxExecutionStatus};
use near_api::{
    Account, AccountId, Chain, Contract, NearGas, NearToken, NetworkConfig, PublicKey, SecretKey,
    Signer, Transaction,
};
use near_sandbox::Sandbox;
use near_sandbox::config::{
    DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY, DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY,
};
use near_sdk::serde::de::{DeserializeOwned, Error as _};
use near_sdk::serde::{Deserialize, Deserializer};
use near_sdk::serde_json::{self, Value, json};
use tokio::sync::{Semaphore, SemaphorePermit};

// ---------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------

/// One whole mock-USDC. mock-ft has 6 decimals, like Circle's USDC, so amounts here read
/// the way they will on testnet.
pub const UNIT: u128 = 1_000_000;

/// The supply `owner.sandbox` receives at token init.
pub const TOTAL_SUPPLY: u128 = 1_000_000_000 * UNIT;

/// Policy defaults for a full `Setup`: a cap and a ceiling that are both live, so a test
/// that forgets to set its own policy still runs against bounds rather than against none.
pub const DEFAULT_DAILY_CAP: u128 = 100 * UNIT;
pub const DEFAULT_AUTO_APPROVE_MAX: u128 = 20 * UNIT;
pub const DEFAULT_FUND: u128 = 500 * UNIT;

/// The prepaid gas an agent attaches to every call: the vault's own `AGENT_PREPAID_GAS`, the
/// one figure the SDK and the docs quote. The agent path here uses it and nothing larger, so
/// a vault whose payment chain needs more than the SDK will attach fails here first. The
/// spec started from 200 Tgas; the vault's static budgets were measured and trimmed, because
/// every attached Tgas is held from the key's allowance up front, and 73 is the smallest
/// figure that keeps 30 percent headroom over the measured floor. `gas.rs` holds this
/// constant equal to the vault's, so the two cannot drift apart silently.
pub const AGENT_GAS: NearGas = NearGas::from_tgas(73);

/// Owner and admin calls get the generous figure; they are not what is being measured.
pub const OWNER_GAS: NearGas = NearGas::from_tgas(300);

/// The NEAR gas allowance on the agent key. It caps gas spend, never tokens. At `AGENT_GAS`
/// each transaction in flight holds 0.073 NEAR of it, and what is burnt (well under 0.01 NEAR
/// a payment) is all that stays charged, so 5 NEAR covers any test here many times over.
pub const AGENT_ALLOWANCE: NearToken = NearToken::from_near(5);

/// The exact method list the vault grants its agent key, in the spec's order.
pub const AGENT_METHODS: [&str; 3] = ["pay", "request_payment", "record_refusal"];

/// The registry's spam price for `report`: 0.01 NEAR, kept in full.
pub const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);

pub const VAULT_STANDARD: &str = "a_identity_vault";
pub const REGISTRY_STANDARD: &str = "a_identity_registry";
pub const NEP141_STANDARD: &str = "nep141";
pub const EVENT_VERSION: &str = "1.0.0";

pub const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
pub const ZERO: NearToken = NearToken::from_yoctonear(0);

pub const NS_PER_S: u64 = 1_000_000_000;

/// Blocks per `sandbox_fast_forward` request when moving the clock.
const FAST_FORWARD_BLOCKS: u64 = 25;

// ---------------------------------------------------------------------------------------
// Building the contracts, once per test binary
// ---------------------------------------------------------------------------------------

/// The outcome of a build is cached, failure included, so a contract that does not compile
/// fails every test that needs it with the compiler's message, once, instead of being
/// rebuilt (and failing again) by each of them.
type Built = OnceLock<Result<Vec<u8>, String>>;

static MOCK_FT_WASM: Built = OnceLock::new();
static REGISTRY_WASM: Built = OnceLock::new();
static VAULT_WASM: Built = OnceLock::new();

/// Builds run one at a time. Two `cargo near build` processes in one target directory
/// would only queue on cargo's own lock anyway; this keeps their output from interleaving.
static BUILD_LOCK: Mutex<()> = Mutex::new(());

pub fn mock_ft_wasm() -> Vec<u8> {
    built(&MOCK_FT_WASM, "mock-ft")
}

pub fn registry_wasm() -> Vec<u8> {
    built(&REGISTRY_WASM, "a-identity-registry")
}

pub fn vault_wasm() -> Vec<u8> {
    built(&VAULT_WASM, "agent-spend-policy")
}

fn built(cell: &'static Built, crate_dir: &str) -> Vec<u8> {
    match cell.get_or_init(|| build(crate_dir)) {
        Ok(code) => code.clone(),
        Err(err) => panic!("{err}"),
    }
}

/// `build_with_cli` runs `cargo near build non-reproducible-wasm --locked` with the
/// manifest's directory as its working directory, which is how cargo-near-build 0.11.5
/// carries `manifest_path` across the process boundary. The subprocess inherits this
/// process's environment, so a `CARGO_TARGET_DIR` set for `cargo test` applies to the wasm
/// builds too.
fn build(crate_dir: &str) -> Result<Vec<u8>, String> {
    let _serial = BUILD_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let manifest = Utf8PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(crate_dir)
        .join("Cargo.toml");
    let opts = cargo_near_build::BuildOpts::builder()
        .manifest_path(manifest.clone())
        .build();
    let artifact = cargo_near_build::build_with_cli(opts)
        .map_err(|err| format!("`cargo near build` failed for {manifest}: {err:?}"))?;
    std::fs::read(&artifact).map_err(|err| format!("cannot read the wasm at {artifact}: {err}"))
}

// ---------------------------------------------------------------------------------------
// Sandbox slots
// ---------------------------------------------------------------------------------------

static SANDBOX_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(sandbox_slots()));

fn sandbox_slots() -> usize {
    std::env::var("SANDBOX_TESTS_PARALLEL")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|slots| *slots > 0)
        .unwrap_or(4)
}

// ---------------------------------------------------------------------------------------
// Lenient numbers
// ---------------------------------------------------------------------------------------

/// Reads an integer that may be a JSON number or a decimal string.
///
/// The spec pins `U64`/`U128` (decimal strings) for arguments, for `PayOutcome` and for
/// event amounts, but leaves most view fields to the implementer, and a u64 below 2^53 is
/// legitimate JSON either way. Reading both keeps a view assertion about the value. Where
/// the spec does pin the string form, the tests assert it on the raw JSON instead.
pub fn lenient_u128(value: &Value) -> Option<u128> {
    match value {
        Value::String(text) => text.parse().ok(),
        Value::Number(number) => number.as_u64().map(u128::from),
        _ => None,
    }
}

pub fn lenient_u64(value: &Value) -> Option<u64> {
    lenient_u128(value).and_then(|wide| u64::try_from(wide).ok())
}

/// A u64 view field, read with `lenient_u64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct N64(pub u64);

impl<'de> Deserialize<'de> for N64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        lenient_u64(&value).map(N64).ok_or_else(|| {
            D::Error::custom(format!(
                "expected a u64 as a number or a decimal string, got {value}"
            ))
        })
    }
}

/// A u128 view field, read with `lenient_u128`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct N128(pub u128);

impl<'de> Deserialize<'de> for N128 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        lenient_u128(&value).map(N128).ok_or_else(|| {
            D::Error::custom(format!("expected a u128 as a decimal string, got {value}"))
        })
    }
}

// ---------------------------------------------------------------------------------------
// The JSON shapes the spec makes public
// ---------------------------------------------------------------------------------------

/// What every agent entry point and `owner_pay` return (spec 1.5). Pinned field by field:
/// `status` is "sent" | "refused" | "held" | "failed", `payment_id` is a U64, `reason` is
/// the error name on a refusal, `held_id` is set on a hold.
#[derive(Debug, Clone, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct PayOutcome {
    pub status: String,
    pub payment_id: N64,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub held_id: Option<N64>,
}

impl PayOutcome {
    #[track_caller]
    pub fn assert_sent(&self) {
        assert_eq!(
            self.status, "sent",
            "expected the payment to be sent, got {self:?}"
        );
    }

    /// A policy or registry refusal: a successful transaction that returns "refused" with
    /// the error name, never a panic, so that the refusal has a receipt and an event.
    #[track_caller]
    pub fn assert_refused(&self, reason: &str) {
        assert_eq!(
            (self.status.as_str(), self.reason.as_deref()),
            ("refused", Some(reason)),
            "expected a refusal named {reason}, got {self:?}"
        );
    }

    /// Returns the held id, which a hold must carry for the owner to act on it.
    #[track_caller]
    pub fn assert_held(&self) -> u64 {
        assert_eq!(
            self.status, "held",
            "expected the payment to be held, got {self:?}"
        );
        self.held_id
            .unwrap_or_else(|| panic!("a held outcome must carry its held_id: {self:?}"))
            .0
    }

    /// A hold with this reason (`RegistryWarn`, `UnknownPayee`, or the agent's own). Returns
    /// the held id.
    #[track_caller]
    pub fn assert_held_because(&self, reason: &str) -> u64 {
        let held_id = self.assert_held();
        assert_eq!(
            self.reason.as_deref(),
            Some(reason),
            "expected a hold for {reason}, got {self:?}"
        );
        held_id
    }

    #[track_caller]
    pub fn assert_failed(&self, reason: &str) {
        assert_eq!(
            (self.status.as_str(), self.reason.as_deref()),
            ("failed", Some(reason)),
            "expected a failed payment named {reason}, got {self:?}"
        );
    }
}

/// `get_config()` (spec 1.7, plus `hold_unknown` from amendment A1).
#[derive(Debug, Clone, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct VaultConfig {
    pub owner_id: String,
    pub token_id: String,
    #[serde(default)]
    pub registry_id: Option<String>,
    pub frozen: bool,
    pub daily_cap: N128,
    pub auto_approve_max: N128,
    pub allowlist_enabled: bool,
    pub token_storage_deposit: N128,
    pub version: String,
    pub hold_unknown: bool,
}

/// `get_agent(public_key)`: the vault's record of an agent key (spec 1.1, AgentKey).
#[derive(Debug, Clone, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AgentView {
    pub label: String,
    pub expires_at_s: N64,
    pub revoked: bool,
    pub added_at_s: N64,
}

/// `get_held(held_id)` (spec 1.1, HeldPayment).
#[derive(Debug, Clone, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct HeldView {
    #[serde(alias = "held_id")]
    pub id: N64,
    pub agent_pk: String,
    pub payee: String,
    pub amount: N128,
    #[serde(default)]
    pub memo: Option<String>,
    pub reason: String,
    pub created_at_s: N64,
    pub expires_at_s: N64,
}

/// `get_verdict(account_id)` (spec 2.2). The vault parses this shape cross-contract, so its
/// top-level `verdict` is a plain string by contract, not by convenience.
#[derive(Debug, Clone, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct VerdictView {
    pub account_id: String,
    pub verdict: String,
    pub reasons: Vec<String>,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub score: Option<N64>,
    #[serde(default)]
    pub code_hash: Option<String>,
    pub updated_at_ns: N64,
    pub updated_by: String,
    #[serde(default)]
    pub expires_at_ns: Option<N64>,
}

/// `check(account_id)` (spec 2.2).
#[derive(Debug, Clone, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CheckView {
    pub verdict: String,
    pub reasons: Vec<String>,
    pub reports: N64,
}

/// One element of `get_reports(account_id)` (spec 2.1, Report).
#[derive(Debug, Clone, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ReportView {
    pub reporter: String,
    pub reason: String,
    #[serde(default)]
    pub evidence: Option<String>,
}

// ---------------------------------------------------------------------------------------
// NEP-297 events
// ---------------------------------------------------------------------------------------

/// One NEP-297 event. `data` is normalized to a single object: near-sdk's `event_json`
/// emits a struct variant's fields as an object, while the NEP-141 events wrap theirs in an
/// array, and a test should not care which convention a contract picked.
#[derive(Debug, Clone)]
pub struct Event {
    pub standard: String,
    pub version: String,
    pub event: String,
    pub data: Value,
}

/// Every `EVENT_JSON:` log, in execution order, across the transaction and all of its
/// receipts. A log that carries the prefix but is not valid NEP-297 JSON fails the test:
/// indexers would drop it, so it is a bug, not noise.
pub fn parse_events<'a>(logs: impl IntoIterator<Item = &'a str>) -> Vec<Event> {
    let mut events = Vec::new();
    for log in logs {
        let Some(body) = log.strip_prefix("EVENT_JSON:") else {
            continue;
        };
        let envelope: Value = serde_json::from_str(body)
            .unwrap_or_else(|err| panic!("malformed NEP-297 log ({err}): {log}"));
        let text = |key: &str| {
            envelope
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("NEP-297 log without a string `{key}`: {log}"))
                .to_owned()
        };
        let (standard, version, event) = (text("standard"), text("version"), text("event"));
        let items = match envelope.get("data") {
            Some(Value::Array(items)) => items.clone(),
            Some(other) => vec![other.clone()],
            None => vec![Value::Null],
        };
        for data in items {
            events.push(Event {
                standard: standard.clone(),
                version: version.clone(),
                event: event.clone(),
                data,
            });
        }
    }
    events
}

/// The data of the ONE event named `name` in `standard`. Exactly one, because a duplicated
/// event is as wrong for an indexer as a missing one. Our own standards must also carry the
/// spec's version.
#[track_caller]
pub fn the_event(events: &[Event], standard: &str, name: &str) -> Value {
    let found: Vec<&Event> = events
        .iter()
        .filter(|event| event.standard == standard && event.event == name)
        .collect();
    assert_eq!(
        found.len(),
        1,
        "expected exactly one {standard}:{name} event, found {}: {events:#?}",
        found.len()
    );
    if standard == VAULT_STANDARD || standard == REGISTRY_STANDARD {
        assert_eq!(
            found[0].version, EVENT_VERSION,
            "wrong version on {standard}:{name}"
        );
    }
    found[0].data.clone()
}

pub fn has_event(events: &[Event], standard: &str, name: &str) -> bool {
    events
        .iter()
        .any(|event| event.standard == standard && event.event == name)
}

#[track_caller]
pub fn str_field<'a>(data: &'a Value, key: &str) -> &'a str {
    data.get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("field `{key}` is not a string in {data}"))
}

#[track_caller]
pub fn num_field(data: &Value, key: &str) -> u128 {
    data.get(key)
        .and_then(lenient_u128)
        .unwrap_or_else(|| panic!("field `{key}` is not an integer in {data}"))
}

#[track_caller]
pub fn bool_field(data: &Value, key: &str) -> bool {
    data.get(key)
        .and_then(Value::as_bool)
        .unwrap_or_else(|| panic!("field `{key}` is not a bool in {data}"))
}

#[track_caller]
pub fn str_list(data: &Value, key: &str) -> Vec<String> {
    let list = data
        .get(key)
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("field `{key}` is not a list in {data}"));
    list.iter()
        .map(|item| {
            item.as_str()
                .unwrap_or_else(|| panic!("`{key}` holds a non-string: {data}"))
                .to_owned()
        })
        .collect()
}

/// The spec writes amounts as decimal strings (U128 JSON) everywhere they are public.
#[track_caller]
pub fn assert_decimal_string(data: &Value, key: &str) {
    assert!(
        data.get(key).is_some_and(Value::is_string),
        "`{key}` must be a decimal string (U128/U64 JSON) in {data}"
    );
}

// ---------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------

/// A transaction the network accepted and executed to finality. Whether it SUCCEEDED is a
/// separate question: a contract panic is still an executed transaction, with a receipt.
pub struct Tx {
    result: ExecutionFinalResult,
}

impl Tx {
    fn from_send(sent: Result<TransactionResult, ExecuteTransactionError>) -> Result<Tx, String> {
        match sent {
            Ok(TransactionResult::Full(result)) => Ok(Tx { result: *result }),
            Ok(TransactionResult::Pending { status }) => Err(format!(
                "the transaction is still pending ({status:?}); the harness waits for Final"
            )),
            Err(err) => Err(format!("{err:?}")),
        }
    }

    pub fn is_success(&self) -> bool {
        self.result.is_success()
    }

    /// Gas burnt by the transaction AND every receipt it caused, refunds included: the
    /// figure the signer pays for.
    pub fn gas_burnt(&self) -> NearGas {
        self.result.total_gas_burnt
    }

    /// Gas burnt converting the signed transaction into its first receipt.
    pub fn transaction_gas(&self) -> NearGas {
        self.result.outcome().gas_burnt
    }

    /// Gas burnt per receipt, with the account each one executed on, in execution order.
    /// This is the breakdown a gas budget is tuned from: one line per hop of the chain.
    pub fn receipt_gas(&self) -> Vec<(String, NearGas)> {
        self.result
            .receipt_outcomes()
            .iter()
            .map(|outcome| (outcome.executor_id.to_string(), outcome.gas_burnt))
            .collect()
    }

    /// NEAR burnt for that gas, across the transaction and all receipts.
    pub fn tokens_burnt(&self) -> NearToken {
        let yocto = self
            .result
            .outcomes()
            .iter()
            .map(|outcome| outcome.tokens_burnt.as_yoctonear())
            .fold(0u128, u128::saturating_add);
        NearToken::from_yoctonear(yocto)
    }

    /// Whether a receipt that executed on `account` failed. A successful transaction can
    /// still carry one: a callback that absorbed a failed cross-contract call.
    pub fn failed_on(&self, account: &AccountId) -> bool {
        self.result
            .receipt_failures()
            .iter()
            .any(|outcome| outcome.executor_id.as_str() == account.as_str())
    }

    pub fn logs(&self) -> Vec<String> {
        self.result.logs().into_iter().map(str::to_owned).collect()
    }

    pub fn events(&self) -> Vec<Event> {
        parse_events(self.result.logs())
    }

    pub fn events_of(&self, standard: &str) -> Vec<Event> {
        self.events()
            .into_iter()
            .filter(|event| event.standard == standard)
            .collect()
    }

    pub fn vault_events(&self) -> Vec<Event> {
        self.events_of(VAULT_STANDARD)
    }

    pub fn registry_events(&self) -> Vec<Event> {
        self.events_of(REGISTRY_STANDARD)
    }

    #[track_caller]
    pub fn event(&self, standard: &str, name: &str) -> Value {
        the_event(&self.events(), standard, name)
    }

    #[track_caller]
    pub fn vault_event(&self, name: &str) -> Value {
        self.event(VAULT_STANDARD, name)
    }

    #[track_caller]
    pub fn registry_event(&self, name: &str) -> Value {
        self.event(REGISTRY_STANDARD, name)
    }

    pub fn has_vault_event(&self, name: &str) -> bool {
        has_event(&self.events(), VAULT_STANDARD, name)
    }

    /// Every account a receipt of this transaction executed on, in order.
    pub fn executors(&self) -> Vec<String> {
        self.result
            .receipt_outcomes()
            .iter()
            .map(|outcome| outcome.executor_id.to_string())
            .collect()
    }

    pub fn touched(&self, account: &AccountId) -> bool {
        self.executors().iter().any(|id| id == account.as_str())
    }

    /// The failure of the transaction itself, then of each failed receipt. Logs are left
    /// out on purpose: a refusal event that mentions an error name must not satisfy a test
    /// that expects a panic with that name.
    pub fn failure_text(&self) -> String {
        let mut text = String::new();
        if let Err(failure) = self.result.clone().into_result() {
            text.push_str(&failure.to_string());
        }
        text.push_str(&self.receipt_failure_text());
        text
    }

    /// Only the receipts that failed, which a successful transaction can also have: a
    /// callback that absorbed a failed cross-contract call leaves exactly this behind.
    pub fn receipt_failure_text(&self) -> String {
        self.result
            .receipt_failures()
            .into_iter()
            .filter_map(|outcome| outcome.clone().into_result().err())
            .map(|err| format!(" | receipt failed: {err:?}"))
            .collect()
    }

    #[track_caller]
    pub fn assert_ok(self) -> Self {
        assert!(
            self.is_success(),
            "expected the transaction to succeed, it failed: {}",
            self.failure_text()
        );
        self
    }

    /// The contract panicked, and the panic message carries `name`. The spec has every
    /// panic go through `env::panic_str(err.as_str())`, so the name is the message.
    #[track_caller]
    pub fn assert_panicked_with(&self, name: &str) {
        assert!(
            !self.is_success(),
            "expected a panic named {name}, but the transaction succeeded; logs: {:?}",
            self.logs()
        );
        let text = self.failure_text();
        assert!(
            text.contains(name),
            "expected a panic named {name}, got: {text}"
        );
    }

    #[track_caller]
    pub fn json<T: DeserializeOwned>(&self) -> T {
        match self.result.clone().json::<T>() {
            Ok(value) => value,
            Err(err) => panic!(
                "cannot read the return value as {}: {err:?}; failure: {}; logs: {:?}",
                std::any::type_name::<T>(),
                self.failure_text(),
                self.logs()
            ),
        }
    }

    #[track_caller]
    pub fn outcome(&self) -> PayOutcome {
        self.json()
    }
}

/// The protocol, not the contract, stopped this transaction: it either never executed
/// (`Err` from the client or the RPC) or failed validation, and the text names the
/// access-key rule. Accepting both forms is deliberate: whether a rule surfaces as an RPC
/// error or as a failed outcome is a node detail, while the rule's name is not.
#[track_caller]
pub fn assert_protocol_rejected(sent: Result<Tx, String>, any_of: &[&str]) {
    let text = match sent {
        Err(text) => text,
        Ok(tx) => {
            assert!(
                !tx.is_success(),
                "expected the protocol to reject this transaction, but it executed and succeeded; logs: {:?}",
                tx.logs()
            );
            tx.failure_text()
        }
    };
    assert!(
        any_of.iter().any(|name| text.contains(name)),
        "rejected, but not for any of {any_of:?}: {text}"
    );
}

/// For owner entry points where the spec names the error but not whether it is a panic or
/// a "refused" outcome (for example `HeldNotFound` on `owner_pay`). Either form passes; a
/// success that is not a refusal with exactly this name does not.
#[track_caller]
pub fn assert_refused_or_panicked(tx: &Tx, name: &str) {
    if tx.is_success() {
        tx.outcome().assert_refused(name);
    } else {
        tx.assert_panicked_with(name);
    }
}

/// One function call, built fluently and sent once.
pub struct Call<'w> {
    world: &'w World,
    signer: Arc<Signer>,
    signer_id: AccountId,
    receiver: AccountId,
    method: String,
    args: Value,
    deposit: NearToken,
    gas: NearGas,
}

impl Call<'_> {
    pub fn deposit(mut self, deposit: NearToken) -> Self {
        self.deposit = deposit;
        self
    }

    pub fn one_yocto(self) -> Self {
        self.deposit(ONE_YOCTO)
    }

    pub fn no_deposit(self) -> Self {
        self.deposit(ZERO)
    }

    pub fn gas(mut self, gas: NearGas) -> Self {
        self.gas = gas;
        self
    }

    /// Sign with a different key for the same `signer_id`.
    pub fn signed_with(mut self, signer: Arc<Signer>) -> Self {
        self.signer = signer;
        self
    }

    fn describe(&self) -> String {
        format!("{} -> {}.{}", self.signer_id, self.receiver, self.method)
    }

    fn prepared(&self) -> ExecuteSignedTransaction {
        Contract(self.receiver.clone())
            .call_function(&self.method, self.args.clone())
            .transaction()
            .gas(self.gas)
            .deposit(self.deposit)
            .with_signer(self.signer_id.clone(), self.signer.clone())
    }

    /// The transaction executed, whatever its outcome. Panics if the network refused to
    /// take it at all, which for these calls is always a harness or setup error.
    pub async fn send(self) -> Tx {
        let what = self.describe();
        match self.try_send().await {
            Ok(tx) => tx,
            Err(err) => panic!("{what}: the transaction was not accepted: {err}"),
        }
    }

    /// `Err` when the client or the network refused the transaction before execution.
    pub async fn try_send(self) -> Result<Tx, String> {
        Tx::from_send(self.prepared().send_to(&self.world.network).await)
    }

    /// Signs with the client (nonce and block hash fetched as usual), then posts the bytes
    /// to the RPC directly. This is the path for every "rejected by the protocol" check:
    /// nearcore serializes `INVALID_TRANSACTION` with an empty `info` and puts the rule
    /// that fired only in the legacy `data` field, which the typed client drops. A test
    /// that cannot see the rule would pass on a bad nonce as happily as on
    /// `MethodNameMismatch`.
    pub async fn try_send_raw(self) -> Result<Tx, String> {
        let world = self.world;
        let signed = self
            .prepared()
            .presign_with(&world.network)
            .await
            .map_err(|err| format!("{err:?}"))?;
        world.send_signed_raw(signed).await
    }

    /// Signs locally with a caller-chosen nonce and a fresh block hash, then posts the
    /// bytes to the RPC directly. This skips the client's access-key lookup, so what
    /// answers is the protocol itself, which is the only thing that can prove a deleted key
    /// cannot sign.
    pub async fn try_send_presigned(self, nonce: u64) -> Result<Tx, String> {
        let world = self.world;
        let public_key = self
            .signer
            .get_public_key()
            .await
            .map_err(|err| format!("{err:?}"))?;
        let block_hash = Chain::block_hash()
            .fetch_from(&world.network)
            .await
            .map_err(|err| format!("{err:?}"))?;
        let signed = self
            .prepared()
            .presign_offline(public_key, block_hash, nonce)
            .await
            .map_err(|err| format!("{err:?}"))?;
        world.send_signed_raw(signed).await
    }
}

// ---------------------------------------------------------------------------------------
// Raw JSON-RPC
// ---------------------------------------------------------------------------------------

/// One JSON-RPC POST to the local sandbox over a plain TCP connection.
///
/// Hand-rolled on purpose, and only for the sandbox: the typed client cannot report which
/// access-key rule rejected a transaction (see `Call::try_send_raw`), and the test crate
/// has no HTTP client of its own to ask instead. HTTP/1.1 with `Connection: close`, so the
/// body ends where the stream ends; chunked framing is decoded in case the server picks it.
async fn rpc_post(rpc_addr: &str, body: &Value) -> Result<Value, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let authority = rpc_addr
        .strip_prefix("http://")
        .ok_or_else(|| format!("not a plain http RPC address: {rpc_addr}"))?
        .trim_end_matches('/');
    let payload = serde_json::to_vec(body).map_err(|err| err.to_string())?;
    let head = format!(
        "POST / HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        payload.len()
    );
    let mut stream = tokio::net::TcpStream::connect(authority)
        .await
        .map_err(|err| format!("connect to {authority}: {err}"))?;
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|err| format!("write to {authority}: {err}"))?;
    stream
        .write_all(&payload)
        .await
        .map_err(|err| format!("write to {authority}: {err}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .await
        .map_err(|err| format!("read from {authority}: {err}"))?;

    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("the RPC answer has no end of headers")?;
    let headers = String::from_utf8_lossy(&raw[..split]).to_ascii_lowercase();
    let mut content = raw[split + 4..].to_vec();
    if headers.contains("transfer-encoding: chunked") {
        content = dechunk(&content)?;
    }
    serde_json::from_slice(&content).map_err(|err| {
        format!(
            "the RPC answered with something that is not JSON ({err}): {}",
            String::from_utf8_lossy(&content)
        )
    })
}

fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = data
            .windows(2)
            .position(|window| window == b"\r\n")
            .ok_or("truncated chunk size line")?;
        let size_line = String::from_utf8_lossy(&data[..line_end]).into_owned();
        let size_hex = size_line.split(';').next().unwrap_or_default().trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|err| format!("bad chunk size {size_line:?}: {err}"))?;
        data = &data[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        let chunk = data.get(..size).ok_or("truncated chunk")?;
        out.extend_from_slice(chunk);
        data = data.get(size + 2..).ok_or("truncated chunk terminator")?;
    }
}

// ---------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------

/// A fresh ed25519 key pair, generated locally. The secret never leaves the test.
pub fn new_key() -> (SecretKey, PublicKey) {
    let secret = generate_secret_key().expect("generate an ed25519 key");
    let public = secret.public_key();
    (secret, public)
}

pub fn signer_for(secret: SecretKey) -> Arc<Signer> {
    Signer::from_secret_key(secret).expect("a signer from a secret key")
}

/// What a client gets back when it tries to sign with `public_key` after the key was deleted.
///
/// near-api looks the key up for its nonce before it signs anything, and nearcore answers a
/// lookup for a missing key in the legacy query shape, `access key <key> does not exist
/// while viewing`, which near-api 0.8.7 cannot parse into its typed error and passes on as
/// text (seen on near-sandbox 2.14.0). Matching the sentence WITH the key in it keeps the
/// assertion about this key, rather than about any lookup that happened to fail.
pub fn key_does_not_exist(public_key: &PublicKey) -> String {
    format!("access key {public_key} does not exist")
}

pub fn genesis_public_key() -> PublicKey {
    DEFAULT_GENESIS_ACCOUNT_PUBLIC_KEY
        .parse()
        .expect("the sandbox genesis public key parses")
}

pub fn sorted(names: &[String]) -> Vec<String> {
    let mut names = names.to_vec();
    names.sort();
    names
}

pub fn agent_methods_sorted() -> Vec<String> {
    sorted(&AGENT_METHODS.map(String::from))
}

/// The permission of a key the vault created for an agent, or a panic naming what is wrong.
#[track_caller]
pub fn function_call_permission(key: &AccessKey) -> FunctionCallPermission {
    match &key.permission {
        AccessKeyPermission::FunctionCall(permission) => permission.clone(),
        AccessKeyPermission::FullAccess => {
            panic!("an agent key must never be a full-access key")
        }
    }
}

// ---------------------------------------------------------------------------------------
// Argument builders (spec 1.4 and 2.2 argument names)
// ---------------------------------------------------------------------------------------

pub fn pay_args(payee: &AccountId, amount: u128, memo: Option<&str>) -> Value {
    json!({ "payee": payee, "amount": amount.to_string(), "memo": memo })
}

pub fn request_args(payee: &AccountId, amount: u128, memo: Option<&str>, reason: &str) -> Value {
    json!({ "payee": payee, "amount": amount.to_string(), "memo": memo, "reason": reason })
}

pub fn refusal_args(payee: &AccountId, amount: u128, reason: &str) -> Value {
    json!({ "payee": payee, "amount": amount.to_string(), "reason": reason })
}

pub fn policy_args(daily_cap: u128, auto_approve_max: u128, allowlist_enabled: bool) -> Value {
    json!({
        "daily_cap": daily_cap.to_string(),
        "auto_approve_max": auto_approve_max.to_string(),
        "allowlist_enabled": allowlist_enabled,
    })
}

pub fn agent_key_args(
    public_key: &PublicKey,
    label: &str,
    expires_at_s: u64,
    allowance: NearToken,
) -> Value {
    json!({
        "public_key": public_key,
        "label": label,
        "expires_at_s": expires_at_s.to_string(),
        "allowance": allowance.as_yoctonear().to_string(),
    })
}

/// The vault's `new` arguments (spec 1.2).
pub fn vault_init_args(
    owner_id: &AccountId,
    token_id: &AccountId,
    registry_id: Option<&AccountId>,
    token_storage_deposit: u128,
    daily_cap: u128,
    auto_approve_max: u128,
) -> Value {
    json!({
        "owner_id": owner_id,
        "token_id": token_id,
        "registry_id": registry_id,
        "token_storage_deposit": token_storage_deposit.to_string(),
        "daily_cap": daily_cap.to_string(),
        "auto_approve_max": auto_approve_max.to_string(),
    })
}

pub fn held_args(held_id: u64) -> Value {
    json!({ "held_id": held_id.to_string() })
}

pub fn verdict_args(subject: &AccountId, verdict: &str, reasons: &[&str]) -> Value {
    json!({
        "account_id": subject,
        "verdict": verdict,
        "reasons": reasons,
        "evidence": null,
        "score": null,
        "code_hash": null,
        "ttl_s": null,
    })
}

pub fn verdict_args_with_ttl(
    subject: &AccountId,
    verdict: &str,
    reasons: &[&str],
    ttl_s: u64,
) -> Value {
    let mut args = verdict_args(subject, verdict, reasons);
    args["ttl_s"] = json!(ttl_s.to_string());
    args
}

pub fn report_args(subject: &AccountId, reason: &str, evidence: &str) -> Value {
    json!({ "account_id": subject, "reason": reason, "evidence": evidence })
}

pub fn account_arg(account: &AccountId) -> Value {
    json!({ "account_id": account })
}

/// A `PaymentCtx` as the vault's callbacks take it, for calling a callback DIRECTLY.
///
/// The shape is the vault crate's, not the spec's (the spec names the context's contents
/// but not its JSON), so a test that uses this pins the vault's current callback ABI. It
/// is built well-formed on purpose: a malformed context would be refused by argument
/// deserialization, and the test would then prove nothing about the guard it is aimed at.
pub fn payment_ctx(agent_pk: &PublicKey, payee: &AccountId, amount: u128, day: u64) -> Value {
    json!({
        "payment_id": "1",
        "mode": "pay",
        "agent_pk": agent_pk,
        "payee": payee,
        "amount": amount.to_string(),
        "memo": null,
        "day": day.to_string(),
        "reason": null,
        "held_id": null,
    })
}

// ---------------------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------------------

/// What the protocol charges a function-call key's allowance (and the signer's balance)
/// UP FRONT per unit of prepaid gas: `max(gas_price, min_gas_purchase_price)`, which is
/// 1e9 yoctoNEAR per gas (0.001 NEAR per Tgas) on testnet and mainnet, 10x the burn price.
/// Unused gas is refunded to the allowance afterwards, so this is a hold, not the cost.
pub const GAS_PURCHASE_PRICE_YOCTO: u128 = 1_000_000_000;

/// The allowance one in-flight transaction with `prepaid` gas holds at the purchase price.
pub fn upfront_gas_cost(prepaid: NearGas) -> NearToken {
    NearToken::from_yoctonear(u128::from(prepaid.as_gas()).saturating_mul(GAS_PURCHASE_PRICE_YOCTO))
}

/// Appends one JSON line to the file named by `SANDBOX_GAS_REPORT`, when it is set. The
/// gas tests also print the same line, so a plain `--nocapture` run shows it too.
pub fn record_gas_report(line: &Value) {
    eprintln!("gas report: {line}");
    let Some(path) = std::env::var_os("SANDBOX_GAS_REPORT") else {
        return;
    };
    use std::io::Write as _;
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(err) = written {
        eprintln!("note: could not append the gas report to {path:?}: {err}");
    }
}

// ---------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------

/// What `World::new` deploys and how the vault starts. A vault needs the token; the
/// registry is optional, and without it the vault starts with `registry_id: None`.
#[derive(Debug, Clone, Copy)]
pub struct Setup {
    pub token: bool,
    pub registry: bool,
    pub vault: bool,
    pub daily_cap: u128,
    pub auto_approve_max: u128,
    pub fund: u128,
    pub agent_expires_at_s: u64,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            token: true,
            registry: true,
            vault: true,
            daily_cap: DEFAULT_DAILY_CAP,
            auto_approve_max: DEFAULT_AUTO_APPROVE_MAX,
            fund: DEFAULT_FUND,
            agent_expires_at_s: 0,
        }
    }
}

impl Setup {
    /// Accounts only, no contracts: for tests about the sandbox itself.
    pub fn bare() -> Self {
        Self {
            token: false,
            registry: false,
            vault: false,
            ..Self::default()
        }
    }

    pub fn token_only() -> Self {
        Self {
            registry: false,
            vault: false,
            ..Self::default()
        }
    }

    pub fn registry_only() -> Self {
        Self {
            token: false,
            vault: false,
            ..Self::default()
        }
    }

    pub fn without_registry() -> Self {
        Self {
            registry: false,
            ..Self::default()
        }
    }

    pub fn with_policy(daily_cap: u128, auto_approve_max: u128) -> Self {
        Self {
            daily_cap,
            auto_approve_max,
            ..Self::default()
        }
    }
}

pub struct World {
    pub sandbox: Sandbox,
    pub network: NetworkConfig,
    /// The sandbox genesis key, the full-access key of every account the harness creates.
    pub root: Arc<Signer>,
    pub owner: AccountId,
    pub oracle: AccountId,
    pub registry: AccountId,
    pub vault: AccountId,
    pub token: AccountId,
    pub merchant: AccountId,
    pub attacker: AccountId,
    pub newshop: AccountId,
    pub stranger: AccountId,
    pub agent_secret: SecretKey,
    pub agent_pk: PublicKey,
    pub agent_signer: Arc<Signer>,
    /// mock-ft's `storage_balance_bounds().min`, the vault's `token_storage_deposit`.
    pub storage_min: u128,
    /// Every event from the setup transactions: init, funding, the first agent key.
    pub setup_events: Vec<Event>,
    /// Whether the promise scheduled by the vault's `new` registered it on the token. When
    /// it did not, setup fell back to `register_with_token` so the other tests can still
    /// run; the init test is the one that reads this flag.
    pub vault_registered_by_init: bool,
    _slot: SemaphorePermit<'static>,
}

fn sandbox_account(name: &str) -> AccountId {
    format!("{name}.sandbox")
        .parse()
        .expect("the harness only uses valid account ids")
}

impl World {
    pub async fn new(setup: Setup) -> World {
        assert!(!setup.vault || setup.token, "a vault needs the token");

        // Build before taking a sandbox slot: the first build in a binary takes minutes and
        // should not hold a running neard hostage while it does.
        let token_code = setup.token.then(mock_ft_wasm);
        let registry_code = setup.registry.then(registry_wasm);
        let vault_code = setup.vault.then(vault_wasm);

        let slot = SANDBOX_SLOTS
            .acquire()
            .await
            .expect("the sandbox semaphore is never closed");
        let sandbox = Sandbox::start_sandbox().await.expect("start near-sandbox");
        let network = NetworkConfig::from_rpc_url(
            "sandbox",
            sandbox
                .rpc_addr
                .parse()
                .expect("the sandbox RPC address is a URL"),
        );
        let root = Signer::from_secret_key(
            DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY
                .parse()
                .expect("the sandbox genesis key parses"),
        )
        .expect("a signer for the genesis key");
        let (agent_secret, agent_pk) = new_key();
        let agent_signer = signer_for(agent_secret.clone());

        let mut world = World {
            sandbox,
            network,
            root,
            owner: sandbox_account("owner"),
            oracle: sandbox_account("oracle"),
            registry: sandbox_account("registry"),
            vault: sandbox_account("vault"),
            token: sandbox_account("token"),
            merchant: sandbox_account("merchant"),
            attacker: sandbox_account("attacker"),
            newshop: sandbox_account("newshop"),
            stranger: sandbox_account("stranger"),
            agent_secret,
            agent_pk,
            agent_signer,
            storage_min: 0,
            setup_events: Vec::new(),
            vault_registered_by_init: false,
            _slot: slot,
        };

        let accounts = [
            (world.owner.clone(), 100),
            (world.oracle.clone(), 20),
            (world.registry.clone(), 50),
            (world.vault.clone(), 50),
            (world.token.clone(), 50),
            (world.merchant.clone(), 10),
            (world.attacker.clone(), 10),
            (world.newshop.clone(), 10),
            (world.stranger.clone(), 20),
        ];
        for (account, near) in accounts {
            world
                .create_account(&account, NearToken::from_near(near))
                .await;
        }

        if let Some(code) = token_code {
            world.setup_token(code).await;
        }
        if let Some(code) = registry_code {
            let tx = world
                .deploy(
                    &world.registry,
                    code,
                    "new",
                    json!({ "owner_id": world.owner, "oracles": [world.oracle] }),
                )
                .await
                .assert_ok();
            world.setup_events.extend(tx.events());
        }
        if let Some(code) = vault_code {
            world.setup_vault(code, &setup).await;
        }
        if setup.registry && setup.vault {
            // See the module docs: the payee the guard tests pay is a judged one.
            let merchant = world.merchant.clone();
            let tx = world
                .set_verdict(&merchant, "ALLOW", &["known_merchant"])
                .await;
            world.setup_events.extend(tx.events());
        }
        world
    }

    async fn setup_token(&mut self, code: Vec<u8>) {
        let token = self.token.clone();
        self.deploy(
            &token,
            code,
            "new",
            json!({ "owner_id": self.owner, "total_supply": TOTAL_SUPPLY.to_string() }),
        )
        .await
        .assert_ok();
        let bounds: Value = self.view(&token, "storage_balance_bounds", json!({})).await;
        self.storage_min = bounds
            .get("min")
            .and_then(lenient_u128)
            .unwrap_or_else(|| panic!("storage_balance_bounds without a min: {bounds}"));
        let payees = [
            self.merchant.clone(),
            self.attacker.clone(),
            self.stranger.clone(),
        ];
        self.register_on(&token, &payees).await;
    }

    async fn setup_vault(&mut self, code: Vec<u8>, setup: &Setup) {
        let vault = self.vault.clone();
        let registry_id = setup.registry.then(|| self.registry.clone());
        let init = vault_init_args(
            &self.owner,
            &self.token,
            registry_id.as_ref(),
            self.storage_min,
            setup.daily_cap,
            setup.auto_approve_max,
        );
        let tx = self.deploy(&vault, code, "new", init).await.assert_ok();
        self.setup_events.extend(tx.events());

        self.vault_registered_by_init = self.is_registered(&vault).await;
        if !self.vault_registered_by_init {
            eprintln!(
                "note: the vault's init did not register it on the token; falling back to register_with_token"
            );
            self.owner_call_plain("register_with_token", json!({}))
                .send()
                .await
                .assert_ok();
            assert!(
                self.is_registered(&vault).await,
                "register_with_token did not register the vault on the token"
            );
        }

        if setup.fund > 0 {
            let tx = self.fund_vault(setup.fund).await;
            self.setup_events.extend(tx.events());
            assert_eq!(
                self.ft_balance(&vault).await,
                setup.fund,
                "the vault keeps what its own token sends it"
            );
        }

        let agent_pk = self.agent_pk;
        let tx = self
            .add_agent_key(
                &agent_pk,
                "sandbox-agent",
                setup.agent_expires_at_s,
                AGENT_ALLOWANCE,
            )
            .await
            .assert_ok();
        self.setup_events.extend(tx.events());
        assert!(
            self.access_key(&vault, &agent_pk).await.is_some(),
            "add_agent_key succeeded but no access key appeared on the vault account"
        );
    }

    // ---- accounts and contracts ------------------------------------------------------

    pub async fn create_account(&self, account: &AccountId, balance: NearToken) {
        self.sandbox
            .create_account(account.as_str().parse().expect("valid account id"))
            .initial_balance(balance)
            .send()
            .await
            .unwrap_or_else(|err| panic!("create {account}: {err:?}"));
    }

    /// Deploy and init in one transaction, signed by the account itself. The two actions
    /// are atomic: an init that panics leaves the account without code.
    pub async fn deploy(&self, account: &AccountId, code: Vec<u8>, init: &str, args: Value) -> Tx {
        let sent = Contract::deploy(account.clone())
            .use_code(code)
            .with_init_call(init, args)
            .expect("init arguments serialize")
            .gas(OWNER_GAS)
            .with_signer(self.root.clone())
            .send_to(&self.network)
            .await;
        Tx::from_send(sent)
            .unwrap_or_else(|err| panic!("deploy to {account} was not accepted: {err}"))
    }

    /// `storage_deposit` for each account on `token`, as one batch transaction from the
    /// owner, with the token's minimum attached to each call.
    pub async fn register_on(&self, token: &AccountId, accounts: &[AccountId]) {
        let mut tx = Transaction::construct(self.owner.clone(), token.clone());
        for account in accounts {
            tx = tx.add_action(Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: "storage_deposit".to_owned(),
                args: serde_json::to_vec(
                    &json!({ "account_id": account, "registration_only": true }),
                )
                .expect("serialize"),
                gas: NearGas::from_tgas(20),
                deposit: NearToken::from_yoctonear(self.storage_min),
            })));
        }
        let sent = tx
            .with_signer(self.root.clone())
            .send_to(&self.network)
            .await;
        Tx::from_send(sent)
            .unwrap_or_else(|err| {
                panic!("registering {accounts:?} on {token} was not accepted: {err}")
            })
            .assert_ok();
    }

    pub async fn fund_vault(&self, amount: u128) -> Tx {
        let tx = self
            .call(
                &self.owner,
                &self.token,
                "ft_transfer_call",
                json!({ "receiver_id": self.vault, "amount": amount.to_string(), "memo": null, "msg": "" }),
            )
            .one_yocto()
            .send()
            .await
            .assert_ok();
        assert_eq!(
            tx.json::<String>(),
            amount.to_string(),
            "ft_transfer_call reports how much the vault kept; a deposit of its own token is kept in full"
        );
        tx
    }

    // ---- calls --------------------------------------------------------------------------

    /// A call signed by `signer_id` with the genesis key, no deposit, 300 Tgas.
    pub fn call(
        &self,
        signer_id: &AccountId,
        receiver: &AccountId,
        method: &str,
        args: Value,
    ) -> Call<'_> {
        Call {
            world: self,
            signer: self.root.clone(),
            signer_id: signer_id.clone(),
            receiver: receiver.clone(),
            method: method.to_owned(),
            args,
            deposit: ZERO,
            gas: OWNER_GAS,
        }
    }

    /// The owner calling the vault with the 1 yoctoNEAR the sensitive methods require.
    pub fn owner_call(&self, method: &str, args: Value) -> Call<'_> {
        self.call(&self.owner, &self.vault, method, args)
            .one_yocto()
    }

    /// The owner calling the vault with no deposit (`freeze`, `register_with_token`, and
    /// every test that checks the yocto requirement).
    pub fn owner_call_plain(&self, method: &str, args: Value) -> Call<'_> {
        self.call(&self.owner, &self.vault, method, args)
    }

    /// The owner calling the registry with 1 yoctoNEAR.
    pub fn registry_owner_call(&self, method: &str, args: Value) -> Call<'_> {
        self.call(&self.owner, &self.registry, method, args)
            .one_yocto()
    }

    pub fn oracle_call(&self, method: &str, args: Value) -> Call<'_> {
        self.call(&self.oracle, &self.registry, method, args)
    }

    /// The agent: the vault account as signer and receiver, the agent's function-call key,
    /// no deposit (the protocol forbids one), and the recommended `AGENT_GAS`.
    pub fn agent_call(&self, method: &str, args: Value) -> Call<'_> {
        Call {
            world: self,
            signer: self.agent_signer.clone(),
            signer_id: self.vault.clone(),
            receiver: self.vault.clone(),
            method: method.to_owned(),
            args,
            deposit: ZERO,
            gas: AGENT_GAS,
        }
    }

    /// The vault account calling itself with the harness's full-access key: NOT an agent
    /// key. The contract must treat it like any other caller that is not an agent.
    pub fn vault_self_call(&self, method: &str, args: Value) -> Call<'_> {
        self.call(&self.vault, &self.vault, method, args)
    }

    pub async fn pay(&self, payee: &AccountId, amount: u128, memo: Option<&str>) -> Tx {
        self.agent_call("pay", pay_args(payee, amount, memo))
            .send()
            .await
    }

    pub async fn request_payment(
        &self,
        payee: &AccountId,
        amount: u128,
        memo: Option<&str>,
        reason: &str,
    ) -> Tx {
        self.agent_call("request_payment", request_args(payee, amount, memo, reason))
            .send()
            .await
    }

    pub async fn record_refusal(&self, payee: &AccountId, amount: u128, reason: &str) -> Tx {
        self.agent_call("record_refusal", refusal_args(payee, amount, reason))
            .send()
            .await
    }

    pub async fn owner_pay(&self, held_id: u64) -> Tx {
        self.owner_call("owner_pay", held_args(held_id))
            .send()
            .await
    }

    pub async fn owner_reject(&self, held_id: u64) -> Tx {
        self.owner_call("owner_reject", held_args(held_id))
            .send()
            .await
    }

    pub async fn set_policy(
        &self,
        daily_cap: u128,
        auto_approve_max: u128,
        allowlist_enabled: bool,
    ) -> Tx {
        self.owner_call(
            "set_policy",
            policy_args(daily_cap, auto_approve_max, allowlist_enabled),
        )
        .send()
        .await
    }

    pub async fn set_allowed(&self, payee: &AccountId, ok: bool) -> Tx {
        self.owner_call("set_allowed", json!({ "payee": payee, "ok": ok }))
            .send()
            .await
    }

    pub async fn set_registry(&self, registry_id: Option<&AccountId>) -> Tx {
        self.owner_call("set_registry", json!({ "registry_id": registry_id }))
            .send()
            .await
    }

    pub async fn set_hold_unknown(&self, hold_unknown: bool) -> Tx {
        self.owner_call("set_hold_unknown", json!({ "hold_unknown": hold_unknown }))
            .send()
            .await
    }

    pub async fn set_agent_expiry(&self, public_key: &PublicKey, expires_at_s: u64) -> Tx {
        self.owner_call(
            "set_agent_expiry",
            json!({ "public_key": public_key, "expires_at_s": expires_at_s.to_string() }),
        )
        .send()
        .await
    }

    pub async fn freeze(&self) -> Tx {
        self.owner_call_plain("freeze", json!({})).send().await
    }

    pub async fn unfreeze(&self) -> Tx {
        self.owner_call("unfreeze", json!({})).send().await
    }

    pub async fn add_agent_key(
        &self,
        public_key: &PublicKey,
        label: &str,
        expires_at_s: u64,
        allowance: NearToken,
    ) -> Tx {
        self.owner_call(
            "add_agent_key",
            agent_key_args(public_key, label, expires_at_s, allowance),
        )
        .send()
        .await
    }

    pub async fn revoke_agent_key(&self, public_key: &PublicKey) -> Tx {
        self.owner_call("revoke_agent_key", json!({ "public_key": public_key }))
            .send()
            .await
    }

    pub async fn forget_agent_key(&self, public_key: &PublicKey) -> Tx {
        self.owner_call("forget_agent_key", json!({ "public_key": public_key }))
            .send()
            .await
    }

    pub async fn withdraw(&self, amount: u128) -> Tx {
        self.owner_call("withdraw", json!({ "amount": amount.to_string() }))
            .send()
            .await
    }

    /// The oracle writes a verdict with no evidence, score, code hash or TTL.
    pub async fn set_verdict(&self, subject: &AccountId, verdict: &str, reasons: &[&str]) -> Tx {
        self.oracle_call("set_verdict", verdict_args(subject, verdict, reasons))
            .send()
            .await
            .assert_ok()
    }

    /// A NEAR transfer, which no function-call key may sign. Sent raw, so a rejection
    /// carries the protocol's reason.
    pub async fn transfer_near(
        &self,
        from: &AccountId,
        to: &AccountId,
        amount: NearToken,
        signer: Arc<Signer>,
    ) -> Result<Tx, String> {
        let unsigned = Transaction::construct(from.clone(), to.clone())
            .add_action(Action::Transfer(TransferAction { deposit: amount }))
            .with_signer(signer);
        self.sign_and_send_raw(unsigned).await
    }

    /// An AddKey action on `account`, outside any contract, signed by `signer`. Sent raw.
    pub async fn add_key_directly(
        &self,
        account: &AccountId,
        permission: AccessKeyPermission,
        public_key: PublicKey,
        signer: Arc<Signer>,
    ) -> Result<Tx, String> {
        let unsigned = Account(account.clone())
            .add_key(permission, public_key)
            .with_signer(signer);
        self.sign_and_send_raw(unsigned).await
    }

    /// A DeleteKey action on `account`, signed by `signer`. Sent raw.
    pub async fn delete_key_directly(
        &self,
        account: &AccountId,
        public_key: PublicKey,
        signer: Arc<Signer>,
    ) -> Result<Tx, String> {
        let unsigned = Account(account.clone())
            .delete_key(public_key)
            .with_signer(signer);
        self.sign_and_send_raw(unsigned).await
    }

    /// Any list of actions in ONE transaction from `signer_id` to `receiver`, signed by
    /// `signer`. Sent raw, so a protocol rejection names its rule.
    pub async fn send_actions_raw(
        &self,
        signer_id: &AccountId,
        receiver: &AccountId,
        actions: Vec<Action>,
        signer: Arc<Signer>,
    ) -> Result<Tx, String> {
        let mut tx = Transaction::construct(signer_id.clone(), receiver.clone());
        for action in actions {
            tx = tx.add_action(action);
        }
        self.sign_and_send_raw(tx.with_signer(signer)).await
    }

    /// A function-call key on `account`, scoped to `receiver` and `methods`, added with the
    /// account's full-access key. This is what a web wallet creates when a user signs in to
    /// a dapp: the console holds one for the owner, and it must not be enough to change
    /// policy or move money.
    pub async fn add_function_call_key(
        &self,
        account: &AccountId,
        receiver: &AccountId,
        methods: &[&str],
        allowance: Option<NearToken>,
    ) -> Arc<Signer> {
        let (secret, public) = new_key();
        let permission = AccessKeyPermission::FunctionCall(FunctionCallPermission {
            allowance,
            receiver_id: receiver.to_string(),
            method_names: methods.iter().map(|method| (*method).to_owned()).collect(),
        });
        self.add_key_directly(account, permission, public, self.root.clone())
            .await
            .unwrap_or_else(|err| {
                panic!("adding a function-call key to {account} was not accepted: {err}")
            })
            .assert_ok();
        signer_for(secret)
    }

    /// A second mock-ft on `name.sandbox`, its supply held by the owner, with the vault
    /// registered on it. The vault is not configured for it: this is the foreign token.
    pub async fn deploy_foreign_token(&self, name: &str) -> AccountId {
        let token = sandbox_account(name);
        self.create_account(&token, NearToken::from_near(50)).await;
        self.deploy(
            &token,
            mock_ft_wasm(),
            "new",
            json!({ "owner_id": self.owner, "total_supply": TOTAL_SUPPLY.to_string() }),
        )
        .await
        .assert_ok();
        self.register_on(&token, std::slice::from_ref(&self.vault))
            .await;
        token
    }

    async fn sign_and_send_raw(&self, unsigned: ExecuteSignedTransaction) -> Result<Tx, String> {
        let signed = unsigned
            .presign_with(&self.network)
            .await
            .map_err(|err| format!("{err:?}"))?;
        self.send_signed_raw(signed).await
    }

    /// Posts an already signed transaction with `send_tx`, waiting for FINAL. `Err` carries
    /// the RPC's whole error object, `data` included. An executed transaction, failed or
    /// not, is read back through the typed client so the caller gets an ordinary `Tx`.
    async fn send_signed_raw(&self, signed: ExecuteSignedTransaction) -> Result<Tx, String> {
        use near_sdk::base64::Engine as _;

        let signed = signed
            .transaction
            .signed()
            .ok_or("the transaction was not signed")?;
        let signer_id = signed.transaction.signer_id().clone();
        let hash = signed.get_hash();
        let bytes = near_sdk::borsh::to_vec(&signed).map_err(|err| err.to_string())?;
        let request = json!({
            "jsonrpc": "2.0",
            "id": "sandbox-tests",
            "method": "send_tx",
            "params": {
                "signed_tx_base64": near_sdk::base64::engine::general_purpose::STANDARD.encode(bytes),
                "wait_until": "FINAL",
            },
        });
        let response = rpc_post(&self.sandbox.rpc_addr, &request).await?;
        if let Some(error) = response.get("error") {
            return Err(error.to_string());
        }
        let result = Transaction::status_with_options(signer_id, hash, TxExecutionStatus::Final)
            .fetch_from(&self.network)
            .await
            .map_err(|err| {
                format!("the RPC took the transaction but its status is unreadable: {err:?}")
            })?;
        Ok(Tx { result })
    }

    // ---- views --------------------------------------------------------------------------

    pub async fn view<T: DeserializeOwned + Send + Sync>(
        &self,
        contract: &AccountId,
        method: &str,
        args: Value,
    ) -> T {
        match Contract(contract.clone())
            .call_function(method, args)
            .read_only::<T>()
            .fetch_from(&self.network)
            .await
        {
            Ok(data) => data.data,
            Err(err) => panic!("view {contract}.{method} failed: {err:?}"),
        }
    }

    pub async fn vault_view<T: DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> T {
        self.view(&self.vault, method, args).await
    }

    pub async fn registry_view<T: DeserializeOwned + Send + Sync>(
        &self,
        method: &str,
        args: Value,
    ) -> T {
        self.view(&self.registry, method, args).await
    }

    pub async fn ft_balance_on(&self, token: &AccountId, account: &AccountId) -> u128 {
        let balance: Value = self
            .view(token, "ft_balance_of", account_arg(account))
            .await;
        lenient_u128(&balance).unwrap_or_else(|| panic!("ft_balance_of returned {balance}"))
    }

    pub async fn ft_balance(&self, account: &AccountId) -> u128 {
        self.ft_balance_on(&self.token, account).await
    }

    pub async fn is_registered_on(&self, token: &AccountId, account: &AccountId) -> bool {
        let balance: Value = self
            .view(token, "storage_balance_of", account_arg(account))
            .await;
        !balance.is_null()
    }

    pub async fn is_registered(&self, account: &AccountId) -> bool {
        self.is_registered_on(&self.token, account).await
    }

    pub async fn config(&self) -> VaultConfig {
        self.vault_view("get_config", json!({})).await
    }

    pub async fn config_json(&self) -> Value {
        self.vault_view("get_config", json!({})).await
    }

    pub async fn today(&self) -> u64 {
        let day: Value = self.vault_view("today", json!({})).await;
        lenient_u64(&day).unwrap_or_else(|| panic!("today() returned {day}"))
    }

    pub async fn spent_today(&self) -> u128 {
        let spent: Value = self.vault_view("spent_today", json!({})).await;
        lenient_u128(&spent).unwrap_or_else(|| panic!("spent_today() returned {spent}"))
    }

    pub async fn remaining_today(&self) -> Option<u128> {
        let remaining: Value = self.vault_view("remaining_today", json!({})).await;
        if remaining.is_null() {
            return None;
        }
        Some(
            lenient_u128(&remaining)
                .unwrap_or_else(|| panic!("remaining_today() returned {remaining}")),
        )
    }

    /// Registry DENY refusals only (amendment A2).
    pub async fn refusal_count(&self, payee: &AccountId) -> u64 {
        let count: Value = self
            .vault_view("refusal_count", json!({ "payee": payee }))
            .await;
        lenient_u64(&count).unwrap_or_else(|| panic!("refusal_count() returned {count}"))
    }

    /// What the agent recorded with `record_refusal` (amendment A2).
    pub async fn guard_refusal_count(&self, payee: &AccountId) -> u64 {
        let count: Value = self
            .vault_view("guard_refusal_count", json!({ "payee": payee }))
            .await;
        lenient_u64(&count).unwrap_or_else(|| panic!("guard_refusal_count() returned {count}"))
    }

    pub async fn paid_count(&self, payee: &AccountId) -> u64 {
        let count: Value = self
            .vault_view("paid_count", json!({ "payee": payee }))
            .await;
        lenient_u64(&count).unwrap_or_else(|| panic!("paid_count() returned {count}"))
    }

    pub async fn held(&self, held_id: u64) -> Option<HeldView> {
        self.vault_view("get_held", held_args(held_id)).await
    }

    /// The ids in `list_held`. The spec names the HeldPayment fields but not the container,
    /// so both a list of payments (each carrying `id`) and a list of `[id, payment]` pairs
    /// are read.
    pub async fn held_ids(&self) -> Vec<u64> {
        let list: Vec<Value> = self
            .vault_view("list_held", json!({ "from_index": null, "limit": null }))
            .await;
        list.iter()
            .map(|item| {
                let id = match item {
                    Value::Array(pair) => pair.first(),
                    _ => item.get("id").or_else(|| item.get("held_id")),
                };
                id.and_then(lenient_u64)
                    .unwrap_or_else(|| panic!("list_held item without an id: {item}"))
            })
            .collect()
    }

    pub async fn agent_record(&self, public_key: &PublicKey) -> Option<AgentView> {
        self.vault_view("get_agent", json!({ "public_key": public_key }))
            .await
    }

    /// `list_agents()` as text. Its shape is not pinned, so tests only ask what it mentions.
    pub async fn agents_text(&self) -> String {
        let agents: Value = self.vault_view("list_agents", json!({})).await;
        agents.to_string()
    }

    pub async fn is_allowed(&self, payee: &AccountId) -> bool {
        self.vault_view("is_allowed", json!({ "payee": payee }))
            .await
    }

    pub async fn allowlist_text(&self) -> String {
        let list: Value = self
            .vault_view(
                "list_allowlist",
                json!({ "from_index": null, "limit": null }),
            )
            .await;
        list.to_string()
    }

    pub async fn verdict(&self, subject: &AccountId) -> Option<VerdictView> {
        self.registry_view("get_verdict", account_arg(subject))
            .await
    }

    pub async fn check(&self, subject: &AccountId) -> CheckView {
        self.registry_view("check", account_arg(subject)).await
    }

    pub async fn near_balance(&self, account: &AccountId) -> NearToken {
        Account(account.clone())
            .view()
            .fetch_from(&self.network)
            .await
            .unwrap_or_else(|err| panic!("view account {account}: {err:?}"))
            .data
            .amount
    }

    /// Bytes of state (code included) the account pays storage stake for, at 1e19 yoctoNEAR
    /// per byte.
    pub async fn storage_usage(&self, account: &AccountId) -> u64 {
        Account(account.clone())
            .view()
            .fetch_from(&self.network)
            .await
            .unwrap_or_else(|err| panic!("view account {account}: {err:?}"))
            .data
            .storage_usage
    }

    pub async fn has_contract(&self, account: &AccountId) -> bool {
        let view = Account(account.clone())
            .view()
            .fetch_from(&self.network)
            .await
            .unwrap_or_else(|err| panic!("view account {account}: {err:?}"))
            .data;
        !matches!(view.contract_state, ContractState::None)
    }

    /// The access key `public_key` on `account`, or None when the account has no such key.
    /// Read from the key list so that "absent" is an answer, not an RPC error to classify.
    pub async fn access_key(
        &self,
        account: &AccountId,
        public_key: &PublicKey,
    ) -> Option<AccessKey> {
        self.access_keys(account)
            .await
            .into_iter()
            .find(|(key, _)| key == public_key)
            .map(|(_, access_key)| access_key)
    }

    /// Every access key on `account`.
    pub async fn access_keys(&self, account: &AccountId) -> Vec<(PublicKey, AccessKey)> {
        Account(account.clone())
            .list_keys()
            .fetch_from(&self.network)
            .await
            .unwrap_or_else(|err| panic!("list keys of {account}: {err:?}"))
            .data
    }

    /// What is left of an agent key's gas allowance, or None when the key is gone.
    pub async fn agent_allowance(&self, public_key: &PublicKey) -> Option<NearToken> {
        let key = self.access_key(&self.vault, public_key).await?;
        let allowance = function_call_permission(&key).allowance;
        Some(
            allowance
                .unwrap_or_else(|| panic!("an agent key must never have an unlimited allowance")),
        )
    }

    // ---- time ---------------------------------------------------------------------------

    /// The timestamp of the latest block, in nanoseconds: the clock contracts see.
    pub async fn chain_time_ns(&self) -> u64 {
        Chain::block()
            .fetch_from(&self.network)
            .await
            .expect("fetch the latest block")
            .header
            .timestamp
    }

    pub async fn chain_time_s(&self) -> u64 {
        self.chain_time_ns().await / NS_PER_S
    }

    /// Moves the block clock strictly past `target_ns`.
    ///
    /// The loop re-reads the clock rather than trusting a blocks-to-seconds figure, because
    /// how far `sandbox_fast_forward` moves the timestamp is a node setting, not an API
    /// promise. It is bounded in wall time, so a node whose clock does not move fails the
    /// test instead of hanging it.
    pub async fn advance_time_past_ns(&self, target_ns: u64) {
        let deadline = Instant::now() + Duration::from_secs(300);
        loop {
            let now = self.chain_time_ns().await;
            if now > target_ns {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "the block clock did not pass {target_ns} within 300 s of wall time (now {now})"
            );
            self.sandbox
                .fast_forward(FAST_FORWARD_BLOCKS)
                .await
                .expect("sandbox_fast_forward");
        }
    }

    /// Moves the block clock past the end of the unix second `second`, so a check written
    /// as `now_s > second` holds for the next block.
    pub async fn advance_time_past_second(&self, second: u64) {
        self.advance_time_past_ns((second + 1) * NS_PER_S).await;
    }
}

//! AgentSpendPolicy, on NEAR.
//!
//! A vault that custodies a NEP-141 token for an AI agent and enforces the agent's spend policy ON
//! CHAIN: a per-UTC-day cap, a per-payment auto-approve ceiling, a payee allowlist, a freeze
//! switch and per-key expiry, plus A-Identity's counterparty verdict, read from the registry
//! contract before every payment. The human owner sets the policy, freezes, settles or rejects
//! held payments, and withdraws. The agent may only pay inside the policy, ask the owner, or
//! record a refusal its own guard made. Anything outside the policy is refused on chain, with a
//! typed reason, a receipt and an event.
//!
//! This is the third sibling of `mcp/contracts/AgentSpendPolicy.sol` and the Soroban port in
//! `soroban/contracts/agent-spend-policy`. What is deliberately identical is the ORDER the shared
//! gates fire in and the meaning of a zero (a 0 cap, a 0 ceiling and a 0 expiry all mean "no
//! bound"), because the console and the spend-preflight API already assume both. The behaviour is
//! not identical; `policy.rs` and `error.rs` list every difference and why.
//!
//! ## The key model
//!
//! The agent has no account of its own. It holds one function-call access key that lives ON THE
//! VAULT ACCOUNT, created by this contract in `add_agent_key` with receiver = the vault and
//! method names exactly `pay,request_payment,record_refusal`, plus a NEAR gas allowance. The
//! protocol, not this contract, then guarantees that the key can only ever call those three
//! methods here, can never attach a deposit (so it cannot call the token's 1-yocto `ft_transfer`,
//! move NEAR, add or delete keys, or deploy code), and can burn at most its allowance on gas.
//! The allowance caps NEAR, not tokens; the token is capped by the policy. `revoke_agent_key`
//! marks the record revoked and deletes the key from the account, so a revoked agent cannot even
//! sign.
//!
//! The vault account itself should carry NO full-access key. Such a key is total control (it can
//! redeploy the code or delete the account) and nothing in a contract can bound it.
//!
//! ## The one check this contract rests on
//!
//! `authenticate_agent` requires `env::predecessor_account_id() == env::current_account_id()`
//! AND that `env::signer_account_pk()` is a registered, non-revoked agent key. Both halves are
//! load-bearing. The signer's public key survives every hop of a cross-contract call chain, so on
//! its own it only proves that some transaction somewhere was signed with that key; a contract the
//! key holder was lured into calling could forward a `pay`. Requiring the predecessor to be the
//! vault makes it mean "this transaction was sent by the vault account itself", which is only
//! possible with a key on the vault account, and the only keys this contract ever adds are the
//! restricted ones above. Anything else panics `NotAgent`, which writes nothing and logs nothing,
//! so an outsider cannot spam the vault's event log either.
//!
//! The same fact cuts the other way for callbacks. Because the agent's key signs AS the vault,
//! `#[private]` (predecessor == current account) does not keep the agent out of a callback; the
//! key's method-name restriction does. So keys are only ever added with the fixed method list,
//! and every callback additionally requires exactly one promise result (`require_callback`): a
//! scheduled callback always has one, a direct call has none.
//!
//! ## What silence means (amendment A1)
//!
//! A registry has no verdict on most accounts, and an account created minutes ago is exactly
//! the payee no registry has seen yet. So a registry's silence is not an ALLOW: with
//! `hold_unknown` on (the default at init), an agent `pay` to a payee the registry is silent on
//! (or with no registry set) transfers only if the owner listed the payee (`set_allowed`, the
//! allowlist gate on or off) or the vault has paid it before (`paid_count > 0`). Otherwise the
//! payment is held for the owner with reason `UnknownPayee`, and its reservation released. The
//! owner's `owner_pay` of that hold is the one human tap, and the payment it makes is what
//! makes later payments to the payee flow. A flagged payee is refused on chain either way.
//!
//! ## Two refusal counters (amendment A2)
//!
//! `refusal_count(payee)` counts only the registry's DENY refusals. What the agent records with
//! `record_refusal` goes to `guard_refusal_count(payee)`: any agent key, a prompt-injected one
//! included, can record a refusal against any payee, so that count is this vault's agent's
//! word, never a signal another vault should read about the payee.
//!
//! ## Reservation before every external call
//!
//! NEAR is asynchronous: between a cross-contract call and its callback, any number of other
//! transactions can run against this vault. So the day's budget is reserved (written) BEFORE the
//! registry or the token is called, and given back only when the payment is refused, held or
//! fails, and only if the reservation still belongs to the current day. Concurrent payments
//! therefore all count against the cap the moment they start, and a callback that never runs
//! leaves the budget charged, which fails closed. Callbacks read promise results as raw bytes and
//! never abort on anything a registry or token can send (`verdict.rs`).
//!
//! ## What is not here, on purpose
//!
//! No upgrade method and no owner transfer. An upgrade path is a second total-authority door,
//! which is the wrong trade for a contract whose whole claim is bounded authority. The escape
//! hatch is the one that already exists: `withdraw`, deploy a new vault, repoint the agent.
//!
//! No NEAR withdrawal. The vault's NEAR pays its own storage, each new payee's token storage
//! registration and its agent keys' gas; the owner tops it up with a plain transfer.
//!
//! No synchronous balance gate. A contract cannot read its token balance synchronously; an
//! underfunded vault fails at `ft_transfer` and the transfer callback rolls the reservation back.
//!
//! ## Gas, and what the agent key's allowance has to hold
//!
//! The agent's key signs as the vault account, so the vault's NEAR pays for every agent
//! transaction, and the key's allowance caps how much of it the key can spend. The protocol takes
//! a transaction's whole prepaid gas out of the allowance (and the vault's balance) upfront, at
//! `max(gas_price, min_gas_purchase_price)`, which is 0.001 NEAR per Tgas since protocol 85, and
//! credits the unused part back when the receipts finish. Every Tgas of static budget the vault
//! reserves is allowance the agent has to hold, so the `GAS_*` budgets are sized from
//! measurement, not generosity.
//!
//! Measured on near-sandbox 2.14.0 (protocol 88, the version testnet runs) with this crate's
//! release wasm, the A-Identity registry and the workspace's mock-ft (`sandbox-tests/tests/
//! gas.rs` records every figure below):
//!
//! * A payment that lands (registry check, payee registration, transfer, callback) burns 13.7
//!   Tgas across its receipts: `pay` 2.3, `get_verdict` 1.3, `on_verdict` 2.9, `storage_deposit`
//!   1.7, `ft_transfer` 1.7, `on_transfer` 1.8, and the gas refunds. A DENY, a WARN hold, an
//!   unknown-payee hold and a held request each burn about 6.5 Tgas, and `record_refusal` 2.4.
//!   The owner's `owner_pay` burns about 14, `withdraw` 6.4 and `add_agent_key` 5.2.
//! * The smallest prepaid gas at which a payment lands through the registry is 51 Tgas, for
//!   the lightest ALLOW and for the heaviest one the registry can produce (every verdict field
//!   at its limit, a 128-byte memo, a 64-byte payee id). With 50, `pay` aborts while scheduling,
//!   at its first receipt, and nothing it wrote is kept. The floor is the static schedule
//!   (`GAS_REGISTRY_VIEW` + `GAS_ON_VERDICT` + about 4 Tgas of `pay` itself), not what burns.
//! * That schedule is only safe if every callback can finish on its static budget alone, which
//!   is all it gets when the agent attaches exactly the floor. A budget below its callback's need
//!   is worse than a high floor: `pay` schedules, the callback runs dry, and the day's
//!   reservation is stranded with no event. Measured: with a 37 Tgas budget `on_verdict` ran dry
//!   on the lightest ALLOW already, with 39 it settled the heaviest, so its 42 keeps 3 Tgas over
//!   its need.
//! * So `AGENT_PREPAID_GAS`, 73 Tgas, is what to attach to `pay` and `request_payment`: the
//!   smallest whole figure that keeps 30 percent of it free over the 51 Tgas floor. 10 Tgas is
//!   enough for `record_refusal`. The margin flows to `on_verdict` and `on_transfer`, never to
//!   the token or the registry, which get exactly their budgets.
//! * The allowance this implies: 0.073 NEAR held for each payment in flight, and only the burnt
//!   gas actually spent, at the network's gas price, the rest credited back: 0.0012 NEAR per
//!   landed payment at 0.0001 NEAR per Tgas. 0.1 NEAR covers ten payments one after the other
//!   (measured: ten charged 0.0122 NEAR) and still would at twice the gas price; ten at once need
//!   ten holds, 0.73 NEAR. A 0.25 NEAR allowance runs three payments at once, and roughly 140 in
//!   total before the key can no longer prepay 73 Tgas and the owner has to issue a new one (an
//!   allowance cannot be topped up: revoke, forget, add). The vault's liquid NEAR must cover the
//!   same upfront hold, or the protocol refuses the agent's transaction before it executes.
//!
//! Outside the allowance, the vault's NEAR also pays the token's storage registration of each
//! new payee (0.00125 NEAR on testnet USDC; refunded when the payee is already registered,
//! measured: a payment to a new payee cost the vault 0.0024 NEAR, one to a known payee 0.0012).
//! The allowance bounds gas, not that, and a registration is not refunded when the transfer
//! after it fails. With `hold_unknown` on, only a payee the registry says ALLOW for, the owner
//! listed, or the vault already paid ever reaches that registration, so a leaked agent key
//! cannot spend it on accounts of its own making; a payee nobody vouches for is held before
//! the token is called. With it off, an agent key that keeps paying new payees can spend about
//! as much again in registrations as in gas, and only the allowlist bounds that.
//!
//! Storage is another matter. Holds are bounded (`MAX_PENDING_HELD`), but `record_refusal`
//! creates a guard counter for each payee it names, and a payee name does not have to be an
//! existing account, so a leaked agent key can lock the vault's NEAR in counters: up to about
//! 0.0011 NEAR of storage per call against about 0.0002 NEAR of burnt allowance, roughly 5
//! times the allowance it has left. Nothing moves and the counters stay readable, but nothing
//! deletes them either. Revoking the key stops it; a bound on it needs a new error name, which
//! is ABI, so it is left for a version that adds one.
//!
//! Keep a little NEAR beyond all that. A hold, or the first counter for a payee, adds storage
//! (a held payment with an ed25519 agent key is at most about 0.005 NEAR), and a callback whose
//! new storage the vault cannot cover fails at the end of its receipt. That fails closed (no
//! money moves, and the day's reservation stays charged until the UTC day rolls over) but it
//! leaves no event. The paying path checks for 0.01 NEAR of headroom before it attaches the
//! registration deposit (`can_fund`) and reports `TransferFailed` instead of trying.

mod error;
mod event;
mod policy;
mod types;
mod verdict;

#[cfg(test)]
mod test;

pub use crate::error::Error;
pub use crate::event::{RefusalSource, VaultEvent};
pub use crate::policy::{MAX_LABEL_BYTES, MAX_MEMO_BYTES, MAX_PENDING_HELD, MAX_REASON_BYTES};
pub use crate::types::{
    AgentKey, AgentKeyView, HeldPayment, HeldPaymentView, PayMode, PayOutcome, PayStatus,
    PaymentCtx, VaultConfig,
};
pub use crate::verdict::Answer;

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U64, U128};
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, PublicKey, env, ext_contract, near,
};

use crate::policy::Snapshot;

/// Most agent key records, revoked ones included until they are forgotten. Each record is a
/// real access key on the vault account, and each key can burn gas from the vault's balance.
pub const MAX_AGENT_KEYS: u32 = 5;
/// Most payees on the allowlist. Bounded so `list_allowlist` and the vault's storage stay small.
pub const MAX_ALLOWLIST: u32 = 100;
/// How long a held payment waits for the owner before it expires.
pub const HELD_TTL_S: u64 = 86_400;
/// The only methods an agent key may call. Passed verbatim to the protocol as the key's
/// permission, and the reason `#[private]` callbacks are out of the agent's reach.
pub const AGENT_METHODS: &str = "pay,request_payment,record_refusal";
/// Reported by `get_config()`.
pub const VERSION: &str = "agent-spend-policy 0.1.0";
/// The held reason when a `pay` is held because the registry said WARN.
pub const REASON_REGISTRY_WARN: &str = "RegistryWarn";
/// The held reason when a `pay` is held because nobody has judged the payee: the registry has
/// no verdict on it (or no registry is set), the owner has not listed it, and the vault has
/// never paid it. See `set_hold_unknown`.
pub const REASON_UNKNOWN_PAYEE: &str = "UnknownPayee";

// Static gas per hop. A budget pays for the callee's own execution only. The receipt's fees
// (about 1.2 Tgas per cross-contract call at protocol 88: 0.3 to send it, 0.9 prepaid for its
// execution) come out of the caller's gas on top. The external calls get exactly their budget
// (weight 0), so a token or a registry cannot burn the agent's spare gas; the vault's own
// callbacks also inherit whatever the caller left over (weight 1). "Used" below is what a
// receipt burnt minus the execution fees its caller prepaid, measured as described under "Gas"
// in the crate docs.

/// `registry.get_verdict`, a view. Measured: 0.4 Tgas of this budget used. If a registry needs
/// more, the call fails and the payment is refused `RegistryUnavailable`, the safe direction.
pub const GAS_REGISTRY_VIEW: Gas = Gas::from_tgas(5);
/// `on_verdict`: read and parse the answer, then either decide (refuse, hold) or schedule the
/// transfer chain, which reserves the three budgets below (35 Tgas). It must be able to do that
/// on this budget alone, because that is all it has when the agent attached exactly the floor:
/// measured, it ran dry at 37 Tgas on the lightest ALLOW already and settled the heaviest ALLOW
/// the registry can produce at 39. The 3 Tgas over that are for a longer reply from another
/// registry, up to the vault's read limit. Paths that hold or refuse schedule nothing and have all 42, the heaviest of them
/// a hold that prunes a full held map first. Every Tgas here raises the smallest prepaid gas at
/// which a payment lands by one, so it is sized to the paying path rather than rounded up; the
/// agent's margin over it arrives as leftover gas.
pub const GAS_ON_VERDICT: Gas = Gas::from_tgas(42);
/// The token's `storage_deposit` for the payee. Measured on mock-ft: 0.6 to 0.8 Tgas used (a new
/// payee's registration, an existing payee's refund). The margin
/// is for a production token, which can do more work here (Circle's USDC also checks its pause
/// switch and its blocklist).
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
/// The token's `ft_transfer`. Measured on mock-ft: 0.8 Tgas used. Kept wide for the same reason:
/// a token that runs out of gas here fails the payment (`TransferFailed`, reservation released),
/// which is safe, but it is a payment that should have gone through.
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// `on_transfer`: one counter and one or two events. Measured: 0.9 Tgas used. It must never run
/// dry, because it is where a failed transfer gives the day's budget back and where a landed
/// one gets its `payment_sent`, so it keeps a wide margin although trimming it would lower the
/// floor: a dry `on_transfer` is money moved with no event.
pub const GAS_ON_TRANSFER: Gas = Gas::from_tgas(10);
/// `on_agent_key_added`. An owner transaction, not paid from an agent's allowance.
pub const GAS_ON_KEY_ADDED: Gas = Gas::from_tgas(10);
/// `on_withdraw`. Measured: 0.6 Tgas used. An owner transaction.
pub const GAS_ON_WITHDRAW: Gas = Gas::from_tgas(10);
/// The prepaid gas an agent attaches to `pay` and `request_payment`, public so the SDK and the
/// docs quote one number. Measured: the longest path (registry check, then `storage_deposit`,
/// `ft_transfer` and `on_transfer`) cannot even be scheduled below 51 Tgas, and 73 is the
/// smallest whole figure that keeps 30 percent of it over that floor (51 is 69.9 percent of
/// 73). It is also what the agent key's allowance holds per payment in flight: 0.073 NEAR at
/// the protocol's 0.001 NEAR per Tgas purchase price, credited back except for what burns.
pub const AGENT_PREPAID_GAS: Gas = Gas::from_tgas(73);

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// NEAR kept free above the storage stake when the vault attaches a deposit, so the receipt that
/// attaches it cannot then fail its own end-of-receipt storage check.
const STORAGE_HEADROOM: NearToken = NearToken::from_millinear(10);

/// Collection prefixes. Order is frozen once deployed: a reordered variant points a collection
/// at another collection's data.
#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Allowlist,
    Agents,
    Held,
    Refusals,
    PaidCount,
    GuardRefusals,
}

/// The two NEP-141/NEP-145 methods the vault calls on its token.
#[ext_contract(ext_token)]
pub trait Nep141Token {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// The one registry method the vault calls. Its JSON reply is public ABI between the two crates:
/// `null`, or an object whose top-level `verdict` is a plain string.
#[ext_contract(ext_registry)]
pub trait AIdentityRegistry {
    fn get_verdict(&self, account_id: AccountId);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentSpendPolicy {
    owner_id: AccountId,
    token_id: AccountId,
    /// `None` means no on-chain verdict check; every payment goes straight to the transfer.
    registry_id: Option<AccountId>,
    /// The token's `storage_balance_bounds().min`, attached to register a payee before paying it.
    token_storage_deposit: NearToken,
    frozen: bool,
    /// Token units; 0 means no cap.
    daily_cap: u128,
    /// Token units per payment; 0 means no ceiling.
    auto_approve_max: u128,
    allowlist_enabled: bool,
    /// Owner-listed payees. With `allowlist_enabled` they are the only payees the agent may
    /// pay; with or without it, a listed payee counts as known for `hold_unknown`.
    allowlist: IterableSet<AccountId>,
    /// True (the default at init): an agent `pay` to a payee nobody has judged is held for the
    /// owner instead of transferred. See `set_hold_unknown`.
    hold_unknown: bool,
    agents: IterableMap<PublicKey, AgentKey>,
    /// The UTC day `spent_today` belongs to. The accumulator is reset lazily when the day changes.
    day: u64,
    spent_today: u128,
    held: IterableMap<u64, HeldPayment>,
    next_payment_id: u64,
    next_held_id: u64,
    /// Feeds `AgentKey::nonce`. Internal; see `on_agent_key_added`.
    next_key_nonce: u64,
    /// Registry DENY refusals only, the one count another vault or the off-chain engine may read
    /// as a signal about the payee. Never the vault's own policy refusals, which say nothing
    /// about the payee, and never what an agent records (`guard_refusals`).
    refusals: LookupMap<AccountId, u32>,
    /// Successful payments to each payee: the "prior interactions" signal the off-chain engine
    /// reads, and what makes a payee known for `hold_unknown`.
    paid_count: LookupMap<AccountId, u32>,
    /// Refusals the agent recorded with `record_refusal`. Kept apart from `refusals` because any
    /// agent key, a prompt-injected one included, can record a refusal against any payee: this
    /// count says what this vault's agent believed, never what is true about the payee, so it
    /// must not feed a reputation signal that crosses vaults.
    guard_refusals: LookupMap<AccountId, u32>,
}

#[near]
impl AgentSpendPolicy {
    /// Initialize the vault. Deploy and init happen in one batch from the owner, so there is no
    /// window in which the contract exists uninitialized for someone else to claim.
    ///
    /// A vault that owned itself would let any agent key (which signs as the vault account)
    /// satisfy the owner check, so `owner_id == vault` is refused. A token at the vault's own
    /// address would make every payment a payment to the vault.
    ///
    /// Also schedules the vault's own registration on the token, paid from the vault's NEAR, so
    /// deposits can arrive. If the vault cannot afford it the call is skipped, and if it fails
    /// nothing else breaks; `register_with_token` retries it.
    #[init]
    pub fn new(
        owner_id: AccountId,
        token_id: AccountId,
        registry_id: Option<AccountId>,
        token_storage_deposit: U128,
        daily_cap: U128,
        auto_approve_max: U128,
    ) -> Self {
        let vault_id = env::current_account_id();
        if owner_id == vault_id {
            Error::OwnerIsVault.panic();
        }
        if token_id == vault_id {
            Error::InvalidPayee.panic();
        }
        let this = Self {
            owner_id,
            token_id,
            registry_id,
            token_storage_deposit: NearToken::from_yoctonear(token_storage_deposit.0),
            frozen: false,
            daily_cap: daily_cap.0,
            auto_approve_max: auto_approve_max.0,
            allowlist_enabled: false,
            allowlist: IterableSet::new(StorageKey::Allowlist),
            hold_unknown: true,
            agents: IterableMap::new(StorageKey::Agents),
            day: policy::day_index(env::block_timestamp()),
            spent_today: 0,
            held: IterableMap::new(StorageKey::Held),
            next_payment_id: 1,
            next_held_id: 1,
            next_key_nonce: 1,
            refusals: LookupMap::new(StorageKey::Refusals),
            paid_count: LookupMap::new(StorageKey::PaidCount),
            guard_refusals: LookupMap::new(StorageKey::GuardRefusals),
        };
        VaultEvent::VaultInitialized {
            owner_id: &this.owner_id,
            token_id: &this.token_id,
            registry_id: this.registry_id.as_ref(),
        }
        .emit();
        if can_fund(this.token_storage_deposit) {
            this.token_registration().detach();
        }
        this
    }

    // -- owner: agent keys ------------------------------------------------------------------

    /// Grant an agent key. Creates a function-call access key ON THE VAULT ACCOUNT, receiver =
    /// the vault, methods exactly `AGENT_METHODS`, with `allowance` yoctoNEAR of gas allowance.
    ///
    /// The record is written first, so the key authenticates the moment the protocol adds it. If
    /// the add fails (for example the account already has that key), `on_agent_key_added` removes
    /// the record again and emits `agent_key_add_failed`. A zero allowance is refused rather than
    /// turned into an unlimited one: unlimited would let a leaked key burn the vault's whole NEAR
    /// balance on gas.
    #[payable]
    pub fn add_agent_key(
        &mut self,
        public_key: PublicKey,
        label: String,
        expires_at_s: U64,
        allowance: U128,
    ) -> Promise {
        self.assert_owner_one_yocto();
        if policy::check_text(Some(&label), MAX_LABEL_BYTES).is_err() {
            Error::MemoTooLong.panic();
        }
        let gas_allowance = Allowance::limited(NearToken::from_yoctonear(allowance.0))
            .unwrap_or_else(|| Error::InvalidAmount.panic());
        if self.agents.len() >= MAX_AGENT_KEYS {
            Error::KeyLimitReached.panic();
        }
        if self.agents.contains_key(&public_key) {
            Error::KeyExists.panic();
        }
        let nonce = self.next_key_nonce;
        self.next_key_nonce = nonce
            .checked_add(1)
            .unwrap_or_else(|| Error::MathOverflow.panic());
        VaultEvent::AgentKeyAdded {
            public_key: &public_key,
            label: &label,
            expires_at_s,
            allowance,
        }
        .emit();
        self.agents.insert(
            public_key.clone(),
            AgentKey {
                label,
                expires_at_s: expires_at_s.0,
                revoked: false,
                added_at_s: policy::seconds(env::block_timestamp()),
                nonce,
            },
        );
        let vault_id = env::current_account_id();
        Promise::new(vault_id.clone())
            .add_access_key_allowance(
                public_key.clone(),
                gas_allowance,
                vault_id.clone(),
                AGENT_METHODS,
            )
            .then(
                Self::ext(vault_id)
                    .with_static_gas(GAS_ON_KEY_ADDED)
                    .on_agent_key_added(public_key, U64(nonce)),
            )
    }

    /// Revoke an agent key: the record is marked revoked in THIS receipt, so the contract refuses
    /// the key immediately, even before the scheduled `delete_key` lands and even if it were to
    /// fail. The record is kept for audit; `forget_agent_key` removes it. Revoking an already
    /// revoked key re-issues the delete, which is a harmless retry.
    #[payable]
    pub fn revoke_agent_key(&mut self, public_key: PublicKey) {
        self.assert_owner_one_yocto();
        match self.agents.get_mut(&public_key) {
            Some(key) => key.revoked = true,
            None => Error::KeyNotFound.panic(),
        }
        VaultEvent::AgentKeyRevoked {
            public_key: &public_key,
        }
        .emit();
        Promise::new(env::current_account_id())
            .delete_key(public_key)
            .detach();
    }

    /// Remove a revoked key's record, freeing a slot under `MAX_AGENT_KEYS`. Only after revoke,
    /// so a live key can never lose its record while the access key still exists on chain.
    #[payable]
    pub fn forget_agent_key(&mut self, public_key: PublicKey) {
        self.assert_owner_one_yocto();
        match self.agents.get(&public_key) {
            None => Error::KeyNotFound.panic(),
            Some(key) if !key.revoked => Error::KeyNotRevoked.panic(),
            Some(_) => {}
        }
        self.agents.remove(&public_key);
    }

    /// Set the Unix second after which the key's payments are refused `SessionKeyExpired`. A
    /// future time grants or extends, a past time ends the session, and 0 removes the bound.
    #[payable]
    pub fn set_agent_expiry(&mut self, public_key: PublicKey, expires_at_s: U64) {
        self.assert_owner_one_yocto();
        match self.agents.get_mut(&public_key) {
            Some(key) => key.expires_at_s = expires_at_s.0,
            None => Error::KeyNotFound.panic(),
        }
        VaultEvent::AgentExpirySet {
            public_key: &public_key,
            expires_at_s,
        }
        .emit();
    }

    // -- owner: policy ----------------------------------------------------------------------

    #[payable]
    pub fn set_policy(&mut self, daily_cap: U128, auto_approve_max: U128, allowlist_enabled: bool) {
        self.assert_owner_one_yocto();
        self.daily_cap = daily_cap.0;
        self.auto_approve_max = auto_approve_max.0;
        self.allowlist_enabled = allowlist_enabled;
        VaultEvent::PolicyUpdated {
            daily_cap,
            auto_approve_max,
            allowlist_enabled,
        }
        .emit();
    }

    /// Add or remove an allowlisted payee. Removing an absent payee is a no-op that still emits,
    /// like Solidity's `setAllowed`.
    #[payable]
    pub fn set_allowed(&mut self, payee: AccountId, ok: bool) {
        self.assert_owner_one_yocto();
        if ok {
            if !self.allowlist.contains(&payee) && self.allowlist.len() >= MAX_ALLOWLIST {
                Error::AllowlistFull.panic();
            }
            self.allowlist.insert(payee.clone());
        } else {
            self.allowlist.remove(&payee);
        }
        VaultEvent::AllowlistSet { payee: &payee, ok }.emit();
    }

    /// Point the vault at a registry, or at none. With none, payments skip the verdict check
    /// (and, under `hold_unknown`, a payee that is not known waits for the owner).
    #[payable]
    pub fn set_registry(&mut self, registry_id: Option<AccountId>) {
        self.assert_owner_one_yocto();
        self.registry_id = registry_id;
        VaultEvent::RegistrySet {
            registry_id: self.registry_id.as_ref(),
        }
        .emit();
    }

    /// Whether an agent `pay` to a payee nobody has judged waits for the owner. On by default.
    ///
    /// "Nobody has judged" means the registry answered no verdict (or no registry is set), the
    /// owner has not listed the payee (`set_allowed`, whether or not the allowlist gate is on),
    /// and the vault has never paid it. Such a payment is held with reason `UnknownPayee` and
    /// its reservation released, as for a WARN. Without this, a prompt-injected agent could pay
    /// an account created minutes ago, which no registry has seen yet, up to the caps. The
    /// owner's `owner_pay` of such a hold transfers, and the payment it makes is what makes the
    /// payee known, so later payments to it flow. ALLOW, WARN and DENY verdicts mean what they
    /// always meant; this only decides what silence means.
    #[payable]
    pub fn set_hold_unknown(&mut self, hold_unknown: bool) {
        self.assert_owner_one_yocto();
        self.hold_unknown = hold_unknown;
        VaultEvent::HoldUnknownSet { hold_unknown }.emit();
    }

    /// The panic button. Deliberately does NOT require the yocto: it must work in one click from
    /// a function-call key the console holds, without a wallet confirmation. Making things safer
    /// needs no second factor; `unfreeze` does.
    pub fn freeze(&mut self) {
        self.assert_owner();
        self.frozen = true;
        VaultEvent::FrozenSet { frozen: true }.emit();
    }

    #[payable]
    pub fn unfreeze(&mut self) {
        self.assert_owner_one_yocto();
        self.frozen = false;
        VaultEvent::FrozenSet { frozen: false }.emit();
    }

    // -- owner: held payments and funds -----------------------------------------------------

    /// Settle a held payment the owner approves. Bypasses the freeze, the key expiry, the
    /// allowlist, the ceiling and the cap check (it is a human act), STILL adds to the day's total
    /// like Solidity's `ownerPay`, and does NOT bypass the registry: a payee that the registry
    /// now says DENY is refused even for the owner, because a held payment may have waited while
    /// the payee was flagged. The owner can still withdraw and pay outside the vault; that is
    /// stated, not hidden.
    ///
    /// The held entry is removed when the pipeline starts, so it cannot be settled twice by two
    /// concurrent approvals. If the settlement then fails, `held_settle_failed` carries what the
    /// agent needs to request it again. An expired entry is removed and reported rather than
    /// panicking, so the removal persists.
    #[payable]
    pub fn owner_pay(&mut self, held_id: U64) -> PromiseOrValue<PayOutcome> {
        self.assert_owner_one_yocto();
        let held = self
            .held
            .get(&held_id.0)
            .cloned()
            .unwrap_or_else(|| Error::HeldNotFound.panic());
        let now_ns = env::block_timestamp();
        let today = policy::day_index(now_ns);
        let ctx = PaymentCtx {
            payment_id: U64(held.payment_id),
            mode: PayMode::OwnerPay,
            agent_pk: held.agent_pk,
            payee: held.payee,
            amount: U128(held.amount),
            memo: held.memo,
            day: U64(today),
            reason: None,
            held_id: Some(held_id),
        };
        if policy::is_expired(held.expires_at_s, policy::seconds(now_ns)) {
            self.held.remove(&held_id.0);
            VaultEvent::HeldExpired { held_id }.emit();
            return PromiseOrValue::Value(refused(
                &ctx,
                Error::HeldExpired.as_str(),
                RefusalSource::Policy,
                &[],
            ));
        }
        let vault_id = env::current_account_id();
        let next = {
            // The agent key's expiry plays no part in the owner's ladder.
            let snapshot = self.snapshot(&vault_id, &ctx.payee, 0, now_ns);
            policy::check_owner_pay(&snapshot, &ctx.payee, ctx.amount.0)
        };
        let next = match next {
            Ok(next) => next,
            // The entry stays: nothing has started, and the owner can still reject it.
            Err(err) => {
                return PromiseOrValue::Value(refused(
                    &ctx,
                    err.as_str(),
                    RefusalSource::Policy,
                    &[],
                ));
            }
        };
        self.held.remove(&held_id.0);
        self.reserve(today, next);
        self.route(ctx)
    }

    /// Drop a held payment without paying it.
    #[payable]
    pub fn owner_reject(&mut self, held_id: U64) {
        self.assert_owner_one_yocto();
        if self.held.remove(&held_id.0).is_none() {
            Error::HeldNotFound.panic();
        }
        VaultEvent::HeldRejected { held_id }.emit();
    }

    /// Move tokens back to the owner. There is deliberately no `to` argument: a compromised
    /// console session that can get the owner to sign a withdrawal still cannot send the funds
    /// to a third party. Not counted against the day, because it is the owner reclaiming their
    /// own money rather than the agent spending it.
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.assert_owner_one_yocto();
        if policy::check_amount(amount.0).is_err() {
            Error::InvalidAmount.panic();
        }
        ext_token::ext(self.token_id.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FT_TRANSFER)
            .with_unused_gas_weight(0)
            .ft_transfer(self.owner_id.clone(), amount, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_WITHDRAW)
                    .on_withdraw(amount),
            )
    }

    /// Retry the vault's own storage registration on the token, paid from the vault's NEAR. If
    /// the vault is already registered, NEP-145 refunds the deposit.
    pub fn register_with_token(&mut self) -> Promise {
        self.assert_owner();
        self.token_registration()
    }

    /// NEP-141 deposit hook. Only the configured token is kept: a foreign token's full amount is
    /// returned, so its sender is refunded and the vault never ends up holding something its
    /// policy does not govern.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = msg;
        if env::predecessor_account_id() != self.token_id {
            return PromiseOrValue::Value(amount);
        }
        VaultEvent::Deposited {
            sender_id: &sender_id,
            amount,
        }
        .emit();
        PromiseOrValue::Value(U128(0))
    }

    // -- the agent path ---------------------------------------------------------------------

    /// Agent payment, bounded by the policy and by the registry's verdict. A payee the registry
    /// is silent on and nobody vouches for is held for the owner (`hold_unknown`).
    ///
    /// The returned outcome is the product: it says exactly why the human-in-the-loop path should
    /// take over, as a name the caller can match on rather than a message to parse. A policy
    /// refusal is NOT a panic; it is `status: "refused"` with a `payment_refused` event, so every
    /// refusal has a receipt. Only a failed authentication panics.
    pub fn pay(
        &mut self,
        payee: AccountId,
        amount: U128,
        memo: Option<String>,
    ) -> PromiseOrValue<PayOutcome> {
        let (agent_pk, key_expires_at_s) = self.authenticate_agent();
        let payment_id = self.take_payment_id();
        let now_ns = env::block_timestamp();
        let today = policy::day_index(now_ns);
        let vault_id = env::current_account_id();
        let verdict = {
            let snapshot = self.snapshot(&vault_id, &payee, key_expires_at_s, now_ns);
            policy::check_agent_pay(&snapshot, &payee, amount.0, memo.as_deref())
        };
        let ctx = PaymentCtx {
            payment_id: U64(payment_id),
            mode: PayMode::Pay,
            agent_pk,
            payee,
            amount,
            memo,
            day: U64(today),
            reason: None,
            held_id: None,
        };
        match verdict {
            Ok(next) => {
                // Reserve BEFORE any external call; refund on refusal or failure.
                self.reserve(today, next);
                self.route(ctx)
            }
            Err(err) => {
                PromiseOrValue::Value(refused(&ctx, err.as_str(), RefusalSource::Policy, &[]))
            }
        }
    }

    /// Ask the owner to approve a payment: when the agent's own check said WARN, or the amount is
    /// above the ceiling. Runs only the argument gates, the freeze and the key expiry, then the
    /// held limit, and reserves nothing; the registry is still consulted, and a DENY refuses the
    /// request outright.
    pub fn request_payment(
        &mut self,
        payee: AccountId,
        amount: U128,
        memo: Option<String>,
        reason: String,
    ) -> PromiseOrValue<PayOutcome> {
        let (agent_pk, key_expires_at_s) = self.authenticate_agent();
        let payment_id = self.take_payment_id();
        let now_ns = env::block_timestamp();
        let vault_id = env::current_account_id();
        let mut verdict = self.check_request(
            &vault_id,
            &payee,
            amount.0,
            memo.as_deref(),
            &reason,
            key_expires_at_s,
            now_ns,
        );
        if verdict == Err(Error::HeldLimitReached) {
            // Every earlier gate passed; make room by dropping expired entries, then ask again.
            self.prune_expired_held(policy::seconds(now_ns));
            verdict = self.check_request(
                &vault_id,
                &payee,
                amount.0,
                memo.as_deref(),
                &reason,
                key_expires_at_s,
                now_ns,
            );
        }
        let ctx = PaymentCtx {
            payment_id: U64(payment_id),
            mode: PayMode::Request,
            agent_pk,
            payee,
            amount,
            memo,
            day: U64(policy::day_index(now_ns)),
            reason: Some(reason),
            held_id: None,
        };
        match verdict {
            Ok(()) => self.route(ctx),
            Err(err) => {
                PromiseOrValue::Value(refused(&ctx, err.as_str(), RefusalSource::Policy, &[]))
            }
        }
    }

    /// Record a DENY that the agent's off-chain A-Identity guard made, so the refusal is on chain
    /// with a receipt and an event even though nothing was ever about to move. Increments the
    /// payee's `guard_refusal_count`, never its `refusal_count`: this is the agent's own word,
    /// and an agent key (a prompt-injected one included) can say it about any payee.
    pub fn record_refusal(&mut self, payee: AccountId, amount: U128, reason: String) -> PayOutcome {
        let (agent_pk, key_expires_at_s) = self.authenticate_agent();
        let payment_id = self.take_payment_id();
        let now_ns = env::block_timestamp();
        let vault_id = env::current_account_id();
        let verdict = {
            let snapshot = self.snapshot(&vault_id, &payee, key_expires_at_s, now_ns);
            policy::check_agent_record(&snapshot, &payee, amount.0, &reason)
        };
        let ctx = PaymentCtx {
            payment_id: U64(payment_id),
            mode: PayMode::Request,
            agent_pk,
            payee,
            amount,
            memo: None,
            day: U64(policy::day_index(now_ns)),
            reason: None,
            held_id: None,
        };
        match verdict {
            Ok(()) => {
                bump(&mut self.guard_refusals, &ctx.payee);
                refused(&ctx, &reason, RefusalSource::AgentGuard, &[])
            }
            Err(err) => refused(&ctx, err.as_str(), RefusalSource::Policy, &[]),
        }
    }

    // -- callbacks --------------------------------------------------------------------------

    /// The registry's answer. MUST NOT abort for any answer: the reservation made in `pay` or
    /// `owner_pay` is only released here. The result is read as raw, bounded bytes and parsed by
    /// `verdict::read_answer`, never by a typed callback argument that would abort on bytes it
    /// did not expect. A failed call, a reply that is too long, malformed JSON or an unknown
    /// verdict all fail CLOSED as `RegistryUnavailable`.
    #[private]
    pub fn on_verdict(&mut self, ctx: PaymentCtx) -> PromiseOrValue<PayOutcome> {
        require_callback();
        let answer = match env::promise_result_checked(0, verdict::MAX_ANSWER_BYTES) {
            Ok(bytes) => verdict::read_answer(&bytes),
            // `Failed`, `TooLong`, and any variant a later near-sdk adds to the non-exhaustive
            // `PromiseError`: a verdict the vault could not read is not an ALLOW.
            Err(_) => Answer::Unusable,
        };
        self.after_verdict(ctx, answer)
    }

    /// The token transfer's result. Success counts the payment and emits `payment_sent`; failure
    /// releases the reservation (only if it still belongs to today) and emits `payment_failed`.
    /// Success is read from the promise status alone (`promise_succeeded`), so no reply body
    /// can make this abort.
    #[private]
    pub fn on_transfer(&mut self, ctx: PaymentCtx) -> PayOutcome {
        require_callback();
        if !promise_succeeded() {
            return self.transfer_failed(&ctx);
        }
        bump(&mut self.paid_count, &ctx.payee);
        VaultEvent::PaymentSent {
            payment_id: ctx.payment_id,
            payee: &ctx.payee,
            amount: ctx.amount,
            day: ctx.day,
            by_owner: ctx.mode == PayMode::OwnerPay,
            memo: ctx.memo.as_deref(),
        }
        .emit();
        PayOutcome {
            status: PayStatus::Sent,
            payment_id: ctx.payment_id,
            reason: None,
            held_id: ctx.held_id,
        }
    }

    /// The add-key action's result. On failure the record `add_agent_key` wrote is removed, but
    /// only if it is still the record that call wrote (same `nonce`): between the add and this
    /// callback the owner may have revoked, forgotten and re-added the same public key, and the
    /// newer record must survive an older add's failure.
    #[private]
    pub fn on_agent_key_added(&mut self, public_key: PublicKey, nonce: U64) -> bool {
        require_callback();
        if promise_succeeded() {
            return true;
        }
        if self
            .agents
            .get(&public_key)
            .is_some_and(|key| key.nonce == nonce.0)
        {
            self.agents.remove(&public_key);
        }
        VaultEvent::AgentKeyAddFailed {
            public_key: &public_key,
        }
        .emit();
        false
    }

    /// The withdrawal's result, as an event either way.
    #[private]
    pub fn on_withdraw(&mut self, amount: U128) -> bool {
        require_callback();
        if promise_succeeded() {
            VaultEvent::Withdrawn { amount }.emit();
            true
        } else {
            VaultEvent::WithdrawFailed { amount }.emit();
            false
        }
    }

    // -- views ------------------------------------------------------------------------------

    pub fn get_config(&self) -> VaultConfig {
        VaultConfig {
            owner_id: self.owner_id.clone(),
            token_id: self.token_id.clone(),
            registry_id: self.registry_id.clone(),
            frozen: self.frozen,
            daily_cap: U128(self.daily_cap),
            auto_approve_max: U128(self.auto_approve_max),
            allowlist_enabled: self.allowlist_enabled,
            token_storage_deposit: U128(self.token_storage_deposit.as_yoctonear()),
            version: VERSION.to_owned(),
            hold_unknown: self.hold_unknown,
        }
    }

    /// The current UTC day index, as the contract computes it.
    pub fn today(&self) -> U64 {
        U64(policy::day_index(env::block_timestamp()))
    }

    /// Spent so far today, reservations of in-flight payments included. 0 if the stored total
    /// belongs to an earlier day.
    pub fn spent_today(&self) -> U128 {
        U128(self.current_spent())
    }

    /// What the cap still allows today, or `None` when there is no cap.
    pub fn remaining_today(&self) -> Option<U128> {
        if self.daily_cap == 0 {
            return None;
        }
        Some(U128(self.daily_cap.saturating_sub(self.current_spent())))
    }

    pub fn get_agent(&self, public_key: PublicKey) -> Option<AgentKeyView> {
        self.agents
            .get(&public_key)
            .map(|key| AgentKeyView::new(&public_key, key))
    }

    pub fn list_agents(&self) -> Vec<AgentKeyView> {
        self.agents
            .iter()
            .map(|(pk, key)| AgentKeyView::new(pk, key))
            .collect()
    }

    /// Held payments, expired ones included until something prunes them; compare `expires_at_s`
    /// with block time to tell them apart.
    pub fn list_held(&self, from_index: Option<U64>, limit: Option<U64>) -> Vec<HeldPaymentView> {
        let (from, take) = page(from_index, limit, MAX_PENDING_HELD);
        self.held
            .iter()
            .skip(from)
            .take(take)
            .map(|(_, held)| HeldPaymentView::from(held))
            .collect()
    }

    pub fn get_held(&self, held_id: U64) -> Option<HeldPaymentView> {
        self.held.get(&held_id.0).map(HeldPaymentView::from)
    }

    pub fn is_allowed(&self, payee: AccountId) -> bool {
        self.allowlist.contains(&payee)
    }

    pub fn list_allowlist(&self, from_index: Option<U64>, limit: Option<U64>) -> Vec<AccountId> {
        let (from, take) = page(from_index, limit, MAX_ALLOWLIST);
        self.allowlist
            .iter()
            .skip(from)
            .take(take)
            .cloned()
            .collect()
    }

    /// How often the registry's DENY refused a payment to `payee` here. Only registry verdicts
    /// count, so this is the number that may be read as a signal about the payee.
    pub fn refusal_count(&self, payee: AccountId) -> u32 {
        self.refusals.get(&payee).copied().unwrap_or(0)
    }

    /// How often this vault's agent recorded its own guard's refusal of `payee`. The agent's
    /// word, not a fact about the payee; see `record_refusal`.
    pub fn guard_refusal_count(&self, payee: AccountId) -> u32 {
        self.guard_refusals.get(&payee).copied().unwrap_or(0)
    }

    pub fn paid_count(&self, payee: AccountId) -> u32 {
        self.paid_count.get(&payee).copied().unwrap_or(0)
    }
}

// -- internals ------------------------------------------------------------------------------

impl AgentSpendPolicy {
    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner_id {
            Error::NotOwner.panic();
        }
    }

    /// Exactly one yoctoNEAR forces a full-access-key signature, because a function-call key can
    /// never attach a deposit. So a function-call key a web wallet created for the console can
    /// read, and can freeze, but can never change policy or move money.
    fn assert_owner_one_yocto(&self) {
        self.assert_owner();
        if env::attached_deposit() != ONE_YOCTO {
            Error::RequiresOneYocto.panic();
        }
    }

    /// See the crate docs, "The one check this contract rests on". Returns the key and its expiry.
    fn authenticate_agent(&self) -> (PublicKey, u64) {
        if env::predecessor_account_id() != env::current_account_id() {
            Error::NotAgent.panic();
        }
        let public_key = env::signer_account_pk();
        let expires_at_s = match self.agents.get(&public_key) {
            Some(key) if !key.revoked => key.expires_at_s,
            _ => Error::NotAgent.panic(),
        };
        (public_key, expires_at_s)
    }

    /// Every authenticated attempt gets an id, refusals included. Overflow is unreachable (2^64
    /// attempts) and is refused rather than wrapped, so an id is never reused.
    fn take_payment_id(&mut self) -> u64 {
        let id = self.next_payment_id;
        self.next_payment_id = id
            .checked_add(1)
            .unwrap_or_else(|| Error::MathOverflow.panic());
        id
    }

    /// Like `take_payment_id`, but called from callbacks, so overflow is an answer, not an abort.
    fn take_held_id(&mut self) -> Option<u64> {
        let id = self.next_held_id;
        self.next_held_id = id.checked_add(1)?;
        Some(id)
    }

    fn current_spent(&self) -> u128 {
        policy::spent_on(
            self.day,
            self.spent_today,
            policy::day_index(env::block_timestamp()),
        )
    }

    fn snapshot<'a>(
        &'a self,
        vault_id: &'a AccountId,
        payee: &AccountId,
        key_expires_at_s: u64,
        now_ns: u64,
    ) -> Snapshot<'a> {
        Snapshot {
            vault_id,
            token_id: &self.token_id,
            frozen: self.frozen,
            key_expires_at_s,
            now_s: policy::seconds(now_ns),
            allowlist_enabled: self.allowlist_enabled,
            // Read the set only when it matters; a storage read costs gas.
            payee_allowed: self.allowlist_enabled && self.allowlist.contains(payee),
            auto_approve_max: self.auto_approve_max,
            daily_cap: self.daily_cap,
            spent_today: policy::spent_on(self.day, self.spent_today, policy::day_index(now_ns)),
            held_count: self.held.len(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn check_request(
        &self,
        vault_id: &AccountId,
        payee: &AccountId,
        amount: u128,
        memo: Option<&str>,
        reason: &str,
        key_expires_at_s: u64,
        now_ns: u64,
    ) -> Result<(), Error> {
        let snapshot = self.snapshot(vault_id, payee, key_expires_at_s, now_ns);
        policy::check_agent_request(&snapshot, payee, amount, memo, reason)
    }

    /// Commit the day total the ladder computed. Rolls the accumulator over to `today` first.
    fn reserve(&mut self, today: u64, next: u128) {
        self.day = today;
        self.spent_today = next;
    }

    /// Give back what `reserve` took for this payment, if it was taken today. `Request` reserved
    /// nothing, so it releases nothing.
    fn release(&mut self, ctx: &PaymentCtx) {
        if ctx.mode == PayMode::Request {
            return;
        }
        let today = policy::day_index(env::block_timestamp());
        self.spent_today =
            policy::release(self.day, self.spent_today, ctx.day.0, today, ctx.amount.0);
    }

    /// Ask the registry, or skip straight to the decision when there is none.
    fn route(&mut self, ctx: PaymentCtx) -> PromiseOrValue<PayOutcome> {
        match self.registry_id.clone() {
            None => self.after_verdict(ctx, Answer::NoVerdict),
            Some(registry_id) => PromiseOrValue::Promise(
                ext_registry::ext(registry_id)
                    .with_static_gas(GAS_REGISTRY_VIEW)
                    .with_unused_gas_weight(0)
                    .get_verdict(ctx.payee.clone())
                    .then(
                        Self::ext(env::current_account_id())
                            .with_static_gas(GAS_ON_VERDICT)
                            .on_verdict(ctx),
                    ),
            ),
        }
    }

    /// The decision table. Called from `on_verdict`, or directly when no registry is set (which
    /// reads as no verdict).
    ///
    /// | answer           | Pay                          | Request       | OwnerPay  |
    /// |------------------|------------------------------|---------------|-----------|
    /// | unusable         | release, refuse              | refuse        | release, refuse |
    /// | DENY             | release, count, refuse       | count, refuse | release, count, refuse |
    /// | WARN             | release, hold `RegistryWarn` | hold          | transfer  |
    /// | null, unknown    | release, hold `UnknownPayee` | hold          | transfer  |
    /// | null, known      | re-check, transfer           | hold          | transfer  |
    /// | ALLOW            | re-check, transfer           | hold          | transfer  |
    ///
    /// "Unknown" is `hold_unknown` on and a payee the owner has not listed and the vault has
    /// never paid (`is_unknown`). It only changes what silence means for the agent's own `pay`:
    /// a request is held anyway, and the owner settling a hold is the human it would ask.
    fn after_verdict(&mut self, ctx: PaymentCtx, answer: Answer) -> PromiseOrValue<PayOutcome> {
        let outcome = match answer {
            Answer::Unusable => {
                self.release(&ctx);
                refused_settlement(
                    &ctx,
                    Error::RegistryUnavailable.as_str(),
                    RefusalSource::Registry,
                    &[],
                )
            }
            Answer::Deny { reasons } => {
                self.release(&ctx);
                bump(&mut self.refusals, &ctx.payee);
                refused_settlement(
                    &ctx,
                    Error::RegistryDeny.as_str(),
                    RefusalSource::Registry,
                    &reasons,
                )
            }
            Answer::Warn => match ctx.mode {
                PayMode::Pay => {
                    self.release(&ctx);
                    self.hold(&ctx, REASON_REGISTRY_WARN)
                }
                PayMode::Request => {
                    let reason = ctx.reason.clone().unwrap_or_default();
                    self.hold(&ctx, &reason)
                }
                // The owner is the human a WARN asks for.
                PayMode::OwnerPay => return self.transfer(ctx),
            },
            // Silence about a payee nobody vouches for is not an ALLOW. Held like a WARN, and
            // before the in-flight re-check, like a WARN: a hold moves nothing, and the owner
            // reads it, whatever happened to the freeze or the key meanwhile.
            Answer::NoVerdict if ctx.mode == PayMode::Pay && self.is_unknown(&ctx.payee) => {
                self.release(&ctx);
                self.hold(&ctx, REASON_UNKNOWN_PAYEE)
            }
            Answer::Allow | Answer::NoVerdict => match ctx.mode {
                PayMode::Pay => match self.in_flight_refusal(&ctx) {
                    None => return self.transfer(ctx),
                    Some(err) => {
                        self.release(&ctx);
                        refused(&ctx, err.as_str(), RefusalSource::Policy, &[])
                    }
                },
                // The agent asked for a human; a clean verdict does not change that.
                PayMode::Request => {
                    let reason = ctx.reason.clone().unwrap_or_default();
                    self.hold(&ctx, &reason)
                }
                PayMode::OwnerPay => return self.transfer(ctx),
            },
        };
        PromiseOrValue::Value(outcome)
    }

    /// Amendment A1: with `hold_unknown` on, a payee is unknown unless the owner listed it or the
    /// vault has paid it before. A payee's first payment therefore waits for one human tap
    /// (`owner_pay`), and the `paid_count` that payment writes lets the next ones flow. The flag
    /// is read first, so a vault with it off pays for no storage reads here.
    fn is_unknown(&self, payee: &AccountId) -> bool {
        self.hold_unknown
            && !self.allowlist.contains(payee)
            && self.paid_count.get(payee).copied().unwrap_or(0) == 0
    }

    /// The freeze is the owner's panic button, and revoking a key is how the owner stops one
    /// agent. A payment that passed the ladder before either happened is still in flight while
    /// the registry answers, so both, and the key's clock, are checked again at the last moment
    /// before any money moves. Without this, a payment started a block before the freeze would
    /// still settle after it.
    fn in_flight_refusal(&self, ctx: &PaymentCtx) -> Option<Error> {
        let key = match self.agents.get(&ctx.agent_pk) {
            Some(key) if !key.revoked => key,
            _ => return Some(Error::NotAgent),
        };
        if self.frozen {
            return Some(Error::Frozen);
        }
        if policy::is_expired(key.expires_at_s, policy::seconds(env::block_timestamp())) {
            return Some(Error::SessionKeyExpired);
        }
        None
    }

    /// Register the payee on the token, then transfer, then report. The vault pays the payee's
    /// storage registration from its own NEAR (NEP-145 refunds it if the payee is already
    /// registered) and the 1 yoctoNEAR `ft_transfer` requires. If the vault cannot afford that,
    /// attaching it would abort this receipt (and, from a callback, strand the reservation), so
    /// the payment is reported failed instead.
    fn transfer(&mut self, ctx: PaymentCtx) -> PromiseOrValue<PayOutcome> {
        if !can_fund(self.token_storage_deposit) {
            return PromiseOrValue::Value(self.transfer_failed(&ctx));
        }
        let token_id = self.token_id.clone();
        PromiseOrValue::Promise(
            ext_token::ext(token_id.clone())
                .with_attached_deposit(self.token_storage_deposit)
                .with_static_gas(GAS_STORAGE_DEPOSIT)
                .with_unused_gas_weight(0)
                .storage_deposit(Some(ctx.payee.clone()), Some(true))
                .then(
                    ext_token::ext(token_id)
                        .with_attached_deposit(ONE_YOCTO)
                        .with_static_gas(GAS_FT_TRANSFER)
                        .with_unused_gas_weight(0)
                        .ft_transfer(ctx.payee.clone(), ctx.amount, ctx.memo.clone()),
                )
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_ON_TRANSFER)
                        .on_transfer(ctx),
                ),
        )
    }

    fn transfer_failed(&mut self, ctx: &PaymentCtx) -> PayOutcome {
        self.release(ctx);
        let reason = Error::TransferFailed.as_str();
        VaultEvent::PaymentFailed {
            payment_id: ctx.payment_id,
            payee: &ctx.payee,
            amount: ctx.amount,
            reason,
        }
        .emit();
        settle_failed(ctx, reason);
        PayOutcome {
            status: PayStatus::Failed,
            payment_id: ctx.payment_id,
            reason: Some(reason.to_owned()),
            held_id: ctx.held_id,
        }
    }

    /// Put a payment in front of the owner. Prunes expired entries only when the map is full, so
    /// the common path stays cheap; refuses `HeldLimitReached` (never aborts) when still full.
    fn hold(&mut self, ctx: &PaymentCtx, reason: &str) -> PayOutcome {
        let now_s = policy::seconds(env::block_timestamp());
        if policy::check_held_capacity(self.held.len()).is_err() {
            self.prune_expired_held(now_s);
        }
        if let Err(err) = policy::check_held_capacity(self.held.len()) {
            return refused(ctx, err.as_str(), RefusalSource::Policy, &[]);
        }
        let Some(held_id) = self.take_held_id() else {
            return refused(
                ctx,
                Error::MathOverflow.as_str(),
                RefusalSource::Policy,
                &[],
            );
        };
        self.held.insert(
            held_id,
            HeldPayment {
                id: held_id,
                payment_id: ctx.payment_id.0,
                agent_pk: ctx.agent_pk.clone(),
                payee: ctx.payee.clone(),
                amount: ctx.amount.0,
                memo: ctx.memo.clone(),
                reason: reason.to_owned(),
                created_at_s: now_s,
                expires_at_s: now_s.saturating_add(HELD_TTL_S),
            },
        );
        VaultEvent::PaymentHeld {
            payment_id: ctx.payment_id,
            held_id: U64(held_id),
            payee: &ctx.payee,
            amount: ctx.amount,
            reason,
        }
        .emit();
        PayOutcome {
            status: PayStatus::Held,
            payment_id: ctx.payment_id,
            reason: Some(reason.to_owned()),
            held_id: Some(U64(held_id)),
        }
    }

    /// Drop every held payment past its time to live, with a `held_expired` event each. Bounded
    /// by `MAX_PENDING_HELD`, so the walk is cheap and cannot be grown into a gas bomb.
    fn prune_expired_held(&mut self, now_s: u64) {
        let expired: Vec<u64> = self
            .held
            .iter()
            .filter(|(_, held)| policy::is_expired(held.expires_at_s, now_s))
            .map(|(id, _)| *id)
            .collect();
        for held_id in expired {
            self.held.remove(&held_id);
            VaultEvent::HeldExpired {
                held_id: U64(held_id),
            }
            .emit();
        }
    }

    fn token_registration(&self) -> Promise {
        ext_token::ext(self.token_id.clone())
            .with_attached_deposit(self.token_storage_deposit)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .with_unused_gas_weight(0)
            .storage_deposit(Some(env::current_account_id()), Some(true))
    }
}

/// Emit `payment_refused` and build the matching outcome. Every refused outcome goes through
/// here, which is what keeps "status refused" and "a payment_refused event" one-to-one.
fn refused(
    ctx: &PaymentCtx,
    reason: &str,
    source: RefusalSource,
    registry_reasons: &[String],
) -> PayOutcome {
    VaultEvent::PaymentRefused {
        payment_id: ctx.payment_id,
        payee: &ctx.payee,
        amount: ctx.amount,
        reason,
        source,
        registry_reasons,
    }
    .emit();
    PayOutcome {
        status: PayStatus::Refused,
        payment_id: ctx.payment_id,
        reason: Some(reason.to_owned()),
        held_id: ctx.held_id,
    }
}

/// A refusal decided after the pipeline started: also tells the owner when it was their
/// settlement that did not go through.
fn refused_settlement(
    ctx: &PaymentCtx,
    reason: &str,
    source: RefusalSource,
    registry_reasons: &[String],
) -> PayOutcome {
    let outcome = refused(ctx, reason, source, registry_reasons);
    settle_failed(ctx, reason);
    outcome
}

/// For an owner settlement that did not complete: the held entry is already gone, so this event
/// is where the owner and the agent read what was not paid.
fn settle_failed(ctx: &PaymentCtx, reason: &str) {
    if ctx.mode != PayMode::OwnerPay {
        return;
    }
    if let Some(held_id) = ctx.held_id {
        VaultEvent::HeldSettleFailed {
            held_id,
            reason,
            payment_id: ctx.payment_id,
            payee: &ctx.payee,
            amount: ctx.amount,
            memo: ctx.memo.as_deref(),
        }
        .emit();
    }
}

/// A scheduled callback always has exactly one promise result and comes from the vault itself.
/// `#[private]` checks the second half before this runs; the first half is what an agent key,
/// which also signs as the vault, cannot fake with a direct call.
fn require_callback() {
    if env::predecessor_account_id() != env::current_account_id()
        || env::promise_results_count() != 1
    {
        Error::NotCallback.panic();
    }
}

/// Whether the one call a callback waited on succeeded, read from its status alone.
///
/// `promise_result_checked(0, 0)` copies none of the reply into the contract, so no reply size
/// can run a callback out of gas here. Only `Failed` means the call failed. `TooLong` means it
/// succeeded with a body: NEP-141's `ft_transfer` returns none, but a token that answers with
/// one has still moved the money. A variant a later near-sdk adds to the non-exhaustive
/// `PromiseError` can only describe the body too, because a body exists only when the call
/// succeeded, so the wildcard counts as success. Callers have already run `require_callback`,
/// so result 0 exists.
fn promise_succeeded() -> bool {
    match env::promise_result_checked(0, 0) {
        Ok(_) => true,
        Err(PromiseError::Failed) => false,
        Err(_) => true,
    }
}

/// Add one to a per-payee counter. Saturating, because the callbacks bump counters and a
/// callback must never abort; a counter stuck at `u32::MAX` still says "at least this many".
fn bump(counter: &mut LookupMap<AccountId, u32>, payee: &AccountId) {
    let count = counter.get(payee).copied().unwrap_or(0);
    counter.insert(payee.clone(), count.saturating_add(1));
}

/// Whether the vault's NEAR above its storage stake covers `deposit`, the 1 yoctoNEAR transfer
/// fee and `STORAGE_HEADROOM`.
fn can_fund(deposit: NearToken) -> bool {
    let locked = env::storage_byte_cost()
        .as_yoctonear()
        .saturating_mul(u128::from(env::storage_usage()));
    let liquid = env::account_balance().as_yoctonear().saturating_sub(locked);
    let needed = deposit
        .as_yoctonear()
        .saturating_add(ONE_YOCTO.as_yoctonear())
        .saturating_add(STORAGE_HEADROOM.as_yoctonear());
    liquid >= needed
}

/// `(skip, take)` for a paginated view, with `take` capped at the collection's own bound.
fn page(from_index: Option<U64>, limit: Option<U64>, max: u32) -> (usize, usize) {
    let max = u64::from(max);
    let from = from_index.map_or(0, |v| usize::try_from(v.0).unwrap_or(usize::MAX));
    let take = limit.map_or(max, |v| v.0.min(max));
    (from, usize::try_from(take).unwrap_or(usize::MAX))
}

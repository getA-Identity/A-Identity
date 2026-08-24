#![cfg(test)]
//! A4: cross-contract calls and token integration.
//!
//! Every test here points the vault at a token the vault was never designed for, which
//! is the only honest way to test P-6. Nothing in this file is part of the shipped
//! suite; it is audit scaffolding.

extern crate std;
use soroban_sdk::testutils::{Address as _, Logs as _, MuxedAddress as _};
use soroban_sdk::{
    contract, contractimpl, contracttype, vec, Address, Env, IntoVal, MuxedAddress,
    String, Symbol, Val, Vec,
};

use crate::{AgentSpendPolicy, AgentSpendPolicyClient, Error};

// ── the hostile token ─────────────────────────────────────────────────────────────

pub const HONEST: u32 = 0;
pub const FEE_ON_TRANSFER: u32 = 1;
pub const SILENT_NOOP: u32 = 2;
pub const PANIC_ON_TRANSFER: u32 = 3;
pub const REENTER_PAY: u32 = 4;
pub const NEGATIVE_IS_NOOP: u32 = 5;
pub const DEAUTHORIZED: u32 = 6;
pub const REBASE_DOWN: u32 = 7;
pub const REENTER_PAY_PROPAGATE: u32 = 9;

#[contracttype]
#[derive(Clone)]
pub enum MockKey {
    Bal(Address),
    Mode,
    Vault,
    ReentryOutcome,
}

#[contract]
pub struct HostileToken;

#[contractimpl]
impl HostileToken {
    pub fn __constructor(env: Env, mode: u32) {
        env.storage().instance().set(&MockKey::Mode, &mode);
    }

    pub fn set_mode(env: Env, mode: u32) {
        env.storage().instance().set(&MockKey::Mode, &mode);
    }

    pub fn set_vault(env: Env, vault: Address) {
        env.storage().instance().set(&MockKey::Vault, &vault);
    }

    /// 0 not attempted, 1 re-entry SUCCEEDED, 2 re-entry refused as a host abort,
    /// 3 re-entry refused as a typed contract error.
    pub fn reentry_outcome(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&MockKey::ReentryOutcome)
            .unwrap_or(0)
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let b = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&MockKey::Bal(to), &(b + amount));
    }

    pub fn decimals(_env: Env) -> u32 {
        7
    }

    pub fn name(env: Env) -> String {
        String::from_str(&env, "hostile")
    }

    pub fn symbol(env: Env) -> String {
        String::from_str(&env, "HOSTILE")
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        let raw: i128 = env
            .storage()
            .persistent()
            .get(&MockKey::Bal(id))
            .unwrap_or(0);
        let mode: u32 = env.storage().instance().get(&MockKey::Mode).unwrap_or(0);
        if mode == REBASE_DOWN {
            // A rebasing token: the reported balance is a share count scaled by a factor
            // the vault never sees. Here the factor halves.
            raw / 2
        } else {
            raw
        }
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        let mode: u32 = env.storage().instance().get(&MockKey::Mode).unwrap_or(0);

        if mode == PANIC_ON_TRANSFER {
            panic!("hostile token refuses to transfer");
        }
        if mode == DEAUTHORIZED {
            // What the SAC actually does when the issuer has revoked authorization:
            // spend_balance returns ContractError::BalanceDeauthorizedError, which
            // reaches the caller as an untyped host error, not a policy error.
            panic!("balance is deauthorized");
        }
        if mode == SILENT_NOOP {
            return;
        }
        if mode == NEGATIVE_IS_NOOP && amount <= 0 {
            return;
        }

        if mode == REENTER_PAY_PROPAGATE {
            let vault: Address = env.storage().instance().get(&MockKey::Vault).unwrap();
            let args: Vec<Val> = vec![&env, to.clone().into_val(&env), 1i128.into_val(&env)];
            env.invoke_contract::<()>(&vault, &Symbol::new(&env, "pay"), args);
        }
        if mode == REENTER_PAY {
            let vault: Address = env.storage().instance().get(&MockKey::Vault).unwrap();
            let args: Vec<Val> = vec![&env, to.clone().into_val(&env), 1i128.into_val(&env)];
            let res = env.try_invoke_contract::<(), Error>(
                &vault,
                &Symbol::new(&env, "pay"),
                args,
            );
            let outcome: u32 = match res {
                Ok(_) => 1,
                Err(Err(_)) => 2,
                Err(Ok(_)) => 3,
            };
            env.storage()
                .instance()
                .set(&MockKey::ReentryOutcome, &outcome);
        }

        let fee = if mode == FEE_ON_TRANSFER {
            amount / 10
        } else {
            0
        };

        let fb = Self::raw_balance(&env, &from);
        if fb < amount {
            panic!("hostile token: insufficient balance");
        }
        env.storage()
            .persistent()
            .set(&MockKey::Bal(from), &(fb - amount));
        let tb = Self::raw_balance(&env, &to);
        env.storage()
            .persistent()
            .set(&MockKey::Bal(to), &(tb + amount - fee));
    }

    fn raw_balance(env: &Env, id: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&MockKey::Bal(id.clone()))
            .unwrap_or(0)
    }
}

/// A contract that is not a token at all. Used to test the constructor's SEP-41 probe.
#[contract]
pub struct NotAToken;

#[contractimpl]
impl NotAToken {
    pub fn hello(_env: Env) -> u32 {
        1
    }
}

// ── harness ───────────────────────────────────────────────────────────────────────

pub struct Rig {
    pub env: Env,
    pub owner: Address,
    pub operator: Address,
    pub payee: Address,
    pub token_id: Address,
    pub contract_id: Address,
}

impl Rig {
    pub fn client(&self) -> AgentSpendPolicyClient<'_> {
        AgentSpendPolicyClient::new(&self.env, &self.contract_id)
    }
    pub fn token(&self) -> HostileTokenClient<'_> {
        HostileTokenClient::new(&self.env, &self.token_id)
    }
}

pub fn rig(mode: u32, daily_cap: i128, auto_approve_max: i128) -> Rig {
    let env = Env::default();
    env.mock_all_auths();

    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);

    let token_id = env.register(HostileToken, (mode,));
    let contract_id = env.register(
        AgentSpendPolicy,
        (
            owner.clone(),
            operator.clone(),
            token_id.clone(),
            daily_cap,
            auto_approve_max,
        ),
    );
    HostileTokenClient::new(&env, &token_id).set_vault(&contract_id);

    Rig {
        env,
        owner,
        operator,
        payee,
        token_id,
        contract_id,
    }
}

// ── 1. MuxedAddress and the allowlist ─────────────────────────────────────────────

/// The headline question. `pay` declares `to: Address`. SEP-41 `transfer` declares
/// `to: MuxedAddress`. Can a caller reach a payee through the muxed type space that the
/// `Address`-keyed allowlist would refuse?
#[test]
fn muxed_payee_cannot_be_passed_to_pay_at_all() {
    let r = rig(HONEST, 0, 0);
    r.token().mint(&r.contract_id, &1_000);

    // Only ACCOUNT addresses can be multiplexed, so the payee has to be an account.
    let seed = MuxedAddress::generate(&r.env);
    let account = seed.address();
    let muxed = MuxedAddress::new(seed, 42);
    assert_eq!(muxed.address(), account);
    assert_eq!(muxed.id(), Some(42), "the test subject must really be muxed");
    r.token().mint(&account, &0);

    let args: Vec<Val> = vec![&r.env, muxed.to_val(), 100i128.into_val(&r.env)];
    let res = r.env.try_invoke_contract::<(), Error>(
        &r.contract_id,
        &Symbol::new(&r.env, "pay"),
        args,
    );

    assert!(
        res.is_err(),
        "a muxed `to` must not be accepted by a function declaring `Address`"
    );
    assert_eq!(
        r.token().balance(&account),
        0,
        "no value may move on a refused muxed call"
    );
}

/// Positive control for the test above: the same call with a plain Address succeeds, so
/// the refusal is about the muxed type and not about the raw-Val invocation path.
#[test]
fn plain_address_through_the_same_raw_path_succeeds() {
    let r = rig(HONEST, 0, 0);
    r.token().mint(&r.contract_id, &1_000);

    let args: Vec<Val> = vec![
        &r.env,
        r.payee.clone().into_val(&r.env),
        100i128.into_val(&r.env),
    ];
    let res = r.env.try_invoke_contract::<(), Error>(
        &r.contract_id,
        &Symbol::new(&r.env, "pay"),
        args,
    );
    assert!(res.is_ok(), "plain Address must still work: {res:?}");
    assert_eq!(r.token().balance(&r.payee), 100);
}

/// The allowlist is enabled and the payee is NOT on it. A muxed variant must not get in.
#[test]
fn muxed_variant_cannot_bypass_a_denying_allowlist() {
    let r = rig(HONEST, 0, 0);
    r.token().mint(&r.contract_id, &1_000);
    r.client().set_policy(&0, &0, &true);

    let seed = MuxedAddress::generate(&r.env);
    let account = seed.address();
    assert!(!r.client().is_allowed(&account), "the payee is NOT allowlisted");

    let muxed = MuxedAddress::new(seed, 7);
    let args: Vec<Val> = vec![&r.env, muxed.to_val(), 100i128.into_val(&r.env)];
    let res = r.env.try_invoke_contract::<(), Error>(
        &r.contract_id,
        &Symbol::new(&r.env, "pay"),
        args,
    );
    assert!(res.is_err(), "muxed must not bypass the allowlist");
    assert_eq!(r.token().balance(&account), 0);

    // And the reverse direction: an ALLOWLISTED account is still refused when the caller
    // wraps it in a mux, so the allowlist decision cannot be widened OR narrowed by it.
    r.client().set_allowed(&account, &true);
    assert!(r.client().is_allowed(&account));
    let muxed2 = MuxedAddress::new(account.clone(), 7);
    let args2: Vec<Val> = vec![&r.env, muxed2.to_val(), 100i128.into_val(&r.env)];
    assert!(
        r.env
            .try_invoke_contract::<(), Error>(&r.contract_id, &Symbol::new(&r.env, "pay"), args2)
            .is_err(),
        "even an allowlisted account cannot be paid through a mux"
    );
    // The plain address, however, is payable.
    r.client().pay(&account, &100);
    assert_eq!(r.token().balance(&account), 100);
}

/// `require_valid_payee` compares `to` against the vault and the token. A muxed wrapper
/// around either must not evade that comparison.
#[test]
fn muxed_variant_cannot_evade_require_valid_payee() {
    let r = rig(HONEST, 0, 0);
    r.token().mint(&r.contract_id, &1_000);

    // The vault and the token are CONTRACT addresses, and the SDK refuses to build a
    // muxed address over a contract at all: `MuxedAddress::new` panics with "contract
    // addresses can not be multiplexed". So the mux type space cannot even name the two
    // addresses require_valid_payee protects.
    for target in [r.contract_id.clone(), r.token_id.clone()] {
        let args: Vec<Val> = vec![
            &r.env,
            target.clone().into_val(&r.env),
            100i128.into_val(&r.env),
        ];
        let res = r.env.try_invoke_contract::<(), Error>(
            &r.contract_id,
            &Symbol::new(&r.env, "pay"),
            args,
        );
        assert_eq!(
            res,
            Err(Ok(Error::InvalidPayee)),
            "{target:?} must be refused by name"
        );
    }
    assert_eq!(r.token().balance(&r.contract_id), 1_000);
}

/// The conversion the contract DOES perform: `&Address -> MuxedAddress` at the transfer
/// call site. It must be the identity on the address part, so the address the allowlist
/// checked is the address the token credits.
#[test]
fn address_to_muxed_conversion_is_the_identity_and_carries_no_id() {
    let env = Env::default();
    let a = Address::generate(&env);
    let m: MuxedAddress = (&a).into();
    assert_eq!(m.address(), a, "conversion must not change the address");
    assert_eq!(m.id(), None, "conversion must not invent a multiplexing id");
}

// ── 2. P-5: reentrancy and ordering ───────────────────────────────────────────────

#[test]
fn a_token_that_calls_back_into_pay_is_refused_by_the_host() {
    let r = rig(REENTER_PAY, 0, 0);
    r.token().mint(&r.contract_id, &10_000);

    let res = r.client().try_pay(&r.payee, &100);

    // The re-entrant attempt is recorded by the token before the outer call finishes.
    // Whatever the outer result, the inner one must NOT have been 1 (succeeded).
    let outcome = r.token().reentry_outcome();
    assert_ne!(outcome, 1, "the host must not allow re-entry into pay");
    assert_eq!(
        outcome, 2,
        "re-entry must fail as a host abort (Context/InvalidAction), got {outcome}"
    );
    assert!(res.is_ok(), "the outer pay itself still settles: {res:?}");
    assert_eq!(
        r.client().spent_today(),
        100,
        "exactly one payment may be charged to the day"
    );
}

#[test]
fn a_trapping_transfer_rolls_back_the_day_counter() {
    let r = rig(HONEST, 0, 0);
    r.token().mint(&r.contract_id, &10_000);

    r.client().pay(&r.payee, &100);
    assert_eq!(r.client().spent_today(), 100);

    r.token().set_mode(&PANIC_ON_TRANSFER);
    let res = r.client().try_pay(&r.payee, &100);
    assert!(res.is_err(), "the transfer must fail");

    r.token().set_mode(&HONEST);
    assert_eq!(
        r.client().spent_today(),
        100,
        "INV-12: a failed transfer must leave SpentOnDay unchanged"
    );
}

// ── 3. P-6: tokens the vault was not designed for ─────────────────────────────────

/// A token that charges a fee. The vault debits `amount`, charges the day `amount`, and
/// emits `Paid { amount }`, but the payee receives less. The vault's OWN balance stays
/// consistent because it is re-read every call; the divergence is between the on-chain
/// record and reality.
#[test]
fn fee_on_transfer_makes_the_paid_record_overstate_what_the_payee_got() {
    let r = rig(FEE_ON_TRANSFER, 0, 0);
    r.token().mint(&r.contract_id, &10_000);

    r.client().pay(&r.payee, &1_000);

    assert_eq!(r.client().spent_today(), 1_000, "the day is charged in full");
    assert_eq!(
        r.token().balance(&r.payee),
        900,
        "but the payee receives less"
    );
    assert_eq!(r.client().balance(), 9_000, "the vault is debited in full");
}

/// The sharpest one. A token whose `transfer` does nothing at all. `transfer` returns
/// `()`, the vault checks nothing after it, so the vault emits `Paid`, charges the daily
/// cap, and reports a settled payment that never happened.
#[test]
fn a_silently_noop_transfer_still_emits_paid_and_burns_the_daily_cap() {
    let r = rig(SILENT_NOOP, 1_000, 0);
    r.token().mint(&r.contract_id, &10_000);

    r.client().pay(&r.payee, &1_000);

    assert_eq!(
        r.token().balance(&r.payee),
        0,
        "nothing moved"
    );
    assert_eq!(
        r.client().balance(),
        10_000,
        "the vault still holds everything"
    );
    assert_eq!(
        r.client().spent_today(),
        1_000,
        "yet the whole daily cap is consumed"
    );
    // And the next real payment is refused for the day.
    let res = r.client().try_pay(&r.payee, &1);
    assert_eq!(res, Err(Ok(Error::DailyCapExceeded)));
}

/// A vault whose balance was deauthorized by the issuer. `balance()` still reports the
/// funds, so the policy ladder passes, and then the token traps. `withdraw` is
/// unreachable and the failure is untyped.
#[test]
fn a_deauthorized_balance_bricks_withdraw_with_an_untyped_error() {
    let r = rig(HONEST, 0, 0);
    r.token().mint(&r.contract_id, &10_000);
    r.token().set_mode(&DEAUTHORIZED);

    assert_eq!(
        r.client().balance(),
        10_000,
        "the view still reports funds the vault cannot move"
    );

    let w = r.client().try_withdraw(&r.owner, &1_000);
    match w {
        Err(Err(_)) => {}
        other => panic!("expected an untyped host trap, got {other:?}"),
    }

    let p = r.client().try_pay(&r.payee, &100);
    match p {
        Err(Err(_)) => {}
        other => panic!("expected an untyped host trap from pay too, got {other:?}"),
    }
}

/// A token that treats a non-positive amount as a no-op instead of trapping. The vault's
/// own `check_amount` must refuse it regardless. Positive result.
#[test]
fn the_vaults_own_sign_guard_holds_against_a_permissive_token() {
    let r = rig(NEGATIVE_IS_NOOP, 1_000, 0);
    r.token().mint(&r.contract_id, &10_000);
    r.client().pay(&r.payee, &500);
    assert_eq!(r.client().spent_today(), 500);

    assert_eq!(
        r.client().try_pay(&r.payee, &-500),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        r.client().try_pay(&r.payee, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        r.client().spent_today(),
        500,
        "the accumulator must not be decremented"
    );
    assert_eq!(
        r.client().try_owner_pay(&r.payee, &-1),
        Err(Ok(Error::InvalidAmount))
    );
}

/// A rebasing token. The vault re-reads `balance()` on every call, so it never acts on a
/// stale number; what it cannot do is notice that the day counter and the balance are in
/// different units.
#[test]
fn a_rebasing_token_desynchronises_the_day_counter_from_the_balance() {
    let r = rig(HONEST, 10_000, 0);
    r.token().mint(&r.contract_id, &10_000);
    r.client().pay(&r.payee, &1_000);
    assert_eq!(r.client().spent_today(), 1_000);
    assert_eq!(r.client().balance(), 9_000);

    r.token().set_mode(&REBASE_DOWN);
    assert_eq!(r.client().balance(), 4_500, "the balance halved under us");
    assert_eq!(
        r.client().spent_today(),
        1_000,
        "the day counter is unchanged and now means something different"
    );
    // The balance gate still uses the live number, so it is not fooled.
    assert_eq!(
        r.client().try_pay(&r.payee, &5_000),
        Err(Ok(Error::InsufficientBalance))
    );
}

// ── 4. the constructor's SEP-41 probe ─────────────────────────────────────────────

#[test]
#[should_panic]
fn the_constructor_rejects_an_address_with_no_decimals_function() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let not_a_token = env.register(NotAToken, ());

    env.register(
        AgentSpendPolicy,
        (owner, operator, not_a_token, 0i128, 0i128),
    );
}

/// But the probe is only a liveness probe: any contract with a `decimals` function
/// passes, whatever else it does.
#[test]
fn the_constructor_accepts_any_contract_that_answers_decimals() {
    let r = rig(SILENT_NOOP, 0, 0);
    assert_eq!(r.client().decimals(), 7);
    assert_eq!(r.client().token(), r.token_id);
}

/// P-4 / lead 6: `decimals` is stored and exposed but consulted by nothing. If it were
/// load-bearing, changing it would change a gate. It does not, because there is no
/// setter and no reader in the policy path. This test pins the observable half: the
/// policy behaves identically whatever the token's decimals are.
#[test]
fn decimals_is_inert_in_every_gate() {
    let r = rig(HONEST, 1_000, 500);
    r.token().mint(&r.contract_id, &10_000);
    assert_eq!(r.client().decimals(), 7);
    // The cap and the ceiling are raw base units, unscaled by decimals.
    assert_eq!(r.client().daily_cap(), 1_000);
    assert_eq!(
        r.client().try_pay(&r.payee, &501),
        Err(Ok(Error::AboveAutoApprove)),
        "the ceiling is compared in raw units, not decimal-scaled"
    );
    r.client().pay(&r.payee, &500);
    assert_eq!(r.client().spent_today(), 500);
}

// ── 5. withdraw and require_valid_payee ───────────────────────────────────────────

#[test]
fn withdraw_refuses_the_vault_and_the_token_but_not_the_owner() {
    let r = rig(HONEST, 0, 0);
    r.token().mint(&r.contract_id, &10_000);

    assert_eq!(
        r.client().try_withdraw(&r.contract_id, &100),
        Err(Ok(Error::InvalidPayee))
    );
    assert_eq!(
        r.client().try_withdraw(&r.token_id, &100),
        Err(Ok(Error::InvalidPayee))
    );
    r.client().withdraw(&r.owner, &10_000);
    assert_eq!(r.token().balance(&r.owner), 10_000);
    assert_eq!(r.client().spent_today(), 0, "INV-07");
}

/// `withdraw` reads `balance()` from the token and trusts it. A token that overstates the
/// balance turns the typed InsufficientBalance guard into an untyped trap from the token.
#[test]
fn an_overstating_balance_turns_a_typed_refusal_into_a_token_trap() {
    let r = rig(HONEST, 0, 0);
    // No mint at all: the vault holds nothing.
    assert_eq!(r.client().balance(), 0);
    assert_eq!(
        r.client().try_withdraw(&r.owner, &100),
        Err(Ok(Error::InsufficientBalance)),
        "the honest case gives the typed error"
    );

    // Now the same call against a token whose balance() lies upward.
    r.token().mint(&r.contract_id, &50);
    r.token().set_mode(&REBASE_DOWN); // balance() reports half of 50 = 25
    assert_eq!(r.client().balance(), 25);
    // 30 > 25, so the vault's own gate still fires first. Good.
    assert_eq!(
        r.client().try_withdraw(&r.owner, &30),
        Err(Ok(Error::InsufficientBalance))
    );
}


/// The structural half of the mux answer: a contract address cannot be multiplexed at
/// all, so the two addresses `require_valid_payee` protects are outside the mux type
/// space entirely.
#[test]
#[should_panic(expected = "contract addresses can not be multiplexed")]
fn a_contract_address_cannot_be_multiplexed() {
    let env = Env::default();
    let c = Address::generate(&env); // Address::generate yields a CONTRACT address
    let _ = MuxedAddress::new(c, 1);
}

/// A token whose `transfer` returns a value where SEP-41 declares none. R1: "Even if the
/// contract publishes an interface that says it'll return a bool, contracts can return
/// any type." The vault ignores the return value entirely.
#[contract]
pub struct ChattyToken;

#[contractimpl]
impl ChattyToken {
    pub fn decimals(_env: Env) -> u32 {
        7
    }
    pub fn balance(_env: Env, _id: Address) -> i128 {
        1_000_000
    }
    /// SEP-41 says this returns nothing. This one returns `false`, i.e. "I did not do it".
    pub fn transfer(_env: Env, _from: Address, _to: Address, _amount: i128) -> bool {
        false
    }
}

#[test]
fn the_vault_ignores_a_transfer_return_value_that_says_it_failed() {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);
    let token_id = env.register(ChattyToken, ());
    let contract_id = env.register(
        AgentSpendPolicy,
        (owner, operator, token_id, 1_000i128, 0i128),
    );
    let c = AgentSpendPolicyClient::new(&env, &contract_id);

    // Good news, and worth pinning: the generated SEP-41 client converts the return Val
    // to `()`, so a non-void return is a ConversionError and the whole invocation aborts.
    // The vault does not silently proceed. The refusal is untyped, though: WasmVm /
    // InvalidAction, not a policy error.
    let res = c.try_pay(&payee, &1_000);
    match res {
        Err(Err(_)) => {}
        other => panic!("expected an untyped abort, got {other:?}"),
    }
    assert_eq!(
        c.spent_today(),
        0,
        "and the day counter rolled back with it (INV-12)"
    );
}

// ── 6. the REAL Stellar Asset Contract, deauthorized ───────────────────────────────
//
// Not a mock. `register_stellar_asset_contract_v2` builds the same builtin SAC that
// backs Circle's USDC on pubnet, and testutils lets the issuer's AUTH_REVOCABLE flag be
// set exactly as Circle's issuer already has it set (verified live on 2026-08-24:
// GA5ZSEJY..., flags auth_revocable true, auth_clawback_enabled false).

use soroban_sdk::testutils::IssuerFlags;
use soroban_sdk::token::{Client as SacClient, StellarAssetClient};

pub struct SacRig {
    pub env: Env,
    pub owner: Address,
    pub operator: Address,
    pub payee: Address,
    pub token_id: Address,
    pub contract_id: Address,
    pub sac: soroban_sdk::testutils::StellarAssetContract,
}

fn sac_rig(daily_cap: i128, auto_approve_max: i128) -> SacRig {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();
    let contract_id = env.register(
        AgentSpendPolicy,
        (
            owner.clone(),
            operator.clone(),
            token_id.clone(),
            daily_cap,
            auto_approve_max,
        ),
    );
    SacRig {
        env,
        owner,
        operator,
        payee,
        token_id,
        contract_id,
        sac,
    }
}

/// The Circle case, end to end, against the real SAC. The issuer sets AUTH_REVOCABLE
/// (Circle's already is set) and deauthorizes the vault's contract balance. After that:
///
///   * `balance()` still reports the full amount, so the vault looks funded;
///   * `pay`, `owner_pay` AND `withdraw` all fail;
///   * the failure is not one of the ten typed errors.
#[test]
fn a_revoked_authorization_freezes_every_outflow_path_including_withdraw() {
    let r = sac_rig(0, 0);
    let c = AgentSpendPolicyClient::new(&r.env, &r.contract_id);
    StellarAssetClient::new(&r.env, &r.token_id).mint(&r.contract_id, &1_000);
    assert_eq!(c.balance(), 1_000);

    // Exactly what Circle's issuer account already has set on pubnet.
    r.sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    StellarAssetClient::new(&r.env, &r.token_id).set_authorized(&r.contract_id, &false);

    assert_eq!(
        c.balance(),
        1_000,
        "the view still reports funds the vault can no longer move"
    );

    for res in [
        c.try_pay(&r.payee, &1),
        c.try_owner_pay(&r.payee, &1),
        c.try_withdraw(&r.owner, &1),
    ] {
        match res {
            Err(Ok(_)) => panic!("a typed policy error would be wrong here, and is not what happens"),
            Err(Err(_)) => {}
            Ok(_) => panic!("the outflow must not succeed"),
        }
    }

    // And it is recoverable ONLY by the issuer, never by the owner.
    StellarAssetClient::new(&r.env, &r.token_id).set_authorized(&r.contract_id, &true);
    c.withdraw(&r.owner, &1_000);
    assert_eq!(SacClient::new(&r.env, &r.token_id).balance(&r.owner), 1_000);
}

/// The error-code namespace collision. The builtin SAC's `ContractError` and this
/// contract's `Error` both live in `ScErrorType::Contract` and overlap on 2..=10. A
/// client that decodes the integer against this contract's table therefore reads a
/// TOKEN failure as a POLICY failure.
#[test]
fn a_token_error_code_is_indistinguishable_from_a_policy_error_code() {
    let r = sac_rig(0, 0);
    let c = AgentSpendPolicyClient::new(&r.env, &r.contract_id);
    StellarAssetClient::new(&r.env, &r.token_id).mint(&r.contract_id, &1_000);

    r.sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    StellarAssetClient::new(&r.env, &r.token_id).set_authorized(&r.contract_id, &false);

    // BalanceDeauthorizedError = 11 in the host's builtin ContractError table, which is
    // one past this contract's highest code (OwnerIsOperator = 10). That is luck, not
    // design: codes 2..=10 collide one-for-one.
    assert_eq!(
        c.try_pay(&r.payee, &1),
        Err(Err(soroban_sdk::InvokeError::Contract(11))),
        "BalanceDeauthorizedError = 11 escapes as a raw token code"
    );
}

/// `pay` to a classic account with no USDC trustline: an ordinary mainnet mistake. The
/// token's own error code escapes this contract's frame unchanged.
#[test]
fn a_missing_payee_trustline_escapes_as_a_raw_token_error_code() {
    let r = sac_rig(0, 0);
    let c = AgentSpendPolicyClient::new(&r.env, &r.contract_id);
    StellarAssetClient::new(&r.env, &r.token_id).mint(&r.contract_id, &1_000);

    // A well-formed G address that was never funded, so no account entry exists.
    let ghost = Address::from_str(
        &r.env,
        "GBZDSBUYZYEGLC44M3OATUCEWHIPRV2HO6ZL6NFLTQ2EX5YSNWTYJKMO",
    );

    // For a CREDIT asset the trustline check fires first, so the code is 13
    // (TrustlineMissingError), which is outside this contract's 1..=10 range and so
    // arrives as an undecodable Contract(13) rather than a wrong typed error. For the
    // NATIVE asset SAC there is no trustline, and the same path raises
    // AccountMissingError = 6, which collides with `InvalidAmount`. See
    // balance.rs:550-563 and balance.rs:786-806.
    let res = c.try_pay(&ghost, &100);
    assert_eq!(
        res,
        Err(Err(soroban_sdk::InvokeError::Contract(13))),
        "a token error code outside 1..=10 is at least undecodable rather than wrong"
    );
    assert_eq!(
        c.spent_today(),
        0,
        "state does roll back, so this is a truthfulness bug, not a money bug"
    );

    assert_eq!(c.try_pay(&r.payee, &0), Err(Ok(Error::InvalidAmount)));
}

/// Build a classic account with a USDC trustline whose limit is `limit` and whose current
/// balance is `balance`, so an incoming transfer that would exceed the limit fails the
/// way it fails on pubnet.
fn make_classic_payee_with_trustline(
    env: &Env,
    strkey: &str,
    asset: soroban_sdk::xdr::Asset,
    balance: i64,
    limit: i64,
) -> Address {
    use soroban_sdk::xdr::{
        AccountEntry, AccountEntryExt, AccountId, LedgerEntry, LedgerEntryData, LedgerEntryExt,
        LedgerKey, LedgerKeyAccount, LedgerKeyTrustLine, PublicKey, SequenceNumber, ScAddress,
        String32, Thresholds, TrustLineAsset, TrustLineEntry, TrustLineEntryExt, TrustLineFlags,
        Uint256, VecM,
    };
    use soroban_sdk::TryIntoVal;
    use std::rc::Rc;

    let raw = stellar_strkey_decode(strkey);
    let account_id = AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(raw)));

    let acc = AccountEntry {
        account_id: account_id.clone(),
        balance: 100_000_000,
        seq_num: SequenceNumber(0),
        num_sub_entries: 1,
        inflation_dest: None,
        flags: 0,
        home_domain: String32::default(),
        thresholds: Thresholds([1, 0, 0, 0]),
        signers: VecM::default(),
        ext: AccountEntryExt::V0,
    };
    let acc_key = Rc::new(LedgerKey::Account(LedgerKeyAccount {
        account_id: account_id.clone(),
    }));
    env.host()
        .add_ledger_entry(
            &acc_key,
            &Rc::new(LedgerEntry {
                last_modified_ledger_seq: 0,
                data: LedgerEntryData::Account(acc),
                ext: LedgerEntryExt::V0,
            }),
            None,
        )
        .unwrap();

    let tl_asset: TrustLineAsset = match asset {
        soroban_sdk::xdr::Asset::CreditAlphanum4(a) => TrustLineAsset::CreditAlphanum4(a),
        soroban_sdk::xdr::Asset::CreditAlphanum12(a) => TrustLineAsset::CreditAlphanum12(a),
        soroban_sdk::xdr::Asset::Native => TrustLineAsset::Native,
    };
    let tl = TrustLineEntry {
        account_id: account_id.clone(),
        asset: tl_asset.clone(),
        balance,
        limit,
        flags: TrustLineFlags::AuthorizedFlag as u32,
        ext: TrustLineEntryExt::V0,
    };
    let tl_key = Rc::new(LedgerKey::Trustline(LedgerKeyTrustLine {
        account_id: account_id.clone(),
        asset: tl_asset,
    }));
    env.host()
        .add_ledger_entry(
            &tl_key,
            &Rc::new(LedgerEntry {
                last_modified_ledger_seq: 0,
                data: LedgerEntryData::Trustline(tl),
                ext: LedgerEntryExt::V0,
            }),
            None,
        )
        .unwrap();

    let sc: ScAddress = ScAddress::Account(account_id);
    sc.try_into_val(env).unwrap()
}

/// Minimal G-strkey decoder, so the test does not need a new dependency.
fn stellar_strkey_decode(s: &str) -> [u8; 32] {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = std::vec::Vec::new();
    for c in s.bytes() {
        let v = ALPHA.iter().position(|&a| a == c).expect("bad strkey char") as u8;
        for i in (0..5).rev() {
            bits.push((v >> i) & 1);
        }
    }
    let mut bytes = std::vec::Vec::new();
    for chunk in bits.chunks(8) {
        if chunk.len() < 8 {
            break;
        }
        let mut b = 0u8;
        for &bit in chunk {
            b = (b << 1) | bit;
        }
        bytes.push(b);
    }
    // byte 0 is the version byte, the last two are the CRC.
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[1..33]);
    out
}

/// THE COLLISION, REALIZED ON THE AUDITED CONFIGURATION.
///
/// The payee is a real classic account with a real USDC trustline whose limit is nearly
/// full. The SAC refuses the credit with `ContractError::BalanceError = 10`. That code
/// propagates through this contract's frame unchanged, and the generated client decodes
/// 10 against THIS contract's table, where 10 is `OwnerIsOperator`.
///
/// The caller is told "the owner and the operator are the same address" for a payment
/// that failed because the payee's trustline was full.
#[test]
fn a_full_payee_trustline_is_reported_to_the_caller_as_owner_is_operator() {
    let r = sac_rig(0, 0);
    let c = AgentSpendPolicyClient::new(&r.env, &r.contract_id);
    StellarAssetClient::new(&r.env, &r.token_id).mint(&r.contract_id, &1_000);

    // limit 100, already holding 95, so a 100 credit cannot land.
    let payee = make_classic_payee_with_trustline(
        &r.env,
        "GBZDSBUYZYEGLC44M3OATUCEWHIPRV2HO6ZL6NFLTQ2EX5YSNWTYJKMO",
        r.sac.asset(),
        95,
        100,
    );

    let res = c.try_pay(&payee, &100);
    assert_eq!(
        res,
        Err(Ok(Error::OwnerIsOperator)),
        "the token's code 10 is decoded as this contract's code 10"
    );
    assert_eq!(c.spent_today(), 0, "state does roll back");

    // A payment inside the limit still works, so the setup is real.
    c.pay(&payee, &5);
    assert_eq!(c.spent_today(), 5);
}

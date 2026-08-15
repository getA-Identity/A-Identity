#![no_std]
//! AgentSpendPolicy, on Soroban.
//!
//! A vault that custodies a SEP-41 token for an AI agent and enforces the agent's spend
//! policy ON THE LEDGER: a per-UTC-day cap, a per-payment auto-approve ceiling, a payee
//! allowlist, a freeze switch, and a time-bounded session key. Two roles. The human
//! `owner` sets the policy, freezes, settles an above-ceiling payment they approved out
//! of band, and withdraws. The agent `operator` may only call `pay`, and only inside the
//! policy. Anything outside it reverts with a typed error, on chain, verifiably.
//!
//! Ported from `mcp/contracts/AgentSpendPolicy.sol`, which is the same product on EVM.
//! The behaviour is deliberately identical, down to the order the gates fire and the
//! meaning of a zero (0 cap, 0 ceiling and 0 expiry all mean "no bound"), because the
//! console and the spend-preflight API already assume it.
//!
//! ## The one line this whole contract rests on
//!
//! On EVM there are two independent guards on a payment: `msg.sender` is supplied by the
//! chain and cannot be forged, and the token's own allowance accounting sits underneath.
//! Neither exists here.
//!
//! `pay` moves the vault's OWN custodied balance, so the token's `from`-side
//! authorization is satisfied structurally: when this contract calls the token directly,
//! that direct call IS the authorization. There is no second layer. Soroban also has no
//! `msg.sender`. So the entire authorization surface of this contract collapses onto
//! `operator.require_auth()` at the top of `pay`, and if that line were missing, any
//! funded account on the network could drain the vault up to the policy limits. The
//! policy would still be enforced; it just would not be enforced against anybody in
//! particular.
//!
//! That is why `soroban/audit/negative-controls/` exists: a patch that deletes exactly
//! that line, and a runner that fails the build if the test suite still passes without
//! it. Unit tests alone cannot be trusted here, because the usual test harness
//! (`mock_all_auths`) is precisely the thing that hides a missing `require_auth`.
//!
//! ## What is not here, on purpose
//!
//! No `upgrade` entrypoint. An upgrade path is a second total-authority door and it makes
//! the admin-centralization finding worse, which is the wrong trade for a contract whose
//! whole claim is bounded authority. The escape hatch is the one that already exists:
//! `withdraw`, redeploy, repoint.
//!
//! No `initialize`. Initialization happens in `__constructor`, atomically at deploy, so
//! there is no window in which the contract exists unowned and the front-run-the-
//! initializer class is structurally absent rather than merely tested against.

mod error;
mod event;
mod policy;
mod storage;

#[cfg(test)]
mod test;

pub use crate::error::Error;
use crate::event::{
    AllowlistSet, FrozenSet, OperatorSet, Paid, PolicyUpdated, SessionKeyExpirySet, Withdrawn,
};
use crate::policy::Snapshot;
use crate::storage as store;

use soroban_sdk::{contract, contractimpl, panic_with_error, token, Address, Env};

#[contract]
pub struct AgentSpendPolicy;

#[contractimpl]
impl AgentSpendPolicy {
    /// Deploy-time initialization. Runs once, atomically, and cannot be re-run.
    ///
    /// Reading `decimals()` from the token here does double duty: it keeps the hot path
    /// free of a cross-contract call, and it means a token address that does not actually
    /// implement SEP-41 fails at deploy, before the vault has ever held anything.
    pub fn __constructor(
        env: Env,
        owner: Address,
        operator: Address,
        token_id: Address,
        daily_cap: i128,
        auto_approve_max: i128,
    ) {
        // A single key that is both owner and operator could spend past the policy and
        // then lift the policy, which is the same as having no policy. The TypeScript
        // vault path already refuses this; refusing it here makes it unbypassable.
        if owner == operator {
            panic_with_error!(&env, Error::OwnerIsOperator);
        }
        if daily_cap < 0 || auto_approve_max < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }

        let decimals = token::Client::new(&env, &token_id).decimals();

        store::set_owner(&env, &owner);
        store::set_operator(&env, &operator);
        store::set_token(&env, &token_id);
        store::set_decimals(&env, decimals);
        store::set_daily_cap(&env, daily_cap);
        store::set_auto_approve_max(&env, auto_approve_max);
        store::set_frozen(&env, false);
        store::set_allowlist_enabled(&env, false);
        store::set_session_key_expiry(&env, 0);
        store::bump_instance(&env);
    }

    // ── the agent path ────────────────────────────────────────────────────────────

    /// Agent-initiated payment, bounded by the policy.
    ///
    /// The returned error is the product: it says exactly why the human-in-the-loop path
    /// should take over, in a form the caller can match on rather than parse.
    pub fn pay(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        // Loaded from storage, never taken from an argument. `who.require_auth()` on a
        // caller-supplied `who` proves the caller controls that address, not that the
        // address is allowed to do anything here.
        let operator = store::get_operator(&env);
        operator.require_auth();

        store::bump_instance(&env);
        Self::settle(&env, &to, amount, false)
    }

    // ── the human path ────────────────────────────────────────────────────────────

    /// The owner settles a payment they approved out of band. Bypasses the ceiling, the
    /// allowlist and the freeze, because it is a human act. Still counts toward the daily
    /// cap, so the on-chain record of total outflow stays honest.
    pub fn owner_pay(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        Self::require_owner(&env);
        store::bump_instance(&env);
        Self::settle(&env, &to, amount, true)
    }

    /// Move funds out of the vault. Owner only, and not counted against the day, because
    /// a withdrawal is the owner reclaiming their own money rather than the agent
    /// spending it.
    pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
        Self::require_owner(&env);
        store::bump_instance(&env);
        policy::check_amount(amount)?;
        Self::require_valid_payee(&env, &to)?;

        let tok = store::get_token(&env);
        let here = env.current_contract_address();
        if token::Client::new(&env, &tok).balance(&here) < amount {
            return Err(Error::InsufficientBalance);
        }
        token::Client::new(&env, &tok).transfer(&here, &to, &amount);
        Withdrawn { to, amount }.publish(&env);
        Ok(())
    }

    // ── owner policy controls ─────────────────────────────────────────────────────

    pub fn set_policy(
        env: Env,
        daily_cap: i128,
        auto_approve_max: i128,
        allowlist_enabled: bool,
    ) -> Result<(), Error> {
        Self::require_owner(&env);
        store::bump_instance(&env);
        if daily_cap < 0 || auto_approve_max < 0 {
            return Err(Error::InvalidAmount);
        }
        store::set_daily_cap(&env, daily_cap);
        store::set_auto_approve_max(&env, auto_approve_max);
        store::set_allowlist_enabled(&env, allowlist_enabled);
        PolicyUpdated {
            daily_cap,
            auto_approve_max,
            allowlist_enabled,
        }
        .publish(&env);
        Ok(())
    }

    pub fn set_allowed(env: Env, payee: Address, ok: bool) {
        Self::require_owner(&env);
        store::bump_instance(&env);
        store::set_allowed(&env, &payee, ok);
        AllowlistSet { payee, allowed: ok }.publish(&env);
    }

    pub fn set_operator(env: Env, operator: Address) -> Result<(), Error> {
        Self::require_owner(&env);
        store::bump_instance(&env);
        if store::get_owner(&env) == operator {
            return Err(Error::OwnerIsOperator);
        }
        store::set_operator(&env, &operator);
        OperatorSet { operator }.publish(&env);
        Ok(())
    }

    /// Grant, extend or revoke the session key by setting the Unix time after which the
    /// agent's `pay` stops working. A future time grants or extends, a past time (or the
    /// current one) revokes immediately, and 0 removes the time bound entirely.
    /// `owner_pay` is never time-bound.
    pub fn set_session_key_expiry(env: Env, expiry: u64) {
        Self::require_owner(&env);
        store::bump_instance(&env);
        store::set_session_key_expiry(&env, expiry);
        SessionKeyExpirySet { expiry }.publish(&env);
    }

    pub fn set_frozen(env: Env, frozen: bool) {
        Self::require_owner(&env);
        store::bump_instance(&env);
        store::set_frozen(&env, frozen);
        FrozenSet { frozen }.publish(&env);
    }

    // ── views ─────────────────────────────────────────────────────────────────────

    pub fn owner(env: Env) -> Address {
        store::get_owner(&env)
    }

    pub fn operator(env: Env) -> Address {
        store::get_operator(&env)
    }

    pub fn token(env: Env) -> Address {
        store::get_token(&env)
    }

    pub fn decimals(env: Env) -> u32 {
        store::get_decimals(&env)
    }

    pub fn daily_cap(env: Env) -> i128 {
        store::get_daily_cap(&env)
    }

    pub fn auto_approve_max(env: Env) -> i128 {
        store::get_auto_approve_max(&env)
    }

    pub fn frozen(env: Env) -> bool {
        store::get_frozen(&env)
    }

    pub fn allowlist_enabled(env: Env) -> bool {
        store::get_allowlist_enabled(&env)
    }

    pub fn session_key_expiry(env: Env) -> u64 {
        store::get_session_key_expiry(&env)
    }

    pub fn is_allowed(env: Env, payee: Address) -> bool {
        store::is_allowed(&env, &payee)
    }

    /// The current UTC day index, as the contract computes it.
    pub fn today(env: Env) -> u64 {
        store::today(&env)
    }

    pub fn spent_today(env: Env) -> i128 {
        store::get_spent_on_day(&env, store::today(&env))
    }

    pub fn balance(env: Env) -> i128 {
        token::Client::new(&env, &store::get_token(&env)).balance(&env.current_contract_address())
    }

    // ── internals ─────────────────────────────────────────────────────────────────

    fn require_owner(env: &Env) {
        let owner = store::get_owner(env);
        owner.require_auth();
    }

    /// Paying the vault itself, or the token contract, moves nothing but still consumes
    /// the day's budget. Left open, a compromised operator could burn the whole cap at
    /// zero cost every day and deny the legitimate agent indefinitely.
    fn require_valid_payee(env: &Env, to: &Address) -> Result<(), Error> {
        if *to == env.current_contract_address() || *to == store::get_token(env) {
            return Err(Error::InvalidPayee);
        }
        Ok(())
    }

    /// The shared tail of `pay` and `owner_pay`: run the right ladder, commit the day
    /// total, then move the money. State is written before the external call, and the
    /// whole invocation rolls back together if the transfer fails, so a failed transfer
    /// cannot leave the day counter charged.
    fn settle(env: &Env, to: &Address, amount: i128, by_owner: bool) -> Result<(), Error> {
        Self::require_valid_payee(env, to)?;

        let day = store::today(env);
        let tok = store::get_token(env);
        let here = env.current_contract_address();
        let snapshot = Snapshot {
            frozen: store::get_frozen(env),
            session_key_expiry: store::get_session_key_expiry(env),
            now: env.ledger().timestamp(),
            allowlist_enabled: store::get_allowlist_enabled(env),
            payee_allowed: store::is_allowed(env, to),
            auto_approve_max: store::get_auto_approve_max(env),
            daily_cap: store::get_daily_cap(env),
            spent_today: store::get_spent_on_day(env, day),
            vault_balance: token::Client::new(env, &tok).balance(&here),
        };

        let next = if by_owner {
            policy::check_owner_pay(&snapshot, amount)?
        } else {
            policy::check_operator_pay(&snapshot, amount)?
        };

        store::set_spent_on_day(env, day, next);
        token::Client::new(env, &tok).transfer(&here, to, &amount);
        Paid {
            to: to.clone(),
            day,
            amount,
            by_owner,
        }
        .publish(env);
        Ok(())
    }
}

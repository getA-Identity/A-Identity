#![cfg(test)]
//! The shared harness.
//!
//! One rule governs this whole directory: **`mock_all_auths` is opt-in, never the
//! default.** It is exactly the harness that hides a missing `require_auth`, so a suite
//! that reaches for it everywhere would pass just as happily against a contract anyone
//! could drain. `setup()` therefore returns an environment with authorization ENFORCED,
//! and a test that wants payments to succeed asks for the mock explicitly by calling
//! `s.mock_auths()`.

mod amounts;
mod arithmetic;
mod auth;
mod behaviour;
mod durability;
mod errors;
mod storage_shape;
mod time;
mod views;

use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, InvokeError};

use crate::{AgentSpendPolicy, AgentSpendPolicyClient, Error};

/// Assert that a `try_*` call came back as the named TYPED error.
///
/// The nesting matters and is easy to get wrong in a way that makes a test vacuous.
/// `Err(Ok(e))` is the contract returning its own error, which is what every policy gate
/// must produce. `Err(Err(_))` is a host-level trap, which is what a failed
/// `require_auth` or an unexpected panic produces. A test that only checked `is_err()`
/// would pass for either, so a gate that had degenerated into an untyped panic would look
/// exactly like a gate that worked.
#[track_caller]
pub fn assert_error<T>(result: Result<T, Result<Error, InvokeError>>, expected: Error) {
    match result {
        Err(Ok(actual)) => assert_eq!(actual, expected, "wrong typed error"),
        Err(Err(host)) => {
            panic!("expected the typed error {expected:?}, got a host trap: {host:?}")
        }
        Ok(_) => panic!("expected the typed error {expected:?}, but the call succeeded"),
    }
}

/// A round number of token base units, so the tests read as amounts rather than digits.
/// Stellar's USDC SAC is 7 decimals; the harness mints a 7-decimal token to match.
pub const UNIT: i128 = 10_000_000;

pub struct Setup {
    pub env: Env,
    pub owner: Address,
    pub operator: Address,
    pub payee: Address,
    pub stranger: Address,
    pub token_id: Address,
    pub contract_id: Address,
}

impl Setup {
    pub fn client(&self) -> AgentSpendPolicyClient<'_> {
        AgentSpendPolicyClient::new(&self.env, &self.contract_id)
    }

    /// Explicit, never implicit. Calling this is a test saying "authorization is not what
    /// I am testing here"; a test that omits it is exercising the real auth path.
    pub fn mock_auths(&self) -> &Self {
        self.env.mock_all_auths();
        self
    }

    /// Put the environment back into the enforcing state.
    ///
    /// `mock_all_auths` is sticky once called, and `fund_vault()` has to call it because
    /// minting is the token admin's act rather than the subject of any test here. Every
    /// authorization test therefore calls this immediately before the call under test, so
    /// that what it exercises is the real path a stranger would take.
    pub fn enforce_auth(&self) -> &Self {
        self.env.set_auths(&[]);
        self
    }

    pub fn token(&self) -> token::Client<'_> {
        token::Client::new(&self.env, &self.token_id)
    }

    pub fn fund_vault(&self, amount: i128) {
        // Minting is the token admin's act, not the vault's, and it is setup rather than
        // subject, so mocking here says nothing about the contract under test.
        self.env.mock_all_auths();
        token::StellarAssetClient::new(&self.env, &self.token_id).mint(&self.contract_id, &amount);
    }

    /// Advance the ledger clock. Used by the day-bucketing and session-key tests.
    pub fn set_time(&self, unix_seconds: u64) {
        self.env.ledger().set_timestamp(unix_seconds);
    }

    /// Advance the ledger SEQUENCE without touching the clock.
    ///
    /// These are two different axes and conflating them is how a TTL test comes to test
    /// nothing. TTL is counted in ledgers; the UTC day index is derived from the
    /// timestamp. Moving the clock forward changes which day bucket is READ, so the test
    /// looks at a key that was never written and finds zero for the wrong reason. Moving
    /// the sequence forward inside the same day is what actually expires an entry.
    pub fn advance_ledgers(&self, count: u32) {
        self.env.ledger().with_mut(|l| l.sequence_number += count);
    }
}

pub fn setup(daily_cap: i128, auto_approve_max: i128) -> Setup {
    let env = Env::default();

    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);
    let stranger = Address::generate(&env);

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

    Setup {
        env,
        owner,
        operator,
        payee,
        stranger,
        token_id,
        contract_id,
    }
}

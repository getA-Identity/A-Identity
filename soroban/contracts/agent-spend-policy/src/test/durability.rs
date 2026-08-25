//! A2 audit probes: storage durability and TTL, measured against the LIVE network
//! settings of both deployments rather than the SDK test defaults.
//!
//! The SDK's `Env::default()` ships `min_temp_entry_ttl = 16` and
//! `min_persistent_entry_ttl = 4096`. Pubnet runs 17,280 and 2,073,600. Every existing
//! TTL test in this crate therefore exercises a network that does not exist. These tests
//! set the real numbers first, then register the contract, so the entries are created
//! with the TTLs the deployed contract actually gets.

use super::{assert_error, Setup, UNIT};
use crate::storage::{
    DataKey, DAY_BUCKET_TTL_EXTEND, DAY_BUCKET_TTL_THRESHOLD, LEDGERS_PER_DAY, LONG_TTL_EXTEND,
    LONG_TTL_THRESHOLD,
};
use crate::{AgentSpendPolicy, Error};
use soroban_sdk::testutils::storage::{Instance as _, Persistent as _, Temporary as _};
use soroban_sdk::testutils::{Address as _, Deployer as _, Ledger as _};
use soroban_sdk::{Address, Env};

#[derive(Clone, Copy)]
pub struct Net {
    pub name: &'static str,
    pub min_temp: u32,
    pub min_persistent: u32,
    pub max_entry: u32,
}

/// Measured on 2026-08-24 from `ConfigSettingID 10` on each network.
pub const PUBNET: Net = Net {
    name: "pubnet",
    min_temp: 17_280,
    min_persistent: 2_073_600,
    max_entry: 3_110_400,
};
pub const TESTNET: Net = Net {
    name: "testnet",
    min_temp: 720,
    min_persistent: 120_960,
    max_entry: 3_110_400,
};

/// `super::setup` builds the env and registers in one step, so the contract instance is
/// created under the SDK defaults. This variant applies the network settings FIRST.
fn setup_on(net: Net, daily_cap: i128, auto_approve_max: i128) -> Setup {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.min_temp_entry_ttl = net.min_temp;
        l.min_persistent_entry_ttl = net.min_persistent;
        l.max_entry_ttl = net.max_entry;
        l.sequence_number = 1_000_000;
        l.timestamp = 0;
    });

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

fn temp_ttl(s: &Setup, key: &DataKey) -> u32 {
    s.env
        .as_contract(&s.contract_id, || s.env.storage().temporary().get_ttl(key))
}

fn persistent_ttl(s: &Setup, key: &DataKey) -> u32 {
    s.env
        .as_contract(&s.contract_id, || s.env.storage().persistent().get_ttl(key))
}

// ── Q1 / INV-18: does the day bucket reliably outlive its own UTC day? ─────────────

/// The ordering question, answered with the number.
///
/// The first write of a day CREATES the temporary entry (host gives it exactly
/// `min_temporary_ttl`) and then extends it in the same call. On pubnet the created TTL
/// and the extension threshold are the SAME constant, 17,280, so whether the extension
/// fires at all comes down to whether the host compares `<` or `<=`, and to the host's
/// off-by-one in `min_live_until_ledger_checked` (`seq + min_ttl - 1`).
///
/// It fires: created TTL is 17,279, the host's test is `current_ttl <= threshold`.
#[test]
fn the_first_write_of_a_day_reaches_the_two_day_floor_on_both_networks() {
    for net in [PUBNET, TESTNET] {
        let s = setup_on(net, 10 * UNIT, 100 * UNIT);
        s.fund_vault(100 * UNIT);
        s.mock_auths();
        s.client().pay(&s.payee, &UNIT);

        let day = s.client().today();
        let ttl = temp_ttl(&s, &DataKey::SpentOnDay(day));
        // The absolute number, not the symbol: an assertion written as
        // `ttl == DAY_BUCKET_TTL_EXTEND` passes for ANY value of the constant, including
        // values that put the margin back to zero.
        assert_eq!(DAY_BUCKET_TTL_EXTEND, 34_560);
        assert_eq!(
            ttl, 34_560,
            "{}: the first write of the day left the bucket at {} ledgers, not the \
             {} ledger floor the code intends",
            net.name, ttl, DAY_BUCKET_TTL_EXTEND
        );
        assert!(
            ttl > net.min_temp,
            "{}: the bucket is on the protocol minimum, which is the INV-18 risk R3 flagged",
            net.name
        );
    }
}

/// The behavioural half: a bucket written at the first second of a UTC day is still
/// there a full day of ledgers later, and is gone once the floor itself runs out.
#[test]
fn the_day_bucket_outlives_its_own_day_and_then_expires() {
    let s = setup_on(PUBNET, 10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.set_time(86_400); // 00:00:00 of day 1, the worst case for the bucket
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.client().spent_today(), 10 * UNIT);

    // A whole UTC day of ledgers at the 5.000 s break-even close time: 17,280.
    s.advance_ledgers(17_280);
    s.set_time(86_400 + 86_399); // 23:59:59 of the SAME day
    assert_eq!(
        s.client().spent_today(),
        10 * UNIT,
        "the cap silently reset while its own UTC day was still running",
    );

    // And the absolute floor: still live at exactly 34,560 ledgers after the write, gone
    // one ledger later. Written as numbers so that shrinking the constant fails here.
    s.advance_ledgers(34_560 - 17_280);
    assert_eq!(s.client().spent_today(), 10 * UNIT);
    s.advance_ledgers(1);
    assert_eq!(s.client().spent_today(), 0);
}

/// The margin, pinned as arithmetic so a future edit to the constants has to face it.
///
/// The bucket must cover at most the remainder of one UTC day, 86,400 s. It is given
/// `DAY_BUCKET_TTL_EXTEND` ledgers. So INV-18 holds while the mean close time stays
/// above `86400 / 34560 = 2.5 s`. Pubnet measured 5.644 s, testnet 5.010 s.
#[test]
fn the_day_bucket_floor_tolerates_a_close_time_down_to_2_5_seconds() {
    let seconds_covered_at_5s = DAY_BUCKET_TTL_EXTEND as u64 * 5;
    assert!(
        seconds_covered_at_5s >= 2 * 86_400,
        "the floor covers only {seconds_covered_at_5s} s at the network's own 5 s target, \
         so a bucket written early in a UTC day may not reach the end of it",
    );
    let break_even_ms = 86_400_000u64 / DAY_BUCKET_TTL_EXTEND as u64;
    assert_eq!(break_even_ms, 2_500);
    // The protocol minimum alone would break even at exactly 5.000 s, which is the
    // network's own target. The floor is what buys the margin.
    assert_eq!(86_400_000u64 / PUBNET.min_temp as u64, 5_000);
}

/// A later payment the same day re-arms the floor from the moment it happens, so the
/// bucket's life is measured from the LAST write, not the first.
#[test]
fn a_later_payment_the_same_day_re_arms_the_floor() {
    let s = setup_on(PUBNET, 10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &UNIT);
    let day = s.client().today();
    assert_eq!(
        temp_ttl(&s, &DataKey::SpentOnDay(day)),
        DAY_BUCKET_TTL_EXTEND
    );

    s.advance_ledgers(LEDGERS_PER_DAY);
    assert_eq!(
        temp_ttl(&s, &DataKey::SpentOnDay(day)),
        DAY_BUCKET_TTL_EXTEND - LEDGERS_PER_DAY
    );
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(
        temp_ttl(&s, &DataKey::SpentOnDay(day)),
        DAY_BUCKET_TTL_EXTEND
    );
}

/// The threshold constant is what makes the re-arm unconditional. If the bucket's TTL is
/// above the threshold the extension is skipped, and the entry keeps decaying from its
/// original write. Here that never bites, because the created TTL (17,279 on pubnet) is
/// already at or under the threshold and every later write happens with less than that.
#[test]
fn the_bucket_threshold_is_never_above_the_created_ttl_on_either_network() {
    for net in [PUBNET, TESTNET] {
        assert!(
            net.min_temp.saturating_sub(1) <= DAY_BUCKET_TTL_THRESHOLD,
            "{}: a freshly created bucket would start ABOVE the extension threshold, so \
             the two-day floor would never be applied on the first write",
            net.name
        );
    }
}

// ── Q2: the UTC midnight boundary ─────────────────────────────────────────────────

/// Intended, and bounded. The cap is per UTC day, so a payment at 23:59:59 and a payment
/// at 00:00:00 land in different buckets and each gets a full cap. That is 2x the daily
/// cap inside two seconds. It is not more than 2x: the third payment is refused.
#[test]
fn two_payments_straddling_utc_midnight_each_get_a_full_cap_and_no_more() {
    let s = setup_on(PUBNET, 10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();

    s.set_time(86_400 + 86_399); // day 1, 23:59:59
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.client().spent_today(), 10 * UNIT);

    s.advance_ledgers(1);
    s.set_time(2 * 86_400); // day 2, 00:00:00, one second later
    assert_eq!(s.client().spent_today(), 0, "a fresh day, a fresh bucket");
    s.client().pay(&s.payee, &(10 * UNIT));

    // 20 UNIT moved in two seconds against a 10 UNIT/day cap, and that is the ceiling:
    // the next one is refused, so the exposure is exactly 2x, not unbounded.
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
    assert_eq!(s.token().balance(&s.payee), 20 * UNIT);

    // The previous day's bucket is still live and still holds its own total. Nothing
    // reads it again, and it cannot be confused with today's: different key.
    assert_eq!(
        temp_ttl(&s, &DataKey::SpentOnDay(1)),
        DAY_BUCKET_TTL_EXTEND - 1
    );
    assert_eq!(
        s.env.as_contract(&s.contract_id, || {
            s.env
                .storage()
                .temporary()
                .get::<_, i128>(&DataKey::SpentOnDay(1))
                .unwrap()
        }),
        10 * UNIT
    );
}

// ── storage key collisions ────────────────────────────────────────────────────────

/// Every `DataKey` variant must be a distinct ledger key. Written into one durability so
/// a collision would show up as a clobbered value rather than as a passing test.
#[test]
fn every_datakey_variant_is_a_distinct_storage_key() {
    let s = setup_on(PUBNET, 0, 0);
    let a = Address::generate(&s.env);
    let b = Address::generate(&s.env);
    let keys = [
        DataKey::Owner,
        DataKey::Operator,
        DataKey::Token,
        DataKey::Decimals,
        DataKey::DailyCap,
        DataKey::AutoApproveMax,
        DataKey::Frozen,
        DataKey::AllowlistEnabled,
        DataKey::SessionKeyExpiry,
        DataKey::Allowed(a.clone()),
        DataKey::Allowed(b.clone()),
        DataKey::SpentOnDay(0),
        DataKey::SpentOnDay(1),
        DataKey::SpentOnDay(u64::MAX),
    ];
    s.env.as_contract(&s.contract_id, || {
        for (i, k) in keys.iter().enumerate() {
            s.env.storage().temporary().set(k, &(i as u32));
        }
        for (i, k) in keys.iter().enumerate() {
            let got: u32 = s.env.storage().temporary().get(k).unwrap();
            assert_eq!(got, i as u32, "DataKey variant {i} collided with another");
        }
    });
}

/// The three durabilities are separate namespaces: the same key in instance, persistent
/// and temporary is three different entries. Worth pinning, because the accessors in
/// storage.rs pick the durability per key and nothing else stops a future edit from
/// reading `Owner` out of the wrong one.
#[test]
fn the_same_key_in_three_durabilities_is_three_entries() {
    let s = setup_on(PUBNET, 0, 0);
    s.env.as_contract(&s.contract_id, || {
        s.env.storage().persistent().set(&DataKey::Decimals, &1u32);
        s.env.storage().temporary().set(&DataKey::Decimals, &2u32);
        assert_eq!(
            s.env
                .storage()
                .instance()
                .get::<_, u32>(&DataKey::Decimals)
                .unwrap(),
            7,
            "the instance copy was clobbered by a write to another durability"
        );
        assert_eq!(
            s.env
                .storage()
                .persistent()
                .get::<_, u32>(&DataKey::Decimals)
                .unwrap(),
            1
        );
        assert_eq!(
            s.env
                .storage()
                .temporary()
                .get::<_, u32>(&DataKey::Decimals)
                .unwrap(),
            2
        );
    });
}

// ── INV-19: instance storage cannot grow ──────────────────────────────────────────

/// The instance map is a fixed nine keys, whatever untrusted input does. `instance().all()`
/// filters by the current contract address (unlike `persistent().all()` / `temporary().all()`,
/// which are unsound per soroban-sdk issue #1736), so this assertion is real.
#[test]
fn the_instance_map_stays_nine_keys_under_untrusted_input() {
    let s = setup_on(PUBNET, 0, 0);
    s.fund_vault(1000 * UNIT);
    s.mock_auths();

    let before = s
        .env
        .as_contract(&s.contract_id, || s.env.storage().instance().all().len());
    assert_eq!(before, 9);

    for i in 0..300u32 {
        s.client().set_allowed(&Address::generate(&s.env), &true);
        if i % 10 == 0 {
            s.set_time(i as u64 * 86_400);
            s.advance_ledgers(10);
            s.client().pay(&s.payee, &UNIT);
        }
    }

    let after = s
        .env
        .as_contract(&s.contract_id, || s.env.storage().instance().all().len());
    assert_eq!(
        after, 9,
        "the instance entry grew with untrusted input, which is the exhaustion class \
         that bricks every entrypoint including withdraw",
    );
}

// ── P-3 / Q3: the instance entry, its clock, and what archival actually costs ──────

/// What the deployed contract actually gets, per network, versus what the code intends.
///
/// `bump_instance` asks for `LONG_TTL_EXTEND` (150 days of ledgers) whenever the TTL is
/// at or under `LONG_TTL_THRESHOLD` (60 days). On pubnet the network hands a new
/// persistent/instance entry `min_persistent_ttl` = 2,073,600 up front, which is ABOVE
/// the threshold, so every bump for the first ~60 days is a no-op and the entry's life
/// comes from the network, not from this contract.
#[test]
fn the_instance_entry_gets_its_life_from_the_network_on_pubnet() {
    let s = setup_on(PUBNET, 0, 0);
    let at_deploy = s.env.deployer().get_contract_instance_ttl(&s.contract_id);
    assert_eq!(at_deploy, PUBNET.min_persistent - 1);
    assert!(
        at_deploy < LONG_TTL_EXTEND,
        "the code's 150 day floor is not what pubnet gives"
    );

    s.fund_vault(10 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(
        s.env.deployer().get_contract_instance_ttl(&s.contract_id),
        PUBNET.min_persistent - 1,
        "bump_instance is a no-op while the TTL is above LONG_TTL_THRESHOLD",
    );

    // Once it drops under the threshold the bump does what it says.
    s.advance_ledgers(PUBNET.min_persistent - LONG_TTL_THRESHOLD);
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(
        s.env.deployer().get_contract_instance_ttl(&s.contract_id),
        LONG_TTL_EXTEND
    );
}

#[test]
fn the_instance_entry_gets_the_code_floor_on_testnet() {
    let s = setup_on(TESTNET, 0, 0);
    assert_eq!(
        s.env.deployer().get_contract_instance_ttl(&s.contract_id),
        LONG_TTL_EXTEND,
        "testnet's min_persistent_ttl is under the threshold, so the bump does fire",
    );
}

/// P-3, stated as a test: NO view extends the instance entry, so a vault that is only
/// read from drifts toward archival. A vault that is only *written* to never does.
#[test]
fn no_view_extends_the_instance_ttl_but_every_writer_does() {
    let s = setup_on(PUBNET, 0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    // Burn down past the bump threshold so a bump would be visible.
    s.advance_ledgers(PUBNET.min_persistent - LONG_TTL_THRESHOLD);
    let before = s.env.deployer().get_contract_instance_ttl(&s.contract_id);
    assert!(before <= LONG_TTL_THRESHOLD);

    let c = s.client();
    c.owner();
    c.operator();
    c.token();
    c.decimals();
    c.daily_cap();
    c.auto_approve_max();
    c.frozen();
    c.allowlist_enabled();
    c.session_key_expiry();
    c.is_allowed(&s.payee);
    c.today();
    c.spent_today();
    c.balance();
    assert_eq!(
        s.env.deployer().get_contract_instance_ttl(&s.contract_id),
        before,
        "a view extended the instance TTL; that would change the P-3 analysis",
    );

    c.pay(&s.payee, &UNIT);
    assert_eq!(
        s.env.deployer().get_contract_instance_ttl(&s.contract_id),
        LONG_TTL_EXTEND
    );
}

/// Q3, the load-bearing one: is an archived instance entry a brick or a bill?
///
/// The host used here is the same one RPC simulation uses (recording footprint mode), and
/// its `handle_maybe_expired_entry` restores an expired PERSISTENT-durability entry
/// (which the contract instance is) to `min_persistent_ttl` and carries the value across,
/// exactly as CAP-0066 auto-restoration does at apply time from protocol 23. A TEMPORARY
/// entry in the same position is deleted instead.
///
/// So the `unwrap()`s at storage.rs:99/107/115/123 are never reached by archival: the
/// entry comes back with its value, it does not come back as `None`.
#[test]
fn an_archived_instance_entry_is_restored_not_lost() {
    let s = setup_on(PUBNET, 10 * UNIT, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    // Walk past the end of the instance entry's life with no activity at all.
    s.advance_ledgers(PUBNET.min_persistent + 10);

    // Every field is still exactly what the constructor wrote.
    assert_eq!(s.client().owner(), s.owner);
    assert_eq!(s.client().operator(), s.operator);
    assert_eq!(s.client().token(), s.token_id);
    assert_eq!(s.client().decimals(), 7);
    assert_eq!(s.client().daily_cap(), 10 * UNIT);

    // And the money still moves: INV-20 survives archival of the instance entry.
    s.client().withdraw(&s.payee, &(10 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 10 * UNIT);
}

// ── Q4: can extend_ttl trap? ──────────────────────────────────────────────────────

/// Temporary entries do NOT clamp: asking for more than `max_entry_ttl - 1` traps, and
/// the trap happens in `prepare_extend_ttl`, BEFORE the threshold test, so it fires even
/// when the extension itself would have been skipped.
///
/// At today's `max_entry_ttl` of 3,110,400 the request of 34,560 has a 90x margin. The
/// boundary is exact and is proven here by moving the network setting, not the code:
/// `pay` traps untyped once `max_entry_ttl <= DAY_BUCKET_TTL_EXTEND`.
#[test]
fn pay_traps_untyped_if_the_network_lowers_max_entry_ttl_to_the_day_bucket_floor() {
    let s = setup_on(PUBNET, 0, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();

    // One ledger of headroom: max_ttl = max_entry_ttl - 1 = 34,560 = extend_to. Fine.
    s.env
        .ledger()
        .with_mut(|l| l.max_entry_ttl = DAY_BUCKET_TTL_EXTEND + 1);
    s.client().pay(&s.payee, &UNIT);

    // One ledger less, and the same call is an untyped host trap rather than a typed
    // refusal. Note WHICH entrypoints die: pay and owner_pay, because they alone touch
    // temporary storage.
    s.env
        .ledger()
        .with_mut(|l| l.max_entry_ttl = DAY_BUCKET_TTL_EXTEND);
    match s.client().try_pay(&s.payee, &UNIT) {
        Err(Err(_host_trap)) => {}
        other => panic!("expected a host trap from the temporary extend, got {other:?}"),
    }
    match s.client().try_owner_pay(&s.payee, &UNIT) {
        Err(Err(_host_trap)) => {}
        other => panic!("expected a host trap from the temporary extend, got {other:?}"),
    }

    // withdraw touches no temporary entry, so the escape hatch stays open. This is what
    // keeps the same fault from being a lockup.
    s.client().withdraw(&s.payee, &UNIT);
}

/// The other half of the asymmetry, and the reason the comment on LONG_TTL_EXTEND is
/// attached to the wrong constant: an instance/persistent extension past the maximum
/// CLAMPS. `bump_instance` can never trap, whatever the network does to `max_entry_ttl`.
#[test]
fn the_instance_bump_clamps_instead_of_trapping() {
    let s = setup_on(TESTNET, 0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    assert_eq!(
        s.env.deployer().get_contract_instance_ttl(&s.contract_id),
        LONG_TTL_EXTEND
    );

    // Burn under the bump threshold, then squeeze the network maximum to well under what
    // bump_instance asks for.
    s.advance_ledgers(LONG_TTL_EXTEND - LONG_TTL_THRESHOLD + 1);
    s.env.ledger().with_mut(|l| l.max_entry_ttl = 1_500_000);

    s.client().pay(&s.payee, &UNIT); // does not trap
    assert_eq!(
        s.env.deployer().get_contract_instance_ttl(&s.contract_id),
        1_500_000 - 1,
        "the instance extension clamped to the network maximum",
    );
}

// ── the allowlist: persistent, per payee, and its real clock ──────────────────────

/// Same shape as the instance entry: on pubnet the network's `min_persistent_ttl`
/// (2,073,600) is already above `LONG_TTL_THRESHOLD` (1,036,800), so the extend_ttl call
/// in `set_allowed` does nothing and the entry lives 135 days, not the 150 the constant
/// names. On testnet the minimum is 120,960, under the threshold, so the code floor wins.
#[test]
fn an_allowlist_entry_lives_on_the_network_minimum_on_pubnet_and_the_code_floor_on_testnet() {
    let sp = setup_on(PUBNET, 0, 0);
    sp.mock_auths();
    sp.client().set_allowed(&sp.payee, &true);
    assert_eq!(
        persistent_ttl(&sp, &DataKey::Allowed(sp.payee.clone())),
        PUBNET.min_persistent - 1
    );

    let st = setup_on(TESTNET, 0, 0);
    st.mock_auths();
    st.client().set_allowed(&st.payee, &true);
    assert_eq!(
        persistent_ttl(&st, &DataKey::Allowed(st.payee.clone())),
        LONG_TTL_EXTEND
    );
}

/// `is_allowed` is a public, unauthenticated VIEW that performs a ledger write (a TTL
/// extension) whenever the payee is allowed. Anyone may call it, and the caller pays. It
/// is the only rent subsidy the allowlist has, and it is the reason an allowlist entry
/// does not depend on the owner remembering to touch it.
#[test]
fn the_is_allowed_view_writes_a_ttl_extension_and_the_caller_pays_for_it() {
    let s = setup_on(PUBNET, 0, 0);
    s.mock_auths();
    s.client().set_allowed(&s.payee, &true);
    s.advance_ledgers(PUBNET.min_persistent - LONG_TTL_THRESHOLD);
    let before = persistent_ttl(&s, &DataKey::Allowed(s.payee.clone()));
    assert!(before <= LONG_TTL_THRESHOLD);

    // No auth of any kind, and the entry's life goes up.
    s.enforce_auth();
    assert!(s.client().is_allowed(&s.payee));
    assert_eq!(
        persistent_ttl(&s, &DataKey::Allowed(s.payee.clone())),
        LONG_TTL_EXTEND
    );

    // And for a payee that is NOT allowed, nothing is written and nothing is created.
    assert!(!s.client().is_allowed(&s.stranger));
    s.env.as_contract(&s.contract_id, || {
        assert!(!s
            .env
            .storage()
            .persistent()
            .has(&DataKey::Allowed(s.stranger.clone())));
    });
}

/// An allowlist entry that outlives its TTL is ARCHIVED, not destroyed, and comes back
/// with its value intact. TTL is therefore not a permission clock in either direction:
/// letting an entry lapse does not revoke the payee. Revocation is `set_allowed(p, false)`,
/// which deletes, and only that.
#[test]
fn an_archived_allowlist_entry_comes_back_still_allowed() {
    let s = setup_on(PUBNET, 10 * UNIT, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().set_policy(&(10 * UNIT), &0, &true);
    s.client().set_allowed(&s.payee, &true);

    // Walk clean past the end of the entry's life.
    s.advance_ledgers(PUBNET.min_persistent + 10);
    s.set_time(400 * 86_400);

    assert!(
        s.client().is_allowed(&s.payee),
        "an archived allowlist entry must not silently read as revoked",
    );
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.token().balance(&s.payee), UNIT);
}

/// Deleting a key that was never written is a no-op, not a trap. This is the path a
/// caller takes when it revokes a payee that was never added.
#[test]
fn revoking_a_payee_that_was_never_allowed_is_a_no_op() {
    let s = setup_on(PUBNET, 0, 0);
    s.mock_auths();
    s.client().set_allowed(&s.stranger, &false);
    s.env.as_contract(&s.contract_id, || {
        assert!(!s
            .env
            .storage()
            .persistent()
            .has(&DataKey::Allowed(s.stranger.clone())));
    });
    // And doing it twice is still a no-op.
    s.client().set_allowed(&s.stranger, &false);
}

/// Logical deletion leaves nothing behind: after a revoke the key is gone from every
/// durability, so a later read cannot resurrect a stale `true`.
#[test]
fn a_revoked_payee_leaves_no_residue_in_any_durability() {
    let s = setup_on(PUBNET, 0, 0);
    s.mock_auths();
    s.client().set_allowed(&s.payee, &true);
    s.client().set_allowed(&s.payee, &false);
    s.env.as_contract(&s.contract_id, || {
        let k = DataKey::Allowed(s.payee.clone());
        assert!(!s.env.storage().persistent().has(&k));
        assert!(!s.env.storage().temporary().has(&k));
        assert!(!s.env.storage().instance().has(&k));
    });
}

// ── INV-20: what the vault's money actually depends on ────────────────────────────

/// The shortest clock in the system is not one this contract owns.
///
/// The vault's USDC lives in a persistent entry inside the TOKEN contract, keyed by the
/// vault's address. The SAC extends it only when its TTL drops under 501,120 ledgers, and
/// only to 518,400 (about 30 days at 5 s). On pubnet it is created with the network
/// minimum of 2,073,600, so the SAC's own bump is a no-op for the first ~91 days and the
/// entry's first archival deadline is 135 days after funding, which is EARLIER than the
/// 150-day floor the vault gives its own instance entry.
#[test]
fn the_vault_balance_entry_has_its_own_shorter_clock_inside_the_token() {
    let s = setup_on(PUBNET, 10 * UNIT, 0);
    s.fund_vault(100 * UNIT);

    let ttl = s.env.as_contract(&s.token_id, || {
        s.env
            .storage()
            .persistent()
            .get_ttl(&SacKey::Balance(s.contract_id.clone()))
    });
    assert_eq!(ttl, PUBNET.min_persistent - 1);
    assert!(
        ttl < LONG_TTL_EXTEND,
        "the money entry expires before the contract's own instance entry does",
    );

    // It is restorable in the same way, so this is rent and operator burden, not loss.
    s.mock_auths();
    s.advance_ledgers(PUBNET.min_persistent + 10);
    s.set_time(400 * 86_400);
    assert_eq!(s.client().balance(), 100 * UNIT);
    s.client().withdraw(&s.stranger, &(100 * UNIT));
    assert_eq!(s.token().balance(&s.stranger), 100 * UNIT);
}

/// The mirror of the SAC's own `DataKey::Balance(Address)`. `#[contracttype]` encodes an
/// enum variant as `[Symbol(name), args...]`, so a local enum with the same variant name
/// and payload type produces the same ledger key.
#[soroban_sdk::contracttype]
pub enum SacKey {
    Balance(Address),
}

/// INV-20 end to end: everything else can be gone (the day bucket expired, every
/// allowlist entry archived, the instance entry archived, months of no activity) and the
/// owner can still take the money out.
#[test]
fn withdraw_still_works_after_every_other_entry_has_lapsed() {
    let s = setup_on(PUBNET, 10 * UNIT, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().set_policy(&(10 * UNIT), &0, &true);
    s.client().set_allowed(&s.payee, &true);
    s.client().pay(&s.payee, &UNIT);

    s.advance_ledgers(PUBNET.min_persistent + 100);
    s.set_time(500 * 86_400);
    assert_eq!(s.client().spent_today(), 0);

    s.client().withdraw(&s.owner, &(99 * UNIT));
    assert_eq!(s.token().balance(&s.owner), 99 * UNIT);
}

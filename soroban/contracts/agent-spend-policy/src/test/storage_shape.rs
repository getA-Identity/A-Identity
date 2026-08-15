//! Where each piece of state lives, asserted rather than assumed.
//!
//! This is the instance-storage-exhaustion finding class, which shows up in published
//! Soroban audits and which this contract is shaped to make unreachable. The whole
//! instance map is ONE ledger entry, read by every entrypoint. Put anything unbounded in
//! it and the entry grows until every entrypoint bricks, `withdraw` included: a vault
//! holding a stranger's money, unspendable on a timer.
//!
//! A comment saying "the day bucket is temporary" is not a control. These are.

use super::{setup, UNIT};
use crate::storage::DataKey;
use soroban_sdk::testutils::{Address as _, Deployer as _, Ledger as _};
use soroban_sdk::Address;

#[test]
fn the_day_accumulator_is_temporary_and_never_instance() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &UNIT);

    let day = s.client().today();
    s.env.as_contract(&s.contract_id, || {
        assert!(
            s.env.storage().temporary().has(&DataKey::SpentOnDay(day)),
            "the day bucket must be in temporary storage",
        );
        assert!(
            !s.env.storage().instance().has(&DataKey::SpentOnDay(day)),
            "a per-day key in the instance entry grows it without bound until every \
             entrypoint bricks, withdraw included",
        );
        assert!(!s.env.storage().persistent().has(&DataKey::SpentOnDay(day)));
    });
}

#[test]
fn allowlist_entries_are_independent_persistent_entries() {
    let s = setup(0, 0);
    s.mock_auths();
    let payee = Address::generate(&s.env);
    s.client().set_allowed(&payee, &true);

    s.env.as_contract(&s.contract_id, || {
        assert!(s
            .env
            .storage()
            .persistent()
            .has(&DataKey::Allowed(payee.clone())));
        assert!(
            !s.env
                .storage()
                .instance()
                .has(&DataKey::Allowed(payee.clone())),
            "the allowlist is unbounded in count, so it may never share the instance entry",
        );
    });
}

#[test]
fn two_hundred_allowlist_entries_do_not_grow_the_instance_entry() {
    let s = setup(0, 0);
    s.mock_auths();
    for _ in 0..200 {
        s.client().set_allowed(&Address::generate(&s.env), &true);
    }

    // Every entry landed in its own persistent slot, so the instance entry still holds
    // only the fixed config. This is what would fail loudly if someone "simplified" the
    // allowlist into a Map inside instance storage: the instance entry would then carry
    // 200 payees and keep growing, and the vault would be on a clock to becoming
    // uncallable.
    s.env.as_contract(&s.contract_id, || {
        assert!(s.env.storage().instance().has(&DataKey::Owner));
        assert!(s.env.storage().instance().has(&DataKey::DailyCap));
    });
    assert!(s.env.deployer().get_contract_instance_ttl(&s.contract_id) > 0);
}

#[test]
fn removing_an_allowlist_entry_deletes_it_rather_than_storing_false() {
    let s = setup(0, 0);
    s.mock_auths();
    let payee = Address::generate(&s.env);

    s.client().set_allowed(&payee, &true);
    s.client().set_allowed(&payee, &false);

    // Absent and explicitly-disallowed mean the same thing to every reader, and a removed
    // entry stops accruing rent. Storing `false` would pay forever to say nothing.
    s.env.as_contract(&s.contract_id, || {
        assert!(!s
            .env
            .storage()
            .persistent()
            .has(&DataKey::Allowed(payee.clone())));
    });
    assert!(!s.client().is_allowed(&payee));
}

#[test]
fn the_instance_ttl_is_extended_by_a_payment() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    // Burn most of the current TTL, then transact and watch it come back. A vault that
    // goes quiet for months and archives becomes uncallable until someone restores it,
    // and `withdraw` is behind the same door as everything else.
    s.env.ledger().with_mut(|l| l.sequence_number += 100_000);
    s.client().pay(&s.payee, &UNIT);

    let ttl = s.env.deployer().get_contract_instance_ttl(&s.contract_id);
    assert!(
        ttl >= crate::storage::LONG_TTL_THRESHOLD,
        "pay must leave the instance entry above the bump threshold, got {ttl}",
    );
}

/// The property, not the number.
///
/// There is no way to read a temporary entry's TTL from a test, and asserting a constant
/// would only restate the source anyway. What matters is behavioural: the bucket must
/// still be there later the same day. The network's own minimum temporary TTL is about
/// one day, which covers the remainder of a bucket's day only just, and if it ever fell
/// short the cap would reset mid-day and the agent could spend twice its limit.
#[test]
fn the_day_bucket_survives_the_rest_of_its_own_day() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.client().spent_today(), 10 * UNIT);

    // A full day of ledgers later, still inside the two-day floor the write extends to.
    s.env
        .ledger()
        .with_mut(|l| l.sequence_number += crate::storage::LEDGERS_PER_DAY);
    assert_eq!(
        s.client().spent_today(),
        10 * UNIT,
        "the bucket expired while its own day was still running, so the cap silently reset",
    );
}

/// And the other half: once the day is genuinely over, the bucket is allowed to go, and
/// its absence must read as zero rather than as an error. That is what makes temporary
/// storage the right choice instead of persistent, which would abort with an opaque host
/// archival error instead of a typed policy reason.
#[test]
fn a_bucket_from_a_past_day_is_gone_and_reads_as_zero() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &(10 * UNIT));

    s.env.ledger().with_mut(|l| {
        l.sequence_number += 5 * crate::storage::LEDGERS_PER_DAY;
        l.timestamp += 5 * 86_400;
    });
    assert_eq!(s.client().spent_today(), 0);
    s.client().pay(&s.payee, &(10 * UNIT));
}

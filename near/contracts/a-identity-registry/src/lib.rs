//! A-Identity's counterparty risk registry, on NEAR.
//!
//! An ORACLE (A-Identity's signer) writes one verdict per account: ALLOW, WARN or DENY,
//! with reason codes, a pointer to the evidence, an optional score, the code hash it
//! observed, and an optional expiry. Anyone can file a REPORT against an account by
//! attaching `REPORT_DEPOSIT`; a report is input for an oracle's review and never changes a
//! verdict by itself. The OWNER manages the oracle set and the owner role, and nothing else:
//! it cannot write a verdict or clear a report unless it makes itself an oracle, and that
//! act is an event like any other.
//!
//! ## The one read this contract exists for
//!
//! The vault (`agent-spend-policy`) calls `get_verdict(payee)` before every payment and acts
//! on the answer on chain: DENY is refused, WARN is held for the vault's owner, ALLOW is paid.
//! No verdict is silence: the vault pays a payee its owner listed or it has paid before, and
//! by default (its `hold_unknown`) holds any other for the owner. So the JSON `get_verdict`
//! returns is public ABI in a stronger sense than
//! the rest of this contract: either JSON `null`, or an object whose top-level `verdict` is
//! the plain string "ALLOW", "WARN" or "DENY". The vault fails closed on anything else, so
//! changing that shape does not loosen the vault; it turns every payment into a refusal.
//!
//! An expired verdict reads exactly like no verdict, and that includes an expired DENY,
//! which the vault then no longer refuses: it treats the payee as one nobody has judged. A TTL
//! on a DENY is therefore a decision to let the payee be paid again once it lapses (at once if
//! the vault already knows it, after its owner approves otherwise). An oracle attaches one
//! only when that is what it means.
//!
//! ## Trust, stated
//!
//! Oracles are trusted to write verdicts, and the registry account pays the storage they
//! write (901 bytes, 0.009 NEAR, for a verdict with every field at its limit; a unit test
//! measures it). A compromised oracle key can write anything an oracle can until the owner
//! removes it, and removing an oracle does not retract what it wrote: the remedy is to
//! overwrite or clear those verdicts. `updated_by` and the `verdict_set` events say which
//! oracle wrote what.
//!
//! Access control is `env::predecessor_account_id()` throughout, never the signer: the
//! predecessor is the account that made this call, while the signer is whoever signed the
//! transaction that started the chain of calls, possibly several contracts back.
//!
//! ## What is not here, on purpose
//!
//! No upgrade method. A second way to replace the code is a second total-authority door,
//! and the account's own full-access key is already one. State is borsh, so the order of
//! `StorageKey` and of every stored struct's fields is frozen for the deployed contract.
//!
//! No refund of report deposits, ever, including when an oracle clears the reports. See
//! `REPORT_DEPOSIT` for why.
//!
//! No `#[private]` on `new`. Deploy and init are sent as one batch transaction, either by the
//! registry account itself or by the parent account that creates it, and `#[private]` would
//! refuse the second. A deploy sent WITHOUT its init call leaves the first caller of `new`
//! free to make itself owner, so never deploy this contract without the init in the same
//! transaction.

mod error;
mod event;
mod rules;
mod types;

#[cfg(test)]
mod tests;

pub use crate::error::Error;
pub use crate::event::RegistryEvent;
pub use crate::rules::{
    DEFAULT_PAGE, MAX_BATCH, MAX_CODE_HASH_LEN, MAX_CODE_LEN, MAX_EVIDENCE_LEN, MAX_LOG_BYTES,
    MAX_OPEN_REPORTS, MAX_ORACLES, MAX_PAGE, MAX_REASONS, MAX_SCORE, REPORT_DEPOSIT,
};
pub use crate::types::{
    CheckVerdict, CheckView, Report, ReportView, Verdict, VerdictInput, VerdictRecord, VerdictView,
};

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{AccountId, AsNep297Event, BorshStorageKey, NearToken, PanicOnDefault, env, near};

/// Storage prefixes. Each variant is a one-byte prefix by declaration order, so the order
/// is frozen for a deployed contract: reorder or delete one and two collections read each
/// other's bytes. Append only.
#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    Oracles,
    Verdicts,
    Reports,
    ReportCount,
}

#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Registry {
    owner_id: AccountId,
    /// At most `MAX_ORACLES`.
    oracles: IterableSet<AccountId>,
    /// One verdict per account. Iterable so the console can page through them.
    verdicts: IterableMap<AccountId, VerdictRecord>,
    /// The reports filed since the account's last oracle review, at most `MAX_OPEN_REPORTS`.
    /// A plain `Vec` per account because it is small and bounded, and it is always read
    /// whole: the duplicate check needs every reporter.
    reports: LookupMap<AccountId, Vec<Report>>,
    /// Every report ever filed against the account, including reviewed and cleared ones.
    /// Never reset, so a reader can tell an account that has attracted reports over time
    /// from one that never has.
    report_count: LookupMap<AccountId, u32>,
}

#[near]
impl Registry {
    // -- init ---------------------------------------------------------------------------

    /// Sets the owner and the initial oracles. Duplicate oracles collapse into one; more
    /// than `MAX_ORACLES` distinct ones are refused.
    ///
    /// Emits `owner_set` and one `oracle_added` per oracle, so the owner and the oracle set
    /// can be rebuilt from the event log alone, from the first block.
    #[init]
    pub fn new(owner_id: AccountId, oracles: Vec<AccountId>) -> Self {
        let mut set = IterableSet::new(StorageKey::Oracles);
        for oracle in oracles {
            set.insert(oracle);
            if set.len() > MAX_ORACLES {
                Error::OracleLimitReached.panic();
            }
        }
        let this = Self {
            owner_id,
            oracles: set,
            verdicts: IterableMap::new(StorageKey::Verdicts),
            reports: LookupMap::new(StorageKey::Reports),
            report_count: LookupMap::new(StorageKey::ReportCount),
        };
        RegistryEvent::OwnerSet {
            owner_id: &this.owner_id,
        }
        .emit();
        for oracle in this.oracles.iter() {
            RegistryEvent::OracleAdded { account_id: oracle }.emit();
        }
        this
    }

    // -- oracle writes --------------------------------------------------------------------

    /// Write the verdict for `account_id`, replacing any earlier one.
    ///
    /// `ttl_s` is in seconds; absent or "0" means the verdict does not expire. Read the
    /// crate comment before giving a DENY a TTL.
    ///
    /// Not payable, on purpose: an oracle can run on a function-call access key scoped to
    /// this contract, which can never attach a deposit and never move the oracle's NEAR.
    ///
    /// Refusals, in order: `NotOracle`, `TooManyReasons`, `InvalidReason`,
    /// `EvidenceTooLong`, `ScoreOutOfRange`, `CodeHashTooLong`, `MathOverflow`.
    // The argument list is the method's public ABI; a struct argument would change the JSON
    // every caller sends. `set_verdicts` takes the same fields as a struct.
    #[allow(clippy::too_many_arguments)]
    pub fn set_verdict(
        &mut self,
        account_id: AccountId,
        verdict: Verdict,
        reasons: Vec<String>,
        evidence: Option<String>,
        score: Option<u16>,
        code_hash: Option<String>,
        ttl_s: Option<U64>,
    ) {
        let by = self.require_oracle();
        let entry = VerdictInput {
            account_id,
            verdict,
            reasons,
            evidence,
            score,
            code_hash,
            ttl_s,
        };
        self.write_verdicts(by, vec![entry]);
    }

    /// Write up to `MAX_BATCH` verdicts in one call, all or none.
    ///
    /// Every entry is validated, and every event rendered and measured, before anything is
    /// written. An entry that breaks a rule refuses the whole batch with that entry's error.
    /// Entries for the same account apply in order, so the last one wins, and each emits its
    /// own `verdict_set`.
    ///
    /// Refusals, in order: `NotOracle`, `BatchTooLarge` (more than `MAX_BATCH` entries),
    /// then each entry's rules as in `set_verdict`, then `BatchTooLarge` again when the
    /// batch's events would exceed the runtime's `MAX_LOG_BYTES` per receipt. A full batch
    /// at every length limit fits when its evidence is a URL or a hash; see `MAX_LOG_BYTES`
    /// for the evidence that does not.
    pub fn set_verdicts(&mut self, entries: Vec<VerdictInput>) {
        let by = self.require_oracle();
        if entries.len() > MAX_BATCH {
            Error::BatchTooLarge.panic();
        }
        self.write_verdicts(by, entries);
    }

    /// Remove `account_id`'s verdict, live or expired. The account then reads as having no
    /// verdict, which the vault treats as silence: paid if the vault already knows the payee,
    /// held for its owner otherwise. A no-op, with no event, when there is none.
    pub fn clear_verdict(&mut self, account_id: AccountId) {
        let by = self.require_oracle();
        if self.verdicts.remove(&account_id).is_some() {
            RegistryEvent::VerdictCleared {
                account_id: &account_id,
                by: &by,
            }
            .emit();
        }
    }

    /// Clear `account_id`'s open reports after an oracle has reviewed them. `report_count`
    /// keeps counting them, the deposits stay with the contract, and every reporter may
    /// report the account again. A no-op, with no event, when none are open.
    pub fn clear_reports(&mut self, account_id: AccountId) {
        let by = self.require_oracle();
        if self.reports.remove(&account_id).is_some() {
            RegistryEvent::ReportsCleared {
                account_id: &account_id,
                by: &by,
            }
            .emit();
        }
    }

    // -- reports --------------------------------------------------------------------------

    /// File a report against `account_id`. Anyone may, once per open review cycle, with at
    /// least `REPORT_DEPOSIT` attached; the whole deposit is kept (see `REPORT_DEPOSIT`).
    ///
    /// The reporter is the predecessor, so a contract can file a report as itself.
    ///
    /// Refusals, in order: `ReportDepositTooLow`, `SelfReport`, `InvalidReason`,
    /// `EvidenceTooLong`, `DuplicateReport`, `ReportLimitReached`, `MathOverflow`.
    #[payable]
    pub fn report(&mut self, account_id: AccountId, reason: String, evidence: String) {
        let reporter = env::predecessor_account_id();
        rules::check_new_report(
            env::attached_deposit(),
            &reporter,
            &account_id,
            &reason,
            &evidence,
        )
        .unwrap_or_else(|err| err.panic());
        let open = self.reports.get(&account_id).map_or(&[][..], Vec::as_slice);
        rules::check_open_reports(open, &reporter).unwrap_or_else(|err| err.panic());
        let count = rules::next_report_count(self.report_count(account_id.clone()))
            .unwrap_or_else(|err| err.panic());

        let report = Report {
            reporter: reporter.clone(),
            reason: reason.clone(),
            evidence: evidence.clone(),
            at_ns: env::block_timestamp(),
        };
        match self.reports.get_mut(&account_id) {
            Some(open) => open.push(report),
            None => {
                self.reports.insert(account_id.clone(), vec![report]);
            }
        }
        self.report_count.insert(account_id.clone(), count);

        RegistryEvent::ReportFiled {
            account_id: &account_id,
            reporter: &reporter,
            reason: &reason,
            evidence: &evidence,
        }
        .emit();
    }

    // -- owner ----------------------------------------------------------------------------

    /// Add an oracle. A no-op, with no event, when it already is one, including at the
    /// limit: that call asked for a state that already holds.
    ///
    /// Refusals, in order: `NotOwner`, `RequiresOneYocto`, `OracleLimitReached`.
    #[payable]
    pub fn add_oracle(&mut self, account_id: AccountId) {
        self.require_owner_one_yocto();
        if self.oracles.contains(&account_id) {
            return;
        }
        if self.oracles.len() >= MAX_ORACLES {
            Error::OracleLimitReached.panic();
        }
        self.oracles.insert(account_id.clone());
        RegistryEvent::OracleAdded {
            account_id: &account_id,
        }
        .emit();
    }

    /// Remove an oracle. Its past verdicts stay; see the crate comment. A no-op, with no
    /// event, when it is not one. Removing the last oracle is allowed: verdicts then stay as
    /// they are until the owner adds one.
    ///
    /// Refusals, in order: `NotOwner`, `RequiresOneYocto`.
    #[payable]
    pub fn remove_oracle(&mut self, account_id: AccountId) {
        self.require_owner_one_yocto();
        if self.oracles.remove(&account_id) {
            RegistryEvent::OracleRemoved {
                account_id: &account_id,
            }
            .emit();
        }
    }

    /// Hand the owner role to `new_owner`, in one step. The old owner loses it in the same
    /// call, so a mistyped account id is a lost owner role: the console should make the
    /// owner confirm the exact id.
    ///
    /// Refusals, in order: `NotOwner`, `RequiresOneYocto`.
    #[payable]
    pub fn set_owner(&mut self, new_owner: AccountId) {
        self.require_owner_one_yocto();
        self.owner_id = new_owner;
        RegistryEvent::OwnerSet {
            owner_id: &self.owner_id,
        }
        .emit();
    }

    // -- views ----------------------------------------------------------------------------

    /// The live verdict for `account_id`, or `null` when it has none or it has expired.
    /// This is the read the vault makes cross-contract before every payment.
    pub fn get_verdict(&self, account_id: AccountId) -> Option<VerdictView> {
        let record = self.verdicts.get(&account_id)?;
        if !rules::is_live(record.expires_at_ns, env::block_timestamp()) {
            return None;
        }
        Some(VerdictView::from_record(account_id, record))
    }

    /// The live verdict in brief, with the number of open reports.
    ///
    /// `reports` counts OPEN reports (`get_reports`), not `report_count`. A lifetime count
    /// can be inflated by anyone for 0.01 NEAR a report and never comes down, so an account
    /// an oracle reviewed and cleared would carry its worst day forever. The open count is
    /// what is still waiting for review; `report_count` remains a view of its own.
    pub fn check(&self, account_id: AccountId) -> CheckView {
        let reports = self.open_report_count(&account_id);
        match self.get_verdict(account_id) {
            Some(view) => CheckView {
                verdict: view.verdict.into(),
                reasons: view.reasons,
                reports,
            },
            None => CheckView {
                verdict: CheckVerdict::NoVerdict,
                reasons: Vec::new(),
                reports,
            },
        }
    }

    /// The stored verdicts in storage order, `limit` at a time (default `DEFAULT_PAGE`, at
    /// most `MAX_PAGE`); both arguments are decimal strings.
    ///
    /// This is the enumeration, not the decision: it includes verdicts whose
    /// `expires_at_ns` has passed, so an operator can see what lapsed. A reader must
    /// compare `expires_at_ns` with the current time before treating an entry as live;
    /// `get_verdict` and `check` do that already. Paging is over storage positions, so a
    /// page costs the same at any depth; removing a verdict moves the last one into its
    /// position, so a list read while verdicts are being cleared can skip or repeat one.
    pub fn list_verdicts(&self, from_index: Option<U64>, limit: Option<U64>) -> Vec<VerdictView> {
        let (skip, take) = rules::page(from_index.map(|v| v.0), limit.map(|v| v.0));
        self.verdicts
            .iter()
            .skip(skip)
            .take(take)
            .map(|(account_id, record)| VerdictView::from_record(account_id.clone(), record))
            .collect()
    }

    /// The open reports against `account_id`, oldest first. At most `MAX_OPEN_REPORTS`.
    pub fn get_reports(&self, account_id: AccountId) -> Vec<ReportView> {
        self.reports
            .get(&account_id)
            .map(|open| open.iter().map(ReportView::from).collect())
            .unwrap_or_default()
    }

    /// Every report ever filed against `account_id`, including reviewed and cleared ones.
    pub fn report_count(&self, account_id: AccountId) -> u32 {
        self.report_count.get(&account_id).copied().unwrap_or(0)
    }

    pub fn oracles(&self) -> Vec<AccountId> {
        self.oracles.iter().cloned().collect()
    }

    pub fn owner(&self) -> AccountId {
        self.owner_id.clone()
    }
}

// -- internals ------------------------------------------------------------------------------

impl Registry {
    /// The caller, if it is an oracle. Checked before any input is looked at, so a caller
    /// that is not an oracle learns nothing about which of its inputs would have passed.
    fn require_oracle(&self) -> AccountId {
        let caller = env::predecessor_account_id();
        if !self.oracles.contains(&caller) {
            Error::NotOracle.panic();
        }
        caller
    }

    /// The owner, then exactly 1 yoctoNEAR.
    ///
    /// The yocto is not a fee. Only a full-access key can sign a call with a deposit, so
    /// requiring one means no function-call key can make this call, including the one a web
    /// wallet creates for the console when the owner signs in, and the wallet asks the
    /// owner to confirm. Exactly 1, not at least 1: the contract keeps whatever is attached,
    /// and an owner method should never be able to take more than the signal costs.
    fn require_owner_one_yocto(&self) {
        if env::predecessor_account_id() != self.owner_id {
            Error::NotOwner.panic();
        }
        if env::attached_deposit() != NearToken::from_yoctonear(1) {
            Error::RequiresOneYocto.panic();
        }
    }

    fn open_report_count(&self, account_id: &AccountId) -> u32 {
        let open = self.reports.get(account_id).map_or(0, Vec::len);
        // At most MAX_OPEN_REPORTS, so the conversion cannot fail; saturate rather than
        // panic in a view if that bound were ever raised past u32.
        u32::try_from(open).unwrap_or(u32::MAX)
    }

    /// The shared tail of `set_verdict` and `set_verdicts`: validate everything, render and
    /// measure every event, and only then write and log. The rendering is done once and the
    /// same lines are logged, so what was measured is what is logged.
    fn write_verdicts(&mut self, by: AccountId, entries: Vec<VerdictInput>) {
        let now_ns = env::block_timestamp();
        let mut records = Vec::with_capacity(entries.len());
        for entry in entries {
            let expires_at_ns =
                rules::check_verdict_input(&entry, now_ns).unwrap_or_else(|err| err.panic());
            let record = VerdictRecord {
                verdict: entry.verdict,
                reasons: entry.reasons,
                evidence: entry.evidence,
                score: entry.score,
                code_hash: entry.code_hash,
                updated_at_ns: now_ns,
                updated_by: by.clone(),
                expires_at_ns,
            };
            records.push((entry.account_id, record));
        }

        let lines: Vec<String> = records
            .iter()
            .map(|(account_id, record)| {
                RegistryEvent::verdict_set(account_id, record)
                    .to_nep297_event()
                    .to_event_log()
            })
            .collect();
        rules::check_log_budget(&lines).unwrap_or_else(|err| err.panic());

        for (account_id, record) in records {
            self.verdicts.insert(account_id, record);
        }
        for line in &lines {
            env::log_str(line);
        }
    }
}

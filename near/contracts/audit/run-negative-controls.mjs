#!/usr/bin/env node
/**
 * Negative controls for the NEAR contracts: prove the tests would notice each guard going
 * missing.
 *
 * A green suite says the contracts pass their tests. It does not say the tests would notice if
 * a contract stopped being safe, and on NEAR that gap is easy to fall into. The unit tests run
 * the contracts as native Rust against a mocked blockchain, where `#[private]`, `#[payable]`
 * and `#[init]` do not exist (near-sdk generates those checks into the wasm entry points
 * only), and a mocked context that sets the signer and the predecessor to the same account
 * can make two independent checks look like one. A suite can be all green and still never
 * exercise the line that keeps a forwarded call from paying as the agent.
 *
 * So, for each control below: delete or neutralize ONE guard in place, with an exact
 * find/replace that must match exactly once; compile the mutated crate; run the narrowest
 * test command that should notice; and REQUIRE it to go red. The source is restored
 * unconditionally after every control, and the run ends by requiring the full unit suite
 * green again on the restored tree, byte for byte the tree it started from.
 *
 * Narrowest first. A unit filter (`cargo test -p <crate> --lib -- --exact <names>`) takes
 * seconds and is used wherever a unit test can see the guard. The sandbox (`cargo test -p
 * sandbox-tests --test <file> -- --exact <names>`) builds the mutated wasm and starts a local
 * neard, so it is used only for what exists in the wasm alone: the macro-generated checks.
 *
 * A control is a FAILURE, never a curiosity, when:
 *   - its find text does not match exactly once (the guard moved, or this list is stale);
 *   - a test it names does not exist (a filter that matches nothing is trivially green);
 *   - the mutated crate does not compile (red for the wrong reason proves nothing);
 *   - its tests stay green: NOT CAUGHT. The fix is the missing test, in the crate that owns
 *     the guard, never dropping the control or weakening the guard.
 *
 * Usage (from anywhere; the workspace is the directory above this file):
 *   node near/contracts/audit/run-negative-controls.mjs              every control
 *   node near/contracts/audit/run-negative-controls.mjs --list       name, guard and tests
 *   node near/contracts/audit/run-negative-controls.mjs --check      every find matches once, no cargo
 *   node near/contracts/audit/run-negative-controls.mjs --only a,b   names containing a or b
 *   node near/contracts/audit/run-negative-controls.mjs --unit-only  skip the sandbox controls
 * The environment reaches every cargo call as it is: SANDBOX_TESTS_PARALLEL and
 * NEAR_SANDBOX_BIN_PATH for the sandbox tests, CARGO_NET_OFFLINE=true for an offline run,
 * CARGO_TARGET_DIR for a separate build directory. The one exception is SANDBOX_WASM_DIR, which
 * is removed: it makes the sandbox deploy given bytes instead of building the source, and a
 * control is only a control if the sandbox runs the mutated source. Exit 0 only when every
 * selected control was caught; a partial selection says so in its last line.
 *
 * The mutation is written to the working tree, so a run must not share the tree with an
 * editor or another process writing the same files. Before each mutation the original and
 * the mutated text are recorded in `audit/.control-in-progress.json` (git-ignored); a run that
 * was killed outright leaves that record behind, and the next run restores the file from it
 * before doing anything else. Ctrl-C stops the running cargo, restores, and exits 130.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AUDIT = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(AUDIT, '..')
const MARKER = join(AUDIT, '.control-in-progress.json')

const VAULT = 'agent-spend-policy'
const REGISTRY = 'a-identity-registry'
const VAULT_LIB = `${VAULT}/src/lib.rs`
const VAULT_POLICY = `${VAULT}/src/policy.rs`
const VAULT_VERDICT = `${VAULT}/src/verdict.rs`
const REGISTRY_LIB = `${REGISTRY}/src/lib.rs`
const REGISTRY_RULES = `${REGISTRY}/src/rules.rs`

/** Tests in a contract crate's own unit suite, by full path (`test::auth::...`). */
const unit = (crate, ...names) => ({ kind: 'unit', crate, names })
/** Tests in one file of sandbox-tests/tests, by function name. */
const sandbox = (binary, ...names) => ({ kind: 'sandbox', binary, names })

// -------------------------------------------------------------------------------------------
// The controls
// -------------------------------------------------------------------------------------------

/**
 * Each control names one guard, the exact text that implements it, what replaces it, what a
 * deployed contract without it would allow, and the tests that must notice. Controls are kept
 * next to the tests that cover them: a control nothing catches fails this script, and should,
 * because it is telling the truth about a gap.
 */
const CONTROLS = [
  // -- the vault: who is the agent -----------------------------------------------------------
  {
    name: 'agent: the call must come from the vault account itself',
    file: VAULT_LIB,
    find: '        if env::predecessor_account_id() != vault_id || env::signer_account_id() != vault_id {\n',
    replace: '        if env::signer_account_id() != vault_id {\n',
    breaks:
      'The agent key signature survives every hop of a call chain, so a contract the vault calls (its token, its registry, or one a future version calls) could call pay back and be taken for the agent, spending inside the policy without the agent ever asking.',
    tests: unit(VAULT, 'test::auth::a_contract_forwarding_the_agent_keys_transaction_is_not_an_agent'),
  },
  {
    name: 'agent: the transaction must be signed as the vault account',
    file: VAULT_LIB,
    find: '        if env::predecessor_account_id() != vault_id || env::signer_account_id() != vault_id {\n',
    replace: '        if env::predecessor_account_id() != vault_id {\n',
    breaks:
      'A NEP-366 delegate action the agent key signed, relayed from the key holder\'s own implicit account, is accepted. The protocol never charges a relayed action to the key\'s allowance, so a leaked key could make the vault store held payments and counters for free, past the bound its allowance sets.',
    tests: unit(VAULT, 'test::auth::a_delegate_action_relayed_by_another_account_is_not_an_agent'),
  },
  {
    name: 'agent: the signing key must be a registered agent key',
    file: VAULT_LIB,
    find: '            Some(key) if !key.revoked => key.expires_at_s,\n            _ => Error::NotAgent.panic(),\n',
    replace:
      '            Some(key) if !key.revoked => key.expires_at_s,\n            None => 0,\n            _ => Error::NotAgent.panic(),\n',
    breaks:
      'Any key on the vault account is an agent with no expiry, including a full-access key left behind at deploy and any key a wallet added for the console.',
    tests: unit(VAULT, 'test::auth::unknown_key_on_the_vault_account_is_not_an_agent'),
  },
  {
    name: 'agent: a revoked key is not an agent',
    file: VAULT_LIB,
    find: '            Some(key) if !key.revoked => key.expires_at_s,\n',
    replace: '            Some(key) => key.expires_at_s,\n',
    breaks:
      'A revoked key keeps paying for as long as its access key survives on chain: the window before the delete lands, and forever if the delete fails.',
    tests: unit(VAULT, 'test::auth::revoked_key_is_not_an_agent_on_any_agent_method'),
  },

  // -- the vault: callbacks ------------------------------------------------------------------
  {
    name: 'callback: exactly one promise result',
    file: VAULT_LIB,
    find: '    if env::predecessor_account_id() != env::current_account_id()\n        || env::promise_results_count() != 1\n    {\n',
    replace: '    if env::predecessor_account_id() != env::current_account_id() {\n',
    breaks:
      'The agent key signs as the vault, so it passes #[private]. It could call on_transfer directly with a made-up context and have the vault log a payment that never happened, count the payee as paid (and so known), or call on_verdict to settle a payment no registry answered.',
    tests: unit(
      VAULT,
      'test::auth::a_direct_call_to_a_callback_is_refused',
      'test::auth::a_callback_with_two_results_is_refused'
    ),
  },
  {
    name: 'callback: from the vault account only',
    file: VAULT_LIB,
    find: '    if env::predecessor_account_id() != env::current_account_id()\n        || env::promise_results_count() != 1\n    {\n',
    replace: '    if env::promise_results_count() != 1 {\n',
    breaks:
      'The callbacks rest on #[private] alone for who may call them. Unit tests do not run #[private], so without this the in-code half of the check would be untested.',
    tests: unit(VAULT, 'test::auth::a_callback_from_another_account_is_refused'),
  },
  {
    name: 'callback: #[private] on on_transfer',
    file: VAULT_LIB,
    find: '    #[private]\n    pub fn on_transfer(&mut self, ctx: PaymentCtx) -> PayOutcome {\n',
    replace: '    pub fn on_transfer(&mut self, ctx: PaymentCtx) -> PayOutcome {\n',
    breaks:
      'Another account reaches on_transfer, and only the in-code callback check stands between it and a forged payment_sent. The macro check exists in the wasm alone, so only the sandbox can see it go.',
    tests: sandbox('keys', 'a_callback_called_directly_is_refused_even_from_the_vault_account'),
  },

  // -- the vault: the owner -------------------------------------------------------------------
  {
    name: 'owner: the owner check',
    file: VAULT_LIB,
    find: '        if env::predecessor_account_id() != self.owner_id {\n            Error::NotOwner.panic();\n        }\n',
    replace: '',
    breaks:
      'Anyone lifts the caps, repoints the registry, adds an agent key of their own, settles held payments, or freezes the vault forever.',
    tests: unit(
      VAULT,
      'test::auth::every_owner_method_refuses_a_non_owner',
      'test::auth::the_agent_key_cannot_reach_an_owner_method'
    ),
  },
  {
    name: 'owner: one yoctoNEAR',
    file: VAULT_LIB,
    find: '        if env::attached_deposit() != ONE_YOCTO {\n            Error::RequiresOneYocto.panic();\n        }\n',
    replace: '',
    breaks:
      'A function-call key (the one a web wallet creates for the console at sign-in) can change the policy, add agent keys and move money, with no wallet confirmation.',
    tests: unit(
      VAULT,
      'test::auth::every_sensitive_owner_method_requires_exactly_one_yocto',
      'test::auth::freeze_needs_no_yocto_and_unfreeze_does'
    ),
  },
  {
    name: 'owner: exactly one yoctoNEAR, not at least one',
    file: VAULT_LIB,
    find: '        if env::attached_deposit() != ONE_YOCTO {\n',
    replace: '        if env::attached_deposit() < ONE_YOCTO {\n',
    breaks:
      'An owner method keeps whatever is attached, so a mistyped amount in a wallet becomes NEAR the vault holds and has no method to return.',
    tests: unit(VAULT, 'test::auth::every_sensitive_owner_method_requires_exactly_one_yocto'),
  },
  // Each sensitive owner method's own choice of check is a guard too; see ownerMethodControls.

  // -- the vault: the agent key it creates ----------------------------------------------------
  {
    name: 'agent key: exactly pay, request_payment and record_refusal',
    file: VAULT_LIB,
    find: 'pub const AGENT_METHODS: &str = "pay,request_payment,record_refusal";\n',
    replace: 'pub const AGENT_METHODS: &str = "";\n',
    breaks:
      'An empty method list is every method: the agent key can call any method of the vault, and the protocol no longer stands between it and the callbacks.',
    tests: unit(VAULT, 'test::owner::add_agent_key_creates_a_restricted_function_call_key_on_the_vault'),
  },
  {
    name: 'agent key: the receiver is the vault',
    file: VAULT_LIB,
    find: '                gas_allowance,\n                vault_id.clone(),\n                AGENT_METHODS,\n',
    replace: '                gas_allowance,\n                self.token_id.clone(),\n                AGENT_METHODS,\n',
    breaks:
      'The agent key is scoped to the token instead of the vault: the agent can no longer pay through the policy at all, and the key may call whatever the token exposes under those three method names.',
    tests: unit(VAULT, 'test::owner::add_agent_key_creates_a_restricted_function_call_key_on_the_vault'),
  },
  {
    name: 'agent key: a function-call key, never full access',
    file: VAULT_LIB,
    find: '            .add_access_key_allowance(\n                public_key.clone(),\n                gas_allowance,\n                vault_id.clone(),\n                AGENT_METHODS,\n            )\n',
    replace: '            .add_full_access_key(public_key.clone())\n',
    breaks:
      'The agent holds a full-access key to the vault account: it can redeploy the code, delete the account, or transfer its NEAR, and no contract check applies.',
    tests: unit(VAULT, 'test::owner::add_agent_key_creates_a_restricted_function_call_key_on_the_vault'),
  },
  {
    name: 'agent key: a zero allowance is refused, not made unlimited',
    file: VAULT_LIB,
    find: '            .unwrap_or_else(|| Error::InvalidAmount.panic());\n        if self.agents.len() >= MAX_AGENT_KEYS {\n',
    replace: '            .unwrap_or(Allowance::Unlimited);\n        if self.agents.len() >= MAX_AGENT_KEYS {\n',
    breaks:
      'A zero allowance becomes an unlimited one, and a leaked agent key can burn the vault\'s whole NEAR balance on gas.',
    tests: unit(VAULT, 'test::owner::a_zero_allowance_is_refused_not_made_unlimited'),
  },
  {
    name: 'agent key: at most MAX_AGENT_KEYS records',
    file: VAULT_LIB,
    find: '        if self.agents.len() >= MAX_AGENT_KEYS {\n            Error::KeyLimitReached.panic();\n        }\n',
    replace: '',
    breaks:
      'The key set is unbounded, and every key is one more allowance that can burn the vault\'s NEAR on gas.',
    tests: unit(VAULT, 'test::owner::key_records_are_bounded_and_revoked_ones_count_until_forgotten'),
  },
  {
    name: 'revoke: the record is marked revoked in the same receipt',
    file: VAULT_LIB,
    find: '            Some(key) => key.revoked = true,\n',
    replace: '            Some(_) => {}\n',
    breaks:
      'A revoked key keeps paying until the delete lands, and forever if it fails.',
    tests: unit(
      VAULT,
      'test::auth::revoked_key_is_not_an_agent_on_any_agent_method',
      'test::owner::revoke_marks_the_record_and_deletes_the_access_key'
    ),
  },
  {
    name: 'revoke: the access key is deleted from the account',
    file: VAULT_LIB,
    find: '        Promise::new(env::current_account_id())\n            .delete_key(public_key)\n            .detach();\n',
    replace: '',
    breaks:
      'A revoked key can still sign as the vault and burn its allowance on refused calls, forever.',
    tests: unit(VAULT, 'test::owner::revoke_marks_the_record_and_deletes_the_access_key'),
  },
  {
    name: 'revoke: the key\'s held payments are dropped',
    file: VAULT_LIB,
    find: '        for held_id in dropped {\n            self.held.remove(&held_id);\n',
    replace: '        for held_id in dropped {\n',
    breaks:
      'What a distrusted key asked for stays in the owner\'s queue, filling it and waiting to be approved by mistake.',
    tests: unit(VAULT, 'test::owner::revoking_a_key_drops_its_held_payments_and_only_its_own'),
  },

  // -- the vault: init ------------------------------------------------------------------------
  {
    name: 'init: only the vault account or its parent',
    file: VAULT_LIB,
    find: '        if caller != vault_id && !vault_id.is_sub_account_of(&caller) {\n            Error::InitNotAllowed.panic();\n        }\n',
    replace: '',
    breaks:
      'A deploy sent without its init is claimed by the first stranger, who names itself owner of an account that may have no full-access key left to redeploy it.',
    tests: unit(VAULT, 'test::auth::only_the_vault_account_or_its_parent_may_initialize_it'),
  },
  {
    name: 'init: the vault cannot own itself',
    file: VAULT_LIB,
    find: '        if owner_id == vault_id {\n            Error::OwnerIsVault.panic();\n        }\n',
    replace: '',
    breaks:
      'Every agent key signs as the vault account, so a self-owned vault lets any agent key pass the owner check.',
    tests: unit(VAULT, 'test::auth::a_vault_cannot_own_itself'),
  },
  {
    name: 'init: the token cannot be the vault',
    file: VAULT_LIB,
    find: '        if token_id == vault_id {\n            Error::InvalidPayee.panic();\n        }\n',
    replace: '',
    breaks: 'Every payment becomes a payment to the vault itself.',
    tests: unit(VAULT, 'test::auth::the_token_cannot_be_the_vault'),
  },
  {
    name: 'init: once (#[init], not #[init(ignore_state)])',
    file: VAULT_LIB,
    find: '    #[init]\n    pub fn new(\n',
    replace: '    #[init(ignore_state)]\n    pub fn new(\n',
    breaks:
      'An initialized vault can be initialized again by the accounts new admits, which replaces the owner and the policy over the funds it holds. The check is generated into the wasm, so only the sandbox sees it.',
    tests: sandbox(
      'vault_flows',
      'init_refuses_a_vault_that_owns_itself_or_is_its_own_token',
      'a_deploy_without_its_init_cannot_be_claimed_by_a_stranger'
    ),
  },
  {
    name: 'init: unknown payees are held by default',
    file: VAULT_LIB,
    find: '            hold_unknown: true,\n',
    replace: '            hold_unknown: false,\n',
    breaks:
      'A new vault pays a payee nobody has judged (an account created minutes ago) without asking anyone, up to the caps.',
    tests: unit(VAULT, 'test::unknown::a_new_vault_holds_unknown_payees_and_only_the_owner_can_change_that'),
  },

  // -- the vault: the pay ladder (pure, src/policy.rs) -----------------------------------------
  {
    name: 'ladder: InvalidAmount (zero)',
    file: VAULT_POLICY,
    find: '    if amount == 0 {\n        return Err(Error::InvalidAmount);\n    }\n',
    replace: '',
    breaks: 'Zero payments pass every gate and fill the log with payments that move nothing.',
    tests: unit(VAULT, 'test::ladder::pay_zero_amount_is_invalid'),
  },
  {
    name: 'ladder: InvalidPayee (the vault and the token)',
    file: VAULT_POLICY,
    find: '    if payee == s.vault_id || payee == s.token_id {\n        return Err(Error::InvalidPayee);\n    }\n',
    replace: '',
    breaks:
      'A compromised agent key burns the whole day\'s cap at zero cost by paying the vault itself, every day, and the legitimate agent is denied indefinitely (finding G-1 on the siblings).',
    tests: unit(VAULT, 'test::ladder::pay_to_the_vault_or_the_token_is_invalid'),
  },
  {
    name: 'ladder: InvalidPayee, the vault half',
    file: VAULT_POLICY,
    find: '    if payee == s.vault_id || payee == s.token_id {\n',
    replace: '    if payee == s.token_id {\n',
    breaks: 'Paying the vault itself burns the day\'s cap while moving nothing.',
    tests: unit(VAULT, 'test::ladder::pay_to_the_vault_or_the_token_is_invalid'),
  },
  {
    name: 'ladder: InvalidPayee, the token half',
    file: VAULT_POLICY,
    find: '    if payee == s.vault_id || payee == s.token_id {\n',
    replace: '    if payee == s.vault_id {\n',
    breaks: 'Tokens sent to the token contract itself are lost.',
    tests: unit(VAULT, 'test::ladder::pay_to_the_vault_or_the_token_is_invalid'),
  },
  {
    name: 'ladder: memo and reason are bounded',
    file: VAULT_POLICY,
    find: '        Some(t) if t.len() > max_bytes => Err(Error::MemoTooLong),\n',
    replace: '',
    breaks:
      'An agent key writes arbitrarily long text into held payments and events, and the vault pays for the storage.',
    tests: unit(
      VAULT,
      'test::ladder::pay_memo_is_bounded_in_bytes',
      'test::ladder::request_reason_is_bounded_in_bytes'
    ),
  },
  {
    name: 'ladder: Frozen',
    file: VAULT_POLICY,
    find: '    if s.frozen {\n        return Err(Error::Frozen);\n    }\n',
    replace: '',
    breaks: 'The owner\'s panic button does nothing: a frozen vault keeps paying.',
    tests: unit(VAULT, 'test::ladder::pay_frozen_is_refused', 'test::agent::frozen_vault_refuses_the_agent'),
  },
  {
    name: 'ladder: SessionKeyExpired',
    file: VAULT_POLICY,
    find: '    if is_expired(s.key_expires_at_s, s.now_s) {\n        return Err(Error::SessionKeyExpired);\n    }\n',
    replace: '',
    breaks: 'An agent key keeps paying after the expiry its owner set.',
    tests: unit(VAULT, 'test::ladder::pay_key_expiry_is_inclusive_and_zero_means_never'),
  },
  {
    name: 'ladder: the key expiry is strictly after its second',
    file: VAULT_POLICY,
    find: '    expires_at_s != 0 && now_s > expires_at_s\n',
    replace: '    expires_at_s != 0 && now_s >= expires_at_s\n',
    breaks:
      'The expiry second itself is refused, unlike Solidity and Soroban, so the same policy means different things on different chains.',
    tests: unit(VAULT, 'test::ladder::is_expired_is_strict_and_zero_means_never'),
  },
  {
    name: 'ladder: PayeeNotAllowed',
    file: VAULT_POLICY,
    find: '    if s.allowlist_enabled && !s.payee_allowed {\n        return Err(Error::PayeeNotAllowed);\n    }\n',
    replace: '',
    breaks: 'With the allowlist on, the agent still pays anyone.',
    tests: unit(VAULT, 'test::ladder::pay_allowlist_only_applies_when_enabled'),
  },
  {
    name: 'ladder: AboveAutoApprove (the per-payment ceiling)',
    file: VAULT_POLICY,
    find: '    if s.auto_approve_max != 0 && amount > s.auto_approve_max {\n        return Err(Error::AboveAutoApprove);\n    }\n',
    replace: '',
    breaks: 'A single payment can take the whole day\'s cap at once, with no human approval.',
    tests: unit(VAULT, 'test::ladder::pay_ceiling_is_inclusive_and_zero_means_none'),
  },
  {
    name: 'ladder: MathOverflow (checked add of the day total)',
    file: VAULT_POLICY,
    find: '    spent.checked_add(amount).ok_or(Error::MathOverflow)\n',
    replace: '    Ok(spent.wrapping_add(amount))\n',
    breaks:
      'The day accumulator wraps instead of refusing, which is the other way to reset a cap.',
    tests: unit(VAULT, 'test::ladder::pay_accumulator_overflow_is_a_named_refusal_not_a_wrap'),
  },
  {
    name: 'ladder: DailyCapExceeded',
    file: VAULT_POLICY,
    find: '    if s.daily_cap != 0 && next > s.daily_cap {\n        return Err(Error::DailyCapExceeded);\n    }\n',
    replace: '',
    breaks: 'No daily cap: a leaked agent key drains the vault one ceiling-sized payment at a time.',
    tests: unit(VAULT, 'test::ladder::pay_cap_is_inclusive_and_zero_means_none'),
  },
  {
    name: 'ladder: the cap is inclusive',
    file: VAULT_POLICY,
    find: '    if s.daily_cap != 0 && next > s.daily_cap {\n',
    replace: '    if s.daily_cap != 0 && next >= s.daily_cap {\n',
    breaks:
      'The last unit of the cap can never be spent, unlike Solidity and Soroban, so the console\'s remaining figure is off by one.',
    tests: unit(VAULT, 'test::ladder::pay_cap_is_inclusive_and_zero_means_none'),
  },
  {
    name: 'ladder: order, the freeze and the expiry before the allowlist',
    file: VAULT_POLICY,
    find:
      '    check_live_session(s)?;\n\n    if s.allowlist_enabled && !s.payee_allowed {\n        return Err(Error::PayeeNotAllowed);\n    }\n',
    replace:
      '    if s.allowlist_enabled && !s.payee_allowed {\n        return Err(Error::PayeeNotAllowed);\n    }\n    check_live_session(s)?;\n',
    breaks:
      'A frozen vault answers PayeeNotAllowed for an unlisted payee, so an agent routes to the wrong recovery path, and the order no longer matches the siblings the console and the preflight API assume.',
    tests: unit(VAULT, 'test::ladder::pay_gate_order_holds_for_every_combination'),
  },
  {
    name: 'ladder: order, the ceiling before the cap',
    file: VAULT_POLICY,
    find:
      '    if s.auto_approve_max != 0 && amount > s.auto_approve_max {\n        return Err(Error::AboveAutoApprove);\n    }\n\n    let next = accumulate(s.spent_today, amount)?;\n    if s.daily_cap != 0 && next > s.daily_cap {\n        return Err(Error::DailyCapExceeded);\n    }\n',
    replace:
      '    let next = accumulate(s.spent_today, amount)?;\n    if s.daily_cap != 0 && next > s.daily_cap {\n        return Err(Error::DailyCapExceeded);\n    }\n    if s.auto_approve_max != 0 && amount > s.auto_approve_max {\n        return Err(Error::AboveAutoApprove);\n    }\n',
    breaks:
      'An above-ceiling payment late in the day answers DailyCapExceeded instead of AboveAutoApprove, so the agent waits for tomorrow instead of asking the owner (request_payment).',
    tests: unit(VAULT, 'test::ladder::pay_gate_order_holds_for_every_combination'),
  },
  {
    name: 'ladder: HeldLimitReached',
    file: VAULT_POLICY,
    find: '    if held_count >= MAX_PENDING_HELD {\n        return Err(Error::HeldLimitReached);\n    }\n',
    replace: '',
    breaks:
      'An agent key fills the owner\'s review queue without bound and locks the vault\'s NEAR in storage for each entry.',
    tests: unit(
      VAULT,
      'test::ladder::request_held_limit_is_exact',
      'test::agent::held_payments_are_bounded_and_expired_ones_make_room'
    ),
  },

  // -- the vault: the ladders as the contract runs them ----------------------------------------
  {
    name: 'contract: pay runs its ladder',
    file: VAULT_LIB,
    find: '            policy::check_agent_pay(&snapshot, &payee, amount.0, memo.as_deref())\n',
    replace: '            let _ = &snapshot;\n            Ok::<u128, Error>(amount.0)\n',
    breaks: 'The pure ladder is right and never asked: every gate passes.',
    tests: unit(VAULT, 'test::agent::every_pay_gate_refuses_through_the_contract'),
  },
  {
    name: 'contract: request_payment runs its ladder',
    file: VAULT_LIB,
    find: '        policy::check_agent_request(&snapshot, payee, amount, memo, reason)\n',
    replace: '        let _ = (&snapshot, payee, amount, memo, reason);\n        Ok(())\n',
    breaks: 'A frozen vault or an expired key can still fill the owner\'s queue.',
    tests: unit(VAULT, 'test::agent::a_request_still_respects_the_freeze_and_the_key_expiry'),
  },
  {
    name: 'contract: record_refusal runs its ladder',
    file: VAULT_LIB,
    find: '            policy::check_agent_record(&snapshot, &payee, amount.0, &reason)\n',
    replace: '            let _ = &snapshot;\n            Ok::<(), Error>(())\n',
    breaks: 'A frozen vault or an expired key can still write refusal counters.',
    tests: unit(VAULT, 'test::agent::record_refusal_is_refused_like_a_request_and_then_counts_nothing'),
  },
  {
    name: 'contract: the allowlist is read when it is on',
    file: VAULT_LIB,
    find: '            payee_allowed: self.allowlist_enabled && self.allowlist.contains(payee),\n',
    replace: '            payee_allowed: true,\n',
    breaks: 'The ladder is asked about the allowlist and told every payee is on it.',
    tests: unit(VAULT, 'test::agent::allowlist_refuses_unlisted_payees_only'),
  },

  // -- the vault: the day's budget -------------------------------------------------------------
  {
    name: 'budget: pay reserves before the registry is asked',
    file: VAULT_LIB,
    find: '                self.reserve(today, next);\n                self.route(ctx)\n',
    replace: '                self.route(ctx)\n',
    breaks:
      'Concurrent payments each pass the cap check against the same total while their registry calls are in flight, so a burst of payments in one block spends many times the cap.',
    tests: unit(VAULT, 'test::agent::the_daily_cap_counts_every_payment_in_flight'),
  },
  {
    name: 'budget: owner_pay still counts against the day',
    file: VAULT_LIB,
    find: '        self.held.remove(&held_id.0);\n        self.reserve(today, next);\n        self.route(ctx)\n',
    replace: '        self.held.remove(&held_id.0);\n        self.route(ctx)\n',
    breaks:
      'Owner-approved payments vanish from the day\'s accounting, so the vault\'s outflow is understated and the agent can spend the full cap on top of them.',
    tests: unit(VAULT, 'test::owner::owner_pay_settles_a_held_payment_outside_the_policy_but_counts_it'),
  },
  {
    name: 'budget: the stored total counts only on its own day',
    file: VAULT_POLICY,
    find: '    if stored_day == today { stored_spent } else { 0 }\n',
    replace: '    if stored_day == today { 0 } else { 0 }\n',
    breaks: 'Every payment sees an empty day, so the cap never accumulates.',
    tests: unit(
      VAULT,
      'test::ladder::spent_on_only_counts_the_stored_day',
      'test::agent::the_daily_cap_counts_every_payment_in_flight'
    ),
  },
  {
    name: 'budget: a release gives back only a reservation from today',
    file: VAULT_POLICY,
    find: '    if stored_day == reserved_day && reserved_day == today {\n',
    replace: '    if stored_day == today {\n',
    breaks:
      'A payment reserved yesterday that fails today is subtracted from today\'s total, handing the agent budget it never had: a cap bypass a key can schedule on purpose across midnight.',
    tests: unit(
      VAULT,
      'test::ladder::release_only_gives_back_a_reservation_from_today',
      'test::callbacks::a_release_on_a_later_day_leaves_that_day_alone',
      'test::callbacks::a_failed_transfer_reported_on_a_later_day_leaves_that_day_alone'
    ),
  },
  {
    name: 'budget: a request reserved nothing, so it releases nothing',
    file: VAULT_LIB,
    find: '        if ctx.mode == PayMode::Request {\n            return;\n        }\n',
    replace: '',
    breaks:
      'A request the registry refuses gives back budget it never took: an agent at its cap asks for a large payment to a DENY payee (or while the registry is down) and spends again.',
    tests: unit(VAULT, 'test::callbacks::a_refused_request_gives_back_no_budget'),
  },
  {
    name: 'budget: a failed transfer gives its reservation back',
    file: VAULT_LIB,
    find: '    fn transfer_failed(&mut self, ctx: &PaymentCtx) -> PayOutcome {\n        self.release(ctx);\n',
    replace: '    fn transfer_failed(&mut self, ctx: &PaymentCtx) -> PayOutcome {\n',
    breaks:
      'An underfunded vault or a paused token eats the day\'s budget for payments that never moved.',
    tests: unit(VAULT, 'test::callbacks::a_failed_transfer_releases_and_reports'),
  },

  // -- the vault: the registry ----------------------------------------------------------------
  {
    name: 'registry: pay asks before it transfers',
    file: VAULT_LIB,
    find: '                self.reserve(today, next);\n                self.route(ctx)\n',
    replace: '                self.reserve(today, next);\n                self.transfer(ctx)\n',
    breaks: 'The registry is never consulted, so a DENY payee is paid.',
    tests: unit(VAULT, 'test::agent::with_a_registry_pay_reserves_then_asks_for_the_verdict'),
  },
  {
    name: 'registry: it is asked about the payee',
    file: VAULT_LIB,
    find: '                    .get_verdict(ctx.payee.clone())\n',
    replace: '                    .get_verdict(env::current_account_id())\n',
    breaks:
      'The registry is asked about the vault instead of the payee, answers that it has no verdict, and a flagged payee the vault already knows is paid.',
    tests: unit(VAULT, 'test::agent::with_a_registry_pay_reserves_then_asks_for_the_verdict'),
  },
  {
    name: 'registry: DENY is refused on chain',
    file: VAULT_LIB,
    find:
      '            Answer::Deny { reasons } => {\n                self.release(&ctx);\n                self.count_refusal(&ctx.payee);\n                refused_settlement(\n                    &ctx,\n                    Error::RegistryDeny.as_str(),\n                    RefusalSource::Registry,\n                    &reasons,\n                )\n            }\n',
    replace: '            Answer::Deny { .. } => return self.transfer(ctx),\n',
    breaks: 'A payee the registry flagged is paid.',
    tests: unit(VAULT, 'test::callbacks::pay_deny_releases_counts_and_refuses_on_chain'),
  },
  {
    name: 'registry: "DENY" is read as DENY',
    file: VAULT_VERDICT,
    find: '                "DENY" => Answer::Deny {\n                    reasons: reason_codes(map.get("reasons")),\n                },\n',
    replace: '                "DENY" => Answer::Allow,\n',
    breaks: 'The registry says DENY and the vault hears ALLOW.',
    tests: unit(VAULT, 'test::verdict::the_three_verdicts'),
  },
  {
    name: 'registry: "WARN" is read as WARN',
    file: VAULT_VERDICT,
    find: '                "WARN" => Answer::Warn,\n',
    replace: '                "WARN" => Answer::Allow,\n',
    breaks: 'A payee the registry warned about is paid without the owner seeing it.',
    tests: unit(VAULT, 'test::verdict::the_three_verdicts'),
  },
  {
    name: 'registry: WARN holds an agent payment for the owner',
    file: VAULT_LIB,
    find:
      '                PayMode::Pay => {\n                    self.release(&ctx);\n                    self.hold(&ctx, REASON_REGISTRY_WARN, HoldKind::RegistryWarn)\n                }\n',
    replace: '                PayMode::Pay => return self.transfer(ctx),\n',
    breaks: 'A payee the registry warned about is paid without the owner seeing it.',
    tests: unit(VAULT, 'test::callbacks::pay_warn_releases_and_holds_for_the_owner'),
  },
  {
    name: 'registry: a warned request is recorded as WARN, whatever the agent says',
    file: VAULT_LIB,
    find:
      '                PayMode::Request => {\n                    let reason = ctx.reason.clone().unwrap_or_default();\n                    self.hold(&ctx, &reason, HoldKind::RegistryWarn)\n                }\n',
    replace:
      '                PayMode::Request => {\n                    let reason = ctx.reason.clone().unwrap_or_default();\n                    self.hold(&ctx, &reason, HoldKind::AgentRequest)\n                }\n',
    breaks:
      'A prompt-injected agent asks for a payee the registry warned about, and the owner\'s one tap sees an ordinary request: only the agent\'s own words say what the registry said.',
    tests: unit(
      VAULT,
      'test::callbacks::an_agent_cannot_relabel_a_registry_warn_as_an_unknown_payee',
      'test::callbacks::request_warn_allow_and_no_verdict_are_all_held_with_the_agents_reason'
    ),
  },
  {
    name: 'unknown payee: a request about one is recorded as unknown',
    file: VAULT_LIB,
    find: '                    let kind = if silent && !self.is_known(&ctx.payee) {\n',
    replace: '                    let kind = if false && silent && !self.is_known(&ctx.payee) {\n',
    breaks:
      'A request to pay a payee nobody has judged reaches the owner as an ordinary request, so the one human tap is made without knowing the payee is new.',
    tests: unit(VAULT, 'test::unknown::a_request_is_held_with_the_agents_own_reason_known_or_not'),
  },
  {
    name: 'registry: owner_pay still asks, so a later DENY stands',
    file: VAULT_LIB,
    find: '        self.held.remove(&held_id.0);\n        self.reserve(today, next);\n        self.route(ctx)\n',
    replace: '        self.held.remove(&held_id.0);\n        self.reserve(today, next);\n        self.transfer(ctx)\n',
    breaks:
      'A payment held yesterday is paid today although the registry has since flagged the payee: the owner approves what it saw then, not what is true now.',
    tests: unit(VAULT, 'test::owner::owner_pay_still_asks_the_registry'),
  },

  // -- the vault: an unreadable registry fails closed ------------------------------------------
  {
    name: 'fail closed: a failed registry call',
    file: VAULT_LIB,
    find: '            Err(_) => Answer::Unusable,\n        };\n        self.after_verdict(ctx, answer)\n',
    replace: '            Err(_) => Answer::Allow,\n        };\n        self.after_verdict(ctx, answer)\n',
    breaks:
      'A registry that is down, out of gas, or made to fail on purpose reads as ALLOW, so a flagged payee is paid whenever the registry cannot answer.',
    tests: unit(VAULT, 'test::callbacks::pay_fails_closed_on_every_unusable_answer'),
  },
  {
    name: 'fail closed: an unusable answer is refused',
    file: VAULT_LIB,
    find:
      '            Answer::Unusable => {\n                self.release(&ctx);\n                refused_settlement(\n                    &ctx,\n                    Error::RegistryUnavailable.as_str(),\n                    RefusalSource::Registry,\n                    &[],\n                )\n            }\n',
    replace: '            Answer::Unusable => return self.transfer(ctx),\n',
    breaks: 'Every answer the vault cannot read is paid through.',
    tests: unit(VAULT, 'test::callbacks::pay_fails_closed_on_every_unusable_answer'),
  },
  {
    name: 'fail closed: bytes that are not JSON',
    file: VAULT_VERDICT,
    find: '        Err(_) => return Answer::Unusable,\n',
    replace: '        Err(_) => return Answer::Allow,\n',
    breaks: 'A registry reply that does not parse reads as ALLOW.',
    tests: unit(VAULT, 'test::verdict::anything_else_fails_closed', 'test::verdict::invalid_utf8_fails_closed'),
  },
  {
    name: 'fail closed: a verdict string the vault does not know',
    file: VAULT_VERDICT,
    find: '                },\n                _ => Answer::Unusable,\n            },\n',
    replace: '                },\n                _ => Answer::Allow,\n            },\n',
    breaks: 'A lower-case "deny", or any new word a registry adds, reads as ALLOW.',
    tests: unit(VAULT, 'test::verdict::anything_else_fails_closed'),
  },
  {
    name: 'fail closed: JSON that is not null or an object with a verdict',
    file: VAULT_VERDICT,
    find: '            _ => Answer::Unusable,\n        },\n        _ => Answer::Unusable,\n',
    replace: '            _ => Answer::Allow,\n        },\n        _ => Answer::Allow,\n',
    breaks: 'An object without a verdict, a number or a list reads as ALLOW.',
    tests: unit(VAULT, 'test::verdict::anything_else_fails_closed'),
  },
  {
    name: 'never abort: a failed registry call is an answer, not a panic',
    file: VAULT_LIB,
    find: '            Err(_) => Answer::Unusable,\n        };\n        self.after_verdict(ctx, answer)\n',
    replace: '            Err(_) => env::panic_str("RegistryUnavailable"),\n        };\n        self.after_verdict(ctx, answer)\n',
    breaks:
      'on_verdict aborts when the registry fails. The reservation pay made is never released and nothing is logged, so a registry that fails on purpose strands the agent\'s budget for the rest of the day.',
    tests: unit(VAULT, 'test::callbacks::pay_fails_closed_on_every_unusable_answer'),
  },
  {
    name: 'never abort: malformed registry bytes are an answer, not a panic',
    file: VAULT_VERDICT,
    find: '    let value: Value = match serde_json::from_slice(bytes) {\n        Ok(v) => v,\n        Err(_) => return Answer::Unusable,\n    };\n',
    replace: '    let value: Value = serde_json::from_slice(bytes).unwrap();\n',
    breaks: 'Any reply that does not parse aborts on_verdict, with the same stranded reservation and no event.',
    tests: unit(VAULT, 'test::verdict::random_bytes_never_abort', 'test::verdict::anything_else_fails_closed'),
  },
  {
    name: 'never abort: a failed transfer is reported, not a panic',
    file: VAULT_LIB,
    find: '        if !promise_succeeded() {\n            self.forget_unpaid(&ctx.payee);\n            return self.transfer_failed(&ctx);\n        }\n',
    replace: '        if !promise_succeeded() {\n            env::panic_str("TransferFailed");\n        }\n',
    breaks:
      'on_transfer aborts when the token fails, so the reservation is never released and payment_failed is never logged: an underfunded vault or a paused token silently eats the day\'s budget.',
    tests: unit(VAULT, 'test::callbacks::a_failed_transfer_releases_and_reports'),
  },
  {
    name: 'fail closed: a reply longer than MAX_ANSWER_BYTES is not read',
    file: VAULT_VERDICT,
    find: '    if bytes.len() > MAX_ANSWER_BYTES {\n        return Answer::Unusable;\n    }\n',
    replace: '',
    breaks:
      'read_answer parses a reply of any length, paying gas per byte for bytes the vault does not control. In the contract the promise read is bounded as well, so this is the second of two bounds: the one any other caller of read_answer relies on.',
    tests: unit(VAULT, 'test::verdict::a_reply_longer_than_the_bound_is_not_read'),
  },

  // -- the vault: payees nobody has judged (amendment A1) ---------------------------------------
  {
    name: 'unknown payee: held, not paid',
    file: VAULT_LIB,
    find:
      '            Answer::NoVerdict if ctx.mode == PayMode::Pay && self.is_unknown(&ctx.payee) => {\n                self.release(&ctx);\n                self.hold(&ctx, REASON_UNKNOWN_PAYEE, HoldKind::UnknownPayee)\n            }\n',
    replace: '',
    breaks:
      'A prompt-injected agent pays an account created minutes ago, which no registry has seen yet, up to the caps.',
    tests: unit(
      VAULT,
      'test::unknown::without_a_registry_a_pay_to_an_unknown_payee_is_held_and_moves_nothing',
      'test::unknown::with_a_registry_silence_about_an_unknown_payee_holds_it'
    ),
  },
  {
    name: 'unknown payee: known means paid at least once, not an entry',
    file: VAULT_LIB,
    find: '        self.allowlist.contains(payee) || self.paid_count.get(payee).copied().unwrap_or(0) > 0\n',
    replace: '        self.allowlist.contains(payee) || self.paid_count.contains_key(payee)\n',
    breaks:
      'The zero entry the transfer path writes before the token moves makes a payee known, so while a first payment is still in flight (or after its registry verdict is cleared) a second one goes out without the owner.',
    tests: unit(
      VAULT,
      'test::unknown::a_payee_whose_first_payment_is_in_flight_is_not_yet_known',
      'test::unknown::a_listed_payee_is_known_whether_or_not_the_allowlist_gate_is_on'
    ),
  },

  // -- the vault: re-checks while the registry answers -----------------------------------------
  {
    name: 'in flight: the freeze is checked again before money moves',
    file: VAULT_LIB,
    find: '        if self.frozen {\n            return Some(Error::Frozen);\n        }\n',
    replace: '',
    breaks: 'A payment started a block before the freeze still settles after it.',
    tests: unit(VAULT, 'test::callbacks::a_freeze_while_the_registry_answers_stops_the_payment'),
  },
  {
    name: 'in flight: the key expiry is checked again',
    file: VAULT_LIB,
    find:
      '        if policy::is_expired(key.expires_at_s, policy::seconds(env::block_timestamp())) {\n            return Some(Error::SessionKeyExpired);\n        }\n',
    replace: '',
    breaks: 'A payment started a second before the key expired settles after it.',
    tests: unit(VAULT, 'test::callbacks::an_expiry_passing_while_the_registry_answers_stops_the_payment'),
  },
  {
    name: 'in flight: a revocation is checked again',
    file: VAULT_LIB,
    find: '            Some(key) if !key.revoked => key,\n',
    replace: '            Some(key) => key,\n',
    breaks: 'A payment started a block before the owner revoked the key still settles.',
    tests: unit(VAULT, 'test::callbacks::a_revocation_while_the_registry_answers_stops_the_payment'),
  },
  {
    name: 'in flight: a revoked key\'s payment is not held',
    file: VAULT_LIB,
    find:
      '        if !self.key_is_live(&ctx.agent_pk) {\n            return refused(ctx, Error::NotAgent.as_str(), RefusalSource::Policy, &[]);\n        }\n',
    replace: '',
    breaks:
      'A request from a key the owner just revoked arrives in the queue after revoke cleared it, waiting to be approved by mistake.',
    tests: unit(VAULT, 'test::callbacks::a_request_in_flight_when_its_key_is_revoked_is_refused_not_held'),
  },
  {
    name: 'freeze: freeze() sets the flag',
    file: VAULT_LIB,
    find: '        self.frozen = true;\n        VaultEvent::FrozenSet { frozen: true }.emit();\n',
    replace: '        VaultEvent::FrozenSet { frozen: true }.emit();\n',
    breaks: 'The panic button announces a freeze and freezes nothing.',
    tests: unit(VAULT, 'test::auth::freeze_needs_no_yocto_and_unfreeze_does'),
  },
  {
    name: 'held: an expired hold cannot be settled',
    file: VAULT_LIB,
    find: '        if policy::is_expired(held.expires_at_s, policy::seconds(now_ns)) {\n',
    replace: '        if false && policy::is_expired(held.expires_at_s, policy::seconds(now_ns)) {\n',
    breaks: 'A request forgotten for days is still payable by one stray tap.',
    tests: unit(VAULT, 'test::owner::owner_pay_on_an_expired_entry_removes_it_and_says_so'),
  },

  // -- the vault: what an agent key can make the vault store -----------------------------------
  {
    name: 'record_refusal: the guard counters are bounded (pure rung)',
    file: VAULT_POLICY,
    find: '    if !has_counter && guard_payees >= max {\n        return Err(Error::GuardRefusalLimitReached);\n    }\n',
    replace: '',
    breaks:
      'A leaked agent key locks the vault\'s NEAR in storage by recording refusals against payee names it makes up, one new counter each.',
    tests: unit(
      VAULT,
      'test::ladder::record_guard_capacity_bounds_new_counters_only',
      'test::counters::guard_counters_stop_at_the_bound_and_a_refused_record_writes_nothing'
    ),
  },
  {
    name: 'record_refusal: the bound is checked before a new counter',
    file: VAULT_LIB,
    find: '        policy::check_guard_capacity(false, self.guard_payees, MAX_GUARD_PAYEES)?;\n',
    replace: '',
    breaks: 'The pure rung is right and never asked: the counters are unbounded again.',
    tests: unit(VAULT, 'test::counters::guard_counters_stop_at_the_bound_and_a_refused_record_writes_nothing'),
  },
  {
    name: 'record_refusal: a new counter is counted toward the bound',
    file: VAULT_LIB,
    find: '        self.guard_payees = self.guard_payees.saturating_add(1);\n',
    replace: '',
    breaks: 'The bound is checked against a number that never grows, so it never binds.',
    tests: unit(VAULT, 'test::counters::guard_counters_stop_at_the_bound_and_a_refused_record_writes_nothing'),
  },
  {
    name: 'record_refusal: a new counter needs NEAR to cover it',
    file: VAULT_LIB,
    find: '        if !can_store() {\n            return Err(Error::StorageNotCovered);\n        }\n',
    replace: '',
    breaks:
      'A record the vault cannot pay storage for fails at the end of its receipt with no event, instead of a named refusal.',
    tests: unit(VAULT, 'test::counters::a_new_counter_or_hold_the_vault_cannot_cover_is_refused_not_written'),
  },
  {
    name: 'record_refusal: the agent\'s word stays out of refusal_count (A2)',
    file: VAULT_LIB,
    find: '        match verdict.and_then(|()| self.count_guard_refusal(&ctx.payee)) {\n',
    replace: '        match verdict.map(|()| self.count_refusal(&ctx.payee)) {\n',
    breaks:
      'Any agent key, a prompt-injected one included, writes the cross-vault reputation signal about any payee it names.',
    tests: unit(VAULT, 'test::agent::record_refusal_counts_in_the_guard_counter_and_moves_nothing'),
  },
  {
    name: 'registry DENY counters are bounded',
    file: VAULT_LIB,
    find: '        if self.refusal_payees >= MAX_REFUSAL_PAYEES || !can_store() {\n            return;\n        }\n',
    replace: '',
    breaks:
      'A leaked key that names DENY payees one after another grows the refusal map without bound, and a counter the vault cannot pay for fails on_verdict at its end, stranding the day\'s reservation.',
    tests: unit(VAULT, 'test::counters::a_deny_past_the_refusal_bound_is_refused_all_the_same_and_not_counted'),
  },
  {
    name: 'held: a hold needs NEAR to cover it',
    file: VAULT_LIB,
    find: '        if !can_store() {\n            return refused(\n',
    replace: '        if false {\n            return refused(\n',
    breaks:
      'A hold the vault cannot pay storage for fails on_verdict at its end, with no event, and strands the day\'s reservation.',
    tests: unit(VAULT, 'test::counters::a_new_counter_or_hold_the_vault_cannot_cover_is_refused_not_written'),
  },
  {
    name: 'storage: liquid NEAR is the balance minus the storage stake',
    file: VAULT_LIB,
    find:
      '    let locked = env::storage_byte_cost()\n        .as_yoctonear()\n        .saturating_mul(u128::from(env::storage_usage()));\n    env::account_balance().as_yoctonear().saturating_sub(locked)\n',
    replace: '    env::account_balance().as_yoctonear()\n',
    breaks:
      'NEAR the account already has locked for its storage counts as free, so every can_store and can_fund check passes on a vault that cannot cover one more byte: holds, counters and deposits are written anyway, and the receipt fails at its end with no event.',
    tests: unit(VAULT, 'test::counters::a_new_counter_or_hold_the_vault_cannot_cover_is_refused_not_written'),
  },

  // -- the vault: what the owner forgets -------------------------------------------------------
  {
    name: 'forget_guard_refusals: a removed counter frees its slot',
    file: VAULT_LIB,
    find:
      '            if let Some(count) = self.guard_refusals.remove(&payee) {\n                self.guard_payees = self.guard_payees.saturating_sub(1);\n',
    replace: '            if let Some(count) = self.guard_refusals.remove(&payee) {\n',
    breaks:
      'Forgetting a counter removes it but keeps its slot taken, so once MAX_GUARD_PAYEES payees ever had a counter, the agent can never record a refusal against a new payee again, however many the owner forgets.',
    tests: unit(VAULT, 'test::counters::the_owner_forgets_guard_counters_and_frees_exactly_their_slots'),
  },
  {
    name: 'forget_refusals: a removed counter frees its slot',
    file: VAULT_LIB,
    find:
      '            if let Some(count) = self.refusals.remove(&payee) {\n                self.refusal_payees = self.refusal_payees.saturating_sub(1);\n',
    replace: '            if let Some(count) = self.refusals.remove(&payee) {\n',
    breaks:
      'Forgetting a registry refusal counter never gives its slot back, so once MAX_REFUSAL_PAYEES DENY\'d payees were ever counted, no new DENY is counted again, however many the owner forgets.',
    tests: unit(VAULT, 'test::counters::a_deny_past_the_refusal_bound_is_refused_all_the_same_and_not_counted'),
  },
  {
    name: 'forget_guard_refusals: at most MAX_FORGET_BATCH payees a call',
    file: VAULT_LIB,
    find:
      '    pub fn forget_guard_refusals(&mut self, payees: Vec<AccountId>) {\n        self.assert_owner_one_yocto();\n        if payees.len() > MAX_FORGET_BATCH {\n            Error::BatchTooLarge.panic();\n        }\n',
    replace: '    pub fn forget_guard_refusals(&mut self, payees: Vec<AccountId>) {\n        self.assert_owner_one_yocto();\n',
    breaks:
      'A call naming a full map of 64-byte payees logs past the 16384 bytes a receipt may log and aborts in the runtime (TotalLogLengthExceeded) after the owner paid for it, instead of being refused by name.',
    tests: unit(VAULT, 'test::counters::forget_guard_refusals_takes_a_batch_of_50_and_two_calls_clear_a_full_map'),
  },
  {
    name: 'forget_refusals: at most MAX_FORGET_BATCH payees a call',
    file: VAULT_LIB,
    find:
      '    pub fn forget_refusals(&mut self, payees: Vec<AccountId>) {\n        self.assert_owner_one_yocto();\n        if payees.len() > MAX_FORGET_BATCH {\n            Error::BatchTooLarge.panic();\n        }\n',
    replace: '    pub fn forget_refusals(&mut self, payees: Vec<AccountId>) {\n        self.assert_owner_one_yocto();\n',
    breaks:
      'A call naming a full map of 64-byte payees logs past the 16384 bytes a receipt may log and aborts in the runtime (TotalLogLengthExceeded) after the owner paid for it, instead of being refused by name.',
    tests: unit(VAULT, 'test::counters::forget_refusals_takes_a_batch_of_50_and_two_calls_clear_a_full_map'),
  },
  {
    name: 'forget: MAX_FORGET_BATCH fits a receipt\'s log budget',
    file: VAULT_LIB,
    find: 'pub const MAX_FORGET_BATCH: usize = 50;\n',
    replace: 'pub const MAX_FORGET_BATCH: usize = 100;\n',
    breaks:
      'The bound admits a call whose longest lines do not fit the 16384 bytes a receipt may log, so a call within it can still abort in the runtime, and the name the refusal promises is never reached.',
    tests: unit(
      VAULT,
      'test::counters::forget_guard_refusals_takes_a_batch_of_50_and_two_calls_clear_a_full_map',
      'test::counters::forget_refusals_takes_a_batch_of_50_and_two_calls_clear_a_full_map'
    ),
  },

  // -- the vault: a payee's paid_count entry ---------------------------------------------------
  {
    name: 'transfer: the paid_count entry is written before the token moves',
    file: VAULT_LIB,
    find: '        if !self.paid_count.contains_key(&ctx.payee) {\n            self.paid_count.insert(ctx.payee.clone(), 0);\n        }\n',
    replace: '',
    breaks:
      'A new payee\'s entry is first written in on_transfer, after the token has moved the money, where storage the vault cannot cover fails the receipt: tokens gone, no payment_sent, and the agent told the payment failed.',
    tests: unit(VAULT, 'test::callbacks::on_transfer_adds_no_storage_after_the_token_moved'),
  },
  {
    name: 'transfer: a failed transfer removes only a 0 entry',
    file: VAULT_LIB,
    find: '        if self.paid_count.get(payee) == Some(&0) {\n            self.paid_count.remove(payee);\n        }\n',
    replace: '        self.paid_count.remove(payee);\n',
    breaks:
      'One failed transfer erases a payee\'s history of landed payments, so a payee the vault has paid many times becomes unknown again and its next payment waits for the owner.',
    tests: unit(VAULT, 'test::callbacks::a_failed_transfer_never_removes_a_count_that_landed'),
  },
  {
    name: 'transfer: a landing writes a new entry only when the vault can store it',
    file: VAULT_LIB,
    find: '        } else if can_store() {\n            self.paid_count.insert(payee.clone(), 1);\n',
    replace: '        } else {\n            self.paid_count.insert(payee.clone(), 1);\n',
    breaks:
      'on_transfer writes storage the vault cannot cover after the money moved, and the receipt fails at its end: the payment went out with no payment_sent and no count.',
    tests: unit(VAULT, 'test::callbacks::a_landing_after_a_failed_one_counts_when_it_can_and_never_aborts'),
  },
  {
    name: 'allowlist: at most MAX_ALLOWLIST payees',
    file: VAULT_LIB,
    find:
      '            if !self.allowlist.contains(&payee) && self.allowlist.len() >= MAX_ALLOWLIST {\n                Error::AllowlistFull.panic();\n            }\n',
    replace: '',
    breaks: 'list_allowlist and the vault\'s storage grow without bound.',
    tests: unit(VAULT, 'test::owner::allowlist_add_remove_and_bound'),
  },

  // -- the vault: tokens -----------------------------------------------------------------------
  {
    name: 'deposits: a foreign token is refunded',
    file: VAULT_LIB,
    find: '        if env::predecessor_account_id() != self.token_id {\n            return PromiseOrValue::Value(amount);\n        }\n',
    replace: '',
    breaks:
      'Any contract can call ft_on_transfer and log a deposit that never happened, and a foreign token\'s deposit is kept where no policy governs it.',
    tests: unit(VAULT, 'test::owner::a_foreign_token_is_refunded_in_full_and_silently'),
  },
  {
    name: 'transfer: a success with a reply body is a success',
    file: VAULT_LIB,
    find: '        Err(PromiseError::Failed) => false,\n        Err(_) => true,\n',
    replace: '        Err(PromiseError::Failed) => false,\n        Err(_) => false,\n',
    breaks:
      'A token that answers ft_transfer with a body has moved the money, and the vault would release the reservation as if it had not: a cap bypass, and a payment logged as failed.',
    tests: unit(
      VAULT,
      'test::callbacks::a_successful_call_with_a_reply_body_is_still_a_success',
      'test::callbacks::a_transfer_reply_body_never_matters'
    ),
  },

  // -- the registry ----------------------------------------------------------------------------
  {
    name: 'registry: oracle-only writes',
    file: REGISTRY_LIB,
    find: '        if !self.oracles.contains(&caller) {\n            Error::NotOracle.panic();\n        }\n',
    replace: '',
    breaks: 'Anyone writes ALLOW for itself, or clears the DENY on its own account, and every vault pays it.',
    tests: unit(
      REGISTRY,
      'tests::verdicts::a_stranger_cannot_write',
      'tests::batch::only_an_oracle_can_write_a_batch',
      'tests::verdicts::only_an_oracle_can_clear_a_verdict',
      'tests::reports::only_an_oracle_can_clear_reports'
    ),
  },
  {
    name: 'registry: set_verdict asks for an oracle',
    file: REGISTRY_LIB,
    find: '        let by = self.require_oracle();\n        let entry = VerdictInput {\n',
    replace: '        let by = env::predecessor_account_id();\n        let entry = VerdictInput {\n',
    breaks: 'Anyone writes a verdict, one account at a time.',
    tests: unit(REGISTRY, 'tests::verdicts::a_stranger_cannot_write'),
  },
  {
    name: 'registry: set_verdicts asks for an oracle',
    file: REGISTRY_LIB,
    find: '        let by = self.require_oracle();\n        if entries.len() > MAX_BATCH {\n',
    replace: '        let by = env::predecessor_account_id();\n        if entries.len() > MAX_BATCH {\n',
    breaks: 'Anyone writes twenty verdicts at a time.',
    tests: unit(REGISTRY, 'tests::batch::only_an_oracle_can_write_a_batch'),
  },
  {
    name: 'registry: clear_verdict asks for an oracle',
    file: REGISTRY_LIB,
    find: '        let by = self.require_oracle();\n        if self.verdicts.remove(&account_id).is_some() {\n',
    replace: '        let by = env::predecessor_account_id();\n        if self.verdicts.remove(&account_id).is_some() {\n',
    breaks: 'A flagged account clears its own DENY and reads as unjudged.',
    tests: unit(REGISTRY, 'tests::verdicts::only_an_oracle_can_clear_a_verdict'),
  },
  {
    name: 'registry: clear_reports asks for an oracle',
    file: REGISTRY_LIB,
    find: '        let by = self.require_oracle();\n        if self.reports.remove(&account_id).is_some() {\n',
    replace: '        let by = env::predecessor_account_id();\n        if self.reports.remove(&account_id).is_some() {\n',
    breaks: 'A reported account wipes the reports against it before any oracle reads them.',
    tests: unit(REGISTRY, 'tests::reports::only_an_oracle_can_clear_reports'),
  },
  {
    name: 'registry: the owner check',
    file: REGISTRY_LIB,
    find: '        if env::predecessor_account_id() != self.owner_id {\n            Error::NotOwner.panic();\n        }\n',
    replace: '',
    breaks: 'Anyone names itself an oracle, or takes the owner role, and then writes any verdict.',
    tests: unit(REGISTRY, 'tests::admin::every_owner_method_refuses_a_caller_that_is_not_the_owner'),
  },
  {
    name: 'registry: one yoctoNEAR',
    file: REGISTRY_LIB,
    find: '        if env::attached_deposit() != NearToken::from_yoctonear(1) {\n            Error::RequiresOneYocto.panic();\n        }\n',
    replace: '',
    breaks: 'A function-call key of the owner (a console session) can add oracles or hand the owner role away.',
    tests: unit(REGISTRY, 'tests::admin::every_owner_method_requires_exactly_one_yocto'),
  },
  {
    name: 'registry: exactly one yoctoNEAR, not at least one',
    file: REGISTRY_LIB,
    find: '        if env::attached_deposit() != NearToken::from_yoctonear(1) {\n',
    replace: '        if env::attached_deposit() < NearToken::from_yoctonear(1) {\n',
    breaks: 'An owner method keeps whatever is attached.',
    tests: unit(REGISTRY, 'tests::admin::every_owner_method_requires_exactly_one_yocto'),
  },
  {
    name: 'registry init: only the registry account or its parent',
    file: REGISTRY_LIB,
    find: '        if caller != registry_id && !registry_id.is_sub_account_of(&caller) {\n            Error::InitNotAllowed.panic();\n        }\n',
    replace: '',
    breaks:
      'A deploy sent without its init is claimed by the first stranger, who names itself owner and oracle and writes ALLOW for whoever it likes.',
    tests: unit(REGISTRY, 'tests::init::only_the_registry_account_or_its_parent_may_initialize_it'),
  },
  {
    name: 'registry init: once (#[init], not #[init(ignore_state)])',
    file: REGISTRY_LIB,
    find: '    #[init]\n    pub fn new(owner_id: AccountId, oracles: Vec<AccountId>) -> Self {\n',
    replace: '    #[init(ignore_state)]\n    pub fn new(owner_id: AccountId, oracles: Vec<AccountId>) -> Self {\n',
    breaks:
      'The registry account (or its parent) can initialize it again with a new owner and oracle set, on top of the verdicts every vault reads. The check is generated into the wasm, so only the sandbox sees it.',
    tests: sandbox('vault_flows', 'a_deploy_without_its_init_cannot_be_claimed_by_a_stranger'),
  },
  {
    name: 'registry: initial oracles are bounded',
    file: REGISTRY_LIB,
    find: '            if set.len() > MAX_ORACLES {\n                Error::OracleLimitReached.panic();\n            }\n',
    replace: '',
    breaks: 'An unbounded oracle set at init: more keys that can write any verdict, and a view that grows without bound.',
    tests: unit(REGISTRY, 'tests::init::new_refuses_one_oracle_over_the_limit'),
  },
  {
    name: 'registry: add_oracle is bounded',
    file: REGISTRY_LIB,
    find: '        if self.oracles.len() >= MAX_ORACLES {\n            Error::OracleLimitReached.panic();\n        }\n',
    replace: '',
    breaks: 'The oracle set grows past the size an owner can audit by eye.',
    tests: unit(REGISTRY, 'tests::admin::the_oracle_set_stops_at_its_limit'),
  },
  {
    name: 'registry: an expired verdict reads as none',
    file: REGISTRY_LIB,
    find: '        if !rules::is_live(record.expires_at_ns, env::block_timestamp()) {\n            return None;\n        }\n',
    replace: '',
    breaks: 'An ALLOW the oracle meant to lapse keeps paying the payee after its deadline.',
    tests: unit(REGISTRY, 'tests::expiry::a_verdict_is_live_through_its_deadline_and_gone_one_nanosecond_after'),
  },
  {
    name: 'registry: a zero TTL means no expiry',
    file: REGISTRY_RULES,
    find: '        None | Some(0) => Ok(None),\n',
    replace: '        None => Ok(None),\n',
    breaks:
      'A client that sends 0 for "no TTL" writes a DENY that has already expired, and every vault pays the payee.',
    tests: unit(REGISTRY, 'tests::expiry::a_zero_ttl_means_no_expiry_not_already_expired'),
  },
  {
    name: 'registry: a TTL deadline is checked, never wrapped',
    file: REGISTRY_RULES,
    find:
      '        Some(ttl_s) => ttl_s\n            .checked_mul(NS_PER_S)\n            .and_then(|ttl_ns| now_ns.checked_add(ttl_ns))\n            .map(Some)\n            .ok_or(Error::MathOverflow),\n',
    replace: '        Some(ttl_s) => Ok(Some(now_ns.wrapping_add(ttl_s.wrapping_mul(NS_PER_S)))),\n',
    breaks: 'A huge TTL wraps into the past, and a DENY written with it expires the moment it is written.',
    tests: unit(
      REGISTRY,
      'tests::expiry::a_ttl_whose_nanoseconds_overflow_is_refused',
      'tests::expiry::a_deadline_past_the_end_of_time_is_refused_not_wrapped'
    ),
  },
  {
    name: 'registry: reason codes are [a-z0-9_], 1 to 32 bytes',
    file: REGISTRY_RULES,
    find: '    if code.is_empty() || code.len() > MAX_CODE_LEN || !charset {\n        return Err(Error::InvalidReason);\n    }\n',
    replace: '',
    breaks: 'Look-alike or oversized codes reach the vault\'s refusal events and the console.',
    tests: unit(REGISTRY, 'tests::verdicts::every_malformed_reason_code_is_refused'),
  },
  {
    name: 'registry: at most MAX_REASONS codes',
    file: REGISTRY_RULES,
    find: '    if reasons.len() > MAX_REASONS {\n        return Err(Error::TooManyReasons);\n    }\n',
    replace: '',
    breaks: 'A verdict of any size, which the vault reads (and pays gas for) before every payment.',
    tests: unit(REGISTRY, 'tests::verdicts::eight_reasons_are_accepted_and_nine_refused'),
  },
  {
    name: 'registry: evidence is bounded',
    file: REGISTRY_RULES,
    find: '    if evidence.len() > MAX_EVIDENCE_LEN {\n        return Err(Error::EvidenceTooLong);\n    }\n',
    replace: '',
    breaks: 'Verdicts and reports of any size, paid for by the registry account.',
    tests: unit(
      REGISTRY,
      'tests::verdicts::evidence_of_256_bytes_is_accepted_and_257_refused',
      'tests::reports::evidence_of_256_bytes_is_accepted_and_257_refused'
    ),
  },
  {
    name: 'registry: the score is 0 to 1000',
    file: REGISTRY_RULES,
    find: '        Some(score) if score > MAX_SCORE => Err(Error::ScoreOutOfRange),\n',
    replace: '',
    breaks: 'Scores off the engine\'s scale reach every reader.',
    tests: unit(REGISTRY, 'tests::verdicts::scores_from_0_to_1000_are_accepted_and_1001_refused'),
  },
  {
    name: 'registry: the code hash is bounded',
    file: REGISTRY_RULES,
    find: '        Some(hash) if hash.len() > MAX_CODE_HASH_LEN => Err(Error::CodeHashTooLong),\n',
    replace: '',
    breaks: 'A code hash field of any size, in every verdict the vault reads.',
    tests: unit(REGISTRY, 'tests::verdicts::a_code_hash_of_64_bytes_is_accepted_and_65_refused'),
  },
  {
    name: 'registry: at most MAX_BATCH entries',
    file: REGISTRY_LIB,
    find: '        if entries.len() > MAX_BATCH {\n            Error::BatchTooLarge.panic();\n        }\n',
    replace: '',
    breaks:
      'One call writes as many verdicts as its gas allows, so the batch an operator reviews is no longer the size the docs promise, and only the log budget still bounds it.',
    tests: unit(REGISTRY, 'tests::batch::one_entry_over_the_bound_is_refused'),
  },
  {
    name: 'registry report: the deposit',
    file: REGISTRY_RULES,
    find: '    if deposit < REPORT_DEPOSIT {\n        return Err(Error::ReportDepositTooLow);\n    }\n',
    replace: '',
    breaks: 'Reports are free: anyone fills a reviewer\'s queue, and the registry pays the storage.',
    tests: unit(
      REGISTRY,
      'tests::reports::a_report_below_the_deposit_is_refused',
      'tests::rules::the_deposit_is_checked_first_and_inclusive'
    ),
  },
  {
    name: 'registry report: the deposit is the attached one',
    file: REGISTRY_LIB,
    find: '            env::attached_deposit(),\n',
    replace: '            REPORT_DEPOSIT,\n',
    breaks: 'The deposit rule is right and is shown the price instead of what was paid.',
    tests: unit(REGISTRY, 'tests::reports::a_report_below_the_deposit_is_refused'),
  },
  {
    name: 'registry report: the deposit is 0.01 NEAR',
    file: REGISTRY_RULES,
    find: 'pub const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);\n',
    replace: 'pub const REPORT_DEPOSIT: NearToken = NearToken::from_yoctonear(1);\n',
    breaks: 'A report costs one yoctoNEAR and no longer covers the storage it takes.',
    tests: unit(
      REGISTRY,
      'tests::reports::the_deposit_is_one_hundredth_of_a_near',
      'tests::reports::the_deposit_covers_the_storage_of_a_maximal_report'
    ),
  },
  {
    name: 'registry report: no self-report',
    file: REGISTRY_RULES,
    find: '    if reporter == subject {\n        return Err(Error::SelfReport);\n    }\n',
    replace: '',
    breaks: 'An account fills its own open slots and crowds out real reports, without a second account.',
    tests: unit(REGISTRY, 'tests::reports::an_account_cannot_report_itself'),
  },
  {
    name: 'registry report: one open report per reporter',
    file: REGISTRY_RULES,
    find: '    if open.iter().any(|report| report.reporter == *reporter) {\n        return Err(Error::DuplicateReport);\n    }\n',
    replace: '',
    breaks: 'One funded account fills an account\'s twenty open slots by itself.',
    tests: unit(REGISTRY, 'tests::reports::a_reporter_has_one_open_report_per_account'),
  },
  {
    name: 'registry report: at most MAX_OPEN_REPORTS open',
    file: REGISTRY_RULES,
    find: '    if open.len() >= MAX_OPEN_REPORTS {\n        return Err(Error::ReportLimitReached);\n    }\n',
    replace: '',
    breaks: 'An account\'s open reports grow without bound, and the duplicate check reads all of them.',
    tests: unit(REGISTRY, 'tests::reports::an_account_takes_twenty_open_reports_and_refuses_the_next'),
  },
  {
    name: 'registry report: the lifetime counter never wraps',
    file: REGISTRY_RULES,
    find: '    count.checked_add(1).ok_or(Error::MathOverflow)\n',
    replace: '    Ok(count.wrapping_add(1))\n',
    breaks: 'An account with four billion reports reads as never reported.',
    tests: unit(REGISTRY, 'tests::reports::a_lifetime_counter_at_its_maximum_refuses_rather_than_wrapping'),
  },
]

/**
 * Every sensitive owner method's own check, one control each way, because each method chooses
 * which check to call and dropping one method from a test's list is how a gap opens. The text
 * before `self.assert_owner_one_yocto();` is the method's signature, so the find is unique.
 *
 * - "needs exactly one yocto": the method keeps the owner check and loses the yocto. A
 *   function-call key of the owner (a console session) can then make the call.
 * - "owner only": the method keeps the yocto and loses the owner check. Anyone with a
 *   full-access key of their own can then make the call.
 */
const VAULT_ONE_YOCTO_METHODS = [
  ['add_agent_key', '    ) -> Promise {\n', '        if policy::check_text(Some(&label), MAX_LABEL_BYTES).is_err() {\n'],
  ['revoke_agent_key', '    pub fn revoke_agent_key(&mut self, public_key: PublicKey) {\n'],
  ['forget_agent_key', '    pub fn forget_agent_key(&mut self, public_key: PublicKey) {\n'],
  ['set_agent_expiry', '    pub fn set_agent_expiry(&mut self, public_key: PublicKey, expires_at_s: U64) {\n'],
  ['set_policy', '    pub fn set_policy(&mut self, daily_cap: U128, auto_approve_max: U128, allowlist_enabled: bool) {\n'],
  ['set_allowed', '    pub fn set_allowed(&mut self, payee: AccountId, ok: bool) {\n'],
  ['set_registry', '    pub fn set_registry(&mut self, registry_id: Option<AccountId>) {\n'],
  ['set_hold_unknown', '    pub fn set_hold_unknown(&mut self, hold_unknown: bool) {\n'],
  ['unfreeze', '    pub fn unfreeze(&mut self) {\n'],
  ['owner_pay', '    pub fn owner_pay(&mut self, held_id: U64) -> PromiseOrValue<PayOutcome> {\n'],
  ['owner_reject', '    pub fn owner_reject(&mut self, held_id: U64) {\n'],
  ['forget_guard_refusals', '    pub fn forget_guard_refusals(&mut self, payees: Vec<AccountId>) {\n'],
  ['forget_refusals', '    pub fn forget_refusals(&mut self, payees: Vec<AccountId>) {\n'],
  ['withdraw', '    pub fn withdraw(&mut self, amount: U128) -> Promise {\n'],
]
const VAULT_OWNER_ONLY_METHODS = [
  ['freeze', '    pub fn freeze(&mut self) {\n'],
  ['register_with_token', '    pub fn register_with_token(&mut self) -> Promise {\n'],
]
const REGISTRY_OWNER_METHODS = [
  ['add_oracle', '    pub fn add_oracle(&mut self, account_id: AccountId) {\n'],
  ['remove_oracle', '    pub fn remove_oracle(&mut self, account_id: AccountId) {\n'],
  ['set_owner', '    pub fn set_owner(&mut self, new_owner: AccountId) {\n'],
]

function ownerMethodControls() {
  const out = []
  const vaultYocto = '        if env::attached_deposit() != ONE_YOCTO {\n            Error::RequiresOneYocto.panic();\n        }\n'
  for (const [method, before, after = ''] of VAULT_ONE_YOCTO_METHODS) {
    const find = `${before}        self.assert_owner_one_yocto();\n${after}`
    out.push({
      name: `owner method ${method}: needs exactly one yocto`,
      file: VAULT_LIB,
      find,
      replace: `${before}        self.assert_owner();\n${after}`,
      breaks: `A function-call key of the owner (a console session, no wallet confirmation) can call ${method}.`,
      tests: unit(VAULT, 'test::auth::every_sensitive_owner_method_requires_exactly_one_yocto'),
    })
    out.push({
      name: `owner method ${method}: owner only`,
      file: VAULT_LIB,
      find,
      replace: `${before}${vaultYocto}${after}`,
      breaks: `Anyone who attaches one yoctoNEAR can call ${method}.`,
      tests: unit(VAULT, 'test::auth::every_owner_method_refuses_a_non_owner'),
    })
  }
  for (const [method, before] of VAULT_OWNER_ONLY_METHODS) {
    out.push({
      name: `owner method ${method}: owner only`,
      file: VAULT_LIB,
      find: `${before}        self.assert_owner();\n`,
      replace: before,
      breaks: `Anyone can call ${method}.`,
      tests: unit(VAULT, 'test::auth::every_owner_method_refuses_a_non_owner'),
    })
  }
  const registryOwner = '        if env::predecessor_account_id() != self.owner_id {\n            Error::NotOwner.panic();\n        }\n'
  const registryYocto =
    '        if env::attached_deposit() != NearToken::from_yoctonear(1) {\n            Error::RequiresOneYocto.panic();\n        }\n'
  for (const [method, before] of REGISTRY_OWNER_METHODS) {
    const find = `${before}        self.require_owner_one_yocto();\n`
    out.push({
      name: `registry owner method ${method}: needs exactly one yocto`,
      file: REGISTRY_LIB,
      find,
      replace: `${before}${registryOwner}`,
      breaks: `A function-call key of the registry owner can call ${method}.`,
      tests: unit(REGISTRY, 'tests::admin::every_owner_method_requires_exactly_one_yocto'),
    })
    out.push({
      name: `registry owner method ${method}: owner only`,
      file: REGISTRY_LIB,
      find,
      replace: `${before}${registryYocto}`,
      breaks: `Anyone who attaches one yoctoNEAR can call ${method}.`,
      tests: unit(REGISTRY, 'tests::admin::every_owner_method_refuses_a_caller_that_is_not_the_owner'),
    })
  }
  return out
}

const ALL_CONTROLS = [...CONTROLS, ...ownerMethodControls()]

// -------------------------------------------------------------------------------------------
// Running them
// -------------------------------------------------------------------------------------------

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valueOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}

const only = (valueOf('--only') ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)
const selected = ALL_CONTROLS.filter(
  (c) =>
    (only.length === 0 || only.some((o) => c.name.toLowerCase().includes(o))) &&
    !(has('--unit-only') && c.tests.kind === 'sandbox')
)
const partial = selected.length !== ALL_CONTROLS.length

const editsOf = (c) => c.edits ?? [{ file: c.file, find: c.find, replace: c.replace }]
const crateOf = (file) => file.split('/')[0]
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const read = (file) => readFileSync(join(WORKSPACE, file), 'utf8')
const write = (file, text) => writeFileSync(join(WORKSPACE, file), text)
const elapsed = (t0) => `${((Date.now() - t0) / 1000).toFixed(0)}s`

if (has('--list')) {
  for (const c of ALL_CONTROLS) {
    const where = c.tests.kind === 'unit' ? c.tests.crate : `sandbox-tests --test ${c.tests.binary}`
    console.log(`${c.name}\n    ${editsOf(c).map((e) => e.file).join(', ')}\n    ${where}: ${c.tests.names.join(', ')}`)
  }
  console.log(`\n${ALL_CONTROLS.length} controls`)
  process.exit(0)
}

class Interrupted extends Error {}
let child = null
let interrupted = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    interrupted = true
    if (child) child.kill('SIGINT')
  })
}

/**
 * What every cargo call sees: this process's environment without SANDBOX_WASM_DIR. Set, the
 * sandbox would deploy the bytes it names instead of building the mutated source, and every
 * sandbox control would stay green for a reason that has nothing to do with its guard.
 */
const CARGO_ENV = { ...process.env }
delete CARGO_ENV.SANDBOX_WASM_DIR

/** Run a command in the workspace, collecting stdout and stderr together. */
function run(cmd, args) {
  return new Promise((done) => {
    let out = ''
    let settled = false
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      child = null
      done({ code, signal, out })
    }
    child = spawn(cmd, args, { cwd: WORKSPACE, env: CARGO_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (err) => {
      out += `\n${err}`
      finish(null, null)
    })
    child.on('close', finish)
  }).then((r) => {
    if (interrupted) throw new Interrupted()
    return r
  })
}

const cargo = (...args) => run('cargo', args)
const tail = (text, n = 25) => text.trimEnd().split('\n').slice(-n).map((l) => `      ${l}`).join('\n')

/** Every `.rs` file and `Cargo.toml` of this workspace, outside target/ and hidden entries. */
function workspaceSources(dir = WORKSPACE) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...workspaceSources(path))
    else if (entry.name.endsWith('.rs') || entry.name === 'Cargo.toml') out.push(path)
  }
  return out
}

/**
 * The crate directories outside this workspace that the sandbox harness says it built a
 * contract from (`sandbox-tests: <file>.wasm: built here from <dir> with ...`). A sandbox test
 * binary carries the directory it was compiled for, so one compiled for another copy of this
 * workspace, and reused from a shared target directory, builds THAT copy's contracts: the
 * mutation here would never be deployed, and the control would prove nothing.
 */
function foreignBuilds(out) {
  const here = realpathSync(WORKSPACE)
  const dirs = new Set()
  for (const m of out.matchAll(/^sandbox-tests: \S+\.wasm: built here from (.+?) with `cargo near build`/gm)) {
    const crateDir = m[1]
    const workspace = existsSync(crateDir) ? realpathSync(resolve(crateDir, '..')) : resolve(crateDir, '..')
    if (workspace !== here) dirs.add(crateDir)
  }
  return [...dirs]
}

/** Whether the sandbox harness said where it built the contracts at all. */
const saysWhereItBuilt = (out) => /^sandbox-tests: \S+\.wasm: built here from /m.test(out)

/** Every `test <name> ... ok|FAILED|ignored` line libtest printed. */
function results(out) {
  const map = new Map()
  for (const line of out.split('\n')) {
    const m = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line)
    if (m) map.set(m[1], m[2])
  }
  return map
}

/** The narrowest command that should notice: the named tests and nothing else. */
function narrow(tests) {
  return tests.kind === 'unit'
    ? ['test', '-p', tests.crate, '--lib', '--locked', '--', '--exact', ...tests.names]
    : ['test', '-p', 'sandbox-tests', '--test', tests.binary, '--locked', '--', '--exact', ...tests.names]
}

/** Apply a control's edits to the given file texts, requiring each find to match exactly once. */
function mutate(c, texts) {
  const out = new Map(texts)
  for (const e of editsOf(c)) {
    const before = out.get(e.file)
    const hits = before.split(e.find).length - 1
    if (hits !== 1) return { error: `expected the guard to appear exactly once in ${e.file}, found ${hits}` }
    out.set(e.file, before.replace(e.find, () => e.replace))
  }
  return { texts: out }
}

/** Put every file named in an interrupted run's record back, then remove the record. */
function recoverFromAnEarlierRun() {
  if (!existsSync(MARKER)) return
  const record = JSON.parse(readFileSync(MARKER, 'utf8'))
  for (const f of record.files) {
    const now = read(f.file)
    if (now === f.original) continue
    if (now !== f.mutated) {
      console.error(
        `An earlier run was stopped during "${record.control}", and ${f.file} now matches neither the original nor the mutated text.` +
          `\nRestore it by hand (git diff shows the change), then delete ${MARKER}.`
      )
      process.exit(1)
    }
    write(f.file, f.original)
    console.log(`restored ${f.file}, left mutated by an interrupted run of "${record.control}"`)
  }
  rmSync(MARKER)
}

const outcomes = []
const record = (c, status, detail) => {
  outcomes.push({ name: c.name, status, detail })
  console.log(`${status === 'caught' ? 'caught' : status.toUpperCase()}  (${detail})`)
}

async function main() {
  recoverFromAnEarlierRun()
  const t0 = Date.now()
  if (process.env.SANDBOX_WASM_DIR !== undefined) {
    console.log('SANDBOX_WASM_DIR is ignored: every control builds the mutated source.')
  }

  // 1. Every find must match before anything runs: a stale control list is worth stopping for.
  const files = [...new Set(selected.flatMap((c) => editsOf(c).map((e) => e.file)))]
  const originals = new Map(files.map((f) => [f, read(f)]))
  const stale = selected
    .map((c) => ({ c, m: mutate(c, originals) }))
    .filter(({ m }) => m.error)
  if (stale.length) {
    for (const { c, m } of stale) console.error(`${c.name}: ${m.error}`)
    console.error('\nThe guard moved, was renamed or was removed, or this list needs updating. Both are worth stopping for.')
    process.exit(1)
  }
  if (has('--check')) {
    console.log(`Every find of the ${selected.length} selected controls matches exactly once. Nothing was run.`)
    return
  }
  const fingerprint = new Map([...originals].map(([f, t]) => [f, sha256(t)]))

  // Cargo decides what to rebuild by timestamps. A file whose timestamp went backwards (rsync -a,
  // an archive, two copies of this workspace sharing one CARGO_TARGET_DIR) can leave a build of
  // DIFFERENT text looking fresh, and a stale mutated binary would turn the baseline red, or a
  // control green, for reasons that have nothing to do with the source. Worse, cargo hashes a
  // workspace crate by its path inside the workspace, so a copy of this workspace that shares
  // a target directory (or was given a clone of one) can reuse the sandbox test binaries of the
  // original, and those carry the ORIGINAL's directory: they build and deploy its contracts,
  // never the mutation here. So every source file of the workspace is stamped now, every crate
  // is rebuilt here on its first build, and the baseline compiles exactly the text on disk.
  const now = new Date()
  for (const path of workspaceSources()) utimesSync(path, now, now)

  // 2. Baseline. A red suite makes every control meaningless: each one would "pass" for the
  //    wrong reason. It also proves every unit test a control names exists.
  process.stdout.write('baseline, unit suites: ')
  const base = await cargo('test', '-p', VAULT, '-p', REGISTRY, '--locked')
  const baseResults = results(base.out)
  if (base.code !== 0) {
    console.error(`FAIL\n  The unit suites are red before any control was applied. Fix that first.\n${tail(base.out)}`)
    process.exit(1)
  }
  console.log(`green (${baseResults.size} tests)`)
  const missing = selected
    .filter((c) => c.tests.kind === 'unit')
    .flatMap((c) => c.tests.names.filter((n) => !baseResults.has(n)).map((n) => `${c.name}: no unit test named ${n}`))
  if (missing.length) {
    console.error(missing.join('\n'))
    console.error('A filter that matches nothing is trivially green. Fix the name, or write the test.')
    process.exit(1)
  }

  const sandboxNames = new Map()
  for (const c of selected.filter((c) => c.tests.kind === 'sandbox')) {
    const names = sandboxNames.get(c.tests.binary) ?? new Set()
    c.tests.names.forEach((n) => names.add(n))
    sandboxNames.set(c.tests.binary, names)
  }
  for (const [binary, names] of sandboxNames) {
    process.stdout.write(`baseline, sandbox ${binary} (${names.size} tests): `)
    const r = await cargo(...narrow(sandbox(binary, ...names)))
    const got = results(r.out)
    const absent = [...names].filter((n) => !got.has(n))
    if (r.code !== 0 || absent.length) {
      console.error(
        `FAIL\n${absent.map((n) => `  no sandbox test named ${n} ran\n`).join('')}  The sandbox tests the controls rely on must be green first.\n${tail(r.out)}`
      )
      process.exit(1)
    }
    const foreign = foreignBuilds(r.out)
    if (!saysWhereItBuilt(r.out) || foreign.length) {
      console.error(
        foreign.length
          ? `FAIL\n  The sandbox tests built the contracts in ${foreign.join(', ')}, not in this workspace (${WORKSPACE}).\n  A test binary compiled for another copy of the workspace was reused; give this run its own CARGO_TARGET_DIR.`
          : `FAIL\n  The sandbox harness did not say where it built the contracts, so this run cannot tell whether a sandbox control deploys the mutation.\n${tail(r.out)}`
      )
      process.exit(1)
    }
    console.log('green')
  }

  // 3. The controls, one at a time.
  console.log(`\n${selected.length} controls${partial ? ` (of ${ALL_CONTROLS.length})` : ''}:\n`)
  for (const [i, c] of selected.entries()) {
    const started = Date.now()
    process.stdout.write(`[${i + 1}/${selected.length}] ${c.name}: `)
    const edited = [...new Set(editsOf(c).map((e) => e.file))]
    const before = new Map(edited.map((f) => [f, read(f)]))
    const { texts, error } = mutate(c, before)
    if (error) {
      record(c, 'stale', error)
      continue
    }
    try {
      writeFileSync(
        MARKER,
        JSON.stringify({ control: c.name, files: edited.map((f) => ({ file: f, original: before.get(f), mutated: texts.get(f) })) })
      )
      for (const f of edited) write(f, texts.get(f))

      // Red for the wrong reason proves nothing: the mutated crate has to compile.
      let broken = null
      for (const crate of new Set(edited.map(crateOf))) {
        const build = await cargo('test', '-p', crate, '--lib', '--no-run', '--locked')
        if (build.code !== 0) {
          broken = `the mutated ${crate} does not compile, so this control proves nothing\n${tail(build.out, 15)}`
          break
        }
      }
      if (broken) {
        record(c, 'broken', broken)
        continue
      }

      const r = await cargo(...narrow(c.tests))
      const got = results(r.out)
      const failed = c.tests.names.filter((n) => got.get(n) === 'FAILED')
      const ran = c.tests.names.filter((n) => got.has(n))
      const foreign = foreignBuilds(r.out)
      if (/`cargo near build` failed|error: could not compile/.test(r.out)) {
        record(c, 'broken', `the mutated contract did not build inside the test run\n${tail(r.out, 15)}`)
      } else if (foreign.length) {
        record(c, 'broken', `the sandbox tests built the contracts in ${foreign.join(', ')}, not in this workspace, so the mutation was never deployed`)
      } else if (failed.length) {
        record(c, 'caught', `${failed.join(', ')}, ${elapsed(started)}`)
      } else if (r.code !== 0) {
        // Red without a FAILED line: the test binary aborted. Still red, and said so.
        record(c, 'caught', `the test process failed outright (exit ${r.code}), ${elapsed(started)}\n${tail(r.out, 10)}`)
      } else if (ran.length !== c.tests.names.length) {
        record(c, 'misconfigured', `only ${ran.length} of ${c.tests.names.length} named tests ran`)
      } else {
        record(c, 'not caught', `${c.tests.names.join(', ')} stayed green. Without this guard: ${c.breaks}`)
      }
    } finally {
      // Restore unconditionally. A failed or interrupted control must never leave a guard
      // deleted on disk.
      for (const f of edited) write(f, before.get(f))
      rmSync(MARKER, { force: true })
    }
  }

  // 4. The tree is back where it started, and green.
  const drifted = [...fingerprint].filter(([f, h]) => sha256(read(f)) !== h).map(([f]) => f)
  if (drifted.length) {
    console.error(`\nFAIL: ${drifted.join(', ')} differ from the text the run started with.`)
    process.exit(1)
  }
  process.stdout.write('\nafter every control, unit suites again: ')
  const after = await cargo('test', '-p', VAULT, '-p', REGISTRY, '--locked')
  if (after.code !== 0) {
    console.error(`FAIL\n  The suites are red after every guard was restored. The tree is not back where it started.\n${tail(after.out)}`)
    process.exit(1)
  }
  console.log(`green (${results(after.out).size} tests)`)

  const bad = outcomes.filter((o) => o.status !== 'caught')
  console.log(`\n${outcomes.length - bad.length}/${outcomes.length} controls caught in ${elapsed(t0)}.`)
  if (bad.length) {
    console.error(`\n${bad.length} control(s) failed. The suite does not prove what it claims:`)
    for (const o of bad) console.error(`  ${o.status.toUpperCase()}  ${o.name}: ${o.detail.split('\n')[0]}`)
    process.exit(1)
  }
  if (partial) console.log(`Partial run: ${selected.length} of ${ALL_CONTROLS.length} controls selected.`)
}

main().catch((err) => {
  if (err instanceof Interrupted) {
    console.error('\nInterrupted. The source was restored.')
    process.exit(130)
  }
  console.error(err)
  process.exit(1)
})

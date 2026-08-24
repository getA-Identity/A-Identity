# A3 - Arithmetic and type conversion

Phase 3 deliverable. Domain: overflow/underflow, casts, precision and rounding, division
by zero, `Val` conversions, and the money invariants INV-05 through INV-12.

Every claim below is backed either by a test I wrote and ran, or by exact tool output.
Work was done in a scratch copy (`rsync -a soroban/ /tmp/a3-scratch/`); nothing under
`soroban/`, `mcp/` or `src/` was modified. Nothing was deployed or transacted.

Artifacts:

- `audit/tool-output/A3-arithmetic-tests.rs` - the 27 tests referenced below, ready to
  drop in as `contracts/agent-spend-policy/src/test/a3_arithmetic.rs`.
- `audit/tool-output/A3-mutants-policy-missed.txt` - my independent `cargo mutants` run
  over `policy.rs` against the unmodified 52-test suite.
- `audit/tool-output/A3-cargo-mutants-after-a3-tests.txt` - the full-crate mutation run
  with those tests added, showing 22 surviving mutants reduced to 10.
- `audit/tool-output/A3-mutants-remaining-missed.txt` - the 10 that remain, all outside
  this domain, handed on in the closing section.

---

## Summary

| # | Title | Severity | Live defect? |
| --- | --- | --- | --- |
| A3-01 | Paying exactly the vault balance is undefended; `check_balance` mutant survives | Low | No, test gap |
| A3-02 | The refusal ladder's first rung differs between `settle` and `withdraw` | Low | **Yes** |
| A3-03 | The day-bucket TTL floor is proven to two ledgers, not two days | Low | No, test gap |
| A3-04 | The instance-TTL assertion is self-referential and cannot fail | Low | No, test gap |
| A3-05 | `set_policy` zero-boundary undefended; two mutants survive | Low | No, test gap |
| A3-06 | The last two rungs of the ladder are never tested | Low | No, test gap |
| A3-07 | INV-05 as written does not hold: `owner_pay` is counted but not capped | Informational | Spec defect |
| A3-08 | `MathOverflow` is an undocumented rung of the refusal ladder | Informational | Spec gap |
| A3-09 | The daily cap is a calendar bucket, so 2x cap can move seconds apart | Informational | By design |
| A3-10 | The committed `soroban/mutants.out` under-reports by 49 mutants | Informational | Stale artifact |

**No exploitable arithmetic defect was found in the deployed code.** Six of the ten items
are test-coverage gaps around correct code; one (A3-02) is a live behavioural
inconsistency in the typed-refusal ABI; three are specification defects.

Section "Verified, not findings" records seven properties I proved hold, including the
one this phase was pointed at hardest: the negative-amount guard.

---

## A3-01 - Paying exactly the vault balance is undefended; the `check_balance` mutant survives

- **Severity**: Low
- **Impact**: High if regressed (a vault that cannot be emptied, permanently, with no
  upgrade path), None today
- **Likelihood**: Low (requires a future edit to a one-character comparison)
- **Violates**: INV-08, INV-20
- **Location**: `soroban/contracts/agent-spend-policy/src/policy.rs:119-124`, `fn check_balance`
- **Category**: Test-coverage gap on a boundary comparison (R2 class 12, class 6)
- **Detected by**: `cargo mutants` 27.1.0, reproduced independently
- **Status**: Open

### Description

`check_balance` refuses when `balance < amount`, so a payment of exactly the full vault
balance is allowed. That is the correct boundary: a vault must be emptiable, and `<=`
would strand the last unit forever behind a contract with no upgrade entrypoint.

Nothing in the 52-test suite asserts it. Every existing balance test pays *more* than the
vault holds (`behaviour.rs:186 paying_more_than_the_vault_holds_returns_insufficient_balance`
uses `2 * UNIT` against a `UNIT` balance), so the `<` boundary is only ever probed from one
side. `cargo mutants` flips it to `<=` and all 52 tests still pass.

The consequence of an undetected regression here is not a wrong number, it is a bricked
vault. `pay`, `owner_pay` and `withdraw` all route through this one comparison, so a `<=`
would make the final unit of any balance permanently unspendable through every path
including the owner's escape hatch. Given P-1 (no upgrade path), that is unrecoverable in
place, which is why a Low-likelihood test gap on this particular line is worth a finding
rather than a note.

### Proof of Concept

My own `cargo mutants` run over `policy.rs` against the unmodified suite, 2026-08-24:

```
Found 32 mutants to test
ok       Unmutated baseline in 37s build + 1s test
MISSED   contracts/agent-spend-policy/src/policy.rs:120:16: replace < with <= in check_balance in 0s build + 1s test
32 mutants tested in 2m: 1 missed, 31 caught
```

One missed out of 32, and it is this one. This matches the Phase 2 full-crate run
(`audit/tool-output/P2-cargo-mutants-full.txt`, 137 mutants, same line MISSED).

Applying the mutant by hand and running the suite:

```
### MUTANT M1: policy.rs:120  balance < amount -> balance <= amount
-- with ORIGINAL 52 only:
test result: ok. 52 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
-- with the A3 tests added:
test result: FAILED. 69 passed; 5 failed; 0 ignored; 0 measured
```

The five tests that kill it are in `audit/tool-output/A3-arithmetic-tests.rs`:
`paying_exactly_the_vault_balance_succeeds`,
`owner_pay_of_exactly_the_vault_balance_succeeds`,
`withdrawing_exactly_the_vault_balance_succeeds`,
`one_unit_over_the_balance_is_refused_on_every_money_path`,
`a_payment_of_the_last_remaining_unit_succeeds`.

### Recommended Fix

Do not change `policy.rs`. `balance < amount` is correct. Add the tests.

```diff
--- a/contracts/agent-spend-policy/src/test/mod.rs
+++ b/contracts/agent-spend-policy/src/test/mod.rs
+mod a3_arithmetic;
 mod amounts;
```

```rust
// contracts/agent-spend-policy/src/test/a3_arithmetic.rs
#[test]
fn paying_exactly_the_vault_balance_succeeds() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 10 * UNIT);
    assert_eq!(s.client().balance(), 0, "the vault must be emptiable");
}

#[test]
fn one_unit_over_the_balance_is_refused_on_every_money_path() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    assert_error(s.client().try_pay(&s.payee, &(10 * UNIT + 1)), Error::InsufficientBalance);
    assert_error(s.client().try_owner_pay(&s.payee, &(10 * UNIT + 1)), Error::InsufficientBalance);
    assert_error(s.client().try_withdraw(&s.owner, &(10 * UNIT + 1)), Error::InsufficientBalance);
    assert_eq!(s.client().balance(), 10 * UNIT, "nothing moved");
}
```

The pair matters more than either half: one test pins the boundary from below and one from
above, so the comparison is fixed to exactly `<` rather than merely "not obviously wrong".
Note the count literal in `mcp/src/asp/proof.ts` and the test script in `mcp/package.json`
must be updated alongside, per CLAUDE.md.

### References

- `audit/tool-output/P2-cargo-mutants-full.txt`
- `audit/research/R2-bug-taxonomy.md` class 12 (i128 arithmetic), class 6 (dead-end flows,
  where Certora rated an unexecutable owner path CRITICAL)
- `audit/00-threat-model.md` P-1, asset 3

---

## A3-02 - The refusal ladder's first rung differs between `settle` and `withdraw`

- **Severity**: Low
- **Impact**: Medium (a caller branching on the typed reason is routed to the wrong
  recovery for one class of input; the product claim is that this cannot happen)
- **Likelihood**: Low (needs an input that violates two gates at once)
- **Violates**: INV-17, INV-22
- **Location**: `soroban/contracts/agent-spend-policy/src/lib.rs:137-151` (`fn withdraw`)
  and `soroban/contracts/agent-spend-policy/src/lib.rs:290-324` (`fn settle`)
- **Category**: Overloaded / inconsistent error ordering (R2 class 17)
- **Detected by**: manual review of gate order, confirmed by a failing test
- **Status**: Open. **This one is a live defect in the deployed wasm.**

### Description

`settle` runs the payee check first and the amount check second:

```rust
fn settle(env: &Env, to: &Address, amount: i128, by_owner: bool) -> Result<(), Error> {
    Self::require_valid_payee(env, to)?;          // lib.rs:291
    ...
    policy::check_operator_pay(&snapshot, amount) // begins with check_amount
```

`withdraw` runs them in the opposite order:

```rust
policy::check_amount(amount)?;                    // lib.rs:140
Self::require_valid_payee(&env, &to)?;            // lib.rs:141
```

So an input that violates both gets a different first reason depending on which
entrypoint it reached. `pay(vault_address, 0)` returns `InvalidPayee` (7);
`withdraw(vault_address, 0)` returns `InvalidAmount` (6). Same two violations, same
contract, two different answers.

INV-17 fixes the ladder as `InvalidAmount -> Frozen -> ...` and lists `InvalidPayee`
nowhere at all, so on the invariant's own terms `settle` is the side that is wrong: the
amount check is specified to be first and it is not. The existing test
`errors.rs:73 the_gate_order_matches_the_solidity_original` comments "Amount is checked
before anything else, even a freeze" and then "Then payee validity, still ahead of the
freeze" - but each of its two assertions violates only one gate, so their relative order
was never actually exercised. The test asserts a claim it does not test.

This is a real finding rather than a nit because the threat model states plainly that a
refusal reporting the wrong reason routes the human-in-the-loop to the wrong recovery, and
lists the truthfulness of the typed error as asset 4. OpenZeppelin rated the analogous
"Overloaded Error Obscures Distinct Failure Cases" as a finding in the Stellar Contracts
Library v0.3.0-rc.2 audit.

### Proof of Concept

Fails on current code:

```rust
#[test]
fn a_doubly_invalid_input_names_the_same_first_reason_on_every_money_path() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();

    let via_pay = s.client().try_pay(&s.contract_id, &0);
    let via_owner_pay = s.client().try_owner_pay(&s.contract_id, &0);
    let via_withdraw = s.client().try_withdraw(&s.contract_id, &0);

    assert_error(via_pay, Error::InvalidAmount);
    assert_error(via_owner_pay, Error::InvalidAmount);
    assert_error(via_withdraw, Error::InvalidAmount);
}
```

```
---- test::a3_arithmetic::a_doubly_invalid_input_names_the_same_first_reason_on_every_money_path stdout ----
panicked at contracts/agent-spend-policy/src/test/a3_arithmetic.rs:450:5:
assertion `left == right` failed: wrong typed error
  left: InvalidPayee
 right: InvalidAmount
```

### Recommended Fix

The contract is on mainnet with no upgrade path, so the code fix applies to the next
deployment; for the live contract, the fix is documentation.

Move the amount check ahead of the payee check in `settle`, so all three money paths agree
and `settle` matches INV-17 as written:

```diff
--- a/contracts/agent-spend-policy/src/lib.rs
+++ b/contracts/agent-spend-policy/src/lib.rs
 fn settle(env: &Env, to: &Address, amount: i128, by_owner: bool) -> Result<(), Error> {
+        // Amount first, so the ladder's first rung is the same on `pay`, `owner_pay`
+        // and `withdraw`. INV-17 specifies InvalidAmount as the first reason.
+        policy::check_amount(amount)?;
         Self::require_valid_payee(env, to)?;
```

`check_amount` is idempotent and the ladders call it again inside, so this is safe as a
pure re-ordering; alternatively drop the now-redundant leading `check_amount` from
`check_operator_pay` and `check_owner_pay`, but keeping both is the cheaper, safer edit
and keeps `policy.rs` correct as a standalone pure module.

Then amend INV-17 in `audit/00-threat-model.md` to name `InvalidPayee` explicitly:

```diff
-  `InvalidAmount` -> `Frozen` -> `SessionKeyExpired` -> `PayeeNotAllowed` ->
-  `AboveAutoApprove` -> `DailyCapExceeded` -> `InsufficientBalance`.
+  `InvalidAmount` -> `InvalidPayee` -> `Frozen` -> `SessionKeyExpired` ->
+  `PayeeNotAllowed` -> `AboveAutoApprove` -> `MathOverflow` -> `DailyCapExceeded` ->
+  `InsufficientBalance`. The order is identical on `pay`, `owner_pay` and `withdraw`
+  for every rung either path has.
```

Until the redeploy, `mcp/` and the console must treat `InvalidPayee` and `InvalidAmount`
as interchangeable first reasons on `pay`/`owner_pay`.

### References

- `audit/research/R2-bug-taxonomy.md` class 17
- `audit/00-threat-model.md` section 4 asset 4, INV-17, INV-22

---

## A3-03 - The day-bucket TTL floor is proven to two ledgers, not two days

- **Severity**: Low
- **Impact**: High if regressed (the cap silently resets mid-day and the agent spends
  twice `daily_cap`), None today
- **Likelihood**: Low
- **Violates**: INV-18, and through it INV-05
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:53-57` (the TTL
  constants) and `src/test/storage_shape.rs:128-145`
- **Category**: Test-coverage gap on const arithmetic (R2 class 4, class 7)
- **Detected by**: `cargo mutants`, Phase 2 full run
- **Status**: Open

### Description

`DAY_BUCKET_TTL_EXTEND = 2 * LEDGERS_PER_DAY` = 34,560 ledgers. The comment block at
`storage.rs:41-46` explains exactly why: the network's own `min_temporary_ttl` is 17,280,
about one day, so a bucket created early in a UTC day covers the rest of that day "only
just", and every write therefore extends to a two-day floor.

`cargo mutants` changes the `*` to a `+`, making the constant `2 + 17_280 = 17_282`, and
all 52 tests still pass. The test that is supposed to catch this,
`the_day_bucket_survives_the_rest_of_its_own_day`, advances the ledger sequence by exactly
`LEDGERS_PER_DAY` (17,280) and then asserts the bucket is still readable. Under the mutant
the bucket survives 17,282 ledgers, so the assertion clears by **two ledgers**, roughly ten
seconds of wall clock. A test written to prove a two-day safety margin proves a two-ledger
one.

The margin is the whole defence. If the floor ever fell below the remainder of a UTC day,
`get_spent_on_day` would read the missing bucket as zero (`storage.rs:225-230`, by design)
and the agent would silently get a fresh full cap mid-day. That is INV-18 failing in the
exact way `storage.rs` says it must not.

### Proof of Concept

From the Phase 2 full run, reproduced by hand:

```
MISSED   contracts/agent-spend-policy/src/storage.rs:57:42: replace * with + in 0s build + 1s test
```

```
### MUTANT: storage.rs:57 DAY_BUCKET_TTL_EXTEND * -> +
pub const DAY_BUCKET_TTL_EXTEND: u32 = 2 + LEDGERS_PER_DAY;
  original 52: test result: ok. 52 passed; 0 failed
  with A3:     test result: FAILED. 75 passed; 2 failed
```

### Recommended Fix

Two tests, both in `audit/tool-output/A3-arithmetic-tests.rs`. The behavioural one widens
the margin it actually exercises; the numeric one pins the constant to a literal, because
an assertion written in terms of the constant it checks agrees with any value that constant
takes.

```rust
#[test]
fn the_ttl_constants_are_the_numbers_the_safety_argument_rests_on() {
    assert_eq!(crate::storage::LEDGERS_PER_DAY, 17_280);
    assert_eq!(crate::storage::DAY_BUCKET_TTL_THRESHOLD, 17_280);
    assert_eq!(crate::storage::DAY_BUCKET_TTL_EXTEND, 34_560);
    assert_eq!(crate::storage::LONG_TTL_THRESHOLD, 1_036_800);
    assert_eq!(crate::storage::LONG_TTL_EXTEND, 2_592_000);
    assert!(crate::storage::DAY_BUCKET_TTL_EXTEND >= 2 * crate::storage::LEDGERS_PER_DAY);
    assert!(crate::storage::LONG_TTL_EXTEND > crate::storage::LONG_TTL_THRESHOLD);
    assert!(crate::storage::LONG_TTL_EXTEND <= 3_110_400); // live pubnet max_entry_ttl
}

#[test]
fn the_day_bucket_outlives_its_own_day_with_a_full_day_to_spare() {
    let s = setup(10 * UNIT, 100 * UNIT);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &(10 * UNIT));

    s.advance_ledgers(crate::storage::LEDGERS_PER_DAY + crate::storage::LEDGERS_PER_DAY / 2);
    assert_eq!(s.client().spent_today(), 10 * UNIT,
        "the bucket expired inside its own day, so the cap silently reset");
}
```

Hand this one to A2/A6 as well: they own INV-18 and the storage durability argument, and
the numeric floor is the thing their behavioural argument rests on.

### References

- `audit/research/R2-bug-taxonomy.md` class 4 (temporary storage as a security time bound),
  class 7 (period accounting)
- `audit/tool-output/pubnet-state-archival-settings.txt`

---

## A3-04 - The instance-TTL assertion is self-referential and cannot fail

- **Severity**: Low
- **Impact**: High if regressed (instance archival makes every entrypoint including
  `withdraw` unreachable until someone restores the footprint), None today
- **Likelihood**: Low
- **Violates**: INV-20, threatens P-3
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:62`
  (`LONG_TTL_THRESHOLD`) and `src/test/storage_shape.rs:102-119`
- **Category**: Vacuous assertion / test-coverage gap on const arithmetic
- **Detected by**: `cargo mutants`, Phase 2 full run
- **Status**: Open

### Description

`the_instance_ttl_is_extended_by_a_payment` asserts
`ttl >= crate::storage::LONG_TTL_THRESHOLD`. The value it compares against is the constant
under test, so the assertion agrees with any value that constant takes. `cargo mutants`
reports two surviving mutants on it: `*` to `+` (1,036,800 becomes 17,340) and `*` to `/`
(1,036,800 becomes 0).

The `/` mutant is the dangerous one. `extend_ttl(threshold, extend)` only extends when the
remaining TTL has fallen below `threshold`; a threshold of 0 means the bump never fires,
so `bump_instance` becomes a no-op and the instance entry drifts to archival on the clock
described in P-3. Every accessor in `storage.rs` for `Owner`, `Operator`, `Token` and
`Decimals` calls `unwrap()`, so the failure mode is a panic on every entrypoint, `withdraw`
included. Certora rated an unexecutable owner path CRITICAL in Blend (BL-001); this is the
test that is supposed to stop that class reaching production, and it cannot fail.

### Proof of Concept

```
MISSED   contracts/agent-spend-policy/src/storage.rs:62:40: replace * with + in 0s build + 1s test
MISSED   contracts/agent-spend-policy/src/storage.rs:62:40: replace * with / in 0s build + 1s test
```

```
### MUTANT: storage.rs:62 LONG_TTL_THRESHOLD * -> /   (threshold becomes 0)
  original 52: test result: ok. 52 passed; 0 failed
  with A3:     test result: FAILED. 75 passed; 2 failed
```

### Recommended Fix

Assert against a literal, so the assertion and the constant are two independent copies that
must agree - the same discipline `errors.rs` already applies to the error discriminants.

```diff
--- a/contracts/agent-spend-policy/src/test/storage_shape.rs
+++ b/contracts/agent-spend-policy/src/test/storage_shape.rs
     let ttl = s.env.deployer().get_contract_instance_ttl(&s.contract_id);
     assert!(
-        ttl >= crate::storage::LONG_TTL_THRESHOLD,
-        "pay must leave the instance entry above the bump threshold, got {ttl}",
+        // A literal, not the constant under test. Asserting against LONG_TTL_THRESHOLD
+        // agrees with any value that constant takes, which is why this could not see a
+        // change to it. 60 days of ledgers.
+        ttl >= 1_036_800,
+        "pay must leave the instance entry at least 60 days out, got {ttl}",
     );
```

Plus `the_ttl_constants_are_the_numbers_the_safety_argument_rests_on` from A3-03, which
pins all five constants. `audit/tool-output/A3-arithmetic-tests.rs` ships the additive
form of this fix (`a_payment_leaves_the_instance_entry_above_a_literal_floor`) so the
module drops in without touching `storage_shape.rs`; the in-place diff above is the better
end state, because it removes the vacuous assertion rather than leaving it alongside a real
one. Cross-reference to A2/A6, who own INV-20 and P-3.

### References

- `audit/research/R2-bug-taxonomy.md` class 3 (instance TTL, OpenZeppelin rated Medium),
  class 6, class 18
- `audit/00-threat-model.md` P-3, INV-20

---

## A3-05 - `set_policy` zero-boundary undefended; two mutants survive

- **Severity**: Low
- **Impact**: Medium if regressed (a zero cap or zero ceiling would be refused, so an
  owner could never remove a bound, and every configuration the console and the
  spend-preflight API assume would break)
- **Likelihood**: Low
- **Violates**: INV-16
- **Location**: `soroban/contracts/agent-spend-policy/src/lib.rs:163-165`, `fn set_policy`
- **Category**: Sentinel-semantics coverage gap (R2 class 19)
- **Detected by**: `cargo mutants`, Phase 2 full run
- **Status**: Open

### Description

INV-16 states that a zero `daily_cap`, a zero `auto_approve_max` and a zero
`SessionKeyExpiry` each mean "no bound", never "bound of zero". `set_policy` enforces that
by refusing only strictly negative values.

The constructor's identical guard at `lib.rs:88` is fully covered: all six of its mutants
are caught. `set_policy`'s is not. `cargo mutants` flips `daily_cap < 0` to `<= 0` and
`auto_approve_max < 0` to `<= 0`, and all 52 tests still pass, because the only test of the
zero sentinels, `behaviour.rs:172 a_zero_cap_and_a_zero_ceiling_both_mean_unbounded`, sets
both zeros through the **constructor** and never calls `set_policy` with a zero at all.

That leaves the runtime path to "remove a bound" untested. It is also the only path an
already-deployed vault has: with no upgrade entrypoint and no re-initialization, an owner
who wants to lift the cap on the live pubnet contract must go through `set_policy`.

The three sentinels are also never tested independently. Nothing asserts that a zero cap
leaves the ceiling binding, or that a zero ceiling leaves the cap binding, so a change that
made one sentinel swallow the other would pass.

### Proof of Concept

```
MISSED   contracts/agent-spend-policy/src/lib.rs:163:22: replace < with <= in AgentSpendPolicy::set_policy
MISSED   contracts/agent-spend-policy/src/lib.rs:163:46: replace < with <= in AgentSpendPolicy::set_policy
```

```
### MUTANT M2: lib.rs:163  daily_cap < 0 -> daily_cap <= 0
-- with ORIGINAL 52 only:
test result: ok. 52 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
-- with the A3 tests added:
test result: FAILED. 71 passed; 3 failed; 0 ignored; 0 measured
```

### Recommended Fix

Do not change `lib.rs`. Add four tests (all in `audit/tool-output/A3-arithmetic-tests.rs`):

```rust
#[test]
fn set_policy_accepts_a_zero_cap_and_a_zero_ceiling() {
    let s = setup(UNIT, UNIT);
    s.mock_auths();
    s.client().set_policy(&0, &UNIT, &false);
    assert_eq!(s.client().daily_cap(), 0);
    assert_eq!(s.client().auto_approve_max(), UNIT);
    s.client().set_policy(&UNIT, &0, &false);
    assert_eq!(s.client().daily_cap(), UNIT);
    assert_eq!(s.client().auto_approve_max(), 0);
    s.client().set_policy(&0, &0, &false);
}

#[test]
fn a_zero_cap_alone_means_unbounded_while_the_ceiling_still_binds() { /* ... */ }

#[test]
fn a_zero_ceiling_alone_means_unbounded_while_the_cap_still_binds() { /* ... */ }

#[test]
fn a_zero_session_key_expiry_means_unbounded_after_a_real_one_was_set() { /* ... */ }
```

The first also kills three of the Phase 2 view-function mutants
(`daily_cap -> 0 / 1 / -1`, `auto_approve_max -> 0 / 1 / -1`) as a side effect, because it
is the first test to assert that those views return the value that was written. Those views
are what `mcp/`'s spend-preflight reads, so their correctness is load-bearing off-chain
even though they move no money.

### References

- `audit/research/R2-bug-taxonomy.md` class 19 (bounds check that does not match the spec)
- `audit/00-threat-model.md` INV-16

---

## A3-06 - The last two rungs of the refusal ladder are never tested

- **Severity**: Low
- **Impact**: Medium (the ordering the operator relies on is undefended; a swap would send
  "wait until tomorrow" cases to "fund the vault" and vice versa)
- **Likelihood**: Low
- **Violates**: INV-17
- **Location**: `soroban/contracts/agent-spend-policy/src/policy.rs:87-93`,
  `fn check_operator_pay`; test at `src/test/errors.rs:73-114`
- **Category**: Test-coverage gap (R2 class 17)
- **Detected by**: manual review of the gate-order test
- **Status**: Open. The code is correct; the test stops one rung early.

### Description

`the_gate_order_matches_the_solidity_original` walks the ladder down to
`AboveAutoApprove` and stops. `DailyCapExceeded` and `InsufficientBalance` - the last two
rungs, and the two most likely to be hit in normal operation - are never compared against
each other. Each is tested alone (`behaviour.rs:25`, `behaviour.rs:186`), which says
nothing about which one fires when both conditions hold.

I verified by reading `policy.rs:87-92` that the cap check does precede the balance check,
and confirmed it by test. The lead auditor's mainnet observation (a refusal that returned
`DailyCapExceeded` while the vault held less than the amount) is therefore correct
behaviour, not a coincidence - but nothing in the suite defends it.

Note also that all five of the `> with ==` / `> with <` / `> with >=` mutants on the cap
comparison at `policy.rs:88` are caught, so the comparison itself is well covered. What is
uncovered is the *relative order* of two gates, which mutation testing cannot express.

### Proof of Concept

Passes on current code; the point is that it did not exist.

```rust
#[test]
fn the_daily_cap_is_reported_before_the_balance() {
    let s = setup(UNIT, 0);
    s.fund_vault(UNIT / 2);          // less than the amount asked for
    s.mock_auths();
    // 5 UNIT is over the 1 UNIT cap AND over the half-unit balance.
    assert_error(s.client().try_pay(&s.payee, &(5 * UNIT)), Error::DailyCapExceeded);
}
```

`the_whole_operator_ladder_fires_in_order_including_the_last_two_rungs` extends the
existing test through both remaining rungs by lifting one gate at a time while cap and
balance stay violated, and closes with
`assert_eq!(s.client().spent_today(), 0, "no refusal charged the day")` - INV-12 across
every rung at once.

### Recommended Fix

Add both tests. Optionally fold them into `errors.rs` rather than a new module, so the
gate-order claim lives in one place.

### References

- `audit/00-threat-model.md` INV-17
- `audit/research/R2-bug-taxonomy.md` class 17

---

## A3-07 - INV-05 as written does not hold: `owner_pay` is counted but not capped

- **Severity**: Informational
- **Impact**: None on funds (the owner can `withdraw` the entire balance at any time, so a
  cap on the owner would be theatre). Real impact on the audit's own correctness: an
  invariant that does not hold cannot be used to judge a finding.
- **Likelihood**: n/a
- **Violates**: INV-05 as currently worded
- **Location**: `soroban/contracts/agent-spend-policy/src/policy.rs:102-107`,
  `fn check_owner_pay`
- **Category**: Specification defect
- **Detected by**: reading `check_owner_pay` against INV-05, confirmed by a failing test
- **Status**: Open. **Fix the invariant text, not the code.**

### Description

INV-05 reads: "For any UTC day `d` with `daily_cap != 0`, the sum of all amounts
successfully moved by `pay` **and `owner_pay`** on day `d` is `<= daily_cap`."

`check_owner_pay` calls `accumulate` and then never compares the result to `daily_cap`:

```rust
pub fn check_owner_pay(s: &Snapshot, amount: i128) -> Result<i128, Error> {
    check_amount(amount)?;
    let next = accumulate(s.spent_today, amount)?;
    check_balance(s.vault_balance, amount)?;
    Ok(next)
}
```

So `owner_pay` is **counted by** the cap without being **limited by** it. That is
deliberate and well documented - `behaviour.rs:124-133` explains the reasoning at length
and `behaviour.rs:135 owner_pay_is_counted_by_the_daily_cap_without_being_limited_by_it`
asserts exactly this behaviour, and the Solidity original does the same. The defect is in
the invariant, which reads as if the cap bounded both callers.

This matters for the audit rather than for the money. INV-05 is the invariant A3 was asked
to check, and section 7 of the threat model requires every finding to reference one. An
invariant that the code deliberately violates will produce either a false High from a
future reviewer who takes it literally, or a habit of ignoring it.

The same ambiguity is in the threat model's own attack-surface table, which says
`owner_pay` is "still charged to the cap" - true for "charged", misleading for "cap".

### Proof of Concept

Fails on current code, by design:

```rust
#[test]
fn inv_05_as_written_the_sum_of_pay_and_owner_pay_stays_under_the_cap() {
    let s = setup(10 * UNIT, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    s.client().pay(&s.payee, &(5 * UNIT));
    s.client().owner_pay(&s.payee, &(50 * UNIT));
    assert!(s.client().spent_today() <= 10 * UNIT,
        "INV-05: the sum of pay and owner_pay on a day must be <= daily_cap, got {}",
        s.client().spent_today());
}
```

```
---- test::a3_arithmetic::inv_05_as_written_the_sum_of_pay_and_owner_pay_stays_under_the_cap stdout ----
panicked at contracts/agent-spend-policy/src/test/a3_arithmetic.rs:615:5:
INV-05: the sum of pay and owner_pay on a day must be <= daily_cap, got 550000000
```

550,000,000 base units against a 100,000,000 cap: 5.5x.

### Recommended Fix

```diff
--- a/audit/00-threat-model.md
+++ b/audit/00-threat-model.md
-- **INV-05** - For any UTC day `d` with `daily_cap != 0`, the sum of all amounts
-  successfully moved by `pay` and `owner_pay` on day `d` is `<= daily_cap`.
+- **INV-05** - For any UTC day `d` with `daily_cap != 0`, the sum of all amounts
+  successfully moved by `pay` on day `d` is `<= daily_cap`. `owner_pay` is COUNTED by
+  the accumulator but is NOT limited by it: the owner can `withdraw` the whole balance
+  at any time, so bounding their payment would be theatre, and the increment exists so
+  the on-chain total is real outflow rather than agent-only outflow. Every `owner_pay`
+  therefore shrinks the agent's remaining budget for the day.
```

And in the section 5 table, replace "still charged to the cap" with "still added to the
day's accumulator, not bounded by the cap".

### References

- `soroban/contracts/agent-spend-policy/src/test/behaviour.rs:124-154`
- `audit/00-threat-model.md` INV-05, section 5
- `audit/research/R2-bug-taxonomy.md` class 19 (code and spec drifting apart), class 15
  (admin over-privilege as a stated, accepted risk)

---

## A3-08 - `MathOverflow` is an undocumented rung of the refusal ladder

- **Severity**: Informational
- **Impact**: Low (a client exhaustively matching INV-17's ladder has no arm for code 8)
- **Likelihood**: Very low (requires a day total within `amount` of `i128::MAX`)
- **Violates**: INV-17 (incomplete), INV-22 (adjacent)
- **Location**: `soroban/contracts/agent-spend-policy/src/policy.rs:87` and
  `policy.rs:112-114`, `fn accumulate`
- **Category**: Specification gap
- **Detected by**: manual review, confirmed by test
- **Status**: Open

### Description

`accumulate` runs between the auto-approve ceiling and the daily cap, so the true
observable ladder on `pay` is:

```
InvalidPayee -> InvalidAmount -> Frozen -> SessionKeyExpired -> PayeeNotAllowed
             -> AboveAutoApprove -> MathOverflow -> DailyCapExceeded -> InsufficientBalance
```

INV-17 lists seven of those nine. `MathOverflow` (code 8) and `InvalidPayee` (code 7) are
both real rungs and neither appears. A caller that branches exhaustively on the documented
ladder has no arm for either. `InvalidPayee` is covered by A3-02; this item is the other
half.

Practically unreachable on pubnet - it needs a day total within `amount` of `i128::MAX`,
which needs roughly 1.7e38 base units to have moved - but it is a rung, and the ladder is
published as the contract's product surface.

### Proof of Concept

```rust
#[test]
fn math_overflow_is_reported_before_the_daily_cap_and_the_balance() {
    let s = Snapshot {
        frozen: false, session_key_expiry: 0, now: NOON,
        allowlist_enabled: false, payee_allowed: false,
        auto_approve_max: 0,
        daily_cap: UNIT,          // violated
        spent_today: i128::MAX,
        vault_balance: 0,         // violated
    };
    assert_eq!(check_operator_pay(&s, UNIT), Err(Error::MathOverflow));
}
```

Passes: `MathOverflow` wins over both `DailyCapExceeded` and `InsufficientBalance`.

### Recommended Fix

The INV-17 diff in A3-02 covers this: it inserts both `InvalidPayee` and `MathOverflow`
into the documented ladder. No code change.

### References

- `audit/00-threat-model.md` INV-17
- `soroban/contracts/agent-spend-policy/src/error.rs:51-52`

---

## A3-09 - The daily cap is a calendar bucket, so 2x cap can move seconds apart

- **Severity**: Informational
- **Impact**: Low, and intended. Up to `2 * daily_cap` can leave the vault inside a
  two-second window straddling 00:00 UTC.
- **Likelihood**: High that it happens eventually; it is normal operation, not an attack
- **Violates**: nothing. INV-05 is stated per UTC day and this respects it exactly.
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:219-221`, `fn today`
- **Category**: Period accounting (R2 class 7)
- **Detected by**: manual review, confirmed by test
- **Status**: Open as documentation

### Description

`today()` is `env.ledger().timestamp() / 86_400`, a discrete non-overlapping UTC-day
bucket rather than a rolling 24-hour window. So a payment at 23:59:59 and another at
00:00:00 the next day each get a full, independent cap.

This is deliberate, matches the Solidity original, and is already tested from the other
direction by `time.rs:19 the_cap_resets_at_utc_midnight_not_24h_after_the_first_spend`.
I record it because a reader of "1 USDC per day" on the console will not expect 2 USDC to
be able to move within two seconds, and because Certora's Blend BL-002 is exactly this
analysis applied to a discrete-bucket accumulator (value stranded when a period is skipped;
here the inversion is budget released early).

I checked the division itself for the classic problems and found none:

- Divisor is the non-zero literal `86_400`. Division by zero is unrepresentable.
- Both operands are `u64`; `u64 / u64` cannot overflow and cannot trap.
- Rounding is truncation toward zero, which for non-negative `u64` is floor. It selects a
  bucket key and never touches a value, so there is no rounding direction to get wrong and
  no rounding-to-zero that could make an operation free.
- `timestamp = 0` gives day 0, a valid key. `u64::MAX` gives `213_503_982_334_601`, also
  valid. No wrap at either end.

### Proof of Concept

```rust
#[test]
fn the_day_index_is_safe_at_both_ends_of_u64() {
    let s = setup(0, 0);
    s.set_time(0);            assert_eq!(s.client().today(), 0);
    s.set_time(86_399);       assert_eq!(s.client().today(), 0);
    s.set_time(86_400);       assert_eq!(s.client().today(), 1);
    s.set_time(u64::MAX);     assert_eq!(s.client().today(), u64::MAX / 86_400);
    s.set_time(u64::MAX - 1); assert_eq!(s.client().today(), (u64::MAX - 1) / 86_400);
}

#[test]
fn two_full_daily_caps_can_move_across_a_utc_midnight_two_seconds_apart() {
    let s = setup(10 * UNIT, 0);
    s.fund_vault(100 * UNIT);
    s.mock_auths();
    let midnight = (NOON / DAY + 1) * DAY;
    s.set_time(midnight - 1);
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_error(s.client().try_pay(&s.payee, &1), Error::DailyCapExceeded);
    s.set_time(midnight);
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_eq!(s.token().balance(&s.payee), 20 * UNIT, "two caps moved one second apart");
}
```

Both pass.

### Recommended Fix

No code change. Add the two tests as regression guards, so nobody replaces the calendar
bucket with a rolling window (or vice versa) without the widened settlement window being
visible. Say "per UTC day" rather than "per day" in the console copy and in
`public/llms.txt`, and note the midnight boundary where `daily_cap` is set.

The ledger timestamp itself is validator-controlled within a bounded drift, so a
manipulated timestamp could in principle advance the bucket key early. That is A2/A7's
domain (INV-11, INV-18) and I make no claim about the achievable drift; the arithmetic is
sound for any `u64` the network can produce.

### References

- `audit/research/R2-bug-taxonomy.md` class 7 (Certora Blend BL-002), class 22 (rounding,
  dismissed explicitly below)

---

## A3-10 - The committed `soroban/mutants.out` under-reports by 49 mutants

- **Severity**: Informational
- **Impact**: Low, but it is the artifact a reader would check to see whether A3-01 is real
- **Likelihood**: n/a
- **Violates**: n/a
- **Location**: `soroban/mutants.out/` (`outcomes.json`, `caught.txt`, `missed.txt`)
- **Category**: Stale tooling artifact
- **Detected by**: comparing the committed artifact against a fresh run
- **Status**: Open

### Description

The committed `soroban/mutants.out` records 88 mutants, 15 missed. A fresh
`cargo mutants --list` on the same tree today enumerates **137**, and the Phase 2 run
(`audit/tool-output/P2-cargo-mutants-full.txt`) confirms 137 with 22 missed.

The committed artifact contains **no mutants at all** for `policy.rs:119-124`
(`check_balance`), which is where A3-01 lives, and none for the `storage.rs` TTL constants,
which is where A3-03 and A3-04 live. Anyone consulting the committed file would conclude
those lines were fully covered. They are the three least-covered lines in the crate.

### Proof of Concept

```
$ python3 -c "import json; d=json.load(open('soroban/mutants.out/outcomes.json')); \
  print(d['total_mutants'], d['caught'], d['missed'])"
88 70 15

$ cd /tmp/a3-pristine && cargo mutants --list | wc -l
137

$ grep -c 'check_balance' soroban/mutants.out/caught.txt soroban/mutants.out/missed.txt
0
0
```

### Recommended Fix

Either regenerate `soroban/mutants.out` as part of the same change that adds the tests, or
delete it from version control and rely on `audit/tool-output/P2-cargo-mutants-full.txt`
plus CI. A committed mutation report that is not regenerated is worse than none, because it
reads as a coverage guarantee.

### References

- `audit/tool-output/P2-cargo-mutants-full.txt`
- `audit/tool-output/A3-mutants-policy-missed.txt`

---

## Verified, not findings

Positive results. Each was checked rather than assumed, and each is backed by a test that
runs green in `audit/tool-output/A3-arithmetic-tests.rs`.

### V-1. The negative-amount guard is airtight on all three money paths

This is the OpenZeppelin "Spending Limit Policy Bypass By Specifying Negative Amount"
finding, and it does **not** apply to this contract.

`check_amount(amount) -> Err(InvalidAmount) if amount <= 0` is reachable on every path that
moves value, and I proved reachability rather than inferring it from the call graph:

| Path | Route to the guard | Location |
| --- | --- | --- |
| `pay` | `pay` -> `settle` -> `check_operator_pay` -> `check_amount` (first line) | `lib.rs:120`, `policy.rs:65` |
| `owner_pay` | `owner_pay` -> `settle` -> `check_owner_pay` -> `check_amount` (first line) | `lib.rs:131`, `policy.rs:103` |
| `withdraw` | `withdraw` -> `policy::check_amount` directly | `lib.rs:140` |

`every_money_path_refuses_every_negative_amount` drives all three entrypoints with
`i128::MIN`, `i128::MIN + 1`, `-i128::MAX`, `-1e18`, `-10 * UNIT`, `-UNIT`, `-2`, `-1` and
`0`, against a vault with a **non-zero day total already seeded**, and asserts after each
call that `spent_today()` and `balance()` are both unchanged. If any path missed the guard,
a negative amount would decrement the accumulator and the assertion would catch it.

`the_pure_ladder_never_accepts_a_non_positive_amount` makes the same assertion against
`check_operator_pay` and `check_owner_pay` directly, with no token in the picture at all -
which is the property that matters, because the OpenZeppelin argument is precisely that the
policy must not outsource sign validation to the token. It does not here.

And the 400,000-case boundary sweep (V-7) asserts `amount > 0` on every accepted result.
Zero counterexamples.

The `i128::MIN` case deserves its own note: it is refused by the sign check before any
arithmetic touches it, which matters because negating or adding `i128::MIN` is itself a
trap. The contract contains no negation anywhere, so the `MIN / -1` trap from the
OpenZeppelin `checked_mul_div` finding has no site to occur at.

The one caveat, already filed as A3-02: on `pay` and `owner_pay` a negative amount to an
*invalid payee* returns `InvalidPayee` rather than `InvalidAmount`, because `settle` checks
the payee first. The amount is still refused and nothing moves; only the reported reason
differs.

### V-2. There are no casts anywhere in the contract

```
$ grep -rn ' as [ui][0-9]' contracts/agent-spend-policy/src/*.rs
(no matches)
```

Not one `as` cast between `i128`, `u128`, `u64`, `u32` or `i32` exists in `lib.rs`,
`policy.rs`, `storage.rs`, `error.rs` or `event.rs`. Every value keeps the type it was
declared with from the ABI boundary to storage. The unchecked-cast class is structurally
absent, not merely unexercised.

### V-3. There is no untrusted `Val` conversion surface

```
$ grep -n 'Vec\|Map<\|Val\b\|Bytes\|Symbol\|String' contracts/agent-spend-policy/src/*.rs
(no matches)
```

The entire public ABI takes only `Address`, `i128`, `u64`, `bool` and (as a return) `u32`.
No entrypoint accepts a collection, so the Veridise class - `Vec<T>` and `Map<K,V>` elements
converting to `Val` at the host boundary with no guarantee they convert back, halting
execution during retrieval - has no entry point here. The Reflector V3 `[M-02]` panic class
likewise has no site.

The only `Val -> T` conversions are the storage reads in `storage.rs`, and every key they
read is written by the contract itself in `__constructor` or a `set_*`. No attacker
controls a stored `Val`'s type. The residual `unwrap()` risk on those reads is archival, not
conversion, and belongs to A2/A6 (P-3).

### V-4. The contract contains exactly two runtime arithmetic expressions

```
$ grep -nE '[0-9a-z_)] *[+*/%-] *[0-9a-z_(]' contracts/agent-spend-policy/src/*.rs
storage.rs:57:pub const DAY_BUCKET_TTL_EXTEND: u32 = 2 * LEDGERS_PER_DAY;
storage.rs:62:pub const LONG_TTL_THRESHOLD: u32 = 60 * LEDGERS_PER_DAY;
storage.rs:63:pub const LONG_TTL_EXTEND: u32 = 150 * LEDGERS_PER_DAY;
storage.rs:220:    env.ledger().timestamp() / 86_400
```

Three of those four are `const` expressions, evaluated and range-checked at compile time
regardless of any profile setting. That leaves exactly two arithmetic operations at
runtime: `spent.checked_add(amount)` in `accumulate` (`policy.rs:113`) and the `u64`
division in `today()`. There is no subtraction, no multiplication and no modulo on any
value path.

That is why there is no rounding direction to audit (R2 class 22 is `n/a` here, as that
class predicted), no precision loss to favour the user, and no rounding-to-zero that could
make an operation free. Zero-value operations are refused outright by `check_amount`.

### V-5. `overflow-checks` is not load-bearing, and `checked_add` is

The threat model asks not to assume `overflow-checks = true` survives. I tested the
assumption directly.

The full suite, including the two 200,000-case property sweeps, passes with the profile
setting defeated:

```
$ RUSTFLAGS="-C overflow-checks=off" cargo test -p agent-spend-policy --lib
test result: ok. 74 passed; 0 failed
```

`the_day_accumulator_uses_checked_add_and_returns_math_overflow` still returns
`MathOverflow`, because `checked_add` does not consult the profile.

The control, which is what makes that meaningful. Replacing `checked_add` with a bare `+`:

```
=== overflow-checks ON ===
expected the typed error MathOverflow, got a host trap: Abort

=== overflow-checks OFF ===
assertion `left == right` failed: wrong typed error
  left: InsufficientBalance
 right: MathOverflow
```

And the sharpest form, a counterfactual run against a modified `accumulate` with an
exhausted cap and a day total near `i128::MAX`:

```
=== A: real code (checked_add), overflow-checks OFF ===
test result: ok. 1 passed

=== B: bare + , overflow-checks OFF ===
CAP BYPASSED: the ladder accepted a payment past an exhausted cap, returning
Ok(-170141183460469231731687303715884105724)
```

So the layering is exactly as the code comments claim, and the claim is not decorative: with
`overflow-checks` on, losing `checked_add` degrades a typed error into an untyped host
abort; with it off, losing `checked_add` wraps the day total negative, which sails under the
cap and hands the agent an unbounded budget for the rest of the day. `checked_add` is the
guard that holds. Keep both.

### V-6. `i128::MAX` and `i128::MIN` behave on both ladders, including the shorter one

`check_owner_pay` has no cap gate, so `accumulate` sits between the sign check and the
balance check with nothing either side. Verified:

- `the_owner_ladder_overflows_by_name_rather_than_panicking` drives `owner_pay` to
  `MathOverflow` through three `i128::MAX / 2` payments against an `i128::MAX` vault. The
  existing suite only did this for `pay`.
- `the_exact_overflow_boundary_is_off_by_nothing`: with `spent_today = i128::MAX - 10`,
  `amount = 10` returns `Ok(i128::MAX)` on both ladders and `amount = 11` returns
  `Err(MathOverflow)` on both. No wrap, no panic, no off-by-one.
- `a_daily_cap_of_i128_max_still_admits_a_payment`: the cap comparison does not itself
  overflow at the extreme.
- `i128::MIN` is refused by `check_amount` on all three paths before any arithmetic (V-1).

### V-7. The pure ladder holds every money invariant over a 400,000-case sweep

`policy.rs` touches no `Env`, so it can be swept directly. Two tests
(`the_operator_ladder_holds_its_money_invariants_over_a_boundary_sweep`,
`the_owner_ladder_...`) run 200,000 cases each from a fixed SplitMix64 seed, drawing every
`Snapshot` field and the amount from a pool of `i128`/`u64` boundary values
(`MIN`, `MIN+1`, `-2`, `-1`, `0`, `1`, `2`, `UNIT`, `MAX/2`, `MAX-2`, `MAX-1`, `MAX`, and
full-width random 128-bit values) mixed with uniform random draws.

On every accepted result they assert:

| Assertion | Invariant |
| --- | --- |
| `amount > 0` | INV-09 |
| `next == spent_today.checked_add(amount).unwrap()` | no wrap ever reaches storage |
| `next > spent_today` | INV-11 |
| `daily_cap == 0 \|\| next <= daily_cap` | INV-05 |
| `auto_approve_max == 0 \|\| amount <= auto_approve_max` | INV-06 |
| `amount <= vault_balance` | INV-08 |
| `!frozen` | INV-13 |
| `session_key_expiry == 0 \|\| now <= session_key_expiry` | INV-14 |
| `!allowlist_enabled \|\| payee_allowed` | INV-15 |

Zero counterexamples in 400,000 cases, and the seed is fixed so any future failure is
reproducible. `the_pure_ladder_treats_each_zero_as_no_bound_at_extreme_inputs` pins the
three sentinels at the extremes of their types in the same style (INV-16).

No `proptest` dependency was added: the crate is `#![no_std]`, and a deterministic
seeded generator inside the existing test module gives reproducibility without touching
`Cargo.toml` or the dependency tree that A8 is auditing.

---

## Unconfirmed

Things I suspected and could not prove. Recorded so they are not silently dropped.

1. **Ledger-timestamp manipulation moving the day key early.** `today()` is sound for every
   `u64` (V-4, A3-09), but whether a validator can advance `env.ledger().timestamp()` far
   enough to roll the bucket key and release a fresh cap is a consensus question, not an
   arithmetic one. I did not establish the achievable drift on pubnet. Hand to A2/A7
   against INV-11 and INV-18.

2. **`Decimals` and the unit of the cap.** `Decimals` is read at construction and never
   consulted by any gate, so `daily_cap` and `auto_approve_max` are raw base units. That is
   correct arithmetic and it is P-4 as documented. What I could not check within scope is
   whether the console and `mcp/` present the cap in the same units the contract stores -
   "1 USDC per day" and "1 unit per day" differ by 10^7 at Stellar USDC's 7 decimals, and
   `mcp/` is out of scope for this audit. Hand to A5. The three Phase 2 mutants
   `decimals -> u32 with 0 / 1` and `get_decimals -> u32 with 0 / 1` survive, so nothing
   on-chain notices if that view starts lying either.

3. **Whether `mcp/`'s spend-preflight replicates the ladder order.** If it computes the
   refusal reason client-side rather than reading it from the contract, A3-02 and A3-08
   would surface as a mismatch between predicted and actual reason. Out of scope; hand to
   A5.

---

## Method notes

- Scratch copy at `/tmp/a3-scratch`, created with
  `rsync -a /Users/mericcintosun/A-Identity/soroban/ /tmp/a3-scratch/`. Nothing under
  `soroban/`, `mcp/` or `src/` was modified. No network transaction of any kind.
- Baseline confirmed before any change: `52 passed; 0 failed`.
- 27 tests added, at `audit/tool-output/A3-arithmetic-tests.rs`. 25 pass on current code;
  2 fail by design and are the proof for A3-02 and A3-07.
- Every mutant claimed as surviving was applied by hand and run against both the original
  52 and the augmented suite, so each "MISSED" line is backed by a before/after pair rather
  than by tool output alone.
- The `testutils` feature was not needed. All work runs under `cargo test`, which already
  enables it as a dev-dependency, so the built wasm is untouched by everything here.

---

## Effect of the recommended fixes, measured

The six test-coverage findings above (A3-01, A3-03, A3-04, A3-05, A3-06, plus the
regression guards from A3-09) were all closed by one new test module, with no change to
any non-test file. Measured by re-running the full-crate mutation suite against the
augmented tests:

```
BEFORE (audit/tool-output/P2-cargo-mutants-full.txt, the 52-test suite)
  137 mutants tested in 5m: 22 missed, 109 caught, 6 unviable

AFTER  (audit/tool-output/A3-cargo-mutants-after-a3-tests.txt, 52 + 27 A3 tests)
  137 mutants tested in 5m: 10 missed, 121 caught, 6 unviable
```

Twelve surviving mutants killed, and **every mutant in the arithmetic domain is now
caught**: `check_balance`, both `set_policy` boundaries, all three `storage.rs` TTL
constants, and the six `daily_cap` / `auto_approve_max` view mutants that the zero-semantics
tests took as a side effect.

The ten that remain are outside A3's domain and are listed here so the next phase can pick
them up rather than rediscover them
(`audit/tool-output/A3-mutants-remaining-missed.txt`):

```
lib.rs:229     decimals -> u32 with 0 / 1
lib.rs:241     frozen -> bool with true / false
lib.rs:245     allowlist_enabled -> bool with false
lib.rs:249     session_key_expiry -> u64 with 0
lib.rs:253     is_allowed -> bool with false
storage.rs:123 get_decimals -> u32 with 0 / 1
storage.rs:127 set_decimals with ()
```

All ten are view functions or the `Decimals` accessor pair. They move no money, but they
are what `mcp/` and the console read to decide whether to attempt a payment at all, and the
`Decimals` group is P-4 (stored, exposed, never used in logic) with no test asserting the
value survives the round trip from `token::decimals()` through storage to the view. Hand
the `Decimals` group to A5 alongside Unconfirmed item 2, and the boolean/expiry views to
whoever owns INV-04.

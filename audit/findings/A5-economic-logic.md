# A5 - Economic and business logic

Phase 3 deliverable. Domain: INV-05, INV-06, INV-07, INV-11, INV-13 to INV-17, plus the
policy-composition, griefing, ordering and fee questions the task set out.

Every finding below carries either a test that FAILS on current code or verbatim tool
output. Suspicions that could not be proved are in section 4, "Unconfirmed". Claims that
were investigated and turned out to be WRONG are in section 3, so the next phase does not
re-chase them.

**Method.** All work was done in a scratch copy, `rsync -a
/Users/mericcintosun/A-Identity/soroban/ /tmp/a5-scratch/`. Nothing under `soroban/`,
`mcp/` or `src/` was modified. No network transaction of any kind was made; the two live
deployments were not touched, and the one piece of live network data used (pubnet archival
settings and ledger rate) was read from the Phase 2 artifacts already in
`audit/tool-output/`.

**Reproduction.** The 23 probe tests are saved verbatim at
`/Users/mericcintosun/A-Identity/audit/tool-output/A5-probe-tests.rs`. Drop the file in as
`soroban/contracts/agent-spend-policy/src/test/a5_probe.rs`, add `mod a5_probe;` to
`src/test/mod.rs`, and run `cargo test -p agent-spend-policy a5_`. Full output:
`/Users/mericcintosun/A-Identity/audit/tool-output/A5-probe-run.txt`.

---

## 1. Answer to the headline question

**Can `daily_cap` be exceeded in one UTC day? YES.**

Not by the operator, and not by any bug in the day bucket. By `owner_pay`, which
increments the day accumulator and is never compared against it. The threat model's INV-05
states the bound over `pay` AND `owner_pay`, and that statement is false as written. The
Solidity original behaves the same way, so this is a specification defect rather than a
port defect: see A5-01.

`pay` alone can never exceed the cap in one UTC day. Every sequence available to the
operator was probed: the accumulator is monotonically non-decreasing (INV-11 holds,
`amount > 0` is enforced before it), the day key is derived from the ledger clock and the
ledger clock does not run backwards, and the day bucket's TTL is 34,560 ledgers against a
worst case need of one day (section 3.1).

---

## 2. Findings

### Summary

| ID | Severity | Title |
| --- | --- | --- |
| A5-01 | **Low** | `owner_pay` is not bounded by `daily_cap`, so INV-05 is false as written |
| A5-02 | Informational | The day accumulator is not the record of total outflow; the comment says it is |
| A5-03 | **Low** | `require_valid_payee` does not close the zero-cost cap burn its comment claims to close |
| A5-04 | Informational | `InvalidPayee` is absent from the documented refusal ladder and fires in a different position per entrypoint |
| A5-05 | Informational | Four parity comments assert behaviour identical to the Solidity original where it is not |
| A5-06 | **Low** | `set_policy` is a whole-struct overwrite with no partial update and no compare-and-swap |
| A5-07 | Informational | The allowlist can be enabled over an empty payee set, locking the agent out |
| A5-08 | Informational | A no-op setter still publishes a change event |
| A5-09 | Informational | Ordering exposure on freeze is bounded by the remaining daily headroom, and is unbounded when `daily_cap == 0` |

0 Critical, 0 High, 0 Medium, 3 Low, 6 Informational.

---

### A5-01 - `owner_pay` is not bounded by `daily_cap`, so INV-05 is false as written

- **Severity:** Low
- **Impact:** Low
- **Likelihood:** High
- **Violates:** INV-05
- **Location:** `soroban/contracts/agent-spend-policy/src/policy.rs:96-107` (`check_owner_pay`);
  the comment that describes it is `policy.rs:96-101`; the mirrored comment is
  `soroban/contracts/agent-spend-policy/src/lib.rs:125-132` (`owner_pay`)
- **Category:** Business logic / specification mismatch (R2 class 7, period accounting)
- **Detected by:** manual review, confirmed by a failing invariant test
- **Status:** open

#### Description

INV-05 reads: "For any UTC day `d` with `daily_cap != 0`, the sum of all amounts
successfully moved by `pay` and `owner_pay` on day `d` is `<= daily_cap`."

`check_owner_pay` runs three gates - amount sign, `checked_add` accumulation, balance -
and no cap comparison:

```rust
pub fn check_owner_pay(s: &Snapshot, amount: i128) -> Result<i128, Error> {
    check_amount(amount)?;
    let next = accumulate(s.spent_today, amount)?;
    check_balance(s.vault_balance, amount)?;
    Ok(next)
}
```

Compare `check_operator_pay`, which has the gate at `policy.rs:87-90`:

```rust
    let next = accumulate(s.spent_today, amount)?;
    if s.daily_cap != 0 && next > s.daily_cap {
        return Err(Error::DailyCapExceeded);
    }
```

`owner_pay` therefore *records into* the cap without being *bounded by* it. It writes
`spent_today` to any value the balance allows, on any day, without limit.

Two things follow.

1. INV-05 is false. Any sequence of one `pay` up to the cap followed by one `owner_pay` of
   any size breaks it. Verified below at 51x the cap.
2. `spent_today()` can exceed `daily_cap()`. Any consumer computing remaining headroom as
   `daily_cap - spent_today` gets a negative number, which is a signed-arithmetic hazard in
   whatever language reads it.

**Why Low and not higher.** The owner is fully trusted with the entire balance; the threat
model's own table says "nothing is enforced against the owner except arithmetic, balance
and payee validity", and `withdraw` already lets the owner move the whole balance with no
cap at all. No attacker gains anything and no value moves that the owner did not sign for.

**Why Low and not Informational.** The per-UTC-day cap is the product claim, the thing the
contract exists to prove on chain. A stated system invariant about it is provably false,
the code comment that misleads the reader is right next to the missing gate, and the
contract has no upgrade path, so the wrong statement will outlive any correction made
anywhere else.

**Parity note (this is deliberate, not a port bug).** `AgentSpendPolicy.sol:137-143`
behaves identically: `ownerPay` does `spentOnDay[d] += amount` and never compares against
`dailyCap`. The comment's claim "matching Solidity exactly" is the one parity claim in this
area that DOES hold. The defect is that "still counts toward the daily cap" is written in a
way every reader takes to mean "is bounded by", including whoever wrote INV-05.

#### Proof of concept

`audit/tool-output/A5-probe-tests.rs`, test
`a5_inv05_sum_of_pay_and_owner_pay_stays_within_daily_cap`. It asserts INV-05 verbatim and
FAILS on current code.

```rust
#[test]
fn a5_inv05_sum_of_pay_and_owner_pay_stays_within_daily_cap() {
    let s = setup(10 * UNIT, 100 * UNIT);   // daily_cap = 10 units
    s.fund_vault(1_000 * UNIT);
    s.mock_auths();
    s.set_time(NOON);

    // The agent spends the day out, legitimately.
    s.client().pay(&s.payee, &(10 * UNIT));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);

    // The owner then settles 500 units on the SAME UTC day. No cap gate runs.
    s.client().owner_pay(&s.payee, &(500 * UNIT));

    let moved = s.token().balance(&s.payee);
    assert_eq!(s.client().today(), NOON / DAY);
    assert!(
        moved <= s.client().daily_cap(),
        "INV-05 broken: {} moved on day {} against a daily_cap of {}",
        moved, s.client().today(), s.client().daily_cap()
    );
}
```

Verbatim output:

```
running 23 tests
thread 'test::a5_probe::a5_inv05_sum_of_pay_and_owner_pay_stays_within_daily_cap'
panicked at contracts/agent-spend-policy/src/test/a5_probe.rs:36:5:
INV-05 broken: 5100000000 moved on day 20680 against a daily_cap of 100000000
test test::a5_probe::a5_inv05_sum_of_pay_and_owner_pay_stays_within_daily_cap ... FAILED

test result: FAILED. 22 passed; 1 failed; 0 ignored; 0 measured; 52 filtered out
```

5,100,000,000 base units moved on UTC day 20680 against a `daily_cap` of 100,000,000. That
is 51 times the cap, in one day, entirely through calls the contract accepts.

The companion test `a5_owner_pay_drives_the_accumulator_past_the_cap` (passes) isolates the
mechanism: `owner_pay(500 units)` leaves `spent_today() == 500 units` with
`daily_cap() == 10 units`, and a second `owner_pay(400 units)` takes it to 900. No limit.

**Interaction with `set_policy`, as asked.** `a5_set_policy_midday_cap_moves_are_not_exploitable`
(passes) covers both directions and finds nothing exploitable:

- **Lowering the cap below `spent_today` mid-day** does not claw back, does not underflow,
  and does not brick anything. `spent_today` stays where it was and every further `pay`
  returns `DailyCapExceeded` until 00:00 UTC. This is the correct conservative behaviour.
- **Lowering the cap to zero** unlocks everything, because zero means "no bound" (INV-16).
  This is documented, and it is the sharp edge of INV-16: the owner's instinct that "0 is
  the tightest cap" is exactly backwards. See A5-06 for how a stale client reaches it by
  accident.
- **Raising the cap mid-day** re-opens budget immediately for the remainder of the same
  day. It cannot be used to spend the old cap and the new cap independently, because the
  accumulator is never reset; the day's total simply becomes bounded by the new value.
  Both directions are owner-only, so neither is reachable by a compromised operator.

#### Recommended fix

The contract cannot be changed: it is live on pubnet with real USDC and has no upgrade path
(threat model P-1), and changing `owner_pay` would also break the Solidity parity the
console and the preflight API depend on. So the fix is to make the specification and the
comments true.

```diff
--- audit/00-threat-model.md
-- **INV-05** - For any UTC day `d` with `daily_cap != 0`, the sum of all amounts
-  successfully moved by `pay` and `owner_pay` on day `d` is `<= daily_cap`.
+- **INV-05** - For any UTC day `d` with `daily_cap != 0`, the sum of all amounts
+  successfully moved by `pay` on day `d` is `<= daily_cap`. `owner_pay` is NOT bounded
+  by the cap: it adds to the same accumulator without being checked against it, so the
+  total outflow on day `d` is bounded only by the vault balance. This matches the
+  Solidity original and is deliberate; it is stated here because the wording "counts
+  toward the daily cap" reads as a bound and is not one.
+- **INV-05a** - `spent_today` may exceed `daily_cap`. Any consumer computing remaining
+  headroom must clamp at zero.
```

```diff
--- soroban/contracts/agent-spend-policy/src/policy.rs
 /// The owner's ladder. `owner_pay` is a human act, so it bypasses the ceiling, the
-/// allowlist and the freeze, but it STILL counts toward the daily cap, matching Solidity
-/// exactly, so on-chain accounting stays honest about total outflow.
+/// allowlist and the freeze.
+///
+/// It ADDS TO the daily accumulator but is NOT BOUNDED BY the daily cap: there is no
+/// `next > daily_cap` comparison here, and that is deliberate, matching
+/// `AgentSpendPolicy.sol:137-143`. The consequence, which must not be misread: a single
+/// `owner_pay` can drive `spent_today` far above `daily_cap`, and the sum moved in one
+/// UTC day is bounded only by the vault balance. The cap bounds the AGENT, not the day.
+/// What the accumulation buys is that an owner settlement consumes the agent's remaining
+/// budget rather than being invisible to it.
 ///
 /// Note what it does not bypass: the amount guard, the arithmetic, and the balance.
```

The same correction is needed at `lib.rs:125-127`. If a future redeploy is on the table,
the behavioural alternative is to keep `owner_pay` uncapped (parity) but return the new
total, or to add a separate `owner_pay_capped`; do not silently cap `owner_pay`, because
the whole point of the override is to settle a payment the policy refused.

#### References

- `audit/00-threat-model.md` section 7, INV-05
- `audit/research/R2-bug-taxonomy.md` class 7 (period and window accounting), class 13
  (a list enforced on one path and not on a second path that reaches the same effect)
- `mcp/contracts/AgentSpendPolicy.sol:137-143` (read for parity only, out of audit scope)

---

### A5-02 - The day accumulator is not the record of total outflow; the comment says it is

- **Severity:** Informational
- **Impact:** Low
- **Likelihood:** High
- **Violates:** n/a. No invariant asserts this; INV-21 (one event per state change) holds.
  Raised because the task asked whether the `Paid` event and the accumulator together give
  a complete picture of outflow, and whether `Withdrawn` creates a blind spot.
- **Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:125-127` (`owner_pay` doc
  comment) and `policy.rs:96-98`
- **Category:** Inaccurate security comment / observability
- **Detected by:** manual review, confirmed by test and by exhausting the transfer call sites
- **Status:** open

#### Description

The comment says `owner_pay` counts toward the cap "so the on-chain record of total outflow
stays honest". Two separate records are in play and the sentence points at the wrong one.

**The event record is complete.** There are exactly two `transfer` call sites in the whole
contract, and each is followed by a publish:

```
lib.rs:148  token::Client::new(&env, &tok).transfer(&here, &to, &amount);
lib.rs:149  Withdrawn { to, amount }.publish(&env);
lib.rs:315  token::Client::new(env, &tok).transfer(&here, to, &amount);
lib.rs:316  Paid { to, day, amount, by_owner }.publish(env);
```

(from `grep -n "transfer(\|\.publish(" lib.rs`). Every unit that leaves the vault is
therefore named by exactly one of `Paid` or `Withdrawn`, and `Paid.by_owner` distinguishes
the two payment paths. `Withdrawn` carrying a different name is not a blind spot; it is the
correct distinction, because a withdrawal is not a payment. An indexer that sums
`Paid.amount + Withdrawn.amount` reconciles exactly against the balance delta.

**The accumulator record is not complete, and cannot be.** `withdraw` deliberately does not
touch `SpentOnDay` (INV-07, verified), so the owner can move the entire balance to any
address without the accumulator moving at all. Combined with A5-01, the accumulator is
neither an upper bound on the day's outflow nor a lower bound on it.

So the honest statement is: the *events* are the honest record of total outflow, which is
exactly what `event.rs:3-7` already says correctly ("`Paid` is the vault's audit trail, and
it is the reason the per-day accumulator can safely live in temporary storage"). The
`owner_pay` comment contradicts its own event module.

#### Proof of concept

`a5_accumulator_alone_does_not_reconcile_with_outflow` (passes):

```rust
    s.client().pay(&s.payee, &(10 * UNIT));
    s.client().owner_pay(&s.payee, &(90 * UNIT));
    s.client().withdraw(&s.stranger, &(400 * UNIT));

    let outflow = 1_000 * UNIT - s.token().balance(&s.contract_id);
    assert_eq!(outflow, 500 * UNIT);
    assert_eq!(s.client().spent_today(), 100 * UNIT);
    assert!(outflow > s.client().spent_today(), "the gap is withdraw");
```

500 units left the vault on one UTC day; the accumulator reports 100.

#### Recommended fix

```diff
--- soroban/contracts/agent-spend-policy/src/lib.rs
     /// The owner settles a payment they approved out of band. Bypasses the ceiling, the
-    /// allowlist and the freeze, because it is a human act. Still counts toward the daily
-    /// cap, so the on-chain record of total outflow stays honest.
+    /// allowlist and the freeze, because it is a human act. It ADDS TO the day
+    /// accumulator (but is not bounded by the cap, see policy.rs), so an owner
+    /// settlement consumes the agent's remaining budget for the day instead of being
+    /// invisible to it.
+    ///
+    /// The honest record of TOTAL outflow is the event stream, not the accumulator:
+    /// `Paid` plus `Withdrawn` covers both transfer call sites in this contract and
+    /// reconciles exactly against the balance delta. The accumulator omits `withdraw`
+    /// entirely and can exceed the cap, so it is a budget counter, not a ledger.
```

#### References

- `soroban/contracts/agent-spend-policy/src/event.rs:1-13`
- `audit/00-threat-model.md` section 5, "Events (7)"

---

### A5-03 - `require_valid_payee` does not close the zero-cost cap burn its comment claims to close

- **Severity:** Low
- **Impact:** Low (denial of service for the remainder of one UTC day; no value lost)
- **Likelihood:** Medium, conditional on the operator key being compromised, which is the
  exact scenario the guard was written for and which the threat model treats as live
  (the backend holds the operator key on some deployments)
- **Violates:** n/a. No invariant covers griefing. INV-10 holds and is not the issue.
- **Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:276-284`
  (`require_valid_payee` and its comment); mirrored at
  `soroban/contracts/agent-spend-policy/src/error.rs:17-19`
- **Category:** Griefing / inaccurate security comment
- **Detected by:** manual review, confirmed by a passing exploit test
- **Status:** open

#### Description

The comment states the guard's purpose:

```rust
    /// Paying the vault itself, or the token contract, moves nothing but still consumes
    /// the day's budget. Left open, a compromised operator could burn the whole cap at
    /// zero cost every day and deny the legitimate agent indefinitely.
```

The guard blocks two addresses: the vault and the token. It does not achieve the stated
goal, because the cheapest griefing path does not need either of them. A compromised
operator pays an address it controls, and that address sends the funds straight back to the
vault. Net token cost: zero. The vault balance is exactly what it was. `spent_today` is at
the cap and every honest `pay` for the rest of the UTC day returns `DailyCapExceeded`.

The refund leg is an ordinary SEP-41 `transfer` from an account the attacker already
controls; it does not touch this contract at all, so no gate here can see or stop it. On a
mainnet where the cap is 1 USDC/day, the attacker's working capital requirement is one
USDC, returned immediately, repeatable every day forever.

**What the guard IS worth,** and why the recommendation is not to remove it: it removes the
zero-capital version (no funds need to exist anywhere), it removes the accidental version
(a misconfigured payee list pointing at the vault or the token), and it makes the refusal
typed. Those are real. The comment simply claims more than the code delivers, and it is the
kind of overclaim that stops the next reviewer looking for the remaining path.

**What actually closes it.** Only the allowlist, and only if the allowlisted payees do not
cooperate with the attacker. With `allowlist_enabled == true`, the operator can burn the cap
only by paying a payee the owner chose, which converts a free grief into a real payment to a
counterparty the owner trusts. That is worth stating in the deployment guidance, because it
is a concrete reason to run with the allowlist on rather than off.

**Dust repetition is not a cheap grief,** which is worth recording so the next phase does
not chase it. Each `pay` consumes its own amount, so burning an N-unit cap costs N units
regardless of how many calls it is split across. Verified by
`a5_dust_repetition_costs_the_full_cap`: 100 calls of 1 unit against a cap of 100 leave
`spent_today == 100` and the payee holding 100. The only per-call cost is the Stellar
transaction fee, which the operator pays. So the operator has a cheap way to burn its own
fee budget and no cheap way to burn the cap other than the refund path above.

#### Proof of concept

`a5_grief_burn_the_cap_at_zero_net_cost_via_a_refunding_payee` (passes, i.e. the exploit
works):

```rust
    let attacker = Address::generate(&s.env);
    let vault_before = s.token().balance(&s.contract_id);

    // Operator burns the whole day's cap to an address it controls.
    s.client().pay(&attacker, &(10 * UNIT));
    // ...and hands it straight back. No net loss to the vault.
    token::Client::new(&s.env, &s.token_id).transfer(&attacker, &s.contract_id, &(10 * UNIT));

    assert_eq!(s.token().balance(&s.contract_id), vault_before, "zero cost");
    assert_eq!(s.client().spent_today(), 10 * UNIT, "cap fully burned");
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::DailyCapExceeded);
```

All three assertions hold: the vault balance is unchanged, the cap is fully consumed, and
the honest agent is refused for the rest of the UTC day.

#### Recommended fix

No code change is possible or desirable here; the refund leg is outside the contract. Fix
the comment so it states what the guard does and does not do, and put the real mitigation
where an operator will find it.

```diff
--- soroban/contracts/agent-spend-policy/src/lib.rs
-    /// Paying the vault itself, or the token contract, moves nothing but still consumes
-    /// the day's budget. Left open, a compromised operator could burn the whole cap at
-    /// zero cost every day and deny the legitimate agent indefinitely.
+    /// Paying the vault itself, or the token contract, moves nothing but still consumes
+    /// the day's budget. This closes the ZERO-CAPITAL version of that grief and the
+    /// accidental version (a payee list pointing at the vault or the token), and it
+    /// makes the refusal typed rather than a silent no-op.
+    ///
+    /// It does NOT close cap-burning in general, and must not be read as doing so. A
+    /// compromised operator can pay any other address it controls and have that address
+    /// return the funds in a separate transfer this contract never sees: net cost zero,
+    /// cap fully burned, agent denied for the rest of the UTC day. The mitigations for
+    /// that are `set_frozen`, `set_operator`, and running with the allowlist ENABLED so
+    /// that burning the cap requires paying a counterparty the owner chose.
```

And in the operator-compromise runbook: enable the allowlist; the response to a burned cap
is `set_frozen(true)` then `set_operator(new_key)`, not a redeploy.

#### References

- `audit/00-threat-model.md` section 4, asset 2 ("The daily budget")
- `audit/research/R2-bug-taxonomy.md` class 11 (missing same-address validation) - the
  guard is a correct instance of that class; this finding is about the comment's scope, not
  the guard's correctness

---

### A5-04 - `InvalidPayee` is absent from the documented refusal ladder and fires in a different position per entrypoint

- **Severity:** Informational
- **Impact:** Low
- **Likelihood:** Low
- **Violates:** INV-17 (the ladder is documented as fixed and observable; two of the ten
  error codes are not in it, and one of those two changes position between entrypoints)
- **Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:290-292` (`settle`, payee
  before amount) versus `lib.rs:137-141` (`withdraw`, amount before payee);
  `audit/00-threat-model.md` INV-17
- **Category:** Typed-error correctness. The threat model calls the truthfulness of the
  typed error asset 4, "a security property here, not a UX one".
- **Detected by:** manual review, confirmed by a passing test
- **Status:** open

#### Description

INV-17 fixes the ladder as `InvalidAmount` -> `Frozen` -> `SessionKeyExpired` ->
`PayeeNotAllowed` -> `AboveAutoApprove` -> `DailyCapExceeded` -> `InsufficientBalance`.
Seven of the ten codes. `InvalidPayee`, `MathOverflow` and `OwnerIsOperator` are not placed.

For `InvalidPayee` that matters, because it fires from `require_valid_payee`, which sits
*outside* `check_operator_pay` and *before* it:

```rust
    fn settle(env: &Env, to: &Address, amount: i128, by_owner: bool) -> Result<(), Error> {
        Self::require_valid_payee(env, to)?;      // payee FIRST
        ...
        policy::check_operator_pay(&snapshot, amount)?   // amount inside
```

while `withdraw` runs them the other way round:

```rust
        policy::check_amount(amount)?;            // amount FIRST
        Self::require_valid_payee(&env, &to)?;
```

So the identical pair of bad arguments gets two different names depending on which
entrypoint received them. A client that branches on the reason - which is the product claim
- routes the same operator mistake to two different recoveries.

This is low impact because both refusals are correct refusals and the caller can fix either
complaint. It is worth recording because the whole design premise is that the refusal
reason is load-bearing, and because it is free to fix in a redeploy and free to document
now.

#### Proof of concept

`a5_the_refusal_ladder_orders_payee_and_amount_differently_per_entrypoint` (passes):

```rust
    let vault = s.contract_id.clone();

    assert_error(s.client().try_pay(&vault, &0), Error::InvalidPayee);
    assert_error(s.client().try_owner_pay(&vault, &0), Error::InvalidPayee);
    // Same arguments, opposite answer.
    assert_error(s.client().try_withdraw(&vault, &0), Error::InvalidAmount);
```

#### Recommended fix

Documentation now, code on the next redeploy.

```diff
--- audit/00-threat-model.md
-- **INV-17** - The refusal ladder order is fixed and observable:
-  `InvalidAmount` -> `Frozen` -> `SessionKeyExpired` -> `PayeeNotAllowed` ->
-  `AboveAutoApprove` -> `DailyCapExceeded` -> `InsufficientBalance`. A caller must be able
-  to branch on the reason.
+- **INV-17** - The refusal ladder order is fixed and observable. For `pay` and
+  `owner_pay`: `InvalidPayee` -> `InvalidAmount` -> `Frozen` -> `SessionKeyExpired` ->
+  `PayeeNotAllowed` -> `AboveAutoApprove` -> `DailyCapExceeded` -> `MathOverflow` ->
+  `InsufficientBalance`, with `owner_pay` skipping the four policy gates. For `withdraw`:
+  `InvalidAmount` -> `InvalidPayee` -> `InsufficientBalance`. Note the first two are
+  TRANSPOSED between the payment paths and `withdraw`; A5-04 records this. A caller must
+  be able to branch on the reason.
```

```diff
--- soroban/contracts/agent-spend-policy/src/lib.rs  (redeploy only)
     pub fn withdraw(env: Env, to: Address, amount: i128) -> Result<(), Error> {
         Self::require_owner(&env);
         store::bump_instance(&env);
-        policy::check_amount(amount)?;
         Self::require_valid_payee(&env, &to)?;
+        policy::check_amount(amount)?;
```

#### References

- `audit/00-threat-model.md` section 4, asset 4; section 7, INV-17
- `soroban/contracts/agent-spend-policy/src/error.rs:1-6` (discriminants are frozen ABI, so
  the ORDER, not the numbering, is what can still be corrected)

---

### A5-05 - Four parity comments assert behaviour identical to the Solidity original where it is not

- **Severity:** Informational
- **Impact:** Low
- **Likelihood:** High (any reader of these files)
- **Violates:** n/a. Requested explicitly by the task: "an inaccurate comment about security
  behaviour is a finding, at Informational or Low."
- **Location:**
  - `soroban/contracts/agent-spend-policy/src/lib.rs:11-14`
  - `soroban/contracts/agent-spend-policy/src/error.rs:8-19`
  - `soroban/contracts/agent-spend-policy/src/error.rs:11-16`
  - `soroban/contracts/agent-spend-policy/src/policy.rs:8-14`
- **Category:** Inaccurate security comment
- **Detected by:** manual diff against `mcp/contracts/AgentSpendPolicy.sol` (read for the
  parity check only, not audited), confirmed by two passing tests
- **Status:** open

#### Description

The parity claims that hold, stated first so the finding is not read as broader than it is:

- The operator ladder order matches. Solidity `pay` (`.sol:121-132`) fires zero-address ->
  frozen -> session expiry -> allowlist -> ceiling -> daily cap. Rust `check_operator_pay`
  fires payee -> amount -> frozen -> session expiry -> allowlist -> ceiling -> daily cap.
  The five shared gates are in the same order.
- `owner_pay` bypassing freeze, ceiling and allowlist while adding to the accumulator and
  not being bounded by the cap: matches `.sol:137-143` exactly. See A5-01.
- Zero meaning "no bound" for cap, ceiling and expiry: matches.
- Strictly-greater-than on the session expiry, so a payment at exactly the expiry second
  goes through: matches `.sol:124`.
- The day index `timestamp / 86400`: matches `.sol:104-106`.

Four claims that do not hold:

**(a) `error.rs:8` - "Two things in this enum have no analogue in the Solidity original".**
Four do.
- `InvalidAmount = 6` - correctly listed.
- `InvalidPayee = 7` - correctly listed.
- `MathOverflow = 8` - not listed. Solidity 0.8 raises a `Panic(0x11)`, not a typed error,
  and the original has no named equivalent.
- `OwnerIsOperator = 10` - not listed, and this is the one that matters, because it is a
  security check. `.sol:88-101` (constructor) checks only `_owner == address(0)` and
  `_usdc == address(0)`; it accepts `_owner == _operator` and `_operator == address(0)`.
  `.sol:159-162` (`setOperator`) has no check of any kind. The Soroban version refuses both
  at construction (`lib.rs:85-87`) and on `set_operator` (`lib.rs:188-190`). The Soroban
  contract is strictly safer here; the comment just does not say so, and the doc string on
  the variant itself credits the TypeScript path rather than noting the EVM sibling lacks
  the check entirely.

**(b) `error.rs:11-16` - the `InvalidAmount` justification covers the negative case only.**
It explains that `uint256` made a negative amount unrepresentable. True. But `check_amount`
rejects `amount <= 0`, and Solidity's `pay(to, 0)` passes every gate, transfers zero, and
emits `Paid(to, 0, d, false)`. So the zero-amount case is a real behavioural divergence
that the stated justification does not cover. It is a benign divergence - refusing a
no-op payment is better - but a reader reconciling the two chains' event streams will find
`Paid` events on EVM with no Soroban counterpart and no comment explaining why.

**(c) `lib.rs:11-14` - "The behaviour is deliberately identical, down to the order the gates
fire and the meaning of a zero."** The gate order and the zeros are identical. The behaviour
is not: the Soroban version adds three refusals the EVM version does not have
(`InvalidPayee`, `OwnerIsOperator`, `InvalidAmount` in the zero case), plus an explicit
balance check inside the ladder and inside `withdraw` where `.sol:178-182` has none. The
sentence as written is broader than the two things it then qualifies.

**(d) `policy.rs:8-12` - "the same rejected payment produces the same reason on both
chains."** False for at least four input classes: `amount == 0` (Solidity accepts and emits
`Paid`, Soroban returns `InvalidAmount`), a negative amount (unrepresentable on EVM),
`to == vault` (Solidity accepts and burns the cap - this is prior-work item **G-1**, known
open, deduped, not re-counted here), and an underfunded vault (Solidity returns
`TransferFailed` from the ERC-20 bool, Soroban returns `InsufficientBalance` one gate
earlier). The narrower claim - that the SHARED gates fire in the same order - is true and
is worth keeping.

#### Proof of concept

Two passing tests pin the divergences:

```rust
#[test]
fn a5_parity_zero_amount_is_refused_here_but_accepted_by_solidity() {
    let s = setup(0, 0);
    s.fund_vault(10 * UNIT);
    s.mock_auths();
    assert_error(s.client().try_pay(&s.payee, &0), Error::InvalidAmount);
}

#[test]
fn a5_parity_owner_is_operator_has_no_solidity_analogue_either() {
    let s = setup(0, 0);
    s.mock_auths();
    let r = s.client().try_set_operator(&s.owner);
    assert_error(r, Error::OwnerIsOperator);
}
```

Both pass. The Solidity side is established by reading `.sol:88-101`, `.sol:121-132` and
`.sol:159-162`; that file is out of scope to audit and was read only to check the claim.

#### Recommended fix

Comment-only, and worth doing before the next reader treats the parity claim as a
guarantee.

```diff
--- soroban/contracts/agent-spend-policy/src/error.rs
-//! Two things in this enum have no analogue in the Solidity original
-//! (`mcp/contracts/AgentSpendPolicy.sol`), because the port is not a translation:
+//! FOUR variants have no analogue in the Solidity original
+//! (`mcp/contracts/AgentSpendPolicy.sol`), because the port is not a translation:
 //!
 //! * `InvalidAmount`. Solidity's `uint256` made a negative amount unrepresentable; an
-//!   `i128` does not. ...
+//!   `i128` does not. Note this guard also rejects ZERO, which Solidity accepts: a
+//!   `pay(to, 0)` there passes every gate and emits `Paid`. Refusing the no-op is
+//!   better, but it is a divergence and the event streams differ because of it.
 //! * `InvalidPayee`. ...
+//! * `MathOverflow`. Solidity 0.8 raises an untyped `Panic(0x11)` on the same
+//!   accumulation. There is no named EVM equivalent to match.
+//! * `OwnerIsOperator`. The Solidity constructor checks only for the zero address, and
+//!   `setOperator` checks nothing at all, so the EVM sibling accepts
+//!   `owner == operator` and a zero operator. This contract refuses both. The Soroban
+//!   side is strictly safer here; do not "restore parity" by removing the check.
```

```diff
--- soroban/contracts/agent-spend-policy/src/policy.rs
-//! The order of the gates is deliberate and matches the Solidity original
-//! (`mcp/contracts/AgentSpendPolicy.sol`) so that the same rejected payment produces the
-//! same reason on both chains. Order is observable behaviour, not an implementation
-//! detail: ...
+//! The order of the SHARED gates is deliberate and matches the Solidity original
+//! (`mcp/contracts/AgentSpendPolicy.sol`): frozen -> session expiry -> allowlist ->
+//! ceiling -> daily cap fire in that sequence on both chains. Order is observable
+//! behaviour, not an implementation detail: ...
+//!
+//! Parity is NOT total, and four input classes get different answers on the two chains:
+//! a zero amount (EVM accepts and emits Paid), a negative amount (unrepresentable on
+//! EVM), a payee equal to the vault (EVM accepts and burns the cap - open issue G-1),
+//! and an underfunded vault (EVM returns TransferFailed from the ERC-20 bool one gate
+//! later than InsufficientBalance fires here).
```

`lib.rs:11-14` should be narrowed the same way: "the shared gates fire in the same order
and the zeros mean the same thing" rather than "the behaviour is deliberately identical".

#### References

- Prior work **G-1** (EVM sibling lacks the payee-validity gate) - confirmed by reading
  `.sol:121-132` and `.sol:178-182`; recorded here as a DUPLICATE of the known open item,
  not a new finding
- `audit/00-threat-model.md` section 9

---

### A5-06 - `set_policy` is a whole-struct overwrite with no partial update and no compare-and-swap

- **Severity:** Low
- **Impact:** Medium (a policy tightening can silently disable the allowlist and remove the
  auto-approve ceiling in the same transaction)
- **Likelihood:** Low to Medium (requires a stale read by the caller, or two owner sessions
  racing; the owner is trusted but the owner is also a human with a console)
- **Violates:** n/a directly. This is the policy-composition gap the task asked about:
  a sequence of legal owner calls that moves the policy somewhere the owner did not intend.
- **Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:155-176` (`set_policy`)
- **Category:** State machine / policy composition
- **Detected by:** manual review, confirmed by a passing test
- **Status:** open

#### Description

`set_policy` takes all three of `daily_cap`, `auto_approve_max` and `allowlist_enabled` and
writes all three unconditionally. There is no way to change one, and no expected-previous-
value parameter, so every caller must perform a read-modify-write over the other two.

That makes three failure modes reachable through nothing but legal owner calls:

1. **Stale read.** A console that loaded the policy a minute ago, or a script with the
   values hard-coded from setup, tightens the cap and silently reverts the ceiling and the
   allowlist flag to whatever it last saw. The allowlist turning OFF is the dangerous
   direction: the agent can immediately pay anyone.
2. **Interaction with A5-01 and INV-16.** Lowering `daily_cap` toward zero looks like
   tightening right up until it reaches zero, at which point it becomes "no bound". An
   owner walking the cap down in a hurry can overshoot into unlimited.
3. **Racing `set_allowed`.** `set_allowed` writes a separate persistent key, so a
   `set_policy(..., allowlist_enabled = false)` in flight can land after it and undo the
   protection the owner just added, with no error and no way for either call to detect the
   other.

None of this is exploitable by the operator; it is all owner-side. It is rated Low rather
than Informational because the consequence is the agent gaining more authority than the
owner intended, on a mainnet contract, in a single accepted transaction, and because the
mitigation is a caller discipline that nothing in the contract enforces or hints at.

#### Proof of concept

`a5_set_policy_is_a_whole_struct_overwrite_with_no_compare_and_swap` (passes):

```rust
    s.client().set_policy(&(10 * UNIT), &(1 * UNIT), &true);
    s.client().set_allowed(&s.payee, &true);
    assert_error(s.client().try_pay(&s.payee, &(2 * UNIT)), Error::AboveAutoApprove);

    // The owner now wants ONLY to lower the cap, and uses a stale snapshot of the other
    // two fields. The ceiling and the allowlist are silently thrown away.
    s.client().set_policy(&(5 * UNIT), &0, &false);
    assert_eq!(s.client().auto_approve_max(), 0, "ceiling gone");
    assert!(!s.client().allowlist_enabled(), "allowlist gone");
    s.client().pay(&s.stranger, &(5 * UNIT));
```

The last line is the finding: after a call the owner intended as a tightening, the agent
pays a stranger who was never on the allowlist, at an amount that was previously above the
ceiling.

Note also `a5_set_policy_midday_cap_moves_are_not_exploitable`, which shows the zero
overshoot concretely: `set_policy(&0, &(100 * UNIT), &false)` on a vault already at its cap
immediately permits a 100-unit payment.

#### Recommended fix

No on-chain change is possible without a redeploy. Two layers:

**Now, caller discipline.** Every `set_policy` call site must read `daily_cap()`,
`auto_approve_max()` and `allowlist_enabled()` immediately before building the call, and
verify all three immediately after. `mcp/src/platform/vault.ts:208-283` already implements
a read-diff-write sync of this shape (out of scope, noted as existing prior art, not
audited). Document that the pattern is mandatory, not incidental.

**Next redeploy.** Either split the setters, or take the previous values:

```diff
+    /// `expected_*` are the values the caller believes are current. The call is refused
+    /// if the policy moved underneath it, so a stale console cannot silently revert the
+    /// two fields it was not trying to change.
     pub fn set_policy(
         env: Env,
+        expected_daily_cap: i128,
+        expected_auto_approve_max: i128,
+        expected_allowlist_enabled: bool,
         daily_cap: i128,
         auto_approve_max: i128,
         allowlist_enabled: bool,
     ) -> Result<(), Error> {
         Self::require_owner(&env);
         store::bump_instance(&env);
+        if store::get_daily_cap(&env) != expected_daily_cap
+            || store::get_auto_approve_max(&env) != expected_auto_approve_max
+            || store::get_allowlist_enabled(&env) != expected_allowlist_enabled
+        {
+            return Err(Error::PolicyChangedUnderneath);   // new code, append-only: 11
+        }
```

`PolicyChangedUnderneath = 11` is safe to add: `error.rs:1-6` says the list is append-only,
and 11 is unused. Any change here also needs the Solidity sibling considered, since
`setPolicy` there has the identical shape.

#### References

- `audit/00-threat-model.md` section 7, INV-16
- `audit/research/R2-bug-taxonomy.md` class 8 (authorization that does not bind the policy
  it was signed against) - the mechanism here is the mirror image: the call does not bind
  the policy state it was computed against

---

### A5-07 - The allowlist can be enabled over an empty payee set, locking the agent out

- **Severity:** Informational
- **Impact:** Low (agent denied until one further owner call; no value at risk)
- **Likelihood:** Medium
- **Violates:** n/a. Asked explicitly by the task; INV-15 holds throughout.
- **Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:155-176` (`set_policy`),
  `lib.rs:178-183` (`set_allowed`)
- **Category:** State machine transition ordering
- **Detected by:** manual review, confirmed by a passing test
- **Status:** open, believed intended

#### Description

`set_policy(cap, ceiling, allowlist_enabled = true)` succeeds with no payee ever allowed.
From that moment every `pay` returns `PayeeNotAllowed` until the owner makes a second call.
There is no atomic "enable the allowlist with this initial set", and the two calls cannot be
ordered safely in only one direction:

- `set_policy(enable)` then `set_allowed(payee)` leaves a window in which the agent is
  fully denied. Harmless, but it is an outage.
- `set_allowed(payee)` then `set_policy(enable)` has no window and is the correct order.

The behaviour is judged intended: fail-closed is the right default for an allowlist, the
refusal is typed and names exactly what to do, and recovery is a single owner call that is
verified working by the test. It is recorded because the task asked whether a documented
recovery exists, and the answer is that it does not - nothing in `lib.rs`, `README` or the
threat model states the safe ordering.

An indirect consequence worth noting for the ordering discussion in A5-09: this lockout is
also the ONE clean, fully-reversible way for the owner to stop the agent without using
`set_frozen`, since `owner_pay` and `withdraw` keep working throughout (verified by
`a5_inv15_allowlist_blocks_pay_and_leaves_both_owner_paths_working`).

#### Proof of concept

`a5_allowlist_can_be_enabled_over_an_empty_set_and_locks_the_agent_out` (passes):

```rust
    s.client().set_policy(&(10 * UNIT), &(100 * UNIT), &true);
    assert!(!s.client().is_allowed(&s.payee));
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::PayeeNotAllowed);
    // Recovery is a second owner call. There is no atomic set-policy-with-payees.
    s.client().set_allowed(&s.payee, &true);
    s.client().pay(&s.payee, &UNIT);
```

#### Recommended fix

Documentation only.

```diff
--- soroban/contracts/agent-spend-policy/src/lib.rs
+    /// Enabling the allowlist over an EMPTY payee set is accepted and is fail-closed:
+    /// every `pay` then returns `PayeeNotAllowed` until the owner calls `set_allowed`.
+    /// There is no atomic enable-with-payees, so the safe ordering is `set_allowed` for
+    /// every payee FIRST, then `set_policy(..., allowlist_enabled = true)`. The reverse
+    /// order is an agent outage for the length of the gap between the two transactions.
+    /// `owner_pay` and `withdraw` are unaffected throughout.
     pub fn set_policy(
```

#### References

- `audit/00-threat-model.md` section 7, INV-15

---

### A5-08 - A no-op setter still publishes a change event

- **Severity:** Informational
- **Impact:** Low
- **Likelihood:** High
- **Violates:** INV-21 in the converse direction. INV-21 requires an event for every state
  change; it does not forbid an event where nothing changed, and the contract emits them.
- **Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:178-183` (`set_allowed`),
  `lib.rs:185-194` (`set_operator`), `lib.rs:200-205` (`set_session_key_expiry`),
  `lib.rs:207-212` (`set_frozen`), `lib.rs:155-176` (`set_policy`)
- **Category:** Observability / integrity of the record
- **Detected by:** manual review, confirmed by a passing test
- **Status:** open

#### Description

None of the five setters compares the incoming value against the stored one. Calling
`set_frozen(true)` on an already-frozen vault publishes a second `FrozenSet(true)`;
`set_allowed(payee, false)` on a payee that was never allowed publishes `AllowlistSet` and
removes a key that does not exist; `set_operator(current)` publishes `OperatorSet` naming
the operator that was already there.

This matters only for the record. `event.rs:1-13` states these events are the public ABI and
the audit trail, so an indexer reconstructing policy history from them will show transitions
that never happened. For a contract whose product claim is an honest on-chain record, that
is worth a line in the docs even though it changes nothing about who can spend what.

It is Informational rather than Low because the event payload always names the resulting
state, not a delta, so a consumer that treats each event as "the policy is now X" rather
than "the policy changed to X" reconstructs the correct history either way.

#### Proof of concept

`a5_no_op_transitions_still_emit_change_events` (passes):

```rust
    s.client().set_frozen(&false);              // was already false
    s.client().set_allowed(&s.stranger, &false); // never was allowed
    s.client().set_operator(&s.operator);        // same operator
    let n = s.env.events().all()
        .filter_by_contract(&s.contract_id).events().len();
    // `all()` reports the LAST invocation only, so this asserts the last no-op call
    // (set_operator to the operator already in storage) still published an OperatorSet.
    assert_eq!(n, 1, "a no-op set_operator published {n} events");
```

#### Recommended fix

Documentation now; a guard is optional on redeploy and arguably not worth the code.

```diff
--- soroban/contracts/agent-spend-policy/src/event.rs
 //! Like the error discriminants, these shapes are public ABI. Renaming a field or moving
 //! one between the topic and data sections changes what downstream indexers see.
+//!
+//! Every event names the RESULTING state, never a delta, and the setters do not compare
+//! against the stored value before publishing. So a setter called with the value already
+//! in storage still publishes. Consumers must read each event as "the policy is now X",
+//! not as "the policy changed to X"; read the other way, the trail shows transitions
+//! that never happened.
```

#### References

- `audit/00-threat-model.md` section 7, INV-21

---

### A5-09 - Ordering exposure on freeze is bounded by the remaining daily headroom, and is unbounded when `daily_cap == 0`

- **Severity:** Informational
- **Impact:** Low with a non-zero cap; High if a deployment runs `daily_cap == 0`
- **Likelihood:** Low
- **Violates:** n/a. Recorded as the answer to the ordering / front-running question.
- **Location:** `soroban/contracts/agent-spend-policy/src/lib.rs:290-324` (`settle` reads
  every gate from live storage), `lib.rs:207-212` (`set_frozen`)
- **Category:** Ordering / transaction sequencing
- **Detected by:** code analysis; the bound is confirmed by a passing test, the network
  ordering mechanics are NOT independently verified (see Unconfirmed U-1)
- **Status:** open, believed intended

#### Description

The contract has no nonce, no deadline parameter, and no expected-state parameter on any
entrypoint. Every gate in `settle` is read fresh from storage at execution time
(`lib.rs:296-306`). Two consequences, one good and one that needs stating.

**The good one, and it is the design working.** Because policy is evaluated at execution and
never at signing, a `pay` authorization the operator signed an hour ago cannot execute
against the policy that was in force when it was signed. If the owner freezes, lowers the
cap, revokes the session key or removes a payee in the meantime, the pre-signed call is
refused when it lands. There is no stale-policy execution window. This is the correct
answer to the "authorization that does not bind the policy it was signed against" class
(R2 class 8), and it is worth recording as a positive.

**The one that needs stating.** The owner cannot make a freeze bind ahead of an in-flight
`pay`. If the owner submits `set_frozen(true)` while the operator submits `pay`, whichever
the network orders first wins, and the contract offers the owner no mechanism to bias it.
So the value at risk in the window between the owner deciding to freeze and the freeze
landing is:

```
at_risk = min(daily_cap - spent_today, auto_approve_max or the remainder, balance)
```

when `daily_cap != 0`, and

```
at_risk = balance
```

when `daily_cap == 0`, because "0 means no bound" (INV-16) and the operator can then move
the entire vault within a single UTC day, one payment at a time.

That second line is the real content of this finding. The bounded-authority claim of the
whole contract depends on `daily_cap` being non-zero. The threat model records the pubnet
deployment as capped at 1 USDC/day, so the live configuration is fine; the point is that
the safety of the freeze race is a property of the CONFIGURATION, not of the code, and
nothing in the contract refuses a zero cap.

#### Proof of concept

`a5_inv16_every_zero_means_no_bound` (passes) - the drain-in-one-day half:

```rust
    let s = setup(0, 0);          // daily_cap = 0, auto_approve_max = 0
    s.fund_vault(1_000 * UNIT);
    ...
    // daily_cap 0: the operator can move the entire vault in one UTC day.
    s.client().pay(&s.payee, &(500 * UNIT));
    s.client().pay(&s.payee, &(500 * UNIT));
    assert_eq!(s.token().balance(&s.contract_id), 0);
    assert_eq!(s.client().spent_today(), 1_000 * UNIT);
```

The gates all pass; nothing is bypassed. Zero cap means no cap.

#### Recommended fix

Deployment guidance, not code. On redeploy, consider refusing `daily_cap == 0` in the
constructor, but note that would break the documented zero semantics and the Solidity
parity, so it is a product decision rather than a bug fix.

```diff
--- soroban/contracts/agent-spend-policy/src/lib.rs
     /// Grant, extend or revoke the session key ...
+
+    /// Note on ordering: policy is read from live storage at EXECUTION time, so a
+    /// pre-signed `pay` can never execute against a stale policy. What the owner cannot
+    /// do is make a freeze bind ahead of a `pay` already in flight; whichever the network
+    /// orders first wins. The value at risk in that window is the remaining daily
+    /// headroom, which is why a deployment should never run with `daily_cap == 0`: with
+    /// no cap the freeze race is bounded only by the vault balance.
     pub fn set_frozen(env: Env, frozen: bool) {
```

#### References

- `audit/research/R2-bug-taxonomy.md` class 8
- `audit/00-threat-model.md` section 7, INV-16; section 2, deployments table

---

## 3. Investigated and NOT a finding

Recorded so Phase 4 and Phase 5 do not re-chase them. Each is backed by a passing test or
by tool output.

### 3.1 The day bucket cannot expire inside its own UTC day (INV-18, and therefore INV-05 via `pay`)

This was the strongest hypothesis going in, from R2 classes 4 and 7. It is wrong, and the
margin is large.

`extend_ttl` was probed directly for its threshold semantics, because the SDK doc string
(`soroban-sdk-27.0.6/src/storage.rs:514`) says "below `threshold`" and an off-by-one there
would make the day bucket's extension a silent no-op:

```
A5: min_temp_entry_ttl=17280 -> ttl_after_set=17279 ttl_after_extend=34560
A5: min_temp_entry_ttl=17281 -> ttl_after_set=17280 ttl_after_extend=34560
A5: min_temp_entry_ttl=34559 -> ttl_after_set=34558 ttl_after_extend=34558
A5: min_temp_entry_ttl=34560 -> ttl_after_set=34559 ttl_after_extend=34559
A5: min_temp_entry_ttl=34561 -> ttl_after_set=34560 ttl_after_extend=34560
```

The host compares `TTL <= threshold`, not `<`, so `DAY_BUCKET_TTL_THRESHOLD ==
LEDGERS_PER_DAY == 17_280` fires the extension at both 17,279 and 17,280. The "one ledger
from being a no-op" worry does not exist.

Measured end to end under the real pubnet parameters:

```
A5: day-bucket TTL after first write = 34560 ledgers
A5: DAY_BUCKET_TTL_EXTEND = 34560
```

Against the live network numbers already captured in `audit/tool-output/`:

- `pubnet-state-archival-settings.txt`: `min_temporary_ttl = 17280`, `max_entry_ttl = 3110400`
- `pubnet-ledger-rate.txt`: mean close interval 5.644 s over 17,280 ledgers, 5.625 s over
  172,800 ledgers

34,560 ledgers at 5.625 s is 54.0 hours, against a worst case requirement of 24 hours (a
bucket created one second after midnight). The close interval would have to fall below
2.5 s for the bucket to die inside its own day. INV-18 holds with better than 2x margin.

The consequence IF it ever failed is preserved as an executable regression test,
`a5_an_early_bucket_expiry_hands_back_a_second_full_cap_on_the_same_day`, which expires the
bucket by advancing the LEDGER SEQUENCE while holding the CLOCK inside the same UTC day and
shows two full caps moving on one calendar day. That test passes today because it forces the
precondition; the precondition is not reachable on pubnet. Phase 5 should keep it as a
canary against a future change to `LEDGERS_PER_DAY` or to the network's close time.

### 3.2 INV-07 holds, and `withdraw` cannot distort the accumulator

`a5_inv07_withdraw_never_touches_the_day_accumulator` (passes). `withdraw` reads no day key,
writes no day key, and after a 900-unit withdrawal the vault is still correctly refusing the
agent at its 10-unit cap. `a5_operator_cannot_reach_withdraw` (passes) confirms with real
auth (`enforce_auth()`, not `mock_all_auths`) that the operator gets a host trap from
`require_auth`, not a typed error. `withdraw` not being capped is not a hole: the owner can
already move the entire balance and is trusted to, and A5-02 covers the one place that fact
is described misleadingly.

### 3.3 INV-06, INV-09, INV-11, INV-13, INV-14, INV-15, INV-16 all hold

- **INV-06** (`pay <= auto_approve_max`): enforced at `policy.rs:83-85`; exercised in
  `a5_set_policy_is_a_whole_struct_overwrite_with_no_compare_and_swap`.
- **INV-09** (every moving amount strictly positive): `check_amount` rejects `<= 0` on all
  three value-moving paths.
- **INV-11** (`SpentOnDay` non-decreasing while the day is current): the only writer is
  `set_spent_on_day(day, next)` where `next = spent + amount` and `amount > 0`. No path
  decrements and no path resets. Monotone by construction.
- **INV-13** `a5_inv13_freeze_blocks_pay_and_leaves_both_owner_paths_working` (passes):
  `pay` returns `Frozen`, `owner_pay` and `withdraw` both succeed.
- **INV-14** `a5_inv14_expiry_blocks_pay_and_leaves_both_owner_paths_working` (passes):
  same shape with `SessionKeyExpired`.
- **INV-15** `a5_inv15_allowlist_blocks_pay_and_leaves_both_owner_paths_working` (passes):
  same shape with `PayeeNotAllowed`, including `owner_pay` and `withdraw` reaching a payee
  that is NOT on the list.
- **INV-16** `a5_inv16_every_zero_means_no_bound` (passes) on all three switches. See A5-09
  for the consequence.

### 3.4 The session key is the ledger clock, not storage expiry - proved on two axes

The claim at `policy.rs:71-74` holds. `a5_session_key_is_the_ledger_clock_not_storage_expiry`
(passes) separates the two axes that a single-axis test would conflate:

```rust
    s.client().set_session_key_expiry(&(NOON + 3_600));

    // Axis 1: burn 500 days of LEDGER SEQUENCE - which expires every temporary entry and
    // would archive anything storage-lifetime-based - while holding the CLOCK before the
    // expiry. `pay` still works, so the permission is not tied to storage age.
    s.advance_ledgers(500 * crate::storage::LEDGERS_PER_DAY);
    s.client().pay(&s.payee, &UNIT);
    assert_eq!(s.client().session_key_expiry(), NOON + 3_600);

    // Axis 2: move the CLOCK one second past the expiry without advancing the sequence at
    // all. `pay` refuses. Only the clock moved.
    s.set_time(NOON + 3_601);
    assert_error(s.client().try_pay(&s.payee, &UNIT), Error::SessionKeyExpired);
```

The value lives in INSTANCE storage (`storage.rs:176-185`), is compared against
`env.ledger().timestamp()` (`lib.rs:299`, `policy.rs:75`), and permissionless TTL extension
of any entry cannot affect it in either direction. This is the correct construction for the
Stellar documentation's rule that a time bound must be in the data, never in the entry
lifetime (R2 class 4).

### 3.5 Missing slippage and deadline parameters: not applicable

Assessed and dismissed on the merits, not waved away. The contract quotes no price, routes
through no pool, and calls no external pricing source; the only cross-contract calls are
`decimals`, `balance` and `transfer` on one token fixed at deploy. There is no quantity a
slippage bound could protect and no quote that could go stale.

The two deadline analogues that DO exist are both present and correct: `session_key_expiry`
as an in-data deadline on the agent's authority (section 3.4), and the Soroban auth entry's
own `signature_expiration_ledger`, which is host-supplied and bounds how long a signed `pay`
can sit unsubmitted. Combined with policy being evaluated at execution rather than at
signing (A5-09), a stale `pay` cannot execute under a stale policy, which is what a
per-call deadline would otherwise be needed for.

### 3.6 Fee calculation and accrual: no fee logic exists, one accrual hazard is A4's

The contract charges no fee, takes no cut, accrues no interest, and holds no second balance.
The only accrued quantity is `SpentOnDay`, covered above.

One economic consequence of a token choice is worth flagging across to **A4**: the
accumulator is charged the NOMINAL `amount`, and `check_balance` compares the NOMINAL
`amount` against the balance. Against a fee-on-transfer or rebasing SEP-41 token, the payee
receives less than the cap was charged and the vault loses more than the cap was charged, so
the cap becomes an approximation in an unpredictable direction. The audited deployments
point at Circle's USDC SAC, which does neither, but the constructor accepts any address
(threat model P-6). Not written up as an A5 finding to avoid duplicating A4's token-
assumption domain; recorded here so it is not lost if A4 scopes it differently.

### 3.7 Dust repetition is not a cheap grief

`a5_dust_repetition_costs_the_full_cap` (passes): 100 calls of 1 unit against a 100-unit cap
leave `spent_today == 100` and the payee holding 100 real units. Splitting a grief across
many calls costs the same principal and MORE transaction fees, all paid by the operator. The
only cheap cap-burn is the refund path in A5-03.

### 3.8 The UTC-day boundary allows 2x the cap in a two-second window, and that is correct

`a5_two_full_caps_move_across_the_midnight_boundary_in_two_seconds` (passes): a full cap at
23:59:59 and another full cap at 00:00:00 the next day. This is not an INV-05 violation -
INV-05 is scoped per calendar day and both halves are inside their own day - and it is not a
bug; it is the documented difference between a UTC-day bucket and a rolling 24-hour window,
which `test/time.rs:1-6` already calls out explicitly. It is recorded because it is the real
short-window rate limit and anyone sizing `daily_cap` against a worst case should size it
against 2x, not 1x.

---

## 4. Unconfirmed

**U-1. Stellar transaction ordering within a ledger.** A5-09 asserts that the owner cannot
make `set_frozen` bind ahead of an in-flight `pay`. The half of that which is proved is the
contract half: no entrypoint takes a nonce, a deadline or an expected-state argument, and
every gate is read from live storage at execution, so the contract itself offers the owner
no mechanism to bias ordering. The half NOT independently verified is the network half - how
Stellar core actually orders two Soroban transactions from two different source accounts
competing for the same ledger, and whether a fee bid gives the owner any usable priority. I
did not probe the network for this and will not assert specifics from memory. Someone with
protocol-27 surge-pricing and ordering documentation to hand should close it. The finding's
conclusion does not depend on the answer: whichever way ordering resolves, the exposure is
the arithmetic bound stated in A5-09.

**U-2. Whether any live deployment ever ran with `daily_cap == 0`.** A5-09's High-impact
branch requires it. The threat model records the pubnet vault as capped at 1 USDC/day, which
would mean no. Confirming it would need a read of `daily_cap()` on
`CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP` and on the testnet contract.
That is a read-only RPC call and safe, but it is a live-network action and I did not take
it. Recommended for whoever compiles the final report.

**U-3. Downstream consumers of `spent_today`.** A5-01 notes that `daily_cap - spent_today`
can go negative. Whether any consumer computes it that way is a question about `mcp/`, which
is out of scope. `grep` shows `mcp/src/spend-preflight.test.ts` reasons in terms of
`remainingTodayUsd`, which is the shape at risk, but the preflight there models an off-chain
policy and I did not trace whether it is ever fed the on-chain accumulator. Flagged for
whoever owns the integration review; it is the only place A5-01 could turn into a real
number being wrong rather than a document being wrong.

---

## 5. Duplicates

- **G-1** (prior internal review, 2026-08-22): the Solidity sibling lacks the
  payee-validity gate. Confirmed while checking the parity claims: `.sol:121-132` checks
  only `to == address(0)`, so `pay(address(this), amount)` is accepted there and burns the
  cap at zero cost. Already open; counted as a duplicate, not a new A5 finding. It is cited
  inside A5-05(d) as one of the four input classes where the "same reason on both chains"
  claim fails.

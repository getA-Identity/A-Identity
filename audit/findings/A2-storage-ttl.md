# A2 - Storage, durability and TTL

Domain: durability class, archival, TTL extension, state bloat, key collisions, residue
after deletion. Owns INV-18, INV-19, INV-20.

Target: `soroban/contracts/agent-spend-policy/src/storage.rs` and every storage access in
`lib.rs`. Deployed on `stellar:pubnet` at
`CB5LYXFKKTKDDSCM6JO6C4GNRQUFBGSLYDET6Q56JNFJQSMBKH6KWSYP` with real Circle USDC, and on
`stellar:testnet` at `CAIL6ECRAB5FUURQ54R7OTZPXRRCDO2S353YT6N6UZUWIBDG2ZOEB4UI`. No upgrade
path (P-1): a fix is withdraw, redeploy, repoint.

## How this was produced

- Work was done in a scratch copy at `/tmp/a2-scratch`. Nothing under `soroban/`, `mcp/`
  or `src/` was modified.
- 22 new probe tests, source archived at `audit/tool-output/A2-probe-tests.rs`, run log at
  `audit/tool-output/A2-live-ttl-probe.txt`. Full suite with them: 74 passed, 0 failed.
- **The probes do not use `Env::default()`'s ledger settings.** The SDK ships
  `min_temp_entry_ttl = 16` and `min_persistent_entry_ttl = 4096`; pubnet runs 17,280 and
  2,073,600. Every pre-existing TTL test in this crate therefore exercises a network that
  does not exist. `setup_on(PUBNET|TESTNET, ..)` applies the measured settings BEFORE
  registering the contract, so entries are created with the TTLs the deployment gets.
- Two host-level facts were read out of `soroban-env-host` 27.0.1 rather than assumed:
  a new entry's `live_until` is `seq + min_ttl - 1` (`ledger_info.rs:16-23`), and the
  extension test is `current_ttl <= threshold`, inclusive (`storage.rs:570`).
- Live pubnet state was read with `getLedgerEntries` only. No transaction was built,
  simulated or submitted on any network.
- `persistent().all()` and `temporary().all()` were NOT used (soroban-sdk issue #1736:
  they return entries from every contract). `instance().all()` filters by the current
  contract address in the SDK source and is used.

---

## The central questions, answered

**1. INV-18: does `SpentOnDay(d)` reliably survive to the end of UTC day `d`, on both
networks? YES, with a 2.25x margin, and the ordering holds.**

The first write of a day creates the temporary entry with the network minimum and then
extends it in the same call. On pubnet the created TTL and the extension threshold are the
same number, 17,280, so whether the extension fires at all turns on two host details. Both
go the right way: the created entry gets `seq + 17,280 - 1`, so `current_ttl` is 17,279,
and the host's test is `current_ttl <= threshold`. The extension fires and the bucket
lands on 34,560 ledgers. Measured, not argued:
`the_first_write_of_a_day_reaches_the_two_day_floor_on_both_networks` asserts the absolute
34,560 under both networks' settings and passes.

Live confirmation: the pubnet bucket `SpentOnDay(20689)` exists right now with
`liveUntilLedgerSeq` 64,138,038 and `lastModifiedLedgerSeq` 64,103,531, a difference of
34,507. That is what a 34,560 floor granted 53 ledgers before the last write looks like:
the day's first payment created and extended the entry, and a second payment 53 ledgers
later rewrote the value without re-extending, because the TTL was still above the 17,280
threshold. It is not what the bare protocol minimum of 17,280 would look like.

The requirement is that the bucket cover at most the remainder of one UTC day, 86,400 s. It
is given 34,560 ledgers, so INV-18 holds while the mean close time stays above
`86400 / 34560 = 2.5000 s`. Pubnet measured 5.644 s, testnet 5.010 s (R3). Without the
extension the break-even would be exactly 5.0000 s, which is the network's own target: the
extension is what turns R3's zero-margin warning into a 2.25x margin. That is the answer to
R3's open item "establish whether the contract relies on the protocol minimum".

One subtlety worth recording because it is easy to misread: a later write on the same day
re-arms the floor only once the TTL has fallen to 17,280 or below, so an entry's life is
34,560 ledgers from creation, not from the last write. It is still always at least 17,280
ledgers after any write. Both branches are covered by
`a_later_payment_the_same_day_re_arms_the_floor`, and the live entry shows the no-op case
(written again at 64,103,531, `liveUntil` unchanged).

**2. UTC midnight: two payments straddling it each get a full cap. Intended, and bounded at
exactly 2x.** `two_payments_straddling_utc_midnight_each_get_a_full_cap_and_no_more` moves
the cap at 23:59:59 and the cap again at 00:00:00 one second later, then proves the third
payment is refused with `DailyCapExceeded`. So the worst case is 2x `daily_cap` inside two
seconds, never more, and the two buckets are different keys that cannot contaminate each
other. Nothing about it is operator-controllable: the day index comes from the ledger
timestamp, not from any argument. See A2-06 for the documentation consequence.

**3. P-3, instance archival: RECOVERABLE AT A COST, not a permanent brick. The `unwrap()`s
are unreachable by archival.** Proven twice over, at two levels:

- Host level. The host used by the test env and by RPC simulation (recording footprint
  mode) restores an expired Persistent-durability entry, which the contract instance is, to
  `min_persistent_ttl` and carries its value across; an expired Temporary entry is deleted
  instead (`soroban-env-host-27.0.1/src/storage.rs:723-770`).
  `an_archived_instance_entry_is_restored_not_lost` walks 2,073,610 ledgers past the end of
  the instance entry's life with no activity, then reads back owner, operator, token,
  decimals and cap unchanged and completes a `withdraw`. The entry comes back with its
  value. It never comes back as `None`, so `unwrap()` at storage.rs:99, 107, 115 and 123 is
  not reachable by this path.
- Protocol level. CAP-0066 (protocol 23) auto-restores any archived Persistent or Instance
  entry present in the footprint of an `InvokeHostFunctionOp`; both networks run protocol
  27 (R3 sections 3.3, 3.4).

So the cost is rent plus a client that builds the restoring footprint. It is not loss of
funds. Severity of the archival issue is therefore driven by liveness and operator burden,
which is A2-04 (Medium), not by bricking. What remains of P-3 as a code smell is
Informational: see A2-09.

**4. Can `extend_ttl` trap? Not with today's network settings, and the margin is 90x, but
the guard the code documents is on the wrong constant.** The trap is real and it is checked
before the threshold test, so it fires even when the extension would have been skipped
(`prepare_extend_ttl`, host storage.rs:478-490): for a Temporary entry, `extend_to` greater
than `max_entry_ttl - 1` is an error, while Persistent and Instance clamp.
`DAY_BUCKET_TTL_EXTEND` is 34,560 against a live `max_entry_ttl` of 3,110,400 on both
networks, a 90x margin, so it cannot trap today.
`pay_traps_untyped_if_the_network_lowers_max_entry_ttl_to_the_day_bucket_floor` proves the
exact boundary by moving the network setting rather than the code, and
`the_instance_bump_clamps_instead_of_trapping` proves the other half of the asymmetry. See
A2-05.

**5. soroban-sdk issue #1736.** Acknowledged. No assertion in the probe suite is built on
`persistent().all()` or `temporary().all()`. The one `all()` used is
`instance().all()`, which the SDK source filters by `current_contract_address`
(`soroban-sdk-27.0.6/src/storage.rs:660-676`), and its result is cross-checked against the
live pubnet instance entry, which decodes to the same nine keys.

---

## Findings

### A2-01. The day bucket's two-day floor is not pinned by any test; halving it keeps the suite green

- **Severity**: Low
- **Impact**: A future edit that shortens `DAY_BUCKET_TTL_EXTEND` back toward one day
  restores the zero-margin case R3 warned about. If the bucket then expires while its own
  UTC day is still running, `get_spent_on_day` correctly reads the missing entry as zero,
  the cap silently resets mid-day, and the operator can spend up to 2x `daily_cap` in one
  day with no error anywhere. Bounded by `daily_cap` (1.0 USDC on the live deployment).
- **Likelihood**: Low. Requires a code edit. CI would not catch it.
- **Violates**: INV-18 (and INV-05 through it)
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:53-57`
  (`LEDGERS_PER_DAY`, `DAY_BUCKET_TTL_THRESHOLD`, `DAY_BUCKET_TTL_EXTEND`); the test that
  should have caught it is `src/test/storage_shape.rs:128-145`
  (`the_day_bucket_survives_the_rest_of_its_own_day`).
- **Category**: Insufficient TTL extension / missing regression guard on a money invariant
- **Detected by**: `cargo-mutants` (Phase 2, `audit/tool-output/P2-cargo-mutants-full.txt`
  line 20, `storage.rs:57:42: replace * with +`, MISSED), reproduced and killed by three
  new tests
- **Status**: Open
- **Description**: The existing test advances exactly `LEDGERS_PER_DAY` ledgers and asserts
  the bucket is still readable. With the surviving mutant applied, the constant becomes
  `2 + LEDGERS_PER_DAY = 17,282`, the bucket survives 17,280 ledgers by two, and the test
  still passes. 17,282 ledgers is 24.003 hours at the network's 5 s target, which is the
  margin R3 flagged as unacceptable. The test suite cannot tell the two apart because every
  assertion in it is written in terms of the constant under test rather than in absolute
  ledgers.
- **Proof of Concept**: apply the surviving mutant and run both suites.

  ```
  -pub const DAY_BUCKET_TTL_EXTEND: u32 = 2 * LEDGERS_PER_DAY;
  +pub const DAY_BUCKET_TTL_EXTEND: u32 = 2 + LEDGERS_PER_DAY;
  ```

  ```
  existing suite: test result: ok. 52 passed; 0 failed
  A2 probes:      the_day_bucket_floor_tolerates_a_close_time_down_to_2_5_seconds ... FAILED
                  the_day_bucket_outlives_its_own_day_and_then_expires ... FAILED
                  the_first_write_of_a_day_reaches_the_two_day_floor_on_both_networks ... FAILED
                  test result: FAILED. 19 passed; 3 failed
  ```

  Full log: `audit/tool-output/A2-live-ttl-probe.txt`.
- **Recommended Fix**: adopt the three probe tests (they are written against both networks'
  measured settings and assert absolute ledger counts), and state the requirement next to
  the constant as a checkable inequality rather than as prose.

  ```diff
  +// The bucket must cover at most the remainder of one UTC day, 86,400 s. At
  +// DAY_BUCKET_TTL_EXTEND ledgers that holds while the mean close time stays above
  +// 86400 / DAY_BUCKET_TTL_EXTEND seconds. 34,560 -> 2.5 s. The protocol minimum alone
  +// would break even at exactly 5.0000 s, which is the network's own target.
  +const _: () = assert!(DAY_BUCKET_TTL_EXTEND >= 2 * 17_280);
   pub const DAY_BUCKET_TTL_EXTEND: u32 = 2 * LEDGERS_PER_DAY;
  ```
- **References**: R3 section 3.4 (a); host `storage.rs:570`; `ledger_info.rs:16-23`;
  `audit/tool-output/P2-cargo-mutants-full.txt`

### A2-02. `bump_instance` can be disabled entirely without failing a single test

- **Severity**: Low
- **Impact**: With the instance extension silently dead, the instance and code entries ride
  the network minimum forever and archive on a fixed date whatever the vault's activity.
  That converts A2-04 from "only if the vault goes idle" into "always". Recoverable, per
  question 3, so this is availability and rent, not loss.
- **Likelihood**: Low. Requires a code edit. CI would not catch it.
- **Violates**: INV-20 (P-3)
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:62-63, 88-94`; the
  test that should have caught it is `src/test/storage_shape.rs:102-119`
  (`the_instance_ttl_is_extended_by_a_payment`).
- **Category**: Missing TTL extension / vacuous test assertion
- **Detected by**: `cargo-mutants` (Phase 2, `P2-cargo-mutants-full.txt` lines 21-22,
  `storage.rs:62:40: replace * with +` and `with /`, both MISSED), reproduced and killed by
  six new tests
- **Status**: Open
- **Description**: The existing test asserts
  `ttl >= crate::storage::LONG_TTL_THRESHOLD`. The assertion is expressed in the same
  constant the mutation changes, so when `LONG_TTL_THRESHOLD` becomes `60 / 17280 = 0` the
  assertion degenerates to `ttl >= 0` and passes for any TTL, including a TTL that was
  never extended at all. `extend_ttl` with a threshold of 0 applies only when the entry's
  TTL is already 0, that is, never in practice.
- **Proof of Concept**:

  ```
  -pub const LONG_TTL_THRESHOLD: u32 = 60 * LEDGERS_PER_DAY;
  +pub const LONG_TTL_THRESHOLD: u32 = 60 / LEDGERS_PER_DAY;   // = 0

  existing suite: test result: ok. 52 passed; 0 failed
  A2 probes:      test result: FAILED. 16 passed; 6 failed
                  (the_instance_entry_gets_its_life_from_the_network_on_pubnet,
                   the_instance_entry_gets_the_code_floor_on_testnet,
                   no_view_extends_the_instance_ttl_but_every_writer_does,
                   the_instance_bump_clamps_instead_of_trapping,
                   an_allowlist_entry_lives_on_the_network_minimum_on_pubnet...,
                   the_is_allowed_view_writes_a_ttl_extension_and_the_caller_pays_for_it)
  ```
- **Recommended Fix**: assert the post-condition in absolute ledgers, per network, not in
  the constant under test.

  ```diff
  -    assert!(
  -        ttl >= crate::storage::LONG_TTL_THRESHOLD,
  -        "pay must leave the instance entry above the bump threshold, got {ttl}",
  -    );
  +    // Absolute, so that mutating either constant fails here.
  +    assert_eq!(ttl, 2_592_000, "pay must leave the instance entry on the 150 day floor");
  ```
- **References**: `audit/tool-output/P2-cargo-mutants-full.txt`; probe tests
  `the_instance_entry_gets_*`

### A2-03. On pubnet the code's TTL floors are never applied; both long-lived entries ride the network minimum

- **Severity**: Low
- **Impact**: No wrong behaviour, but the documented lifetimes are wrong on the network that
  holds the money, and an operational runbook derived from the comments would carry the
  wrong archival date. The instance entry is documented as living 150 days; the live one
  lives 135.
- **Likelihood**: Certain. It is the current live state.
- **Violates**: n/a (documentation and operational-model accuracy; feeds INV-20)
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:59-63` (the comment on
  `LONG_TTL_THRESHOLD` / `LONG_TTL_EXTEND`), `:88-94` (`bump_instance`), `:200-212`
  (`set_allowed`)
- **Category**: Wrong assumption about network parameters
- **Detected by**: probe tests plus a live read-only `getLedgerEntries` on pubnet
- **Status**: Open
- **Description**: `extend_ttl(threshold, extend_to)` applies only when the current TTL is
  at or below `threshold`. Pubnet hands a new Persistent or Instance entry
  `min_persistent_ttl = 2,073,600`, which is above `LONG_TTL_THRESHOLD = 1,036,800`, so
  `bump_instance` and the `set_allowed` extension are both no-ops for the first roughly 60
  days of an entry's life, and the entry's life comes from the network rather than from this
  contract. Testnet's minimum is 120,960, below the threshold, so there the code floor does
  apply. The result is a factor-of-difference between the two deployments that no comment
  mentions:

  | entry | pubnet TTL granted | testnet TTL granted |
  | --- | --- | --- |
  | contract instance at deploy | 2,073,599 (network) | 2,592,000 (code) |
  | `Allowed(payee)` at `set_allowed` | 2,073,599 (network) | 2,592,000 (code) |

  Live pubnet, ledger 64,104,666: the instance entry's `liveUntilLedgerSeq` is 66,177,017.
  Subtracting `min_persistent_ttl` puts its creation at ledger 64,103,417, one ledger after
  the code upload at 64,103,416, so it is carrying the network minimum granted at creation
  and has not been extended since, although the contract was invoked at 64,103,532.
- **Proof of Concept**: `the_instance_entry_gets_its_life_from_the_network_on_pubnet`,
  `the_instance_entry_gets_the_code_floor_on_testnet`,
  `an_allowlist_entry_lives_on_the_network_minimum_on_pubnet_and_the_code_floor_on_testnet`.
  Live values in `audit/tool-output/A2-live-ttl-probe.txt`.
- **Recommended Fix**: correct the comment and say which number wins where. No code change
  is required, because taking the larger of the two is the correct behaviour.

  ```diff
  -/// Config and allowlist entries are long-lived. Both stay comfortably under the live
  -/// `max_entry_ttl` of 3,110,400 so that a future reduction of that network setting
  -/// cannot turn a routine bump into a failing call.
  +/// Config and allowlist entries are long-lived. Note which number actually wins: an
  +/// extension applies only while the entry's TTL is at or below the threshold, and
  +/// pubnet's `min_persistent_ttl` (2,073,600) is already above LONG_TTL_THRESHOLD. So on
  +/// pubnet these entries live 2,073,600 ledgers from creation and this bump does nothing
  +/// for the first ~60 days; on testnet (minimum 120,960) the floor below is what applies.
  +/// Neither can fail: Persistent and Instance extensions clamp to `max_entry_ttl`. It is
  +/// the TEMPORARY extension above that traps if it ever exceeds the network maximum.
  ```
- **References**: R3 section 3.4 (b); host `storage.rs:570`

### A2-04. The live vault archives on a known date if it is not written to, and no view keeps it alive

- **Severity**: Medium
- **Impact**: Every entrypoint, `withdraw` included, stops being callable in the ordinary
  way once the instance and code entries archive. Recovery is automatic restoration under
  CAP-0066 plus rent, so no funds are lost, but the first transaction after that date needs
  a client that builds the restoring footprint and pays the higher fee. A vault that is
  funded and then left alone, which is exactly the "small balance, occasional agent" shape
  the product describes, walks into this on a fixed schedule.
- **Likelihood**: Certain if the vault is idle for roughly four months; today the live
  deployment is 1 day old and has not been touched since deploy.
- **Violates**: INV-20 (P-3)
- **Location**: `soroban/contracts/agent-spend-policy/src/lib.rs:216-267` (the 12 views, none
  of which calls `store::bump_instance`), `src/storage.rs:88-94`
- **Category**: Entry can archive while still semantically required / TTL extension never
  paid by the party that keeps reading
- **Detected by**: probe tests plus live read-only probe
- **Status**: Open
- **Description**: `bump_instance` runs at the top of every writing entrypoint and on no
  view, so a vault that is only read from drifts toward archival at full speed.
  `no_view_extends_the_instance_ttl_but_every_writer_does` calls all 12 views in a row and
  shows the instance TTL unchanged, then shows one `pay` restoring it to the floor.

  The live numbers make the deadline concrete. On pubnet at ledger 64,104,666:

  | entry | liveUntilLedgerSeq | ledgers left |
  | --- | --- | --- |
  | contract code (wasm) | 66,177,015 | 2,072,349 |
  | contract instance | 66,177,017 | 2,072,351 |
  | USDC SAC `Balance(vault)` | 66,177,068 | 2,072,402 |

  All three land within 53 ledgers of each other: between about 2026-12-22 (at the 5.000 s
  target close) and about 2027-01-06 (at the measured 5.644 s). The shortest clock is the
  Wasm code entry, which `storage().instance().extend_ttl()` does cover, since the SDK
  routes it to `extend_current_contract_instance_and_code_ttl`.

  A second, independent clock is worth naming because it is not this contract's storage at
  all: the vault's USDC lives in a Persistent entry inside the token contract. The SAC
  extends it only when its TTL falls below 501,120 ledgers and only to 518,400 (about 30
  days), so after the first bump cycle the money entry runs on a much shorter leash than
  the contract does. The mitigation is already there and is worth knowing about: the
  permissionless `balance()` view calls into the SAC, whose `read_balance` performs that
  extension, so anyone at all can keep the money entry alive for the cost of one
  invocation.
- **Proof of Concept**: `no_view_extends_the_instance_ttl_but_every_writer_does`,
  `an_archived_instance_entry_is_restored_not_lost`,
  `the_vault_balance_entry_has_its_own_shorter_clock_inside_the_token`,
  `withdraw_still_works_after_every_other_entry_has_lapsed`. Live TTLs in
  `audit/tool-output/A2-live-ttl-probe.txt`.
- **Recommended Fix**: this is operational, and the code change is optional. In order of
  value:
  1. Write the archival date into the deployment record and monitor it. The check is one
     read-only `getLedgerEntries` on the instance and code keys; alert when TTL drops below
     `LONG_TTL_THRESHOLD`.
  2. Document the restore path so the first post-archival call does not look like an
     outage. Under protocol 23 and above the restoration is automatic for any archived key
     in the footprint, so the requirement is a client that includes it and a fee bump, not
     a separate `RestoreFootprint` step.
  3. Optionally, let the cheapest existing read pay the rent. `balance()` already makes a
     cross-contract call, so adding the bump there costs one host call and gives any
     third party a way to keep the vault warm without authorization:

  ```diff
   pub fn balance(env: Env) -> i128 {
  +    // A permissionless keepalive: this view already pays for a cross-contract call,
  +    // and it is the one anybody can call to stop an idle vault drifting into archival.
  +    store::bump_instance(&env);
       token::Client::new(&env, &store::get_token(&env)).balance(&env.current_contract_address())
   }
  ```

  Note the trade-off before taking option 3: it makes a documented view a writer, which
  narrows INV-04 to "no view mutates policy state or moves value" (it already has to be
  read that way because of `is_allowed`, see A2-07).
- **References**: R3 section 3.3 (CAP-0066), section 3.4; threat model P-3, INV-20;
  `soroban-env-host-27.0.1/src/builtin_contracts/stellar_asset_contract/balance.rs:44-97`

### A2-05. The trap-versus-clamp asymmetry is documented against the constants that cannot trap

- **Severity**: Informational
- **Impact**: If `max_entry_ttl` were ever lowered to 34,560 or below, `pay` and `owner_pay`
  would abort with an untyped host error rather than a typed refusal, on every call, for
  every user. `withdraw` would keep working, so this is a payments outage, not a lockup. At
  today's 3,110,400 the margin is 90x, and a reduction of that size has no precedent.
- **Likelihood**: Very low (requires a validator settings upgrade that shrinks
  `max_entry_ttl` by 98 percent)
- **Violates**: INV-17 (the refusal would not be typed), INV-13/INV-20 unaffected
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:59-63` (the comment),
  `:234-240` (`set_spent_on_day`, the call that would actually trap)
- **Category**: Misattributed safety argument
- **Detected by**: host source review plus two probe tests
- **Status**: Open
- **Description**: The comment on `LONG_TTL_THRESHOLD` / `LONG_TTL_EXTEND` says the values
  are kept under `max_entry_ttl` "so that a future reduction of that network setting cannot
  turn a routine bump into a failing call". Those are the Instance and Persistent
  extensions, and they cannot fail: the host clamps them. The extension that can fail is the
  Temporary one on the day bucket, which the comment does not mention. The host checks the
  maximum inside `prepare_extend_ttl`, before the threshold test, so the trap fires even in
  the case where the extension would have been skipped as unnecessary.
- **Proof of Concept**:
  `pay_traps_untyped_if_the_network_lowers_max_entry_ttl_to_the_day_bucket_floor` sets
  `max_entry_ttl` to `DAY_BUCKET_TTL_EXTEND + 1` and pays successfully, then to
  `DAY_BUCKET_TTL_EXTEND` and gets `Err(Err(host trap))` from both `pay` and `owner_pay`
  while `withdraw` still settles. `the_instance_bump_clamps_instead_of_trapping` squeezes
  `max_entry_ttl` to 1,500,000 with the instance entry under the bump threshold and shows
  the extension clamping to 1,499,999 rather than failing.
- **Recommended Fix**: move the sentence to the constant it is about (diff sketch in A2-03).
- **References**: `soroban-env-host-27.0.1/src/storage.rs:478-490, 520-527`; R3 section 3.3

### A2-06. The per-UTC-day cap allows 2x `daily_cap` across a midnight boundary

- **Severity**: Informational
- **Impact**: The product says 1.0 USDC per day. The enforceable statement is 1.0 USDC per
  UTC day, which permits 2.0 USDC inside two seconds if the payments straddle 00:00:00 UTC.
  Bounded at exactly 2x and identical to the Solidity original, so this is a documentation
  item, not a defect.
- **Likelihood**: Certain if an agent runs near the cap around midnight
- **Violates**: n/a (INV-05 is per day and holds)
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:219-221` (`today`),
  `src/lib.rs:290-324` (`settle`)
- **Category**: Semantics of the accounting window
- **Detected by**: probe test
- **Status**: Open
- **Description**: `today()` is `timestamp / 86_400`, so the window is a fixed UTC calendar
  day, not a rolling 24 hours. The operator cannot influence which bucket a payment lands
  in: the day index comes from the ledger timestamp. The old day's bucket keeps its own
  total, under its own key, and is never read again.
- **Proof of Concept**:
  `two_payments_straddling_utc_midnight_each_get_a_full_cap_and_no_more` (20 UNIT moved
  against a 10 UNIT cap in two seconds; the next payment is refused `DailyCapExceeded`; the
  previous day's bucket still holds 10 UNIT under `SpentOnDay(1)`).
- **Recommended Fix**: state the window where the cap is presented to a user, in the console
  and in `llms.txt`: "up to `daily_cap` per UTC day, so up to 2x `daily_cap` may move across
  a midnight boundary". A rolling window would be a behaviour change against the Solidity
  original and is not recommended.
- **References**: `mcp/contracts/AgentSpendPolicy.sol` (same bucketing)

### A2-07. `is_allowed` is an unauthenticated view that writes to the ledger

- **Severity**: Informational
- **Impact**: Any tooling that treats the 12 views as read-only is wrong about this one. It
  is also, positively, the only rent subsidy the allowlist has.
- **Likelihood**: Certain
- **Violates**: n/a (INV-04 holds as written: no policy state is mutated and no value moves)
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:189-198`,
  `src/lib.rs:252-254`
- **Category**: Side-effecting read / TTL extension paid by whoever calls
- **Detected by**: probe test
- **Status**: Open
- **Description**: `is_allowed` extends the payee's Persistent entry whenever the payee is
  allowed, so the footprint of a "view" call contains a read-write entry and the caller pays
  the rent. Nothing is created for a payee that is not allowed, so an unauthenticated caller
  cannot use it to grow storage. `settle` calls the same function on every payment, even
  when the allowlist is disabled, which means every payment carries the payee's `Allowed`
  key in its footprint.
- **Proof of Concept**:
  `the_is_allowed_view_writes_a_ttl_extension_and_the_caller_pays_for_it` (no auth of any
  kind; TTL rises from below the threshold to the floor; nothing is written for an
  unallowed payee).
- **Recommended Fix**: none to the code. Note it where the views are documented, and keep it
  in mind if the project ever exposes a genuinely read-only RPC path.

### A2-08. Archival does not revoke an allowlist entry

- **Severity**: Informational
- **Impact**: None. Recorded because the opposite is a common and wrong assumption, and
  because it is the thing that would make TTL a permission clock.
- **Likelihood**: n/a
- **Violates**: n/a (supports INV-15)
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:189-212`
- **Category**: Data lifetime versus permission lifetime
- **Detected by**: probe test
- **Status**: Confirmed correct
- **Description**: An `Allowed` entry that outlives its TTL is archived, not destroyed, and
  is restored with its value. Letting an entry lapse therefore does not revoke a payee; only
  `set_allowed(payee, false)`, which removes the key, does. That is consistent with the
  principle policy.rs already states for the session key ("anyone can extend any entry's
  TTL, so 'the entry expired, therefore the permission ended' is broken by design").
- **Proof of Concept**: `an_archived_allowlist_entry_comes_back_still_allowed` (walks past
  `min_persistent_ttl + 10`, then `is_allowed` is still true and `pay` settles),
  `a_revoked_payee_leaves_no_residue_in_any_durability`,
  `revoking_a_payee_that_was_never_allowed_is_a_no_op`.

### A2-09. `Decimals` occupies an instance slot that nothing reads

- **Severity**: Informational (duplicate of threat-model P-4, restated from the storage side)
- **Impact**: None today.
- **Violates**: n/a
- **Location**: `soroban/contracts/agent-spend-policy/src/storage.rs:122-128`,
  `src/lib.rs:92, 97, 228-230`
- **Category**: Dead state
- **Detected by**: `cargo-mutants` (three MISSED mutants: `storage.rs:123` to 0 and to 1,
  `storage.rs:127` `set_decimals` to `()`), plus `P2-llvm-cov.txt` (storage.rs 95.65 percent
  lines, 2 functions never executed)
- **Status**: Open, deduplicated against P-4
- **Description**: `Decimals` can be replaced by any value, or its writer deleted outright,
  without a single test noticing, because no gate consults it. Its real function is the
  deploy-time SEP-41 probe, which is a property of the constructor's `decimals()` call, not
  of the stored value. It is one of nine instance keys, so the cost is negligible; the
  finding is that the storage slot has no reader and no test.
- **Recommended Fix**: keep the constructor's `decimals()` call, which is the actual probe,
  and either add a test that pins `decimals()` to the token's own value (killing all three
  mutants) or drop the stored key. Prefer the test: the view is part of the published ABI.

---

## Confirmed, with tests: what holds

These are not findings. They are the invariants in this domain, each closed by a test that
would fail if it stopped being true.

| Claim | Test |
| --- | --- |
| INV-18 holds on both networks, with a 2.25x margin on close time | `the_first_write_of_a_day_reaches_the_two_day_floor_on_both_networks`, `the_day_bucket_outlives_its_own_day_and_then_expires`, `the_day_bucket_floor_tolerates_a_close_time_down_to_2_5_seconds` |
| The first write's create-then-extend ordering survives `min_temporary_ttl == threshold` | `the_bucket_threshold_is_never_above_the_created_ttl_on_either_network` |
| INV-19: the instance map is exactly 9 keys under 300 attacker-shaped writes and payments across many days | `the_instance_map_stays_nine_keys_under_untrusted_input`; live pubnet instance decodes to the same 9 keys |
| No two `DataKey` variants collide, including `Allowed(a)` vs `Allowed(b)` and `SpentOnDay(0)` vs `SpentOnDay(u64::MAX)` | `every_datakey_variant_is_a_distinct_storage_key` |
| The three durabilities are separate namespaces for the same key | `the_same_key_in_three_durabilities_is_three_entries` |
| INV-20: `withdraw` settles after the instance entry has archived, the day bucket has expired and the allowlist has lapsed | `an_archived_instance_entry_is_restored_not_lost`, `withdraw_still_works_after_every_other_entry_has_lapsed` |
| Logical deletion leaves no residue in any durability | `a_revoked_payee_leaves_no_residue_in_any_durability` |
| Every unchecked read is either `unwrap_or` (day bucket, allowlist, policy scalars) or unreachable-by-archival (`unwrap` on instance) | `an_archived_instance_entry_is_restored_not_lost` |
| CAP-0077 is not currently touching this deployment | live read: `frozen_ledger_keys` holds 3 keys, all ACCOUNT entries, none related to this contract, the owner, the operator or the USDC SAC |

## Unconfirmed

Suspicions that could not be proven, stated as such.

1. **CAP-0066 auto-restoration has not been exercised on a live network by this audit.**
   Proving it would require submitting a transaction against an archived entry, which the
   audit rules forbid. The evidence for question 3 is (a) the recording-mode host's
   identical restore-with-value semantics, exercised in a test, and (b) the CAP text and the
   Stellar docs quoted in R3. If the project wants a stronger proof, the honest way is to
   deploy a throwaway contract on testnet, where `min_persistent_ttl` is 120,960 ledgers
   (about 7 days), let it archive and then call it. That is a Phase 5 exercise, not a Phase
   3 one.
2. **Whether pubnet's mean close time can fall to 2.5 s** is a network-roadmap question, not
   a code question. The break-even for INV-18 is computed exactly (2.5000 s) and pinned in a
   test; today's measurement is 5.644 s. No claim is made about the future.
3. **The Wasm code entry's TTL could not be measured in a test.** The SDK test env registers
   contracts natively, so there is no separate code entry to inspect. The claim that
   `storage().instance().extend_ttl()` covers it rests on the SDK doc comment and on the host
   function it calls (`extend_current_contract_instance_and_code_ttl`), plus the live
   observation that the code entry exists with its own `liveUntilLedgerSeq` two ledgers below
   the instance entry's. A live restore was not attempted.
4. **Rent cost of restoration was not quantified.** The report says "rent and a fee bump"
   without a number. Producing one would require a simulated restore against pubnet, which
   is out of scope here.
